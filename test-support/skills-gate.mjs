#!/usr/bin/env node
/**
 * The skills gate.
 *
 * A skill that documents a command the CLI does not have is worse than no skill:
 * an agent follows it, gets `usage`, and concludes the deployment is broken. This
 * script is the thing that stops that, and it is the reason the skills are written
 * LAST, against `capabilities`, rather than alongside the code.
 *
 * What it checks, for every `skills/<name>/SKILL.md`:
 *
 *   1. Frontmatter. `name` matches the directory and is at most 64 characters of
 *      [a-z0-9-]; `description` exists and is at most 1024 characters; `metadata`,
 *      if present, is a map of strings. These are the Agent Skills spec's own
 *      limits, and the spec labels `allowed-tools` experimental, so this script
 *      does not depend on it.
 *   2. Every `dakflare …` invocation. The command must exist, and every `--flag`
 *      must be one that command declares in `capabilities`, plus the three
 *      universal ones. Positional arguments are not checked here: they are data,
 *      and `schema <command>` is where their contract lives.
 *
 *   node test-support/skills-gate.mjs
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SKILLS = path.join(ROOT, "skills");
const CLI = path.join(ROOT, "cli", "bin", "dakflare.js");

/** Flags every command accepts, whatever it declares. */
const UNIVERSAL_FLAGS = new Set(["json", "agent", "help"]);

function capabilities() {
  const run = spawnSync(process.execPath, [CLI, "capabilities", "--agent"], {
    encoding: "utf8",
  });
  if (run.status !== 0) {
    console.error("`dakflare capabilities --agent` failed; the gate cannot run");
    process.exit(2);
  }
  const doc = JSON.parse(run.stdout.trim().split("\n").pop());
  const table = new Map();
  for (const command of doc.data?.commands ?? []) {
    table.set(command.name, { flags: new Set(command.flags ?? []), effect: command.effect });
  }
  return table;
}

/** The YAML frontmatter, as the handful of keys the spec defines. */
function frontmatter(text) {
  if (!text.startsWith("---\n")) return null;
  const end = text.indexOf("\n---", 4);
  if (end === -1) return null;
  const block = text.slice(4, end);
  const fields = new Map();
  let nested = null;
  for (const raw of block.split("\n")) {
    if (raw.trim() === "") continue;
    if (raw.startsWith("  ") && nested !== null) continue; // nested map values
    const match = /^([A-Za-z_-]+):\s*(.*)$/.exec(raw);
    if (match === null) continue;
    fields.set(match[1], match[2].trim());
    nested = match[2].trim() === "" ? match[1] : null;
  }
  return { fields, block };
}

/**
 * Every `dakflare …` invocation in the body, one per line of a fenced block or
 * inline. Backticks and prose are stripped first, so a sentence that mentions the
 * tool does not become an invocation with a flag made of words.
 */
function invocations(text) {
  const found = [];
  for (const line of text.split("\n")) {
    // A line that starts with `#` or is plain prose is skipped; a command is what
    // follows `dakflare` up to the first thing that cannot be an argument.
    const matches = line.matchAll(/\bdakflare\s+([a-z][a-z0-9-]*)([^`\n]*)/g);
    for (const match of matches) {
      const command = match[1];
      const rest = match[2] ?? "";
      const flags = [...rest.matchAll(/(^|\s)(--[a-z][a-z0-9-]*)/g)].map((flag) => flag[2]);
      found.push({ command, flags, line: line.trim().slice(0, 120) });
    }
  }
  return found;
}

const table = capabilities();
const failures = [];
const skills = fs
  .readdirSync(SKILLS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

if (skills.length === 0) {
  console.error("no skills found under skills/");
  process.exit(2);
}

for (const directory of skills) {
  const file = path.join(SKILLS, directory, "SKILL.md");
  if (!fs.existsSync(file)) {
    failures.push(`${directory}: no SKILL.md`);
    continue;
  }
  const text = fs.readFileSync(file, "utf8");

  /* ---- frontmatter -------------------------------------------------- */
  const meta = frontmatter(text);
  if (meta === null) {
    failures.push(`${directory}: missing YAML frontmatter`);
  } else {
    const name = meta.fields.get("name");
    if (name !== directory) {
      failures.push(`${directory}: name "${name ?? ""}" must match the directory`);
    }
    if (name !== undefined && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
      failures.push(`${directory}: name must be lowercase letters, digits and single hyphens`);
    }
    if (name !== undefined && name.length > 64) {
      failures.push(`${directory}: name is ${name.length} characters, the limit is 64`);
    }
    const description = meta.fields.get("description") ?? "";
    if (description === "") failures.push(`${directory}: description is required`);
    if (description.length > 1_024) {
      failures.push(`${directory}: description is ${description.length} characters, the limit is 1024`);
    }
    if (meta.fields.has("metadata")) {
      // The spec types metadata as string -> string; a bare number is the trap.
      const bad = meta.block
        .split("\n")
        .filter((line) => /^\s{2,}[A-Za-z_-]+:\s*[0-9]/.test(line));
      for (const line of bad) {
        failures.push(`${directory}: metadata value must be a string: ${line.trim()}`);
      }
    }
  }

  /* ---- invocations --------------------------------------------------- */
  let checked = 0;
  for (const call of invocations(text)) {
    const entry = table.get(call.command);
    if (entry === undefined) {
      failures.push(`${directory}: "dakflare ${call.command}" is not a command`);
      continue;
    }
    checked += 1;
    for (const flag of call.flags) {
      const name = flag.slice(2);
      if (entry.flags.has(name) || UNIVERSAL_FLAGS.has(name)) continue;
      failures.push(
        `${directory}: "dakflare ${call.command}" has no ${flag} (declared: ${[...entry.flags].join(", ") || "none"})`
      );
    }
  }

  const words = text.split(/\s+/).length;
  // Not a hard spec limit: guidance is under 5,000 tokens and under 500 lines.
  const lines = text.split("\n").length;
  console.log(
    `${directory.padEnd(22)} ${String(checked).padStart(3)} invocations  ${String(lines).padStart(4)} lines  ~${Math.round(words * 1.3)} tokens`
  );
  if (lines > 500) {
    failures.push(`${directory}: ${lines} lines, the guidance is under 500`);
  }
}

if (failures.length > 0) {
  console.error(`\nskills gate: ${failures.length} problem(s)`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log(`\nskills gate: ${skills.length} skills, every invocation exists`);
