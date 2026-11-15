#!/usr/bin/env node
/**
 * Agent turn streams — the client's resume contract.
 *
 * Asserted:
 *   - the first frame of a turn is `turn`, and its streamId is exactly
 *     `streamIdFor(idempotencyKey)` (so the client can construct it too);
 *   - `status` frames bracket each model call and each tool;
 *   - a slow model call emits `waiting` heartbeats (10 s default);
 *   - a read from seq 0 of an open stream tails frames appended after it
 *     caught up, and still ends when the stream closes;
 *   - an idle SSE response ends with `event: timeout`;
 *   - a closed stream still ends with `event: done`.
 *
 * The Streams capability is the real one from the SDK, driven through the
 * in-memory SQL seam in `agent-capability-harness.mjs`.
 *
 * Run: node --experimental-strip-types src/lib/__checks__/agent-turn-stream.mjs
 */

import { createCapabilityHost } from "./agent-capability-harness.mjs";

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

const { streamIdFor, turnFrame, streamSseResponse } = await import("../agent-runtime.ts");
const { runTurn, WAITING_HEARTBEAT_MS } = await import("../../agent/loop.ts");

/* ── 1. the announcement and the id the client can build ─────────────── */

{
  const key = "ask-42";
  const announced = turnFrame(key, "conversation:alice");
  check(
    "the turn frame names the stream, key and conversation",
    announced.type === "turn" &&
      announced.streamId === streamIdFor(key) &&
      announced.idempotencyKey === key &&
      announced.conversationId === "conversation:alice",
    JSON.stringify(announced)
  );
  check(
    "the announced id equals streamIdFor(key)",
    announced.streamId === "turn:ask-42",
    announced.streamId
  );
  const longKey = "k".repeat(400);
  check(
    "a long key folds to a stable short id under the Streams ceiling",
    streamIdFor(longKey) === streamIdFor(longKey) &&
      streamIdFor(longKey).length <= 256,
    streamIdFor(longKey)
  );
}

/* ── 2. status frames bracket the model call and each tool ───────────── */

{
  const frames = [];
  let calls = 0;
  let lastBeforeCall = null;
  const adapter = {
    async chat() {
      calls += 1;
      lastBeforeCall = frames.at(-1);
      if (calls === 1) {
        return {
          text: JSON.stringify({
            answer: "",
            calls: [{ tool: "echo", input: { value: "x" } }],
          }),
          tokensIn: 1,
          tokensOut: 1,
        };
      }
      return { text: JSON.stringify({ answer: "done", calls: [] }), tokensIn: 1, tokensOut: 1 };
    },
  };
  const journal = {
    nextTurn: () => 1,
    setTurn: () => {},
    finishTurn: () => {},
  };
  const tools = [
    {
      name: "echo",
      description: "echo",
      kind: "read",
      parameters: {},
      async execute() {
        return { ok: true, output: "ok" };
      },
    },
  ];

  const result = await runTurn(
    {},
    { userId: "u1", label: "alice", role: "admin", canGrantOwner: true },
    "s1",
    "go",
    tools,
    {
      model: adapter,
      journal,
      budget: { chargeTokens: async () => {} },
      idempotencyKey: "ask-42",
      onEvent: (frame) => frames.push(frame),
    }
  );

  check("the turn answers", result.stopped === "answer" && result.answer === "done");
  check(
    "the first frame before the model call is status thinking",
    frames[0]?.type === "status" &&
      frames[0]?.phase === "thinking" &&
      lastBeforeCall?.type === "status" &&
      lastBeforeCall?.phase === "thinking",
    JSON.stringify(frames.slice(0, 2))
  );

  const indexOf = (predicate) => frames.findIndex(predicate);
  const toolStatus = indexOf((f) => f.type === "status" && f.phase === "tool:echo");
  const toolFrame = indexOf((f) => f.type === "tool");
  check(
    "status tool:<name> precedes the tool frame",
    toolStatus !== -1 && toolFrame !== -1 && toolStatus < toolFrame,
    `status@${toolStatus} tool@${toolFrame}`
  );
  const answering = frames.at(-2);
  const answer = frames.at(-1);
  check(
    "status answering precedes the answer frame",
    answering?.type === "status" && answering?.phase === "answering" && answer?.type === "answer",
    JSON.stringify(frames.slice(-2))
  );
}

/* ── 3. a slow model call heartbeats instead of going silent ─────────── */

{
  const frames = [];
  const adapter = {
    async chat() {
      // The failure this guards: 25 s of model silence. At the real 10 s
      // cadence that must produce at least two `waiting` frames.
      await new Promise((resolve) => setTimeout(resolve, 25_000));
      return {
        text: JSON.stringify({ answer: "slow but alive", calls: [] }),
        tokensIn: 1,
        tokensOut: 1,
      };
    },
  };
  const journal = { nextTurn: () => 1, setTurn: () => {}, finishTurn: () => {} };
  const result = await runTurn(
    {},
    { userId: "u1", label: "alice", role: "admin", canGrantOwner: true },
    "slow",
    "go",
    [],
    {
      model: adapter,
      journal,
      budget: { chargeTokens: async () => {} },
      idempotencyKey: "slow-turn",
      onEvent: (frame) => frames.push(frame),
    }
  );

  const waiting = frames.filter((frame) => frame.type === "status" && frame.phase === "waiting");
  const thinkingIndex = frames.findIndex((frame) => frame.type === "status" && frame.phase === "thinking");
  const answeringIndex = frames.findIndex((frame) => frame.type === "status" && frame.phase === "answering");
  const lastWaitingIndex = frames.map((frame) => frame.phase).lastIndexOf("waiting");
  check("the default waiting heartbeat is 10 s", WAITING_HEARTBEAT_MS === 10_000, String(WAITING_HEARTBEAT_MS));
  check("a slow model call emits at least two waiting frames", waiting.length >= 2, `${waiting.length} waiting`);
  check(
    "waiting frames sit between thinking and answering",
    thinkingIndex !== -1 &&
      answeringIndex !== -1 &&
      lastWaitingIndex > thinkingIndex &&
      lastWaitingIndex < answeringIndex,
    `thinking@${thinkingIndex} waiting@${lastWaitingIndex} answering@${answeringIndex}`
  );
  check("the slow turn still answers", result.answer === "slow but alive", result.answer);
}

/* ── a capability host for the stream checks ─────────────────────────── */

const { Streams } = await import("agents/streams");
const harness = await createCapabilityHost();
const streams = new Streams();
harness.lifecycle.use(streams);
await harness.lifecycle.start();

/* ── 4. the turn frame is the stream's first chunk ───────────────────── */

{
  const key = "ask-42";
  const writer = await streams.open(streamIdFor(key), {
    tag: "conversation:alice",
    metadata: { turn: key, actor: "alice" },
  });
  writer.append(turnFrame(key, "conversation:alice"));
  writer.append({ type: "status", phase: "thinking" });
  writer.close();

  const chunks = [];
  for await (const chunk of streams.read(streamIdFor(key))) chunks.push(chunk);
  check(
    "the announced turn frame is the first durable chunk",
    chunks.length === 2 &&
      chunks[0].chunk.type === "turn" &&
      chunks[0].chunk.streamId === streamIdFor(key),
    JSON.stringify(chunks.map((entry) => entry.chunk.type))
  );
}

/* ── 5. a read from 0 tails an open stream ───────────────────────────── */

{
  const id = "turn:live-tail";
  const writer = await streams.open(id, { tag: "conversation:alice" });
  const seen = [];

  const readDone = (async () => {
    for await (const chunk of streams.read(id, { from: 0 })) seen.push(chunk);
  })();

  const until = (count) =>
    new Promise((resolve, reject) => {
      const started = Date.now();
      const poll = () => {
        if (seen.length >= count) resolve();
        else if (Date.now() - started > 2_000) reject(new Error(`saw ${seen.length}/${count}`));
        else setTimeout(poll, 1);
      };
      poll();
    });

  writer.append({ type: "turn", streamId: id });
  await until(1);
  writer.append({ type: "status", phase: "thinking" });
  await until(2);

  check(
    "frames appended after the reader caught up arrive live",
    seen.length === 2 && seen[1].chunk.phase === "thinking",
    JSON.stringify(seen.map((entry) => entry.chunk.type))
  );

  writer.append({ type: "answer", text: "late" });
  writer.close();
  await readDone;
  check(
    "the live read ends at the stream's close",
    seen.length === 3 && seen[2].chunk.type === "answer",
    JSON.stringify(seen.map((entry) => entry.chunk.type))
  );
}

/* ── 6. an idle SSE stream times out; a closed one says done ─────────── */

async function readResponse(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

{
  const id = "turn:idle";
  const writer = await streams.open(id, { tag: "conversation:alice" });
  writer.append(turnFrame("idle", "conversation:alice"));

  const text = await readResponse(
    streamSseResponse(streams, id, new Request(`http://local/streams/${id}?from=0`), {
      idleMs: 60,
    })
  );
  check("the idle stream delivered its replayed frame", text.includes('"type":"turn"'), text);
  check("an idle open stream ends with event: timeout", text.includes("event: timeout"), text);
  check("an idle stream does not claim done", !text.includes("event: done"), text);

  writer.close();
  const closed = await readResponse(
    streamSseResponse(streams, id, new Request(`http://local/streams/${id}?from=0`), {
      idleMs: 60,
    })
  );
  check(
    "a closed stream replays from 0 and ends with event: done",
    closed.includes('id: 0') && closed.includes("event: done") && !closed.includes("timeout"),
    closed.slice(-80)
  );
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exitCode = 1;
}
