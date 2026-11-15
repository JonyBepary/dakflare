/**
 * The assistant Durable Object — pass 3, stages A–C.
 *
 * The shell (schema ledger, pinned name, one `WebSockets` capability) is stage
 * A. Stage B adds the turn loop with an injectable adapter; stage C adds the
 * act tools, the call journal and the autonomy gate.
 *
 * The object is still ONE pinned instance (`assistant`), but a "session" is a
 * connection: the journal's turn cap is per connection, and the socket closes at
 * the earlier of the connection's 7-day life and the autonomy window's expiry.
 * A long-lived socket therefore cannot outlive the grant that lets it act — and
 * every act re-checks the grant at call time anyway.
 *
 * Conversation is a different axis: it is per operator
 * (`conversation:<actor label>`), shared by every socket and by `say()`, and
 * stored by the Sessions capability. Reconnecting no longer starts a blank
 * transcript, and the CLI and the panel read the same memory.
 *
 * `AGENT_RUNTIME=off` is enforced at the edge (`index.ts`) before this object is
 * touched; the stateless assistant keeps working either way.
 */

import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import { Scheduler } from "agents/schedules";
import { Sessions } from "agents/sessions";
import { State } from "agents/state";
import { Streams, type StreamJson, type StreamWriter } from "agents/streams";
import { WebSockets } from "agents/websockets";
import type { Env } from "../index";
import type { AdminActor } from "../audit";
import {
  ASSISTANT_OBJECT_NAME,
  STREAM_IDLE_TIMEOUT_MS,
  shortHash,
  streamIdFor,
  streamSseResponse,
  turnFrame,
} from "../lib/agent-runtime";
import { readSettingsOrEnv } from "../lib/ai/settings";
import { resolveAdapter } from "../lib/ai/registry";
import {
  appendTurnMessages,
  conversationIdFor,
  readHistoryNewestFirst,
  readTurnAnswer,
  recordTurnAnswer,
  toChatHistory,
} from "./conversation";
import { Journal, type JournalSql } from "./journal";
import type { AgentActor } from "./types";
import { runTurn, type RunFrame } from "./loop";
import { buildAgentTools } from "./tools";
import { chargeAgentTokens, describeAutonomy, readAutonomyStatus } from "./grants";

/** The code's schema version. Bump it and append a step to `MIGRATIONS`. */
/** How long a socket session lives before it must reconnect. */
export const AGENT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

/**
 * Forward-only steps. Index 0 is version 1. A step must be idempotent enough to
 * survive a retry after a deploy that died between the DDL and the version
 * update: `CREATE TABLE IF NOT EXISTS` is the pattern to keep.
 */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS schema_version (
     id         INTEGER PRIMARY KEY CHECK (id = 1),
     version    INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  // Version 2 — the turn journal and the conversation.
  // `agent_messages` is kept (the brief asks for it unreferenced) so a
  // rollback does not lose a running object's transcript. The runtime now
  // reads and writes `cf_agents_session_*` through the Sessions capability;
  // migration 0014_agent_drop_messages.sql (next pass) drops this table.
  `CREATE TABLE IF NOT EXISTS agent_turns (
     session    TEXT NOT NULL,
     turn       INTEGER NOT NULL,
     state      TEXT NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (session, turn)
   )`,
  `CREATE TABLE IF NOT EXISTS tool_calls (
     call_id     TEXT PRIMARY KEY NOT NULL,
     session     TEXT NOT NULL,
     turn        INTEGER NOT NULL,
     tool        TEXT NOT NULL,
     args_hash   TEXT NOT NULL,
     state       TEXT NOT NULL,
     result_json TEXT,
     created_at  INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session)`,
  `CREATE TABLE IF NOT EXISTS agent_messages (
     id         INTEGER PRIMARY KEY AUTOINCREMENT,
     session    TEXT NOT NULL,
     role       TEXT NOT NULL,
     content    TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_agent_messages_session ON agent_messages(session, id)`,
];

/**
 * One version per migration step.
 *
 * It used to be a hand-written 2 while the list held six steps, so a fresh
 * object applied `agent_turns` and stopped; the journal then failed with
 * "no such table: tool_calls" the first time an act ran. Deriving it makes that
 * drift impossible: add a step, the version moves with it.
 */
export const AGENT_SCHEMA_VERSION = MIGRATIONS.length;

interface AssistantState {
  schemaVersion: number;
  lastSeenAt: number | null;
}

interface AssistantConnectionState {
  actor: AdminActor;
  sessionExpiresAt: number;
}

interface StoredVersionRow extends Record<string, SqlStorageValue> {
  version: number;
}

/** The connection fields the runtime reads; `Connection` extends `WebSocket`. */
interface AssistantConnection extends WebSocket {
  id: string;
  state: unknown;
}

/**
 * The documented cadence of the `Agent` class's keep-alive heartbeat. A DO is
 * evicted after roughly 70–140 s idle; a turn takes 10–25 s, so one 30 s wake-up
 * during the model call is enough to keep the instance resident.
 */
export const TURN_HEARTBEAT_SECONDS = 30;

/** The slice of `Scheduler` the heartbeat uses; the real class satisfies it. */
export interface HeartbeatScheduler {
  every(
    intervalSeconds: number,
    callback: "keepalive",
    payload?: undefined,
    options?: { idempotent?: boolean }
  ): Promise<{ id: string }>;
  cancel(id: string): Promise<boolean>;
}

/**
 * Holds the Durable Object awake while any turn is in flight.
 *
 * Job key: ONE interval job for every turn. The installed Scheduler's `every()`
 * is idempotent by default for recurrent schedules (`ScheduleOptions.idempotent`
 * defaults to true for interval/cron) and deduplicates on type, callback,
 * owner, payload and interval. So the first turn arms `keepalive` at 30 s with
 * no payload, later turns call the same `every` and receive the same job, and
 * cancellation is decided by a counter: the last turn out cancels the one job.
 *
 * The counter is INSTANCE memory. Eviction takes it with the object, and a turn
 * that died with the object cannot resume: this makes eviction during a live
 * turn less likely, it does not make the turn durable.
 */
export class TurnHeartbeat {
  #turnsInFlight = 0;
  #jobId: string | null = null;
  /** Serialises arm/cancel so a turn starting as the last one ends cannot race. */
  #chain: Promise<void> = Promise.resolve();
  readonly #scheduler: HeartbeatScheduler;

  constructor(scheduler: HeartbeatScheduler) {
    this.#scheduler = scheduler;
  }

  /** `true` while the interval job is armed. */
  get armed(): boolean {
    return this.#jobId !== null;
  }

  /** How many turns currently hold the heartbeat. */
  get turnsInFlight(): number {
    return this.#turnsInFlight;
  }

  /** Run one turn, armed from start to end — including a throw. */
  async run<T>(turn: () => Promise<T>): Promise<T> {
    this.#turnsInFlight += 1;
    await this.#queue(async () => {
      if (this.#jobId !== null) return;
      // `idempotent` is the documented default for an interval; passing it
      // makes the one-job choice explicit rather than incidental.
      const schedule = await this.#scheduler.every(TURN_HEARTBEAT_SECONDS, "keepalive", undefined, {
        idempotent: true,
      });
      this.#jobId = schedule.id;
    });
    try {
      return await turn();
    } finally {
      this.#turnsInFlight = Math.max(0, this.#turnsInFlight - 1);
      const stillActive = this.#turnsInFlight;
      await this.#queue(async () => {
        if (stillActive > 0) return;
        const id = this.#jobId;
        this.#jobId = null;
        if (id !== null) await this.#scheduler.cancel(id);
      });
    }
  }

  /**
   * Heartbeat storage is best effort: a failure to arm must not fail the turn,
   * and a failure to cancel leaves one job that the next turn reuses.
   */
  #queue(task: () => Promise<void>): Promise<void> {
    const next = this.#chain.then(task, task).catch((error: unknown) => {
      console.warn(`[agent] keepalive failed: ${String(error).slice(0, 200)}`);
    });
    this.#chain = next;
    return next;
  }
}

export class AssistantAgent extends DurableObject<Env> {
  /** `true` when the stored schema is newer than this code (a rollback). */
  #schemaAhead = false;

  readonly state = new State<AssistantState>({
    initialState: { schemaVersion: AGENT_SCHEMA_VERSION, lastSeenAt: null },
  });

  readonly sockets = new WebSockets({
    handlers: {
      onConnect: (connection, context) => {
        if (this.#schemaAhead) {
          connection.close(1011, "agent_schema_ahead");
          return;
        }
        const request = context.request;
        const userId = request.headers.get("x-dakflare-actor");
        const role = request.headers.get("x-dakflare-actor-role");
        if (userId === null || userId === "" || role === null || role === "") {
          connection.close(1008, "agent_identity_missing");
          return;
        }
        const actor: AdminActor = {
          userId,
          label: userId,
          role: role as AdminActor["role"],
          canGrantOwner: role === "owner",
        };
        connection.setState({
          actor,
          sessionExpiresAt: Date.now() + AGENT_SESSION_TTL_MS,
        } satisfies AssistantConnectionState);

        connection.send(
          JSON.stringify({
            type: "ready",
            name: this.ctx.id.name ?? ASSISTANT_OBJECT_NAME,
            session_expires_at: Date.now() + AGENT_SESSION_TTL_MS,
            conversation: conversationIdFor(actor.label),
          })
        );
        this.state.set({ schemaVersion: AGENT_SCHEMA_VERSION, lastSeenAt: Date.now() });
      },
      onMessage: (connection, message) => {
        void this.#handleFrame(connection, message);
        return true;
      },
      onClose: (connection, code, reason) => {
        // The platform's close code is the only server-side reason a "link
        // closed" report can be matched against later. Record it, with the
        // actor, before the connection state is forgotten.
        const state = connection.state as AssistantConnectionState | null;
        console.log(
          `[agent] socket_close ${JSON.stringify({
            actor: state?.actor.label ?? null,
            code,
            reason,
          })}`
        );
      },
    },
  });

  /**
   * Durable conversation history and durable turn output.
   *
   * Both capabilities create their own `cf_agents_*` tables at Lifecycle
   * startup, so they add no step to this object's migration ledger. The
   * conversation id is per operator (`conversation:<label>`), not per socket:
   * a reconnect, the CLI and the panel share one memory.
   */
  readonly sessions = new Sessions();
  readonly streams = new Streams();

  /**
   * The keep-alive schedule. The callback runs inside the Lifecycle host
   * boundary and touches nothing: an interval schedule re-arms itself, and the
   * only effect wanted is that the object's alarm loop keeps running while a
   * turn is in flight.
   */
  readonly scheduler = new Scheduler({
    callbacks: {
      keepalive: () => {
        // Intentionally empty: the recurring schedule is the wake-up.
      },
    },
  });

  /** Arms `scheduler` while a turn runs; see `TurnHeartbeat` for the key choice. */
  readonly turns = new TurnHeartbeat(this.scheduler);

  readonly lifecycle = Lifecycle.install(this)
    .use(this.state)
    .use(this.sockets)
    .use(this.sessions)
    .use(this.streams)
    .use(this.scheduler);

  readonly #journal = new Journal({
    sql: this.ctx.storage.sql as unknown as JournalSql,
    transactionSync: (fn) => this.ctx.storage.transactionSync(fn),
  });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Startup work runs behind the input gate: a request that arrives during
    // the migration waits for it rather than seeing a table that does not exist.
    ctx.blockConcurrencyWhile(async () => {
      this.#migrate();
    });
  }

  /** Lifecycle host hook: the SQL ledger is migrated, publish it to `State`. */
  onStart(): void {
    if (this.#schemaAhead) return;
    const current = this.state.get();
    this.state.set({
      schemaVersion: AGENT_SCHEMA_VERSION,
      lastSeenAt: current?.lastSeenAt ?? null,
    });
  }

  /**
   * HTTP surface: the status probe, and the kill switch's "stop the object's
   * sessions" arm. `/agents/*` itself only carries upgrades.
   */
  async onRequest(request: Request): Promise<Response> {
    if (this.#schemaAhead) {
      return Response.json(
        { error: "agent_schema_ahead", code: AGENT_SCHEMA_VERSION },
        { status: 503 }
      );
    }
    const path = new URL(request.url).pathname;
    if (path.endsWith("/__runtime/status")) {
      const stored = this.#storedVersion();
      return Response.json({
        name: this.ctx.id.name ?? ASSISTANT_OBJECT_NAME,
        schemaVersion: stored ?? AGENT_SCHEMA_VERSION,
        codeVersion: AGENT_SCHEMA_VERSION,
        connections: [...this.sockets.getConnections()].length,
      });
    }
    if (path.endsWith("/__runtime/kill")) {
      let closed = 0;
      for (const connection of this.sockets.getConnections()) {
        try {
          connection.close(1001, "agent_revoked");
          closed += 1;
        } catch {
          // A connection already gone is already stopped.
        }
      }
      return Response.json({ ok: true, closed });
    }
    // A reloaded page cannot hold a socket open across the reload. The same
    // durable stream is served as SSE, resuming from `?from=` (or the
    // EventSource `Last-Event-ID`). The stream id is namespaced by the turn
    // key; ownership is checked against the actor the edge authenticated, so
    // one operator cannot read another's stream.
    const streamMatch = /\/streams\/([^/]+)$/.exec(path);
    if (request.method === "GET" && streamMatch !== null) {
      const streamId = decodeURIComponent(streamMatch[1]);
      const actorLabel = request.headers.get("x-dakflare-actor");
      if (actorLabel === null || actorLabel === "") {
        return Response.json({ error: "agent_identity_missing" }, { status: 401 });
      }
      const status = await this.streams.status(streamId);
      if (status === null || status.tag !== conversationIdFor(actorLabel)) {
        return Response.json({ error: "stream_not_found" }, { status: 404 });
      }
      return streamSseResponse(this.streams, streamId, request);
    }
    return Response.json({ error: "agent_upgrade_required" }, { status: 426 });
  }

  /**
   * The physical alarm. Lifecycle owns the job queue behind it, so the host's
   * override must delegate rather than replace it: `installHandlers` skips a
   * name the host already defines, and a host `alarm()` that did not call
   * `lifecycle.alarm()` would store Scheduler jobs — the heartbeat included —
   * and never dispatch them.
   */
  override async alarm(): Promise<void> {
    await this.lifecycle.alarm();
  }

  /**
   * Lifecycle's host hook, run after due jobs. Close every socket whose session
   * or autonomy window has passed.
   */
  async onAlarm(): Promise<void> {
    const autonomy = await readAutonomyStatus(this.env);
    const grantExpiresAt = autonomy.enabled ? autonomy.expires_at ?? Infinity : autonomy.expires_at ?? Date.now();
    const now = Date.now();
    for (const connection of this.sockets.getConnections()) {
      const state = connection.state as AssistantConnectionState | null;
      const sessionExpiresAt = state?.sessionExpiresAt ?? now;
      const earliest = Math.min(sessionExpiresAt, grantExpiresAt);
      if (now >= earliest) {
        try {
          connection.close(
            4001,
            now >= grantExpiresAt ? "agent_grant_expired" : "agent_session_expired"
          );
        } catch {
          // Already closed.
        }
      }
    }
  }

  /* ─────────────────────────────── frames ─────────────────────────────── */

  async #handleFrame(connection: AssistantConnection, message: unknown): Promise<void> {
    if (this.#schemaAhead) {
      connection.close(1011, "agent_schema_ahead");
      return;
    }
    const text =
      typeof message === "string"
        ? message
        : new TextDecoder().decode(
            message instanceof ArrayBuffer
              ? new Uint8Array(message)
              : new Uint8Array(
                  (message as ArrayBufferView).buffer,
                  (message as ArrayBufferView).byteOffset,
                  (message as ArrayBufferView).byteLength
                )
          );

    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        connection.send(JSON.stringify({ type: "unsupported" }));
        return;
      }
      payload = parsed as Record<string, unknown>;
    } catch {
      connection.send(JSON.stringify({ type: "error", error: "bad_json" }));
      return;
    }

    if (payload.type !== "ask" && payload.type !== "resume") {
      connection.send(JSON.stringify({ type: "unsupported" }));
      return;
    }

    const state = connection.state as AssistantConnectionState | null;
    if (state === null || state.actor === undefined) {
      connection.close(1008, "agent_identity_missing");
      return;
    }

    if (payload.type === "resume") {
      const streamId = typeof payload.streamId === "string" ? payload.streamId : "";
      const rawFrom = payload.from;
      const from =
        typeof rawFrom === "number" && Number.isInteger(rawFrom) && rawFrom >= 0 ? rawFrom : 0;
      if (streamId === "") {
        connection.send(JSON.stringify({ type: "error", error: "bad_request", message: "streamId is required" }));
        return;
      }
      const status = await this.streams.status(streamId);
      if (status === null || status.tag !== conversationIdFor(state.actor.label)) {
        connection.send(JSON.stringify({ type: "error", error: "stream_not_found" }));
        return;
      }
      // Tailing a live stream is allowed; it ends when the stream settles or
      // the client goes away. Run it beside the frame handler so another ask
      // on the same socket is not blocked behind a long replay.
      void this.#replayStream(connection, streamId, from);
      return;
    }

    const now = Date.now();
    const autonomy = await readAutonomyStatus(this.env);
    const grantExpiresAt = autonomy.expires_at ?? Infinity;
    const earliest = Math.min(state.sessionExpiresAt, grantExpiresAt);
    if (now >= earliest) {
      connection.close(
        4001,
        now >= grantExpiresAt ? "agent_grant_expired" : "agent_session_expired"
      );
      return;
    }

    const messageText = payload.message;
    if (typeof messageText !== "string" || messageText.trim() === "") {
      connection.send(
        JSON.stringify({ type: "error", error: "bad_request", message: "message is required" })
      );
      return;
    }
    const idempotencyKey =
      typeof payload.idempotencyKey === "string" && payload.idempotencyKey !== ""
        ? payload.idempotencyKey
        : `${connection.id}:${shortHash(messageText)}`;

    const sessionId = connection.id;
    await this.#ask(connection, state, sessionId, messageText.trim(), idempotencyKey);

    await this.#armExpiryAlarm();
  }

  /**
   * Re-arm the socket-expiry alarm at the earliest session/autonomy deadline.
   *
   * Lifecycle owns the physical alarm for its job queue. While the heartbeat is
   * armed the interval job must own that alarm, so an expiry write here would
   * delay the 30 s wake-up; the last turn to finish calls this again with the
   * heartbeat down. The per-frame check remains the guarantee either way.
   */
  async #armExpiryAlarm(): Promise<void> {
    if (this.turns.armed) return;
    const connections = [...this.sockets.getConnections()];
    if (connections.length === 0) return;
    let earliest = Infinity;
    for (const connection of connections) {
      const state = connection.state as AssistantConnectionState | null;
      earliest = Math.min(earliest, state?.sessionExpiresAt ?? Infinity);
    }
    const autonomy = await readAutonomyStatus(this.env);
    earliest = Math.min(earliest, autonomy.expires_at ?? Infinity);
    if (!Number.isFinite(earliest)) return;
    try {
      await this.ctx.storage.setAlarm(Math.max(Date.now() + 1_000, earliest));
    } catch {
      // The alarm is a convenience; the per-frame check is the guarantee.
    }
  }

  /** Replay a durable stream from `from`, then tail it while it is live. */
  async #replayStream(
    connection: AssistantConnection,
    streamId: string,
    from: number
  ): Promise<void> {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stop = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    // The same bounded idle wait as SSE: a resumed socket cannot sit on an
    // abandoned stream forever.
    const arm = (): void => {
      stop();
      timer = setTimeout(() => {
        try {
          connection.send(JSON.stringify({ type: "timeout" }));
        } catch {
          // closed; the client can resume again
        }
        stop();
        abort.abort();
      }, STREAM_IDLE_TIMEOUT_MS);
    };
    arm();
    try {
      for await (const chunk of this.streams.read(streamId, { from, signal: abort.signal })) {
        try {
          connection.send(JSON.stringify(chunk.chunk));
        } catch {
          // The socket went away; stop tailing. The stream itself is not
          // settled here — only the turn that owns it may close it.
          return;
        }
        arm();
      }
    } catch {
      // A stream deleted during replay, or the idle timeout, ends the tail;
      // the client can resume again.
    } finally {
      stop();
    }
  }

  async #ask(
    connection: AssistantConnection,
    state: AssistantConnectionState,
    sessionId: string,
    message: string,
    idempotencyKey: string
  ): Promise<void> {
    const started = Date.now();
    let frames = 0;
    // A turn retried with the same key answers from storage: the model is not
    // called twice and no message is appended twice.
    const conversationId = conversationIdFor(state.actor.label);
    const streamId = streamIdFor(idempotencyKey);
    const session = this.sessions.session(conversationId);

    // One line per finished turn, through the path the runtime already logs
    // on: the next "the link closed" report has a server-side duration to
    // compare against the socket's close code.
    const logTurn = (outcome: string): void => {
      console.log(
        `[agent] turn ${JSON.stringify({
          turn: idempotencyKey,
          actor: state.actor.label,
          took_ms: Date.now() - started,
          frames,
          outcome,
        })}`
      );
    };

    const replayedAnswer = await readTurnAnswer(session, idempotencyKey);
    if (replayedAnswer !== null) {
      // Announce first even on a replay: the stream id is deterministic, so
      // the client can still resume the turn that produced this answer.
      try {
        connection.send(JSON.stringify(turnFrame(idempotencyKey, conversationId)));
        connection.send(JSON.stringify({ type: "answer", text: replayedAnswer }));
      } catch {
        // The replayed answer is durable; a closed socket can resume.
      }
      logTurn("replayed");
      return;
    }

    const { messages: newestFirst } = await readHistoryNewestFirst(session);
    const history = toChatHistory(newestFirst);
    const before = history.length;

    // Every turn owns one durable stream keyed by its server-held idempotency
    // key. A frame is appended before it is sent, so a dropped socket loses
    // presentation, not the reply the journal records.
    let writer: StreamWriter | null = null;
    try {
      writer = await this.streams.open(streamId, {
        tag: conversationId,
        metadata: { turn: idempotencyKey, actor: state.actor.label },
      });
    } catch {
      // A settled stream from a completed turn has nothing to append to.
      // The answer marker above is the replay path; resume still reads chunks.
    }

    const errorRef: { current: { reason: string; message: string } | null } = { current: null };
    const sendRaw = (frame: unknown): void => {
      frames += 1;
      try {
        connection.send(JSON.stringify(frame));
      } catch {
        // The socket closed mid-turn; the journal and stream still record it.
      }
      if (writer !== null) {
        try {
          writer.append(frame as StreamJson);
        } catch {
          // A stream settled underneath the writer: presentation only.
        }
      }
    };
    const send = (frame: RunFrame): void => {
      if (frame.type === "error") {
        errorRef.current = { reason: frame.reason, message: frame.message };
      }
      sendRaw(frame);
    };

    // The turn's first frame names the durable stream before the model is
    // called, so a socket that closes during the wait can resume it instead of
    // printing "the link closed before the answer finished".
    sendRaw(turnFrame(idempotencyKey, conversationId));

    const settings = await readSettingsOrEnv(this.env);
    const resolved = resolveAdapter(this.env, settings);
    if (!resolved.ok) {
      sendRaw({
        type: "error",
        error: "ai_unavailable",
        reason: resolved.reason,
        message: resolved.message,
      });
      if (writer !== null) {
        try {
          writer.error(resolved.reason);
        } catch {
          // already settled
        }
      }
      logTurn(`error:${resolved.reason}`);
      return;
    }

    const tools = buildAgentTools();
    // Armed for the model call and everything after it, and disarmed by
    // `run` on success, refusal and throw alike.
    await this.turns.run(async () => {
      const result = await runTurn(
        this.env,
        state.actor,
        sessionId,
        message,
        tools,
        {
          model: resolved.adapter,
          journal: this.#journal,
          budget: { chargeTokens: (tokens) => chargeAgentTokens(this.env, tokens) },
          autonomyNote: describeAutonomy(await readAutonomyStatus(this.env)),
          idempotencyKey,
          history,
          onEvent: send,
        }
      );

      if (writer !== null) {
        try {
          if (errorRef.current !== null) writer.error(errorRef.current.message);
          else writer.close();
        } catch {
          // Closing a settled stream is safe; a race here has no side effect.
        }
      }

      try {
        await appendTurnMessages(session, idempotencyKey, history.slice(before));
        if (result.stopped === "answer" && result.answer !== "") {
          await recordTurnAnswer(session, idempotencyKey, result.answer);
        }
      } catch {
        // A lost transcript row costs context, not the journal.
      }

      if (result.stopped === "turn_cap") {
        try {
          connection.send(JSON.stringify({ type: "turn_cap", turns: result.turns }));
        } catch {
          // closed
        }
      }

      logTurn(errorRef.current !== null ? `error:${errorRef.current.reason}` : result.stopped);
    });
  }


  /**
   * One non-streaming turn, for an HTTP caller.
   *
   * The console uses the WebSocket; this exists so a machine with an admin token
   * (the CLI, a test harness) can exercise the same loop, tools, grants and
   * journal without a browser session. Frames are collected rather than sent.
   */
  async say(
    actor: AgentActor,
    message: string
  ): Promise<
    | { ok: true; answer: string; calls: unknown[]; tokens: unknown; took_ms: number }
    | { ok: false; reason: string; message: string }
  > {
    await this.lifecycle.start();
    if (this.#schemaAhead) {
      return { ok: false, reason: "agent_schema_ahead", message: "agent storage is newer than this code" };
    }
    const trimmed = message.trim();
    if (trimmed === "") return { ok: false, reason: "bad_request", message: "message is empty" };

    // The machine path shares `conversation:<label>` with the socket path: a
    // CLI turn and a panel turn are one memory, not one memory per transport.
    const conversationId = conversationIdFor(actor.label);
    const session = this.sessions.session(conversationId);
    const idempotencyKey = "http:" + crypto.randomUUID();
    // The journal's turn cap is per call on the machine path; only the
    // transcript is shared with the socket path.
    const journalSessionId = "http:" + crypto.randomUUID();

    const replayedAnswer = await readTurnAnswer(session, idempotencyKey);
    if (replayedAnswer !== null) {
      return { ok: true, answer: replayedAnswer, calls: [], tokens: null, took_ms: 0 };
    }

    const { messages: newestFirst } = await readHistoryNewestFirst(session);
    const history = toChatHistory(newestFirst);
    const before = history.length;

    const streamId = streamIdFor(idempotencyKey);
    let writer: StreamWriter | null = null;
    try {
      writer = await this.streams.open(streamId, {
        tag: conversationId,
        metadata: { turn: idempotencyKey, actor: actor.label },
      });
    } catch {
      // A settled stream from a completed turn; the answer marker is the replay.
    }

    const started = Date.now();
    const calls: unknown[] = [];
    let answer = "";
    let frames = 0;
    const logTurn = (outcome: string): void => {
      console.log(
        `[agent] turn ${JSON.stringify({
          turn: idempotencyKey,
          actor: actor.label,
          took_ms: Date.now() - started,
          frames,
          outcome,
        })}`
      );
    };
    // The HTTP turn's stream announces itself like a socket turn does, so an
    // SSE consumer of a machine turn can resume it from seq 0.
    if (writer !== null) {
      try {
        writer.append(turnFrame(idempotencyKey, conversationId) as unknown as StreamJson);
        frames += 1;
      } catch {
        // A settled stream is presentation only.
      }
    }
    // A holder, not a bare `let`: TypeScript's flow analysis does not see an
    // assignment made inside a callback, and narrows a reassigned `let` to null.
    const failureRef: { current: { reason: string; message: string } | null } = { current: null };

    const settings = await readSettingsOrEnv(this.env);
    const resolved = resolveAdapter(this.env, settings);
    if (!resolved.ok) {
      if (writer !== null) {
        try {
          writer.error(resolved.reason);
        } catch {
          // already settled
        }
      }
      logTurn(`error:${resolved.reason}`);
      return { ok: false, reason: resolved.reason, message: resolved.message };
    }

    // The machine path holds the object awake the same way the socket path
    // does: one counter, one interval job, disarmed even when the turn throws.
    return this.turns.run(async () => {
      const result = await runTurn(
        this.env,
        actor,
        journalSessionId,
        trimmed,
        buildAgentTools(),
        {
          model: resolved.adapter,
          journal: this.#journal,
          budget: { chargeTokens: (tokens) => chargeAgentTokens(this.env, tokens) },
          autonomyNote: describeAutonomy(await readAutonomyStatus(this.env)),
          idempotencyKey,
          history,
          onEvent: (frame) => {
            frames += 1;
            if (writer !== null) {
              try {
                writer.append(frame as unknown as StreamJson);
              } catch {
                // A settled stream is presentation only; the journal is intact.
              }
            }
            if (frame.type === "answer") answer = frame.text;
            else if (frame.type === "tool") calls.push(frame);
            else if (frame.type === "error") {
              failureRef.current = { reason: frame.reason, message: frame.message };
            }
          },
        }
      );

      if (writer !== null) {
        try {
          if (failureRef.current !== null) writer.error(failureRef.current.message);
          else writer.close();
        } catch {
          // closing a settled stream is safe
        }
      }

      try {
        await appendTurnMessages(session, idempotencyKey, history.slice(before));
        if (answer !== "") {
          await recordTurnAnswer(session, idempotencyKey, answer);
        }
      } catch {
        // a lost transcript costs context, not the turn
      }

      if (failureRef.current !== null) {
        // A provider or parse failure is a refusal with a reason, never an empty
        // "answer" the operator has to interpret.
        logTurn(`error:${failureRef.current.reason}`);
        return {
          ok: false as const,
          reason: failureRef.current.reason,
          message: failureRef.current.message,
        };
      }
      if (answer === "") answer = result.answer ?? "";
      logTurn(result.stopped);
      return {
        ok: true as const,
        answer,
        calls,
        tokens: null,
        took_ms: Date.now() - started,
      };
    });
  }

  /* ─────────────────────────── schema ledger ─────────────────────────── */

  #storedVersion(): number | null {
    const rows = this.ctx.storage.sql
      .exec<StoredVersionRow>(`SELECT version FROM schema_version WHERE id = 1`)
      .toArray();
    return rows.length === 0 ? null : Number(rows[0].version);
  }

  #migrate(): void {
    const now = Date.now();

    // The ledger table itself is step 1, so create it before reading it.
    this.ctx.storage.sql.exec(MIGRATIONS[0]);

    const stored = this.#storedVersion();

    if (stored !== null && stored > AGENT_SCHEMA_VERSION) {
      // Rollback: old code reading new storage. Refuse rather than interpret.
      this.#schemaAhead = true;
      console.error(
        `[agent] stored schema ${stored} is newer than code ${AGENT_SCHEMA_VERSION}; ` +
          `refusing to serve. Roll forward or restore a backup.`
      );
      return;
    }

    if (stored === null) {
      // Fresh storage: the ledger is step 1, so run the steps after it.
      for (let version = 2; version <= AGENT_SCHEMA_VERSION; version++) {
        const step = MIGRATIONS[version - 1];
        if (step !== undefined) this.ctx.storage.sql.exec(step);
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO schema_version (id, version, updated_at) VALUES (1, ?, ?)`,
        AGENT_SCHEMA_VERSION,
        now
      );
      return;
    }

    if (stored < AGENT_SCHEMA_VERSION) {
      // Forward-only: run each step after the stored version, in order.
      for (let version = stored + 1; version <= AGENT_SCHEMA_VERSION; version++) {
        const step = MIGRATIONS[version - 1];
        if (step !== undefined) this.ctx.storage.sql.exec(step);
      }
      this.ctx.storage.sql.exec(
        `UPDATE schema_version SET version = ?, updated_at = ? WHERE id = 1`,
        AGENT_SCHEMA_VERSION,
        now
      );
    }
  }
}


