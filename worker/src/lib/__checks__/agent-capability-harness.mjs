/**
 * A tiny Durable Object shim for driving the real `agents` capabilities.
 *
 * The SDK's capabilities read `lifecycle.storage.sql`, `storage.get/put` and
 * `blockConcurrencyWhile`. This module supplies exactly those over an
 * in-memory SQLite database, so `agent-sessions.mjs` and `agent-streams.mjs`
 * exercise the published Sessions/Streams implementation rather than a second
 * mock of it.
 *
 * Not a Workers runtime: sockets are inert and alarms are recorded, not
 * delivered. Neither capability needs delivery for the properties these checks
 * assert; `agent-heartbeat.mjs` only reads the alarm the SDK schedules.
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
      "export class RpcTarget {}\n" +
      "export class EmailMessage {}\n" +
      "export class WebSocketPair { constructor() { return [{}, {}]; } }\n" +
      "const exportsObject = {}; export { exportsObject as exports };\n"
  );

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers" || specifier === "cloudflare:email") {
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
  let alarm = null;

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
    // The synchronous KV view the Agent base class reads its own schema gate
    // from during construction.
    kv: {
      get: (key) => kv.get(key),
      put: (key, value) => {
        kv.set(key, value);
      },
      delete: (key) => kv.delete(key),
    },
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
    setAlarm: async (time) => {
      alarm = Number(time);
    },
    deleteAlarm: async () => {
      alarm = null;
    },
    getAlarm: async () => alarm,
    waitUntil: () => {},
  };

  class HarnessHost {}
  const host = new HarnessHost();
  host.ctx = {
    id: { name: "assistant", toString: () => "assistant-id" },
    storage,
    acceptWebSocket() {},
    getWebSockets: () => [],
    blockConcurrencyWhile: storage.blockConcurrencyWhile,
    waitUntil: () => {},
  };

  return { db, kv, storage, ctx: host.ctx, lifecycle: Lifecycle.install(host) };
}
