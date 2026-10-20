/**
 * Device authentication — PROTOCOL_CONTRACT_V5 Rev C §1.1, §1.2, §2, §3.2.
 *
 * Implements §3.2's numbered validation order EXACTLY, cheapest check first, and
 * delegates only the two expensive steps (7: curve verification, 8: replay guard)
 * to the device's Durable Object, which owns the public key and the `nonces`
 * table. Step 8 still runs strictly last and still runs only after step 7 has
 * succeeded, so an invalid signature never pays for a write.
 *
 * Rev B's hole, closed here: it tested `Number.isFinite(Number(X-Timestamp))`, so
 * " 1776470400000", "+1776470400000", "1776470400000.0" and "1.7e12" all passed
 * (and the last two made the digest path disagree with the client). §1.1 fixes a
 * grammar per header; the grammar is now the only thing consulted.
 */

import type { Env } from "../index";
import { err, asErrorCode } from "../lib/errors";
import { MAX_BODY_BYTES, timingConfig } from "../lib/config";
import { readBodyBounded } from "../lib/body";
import {
  RE_DEVICE_ID,
  RE_NONCE,
  RE_SIGNATURE_B64,
  RE_TIMESTAMP,
  SIGNATURE_BYTES,
  buildCanonicalStringFromDigest,
  toHex,
  utf8Bytes,
} from "./canonical";

export type DeviceAuthResult =
  | { ok: true; deviceId: string; body: string }
  | { ok: false; response: Response };

/**
 * Decode standard padded base64 without throwing.
 *
 * Returns null on any deviation (wrong alphabet, URL-safe alphabet, bad padding,
 * non-multiple-of-4 length) so §3's "signature must be exactly 64 bytes" check is
 * never reached with a silently-mangled buffer.
 */
export function base64ToBytes(value: string): Uint8Array | null {
  if (!RE_SIGNATURE_B64.test(value)) return null;
  if (value.length % 4 !== 0) return null;
  try {
    const binary = atob(value);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/**
 * §3.2 server-side validation order.
 *
 * 1. all four headers present        -> 401 missing_auth_headers
 * 2. header grammars                 -> 401 malformed_header
 * 3. no query string                 -> 400 unexpected_query
 * 4. |now - ts| <= window            -> 401 timestamp_out_of_window
 * 5. body digest + canonical string  (no error of its own)
 * 6. signature decodes to 64 bytes   -> 401 bad_signature_length
 * 7. ECDSA P-256 / SHA-256 verify    -> 401 invalid_signature (in the DO)
 * 8. replay guard                    -> 401 nonce_replay      (in the DO, last)
 */
export async function verifyDeviceSignature(req: Request, env: Env): Promise<DeviceAuthResult> {
  // --- 1. presence -------------------------------------------------------
  const deviceId = req.headers.get("X-Device-Id");
  const timestampHeader = req.headers.get("X-Timestamp");
  const nonce = req.headers.get("X-Nonce");
  const signatureB64 = req.headers.get("X-Signature");
  if (!deviceId || !timestampHeader || !nonce || !signatureB64) {
    return { ok: false, response: err("missing_auth_headers", 401) };
  }

  // --- 2. grammar --------------------------------------------------------
  // §1.1 exact grammars. `Number()` is never trusted to police this: it accepts
  // " 1.7e12", "+177...", "177....0" and decimals, all of which are malformed.
  if (!RE_DEVICE_ID.test(deviceId)) {
    return { ok: false, response: err("malformed_header", 401) };
  }
  if (!RE_TIMESTAMP.test(timestampHeader)) {
    return { ok: false, response: err("malformed_header", 401) };
  }
  if (!RE_NONCE.test(nonce)) {
    return { ok: false, response: err("malformed_header", 401) };
  }

  // --- 3. no query string (§1.2) -----------------------------------------
  // Before any crypto work, so a percent-encoding divergence can never look
  // like a signature failure.
  const url = new URL(req.url);
  if (url.search !== "") {
    return { ok: false, response: err("unexpected_query", 400) };
  }

  // --- 4. timestamp window ----------------------------------------------
  // Safe only because step 2 already proved the header is exactly 13 digits.
  const ts = Number(timestampHeader);
  const windowMs = timingConfig(env as unknown as Record<string, unknown>).nonceWindowMs;
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > windowMs) {
    return { ok: false, response: err("timestamp_out_of_window", 401) };
  }

  // --- 5. raw body digest + canonical string ----------------------------
  // §1.2: GET/HEAD carry no body, so the digest is SHA-256 of zero bytes.
  //
  // The body is read through a hard byte cap and digested with the native
  // implementation. `req.text()` would buffer anything the caller sends, and a
  // JS SHA-256 over a multi-megabyte body is a cheap way to exhaust the Workers
  // Free 10 ms CPU budget before authentication has even happened.
  const bodyResult = await readBodyBounded(req, MAX_BODY_BYTES);
  if (!bodyResult.ok) {
    return { ok: false, response: err("payload_too_large", 413) };
  }
  const body = bodyResult.text;
  const bodyBytes = utf8Bytes(body);
  const digest = await crypto.subtle.digest("SHA-256", bodyBytes);
  const canonical = buildCanonicalStringFromDigest(
    {
      method: req.method,
      pathname: url.pathname,
      timestampHeader,
      nonce,
    },
    toHex(new Uint8Array(digest))
  );

  // --- 6. signature length ----------------------------------------------
  const signature = base64ToBytes(signatureB64);
  if (!signature || signature.byteLength !== SIGNATURE_BYTES) {
    return { ok: false, response: err("bad_signature_length", 401) };
  }

  // --- 7 + 8. verify, then replay guard (both inside the device's DO) ----
  const stub = env.DEVICE.get(env.DEVICE.idFromName(deviceId));
  let res: Response;
  try {
    res = await stub.fetch("https://do/__auth/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceId, ts, nonce, canonical, signatureB64 }),
    });
  } catch {
    return { ok: false, response: err("invalid_signature", 401) };
  }

  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as { error?: unknown } | null;
    return {
      ok: false,
      response: err(asErrorCode(payload?.error, "invalid_signature"), res.status || 401),
    };
  }

  return { ok: true, deviceId, body };
}
