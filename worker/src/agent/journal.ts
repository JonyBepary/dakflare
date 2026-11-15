/**
 * The terminal tool journal — pass 3, stage C.
 *
 * An act writes a `tool_calls` row BEFORE its effect, in the same transaction
 * that marks the turn running, and updates the row after. The row is the replay
 * detector: the effect's idempotency key is derived from `call_id`, so a retry
 * of the same ask cannot send a second SMS or deploy a second graph.
 *
 * The journal deliberately owns no policy. It answers one question — "has this
 * exact call already happened, and if so what did it return?" — and the act
 * tool decides what to do with that answer.
 *
 * The storage seam is a tiny interface, not `DurableObjectStorage`, so the
 * policy checks in `__checks__/agent-loop.mjs` can drive it with an in-memory
 * object. `runtime.ts` supplies the object's real SQLite.
 */

import type { ToolResult } from "./types";

/** The subset of `ctx.storage.sql` the journal needs. */
export interface JournalSql {
  exec<T extends Record<string, unknown>>(
    query: string,
    ...bindings: unknown[]
  ): { toArray(): T[] };
}

/** The subset of `ctx.storage` the journal needs. */
export interface JournalStorage {
  sql: JournalSql;
  /** Present on Durable Object storage; absent in the in-memory test double. */
  transactionSync?<T>(fn: () => T): T;
}

export interface ReserveInput {
  callId: string;
  tool: string;
  args: Record<string, unknown>;
}

export type Reservation =
  | { replay: false }
  | { replay: true; result: ToolResult; state: string };

interface CallRow extends Record<string, unknown> {
  state: string;
  result_json: string | null;
}

interface TurnRow extends Record<string, unknown> {
  turn: number;
}

/** A stable JSON string with sorted object keys, so an args hash cannot drift. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class Journal {
  readonly #storage: JournalStorage;
  #session = "";
  #turn = 0;

  constructor(storage: JournalStorage) {
    this.#storage = storage;
  }

  /** The session and turn the loop is currently executing. */
  setTurn(session: string, turn: number): void {
    this.#session = session;
    this.#turn = turn;
  }

  currentTurn(): { session: string; turn: number } {
    return { session: this.#session, turn: this.#turn };
  }

  /**
   * The effect's idempotency key: a pure function of the model-independent call
   * id. Two different asks can never share a key, and the model cannot choose
   * one.
   */
  deriveKey(callId: string): string {
    return `agent:${callId}`;
  }

  /** The next turn number for a session; 1 on the first call. */
  nextTurn(session: string): number {
    const rows = this.#storage.sql
      .exec<TurnRow>(`SELECT COALESCE(MAX(turn), 0) AS turn FROM agent_turns WHERE session = ?`, session)
      .toArray();
    return Number(rows[0]?.turn ?? 0) + 1;
  }

  /**
   * Write the call row and mark the turn running, atomically.
   *
   * Returns `{replay: true}` with the recorded result when the call id already
   * reached a terminal state. A row left in `running` by a crash is also
   * refused: the effect may have happened, so replaying it is not safe, and the
   * refusal names that rather than pretending the call is new.
   */
  async reserve(input: ReserveInput): Promise<Reservation> {
    const argsHash = await sha256Hex(canonicalJson(input.args));
    const now = Date.now();
    const session = this.#session;
    const turn = this.#turn;

    const write = (): CallRow | undefined => {
      const existing = this.#storage.sql
        .exec<CallRow>(
          `SELECT state, result_json FROM tool_calls WHERE call_id = ?`,
          input.callId
        )
        .toArray();
      if (existing.length > 0) return existing[0];

      this.#storage.sql.exec(
        `INSERT INTO agent_turns (session, turn, state, updated_at)
         VALUES (?, ?, 'running', ?)
         ON CONFLICT(session, turn) DO UPDATE SET state = 'running', updated_at = excluded.updated_at`,
        session,
        turn,
        now
      );
      this.#storage.sql.exec(
        `INSERT INTO tool_calls
           (call_id, session, turn, tool, args_hash, state, result_json, created_at)
         VALUES (?, ?, ?, ?, ?, 'running', NULL, ?)`,
        input.callId,
        session,
        turn,
        input.tool,
        argsHash,
        now
      );
      return undefined;
    };

    const row =
      this.#storage.transactionSync !== undefined
        ? this.#storage.transactionSync(write)
        : write();

    if (row === undefined) {
      return { replay: false };
    }
    if (row.state === "running") {
      return {
        replay: true,
        state: "running",
        result: {
          ok: false,
          reason: "call_in_progress",
          message: `call ${input.callId} was already started and did not finish; replay is unsafe`,
        },
      };
    }
    return {
      replay: true,
      state: row.state,
      result: parseResult(row.result_json),
    };
  }

  complete(callId: string, result: ToolResult): void {
    this.#storage.sql.exec(
      `UPDATE tool_calls SET state = 'done', result_json = ? WHERE call_id = ?`,
      JSON.stringify(result),
      callId
    );
  }

  fail(callId: string, result: ToolResult): void {
    this.#storage.sql.exec(
      `UPDATE tool_calls SET state = 'failed', result_json = ? WHERE call_id = ?`,
      JSON.stringify(result),
      callId
    );
  }

  finishTurn(session: string, turn: number): void {
    this.#storage.sql.exec(
      `UPDATE agent_turns SET state = 'done', updated_at = ? WHERE session = ? AND turn = ?`,
      Date.now(),
      session,
      turn
    );
  }
}

function parseResult(json: string | null): ToolResult {
  if (json === null || json === "") {
    return { ok: false, reason: "replay_unreadable", message: "the recorded result is empty" };
  }
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed !== null && typeof parsed === "object" && "ok" in parsed) {
      return parsed as ToolResult;
    }
  } catch {
    // fall through
  }
  return { ok: false, reason: "replay_unreadable", message: "the recorded result is not readable" };
}
