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
    if (section === "d1_databases" || section === "kv_namespaces") {
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

const diffs = [];
for (const key of ["bindings", "ratelimits", "vars"]) {
  const a = JSON.stringify(local[key]);
  const b = JSON.stringify(account[key]);
  if (a !== b) diffs.push(`${key}: local=${a} account=${b}`);
}
for (const key of ["crons", "observability"]) {
  if (local[key] !== account[key]) diffs.push(`${key}: local=${local[key]} account=${account[key]}`);
}

if (diffs.length || cfDrift.length) {
  console.error("config drift detected:");
  for (const d of diffs) console.error(`  - wrangler.toml vs wrangler.account.toml — ${d}`);
  for (const d of cfDrift) console.error(`  - wrangler.toml vs cloudflare.config.ts — ${d}`);
  process.exit(1);
}
console.log(
  `config in sync: ${local.bindings.length} bindings, ${local.ratelimits.length} limiters, ${local.vars.length} vars` +
  (cfNames ? `, cloudflare.config.ts ${cfNames.length} bindings` : "")
);
