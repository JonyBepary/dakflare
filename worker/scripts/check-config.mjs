#!/usr/bin/env node
/**
 * Config drift check: `wrangler.toml` (always local) and `wrangler.account.toml`
 * (local Worker + real preview bindings) must expose the same binding names.
 *
 * They are separate files because `d1_databases`/`kv_namespaces` are arrays of
 * tables and `durable_objects`/`vars`/`ratelimits`/`triggers` are non-inheritable,
 * so an `[env.*]` block silently drops most of the config.
 *
 *   npm run check:config
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Minimal TOML reader: enough to collect the keys this check cares about. */
function bindingNames(file) {
  const text = fs.readFileSync(file, "utf8");
  const names = { bindings: [], ratelimits: [], vars: [], crons: false, observability: false };

  // [[table]] headers and their `name =` / `binding =` values
  let section = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#") || line === "") continue;

    const header = /^\[\[?([^\]]+)\]\]?$/.exec(line);
    if (header) {
      section = header[1].trim();
      continue;
    }
    if (section === "durable_objects.bindings") {
      // Durable Object bindings use `name =`, not `binding =` — missing that here meant
      // the DO binding was never compared, so both Wrangler configs "agreed" by omission.
      const m = /^name\s*=\s*"([^"]+)"/.exec(line);
      if (m) names.bindings.push(`${section}:${m[1]}`);
    }
    if (
      section === "d1_databases" ||
      section === "kv_namespaces" ||
      section === "r2_buckets" ||
      section === "queues.producers" ||
      section === "workflows" ||
      section === "ai"
    ) {
      const m = /^binding\s*=\s*"([^"]+)"/.exec(line);
      if (m) names.bindings.push(`${section}:${m[1]}`);
    }
    if (section === "ratelimits") {
      const m = /^name\s*=\s*"([^"]+)"/.exec(line);
      if (m) names.ratelimits.push(m[1]);
    }
    if (section === "vars") {
      const m = /^([A-Z0-9_]+)\s*=/.exec(line);
      if (m) names.vars.push(m[1]);
    }
    if (section === "triggers" && /^crons\s*=/.test(line)) names.crons = true;
    if (section === "observability" && /^enabled\s*=\s*true/.test(line)) names.observability = true;
  }

  for (const key of Object.keys(names)) {
    if (Array.isArray(names[key])) names[key].sort();
  }
  return names;
}

/**
 * The `exports` table, which the name comparison above cannot judge.
 *
 * `wrangler.toml` declaring `[exports.FlowExecutionWorkflow]` without a `name`
 * passed this check and failed only when wrangler started, which in CI reads as
 * "the local stack did not come up" rather than as a config error. The schema is
 * small enough to check here: every export has a `type`, and a workflow export
 * also carries the Workflow's `name`, which must match its `[[workflows]]` entry.
 */
function exportProblems(file) {
  const text = fs.readFileSync(file, "utf8");
  const problems = [];
  const exports = new Map();
  let current = null;

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;

    // ANY table header ends the block being read. Resetting only on the next
    // `[exports.*]` let a later `[[workflows]] name = "…"` be attributed to the
    // export above it, which is how a missing name passed this check.
    const header = /^\[\[?([^\]]+)\]\]?$/.exec(line);
    if (header) {
      current = header[1].startsWith("exports.") ? header[1].slice("exports.".length) : null;
      if (current !== null) exports.set(current, {});
      continue;
    }
    if (current === null) continue;
    const pair = /^(type|name|storage|class_name)\s*=\s*"([^"]*)"/.exec(line);
    if (pair) exports.get(current)[pair[1]] = pair[2];
  }

  const workflowNames = new Set(
    [...text.matchAll(/^\[\[workflows\]\][\s\S]*?^name\s*=\s*"([^"]+)"/gm)].map((m) => m[1])
  );

  for (const [name, fields] of exports) {
    if (fields.type === undefined) {
      problems.push(`[exports.${name}] has no type`);
      continue;
    }
    if (fields.type !== "workflow") continue;
    if (fields.name === undefined) {
      problems.push(`[exports.${name}] is a workflow export and needs name = "<the workflow name>"`);
    } else if (workflowNames.size > 0 && !workflowNames.has(fields.name)) {
      problems.push(`[exports.${name}] names "${fields.name}", which has no [[workflows]] entry`);
    }
  }
  return problems;
}

const ROOT = path.join(HERE, "..");
const local = bindingNames(path.join(ROOT, "wrangler.toml"));
const account = bindingNames(path.join(ROOT, "wrangler.account.toml"));

/**
 * Third config: `cloudflare.config.ts`, written by `cf migrate` and completed by hand.
 *
 * A dual-config project drifts the moment someone adds a binding to one file only, and the
 * symptom is a binding that is `undefined` at runtime in one tool and present in the other.
 * This is a light parse — it only collects `NAME: bindings.x(...)` keys under `env` — but it
 * catches exactly that drift.
 */
function cloudflareConfigNames(file) {
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, "utf8");
  const names = new Set();
  for (const line of text.split("\n")) {
    const m = /^\s{2,}([A-Z][A-Z0-9_]*):\s*bindings\./.exec(line);
    if (m) names.add(m[1]);
  }
  return [...names].sort();
}

const cfNames = cloudflareConfigNames(path.join(ROOT, "cloudflare.config.ts"));
const cfTemplateNames = cloudflareConfigNames(path.join(ROOT, "cloudflare.config.template.ts"));
const wranglerTemplate = bindingNames(path.join(ROOT, "wrangler.template.toml"));

const flatLocalNames = [
  ...local.bindings.map((b) => b.split(":")[1]),
  ...local.ratelimits,
  ...local.vars,
].sort();

const cfDrift = [];
if (cfNames) {
  const onlyLocal = flatLocalNames.filter((n) => !cfNames.includes(n));
  const onlyCf = cfNames.filter((n) => !flatLocalNames.includes(n));
  if (onlyLocal.length) cfDrift.push(`only in wrangler.toml: ${onlyLocal.join(", ")}`);
  if (onlyCf.length) cfDrift.push(`only in cloudflare.config.ts: ${onlyCf.join(", ")}`);
}

const templateDrift = [];
if (cfTemplateNames && cfNames) {
  const onlyCf = cfNames.filter((n) => !cfTemplateNames.includes(n));
  const onlyTmpl = cfTemplateNames.filter((n) => !cfNames.includes(n));
  if (onlyCf.length) templateDrift.push(`in cloudflare.config.ts but missing in template: ${onlyCf.join(", ")}`);
  if (onlyTmpl.length) templateDrift.push(`in cloudflare.config.template.ts but missing in config: ${onlyTmpl.join(", ")}`);
}
for (const key of ["bindings", "ratelimits", "vars"]) {
  const a = JSON.stringify(local[key]);
  const b = JSON.stringify(wranglerTemplate[key]);
  if (a !== b) templateDrift.push(`wrangler.toml vs wrangler.template.toml ${key}: local=${a} template=${b}`);
}

const diffs = [];
for (const key of ["bindings", "ratelimits", "vars"]) {
  const a = JSON.stringify(local[key]);
  const b = JSON.stringify(account[key]);
  if (a !== b) diffs.push(`${key}: local=${a} account=${b}`);
}
for (const key of ["crons", "observability"]) {
  if (local[key] !== account[key]) diffs.push(`${key}: local=${local[key]} account=${account[key]}`);
}

// Checked unconditionally: a shape error is not drift, and the earlier placement
// inside this branch meant it was never evaluated on a clean run, which is exactly
// when it is needed.
const exportIssues = exportProblems(path.join(ROOT, "wrangler.toml"));

if (diffs.length || cfDrift.length || templateDrift.length || exportIssues.length) {
  console.error("config drift detected:");
  for (const problem of exportIssues) {
    console.error(`  - ${problem}`);
  }
  for (const d of diffs) console.error(`  - wrangler.toml vs wrangler.account.toml — ${d}`);
  for (const d of cfDrift) console.error(`  - wrangler.toml vs cloudflare.config.ts — ${d}`);
  for (const d of templateDrift) console.error(`  - template config drift — ${d}`);
  process.exit(1);
}
console.log(
  `config in sync: ${local.bindings.length} bindings, ${local.ratelimits.length} limiters, ${local.vars.length} vars` +
  (cfNames ? `, cloudflare.config.ts ${cfNames.length} bindings` : "") +
  (cfTemplateNames ? `, templates verified` : "")
);
