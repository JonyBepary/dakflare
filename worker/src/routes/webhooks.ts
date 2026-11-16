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
import type { AdminActor } from "../audit";
import { assertHuman } from "../lib/authority";
import { err } from "../lib/errors";
import { readBodyBounded } from "../lib/body";
import { ASSISTANT_OBJECT_NAME } from "../lib/agent-runtime";

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

async function sha256Hex(value: string): Promise<string> {
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

/** HMAC-SHA256(secret, rawBody) as lowercase hex. */
export async function hmacSha256Hex(secret: string, rawBody: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
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

/** `v1.<iv-hex>.<ciphertext-hex>` so a future key version can be introduced. */
async function sealSecret(env: Env, secret: string): Promise<string | null> {
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

async function openSecret(env: Env, sealed: string | null): Promise<string | null> {
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

  return json(
    {
      id,
      name,
      secret,
      enabled: true,
      created_at: createdAt,
      created_by: actor.label,
    },
    201
  );
}

/** `GET /v1/admin/webhooks` — never the secret or its hash. */
export async function handleWebhookList(env: Env, actor: AdminActor): Promise<Response> {
  const refused = adminRefusal(actor);
  if (refused !== null) return refused;

  const rows = await env.DB.prepare(
    `SELECT id, name, enabled, created_by, created_at, last_delivery_at
       FROM webhooks WHERE kind = 'inbound'
       ORDER BY created_at DESC LIMIT 200`
  ).all<Omit<WebhookRow, "secret_hash" | "secret_sealed">>();
  return json({ webhooks: rows.results ?? [] });
}

/** `DELETE /v1/admin/webhooks/:id` — the delivery rows cascade. */
export async function handleWebhookDelete(
  env: Env,
  id: string,
  actor: AdminActor
): Promise<Response> {
  const refused = adminRefusal(actor);
  if (refused !== null) return refused;

  const result = await env.DB.prepare(`DELETE FROM webhooks WHERE id = ? AND kind = 'inbound'`).bind(id).run();
  if (Number(result.meta?.changes ?? 0) === 0) return json({ error: "not_found" }, 404);
  return json({ deleted: true, id });
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

  // Per-hook budget, keyed on the proven row rather than an unauthenticated
  // header. The key is namespaced so an admin caller's budget is untouched.
  if (env.ADMIN_LIMITER) {
    const { success } = await env.ADMIN_LIMITER.limit({ key: `webhook:${hook.id}` });
    if (!success) return err("rate_limited", 429);
  }

  const bounded = await readBodyBounded(req, MAX_WEBHOOK_BODY_BYTES);
  if (!bounded.ok) return err("payload_too_large", 413);

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
    return replay(existing);
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
