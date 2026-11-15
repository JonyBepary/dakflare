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
 * `AGENT_RUNTIME=off` is enforced at the edge (`index.ts`) before this object is
 * touched; the stateless assistant keeps working either way.
 */

import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import { State } from "agents/state";
import { WebSockets } from "agents/websockets";
import type { Env } from "../index";
import type { AdminActor } from "../audit";
import { ASSISTANT_OBJECT_NAME } from "../lib/agent-runtime";
import { readSettingsOrEnv } from "../lib/ai/settings";
import { resolveAdapter } from "../lib/ai/registry";
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

interface MessageRow extends Record<string, SqlStorageValue> {
  role: string;
  content: string;
}

/** The connection fields the runtime reads; `Connection` extends `WebSocket`. */
interface AssistantConnection extends WebSocket {
  id: string;
  state: unknown;
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
          })
        );
        this.state.set({ schemaVersion: AGENT_SCHEMA_VERSION, lastSeenAt: Date.now() });
      },
      onMessage: (connection, message) => {
        void this.#handleFrame(connection, message);
        return true;
      },
    },
  });

  readonly lifecycle = Lifecycle.install(this).use(this.state).use(this.sockets);

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
    return Response.json({ error: "agent_upgrade_required" }, { status: 426 });
  }

  /** Close every socket whose session or autonomy window has passed. */
  override async alarm(): Promise<void> {
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

    if (payload.type !== "ask") {
      connection.send(JSON.stringify({ type: "unsupported" }));
      return;
    }

    const state = connection.state as AssistantConnectionState | null;
    if (state === null || state.actor === undefined) {
      connection.close(1008, "agent_identity_missing");
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
        : `${connection.id}:${fnv1a(messageText)}`;

    const sessionId = connection.id;
    await this.#ask(connection, state, sessionId, messageText.trim(), idempotencyKey);

    const after = await readAutonomyStatus(this.env);
    const nextExpiry = Math.min(
      state.sessionExpiresAt,
      after.expires_at ?? Infinity
    );
    if (Number.isFinite(nextExpiry)) {
      try {
        await this.ctx.storage.setAlarm(Math.max(Date.now() + 1_000, nextExpiry));
      } catch {
        // The alarm is a convenience; the per-frame check is the guarantee.
      }
    }
  }

  async #ask(
    connection: AssistantConnection,
    state: AssistantConnectionState,
    sessionId: string,
    message: string,
    idempotencyKey: string
  ): Promise<void> {
    const send = (frame: RunFrame): void => {
      try {
        connection.send(JSON.stringify(frame));
      } catch {
        // The socket closed mid-turn; the journal still records what happened.
      }
    };

    let history: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
    try {
      const rows = this.ctx.storage.sql
        .exec<MessageRow>(
          `SELECT role, content FROM agent_messages WHERE session = ? ORDER BY id ASC LIMIT 60`,
          sessionId
        )
        .toArray();
      history = rows
        .filter((row) => row.role === "user" || row.role === "assistant")
        .map((row) => ({
          role: row.role as "user" | "assistant",
          content: row.content,
        }));
    } catch {
      history = [];
    }
    const before = history.length;

    const settings = await readSettingsOrEnv(this.env);
    const resolved = resolveAdapter(this.env, settings);
    if (!resolved.ok) {
      connection.send(
        JSON.stringify({
          type: "error",
          error: "ai_unavailable",
          reason: resolved.reason,
          message: resolved.message,
        })
      );
      return;
    }

    const tools = buildAgentTools();
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

    const now = Date.now();
    for (const entry of history.slice(before)) {
      try {
        this.ctx.storage.sql.exec(
          `INSERT INTO agent_messages (session, role, content, created_at) VALUES (?, ?, ?, ?)`,
          sessionId,
          entry.role,
          entry.content,
          now
        );
      } catch {
        // A lost transcript row costs context, not the journal.
      }
    }

    if (result.stopped === "turn_cap") {
      try {
        connection.send(JSON.stringify({ type: "turn_cap", turns: result.turns }));
      } catch {
        // closed
      }
    }
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

    // One session per call. The machine path is for a single turn, and reusing a
    // session made the model read its own earlier refusals back as the current
    // state ("repeating the request doesn't create a grant").
    const sessionId = "http:" + actor.label + ":" + crypto.randomUUID();
    const started = Date.now();
    const calls: unknown[] = [];
    let answer = "";
    // A holder, not a bare `let`: TypeScript's flow analysis does not see an
    // assignment made inside a callback, and narrows a reassigned `let` to null.
    const failureRef: { current: { reason: string; message: string } | null } = { current: null };

    const history: Array<{ role: "user" | "assistant"; content: string }> = [];
    try {
      const rows = this.ctx.storage.sql
        .exec<{ role: string; content: string }>(
          `SELECT role, content FROM agent_messages WHERE session = ? ORDER BY id ASC LIMIT 60`,
          sessionId
        )
        .toArray();
      for (const row of rows) {
        if (row.role === "user" || row.role === "assistant") {
          history.push({ role: row.role, content: row.content });
        }
      }
    } catch {
      // a lost transcript costs context, not the turn
    }
    const before = history.length;

    const settings = await readSettingsOrEnv(this.env);
    const resolved = resolveAdapter(this.env, settings);
    if (!resolved.ok) {
      return { ok: false, reason: resolved.reason, message: resolved.message };
    }

    const result = await runTurn(
      this.env,
      actor,
      sessionId,
      trimmed,
      buildAgentTools(),
      {
        model: resolved.adapter,
        journal: this.#journal,
        budget: { chargeTokens: (tokens) => chargeAgentTokens(this.env, tokens) },
        autonomyNote: describeAutonomy(await readAutonomyStatus(this.env)),
        idempotencyKey: "http:" + crypto.randomUUID(),
        history,
        onEvent: (frame) => {
          if (frame.type === "answer") answer = frame.text;
          else if (frame.type === "tool") calls.push(frame);
          else if (frame.type === "error") {
            failureRef.current = { reason: frame.reason, message: frame.message };
          }
        },
      }
    );

    const now = Date.now();
    for (const entry of history.slice(before)) {
      try {
        this.ctx.storage.sql.exec(
          `INSERT INTO agent_messages (session, role, content, created_at) VALUES (?, ?, ?, ?)`,
          sessionId,
          entry.role,
          entry.content,
          now
        );
      } catch {
        // ignore
      }
    }

    if (failureRef.current !== null) {
      // A provider or parse failure is a refusal with a reason, never an empty
      // "answer" the operator has to interpret.
      return {
        ok: false,
        reason: failureRef.current.reason,
        message: failureRef.current.message,
      };
    }
    if (answer === "") answer = result.answer ?? "";
    return {
      ok: true,
      answer,
      calls,
      tokens: null,
      took_ms: Date.now() - started,
    };
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

/** A tiny non-cryptographic hash for an ask without an idempotency key. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}
