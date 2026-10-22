/**
 * SMS Gateway v5 — Worker entry point.
 * Implements PROTOCOL_CONTRACT_V5 Rev C §1 (transport), §3.2 (validation order),
 * §6 (command state machine surface) and §8 (error envelope), and ports
 * master plan §5.2 with brief fixes #2, #19 and #20.
 *
 * Auth surfaces:
 *   - public:  POST /v1/device/pair              (single-use pairing code)
 *   - admin:   Authorization: Bearer <ADMIN_TOKEN>, constant-time compared
 *   - device:  ECDSA P-256 signature over the §2 canonical string
 */

import { DeviceGateway } from "./durable-object";
import { verifyDeviceSignature } from "./auth/ecdsa";
import { handleAdminPairingCode, handleDevicePair, handleDevicesList } from "./routes/pair";
import { handleSend, handleSendBatch } from "./routes/send";
import { handleWs } from "./routes/ws";
import { handleIncomingBatch, handleMessagesList, handleMessagesPurge } from "./routes/incoming";
import { handlePoll } from "./routes/poll";
import { handleCommandStatus, handleStatusBatch } from "./routes/status";
import { handleRulesGet, handleRulesPost, handleRulesTest } from "./routes/rules";
import {
  handleDeviceFlows,
  handleWorkflowDelete,
  handleWorkflowGet,
  handleWorkflowPut,
  handleWorkflowsList,
} from "./routes/workflows";
import { handleHealth } from "./routes/health";
import {
  handleDeviceCommands,
  handleDeviceRevoke,
  handleRuleDelete,
  handleRulesListAdmin,
} from "./routes/admin";
import { handleAlertAck, handleAlertsList } from "./routes/alerts";
import { err } from "./lib/errors";
import { readJsonBoundedResult } from "./lib/body";
import { MAX_BODY_BYTES, readIntEnv } from "./lib/config";

export { DeviceGateway };

/** HttpOnly session cookie carrying the dashboard's admin session. */
const SESSION_COOKIE = "dakflare_admin";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export interface Env {
  DEVICE: DurableObjectNamespace<DeviceGateway>;
  DB: D1Database;
  /** Load-bearing: lib/fcm.ts caches the FCM HTTP v1 bearer token here. */
  KV: KVNamespace;
  /**
   * Admin bearer token. Comes from `.dev.vars` locally or `wrangler secret put`
   * remotely; it is deliberately NOT in `[vars]`. When unset, `withAdmin` fails
   * closed with 401 (see the comment there).
   */
  ADMIN_TOKEN?: string;
  /** FCM HTTP v1 service-account JSON. Absent is a normal local-dev state. */
  FCM_SERVICE_ACCOUNT_JSON?: string;
  /** Redirectable so the harness can point FCM at a local stub. */
  FCM_BASE_URL: string;
  GOOGLE_TOKEN_URL: string;
  /** Optional timing overrides, clamped in lib/config.ts. */
  ACK_TIMEOUT_MS?: string;
  OFFLINE_ALERT_MS?: string;
  STALE_SOCKET_MS?: string;
  NONCE_WINDOW_MS?: string;
  /** Retention window in days for message bodies (D1 and DO). Default 90. */
  MESSAGE_RETENTION_DAYS?: string;
  /**
   * Where `/source` redirects. AGPL-3.0 §13 requires a network deployment to offer its
   * source to the people using it; this makes the offer a configuration value rather
   * than a hardcoded URL that goes stale on a fork.
   */
  SOURCE_URL?: string;
  /**
   * Rate Limiting bindings. Optional so a deployment without them still type
   * checks and runs; each call site guards on presence.
   */
  PAIR_LIMITER?: RateLimit;
  ADMIN_LIMITER?: RateLimit;
  DEVICE_LIMITER?: RateLimit;
  /**
   * Separate binding for the shared pairing key. It must be a distinct limiter,
   * not the same one keyed differently: sharing `PAIR_LIMITER` let one client
   * drain the global budget and deny pairing to every other device.
   */
  PAIR_GLOBAL_LIMITER?: RateLimit;
  /**
   * Per-IP counter for FAILED device authentication only. Never incremented on
   * success, so a busy legitimate device is unaffected. Skipped when the request
   * carries no `CF-Connecting-IP` (local dev, conformance suite).
   */
  AUTH_FAIL_LIMITER?: RateLimit;
  /** Per-device daily inbound row budget, read by the DO's `write_budget` table. */
  INCOMING_ROWS_PER_DAY?: string;
  /**
   * Optional out-of-band delivery for operator alerts. When set, the DO POSTs the
   * alert JSON to it, best-effort: a webhook outage must never fail the alarm.
   */
  ALERT_WEBHOOK_URL?: string;
}

type DeviceHandler = (
  req: Request,
  env: Env,
  deviceId: string,
  body: string
) => Promise<Response>;

/**
 * Admin authentication — brief #20.
 *
 * The token is compared in constant time: both sides are hashed to SHA-256 first
 * (which fixes the length, so no length leak) and the digests are compared with a
 * single accumulating XOR loop rather than `===`, which short-circuits on the
 * first differing byte.
 *
 * Fail closed: if `ADMIN_TOKEN` is unset, every admin route answers 401. In local
 * dev without a non-dev token that means `wrangler dev` alone is not enough —
 * create `worker/.dev.vars` (see `.dev.vars.example`) or set the token with
 * `wrangler secret put ADMIN_TOKEN`.
 *
 * Note: §8 defines the code set for the DEVICE protocol only, so an admin auth
 * failure uses its own body and keeps `err()` strictly within §8.
 */
async function withAdmin(
  req: Request,
  env: Env,
  handler: () => Promise<Response>
): Promise<Response> {
  const expected = env.ADMIN_TOKEN;
  if (!expected) return unauthorized();

  const authHeader = req.headers.get("Authorization");
  if (authHeader !== null) {
    // Bearer path — unchanged. A caller that sends `Authorization` gets no
    // fallback to the cookie, so a bad bearer header still fails.
    const providedDigest = await sha256(authHeader);
    const expectedDigest = await sha256(`Bearer ${expected}`);
    if (!timingSafeEqual(providedDigest, expectedDigest)) return unauthorized();
  } else {
    // Session-cookie path.
    //
    // CSRF guard: require a custom header. A cross-origin `fetch` cannot set
    // `X-Admin-Session` without a CORS preflight, and this Worker allows no
    // cross-origin CORS, so the preflight fails and the real request never
    // leaves the browser. `SameSite=Strict` independently keeps the cookie off
    // cross-site requests, so both layers would have to fail for a forged
    // request to authenticate.
    if (req.headers.get("X-Admin-Session") !== "1") return unauthorized();
    const exp = await verifySession(expected, readCookie(req, SESSION_COOKIE));
    if (exp === null) return unauthorized();
  }

  // Rate-limit only AFTER the token is verified. Keying the limiter by token
  // material before verification lets an attacker send random `Authorization`
  // headers and mint a fresh rate-limit key per request — a complete bypass.
  if (env.ADMIN_LIMITER) {
    const { success } = await env.ADMIN_LIMITER.limit({ key: "admin" });
    if (!success) return err("rate_limited", 429);
  }

  return handler();
}

/**
 * Advance `devices.last_seen` after an authenticated device request.
 *
 * §11.12: this is authenticated contact, not pairing time. It is deliberately
 * fire-and-forget (`ctx.waitUntil`) and conditional on being at least 60 s stale,
 * so it never delays a response and cannot turn a D1 hiccup into a device failure.
 * Every failure mode is swallowed; a stale liveness value is worse than a failed
 * request only if the request itself fails.
 */
function recordDeviceContact(ctx: ExecutionContext, env: Env, deviceId: string): void {
  ctx.waitUntil(
    (async () => {
      try {
        const now = Date.now();
        await env.DB.prepare(
          `UPDATE devices SET last_seen = ? WHERE device_id = ? AND last_seen < ?`
        )
          .bind(now, deviceId, now - 60_000)
          .run();
      } catch {
        // Presence is diagnostic. Never surface it.
      }
    })()
  );
}

/** `withDevice` — §3.2 runs entirely inside `verifyDeviceSignature`. */
async function withDevice(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  handler: DeviceHandler
): Promise<Response> {
  const result = await verifyDeviceSignature(req, env);
  if (!result.ok) {
    // Count FAILURES only, and only where the edge tells us who is calling. A
    // pre-auth counter keyed on an attacker-chosen header value would be a bypass;
    // `CF-Connecting-IP` is set by Cloudflare and cannot be spoofed from outside.
    // No header means local dev / the conformance suite, where limiting would be
    // pure noise, so the whole check is skipped.
    if (env.AUTH_FAIL_LIMITER) {
      const ip = req.headers.get("CF-Connecting-IP");
      if (ip !== null && ip !== "") {
        const { success } = await env.AUTH_FAIL_LIMITER.limit({ key: `authfail:${ip}` });
        if (!success) return err("rate_limited", 429);
      }
    }
    return result.response;
  }

  // Per-device throttle, applied after the signature proves which device it is.
  // A compromised device must not be able to flood the batch endpoints, each of
  // which costs Durable Object requests plus D1 rows.
  if (env.DEVICE_LIMITER) {
    const { success } = await env.DEVICE_LIMITER.limit({ key: `device:${result.deviceId}` });
    if (!success) return err("rate_limited", 429);
  }

  // Authenticated contact, after every gate that could reject the request.
  recordDeviceContact(ctx, env, result.deviceId);

  return handler(req, env, result.deviceId, result.body);
}

export default {
  /**
   * Retention cron (hardening S6). Terminal D1 rows are pruned in bounded
   * batches so one large delete cannot hit a D1 duration limit and roll back.
   * The device keeps the authoritative copy, so this only bounds the operator's
   * copy — which is also the copy that holds SMS bodies and phone numbers.
   */
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    ctx.waitUntil(runRetention(env));
  },

  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;
    const method = req.method.toUpperCase();

    /* ---- public bootstrapping ----------------------------------------- */
    // AGPL-3.0 §13 source offer. Public by design: it must be reachable by anyone the
    // deployment serves, including someone who has never paired a device.
    if (method === "GET" && pathname === "/source") {
      return env.SOURCE_URL
        ? Response.redirect(env.SOURCE_URL, 302)
        : Response.json({ error: "not_found" }, { status: 404 });
    }

    if (method === "POST" && pathname === "/v1/device/pair") {
      return handleDevicePair(req, env);
    }

    /* ---- admin -------------------------------------------------------- */
    if (method === "POST" && pathname === "/v1/admin/pairing-code") {
      return withAdmin(req, env, () => handleAdminPairingCode(req, env));
    }

    if (method === "GET" && pathname === "/v1/admin/health") {
      return withAdmin(req, env, () => handleHealth(env));
    }

    // S10: revocation must reach the Durable Object, not just D1.
    const revokeMatch = pathname.match(/^\/v1\/admin\/devices\/([^/]+)$/);
    if (method === "DELETE" && revokeMatch) {
      const target = decodeURIComponent(revokeMatch[1]);
      return withAdmin(req, env, () => handleDeviceRevoke(env, target));
    }

    const deviceCommandsMatch = pathname.match(/^\/v1\/admin\/devices\/([^/]+)\/commands$/);
    if (method === "GET" && deviceCommandsMatch) {
      // Decoding happens INSIDE `withAdmin`, so a malformed escape is an
      // authenticated caller's error, not an unauthenticated throw.
      return withAdmin(req, env, () =>
        handleDeviceCommands(env, decodeURIComponent(deviceCommandsMatch[1]), url)
      );
    }

    if (method === "GET" && pathname === "/v1/admin/alerts") {
      return withAdmin(req, env, () => handleAlertsList(env, url));
    }
    const alertAckMatch = pathname.match(/^\/v1\/admin\/alerts\/([^/]+)\/ack$/);
    if (method === "POST" && alertAckMatch) {
      return withAdmin(req, env, () => handleAlertAck(env, decodeURIComponent(alertAckMatch[1])));
    }

    if (method === "GET" && pathname === "/v1/admin/rules") {
      return withAdmin(req, env, () => handleRulesListAdmin(env));
    }
    if (method === "POST" && pathname === "/v1/admin/rules/test") {
      return withAdmin(req, env, () => handleRulesTest(req, env));
    }
    const ruleDeleteMatch = pathname.match(/^\/v1\/admin\/rules\/([^/]+)$/);
    if (method === "DELETE" && ruleDeleteMatch) {
      const ruleId = decodeURIComponent(ruleDeleteMatch[1]);
      return withAdmin(req, env, () => handleRuleDelete(env, ruleId));
    }

    // Workflow graphs. The id segment is passed to the handler RAW and decoded
    // there, after `withAdmin`, so a malformed escape cannot throw on an
    // unauthenticated path. The list route has no segment and is matched first.
    if (method === "GET" && pathname === "/v1/admin/workflows") {
      return withAdmin(req, env, () => handleWorkflowsList(env));
    }
    const workflowMatch = pathname.match(/^\/v1\/admin\/workflows\/([^/]+)$/);
    if (method === "GET" && workflowMatch) {
      return withAdmin(req, env, () => handleWorkflowGet(env, workflowMatch[1]));
    }
    if (method === "PUT" && workflowMatch) {
      return withAdmin(req, env, () => handleWorkflowPut(req, env, workflowMatch[1]));
    }
    if (method === "DELETE" && workflowMatch) {
      return withAdmin(req, env, () => handleWorkflowDelete(env, workflowMatch[1]));
    }
    if (method === "GET" && pathname === "/v1/devices") {
      return withAdmin(req, env, () => handleDevicesList(env));
    }
    if (method === "GET" && pathname === "/v1/messages") {
      return withAdmin(req, env, () => handleMessagesList(env, url));
    }
    if (method === "DELETE" && pathname === "/v1/messages") {
      return withAdmin(req, env, () => handleMessagesPurge(env, url));
    }
    if (method === "POST" && pathname === "/v1/rules") {
      return withAdmin(req, env, () => handleRulesPost(req, env));
    }
    if (method === "POST" && pathname === "/v1/sms/send") {
      return withAdmin(req, env, () => handleSend(req, env));
    }
    if (method === "POST" && pathname === "/v1/sms/send/batch") {
      return withAdmin(req, env, () => handleSendBatch(req, env));
    }

    const commandMatch = pathname.match(/^\/v1\/sms\/commands\/([^/]+)$/);
    if (method === "GET" && commandMatch) {
      const commandId = decodeURIComponent(commandMatch[1]);
      return withAdmin(req, env, () =>
        handleCommandStatus(env, url.searchParams.get("device_id") ?? "", commandId)
      );
    }

    const deviceStatusMatch = pathname.match(/^\/v1\/device\/([^/]+)\/status$/);
    if (method === "GET" && deviceStatusMatch) {
      const target = deviceStatusMatch[1];
      return withAdmin(req, env, async () => {
        const stub = env.DEVICE.get(env.DEVICE.idFromName(target));
        return stub.fetch("https://do/__device_status", { method: "GET" });
      });
    }

    /* ---- ECDSA-authenticated device routes ----------------------------- */
    if (method === "GET" && pathname === "/v1/device/ws") {
      return withDevice(req, env, ctx, (r, e, deviceId) => handleWs(r, e, deviceId));
    }
    if (method === "POST" && pathname === "/v1/sms/incoming/batch") {
      return withDevice(req, env, ctx, (r, e, deviceId, body) =>
        handleIncomingBatch(r, e, deviceId, body)
      );
    }
    if (method === "POST" && pathname === "/v1/sms/outgoing/poll") {
      return withDevice(req, env, ctx, (r, e, deviceId, body) => handlePoll(r, e, deviceId, body));
    }
    if (method === "POST" && pathname === "/v1/sms/status/batch") {
      return withDevice(req, env, ctx, (r, e, deviceId, body) => handleStatusBatch(r, e, deviceId, body));
    }
    if (method === "GET" && pathname === "/v1/rules") {
      return withDevice(req, env, ctx, (r, e, deviceId) => handleRulesGet(r, e, deviceId));
    }
    if (method === "GET" && pathname === "/v1/flows") {
      return withDevice(req, env, ctx, (_r, e, deviceId) => handleDeviceFlows(e, deviceId));
    }

    /* ---- admin session (cookie) ---------------------------------------- */
    // Not wrapped in `withAdmin`: these are the endpoints that establish and
    // inspect the session in the first place.
    if (method === "POST" && pathname === "/admin/session") {
      return handleSessionCreate(req, env);
    }
    if (method === "GET" && pathname === "/admin/session") {
      return handleSessionGet(req, env);
    }
    if (method === "DELETE" && pathname === "/admin/session") {
      return handleSessionDelete(req);
    }

    // Every real console route is a PRERENDERED file (`/admin/devices.html`),
    // so the assets layer serves it before this Worker runs — which is why
    // there is no `ASSETS` binding: `cf` deploys assets but exposes none to the
    // Worker. Only an unknown path under `/admin` reaches here; send the
    // operator to the console root instead of answering with the JSON 404.
    if (pathname === "/admin" || pathname.startsWith("/admin/")) {
      return Response.redirect(new URL("/admin/", req.url).toString(), 302);
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;

async function runRetention(env: Env): Promise<void> {
  const days = readIntEnv(env.MESSAGE_RETENTION_DAYS, 90, 7, 3_650);
  const cutoff = Date.now() - days * 86_400_000;
  let deleted = 0;

  // Bounded batches with a hard iteration cap.
  //
  // The cap matters on Workers Free: D1 rows WRITTEN is 100,000/day, and each
  // deleted row counts. 10 batches x 1,000 is 10% of that budget per day, so a
  // first-run catch-up on a large backlog can never consume the whole day and
  // starve the live writes. A runaway loop would be worse than a slow prune; the
  // next run continues where this one stopped.
  for (let i = 0; i < 10; i++) {
    const result = await env.DB.prepare(
      `DELETE FROM messages WHERE id IN (
         SELECT id FROM messages WHERE received_at < ? LIMIT 1000
       )`
    )
      .bind(cutoff)
      .run();
    const changes = Number(result.meta?.changes ?? 0);
    deleted += changes;
    if (changes === 0) break;
  }

  const codes = await env.DB.prepare(`DELETE FROM pairing_codes WHERE expires_at <= ?`)
    .bind(Date.now())
    .run();

  // `rule_hits` is what enforces each rule's cooldown and hourly cap. It grows one
  // row per automated reply, so it needs the same retention as the log — but the
  // horizon must never be shorter than a cooldown that is still configured, or a
  // prune would silently re-enable a reply the operator asked to suppress.
  const cooldownRow = await env.DB.prepare(
    `SELECT MAX(cooldown_s) AS max_cooldown_s FROM rules`
  ).first<{ max_cooldown_s: number | null }>();
  const maxCooldownS = cooldownRow?.max_cooldown_s;
  const hitCutoff =
    maxCooldownS === null || maxCooldownS === undefined
      ? // No rules configured: keep a day of history so re-creating a rule shortly
        // afterwards still respects the most recent reply.
        Date.now() - 24 * 3_600_000
      : Date.now() - Math.max(3_600_000, Math.max(0, maxCooldownS) * 1_000 + 3_600_000);
  let hitsDeleted = 0;
  for (let i = 0; i < 10; i++) {
    const result = await env.DB.prepare(
      `DELETE FROM rule_hits WHERE rowid IN (
         SELECT rowid FROM rule_hits WHERE replied_at < ? LIMIT 1000
       )`
    )
      .bind(hitCutoff)
      .run();
    const changes = Number(result.meta?.changes ?? 0);
    hitsDeleted += changes;
    if (changes === 0) break;
  }

  // Alerts are operator history, not device state. Acknowledged ones are safe to
  // age out with the message log; an OPEN alert is the current outage signal and
  // is never deleted here.
  const alerts = await env.DB.prepare(
    `DELETE FROM alerts WHERE acknowledged_at IS NOT NULL AND acknowledged_at < ?`
  )
    .bind(cutoff)
    .run();

  console.log(
    `[retention] days=${days} messages=${deleted} pairing_codes=${Number(
      codes.meta?.changes ?? 0
    )} rule_hits=${hitsDeleted} alerts=${Number(alerts.meta?.changes ?? 0)}`
  );
}

function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

/* ---- session cookie helpers ------------------------------------------ */

/**
 * Session key derivation.
 *
 * The HMAC key is `SHA-256("dakflare-session-v1\n" + ADMIN_TOKEN)`, so rotating
 * `ADMIN_TOKEN` invalidates every outstanding session without a revocation list.
 * The label keeps the derivation domain-separated from any other use of the token.
 */
async function sessionKey(adminToken: string): Promise<CryptoKey> {
  const digest = await sha256(`dakflare-session-v1\n${adminToken}`);
  return crypto.subtle.importKey("raw", digest, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
}

/**
 * Mint a session cookie value: `v1.<expiry_ms>.<hmac_hex>`, where the HMAC
 * covers exactly `v1.<expiry_ms>`. The expiry is therefore authenticated; a
 * client cannot extend its own session by editing the cookie.
 */
async function mintSession(adminToken: string): Promise<{ value: string; exp: number }> {
  const key = await sessionKey(adminToken);
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = `v1.${exp}`;
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return { value: `${payload}.${toHex(new Uint8Array(signature))}`, exp };
}

/**
 * Verify a session cookie value. Returns the authenticated expiry, or `null` for
 * anything malformed, expired or forged. The MAC comparison is constant time.
 */
async function verifySession(
  adminToken: string,
  cookieValue: string | undefined
): Promise<number | null> {
  if (!cookieValue) return null;

  const parts = cookieValue.split(".");
  if (parts.length !== 3) return null;

  const [version, rawExp, macHex] = parts;
  if (version !== "v1") return null;

  const exp = Number(rawExp);
  if (!Number.isFinite(exp)) return null;
  if (exp <= Date.now()) return null;

  const mac = fromHex(macHex);
  if (mac === null || mac.length !== 32) return null;

  const key = await sessionKey(adminToken);
  const expected = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${version}.${rawExp}`))
  );
  return timingSafeEqual(mac, expected) ? exp : null;
}

/** Read one cookie value from the request's `Cookie` header. */
function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("Cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** Build the `Set-Cookie` value with the attributes the dashboard expects. */
function sessionCookie(value: string, maxAgeSeconds: number, secure: boolean): string {
  return (
    `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}` +
    (secure ? "; Secure" : "")
  );
}

/**
 * `POST /admin/session` — exchange the admin token for an HttpOnly cookie.
 *
 * The token never persists in the browser: it is read from this one request and
 * the response only carries the signed session. Rate-limited per IP *before*
 * verification, because an unauthenticated login endpoint is exactly where
 * guessing happens (unlike admin routes, a random guess here cannot mint a
 * useful limiter key).
 */
async function handleSessionCreate(req: Request, env: Env): Promise<Response> {
  const ip = req.headers.get("CF-Connecting-IP") ?? "local";
  if (env.ADMIN_LIMITER) {
    const { success } = await env.ADMIN_LIMITER.limit({ key: `login:${ip}` });
    if (!success) return err("rate_limited", 429);
  }

  const expected = env.ADMIN_TOKEN;
  if (!expected) return unauthorized();

  const parsed = await readJsonBoundedResult(req, MAX_BODY_BYTES);
  if (!parsed.ok) return err(parsed.reason, parsed.reason === "payload_too_large" ? 413 : 400);

  const token = parsed.value.token;
  if (typeof token !== "string") return err("bad_request", 400);

  const providedDigest = await sha256(token);
  const expectedDigest = await sha256(expected);
  if (!timingSafeEqual(providedDigest, expectedDigest)) return unauthorized();

  const { value, exp } = await mintSession(expected);
  const secure = new URL(req.url).protocol === "https:";
  return Response.json(
    { ok: true, expires_at: exp },
    { headers: { "Set-Cookie": sessionCookie(value, SESSION_TTL_MS / 1000, secure) } }
  );
}

/** `GET /admin/session` — is this cookie still valid, and until when. */
async function handleSessionGet(req: Request, env: Env): Promise<Response> {
  const exp = env.ADMIN_TOKEN
    ? await verifySession(env.ADMIN_TOKEN, readCookie(req, SESSION_COOKIE))
    : null;
  if (exp === null) return unauthorized();
  return Response.json({ ok: true, expires_at: exp });
}

/** `DELETE /admin/session` — clear the cookie. Clearing needs no authentication. */
function handleSessionDelete(req: Request): Response {
  const secure = new URL(req.url).protocol === "https:";
  return Response.json(
    { ok: true },
    { headers: { "Set-Cookie": sessionCookie("", 0, secure) } }
  );
}

/* ---- byte helpers ----------------------------------------------------- */

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** Decode lowercase/uppercase hex, or `null` on an odd length or non-hex character. */
function fromHex(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function sha256(input: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return new Uint8Array(digest);
}

/** Constant-time equality over two fixed-length digests. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
