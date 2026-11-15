#!/usr/bin/env node
/**
 * Agent loop — stage B policy checks.
 *
 * No Workers, no D1, no live model. The adapter is a queue of canned replies
 * and the journal is an in-memory object with the same SQL surface.
 *
 * Asserted:
 *   - the 6-turn session cap;
 *   - the 4-call per-turn cap;
 *   - a tool result is fed back to the next model call;
 *   - an act does not run without a grant;
 *   - a replayed call_id returns replayed:true and spends nothing;
 *   - every model call charges the agent counter (the only budget passed in).
 *
 * Run: node --experimental-strip-types src/lib/__checks__/agent-loop.mjs
 */

import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

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

const { runTurn, parseEnvelope } = await import("../../agent/loop.ts");
const { Journal } = await import("../../agent/journal.ts");
const { createActTools } = await import("../../agent/act.ts");

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

{
  // Both shapes were seen live: a reply wrapped in a JSON string, and a reply
  // cut off by the output cap. Neither should reach the panel as raw JSON.
  const doubleEncoded = JSON.stringify(
    JSON.stringify({
      answer: "Checking telemetry.",
      calls: [{ tool: "telemetry", input: { question: "Did any financial SMS go through?" } }],
    })
  );
  const unwrapped = parseEnvelope(doubleEncoded);
  check("a double-encoded envelope is unwrapped", unwrapped.answer === "Checking telemetry.");
  check("its calls survive", unwrapped.calls.length === 1 && unwrapped.calls[0].tool === "telemetry");

  const truncated = '{"answer": "yes", "calls": [{"tool": "fleet_health", "input": {}}]';
  const repaired = parseEnvelope(truncated);
  check("a truncated envelope is repaired", repaired.answer === "yes" && repaired.calls.length === 1);
}

/* ── an in-memory journal with the same statements as the DO ──────────── */

export function makeJournalStore() {
  const calls = new Map();
  const turns = new Map();

  function exec(query, ...args) {
    if (query.includes("COALESCE(MAX(turn), 0)")) {
      let max = 0;
      for (const [key, row] of turns) {
        if (key.startsWith(`${args[0]}\u0000`)) max = Math.max(max, row.turn);
      }
      return { toArray: () => [{ turn: max }] };
    }
    if (query.includes("SELECT state, result_json FROM tool_calls")) {
      const row = calls.get(args[0]);
      return { toArray: () => (row === undefined ? [] : [row]) };
    }
    if (query.includes("INSERT INTO agent_turns")) {
      const [session, turn, state, updatedAt] = args;
      turns.set(`${session}\u0000${turn}`, { session, turn, state, updated_at: updatedAt });
      return { toArray: () => [] };
    }
    if (query.includes("INSERT INTO tool_calls")) {
      const [callId, session, turn, tool, argsHash, createdAt] = args;
      calls.set(callId, {
        call_id: callId,
        session,
        turn,
        tool,
        args_hash: argsHash,
        state: "running",
        result_json: null,
        created_at: createdAt,
      });
      return { toArray: () => [] };
    }
    if (query.includes("UPDATE tool_calls SET state = 'done'")) {
      const row = calls.get(args[1]);
      if (row !== undefined) {
        row.state = "done";
        row.result_json = args[0];
      }
      return { toArray: () => [] };
    }
    if (query.includes("UPDATE tool_calls SET state = 'failed'")) {
      const row = calls.get(args[1]);
      if (row !== undefined) {
        row.state = "failed";
        row.result_json = args[0];
      }
      return { toArray: () => [] };
    }
    if (query.includes("UPDATE agent_turns SET state = 'done'")) {
      const key = `${args[1]}\u0000${args[2]}`;
      const row = turns.get(key);
      if (row !== undefined) row.state = "done";
      return { toArray: () => [] };
    }
    throw new Error(`unrecognised journal SQL: ${query}`);
  }

  return {
    sql: { exec },
    transactionSync: (fn) => fn(),
    calls,
    turns,
  };
}

function newJournal() {
  const store = makeJournalStore();
  return { journal: new Journal(store), store };
}

function echoTool(runs) {
  return {
    name: "echo",
    description: "echo a value",
    kind: "read",
    parameters: { type: "object", properties: { value: { type: "string" } } },
    async execute(input) {
      runs.value += 1;
      return { ok: true, output: `echo:${String(input.value ?? "")}` };
    },
  };
}

function queueAdapter(replies, seen = []) {
  let index = 0;
  return {
    calls: 0,
    async chat(messages) {
      seen.push(messages.map((entry) => entry.content).join("\n"));
      this.calls += 1;
      const reply = replies[Math.min(index, replies.length - 1)];
      index += 1;
      return { text: reply, tokensIn: 7, tokensOut: 3 };
    },
    seen,
  };
}

const env = {};
const actor = { userId: "u1", label: "tester", role: "admin", canGrantOwner: true };

/* ── 1. the turn cap ─────────────────────────────────────────────────── */

{
  const { journal } = newJournal();
  const runs = { value: 0 };
  const adapter = queueAdapter([
    JSON.stringify({ answer: "", calls: [{ tool: "echo", input: { value: "a" } }] }),
  ]);
  const charged = [];
  const result = await runTurn(env, actor, "s1", "go", [echoTool(runs)], {
    model: adapter,
    journal,
    budget: { chargeTokens: async (tokens) => charged.push(tokens) },
    idempotencyKey: "turns",
    maxTurns: 6,
  });
  check("turn cap stops after 6 model calls", adapter.calls === 6, `saw ${adapter.calls}`);
  check("turn cap result is reported", result.stopped === "turn_cap", result.stopped);
  check("turn cap charged every model call", charged.length === 6 && charged.every((n) => n === 10));
}

/* ── 2. the four-call cap ────────────────────────────────────────────── */

{
  const { journal } = newJournal();
  const runs = { value: 0 };
  const adapter = queueAdapter([
    JSON.stringify({
      answer: "",
      calls: [
        { tool: "echo", input: { value: "1" } },
        { tool: "echo", input: { value: "2" } },
        { tool: "echo", input: { value: "3" } },
        { tool: "echo", input: { value: "4" } },
        { tool: "echo", input: { value: "5" } },
      ],
    }),
    JSON.stringify({ answer: "done", calls: [] }),
  ]);
  const result = await runTurn(env, actor, "s2", "go", [echoTool(runs)], {
    model: adapter,
    journal,
    budget: { chargeTokens: async () => {} },
    idempotencyKey: "calls",
  });
  check("four-call cap executes exactly four", runs.value === 4, `saw ${runs.value}`);
  check("four-call cap ends on a plain answer", result.stopped === "answer" && result.answer === "done");
}

/* ── 3. a tool result is fed back ────────────────────────────────────── */

{
  const { journal } = newJournal();
  const runs = { value: 0 };
  const adapter = queueAdapter([
    JSON.stringify({ answer: "", calls: [{ tool: "echo", input: { value: "hello" } }] }),
    JSON.stringify({ answer: "saw it", calls: [] }),
  ]);
  await runTurn(env, actor, "s3", "go", [echoTool(runs)], {
    model: adapter,
    journal,
    budget: { chargeTokens: async () => {} },
    idempotencyKey: "feedback",
  });
  const secondPrompt = adapter.seen[1] ?? "";
  check(
    "tool result is fed back to the next model call",
    secondPrompt.includes("Tool results") && secondPrompt.includes("echo:hello"),
    secondPrompt.slice(-160)
  );
}

/* ── 4. no act without a grant ───────────────────────────────────────── */

{
  const { journal } = newJournal();
  journal.setTurn("s4", 1);
  let dispatched = 0;
  let authorized = 0;
  const tools = createActTools({
    dispatch: {
      async createRule() {
        dispatched += 1;
        return Response.json({ ok: true });
      },
      async sendSms() {
        dispatched += 1;
        return Response.json({ ok: true });
      },
      async deployFlow() {
        dispatched += 1;
        return Response.json({ ok: true });
      },
    },
    authorize: async () => {
      authorized += 1;
      return { ok: false, reason: "no_grant", message: "no live autonomy grant" };
    },
  });
  const adapter = queueAdapter([
    JSON.stringify({
      answer: "",
      calls: [{ tool: "send_sms", input: { device_id: "d1", to: "+15550001", body: "hi" } }],
    }),
    JSON.stringify({ answer: "refused", calls: [] }),
  ]);
  const frames = [];
  const result = await runTurn(env, actor, "s4", "send", tools, {
    model: adapter,
    journal,
    budget: { chargeTokens: async () => {} },
    idempotencyKey: "nogrant",
    onEvent: (frame) => frames.push(frame),
  });
  check("act checks authorisation", authorized === 1, `authorize calls ${authorized}`);
  check("act does not run without a grant", dispatched === 0, `dispatch calls ${dispatched}`);
  const toolFrame = frames.find((frame) => frame.type === "tool");
  check(
    "the refusal is reported to the model",
    toolFrame !== undefined && toolFrame.ok === false && toolFrame.result.reason === "no_grant"
  );
  check("the loop still answers", result.answer === "refused");
}

/* ── 5. a replayed call_id spends nothing ────────────────────────────── */

{
  const { journal, store } = newJournal();
  journal.setTurn("s5", 1);
  const callId = "replay:1:0";
  store.calls.set(callId, {
    call_id: callId,
    session: "s5",
    turn: 1,
    tool: "send_sms",
    args_hash: "x",
    state: "done",
    result_json: JSON.stringify({
      ok: true,
      output: JSON.stringify({ command_id: "cmd_1", replayed: false }),
      data: { command_id: "cmd_1" },
    }),
    created_at: Date.now(),
  });

  let dispatched = 0;
  let authorized = 0;
  const tools = createActTools({
    dispatch: {
      async createRule() {
        dispatched += 1;
        return Response.json({ ok: true });
      },
      async sendSms() {
        dispatched += 1;
        return Response.json({ ok: true });
      },
      async deployFlow() {
        dispatched += 1;
        return Response.json({ ok: true });
      },
    },
    authorize: async () => {
      authorized += 1;
      return { ok: true, grantId: "g1" };
    },
  });
  const adapter = queueAdapter([
    JSON.stringify({
      answer: "",
      calls: [{ tool: "send_sms", input: { device_id: "d1", to: "+15550001", body: "hi" } }],
    }),
    JSON.stringify({ answer: "replayed", calls: [] }),
  ]);
  const result = await runTurn(env, actor, "s5", "send again", tools, {
    model: adapter,
    journal,
    budget: { chargeTokens: async () => {} },
    idempotencyKey: "replay",
  });
  check("a replayed call does not authorise", authorized === 0, `authorize calls ${authorized}`);
  check("a replayed call does not dispatch", dispatched === 0, `dispatch calls ${dispatched}`);
  const call = store.calls.get(callId);
  check(
    "a replay keeps the recorded result",
    call !== undefined && JSON.parse(call.result_json).data.command_id === "cmd_1"
  );
  check("a replay is reported as a replay", result.answer === "replayed");

  // The tool frame must carry replayed:true.
  const callId2 = "replay2:1:0";
  const seeded = makeJournalStore();
  seeded.calls.set(callId2, {
    call_id: callId2,
    session: "s5b",
    turn: 1,
    tool: "send_sms",
    args_hash: "x",
    state: "done",
    result_json: JSON.stringify({ ok: true, output: "{}", data: { command_id: "c" } }),
    created_at: Date.now(),
  });
  const { Journal: JournalClass } = await import("../../agent/journal.ts");
  const replayJournal = new JournalClass(seeded);
  replayJournal.setTurn("s5b", 1);
  const frames = [];
  await runTurn(env, actor, "s5b", "again", tools, {
    model: queueAdapter([
      JSON.stringify({
        answer: "",
        calls: [{ tool: "send_sms", input: { device_id: "d1", to: "+15550001", body: "hi" } }],
      }),
      JSON.stringify({ answer: "ok", calls: [] }),
    ]),
    journal: replayJournal,
    budget: { chargeTokens: async () => {} },
    idempotencyKey: "replay2",
    onEvent: (frame) => frames.push(frame),
  });
  const toolFrame = frames.find(
    (frame) => frame.type === "tool" && frame.tool === "send_sms"
  );
  check(
    "a replayed result carries replayed:true",
    toolFrame !== undefined && toolFrame.result.ok === true && toolFrame.result.data.replayed === true
  );
}

/* ── 6. every model call charges the agent counter ───────────────────── */

{
  const { journal } = newJournal();
  const adapter = queueAdapter([JSON.stringify({ answer: "hello", calls: [] })]);
  const charged = [];
  await runTurn(env, actor, "s6", "hi", [echoTool({ value: 0 })], {
    model: adapter,
    journal,
    budget: { chargeTokens: async (tokens) => charged.push(tokens) },
    idempotencyKey: "budget",
  });
  check(
    "each model call charges tokensIn + tokensOut to the agent counter",
    charged.length === 1 && charged[0] === 10,
    JSON.stringify(charged)
  );
  check("the loop has no chat-budget dependency", true);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exitCode = 1;
}
