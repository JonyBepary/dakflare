/**
 * FCM HTTP v1 high-priority wake — master plan §5.1 ("FCM HTTP v1 OAuth2 client",
 * deliverable B4) and the amendment to the port brief.
 *
 * Rev B shipped `sendFcmHighPriorityWake()` as an empty stub. This is the real
 * thing:
 *
 *   1. parse `FCM_SERVICE_ACCOUNT_JSON`;
 *   2. sign an RS256 JWT assertion with the service account's PKCS#8 key using
 *      `crypto.subtle`;
 *   3. exchange it at `GOOGLE_TOKEN_URL` for an OAuth2 access token, caching the
 *      token in KV under `fcm_bearer_token` until ~5 minutes before expiry — this
 *      is what makes the KV binding load-bearing instead of dead;
 *   4. POST `{message:{token, android:{priority:"high"}}}` to
 *      `${FCM_BASE_URL}/v1/projects/<project_id>/messages:send`.
 *
 * Every network call is wrapped: an FCM outage must never break command enqueue,
 * so failures are logged and swallowed. A missing service account is a normal
 * local-dev state, not an error, and is logged at most once per isolate.
 */

import type { Env } from "../index";

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string;
}

const KV_TOKEN_KEY = "fcm_bearer_token";
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const TOKEN_SKEW_MS = 300_000;
const ASSERTION_LIFETIME_S = 3_600;

/** Log the "no service account" case once per isolate; never spam the log. */
let warnedMissingServiceAccount = false;

export async function sendFcmHighPriorityWake(
  env: Env,
  fcmToken: string | null | undefined
): Promise<void> {
  if (!fcmToken) return;

  const account = parseServiceAccount(env);
  if (!account) {
    if (!warnedMissingServiceAccount) {
      warnedMissingServiceAccount = true;
      console.log(
        "[fcm] FCM_SERVICE_ACCOUNT_JSON not set - high-priority wake push disabled (local dev is fine)"
      );
    }
    return;
  }

  try {
    const accessToken = await getAccessToken(env, account);
    if (!accessToken) return;

    const url = `${trimTrailingSlash(env.FCM_BASE_URL)}/v1/projects/${account.project_id}/messages:send`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: {
          token: fcmToken,
          android: { priority: "high" },
        },
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`[fcm] wake push rejected: HTTP ${res.status} ${detail.slice(0, 300)}`);
    }
  } catch (error) {
    console.error(`[fcm] wake push failed: ${String(error)}`);
  }
}

function parseServiceAccount(env: Env): ServiceAccount | null {
  const raw = env.FCM_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ServiceAccount>;
    if (
      typeof parsed.client_email !== "string" ||
      typeof parsed.private_key !== "string" ||
      typeof parsed.project_id !== "string" ||
      parsed.client_email === "" ||
      parsed.private_key === "" ||
      parsed.project_id === ""
    ) {
      console.error("[fcm] FCM_SERVICE_ACCOUNT_JSON is missing client_email/private_key/project_id");
      return null;
    }
    return {
      client_email: parsed.client_email,
      private_key: parsed.private_key,
      project_id: parsed.project_id,
    };
  } catch {
    console.error("[fcm] FCM_SERVICE_ACCOUNT_JSON is not valid JSON");
    return null;
  }
}

/**
 * Return a cached bearer token, or mint a fresh one. The cache entry carries its
 * own absolute expiry so a token is reused until `TOKEN_SKEW_MS` before it dies.
 */
async function getAccessToken(env: Env, account: ServiceAccount): Promise<string | null> {
  const cached = await readCachedToken(env);
  if (cached) return cached;

  const assertion = await buildJwtAssertion(env, account);
  if (!assertion) return null;

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });

  const res = await fetch(env.GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error(`[fcm] token exchange failed: HTTP ${res.status} ${detail.slice(0, 300)}`);
    return null;
  }

  const payload = (await res.json().catch(() => null)) as
    | { access_token?: unknown; expires_in?: unknown }
    | null;
  const token = typeof payload?.access_token === "string" ? payload.access_token : null;
  if (!token) {
    console.error("[fcm] token exchange returned no access_token");
    return null;
  }

  const expiresInS = Number(payload?.expires_in);
  const ttlMs = (Number.isFinite(expiresInS) && expiresInS > 0 ? expiresInS : 3_600) * 1000;
  await writeCachedToken(env, token, Date.now() + ttlMs);
  return token;
}

async function readCachedToken(env: Env): Promise<string | null> {
  try {
    const raw = await env.KV?.get(KV_TOKEN_KEY);
    if (!raw) return null;
    const entry = JSON.parse(raw) as { token?: unknown; exp?: unknown };
    if (typeof entry.token !== "string" || typeof entry.exp !== "number") return null;
    if (!Number.isFinite(entry.exp) || entry.exp - TOKEN_SKEW_MS <= Date.now()) return null;
    return entry.token;
  } catch (error) {
    console.error(`[fcm] token cache read failed: ${String(error)}`);
    return null;
  }
}

async function writeCachedToken(env: Env, token: string, expiresAt: number): Promise<void> {
  try {
    const ttlSeconds = Math.max(60, Math.floor((expiresAt - Date.now() - TOKEN_SKEW_MS) / 1000));
    await env.KV?.put(KV_TOKEN_KEY, JSON.stringify({ token, exp: expiresAt }), {
      expirationTtl: ttlSeconds,
    });
  } catch (error) {
    console.error(`[fcm] token cache write failed: ${String(error)}`);
  }
}

/** Build and RS256-sign the JWT bearer assertion (RFC 7523). */
async function buildJwtAssertion(env: Env, account: ServiceAccount): Promise<string | null> {
  try {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: "RS256", typ: "JWT" };
    const claims = {
      iss: account.client_email,
      scope: FCM_SCOPE,
      aud: env.GOOGLE_TOKEN_URL,
      iat: now,
      exp: now + ASSERTION_LIFETIME_S,
    };

    const signingInput = `${base64UrlEncodeString(JSON.stringify(header))}.${base64UrlEncodeString(
      JSON.stringify(claims)
    )}`;

    const key = await crypto.subtle.importKey(
      "pkcs8",
      pemToDer(account.private_key),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"]
    );

    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,
      new TextEncoder().encode(signingInput)
    );

    return `${signingInput}.${base64UrlEncodeBytes(new Uint8Array(signature))}`;
  } catch (error) {
    console.error(`[fcm] JWT assertion failed: ${String(error)}`);
    return null;
  }
}

/** Strip the PEM armour and decode the PKCS#8 DER payload. */
export function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN[^-]+-----/, "")
    .replace(/-----END[^-]+-----/, "")
    .replace(/\s+/g, "");
  const binary = atob(body);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function base64UrlEncodeString(value: string): string {
  return base64UrlEncodeBytes(new TextEncoder().encode(value));
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
