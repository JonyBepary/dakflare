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

const { handleAssistantChat } = await import("../../routes/assistant.ts");

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

async function runChat({ env, flowRow, context, queries }) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return jsonResponse({
      choices: [{ message: { content: MODEL_REPLY } }],
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
      "patch shape line is exact",
      result.prompt.includes(
        "stage_workflow_patch payload: { flow_id, patch: { nodes: [ { id, type, position: { x, y }, data: {...} } ], edges: [ { id, source, target } ] } }"
      )
    );
    check(
      "patch is declared a complete graph",
      result.prompt.includes("COMPLETE graph") &&
        result.prompt.includes("an unusable patch is refused rather than applied")
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

  // --- an invalid env base URL never sends the key ----------------------
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
