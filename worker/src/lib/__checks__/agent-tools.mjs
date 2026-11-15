#!/usr/bin/env node
/**
 * Agent read tools — message_timeline and flow_runs.
 *
 * No Workers and no D1: `ctx.env.DB` is a fake that records every statement
 * and bind, and the journal/budget are traps that throw if a read touches them.
 * Grants are the loop's concern; a read tool must never reach them, which the
 * `kind: "read"` assertion and the untouched journal/budget prove for this path.
 *
 * Asserted:
 *   - both tools are registered with kind `read`;
 *   - message_timeline refuses an empty peer with a named reason;
 *   - its SQL filters by peer and window, orders oldest first, caps previews at
 *     120 characters and clamps the limit to 50;
 *   - flow_runs clamps the limit to 20 and orders newest first;
 *   - both return `ok: true` with JSON `output`, and touch no journal or budget.
 *
 * Run: node --experimental-strip-types src/lib/__checks__/agent-tools.mjs
 */

import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// `tools.ts` reaches the route handlers, whose transitive imports pull the
// DurableObject base class. None of that is reached by a read tool; Node just
// needs a module for the scheme.
const CLOUDFLARE_WORKERS_STUB =
  "data:text/javascript," +
  encodeURIComponent(
    "export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }\n" +
      "export class WorkerEntrypoint {}\n" +
      "export class WorkflowEntrypoint {}\n" +
      "export class RpcTarget {}\n"
  );

function resolveExtensionless(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") {
    return { url: CLOUDFLARE_WORKERS_STUB, shortCircuit: true };
  }
  if (specifier.endsWith(".wasm")) {
    // The flow interpreter bytes are never touched by these read tools.
    return { url: "data:text/javascript,export default new Uint8Array()", shortCircuit: true };
  }
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && path.extname(specifier) === "") {
    const base = context.parentURL ? path.dirname(fileURLToPath(context.parentURL)) : HERE;
    for (const suffix of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
      const candidate = path.resolve(base, specifier + suffix);
      if (existsSync(candidate)) {
        return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
    }
  }
  return nextResolve(specifier, context, nextResolve);
}

registerHooks({ resolve: resolveExtensionless });

const { buildAgentTools } = await import("../../agent/tools.ts");

let passed = 0;
const failures = [];

function check(label, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ok  ${label}`);
  } else {
    failures.push(`${label}${detail === "" ? "" : ` — ${detail}`}`);
    console.log(`FAIL  ${label}${detail === "" ? "" : ` — ${detail}`}`);
  }
}

/* ── a recording D1 ───────────────────────────────────────────────────── */

function makeDB(rows) {
  const queries = [];
  return {
    queries,
    prepare(sql) {
      const entry = { sql, args: [] };
      queries.push(entry);
      return {
        bind(...args) {
          entry.args = args;
          return this;
        },
        async all() {
          return { results: rows };
        },
        async first() {
          return rows[0] ?? null;
        },
        async run() {
          return { meta: { changes: 0 } };
        },
      };
    },
  };
}

// Any read of these is a failure: reads must not open the journal or spend the
// agent budget (and the loop is what consults a grant, never the tool).
function trap(name) {
  return new Proxy(
    {},
    {
      get() {
        throw new Error(`read tool touched ${name}`);
      },
    }
  );
}

const actor = { id: "check-actor" };
const signal = new AbortController().signal;

function context(db) {
  return { env: { DB: db }, actor, callId: "check-call", journal: trap("journal"), budget: trap("budget"), signal };
}

/* ── registration ─────────────────────────────────────────────────────── */

const tools = buildAgentTools({
  async createRule() {
    throw new Error("not used");
  },
  async sendSms() {
    throw new Error("not used");
  },
  async deployFlow() {
    throw new Error("not used");
  },
});

const byName = new Map(tools.map((tool) => [tool.name, tool]));
const timeline = byName.get("message_timeline");
const runs = byName.get("flow_runs");

check("message_timeline is registered", timeline !== undefined);
check("flow_runs is registered", runs !== undefined);
check("message_timeline is a read tool", timeline?.kind === "read", timeline?.kind);
check("flow_runs is a read tool", runs?.kind === "read", runs?.kind);

/* ── message_timeline ─────────────────────────────────────────────────── */

{
  const db = makeDB([]);
  const refused = await timeline.execute({ peer: "" }, context(db));
  check(
    "message_timeline refuses an empty peer with a named reason",
    refused.ok === false && refused.reason === "bad_request" && /peer/.test(refused.message ?? ""),
    JSON.stringify(refused)
  );
  check("the refusal runs no SQL", db.queries.length === 0, `${db.queries.length} statements`);
}

{
  const longBody = "x".repeat(400);
  const receivedAt = Date.UTC(2026, 0, 2, 3, 4, 5);
  const db = makeDB([
    {
      peer: "+15550001111",
      direction: "in",
      body: longBody,
      received_at: receivedAt,
      reply_state: "DELIVERED",
      channel: "sms",
    },
  ]);

  const result = await timeline.execute(
    { peer: "+15550001111", since_hours: 24, limit: 7 },
    context(db)
  );
  const query = db.queries[0] ?? { sql: "", args: [] };

  check(
    "message_timeline SQL filters by peer",
    /peer = \?/.test(query.sql),
    query.sql
  );
  check(
    "message_timeline SQL filters by the window",
    /received_at >= \?/.test(query.sql),
    query.sql
  );
  check(
    "message_timeline orders oldest first",
    /ORDER BY received_at ASC/.test(query.sql),
    query.sql
  );
  check("message_timeline binds the peer first", query.args[0] === "+15550001111", String(query.args[0]));
  check(
    "message_timeline binds an absolute window timestamp",
    typeof query.args[1] === "number" && query.args[1] < Date.now(),
    String(query.args[1])
  );
  check("message_timeline passes the requested limit", query.args[2] === 7, String(query.args[2]));

  check("message_timeline returns ok with output JSON", result.ok === true && typeof result.output === "string");
  const parsed = JSON.parse(result.output);
  check("message_timeline output carries peer and count", parsed.peer === "+15550001111" && parsed.count === 1);
  check(
    "message_timeline truncates the preview at 120 characters",
    parsed.messages[0].preview.length === 120,
    `${parsed.messages[0].preview.length} chars`
  );
  check(
    "message_timeline carries at, direction, state and channel",
    parsed.messages[0].at === new Date(receivedAt).toISOString() &&
      parsed.messages[0].direction === "in" &&
      parsed.messages[0].state === "DELIVERED" &&
      parsed.messages[0].channel === "sms"
  );
}

{
  const db = makeDB([]);
  await timeline.execute({ peer: "+15550002222", limit: 999 }, context(db));
  check("message_timeline clamps the limit to 50", db.queries[0].args.at(-1) === 50, String(db.queries[0].args.at(-1)));
}

/* ── flow_runs ────────────────────────────────────────────────────────── */

{
  const startedAt = Date.UTC(2026, 5, 1, 12, 0, 0);
  const db = makeDB([
    {
      device_id: "dev-1",
      local_id: "local-9",
      flow_id: "flow-abc",
      flow_version: 3,
      outcome: "error",
      created_at: startedAt,
    },
  ]);

  const result = await runs.execute({ flow_id: "flow-abc", status: "error", limit: 500 }, context(db));
  const query = db.queries[0] ?? { sql: "", args: [] };

  check(
    "flow_runs clamps the limit to 20",
    query.args.at(-1) === 20,
    String(query.args.at(-1))
  );
  check(
    "flow_runs orders newest first",
    /ORDER BY created_at DESC/.test(query.sql),
    query.sql
  );
  check("flow_runs filters by flow_id", /flow_id = \?/.test(query.sql) && query.args[0] === "flow-abc");
  check(
    "flow_runs filters status on the outcome column",
    /outcome = \?/.test(query.sql) && query.args[1] === "error",
    query.sql
  );
  check(
    "flow_runs selects only columns the schema has",
    /device_id/.test(query.sql) &&
      /local_id/.test(query.sql) &&
      /flow_version/.test(query.sql) &&
      /outcome/.test(query.sql) &&
      /created_at/.test(query.sql) &&
      !/failed_step|finished_at|started_at/.test(query.sql),
    query.sql
  );
  check("flow_runs returns ok with output JSON", result.ok === true && typeof result.output === "string");
  const parsed = JSON.parse(result.output);
  check("flow_runs output carries count and runs", parsed.count === 1 && parsed.runs.length === 1);
  check(
    "flow_runs maps a run to the real columns",
    parsed.runs[0].flow_id === "flow-abc" &&
      parsed.runs[0].outcome === "error" &&
      parsed.runs[0].created_at === new Date(startedAt).toISOString()
  );
}

{
  const db = makeDB([]);
  await runs.execute({}, context(db));
  const query = db.queries[0] ?? { sql: "", args: [] };
  check("flow_runs defaults the limit to 10", query.args.at(-1) === 10, String(query.args.at(-1)));
  check("flow_runs with no filters has no WHERE", !/WHERE/.test(query.sql), query.sql);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
