/**
 * Channel connector administration and webhook ingress.
 *
 * A connector is one external account — a Page, an Instagram professional
 * account, a Telegram bot, a WhatsApp number — with its credential sealed at
 * rest. The credential is never returned after creation: a response can say a
 * secret exists and when it last changed, and nothing more.
 *
 * Three boundaries this file keeps:
 *
 *  1. Admin handlers call `assertHuman` first, exactly as `routes/approvals.ts`
 *     does. A `dkf_agt_` token or a webhook turn must not manage credentials,
 *     even if it somehow carries an admin-looking label.
 *  2. The hot webhook path reads KV, then D1 only on a miss. The cached record
 *     carries the sealed credential, the tier, the auth mode, the enabled flag
 *     and the connector id, so a POST does not touch D1 before the Durable
 *     Object has already deduplicated it.
 *  3. Isolation is the Durable Object name. Every account is
 *     `env.CHANNEL_CONN.getByName(`${channel}:${account_id}`)`; there is no
 *     shared or global connection object.
 *
 * Sealing is intentionally shared with `routes/webhooks.ts`: same
 * `WEBHOOK_SECRET_KEY`, same `dakflare-webhook-seal-v1` derivation, same
 * `v1.<iv>.<ciphertext>` envelope. Rotating that key invalidates channel
 * credentials the same way it invalidates webhook secrets, and both must be
 * re-entered. `secret_hash` is a SHA-256 fingerprint of the sealed plaintext so
 * a rotation can be observed without opening the envelope.
 */

import type { Env } from "../index";
import type { AdminActor } from "../audit";
import { writeAudit } from "../audit";
import { assertHuman } from "../lib/authority";
import { err } from "../lib/errors";
import { readBodyBounded } from "../lib/body";
import { openSecret, sealSecret, sha256Hex } from "./webhooks";
import type { NormalizedChannelEvent } from "../channels/connection-do";
import type { OutboundDeliveryResult, OutboundMessageParams } from "../plugins/types";
import {
  handleMetaChallenge,
  toReplyState,
  verifyMetaWebhookSignature,
  type MetaDeliveryStatus,
} from "../channels/meta-common";
import { parseMessengerWebhook } from "../channels/messenger";
import { parseInstagramWebhook } from "../channels/instagram";
import {
  parseWhatsAppCloudWebhook,
  sendWhatsAppCloudOutbound,
  whatsappStatusEventId,
  type WhatsAppCloudCredentials,
} from "../channels/whatsapp-cloud";
import {
  parseTelegramWebhook,
  sendTelegramOutbound,
  verifyTelegramWebhook,
} from "../channels/telegram-connector";
import { sendMessengerOutbound } from "../channels/messenger";
import { sendInstagramOutbound, type InstagramAuthMode } from "../channels/instagram";

/** An admin create/update body is configuration, not an upload. */
const MAX_CONNECTOR_BODY_BYTES = 64 * 1024;

/** Meta retries for 36 hours; a hard cap keeps one body from becoming a bill. */
const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

/**
 * KV's minimum expiry is 60 seconds. This is deliberately the floor: a
 * revocation must be visible quickly, and the DO already deduplicates, so the
 * cache is not the correctness boundary.
 */
const CACHE_TTL_SECONDS = 60;

const CHANNELS = ["sms", "whatsapp", "telegram", "messenger", "instagram"] as const;
type ConnectorChannel = (typeof CHANNELS)[number];

const EXECUTION_TIERS = ["worker_do", "edge_device"] as const;
type ExecutionTier = (typeof EXECUTION_TIERS)[number];

const AUTH_MODES = [
  "unified_login",
  "instagram_login",
  "facebook_login",
  "cloud_api",
  "coexistence",
  "bot_api",
  "business_bot",
  "gateway",
  "mtproto",
  "linked_device",
  "android_notif",
  "sim_radio",
] as const;
type AuthMode = (typeof AUTH_MODES)[number];

interface ConnectorRow {
  id: string;
  channel: string;
  account_id: string;
  execution_tier: string;
  auth_mode: string | null;
  label: string;
  secret_sealed: string | null;
  secret_hash: string | null;
  enabled: number;
  last_event_at: number | null;
  created_by: string;
  created_at: number;
  updated_at: number;
}

/** The subset of a connector that the webhook path is allowed to need. */
interface CachedConnector {
  id: string;
  channel: string;
  accountId: string;
  enabled: boolean;
  tier: string;
  authMode: string | null;
  label: string;
  sealed: string | null;
  updatedAt: number;
}

type CachedLookup = CachedConnector | { missing: true };

interface CredentialBag {
  appSecret?: string;
  verifyToken?: string;
  accessToken?: string;
  pageAccessToken?: string;
  botToken?: string;
  secretToken?: string;
  graphVersion?: string;
}

const META_CHANNELS = new Set<string>(["whatsapp", "messenger", "instagram"]);

/* ───────────────────────────── helpers ───────────────────────────── */

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  let out = "";
  for (const byte of buffer) out += byte.toString(16).padStart(2, "0");
  return out;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function adminRefusal(actor: AdminActor): Response | null {
  const human = assertHuman(actor);
  return human.ok ? null : human.response;
}

/**
 * Admin handlers additionally require a mutating role.
 *
 * `assertHuman` refuses an agent token and a webhook turn but accepts any human
 * session, including a member's; a member can read the fleet but must not mint
 * or rotate a credential. The ADMIN_TOKEN machine actor is the CLI and keeps
 * its access, so `routes/approvals.ts`'s human rule is preserved, not weakened.
 */
function connectorAdminRefusal(actor: AdminActor): Response | null {
  const refused = adminRefusal(actor);
  if (refused !== null) return refused;
  if (actor.role === "member") {
    return Response.json(
      {
        error: "permission",
        message: "channel credentials are managed by owners and admins",
      },
      { status: 403 }
    );
  }
  return null;
}

function isChannel(value: string): value is ConnectorChannel {
  return (CHANNELS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readJsonObject(req: Request): Promise<Record<string, unknown> | null> {
  const bounded = await readBodyBounded(req, MAX_CONNECTOR_BODY_BYTES);
  if (!bounded.ok) return null;
  if (bounded.text.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(bounded.text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Read the raw request bytes, bounded.
 *
 * The Meta signature is over the bytes, so this cannot go through
 * `readBodyBounded`'s text path: decoding and re-encoding would change the
 * input for any byte sequence that is not already valid UTF-8.
 */
async function readRawBodyBounded(req: Request, maxBytes: number): Promise<Uint8Array | null> {
  if (req.method === "GET" || req.method === "HEAD") return new Uint8Array(0);
  const stream = req.body;
  if (stream === null) return new Uint8Array(0);

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/** The public shape of a connector row: never `secret_sealed`, never `secret_hash`. */
function connectorView(row: ConnectorRow): Record<string, unknown> {
  const hasSecret = row.secret_sealed !== null && row.secret_sealed !== "";
  return {
    id: row.id,
    channel: row.channel,
    account_id: row.account_id,
    execution_tier: row.execution_tier,
    auth_mode: row.auth_mode,
    label: row.label,
    enabled: row.enabled === 1,
    // "a secret exists and was last set at this time" — never the secret.
    secret_set: hasSecret,
    secret_updated_at: hasSecret ? row.updated_at : null,
    last_event_at: row.last_event_at,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function cacheKey(channel: string, key: string): string {
  return `chanconn:v1:${channel}:${key}`;
}

async function cacheConnector(env: Env, row: ConnectorRow): Promise<void> {
  const record: CachedConnector = {
    id: row.id,
    channel: row.channel,
    accountId: row.account_id,
    enabled: row.enabled === 1,
    tier: row.execution_tier,
    authMode: row.auth_mode,
    label: row.label,
    sealed: row.secret_sealed,
    updatedAt: row.updated_at,
  };
  const payload = JSON.stringify(record);
  // Both identities are written because the webhook URL may name either the
  // connector id or the platform account id.
  await Promise.all([
    env.KV.put(cacheKey(row.channel, row.id), payload, { expirationTtl: CACHE_TTL_SECONDS }),
    env.KV.put(cacheKey(row.channel, row.account_id), payload, {
      expirationTtl: CACHE_TTL_SECONDS,
    }),
  ]);
}

async function invalidateConnector(
  env: Env,
  channel: string,
  id: string,
  accountId: string
): Promise<void> {
  await Promise.all([
    env.KV.delete(cacheKey(channel, id)),
    env.KV.delete(cacheKey(channel, accountId)),
  ]);
}

function isCachedConnector(value: CachedLookup): value is CachedConnector {
  return (value as { missing?: boolean }).missing !== true;
}

/**
 * Resolve a connector for a webhook.
 *
 * `key` is whatever the URL carried. The cache key is scoped by channel and
 * key, so two platforms cannot collide even if a Page id and an Instagram id
 * are the same string.
 */
async function resolveConnector(
  env: Env,
  channel: string,
  key: string
): Promise<CachedConnector | null> {
  const cached = await env.KV.get<CachedLookup>(cacheKey(channel, key), "json");
  if (cached !== null) return isCachedConnector(cached) ? cached : null;

  const byId = await env.DB.prepare(
    `SELECT id, channel, account_id, execution_tier, auth_mode, label, secret_sealed,
            secret_hash, enabled, last_event_at, created_by, created_at, updated_at
       FROM channel_connectors WHERE channel = ? AND id = ?`
  )
    .bind(channel, key)
    .first<ConnectorRow>();

  const row =
    byId ??
    (await env.DB.prepare(
      `SELECT id, channel, account_id, execution_tier, auth_mode, label, secret_sealed,
              secret_hash, enabled, last_event_at, created_by, created_at, updated_at
         FROM channel_connectors WHERE channel = ? AND account_id = ?`
    )
      .bind(channel, key)
      .first<ConnectorRow>());

  if (row === null) {
    // Negative cache: an unknown connector must not turn every unsigned POST
    // into a D1 read. 60 seconds is short enough that a just-created row is
    // found immediately (creation writes the positive value).
    await env.KV.put(cacheKey(channel, key), JSON.stringify({ missing: true }), {
      expirationTtl: CACHE_TTL_SECONDS,
    });
    return null;
  }

  await cacheConnector(env, row);
  return {
    id: row.id,
    channel: row.channel,
    accountId: row.account_id,
    enabled: row.enabled === 1,
    tier: row.execution_tier,
    authMode: row.auth_mode,
    label: row.label,
    sealed: row.secret_sealed,
    updatedAt: row.updated_at,
  };
}

async function openCredentials(
  env: Env,
  sealed: string | null
): Promise<CredentialBag | null> {
  const plain = await openSecret(env, sealed);
  if (plain === null) return null;
  try {
    const parsed: unknown = JSON.parse(plain);
    return isRecord(parsed) ? (parsed as CredentialBag) : null;
  } catch {
    return null;
  }
}

/* ───────────────────────────── create ───────────────────────────── */

function stringField(body: Record<string, unknown>, name: string): string | null {
  const value = body[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

const MAX_LABEL_CHARS = 64;
const MAX_ACCOUNT_ID_CHARS = 200;

export async function handleConnectorCreate(
  req: Request,
  env: Env,
  actor: AdminActor
): Promise<Response> {
  const refused = connectorAdminRefusal(actor);
  if (refused !== null) return refused;

  const body = await readJsonObject(req);
  if (body === null) return err("bad_request", 400);

  const channel = stringField(body, "channel")?.toLowerCase() ?? "";
  if (!isChannel(channel)) {
    return json({ error: "bad_request", message: "channel is not supported" }, 400);
  }

  const accountId = stringField(body, "account_id") ?? "";
  if (accountId === "" || accountId.length > MAX_ACCOUNT_ID_CHARS) {
    return json(
      {
        error: "bad_request",
        message: `account_id must be 1..${MAX_ACCOUNT_ID_CHARS} characters`,
      },
      400
    );
  }

  const label = stringField(body, "label") ?? "";
  if (label === "" || label.length > MAX_LABEL_CHARS) {
    return json(
      { error: "bad_request", message: `label must be 1..${MAX_LABEL_CHARS} characters` },
      400
    );
  }

  const tierRaw = stringField(body, "execution_tier") ?? "worker_do";
  if (!(EXECUTION_TIERS as readonly string[]).includes(tierRaw)) {
    return json({ error: "bad_request", message: "execution_tier is not supported" }, 400);
  }
  const tier = tierRaw as ExecutionTier;

  const authMode = resolveAuthMode(channel, body["auth_mode"]);
  if (authMode === "invalid") {
    return json({ error: "bad_request", message: "auth_mode is not supported" }, 400);
  }

  const secretValue = body["secret"];
  if (!isRecord(secretValue)) {
    return json(
      { error: "bad_request", message: "secret must be an object of credential fields" },
      400
    );
  }
  const credentials = secretValue as CredentialBag;
  const missing = missingCredentialFields(channel, credentials);
  if (missing !== null) {
    return json(
      {
        error: "bad_request",
        message: `secret is missing ${missing} for ${channel}`,
      },
      400
    );
  }

  const plaintext = canonicalJson(credentials);
  const sealed = await sealSecret(env, plaintext);
  if (sealed === null) {
    return json(
      {
        error: "connector_secret_unavailable",
        message:
          "WEBHOOK_SECRET_KEY is required to seal a channel credential; set it with `cf workers secrets update WEBHOOK_SECRET_KEY --type secret_text`",
      },
      503
    );
  }
  const secretHash = await sha256Hex(plaintext);

  const now = Date.now();
  const id = `conn_${randomHex(12)}`;
  const enabled = body["enabled"] === false || body["enabled"] === 0 ? 0 : 1;

  try {
    await env.DB.prepare(
      `INSERT INTO channel_connectors
         (id, channel, account_id, execution_tier, auth_mode, label, secret_sealed,
          secret_hash, enabled, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        channel,
        accountId,
        tier,
        authMode,
        label,
        sealed,
        secretHash,
        enabled,
        actor.label,
        now,
        now
      )
      .run();
  } catch (error) {
    if (String(error).toUpperCase().includes("UNIQUE")) {
      return json(
        {
          error: "connector_exists",
          message: "this channel already has a connector for that account_id",
        },
        409
      );
    }
    throw error;
  }

  const row: ConnectorRow = {
    id,
    channel,
    account_id: accountId,
    execution_tier: tier,
    auth_mode: authMode,
    label,
    secret_sealed: sealed,
    secret_hash: secretHash,
    enabled,
    last_event_at: null,
    created_by: actor.label,
    created_at: now,
    updated_at: now,
  };
  await cacheConnector(env, row);

  await writeAudit(env, {
    action: "channel_connector.created",
    actor: { userId: actor.userId, label: actor.label },
    subject: id,
    detail: { channel, account_id: accountId, execution_tier: tier, auth_mode: authMode },
  });

  return json(connectorView(row), 201);
}

/* ───────────────────────────── list ───────────────────────────── */

export async function handleConnectorList(env: Env, actor: AdminActor): Promise<Response> {
  const refused = connectorAdminRefusal(actor);
  if (refused !== null) return refused;

  const rows = await env.DB.prepare(
    `SELECT id, channel, account_id, execution_tier, auth_mode, label, secret_sealed,
            secret_hash, enabled, last_event_at, created_by, created_at, updated_at
       FROM channel_connectors ORDER BY created_at DESC LIMIT 200`
  ).all<ConnectorRow>();

  return json({ connectors: (rows.results ?? []).map(connectorView) });
}

/* ───────────────────────────── update ───────────────────────────── */

export async function handleConnectorUpdate(
  req: Request,
  env: Env,
  actor: AdminActor,
  id: string
): Promise<Response> {
  const refused = connectorAdminRefusal(actor);
  if (refused !== null) return refused;

  const body = await readJsonObject(req);
  if (body === null) return err("bad_request", 400);

  const row = await env.DB.prepare(
    `SELECT id, channel, account_id, execution_tier, auth_mode, label, secret_sealed,
            secret_hash, enabled, last_event_at, created_by, created_at, updated_at
       FROM channel_connectors WHERE id = ?`
  )
    .bind(id)
    .first<ConnectorRow>();
  if (row === null) return json({ error: "not_found" }, 404);

  // Routing identity is immutable. Changing either half would point the row at
  // a different Durable Object and leave the old one holding a live window.
  if (body["channel"] !== undefined && String(body["channel"]).toLowerCase() !== row.channel) {
    return json({ error: "bad_request", message: "channel is immutable" }, 400);
  }
  if (body["account_id"] !== undefined && String(body["account_id"]) !== row.account_id) {
    return json({ error: "bad_request", message: "account_id is immutable" }, 400);
  }

  let label = row.label;
  if (body["label"] !== undefined) {
    const next = stringField(body, "label") ?? "";
    if (next === "" || next.length > MAX_LABEL_CHARS) {
      return json(
        { error: "bad_request", message: `label must be 1..${MAX_LABEL_CHARS} characters` },
        400
      );
    }
    label = next;
  }

  let tier = row.execution_tier;
  if (body["execution_tier"] !== undefined) {
    const next = String(body["execution_tier"]);
    if (!(EXECUTION_TIERS as readonly string[]).includes(next)) {
      return json({ error: "bad_request", message: "execution_tier is not supported" }, 400);
    }
    tier = next;
  }

  let authMode = row.auth_mode;
  if (body["auth_mode"] !== undefined) {
    const next = resolveAuthMode(row.channel, body["auth_mode"]);
    if (next === "invalid") {
      return json({ error: "bad_request", message: "auth_mode is not supported" }, 400);
    }
    authMode = next;
  }

  let enabled = row.enabled;
  if (body["enabled"] !== undefined) {
    const value = body["enabled"];
    if (value !== true && value !== false && value !== 0 && value !== 1) {
      return json({ error: "bad_request", message: "enabled must be a boolean" }, 400);
    }
    enabled = value === true || value === 1 ? 1 : 0;
  }

  let sealed = row.secret_sealed;
  let secretHash = row.secret_hash;
  if (body["secret"] !== undefined) {
    if (!isRecord(body["secret"])) {
      return json(
        { error: "bad_request", message: "secret must be an object of credential fields" },
        400
      );
    }
    const credentials = body["secret"] as CredentialBag;
    const missing = missingCredentialFields(row.channel, credentials);
    if (missing !== null) {
      return json(
        { error: "bad_request", message: `secret is missing ${missing} for ${row.channel}` },
        400
      );
    }
    const plaintext = canonicalJson(credentials);
    const nextSealed = await sealSecret(env, plaintext);
    if (nextSealed === null) {
      return json(
        {
          error: "connector_secret_unavailable",
          message:
            "WEBHOOK_SECRET_KEY is required to seal a channel credential; set it with `cf workers secrets update WEBHOOK_SECRET_KEY --type secret_text`",
        },
        503
      );
    }
    sealed = nextSealed;
    secretHash = await sha256Hex(plaintext);
  }

  const now = Date.now();
  await env.DB.prepare(
    `UPDATE channel_connectors
        SET execution_tier = ?, auth_mode = ?, label = ?, secret_sealed = ?,
            secret_hash = ?, enabled = ?, updated_at = ?
      WHERE id = ?`
  )
    .bind(tier, authMode, label, sealed, secretHash, enabled, now, id)
    .run();

  const next: ConnectorRow = {
    ...row,
    execution_tier: tier,
    auth_mode: authMode,
    label,
    secret_sealed: sealed,
    secret_hash: secretHash,
    enabled,
    updated_at: now,
  };

  // Cache the disabled row too: the webhook can then answer 403 from KV and
  // never reads D1 to discover that the connector was switched off.
  await cacheConnector(env, next);

  await writeAudit(env, {
    action: "channel_connector.updated",
    actor: { userId: actor.userId, label: actor.label },
    subject: id,
    detail: {
      channel: row.channel,
      account_id: row.account_id,
      enabled: enabled === 1,
      secret_rotated: body["secret"] !== undefined,
    },
  });

  return json(connectorView(next));
}

/* ───────────────────────────── delete ───────────────────────────── */

export async function handleConnectorDelete(
  env: Env,
  actor: AdminActor,
  id: string
): Promise<Response> {
  const refused = connectorAdminRefusal(actor);
  if (refused !== null) return refused;

  const row = await env.DB.prepare(
    `SELECT id, channel, account_id FROM channel_connectors WHERE id = ?`
  )
    .bind(id)
    .first<Pick<ConnectorRow, "id" | "channel" | "account_id">>();
  if (row === null) return json({ error: "not_found" }, 404);

  await env.DB.prepare(`DELETE FROM channel_connectors WHERE id = ?`).bind(id).run();
  await invalidateConnector(env, row.channel, row.id, row.account_id);

  // Stop the per-account object's alarm and release its storage. Failure here
  // must not resurrect the row: the credential is already gone from D1.
  try {
    const stub = env.CHANNEL_CONN.getByName(`${row.channel}:${row.account_id}`);
    await stub.revokeAndDestroy();
  } catch {
    // The object may already be evicted. D1 no longer routes to it either way.
  }

  await writeAudit(env, {
    action: "channel_connector.deleted",
    actor: { userId: actor.userId, label: actor.label },
    subject: id,
    detail: { channel: row.channel, account_id: row.account_id },
  });

  return json({ deleted: true, id });
}

/* ───────────────────────────── credential validation ───────────────────────────── */

function resolveAuthMode(channel: string, value: unknown): string | null | "invalid" {
  if (value === undefined || value === null || value === "") {
    if (channel === "instagram") return "unified_login";
    if (channel === "telegram") return "bot_api";
    if (channel === "whatsapp") return "cloud_api";
    return null;
  }
  if (typeof value !== "string") return "invalid";
  const mode = value.trim();
  if (!(AUTH_MODES as readonly string[]).includes(mode)) return "invalid";
  if (channel === "instagram") {
    return mode === "unified_login" || mode === "instagram_login" || mode === "facebook_login"
      ? mode
      : "invalid";
  }
  if (channel === "telegram") {
    return mode === "bot_api" || mode === "business_bot" ? mode : "invalid";
  }
  if (channel === "whatsapp") {
    // Coexistence ingests through the same Cloud API webhook shape; the only
    // difference is extra change fields, which the parser skips by name.
    return mode === "cloud_api" || mode === "coexistence" ? mode : "invalid";
  }
  return mode;
}

/** Which credential field is absent for this platform, or null when complete. */
function missingCredentialFields(
  channel: string,
  credentials: CredentialBag
): string | null {
  const present = (value: unknown): boolean => typeof value === "string" && value !== "";
  switch (channel) {
    case "whatsapp":
      if (!present(credentials.appSecret)) return "appSecret";
      if (!present(credentials.verifyToken)) return "verifyToken";
      if (!present(credentials.accessToken)) return "accessToken";
      return null;
    case "messenger":
      if (!present(credentials.appSecret)) return "appSecret";
      if (!present(credentials.verifyToken)) return "verifyToken";
      if (!present(credentials.accessToken) && !present(credentials.pageAccessToken)) {
        return "accessToken";
      }
      return null;
    case "instagram":
      if (!present(credentials.appSecret)) return "appSecret";
      if (!present(credentials.verifyToken)) return "verifyToken";
      if (!present(credentials.accessToken)) return "accessToken";
      return null;
    case "telegram":
      if (!present(credentials.botToken)) return "botToken";
      // An empty secret token means the webhook cannot verify anything, which
      // is a worse failure than refusing configuration.
      if (!present(credentials.secretToken)) return "secretToken";
      return null;
    default:
      return null;
  }
}

/**
 * Stable JSON for the fingerprint and the seal.
 *
 * Key order must not change the hash: an operator re-saving the same credential
 * with its fields in another order is not a rotation, and the console would
 * otherwise show a false one.
 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/* ───────────────────────────── outbound ───────────────────────────── */

function sendFailure(errorCode: string, substate?: string): OutboundDeliveryResult {
  return {
    success: false,
    state: "FAILED_PERMANENT",
    errorCode,
    ...(substate === undefined ? {} : { substate }),
  };
}

/**
 * Send through a connector's own sealed credential.
 *
 * This is the connector counterpart to the legacy plugin senders: the token,
 * app secret and account id come from the row, never from `env`. The platform
 * senders themselves are reused unchanged, so WhatsApp still goes through
 * `sendWhatsAppCloudOutbound`.
 *
 * Meta windows are read from the per-account Durable Object, not D1. Telegram
 * is not gated: Bot API chats have no 24-hour service window, and the DO's
 * window only tracks inbound messages as a convenience.
 */
export async function sendConnectorOutbound(
  env: Env,
  channel: string,
  connectorId: string,
  params: OutboundMessageParams
): Promise<OutboundDeliveryResult> {
  const normalized = channel.toLowerCase();
  if (!isChannel(normalized) || normalized === "sms") {
    return sendFailure("unsupported_channel");
  }

  const connector = await resolveConnector(env, normalized, connectorId);
  if (connector === null) return sendFailure("connector_not_found");
  if (!connector.enabled) return sendFailure("connector_disabled");

  const credentials = await openCredentials(env, connector.sealed);
  if (credentials === null) return sendFailure("connector_secret_unavailable");

  const stub = env.CHANNEL_CONN.getByName(`${normalized}:${connector.accountId}`);

  if (normalized === "telegram") {
    if (!credentials.botToken) return sendFailure("telegram_bot_token_missing");
    return sendTelegramOutbound(params, {
      botToken: credentials.botToken,
      secretToken: credentials.secretToken ?? "",
    });
  }

  const window = await stub.checkWindow(params.to);
  if (window.optedOut) return sendFailure("opted_out", "recipient sent STOP");

  const session = {
    windowOpen: window.open,
    requiresTemplate: !window.open,
    ...(window.expiresAt === null ? {} : { expiresAt: window.expiresAt }),
  };

  if (normalized === "whatsapp") {
    if (!credentials.accessToken) return sendFailure("whatsapp_credentials_missing");
    const whatsapp: WhatsAppCloudCredentials = {
      accessToken: credentials.accessToken,
      phoneNumberId: connector.accountId,
      ...(credentials.graphVersion === undefined
        ? {}
        : { graphVersion: credentials.graphVersion }),
    };
    return sendWhatsAppCloudOutbound(params, whatsapp, { session });
  }

  if (!window.open) {
    return sendFailure("window_expired", "24h_customer_service_window_expired");
  }

  if (normalized === "messenger") {
    const token = credentials.accessToken ?? credentials.pageAccessToken;
    if (!token) return sendFailure("messenger_credentials_missing");
    return sendMessengerOutbound(
      params as OutboundMessageParams & { useHumanAgentTag?: boolean },
      {
        pageId: connector.accountId,
        pageAccessToken: token,
        appSecret: credentials.appSecret ?? "",
        ...(credentials.graphVersion === undefined
          ? {}
          : { graphVersion: credentials.graphVersion }),
      }
    );
  }

  if (!credentials.accessToken) return sendFailure("instagram_credentials_missing");
  const authMode: InstagramAuthMode =
    connector.authMode === "instagram_login" || connector.authMode === "facebook_login"
      ? connector.authMode
      : "unified_login";
  return sendInstagramOutbound(params, {
    authMode,
    igUserId: connector.accountId,
    accessToken: credentials.accessToken,
    appSecret: credentials.appSecret ?? "",
    ...(credentials.graphVersion === undefined
      ? {}
      : { graphVersion: credentials.graphVersion }),
  });
}

/* ───────────────────────────── webhook ingress ───────────────────────────── */
/**
 * `GET|POST /v1/channels/:channel/:connectorId/webhook`.
 *
 * GET is Meta's subscribe handshake; POST is delivery. The order on POST is:
 * resolve from KV (D1 only on miss), refuse a disabled connector, read the raw
 * bytes once, verify the platform's credential, parse, hand to the per-account
 * Durable Object, then answer 200. No D1 write happens before the ACK.
 */
export async function handleChannelWebhook(
  req: Request,
  env: Env,
  channel: string,
  connectorId: string
): Promise<Response> {
  const normalized = channel.toLowerCase();
  if (!isChannel(normalized)) {
    return json({ error: "not_found" }, 404);
  }

  // Throttle before the KV/D1 lookup so a flood of invented connector ids
  // cannot turn the negative cache into a D1 read per random key.
  if (env.ADMIN_LIMITER) {
    const { success } = await env.ADMIN_LIMITER.limit({
      key: `chanhook:${normalized}:${connectorId.slice(0, 64)}`,
    });
    if (!success) return err("rate_limited", 429);
  }

  const connector = await resolveConnector(env, normalized, connectorId);
  if (connector === null) return json({ error: "not_found" }, 404);
  if (!connector.enabled) {
    return json(
      { error: "connector_disabled", message: "this connector is disabled" },
      403
    );
  }

  if (req.method === "GET") {
    if (!META_CHANNELS.has(normalized)) {
      return new Response("Method not allowed", { status: 405 });
    }
    const credentials = await openCredentials(env, connector.sealed);
    if (credentials === null) {
      return json(
        { error: "connector_secret_unavailable", message: "the credential could not be opened" },
        503
      );
    }
    return handleMetaChallenge(new URL(req.url), credentials.verifyToken);
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const raw = await readRawBodyBounded(req, MAX_WEBHOOK_BODY_BYTES);
  if (raw === null) return err("payload_too_large", 413);

  let messages: Array<{
    channelMessageId: string;
    sender: string;
    body: string;
    timestamp: number;
  }> = [];
  let statuses: Array<{
    channelMessageId: string;
    peerId: string;
    status: MetaDeliveryStatus;
    timestamp: number;
    errorCode?: string;
  }> = [];

  if (normalized === "telegram") {
    const credentials = await openCredentials(env, connector.sealed);
    if (credentials === null || credentials.botToken === undefined) {
      return json(
        { error: "connector_secret_unavailable", message: "the credential could not be opened" },
        503
      );
    }
    const verified = await verifyTelegramWebhook(req, {
      secretToken: credentials.secretToken ?? "",
    });
    if (!verified) return err("invalid_signature", 401);
    messages = parseTelegramWebhook(new TextDecoder().decode(raw));
  } else if (
    normalized === "messenger" ||
    normalized === "instagram" ||
    normalized === "whatsapp"
  ) {
    const credentials = await openCredentials(env, connector.sealed);
    if (credentials === null) {
      return json(
        { error: "connector_secret_unavailable", message: "the credential could not be opened" },
        503
      );
    }
    const verified = await verifyMetaWebhookSignature(
      req,
      raw,
      credentials.appSecret ?? ""
    );
    if (!verified) return err("invalid_signature", 401);

    const text = new TextDecoder().decode(raw);
    if (normalized === "whatsapp") {
      const parsed = parseWhatsAppCloudWebhook(text);
      for (const field of parsed.skippedFields) {
        // Coexistence payloads carry `smb_message_echoes` / `history` beside
        // `messages`. Skipping by name is deliberate: storing an echo as an
        // inbound message would show the operator their own reply as a
        // customer message, and the mode-specific fields have no D1 column.
        console.info(
          `[channels] skipped whatsapp change field "${field}" (auth_mode=${connector.authMode ?? "cloud_api"})`
        );
      }
      messages = parsed.messages.map((message) => ({
        channelMessageId: message.channelMessageId,
        sender: message.sender,
        body: message.body,
        timestamp: message.timestamp,
      }));
      statuses = parsed.statuses.map((status) => ({
        channelMessageId: status.channelMessageId,
        peerId: status.peerId,
        status: status.status,
        timestamp: status.timestamp,
        errorCode: status.errorCode,
      }));
    } else {
      const parsed =
        normalized === "messenger" ? parseMessengerWebhook(text) : parseInstagramWebhook(text);
      messages = parsed.messages.map((message) => ({
        channelMessageId: message.channelMessageId,
        sender: message.sender,
        body: message.body,
        timestamp: message.timestamp,
      }));
      statuses = parsed.statuses.map((status) => ({
        channelMessageId: status.channelMessageId,
        peerId: status.peerId,
        status: status.status,
        timestamp: status.timestamp,
        errorCode: status.errorCode,
      }));
    }
  } else {
    // SMS is owned by the device protocol, not a Meta-shaped webhook. A
    // connector row for it is accepted (the schema allows it) but this ingress
    // does not pretend to handle it.
    return json(
      { error: "unsupported_channel", message: `webhook ingress is not implemented for ${normalized}` },
      404
    );
  }

  const events: NormalizedChannelEvent[] = [];
  for (const message of messages) {
    if (message.channelMessageId === "") continue;
    events.push({
      connectorId: connector.id,
      channel: normalized,
      accountId: connector.accountId,
      eventKind: "inbound_message",
      eventId: message.channelMessageId,
      peerId: message.sender,
      body: message.body,
      timestamp: message.timestamp,
    });
  }
  for (const status of statuses) {
    // A Messenger read receipt carries only a watermark, not a message id, so
    // `read:<sender>:<watermark>` can never match a stored row. Emitting it
    // would be a guaranteed no-op update and a wasted queue slot.
    if (status.channelMessageId === "" || status.channelMessageId.startsWith("read:")) {
      continue;
    }
    events.push({
      connectorId: connector.id,
      channel: normalized,
      accountId: connector.accountId,
      eventKind: "status_update",
      // Two receipts for one wamid (`sent`, then `delivered`) are distinct
      // events; keying by the bare wamid would make the DO drop the second as
      // a replay. `ingest.ts` strips the suffix before matching the message.
      eventId:
        normalized === "whatsapp"
          ? whatsappStatusEventId(status.channelMessageId, status.status)
          : status.channelMessageId,
      peerId: status.peerId,
      // `read` is not a `messages.reply_state`; toReplyState folds it to
      // `delivered`, which is what a read receipt proves.
      status: toReplyState(status.status),
      errorCode: status.errorCode,
      timestamp: status.timestamp,
    });
  }

  if (events.length === 0) {
    // A valid delivery with nothing this product understands is still a 200:
    // a non-2xx makes Meta retry the same unusable payload for 36 hours.
    return json({ ok: true, accepted: 0, deduplicated: 0 });
  }

  try {
    const stub = env.CHANNEL_CONN.getByName(`${normalized}:${connector.accountId}`);
    const result = await stub.ingestEvents(events);
    return json({ ok: true, accepted: result.accepted, deduplicated: result.deduplicated });
  } catch (error) {
    // 5xx is the correct answer: Meta/Telegram retry, and the DO may simply
    // have been evicted mid-call.
    return json(
      { error: "ingest_unavailable", message: String(error).slice(0, 120) },
      500
    );
  }
}
