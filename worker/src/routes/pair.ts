/**
 * Pairing — PROTOCOL_CONTRACT_V5 Rev C §1.1 (device_id grammar) and §8.
 * Port of master plan §5.4 with two verified Rev B defects fixed:
 *
 *   #13 pairing atomicity. Rev B consumed the single-use code with
 *   `DELETE ... RETURNING` BEFORE calling the Durable Object and never checked
 *   the DO response, so a DO 500 still returned `{ok:true}`: D1 had burnt the
 *   code while the DO had no public key, and every later request 401'd
 *   `device_unknown` with no way to repair it. The order is now
 *   validate -> DO -> consume, with the consume and the device upsert in one
 *   `DB.batch()` and the DELETE asserted to have affected exactly one row.
 *
 *   #12 unclamped scheduling input. `ttl_ms` is now finite-checked and clamped;
 *   Rev B passed any value straight through, so `ttl_ms: NaN` produced
 *   `expires_at = NULL`-adjacent garbage and a code that could never be consumed
 *   (or a code that lived forever).
 */

import type { Env } from "../index";
import { err } from "../lib/errors";
import { RE_DEVICE_ID } from "../auth/canonical";
import { clampTtlMs } from "../lib/config";

/** `POST /v1/admin/pairing-code` — mint a single-use, expiring pairing code. */
export async function handleAdminPairingCode(req: Request, env: Env): Promise<Response> {
  let ttlMs = clampTtlMs(undefined);
  try {
    const body = (await req.json()) as unknown;
    if (body && typeof body === "object" && "ttl_ms" in body) {
      ttlMs = clampTtlMs((body as { ttl_ms?: unknown }).ttl_ms);
    }
  } catch {
    // An empty or non-JSON body is fine: use the default TTL.
  }

  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  const pairingCode = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
  const expiresAt = Date.now() + ttlMs;

  await env.DB.batch([
    // Opportunistic purge: keeps the single-use table bounded without a cron.
    env.DB.prepare(`DELETE FROM pairing_codes WHERE expires_at <= ?`).bind(Date.now()),
    env.DB.prepare(`INSERT INTO pairing_codes (code, expires_at) VALUES (?, ?)`).bind(
      pairingCode,
      expiresAt
    ),
  ]);

  return Response.json({ pairing_code: pairingCode, expires_at: expiresAt });
}

/** `POST /v1/device/pair` — bootstrap a device (authenticated by the pairing code alone). */
export async function handleDevicePair(req: Request, env: Env): Promise<Response> {
  let payload: unknown;
  try {
    payload = await req.json();
  } catch {
    return err("bad_request", 400);
  }
  if (!payload || typeof payload !== "object") return err("bad_request", 400);

  const body = payload as Record<string, unknown>;
  const pairingCode = body.pairing_code;
  const deviceId = body.device_id;
  const publicKeySpki = body.public_key_spki;
  const fcmToken = typeof body.fcm_token === "string" && body.fcm_token !== "" ? body.fcm_token : null;

  if (typeof pairingCode !== "string" || pairingCode === "") return err("bad_request", 400);
  if (typeof deviceId !== "string" || deviceId === "") return err("bad_request", 400);
  if (typeof publicKeySpki !== "string" || publicKeySpki === "") return err("bad_request", 400);

  // §1.1: X-Device-Id must match /^[A-Za-z0-9_-]{8,64}$/. Rejecting here rather
  // than at the first signed request turns a confusing 401 into a clear 400.
  if (!RE_DEVICE_ID.test(deviceId)) return err("bad_request", 400);
  if (!isDecodableBase64(publicKeySpki)) return err("bad_request", 400);

  const now = Date.now();

  // (a) Validate WITHOUT consuming, so a DO failure leaves the code intact.
  const existing = await env.DB.prepare(
    `SELECT code FROM pairing_codes WHERE code = ? AND expires_at > ?`
  )
    .bind(pairingCode, now)
    .first<{ code: string }>();
  if (!existing) return err("bad_request", 401);

  // (b) Register in the device's Durable Object FIRST. A failure here must
  //     surface as 5xx and must NOT burn the code.
  const stub = env.DEVICE.get(env.DEVICE.idFromName(deviceId));
  let doRes: Response;
  try {
    doRes = await stub.fetch("https://do/__pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: deviceId, public_key_spki: publicKeySpki, fcm_token: fcmToken }),
    });
  } catch (error) {
    console.error(`[pair] DO unreachable: ${String(error)}`);
    return internalError();
  }
  if (!doRes.ok) {
    console.error(`[pair] DO rejected pairing with HTTP ${doRes.status}`);
    return internalError();
  }

  // (c) Only now consume the code, atomically, together with the D1 upsert.
  const [consume] = await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM pairing_codes WHERE code = ? AND expires_at > ? RETURNING code`
    ).bind(pairingCode, now),
    env.DB.prepare(
      `INSERT INTO devices (device_id, public_key, fcm_token, paired_at, last_seen)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(device_id) DO UPDATE SET
         public_key = excluded.public_key,
         fcm_token  = excluded.fcm_token,
         last_seen  = excluded.last_seen`
    ).bind(deviceId, publicKeySpki, fcmToken, now, now),
  ]);

  // A concurrent pair won the race and consumed the code first.
  if ((consume.meta?.changes ?? 0) !== 1) return err("bad_request", 401);

  return Response.json({ ok: true });
}

/** `GET /v1/devices` — admin fleet visibility. */
export async function handleDevicesList(env: Env): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT device_id, fcm_token, paired_at, last_seen FROM devices ORDER BY last_seen DESC`
  ).all();
  return Response.json({ devices: rows.results ?? [] });
}

/** §8 covers device-protocol errors only; a server fault is a plain 500. */
export function internalError(): Response {
  return Response.json({ error: "internal_error" }, { status: 500 });
}

function isDecodableBase64(value: string): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  if (value.length % 4 !== 0) return false;
  try {
    atob(value);
    return true;
  } catch {
    return false;
  }
}
