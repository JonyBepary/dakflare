#!/usr/bin/env node
/**
 * Agent heartbeat — eviction resistance for a live turn.
 *
 * Drives the real `AssistantAgent` over the in-memory host in
 * `agent-capability-harness.mjs`, and therefore the real `Agent.keepAliveWhile`
 * the runtime now uses in place of the hand-rolled Scheduler heartbeat. Nothing
 * here fakes the ref count or the alarm write.
 *
 * Asserted:
 *   - one turn arms the documented 30 s keep-alive cap (the next alarm);
 *   - two overlapping turns share it and keep it armed;
 *   - the first turn ending does not remove it;
 *   - the last turn ending removes it;
 *   - a throw inside the turn still disposes it.
 *
 * `keepAliveWhile` is genuinely equivalent to the deleted `TurnHeartbeat` for a
 * bare turn: both are an in-memory ref count over a 30 s alarm wake-up, both
 * dispose on success/refusal/throw, and neither survives eviction. The SDK's
 * version is one alarm policy instead of a second Scheduler interval row.
 *
 * Run: node --experimental-strip-types src/lib/__checks__/agent-heartbeat.mjs
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";

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

const { createCapabilityHost } = await import("./agent-capability-harness.mjs");
const { AssistantAgent, TURN_HEARTBEAT_SECONDS } = await import(
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
const agent = new AssistantAgent(harness.ctx, {});
await agent.lifecycle.start();

/** Let the `waitUntil(_syncHostJobs)` disposal write land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

check(
  "the documented keep-alive cadence is 30 s",
  TURN_HEARTBEAT_SECONDS === 30 &&
    AssistantAgent.options.keepAliveIntervalMs === TURN_HEARTBEAT_SECONDS * 1_000,
  JSON.stringify(AssistantAgent.options)
);
check("the heartbeat starts disarmed", agent._keepAliveRefs === 0 && (await harness.storage.getAlarm()) === null);

/* ── one turn arms the keep-alive cap ─────────────────────────────────── */

const firstEntered = deferred();
const firstRelease = deferred();
const first = agent.keepAliveWhile(async () => {
  firstEntered.resolve();
  await firstRelease.promise;
});
await firstEntered.promise;

const firstAlarm = await harness.storage.getAlarm();
const firstDelta = firstAlarm === null ? null : firstAlarm - Date.now();
check(
  "one turn caps the next alarm at the 30 s heartbeat",
  firstDelta !== null && firstDelta > 25_000 && firstDelta <= 30_500,
  String(firstDelta)
);
check("the heartbeat reports one turn in flight", agent._keepAliveRefs === 1);

/* ── two overlapping turns keep the same cap ─────────────────────────── */

const secondEntered = deferred();
const secondRelease = deferred();
const second = agent.keepAliveWhile(async () => {
  secondEntered.resolve();
  await secondRelease.promise;
});
await secondEntered.promise;

const overlapAlarm = await harness.storage.getAlarm();
check("two turns are counted", agent._keepAliveRefs === 2);
check(
  "two overlapping turns still have a 30 s wake-up",
  overlapAlarm !== null && overlapAlarm - Date.now() <= 30_500,
  String(overlapAlarm)
);

firstRelease.resolve();
await first;
await settle();
check("the first turn ending leaves the heartbeat armed", agent._keepAliveRefs === 1);
check(
  "the wake-up survives the first turn",
  (await harness.storage.getAlarm()) !== null,
  String(await harness.storage.getAlarm())
);

/* ── the last turn out disposes it ───────────────────────────────────── */

secondRelease.resolve();
await second;
await settle();
check("the last turn ending disposes the heartbeat", agent._keepAliveRefs === 0);
check("the last turn ending leaves no keep-alive alarm", (await harness.storage.getAlarm()) === null);

/* ── a throw still disposes it ───────────────────────────────────────── */

await assert.rejects(
  agent.keepAliveWhile(async () => {
    throw new Error("turn blew up");
  }),
  /turn blew up/
);
await settle();
check("a throwing turn is disposed", agent._keepAliveRefs === 0);
check("a throwing turn leaves no keep-alive alarm", (await harness.storage.getAlarm()) === null);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exitCode = 1;
}
