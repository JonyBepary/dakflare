#!/usr/bin/env node
/**
 * Assistant prompt + env base URL checks.
 *
 * `assistant.ts` imports its siblings without file extensions (the Worker
 * bundles them), so plain `node --experimental-strip-types` cannot resolve
 * them. This file registers a tiny resolve hook that tries `.ts` first, then
 * imports the real route module. Nothing is mocked except D1 and `fetch`.
 *
 * Asserted here:
 *   - a flowId that exists puts its nodes and edges in the system prompt
 *   - the exact stage_workflow_patch payload shape is present
 *   - a graph over 8000 characters degrades to ids/types + edge endpoints
 *   - an unknown flowId adds the not-found / withhold line
 *   - no flowId means no graph block and no workflow query
 *   - http:// on a non-loopback host refuses with bad_base_url and no call
 *   - an https env base URL still reaches the provider
 *   - a JSON object with one missing closer is repaired, and one with an
 *     unbalanced string or an extra closer is left alone
 *
 * Run: node --experimental-strip-types src/lib/__checks__/assistant-prompt.mjs
 */

import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function resolveExtensionless(specifier, context, nextResolve) {
  // The rules route (imported by assistant.ts) reaches the flow engine, which
  // imports the compiled interpreter. The chat path never runs it, and Node
  // cannot load a Worker wasm import here, so give it an inert module.
  if (specifier.endsWith(".wasm")) {
    return {
      url: "data:text/javascript,export%20default%20%7B%7D%3B",
      shortCircuit: true,
    };
  }
  if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    path.extname(specifier) === ""
  ) {
    const base = context.parentURL
      ? path.dirname(fileURLToPath(context.parentURL))
      : HERE;
    for (const suffix of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
      const candidate = path.resolve(base, specifier + suffix);
      if (existsSync(candidate)) {
        return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
    }
  }
  return nextResolve(specifier, context);
}

registerHooks({ resolve: resolveExtensionless });

const { handleAssistantChat, closeOpenBrackets, applyFlowOps, salvageAnswer } = await import(
  "../../routes/assistant.ts"
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

/* ── JSON bracket repair (a real model miscounts closers) ───────────────── */

{
  // The exact shape llama-3.3-70b returned: one unclosed object at the end.
  const malformed = '{"answer": "ok", "proposals": [{"kind": "x", "payload": {"a": 1}}]';
  const fixed = closeOpenBrackets(malformed);
  check("repair closes a missing brace", fixed !== null && fixed.endsWith("}"), String(fixed).slice(-6));
  let parsed = null;
  try {
    parsed = JSON.parse(fixed ?? "");
  } catch {
    parsed = null;
  }
  check("repaired text parses", parsed !== null && parsed.answer === "ok");

  const bracesInStrings = '{"answer": "use {n} and ] here", "proposals": []';
  const second = closeOpenBrackets(bracesInStrings);
  check(
    "repair ignores brackets inside strings",
    second !== null && second.endsWith("}"),
    String(second).slice(-4)
  );

  check(
    "an extra closer is not repaired",
    closeOpenBrackets('{"answer": "ok"}}') === null
  );
  check(
    "an unclosed string is not repaired",
    closeOpenBrackets('{"answer": "ok') === null
  );
}


/* ── server-side ops composition (the model names steps, code moves them) ── */

const CHAIN = {
  nodes: [
    { id: "n_trigger", type: "trigger", position: { x: 0, y: 0 }, data: {} },
    { id: "n_a", type: "delay", position: { x: 280, y: 0 }, data: { seconds: 30 } },
    { id: "n_b", type: "send_sms", position: { x: 560, y: 0 }, data: { body: "hi" } },
  ],
  edges: [
    { id: "e_1", source: "n_trigger", target: "n_a" },
    { id: "e_2", source: "n_a", target: "n_b" },
  ],
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

{
  // Insert after an anchor that already has an outgoing edge: the edge is
  // rewired through the new step, and the new id is minted without collision.
  const before = clone(CHAIN);
  const result = applyFlowOps(before, [
    { op: "add", type: "webhook", after: "n_a", data: { url: "https://example.test" } },
  ]);
  check("add after an anchor applies", result.ok === true, result.ok ? "" : result.reason);
  const graph = result.ok ? result.graph : { nodes: [], edges: [] };
  const created = graph.nodes.find((node) => !before.nodes.some((item) => item.id === node.id));
  check("add mints a new node id", typeof created?.id === "string" && created.id !== "");
  check(
    "add never collides with an existing id",
    created !== undefined && !before.nodes.some((node) => node.id === created.id)
  );
  check(
    "add rewires the anchor's outgoing edge through the new step",
    graph.edges.some((edge) => edge.source === created?.id && edge.target === "n_b") &&
      graph.edges.some((edge) => edge.source === "n_a" && edge.target === created?.id)
  );
  check(
    "add places the new step to the right of its anchor",
    created?.position?.x === 560 && created?.position?.y === 0,
    JSON.stringify(created?.position)
  );

  // Append at the end: no outgoing edge, just one new connection.
  const atEnd = applyFlowOps(clone(CHAIN), [{ op: "add", type: "stop", after: "n_b" }]);
  const endCreated = atEnd.ok
    ? atEnd.graph.nodes.find((node) => !CHAIN.nodes.some((item) => item.id === node.id))
    : null;
  check(
    "add after the last step appends one edge",
    atEnd.ok === true &&
      atEnd.graph.edges.some(
        (edge) => edge.source === "n_b" && edge.target === endCreated?.id
      ) &&
      atEnd.graph.edges.length === CHAIN.edges.length + 1
  );
}

{
  // Move: lift B out, drop it before A, and rewire both sides.
  const four = {
    nodes: [
      { id: "n_trigger", type: "trigger", position: { x: 0, y: 0 }, data: {} },
      { id: "n_a", type: "delay", position: { x: 280, y: 0 }, data: {} },
      { id: "n_b", type: "send_sms", position: { x: 560, y: 0 }, data: {} },
      { id: "n_c", type: "stop", position: { x: 840, y: 0 }, data: {} },
    ],
    edges: [
      { id: "e_1", source: "n_trigger", target: "n_a" },
      { id: "e_2", source: "n_a", target: "n_b" },
      { id: "e_3", source: "n_b", target: "n_c" },
    ],
  };
  const before = clone(four);
  const result = applyFlowOps(four, [{ op: "move", id: "n_b", before: "n_a" }]);
  check("move applies", result.ok === true, result.ok ? "" : result.reason);
  const edges = result.ok ? result.graph.edges : [];
  const has = (source, target) =>
    edges.some((edge) => edge.source === source && edge.target === target);
  check(
    "move rewires both sides",
    has("n_trigger", "n_b") && has("n_b", "n_a") && has("n_a", "n_c")
  );
  check(
    "move keeps the moved step's position",
    result.ok &&
      result.graph.nodes.find((node) => node.id === "n_b")?.position?.x === 560
  );
  check("move does not mutate the input graph", JSON.stringify(four) === JSON.stringify(before));
}

{
  // Rename changes data.title only.
  const before = clone(CHAIN);
  const result = applyFlowOps(CHAIN, [{ op: "rename", id: "n_a", title: "Wait a moment" }]);
  const renamed = result.ok ? result.graph.nodes.find((node) => node.id === "n_a") : null;
  check(
    "rename sets data.title",
    result.ok === true && renamed?.data?.title === "Wait a moment"
  );
  check(
    "rename keeps the node's other data",
    renamed?.data?.seconds === 30 && renamed?.type === "delay"
  );
  check(
    "rename leaves other nodes and edges untouched",
    result.ok === true &&
      JSON.stringify(result.graph.nodes.filter((node) => node.id !== "n_a")) ===
        JSON.stringify(before.nodes.filter((node) => node.id !== "n_a")) &&
      JSON.stringify(result.graph.edges) === JSON.stringify(before.edges)
  );
}

{
  // Remove with exactly one in and one out splices the chain back together.
  const before = clone(CHAIN);
  const result = applyFlowOps(CHAIN, [{ op: "remove", id: "n_a" }]);
  check("remove with one in/out applies", result.ok === true, result.ok ? "" : result.reason);
  check(
    "remove reconnects the neighbours",
    result.ok === true &&
      !result.graph.nodes.some((node) => node.id === "n_a") &&
      result.graph.edges.some((edge) => edge.source === "n_trigger" && edge.target === "n_b") &&
      result.graph.edges.length === 1
  );
  check("remove does not mutate the input graph", JSON.stringify(CHAIN) === JSON.stringify(before));
}

{
  // A branching node cannot be spliced out.
  const branching = {
    nodes: [
      { id: "n_trigger", type: "trigger", position: { x: 0, y: 0 }, data: {} },
      { id: "n_cond", type: "condition", position: { x: 280, y: 0 }, data: {} },
      { id: "n_x", type: "stop", position: { x: 560, y: -80 }, data: {} },
      { id: "n_y", type: "stop", position: { x: 560, y: 80 }, data: {} },
    ],
    edges: [
      { id: "e_1", source: "n_trigger", target: "n_cond" },
      { id: "e_2", source: "n_cond", target: "n_x" },
      { id: "e_3", source: "n_cond", target: "n_y" },
    ],
  };
  const result = applyFlowOps(branching, [{ op: "remove", id: "n_cond" }]);
  check("remove of a branching node is refused", result.ok === false);
  check(
    "branch refusal names the step and the branch",
    result.ok === false &&
      result.reason.includes('"Condition"') &&
      result.reason.includes("two outgoing connections"),
    result.ok ? "" : result.reason
  );

  const triggerResult = applyFlowOps(branching, [{ op: "remove", id: "n_trigger" }]);
  check(
    "remove of the trigger is refused",
    triggerResult.ok === false && triggerResult.reason.includes("trigger"),
    triggerResult.ok ? "" : triggerResult.reason
  );
}

{
  // Unknown ids are refused, never guessed at.
  const result = applyFlowOps(clone(CHAIN), [{ op: "remove", id: "n_missing" }]);
  check(
    "unknown node id is refused",
    result.ok === false && result.reason.includes("n_missing"),
    result.ok ? "" : result.reason
  );

  const addResult = applyFlowOps(clone(CHAIN), [
    { op: "add", type: "delay", after: "n_missing" },
  ]);
  check(
    "add with an unknown anchor is refused",
    addResult.ok === false && addResult.reason.includes("n_missing"),
    addResult.ok ? "" : addResult.reason
  );
}

{
  // The same ops on the same graph produce the same graph, id included.
  const ops = [
    { op: "add", type: "webhook", after: "n_a" },
    { op: "rename", id: "n_b", title: "Notify" },
  ];
  const before = clone(CHAIN);
  const first = applyFlowOps(CHAIN, ops);
  const second = applyFlowOps(CHAIN, ops);
  check(
    "two runs of the same ops produce identical graphs",
    first.ok === true &&
      second.ok === true &&
      JSON.stringify(first.graph) === JSON.stringify(second.graph)
  );
  check("ops never mutate the input graph", JSON.stringify(CHAIN) === JSON.stringify(before));
}

/* ── answer salvage when the JSON tail is invalid ───────────────────────── */

{
  const broken =
    '{"answer": "I cannot patch this flow: the step is missing.", "proposals": []]';
  check(
    "salvage reads the answer past an invalid tail",
    salvageAnswer(broken) === "I cannot patch this flow: the step is missing.",
    String(salvageAnswer(broken))
  );
  const escaped = '{"answer": "He said \\"move\\" and then {left}.", "proposals": ]';
  check(
    "salvage respects escaped quotes and braces",
    salvageAnswer(escaped) === 'He said "move" and then {left}.',
    String(salvageAnswer(escaped))
  );
}


function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The narrow D1 surface the chat route uses: one settings read, one budget
 * read, one optional workflow read, and the usage/proposal writes.
 */
function makeDB(flowRow, queries = []) {
  return {
    prepare(sql) {
      queries.push(sql);
      const statement = {
        args: [],
        bind(...args) {
          statement.args = args;
          return statement;
        },
        async first() {
          if (sql.includes("FROM workflows")) return flowRow;
          if (sql.includes("FROM ai_usage")) return null;
          if (sql.includes("FROM ai_settings")) return null;
          return null;
        },
        async run() {
          return { success: true };
        },
      };
      return statement;
    },
  };
}

const MODEL_REPLY = JSON.stringify({ answer: "ok", proposals: [] });

async function runChat({ env, flowRow, context, queries, modelReply }) {
  const calls = [];
  const reply = modelReply ?? MODEL_REPLY;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return jsonResponse({
      choices: [{ message: { content: reply } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
  };
  try {
    const req = new Request("https://check.invalid/v1/admin/assistant/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "what does this flow do?", context }),
    });
    const response = await handleAssistantChat(req, env, {
      userId: "check-user",
      label: "check",
    });
    const text = await response.text();
    const body = JSON.parse(text);
    const prompt =
      calls.length === 0 ? "" : JSON.parse(calls[0].init.body).messages[0].content;
    return { status: response.status, body, calls, prompt };
  } finally {
    globalThis.fetch = realFetch;
  }
}

function httpsEnv(db) {
  return {
    DB: db,
    AI_CHAT_PROVIDER: "openai-compatible",
    AI_CHAT_MODEL: "gpt-test",
    AI_CHAT_BASE_URL: "https://provider.example/v1",
    AI_CHAT_API_KEY: "sk-check",
  };
}

const FLOW_ROW = {
  id: "wf_check",
  name: "Support triage",
  enabled: 1,
  graph: JSON.stringify({
    nodes: [
      {
        id: "n_trigger",
        type: "trigger",
        position: { x: 0, y: 0 },
        data: { label: "Inbound SMS" },
      },
      {
        id: "n_reply",
        type: "reply",
        position: { x: 240, y: 0 },
        data: { body: "Thanks, we will reply soon." },
      },
    ],
    edges: [
      {
        id: "e_1",
        source: "n_trigger",
        target: "n_reply",
        sourceHandle: "case_default",
      },
    ],
  }),
};

async function main() {
  console.log("assistant prompt + env base url");

  // --- an existing flow is quoted verbatim -------------------------------
  {
    const queries = [];
    const result = await runChat({
      env: httpsEnv(makeDB(FLOW_ROW, queries)),
      flowRow: FLOW_ROW,
      context: { flowId: "wf_check", route: "/workflows/wf_check" },
      queries,
    });

    check("existing flowId answers 200", result.status === 200, JSON.stringify(result.body));
    check("https env base URL reaches the provider", result.calls.length === 1);
    check(
      "provider request goes to the configured URL",
      result.calls[0]?.url === "https://provider.example/v1/chat/completions",
      result.calls[0]?.url
    );
    check("prompt names the flow", result.prompt.includes('"wf_check"'));
    check("prompt names the flow name", result.prompt.includes('"Support triage"'));
    check(
      "prompt carries node ids, types and data",
      result.prompt.includes('"id":"n_trigger"') &&
        result.prompt.includes('"type":"trigger"') &&
        result.prompt.includes('"label":"Inbound SMS"') &&
        result.prompt.includes('"body":"Thanks, we will reply soon."')
    );
    check(
      "prompt carries layout positions",
      result.prompt.includes('"position":{"x":240,"y":0}')
    );
    check(
      "prompt carries edge endpoints and branch handle",
      result.prompt.includes('"source":"n_trigger"') &&
        result.prompt.includes('"target":"n_reply"') &&
        result.prompt.includes('"sourceHandle":"case_default"')
    );
    check(
      "prompt carries the ops payload shape",
      result.prompt.includes(
        'stage_workflow_patch payload: { flow_id, ops: [ { "op": "add"'
      ) &&
        result.prompt.includes('{ "op": "move"') &&
        result.prompt.includes('{ "op": "rename"') &&
        result.prompt.includes('{ "op": "remove"')
    );
    check(
      "prompt says the server applies the ops and a human accepts",
      result.prompt.includes("The server applies the operations and a human accepts the result")
    );
    check(
      "prompt no longer asks for a complete graph",
      !result.prompt.includes("COMPLETE graph") &&
        !result.prompt.includes("patch: { nodes: [ { id, type, position")
    );

    console.log("\n--- captured system prompt for flow wf_check ---");
    console.log(result.prompt);
    console.log("--- end captured prompt ---\n");
  }

  // --- a graph over the cap loses data, not structure --------------------
  {
    const bigRow = {
      id: "wf_big",
      name: "Huge flow",
      enabled: 1,
      graph: JSON.stringify({
        nodes: [
          {
            id: "n_big",
            type: "reply",
            position: { x: 1, y: 2 },
            data: { body: `SECRETDATA_${"x".repeat(9000)}` },
          },
        ],
        edges: [{ id: "e_big", source: "n_big", target: "n_big" }],
      }),
    };
    const result = await runChat({
      env: httpsEnv(makeDB(bigRow)),
      flowRow: bigRow,
      context: { flowId: "wf_big" },
    });
    check(
      "oversize graph degrades with an omission note",
      result.prompt.includes("Step data was omitted from this block")
    );
    check(
      "oversize graph keeps ids/types and edge endpoints",
      result.prompt.includes('"id":"n_big"') &&
        result.prompt.includes('"type":"reply"') &&
        result.prompt.includes('"id":"e_big","source":"n_big","target":"n_big"')
    );
    check(
      "oversize graph does not include the step data",
      !result.prompt.includes("SECRETDATA")
    );
    check(
      "oversize graph block stays within the cap plus the fixed prompt",
      result.prompt.length < 8000 + 3000,
      String(result.prompt.length)
    );
  }

  // --- a flowId D1 does not hold ----------------------------------------
  {
    const result = await runChat({
      env: httpsEnv(makeDB(null)),
      flowRow: null,
      context: { flowId: "wf_missing" },
    });
    check("unknown flowId still answers (with a warning)", result.status === 200);
    check(
      "unknown flowId says it was not found",
      result.prompt.includes("no flow with that id exists in D1")
    );
    check(
      "unknown flowId says to withhold a patch",
      result.prompt.includes("withhold any stage_workflow_patch proposal")
    );
  }

  // --- no flowId: no graph read, no graph block --------------------------
  {
    const queries = [];
    const result = await runChat({
      env: httpsEnv(makeDB(FLOW_ROW, queries)),
      flowRow: FLOW_ROW,
      context: { route: "/workflows" },
      queries,
    });
    check(
      "no flowId means no workflow query",
      !queries.some((sql) => sql.includes("FROM workflows")),
      queries.join(" | ")
    );
    check(
      "no flowId means no graph block",
      !result.prompt.includes("Flow context from D1")
    );
  }

  // --- a stage_workflow_patch is composed by code from ops ---------------
  {
    const modelReply = JSON.stringify({
      answer: "I can add a delay after the trigger.",
      proposals: [
        {
          kind: "stage_workflow_patch",
          title: "Add a delay",
          summary: "Insert a delay after the trigger.",
          payload: {
            flow_id: "wf_check",
            ops: [
              { op: "add", type: "delay", after: "n_trigger", data: { seconds: 5 } },
            ],
          },
        },
      ],
    });
    const result = await runChat({
      env: httpsEnv(makeDB(FLOW_ROW)),
      flowRow: FLOW_ROW,
      context: { flowId: "wf_check" },
      modelReply,
    });
    const proposal = result.body.proposals?.[0];
    check("ops proposal is stored", result.status === 200 && result.body.proposals?.length === 1);
    check(
      "proposal payload carries the complete graph built by code",
      proposal?.payload?.flow_id === "wf_check" &&
        Array.isArray(proposal?.payload?.patch?.nodes) &&
        proposal.payload.patch.nodes.length === 3 &&
        proposal.payload.patch.edges.length === 2,
      JSON.stringify(proposal?.payload?.patch)
    );
    check(
      "proposal payload still carries the ops it was asked for",
      Array.isArray(proposal?.payload?.ops) && proposal.payload.ops.length === 1
    );
    check(
      "withheld is an empty array when nothing was refused",
      Array.isArray(result.body.withheld) && result.body.withheld.length === 0
    );
  }

  // --- a refused op withholds the whole proposal -------------------------
  {
    const modelReply = JSON.stringify({
      answer: "I cannot remove the trigger.",
      proposals: [
        {
          kind: "stage_workflow_patch",
          title: "Remove the trigger",
          summary: "Remove the trigger.",
          payload: { flow_id: "wf_check", ops: [{ op: "remove", id: "n_trigger" }] },
        },
      ],
    });
    const result = await runChat({
      env: httpsEnv(makeDB(FLOW_ROW)),
      flowRow: FLOW_ROW,
      context: { flowId: "wf_check" },
      modelReply,
    });
    check(
      "a refused op drops the proposal",
      result.status === 200 && (result.body.proposals?.length ?? 0) === 0
    );
    check(
      "a refused op is reported in withheld with its reason",
      result.body.withheld?.length === 1 &&
        result.body.withheld[0].kind === "stage_workflow_patch" &&
        String(result.body.withheld[0].reason).includes("trigger"),
      JSON.stringify(result.body.withheld)
    );
  }

  // --- an invalid reply tail still yields the answer ---------------------
  {
    const broken =
      '{"answer": "The flow already has a trigger, so I left it alone.", "proposals": []]';
    const result = await runChat({
      env: httpsEnv(makeDB(FLOW_ROW)),
      flowRow: FLOW_ROW,
      context: { flowId: "wf_check" },
      modelReply: broken,
    });
    check(
      "an invalid tail salvages the answer",
      result.body.answer === "The flow already has a trigger, so I left it alone.",
      JSON.stringify(result.body.answer)
    );
    check(
      "a salvaged answer carries zero proposals and no withholding",
      (result.body.proposals?.length ?? 0) === 0 &&
        Array.isArray(result.body.withheld) &&
        result.body.withheld.length === 0
    );
  }


  {
    const env = {
      DB: makeDB(FLOW_ROW),
      AI_CHAT_PROVIDER: "openai-compatible",
      AI_CHAT_MODEL: "gpt-test",
      AI_CHAT_BASE_URL: "http://provider.example/v1",
      AI_CHAT_API_KEY: "sk-check",
    };
    const result = await runChat({ env, flowRow: FLOW_ROW, context: {} });
    check("http non-loopback base URL refuses", result.status === 503);
    check(
      "refusal reason is bad_base_url",
      result.body.reason === "bad_base_url",
      JSON.stringify(result.body)
    );
    check(
      "refusal message names AI_CHAT_BASE_URL",
      typeof result.body.message === "string" &&
        result.body.message.includes("AI_CHAT_BASE_URL")
    );
    check("refusal never calls out", result.calls.length === 0);
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const failure of failures) console.log(`  - ${failure}`);
    process.exitCode = 1;
  }
}

await main();
