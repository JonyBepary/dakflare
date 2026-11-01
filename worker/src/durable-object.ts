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
  MAX_OUTBOUND_COMMANDS,
  type TimingConfig,
  MAX_IDEMPOTENCY_KEY_CHARS,
} from "./lib/config";
import { carriesRetiredAckKey, parseAcks } from "./lib/acks";
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

/**
 * The command shape sent to the device (Rev E §6.1 `PENDING -> LEASED` payload).
 *
 * `claim_token` travels WITH the command because the ack has to echo it back.
 * Without it the device cannot prove it is the holder of this lease, and the
 * edge would have to trust any device that names a command id.
 */
interface CommandView {
  command_id: string;
  to: string;
  body: string;
  priority: string;
  expires_at: number;
  claim_token: string;
  /** 1 or 2, or 0 for "no preference". Chosen by the sender, honoured by the phone. */
  sim_slot: number;
}

interface CommandRow {
  command_id: string;
  to_e164: string;
  body: string;
  priority: string;
  state: string;
  created_at: number;
  expires_at: number;
  /** Caller-supplied dedupe key, or null for an ordinary send. */
  idempotency_key: string | null;
  /** 1 or 2, or 0 for "no preference". */
  sim_slot: number;
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
 * Rev E §6.1 allowed transitions, expressed as "allowed predecessors of the
 * target".
 *
 * §6.2 requires the guard to live IN SQL so it is atomic and cannot be bypassed
 * from a new route. Terminal states (`DELIVERED`, `FAILED`, `EXPIRED`) appear
 * only on the right-hand side, so no transition can ever leave them:
 *   - `SENT -> DISPATCHED` (a stale ack): `DISPATCHED` accepts only `LEASED`, so
 *     it is a no-op;
 *   - `DELIVERED -> SENT`: `SENT` accepts only `DISPATCHED`, so it is a no-op;
 *   - `EXPIRED -> *`: nothing accepts `EXPIRED` as a predecessor.
 *
 * `LEASED -> DISPATCHED` additionally requires the matching `claim_token`; see
 * `transition`. `PENDING` is a target only from a lease that expired.
 */
const ALLOWED_PREDECESSORS: Readonly<Record<string, readonly string[]>> = {
  LEASED: ["PENDING"],
  PENDING: ["LEASED"],
  DISPATCHED: ["LEASED"],
  SENT: ["DISPATCHED"],
  DELIVERED: ["SENT"],
  FAILED: ["DISPATCHED", "SENT"],
  EXPIRED: ["PENDING", "LEASED"],
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
          expires_at INTEGER NOT NULL,
          idempotency_key TEXT,
          claim_token TEXT,
          lease_until INTEGER,
          sim_slot   INTEGER NOT NULL DEFAULT 0
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

      // Idempotency (CLI slice 2b). The key lives on the command row on purpose:
      // the retention sweep already deletes terminal commands, so a key cannot
      // outlive the command it points at and hand back an unreadable id.
      try {
        ctx.storage.sql.exec(`ALTER TABLE commands ADD COLUMN idempotency_key TEXT`);
      } catch {
        // Column already present.
      }
      // Partial unique index: one command per key, and any number of NULL keys,
      // which is every command sent without one.
      try {
        ctx.storage.sql.exec(
          `CREATE UNIQUE INDEX IF NOT EXISTS idx_commands_idempotency
             ON commands(idempotency_key) WHERE idempotency_key IS NOT NULL`
        );
      } catch (error) {
        // Two rows already share a key, which cannot happen unless a partial
        // rollout inserted duplicates. Refusing to boot would take the whole
        // device down over a bookkeeping index.
        console.error(`[do] idempotency index skipped: ${String(error)}`);
      }

      // Rev E lease columns. Objects created before 6.0.0 have a `commands` table
      // without them, and SQLite has no ADD COLUMN IF NOT EXISTS, so a duplicate
      // -column error is the success case here too.
      for (const statement of [
        `ALTER TABLE commands ADD COLUMN claim_token TEXT`,
        `ALTER TABLE commands ADD COLUMN lease_until INTEGER`,
        `ALTER TABLE commands ADD COLUMN sim_slot INTEGER NOT NULL DEFAULT 0`,
      ]) {
        try {
          ctx.storage.sql.exec(statement);
        } catch {
          // Column already present.
        }
      }

      // The lease scan is `state = ... AND lease_until <= now` ordered by
      // priority, so the index leads with state and lease_until. Without it every
      // poll and every push scans the whole command table, which grows with the
      // retention window.
      ctx.storage.sql.exec(
        `CREATE INDEX IF NOT EXISTS idx_commands_dispatch
           ON commands(state, lease_until, priority, created_at)`
      );

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
    if (url.pathname === "/__commands") {
      return this.handleCommands(url);
    }
    if (url.pathname === "/__trace") {
      return this.handleTrace(url);
    }
    if (url.pathname === "/__dlq") {
      return this.handleDeadLetters(url);
    }
    if (url.pathname === "/__ws") {
      return this.handleSocketInspection();
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
      //
      // Pruned lazily, one signed request in twenty, plus every alarm tick. Doing
      // it on every request wrote the table and its index twice per request for no
      // security gain: an unpruned expired nonce still blocks its own replay, and
      // the timestamp window already rejects a stale one. The alarm is the
      // backstop, so a quiet object still gets cleaned.
      if (Math.random() < 0.05) sql.exec(`DELETE FROM nonces WHERE exp < ?`, now);

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

    // Idempotency (slice 2b). A key that already produced a command returns that
    // command rather than a second SMS. The lookup and the insert run without an
    // await between them, and a Durable Object serialises its requests, so two
    // concurrent retries cannot both miss the row.
    if (command.idempotency_key !== null) {
      const existing = this.commandIdForKey(command.idempotency_key);
      if (existing !== null) {
        return Response.json({ ok: true, replayed: true, command_id: existing });
      }
    }

    this.insertCommand(command);

    // #9: push ONLY the command just created. The push leases it, so a socket
    // that vanished between `pickFreshSocket` and `send` releases the lease
    // instead of stranding the command in `LEASED` for a full lease window.
    if (!this.pushCommands([command.command_id])) {
      await this.sendWakePush();
    }
    return Response.json({ ok: true, replayed: false, command_id: command.command_id });
  }

  /** The command a key already created, or null when the key is new. */
  private commandIdForKey(key: string): string | null {
    const rows = this.ctx.storage.sql
      .exec(`SELECT command_id FROM commands WHERE idempotency_key = ?`, key)
      .toArray() as unknown as { command_id: string }[];
    return rows.length === 0 ? null : rows[0].command_id;
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
      // The batch has no per-entry replay answer yet. Accepting the key would
      // either duplicate or throw on the unique index, and silently dropping it
      // would be worse than saying so.
      if (command.idempotency_key !== null) {
        return err("idempotency_key_not_supported_in_batch", 400);
      }
      commands.push(command);
    }
    if (commands.length === 0) return Response.json({ ok: true, enqueued: 0 });

    for (const command of commands) this.insertCommand(command);

    // One push for the whole batch, one wake push if there is no socket.
    if (!this.pushCommands(commands.map((command) => command.command_id))) {
      await this.sendWakePush();
    }
    return Response.json({ ok: true, enqueued: commands.length });
  }

  private insertCommand(command: CommandRow): void {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO commands
         (command_id, to_e164, body, priority, state, created_at, expires_at,
          idempotency_key, sim_slot)
       VALUES (?, ?, ?, ?, 'PENDING', ?, ?, ?, ?)`,
      command.command_id,
      command.to_e164,
      command.body,
      command.priority,
      now,
      command.expires_at,
      command.idempotency_key,
      command.sim_slot
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

    // Rev E: acks are objects carrying the lease token. A v5.2.1 body that still
    // sends `ack_command_ids` is rejected rather than ignored: silence would let
    // the phone believe it acknowledged while the lease churns underneath it.
    if (carriesRetiredAckKey(parsed)) return err("bad_request", 400);
    const acks = parseAcks(parsed.acks);
    if (acks === null) return err("bad_request", 400);

    let applied = 0;
    for (const ack of acks) {
      if (this.transition(ack.command_id, "DISPATCHED", ack.claim_token)) applied++;
    }

    const fcmToken = parsed.fcm_token;
    if (typeof fcmToken === "string" && fcmToken !== "") {
      this.ctx.storage.sql.exec(
        `UPDATE devices SET fcm_token = ?, updated_at = ?`,
        fcmToken,
        Date.now()
      );
    }

    return Response.json({ ok: true, applied });
  }

  /**
   * Arm the offline watch from any authenticated contact, not only a WebSocket.
   *
   * The app that ships today is poll-only. If the watch were armed only on socket
   * connect, a phone that never connects would never raise `device_offline`, and
   * the alert banner would be dead code for exactly the deployment it was built
   * for. Polling re-arms the same single task; when polling stops, the task fires
   * one `OFFLINE_ALERT_MS` later. The half-window guard keeps that to one write
   * per window while tolerating a poll interval of several minutes.
   */
  private ensureOfflineWatch(): void {
    const now = Date.now();
    const row = this.ctx.storage.sql
      .exec(`SELECT run_at FROM scheduled_tasks WHERE id = 'offline_alert'`)
      .toArray()[0] as { run_at?: number } | undefined;
    if (row && Number(row.run_at) - now > this.timings.offlineAlertMs / 2) return;
    this.scheduleTask("offline_alert", now + this.timings.offlineAlertMs, "offline_alert", "{}");
  }

  private handlePending(): Response {
    // A poll-only device never opens a socket, so the connect path cannot be the
    // only place that arms the silence watch. Re-arming is throttled to once a
    // minute of headroom: a device polling every few seconds must not write a
    // scheduled task (and reset the DO alarm) on every request.
    this.ensureOfflineWatch();

    // §6.1: returned by poll -> LEASED, with a lease that reverts it. A poll has
    // no socket, so there is none to close when the lease expires.
    const commands = this.leaseCommands(MAX_OUTBOUND_COMMANDS);
    for (const command of commands) this.armLeaseExpiry(command, null);
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
    const claimToken = typeof parsed.claim_token === "string" ? parsed.claim_token : undefined;
    const applied = this.transition(commandId, status, claimToken);
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
      // `DISPATCHED` is reportable here too, and it is the one status that needs
      // the lease token, so the batch carries it when the device sends it.
      const claimToken = typeof row.claim_token === "string" ? row.claim_token : undefined;
      if (this.transition(row.command_id, row.status, claimToken)) applied++;
      else rejected++;
    }
    // §6.1: rejected transitions are successful no-ops, so this is still a 200.
    return Response.json({ applied, rejected });
  }

  private handleDeviceStatus(): Response {
    const sockets = this.ctx.getWebSockets();
    const row = this.ctx.storage.sql
      .exec(`SELECT COUNT(*) AS cnt FROM commands WHERE state IN ('PENDING', 'LEASED')`)
      .toArray() as { cnt: number }[];
    return Response.json({
      ws_connected: sockets.length > 0,
      queue_depth: Number(row[0]?.cnt ?? 0),
    });
  }

  /**
   * `GET /__trace?id=…` — everything this object knows about one id.
   *
   * One request instead of four, and it is the only place the answer can be
   * complete: the command row, the timers armed for it, the dead letters it left
   * behind, and the sockets that could have carried it all live here, in object
   * storage that D1 never sees.
   *
   * Matching is `instr(payload, ?) > 0` rather than `LIKE`: an id is opaque and a
   * LIKE pattern would treat `_` in a uuid as a wildcard.
   */
  private handleTrace(url: URL): Response {
    const id = url.searchParams.get("id");
    if (id === null || id === "") return err("bad_request", 400);
    const now = Date.now();

    const commandRows = this.ctx.storage.sql
      .exec(
        `SELECT command_id, to_e164, body, priority, state, created_at, expires_at,
                claim_token, lease_until, idempotency_key
           FROM commands WHERE command_id = ?`,
        id
      )
      .toArray() as unknown as Record<string, unknown>[];

    const tasks = this.ctx.storage.sql
      .exec(
        `SELECT id, kind, run_at, payload, attempts
           FROM scheduled_tasks
          WHERE instr(id, ?) > 0 OR instr(payload, ?) > 0
          ORDER BY run_at ASC`,
        id,
        id
      )
      .toArray() as unknown as Record<string, unknown>[];

    const letters = this.ctx.storage.sql
      .exec(
        `SELECT id, kind, payload, attempts, failed_at
           FROM dead_letters
          WHERE instr(id, ?) > 0 OR instr(payload, ?) > 0
          ORDER BY failed_at DESC`,
        id,
        id
      )
      .toArray() as unknown as Record<string, unknown>[];

    // The object's `devices` row is the PAIRING record (key + updated_at); liveness
    // lives in D1 and in the sockets. Ask only for what is here.
    const device = this.ctx.storage.sql
      .exec(`SELECT device_id, updated_at, fcm_token IS NOT NULL AS has_fcm FROM devices LIMIT 1`)
      .toArray() as unknown as { device_id: string; updated_at: number; has_fcm: number }[];

    const depth = this.ctx.storage.sql
      .exec(`SELECT COUNT(*) AS cnt FROM commands WHERE state IN ('PENDING', 'LEASED')`)
      .toArray() as { cnt: number }[];

    return Response.json({
      id,
      device: device[0] ?? null,
      command: commandRows[0] ?? null,
      scheduled_tasks: tasks,
      dead_letters: letters,
      sockets: this.socketSummary(now),
      queue_depth: Number(depth[0]?.cnt ?? 0),
      now,
    });
  }

  /** `GET /__dlq?limit=N` — the object's dead letters, newest first. */
  private handleDeadLetters(url: URL): Response {
    const raw = Number(url.searchParams.get("limit") ?? "50");
    const limit = Number.isFinite(raw) ? Math.min(200, Math.max(1, Math.trunc(raw))) : 50;
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT id, kind, payload, attempts, failed_at
           FROM dead_letters ORDER BY failed_at DESC LIMIT ?`,
        limit
      )
      .toArray() as unknown as Record<string, unknown>[];
    return Response.json({ dead_letters: rows, limit });
  }

  /** `GET /__ws` — what the sockets for this device actually are right now. */
  private handleSocketInspection(): Response {
    return Response.json({ sockets: this.socketSummary(Date.now()), now: Date.now() });
  }

  /**
   * One row per socket: which connection, when it was accepted, and how fresh its
   * liveness evidence is. `stale_ms` is derived from the same
   * `socketLastSeen` the push path uses, so the console and the close decision
   * cannot disagree about what "quiet" means.
   */
  private socketSummary(now: number): Array<Record<string, unknown>> {
    return this.ctx.getWebSockets().map((ws) => {
      const attachment = readAttachment(ws);
      const lastSeen = this.socketLastSeen(ws, attachment);
      const state = this.socketStateOf(ws);
      return {
        socket_id: attachment.socketId,
        connected_at: attachment.connectedAt,
        last_seen: lastSeen,
        quiet_ms: lastSeen === null ? null : now - lastSeen,
        state,
      };
    });
  }

  private socketStateOf(ws: WebSocket): string {
    try {
      const candidate = ws as unknown as { readyState?: number };
      switch (candidate.readyState) {
        case 0:
          return "CONNECTING";
        case 1:
          return "OPEN";
        case 2:
          return "CLOSING";
        case 3:
          return "CLOSED";
        default:
          return "UNKNOWN";
      }
    } catch {
      return "UNKNOWN";
    }
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
   * `GET /__commands?limit=N` — newest-first queue view for the operator console.
   *
   * `limit` is clamped here, in the DO, so the admin proxy cannot widen it by
   * passing a different value. An unknown device simply has no rows.
   */
  private handleCommands(url: URL): Response {
    const raw = url.searchParams.get("limit");
    const parsed = raw === null || raw.trim() === "" ? 20 : Number(raw);
    const limit = Number.isFinite(parsed) ? Math.min(50, Math.max(1, Math.trunc(parsed))) : 20;

    const rows = this.ctx.storage.sql
      .exec(
        `SELECT command_id, to_e164, body, priority, state, created_at, expires_at
           FROM commands
          ORDER BY created_at DESC, command_id DESC
          LIMIT ?`,
        limit
      )
      .toArray() as unknown as CommandRow[];

    return Response.json({
      commands: rows.map((row) => ({
        command_id: row.command_id,
        to_e164: row.to_e164,
        body: row.body,
        priority: row.priority,
        state: row.state,
        created_at: row.created_at,
        expires_at: row.expires_at,
      })),
    });
  }

  /**
   * Rev E §6.2: the guard lives in the SQL, never in application logic. Returns
   * true when the transition was applied and false for a rejected no-op — both
   * are successes to the caller (§6.1).
   *
   * `LEASED -> DISPATCHED` additionally requires the matching lease token. That
   * is the only transition a device drives on its own, so it is the only one that
   * needs proof of ownership. A command that was never leased has no token at
   * all, so an ack for it is refused instead of trusted.
   */
  private transition(commandId: string, targetStatus: string, claimToken?: string): boolean {
    const allowed = ALLOWED_PREDECESSORS[targetStatus];
    if (!allowed || allowed.length === 0) return false;

    const guards = ["command_id = ?", `state IN (${allowed.map(() => "?").join(", ")})`];
    const params: unknown[] = [targetStatus, commandId, ...allowed];

    if (targetStatus === "DISPATCHED") {
      if (typeof claimToken !== "string" || claimToken === "") return false;
      guards.push("claim_token = ?");
      params.push(claimToken);
    }

    const cursor = this.ctx.storage.sql.exec(
      `UPDATE commands SET state = ? WHERE ${guards.join(" AND ")}`,
      ...params
    );
    if (cursor.rowsWritten === 0) return false;

    // A settled transition no longer needs its timers. `LEASED` is the only state
    // that keeps them, and `PENDING` is the state a lease was released into.
    if (targetStatus !== "LEASED" && targetStatus !== "PENDING") {
      this.cancelLeaseTimers(commandId);
    }
    this.broadcastState(commandId, targetStatus);
    return true;
  }

  /**
   * Claim up to `limit` claimable commands and return them with their tokens.
   *
   * One statement, because the `UPDATE` *is* the claim: two transports racing for
   * the same command (a WebSocket push and an HTTP poll) cannot both receive it.
   * The old read-then-mark pair could, which is what the lease exists to stop.
   *
   * A command is claimable when it is `PENDING`, or when it is `LEASED` and that
   * lease has run out. `expires_at` is checked so a dead command is never handed
   * out; the `expire` task is what moves it to `EXPIRED`.
   *
   * `only` narrows the claim to specific ids, which the enqueue push needs so it
   * cannot drag along unrelated queued commands the way a bare scan would.
   */
  private leaseCommands(limit: number, only?: readonly string[]): CommandView[] {
    if (limit <= 0) return [];
    if (only !== undefined && only.length === 0) return [];

    const now = Date.now();
    const params: unknown[] = [now + this.timings.leaseMs, now, now];

    let idFilter = "";
    if (only !== undefined) {
      idFilter = ` AND command_id IN (${only.map(() => "?").join(", ")})`;
      params.push(...only);
    }
    params.push(limit);

    const rows = this.ctx.storage.sql
      .exec(
        `UPDATE commands
            SET state = 'LEASED',
                claim_token = lower(hex(randomblob(16))),
                lease_until = ?
          WHERE command_id IN (
            SELECT command_id FROM commands
             WHERE (state = 'PENDING'
                    OR (state = 'LEASED' AND lease_until <= ?))
               AND expires_at > ?${idFilter}
             ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
                      created_at
             LIMIT ?
          )
          RETURNING command_id, to_e164, body, priority, expires_at, claim_token, sim_slot`,
        ...params
      )
      .toArray() as unknown as {
      command_id: string;
      to_e164: string;
      body: string;
      priority: string;
      expires_at: number;
      claim_token: string;
      sim_slot: number;
    }[];

    const commands: CommandView[] = rows.map((row) => ({
      command_id: row.command_id,
      to: row.to_e164,
      body: row.body,
      priority: row.priority,
      expires_at: row.expires_at,
      claim_token: row.claim_token,
      sim_slot: Number(row.sim_slot ?? 0),
    }));

    return commands;
  }

  /**
   * Arm the expiry for a lease that has actually been handed over.
   *
   * Scheduled by the caller and not by `leaseCommands`, because the timer needs
   * the id of the socket the frame really went to: a lease that expires closes
   * exactly that socket, which is how a wedged device learns to reconnect. A
   * command collected over an HTTP poll has no socket to close.
   */
  private armLeaseExpiry(command: CommandView, socketId: string | null): void {
    this.scheduleTask(
      `lease:${command.command_id}`,
      Date.now() + this.timings.leaseMs,
      "lease_expiry",
      JSON.stringify({
        command_id: command.command_id,
        claim_token: command.claim_token,
        socket_id: socketId,
      })
    );
  }

  /**
   * Hand leases back because the frame carrying them never reached the device.
   *
   * Guarded on the token so a lease that was re-granted in the meantime is left
   * alone: this releases OUR lease, not whatever currently holds the command.
   */
  private releaseLeases(commands: readonly CommandView[]): void {
    for (const command of commands) {
      this.ctx.storage.sql.exec(
        `UPDATE commands
            SET state = 'PENDING', claim_token = NULL, lease_until = NULL
          WHERE command_id = ? AND state = 'LEASED' AND claim_token = ?`,
        command.command_id,
        command.claim_token
      );
      this.cancelLeaseTimers(command.command_id);
    }
    for (const command of commands) this.broadcastState(command.command_id, "PENDING");
  }

  /**
   * Arm the "the phone has gone quiet" close for one leased command.
   *
   * This is the only thing `ACK_TIMEOUT_MS` still governs. It never releases the
   * lease, because a `SmsManager` send can legitimately outlast it and releasing
   * the command mid-send is what produces a duplicate SMS. Closing the socket
   * makes a dead or wedged device reconnect and re-`hello`.
   */
  private armWakeTimer(commandId: string, claimToken: string, socketId: string): void {
    this.scheduleTask(
      `wake:${commandId}`,
      Date.now() + this.timings.ackTimeoutMs,
      "ack_wake",
      JSON.stringify({ command_id: commandId, claim_token: claimToken, socket_id: socketId })
    );
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

    if (data.op === "ack") {
      // Rev E: acks are objects carrying the lease token, on every transport.
      // The slice cap applies here too, or the HTTP cap is only a suggestion.
      const acks = Array.isArray(data.acks) ? data.acks.slice(0, MAX_ACK_IDS) : [];
      for (const entry of acks) {
        if (!entry || typeof entry !== "object") continue;
        const row = entry as Record<string, unknown>;
        if (typeof row.command_id !== "string" || row.command_id === "") continue;
        if (typeof row.claim_token !== "string" || row.claim_token === "") continue;
        this.transition(row.command_id, "DISPATCHED", row.claim_token);
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
   * #9: the enqueue/recovery push. Leases and sends EXACTLY the commands it is
   * given, so a new command can never re-push the ones already in flight.
   * Returns false when there is no usable socket, so the caller can wake the
   * device over FCM instead.
   */
  private pushCommands(commandIds: readonly string[]): boolean {
    if (commandIds.length === 0) return true;
    const sockets = this.freshSockets();
    if (sockets.length === 0) return false;

    const leased = this.leaseCommands(commandIds.length, commandIds);
    // Nothing claimable: every id was already claimed, had expired, or is gone.
    // That is not a failure; whatever is still PENDING is picked up by the poll.
    if (leased.length === 0) return true;

    return this.deliverToAny(sockets, leased);
  }

  /**
   * Deliver to the first socket that accepts the frame.
   *
   * A dead socket is not always detectable before the write: a connection the
   * client destroyed a moment ago still appears in `getWebSockets()` and its
   * `send` may even resolve. Trying the next candidate is the only evidence
   * available, and it is much cheaper than the alternative, which is losing the
   * push and waiting out a lease.
   *
   * Every candidate is tried before the leases are released, so a lost frame is
   * only given up on when there is nowhere left to send it.
   */
  private deliverToAny(sockets: readonly WebSocket[], leased: readonly CommandView[]): boolean {
    for (const ws of sockets) {
      if (this.deliver(ws, leased)) return true;
    }
    // Nowhere to put it. Hand the leases back immediately rather than waiting out
    // the whole window on a command nobody can be working on.
    this.releaseLeases(leased);
    return false;
  }

  /** One send attempt. Returns false only when the frame certainly did not leave. */
  private deliver(ws: WebSocket, leased: readonly CommandView[]): boolean {
    try {
      ws.send(JSON.stringify({ op: "commands", commands: leased }));
    } catch {
      try {
        ws.close(1011, "send_failed");
      } catch {
        // Already closed.
      }
      return false;
    }

    const socketId = readAttachment(ws).socketId ?? null;
    for (const command of leased) {
      this.armLeaseExpiry(command, socketId);
      if (socketId !== null) {
        this.armWakeTimer(command.command_id, command.claim_token, socketId);
      }
    }
    return true;
  }

  /**
   * `hello`/reconnect recovery.
   *
   * Leases only what is claimable, which now includes a command whose previous
   * lease has run out. That is the whole point of the lease: a command is
   * recoverable by whoever claims it first, and only one transport can win.
   */
  private pushPendingToSocket(ws: WebSocket): void {
    // The socket that just said hello goes first, then the others, so a
    // reconnect is served by the connection the device is actually reading.
    const ordered = [ws, ...this.freshSockets().filter((candidate) => candidate !== ws)];
    const commands = this.leaseCommands(MAX_OUTBOUND_COMMANDS);
    if (commands.length === 0) return;
    this.deliverToAny(ordered, commands);
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
    return this.freshSockets()[0] ?? null;
  }

  /**
   * Every socket worth writing to, best first.
   *
   * Sockets that are already CLOSING or CLOSED are skipped: a client that hung up
   * a moment ago can still be listed, and a push written to it is the lost frame
   * this whole path exists to avoid. A socket with no trustworthy liveness
   * evidence is kept, because `socketLastSeen` only returns null when the runtime
   * cannot tell us anything, and guessing "dead" there would drop pushes to a
   * healthy device.
   */
  private freshSockets(): WebSocket[] {
    const fresh: WebSocket[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const readyState = (ws as unknown as { readyState?: number }).readyState;
      if (readyState === 2 || readyState === 3) continue;

      const lastSeen = this.socketLastSeen(ws, readAttachment(ws));
      if (lastSeen === null) {
        fresh.push(ws); // unknown liveness -> never close on null
        continue;
      }
      if (Date.now() - lastSeen <= this.timings.staleSocketMs) {
        fresh.push(ws);
        continue;
      }
      try {
        ws.close(1001, "stale_connection");
      } catch {
        // Already closed.
      }
    }
    return fresh;
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
      // The lazy prune in the signed-request path is 1-in-20; this is the
      // backstop, so a quiet object does not accumulate expired nonces forever.
      this.ctx.storage.sql.exec(`DELETE FROM nonces WHERE exp < ?`, Date.now());

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

    if (task.kind === "lease_expiry") {
      const commandId = payload.command_id;
      const claimToken = payload.claim_token;
      if (typeof commandId === "string" && typeof claimToken === "string") {
        // Revert ONLY the lease this task granted. A command that was re-leased
        // carries a different token, and reverting it would hand a live lease to
        // a second transport: exactly the duplicate send the lease prevents.
        const reverted =
          this.ctx.storage.sql.exec(
            `UPDATE commands
                SET state = 'PENDING', claim_token = NULL, lease_until = NULL
              WHERE command_id = ? AND state = 'LEASED' AND claim_token = ?`,
            commandId,
            claimToken
          ).rowsWritten > 0;
        if (reverted) {
          this.cancelLeaseTimers(commandId);
          this.broadcastState(commandId, "PENDING");

          // Hand it to the device again, now, instead of hoping it notices.
          //
          // An expired lease means one of two things: the frame never reached the
          // phone (a write to a half-open socket succeeds and is lost), or the
          // send failed silently. Either way the device owes this command a
          // second try, and `pushCommands` re-leases it with a FRESH token so the
          // previous holder's late ack is refused by the token guard: the new
          // lease is the authoritative one.
          //
          // Without this the command waits for the handset's five-minute drain.
          // Measured before the fix: a lost push took 90 s to recover through a
          // reconnect, and a second one waited out the full drain.
          if (this.pushCommands([commandId])) {
            // Re-delivered, and `pushCommands` has already replaced this row with
            // a new `lease:` task. "rescheduled" is what keeps the alarm from
            // deleting the timer it just created.
            return "rescheduled";
          }

          // No socket to hand it to. Close the one this lease was pushed to, so a
          // wedged device reconnects, and wake it out of band. A command
          // collected over an HTTP poll has no owning socket, and one expired
          // lease must not tear down a device's other connections.
          const socketId = typeof payload.socket_id === "string" ? payload.socket_id : null;
          if (socketId !== null) {
            for (const ws of this.ctx.getWebSockets()) {
              if (readAttachment(ws).socketId !== socketId) continue;
              try {
                ws.close(1011, "lease_expiry");
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

    if (task.kind === "ack_wake") {
      // The lease is deliberately NOT released here. `ACK_TIMEOUT_MS` is the
      // dead-phone signal, not the claim window: a send that takes 20 s is
      // normal, and releasing the command mid-send is what duplicates an SMS.
      // Closing the socket makes a wedged or vanished device reconnect.
      const commandId = payload.command_id;
      const claimToken = payload.claim_token;
      const socketId = typeof payload.socket_id === "string" ? payload.socket_id : null;
      if (
        typeof commandId === "string" &&
        typeof claimToken === "string" &&
        socketId !== null
      ) {
        const stillLeased = this.ctx.storage.sql
          .exec(
            `SELECT 1 AS present FROM commands
              WHERE command_id = ? AND state = 'LEASED' AND claim_token = ?`,
            commandId,
            claimToken
          )
          .toArray();
        if (stillLeased.length > 0) {
          for (const ws of this.ctx.getWebSockets()) {
            if (readAttachment(ws).socketId !== socketId) continue;
            try {
              ws.close(1011, "ack_timeout");
            } catch {
              // Already closed.
            }
          }
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
      await this.raiseOfflineAlert(now);
      return "consumed";
    }

    // Unknown kind: nothing to do, and keeping it would retry forever.
    return "consumed";
  }

  /**
   * Persist an offline alert, then deliver it out-of-band if configured.
   *
   * `INSERT OR IGNORE` plus the partial unique index keeps one open alert per
   * (device, kind): a reconnect that goes silent again does not stack duplicates,
   * but acknowledging the first one frees the slot for a genuinely new outage.
   * The webhook fires only for a newly inserted row, so a deduped alert cannot
   * re-notify with a fresh `raised_at`.
   */
  private async raiseOfflineAlert(now: number): Promise<void> {
    const device = this.ctx.storage.sql
      .exec(`SELECT device_id FROM devices LIMIT 1`)
      .toArray()[0] as { device_id?: string } | undefined;
    const deviceId = device?.device_id;
    if (!deviceId) return;

    // Prefer D1's authenticated `last_seen`; fall back to this socket's evidence.
    let lastSeenAt: number | null = null;
    try {
      const row = await this.env.DB.prepare(`SELECT last_seen FROM devices WHERE device_id = ?`)
        .bind(deviceId)
        .first<{ last_seen: number }>();
      const value = Number(row?.last_seen ?? Number.NaN);
      if (Number.isFinite(value)) lastSeenAt = value;
    } catch (error) {
      console.error(`[offline_alert] could not read last_seen: ${String(error)}`);
    }
    if (lastSeenAt === null) {
      const ws = this.ctx.getWebSockets()[0];
      if (ws) lastSeenAt = this.socketLastSeen(ws, readAttachment(ws));
    }

    const detail =
      lastSeenAt === null
        ? "device silent; last_seen unknown"
        : `device silent for ${Math.max(0, now - lastSeenAt)} ms (last_seen ${new Date(
            lastSeenAt
          ).toISOString()})`;

    let inserted = false;
    try {
      const result = await this.env.DB.prepare(
        `INSERT OR IGNORE INTO alerts (id, device_id, kind, raised_at, acknowledged_at, detail)
         VALUES (?, ?, 'device_offline', ?, NULL, ?)`
      )
        .bind(crypto.randomUUID(), deviceId, now, detail)
        .run();
      inserted = Number(result.meta?.changes ?? 0) > 0;
    } catch (error) {
      // Losing the durable alert must not make the alarm retry forever.
      console.error(`[offline_alert] could not persist alert: ${String(error)}`);
      return;
    }

    if (!inserted) return;
    const webhook = this.env.ALERT_WEBHOOK_URL;
    if (!webhook) return;

    try {
      await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          device_id: deviceId,
          kind: "device_offline",
          raised_at: now,
          detail,
        }),
        signal: AbortSignal.timeout(3000),
      });
    } catch (error) {
      // Out-of-band delivery is best-effort; D1 already has the fact.
      console.error(`[offline_alert] webhook failed: ${String(error)}`);
    }
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

  private cancelLeaseTimers(commandId: string): void {
    const cursor = this.ctx.storage.sql.exec(
      `DELETE FROM scheduled_tasks WHERE id IN (?, ?)`,
      `lease:${commandId}`,
      `wake:${commandId}`
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

  const key = row.idempotency_key;
  if (key !== undefined && key !== null) {
    if (typeof key !== "string" || key === "" || key.length > MAX_IDEMPOTENCY_KEY_CHARS) {
      return null;
    }
  }

  // 0 means "no preference". A slot that is out of range is dropped rather than
  // refusing the send: a wrong slot hint must never stop an SMS, and the phone
  // falls back to the platform default exactly as it does today.
  const rawSlot = row.sim_slot;
  const simSlot =
    rawSlot === 1 || rawSlot === 2 ? rawSlot : 0;

  return {
    command_id: commandId,
    to_e164: to,
    body,
    priority,
    state: "PENDING",
    created_at: Date.now(),
    expires_at: expiresAt,
    idempotency_key: typeof key === "string" ? key : null,
    sim_slot: simSlot,
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
