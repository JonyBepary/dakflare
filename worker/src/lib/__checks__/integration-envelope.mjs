#!/usr/bin/env node
/**
 * Zero-dependency contract check for DakFlare Integration Envelope v1
 * and OTP/PIN vs allowlisted-raw content policy.
 *
 * Run:
 *   node worker/src/lib/__checks__/integration-envelope.mjs
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const contractPath = resolve(here, "../../../../contracts/integration-envelope.json");
const contract = JSON.parse(readFileSync(contractPath, "utf8"));

function signV1(secret, ts, deliveryId, rawBody) {
  const canonical = `v1.${ts}.${deliveryId}.${rawBody}`;
  const hex = crypto.createHmac("sha256", secret).update(canonical, "utf8").digest("hex");
  return `v1=${hex}`;
}

function verifyV1({ secret, ts, deliveryId, signature, rawBody, nowSeconds, maxSkew = 300 }) {
  if (Math.abs(nowSeconds - ts) > maxSkew) return { ok: false, reason: "timestamp_skew" };
  if (!signature.startsWith("v1=")) return { ok: false, reason: "unsupported_version" };
  const expected = signV1(secret, ts, deliveryId, rawBody);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: "signature_mismatch" };
  }
  return { ok: true };
}

// 1. Verify every golden vector in contracts/integration-envelope.json
for (const v of contract.golden_vectors) {
  const actual = signV1(v.secret, v.timestamp_seconds, v.delivery_id, v.raw_body);
  assert.equal(actual, v.expected_signature, `Golden vector mismatch: ${v.name}`);

  const ok = verifyV1({
    secret: v.secret,
    ts: v.timestamp_seconds,
    deliveryId: v.delivery_id,
    signature: v.expected_signature,
    rawBody: v.raw_body,
    nowSeconds: v.timestamp_seconds + 120,
  });
  assert.equal(ok.ok, true, `Valid skew failed: ${v.name}`);

  // 2. Reject >300s clock skew
  const stale = verifyV1({
    secret: v.secret,
    ts: v.timestamp_seconds,
    deliveryId: v.delivery_id,
    signature: v.expected_signature,
    rawBody: v.raw_body,
    nowSeconds: v.timestamp_seconds + 301,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, "timestamp_skew");

  // 3. Reject tampered delivery_id (nonce binding)
  const tamperedDelivery = verifyV1({
    secret: v.secret,
    ts: v.timestamp_seconds,
    deliveryId: `${v.delivery_id}_tampered`,
    signature: v.expected_signature,
    rawBody: v.raw_body,
    nowSeconds: v.timestamp_seconds,
  });
  assert.equal(tamperedDelivery.ok, false);
  assert.equal(tamperedDelivery.reason, "signature_mismatch");

  // 4. Reject tampered body
  const tamperedBody = verifyV1({
    secret: v.secret,
    ts: v.timestamp_seconds,
    deliveryId: v.delivery_id,
    signature: v.expected_signature,
    rawBody: `${v.raw_body} `,
    nowSeconds: v.timestamp_seconds,
  });
  assert.equal(tamperedBody.ok, false);
  assert.equal(tamperedBody.reason, "signature_mismatch");
}

// 5. Verify OTP/PIN hard boundary vs allowlisted_raw behavior
const RE_OTP_PIN =
  /(?:\b(?:otp|pin|passcode|secret\s+code|auth(?:entication)?\s+code|verification\s+code|security\s+code|one[\s-]time\s+password)\b|ওটিপি|গোলাপী\s*পিন|গোপন\s*(?:নম্বর|পিন)|ভেরিফিকেশন\s*(?:কোড)?|সিকিউরিটি\s*কোড|\bপিন\b)/iu;

function isOtpOrPin(body) {
  const normalized = (body || "")
    .normalize("NFKC")
    .replace(/[\u09E6-\u09EF]/g, (ch) => String(ch.charCodeAt(0) - 0x09e6));
  return RE_OTP_PIN.test(normalized);
}

assert.equal(isOtpOrPin("Your bKash verification code is 482910. Never share OTP."), true);
assert.equal(isOtpOrPin("আপনার ওটিপি কোড 123456"), true);
assert.equal(
  isOtpOrPin("You have received Tk 1,500.00 from 017****8901. TrxID 9K8L7M6N5P."),
  false
);

console.log(
  `integration-envelope check passed: ${contract.golden_vectors.length} golden vector(s), skew/tamper guards, and OTP/PIN boundary verified.`
);
