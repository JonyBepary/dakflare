#!/usr/bin/env node
/**
 * Did the deploy actually land?
 *
 * `cf deploy` exits 1 on a deploy that worked: the Workflow trigger update returns
 * `workflows.api.error.internal_server` after the Worker upload, the cron schedule and both
 * queue triggers have already applied (docs/OPS_DEPLOY.md, "Traps when scripting cf"). A
 * release gate therefore cannot read the exit status, and until now the only honest check
 * was three commands run by hand.
 *
 * This runs those three, plus the migration ledger, and says plainly what it cannot see:
 *   - the newest version id, and that it changed since the previous deploy;
 *   - three live routes, one of them new in this release, answering what they should;
 *   - the workflow still bound to the deployed script;
 *   - no unapplied D1 migration.
 *
 * Usage:
 *   node scripts/verify-deploy.mjs                # verify against production
 *   node scripts/verify-deploy.mjs --expect <id8> # require this version prefix
 *   BASE_URL=... node scripts/verify-deploy.mjs    # verify another deployment
 *
 * Exit codes follow the CLI's own contract: 0 ok, 1 a check failed, 6 a precondition
 * (the `cf` CLI missing or unauthenticated), 75 still in flight.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

const BASE_URL = (process.env.BASE_URL ?? "https://dakflare-worker.sohelahmedjony.workers.dev").replace(/\/$/, "");
const WORKER = process.env.WORKER_NAME ?? "dakflare-worker";
const D1_ID = process.env.D1_ID ?? "8d88069e-71cf-49a2-ba33-c150b02246b7";

const argv = process.argv.slice(2);
const expectIndex = argv.indexOf("--expect");
const expect = expectIndex === -1 ? null : (argv[expectIndex + 1] ?? "").slice(0, 8);

const results = [];
const record = (ok, label, detail) => {
  results.push({ ok, label, detail });
  console.log(`${ok ? "  PASS  " : "  FAIL  "}${label}${detail ? `  ·  ${detail}` : ""}`);
};

/** `cf` prints its JSON to stdout; anything else means the command did not answer. */
async function cfJson(args) {
  try {
    const { stdout } = await run("npx", ["cf", ...args], { maxBuffer: 8 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (error) {
    const detail = String(error.stdout || error.stderr || error.message).slice(0, 400);
    if (/not authenticated|log in|sign in/i.test(detail)) {
      console.error(`cf is not authenticated:\n${detail}`);
      process.exit(6);
    }
    return null;
  }
}

/**
 * Up to three reads, 1.5 s apart, stopping at the first one that matches. A Worker that has
 * just been uploaded can answer from an edge that has not caught up, and a gate that turns
 * one blip into a red build is a gate people learn to ignore. Bounded, so a real failure
 * still fails and still prints what it saw.
 */
async function status(path, want) {
  const seen = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${BASE_URL}${path}`, {
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      seen.push(response.status);
      if (response.status === want) return { status: response.status, seen };
    } catch {
      seen.push(null);
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 1_500));
  }
  return { status: seen[seen.length - 1] ?? null, seen };
}

console.log(`\nverify-deploy · ${BASE_URL}\n`);

// ── 1. The version, which is the only proof the upload landed ─────────────────
const deployments = await cfJson(["workers", "deployments", "list", "--worker", WORKER]);
const newest = deployments?.deployments?.[0]?.versions?.[0]?.version_id ?? null;
const createdOn = deployments?.deployments?.[0]?.created_on ?? null;
if (newest === null) {
  record(false, "the deployment list answered", "cf returned no deployments");
} else {
  const id = String(newest).slice(0, 8);
  record(
    expect === null || id.startsWith(expect) || expect.startsWith(id),
    `newest version is ${id}`,
    expectations(),
  );
}

function expectations() {
  if (expectIndex === -1) return createdOn ? `created ${createdOn}` : "";
  return `expected ${expect}`;
}

// ── 2. Live routes, including one that is new in this release ─────────────────
// A route that exists and demands auth answers 401; a route that was never deployed answers
// 404. That difference is the honest signal that the code, not just the version id, moved.
const routes = [
  ["/v1/auth/mode", 200, "the Worker answers at all"],
  ["/admin/", 200, "the console is served"],
  ["/v1/admin/agent/attachments", 401, "the attachments route exists and demands auth"],
  ["/v1/admin/agent/conversation", 401, "the conversation route exists and demands auth"],
];
for (const [path, want, why] of routes) {
  // Sequentially, so a failure reads in order against the route it belongs to.
  const { status: got, seen } = await status(path, want);
  record(
    got === want,
    `${path} → ${want}`,
    got === want ? why : `got ${seen.map((s) => s ?? "no answer").join(", then ")}`,
  );
}

// ── 3. The workflow, which is what makes the exit code wrong ──────────────────
const workflows = await cfJson(["workflows", "list"]);
const workflow = Array.isArray(workflows) ? workflows.find((w) => w.script_name === WORKER) : null;
record(
  workflow !== undefined && workflow !== null,
  "the workflow is bound to the deployed script",
  workflow ? `${workflow.name} · modified ${workflow.modified_on}` : "no workflow names this script",
);

// ── 4. Schema, because a deploy can land without its migration ────────────────
const migrations = await cfJson(["d1", "migrations", "list", D1_ID, "--dir", "migrations"]);
if (migrations === null) {
  record(false, "the D1 migration ledger answered", "cf returned no ledger");
} else {
  record(
    Array.isArray(migrations) && migrations.length === 0,
    "no unapplied D1 migration",
    Array.isArray(migrations) && migrations.length > 0
      ? `unapplied: ${migrations.map((m) => m.Name).join(", ")}`
      : "ledger is current",
  );
}

const failed = results.filter((r) => !r.ok);
console.log(
  failed.length === 0
    ? `\nDEPLOY VERIFIED  ${results.length}/${results.length} checks`
    : `\nDEPLOY NOT VERIFIED  ${results.length - failed.length}/${results.length} checks · ${failed.map((f) => f.label).join("; ")}`,
);
console.log(
  "Not checked: the cron schedule firing, a queue message consumed, a model call answered.\n" +
    "Those need a live traffic check, not a deploy gate.\n",
);
process.exit(failed.length === 0 ? 0 : 1);
