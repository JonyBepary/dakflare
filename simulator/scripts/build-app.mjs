#!/usr/bin/env node
/**
 * Build the device app's web assets with the local workbenches out of the tree.
 *
 * `src/routes/states/` holds the review workbenches. They are local-only, and
 * `scripts/assert-no-workbenches.mjs` (wired as `prebuild`) refuses a production build while
 * they exist — which protects the phone from a bundle full of stubbed endpoints, and also
 * broke the one command that builds the app.
 *
 * Rather than weaken the guard, this moves the directory aside inside the simulator (same
 * filesystem, so the rename cannot half-succeed), builds, and puts it back in a `finally`.
 * Tauri's `beforeBuildCommand` calls this, so `tauri android build` works while every other
 * route to a production bundle still refuses. On CI, where the workbenches do not exist, it
 * is a no-op.
 */

import { execFileSync } from "node:child_process";
import { existsSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, "..");
const states = resolve(appDir, "src", "routes", "states");
const aside = resolve(appDir, ".states-aside");

if (existsSync(aside)) {
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
  console.log("app build: workbenches moved aside");
}

let code = 0;
try {
  execFileSync("npx", ["vite", "build"], { cwd: appDir, stdio: "inherit" });
} catch (error) {
  code = typeof error.status === "number" ? error.status : 1;
} finally {
  if (hidden && existsSync(aside)) {
    renameSync(aside, states);
    console.log("app build: workbenches restored");
  }
}

process.exit(code);
