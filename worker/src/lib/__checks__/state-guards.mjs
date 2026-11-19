#!/usr/bin/env node
/**
 * State-guard checks — the guards that keep a duplicate from becoming a second
 * effect, and a late report from moving a terminal state backwards.
 *
 * Everything runs against the real handlers over an in-memory SQLite database
 * loaded from `migrations/`, or against the real `DeviceGateway.transition`, so
 * the assertions are about rows, `meta.changes` and response codes rather than
 * the text of a predicate.
 *
 * Asserted:
 *   - two accepts racing on one proposal create exactly one rule; the loser
 *     gets 409 and says it was already applied;
 *   - a failed effect releases the claim, and a retry then succeeds;
 *   - a delivered reply refuses `sent`, `queued` and `failed`;
 *   - `queued → sent → delivered` still works;
 *   - a duplicate `delivered` leaves `meta.changes` at 0;
 *   - `DELIVERED` is accepted from `DISPATCHED`, and a later `SENT` is a no-op;
 *   - an oversized multipart upload is refused with 413 even without a
 *     trustworthy `content-length`.
 *
 * Run: node --experimental-strip-types src/lib/__checks__/state-guards.mjs
 */

import { registerHooks } from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = path.resolve(HERE, "../../..");

// `durable-object.ts` imports `cloudflare:workers` for its base class. Node
// cannot resolve that scheme, and the check only needs `transition`, not the
// runtime.
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

// `incoming.ts` reaches the flow engine, which imports the compiled wasm. This
// check never runs the engine; Node only needs the import to resolve.
const WASM_STUB = "data:text/javascript,export default {}";

function resolveExtensionless(specifier, context, nextResolve) {
  if (specifier.startsWith("cloudflare:")) {
    return { url: DURABLE_OBJECT_STUB, shortCircuit: true };
  }
  if (specifier.endsWith(".wasm")) {
    return { url: WASM_STUB, shortCircuit: true };
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

// The Durable Object constructor installs a WebSocket auto-response pair. It is
// inert in this check, but the global exists in the Workers runtime.
globalThis.WebSocketRequestResponsePair = class WebSocketRequestResponsePair {
  constructor(request, response) {
    this.request = request;
    this.response = response;
  }
};

const { handleAssistantProposalAccept } = await import("../../routes/assistant.ts");
const { handleIncomingBatch } = await import("../../routes/incoming.ts");
const { handleAgentAttachmentUpload } = await import("../../routes/agent-runtime.ts");
const { MAX_ATTACHMENT_BYTES } = await import("../../agent/attachments.ts");
const { DeviceGateway } = await import("../../durable-object.ts");

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

/* ── the real schema, in memory ───────────────────────────────────────── */

function makeD1() {
  const db = new DatabaseSync(":memory:");
  const migrations = path.join(WORKER_ROOT, "migrations");
  for (const file of readdirSync(migrations).filter((entry) => entry.endsWith(".sql")).sort()) {
    db.exec(readFileSync(path.join(migrations, file), "utf8"));
  }
  // Test-only fault injection: the next INSERT into `rules` throws, so the
  // accept route's release path can be driven without a second implementation.
  const state = { failRulesInsert: false };
  return {
    raw: db,
    state,
    prepare(sql) {
      const statement = db.prepare(sql);
      const args = { values: [] };
      return {
        bind(...values) {
          args.values = values;
          return this;
        },
        async first() {
          return statement.get(...args.values) ?? null;
        },
        async all() {
          return { results: statement.all(...args.values) };
        },
        async run() {
          if (state.failRulesInsert && /INSERT\s+OR\s+REPLACE\s+INTO\s+rules/i.test(sql)) {
            state.failRulesInsert = false;
            throw new Error("simulated storage fault");
          }
          const result = statement.run(...args.values);
          return { meta: { changes: Number(result.changes) } };
        },
      };
    },
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
}

const ADMIN = { userId: "user_check", label: "checker@example.com", role: "admin", canGrantOwner: true };

const RULE_PAYLOAD = {
  matcher: { type: "exact", value: "BOT" },
  body_matcher: { type: "keyword", value: "ping" },
  reply_template: "pong",
};

function insertProposal(db, id, kind, payload, now = Date.now()) {
  db.raw
    .prepare(
      `INSERT INTO assistant_proposals
         (id, kind, payload_json, created_by, created_at, expires_at, consumed_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`
    )
    .run(id, kind, JSON.stringify(payload), ADMIN.label, now, now + 15 * 60_000);
}

/* ── 1. two accepts race; one rule, one 409 ───────────────────────────── */

{
  const env = { DB: makeD1() };
  const id = "ap_racecheck0001";
  insertProposal(env.DB, id, "create_rule", RULE_PAYLOAD);

  const [first, second] = await Promise.all([
    handleAssistantProposalAccept(env, id, ADMIN),
    handleAssistantProposalAccept(env, id, ADMIN),
  ]);
  const statuses = [first.status, second.status].sort((a, b) => a - b);
  check("a race yields one 200 and one 409", statuses[0] === 200 && statuses[1] === 409, JSON.stringify(statuses));

  const loser = first.status === 409 ? first : second;
  const loserBody = await loser.json().catch(() => ({}));
  check(
    "the loser says the proposal was already applied",
    typeof loserBody.message === "string" && /already applied/i.test(loserBody.message),
    JSON.stringify(loserBody)
  );

  const rules = env.DB.raw.prepare("SELECT COUNT(*) AS n FROM rules").get().n;
  check("exactly one rule was created", Number(rules) === 1, String(rules));

  const consumed = env.DB.raw
    .prepare("SELECT consumed_at FROM assistant_proposals WHERE id = ?")
    .get(id).consumed_at;
  check("the proposal is consumed once", typeof consumed === "number" && consumed > 0, String(consumed));
}

/* ── 2. a failed effect releases the claim, and a retry succeeds ──────── */

{
  const env = { DB: makeD1() };
  const id = "ap_failcheck0001";
  insertProposal(env.DB, id, "create_rule", RULE_PAYLOAD);
  env.DB.state.failRulesInsert = true;

  let threw = false;
  try {
    await handleAssistantProposalAccept(env, id, ADMIN);
  } catch {
    threw = true;
  }
  check("a thrown effect surfaces as a failure", threw === true);
  const afterFailure = env.DB.raw
    .prepare("SELECT consumed_at FROM assistant_proposals WHERE id = ?")
    .get(id).consumed_at;
  check("the failed effect released the claim", afterFailure === null, String(afterFailure));

  const retry = await handleAssistantProposalAccept(env, id, ADMIN);
  check("a retry after release succeeds", retry.status === 200, String(retry.status));
  const rules = env.DB.raw.prepare("SELECT COUNT(*) AS n FROM rules").get().n;
  check("the retry created the rule", Number(rules) === 1, String(rules));
}

/* ── 3. outbound reply state only moves forward ───────────────────────── */

const DEVICE_ID = "dev_statecheck01";

function makeIncomingEnv() {
  const db = makeD1();
  const pending = [];
  return {
    DB: db,
    DEVICE: {
      idFromName: () => "do_statecheck",
      get: () => ({
        async fetch(url) {
          const target = typeof url === "string" ? url : url.url;
          if (target.includes("__reserve")) return Response.json({ ok: true });
          if (target.includes("__pending")) return Response.json(pending);
          return Response.json({ ok: true });
        },
      }),
    },
  };
}

async function reportState(env, localId, state, error) {
  const body = {
    outbound: [
      {
        local_id: localId,
        to: "+15550000001",
        body: "hello",
        sent_at: Date.now(),
        ...(state === undefined ? {} : { state }),
        ...(error === undefined ? {} : { error }),
      },
    ],
  };
  const response = await handleIncomingBatch(
    new Request("https://worker.invalid/v1/messages"),
    env,
    DEVICE_ID,
    JSON.stringify(body)
  );
  return { response, body: await response.json() };
}

function replyRow(env, localId) {
  return env.DB.raw
    .prepare(
      "SELECT reply_state, reply_error FROM messages WHERE device_id = ? AND local_id = ?"
    )
    .get(DEVICE_ID, localId);
}

{
  const env = makeIncomingEnv();
  const localId = "local_forward_1";

  const queued = await reportState(env, localId, "queued");
  check("a first queued report is accepted", queued.response.status === 200 && queued.body.accepted === 1, JSON.stringify(queued.body));

  const sent = await reportState(env, localId, "sent");
  check("queued → sent is accepted", sent.body.accepted === 1, JSON.stringify(sent.body));

  const delivered = await reportState(env, localId, "delivered");
  check("sent → delivered is accepted", delivered.body.accepted === 1, JSON.stringify(delivered.body));
  check("the row is delivered", replyRow(env, localId).reply_state === "delivered", JSON.stringify(replyRow(env, localId)));

  for (const late of ["sent", "queued", "failed"]) {
    const replay = await reportState(env, localId, late, late === "failed" ? "late failure" : undefined);
    const row = replyRow(env, localId);
    check(
      `delivered refuses a late ${late}`,
      replay.body.accepted === 0 && replay.body.duplicates === 1 && row.reply_state === "delivered",
      JSON.stringify({ body: replay.body, row })
    );
    check(
      `a refused ${late} does not write reply_error`,
      late !== "failed" || row.reply_error === null,
      JSON.stringify(row)
    );
  }

  const duplicate = await reportState(env, localId, "delivered");
  check(
    "a duplicate delivered changes nothing (changes === 0)",
    duplicate.body.accepted === 0 && duplicate.body.duplicates === 1,
    JSON.stringify(duplicate.body)
  );
  check("the duplicate left the row at delivered", replyRow(env, localId).reply_state === "delivered");
}

/* ── 4. DELIVERED may arrive before SENT, and terminal stays terminal ──── */

{
  const db = new DatabaseSync(":memory:");
  const cursor = (rows, rowsWritten) => ({
    rowsWritten: rowsWritten ?? rows.length,
    rowsRead: 0,
    toArray: () => [...rows],
    one: () => rows[0],
    raw: () => rows.map((row) => Object.values(row)),
    [Symbol.iterator]: () => rows[Symbol.iterator](),
  });
  const ctx = {
    storage: {
      sql: {
        exec(query, ...params) {
          if (params.length === 0 && /;\s*\S/.test(query)) {
            db.exec(query);
            return cursor([], 0);
          }
          const statement = db.prepare(query);
          if (/^\s*(SELECT|PRAGMA|WITH)\b/i.test(query)) return cursor(statement.all(...params));
          return cursor([], Number(statement.run(...params).changes));
        },
      },
      setAlarm() {},
      deleteAlarm() {},
      get: async () => undefined,
      put: async () => {},
      delete: async () => {},
    },
    blockConcurrencyWhile(fn) {
      fn();
    },
    getWebSockets: () => [],
    setWebSocketAutoResponse() {},
  };

  const gateway = new DeviceGateway(ctx, {});
  const insert = (id, state) =>
    db
      .prepare(
        `INSERT INTO commands
           (command_id, to_e164, body, priority, state, created_at, expires_at)
         VALUES (?, '+15550000002', 'hi', 'normal', ?, ?, ?)`
      )
      .run(id, state, Date.now(), Date.now() + 60_000);
  const stateOf = (id) => db.prepare("SELECT state FROM commands WHERE command_id = ?").get(id).state;

  insert("cmd_direct_delivery", "DISPATCHED");
  const accepted = gateway.transition("cmd_direct_delivery", "DELIVERED");
  check("DELIVERED is accepted from DISPATCHED", accepted === true && stateOf("cmd_direct_delivery") === "DELIVERED", stateOf("cmd_direct_delivery"));

  const lateSent = gateway.transition("cmd_direct_delivery", "SENT");
  check("a late SENT after DELIVERED is a no-op", lateSent === false && stateOf("cmd_direct_delivery") === "DELIVERED", stateOf("cmd_direct_delivery"));

  insert("cmd_from_sent", "SENT");
  const fromSent = gateway.transition("cmd_from_sent", "DELIVERED");
  check("DELIVERED is still accepted from SENT", fromSent === true && stateOf("cmd_from_sent") === "DELIVERED", stateOf("cmd_from_sent"));

  insert("cmd_failed", "FAILED");
  const fromFailed = gateway.transition("cmd_failed", "DELIVERED");
  check("DELIVERED cannot resurrect a FAILED command", fromFailed === false && stateOf("cmd_failed") === "FAILED", stateOf("cmd_failed"));
}

/* ── 5. an oversized multipart body is refused while reading ──────────── */

{
  const limit = MAX_ATTACHMENT_BYTES + 128 * 1024;
  let remaining = limit;
  const body = new ReadableStream({
    pull(controller) {
      if (remaining <= 0) {
        controller.close();
        return;
      }
      const size = Math.min(64 * 1024, remaining);
      controller.enqueue(new Uint8Array(size));
      remaining -= size;
    },
  });
  const req = new Request("https://worker.invalid/v1/admin/agent/attachments", {
    method: "POST",
    headers: { "content-type": "multipart/form-data; boundary=check" },
    body,
    duplex: "half",
  });
  const env = {
    DB: { prepare() { throw new Error("the size check must run before storage"); } },
    MEDIA_BUCKET: { put: async () => {}, delete: async () => {} },
  };
  const response = await handleAgentAttachmentUpload(req, env, ADMIN);
  const payload = await response.json().catch(() => ({}));
  check("an oversized chunked upload is refused with 413", response.status === 413, String(response.status));
  check(
    "the refusal names the 1 MiB limit",
    typeof payload.message === "string" && /1 MiB/.test(payload.message),
    JSON.stringify(payload)
  );
}

console.log("");
if (failures.length > 0) {
  console.log(`${failures.length} failure(s); ${passed} check(s) passed`);
  process.exitCode = 1;
} else {
  console.log(`STATE GUARDS PASSED — ${passed} checks`);
}
