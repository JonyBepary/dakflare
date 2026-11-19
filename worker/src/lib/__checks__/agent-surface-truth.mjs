#!/usr/bin/env node
/**
 * Agent-surface truth checks — the seven defects that made the published
 * contract disagree with what the Worker actually did.
 *
 * Asserted:
 *   1. `truncated` is false for 24 and 25 rows and true for 26 (limit 25), and
 *      every telemetry statement fetches `limit + 1`;
 *   2. `list_devices` carries `sim_slot`, matching its output schema;
 *   3. the discovery documentation URL names a file this repository serves;
 *   4. `flow_run_id` resolves the stored run key and refuses a malformed or
 *      unknown id by name (never as a flow id / local id);
 *   5. `diagnose` accepts a pattern on its own and answers;
 *   6. `triage` and `telemetry` appear in `tools/list` only for a token whose
 *      scopes allow them;
 *   7. `flows:write` is not advertised as grant-required, because no act
 *      enforces a grant for it.
 *
 * No Workers runtime and no D1: the MCP tool list needs no database, and the
 * diagnose path is driven with a fake `DB` that records its binds.
 *
 * Run: node --experimental-strip-types src/lib/__checks__/agent-surface-truth.mjs
 */

import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = path.resolve(HERE, "../../..");
const REPO_ROOT = path.resolve(WORKER_ROOT, "..");

const RUNTIME_STUB =
  "data:text/javascript," +
  encodeURIComponent(
    "export class DurableObject { constructor(ctx, env) { this.ctx=ctx; this.env=env; } }\n" +
      "export class WorkerEntrypoint {}\nexport class WorkflowEntrypoint {}\nexport class RpcTarget {}\n" +
      "export class EmailMessage {}\nexport class WebSocketPair { constructor(){return [{},{}];} }\n" +
      "const exportsObject={}; export { exportsObject as exports };\n"
  );

function resolveExtensionless(specifier, context, nextResolve) {
  if (specifier.startsWith("cloudflare:")) return { url: RUNTIME_STUB, shortCircuit: true };
  if (specifier.endsWith(".wasm")) {
    return { url: "data:text/javascript,export default {}", shortCircuit: true };
  }
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && path.extname(specifier) === "") {
    const base = context.parentURL ? path.dirname(fileURLToPath(context.parentURL)) : HERE;
    for (const suffix of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
      const candidate = path.resolve(base, specifier + suffix);
      if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context, nextResolve);
}

registerHooks({ resolve: resolveExtensionless });

const { collectTelemetryRows, handleAgentDiagnose, parseFlowRunId, flowRunIdOf } = await import(
  "../../routes/agent.ts"
);
const { MCP_DOCUMENTATION_URL, protectedResourceMetadata } = await import("../../mcp/oauth.ts");
const { handleStreamableMcp } = await import("../../mcp/http.ts");
const { toolDefinitions } = await import("../../mcp/tools.ts");
const { GRANT_REQUIRED_SCOPES, SCOPE_CAPS, scopeNeedsGrant } = await import(
  "../../lib/agent-scopes.ts"
);
const { buildAgentTools } = await import("../../agent/tools.ts");

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

const jsonRequest = (body) =>
  new Request("https://gateway.example/v1/agent/diagnose", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

/* ── 1. truncated is evidence, not arithmetic on the cap ──────────────── */

function rowsPage(count) {
  return { results: Array.from({ length: count }, (_, index) => ({ id: `row_${index}` })) };
}

function truncationAt(count) {
  return collectTelemetryRows(
    [{ group: "devices", limit: 25 }],
    [rowsPage(count)]
  );
}

console.log("telemetry truncation boundaries");
{
  const at24 = truncationAt(24);
  check("24 rows is not truncated", at24.truncated === false && at24.rows.length === 24, JSON.stringify({ n: at24.rows.length, t: at24.truncated }));
  const at25 = truncationAt(25);
  check("exactly 25 rows is not truncated", at25.truncated === false && at25.rows.length === 25, JSON.stringify({ n: at25.rows.length, t: at25.truncated }));
  const at26 = truncationAt(26);
  check("26 rows is truncated and returns 25", at26.truncated === true && at26.rows.length === 25, JSON.stringify({ n: at26.rows.length, t: at26.truncated }));

  const source = readFileSync(path.join(WORKER_ROOT, "src/routes/agent.ts"), "utf8");
  check("every per-query cap fetches one extra row", source.includes("PER_QUERY_LIMIT + 1") && source.includes("MAX_TELEMETRY_ROWS + 1"));
  check("no statement fetches only its cap", !/LIMIT \$\{PER_QUERY_LIMIT\}[` ]/.test(source) && !/LIMIT \$\{MAX_TELEMETRY_ROWS\}[` ]/.test(source));

  const twoPages = collectTelemetryRows(
    [
      { group: "grants", limit: 25 },
      { group: "pending_approvals", limit: 25 },
    ],
    [rowsPage(25), rowsPage(25)]
  );
  check("two full pages inside the total cap are complete", twoPages.truncated === false && twoPages.rows.length === 50, JSON.stringify({ n: twoPages.rows.length, t: twoPages.truncated }));
}

/* ── 2. list_devices carries sim_slot ─────────────────────────────────── */

console.log("list_devices mapping");
{
  const deviceRow = {
    device_id: "dev_truth",
    fcm_token: "fcm-token",
    label: "Gate",
    sim_slot: 2,
    paired_at: 1,
    last_seen: 1_700_000_000_000,
    archived_at: null,
    revoked_at: null,
  };
  const env = {
    DB: {
      prepare() {
        return { all: async () => ({ results: [deviceRow] }) };
      },
    },
  };
  const tool = toolDefinitions(env).find((entry) => entry.name === "list_devices");
  const answer = await tool.run({}, env, { agentScopes: ["devices:read"] });
  const row = answer.structured.devices[0];
  check("the device row carries sim_slot", row.sim_slot === 2, JSON.stringify(row));
  const schema = tool.outputSchema.shape.devices.element.shape;
  check("the output schema publishes sim_slot", schema.sim_slot !== undefined);
  check(
    "every schema field is present on the mapped row",
    Object.keys(schema).every((field) => field in row),
    Object.keys(schema).filter((field) => !(field in row)).join(",")
  );
}

/* ── 3. the advertised documentation URL is real ──────────────────────── */

console.log("discovery documentation");
{
  const metadata = protectedResourceMetadata(new Request("https://gateway.example/.well-known/oauth-protected-resource"));
  check("discovery advertises a documentation URL", typeof metadata.resource_documentation === "string");
  check("it is not a path this Worker does not serve", !metadata.resource_documentation.startsWith("https://gateway.example/docs"), metadata.resource_documentation);

  const url = new URL(MCP_DOCUMENTATION_URL);
  const prefix = "/JonyBepary/dakflare/blob/main/";
  check("it names the repository's agent-surface document", url.hostname === "github.com" && url.pathname.startsWith(prefix), url.href);
  const repoPath = path.join(REPO_ROOT, url.pathname.slice(prefix.length));
  check("that document exists in this checkout", existsSync(repoPath), repoPath);
}

/* ── 4. flow_run_id is a run id ───────────────────────────────────────── */

/** A fake D1 that answers the two statements diagnose's run branch reads. */
function diagnoseEnv(runRow) {
  const binds = [];
  return {
    binds,
    DB: {
      prepare(sql) {
        if (sql.includes("FROM flow_runs")) {
          return {
            bind(...args) {
              binds.push(args);
              return { first: async () => runRow };
            },
          };
        }
        if (sql.includes("FROM authority_grants")) {
          return { all: async () => ({ results: [] }) };
        }
        throw new Error(`unexpected SQL in diagnose: ${sql}`);
      },
    },
  };
}

console.log("flow_run_id resolution");
{
  const run = {
    device_id: "dev_truth",
    local_id: "loc_1",
    flow_id: "wf_truth",
    flow_version: 3,
  };
  const id = flowRunIdOf(run);
  check("a run's key renders as one run id", id === "dev_truth/loc_1/wf_truth/3", id);
  check("it parses back to the same key", JSON.stringify(parseFlowRunId(id)) === JSON.stringify({ deviceId: "dev_truth", localId: "loc_1", flowId: "wf_truth", flowVersion: 3 }));

  const env = diagnoseEnv({ flow_id: "wf_truth", outcome: "error" });
  const resolved = await handleAgentDiagnose(jsonRequest({ flow_run_id: id }), env);
  const resolvedBody = await resolved.json();
  check("a stored run id resolves", resolved.status === 200, JSON.stringify(resolvedBody));
  check(
    "...and the query binds exactly that run key",
    JSON.stringify(env.binds[0]) === JSON.stringify(["dev_truth", "loc_1", "wf_truth", 3]),
    JSON.stringify(env.binds)
  );
  check(
    "...so the failed run reports the authority diagnosis",
    resolvedBody.code === "ERR_AUTHORITY_GUARD_EXPIRED_OR_HASH_MISMATCH",
    JSON.stringify(resolvedBody)
  );

  const missing = await handleAgentDiagnose(
    jsonRequest({ flow_run_id: "dev_truth/loc_1/wf_truth/9" }),
    diagnoseEnv(null)
  );
  const missingBody = await missing.json();
  check("an unknown run is refused by name", missing.status === 404 && missingBody.error === "flow_run_not_found", JSON.stringify(missingBody));

  const malformed = await handleAgentDiagnose(
    jsonRequest({ flow_run_id: "wf_truth" }),
    diagnoseEnv(null)
  );
  const malformedBody = await malformed.json();
  check("a bare flow id is not silently accepted", malformed.status === 400 && malformedBody.error === "invalid_flow_run_id", JSON.stringify(malformedBody));

  const flowEnv = diagnoseEnv({ flow_id: "wf_truth", outcome: "error" });
  const byFlow = await handleAgentDiagnose(jsonRequest({ flow_id: "wf_truth" }), flowEnv);
  const byFlowBody = await byFlow.json();
  check("a flow id diagnoses its latest run", byFlow.status === 200, JSON.stringify(byFlowBody));
  check(
    "...and the query asks for that flow only",
    JSON.stringify(flowEnv.binds[0]) === JSON.stringify(["wf_truth"]),
    JSON.stringify(flowEnv.binds)
  );
  check(
    "...using the latest run's failed outcome",
    byFlowBody.code === "ERR_AUTHORITY_GUARD_EXPIRED_OR_HASH_MISMATCH",
    JSON.stringify(byFlowBody)
  );

  const noRuns = await handleAgentDiagnose(
    jsonRequest({ flow_id: "wf_absent" }),
    diagnoseEnv(null)
  );
  const noRunsBody = await noRuns.json();
  check(
    "a flow with no runs is refused by name",
    noRuns.status === 404 && noRunsBody.error === "no_flow_runs",
    JSON.stringify(noRunsBody)
  );

  const ambiguousEnv = diagnoseEnv({ flow_id: "wf_truth", outcome: "error" });
  const ambiguous = await handleAgentDiagnose(
    jsonRequest({ flow_id: "wf_truth", flow_run_id: id }),
    ambiguousEnv
  );
  const ambiguousBody = await ambiguous.json();
  check(
    "both targets at once is refused as ambiguous",
    ambiguous.status === 400 && ambiguousBody.error === "ambiguous_flow_target",
    JSON.stringify(ambiguousBody)
  );
  check("...before any query runs", ambiguousEnv.binds.length === 0, JSON.stringify(ambiguousEnv.binds));
}

/* ── 4b. the agent tool schema names both targets ─────────────────────── */

console.log("diagnose tool schema");
{
  const tools = buildAgentTools({
    async createRule() {
      throw new Error("not used");
    },
    async sendSms() {
      throw new Error("not used");
    },
    async deployFlow() {
      throw new Error("not used");
    },
  });
  const diagnose = tools.find((tool) => tool.name === "diagnose");
  const properties = diagnose?.parameters?.properties ?? {};
  check("the tool publishes flow_id", properties.flow_id !== undefined, JSON.stringify(Object.keys(properties)));
  check("the tool publishes flow_run_id", properties.flow_run_id !== undefined, JSON.stringify(Object.keys(properties)));
  check(
    "each target says what it means",
    String(properties.flow_id?.description ?? "").includes("most recent") &&
      String(properties.flow_run_id?.description ?? "").includes("device_id/local_id/flow_id/flow_version"),
    JSON.stringify({ flow_id: properties.flow_id, flow_run_id: properties.flow_run_id })
  );
}

/* ── 5. diagnose with a pattern alone answers ─────────────────────────── */

console.log("diagnose pattern-only");
{
  const linted = await handleAgentDiagnose(jsonRequest({ pattern: "REF [A-Z0-9]+" }), diagnoseEnv(null));
  const lintedBody = await linted.json();
  check("a pattern alone is a 200 card", linted.status === 200 && typeof lintedBody.encoding === "string", JSON.stringify(lintedBody));
  check(
    "the unanchored multi-word pattern is named",
    lintedBody.code === "ERR_MULTIWORD_REF_MISMATCH" && lintedBody.fix?.kind === "pattern_patch",
    JSON.stringify(lintedBody)
  );

  const clean = await handleAgentDiagnose(jsonRequest({ pattern: "^[0-9]+$" }), diagnoseEnv(null));
  const cleanBody = await clean.json();
  check("a sound pattern alone answers with no defect", clean.status === 200 && cleanBody.code === null, JSON.stringify(cleanBody));

  const empty = await handleAgentDiagnose(jsonRequest({}), diagnoseEnv(null));
  check("no input at all is still a 400", empty.status === 400, String(empty.status));
}

/* ── 6. triage and telemetry are tools, filtered by scope ─────────────── */

const agent = (scopes) => ({
  userId: null,
  label: `agent:${scopes.join(",")}`,
  role: "agent",
  canGrantOwner: false,
  agentTokenId: `tok_${scopes.join("_")}`,
  agentScopes: scopes,
});

function mcpPost(body, sessionId) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    Host: "gateway.example",
  };
  if (sessionId !== undefined && sessionId !== null) headers["Mcp-Session-Id"] = sessionId;
  return new Request("https://gateway.example/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function visibleTools(actor) {
  const env = {};
  const init = await handleStreamableMcp(
    mcpPost({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }),
    env,
    actor
  );
  const sessionId = init.headers.get("Mcp-Session-Id");
  const list = await handleStreamableMcp(
    mcpPost({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, sessionId),
    env,
    actor
  );
  const body = await list.json();
  return (body.result?.tools ?? []).map((tool) => tool.name);
}

console.log("MCP tool visibility");
{
  const both = await visibleTools(agent(["messages:read", "devices:read"]));
  check("triage is listed for messages:read", both.includes("triage"), both.join(","));
  check("telemetry is listed for devices:read", both.includes("telemetry"), both.join(","));

  const readOnlyMessages = await visibleTools(agent(["messages:read"]));
  check("triage is visible with messages:read alone", readOnlyMessages.includes("triage"), readOnlyMessages.join(","));
  check("telemetry is absent without devices:read", !readOnlyMessages.includes("telemetry"), readOnlyMessages.join(","));

  const readOnlyDevices = await visibleTools(agent(["devices:read"]));
  check("telemetry is visible with devices:read alone", readOnlyDevices.includes("telemetry"), readOnlyDevices.join(","));
  check("triage is absent without messages:read", !readOnlyDevices.includes("triage"), readOnlyDevices.join(","));

  const none = await visibleTools(agent([]));
  check("neither is visible to a token with no scopes", !none.includes("triage") && !none.includes("telemetry"), none.join(","));

  const definitions = toolDefinitions({});
  const triage = definitions.find((entry) => entry.name === "triage");
  const telemetry = definitions.find((entry) => entry.name === "telemetry");
  check("triage asks for messages:read", triage?.requiredScope === "messages:read");
  check("telemetry asks for devices:read", telemetry?.requiredScope === "devices:read");
  const telemetryShape = telemetry.outputSchema.shape;
  check(
    "telemetry publishes the HTTP response shape",
    ["plan", "rows", "truncated", "took_ms"].every((key) => key in telemetryShape)
  );
  const triageShape = triage.outputSchema.shape;
  check(
    "triage publishes the HTTP response shape",
    ["intent", "injection", "specificity", "roles", "invariant", "source"].every((key) => key in triageShape)
  );
}

/* ── 7. flows:write is not an advertised grant ────────────────────────── */

console.log("flows:write gate");
{
  check("flows:write is not grant-required", GRANT_REQUIRED_SCOPES.has("flows:write") === false);
  check("scopeNeedsGrant(flows:write) is false", scopeNeedsGrant("flows:write") === false);
  check("no flows:write grant ceiling is advertised", SCOPE_CAPS["flows:write"] === undefined);
  check("the enforced gates remain", scopeNeedsGrant("flow_deploy_prod") === true && scopeNeedsGrant("rules:write") === true);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
}
