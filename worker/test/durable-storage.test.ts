import { abortAllDurableObjects, env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { AGENT_SCHEMA_VERSION } from "../src/agent/runtime";

/**
 * The schema ledger, against the object's real SQLite.
 *
 * Only the pool has `runInDurableObject` (read and write the DO's storage from
 * the test), `evictDurableObject` (tear the instance down so the next request
 * runs `onStart` again) and the real `getByName` stub the runtime itself calls.
 * The node check calls `#migrate`-shaped SQL against `node:sqlite`; it cannot
 * prove the ledger lives in the deployed object's storage or survives eviction.
 */
const OBJECT = "assistant";

function stub() {
  return env.ASSISTANT.getByName(OBJECT);
}

async function status(): Promise<Response> {
  return stub().fetch("https://assistant/__runtime/status");
}

describe("durable schema ledger", () => {
  it("migrates fresh storage to AGENT_SCHEMA_VERSION on first start", async () => {
    const response = await status();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { schemaVersion: number; codeVersion: number };
    expect(body.codeVersion).toBe(AGENT_SCHEMA_VERSION);
    expect(body.schemaVersion).toBe(AGENT_SCHEMA_VERSION);

    const state = await runInDurableObject(stub(), (_instance, ctx) => {
      const version = ctx.storage.sql
        .exec<{ version: number }>(`SELECT version FROM schema_version WHERE id = 1`)
        .toArray();
      const tables = ctx.storage.sql
        .exec<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table'`)
        .toArray()
        .map((row) => row.name);
      return { version: version[0]?.version, tables };
    });

    expect(state.version).toBe(AGENT_SCHEMA_VERSION);
    for (const table of ["agent_turns", "tool_calls", "agent_messages"]) {
      expect(state.tables).toContain(table);
    }
  });

  it("does not re-run migrations on a second start", async () => {
    await status();
    const before = await runInDurableObject(stub(), (_instance, ctx) =>
      ctx.storage.sql
        .exec<{ version: number; updated_at: number }>(
          `SELECT version, updated_at FROM schema_version WHERE id = 1`
        )
        .toArray()[0]
    );

    // A real teardown: the next request constructs a new instance and runs
    // onStart again, exactly as after an idle eviction or a deploy.
    await abortAllDurableObjects();
    const response = await status();
    expect(response.status).toBe(200);

    const after = await runInDurableObject(stub(), (_instance, ctx) =>
      ctx.storage.sql
        .exec<{ version: number; updated_at: number }>(
          `SELECT version, updated_at FROM schema_version WHERE id = 1`
        )
        .toArray()[0]
    );
    expect(after.version).toBe(AGENT_SCHEMA_VERSION);
    expect(after.updated_at).toBe(before.updated_at);

    // The stronger claim: no DDL ran. Drop a migrated table, restart, and it
    // stays missing. `CREATE TABLE IF NOT EXISTS` would silently recreate it,
    // so an unchanged updated_at alone would not distinguish the two.
    await runInDurableObject(stub(), (_instance, ctx) =>
      ctx.storage.sql.exec(`DROP TABLE agent_messages`)
    );
    await abortAllDurableObjects();
    expect((await status()).status).toBe(200);
    const recreated = await runInDurableObject(stub(), (_instance, ctx) =>
      ctx.storage.sql
        .exec<{ name: string }>(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_messages'`
        )
        .toArray()
    );
    expect(recreated).toEqual([]);
  });

  it("answers 503 agent_schema_ahead when storage is newer than the code", async () => {
    await runInDurableObject(stub(), (_instance, ctx) => {
      ctx.storage.sql.exec(
        `UPDATE schema_version SET version = ?, updated_at = ? WHERE id = 1`,
        AGENT_SCHEMA_VERSION + 1,
        Date.now()
      );
    });
    await abortAllDurableObjects();

    const response = await status();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "agent_schema_ahead",
      code: AGENT_SCHEMA_VERSION,
    });
  });
});
