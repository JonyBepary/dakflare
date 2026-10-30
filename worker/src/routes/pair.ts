/**
 * Pairing — PROTOCOL_CONTRACT_V5 Rev C §1.1 (device_id grammar) and §8.
 * Port of master plan §5.4 with the verified Rev B defects fixed.
 *
 * Design: claim -> Durable Object -> finalize.
 *
 *   A redemption atomically CLAIMS the pairing code (one UPDATE ... RETURNING that
 *   stamps `claimed_at = now`) before any Durable Object work happens. The claim is
 *   a short lease (30 s) so an abandoned redemption — a crashed isolate, a killed
 *   request — cannot wedge a code forever. Winning the claim is the exclusive right
 *   to call the DO for that code.
 *
 * Two properties are preserved deliberately, and both matter:
 *
 *   (a) A DO FAILURE DOES NOT BURN THE CODE. This is Rev B defect #13: Rev B
 *   consumed the single-use code with `DELETE ... RETURNING` BEFORE calling the
 *   Durable Object and never checked the DO response, so a DO 500 still returned
 *   `{ok:true}`: D1 had burnt the code while the DO had no public key, and every
 *   later request 401'd `device_unknown` with no way to repair it. Here the claim
 *   is a reversible marker, not a delete: if the DO throws or answers non-ok, the
 *   claim is released (`claimed_at = NULL`) and the code stays valid. The actual
 *   DELETE happens only in the finalize step, after the DO has committed the key,
 *   and it is bound to our own claim token.
 *
 *   (b) A CONCURRENT LOSER CANNOT REGISTER AN IDENTITY. Rev C's
 *   validate -> DO -> consume order left a race: two requests could both validate
 *   the same code, both reach the DO and both write a public key, while only one of
 *   them then consumed the code. The loser had already created a persistent device
 *   identity (and, on a rotation, evicted the winner's key holder). The claim above
 *   is a single conditional UPDATE, so exactly one redemption can proceed; the loser
 *   claims zero rows and returns without ever touching the DO.
 *
 * Also fixed here:
 *
 *   #12 unclamped scheduling input. `ttl_ms` is now finite-checked and clamped;
 *   Rev B passed any value straight through, so `ttl_ms: NaN` produced
 *   `expires_at = NULL`-adjacent garbage and a code that could never be consumed
 *   (or a code that lived forever).
 *
 * Scope (security fix 1): a code is bound to at most one `device_id`, and it carries
 * a `purpose`. `enroll` may only register a device that does not exist yet, so a
 * valid enrollment code can no longer rebind — and therefore take over — an already
 * paired device. `rotate` requires an explicit `device_id` from the admin and is the
 * only purpose allowed to replace an existing key. Rotation then evicts the previous
 * key holder inside the DO, which is intended behaviour but only when authorized.
 *
 * Limiting (security fix 3): the per-IP limiter is checked first and a failure there
 * returns immediately, so one client cannot exhaust the shared limiter budget and
 * deny pairing to everybody else. The global limiter is a separate binding and is
 * consulted only for requests that passed the per-IP check.
 */

import type { Env } from "../index";
import { requestMeta, writeAudit } from "../audit";
import { err } from "../lib/errors";
import { RE_DEVICE_ID } from "../auth/canonical";
import { readJsonBoundedResult } from "../lib/body";
import { MAX_BODY_BYTES, MAX_FCM_TOKEN_CHARS, MAX_LABEL_CHARS, clampTtlMs } from "../lib/config";
import { MAX_WORKFLOW_NAME_CHARS } from "../lib/workflow";

/**
 * How long a claim blocks other redeemers before it is treated as abandoned.
 * Long enough for a DO round-trip, short enough that a crashed isolate does not
 * leave an operator waiting for a code that expires in minutes.
 */
const CLAIM_LEASE_MS = 30_000;

type PairingPurpose = "enroll" | "rotate";

/** `POST /v1/admin/pairing-code` — mint a single-use, expiring pairing code. */
export async function handleAdminPairingCode(req: Request, env: Env): Promise<Response> {
  let ttlMs = clampTtlMs(undefined);
  let deviceId: string | null = null;
  let purpose: PairingPurpose = "enroll";

  const mintBody = await readJsonBoundedResult(req, MAX_BODY_BYTES);
  if (!mintBody.ok && mintBody.reason === "payload_too_large") {
    return err("payload_too_large");
  }
  // An empty or non-JSON body is fine here: use the default TTL and scope.
  if (mintBody.ok) {
    const value = mintBody.value;
    if ("ttl_ms" in value) ttlMs = clampTtlMs(value.ttl_ms);

    if (value.device_id !== undefined && value.device_id !== null) {
      // §1.1 grammar, so a code can never be bound to a device_id that no request
      // could ever authenticate as.
      if (typeof value.device_id !== "string" || !RE_DEVICE_ID.test(value.device_id)) {
        return err("bad_request", 400);
      }
      deviceId = value.device_id;
    }

    if (value.purpose !== undefined && value.purpose !== null) {
      if (value.purpose !== "enroll" && value.purpose !== "rotate") {
        return err("bad_request", 400);
      }
      purpose = value.purpose;
    }

    // An unscoped rotation is meaningless: there is no device to rotate.
    if (purpose === "rotate" && deviceId === null) return err("bad_request", 400);
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
    env.DB.prepare(
      `INSERT INTO pairing_codes (code, expires_at, device_id, purpose) VALUES (?, ?, ?, ?)`
    ).bind(pairingCode, expiresAt, deviceId, purpose),
  ]);

  return Response.json({
    pairing_code: pairingCode,
    expires_at: expiresAt,
    device_id: deviceId,
    purpose,
  });
}

/** `POST /v1/device/pair` — bootstrap a device (authenticated by the pairing code alone). */
export async function handleDevicePair(req: Request, env: Env): Promise<Response> {
  // --- Step 1. Unauthenticated route: throttle before touching the database.
  //
  // Per-IP first, and return on failure BEFORE the global limiter is consulted.
  // Two keys exist because the Rate Limiting binding is per-colo — a per-IP key
  // alone lets an IP-rotating botnet spread across locations — but checking the
  // shared key first (or unconditionally) lets one client drain the shared budget
  // and lock every other device out of pairing.
  if (env.PAIR_LIMITER) {
    const ip = req.headers.get("CF-Connecting-IP") ?? "local";
    const perIp = await env.PAIR_LIMITER.limit({ key: `ip:${ip}` });
    if (!perIp.success) return err("rate_limited", 429);
  }
  if (env.PAIR_GLOBAL_LIMITER) {
    const global = await env.PAIR_GLOBAL_LIMITER.limit({ key: "pair_global" });
    if (!global.success) return err("rate_limited", 429);
  }

  // --- Step 2. Parse/validate the body exactly as before. -------------------
  const parsed = await readJsonBoundedResult(req, MAX_BODY_BYTES);
  if (!parsed.ok) return err(parsed.reason);
  const body = parsed.value;
  const pairingCode = body.pairing_code;
  const deviceId = body.device_id;
  const publicKeySpki = body.public_key_spki;
  const fcmToken = typeof body.fcm_token === "string" && body.fcm_token !== ""
    ? body.fcm_token.slice(0, MAX_FCM_TOKEN_CHARS)
    : null;

  // Optional identity metadata. `undefined`/`null` means "not reported" and stays
  // NULL in D1, which the console renders as unknown rather than inventing a value.
  let label: string | null = null;
  if (body.label !== undefined && body.label !== null) {
    if (typeof body.label !== "string") return err("bad_request", 400);
    // Control characters have no place in an operator label and would corrupt a
    // console table/terminal. Checked before trimming so a trailing newline is
    // rejected rather than silently normalised away.
    if (/[\u0000-\u001f\u007f]/.test(body.label)) return err("bad_request", 400);
    const trimmed = body.label.trim();
    if (trimmed.length > MAX_LABEL_CHARS) return err("bad_request", 400);
    label = trimmed === "" ? null : trimmed;
  }

  let simSlot: number | null = null;
  if (body.sim_slot !== undefined && body.sim_slot !== null) {
    if (
      typeof body.sim_slot !== "number" ||
      !Number.isInteger(body.sim_slot) ||
      body.sim_slot < 0 ||
      body.sim_slot > 2
    ) {
      return err("bad_request", 400);
    }
    simSlot = body.sim_slot;
  }

  if (typeof pairingCode !== "string" || pairingCode === "") return err("bad_request", 400);
  if (typeof deviceId !== "string" || deviceId === "") return err("bad_request", 400);
  if (typeof publicKeySpki !== "string" || publicKeySpki === "") return err("bad_request", 400);

  // §1.1: X-Device-Id must match /^[A-Za-z0-9_-]{8,64}$/. Rejecting here rather
  // than at the first signed request turns a confusing 401 into a clear 400.
  if (!RE_DEVICE_ID.test(deviceId)) return err("bad_request", 400);
  if (!isDecodableBase64(publicKeySpki)) return err("bad_request", 400);

  const now = Date.now();

  // --- Step 3. Atomic claim: ONE statement. --------------------------------
  //
  // Everything that decides whether this request may pair is in the WHERE clause,
  // so the decision and the write cannot be separated by a concurrent request:
  //   - the code exists and is unexpired;
  //   - it is not claimed by someone else (a claim older than the lease is
  //     abandoned and may be reclaimed);
  //   - it is either unscoped or scoped to THIS device_id;
  //   - an `enroll` code may not target a device that is already paired. That is
  //     the takeover fix, expressed as data rather than as an application check
  //     that a race could step over.
  //
  // A concurrent loser updates 0 rows and returns below, never reaching the DO.
  const claim = await env.DB.prepare(
    `UPDATE pairing_codes
        SET claimed_at = ?1
      WHERE code = ?2
        AND expires_at > ?1
        AND (claimed_at IS NULL OR claimed_at <= ?1 - ${CLAIM_LEASE_MS})
        AND (device_id IS NULL OR device_id = ?3)
        AND (purpose = 'rotate' OR NOT EXISTS (SELECT 1 FROM devices WHERE device_id = ?3))
     RETURNING purpose`
  )
    .bind(now, pairingCode, deviceId)
    .all<{ purpose: string }>();

  // `.all()` rather than `.first()`: an UPDATE ... RETURNING result set is read
  // more predictably through `results`, and the row count is explicit.
  const claimed = claim.results?.[0];
  if (!claimed) {
    // Diagnostic only — the claim above already made the security decision.
    const row = await env.DB.prepare(
      `SELECT purpose FROM pairing_codes WHERE code = ? AND expires_at > ?`
    )
      .bind(pairingCode, now)
      .first<{ purpose: string }>();

    if (row?.purpose === "enroll") {
      const device = await env.DB.prepare(`SELECT 1 AS ok FROM devices WHERE device_id = ?`)
        .bind(deviceId)
        .first<{ ok: number }>();
      if (device) return err("device_exists", 409);
    }
    return err("bad_request", 401);
  }

  const rotating = claimed.purpose === "rotate";

  // --- Step 4. Register in the device's Durable Object. --------------------
  //
  // The claim is held across this call. A failure here RELEASES it and leaves the
  // code valid: property (a) above.
  const stub = env.DEVICE.get(env.DEVICE.idFromName(deviceId));
  let doRes: Response;
  try {
    doRes = await stub.fetch("https://do/__pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        device_id: deviceId,
        public_key_spki: publicKeySpki,
        fcm_token: fcmToken,
        rotate: rotating,
      }),
    });
  } catch (error) {
    console.error(`[pair] DO unreachable: ${String(error)}`);
    await releaseClaim(env, pairingCode, now);
    return internalError();
  }
  if (!doRes.ok) {
    console.error(`[pair] DO rejected pairing with HTTP ${doRes.status}`);
    await releaseClaim(env, pairingCode, now);
    // A refusal is a refusal: the DO declined an unauthorized rotation.
    if (doRes.status === 409) return err("device_exists", 409);
    return internalError();
  }

  // --- Step 5. Finalize: consume OUR claim, THEN mirror the registry. ------
  //
  // These are deliberately two statements, not one `DB.batch()`. A D1 batch only
  // rolls back when a statement ERRORS, and a DELETE matching zero rows is a
  // SUCCESS — so batching the registry upsert beside the DELETE would let the
  // upsert commit even when the DELETE changed nothing. That is the same
  // phantom-identity shape this design removes, merely pushed behind the 30 s
  // lease. Checking `changes` first makes the DELETE the real commit point.
  //
  // Bound to `claimed_at = now`, so this only consumes the claim this request owns.
  const consume = await env.DB.prepare(
    `DELETE FROM pairing_codes WHERE code = ? AND claimed_at = ?`
  )
    .bind(pairingCode, now)
    .run();

  if ((consume.meta?.changes ?? 0) !== 1) {
    // The lease was reclaimed by another redeemer while the DO call was in flight.
    // It owns the code now; do not mirror a registry row for a claim we no longer
    // hold, or its key could be overwritten by ours.
    return err("bad_request", 401);
  }

  await env.DB.prepare(
    `INSERT INTO devices (device_id, public_key, fcm_token, paired_at, last_seen, label, sim_slot)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(device_id) DO UPDATE SET
       public_key = excluded.public_key,
       fcm_token  = excluded.fcm_token,
       last_seen  = excluded.last_seen,
       -- A re-pair that does not report a label must not erase one an operator
       -- set (or a previous build reported). Null means "unknown", not "clear".
       label      = COALESCE(excluded.label, devices.label),
       sim_slot   = COALESCE(excluded.sim_slot, devices.sim_slot)`
  )
    .bind(deviceId, publicKeySpki, fcmToken, now, now, label, simSlot)
    .run();

  // A pair is a security-relevant event: a device gained (or rotated) a key.
  // No key material and no FCM token in the detail — the ids are enough.
  await writeAudit(env, {
    action: "device.paired",
    actor: { userId: null, label: "pairing-code" },
    subject: deviceId,
    detail: { rotate: rotating, sim_slot: simSlot },
    ...requestMeta(req),
  });

  // --- Step 6. Re-pair inheritance: adopt the previous phone's workflows. ---
  //
  // Workflows are scoped by `device_id`, and a reinstall mints a NEW device_id.
  // Without this step every flow the operator built is orphaned and `/v1/flows`
  // silently answers nothing — which is exactly what happened on 2026-10-30.
  // The phone's only stable identity hint is its label, so a pair that reports
  // one inherits from the most recently paired other device that shares it.
  //
  // This runs AFTER the pair has committed and is deliberately best-effort: the
  // device is already registered, so a storage failure here must not turn a
  // successful pair into a 500 the phone would answer by re-pairing.
  let copiedWorkflows = 0;
  try {
    // The effective label, not just the reported one: a rotation that omits the
    // label keeps the row's existing one (see the COALESCE in the upsert above).
    const effectiveLabel =
      label ??
      (
        await env.DB.prepare(`SELECT label FROM devices WHERE device_id = ?`)
          .bind(deviceId)
          .first<{ label: string | null }>()
      )?.label ??
      null;

    const inherited = await inheritWorkflows(env, deviceId, effectiveLabel);
    copiedWorkflows = inherited.copied;

    if (inherited.from !== null && (inherited.copied > 0 || inherited.skipped > 0)) {
      await writeAudit(env, {
        action: "workflows.copied",
        actor: { userId: null, label: "pairing-code" },
        subject: deviceId,
        detail: {
          from: inherited.from,
          to: deviceId,
          count: inherited.copied,
          // Additive: how many source flows were left alone because the new
          // device already had a workflow with that name.
          skipped: inherited.skipped,
          // Additive: more than one device shares the label, so `from` is the
          // most recently paired one.
          ...(inherited.ambiguous ? { ambiguous_label: true } : {}),
        },
        ...requestMeta(req),
      });
    }
  } catch (error) {
    console.error(`[pair] workflow inheritance failed for ${deviceId}: ${String(error)}`);
  }

  // `copied_workflows` is additive: existing clients ignore an unknown key.
  return Response.json({ ok: true, copied_workflows: copiedWorkflows });
}

/**
 * `GET /v1/devices` — admin fleet visibility.
 *
 * Archived devices are hidden by default: archiving is how an uninstalled phone
 * stops appearing in the fleet view WITHOUT losing its history. `?include_archived=1`
 * asks for them too, which is what the console's "archived" filter uses. The
 * `archived_at` column is returned either way so the caller can render the state
 * (null = live).
 */
export async function handleDevicesList(env: Env, requestUrl: URL): Promise<Response> {
  const includeArchived = requestUrl.searchParams.get("include_archived");
  const archivedFilter =
    includeArchived === "1" || includeArchived === "true" ? "" : "WHERE archived_at IS NULL";

  const rows = await env.DB.prepare(
    `SELECT device_id, fcm_token, label, sim_slot, paired_at, last_seen, archived_at
       FROM devices
       ${archivedFilter}
      ORDER BY last_seen DESC`
  ).all();
  return Response.json({ devices: rows.results ?? [] });
}

/** What `inheritWorkflows` did, for the response count and the audit detail. */
interface InheritedWorkflows {
  /** The device the flows were copied FROM, or null when no candidate existed. */
  from: string | null;
  copied: number;
  /** Source flows left alone because the new device already had that name. */
  skipped: number;
  /** More than one other device shares the label; `from` is the newest. */
  ambiguous: boolean;
}

/**
 * Copy the previous phone's workflows onto a newly paired device.
 *
 * The rule, exactly: on a successful pair, find the most recently paired OTHER
 * device row whose `label` matches the new device's effective label, and copy
 * every workflow scoped to it. Each copy is a NEW row (`wf_<hex>`, version 1,
 * `created_at = updated_at = now`) owned by the new device; the source rows are
 * never touched, so an operator can still see what the old phone had. The name
 * gains a `" (copied from <old id>)"` suffix so the two generations are
 * distinguishable in the canvas list.
 *
 * Nothing on the new device is ever overwritten: a copy whose target name is
 * already present there is skipped and counted. That also makes a repeated pair
 * with the same label idempotent rather than duplicating the fleet's flows.
 *
 * A null label inherits nothing — "unknown" is not a match, or every unlabelled
 * phone would adopt the flows of the last unlabelled one.
 */
async function inheritWorkflows(
  env: Env,
  newDeviceId: string,
  label: string | null
): Promise<InheritedWorkflows> {
  const none: InheritedWorkflows = { from: null, copied: 0, skipped: 0, ambiguous: false };
  if (label === null) return none;

  // LIMIT 2 is enough to answer "is this label ambiguous?" without reading the
  // whole fleet: `paired_at DESC` makes row 0 the most recent candidate.
  const candidates = await env.DB.prepare(
    `SELECT device_id FROM devices
      WHERE label = ? AND device_id <> ?
      ORDER BY paired_at DESC, device_id DESC
      LIMIT 2`
  )
    .bind(label, newDeviceId)
    .all<{ device_id: string }>();

  const matches = candidates.results ?? [];
  if (matches.length === 0) return none;

  const from = matches[0].device_id;
  const ambiguous = matches.length > 1;
  if (ambiguous) {
    // The response has one count and no room for a provenance list, so the
    // operator is told through the log and the audit detail instead.
    console.warn(
      `[pair] ${newDeviceId}: more than one device shares label ${JSON.stringify(
        label
      )}; inheriting from the most recently paired (${from})`
    );
  }

  const source = await env.DB.prepare(
    `SELECT id, name, enabled, graph FROM workflows WHERE device_id = ? ORDER BY created_at, id`
  )
    .bind(from)
    .all<{ id: string; name: string; enabled: number; graph: string }>();

  const rows = source.results ?? [];
  if (rows.length === 0) return { ...none, from, ambiguous };

  // Snapshot of the names already on the new device. Only these are protected;
  // two source flows that happen to share a name are BOTH copied, because that
  // is a duplicate in the source, not an overwrite on the target.
  const existing = await env.DB.prepare(`SELECT name FROM workflows WHERE device_id = ?`)
    .bind(newDeviceId)
    .all<{ name: string }>();
  const taken = new Set((existing.results ?? []).map((row) => row.name));

  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  let skipped = 0;

  for (const row of rows) {
    const suffix = ` (copied from ${from})`;
    // The suffix is bounded by the device-id grammar (64 chars), so this only
    // trims a long name; the result still satisfies MAX_WORKFLOW_NAME_CHARS.
    const room = MAX_WORKFLOW_NAME_CHARS - suffix.length;
    const name = `${row.name.slice(0, Math.max(0, room)).trimEnd()}${suffix}`;

    if (taken.has(name)) {
      skipped++;
      continue;
    }

    statements.push(
      env.DB.prepare(
        `INSERT INTO workflows (id, name, enabled, device_id, graph, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`
      ).bind(
        newWorkflowId(),
        name,
        Number(row.enabled) === 1 ? 1 : 0,
        newDeviceId,
        row.graph,
        now,
        now
      )
    );
  }

  if (statements.length > 0) await env.DB.batch(statements);

  return { from, copied: statements.length, skipped, ambiguous };
}

/**
 * A fresh workflow id for an inherited copy: `wf_<16 hex>`, which fits
 * `RE_WORKFLOW_ID`. Random rather than derived from the source id, because the
 * source row stays and two rows must never share a primary key.
 */
function newWorkflowId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `wf_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** §8 covers device-protocol errors only; a server fault is a plain 500. */
export function internalError(): Response {
  return Response.json({ error: "internal_error" }, { status: 500 });
}

/**
 * Drop our claim without consuming the code.
 *
 * Bound to the exact `claimed_at` value this request wrote, so a lease that was
 * already reclaimed by someone else is never cleared out from under them.
 */
async function releaseClaim(env: Env, pairingCode: string, claimedAt: number): Promise<void> {
  try {
    await env.DB.prepare(
      `UPDATE pairing_codes SET claimed_at = NULL WHERE code = ? AND claimed_at = ?`
    )
      .bind(pairingCode, claimedAt)
      .run();
  } catch (error) {
    // The lease expires on its own, so a failed release only delays the retry.
    console.error(`[pair] failed to release pairing claim: ${String(error)}`);
  }
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
