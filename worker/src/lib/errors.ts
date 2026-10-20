/**
 * Uniform error envelope — PROTOCOL_CONTRACT_V5 Rev C §8.
 *
 * Every error response the device can observe is:
 *   Response.json({ error: "<code>" }, { status })
 * with `<code>` drawn from exactly the §8 table, so the client never has to
 * guess and `nonce_replay` / `timestamp_out_of_window` stay distinct from
 * `invalid_signature` (§8: collapsing them is what makes this protocol
 * undebuggable from a phone).
 */

/** The complete §8 code set. Nothing outside this union may be returned by `err()`. */
export type ErrorCode =
  | "unexpected_query"
  | "bad_request"
  | "rule_rejected"
  | "missing_auth_headers"
  | "malformed_header"
  | "timestamp_out_of_window"
  | "bad_signature_length"
  | "invalid_signature"
  | "device_unknown"
  | "nonce_replay"
  | "rate_limited";

/** §8 status codes, as a compile-time map so call sites cannot drift. */
export const ERROR_STATUS: Readonly<Record<ErrorCode, number>> = {
  unexpected_query: 400,
  bad_request: 400,
  rule_rejected: 400,
  missing_auth_headers: 401,
  malformed_header: 401,
  timestamp_out_of_window: 401,
  bad_signature_length: 401,
  invalid_signature: 401,
  device_unknown: 401,
  nonce_replay: 401,
  rate_limited: 429,
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
