/**
 * `GET /v1/admin/health` — self-diagnosis for a self-hosted deployment (packaging P0).
 *
 * Why this exists: this software runs in the operator's own Cloudflare account, so nobody
 * upstream can see their logs, their schema version, or whether a binding failed to attach.
 * The only workable support model is "run this and paste the output", which means the
 * response must answer the questions that actually block a deployment:
 *
 *   - which version is installed, and which migrations have run?
 *   - are all bindings present (a missing rate limiter or KV silently degrades behaviour)?
 *   - is the database reachable and does it have data?
 *
 * It deliberately returns **counts and timestamps only** — never a message body, phone
 * number or key. A health endpoint that leaks the thing the architecture exists to protect
 * would be self-defeating.
 */

import type { Env } from "../index";
import { timingConfig } from "../lib/config";
import { VERSION } from "../lib/version";

interface HealthCounts {
  devices: number;
  messages: number;
  rules: number;
  pairing_codes: number;
  open_alerts: number;
}

export async function handleHealth(env: Env): Promise<Response> {
  const bindings = {
    DB: Boolean(env.DB),
    KV: Boolean(env.KV),
    DEVICE: Boolean(env.DEVICE),
    PAIR_LIMITER: Boolean(env.PAIR_LIMITER),
    PAIR_GLOBAL_LIMITER: Boolean(env.PAIR_GLOBAL_LIMITER),
    ADMIN_LIMITER: Boolean(env.ADMIN_LIMITER),
    DEVICE_LIMITER: Boolean(env.DEVICE_LIMITER),
    AUTH_FAIL_LIMITER: Boolean(env.AUTH_FAIL_LIMITER),
    FCM_SERVICE_ACCOUNT: Boolean(env.FCM_SERVICE_ACCOUNT_JSON),
  };

  // A binding that is absent does not crash the Worker — the call sites guard on it — so
  // "it works but the rate limiter is gone" is a real and silent failure mode. Surface it.
  const missing = Object.entries(bindings)
    .filter(([, present]) => !present)
    .map(([name]) => name);

  let migrations: string[] = [];
  let counts: HealthCounts | null = null;
  let lastMessageAt: number | null = null;
  let dbError: string | null = null;

  try {
    const rows = await env.DB.prepare(`SELECT name FROM d1_migrations ORDER BY id`).all();
    migrations = (rows.results ?? []).map((row) => String((row as { name: unknown }).name));
  } catch {
    // `d1_migrations` is created by the migration runner; a brand-new database has none.
    // The counts query below is the authoritative reachability check.
  }

  try {
    const row = (await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM devices)       AS devices,
         (SELECT COUNT(*) FROM messages)      AS messages,
         (SELECT COUNT(*) FROM rules)         AS rules,
         (SELECT COUNT(*) FROM pairing_codes WHERE expires_at > ?) AS pairing_codes,
         (SELECT COUNT(*) FROM alerts WHERE acknowledged_at IS NULL) AS open_alerts,
         (SELECT MAX(received_at) FROM messages) AS last_message_at`
    ).bind(Date.now()).first()) as Record<string, unknown> | null;

    counts = {
      devices: Number(row?.devices ?? 0),
      messages: Number(row?.messages ?? 0),
      rules: Number(row?.rules ?? 0),
      pairing_codes: Number(row?.pairing_codes ?? 0),
      open_alerts: Number(row?.open_alerts ?? 0),
    };
    const last = Number(row?.last_message_at ?? 0);
    lastMessageAt = Number.isFinite(last) && last > 0 ? last : null;
  } catch (error) {
    dbError = String(error).slice(0, 200);
  }

  const schemaReady = migrations.length > 0 && dbError === null;
  const ok = schemaReady && bindings.DB && bindings.KV && bindings.DEVICE;

  return Response.json(
    {
      ok,
      version: VERSION,
      // Cheap, explicit, and the two things support will ask for first.
      schema_ready: schemaReady,
      migrations,
      bindings,
      missing_bindings: missing,
      retention_days: timingConfig(env as unknown as Record<string, unknown>).retentionDays,
      counts,
      // Also surfaced at the top level: the open-alert banner should not have to
      // dig through `counts` to answer "is the fleet reachable?".
      open_alerts: counts?.open_alerts ?? 0,
      last_message_at: lastMessageAt,
      db_error: dbError,
      checked_at: Date.now(),
    },
    { status: ok ? 200 : 503 }
  );
}
