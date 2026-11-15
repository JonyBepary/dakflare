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

/**
 * Workflow names, across all three configs.
 *
 * A workflow is declared in two places per file (a `[[workflows]]` binding and an
 * export, or a `bindings.workflow()` and an `exports.workflow()`), and nothing above
 * compared them. That is how `wrangler.toml` lost the `name` that `cloudflare.config.ts`
 * still had: production deployed fine, and the conformance suite could not start.
 */
function workflowNames(file) {
  const text = fs.readFileSync(file, "utf8");
  const names = new Set();

  // Line-based, and it stops at the next table header. A lazy `[\s\S]*?` between
  // `[[workflows]]` and the next `name =` ran past the block and picked up a
  // rate-limiter's name, which read as a phantom workflow in two configs.
  let inWorkflows = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const header = /^\[\[?([^\]]+)\]\]?$/.exec(line);
    if (header) {
      inWorkflows = header[1] === "workflows";
      continue;
    }
    if (inWorkflows) {
      const pair = /^name\s*=\s*"([^"]+)"/.exec(line);
      if (pair) names.add(pair[1]);
    }
  }

  for (const m of text.matchAll(/exports\.workflow\(\s*\{\s*name:\s*"([^"]+)"/g)) names.add(m[1]);
  for (const m of text.matchAll(/bindings\.workflow\(\s*\{\s*name:\s*"([^"]+)"/g)) names.add(m[1]);
  return names;
}

/**
 * Durable Object classes per carrier, and the binding→class map.
 *
 * The previous check compared binding NAMES only, so `DEVICE` could point at a
 * different class in two files and nothing noticed. Two carriers express the
 * class two ways:
 *
 *   TOML    `[[durable_objects.bindings]] name/class_name` and `[exports.X]`
 *   cf/TS   `NAME: bindings.durableObject({ exportName: "X" })` and `X: exports.durableObject(...)`
 *
 * `exports` is the current Wrangler lifecycle syntax; `[[migrations]]` is the
 * older ordered history that `wrangler.account.toml` still carries. They are
 * different representations of the same set, so the class SET is comparable
 * across all of them even where the tag history is not.
 */
function durableObjects(file) {
  if (!fs.existsSync(file)) return { bindings: {}, classes: [], tags: [], migrationClasses: [] };
  const text = fs.readFileSync(file, "utf8");
  const bindings = {};
  const classes = new Set();
  const tags = [];
  const migrationClasses = new Set();

  let section = null;
  let exportName = null;
  let migration = null;
  let pendingBinding = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const header = /^\[\[?([^\]]+)\]\]?$/.exec(line);
    if (header) {
      section = header[1].trim();
      exportName = section.startsWith("exports.") ? section.slice("exports.".length) : null;
      migration = section === "migrations" ? { tag: null } : null;
      pendingBinding = null;
      if (migration !== null) tags.push(migration);
      continue;
    }
    if (section === "durable_objects.bindings") {
      const m = /^(name|class_name)\s*=\s*"([^"]+)"/.exec(line);
      if (m) {
        if (m[1] === "name") {
          pendingBinding = m[2];
        } else {
          classes.add(m[2]);
          if (pendingBinding !== null) bindings[pendingBinding] = m[2];
          pendingBinding = null;
        }
      }
    }
    if (exportName !== null && /^type\s*=\s*"durable-object"/.test(line)) {
      classes.add(exportName);
    }
    if (migration !== null) {
      const tag = /^tag\s*=\s*"([^"]+)"/.exec(line);
      if (tag) migration.tag = tag[1];
      const created = /^new_sqlite_classes\s*=\s*\[([^\]]*)\]/.exec(line);
      if (created) {
        for (const cls of created[1].matchAll(/"([^"]+)"/g)) migrationClasses.add(cls[1]);
      }
    }
  }

  // TypeScript carriers.
  for (const m of text.matchAll(/^\s{2,}([A-Za-z][A-Za-z0-9_]*):\s*exports\.durableObject\(/gm)) {
    classes.add(m[1]);
  }
  for (const m of text.matchAll(
    /^\s{2,}([A-Z][A-Z0-9_]*):\s*bindings\.durableObject\(\{([\s\S]*?)\}\)/gm
  )) {
    const target = /exportName:\s*"([^"]+)"/.exec(m[2]);
    if (target) bindings[m[1]] = target[1];
  }

  return {
    bindings,
    classes: [...classes].sort(),
    tags: tags.map((entry) => entry.tag).filter((tag) => tag !== null),
    migrationClasses: [...migrationClasses].sort(),
  };
}

function compareObjectSets(label, files) {
  const problems = [];
  const [first, ...rest] = files;
  for (const other of rest) {
    const a = JSON.stringify(first.objects.classes);
    const b = JSON.stringify(other.objects.classes);
    if (a !== b) problem(`durable object classes: ${first.name}=${a} ${other.name}=${b}`);
    const ab = JSON.stringify(first.objects.bindings);
    const bb = JSON.stringify(other.objects.bindings);
    if (ab !== bb) problem(`durable object binding→class: ${first.name}=${ab} ${other.name}=${bb}`);
  }
  return problems;

  function problem(message) {
    problems.push(`${label}: ${message}`);
  }
}

const AGENT_RUNTIME_DEFAULT = "off";

const ROOT = path.join(HERE, "..");

const CARRIERS = [
  ["wrangler.toml", "wrangler.toml"],
  ["wrangler.account.toml", "wrangler.account.toml"],
  ["wrangler.template.toml", "wrangler.template.toml"],
  ["cloudflare.config.ts", "cloudflare.config.ts"],
  ["cloudflare.config.template.ts", "cloudflare.config.template.ts"],
].map(([name, file]) => ({ name, objects: durableObjects(path.join(ROOT, file)) }));

const objectIssues = compareObjectSets("durable objects", CARRIERS);

// A class that a carrier exports but its migration history never created is a
// deploy that fails (or silently reuses another class's namespace). Only the
// account lane declares ordered tags, so this is checked only there.
const accountObjects = CARRIERS.find((carrier) => carrier.name === "wrangler.account.toml").objects;
const localObjects = CARRIERS.find((carrier) => carrier.name === "wrangler.toml").objects;
for (const cls of accountObjects.classes) {
  if (!accountObjects.migrationClasses.includes(cls)) {
    objectIssues.push(
      `wrangler.account.toml exports ${cls} but no [[migrations]] new_sqlite_classes creates it`
    );
  }
}
for (const cls of accountObjects.migrationClasses) {
  if (!accountObjects.classes.includes(cls)) {
    objectIssues.push(
      `wrangler.account.toml migration creates ${cls} but no binding/export declares it`
    );
  }
}

/**
 * Agents can be enabled by a deploy that forgot one carrier. Compare the
 * default, which must be `off` everywhere: the runtime is opt-in.
 */
const runtimeDefaults = [];
for (const [file, text] of CARRIERS.map((carrier) => [
  carrier.name,
  fs.readFileSync(path.join(ROOT, carrier.name), "utf8"),
])) {
  const toml = /^AGENT_RUNTIME\s*=\s*"([^"]*)"/m.exec(text);
  const ts = /AGENT_RUNTIME:\s*bindings\.text\("([^"]*)"\)/m.exec(text);
  const value = toml?.[1] ?? ts?.[1];
  if (value === undefined) {
    objectIssues.push(`${file}: no AGENT_RUNTIME var`);
  } else {
    runtimeDefaults.push(value);
  }
}
if (new Set(runtimeDefaults).size > 1) {
  objectIssues.push(`AGENT_RUNTIME defaults disagree: ${runtimeDefaults.join(", ")}`);
} else if (runtimeDefaults[0] !== AGENT_RUNTIME_DEFAULT) {
  objectIssues.push(`AGENT_RUNTIME default is "${runtimeDefaults[0]}", expected "${AGENT_RUNTIME_DEFAULT}"`);
}

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

// Workflows must be the same set in every config, or one deployment path silently
// lacks a binding the code uses.
const localWorkflows = workflowNames(path.join(ROOT, "wrangler.toml"));
const accountWorkflows = workflowNames(path.join(ROOT, "wrangler.account.toml"));
const cfWorkflows = workflowNames(path.join(ROOT, "cloudflare.config.ts"));
if (cfWorkflows.size > 0) {
  for (const name of localWorkflows) {
    if (!cfWorkflows.has(name)) exportIssues.push(`workflow "${name}" is in wrangler.toml but not cloudflare.config.ts`);
  }
  for (const name of cfWorkflows) {
    if (localWorkflows.size > 0 && !localWorkflows.has(name)) exportIssues.push(`workflow "${name}" is in cloudflare.config.ts but not wrangler.toml`);
  }
}
if (accountWorkflows.size > 0) {
  for (const name of localWorkflows) {
    if (!accountWorkflows.has(name)) exportIssues.push(`workflow "${name}" is in wrangler.toml but not wrangler.account.toml`);
  }
}

if (
  diffs.length ||
  cfDrift.length ||
  templateDrift.length ||
  exportIssues.length ||
  objectIssues.length
) {
  console.error("config drift detected:");
  for (const problem of exportIssues) {
    console.error(`  - ${problem}`);
  }
  for (const problem of objectIssues) console.error(`  - ${problem}`);
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
console.log(
  `durable objects: ${localObjects.classes.length} classes [${localObjects.classes.join(", ")}] ` +
  `compared across ${CARRIERS.length} carriers (bindings and class names)`
);
console.log(
  `migration tags: wrangler.account.toml [${accountObjects.tags.join(", ")}] creates ` +
  `[${accountObjects.migrationClasses.join(", ")}] — only that carrier declares [[migrations]]; ` +
  `wrangler.toml, wrangler.template.toml and both cloudflare.config*.ts use [exports], ` +
  `which has no ordered tag, so tag order is NOT comparable outside the account lane (class sets are)`
);
