/**
 * Strict base64 for the password construction (AUTH_PLAN §2).
 *
 * `atob`/`btoa` are deliberately wrapped rather than used raw: the stored row is
 * a security value, so a salt or digest must decode to an exact byte length and
 * a non-canonical string (padding in the middle, URL-safe alphabet, stray
 * whitespace) is a malformed row, not something to "helpfully" repair.
 */

const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Decode standard base64, or `null` for anything that is not canonical. */
export function b64decode(value: unknown, maxLength = 4096): Uint8Array | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > maxLength) return null;
  if (value.length % 4 !== 0 || !B64_RE.test(value)) return null;
  try {
    const binary = atob(value);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** Standard base64 with padding, as the stored row uses. */
export function b64encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Constant-time equality over two byte strings. A length difference is false. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Concatenate byte strings without a `Uint8Array`-of-arrays type dance. */
export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
