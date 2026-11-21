/**
 * The assistant Durable Object — pass 3, stages A–C.
 *
 * The actor-facing runtime is one `Agent<Env, AssistantState>`: the SDK owns
 * the Lifecycle/State/WebSockets shell, `keepAlive` while a model call is in
 * flight, and the optional `runFiber`/`queue`/`@callable` surface. This file
 * keeps the bespoke pieces that have no SDK equivalent: the versioned ledger,
 * the grant gate, the fail-closed journal, and the turn frames.
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

import {
  Agent,
  type Connection,
  type ConnectionContext,
  type FiberContext,
  type FiberRecoveryContext,
  type WSMessage,
} from "agents";
import { Sessions, type SessionMessage } from "agents/sessions";
import { Streams, type StreamJson, type StreamWriter } from "agents/streams";
import type { Env } from "../index";
import type { AdminActor } from "../audit";
import {
  ASSISTANT_OBJECT_NAME,
  IDEMPOTENCY_KEY_MESSAGE,
  STREAM_IDLE_TIMEOUT_MS,
  readIdempotencyKey,
  shortHash,
  streamIdFor,
  streamSseResponse,
  turnFrame,
} from "../lib/agent-runtime";
import { readSettingsOrEnv } from "../lib/ai/settings";
import { resolveAdapter } from "../lib/ai/registry";
import {
  appendTurnMessages,
  clearConversationMessages,
  conversationIdFor,
  messageFingerprint,
  readConversationMessages,
  readHistoryNewestFirst,
  recordTurnAnswer,
  runClaimedTurn,
  toChatHistory,
  type ConversationReadMessage,
  type TurnClaimStore,
} from "./conversation";
import {
  actorHashFor,
  d1AttachmentStore,
  MAX_ATTACHMENTS_PER_TURN,
  messageWithAttachments,
  r2BlobStore,
  resolveAttachments,
  type PromptFile,
} from "./attachments";
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
  // Version 7 — one in-flight claim per turn key. The row is the mutual
  // exclusion: a second request with the same key cannot enter the model path
  // while the first is running. `expires_at` is the backstop for a turn whose
  // process died without releasing it.
  `CREATE TABLE IF NOT EXISTS agent_turn_claims (
     turn         TEXT PRIMARY KEY NOT NULL,
     message_hash TEXT NOT NULL,
     claimed_at   INTEGER NOT NULL,
     expires_at   INTEGER NOT NULL
   )`,
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

/**
 * `attachmentIds` from an `ask` frame: strings only, no dedupe here.
 *
 * The cap is enforced where the ids are resolved, so an over-limit frame is a
 * named refusal rather than a silently shortened list.
 */
function readAttachmentIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry !== "");
}

/**
 * The cadence of the SDK's `keepAlive()` heartbeat. A DO is evicted after
 * roughly 70–140 s idle; a turn takes 10–25 s, so one 30 s wake-up during the
 * model call is enough to keep the instance resident.
 */
export const TURN_HEARTBEAT_SECONDS = 30;

/**
 * The result of one `say()` turn. `replayed` is on both the fresh and replayed
 * success shapes so a caller never has to infer it from `took_ms`.
 */
export type SayResult =
  | {
      ok: true;
      answer: string;
      calls: unknown[];
      tokens: unknown;
      took_ms: number;
      replayed: boolean;
    }
  | { ok: false; reason: string; message: string };

/**
 * The acting agent, on the SDK's `Agent` base class.
 *
 * `Agent` owns the same Lifecycle + State + WebSockets wiring we hand-rolled,
 * and adds `keepAlive`/`keepAliveWhile`, `runFiber`, `queue` and `@callable`.
 * The hooks below replace the manual capability handlers:
 *
 *   onStart    the schema ledger, then publish it to State
 *   onRequest  status, kill switch and the SSE stream read
 *   onConnect  the bespoke `ready` frame after identity is proved
 *   onMessage  the `ask` / `resume` frames
 *   onClose    one structured close log line
 *   onAlarm    close sockets past their session or grant deadline
 *
 * Two schema owners share this object and do not overlap:
 *
 *   `Agent._ensureSchema()` (constructor, synchronous) owns every `cf_agents_*`
 *   table and its KV schema gate. The SDK may add columns or bump its own
 *   version; we never read or write that gate.
 *
 *   Our `MIGRATIONS` + `schema_version` row own `agent_turns`, `tool_calls`,
 *   `agent_messages` and `schema_version`. We refuse to serve when the stored
 *   row is NEWER than `AGENT_SCHEMA_VERSION` (a rollback): that refusal is
 *   authoritative for our tables, independently of the SDK's gate. The two
 *   gates may legitimately disagree during a rollback, so `#schemaAhead` is
 *   checked on every path rather than inferred from the SDK.
 */
export class AssistantAgent extends Agent<Env, AssistantState> {
  /**
   * Our client speaks a bespoke JSON protocol, so the SDK must not put
   * `cf_agent_identity`, `cf_agent_state` or `cf_agent_mcp_servers` frames on
   * the wire. `shouldSendProtocolMessages()` below is the per-connection
   * switch that suppresses all three; `sendIdentityOnConnect` is also off so a
   * future subclass cannot accidentally turn identity back on. `keepAlive`
   * uses the documented 30 s cadence our heartbeat check asserts.
   */
  static override options = {
    sendIdentityOnConnect: false,
    keepAliveIntervalMs: TURN_HEARTBEAT_SECONDS * 1_000,
  };

  /** `true` when our stored schema is newer than this code (a rollback). */
  #schemaAhead = false;

  override initialState: AssistantState = {
    schemaVersion: AGENT_SCHEMA_VERSION,
    lastSeenAt: null,
  };

  /**
   * Durable conversation history and durable turn output.
   *
   * Both capabilities create their own `cf_agents_*` tables at Lifecycle
   * startup, so they add no step to our migration ledger. The conversation id
   * is per operator (`conversation:<label>`), not per socket: a reconnect, the
   * CLI and the panel share one memory.
   */
  readonly sessions = new Sessions();
  readonly streams = new Streams();

  readonly #journal = new Journal({
    sql: this.ctx.storage.sql as unknown as JournalSql,
    transactionSync: (fn) => this.ctx.storage.transactionSync(fn),
  });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // `super()` has already run the SDK's `_ensureSchema()` and installed its
    // Lifecycle capabilities. Ours are added before Lifecycle starts, so the
    // host-level `onStart` below is still the first thing to run.
    this.lifecycle.use(this.sessions).use(this.streams);
  }

  /**
   * Our client never expects SDK protocol frames. Returning false here makes
   * the base class mark the connection no-protocol before its own `onConnect`
   * wrapper, so identity, state sync and MCP lists are suppressed both on
   * connect and in later broadcasts (including the MCP broadcast in onStart).
   */
  override shouldSendProtocolMessages(
    _connection: Connection,
    _context: ConnectionContext
  ): boolean {
    return false;
  }

  /**
   * Lifecycle host hook. The SDK's own schema is already ensured in `super()`;
   * this migrates OUR ledger before `onRequest`/`onConnect` can be reached
   * (Lifecycle awaits onStart at its first entry point), then publishes the
   * ledger version to State.
   */
  override onStart(): void {
    this.#migrate();
    if (this.#schemaAhead) return;
    this.setState({
      schemaVersion: AGENT_SCHEMA_VERSION,
      lastSeenAt: this.state.lastSeenAt ?? null,
    });
  }

  /* ───────────────────────────── WebSocket hooks ──────────────────────── */

  override async onConnect(connection: Connection, context: ConnectionContext): Promise<void> {
    if (this.#schemaAhead) {
      connection.close(1011, "agent_schema_ahead");
      return;
    }
    const request = context.request;
    const actorLabel = request.headers.get("x-dakflare-actor");
    const actorRole = request.headers.get("x-dakflare-actor-role");
    if (actorLabel === null || actorLabel === "" || actorRole === null || actorRole === "") {
      connection.close(1008, "agent_identity_missing");
      return;
    }
    const headerUserId = request.headers.get("x-dakflare-user-id");
    const actor: AdminActor = {
      userId: headerUserId && headerUserId !== "" ? headerUserId : actorLabel,
      label: actorLabel,
      role: actorRole as AdminActor["role"],
      canGrantOwner: actorRole === "owner",
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
    this.setState({ schemaVersion: AGENT_SCHEMA_VERSION, lastSeenAt: Date.now() });
  }

  override onMessage(connection: Connection, message: WSMessage): void {
    void this.#handleFrame(connection, message);
  }

  override onClose(connection: Connection, code: number, reason: string): void {
    // The platform's close code is the only server-side reason a "link closed"
    // report can be matched against later. Record it, with the actor, before
    // the connection state is forgotten.
    const state = connection.state as AssistantConnectionState | null;
    console.log(
      `[agent] socket_close ${JSON.stringify({
        actor: state?.actor.label ?? null,
        code,
        reason,
      })}`
    );
  }

  /**
   * HTTP surface: the status probe, and the kill switch's "stop the object's
   * sessions" arm. `/agents/*` itself only carries upgrades.
   */
  override async onRequest(request: Request): Promise<Response> {
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
        connections: [...this.getConnections()].length,
      });
    }
    if (path.endsWith("/__runtime/kill")) {
      let closed = 0;
      for (const connection of this.getConnections()) {
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
   * Agent host hook, run after Lifecycle's due jobs and before its
   * housekeeping. Close every socket whose session or autonomy window has
   * passed. `Agent.alarm()` owns the physical alarm now (it also handles
   * pending destroy), so this subclass must not override `alarm()`.
   */
  override async onAlarm(): Promise<void> {
    const now = Date.now();
    for (const connection of this.getConnections()) {
      const state = connection.state as AssistantConnectionState | null;
      const sessionExpiresAt = state?.sessionExpiresAt ?? now;
      if (now >= sessionExpiresAt) {
        try {
          connection.close(4001, "agent_session_expired");
        } catch {
          // Already closed.
        }
      }
    }
  }

  /* ─────────────────────────────── frames ─────────────────────────────── */

  async #handleFrame(connection: Connection, message: WSMessage | unknown): Promise<void> {
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
    if (now >= state.sessionExpiresAt) {
      connection.close(4001, "agent_session_expired");
      return;
    }

    const messageText = payload.message;
    if (typeof messageText !== "string" || messageText.trim() === "") {
      connection.send(
        JSON.stringify({ type: "error", error: "bad_request", message: "message is required" })
      );
      return;
    }
    const keyReading = readIdempotencyKey(payload.idempotencyKey);
    if (!keyReading.ok) {
      // The same rule the HTTP `say` route enforces: 8–64 URL-safe characters.
      // The socket speaks its own frame shape, not an HTTP status.
      connection.send(
        JSON.stringify({
          type: "error",
          error: "bad_request",
          message: IDEMPOTENCY_KEY_MESSAGE,
        })
      );
      return;
    }
    const idempotencyKey =
      keyReading.key ?? `${connection.id}:${shortHash(messageText)}`;
    const attachmentIds = readAttachmentIds(payload.attachmentIds);

    const sessionId = connection.id;
    await this.#ask(connection, state, sessionId, messageText.trim(), idempotencyKey, attachmentIds);

    await this.#armExpiryAlarm();
  }

  /* ─────────────────────────── turn execution ────────────────────────── */

  /**
   * Run one model turn as a durable fiber, with the heartbeat held.
   *
   * `runFiber` records a `cf_agents_runs` row before the first model call and
   * deletes it when the turn settles. A turn interrupted by eviction therefore
   * leaves a marker that `onFiberRecovered` below sees; the snapshot is the
   * last frame's phase, for the log and for the operator. `keepAliveWhile` is
   * what keeps the object resident; the fiber's own keepAlive ref is a second
   * holder of the same heartbeat, not a second heartbeat.
   *
   * The fiber is NOT the thing that makes a replay safe. If this turn is ever
   * retried with the same idempotency key, the journal's `tool_calls` row is
   * what refuses a second effect: `runTurn` derives each call id from the turn
   * and returns the recorded result. Recovery deliberately does not re-run the
   * turn, so it cannot replay an act at all.
   */
  async #runTurnFiber<T>(
    name: string,
    turn: (fiber: FiberContext) => Promise<T>
  ): Promise<T> {
    return this.keepAliveWhile(() => this.runFiber(name, turn));
  }

  /**
   * A turn interrupted by eviction. The client resumes from the durable stream
   * (or sends the turn again); this hook only records what was left behind.
   * It never re-invokes the turn: replay safety lives in the journal, and an
   * automatic re-run would be a second model call for an effect that may
   * already be recorded.
   */
  override async onFiberRecovered(ctx: FiberRecoveryContext): Promise<void> {
    const snapshot =
      ctx.snapshot !== null && typeof ctx.snapshot === "object"
        ? (ctx.snapshot as { turn?: unknown; phase?: unknown })
        : null;
    try {
      this.ctx.storage.sql.exec(
        `UPDATE agent_turns SET state = 'failed', updated_at = ? WHERE state = 'running'`,
        Date.now()
      );
    } catch {
      // Non-fatal; reserve() still blocks crash replay.
    }
    // An interrupted turn never reached its release. Drop the claim so a retry
    // with the same key is not blocked until the TTL expires.
    const interruptedKey =
      typeof ctx.name === "string" && ctx.name.startsWith("turn:")
        ? ctx.name.slice("turn:".length)
        : null;
    if (interruptedKey !== null && interruptedKey !== "") {
      try {
        this.ctx.storage.sql.exec(
          `DELETE FROM agent_turn_claims WHERE turn = ?`,
          interruptedKey
        );
      } catch {
        // The TTL is the fallback; recovery must not fail on it.
      }
    }
    console.warn(
      `[agent] turn_interrupted ${JSON.stringify({
        fiber: ctx.id,
        name: ctx.name,
        turn: typeof snapshot?.turn === "string" ? snapshot.turn : null,
        phase: typeof snapshot?.phase === "string" ? snapshot.phase : null,
        created_at: ctx.createdAt,
      })}`
    );
  }

  /**
   * Re-arm the socket-expiry alarm at the earliest session deadline.
   */
  async #armExpiryAlarm(): Promise<void> {
    if (this._keepAliveRefs > 0) return;
    const connections = [...this.getConnections()];
    if (connections.length === 0) return;
    let earliest = Infinity;
    for (const connection of connections) {
      const state = connection.state as AssistantConnectionState | null;
      earliest = Math.min(earliest, state?.sessionExpiresAt ?? Infinity);
    }
    if (!Number.isFinite(earliest)) return;
    const target = Math.max(Date.now() + 1_000, earliest);
    try {
      const existing = await this.ctx.storage.getAlarm();
      if (existing !== null && existing <= target) return;
      await this.ctx.storage.setAlarm(target);
    } catch {
      // The alarm is a convenience; the per-frame check is the guarantee.
    }
  }

  /**
   * The claim surface over this object's SQLite.
   *
   * `INSERT ... ON CONFLICT ... WHERE expires_at <= now` makes one statement
   * both the claim and the reclaim of a dead claim. `rowsWritten === 1` is the
   * single winner; a live row makes the statement write nothing and the loser
   * takes the replay/poll path.
   */
  #turnClaims(): TurnClaimStore {
    return {
      claim: async (key, messageHash, now, expiresAt) => {
        const write = (): boolean => {
          const existing = this.ctx.storage.sql
            .exec<{ expires_at: number }>(
              `SELECT expires_at FROM agent_turn_claims WHERE turn = ?`,
              key
            )
            .toArray();
          // A live claim belongs to someone else. An expired one is reclaimed;
          // the read and the write are one synchronous block, so exactly one
          // caller can observe the row as free.
          if (existing.length > 0 && Number(existing[0].expires_at) > now) return false;
          this.ctx.storage.sql.exec(
            `INSERT INTO agent_turn_claims (turn, message_hash, claimed_at, expires_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(turn) DO UPDATE SET
               message_hash = excluded.message_hash,
               claimed_at = excluded.claimed_at,
               expires_at = excluded.expires_at`,
            key,
            messageHash,
            now,
            expiresAt
          );
          return true;
        };
        return typeof this.ctx.storage.transactionSync === "function"
          ? this.ctx.storage.transactionSync(write)
          : write();
      },
      release: async (key) => {
        this.ctx.storage.sql.exec(`DELETE FROM agent_turn_claims WHERE turn = ?`, key);
      },
    };
  }

  /** Replay a durable stream from `from`, then tail it while it is live. */
  async #replayStream(
    connection: Connection,
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

  /**
   * Claim the key, then run or replay.
   *
   * The claim is what stops two concurrent asks with one key from both calling
   * the model. A replay announces the same deterministic stream id first, so
   * the client can still resume the turn that produced the answer. A reused
   * key with different text is a named conflict, not a silent replay.
   */
  async #ask(
    connection: Connection,
    state: AssistantConnectionState,
    sessionId: string,
    message: string,
    idempotencyKey: string,
    attachmentIds: string[] = []
  ): Promise<void> {
    const conversationId = conversationIdFor(state.actor.label);
    const session = this.sessions.session(conversationId);
    const messageHash = await messageFingerprint(message);

    const outcome = await runClaimedTurn({
      session,
      key: idempotencyKey,
      messageHash,
      claims: this.#turnClaims(),
      run: () =>
        this.#runAskTurn(
          connection,
          state,
          sessionId,
          message,
          idempotencyKey,
          messageHash,
          attachmentIds
        ),
    });

    const logOutcome = (name: string): void => {
      console.log(
        `[agent] turn ${JSON.stringify({
          turn: idempotencyKey,
          actor: state.actor.label,
          took_ms: 0,
          frames: 0,
          outcome: name,
        })}`
      );
    };

    if (outcome.status === "replayed") {
      try {
        connection.send(JSON.stringify(turnFrame(idempotencyKey, conversationId)));
        // `replayed` on the frame is what lets the panel say "answered earlier, nothing ran
        // twice". Without it a replayed socket turn is indistinguishable from a fresh one,
        // which is the one thing the key exists to make visible.
        connection.send(
          JSON.stringify({ type: "answer", text: outcome.answer, replayed: true })
        );
      } catch {
        // The replayed answer is durable; a closed socket can resume.
      }
      logOutcome("replayed");
      return;
    }
    if (outcome.status === "conflict") {
      try {
        connection.send(
          JSON.stringify({
            type: "error",
            error: "idempotency_conflict",
            message: outcome.message,
          })
        );
      } catch {
        // closed; the refusal is in the log
      }
      logOutcome("error:idempotency_conflict");
      return;
    }
    if (outcome.status === "busy") {
      try {
        connection.send(
          JSON.stringify({
            type: "error",
            error: "turn_in_progress",
            message: outcome.message,
          })
        );
      } catch {
        // closed; the refusal is in the log
      }
      logOutcome("error:turn_in_progress");
    }
  }

  async #runAskTurn(
    connection: Connection,
    state: AssistantConnectionState,
    sessionId: string,
    message: string,
    idempotencyKey: string,
    messageHash: string,
    attachmentIds: string[] = []
  ): Promise<{ ok: boolean }> {
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

    // Attachments are resolved only for a turn that will actually run, and
    // before any history or stream exists: an unknown or expired id must fail
    // the turn by name rather than silently arriving without the file.
    let promptMessage = message;
    let attachmentNames: string[] = [];
    if (attachmentIds.length > 0) {
      const resolved = await this.#resolveAttachmentPrompt(attachmentIds, state.actor.label);
      if (!resolved.ok) {
        try {
          connection.send(
            JSON.stringify({ type: "error", error: resolved.reason, message: resolved.message })
          );
        } catch {
          // closed; the refusal is in the log
        }
        logTurn(`error:${resolved.reason}`);
        return { ok: false };
      }
      promptMessage = messageWithAttachments(message, resolved.block);
      attachmentNames = resolved.files.map((file) => file.name);
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
    let tokenBuffer = "";
    let tokenFlushAt = 0;
    let tokenTimer: ReturnType<typeof setTimeout> | null = null;
    const flushTokens = (): void => {
      if (tokenTimer !== null) {
        clearTimeout(tokenTimer);
        tokenTimer = null;
      }
      if (tokenBuffer !== "") {
        const text = tokenBuffer;
        tokenBuffer = "";
        tokenFlushAt = Date.now();
        sendRaw({ type: "token", text });
      }
    };
    const send = (frame: RunFrame): void => {
      if (frame.type === "token") {
        tokenBuffer += frame.text;
        const now = Date.now();
        if (tokenBuffer.length >= 64 || (tokenFlushAt > 0 && now - tokenFlushAt >= 50)) {
          flushTokens();
        } else {
          if (tokenFlushAt === 0) tokenFlushAt = now;
          if (tokenTimer === null) {
            tokenTimer = setTimeout(flushTokens, 50);
          }
        }
        return;
      }
      flushTokens();
      if (frame.type === "error") {
        errorRef.current = { reason: frame.reason, message: frame.message };
      }
      // Every frame, coalesced `token` deltas included, is appended before it is
      // sent. `token` is presentation (the model's prose as it was written); the
      // `answer` frame remains the terminal marker and the value to replay.
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
      return { ok: false };
    }

    const tools = buildAgentTools();
    // `keepAliveWhile` inside `#runTurnFiber` is the SDK's ref-counted
    // heartbeat: it caps the next alarm at `keepAliveIntervalMs` (30 s) for the
    // duration of the model call and the effects after it, and disposes on
    // success, refusal and throw. It is in-memory, exactly like the counter it
    // replaced: it lowers the chance of eviction during a live turn, it does
    // not make the turn durable — the fiber row and the journal do.
    await this.#runTurnFiber(`turn:${idempotencyKey}`, async (fiber) => {
      fiber.stash({ turn: idempotencyKey, phase: "model" });
      let result;
      try {
        result = await runTurn(
          this.env,
          state.actor,
          sessionId,
          promptMessage,
          tools,
          {
            model: resolved.adapter,
            journal: this.#journal,
            budget: { chargeTokens: (tokens) => chargeAgentTokens(this.env, tokens) },
            autonomyNote: describeAutonomy(await readAutonomyStatus(this.env)),
            idempotencyKey,
            history,
            onEvent: (frame) => {
              send(frame);
              fiber.stash({ turn: idempotencyKey, phase: frame.type });
            },
          }
        );
      } finally {
        flushTokens();
      }

      if (writer !== null) {
        try {
          if (errorRef.current !== null) writer.error(errorRef.current.message);
          else writer.close();
        } catch {
          // Closing a settled stream is safe; a race here has no side effect.
        }
      }

      try {
        await appendTurnMessages(session, idempotencyKey, history.slice(before), {
          attachmentNames,
        });
        if (result.stopped === "answer" && result.answer !== "") {
          await recordTurnAnswer(session, idempotencyKey, result.answer, messageHash);
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

      fiber.stash({ turn: idempotencyKey, phase: "settled" });
      logTurn(errorRef.current !== null ? `error:${errorRef.current.reason}` : result.stopped);
    });

    return { ok: errorRef.current === null };
  }


  /**
   * Resolve attachment ids into the text block a turn may carry.
   *
   * Text files are read from R2; images and other binaries are named only. The
   * returned block goes into the user message, never the system prompt.
   */
  async #resolveAttachmentPrompt(
    ids: string[],
    actorLabel: string
  ): Promise<
    | { ok: true; block: string; files: PromptFile[] }
    | { ok: false; reason: string; message: string }
  > {
    if (this.env.MEDIA_BUCKET === undefined) {
      return {
        ok: false,
        reason: "attachments_unavailable",
        message: "MEDIA_BUCKET is not bound, so attachments cannot be read on this deployment",
      };
    }
    if (ids.length > MAX_ATTACHMENTS_PER_TURN) {
      return {
        ok: false,
        reason: "too_many",
        message: `at most ${MAX_ATTACHMENTS_PER_TURN} attachments may be named in one turn`,
      };
    }
    const resolved = await resolveAttachments(ids, await actorHashFor(actorLabel), {
      store: d1AttachmentStore(this.env),
      blobs: r2BlobStore(this.env.MEDIA_BUCKET),
    });
    if (!resolved.ok) return resolved;
    return { ok: true, block: resolved.block, files: resolved.files };
  }

  /**
   * One non-streaming turn, for an HTTP caller.
   *
   * The console uses the WebSocket; this exists so a machine with an admin token
   * (the CLI, a test harness) can exercise the same loop, tools, grants and
   * journal without a browser session. Frames are collected rather than sent.
   *
   * `idempotencyKey` makes the whole turn replayable: the same key returns the
   * recorded answer with `replayed: true` and no second model call, the same
   * guarantee the journal gives an act. Without one the key is server-held and
   * a retry is a new turn, exactly as before.
   */
  async say(
    actor: AgentActor,
    message: string,
    options: { idempotencyKey?: string; attachmentIds?: string[] } = {}
  ): Promise<SayResult> {
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
    // Prefix keeps a caller's key from colliding with a socket turn's
    // connection-derived key; the rest is deterministic, which is the point.
    const idempotencyKey =
      options.idempotencyKey !== undefined && options.idempotencyKey !== ""
        ? `say:${options.idempotencyKey}`
        : "http:" + crypto.randomUUID();
    // The journal's turn cap is per call on the machine path; only the
    // transcript is shared with the socket path.
    const journalSessionId = "http:" + crypto.randomUUID();

    const messageHash = await messageFingerprint(trimmed);
    const outcome = await runClaimedTurn<SayResult>({
      session,
      key: idempotencyKey,
      messageHash,
      claims: this.#turnClaims(),
      run: async () => {
        let promptMessage = trimmed;
        let attachmentNames: string[] = [];
        const attachmentIds = options.attachmentIds ?? [];
        if (attachmentIds.length > 0) {
          const resolved = await this.#resolveAttachmentPrompt(attachmentIds, actor.label);
          if (!resolved.ok) return resolved;
          promptMessage = messageWithAttachments(trimmed, resolved.block);
          attachmentNames = resolved.files.map((file) => file.name);
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
        // does: one ref-counted heartbeat, disposed even when the turn throws. It
        // is also a durable fiber for the same reason: an interrupted machine turn
        // leaves a marker for `onFiberRecovered` instead of vanishing.
        return this.#runTurnFiber(`turn:${idempotencyKey}`, async (fiber) => {
          fiber.stash({ turn: idempotencyKey, phase: "model" });
          const result = await runTurn(
            this.env,
            actor,
            journalSessionId,
            promptMessage,
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
                fiber.stash({ turn: idempotencyKey, phase: frame.type });
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
            await appendTurnMessages(session, idempotencyKey, history.slice(before), {
              attachmentNames,
            });
            if (answer !== "") {
              await recordTurnAnswer(session, idempotencyKey, answer, messageHash);
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
          fiber.stash({ turn: idempotencyKey, phase: "settled" });
          logTurn(result.stopped);
          return {
            ok: true as const,
            answer,
            calls,
            tokens: null,
            took_ms: Date.now() - started,
            replayed: false,
          };
        });
      },
    });

    if (outcome.status === "replayed") {
      // A replay is answered from storage: no attachment read, no model call,
      // no token charge and no second transcript row.
      return {
        ok: true,
        answer: outcome.answer,
        calls: [],
        tokens: null,
        took_ms: 0,
        replayed: true,
      };
    }
    if (outcome.status === "conflict") {
      return { ok: false, reason: "idempotency_conflict", message: outcome.message };
    }
    if (outcome.status === "busy") {
      return { ok: false, reason: "turn_in_progress", message: outcome.message };
    }
    return outcome.value;
  }

  /* ─────────────────────────── conversation read ─────────────────────── */

  /**
   * `GET /v1/admin/agent/conversation` — the operator's durable transcript.
   *
   * The rows live in this object's SQLite, so the route must ask the object;
   * `lifecycle.start()` is awaited because the Sessions schema is created by
   * the capability's startup hook, and an RPC can be the first entry point.
   */
  async readConversation(
    actor: { label: string },
    limit: number
  ): Promise<
    | { ok: true; conversation: string; messages: ConversationReadMessage[]; truncated: boolean }
    | { ok: false; reason: string; message: string }
  > {
    await this.lifecycle.start();
    if (this.#schemaAhead) {
      return {
        ok: false,
        reason: "agent_schema_ahead",
        message: "agent storage is newer than this code",
      };
    }
    const conversation = conversationIdFor(actor.label);
    const { messages, truncated } = await readConversationMessages(
      this.sessions.session(conversation),
      limit
    );
    return { ok: true, conversation, messages, truncated };
  }

  /**
   * `DELETE /v1/admin/agent/conversation` — clear this operator's transcript.
   *
   * Sessions does have a delete-all for one session (`clearMessages`), so the
   * conversation id is kept: the panel's next turn appends to the same id and a
   * client holding it does not have to re-learn a new one. The replay markers
   * live in the same session, so a cleared conversation also forgets which turn
   * keys were already answered.
   */
  async clearConversation(
    actor: { label: string }
  ): Promise<{ ok: true; conversation: string; cleared: true } | { ok: false; reason: string; message: string }> {
    await this.lifecycle.start();
    if (this.#schemaAhead) {
      return {
        ok: false,
        reason: "agent_schema_ahead",
        message: "agent storage is newer than this code",
      };
    }
    const conversation = conversationIdFor(actor.label);
    await clearConversationMessages(this.sessions.session(conversation));
    return { ok: true, conversation, cleared: true };
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

  /**
   * One-shot migration export: every conversation session's active branch.
   * Read-only; used before moving this class to a new Worker (a new script
   * means a new Durable Object namespace and no access to this SQLite).
   */
  async exportConversations(): Promise<
    Array<{ id: string; messages: Array<Omit<SessionMessage, "createdAt"> & { createdAt?: string }> }>
  > {
    const rows = [
      ...this.ctx.storage.sql.exec<{ session_id: string }>(
        `SELECT DISTINCT session_id FROM cf_agents_session_messages
          WHERE session_id LIKE 'conversation:%'`
      ),
    ];
    const out: Array<{
      id: string;
      messages: Array<Omit<SessionMessage, "createdAt"> & { createdAt?: string }>;
    }> = [];
    for (const row of rows) {
      const history = await this.sessions.session(row.session_id).getHistory();
      out.push({
        id: row.session_id,
        messages: history.map((message) => ({
          ...message,
          createdAt: message.createdAt instanceof Date ? message.createdAt.toISOString() : message.createdAt,
        })),
      });
    }
    return out;
  }

  /**
   * One-shot migration import into the new namespace. Parent ids are rebuilt
   * from the exported order; `importMessage` keeps ids/timestamps verbatim and
   * is idempotent on id.
   */
  async importConversations(
    conversations: Array<{
      id: string;
      messages: Array<Omit<SessionMessage, "createdAt"> & { createdAt?: string }>;
    }>
  ): Promise<{ sessions: number; messages: number }> {
    let sessions = 0;
    let messages = 0;
    for (const conversation of conversations) {
      const session = this.sessions.session(conversation.id);
      let parentId: string | null = null;
      for (const message of conversation.messages) {
        const createdAt = message.createdAt === undefined ? Date.now() : Date.parse(message.createdAt);
        await session.importMessage(
          { ...message, createdAt: new Date(Number.isFinite(createdAt) ? createdAt : Date.now()) },
          { parentId, createdAt: Number.isFinite(createdAt) ? createdAt : Date.now() }
        );
        parentId = message.id;
        messages += 1;
      }
      sessions += 1;
    }
    return { sessions, messages };
  }
}


