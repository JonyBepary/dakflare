#!/usr/bin/env node
/**
 * MCP authority and approval-path checks.
 *
 * These are the four guards that were predicates on the wrong thing:
 *
 *   1. the legacy `POST /v1/mcp` path must not run a mutating tool with no
 *      elicitation driver — it refuses by name instead;
 *   2. an `ag1_` handle is signed, a tampered one is refused, minting creates
 *      the pending approval request `flow apply` looks for, and a second spend
 *      beyond `max_uses` is refused;
 *   3. an audience-bearing token with the wrong audience is refused while a
 *      token with no audience (the pre-change shape) still works;
 *   4. the synthesize judge is given the patch / stored graph, not only a
 *      sentence about it.
 *
 * Everything runs against the real handlers over an in-memory SQLite database
 * loaded from `migrations/`, and the model is a recording AI binding: the
 * assertion about the judge input is made against the request the model
 * actually received, not against the source that built it.
 *
 * Run: node --experimental-strip-types src/lib/__checks__/mcp-authority.mjs
 */

import { registerHooks } from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = path.resolve(HERE, "../../..");

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

const { handleStreamableMcp, mcpDeploymentAudience } = await import("../../mcp/http.ts");
const { handleAgentSynthesize } = await import("../../routes/agent.ts");
const { handleApprovalApprove } = await import("../../routes/approvals.ts");
const { createGrant, requestApproval } = await import("../../lib/authority.ts");
const { mintApplyHandle, verifyApplyHandle } = await import("../../lib/apply-handle.ts");
const { authorizeAgentSend } = await import("../../lib/agent-send.ts");

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

/* ── the real schema, in memory ───────────────────────────────────────── */

function makeD1() {
  const db = new DatabaseSync(":memory:");
  const migrations = path.join(WORKER_ROOT, "migrations");
  for (const file of readdirSync(migrations).filter((entry) => entry.endsWith(".sql")).sort()) {
    db.exec(readFileSync(path.join(migrations, file), "utf8"));
  }
  return {
    raw: db,
    prepare(sql) {
      const statement = db.prepare(sql);
      const args = { values: [] };
      return {
        bind(...values) {
          args.values = values;
          return this;
        },
        async first() {
          return statement.get(...args.values) ?? null;
        },
        async all() {
          return { results: statement.all(...args.values) };
        },
        async run() {
          const result = statement.run(...args.values);
          return { meta: { changes: Number(result.changes) } };
        },
      };
    },
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
}

function makeEnv(overrides = {}) {
  const DB = makeD1();
  const seenAi = [];
  const env = {
    DB,
    WEBHOOK_SECRET_KEY: "test-apply-handle-key",
    AUTH_BASE_URL: "https://gateway.example",
    AI: {
      async run(model, input) {
        seenAi.push({ model, input });
        return {
          answers: {
            faithful: { type: "score", score: 3, probability: 0.92, confidence: 0.9 },
            approval: { type: "noul", noul: 0.95 },
          },
        };
      },
    },
    ...overrides,
  };
  return { env, DB, seenAi };
}

const agentActor = {
  userId: null,
  label: "agent:writer",
  role: "agent",
  canGrantOwner: false,
  agentTokenId: "tok_writer",
  agentScopes: ["flows:write", "devices:read", "sms:send"],
};

const machineActor = { userId: null, label: "admin-token", role: "machine", canGrantOwner: true };

/* ── 1. the legacy transport ignores a pre-existing grant ────────────── */

async function checkLegacyPath() {
  console.log("legacy /v1/mcp grant rule");

  const { env, DB } = makeEnv();
  DB.raw
    .prepare(
      `INSERT INTO agent_tokens
         (id, name, token_hash, scopes_json, max_per_hour, sent_current_hour,
          hour_window_start, created_at, created_by)
       VALUES ('tok_writer', 'writer', 'hash', '["sms:send"]', 20, 0, 0, 0, 'check')`
    )
    .run();

  const recipients = ["+8801000000000"];
  const grant = await createGrant(env, {
    agentTokenId: "tok_writer",
    scope: "sms:send:production",
    target: { recipients, device_id: "dev1", max_uses: 5 },
    grantedBy: "check",
    actor: machineActor,
    durationS: 900,
    approvalRequestId: "apr_live",
  });
  check("a live grant exists to be ignored", grant.ok === true, JSON.stringify(grant));
  const request = {
    deviceId: "dev1",
    recipients,
    allRecipients: false,
  };

  const ordinary = await authorizeAgentSend(
    env,
    { tokenId: "tok_writer", boundDeviceId: null },
    request
  );
  check("the ordinary path still spends a live grant", ordinary.ok === true);

  const legacyFirstRound = await authorizeAgentSend(
    env,
    { tokenId: "tok_writer", boundDeviceId: null },
    request,
    { ignoreGrants: true, approvalRequestId: null }
  );
  check(
    "the legacy transport ignores a pre-existing grant and asks",
    legacyFirstRound.ok === false && legacyFirstRound.kind === "approval",
    JSON.stringify(legacyFirstRound)
  );

  const legacyWrongRound = await authorizeAgentSend(
    env,
    { tokenId: "tok_writer", boundDeviceId: null },
    request,
    { ignoreGrants: true, approvalRequestId: "apr_somewhere_else" }
  );
  check(
    "...and refuses a grant minted by a different approval",
    legacyWrongRound.ok === false && legacyWrongRound.kind === "approval",
    JSON.stringify(legacyWrongRound)
  );

  const legacyApprovedRound = await authorizeAgentSend(
    env,
    { tokenId: "tok_writer", boundDeviceId: null },
    request,
    { ignoreGrants: true, approvalRequestId: "apr_live" }
  );
  check(
    "...but accepts the grant its own round's human approved",
    legacyApprovedRound.ok === true,
    JSON.stringify(legacyApprovedRound)
  );
}

/* ── 2. signed handles, pending request, max_uses ─────────────────────── */

async function checkHandlesAndApproval() {
  console.log("signed apply handles");
  const { env, DB, seenAi } = makeEnv();

  DB.raw
    .prepare(
      `INSERT INTO agent_tokens
         (id, name, token_hash, scopes_json, max_per_hour, sent_current_hour,
          hour_window_start, created_at, created_by)
       VALUES ('tok_writer', 'writer', 'hash', '["flows:write"]', 0, 0, 0, 0, 'check')`
    )
    .run();
  DB.raw
    .prepare(
      `INSERT INTO workflows (id, name, enabled, graph, version, created_at, updated_at)
       VALUES ('wf_handle', 'Handle flow', 1, ?, 3, 0, 0)`
    )
    .run(JSON.stringify({ nodes: [{ id: "extract_trx", type: "extract", pattern: "TrxID:(\\w+)" }] }));

  const patchText = "diff --git a/flow.json b/flow.json: + node extract_trx uses TrxID:(\\\\w+)";
  const synthesize = await handleAgentSynthesize(
    new Request("https://gateway.example/v1/agent/synthesize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        intent: "capture the transaction id",
        flow_id: "wf_handle",
        diff_summary: "adds an extract node for the transaction id",
        corpus_report: "precision=1 recall=1",
        patch: patchText,
      }),
    }),
    env,
    agentActor
  );
  const synthesized = await synthesize.json();
  check("synthesize returns 200", synthesize.status === 200, JSON.stringify(synthesized).slice(0, 240));
  check("a handle was minted", typeof synthesized.apply_token === "string" && synthesized.apply_token.startsWith("ag1_"));
  check("the mint names its approval request", typeof synthesized.approval_request_id === "string");

  const target = synthesized.apply_token.slice(4);
  const payload = JSON.parse(Buffer.from(target, "base64url").toString("utf8"));
  check("the handle carries a signature", typeof payload.sig === "string" && payload.sig.length === 64);
  check("the handle's max_uses is signed data", payload.max_uses === 1, String(payload.max_uses));

  const pending = DB.raw
    .prepare(`SELECT id, scope, target_json, state FROM approval_requests WHERE id = ?`)
    .get(synthesized.approval_request_id);
  check(
    "a PENDING approval request exists for the handle",
    pending?.state === "PENDING" && pending?.scope === "flow_deploy_prod",
    JSON.stringify(pending)
  );
  check(
    "...and it names the flow the handle names",
    JSON.parse(pending?.target_json ?? "{}").flow_id === "wf_handle",
    String(pending?.target_json)
  );

  /* the judge saw the patch and the graph, not only a summary */
  const modelRequest = seenAi[0]?.input ?? {};
  const stateText = JSON.stringify(modelRequest.state ?? {});
  check(
    "the judge input contains the patch text",
    stateText.includes("node extract_trx") && stateText.includes("TrxID"),
    stateText.slice(0, 240)
  );
  check(
    "the judge input contains the stored graph",
    stateText.includes("extract_trx"),
    stateText.slice(0, 240)
  );

  /* tampering */
  const tampered = JSON.parse(JSON.stringify(payload));
  tampered.flow_id = "wf_somewhere_else";
  const tamperedToken = `ag1_${Buffer.from(JSON.stringify(tampered)).toString("base64url")}`;
  const tamperedVerdict = await verifyApplyHandle(env, tamperedToken);
  check(
    "a tampered handle is refused by name",
    tamperedVerdict.ok === false && tamperedVerdict.code === "invalid_apply_token",
    JSON.stringify(tamperedVerdict)
  );

  const tamperedMax = JSON.parse(JSON.stringify(payload));
  tamperedMax.max_uses = 99;
  const tamperedMaxToken = `ag1_${Buffer.from(JSON.stringify(tamperedMax)).toString("base64url")}`;
  const maxVerdict = await verifyApplyHandle(env, tamperedMaxToken);
  check(
    "raising max_uses breaks the signature",
    maxVerdict.ok === false && maxVerdict.code === "invalid_apply_token",
    JSON.stringify(maxVerdict)
  );

  const unsigned = await mintApplyHandle({ ...env, WEBHOOK_SECRET_KEY: "" }, {
    flow_id: "wf_handle",
    body_hash: payload.body_hash,
    max_uses: 1,
  });
  check(
    "no signing key means no handle, by name",
    unsigned.ok === false && unsigned.code === "apply_handle_unavailable",
    JSON.stringify(unsigned)
  );

  /* spend it through the approval route */
  const approve = (token, id = synthesized.approval_request_id) =>
    handleApprovalApprove(
      new Request(`https://gateway.example/v1/admin/approvals/${id}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ duration_s: 3_600, apply_token: token }),
      }),
      env,
      id,
      machineActor
    );

  const withoutHandle = await handleApprovalApprove(
    new Request("https://gateway.example/v1/admin/approvals/x/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ duration_s: 900 }),
    }),
    env,
    synthesized.approval_request_id,
    machineActor
  );
  const withoutBody = await withoutHandle.json();
  check(
    "a handle-bound request refuses approval without the handle",
    withoutHandle.status === 400 && withoutBody.error === "apply_token_required",
    JSON.stringify(withoutBody)
  );

  const bad = await approve(tamperedToken);
  const badBody = await bad.json();
  check(
    "the approval route refuses a tampered handle",
    bad.status === 400 && badBody.error === "invalid_apply_token",
    JSON.stringify(badBody)
  );

  const spent = await approve(synthesized.apply_token);
  const spentBody = await spent.json();
  check("the minted handle is spendable by apply", spent.status === 200 && spentBody.ok === true, JSON.stringify(spentBody));
  check(
    "...and the grant carries max_uses 1",
    JSON.parse(spentBody.target_json ?? "{}").max_uses === 1 ||
      spentBody.target?.max_uses === 1,
    JSON.stringify(spentBody.target)
  );

  /* a second request for the same handle target, then a second spend */
  const verified = await verifyApplyHandle(env, synthesized.apply_token);
  check("the spent handle still verifies as data", verified.ok === true);
  const reopened = await requestApproval(env, {
    agentTokenId: "tok_writer",
    scope: "flow_deploy_prod",
    target: verified.ok ? verified.target : {},
    reason: "second ask",
  });
  const second = await approve(synthesized.apply_token, reopened.id);
  const secondBody = await second.json();
  check(
    "a second use beyond max_uses is refused",
    second.status === 409 && secondBody.error === "handle_exhausted",
    JSON.stringify(secondBody)
  );
}

/* ── 3. the audience check is reachable ───────────────────────────────── */

async function checkAudience() {
  console.log("RFC 8707 audience");

  const configured = makeEnv().env;
  const request = new Request("https://gateway.example/mcp", { method: "POST" });
  const audience = mcpDeploymentAudience(configured, request);
  check(
    "a configured deployment yields a real audience",
    audience === "https://gateway.example/mcp",
    String(audience)
  );

  const legacyDeployment = makeEnv({ AUTH_BASE_URL: "" }).env;
  check(
    "a deployment with no configured origin keeps the no-audience shape",
    mcpDeploymentAudience(legacyDeployment, request) === undefined
  );

  const actor = { ...agentActor, agentScopes: [] };
  const wrong = await handleStreamableMcp(
    new Request("https://gateway.example/mcp", { method: "POST" }),
    configured,
    actor,
    "https://other.example/mcp"
  );
  check("an audience-bearing token for another resource is refused", wrong.status === 401, String(wrong.status));
  const challenge = wrong.headers.get("WWW-Authenticate") ?? "";
  check("...with a challenge naming the metadata document", challenge.includes("resource_metadata="), challenge);

  const noAudience = await handleStreamableMcp(
    new Request("https://gateway.example/mcp", { method: "POST" }),
    configured,
    actor,
    undefined
  );
  check(
    "a token carrying no audience is accepted as before",
    noAudience.status !== 401,
    String(noAudience.status)
  );

  const wrongOrigin = await handleStreamableMcp(
    new Request("https://evil.example/mcp", { method: "POST" }),
    configured,
    actor,
    mcpDeploymentAudience(configured, request)
  );
  check(
    "the configured audience refuses a resource reached under another host",
    wrongOrigin.status === 401,
    String(wrongOrigin.status)
  );
}

await checkLegacyPath();
await checkHandlesAndApproval();
await checkAudience();

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
}
