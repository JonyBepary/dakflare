#!/usr/bin/env node
/**
 * Agent act tools — stage C policy checks.
 *
 * The handlers are stubs and the journal is in memory. The grant/cap gate runs
 * through `authorizeActWithStore`'s in-memory store, so the refusals are the
 * real ones, not a mock of them.
 *
 * Asserted:
 *   - create_rule_now forces allow_shortcode:false and device_id:null, and
 *     refuses a regex before anything is dispatched;
 *   - send_sms passes idempotency_key=agent:<callId>;
 *   - deploy_flow sends expected_previous_version;
 *   - the SMS daily cap and the write daily cap each refuse at the limit;
 *   - a revoked grant and an expired grant each refuse.
 *
 * Run: node --experimental-strip-types src/lib/__checks__/agent-act.mjs
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

const { createActTools } = await import("../../agent/act.ts");
const { Journal } = await import("../../agent/journal.ts");
const { authorizeActWithStore } = await import("../../agent/grants.ts");

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
  // With autonomy off, an act becomes a proposal instead of only a refusal: the
  // operator gets one card to accept rather than an act refused per turn.
  const { createActTools } = await import("../../agent/act.ts");
  const staged = [];
  const created = [];
  const tools = createActTools({
    // The refusal is injected through the same seam the other act checks use.
    authorize: async () => ({ ok: false, reason: "autonomy_off", message: "agent autonomy is off" }),
    dispatch: {
      async proposeRule(payload) {
        staged.push(payload);
        return { id: "ap_check" };
      },
      async createRule() {
        created.push(1);
        return Response.json({ id: "r_should_not_exist" });
      },
      async sendSms() { return Response.json({}); },
      async deployFlow() { return Response.json({}); },
    },
  });
  const tool = tools.find((candidate) => candidate.name === "create_rule_now");
  const result = await tool.execute(
    {
      matcher: { type: "exact", value: "BOT" },
      body_matcher: { type: "keyword", value: "ping" },
      reply_template: "pong",
    },
    {
      env: { DB: { prepare() { throw new Error("no db in this check"); } } },
      actor: { userId: "u1", label: "tester", role: "admin", canGrantOwner: true },
      callId: "check:proposal:1",
      journal: {
        async reserve() { return { replay: false }; },
        fail() {},
        finishTurn() {},
      },
      budget: { chargeTokens: async () => {} },
      signal: new AbortController().signal,
    }
  );
  check(
    "offers a proposal when authority is missing",
    result.ok === true && result.data && result.data.proposal_id === "ap_check" && staged.length === 1,
    JSON.stringify(result).slice(0, 160)
  );
  check("and creates nothing", created.length === 0, String(created.length));
}

{
  // A window is per operator. Someone else's live socket must not inherit it,
  // even while the row says enabled.
  const { authorizeActWithStore } = await import("../../agent/grants.ts");
  const baseRow = {
    enabled: 1,
    sms_cap: 5,
    write_cap: 5,
    expires_at: Date.now() + 60_000,
    updated_by: "jony@example.com",
    allow_rules: 1,
    actor: "jony@example.com",
  };
  const store = {
    async readAutonomy() { return baseRow; },
    async readUsage() { return { tokens: 0, writes: 0, sms: 0 }; },
    async chargeUsage() { return "ok"; },
    async refundUsage() {},
    async findGrant() { return { id: "grant_1", scope: "rules:write", target: {} }; },
    async consumeGrant() { return true; },
    async refundGrant() {},
  };
  const mine = await authorizeActWithStore(store, { label: "jony@example.com" }, { kind: "write", scope: "rules:write", target: {} });
  check("the operator who opened the window may act", mine.ok === true, mine.ok ? "ok" : mine.reason);
  const other = await authorizeActWithStore(store, { label: "rae@example.com" }, { kind: "write", scope: "rules:write", target: {} });
  check(
    "another operator does not inherit it",
    other.ok === false && other.reason === "autonomy_other_session",
    other.ok ? "allowed" : other.reason
  );
}

function makeJournalStore() {
  const calls = new Map();
  const turns = new Map();
  function exec(query, ...args) {
    if (query.includes("COALESCE(MAX(turn), 0)")) {
      let max = 0;
      for (const [key, row] of turns) if (key.startsWith(`${args[0]}\u0000`)) max = Math.max(max, row.turn);
      return { toArray: () => [{ turn: max }] };
    }
    if (query.includes("SELECT state, result_json FROM tool_calls")) {
      const row = calls.get(args[0]);
      return { toArray: () => (row === undefined ? [] : [row]) };
    }
    if (query.includes("INSERT INTO agent_turns")) {
      turns.set(`${args[0]}\u0000${args[1]}`, { turn: args[1], state: args[2] });
      return { toArray: () => [] };
    }
    if (query.includes("INSERT INTO tool_calls")) {
      calls.set(args[0], { state: "running", result_json: null });
      return { toArray: () => [] };
    }
    if (query.includes("UPDATE tool_calls SET state = 'done'")) {
      const row = calls.get(args[1]);
      if (row !== undefined) Object.assign(row, { state: "done", result_json: args[0] });
      return { toArray: () => [] };
    }
    if (query.includes("UPDATE tool_calls SET state = 'failed'")) {
      const row = calls.get(args[1]);
      if (row !== undefined) Object.assign(row, { state: "failed", result_json: args[0] });
      return { toArray: () => [] };
    }
    if (query.includes("UPDATE agent_turns SET state = 'done'")) return { toArray: () => [] };
    throw new Error(`unrecognised journal SQL: ${query}`);
  }
  return { sql: { exec }, transactionSync: (fn) => fn(), calls };
}

const env = {};
const actor = { userId: "u1", label: "tester", role: "admin", canGrantOwner: true };

function ctxFor(callId) {
  const journal = new Journal(makeJournalStore());
  journal.setTurn("s", 1);
  return {
    journal,
    ctx: {
      env,
      actor,
      callId,
      journal,
      budget: { chargeTokens: async () => {} },
      signal: new AbortController().signal,
    },
  };
}

function dispatchStub(overrides = {}) {
  const seen = {
    rules: [],
    sms: [],
    flows: [],
  };
  return {
    seen,
    dispatch: {
      async createRule(payload) {
        seen.rules.push(payload);
        return Response.json({ kind: "create_rule", result: { rule_id: payload.id } });
      },
      async sendSms(body) {
        seen.sms.push(body);
        return Response.json({ command_id: "cmd_1", replayed: false });
      },
      async deployFlow(flowId, body) {
        seen.flows.push({ flowId, body });
        return Response.json({ workflow: { id: flowId, version: 2 } });
      },
      ...overrides,
    },
  };
}

const allow = async () => ({ ok: true, grantId: "grant_1" });
const toolsFor = (dispatch) => createActTools({ dispatch, authorize: allow, refund: async () => {} });
const byName = (tools, name) => tools.find((tool) => tool.name === name);

/* ── create_rule_now ─────────────────────────────────────────────────── */

{
  const { seen, dispatch } = dispatchStub();
  const tools = toolsFor(dispatch);
  const { ctx } = ctxFor("rule:1:0");
  const result = await byName(tools, "create_rule_now").execute(
    {
      name: "thanks",
      matcher: { type: "exact", value: "thanks" },
      body_matcher: { type: "keyword", value: "welcome" },
      reply_template: "You are welcome",
    },
    ctx
  );
  const payload = seen.rules[0] ?? {};
  check("create_rule_now succeeded", result.ok === true);
  check("create_rule_now forces allow_shortcode:false", payload.allow_shortcode === false, String(payload.allow_shortcode));
  check("create_rule_now forces device_id:null", payload.device_id === null, String(payload.device_id));
}

{
  const { seen, dispatch } = dispatchStub();
  const tools = toolsFor(dispatch);
  const { ctx } = ctxFor("rule:2:0");
  const result = await byName(tools, "create_rule_now").execute(
    {
      matcher: { type: "regex", value: ".*" },
      body_matcher: { type: "keyword", value: "x" },
      reply_template: "x",
    },
    ctx
  );
  check("create_rule_now refuses a regex", result.ok === false && result.reason === "rule_rejected", JSON.stringify(result));
  check("a refused regex dispatches nothing", seen.rules.length === 0);
}

/* ── send_sms ────────────────────────────────────────────────────────── */

{
  const { seen, dispatch } = dispatchStub();
  const tools = toolsFor(dispatch);
  const { ctx } = ctxFor("sms:9:0");
  const result = await byName(tools, "send_sms").execute(
    { device_id: "dev_1", to: "+15550001", body: "hello" },
    ctx
  );
  check("send_sms succeeded", result.ok === true, JSON.stringify(result));
  check(
    "send_sms passes idempotency_key=agent:<callId>",
    seen.sms[0]?.idempotency_key === "agent:sms:9:0",
    String(seen.sms[0]?.idempotency_key)
  );
}

/* ── deploy_flow ─────────────────────────────────────────────────────── */

{
  const { seen, dispatch } = dispatchStub();
  const tools = toolsFor(dispatch);
  const { ctx } = ctxFor("flow:3:0");
  const result = await byName(tools, "deploy_flow").execute(
    {
      flow_id: "flow_1",
      name: "Main",
      graph: { nodes: [], edges: [] },
      expected_previous_version: 7,
    },
    ctx
  );
  check("deploy_flow succeeded", result.ok === true, JSON.stringify(result));
  check(
    "deploy_flow sends expected_previous_version",
    seen.flows[0]?.body.expected_previous_version === 7,
    String(seen.flows[0]?.body.expected_previous_version)
  );
  check("deploy_flow names the flow", seen.flows[0]?.flowId === "flow_1");
}

/* ── caps and grants through the real gate ───────────────────────────── */

function store(overrides = {}) {
  const autonomy = {
    enabled: 1,
    sms_cap: 2,
    write_cap: 3,
    expires_at: Date.now() + 60_000,
    updated_by: "tester",
    ...overrides.autonomy,
  };
  return {
    readAutonomy: async () => autonomy,
    readUsage: async () => ({ tokens: 0, writes: 0, sms: 0, ...overrides.usage }),
    chargeUsage: async () => overrides.charge ?? "ok",
    refundUsage: async () => {},
    findGrant: async () =>
      overrides.grant === undefined
        ? { id: "g1", agent_token_id: "autonomy:agent", scope: "x", target: {}, granted_by: "t", granted_at: 0, expires_at: autonomy.expires_at, revoked_at: null, use_count: 0, last_used_at: null, approval_request_id: null }
        : overrides.grant,
    consumeGrant: async () => overrides.consume ?? true,
    refundGrant: async () => {},
  };
}

{
  const decision = await authorizeActWithStore(
    store({ usage: { sms: 2 } }),
    actor,
    { kind: "sms", scope: "sms:send:production", target: { recipients: ["+1555"] } }
  );
  check(
    "the SMS cap refuses at the limit",
    decision.ok === false && decision.reason === "sms_cap",
    JSON.stringify(decision)
  );
  check(
    "the SMS cap message names the cap",
    decision.ok === false && decision.message === "agent daily SMS cap reached (2/day)",
    decision.ok === false ? decision.message : ""
  );
}

{
  const decision = await authorizeActWithStore(
    store({ usage: { writes: 3 } }),
    actor,
    { kind: "write", scope: "rules:write", target: { rule_id: "r1" } }
  );
  check(
    "the write cap refuses at the limit",
    decision.ok === false && decision.reason === "write_cap",
    JSON.stringify(decision)
  );
  check(
    "the write cap message names the cap",
    decision.ok === false && decision.message === "agent daily write cap reached (3/day)",
    decision.ok === false ? decision.message : ""
  );
}

{
  const decision = await authorizeActWithStore(
    store({ grant: null }),
    actor,
    { kind: "write", scope: "rules:write", target: { rule_id: "r1" } }
  );
  check(
    "a revoked grant refuses",
    decision.ok === false && decision.reason === "no_grant",
    JSON.stringify(decision)
  );
}

{
  const decision = await authorizeActWithStore(
    store({ consume: false }),
    actor,
    { kind: "write", scope: "rules:write", target: { rule_id: "r1" } }
  );
  check(
    "an expired grant refuses",
    decision.ok === false && decision.reason === "grant_expired",
    JSON.stringify(decision)
  );
}

{
  const decision = await authorizeActWithStore(
    store({ autonomy: { expires_at: Date.now() - 1_000 } }),
    actor,
    { kind: "write", scope: "rules:write", target: { rule_id: "r1" } }
  );
  check(
    "an expired autonomy window refuses",
    decision.ok === false && decision.reason === "autonomy_expired",
    JSON.stringify(decision)
  );
}

{
  const decision = await authorizeActWithStore(
    store({ autonomy: { enabled: 0 } }),
    actor,
    { kind: "write", scope: "rules:write", target: { rule_id: "r1" } }
  );
  check(
    "autonomy off refuses",
    decision.ok === false && decision.reason === "autonomy_off",
    JSON.stringify(decision)
  );
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exitCode = 1;
}
