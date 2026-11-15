/**
 * A tiny Durable Object shim for driving the real `agents` capabilities.
 *
 * The SDK's capabilities read `lifecycle.storage.sql`, `storage.get/put` and
 * `blockConcurrencyWhile`. This module supplies exactly those over an
 * in-memory SQLite database, so `agent-sessions.mjs` and `agent-streams.mjs`
 * exercise the published Sessions/Streams implementation rather than a second
 * mock of it.
 *
 * Not a Workers runtime: alarms and sockets are inert. Neither capability
 * needs them for the properties these checks assert.
 */

import { DatabaseSync } from "node:sqlite";
import { registerHooks } from "node:module";

// The SDK imports `cloudflare:workers` for the DurableObject base class. Node
// cannot resolve that scheme, and the capabilities below never reach it.
const DURABLE_OBJECT_STUB =
  "data:text/javascript," +
  encodeURIComponent(
    "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }\n" +
      "export class WorkerEntrypoint {}\n" +
      "export class WorkflowEntrypoint {}\n" +
      "export class RpcTarget {}\n"
  );

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") {
      return { url: DURABLE_OBJECT_STUB, shortCircuit: true };
    }
    return nextResolve(specifier, context, nextResolve);
  },
});

function makeCursor(rows, rowsWritten) {
  const values = [...rows];
  return {
    rowsWritten: rowsWritten ?? values.length,
    rowsRead: 0,
    toArray: () => values,
    one: () => {
      if (values.length !== 1) throw new Error(`expected one row, saw ${values.length}`);
      return values[0];
    },
    raw: () => values.map((row) => Object.values(row)),
    [Symbol.iterator]: () => values[Symbol.iterator](),
  };
}

/** A fresh in-memory host plus the real `Lifecycle` over it. */
export async function createCapabilityHost() {
  const { Lifecycle } = await import("agents/lifecycle");
  const db = new DatabaseSync(":memory:");
  const kv = new Map();

  const sql = {
    exec(query, ...params) {
      const statement = db.prepare(query);
      if (/^\s*(SELECT|PRAGMA|WITH)\b/i.test(query)) {
        return makeCursor(statement.all(...params));
      }
      const result = statement.run(...params);
      return makeCursor([], Number(result.changes));
    },
  };

  const storage = {
    sql,
    get: async (key) => kv.get(key),
    put: async (key, value) => {
      kv.set(key, value);
    },
    delete: async (key) => kv.delete(key),
    blockConcurrencyWhile: async (fn) => await fn(),
    transactionSync: (fn) => {
      db.exec("BEGIN");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    setAlarm: async () => {},
    deleteAlarm: async () => {},
    getAlarm: async () => null,
  };

  class HarnessHost {}
  const host = new HarnessHost();
  host.ctx = {
    id: { name: "assistant" },
    storage,
    acceptWebSocket() {},
    getWebSockets: () => [],
    blockConcurrencyWhile: storage.blockConcurrencyWhile,
  };

  return { db, kv, storage, ctx: host.ctx, lifecycle: Lifecycle.install(host) };
}
