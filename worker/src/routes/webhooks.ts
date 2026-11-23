/**
 * Inbound webhook channel for the agent.
 *
 * An external service wakes the agent with one signed HTTP call. The call is
 * the delivery: `POST /v1/webhooks/:id` verifies an HMAC-SHA256 signature over
 * the raw body, claims the caller's `x-dakflare-delivery` id, runs one
 * non-streaming agent turn as `webhook:<id>`, stores the answer on the delivery
 * row and returns it. A repeated delivery id replays that stored answer and
 * runs no second turn.
 *
 * Two boundaries matter:
 *
 *   1. A webhook is not a credential for the agent. The synthetic actor has
 *      `role: "webhook"`, `authorizeAct` refuses it with `webhook_cannot_act`,
 *      and `assertHuman` refuses it too, so no autonomy window can be spent by
 *      a service that merely knows a signing secret.
 *   2. The signing secret is shown once. `secret_hash` is SHA-256(secret), but
 *      HMAC verification needs the key itself, so `secret_sealed` carries the
 *      same secret under AES-256-GCM with a Worker-held key. See the migration
 *      comment for why a one-way hash alone cannot do this.
 */

import type { Env } from "../index";
import { requestMeta, writeAudit } from "../audit";
import {
  MAX_ALLOWLIST_PATTERNS,
  validateBodyAllowlist,
  type BodyAllowlistConfig,
  type WebhookBodyPolicy,
} from "../lib/content-policy";
import type { AdminActor } from "../audit";
import { assertHuman } from "../lib/authority";
import { err } from "../lib/errors";
import { readBodyBounded } from "../lib/body";
import { ASSISTANT_OBJECT_NAME } from "../lib/agent-runtime";
import { isBlockedWebhookHost } from "../lib/flow-ir";
import { findOutboundWebhook } from "../lib/outbound-webhook";
import { buildSignedEnvelopeHeaders } from "../lib/integration-envelope";

/** A webhook body is an event, not a batch upload. */
export const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;

/** Matches the machine-turn route; a model does not need an essay to wake up. */
export const MAX_WEBHOOK_MESSAGE_CHARS = 2_000;

/** Bound on the caller's delivery id, which becomes a primary key. */
export const MAX_DELIVERY_ID_CHARS = 200;

/** Name shown in the console; a label, never a routing key. */
export const MAX_WEBHOOK_NAME_CHARS = 64;

/** Last N deliveries an operator may read. */
export const DELIVERY_LIST_LIMIT = 20;

interface WebhookRow {
  id: string;
  name: string;
  secret_hash: string;
  secret_sealed: string;
  enabled: number;
  created_by: string | null;
  created_at: number;
  last_delivery_at: number | null;
}

interface DeliveryRow {
  id: string;
  webhook_id: string;
  received_at: number;
  body_json: string | null;
  status: string;
  answer_text: string | null;
  error: string | null;
}

/* ───────────────────────────── crypto ───────────────────────────── */

const encoder = new TextEncoder();

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  let out = "";
  for (const byte of buffer) out += byte.toString(16).padStart(2, "0");
  return out;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** Exported so the channel-connector layer fingerprints and seals with one scheme. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return toHex(new Uint8Array(digest));
}

/**
 * Constant-time equality over two hex strings.
 *
 * Length is folded into the accumulator and the loop runs over the longer of
 * the two, so a truncated or wrong-length signature costs the same comparison
 * as a full-length wrong one. The caller still checks the expected 64-char
 * shape; this function never returns early on a length mismatch.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let index = 0; index < length; index += 1) {
    diff |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return diff === 0;
}

const WEBHOOK_HMAC_KEYS = new Map<string, Promise<CryptoKey>>();

function getWebhookHmacKey(secret: string): Promise<CryptoKey> {
  let cached = WEBHOOK_HMAC_KEYS.get(secret);
  if (cached === undefined) {
    if (WEBHOOK_HMAC_KEYS.size >= 64) WEBHOOK_HMAC_KEYS.clear();
    cached = crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    WEBHOOK_HMAC_KEYS.set(secret, cached);
  }
  return cached;
}

/** HMAC-SHA256(secret, rawBody) as lowercase hex. */
export async function hmacSha256Hex(secret: string, rawBody: string): Promise<string> {
  const key = await getWebhookHmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
  return toHex(new Uint8Array(signature));
}

/**
 * Verify `x-dakflare-signature: sha256=<hex>` over the raw body.
 *
 * The canonical string is the raw request body bytes (UTF-8), with no method,
 * path, timestamp or nonce mixed in. A separate delivery id supplies replay
 * protection, and the body is what the service actually sends.
 */
export async function verifyWebhookSignature(
  secret: string,
  rawBody: string,
  header: string | null
): Promise<boolean> {
  if (header === null) return false;
  const match = /^sha256=([0-9a-fA-F]+)$/.exec(header.trim());
  if (match === null) return false;
  const provided = match[1].toLowerCase();
  const expected = await hmacSha256Hex(secret, rawBody);
  return timingSafeEqualHex(expected, provided);
}

/** The Worker-held key that seals a webhook secret at rest. */
async function sealingKey(env: Env): Promise<CryptoKey | null> {
  const material =
    // Only its own key. Falling back to ADMIN_TOKEN would mean rotating the
    // admin credential silently breaks every webhook, and both fallbacks are
    // bearer secrets whose compromise already grants more than this.
    env.WEBHOOK_SECRET_KEY?.trim() ||
    "";
  if (material === "") return null;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`dakflare-webhook-seal-v1\0${material}`)
  );
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * `v1.<iv-hex>.<ciphertext-hex>` so a future key version can be introduced.
 *
 * Exported for `routes/channel-connectors.ts`: a channel credential and a
 * webhook signing secret are the same kind of value, so they share one key and
 * one envelope rather than growing a second sealing scheme that rotates apart.
 */
export async function sealSecret(env: Env, secret: string): Promise<string | null> {
  const key = await sealingKey(env);
  if (key === null) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(secret)
  );
  return `v1.${toHex(iv)}.${toHex(new Uint8Array(ciphertext))}`;
}

/** Counterpart to {@link sealSecret}; shared with the channel connector layer. */
export async function openSecret(env: Env, sealed: string | null): Promise<string | null> {
  if (sealed === null) return null;
  const parts = sealed.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const iv = fromHex(parts[1]);
  const ciphertext = fromHex(parts[2]);
  if (iv === null || ciphertext === null) return null;
  const key = await sealingKey(env);
  if (key === null) return null;
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

function fromHex(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

/* ───────────────────────────── admin routes ───────────────────────────── */

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  const bounded = await readBodyBounded(req, MAX_WEBHOOK_BODY_BYTES);
  if (!bounded.ok) return null;
  if (bounded.text.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(bounded.text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function adminRefusal(actor: AdminActor): Response | null {
  const human = assertHuman(actor);
  return human.ok ? null : human.response;
}

/** `POST /v1/admin/webhooks` — create and show the secret exactly once. */
export async function handleWebhookCreate(
  req: Request,
  env: Env,
  actor: AdminActor
): Promise<Response> {
  const refused = adminRefusal(actor);
  if (refused !== null) return refused;

  const body = await readJson(req);
  if (body === null) return err("bad_request", 400);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name === "" || name.length > MAX_WEBHOOK_NAME_CHARS) {
    return Response.json(
      { error: "bad_request", message: `name must be 1..${MAX_WEBHOOK_NAME_CHARS} characters` },
      { status: 400 }
    );
  }

  const kind = body.kind === undefined ? "inbound" : body.kind;
  if (kind !== "inbound" && kind !== "outbound") {
    return Response.json(
      { error: "bad_request", message: "kind must be 'inbound' or 'outbound'" },
      { status: 400 }
    );
  }
  if (kind === "outbound") {
    return createOutboundWebhook(env, actor, name, body);
  }

  const secret = randomHex(32);
  const secretHash = await sha256Hex(secret);
  const sealed = await sealSecret(env, secret);
  if (sealed === null) {
    return Response.json(
      {
        error: "webhook_secret_unavailable",
        message:
          "WEBHOOK_SECRET_KEY is required to seal a webhook secret; set it with `cf workers secrets update WEBHOOK_SECRET_KEY --type secret_text`",
      },
      { status: 503 }
    );
  }

  const id = `wh_${randomHex(12)}`;
  const createdAt = Date.now();
  await env.DB.prepare(
    `INSERT INTO webhooks
       (id, name, vertical, target_url, enabled, events_json, secret_ring,
        created_at, updated_at, kind, secret_hash, secret_sealed, created_by,
        last_delivery_at)
     VALUES (?, ?, 'generic', '', 1, '[]', '', ?, ?, 'inbound', ?, ?, ?, NULL)`
  )
    .bind(id, name, createdAt, createdAt, secretHash, sealed, actor.label)
    .run();

  return Response.json(
    {
      id,
      name,
      secret,
      enabled: true,
      created_at: createdAt,
      created_by: actor.label,
    },
    { status: 201, headers: { "Cache-Control": "no-store" } }
  );
}

/**
 * Create an outbound endpoint.
 *
 * The URL is validated here as well as at dispatch: a row that can never be
 * authorised should not exist, and a test ping must not be able to point the
 * Worker at a private address. `secret_ring` stays empty because outbound
 * signing uses the sealed single secret, not the legacy dual-ring.
 */
async function createOutboundWebhook(
  env: Env,
  actor: AdminActor,
  name: string,
  body: Record<string, unknown>
): Promise<Response> {
  const targetUrl = typeof body.target_url === "string" ? body.target_url.trim() : "";
  if (targetUrl === "") {
    return Response.json(
      { error: "bad_url", message: "target_url is required for an outbound webhook" },
      { status: 400 }
    );
  }
  let protocol = "";
  try {
    protocol = new URL(targetUrl).protocol;
  } catch {
    return Response.json({ error: "bad_url", message: "target_url is not a valid URL" }, { status: 400 });
  }
  if (protocol !== "https:" || isBlockedWebhookHost(targetUrl)) {
    return Response.json(
      { error: "bad_url", message: "target_url must be a public https URL" },
      { status: 400 }
    );
  }

  const events =
    body.events === undefined
      ? []
      : Array.isArray(body.events)
        ? body.events.filter((event): event is string => typeof event === "string").slice(0, 50)
        : null;
  if (events === null) {
    return Response.json(
      { error: "bad_request", message: "events must be an array of strings" },
      { status: 400 }
    );
  }

  let customHeaders: Record<string, string> | null = null;
  if (body.custom_headers !== undefined) {
    if (
      body.custom_headers === null ||
      typeof body.custom_headers !== "object" ||
      Array.isArray(body.custom_headers)
    ) {
      return Response.json(
        { error: "bad_request", message: "custom_headers must be an object of strings" },
        { status: 400 }
      );
    }
    customHeaders = {};
    for (const [header, value] of Object.entries(body.custom_headers as Record<string, unknown>)) {
      if (typeof value === "string") customHeaders[header] = value;
    }
  }

  const timeoutMs = readBoundedInt(body.timeout_ms, 10_000, 1_000, 60_000);
  if (timeoutMs === null) {
    return Response.json(
      { error: "bad_request", message: "timeout_ms must be an integer between 1000 and 60000" },
      { status: 400 }
    );
  }
  const maxAttempts = readBoundedInt(body.max_attempts, 8, 1, 20);
  if (maxAttempts === null) {
    return Response.json(
      { error: "bad_request", message: "max_attempts must be an integer between 1 and 20" },
      { status: 400 }
    );
  }
  const deviceId =
    typeof body.device_id === "string" && body.device_id.trim() !== ""
      ? body.device_id.trim()
      : null;

  // Content policy. `redacted` is the default because a webhook receiver is a
  // third party: it should not start receiving message bodies because someone
  // registered a URL. `full` is an explicit opt-in, and `allowlisted_raw` names
  // who or what may be forwarded raw.
  const policyRaw = body.body_policy === undefined ? "redacted" : body.body_policy;
  if (policyRaw !== "redacted" && policyRaw !== "allowlisted_raw" && policyRaw !== "full") {
    return Response.json(
      { error: "bad_request", message: "body_policy must be 'redacted', 'allowlisted_raw' or 'full'" },
      { status: 400 }
    );
  }
  const bodyPolicy = policyRaw as WebhookBodyPolicy;

  let allowlist: BodyAllowlistConfig | null = null;
  if (body.body_allowlist !== undefined) {
    if (
      body.body_allowlist === null ||
      typeof body.body_allowlist !== "object" ||
      Array.isArray(body.body_allowlist)
    ) {
      return Response.json(
        { error: "bad_request", message: "body_allowlist must be an object" },
        { status: 400 }
      );
    }
    const raw = body.body_allowlist as Record<string, unknown>;
    const senders = Array.isArray(raw.senders)
      ? raw.senders.filter((entry): entry is string => typeof entry === "string")
      : undefined;
    const bodyPatterns = Array.isArray(raw.body_patterns)
      ? raw.body_patterns.filter((entry): entry is string => typeof entry === "string")
      : undefined;
    if (
      (raw.senders !== undefined && (!Array.isArray(raw.senders) || senders === undefined)) ||
      (raw.body_patterns !== undefined &&
        (!Array.isArray(raw.body_patterns) || bodyPatterns === undefined))
    ) {
      return Response.json(
        { error: "bad_request", message: "body_allowlist names senders and body_patterns only" },
        { status: 400 }
      );
    }
    allowlist = {
      ...(senders === undefined ? {} : { senders }),
      ...(bodyPatterns === undefined ? {} : { body_patterns: bodyPatterns }),
    };
    // A pattern is evaluated as a regex on every dispatch, so it is bounded and
    // proven to compile at write time rather than throwing under traffic.
    const problem = validateBodyAllowlist(allowlist);
    if (problem !== null) {
      return Response.json({ error: "bad_request", message: problem }, { status: 400 });
    }
    if ((senders?.length ?? 0) > MAX_ALLOWLIST_PATTERNS) {
      return Response.json(
        { error: "bad_request", message: `senders may hold at most ${MAX_ALLOWLIST_PATTERNS} entries` },
        { status: 400 }
      );
    }
  }

  const signingKeyIdRaw = body.signing_key_id;
  const signingKeyId =
    signingKeyIdRaw === undefined ? "k1" : typeof signingKeyIdRaw === "string" ? signingKeyIdRaw.trim() : "";
  if (signingKeyId === "" || signingKeyId.length > 32 || !/^[A-Za-z0-9._-]+$/.test(signingKeyId)) {
    return Response.json(
      { error: "bad_request", message: "signing_key_id must be 1..32 of [A-Za-z0-9._-]" },
      { status: 400 }
    );
  }

  let metadataJson: string | null = null;
  if (body.metadata !== undefined && body.metadata !== null) {
    if (typeof body.metadata !== "object" || Array.isArray(body.metadata)) {
      return Response.json({ error: "bad_request", message: "metadata must be an object" }, { status: 400 });
    }
    const serialised = JSON.stringify(body.metadata);
    if (serialised.length > 2_048) {
      return Response.json({ error: "bad_request", message: "metadata is over 2 KB" }, { status: 400 });
    }
    metadataJson = serialised;
  }

  const secret = randomHex(32);
  const secretHash = await sha256Hex(secret);
  const sealed = await sealSecret(env, secret);
  if (sealed === null) {
    return Response.json(
      {
        error: "webhook_secret_unavailable",
        message:
          "WEBHOOK_SECRET_KEY is required to seal a webhook secret; set it with `cf workers secrets update WEBHOOK_SECRET_KEY --type secret_text`",
      },
      { status: 503 }
    );
  }

  const id = `wh_${randomHex(12)}`;
  const createdAt = Date.now();
  await env.DB.prepare(
    `INSERT INTO webhooks
       (id, name, vertical, target_url, enabled, events_json, secret_ring,
        custom_headers_json, timeout_ms, max_attempts, device_id,
        signing_key_id, body_policy, body_allowlist_json, metadata_json,
        created_at, updated_at, kind, secret_hash, secret_sealed, created_by,
        last_delivery_at)
     VALUES (?, ?, 'generic', ?, 1, ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'outbound', ?, ?, ?, NULL)`
  )
    .bind(
      id,
      name,
      targetUrl,
      JSON.stringify(events),
      customHeaders === null ? null : JSON.stringify(customHeaders),
      timeoutMs,
      maxAttempts,
      deviceId,
      signingKeyId,
      bodyPolicy,
      allowlist === null ? null : JSON.stringify(allowlist),
      metadataJson,
      createdAt,
      createdAt,
      secretHash,
      sealed,
      actor.label
    )
    .run();

  return Response.json(
    {
      id,
      name,
      kind: "outbound",
      target_url: targetUrl,
      secret,
      enabled: true,
      events,
      custom_headers: customHeaders ?? {},
      timeout_ms: timeoutMs,
      max_attempts: maxAttempts,
      created_at: createdAt,
      created_by: actor.label,
    },
    { status: 201, headers: { "Cache-Control": "no-store" } }
  );
}

function readBoundedInt(value: unknown, fallback: number, min: number, max: number): number | null {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    return null;
  }
  return value;
}

function parseStringArray(value: unknown): string[] {
  try {
    const parsed: unknown = JSON.parse(typeof value === "string" ? value : "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseHeaders(value: unknown): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(typeof value === "string" ? value : "{}");
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [header, headerValue] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof headerValue === "string") out[header] = headerValue;
    }
    return out;
  } catch {
    return {};
  }
}

interface OutboundListRow {
  id: string;
  name: string;
  kind: string;
  target_url: string;
  enabled: number;
  events_json: string;
  custom_headers_json: string | null;
  timeout_ms: number;
  max_attempts: number;
  created_by: string | null;
  created_at: number;
  last_delivery_at: number | null;
  secret_set: number;
}

/**
 * `GET /v1/admin/webhooks?kind=outbound` (default inbound).
 *
 * Never the secret or its hash: `secret_set` says only whether one exists, so
 * a console can show "signing configured" without carrying key material.
 */
export async function handleWebhookList(
  env: Env,
  actor: AdminActor,
  kind: "inbound" | "outbound" = "inbound"
): Promise<Response> {
  const refused = adminRefusal(actor);
  if (refused !== null) return refused;

  const rows = await env.DB.prepare(
    `SELECT id, name, kind, target_url, enabled, events_json, custom_headers_json,
            timeout_ms, max_attempts, created_by, created_at, last_delivery_at,
            CASE WHEN secret_sealed IS NULL THEN 0 ELSE 1 END AS secret_set
       FROM webhooks WHERE kind = ?
       ORDER BY created_at DESC LIMIT 200`
  )
    .bind(kind)
    .all<OutboundListRow>();

  const webhooks = (rows.results ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    target_url: row.target_url,
    enabled: Number(row.enabled) === 1,
    events: parseStringArray(row.events_json),
    custom_headers: parseHeaders(row.custom_headers_json),
    timeout_ms: row.timeout_ms,
    max_attempts: row.max_attempts,
    created_by: row.created_by,
    created_at: row.created_at,
    last_delivery_at: row.last_delivery_at,
    secret_set: Number(row.secret_set) === 1,
  }));

  return json({ webhooks });
}

/** `DELETE /v1/admin/webhooks/:id` — the delivery rows cascade. */
export async function handleWebhookDelete(
  env: Env,
  id: string,
  actor: AdminActor
): Promise<Response> {
  const refused = adminRefusal(actor);
  if (refused !== null) return refused;

  const result = await env.DB.prepare(`DELETE FROM webhooks WHERE id = ?`).bind(id).run();
  if (Number(result.meta?.changes ?? 0) === 0) return json({ error: "not_found" }, 404);
  return json({ deleted: true, id });
}

/**
 * `POST /v1/admin/webhooks/:id/test`.
 *
 * One signed POST with the stored secret. The response reports the status and
 * latency but never the secret or the body. `ok` tracks the receiver's status,
 * so a 500 is a failed test rather than a transport error.
 */
export async function handleWebhookTest(
  env: Env,
  id: string,
  actor: AdminActor
): Promise<Response> {
  const refused = adminRefusal(actor);
  if (refused !== null) return refused;

  const row = await env.DB.prepare(
    `SELECT id, kind, target_url, secret_sealed, custom_headers_json, timeout_ms
       FROM webhooks WHERE id = ?`
  )
    .bind(id)
    .first<{
      id: string;
      kind: string;
      target_url: string;
      secret_sealed: string | null;
      custom_headers_json: string | null;
      timeout_ms: number;
    }>();
  if (row === null) return json({ error: "not_found" }, 404);
  if (row.kind !== "outbound") {
    return Response.json(
      { error: "conflict", message: "only an outbound webhook can be tested" },
      { status: 409 }
    );
  }
  if (isBlockedWebhookHost(row.target_url)) {
    return Response.json(
      { error: "bad_url", message: "target_url is not a public https URL" },
      { status: 400 }
    );
  }

  const secret = await openSecret(env, row.secret_sealed);
  if (secret === null) {
    return Response.json(
      {
        error: "webhook_secret_unavailable",
        message: "the signing secret could not be opened",
      },
      { status: 503 }
    );
  }

  const now = Date.now();
  const body = JSON.stringify({
    event: "test",
    webhook_id: row.id,
    sent_at: new Date(now).toISOString(),
  });
  // A test ping is signed exactly like a delivery, with an id the receiver can
  // treat as its idempotency key, so "the signature verifies" is proven against
  // the same scheme the real traffic uses.
  const hook = await findOutboundWebhook(env, row.target_url);
  const signed = await buildSignedEnvelopeHeaders({
    secret,
    deliveryId: `test_${crypto.randomUUID().replace(/-/g, "")}`,
    rawBody: body,
    keyId: hook?.keyId,
    nowMs: now,
  });
  const headers: Record<string, string> = {
    ...parseHeaders(row.custom_headers_json),
    "Content-Type": "application/json",
    "User-Agent": "DakFlare-Worker/7.0",
    ...signed,
  };

  const started = Date.now();
  try {
    const timeout = Math.min(Math.max(row.timeout_ms ?? 10_000, 1_000), 60_000);
    const response = await fetch(row.target_url, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(timeout),
    });
    return json({
      ok: response.ok,
      status: response.status,
      latency_ms: Date.now() - started,
      signed: true,
    });
  } catch {
    return json({
      ok: false,
      status: 0,
      latency_ms: Date.now() - started,
      signed: true,
    });
  }
}

/**
 * `POST /v1/admin/webhooks/:id/rotate-secret` — a new signing secret, once.
 *
 * The old secret stops being used immediately: every delivery is signed at
 * consumption, so nothing after this call carries it. `previous_valid_until` is
 * therefore a short transport bound, not a policy window — an already-sent
 * request can still be in flight, and nothing older than the fetch timeout can
 * arrive. A consumer that wants to accept the old secret for a day is making its
 * own policy; this field only promises what this deployment can keep.
 */
export async function handleWebhookSecretRotate(
  req: Request,
  env: Env,
  id: string,
  actor: AdminActor
): Promise<Response> {
  const refused = adminRefusal(actor);
  if (refused !== null) return refused;

  const row = await env.DB.prepare(`SELECT id, kind FROM webhooks WHERE id = ?`)
    .bind(id)
    .first<{ id: string; kind: string }>();
  if (row === null) return json({ error: "not_found" }, 404);
  if (row.kind !== "outbound") {
    return Response.json(
      { error: "conflict", message: "only an outbound webhook has a signing secret" },
      { status: 409 }
    );
  }

  const secret = randomHex(32);
  const secretHash = await sha256Hex(secret);
  const sealed = await sealSecret(env, secret);
  if (sealed === null) {
    return Response.json(
      {
        error: "webhook_secret_unavailable",
        message:
          "WEBHOOK_SECRET_KEY is required to seal a webhook secret; set it with `cf workers secrets update WEBHOOK_SECRET_KEY --type secret_text`",
      },
      { status: 503 }
    );
  }

  const now = Date.now();
  const previousValidUntil = now + 300_000;
  await env.DB.prepare(
    `UPDATE webhooks SET secret_hash = ?, secret_sealed = ?, updated_at = ? WHERE id = ?`
  )
    .bind(secretHash, sealed, now, id)
    .run();

  await writeAudit(env, {
    action: "webhook.secret_rotated",
    actor: { userId: actor.userId, label: actor.label },
    subject: id,
    detail: { previous_valid_until: previousValidUntil },
    ...requestMeta(req),
  });

  return Response.json(
    { id, secret, previous_valid_until: previousValidUntil },
    { status: 200, headers: { "Cache-Control": "no-store" } }
  );
}

/** `GET /v1/admin/webhooks/:id/deliveries` — the last 20, newest first. */
export async function handleWebhookDeliveries(
  env: Env,
  id: string,
  actor: AdminActor
): Promise<Response> {
  const refused = adminRefusal(actor);
  if (refused !== null) return refused;

  const hook = await env.DB.prepare(`SELECT id FROM webhooks WHERE id = ? AND kind = 'inbound'`)
    .bind(id)
    .first<{ id: string }>();
  if (hook === null) return json({ error: "not_found" }, 404);

  const rows = await env.DB.prepare(
    `SELECT id, webhook_id, received_at, body_json, status, answer_text, error
       FROM webhook_deliveries WHERE webhook_id = ?
       ORDER BY received_at DESC LIMIT ${DELIVERY_LIST_LIMIT}`
  )
    .bind(id)
    .all<DeliveryRow>();
  return json({ deliveries: rows.results ?? [] });
}

/* ───────────────────────────── ingress ───────────────────────────── */

function deliveryMessage(bodyText: string): { ok: true; message: string } | { ok: false } {
  let parsed: unknown = null;
  try {
    parsed = bodyText.trim() === "" ? {} : JSON.parse(bodyText);
  } catch {
    return { ok: false };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false };
  }
  const record = parsed as Record<string, unknown>;
  const direct = typeof record.message === "string" ? record.message : record.text;
  const message =
    typeof direct === "string"
      ? direct.trim()
      : JSON.stringify(record).slice(0, MAX_WEBHOOK_MESSAGE_CHARS);
  if (message === "") return { ok: false };
  if (message.length > MAX_WEBHOOK_MESSAGE_CHARS) return { ok: false };
  return { ok: true, message };
}

function replay(row: DeliveryRow): Response {
  if (row.status === "succeeded") {
    return json({
      id: row.id,
      webhook_id: row.webhook_id,
      replayed: true,
      answer: row.answer_text ?? "",
    });
  }
  if (row.status === "failed") {
    return Response.json(
      {
        id: row.id,
        webhook_id: row.webhook_id,
        replayed: true,
        error: "webhook_turn_failed",
        message: row.error ?? "the turn failed",
      },
      { status: 502 }
    );
  }
  return Response.json(
    { id: row.id, webhook_id: row.webhook_id, error: "delivery_in_progress" },
    { status: 409 }
  );
}

/**
 * `POST /v1/webhooks/:id`.
 *
 * Order: look up the hook, refuse a disabled one, rate-limit per hook, read a
 * bounded body, verify the signature, require the delivery id, then claim it.
 * The claim is the insert itself, so two concurrent copies of one delivery
 * cannot both run a turn.
 */
export async function handleWebhookIngress(
  req: Request,
  env: Env,
  id: string
): Promise<Response> {
  if (env.AGENT_RUNTIME !== "on") {
    return Response.json(
      { error: "agent_runtime_off", message: "the agent runtime is not enabled" },
      { status: 503 }
    );
  }

  // Throttle before any D1 read so unknown webhook ids cannot burn D1 quota.
  if (env.ADMIN_LIMITER) {
    const { success } = await env.ADMIN_LIMITER.limit({ key: `webhook:${id.slice(0, 64)}` });
    if (!success) return err("rate_limited", 429);
  }

  const hook = await env.DB.prepare(
    `SELECT id, name, secret_hash, secret_sealed, enabled, created_by, created_at, last_delivery_at
       FROM webhooks WHERE id = ? AND kind = 'inbound'`
  )
    .bind(id)
    .first<WebhookRow>();
  if (hook === null) return json({ error: "not_found" }, 404);

  if (Number(hook.enabled) !== 1) {
    return Response.json(
      { error: "webhook_disabled", message: "this webhook is disabled" },
      { status: 403 }
    );
  }

  const bounded = await readBodyBounded(req, MAX_WEBHOOK_BODY_BYTES);
  if (!bounded.ok) return err("payload_too_large", 413);

  const tsHeader = req.headers.get("x-dakflare-timestamp");
  if (tsHeader !== null && tsHeader.trim() !== "") {
    const tsNum = Number(tsHeader.trim());
    if (!Number.isFinite(tsNum)) {
      return Response.json(
        { error: "invalid_timestamp", message: "x-dakflare-timestamp is malformed" },
        { status: 401 }
      );
    }
    const tsMs = tsNum < 1e12 ? tsNum * 1_000 : tsNum;
    if (Math.abs(Date.now() - tsMs) > 300_000) {
      return Response.json(
        { error: "invalid_timestamp", message: "webhook timestamp outside allowed window" },
        { status: 401 }
      );
    }
  }

  const secret = await openSecret(env, hook.secret_sealed);
  if (secret === null) {
    return Response.json(
      { error: "webhook_secret_unavailable", message: "the signing secret could not be opened" },
      { status: 503 }
    );
  }

  const verified = await verifyWebhookSignature(
    secret,
    bounded.text,
    req.headers.get("x-dakflare-signature")
  );
  if (!verified) return err("invalid_signature", 401);

  const deliveryId = (req.headers.get("x-dakflare-delivery") ?? "").trim();
  if (deliveryId === "" || deliveryId.length > MAX_DELIVERY_ID_CHARS) {
    return Response.json(
      {
        error: "bad_request",
        message: `x-dakflare-delivery is required and must be at most ${MAX_DELIVERY_ID_CHARS} characters`,
      },
      { status: 400 }
    );
  }

  const message = deliveryMessage(bounded.text);
  if (!message.ok) {
    return Response.json(
      { error: "bad_request", message: "body must be a JSON object with a non-empty message" },
      { status: 400 }
    );
  }

  const receivedAt = Date.now();
  const claimed = await env.DB.prepare(
    `INSERT INTO webhook_deliveries
       (id, webhook_id, received_at, body_json, status, answer_text, error)
     VALUES (?, ?, ?, ?, 'running', NULL, NULL)
     ON CONFLICT(id) DO NOTHING`
  )
    .bind(deliveryId, hook.id, receivedAt, bounded.text.slice(0, MAX_WEBHOOK_BODY_BYTES))
    .run();

  if (Number(claimed.meta?.changes ?? 0) === 0) {
    const existing = await env.DB.prepare(
      `SELECT id, webhook_id, received_at, body_json, status, answer_text, error
         FROM webhook_deliveries WHERE id = ?`
    )
      .bind(deliveryId)
      .first<DeliveryRow>();
    if (existing === null) return json({ error: "conflict" }, 409);
    // A delivery id belongs to the hook that claimed it. Reusing it on another
    // hook is a conflict, never a way to read that hook's answer.
    if (existing.webhook_id !== hook.id) {
      return Response.json(
        { error: "conflict", message: "this delivery id belongs to another webhook" },
        { status: 409 }
      );
    }
    // Reclaim stale 'running' rows abandoned by an isolate crash (> 5 min old).
    const isStaleRunning =
      existing.status === "running" && receivedAt - existing.received_at > 300_000;
    if (isStaleRunning) {
      const reclaimed = await env.DB.prepare(
        `UPDATE webhook_deliveries
            SET received_at = ?, body_json = ?, error = NULL
          WHERE id = ? AND webhook_id = ? AND status = 'running' AND received_at < ?`
      )
        .bind(
          receivedAt,
          bounded.text.slice(0, MAX_WEBHOOK_BODY_BYTES),
          deliveryId,
          hook.id,
          receivedAt - 300_000
        )
        .run();
      if (Number(reclaimed.meta?.changes ?? 0) === 0) return replay(existing);
    } else {
      return replay(existing);
    }
  }

  const actor: AdminActor = {
    userId: null,
    label: `webhook:${hook.id}`,
    role: "webhook",
    canGrantOwner: false,
  };

  const markFailed = async (reason: string): Promise<void> => {
    await env.DB.prepare(
      `UPDATE webhook_deliveries SET status = 'failed', error = ? WHERE id = ?`
    )
      .bind(reason.slice(0, 500), deliveryId)
      .run();
    await env.DB.prepare(`UPDATE webhooks SET last_delivery_at = ? WHERE id = ?`)
      .bind(receivedAt, hook.id)
      .run();
  };

  if (env.ASSISTANT === undefined) {
    await markFailed("agent_runtime_off: the ASSISTANT binding is not configured");
    return Response.json(
      { error: "webhook_turn_failed", reason: "agent_runtime_off", message: "the agent runtime is not configured" },
      { status: 502 }
    );
  }

  try {
    const stub = env.ASSISTANT.getByName(ASSISTANT_OBJECT_NAME);
    const result = await stub.say(actor, message.message);
    if (!result.ok) {
      await markFailed(`${result.reason}: ${result.message}`);
      return Response.json(
        { error: "webhook_turn_failed", reason: result.reason, message: result.message },
        { status: 502 }
      );
    }
    // The DO stub's RPC type widens `ok`, so read the success field explicitly.
    const success = result as unknown as { answer?: unknown };
    const answer = typeof success.answer === "string" ? success.answer : "";

    await env.DB.prepare(
      `UPDATE webhook_deliveries
          SET status = 'succeeded', answer_text = ?, error = NULL
        WHERE id = ?`
    )
      .bind(answer.slice(0, 100_000), deliveryId)
      .run();
    await env.DB.prepare(`UPDATE webhooks SET last_delivery_at = ? WHERE id = ?`)
      .bind(receivedAt, hook.id)
      .run();

    return json({
      id: deliveryId,
      webhook_id: hook.id,
      replayed: false,
      answer,
    });
  } catch (error) {
    const reason = `webhook_turn_failed: ${String(error)}`;
    await markFailed(reason);
    return Response.json(
      { error: "webhook_turn_failed", reason: "webhook_turn_failed", message: String(error).slice(0, 200) },
      { status: 502 }
    );
  }
}
