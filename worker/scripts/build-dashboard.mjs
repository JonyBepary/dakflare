#!/usr/bin/env node
/**
 * Build the console, with the local workbenches temporarily out of the tree.
 *
 * `dashboard/src/routes/states/` holds the review workbenches. They are deliberately local
 * — never committed, never shipped — and `scripts/assert-no-workbenches.mjs` enforces that by
 * refusing a build while they exist. The consequence was that the one command an operator
 * runs (`npm run deploy`) failed on any machine where the workbenches existed, and the
 * documented workaround was "move the directory aside by hand, build, move it back" — three
 * steps with no reason to be manual, and a real chance of leaving the workbenches in a build.
 *
 * This does exactly that, atomically, in a `finally`: the directory is renamed inside the
 * dashboard (same filesystem, so the rename cannot half-succeed), the build runs, the
 * directory comes back. On CI, where the workbenches do not exist, this is a no-op.
 *
 * Exit code is the build's.
 */

import { execFileSync } from "node:child_process";
import { existsSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const workerDir = resolve(here, "..");
const dashboardDir = resolve(workerDir, "..", "dashboard");
const states = resolve(dashboardDir, "src", "routes", "states");
const aside = resolve(dashboardDir, ".states-aside");

if (existsSync(aside)) {
  // A previous run died between the rename and the restore. Put it back before building,
  // so the worst case is one confusing directory rather than lost work.
  if (existsSync(states)) {
    console.error(
      `Refusing to build: both ${states} and ${aside} exist.\n` +
        "A previous build did not restore the workbenches. Merge them by hand, then remove .states-aside.",
    );
    process.exit(6);
  }
  renameSync(aside, states);
}

const hidden = existsSync(states);
if (hidden) {
  renameSync(states, aside);
  console.log("console build: workbenches moved aside for the build");
}

let code = 0;
try {
  execFileSync("npm", ["--prefix", dashboardDir, "ci", "--no-audit", "--no-fund"], { stdio: "inherit" });
  execFileSync("npm", ["--prefix", dashboardDir, "run", "build"], { stdio: "inherit" });
} catch (error) {
  code = typeof error.status === "number" ? error.status : 1;
} finally {
  if (hidden && existsSync(aside)) {
    renameSync(aside, states);
    console.log("console build: workbenches restored");
  }
}

process.exit(code);
