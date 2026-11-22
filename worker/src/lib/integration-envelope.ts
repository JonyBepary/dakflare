/**
 * Canonical Integration Envelope v1 signing and verification.
 *
 * Canonical string:
 *   `v1.${timestampSeconds}.${deliveryId}.${rawBody}`
 *
 * Headers:
 *   X-Dakflare-Timestamp  Unix epoch seconds (signed)
 *   X-Dakflare-Delivery   Stable delivery UUID / idempotency key / nonce (signed)
 *   X-Dakflare-Signature  `v1=<lowercase sha256 hex>`
 *   X-Dakflare-Key-Id     Key identifier for zero-downtime secret rotation (e.g. `k1`)
 *   X-Trace-Id            End-to-end request trace identifier
 */

export const HEADER_TIMESTAMP = "X-Dakflare-Timestamp";
export const HEADER_DELIVERY = "X-Dakflare-Delivery";
export const HEADER_SIGNATURE = "X-Dakflare-Signature";
export const HEADER_KEY_ID = "X-Dakflare-Key-Id";
export const HEADER_TRACE_ID = "X-Trace-Id";

export const ENVELOPE_VERSION = "v1";
export const DEFAULT_MAX_SKEW_SECONDS = 300;
export const DEFAULT_KEY_ID = "k1";

const encoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function canonicalEnvelopeString(
  timestampSeconds: number,
  deliveryId: string,
  rawBody: string
): string {
  return `${ENVELOPE_VERSION}.${timestampSeconds}.${deliveryId}.${rawBody}`;
}

export async function signIntegrationEnvelope(
  secret: string,
  timestampSeconds: number,
  deliveryId: string,
  rawBody: string
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const canonical = canonicalEnvelopeString(timestampSeconds, deliveryId, rawBody);
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(canonical));
  return `${ENVELOPE_VERSION}=${toHex(new Uint8Array(digest))}`;
}

export interface SignedEnvelopeHeaders {
  [HEADER_TIMESTAMP]: string;
  [HEADER_DELIVERY]: string;
  [HEADER_SIGNATURE]: string;
  [HEADER_KEY_ID]: string;
  [HEADER_TRACE_ID]?: string;
}

export async function buildSignedEnvelopeHeaders(input: {
  secret: string;
  deliveryId: string;
  rawBody: string;
  keyId?: string;
  traceId?: string;
  nowMs?: number;
}): Promise<SignedEnvelopeHeaders> {
  const timestampSeconds = Math.floor((input.nowMs ?? Date.now()) / 1000);
  const signature = await signIntegrationEnvelope(
    input.secret,
    timestampSeconds,
    input.deliveryId,
    input.rawBody
  );
  const headers: SignedEnvelopeHeaders = {
    [HEADER_TIMESTAMP]: String(timestampSeconds),
    [HEADER_DELIVERY]: input.deliveryId,
    [HEADER_SIGNATURE]: signature,
    [HEADER_KEY_ID]: input.keyId && input.keyId.trim() !== "" ? input.keyId.trim() : DEFAULT_KEY_ID,
  };
  if (input.traceId && input.traceId.trim() !== "") {
    headers[HEADER_TRACE_ID] = input.traceId.trim();
  }
  return headers;
}

export interface VerifyEnvelopeResult {
  ok: boolean;
  reason?:
    | "missing_headers"
    | "invalid_timestamp"
    | "timestamp_skew"
    | "unsupported_version"
    | "signature_mismatch";
  timestampSeconds?: number;
  deliveryId?: string;
  keyId?: string;
}

export async function verifyIntegrationEnvelope(input: {
  secret: string;
  timestampHeader: string | null;
  deliveryHeader: string | null;
  signatureHeader: string | null;
  keyIdHeader?: string | null;
  rawBody: string;
  nowMs?: number;
  maxSkewSeconds?: number;
}): Promise<VerifyEnvelopeResult> {
  const { secret, timestampHeader, deliveryHeader, signatureHeader, rawBody } = input;
  if (!timestampHeader || !deliveryHeader || !signatureHeader) {
    return { ok: false, reason: "missing_headers" };
  }

  const timestampSeconds = Number(timestampHeader);
  if (!Number.isInteger(timestampSeconds) || timestampSeconds <= 0) {
    return { ok: false, reason: "invalid_timestamp" };
  }

  const nowSeconds = Math.floor((input.nowMs ?? Date.now()) / 1000);
  const maxSkew = input.maxSkewSeconds ?? DEFAULT_MAX_SKEW_SECONDS;
  if (Math.abs(nowSeconds - timestampSeconds) > maxSkew) {
    return { ok: false, reason: "timestamp_skew" };
  }

  if (!signatureHeader.startsWith(`${ENVELOPE_VERSION}=`)) {
    return { ok: false, reason: "unsupported_version" };
  }

  const expected = await signIntegrationEnvelope(
    secret,
    timestampSeconds,
    deliveryHeader,
    rawBody
  );
  if (!timingSafeEqualHex(expected, signatureHeader)) {
    return { ok: false, reason: "signature_mismatch" };
  }

  return {
    ok: true,
    timestampSeconds,
    deliveryId: deliveryHeader,
    keyId: input.keyIdHeader ?? DEFAULT_KEY_ID,
  };
}
