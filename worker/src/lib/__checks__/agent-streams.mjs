#!/usr/bin/env node
/**
 * Agent streams — pass 4 checks.
 *
 * Drives the real `Streams` capability through the in-memory SQL seam in
 * `agent-capability-harness.mjs`, with the same open/append/read/settle calls
 * `runtime.ts` makes.
 *
 * Asserted:
 *   - frames appended for one turn keep their order and cursor;
 *   - `read(from)` replays only the tail;
 *   - a second writer on the same id continues the cursor, never resets it;
 *   - closing twice is safe.
 *
 * Run: node --experimental-strip-types src/lib/__checks__/agent-streams.mjs
 */

import assert from "node:assert/strict";
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

const { Streams } = await import("agents/streams");
const harness = await createCapabilityHost();
const streams = new Streams();
harness.lifecycle.use(streams);
await harness.lifecycle.start();

const streamId = "turn:test-turn";
const conversation = "conversation:alice";

const writer = await streams.open(streamId, {
  tag: conversation,
  metadata: { turn: "test-turn", actor: "alice" },
});

const frames = [
  { type: "calls", calls: [{ tool: "telemetry", input: {} }] },
  { type: "tool", tool: "telemetry", ok: true, result: { ok: true, output: "ok" } },
  { type: "answer", text: "the answer" },
];
const seqs = frames.map((frame) => writer.append(frame));
check("frames append in order", JSON.stringify(seqs) === JSON.stringify([0, 1, 2]), seqs.join(","));
check("the writer cursor follows appends", writer.cursor === 3, String(writer.cursor));

/* ── a second writer continues, never resets ─────────────────────────── */

const writer2 = await streams.open(streamId);
check("a second writer starts at the existing cursor", writer2.cursor === 3, String(writer2.cursor));
const fourth = writer2.append({ type: "answer", text: "continued" });
check("the second writer continues the cursor", fourth === 3 && writer2.cursor === 4);

/* ── closing twice is safe ───────────────────────────────────────────── */

writer2.close();
writer2.close();
writer.close();
const status = await streams.status(streamId);
check(
  "closing twice leaves one completed stream",
  status !== null && status.state === "completed" && status.cursor === 4,
  JSON.stringify(status)
);

/* ── replay honours the cursor ───────────────────────────────────────── */

const readAll = [];
for await (const chunk of streams.read(streamId)) readAll.push(chunk);
check(
  "a full read returns every frame in order",
  readAll.length === 4 &&
    readAll[0].chunk.type === "calls" &&
    readAll[3].chunk.type === "answer" &&
    readAll[3].chunk.text === "continued",
  JSON.stringify(readAll.map((entry) => entry.chunk.type))
);

const tail = [];
for await (const chunk of streams.read(streamId, { from: 2 })) tail.push(chunk);
check(
  "read(from) replays only the tail",
  tail.length === 2 && tail[0].seq === 2 && tail[1].seq === 3,
  JSON.stringify(tail.map((entry) => entry.seq))
);

const missing = [];
for await (const chunk of streams.read(streamId, { from: 99 })) missing.push(chunk);
check("read(from) past the tail yields nothing", missing.length === 0);

check(
  "the stream keeps its conversation tag for ownership checks",
  status !== null && status.tag === conversation
);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exitCode = 1;
}
