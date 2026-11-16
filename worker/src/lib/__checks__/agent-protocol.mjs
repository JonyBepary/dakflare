#!/usr/bin/env node
/**
 * Agent base-class migration — protocol silence and startup ordering.
 *
 * Drives the real `AssistantAgent` and the real `Agent` base class over the
 * in-memory host in `agent-capability-harness.mjs`.
 *
 * Asserted:
 *   - the SDK's protocol frames (`cf_agent_identity`, `cf_agent_state`,
 *     `cf_agent_mcp_servers`) never reach a client: the only frame our
 *     `onConnect` produces is `ready`, and the connection is marked
 *     no-protocol so later broadcasts skip it too;
 *   - the bespoke identity refusal still closes an unauthenticated socket;
 *   - `onStart` (our `MIGRATIONS` ledger) runs before the first request, so a
 *     cold object can answer `__runtime/status` and read `schema_version`;
 *   - the SDK and our ledger own disjoint tables.
 *
 * Run: node --experimental-strip-types src/lib/__checks__/agent-protocol.mjs
 */

import { existsSync } from "node:fs";
import { registerHooks } from "node:module";

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
const { AssistantAgent, AGENT_SCHEMA_VERSION } = await import(
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

const PROTOCOL_TYPES = new Set([
  "cf_agent_identity",
  "cf_agent_state",
  "cf_agent_state_error",
  "cf_agent_mcp_servers",
]);

function fakeConnection(id, frames) {
  return {
    id,
    state: null,
    tags: [id],
    readyState: 1,
    setState(next) {
      this.state = typeof next === "function" ? next(this.state) : next;
      return this.state;
    },
    send(frame) {
      frames.push(JSON.parse(frame));
    },
    close(code, reason) {
      frames.push({ type: "close", code, reason });
    },
  };
}

const headers = {
  "x-dakflare-actor": "u1",
  "x-dakflare-actor-role": "owner",
};

/* ── cold object: onStart migrates before the first request ──────────── */

{
  const harness = await createCapabilityHost();
  const agent = new AssistantAgent(harness.ctx, {});
  check("Lifecycle has not started before the first request", agent.lifecycle.isStarted() === false);

  const response = await agent.fetch(new Request("https://assistant/__runtime/status"));
  const body = await response.json();
  check(
    "the first request is served after onStart",
    response.status === 200 && agent.lifecycle.isStarted() === true,
    JSON.stringify(body)
  );
  check(
    "the status probe read our ledger row",
    body.schemaVersion === AGENT_SCHEMA_VERSION &&
      body.codeVersion === AGENT_SCHEMA_VERSION,
    JSON.stringify(body)
  );

  const tables = new Set(
    harness.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name)
  );
  check(
    "our ledger owns its tables after onStart",
    ["schema_version", "agent_turns", "tool_calls", "agent_messages"].every((name) =>
      tables.has(name)
    ),
    [...tables].sort().join(",")
  );
  check(
    "the SDK owns its cf_agents_* tables",
    tables.has("cf_agents_runs") &&
      tables.has("cf_agents_fibers") &&
      tables.has("cf_agents_state"),
    [...tables].sort().join(",")
  );
  check(
    "the two table sets are disjoint",
    !tables.has("cf_agents_agent_turns") && !tables.has("schema_version_v2"),
    [...tables].sort().join(",")
  );
}

/* ── no SDK protocol frames on the wire ─────────────────────────────── */

{
  const harness = await createCapabilityHost();
  const agent = new AssistantAgent(harness.ctx, {});
  check(
    "the base class will not send protocol frames",
    AssistantAgent.options.sendIdentityOnConnect === false &&
      agent.shouldSendProtocolMessages({}, { request: new Request("https://assistant") }) === false
  );

  const frames = [];
  const connection = fakeConnection("c1", frames);
  await agent.onConnect(connection, {
    request: new Request("https://assistant", { headers }),
  });

  check(
    "the first frame is our ready frame",
    frames.length === 1 && frames[0].type === "ready",
    JSON.stringify(frames)
  );
  check(
    "no cf_agent_* protocol frame reached the client",
    frames.every((frame) => !PROTOCOL_TYPES.has(frame.type)),
    JSON.stringify(frames)
  );
  check(
    "the connection is marked no-protocol for later broadcasts",
    agent.isConnectionProtocolEnabled(connection) === false
  );
  check(
    "ready names the pinned object and the conversation",
    frames[0].name === "assistant" &&
      frames[0].conversation === "conversation:v2:u1",
    JSON.stringify(frames[0])
  );

  const refused = [];
  const anonymous = fakeConnection("c2", refused);
  await agent.onConnect(anonymous, {
    request: new Request("https://assistant"),
  });
  check(
    "an unauthenticated upgrade still closes 1008 with no frame",
    refused.length === 1 &&
      refused[0].type === "close" &&
      refused[0].code === 1008 &&
      refused[0].reason === "agent_identity_missing",
    JSON.stringify(refused)
  );
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exitCode = 1;
}
