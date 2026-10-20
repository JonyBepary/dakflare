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
    if (section === "durable_objects.bindings" || section === "d1_databases" || section === "kv_namespaces") {
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

const diffs = [];
for (const key of ["bindings", "ratelimits", "vars"]) {
  const a = JSON.stringify(local[key]);
  const b = JSON.stringify(account[key]);
  if (a !== b) diffs.push(`${key}: local=${a} account=${b}`);
}
for (const key of ["crons", "observability"]) {
  if (local[key] !== account[key]) diffs.push(`${key}: local=${local[key]} account=${account[key]}`);
}

if (diffs.length) {
  console.error("config drift between wrangler.toml and wrangler.account.toml:");
  for (const d of diffs) console.error(`  - ${d}`);
  process.exit(1);
}
console.log(
  `config in sync: ${local.bindings.length} bindings, ${local.ratelimits.length} limiters, ${local.vars.length} vars`
);
