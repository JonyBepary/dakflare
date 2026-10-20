/**
 * DeviceGateway — one Durable Object per device_id.
 * Implements PROTOCOL_CONTRACT_V5 Rev C §1.1/§3.2 (signature verification owner),
 * §5 (replay guard), §6 (command state machine, enforced in SQL) and §8.
 * Ports master plan §5.5 with brief fixes #6, #9, #10, #11, #12 and #22, plus the
 * timing/`getWebSocketAutoResponseTimestamp` amendment.
 *
 * Rev B defects removed outright:
 *
 *   #6  `device_meta` (a JSON nonce ring buffer capped at 32 plus an
 *       `evicted_max_ts` floor) is DELETED. It self-DoSes: any 33rd signed
 *       request inside the window evicts a live nonce and raises the floor, after
 *       which a legitimate request at exactly that timestamp is rejected. §5.1's
 *       `nonces` table plus `exp = MAX(now, ts) + W` is the replacement, and it
 *       is why no policy floor is needed at all (§5.2).
 *
 *   #9  `tryPushOverWebSocket` used to select `state IN ('PENDING','DISPATCHED')`
 *       and run on every enqueue, so each new command re-pushed ALL in-flight
 *       commands and reset their ack timers — N enqueues re-sent command #1 N
 *       times. The enqueue path now pushes only the command it just created
 *       (`pushCommands`), and the socket-recovery path (`pushPendingToSocket`,
 *       used on `hello`/reconnect) recovers `PENDING` ONLY, because an
 *       `ack_timeout` already reverts `DISPATCHED` back to `PENDING` (§6.1).
 *
 *   #10 `alarm()` deleted each `scheduled_tasks` row BEFORE awaiting its work, so
 *       a retry had nothing left to retry. Rows are now deleted only after their
 *       work succeeds, each task is isolated in try/catch so one failure cannot
 *       abort the batch or skip the remaining tasks, and `syncNextAlarm()` sits in
 *       a `finally`.
 *
 *   #11 `syncNextAlarm` tested `if (next?.m)`, so a legitimate `run_at = 0` fell
 *       into the `deleteAlarm()` branch and wiped the entire schedule.
 *
 *   #12 `expires_at` and the ack timers were previously fed unclamped numbers.
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";
import { err } from "./lib/errors";
import { sendFcmHighPriorityWake } from "./lib/fcm";
import {
  timingConfig,
  readIntEnv,
  MAX_ACK_IDS,
  MAX_INCOMING_MESSAGES,
  type TimingConfig,
} from "./lib/config";
import { SIGNATURE_BYTES, utf8Bytes } from "./auth/canonical";

interface WsAttachment {
  deviceId: string;
  connectedAt: number;
  /**
   * Immutable per-connection id. A command's `ack_timeout` task carries the id
   * of the socket it was pushed to, so a timeout closes exactly that socket
   * instead of every socket the device happens to hold. Optional because a
   * socket accepted before this field existed has no readable value.
   */
  socketId?: string;
}

/** The command shape sent to the device (§6.1 `PENDING -> DISPATCHED` payload). */
interface CommandView {
  command_id: string;
  to: string;
  body: string;
  priority: string;
  expires_at: number;
}

interface CommandRow {
  command_id: string;
  to_e164: string;
  body: string;
  priority: string;
  state: string;
  created_at: number;
  expires_at: number;
}

interface ScheduledTaskRow {
  id: string;
  kind: string;
  payload: string;
  /** Consecutive failures. Past `MAX_TASK_ATTEMPTS` the row is dead-lettered. */
  attempts: number;
}

/** `consumed`: the row's work finished, so the alarm loop may delete it. */
type TaskOutcome = "consumed" | "rescheduled";

/**
 * §6.1 allowed transitions, expressed as "allowed predecessors of the target".
 *
 * §6.2 requires the guard to live IN SQL so it is atomic and cannot be bypassed
 * from a new route. Terminal states (`DELIVERED`, `FAILED`, `EXPIRED`) appear
 * only on the right-hand side, so no transition can ever leave them:
 *   - `SENT -> ACKED_BY_DEVICE` (a stale ack): `ACKED_BY_DEVICE` accepts only
 *     `PENDING`/`DISPATCHED`, so it is a no-op;
 *   - `DELIVERED -> SENT`: `SENT` accepts only `ACKED_BY_DEVICE`, so it is a no-op;
 *   - `EXPIRED -> *`: nothing accepts `EXPIRED` as a predecessor.
 */
const ALLOWED_PREDECESSORS: Readonly<Record<string, readonly string[]>> = {
  DISPATCHED: ["PENDING"],
  PENDING: ["DISPATCHED"],
  // §6.1 lists `DISPATCHED -> ACKED_BY_DEVICE`; §6.2's enforcement snippet is
  // `state IN ('PENDING','DISPATCHED')`. Accepting `PENDING` as well can only ever
  // move a command FORWARD, so the frozen document's own SQL is honoured.
  ACKED_BY_DEVICE: ["PENDING", "DISPATCHED"],
  SENT: ["ACKED_BY_DEVICE"],
  DELIVERED: ["SENT"],
  FAILED: ["ACKED_BY_DEVICE", "SENT"],
  EXPIRED: ["PENDING", "DISPATCHED"],
};

/** Backoff before a failed alarm task is retried, so a persistent failure cannot spin. */
const TASK_RETRY_BACKOFF_MS = 30_000;

/**
 * Consecutive failures before a task is moved to `dead_letters` instead of being
 * rescheduled forever. Without a ceiling a persistently failing task retries
 * every 30 s indefinitely, costing a Durable Object request each time and
 * producing no signal beyond a log line.
 */
const MAX_TASK_ATTEMPTS = 5;

/** `getWebSocketAutoResponseTimestamp` is unverified locally; clamp absurd future values. */
const AUTO_RESPONSE_FUTURE_SKEW_MS = 60_000;

export class DeviceGateway extends DurableObject<Env> {
  private timingsCache: TimingConfig | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS devices (
          device_id       TEXT PRIMARY KEY,
          public_key_spki TEXT NOT NULL,
          fcm_token       TEXT,
          updated_at      INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS nonces (
          nonce TEXT PRIMARY KEY,
          ts    INTEGER NOT NULL,
          exp   INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_nonces_exp ON nonces(exp);

        CREATE TABLE IF NOT EXISTS commands (
          command_id TEXT PRIMARY KEY,
          to_e164    TEXT NOT NULL,
          body       TEXT NOT NULL,
          priority   TEXT NOT NULL DEFAULT 'normal',
          state      TEXT NOT NULL DEFAULT 'PENDING',
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_commands_state ON commands(state, priority, created_at);

        CREATE TABLE IF NOT EXISTS scheduled_tasks (
          id       TEXT PRIMARY KEY,
          run_at   INTEGER NOT NULL,
          kind     TEXT NOT NULL,
          payload  TEXT,
          attempts INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_run_at ON scheduled_tasks(run_at);

        CREATE TABLE IF NOT EXISTS dead_letters (
          id        TEXT PRIMARY KEY,
          kind      TEXT NOT NULL,
          payload   TEXT,
          attempts  INTEGER NOT NULL,
          failed_at INTEGER NOT NULL
        );

        -- Per-device daily inbound row budget. One row per UTC day, so a single
        -- device cannot spend the shared D1 write allowance for every other device.
        CREATE TABLE IF NOT EXISTS write_budget (
          day  TEXT PRIMARY KEY,
          rows INTEGER NOT NULL
        );
      `);

      // Migration for objects created before `attempts` existed. SQLite has no
      // ADD COLUMN IF NOT EXISTS, so a duplicate-column error is the success case.
      try {
        ctx.storage.sql.exec(
          `ALTER TABLE scheduled_tasks ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0`
        );
      } catch {
        // Column already present.
      }

      // Hibernation-safe ping/pong: answered by the edge without waking the DO.
      ctx.setWebSocketAutoResponse(
        new WebSocketRequestResponsePair('{"op":"ping"}', '{"op":"pong"}')
      );
    });
  }

  /** Timings are env-driven and clamped (brief amendment); cached per instance. */
  private get timings(): TimingConfig {
    if (!this.timingsCache) {
      this.timingsCache = timingConfig(this.env as unknown as Record<string, unknown>);
    }
    return this.timingsCache;
  }

  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    /* 1. WebSocket upgrade ------------------------------------------------- */
    if (req.headers.get("Upgrade")?.toLowerCase() === "websocket") {
      const deviceId =
        url.searchParams.get("device_id") ?? req.headers.get("X-Device-Id") ?? "";
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];

      this.ctx.acceptWebSocket(server);
      const attachment: WsAttachment = {
        deviceId,
        connectedAt: Date.now(),
        socketId: crypto.randomUUID(),
      };
      server.serializeAttachment(attachment);

      this.scheduleTask("offline_alert", Date.now() + this.timings.offlineAlertMs, "offline_alert", "{}");
      return new Response(null, { status: 101, webSocket: client });
    }

    /* 2. Pairing bootstrap ------------------------------------------------- */
    if (url.pathname === "/__pair") {
      return this.handlePair(req);
    }

    /* 2b. Revocation (hardening S10) ---------------------------------------- */
    if (url.pathname === "/__revoke") {
      return this.handleRevoke();
    }

    /* 3. Signature verify + replay guard (§3.2 steps 7 and 8) -------------- */
    if (url.pathname === "/__auth/verify") {
      return this.handleAuthVerify(req);
    }

    /* 4. Enqueue ---------------------------------------------------------- */
    if (url.pathname === "/__enqueue") {
      return this.handleEnqueue(req);
    }
    if (url.pathname === "/__enqueue_batch") {
      return this.handleEnqueueBatch(req);
    }

    /* 5. ACK + FCM token sync --------------------------------------------- */
    if (url.pathname === "/__http_ack") {
      return this.handleHttpAck(req);
    }

    /* 6. Pending commands (poll / piggyback) ------------------------------ */
    if (url.pathname === "/__pending") {
      return this.handlePending();
    }

    /* 6b. Daily inbound write budget --------------------------------------- */
    if (url.pathname === "/__reserve") {
      return this.handleReserve(req);
    }

    /* 7. Status transitions (guarded, §6.2) -------------------------------- */
    if (url.pathname === "/__status") {
      return this.handleStatusSingle(req);
    }
    if (url.pathname === "/__status_batch") {
      return this.handleStatusBatch(req);
    }

    /* 8. Introspection ---------------------------------------------------- */
    if (url.pathname === "/__device_status") {
      return this.handleDeviceStatus();
    }
    if (url.pathname === "/__command") {
      return this.handleCommandLookup(url);
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  }

  /* ====================================================================== */
  /* Signatures + replay guard                                              */
  /* ====================================================================== */

  /**
   * §3.2 steps 7 and 8 for this device: import the stored public key, verify the
   * raw P1363 signature, and only then consume the nonce.
   *
   * The write is the expensive part, so it is strictly last: an invalid signature
   * never pays for it. Both steps stay inside the DO because the public key and
   * the `nonces` table live here, next to the object that serialises access.
   */
  private async handleAuthVerify(req: Request): Promise<Response> {
    let payload: unknown;
    try {
      payload = await req.json();
    } catch {
      return err("bad_request", 400);
    }
    const body = (payload ?? {}) as Record<string, unknown>;

    const deviceId = body.deviceId;
    const ts = body.ts;
    const nonce = body.nonce;
    const canonical = body.canonical;
    const signatureB64 = body.signatureB64;

    if (
      typeof deviceId !== "string" ||
      typeof nonce !== "string" ||
      typeof canonical !== "string" ||
      typeof signatureB64 !== "string"
    ) {
      return err("bad_request", 400);
    }
    // The Worker has already proved the grammar; re-establish just enough of it
    // that a non-integer `ts` can never reach the `MAX(now, ts)` computation.
    if (typeof ts !== "number" || !Number.isFinite(ts) || !Number.isInteger(ts)) {
      return err("malformed_header", 401);
    }

    // --- §3.2 step 7: curve verification --------------------------------
    const deviceRows = this.ctx.storage.sql
      .exec(`SELECT public_key_spki FROM devices WHERE device_id = ?`, deviceId)
      .toArray() as { public_key_spki: string }[];
    if (deviceRows.length === 0) return err("device_unknown", 401);

    const signature = base64ToBytes(signatureB64);
    if (!signature || signature.byteLength !== SIGNATURE_BYTES) {
      return err("bad_signature_length", 401);
    }

    let verified = false;
    try {
      const publicKey = await crypto.subtle.importKey(
        "spki",
        base64ToBytes(deviceRows[0].public_key_spki) ?? new Uint8Array(0),
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"]
      );
      // Workers' crypto.subtle.verify for ECDSA consumes RAW IEEE P1363
      // (`r || s`, 64 bytes) — not ASN.1 DER. §3.1 is the client's obligation.
      verified = await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        publicKey,
        signature,
        utf8Bytes(canonical)
      );
    } catch (error) {
      console.error(`[auth] verification error for ${deviceId}: ${String(error)}`);
      return err("invalid_signature", 401);
    }
    if (!verified) return err("invalid_signature", 401);

    // --- §3.2 step 8: replay guard, LAST, inside one sync transaction -----
    const now = Date.now();
    const window = this.timings.nonceWindowMs;
    const replay = this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;

      // Prune everything whose replay-blocking window has already CLOSED.
      //
      // Strictly `<`, never `<=`. A nonce stored with `exp = ts + W` still has to
      // reject a replay at the last acceptable instant: a copy claiming the same
      // `ts` arriving at `now === exp` is inside the window (`|now - ts| <= W`,
      // inclusive), so `exp <= now` deleted the guard exactly one millisecond too
      // early. Pruning and admission must not share an inclusive boundary.
      sql.exec(`DELETE FROM nonces WHERE exp < ?`, now);

      const found = sql.exec(`SELECT 1 AS present FROM nonces WHERE nonce = ?`, nonce).toArray();
      if (found.length > 0) return "nonce_replay" as const;

      // §5.2: exp = MAX(now, ts) + W. Using `now + W` alone reopens a replay hole
      // for a future-dated ts, because the row would be pruned before the request's
      // own validity window closes.
      const exp = Math.max(now, ts) + window;
      sql.exec(`INSERT INTO nonces (nonce, ts, exp) VALUES (?, ?, ?)`, nonce, ts, exp);
      return null;
    });

    if (replay) return err("nonce_replay", 401);
    return new Response("ok", { status: 200 });
  }

  /* ====================================================================== */
  /* Pairing                                                                */
  /* ====================================================================== */

  private async handlePair(req: Request): Promise<Response> {
    let payload: unknown;
    try {
      payload = await req.json();
    } catch {
      return err("bad_request", 400);
    }
    const body = (payload ?? {}) as Record<string, unknown>;
    const deviceId = body.device_id;
    const publicKeySpki = body.public_key_spki;
    const fcmToken = typeof body.fcm_token === "string" ? body.fcm_token : null;
    // Authorization for replacing an existing key. Supplied by the Worker only when
    // the redeemed pairing code was minted with `purpose = 'rotate'`, i.e. when an
    // admin explicitly authorized a rotation of THIS device.
    const rotate = body.rotate === true;

    if (typeof deviceId !== "string" || deviceId === "") return err("bad_request", 400);
    if (typeof publicKeySpki !== "string" || publicKeySpki === "") return err("bad_request", 400);

    // Reject an unusable key HERE rather than storing it and failing the first
    // signed request with a confusing 401.
    const spki = base64ToBytes(publicKeySpki);
    if (!spki) return err("bad_request", 400);
    try {
      await crypto.subtle.importKey("spki", spki, { name: "ECDSA", namedCurve: "P-256" }, false, [
        "verify",
      ]);
    } catch {
      return err("bad_request", 400);
    }

    // A re-pair of the same device_id with a DIFFERENT key is a rotation, and the
    // previous key holder must be evicted — otherwise a stolen phone keeps its
    // socket and can still ack commands queued before the rotation.
    //
    // Rotation is only legitimate when the pairing code said so. An enrollment
    // redemption that targets an existing device is a takeover attempt (or a lost
    // race), and is refused WITHOUT writing anything: the D1 claim already blocks
    // it, and this second check keeps the DO honest even if another caller reaches
    // it directly. Re-pairing with the SAME key is not a rotation and stays allowed.
    const existing = this.ctx.storage.sql
      .exec(`SELECT public_key_spki FROM devices WHERE device_id = ?`, deviceId)
      .toArray()[0] as { public_key_spki?: string } | undefined;
    const rotating = existing !== undefined && existing.public_key_spki !== publicKeySpki;

    if (existing !== undefined && rotating && rotate !== true) {
      return err("device_exists", 409);
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO devices (device_id, public_key_spki, fcm_token, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(device_id) DO UPDATE SET
         public_key_spki = excluded.public_key_spki,
         fcm_token       = excluded.fcm_token,
         updated_at      = excluded.updated_at`,
      deviceId,
      publicKeySpki,
      fcmToken,
      Date.now()
    );

    if (rotating) this.evictPreviousKeyHolder();

    return Response.json({ ok: true });
  }

  /**
   * Kill everything the previous key holder still controls.
   *
   * The new key is already stored, so no NEW request from the old key can pass
   * verification. What survives a naive rotation is a live WebSocket (accepted
   * before the change) plus any commands already dispatched to it — both of which
   * let the old holder keep operating.
   */
  private evictPreviousKeyHolder(): void {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1000, "rekeyed");
      } catch {
        // Already closed.
      }
    }
    this.ctx.storage.sql.exec(`DELETE FROM commands`);
    this.ctx.storage.sql.exec(`DELETE FROM nonces`);
    // Per-command timers only; the offline alert is harmless and self-arms.
    this.ctx.storage.sql.exec(
      `DELETE FROM scheduled_tasks WHERE id LIKE 'ack:%' OR id LIKE 'exp:%'`
    );
    this.syncNextAlarm();
  }

  /* ====================================================================== */
  /* Enqueue                                                                */
  /* ====================================================================== */

  /**
   * Wipe everything that lets this device talk to us.
   *
   * Deleting the D1 row alone does NOT revoke a device — the public key lives in
   * this object's SQLite, so the key, all in-flight commands, the replay-guard
   * nonces and the schedule have to go too, and every live socket closed.
   */
  private handleRevoke(): Response {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1000, "revoked");
      } catch {
        // Already closed.
      }
    }
    this.ctx.storage.sql.exec(`DELETE FROM commands`);
    this.ctx.storage.sql.exec(`DELETE FROM nonces`);
    this.ctx.storage.sql.exec(`DELETE FROM devices`);
    this.ctx.storage.sql.exec(`DELETE FROM scheduled_tasks`);
    this.ctx.storage.deleteAlarm();
    return Response.json({ ok: true });
  }

  private async handleEnqueue(req: Request): Promise<Response> {
    const parsed = await readJson(req);
    if (!parsed) return err("bad_request", 400);
    const command = parseCommandInput(parsed);
    if (!command) return err("bad_request", 400);

    this.insertCommand(command);

    // #9: push ONLY the command just created.
    if (!this.pushCommands([toView(command)])) {
      await this.sendWakePush();
    }
    return Response.json({ ok: true });
  }

  private async handleEnqueueBatch(req: Request): Promise<Response> {
    const parsed = await readJson(req);
    if (!parsed) return err("bad_request", 400);
    const raw = Array.isArray(parsed.commands) ? parsed.commands : null;
    if (!raw) return err("bad_request", 400);

    const commands: CommandRow[] = [];
    for (const entry of raw) {
      const command = parseCommandInput(entry);
      if (!command) return err("bad_request", 400);
      commands.push(command);
    }
    if (commands.length === 0) return Response.json({ ok: true, enqueued: 0 });

    for (const command of commands) this.insertCommand(command);

    // One push for the whole batch, one wake push if there is no socket.
    if (!this.pushCommands(commands.map(toView))) {
      await this.sendWakePush();
    }
    return Response.json({ ok: true, enqueued: commands.length });
  }

  private insertCommand(command: CommandRow): void {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO commands (command_id, to_e164, body, priority, state, created_at, expires_at)
       VALUES (?, ?, ?, ?, 'PENDING', ?, ?)`,
      command.command_id,
      command.to_e164,
      command.body,
      command.priority,
      now,
      command.expires_at
    );
    this.scheduleTask(
      `exp:${command.command_id}`,
      command.expires_at,
      "expire",
      JSON.stringify({ command_id: command.command_id })
    );
  }

  /* ====================================================================== */
  /* Ack / pending / status                                                 */
  /* ====================================================================== */

  private async handleHttpAck(req: Request): Promise<Response> {
    const parsed = await readJson(req);
    if (!parsed) return err("bad_request", 400);

    const ackIds = Array.isArray(parsed.ack_command_ids) ? parsed.ack_command_ids : [];
    for (const id of ackIds) {
      if (typeof id !== "string" || id === "") continue;
      this.cancelAckTimeout(id);
      this.transition(id, "ACKED_BY_DEVICE");
    }

    const fcmToken = parsed.fcm_token;
    if (typeof fcmToken === "string" && fcmToken !== "") {
      this.ctx.storage.sql.exec(
        `UPDATE devices SET fcm_token = ?, updated_at = ?`,
        fcmToken,
        Date.now()
      );
    }

    return Response.json({ ok: true });
  }

  private handlePending(): Response {
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT command_id, to_e164, body, priority, state, created_at, expires_at
           FROM commands
          WHERE state = 'PENDING'
          ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, created_at`
      )
      .toArray() as unknown as CommandRow[];

    const commands = rows.map(toView);
    // §6.1: returned by poll -> DISPATCHED, with an ack_timeout that reverts it.
    for (const command of commands) this.markDispatched(command.command_id);

    return Response.json(commands);
  }

  /**
   * Reserve inbound D1 rows against this device's daily budget.
   *
   * The D1 write allowance is shared by the whole deployment, so without a
   * per-device cap one compromised or looping device can exhaust it for everybody
   * and take the operator's message log down with it. The counter lives here —
   * in the device's own object, in one synchronous transaction — so the check and
   * the increment cannot be split by a concurrent batch.
   *
   * Reservation is deliberately pessimistic: rows that later turn out to be
   * duplicates (`ON CONFLICT DO NOTHING`) are still charged. A device can always
   * retry tomorrow; the shared budget cannot be unspent after the fact.
   */
  private async handleReserve(req: Request): Promise<Response> {
    let payload: unknown;
    try {
      payload = await req.json();
    } catch {
      return err("bad_request", 400);
    }
    const requested = ((payload ?? {}) as Record<string, unknown>).rows;
    if (
      typeof requested !== "number" ||
      !Number.isInteger(requested) ||
      requested < 1 ||
      requested > MAX_INCOMING_MESSAGES
    ) {
      return err("bad_request", 400);
    }

    const day = new Date().toISOString().slice(0, 10);
    const cap = readIntEnv(this.env.INCOMING_ROWS_PER_DAY, 10_000, 100, 100_000);

    const outcome = this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const currentRows = sql
        .exec(`SELECT rows FROM write_budget WHERE day = ?`, day)
        .toArray() as { rows: number }[];
      const used = Number(currentRows[0]?.rows ?? 0);

      if (used + requested > cap) return { granted: false as const, used };

      sql.exec(
        `INSERT INTO write_budget (day, rows) VALUES (?, ?)
         ON CONFLICT(day) DO UPDATE SET rows = excluded.rows`,
        day,
        used + requested
      );
      // Yesterday's counters have no reader; drop them so the table stays at one
      // row. Cheap, indexed by the primary key.
      sql.exec(`DELETE FROM write_budget WHERE day < ?`, day);

      return { granted: true as const, used: used + requested };
    });

    if (!outcome.granted) return err("daily_quota_exceeded", 429);
    return Response.json({ ok: true, reserved: requested, used: outcome.used, cap });
  }

  private async handleStatusSingle(req: Request): Promise<Response> {
    const parsed = await readJson(req);
    if (!parsed) return err("bad_request", 400);
    const commandId = parsed.command_id;
    const status = parsed.status;
    if (typeof commandId !== "string" || typeof status !== "string") {
      return err("bad_request", 400);
    }
    const applied = this.transition(commandId, status);
    return Response.json({ applied: applied ? 1 : 0, rejected: applied ? 0 : 1 });
  }

  private async handleStatusBatch(req: Request): Promise<Response> {
    const parsed = await readJson(req);
    if (!parsed) return err("bad_request", 400);
    const updates = Array.isArray(parsed.updates) ? parsed.updates : null;
    if (!updates) return err("bad_request", 400);

    let applied = 0;
    let rejected = 0;
    for (const entry of updates) {
      if (!entry || typeof entry !== "object") {
        rejected++;
        continue;
      }
      const row = entry as Record<string, unknown>;
      if (typeof row.command_id !== "string" || typeof row.status !== "string") {
        rejected++;
        continue;
      }
      if (this.transition(row.command_id, row.status)) applied++;
      else rejected++;
    }
    // §6.1: rejected transitions are successful no-ops, so this is still a 200.
    return Response.json({ applied, rejected });
  }

  private handleDeviceStatus(): Response {
    const sockets = this.ctx.getWebSockets();
    const row = this.ctx.storage.sql
      .exec(`SELECT COUNT(*) AS cnt FROM commands WHERE state IN ('PENDING', 'DISPATCHED')`)
      .toArray() as { cnt: number }[];
    return Response.json({
      ws_connected: sockets.length > 0,
      queue_depth: Number(row[0]?.cnt ?? 0),
    });
  }

  private handleCommandLookup(url: URL): Response {
    const commandId = url.searchParams.get("command_id");
    if (!commandId) return err("bad_request", 400);
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT command_id, to_e164, body, priority, state, created_at, expires_at
           FROM commands WHERE command_id = ?`,
        commandId
      )
      .toArray() as unknown as CommandRow[];
    if (rows.length === 0) return err("bad_request", 404);
    const row = rows[0];
    return Response.json({
      command: {
        command_id: row.command_id,
        to: row.to_e164,
        body: row.body,
        priority: row.priority,
        state: row.state,
        created_at: row.created_at,
        expires_at: row.expires_at,
      },
    });
  }

  /**
   * §6.2: the guard lives in the SQL, never in application logic. Returns true
   * when the transition was applied and false for a rejected no-op — both are
   * successes to the caller (§6.1).
   */
  private transition(commandId: string, targetStatus: string): boolean {
    const allowed = ALLOWED_PREDECESSORS[targetStatus];
    if (!allowed || allowed.length === 0) return false;

    const placeholders = allowed.map(() => "?").join(", ");
    const cursor = this.ctx.storage.sql.exec(
      `UPDATE commands SET state = ? WHERE command_id = ? AND state IN (${placeholders})`,
      targetStatus,
      commandId,
      ...allowed
    );

    if (cursor.rowsWritten === 0) return false;

    // A resolved non-terminal transition no longer needs its ack timer.
    if (targetStatus !== "DISPATCHED" && targetStatus !== "PENDING") {
      this.cancelAckTimeout(commandId);
    }
    this.broadcastState(commandId, targetStatus);
    return true;
  }

  /** §6.1 `PENDING -> DISPATCHED` plus the `ack_timeout` that reverts it. */
  private markDispatched(commandId: string, socketId: string | null = null): boolean {
    const cursor = this.ctx.storage.sql.exec(
      `UPDATE commands SET state = 'DISPATCHED' WHERE command_id = ? AND state IN ('PENDING')`,
      commandId
    );
    if (cursor.rowsWritten === 0) return false;

    this.scheduleTask(
      `ack:${commandId}`,
      Date.now() + this.timings.ackTimeoutMs,
      "ack_timeout",
      JSON.stringify({ command_id: commandId, socket_id: socketId })
    );
    this.broadcastState(commandId, "DISPATCHED");
    return true;
  }

  /** Fire-and-forget fan-out so an already-open socket sees another client's ack. */
  private broadcastState(commandId: string, state: string): void {
    const payload = JSON.stringify({ op: "state", command_id: commandId, state });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        // A dead socket is not an error here; the next hello recovers PENDING.
      }
    }
  }

  /* ====================================================================== */
  /* WebSocket handlers                                                     */
  /* ====================================================================== */

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    let msg: unknown;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    const data = msg as Record<string, unknown>;
    const attachment = readAttachment(ws);

    if (data.op === "hello") {
      if (typeof data.fcm_token === "string" && data.fcm_token !== "" && attachment.deviceId) {
        this.ctx.storage.sql.exec(
          `UPDATE devices SET fcm_token = ?, updated_at = ? WHERE device_id = ?`,
          data.fcm_token,
          Date.now(),
          attachment.deviceId
        );
      }
      // #9: recovery path, and it recovers `PENDING` only.
      this.pushPendingToSocket(ws);
      return;
    }

    if (data.op === "ack" && Array.isArray(data.command_ids)) {
      // The HTTP path caps this list; the socket path must too, or the cap is a
      // suggestion.
      for (const id of data.command_ids.slice(0, MAX_ACK_IDS)) {
        if (typeof id !== "string" || id === "") continue;
        this.cancelAckTimeout(id);
        this.transition(id, "ACKED_BY_DEVICE");
      }
    }
  }

  override async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    _wasClean: boolean
  ): Promise<void> {
    try {
      ws.close(code, reason);
    } catch {
      // Already closed.
    }
  }

  /* ====================================================================== */
  /* Push paths                                                             */
  /* ====================================================================== */

  /**
   * #9: the enqueue/recovery push. Sends EXACTLY the commands it is given, so a
   * new command can never re-push (and re-timer) the ones already in flight.
   * Returns false when there is no usable socket, so the caller can wake the
   * device over FCM instead.
   */
  private pushCommands(commands: CommandView[]): boolean {
    if (commands.length === 0) return true;
    const ws = this.pickFreshSocket();
    if (!ws) return false;

    try {
      ws.send(JSON.stringify({ op: "commands", commands }));
    } catch {
      try {
        ws.close(1011, "send_failed");
      } catch {
        // Already closed.
      }
      return false;
    }

    const socketId = readAttachment(ws).socketId ?? null;
    for (const command of commands) this.markDispatched(command.command_id, socketId);
    return true;
  }

  /**
   * `hello`/reconnect recovery: `PENDING` ONLY.
   *
   * `DISPATCHED` commands are deliberately excluded — an `ack_timeout` already
   * reverts them to `PENDING` (§6.1), so re-pushing them here would restart their
   * timers on every reconnect and duplicate work the device is already doing.
   */
  private pushPendingToSocket(ws: WebSocket): void {
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT command_id, to_e164, body, priority, state, created_at, expires_at
           FROM commands
          WHERE state = 'PENDING'
          ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, created_at`
      )
      .toArray() as unknown as CommandRow[];

    if (rows.length === 0) return;
    const commands = rows.map(toView);

    try {
      ws.send(JSON.stringify({ op: "commands", commands }));
    } catch {
      return;
    }
    for (const command of commands) this.markDispatched(command.command_id);
  }

  /** #22: never let an FCM outage break command enqueue. */
  private async sendWakePush(): Promise<void> {
    const rows = this.ctx.storage.sql
      .exec(`SELECT fcm_token FROM devices LIMIT 1`)
      .toArray() as { fcm_token: string | null }[];
    await sendFcmHighPriorityWake(this.env, rows[0]?.fcm_token ?? null);
  }

  /**
   * The first socket whose liveness evidence is still within
   * `STALE_SOCKET_MS`. Stale sockets are closed (which is how a device learns to
   * reconnect and re-`hello`), and a socket with NO trustworthy liveness evidence
   * is treated as fresh: see `socketLastSeen`.
   */
  private pickFreshSocket(): WebSocket | null {
    const sockets = this.ctx.getWebSockets();
    for (const ws of sockets) {
      const lastSeen = this.socketLastSeen(ws, readAttachment(ws));
      if (lastSeen === null) return ws; // unknown liveness -> never close on null
      if (Date.now() - lastSeen <= this.timings.staleSocketMs) return ws;
      try {
        ws.close(1001, "stale_connection");
      } catch {
        // Already closed.
      }
    }
    return null;
  }

  /**
   * Freshest trustworthy liveness evidence, or `null` when there is none.
   *
   * `ctx.getWebSocketAutoResponseTimestamp(ws)` is UNVERIFIED in this environment
   * and may be missing, may return `null`, or may return a stub — so it is never
   * load-bearing: a non-Date, NaN, zero/negative or absurdly-future value is
   * discarded, and a `null` from it must never close a socket or trigger a false
   * offline alert. When nothing trustworthy exists the caller must assume the
   * socket is alive.
   */
  private socketLastSeen(ws: WebSocket, attachment: WsAttachment): number | null {
    const autoResponse = this.autoResponseTimestamp(ws);
    const connectedAt =
      Number.isFinite(attachment.connectedAt) && attachment.connectedAt > 0
        ? attachment.connectedAt
        : null;

    if (autoResponse === null && connectedAt === null) return null;
    if (autoResponse === null) return connectedAt;
    if (connectedAt === null) return autoResponse;
    return Math.max(autoResponse, connectedAt);
  }

  /** See `socketLastSeen`: every failure mode degrades to `null`, never to a guess. */
  private autoResponseTimestamp(ws: WebSocket): number | null {
    try {
      const candidate = this.ctx as unknown as {
        getWebSocketAutoResponseTimestamp?: (socket: WebSocket) => Date | null;
      };
      const fn = candidate.getWebSocketAutoResponseTimestamp;
      if (typeof fn !== "function") return null;

      const value = fn.call(this.ctx, ws);
      const ms =
        value instanceof Date ? value.getTime() : typeof value === "number" ? value : Number.NaN;
      if (!Number.isFinite(ms) || ms <= 0) return null;
      if (ms > Date.now() + AUTO_RESPONSE_FUTURE_SKEW_MS) return null;
      return ms;
    } catch {
      return null;
    }
  }

  /* ====================================================================== */
  /* Alarms                                                                 */
  /* ====================================================================== */

  /**
   * #10/#11/#12: each due task is dequeued, run in isolation, and its row is
   * deleted ONLY after its work succeeded. `syncNextAlarm()` is in a `finally` so
   * the schedule is correct even if the loop throws.
   */
  override async alarm(): Promise<void> {
    try {
      // Retention (S6): terminal commands hold the outbound body and the peer
      // number in DO SQLite. Pruning D1 alone would leave every outbound SMS
      // body and phone number here forever.
      const cutoff = Date.now() - this.timings.retentionDays * 86_400_000;
      const pruned = this.ctx.storage.sql.exec(
        `DELETE FROM commands WHERE state IN ('DELIVERED','FAILED','EXPIRED') AND created_at < ?`,
        cutoff
      );
      if (pruned.rowsWritten > 0) {
        console.log(`[retention] pruned ${pruned.rowsWritten} terminal commands`);
      }

      const due = this.ctx.storage.sql
        .exec(
          `SELECT id, kind, payload FROM scheduled_tasks WHERE run_at <= ? ORDER BY run_at ASC`,
          Date.now()
        )
        .toArray() as unknown as ScheduledTaskRow[];

      for (const task of due) {
        let outcome: TaskOutcome;
        try {
          outcome = await this.runTask(task);
        } catch (error) {
          // Bounded retries. An unbounded retry loop costs a Durable Object
          // request every 30 s forever and produces no signal beyond a log line.
          const attempts = this.bumpAttempts(task.id);
          if (attempts >= MAX_TASK_ATTEMPTS) {
            this.ctx.storage.sql.exec(
              `INSERT OR REPLACE INTO dead_letters (id, kind, payload, attempts, failed_at)
               VALUES (?, ?, ?, ?, ?)`,
              task.id,
              task.kind,
              task.payload ?? "{}",
              attempts,
              Date.now()
            );
            this.ctx.storage.sql.exec(`DELETE FROM scheduled_tasks WHERE id = ?`, task.id);
            console.error(
              `[alarm:dead_letter] ${task.id} (${task.kind}) after ${attempts} attempts: ${String(error)}`
            );
          } else {
            console.error(
              `[alarm:retry] ${task.id} (${task.kind}) attempt ${attempts}: ${String(error)}`
            );
            this.ctx.storage.sql.exec(
              `UPDATE scheduled_tasks SET attempts = ?, run_at = ? WHERE id = ?`,
              attempts,
              Date.now() + TASK_RETRY_BACKOFF_MS,
              task.id
            );
          }
          continue;
        }
        // A task that rescheduled itself has already replaced its own row; only
        // completed work is dequeued.
        if (outcome === "consumed") {
          this.ctx.storage.sql.exec(`DELETE FROM scheduled_tasks WHERE id = ?`, task.id);
        }
      }
    } finally {
      this.syncNextAlarm();
    }
  }

  private async runTask(task: ScheduledTaskRow): Promise<TaskOutcome> {
    const payload = parseTaskPayload(task.payload);

    if (task.kind === "expire") {
      const commandId = payload.command_id;
      if (typeof commandId === "string") {
        // §6.1: `PENDING|DISPATCHED -> EXPIRED`. Terminal states are never touched.
        this.transition(commandId, "EXPIRED");
      }
      return "consumed";
    }

    if (task.kind === "ack_timeout") {
      const commandId = payload.command_id;
      if (typeof commandId === "string") {
        // §6.1: `DISPATCHED -> PENDING`, guarded in SQL, so an acked or delivered
        // command is left exactly as it is.
        const reverted = this.transition(commandId, "PENDING");
        if (reverted) {
          // Close only the socket the command was pushed to. A command delivered
          // over an HTTP poll has no owning socket, and one slow ack must not
          // tear down a device's other connections.
          const socketId = typeof payload.socket_id === "string" ? payload.socket_id : null;
          if (socketId !== null) {
            for (const ws of this.ctx.getWebSockets()) {
              if (readAttachment(ws).socketId !== socketId) continue;
              try {
                ws.close(1011, "ack_timeout");
              } catch {
                // Already closed.
              }
            }
          }
          await this.sendWakePush();
        }
      }
      return "consumed";
    }

    if (task.kind === "offline_alert") {
      const now = Date.now();
      const ws = this.ctx.getWebSockets()[0];
      if (ws) {
        const lastSeen = this.socketLastSeen(ws, readAttachment(ws));
        if (lastSeen === null) {
          // No trustworthy liveness evidence (see socketLastSeen): re-arm and stay
          // silent rather than raise a false offline alert.
          this.scheduleTask("offline_alert", now + this.timings.offlineAlertMs, "offline_alert", "{}");
          return "rescheduled";
        }
        if (now - lastSeen < this.timings.offlineAlertMs) {
          this.scheduleTask(
            "offline_alert",
            lastSeen + this.timings.offlineAlertMs,
            "offline_alert",
            "{}"
          );
          return "rescheduled";
        }
      }
      console.warn(`[offline_alert] device silent for > ${this.timings.offlineAlertMs} ms`);
      return "consumed";
    }

    // Unknown kind: nothing to do, and keeping it would retry forever.
    return "consumed";
  }

  private bumpAttempts(id: string): number {
    const row = this.ctx.storage.sql
      .exec(`SELECT attempts FROM scheduled_tasks WHERE id = ?`, id)
      .toArray()[0] as { attempts?: number } | undefined;
    return Number(row?.attempts ?? 0) + 1;
  }

  private scheduleTask(id: string, runAt: number, kind: string, payload: string): void {
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO scheduled_tasks (id, run_at, kind, payload) VALUES (?, ?, ?, ?)`,
      id,
      runAt,
      kind,
      payload
    );
    this.syncNextAlarm();
  }

  private cancelAckTimeout(commandId: string): void {
    const cursor = this.ctx.storage.sql.exec(
      `DELETE FROM scheduled_tasks WHERE id = ?`,
      `ack:${commandId}`
    );
    if (cursor.rowsWritten > 0) this.syncNextAlarm();
  }

  /**
   * #11: `!= null`, not truthiness — `run_at = 0` is a legitimate timestamp and
   * the old `if (next?.m)` wiped the whole schedule for it. `next` itself is
   * guarded too, because `MIN()` over an empty table returns one row of `NULL`.
   */
  private syncNextAlarm(): void {
    const rows = this.ctx.storage.sql
      .exec(`SELECT MIN(run_at) AS m FROM scheduled_tasks`)
      .toArray() as { m: number | null }[];
    const next = rows[0]?.m ?? null;
    if (next != null) {
      this.ctx.storage.setAlarm(Number(next));
    } else {
      this.ctx.storage.deleteAlarm();
    }
  }
}

/* ======================================================================== */
/* Helpers                                                                  */
/* ======================================================================== */

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed = await req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseTaskPayload(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || "{}");
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function parseCommandInput(entry: unknown): CommandRow | null {
  if (!entry || typeof entry !== "object") return null;
  const row = entry as Record<string, unknown>;

  const commandId = row.command_id;
  const to = row.to;
  const body = row.body;
  const expiresAt = row.expires_at;

  if (typeof commandId !== "string" || commandId === "") return null;
  if (typeof to !== "string" || to === "") return null;
  if (typeof body !== "string") return null;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return null;

  const priority =
    row.priority === "high" || row.priority === "normal" || row.priority === "low"
      ? row.priority
      : "normal";

  return {
    command_id: commandId,
    to_e164: to,
    body,
    priority,
    state: "PENDING",
    created_at: Date.now(),
    expires_at: expiresAt,
  };
}

function toView(command: CommandRow): CommandView {
  return {
    command_id: command.command_id,
    to: command.to_e164,
    body: command.body,
    priority: command.priority,
    expires_at: command.expires_at,
  };
}

function readAttachment(ws: WebSocket): WsAttachment {
  try {
    const raw = ws.deserializeAttachment() as unknown;
    if (raw && typeof raw === "object") {
      const candidate = raw as Partial<WsAttachment>;
      return {
        deviceId: typeof candidate.deviceId === "string" ? candidate.deviceId : "",
        connectedAt: typeof candidate.connectedAt === "number" ? candidate.connectedAt : 0,
        // Must be carried through: the ack_timeout path matches sockets by this id,
        // and omitting it silently turns "close the owning socket" into "close none".
        socketId: typeof candidate.socketId === "string" ? candidate.socketId : undefined,
      };
    }
  } catch {
    // Hibernated sockets may have no readable attachment.
  }
  return { deviceId: "", connectedAt: 0 };
}

/** Standard padded base64 only; anything else is rejected rather than guessed. */
function base64ToBytes(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
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
