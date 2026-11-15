#!/usr/bin/env node
/**
 * Agent loop — native tool-calling checks.
 *
 * No Workers, no D1, no live model. The adapter is a scripted streaming fake
 * (or a plain `chat()` fake) and the journal is an in-memory object with the
 * same SQL surface.
 *
 * Asserted:
 *   - prose deltas arrive as `token` frames before the tool runs;
 *   - a tool result is appended as a `tool` message (with its call id) and the
 *     next round answers;
 *   - the 6-turn session cap and the 4-call per-turn cap still hold;
 *   - a malformed `function.arguments` string becomes a `bad_arguments` refusal
 *     returned to the model instead of a throw;
 *   - an act does not run without a grant, and its refusal is fed back;
 *   - a replayed call_id returns replayed:true and spends nothing;
 *   - every model call charges the agent counter (the only budget passed in).
 *
 * Run: node --experimental-strip-types src/lib/__checks__/agent-loop.mjs
 */

import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

const { runTurn } = await import("../../agent/loop.ts");
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

function toolCall(name, args, id) {
  return {
    id: id ?? `call_${name}`,
    name,
    arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
  };
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

function echoTool(runs, onRun) {
  return {
    name: "echo",
    description: "echo a value",
    kind: "read",
    parameters: { type: "object", properties: { value: { type: "string" } } },
    async execute(input) {
      runs.value += 1;
      onRun?.(input);
      return { ok: true, output: `echo:${String(input.value ?? "")}` };
    },
  };
}

/** A streaming fake: each round is an array of deltas plus optional calls. */
function streamingAdapter(rounds, seen = []) {
  let index = 0;
  return {
    calls: 0,
    async chat() {
      throw new Error("the streaming fake must be driven through chatStream");
    },
    async chatStream(messages, options, onEvent) {
      seen.push({ messages: messages.map((entry) => ({ ...entry })), options });
      const round = rounds[Math.min(index, rounds.length - 1)];
      index += 1;
      this.calls += 1;
      let text = "";
      for (const delta of round.tokens ?? []) {
        text += delta;
        onEvent({ type: "token", text: delta });
      }
      return {
        text,
        tokensIn: 7,
        tokensOut: 3,
        ...(round.toolCalls === undefined ? {} : { toolCalls: round.toolCalls }),
      };
    },
    seen,
  };
}

const env = {};
const actor = { userId: "u1", label: "tester", role: "admin", canGrantOwner: true };

/* ── 1. tokens stream before the tool runs, and the result is fed back ── */

{
  const { journal } = newJournal();
  const runs = { value: 0 };
  let framesAtRun = [];
  const frames = [];
  const adapter = streamingAdapter([
    {
      tokens: ["Checking", " telemetry."],
      toolCalls: [toolCall("echo", { value: "hello" }, "call_echo_1")],
    },
    { tokens: ["saw it"] },
  ]);
  const result = await runTurn(env, actor, "s1", "go", [
    echoTool(runs, () => {
      framesAtRun = frames.map((frame) => frame.type);
    }),
  ], {
    model: adapter,
    journal,
    budget: { chargeTokens: async () => {} },
    idempotencyKey: "stream",
    onEvent: (frame) => frames.push(frame),
  });

  const tokenFrames = frames.filter((frame) => frame.type === "token");
  check(
    "prose deltas arrive as token frames",
    tokenFrames.length === 3 &&
      tokenFrames[0].text === "Checking" &&
      tokenFrames[1].text === " telemetry.",
    JSON.stringify(tokenFrames)
  );
  check(
    "tokens are emitted before the tool frame",
    frames.findIndex((frame) => frame.type === "token") < frames.findIndex((frame) => frame.type === "tool")
  );
  check(
    "the tool runs only after prose was emitted",
    framesAtRun.includes("token") && !framesAtRun.includes("tool"),
    JSON.stringify(framesAtRun)
  );
  check("the tool executed once", runs.value === 1, String(runs.value));

  const assistant = adapter.seen[1]?.messages.find((entry) => entry.role === "assistant");
  const toolMessage = adapter.seen[1]?.messages.find((entry) => entry.role === "tool");
  check(
    "the assistant message carries the structured call",
    assistant !== undefined &&
      Array.isArray(assistant.toolCalls) &&
      assistant.toolCalls[0].id === "call_echo_1",
    JSON.stringify(assistant?.toolCalls)
  );
  check(
    "the tool result is appended as a tool message with its call id",
    toolMessage !== undefined &&
      toolMessage.toolCallId === "call_echo_1" &&
      toolMessage.name === "echo" &&
      toolMessage.content.includes("echo:hello"),
    JSON.stringify(toolMessage)
  );
  check("the second round answers", result.stopped === "answer" && result.answer === "saw it", result.answer);
  check("the token text assembled into the answer", result.answer === "saw it");
}

/* ── 2. the turn cap ─────────────────────────────────────────────────── */

{
  const { journal } = newJournal();
  const runs = { value: 0 };
  const adapter = streamingAdapter([{ toolCalls: [toolCall("echo", { value: "a" })] }]);
  const charged = [];
  const result = await runTurn(env, actor, "s2", "go", [echoTool(runs)], {
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

/* ── 3. the four-call cap ────────────────────────────────────────────── */

{
  const { journal } = newJournal();
  const runs = { value: 0 };
  const seen = [];
  const adapter = streamingAdapter(
    [
      {
        toolCalls: [
          toolCall("echo", { value: "1" }, "c1"),
          toolCall("echo", { value: "2" }, "c2"),
          toolCall("echo", { value: "3" }, "c3"),
          toolCall("echo", { value: "4" }, "c4"),
          toolCall("echo", { value: "5" }, "c5"),
        ],
      },
      { tokens: ["done"] },
    ],
    seen
  );
  const result = await runTurn(env, actor, "s3", "go", [echoTool(runs)], {
    model: adapter,
    journal,
    budget: { chargeTokens: async () => {} },
    idempotencyKey: "calls",
  });
  check("four-call cap executes exactly four", runs.value === 4, `saw ${runs.value}`);
  const toolMessages = seen[1].messages.filter((entry) => entry.role === "tool");
  check("every called id still gets a tool response", toolMessages.length === 5, String(toolMessages.length));
  check(
    "the withheld call is refused with call_cap",
    toolMessages[4].content.includes("call_cap"),
    toolMessages[4].content
  );
  check("four-call cap ends on a plain answer", result.stopped === "answer" && result.answer === "done");
}

/* ── 4. malformed tool arguments become a refusal, not a throw ───────── */

{
  const { journal } = newJournal();
  const runs = { value: 0 };
  const frames = [];
  const seen = [];
  const adapter = streamingAdapter(
    [
      {
        tokens: ["Trying."],
        toolCalls: [toolCall("echo", "{not json", "call_bad")],
      },
      { tokens: ["understood"] },
    ],
    seen
  );
  const result = await runTurn(env, actor, "s4", "go", [echoTool(runs)], {
    model: adapter,
    journal,
    budget: { chargeTokens: async () => {} },
    idempotencyKey: "badargs",
    onEvent: (frame) => frames.push(frame),
  });
  const toolFrame = frames.find((frame) => frame.type === "tool");
  check(
    "a malformed argument string is a bad_arguments refusal",
    toolFrame !== undefined && toolFrame.ok === false && toolFrame.result.reason === "bad_arguments",
    JSON.stringify(toolFrame)
  );
  check("the malformed call never reached the tool", runs.value === 0, String(runs.value));
  const toolMessage = seen[1].messages.find((entry) => entry.role === "tool");
  check(
    "the refusal is returned to the model as a tool result",
    toolMessage !== undefined && toolMessage.content.includes("bad_arguments"),
    toolMessage?.content
  );
  check("the loop still answers", result.answer === "understood");
}

/* ── 5. no act without a grant ───────────────────────────────────────── */

{
  const { journal } = newJournal();
  journal.setTurn("s5", 1);
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
  const adapter = streamingAdapter([
    {
      toolCalls: [
        toolCall("send_sms", { device_id: "d1", to: "+15550001", body: "hi" }, "call_send"),
      ],
    },
    { tokens: ["refused"] },
  ]);
  const frames = [];
  const result = await runTurn(env, actor, "s5", "send", tools, {
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

/* ── 6. a replayed call_id spends nothing ────────────────────────────── */

{
  const { journal, store } = newJournal();
  journal.setTurn("s6", 1);
  const callId = "replay:1:0";
  store.calls.set(callId, {
    call_id: callId,
    session: "s6",
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
  const adapter = streamingAdapter([
    {
      toolCalls: [
        toolCall("send_sms", { device_id: "d1", to: "+15550001", body: "hi" }, "call_replay"),
      ],
    },
    { tokens: ["replayed"] },
  ]);
  const result = await runTurn(env, actor, "s6", "send again", tools, {
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
    session: "s6b",
    turn: 1,
    tool: "send_sms",
    args_hash: "x",
    state: "done",
    result_json: JSON.stringify({ ok: true, output: "{}", data: { command_id: "c" } }),
    created_at: Date.now(),
  });
  const { Journal: JournalClass } = await import("../../agent/journal.ts");
  const replayJournal = new JournalClass(seeded);
  replayJournal.setTurn("s6b", 1);
  const frames = [];
  await runTurn(env, actor, "s6b", "again", tools, {
    model: streamingAdapter([
      {
        toolCalls: [
          toolCall("send_sms", { device_id: "d1", to: "+15550001", body: "hi" }, "call_replay2"),
        ],
      },
      { tokens: ["ok"] },
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

/* ── 7. every model call charges the agent counter ───────────────────── */

{
  const { journal } = newJournal();
  const adapter = streamingAdapter([{ tokens: ["hello"] }]);
  const charged = [];
  await runTurn(env, actor, "s7", "hi", [echoTool({ value: 0 })], {
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

/* ── 8. an adapter without chatStream still answers once ─────────────── */

{
  const { journal } = newJournal();
  const frames = [];
  const adapter = {
    calls: 0,
    async chat() {
      this.calls += 1;
      return { text: "plain", tokensIn: 1, tokensOut: 2 };
    },
  };
  const result = await runTurn(env, actor, "s8", "hi", [echoTool({ value: 0 })], {
    model: adapter,
    journal,
    budget: { chargeTokens: async () => {} },
    idempotencyKey: "nostream",
    onEvent: (frame) => frames.push(frame),
  });
  check("a non-streaming adapter answers", result.answer === "plain");
  check(
    "a non-streaming adapter emits no token frames",
    frames.every((frame) => frame.type !== "token"),
    JSON.stringify(frames.map((frame) => frame.type))
  );
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exitCode = 1;
}
