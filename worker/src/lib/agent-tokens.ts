/**
 * Agent tokens — minting, resolving and the per-token send budget.
 *
 * Shape: `dkf_agt_<id>_<secret>`.
 *
 *   id      16 lowercase hex characters, stored plainly. It is the lookup key and
 *           the value an operator names when revoking, so it must be readable.
 *   secret  32 random bytes, base64url. Stored ONLY as SHA-256 hex.
 *
 * A plain digest is right here, unlike a password: the secret is 256 bits of
 * CSPRNG output with no structure to guess, so there is no dictionary to attack
 * and no reason to pay for a slow KDF on every request. What the digest buys is
 * that a database leak does not hand the attacker a usable token, and that the
 * comparison is over a fixed 32 bytes.
 *
 * The token itself is never logged. Every function here takes the raw value only
 * long enough to split it; callers pass the id from then on.
 */

import type { Env } from "../index";
import { isTokenScope } from "./agent-scopes";

export const AGENT_TOKEN_PREFIX = "dkf_agt_";

/** Bounds, so a hand-written request cannot mint an unbounded credential. */
export const AGENT_TOKEN_ID_CHARS = 16;
export const MAX_AGENT_NAME_CHARS = 64;
export const DEFAULT_AGENT_SENDS_PER_HOUR = 20;
export const MAX_AGENT_SENDS_PER_HOUR = 1_000;

/** The fixed window the send budget is counted over. */
const QUOTA_WINDOW_MS = 3_600_000;

/** The unattended-send scope a `service` token may hold. */
export const TRANSACTIONAL_SCOPE = "sms:send:transactional";

/** How stale `last_used_at` may get before a request writes it again. */
const LAST_USED_REFRESH_MS = 60_000;

export type AgentTokenKind = "agent" | "service";

export interface AgentTokenRecord {
  id: string;
  name: string;
  scopes: string[];
  /**
   * `agent` is the default and the only kind that can act on a human grant.
   * `service` is an integration credential: it may hold
   * `sms:send:transactional` and send unattended under its allowlists.
   */
  kind: AgentTokenKind;
  /** NULL means fleet-wide; a grant then has to narrow each action. */
  device_id: string | null;
  /** `service` only: JSON array of device ids, or null for any. */
  allowed_device_ids: string[] | null;
  /** `service` only: JSON array of channels, or null for any. */
  allowed_channels: string[] | null;
  /** Free-form integration metadata. Never read by the send gate. */
  metadata: Record<string, unknown> | null;
  max_per_hour: number;
  sent_current_hour: number;
  hour_window_start: number;
  created_at: number;
  created_by: string;
  last_used_at: number | null;
  expires_at: number | null;
  revoked_at: number | null;
}

interface AgentTokenRow {
  id: string;
  name: string;
  token_hash: string;
  scopes_json: string;
  kind: string | null;
  device_id: string | null;
  allowed_device_ids_json: string | null;
  allowed_channels_json: string | null;
  metadata_json: string | null;
  max_per_hour: number;
  sent_current_hour: number;
  hour_window_start: number;
  created_at: number;
  created_by: string;
  last_used_at: number | null;
  expires_at: number | null;
  revoked_at: number | null;
}

/* ───────────────────────────── minting ───────────────────────────── */

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  let out = "";
  for (const byte of buffer) out += byte.toString(16).padStart(2, "0");
  return out;
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const bytes = new Uint8Array(digest);
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** Constant-time comparison over two equal-length lowercase hex strings. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface MintedAgentToken {
  /** The value to hand to the agent. Printed once; never stored. */
  token: string;
  id: string;
  record: AgentTokenRecord;
}

export interface MintAgentTokenInput {
  name: string;
  scopes: string[];
  /** Defaults to `agent`. Only `service` may hold `sms:send:transactional`. */
  kind?: AgentTokenKind;
  allowedDeviceIds?: string[] | null;
  allowedChannels?: string[] | null;
  metadata?: Record<string, unknown> | null;
  deviceId: string | null;
  maxPerHour: number;
  /** Absolute expiry in ms, or null for a token that does not expire on its own. */
  expiresAt: number | null;
  createdBy: string;
}

/**
 * Mint a token and insert its row.
 *
 * Validation is the caller's job for the HTTP shape; what belongs here is the
 * invariant an operator cannot be talked out of: an unknown scope is refused
 * rather than dropped, because a token that silently lacks a scope it printed is
 * worse than one that failed to mint.
 */
export async function mintAgentToken(
  env: Env,
  input: MintAgentTokenInput
): Promise<
  | { ok: true; minted: MintedAgentToken }
  | { ok: false; unknown: string[] }
  | { ok: false; refused: string }
> {
  const unknown = input.scopes.filter((scope) => !isTokenScope(scope));
  if (unknown.length > 0) return { ok: false, unknown: unknown };

  // The one coupling between a token's kind and a scope, enforced at mint rather
  // than only at send: an `agent` token that printed `sms:send:transactional`
  // would be a credential that claims a capability the gate will refuse.
  const kind: AgentTokenKind = input.kind === "service" ? "service" : "agent";
  if (kind === "agent" && input.scopes.includes(TRANSACTIONAL_SCOPE)) {
    return {
      ok: false,
      refused:
        `${TRANSACTIONAL_SCOPE} is only valid on a service token; mint with kind: "service" ` +
        "or use sms:send with a human grant",
    };
  }

  const id = randomHex(AGENT_TOKEN_ID_CHARS / 2);
  const secretBytes = new Uint8Array(32);
  crypto.getRandomValues(secretBytes);
  const secret = base64url(secretBytes);
  const tokenHash = await sha256Hex(secret);
  const now = Date.now();
  const scopes = [...new Set(input.scopes)];

  const allowedDeviceIds = normalizeIdList(input.allowedDeviceIds);
  const allowedChannels = normalizeIdList(input.allowedChannels);
  await env.DB.prepare(
    `INSERT INTO agent_tokens
       (id, name, token_hash, scopes_json, kind, device_id, allowed_device_ids_json,
        allowed_channels_json, metadata_json, max_per_hour,
        sent_current_hour, hour_window_start, created_at, created_by, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`
  )
    .bind(
      id,
      input.name,
      tokenHash,
      JSON.stringify(scopes),
      kind,
      input.deviceId,
      allowedDeviceIds === null ? null : JSON.stringify(allowedDeviceIds),
      allowedChannels === null ? null : JSON.stringify(allowedChannels),
      input.metadata === undefined || input.metadata === null
        ? null
        : JSON.stringify(input.metadata),
      input.maxPerHour,
      now,
      input.createdBy,
      input.expiresAt
    )
    .run();

  return {
    ok: true,
    minted: {
      token: `${AGENT_TOKEN_PREFIX}${id}_${secret}`,
      id,
      record: {
        id,
        name: input.name,
        scopes,
        kind,
        device_id: input.deviceId,
        allowed_device_ids: allowedDeviceIds,
        allowed_channels: allowedChannels,
        metadata: input.metadata ?? null,
        max_per_hour: input.maxPerHour,
        sent_current_hour: 0,
        hour_window_start: 0,
        created_at: now,
        created_by: input.createdBy,
        last_used_at: null,
        expires_at: input.expiresAt,
        revoked_at: null,
      },
    },
  };
}

/* ──────────────────────────── resolving ──────────────────────────── */

/** Split a raw header value into its id and secret. `null` for anything malformed. */
export function parseAgentToken(raw: string): { id: string; secret: string } | null {
  if (!raw.startsWith(AGENT_TOKEN_PREFIX)) return null;
  const rest = raw.slice(AGENT_TOKEN_PREFIX.length);
  // The id is hex, so the FIRST underscore separates it from the secret, which
  // may itself contain underscores (base64url).
  const separator = rest.indexOf("_");
  if (separator <= 0) return null;
  const id = rest.slice(0, separator);
  const secret = rest.slice(separator + 1);
  if (id.length !== AGENT_TOKEN_ID_CHARS || !/^[0-9a-f]+$/.test(id)) return null;
  if (secret.length < 40) return null;
  return { id, secret };
}

/** True when a header value is shaped like one of our agent tokens, valid or not. */
export function looksLikeAgentToken(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(AGENT_TOKEN_PREFIX);
}

function toRecord(row: AgentTokenRow): AgentTokenRecord {
  return {
    id: row.id,
    name: row.name,
    scopes: parseScopes(row.scopes_json),
    kind: row.kind === "service" ? "service" : "agent",
    device_id: row.device_id,
    allowed_device_ids: parseStringList(row.allowed_device_ids_json),
    allowed_channels: parseStringList(row.allowed_channels_json),
    metadata: parseMetadata(row.metadata_json),
    max_per_hour: row.max_per_hour,
    sent_current_hour: row.sent_current_hour,
    hour_window_start: row.hour_window_start,
    created_at: row.created_at,
    created_by: row.created_by,
    last_used_at: row.last_used_at,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
  };
}

function parseStringList(value: string | null): string[] | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    return null;
  }
}

function parseMetadata(value: string | null): Record<string, unknown> | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Deduplicate, drop blanks, and treat an empty list as "unset" (null). */
function normalizeIdList(value: string[] | null | undefined): string[] | null {
  if (value === undefined || value === null) return null;
  const cleaned = [...new Set(value.map((entry) => entry.trim()).filter((entry) => entry !== ""))];
  return cleaned.length === 0 ? null : cleaned;
}

function parseScopes(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === "string");
  } catch {
    // A corrupted row grants nothing. Failing closed is the only safe reading.
    return [];
  }
}

/**
 * Resolve a raw bearer value to a live token, or `null`.
 *
 * Revocation and expiry are checked here, on every request, so "revoking takes
 * effect on the next request" is a property of the resolver rather than a
 * promise about cache invalidation.
 */
export async function resolveAgentToken(
  env: Env,
  raw: string
): Promise<AgentTokenRecord | null> {
  const parsed = parseAgentToken(raw);
  if (parsed === null) return null;

  const row = await env.DB.prepare(
    `SELECT id, name, token_hash, scopes_json, kind, device_id,
            allowed_device_ids_json, allowed_channels_json, metadata_json, max_per_hour,
            sent_current_hour, hour_window_start, created_at, created_by,
            last_used_at, expires_at, revoked_at
       FROM agent_tokens WHERE id = ?`
  )
    .bind(parsed.id)
    .first<AgentTokenRow>();
  if (row === null) return null;

  const provided = await sha256Hex(parsed.secret);
  if (!timingSafeEqualHex(provided, row.token_hash)) return null;

  const now = Date.now();
  if (row.revoked_at !== null && row.revoked_at <= now) return null;
  if (row.expires_at !== null && row.expires_at <= now) return null;

  return toRecord(row);
}

/**
 * Record that the token was used, at most once a minute.
 *
 * `last_used_at` is the only signal an operator has that a minted token is
 * actually in use, so it is worth a write; it is not worth a write per request,
 * which would double the cost of every read for a field nobody watches closely.
 */
const LAST_USED_MEMO = new Map<string, number>();

export async function recordTokenUse(env: Env, tokenId: string, now = Date.now()): Promise<void> {
  const prev = LAST_USED_MEMO.get(tokenId);
  if (prev !== undefined && now - prev < LAST_USED_REFRESH_MS) return;
  if (LAST_USED_MEMO.size >= 512) LAST_USED_MEMO.clear();
  LAST_USED_MEMO.set(tokenId, now);
  try {
    await env.DB.prepare(
      `UPDATE agent_tokens SET last_used_at = ?
        WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)`
    )
      .bind(now, tokenId, now - LAST_USED_REFRESH_MS)
      .run();
  } catch (error) {
    console.error(`[agent-token] last_used_at write failed: ${String(error)}`);
  }
}

/* ───────────────────────────── input helpers ───────────────────────────── */

export function clampSendsPerHour(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_AGENT_SENDS_PER_HOUR;
  return Math.min(
    MAX_AGENT_SENDS_PER_HOUR,
    Math.max(1, Math.trunc(numeric))
  );
}

/* ─────────────────────────────── listing ─────────────────────────────── */

export async function listAgentTokens(
  env: Env,
  options: { includeRevoked?: boolean } = {}
): Promise<AgentTokenRecord[]> {
  const rows = await env.DB.prepare(
    `SELECT id, name, token_hash, scopes_json, kind, device_id,
            allowed_device_ids_json, allowed_channels_json, metadata_json, max_per_hour,
            sent_current_hour, hour_window_start, created_at, created_by,
            last_used_at, expires_at, revoked_at
       FROM agent_tokens
      ${options.includeRevoked === true ? "" : "WHERE revoked_at IS NULL"}
      ORDER BY created_at DESC
      LIMIT 200`
  ).all<AgentTokenRow>();
  return (rows.results ?? []).map(toRecord);
}

export async function getAgentToken(env: Env, id: string): Promise<AgentTokenRecord | null> {
  const row = await env.DB.prepare(
    `SELECT id, name, token_hash, scopes_json, kind, device_id,
            allowed_device_ids_json, allowed_channels_json, metadata_json, max_per_hour,
            sent_current_hour, hour_window_start, created_at, created_by,
            last_used_at, expires_at, revoked_at
       FROM agent_tokens WHERE id = ?`
  )
    .bind(id)
    .first<AgentTokenRow>();
  return row === null ? null : toRecord(row);
}

/**
 * Revoke a token. Returns the row as it was, or `null` when it was already
 * revoked or does not exist — the caller needs to tell those apart from a
 * successful revoke, and "already revoked" is not a success to report twice.
 */
export async function revokeAgentToken(env: Env, id: string): Promise<AgentTokenRecord | null> {
  const now = Date.now();
  const result = await env.DB.prepare(
    `UPDATE agent_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`
  )
    .bind(now, id)
    .run();
  if (Number(result.meta?.changes ?? 0) === 0) return null;
  return getAgentToken(env, id);
}

/* ─────────────────────────────── the budget ─────────────────────────────── */

export type QuotaOutcome =
  | { ok: true; used: number; limit: number; resets_at: number }
  | { ok: false; used: number; limit: number; resets_at: number };

interface QuotaRow {
  sent_current_hour: number;
  hour_window_start: number;
  max_per_hour: number;
}

/**
 * Read the budget without spending it.
 *
 * Used to refuse a send BEFORE a grant use is recorded, so `use_count` counts
 * sends rather than attempts. This is advisory only: `consumeSendQuota` is the
 * authoritative spend, and it re-checks the same condition atomically.
 */
export async function peekSendQuota(
  env: Env,
  tokenId: string,
  now = Date.now(),
  count = 1
): Promise<QuotaOutcome> {
  const row = await env.DB.prepare(
    `SELECT sent_current_hour, hour_window_start, max_per_hour
       FROM agent_tokens WHERE id = ?`
  )
    .bind(tokenId)
    .first<QuotaRow>();

  const used = row?.sent_current_hour ?? 0;
  const limit = row?.max_per_hour ?? DEFAULT_AGENT_SENDS_PER_HOUR;
  const windowStart = row?.hour_window_start ?? now;
  const rolledOver = now - windowStart >= QUOTA_WINDOW_MS;
  const resetsAt = rolledOver ? now + QUOTA_WINDOW_MS : windowStart + QUOTA_WINDOW_MS;
  const effectiveUsed = rolledOver ? 0 : used;

  if (effectiveUsed + count > limit) return { ok: false, used, limit, resets_at: resetsAt };
  return { ok: true, used, limit, resets_at: resetsAt };
}

/**
 * Spend SMS from the token's fixed hourly window.
 *
 * ONE conditional UPDATE, then one read for the numbers the caller reports. The
 * condition is the whole budget check: D1 exposes no isolation level beyond a
 * single statement, so a SELECT-then-UPDATE pair would let two Workers both see
 * room for the last send. `meta.changes` is the answer.
 *
 * The window advances only when the current one has run out, so the count cannot
 * drift and a caller cannot reset its own budget by waiting less than an hour.
 */
export async function consumeSendQuota(
  env: Env,
  tokenId: string,
  now = Date.now(),
  count = 1
): Promise<QuotaOutcome> {
  const updated = await env.DB.prepare(
    `UPDATE agent_tokens
        SET sent_current_hour = CASE WHEN (? - hour_window_start) >= ? THEN ?
                                     ELSE sent_current_hour + ? END,
            hour_window_start  = CASE WHEN (? - hour_window_start) >= ? THEN ?
                                      ELSE hour_window_start END
      WHERE id = ?
        AND revoked_at IS NULL
        AND ((? - hour_window_start) >= ? OR (sent_current_hour + ?) <= max_per_hour)`
  )
    .bind(
      now,
      QUOTA_WINDOW_MS,
      count,
      count,
      now,
      QUOTA_WINDOW_MS,
      now,
      tokenId,
      now,
      QUOTA_WINDOW_MS,
      count
    )
    .run();

  const row = await env.DB.prepare(
    `SELECT sent_current_hour, hour_window_start, max_per_hour
       FROM agent_tokens WHERE id = ?`
  )
    .bind(tokenId)
    .first<QuotaRow>();

  const used = row?.sent_current_hour ?? 0;
  const limit = row?.max_per_hour ?? DEFAULT_AGENT_SENDS_PER_HOUR;
  const windowStart = row?.hour_window_start ?? now;
  // A window that has just rolled over resets "when" to an hour from now.
  const resetsAt =
    now - windowStart >= QUOTA_WINDOW_MS ? now + QUOTA_WINDOW_MS : windowStart + QUOTA_WINDOW_MS;

  if (Number(updated.meta?.changes ?? 0) === 0) {
    return { ok: false, used, limit, resets_at: resetsAt };
  }
  return { ok: true, used, limit, resets_at: resetsAt };
}

/** Roll back sent quota if downstream DO enqueue fails. */
export async function rollbackSendQuota(
  env: Env,
  tokenId: string,
  count = 1
): Promise<void> {
  await env.DB.prepare(
    `UPDATE agent_tokens
        SET sent_current_hour = MAX(0, sent_current_hour - ?)
      WHERE id = ?`
  )
    .bind(count, tokenId)
    .run();
}
