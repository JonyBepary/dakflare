#!/usr/bin/env node
/**
 * Alert acknowledgement provenance and conversation session state.
 *
 * Everything runs against the real handlers over an in-memory SQLite database
 * loaded from `migrations/`, so the assertions are about stored rows, audit rows
 * and response bodies rather than the text of a query.
 *
 * Asserted:
 *   - acknowledging an alert stores the actor on the row and in `audit_log`;
 *   - a second acknowledgement keeps the first actor and time and writes nothing;
 *   - an alert acknowledged before the column existed reads back as null
 *     ("unknown"), never an empty label;
 *   - a message with a conversation returns its `session_state` and window;
 *   - a message without one returns null for both.
 *
 * Run: node --experimental-strip-types src/lib/__checks__/alert-audit.mjs
 */

import { registerHooks } from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = path.resolve(HERE, "../../..");

// `incoming.ts` reaches the flow engine, which imports compiled wasm. These
// checks never run the engine; Node only needs the import to resolve.
const WASM_STUB = "data:text/javascript,export default {}";

function resolveExtensionless(specifier, context, nextResolve) {
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

const { handleAlertAck, handleAlertsAckAll, handleAlertsList } = await import("../../routes/alerts.ts");
const { handleMessagesList } = await import("../../routes/incoming.ts");

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
  return {
    raw: db,
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

const DEVICE_ID = "dev_alertcheck01";
const NOW = Date.now();

const ALICE = {
  userId: "user_alice",
  label: "alice@example.com",
  role: "admin",
  canGrantOwner: false,
};
const BOB = {
  userId: "user_bob",
  label: "bob@example.com",
  role: "owner",
  canGrantOwner: true,
};

function makeEnv() {
  const env = { DB: makeD1() };
  env.DB.raw
    .prepare(
      `INSERT INTO devices (device_id, public_key, paired_at, last_seen, label)
       VALUES (?, 'pk', ?, ?, 'Front desk')`
    )
    .run(DEVICE_ID, NOW, NOW);
  return env;
}

function insertAlert(env, id, extra = {}) {
  env.DB.raw
    .prepare(
      `INSERT INTO alerts (id, device_id, kind, raised_at, acknowledged_at, acknowledged_by, detail)
       VALUES (?, ?, 'offline', ?, ?, ?, 'silent too long')`
    )
    .run(
      id,
      DEVICE_ID,
      extra.raisedAt ?? NOW - 60_000,
      extra.acknowledgedAt ?? null,
      extra.acknowledgedBy ?? null
    );
}

function alertRow(env, id) {
  return env.DB.raw
    .prepare("SELECT acknowledged_at, acknowledged_by, resolved_at FROM alerts WHERE id = ?")
    .get(id);
}

function auditRows(env, action) {
  return env.DB.raw
    .prepare(
      `SELECT actor_user, actor_label, subject, action, detail_json
         FROM audit_log WHERE action = ? ORDER BY at, id`
    )
    .all(action);
}

/* ── 1. acknowledging stores the actor on the row and in the audit log ── */

{
  const env = makeEnv();
  const id = "alert_ack_actor";
  insertAlert(env, id);

  const response = await handleAlertAck(env, id, ALICE);
  const body = await response.json();
  check("the acknowledgement succeeds", response.status === 200 && body.ok === true, JSON.stringify(body));
  check(
    "the response names the actor",
    body.acknowledged_by === ALICE.label,
    JSON.stringify(body)
  );

  const row = alertRow(env, id);
  check(
    "the row stores the actor and the time",
    row.acknowledged_by === ALICE.label && typeof row.acknowledged_at === "number",
    JSON.stringify(row)
  );

  const audit = auditRows(env, "alert.acknowledged");
  check("one audit row is written", audit.length === 1, String(audit.length));
  check(
    "the audit row names the actor and the alert",
    audit[0]?.actor_user === ALICE.userId &&
      audit[0]?.actor_label === ALICE.label &&
      audit[0]?.subject === id,
    JSON.stringify(audit[0])
  );
}

/* ── 2. a second acknowledgement keeps the first actor and time ───────── */

{
  const env = makeEnv();
  const id = "alert_ack_twice";
  insertAlert(env, id);

  const first = await (await handleAlertAck(env, id, ALICE)).json();
  const firstRow = alertRow(env, id);

  const secondResponse = await handleAlertAck(env, id, BOB);
  const second = await secondResponse.json();
  const secondRow = alertRow(env, id);

  check("the second acknowledgement still succeeds as a no-op", secondResponse.status === 200 && second.ok === true, JSON.stringify(second));
  check(
    "the first actor is kept on the row",
    secondRow.acknowledged_by === ALICE.label,
    JSON.stringify(secondRow)
  );
  check(
    "the first acknowledgement time is kept",
    secondRow.acknowledged_at === firstRow.acknowledged_at,
    `${firstRow.acknowledged_at} vs ${secondRow.acknowledged_at}`
  );
  check(
    "the response repeats the first acknowledgement",
    second.acknowledged_by === ALICE.label &&
      second.acknowledged_at === firstRow.acknowledged_at,
    JSON.stringify(second)
  );
  check(
    "a no-op writes no second audit row",
    auditRows(env, "alert.acknowledged").length === 1,
    String(auditRows(env, "alert.acknowledged").length)
  );

  // The batch path must also keep an existing acknowledgement intact.
  await handleAlertsAckAll(env, BOB);
  const afterBatch = alertRow(env, id);
  check(
    "ack-all does not rewrite an acknowledged row",
    afterBatch.acknowledged_by === ALICE.label &&
      afterBatch.acknowledged_at === firstRow.acknowledged_at,
    JSON.stringify(afterBatch)
  );
  check("ack-all on nothing open writes no audit row", auditRows(env, "alert.acknowledged_all").length === 0);
}

/* ── 3. a pre-column acknowledgement reads as unknown, not empty ──────── */

{
  const env = makeEnv();
  const id = "alert_ack_legacy";
  insertAlert(env, id, { acknowledgedAt: NOW - 3_600_000, acknowledgedBy: null });

  const response = await handleAlertsList(env, new URL(`https://worker.invalid/v1/admin/alerts?all=1`));
  const body = await response.json();
  const row = (body.alerts ?? []).find((alert) => alert.id === id);

  check("the historical alert is listed", row !== undefined, JSON.stringify(body));
  check(
    "an old row reports null, meaning unknown",
    row !== undefined && row.acknowledged_by === null,
    JSON.stringify(row)
  );
  check(
    "the unknown actor is not an empty string",
    row !== undefined && row.acknowledged_by !== "",
    JSON.stringify(row)
  );
  check(
    "the historical acknowledgement time is still there",
    row !== undefined && row.acknowledged_at === NOW - 3_600_000,
    JSON.stringify(row)
  );
}

/* ── 4. message rows carry the conversation's session state and window ── */

{
  const env = makeEnv();
  const windowExpiresAt = NOW + 12 * 3_600_000;

  env.DB.raw
    .prepare(
      `INSERT INTO conversations
         (id, channel, account_id, peer_id, session_state, window_expires_at,
          last_inbound_at, created_at, updated_at)
       VALUES ('conv_check_1', 'whatsapp', 'default', '+15550001111', 'WINDOW_OPEN', ?, ?, ?, ?)`
    )
    .run(windowExpiresAt, NOW - 1_000, NOW - 10_000, NOW - 1_000);

  env.DB.raw
    .prepare(
      `INSERT INTO messages
         (id, device_id, local_id, direction, peer, body, received_at, channel, conversation_id)
       VALUES ('msg_conv_1', ?, 'local_conv_1', 'in', '+15550001111', 'hello', ?, 'whatsapp', 'conv_check_1')`
    )
    .run(DEVICE_ID, NOW - 500);

  env.DB.raw
    .prepare(
      `INSERT INTO messages
         (id, device_id, local_id, direction, peer, body, received_at, channel)
       VALUES ('msg_sms_1', ?, 'local_sms_1', 'in', '+15550002222', 'plain sms', ?, 'sms')`
    )
    .run(DEVICE_ID, NOW - 400);

  const response = await handleMessagesList(
    env,
    new URL(`https://worker.invalid/v1/messages?device_id=${DEVICE_ID}&limit=10`)
  );
  const body = await response.json();
  const withConversation = (body.messages ?? []).find((message) => message.id === "msg_conv_1");
  const withoutConversation = (body.messages ?? []).find((message) => message.id === "msg_sms_1");

  check(
    "a message on a conversation returns its session_state",
    withConversation !== undefined && withConversation.session_state === "WINDOW_OPEN",
    JSON.stringify(withConversation)
  );
  check(
    "a message on a conversation returns its window expiry",
    withConversation !== undefined && withConversation.window_expires_at === windowExpiresAt,
    JSON.stringify(withConversation)
  );
  check(
    "both message kinds are listed",
    withConversation !== undefined && withoutConversation !== undefined,
    JSON.stringify(body)
  );
  check(
    "a message with no conversation returns null state and window",
    withoutConversation !== undefined &&
      withoutConversation.session_state === null &&
      withoutConversation.window_expires_at === null,
    JSON.stringify(withoutConversation)
  );
  check(
    "the no-conversation row still carries both fields",
    withoutConversation !== undefined &&
      "session_state" in withoutConversation &&
      "window_expires_at" in withoutConversation,
    JSON.stringify(withoutConversation)
  );
}

console.log("");
if (failures.length > 0) {
  console.log(`${failures.length} failure(s); ${passed} check(s) passed`);
  process.exitCode = 1;
} else {
  console.log(`ALERT AUDIT PASSED — ${passed} checks`);
}
