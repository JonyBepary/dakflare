/**
 * The assistant Durable Object — pass 3, stage A.
 *
 * This is the runtime SHELL only: a `Lifecycle`, one `State` (schema version and
 * last connection), and a `WebSockets` capability that answers one `ready`
 * frame and refuses everything else with `unsupported`. There are no tools and
 * no model call yet; stage B adds read/propose tools and the injectable model
 * adapter, and stage C adds act tools and grants.
 *
 * The object owns a forward-only `schema_version` table, written inside
 * `blockConcurrencyWhile` so no request can observe a half-migrated object. A
 * stored version NEWER than the code is a rollback: the object refuses to
 * serve (503 on HTTP, a close on the socket) and logs the numbers instead of
 * guessing what the newer schema meant.
 *
 * `agents/lifecycle` is stable; the Pi Durable pieces are not imported here at
 * all. See the README in this directory for why the dependency is pinned.
 */

import { DurableObject } from "cloudflare:workers";
import { Lifecycle } from "agents/lifecycle";
import { State } from "agents/state";
import { WebSockets } from "agents/websockets";
import type { Env } from "../index";
import { ASSISTANT_OBJECT_NAME } from "../lib/agent-runtime";

/** The code's schema version. Bump it and append a step to `MIGRATIONS`. */
export const AGENT_SCHEMA_VERSION = 1;

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
];

interface AssistantState {
  schemaVersion: number;
  lastSeenAt: number | null;
}

interface StoredVersionRow extends Record<string, SqlStorageValue> {
  version: number;
}

export class AssistantAgent extends DurableObject<Env> {
  /** `true` when the stored schema is newer than this code (a rollback). */
  #schemaAhead = false;

  readonly state = new State<AssistantState>({
    initialState: { schemaVersion: AGENT_SCHEMA_VERSION, lastSeenAt: null },
  });

  /**
   * Stage A's whole protocol: one identity frame on connect, one refusal frame
   * for anything the stage does not implement yet.
   */
  readonly sockets = new WebSockets({
    handlers: {
      onConnect: (connection) => {
        if (this.#schemaAhead) {
          connection.close(1011, "agent_schema_ahead");
          return;
        }
        connection.send(
          JSON.stringify({ type: "ready", name: this.ctx.id.name ?? ASSISTANT_OBJECT_NAME })
        );
        this.state.set({ schemaVersion: AGENT_SCHEMA_VERSION, lastSeenAt: Date.now() });
      },
      onMessage: (connection) => {
        connection.send(JSON.stringify({ type: "unsupported" }));
        return true;
      },
    },
  });

  readonly lifecycle = Lifecycle.install(this).use(this.state).use(this.sockets);

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
   * HTTP surface of the shell. `/agents/*` is only expected to carry upgrades;
   * this exists so the console can ask the object which schema it is running.
   */
  onRequest(request: Request): Response {
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
    return Response.json({ error: "agent_upgrade_required" }, { status: 426 });
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
