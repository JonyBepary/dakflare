#!/usr/bin/env node
/**
 * Agent heartbeat — eviction resistance for a live turn.
 *
 * Drives the real `Scheduler` capability through the in-memory Lifecycle in
 * `agent-capability-harness.mjs`, and the real `TurnHeartbeat` from
 * `src/agent/runtime.ts` over it. Nothing here fakes the counter or the job
 * queue.
 *
 * Asserted:
 *   - one turn arms exactly one 30 s repeating `keepalive` job;
 *   - two overlapping turns share that one job and keep it armed;
 *   - the first turn ending does not cancel it;
 *   - the last turn ending disarms it;
 *   - a throw inside the turn still disarms it.
 *
 * The installed `agents@0.33.0` exports the primitive as `agents/schedules`
 * (`agents/scheduler` is not an export). `Scheduler.every()` deduplicates
 * interval schedules by type, callback, owner, payload and interval, which is
 * why one fixed job is enough and cancellation needs a counter.
 *
 * Run: node --experimental-strip-types src/lib/__checks__/agent-heartbeat.mjs
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { createCapabilityHost } from "./agent-capability-harness.mjs";

// `runtime.ts` uses extensionless TS imports and imports the flow wasm at the
// edge of its graph. Node's strip-types loader needs both resolved to load the
// module; this check never runs the flow engine.
const WASM_STUB = "data:text/javascript,export default {}";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith(".wasm")) return { url: WASM_STUB, shortCircuit: true };
    if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) {
      const base = new URL(specifier, context.parentURL);
      for (const extension of [".ts", ".tsx", "/index.ts"]) {
        const candidate = new URL(base.href + extension);
        if (existsSync(new URL(candidate))) return { url: candidate.href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context, nextResolve);
  },
});

const { Scheduler } = await import("agents/schedules");
const { TurnHeartbeat, TURN_HEARTBEAT_SECONDS } = await import(
  new URL("../../agent/runtime.ts", import.meta.url).href
);

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

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const harness = await createCapabilityHost();
const scheduler = new Scheduler({ callbacks: { keepalive: () => {} } });
harness.lifecycle.use(scheduler);
await harness.lifecycle.start();

const heartbeat = new TurnHeartbeat(scheduler);
check("the heartbeat starts disarmed", heartbeat.armed === false && heartbeat.turnsInFlight === 0);

/* ── one turn arms exactly one repeating job ─────────────────────────── */

const firstEntered = deferred();
const firstRelease = deferred();
const first = heartbeat.run(async () => {
  firstEntered.resolve();
  await firstRelease.promise;
});
await firstEntered.promise;

const armedJobs = await scheduler.list();
check(
  "one turn arms exactly one repeating job",
  armedJobs.length === 1 &&
    armedJobs[0].callback === "keepalive" &&
    armedJobs[0].type === "interval" &&
    armedJobs[0].intervalSeconds === TURN_HEARTBEAT_SECONDS,
  JSON.stringify(armedJobs)
);
check("the job fires at the documented 30 s cadence", TURN_HEARTBEAT_SECONDS === 30);
check("the heartbeat reports one turn in flight", heartbeat.turnsInFlight === 1 && heartbeat.armed);
const jobId = armedJobs[0]?.id;

/* ── two overlapping turns keep the same job armed ───────────────────── */

const secondEntered = deferred();
const secondRelease = deferred();
const second = heartbeat.run(async () => {
  secondEntered.resolve();
  await secondRelease.promise;
});
await secondEntered.promise;

const overlapJobs = await scheduler.list();
check(
  "two overlapping turns still have one job",
  overlapJobs.length === 1 && overlapJobs[0].id === jobId,
  JSON.stringify(overlapJobs)
);
check("two turns are counted", heartbeat.turnsInFlight === 2);

firstRelease.resolve();
await first;
check("the first turn ending leaves the heartbeat armed", heartbeat.armed && heartbeat.turnsInFlight === 1);
check(
  "the job survives the first turn",
  (await scheduler.list()).length === 1,
  JSON.stringify(await scheduler.list())
);

/* ── the last turn out disarms it ────────────────────────────────────── */

secondRelease.resolve();
await second;
check("the last turn ending disarms the heartbeat", heartbeat.armed === false && heartbeat.turnsInFlight === 0);
check("the last turn ending cancels the job", (await scheduler.list()).length === 0);

/* ── a throw still disarms it ────────────────────────────────────────── */

await assert.rejects(
  heartbeat.run(async () => {
    throw new Error("turn blew up");
  }),
  /turn blew up/
);
check("a throwing turn is disarmed", heartbeat.armed === false && heartbeat.turnsInFlight === 0);
check("a throwing turn leaves no job behind", (await scheduler.list()).length === 0);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exitCode = 1;
}
