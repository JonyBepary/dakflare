/**
 * Outbound webhook signing.
 *
 * A flow's `webhook` action POSTs to a URL registered in `webhooks` as
 * `kind = 'outbound'`. When that row carries a sealed signing secret, the
 * Worker signs the request so the receiver can prove it came from this
 * deployment and that the body was not altered in transit.
 *
 * Two schemes exist and only one is written now:
 *
 *   v1  `v1.<unix-seconds>.<delivery-id>.<raw-body>` — the delivery id inside
 *       the signed value is the idempotency key AND the nonce, so a replay of a
 *       captured request cannot be re-labelled with a fresh timestamp. This is
 *       what `buildSignedEnvelopeHeaders` emits, alongside `X-Dakflare-Key-Id`
 *       and the propagated `X-Trace-Id`.
 *   v0  `<unix-seconds>.<raw-body>` — the original scheme. Kept exported, and
 *       still verified by receivers that have not migrated, but no producer in
 *       this repository signs with it any more.
 *
 * The secret never reaches a log line, and neither does the request body.
 */

import type { Env } from "../index";
import { openSecret } from "../routes/webhooks";
import {
  HEADER_DELIVERY,
  HEADER_KEY_ID,
  HEADER_SIGNATURE,
  HEADER_TIMESTAMP,
  HEADER_TRACE_ID,
  buildSignedEnvelopeHeaders,
} from "./integration-envelope";
import { parseBodyAllowlist, type BodyAllowlistConfig, type WebhookBodyPolicy } from "./content-policy";

export const OUTBOUND_TIMESTAMP_HEADER = HEADER_TIMESTAMP;
export const OUTBOUND_SIGNATURE_HEADER = HEADER_SIGNATURE;
export const OUTBOUND_DELIVERY_HEADER = HEADER_DELIVERY;
export const OUTBOUND_KEY_ID_HEADER = HEADER_KEY_ID;
export const OUTBOUND_TRACE_HEADER = HEADER_TRACE_ID;

const SIGNATURE_HEADERS: ReadonlySet<string> = new Set(
  [
    HEADER_TIMESTAMP,
    HEADER_SIGNATURE,
    HEADER_DELIVERY,
    HEADER_KEY_ID,
    HEADER_TRACE_ID,
  ].map((name) => name.toLowerCase())
);

const encoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/**
 * `sha256=<lowercase hex>` over `` `${timestampSeconds}.${rawBody}` ``.
 *
 * The v0 scheme. It is still here because a receiver written against v0 must
 * keep working while it migrates; nothing inside this Worker emits it.
 */
export async function signOutboundWebhook(
  secret: string,
  timestampSeconds: number,
  rawBody: string
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${timestampSeconds}.${rawBody}`)
  );
  return `sha256=${toHex(new Uint8Array(signature))}`;
}

export interface OutboundWebhookMatch {
  id: string;
  target_url: string;
  /** Plaintext signing secret, or `null` for a legacy row with no sealed copy. */
  secret: string | null;
  /** Which key signed, so a rotation can accept two keys at once. */
  keyId: string;
  bodyPolicy: WebhookBodyPolicy;
  bodyAllowlist: BodyAllowlistConfig;
  events: string[];
  customHeaders: Record<string, string>;
  timeoutMs: number;
  maxAttempts: number;
}

interface OutboundWebhookRow {
  id: string;
  target_url: string;
  secret_sealed: string | null;
  signing_key_id: string | null;
  body_policy: string | null;
  body_allowlist_json: string | null;
  events_json: string | null;
  custom_headers_json: string | null;
  timeout_ms: number | null;
  max_attempts: number | null;
}

function asPolicy(value: string | null): WebhookBodyPolicy {
  return value === "allowlisted_raw" || value === "full" ? value : "redacted";
}

function parseStringArray(value: string | null): string[] {
  if (value === null) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function parseHeaderMap(value: string | null): Record<string, string> {
  if (value === null) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [name, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof entry === "string") out[name] = entry;
    }
    return out;
  } catch {
    return {};
  }
}

function toMatch(row: OutboundWebhookRow): OutboundWebhookMatch {
  return {
    id: row.id,
    target_url: row.target_url,
    secret: null,
    keyId: row.signing_key_id && row.signing_key_id.trim() !== "" ? row.signing_key_id : "k1",
    bodyPolicy: asPolicy(row.body_policy),
    bodyAllowlist: parseBodyAllowlist(row.body_allowlist_json),
    events: parseStringArray(row.events_json),
    customHeaders: parseHeaderMap(row.custom_headers_json),
    timeoutMs: row.timeout_ms ?? 10_000,
    maxAttempts: row.max_attempts ?? 8,
  };
}

const SELECT_COLUMNS = `id, target_url, secret_sealed, signing_key_id, body_policy,
            body_allowlist_json, events_json, custom_headers_json, timeout_ms, max_attempts`;

/**
 * Find the enabled outbound hook for a URL.
 *
 * An exact `target_url` match wins, then any hook on the same origin, which is
 * the same granularity `isAuthorizedWebhookUrl` authorises. A row whose
 * `secret_sealed` is NULL (pre-0015 legacy) still matches but signs nothing:
 * the receiver gets an unsigned request rather than a request signed with a
 * key that was never stored.
 */
export async function findOutboundWebhook(
  env: Env,
  url: string
): Promise<OutboundWebhookMatch | null> {
  let target: URL | null = null;
  try {
    target = new URL(url);
  } catch {
    return null;
  }

  const rows = await env.DB.prepare(
    `SELECT ${SELECT_COLUMNS}
       FROM webhooks
      WHERE kind = 'outbound' AND enabled = 1`
  ).all<OutboundWebhookRow>();
  const candidates = rows.results ?? [];

  let match: OutboundWebhookRow | null = null;
  for (const row of candidates) {
    if (row.target_url === url) {
      match = row;
      break;
    }
  }
  if (match === null) {
    for (const row of candidates) {
      try {
        if (new URL(row.target_url).origin === target.origin) {
          match = row;
          break;
        }
      } catch {
        // A malformed registered URL cannot match anything.
      }
    }
  }
  if (match === null) return null;

  const result = toMatch(match);
  result.secret = await openSecret(env, match.secret_sealed);
  return result;
}

/** Enabled outbound hooks subscribed to one event type. */
export async function findSubscribedWebhooks(
  env: Env,
  eventType: string
): Promise<OutboundWebhookMatch[]> {
  const rows = await env.DB.prepare(
    `SELECT ${SELECT_COLUMNS}
       FROM webhooks
      WHERE kind = 'outbound' AND enabled = 1`
  ).all<OutboundWebhookRow>();
  const subscribed = (rows.results ?? []).filter((row) =>
    parseStringArray(row.events_json).includes(eventType)
  );
  return Promise.all(
    subscribed.map(async (row) => {
      const match = toMatch(row);
      match.secret = await openSecret(env, row.secret_sealed);
      return match;
    })
  );
}

/**
 * Merge the signing headers into a request's headers.
 *
 * With no matching hook, or a legacy hook with no secret, the base headers are
 * returned unchanged. Every signature header already present is dropped first: a
 * producer that queued a stale set must not have it forwarded, because the
 * receiver would verify it against the wrong timestamp or the wrong delivery id.
 */
export async function signOutboundRequest(
  env: Env,
  url: string,
  baseHeaders: Record<string, string>,
  rawBody: string,
  options: { deliveryId: string; traceId?: string; now?: number }
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(baseHeaders)) {
    if (SIGNATURE_HEADERS.has(name.toLowerCase())) continue;
    headers[name] = value;
  }

  const hook = await findOutboundWebhook(env, url);
  if (hook === null || hook.secret === null) return headers;

  const signed = await buildSignedEnvelopeHeaders({
    secret: hook.secret,
    deliveryId: options.deliveryId,
    rawBody,
    keyId: hook.keyId,
    traceId: options.traceId,
    nowMs: options.now,
  });
  return { ...headers, ...signed };
}
