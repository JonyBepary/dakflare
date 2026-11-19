#!/usr/bin/env node
/**
 * Agent sessions — pass 4 policy checks.
 *
 * Exercises the real `Sessions` capability through the in-memory SQL seam in
 * `agent-capability-harness.mjs`, plus the small policy layer in
 * `src/agent/conversation.ts` that the runtime calls. No Workers, no model.
 *
 * Asserted:
 *   - two turns from the same actor land in one conversation;
 *   - a retry with the same message id does not duplicate;
 *   - a finished turn's answer is replayable without re-running;
 *   - history selects the newest messages within a byte budget and reports
 *     them newest-first.
 *
 * Run: node --experimental-strip-types src/lib/__checks__/agent-sessions.mjs
 */

import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createCapabilityHost } from "./agent-capability-harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function resolveExtensionless(specifier, context, nextResolve) {
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

const {
  appendTurnMessages,
  conversationIdFor,
  readHistoryNewestFirst,
  readTurnAnswer,
  recordTurnAnswer,
  toChatHistory,
  turnMessageId,
} = await import("../../agent/conversation.ts");
const { Sessions } = await import("agents/sessions");

const harness = await createCapabilityHost();
const sessions = new Sessions();
harness.lifecycle.use(sessions);
await harness.lifecycle.start();

// The runtime chooses this id for the socket path and for `say()`. Both go
// through the same function, so one operator has one memory across transports.
const conversationId = conversationIdFor("alice");
check(
  "the socket path and say() resolve the same conversation",
  conversationId === conversationIdFor("alice") && conversationId === "conversation:v2:alice"
);

const session = sessions.session(conversationId);

/* ── 1. two turns, one conversation ─────────────────────────────────── */

await appendTurnMessages(session, "turn-1", [
  { role: "user", content: "first question" },
  { role: "assistant", content: '{"answer":"first answer","calls":[]}' },
]);
await recordTurnAnswer(session, "turn-1", "first answer");

await appendTurnMessages(session, "turn-2", [
  { role: "user", content: "second question" },
  { role: "assistant", content: '{"answer":"second answer","calls":[]}' },
]);
await recordTurnAnswer(session, "turn-2", "second answer");

const conversationRows = harness.db
  .prepare("SELECT session_id, COUNT(*) AS n FROM cf_agents_session_messages GROUP BY session_id")
  .all();
check(
  "two turns from the same actor land in one conversation",
  conversationRows.length === 1 && conversationRows[0].session_id === conversationId,
  JSON.stringify(conversationRows)
);
check(
  "both turns' messages are present",
  Number(conversationRows[0]?.n) === 6,
  `rows ${conversationRows[0]?.n}`
);

/* ── 2. a retry with the same id does not duplicate ──────────────────── */

const before = Number(
  harness.db.prepare("SELECT COUNT(*) AS n FROM cf_agents_session_messages").get().n
);
await appendTurnMessages(session, "turn-2", [
  { role: "user", content: "second question" },
  { role: "assistant", content: '{"answer":"second answer","calls":[]}' },
]);
const after = Number(
  harness.db.prepare("SELECT COUNT(*) AS n FROM cf_agents_session_messages").get().n
);
check("a retried turn appends no duplicate messages", before === after, `${before} → ${after}`);

const retried = await session.appendMessage({
  id: turnMessageId("turn-2", 0),
  role: "user",
  parts: [{ type: "text", text: "a different body" }],
});
check(
  "a repeated message id is an idempotent no-op",
  retried.inserted === false && retried.message.parts[0].text === "second question"
);

/* ── 3. a finished turn replays from storage ─────────────────────────── */

check("a finished turn's answer is replayable", (await readTurnAnswer(session, "turn-1")) === "first answer");
check("an unknown turn has no replayed answer", (await readTurnAnswer(session, "turn-absent")) === null);

/* ── 4. newest-first inside the byte budget ──────────────────────────── */

// Fresh session: long messages make the budget select only the newest few.
const budgetSession = sessions.session(conversationIdFor("bob"));
for (let index = 0; index < 12; index++) {
  await budgetSession.appendMessage({
    id: `budget:m${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    parts: [{ type: "text", text: `message-${index}-${"x".repeat(60)}` }],
  });
}

const budget = 300;
const recent = await readHistoryNewestFirst(budgetSession, budget);
const ids = recent.messages.map((message) => message.id);
check(
  "history is newest-first",
  ids.length > 0 && ids[0] === "budget:m11" && ids[ids.length - 1] === `budget:m${12 - ids.length}`,
  ids.join(",")
);
check("the byte budget truncates older messages", recent.truncated === true && ids.length < 12);
check(
  "the selected window fits the budget (newest row always included)",
  recent.totalContentBytes > budget || recent.messages.length <= 3,
  `bytes ${recent.totalContentBytes}, rows ${recent.messages.length}`
);

const prompt = toChatHistory(recent.messages);
check(
  "the prompt view is chronological and user/assistant only",
  prompt.length === ids.length &&
    prompt[0].content.startsWith("message-") &&
    prompt.at(-1).content.startsWith("message-11")
);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exitCode = 1;
}
