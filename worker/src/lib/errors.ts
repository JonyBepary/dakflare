/**
 * Uniform error envelope — PROTOCOL_CONTRACT_V5 Rev C §8.
 *
 * Every error response the device can observe is:
 *   Response.json({ error: "<code>" }, { status })
 * with `<code>` drawn from exactly the §8 table, so the client never has to
 * guess and `nonce_replay` / `timestamp_out_of_window` stay distinct from
 * `invalid_signature` (§8: collapsing them is what makes this protocol
 * undebuggable from a phone).
 *
 * Three codes extend the §8 table for conditions the frozen document did not have
 * to describe: `device_exists` (pairing refused an unauthorized rebind),
 * `daily_quota_exceeded` (this device spent its own daily write allowance) and
 * `storage_unavailable` (the write did not happen; retry). They are distinct codes
 * for the same reason as the rest: "try again tomorrow", "retry now" and "someone
 * else owns this device" must not all look like `bad_request`.
 *
 * A fourth extension, `workflow_invalid`, is ADMIN-ONLY: a saved workflow graph
 * failed `lib/workflow.ts`. It carries a `details` array of
 * `{ path, message }` issues so the canvas can point at the offending field, which
 * `bad_request`'s bare envelope cannot express. Devices never see it.
 */

/** The complete §8 code set, plus the documented extensions above. */
export type ErrorCode =
  | "unexpected_query"
  | "bad_request"
  | "rule_rejected"
  /** Admin-only: a workflow graph failed `lib/workflow.ts`; `details` lists the issues. */
  | "workflow_invalid"
  | "missing_auth_headers"
  | "malformed_header"
  | "timestamp_out_of_window"
  | "bad_signature_length"
  | "invalid_signature"
  | "device_unknown"
  | "nonce_replay"
  | "rate_limited"
  | "payload_too_large"
  /** Pairing: the target device_id is already registered and no rotation was authorized. */
  | "device_exists"
  /** The caller's own daily write reservation is exhausted. Retry tomorrow. */
  | "daily_quota_exceeded"
  /** A backing store failed; the batch was NOT written and the device should retry. */
  | "storage_unavailable"
  /**
   * Admin-only: `POST /v1/sms/send/batch` does not carry per-entry replay
   * semantics yet, so a key there is refused rather than silently ignored.
   */
  | "idempotency_key_not_supported_in_batch";

/** §8 status codes, as a compile-time map so call sites cannot drift. */
export const ERROR_STATUS: Readonly<Record<ErrorCode, number>> = {
  unexpected_query: 400,
  bad_request: 400,
  rule_rejected: 400,
  workflow_invalid: 400,
  missing_auth_headers: 401,
  malformed_header: 401,
  timestamp_out_of_window: 401,
  bad_signature_length: 401,
  invalid_signature: 401,
  device_unknown: 401,
  nonce_replay: 401,
  rate_limited: 429,
  payload_too_large: 413,
  device_exists: 409,
  daily_quota_exceeded: 429,
  storage_unavailable: 503,
  idempotency_key_not_supported_in_batch: 400,
};

const KNOWN_CODES = new Set<string>(Object.keys(ERROR_STATUS));

/** True when `code` is one of the §8 codes. */
export function isErrorCode(code: unknown): code is ErrorCode {
  return typeof code === "string" && KNOWN_CODES.has(code);
}

/**
 * Build the §8 error envelope.
 *
 * `status` defaults to the §8 status for that code, so `err("nonce_replay")`
 * and `err("nonce_replay", 401)` are the same response.
 */
export function err(code: ErrorCode, status: number = ERROR_STATUS[code]): Response {
  return Response.json({ error: code }, { status });
}

/**
 * Map an arbitrary upstream string (typically the DO's error body) onto a §8
 * code, degrading to `invalid_signature` for anything unrecognised so a leaky
 * DO message can never invent a code the client does not know.
 */
export function asErrorCode(value: unknown, fallback: ErrorCode = "invalid_signature"): ErrorCode {
  return isErrorCode(value) ? value : fallback;
}
