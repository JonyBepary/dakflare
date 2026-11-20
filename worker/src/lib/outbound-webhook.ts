/**
 * Outbound webhook signing.
 *
 * A flow's `webhook` action POSTs to a URL registered in `webhooks` as
 * `kind = 'outbound'`. When that row carries a sealed signing secret, the
 * Worker signs the request so the receiver can prove it came from this
 * deployment and that the body was not altered in transit.
 *
 * Canonical string: `<unix-seconds>.<raw-body>`. The timestamp is inside the
 * signed value, so a receiver can reject a stale delivery without trusting an
 * unsigned header. Signing happens at the edge, immediately before `fetch`,
 * which is why the queue consumer signs at consumption rather than enqueue: a
 * queued job may wait, and a timestamp minted at enqueue would be stale.
 *
 * The secret never reaches a log line, and neither does the request body.
 */

import type { Env } from "../index";
import { openSecret } from "../routes/webhooks";

export const OUTBOUND_TIMESTAMP_HEADER = "X-Dakflare-Timestamp";
export const OUTBOUND_SIGNATURE_HEADER = "X-Dakflare-Signature";

const encoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/**
 * `sha256=<lowercase hex>` over `` `${timestampSeconds}.${rawBody}` ``.
 *
 * Exactly the inbound scheme (`routes/webhooks.ts`) with the timestamp folded
 * into the signed string. One HMAC, one prefix, so a receiver does not need a
 * second parser for the outbound direction.
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
}

interface OutboundWebhookRow {
  id: string;
  target_url: string;
  secret_sealed: string | null;
}

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
    `SELECT id, target_url, secret_sealed
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

  const secret = await openSecret(env, match.secret_sealed);
  return { id: match.id, target_url: match.target_url, secret };
}

/**
 * Merge the signing headers into a request's headers.
 *
 * With no matching hook, or a legacy hook with no secret, the base headers are
 * returned unchanged. Any signature headers already present are dropped first:
 * a producer that queued a stale pair must not have it forwarded, because the
 * receiver would verify it against the wrong timestamp.
 */
export async function signOutboundRequest(
  env: Env,
  url: string,
  baseHeaders: Record<string, string>,
  rawBody: string,
  now: number = Date.now()
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(baseHeaders)) {
    const lower = name.toLowerCase();
    if (
      lower === OUTBOUND_TIMESTAMP_HEADER.toLowerCase() ||
      lower === OUTBOUND_SIGNATURE_HEADER.toLowerCase()
    ) {
      continue;
    }
    headers[name] = value;
  }

  const hook = await findOutboundWebhook(env, url);
  if (hook === null || hook.secret === null) return headers;

  const timestampSeconds = Math.floor(now / 1000);
  const signature = await signOutboundWebhook(hook.secret, timestampSeconds, rawBody);
  headers[OUTBOUND_TIMESTAMP_HEADER] = String(timestampSeconds);
  headers[OUTBOUND_SIGNATURE_HEADER] = signature;
  return headers;
}
