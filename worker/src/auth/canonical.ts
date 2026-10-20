/**
 * Canonical string construction — PROTOCOL_CONTRACT_V5 Rev C §2, §3.1, §4.
 *
 * This module is deliberately PURE, SYNCHRONOUS and DEPENDENCY-FREE: it imports
 * nothing, touches no global state, performs no I/O and uses no WebCrypto. That
 * is what makes §4's vectors reproducible by any lane (harness, Android client,
 * grader) without a crypto polyfill, and it is why SHA-256 is implemented here
 * rather than delegated to `crypto.subtle` (which is async and would force every
 * consumer to be async as well).
 *
 * §2.1:
 *   canonical = METHOD + "\n" + PATH + "\n" + TS + "\n" + NONCE + "\n" + BODY_SHA256
 *
 * Five lines, four 0x0A separators, NO trailing newline. There is no `${search}`
 * segment: §1.2 deletes the query string from signed requests entirely.
 *
 * §2.3: for GET/HEAD the body is empty, so BODY_SHA256 is SHA-256 of zero bytes
 * (`e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`), NOT the
 * digest of a JSON body and NOT an empty string.
 */

/** §1.1 — `X-Timestamp`: UTC epoch milliseconds, exactly 13 digits. No sign, no whitespace, no exponent, no fraction. */
export const RE_TIMESTAMP = /^\d{13}$/;

/** §1.1 — `X-Nonce`: 16 random bytes, lowercase hex only. */
export const RE_NONCE = /^[0-9a-f]{32}$/;

/** §1.1 — `X-Device-Id`: 8–64 chars from a URL-safe alphabet. */
export const RE_DEVICE_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** §1.1/§3 — `X-Signature`: standard base64 alphabet, `=` padded, no URL-safe variants. */
export const RE_SIGNATURE_B64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** §3.2 step 4 — symmetric acceptance window for `X-Timestamp`. */
export const TIMESTAMP_WINDOW_MS = 300_000;

/** §3 — a P-256 P1363 signature is exactly `r ‖ s`, 32 + 32 bytes. */
export const SIGNATURE_BYTES = 64;

/** §2.1 — the literal that separates the five canonical lines. */
export const CANONICAL_SEPARATOR = "\n";

export interface CanonicalParams {
  /** HTTP method as received; uppercased by this function (§2.1). */
  method: string;
  /** `url.pathname` exactly as received — no trailing-slash normalisation, no decoding. */
  pathname: string;
  /** The exact byte sequence of the `X-Timestamp` header value. */
  timestampHeader: string;
  /** The exact byte sequence of the `X-Nonce` header value. */
  nonce: string;
  /** Raw body bytes, digested once and never re-serialised (§2.1 reference order). */
  bodyBytes: Uint8Array;
}

/**
 * UTF-8 encode a string. §4 Vector C exists precisely to catch a builder that
 * digests characters instead of bytes.
 */
export function utf8Bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/**
 * §2.1: `BODY_SHA256` is the lowercase hex of SHA-256 over the raw body bytes.
 * Returns 64 lowercase hex characters.
 */
export function sha256Hex(bytes: Uint8Array): string {
  return toHex(sha256(bytes));
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * §4.2's `body_bytes_len` — the UTF-8 byte length, not the character count.
 */
export function bodyBytesLen(body: string): number {
  return utf8Bytes(body).byteLength;
}

/**
 * Build the five-line canonical string of §2.1.
 *
 * Pure: same inputs always produce the same output; no I/O, no clock, no globals.
 * Reproduces §4.2 vectors A, B and C byte-for-byte.
 */
export function buildCanonicalString(params: CanonicalParams): string {
  const method = params.method.toUpperCase();
  const bodySha256 = sha256Hex(params.bodyBytes);
  return (
    method +
    CANONICAL_SEPARATOR +
    params.pathname +
    CANONICAL_SEPARATOR +
    params.timestampHeader +
    CANONICAL_SEPARATOR +
    params.nonce +
    CANONICAL_SEPARATOR +
    bodySha256
  );
}

/**
 * Convenience wrapper for the common "digest this exact body string" case.
 * The caller must pass the bytes it will actually transmit (§9.3).
 */
export function buildCanonicalStringForBody(
  params: Omit<CanonicalParams, "bodyBytes"> & { body: string }
): string {
  return buildCanonicalString({
    method: params.method,
    pathname: params.pathname,
    timestampHeader: params.timestampHeader,
    nonce: params.nonce,
    bodyBytes: utf8Bytes(params.body),
  });
}

/* ------------------------------------------------------------------------- *
 * SHA-256 (FIPS 180-4), self-contained.
 * ------------------------------------------------------------------------- */

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/** SHA-256 over arbitrary bytes. Deterministic and allocation-local. */
export function sha256(bytes: Uint8Array): Uint8Array {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);

  const len = bytes.length;
  const bitLenLo = (len << 3) >>> 0;
  const bitLenHi = Math.floor(len / 0x20000000);

  const paddedLen = Math.ceil((len + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes);
  padded[len] = 0x80;

  const view = new DataView(padded.buffer);
  view.setUint32(paddedLen - 8, bitLenHi, false);
  view.setUint32(paddedLen - 4, bitLenLo, false);

  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }

    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let hh = h[7];

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + SHA256_K[i] + w[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;

      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }

    h[0] = (h[0] + a) | 0;
    h[1] = (h[1] + b) | 0;
    h[2] = (h[2] + c) | 0;
    h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0;
    h[5] = (h[5] + f) | 0;
    h[6] = (h[6] + g) | 0;
    h[7] = (h[7] + hh) | 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i] >>> 0, false);
  return out;
}
