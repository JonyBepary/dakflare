#!/usr/bin/env node
/**
 * Refuse to ship console assets that no commit describes.
 *
 * `cf deploy` uploads whatever is in `worker/public/admin`, which is a build artifact and not
 * in git. On 2026-11-19 that shipped a half-finished panel to production: a lane had built the
 * console to verify its own work, and `deploy:worker` — which means "do not rebuild", not "do
 * not upload" — published those files a commit early.
 *
 * The first version of this guard refused whenever `dashboard/src` differed from HEAD. That
 * closed the hole and opened another: editing the console made every Worker-only deploy
 * impossible, even though the assets on disk were the last reviewed build and the Worker change
 * had nothing to do with them.
 *
 * So the build records itself. `build-dashboard.mjs` writes `worker/.build-source.json` with the
 * commit it built from and whether that tree was dirty. This gate then asks two questions:
 *
 *   1. Was the build made from a dirty tree? If so it may contain work nobody reviewed — refuse.
 *   2. Has the console changed since that commit? If not, the artifact is current even if the
 *      working tree is dirty with something else — allow.
 *
 * Assets with no manifest are refused: unknown provenance is the thing this exists to stop.
 * `--force` (or DAKFLARE_ALLOW_DIRTY_ASSETS=1) ships anyway and says so.
 *
 * Exit codes: 0 allowed, 6 refused.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const workerDir = resolve(here, "..");
const repo = resolve(workerDir, "..");
const assets = resolve(workerDir, "public", "admin", "index.html");
const manifestPath = resolve(workerDir, ".build-source.json");

/** The paths that can change the built console. A docs commit is not a console change. */
const CONSOLE_PATHS = ["dashboard/src", "dashboard/static", "dashboard/package.json", "dashboard/vite.config.ts"];

const forced = process.argv.includes("--force") || process.env.DAKFLARE_ALLOW_DIRTY_ASSETS === "1";

function git(args) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function refuse(lines) {
  if (forced) {
    console.warn(`${lines.join("\n")}\n\nShipping anyway because --force was given.`);
    process.exit(0);
  }
  console.error(`${lines.join("\n")}\n`);
  process.exit(6);
}

if (!existsSync(assets)) {
  refuse([
    "Refusing to deploy: worker/public/admin/index.html is missing.",
    "Run `npm run build:dashboard` (or `npm run deploy`) so the console exists before uploading.",
  ]);
}

if (!existsSync(manifestPath)) {
  refuse([
    "Refusing to deploy: worker/public/admin has no build manifest, so nothing says which",
    `source produced it. Run \`npm run build:dashboard\` once to record it (${manifestPath}).`,
    "If you know these assets are the reviewed build, re-run with --force.",
  ]);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (error) {
  refuse([
    `Refusing to deploy: ${manifestPath} is unreadable (${String(error.message)}).`,
    "Rebuild the console so the manifest describes what is actually there.",
  ]);
}

if (!manifest || typeof manifest.sha !== "string" || typeof manifest.dirty !== "boolean") {
  refuse([
    `Refusing to deploy: ${manifestPath} does not describe a build.`,
    "Rebuild the console so the manifest describes what is actually there.",
  ]);
}

if (manifest.dirty) {
  refuse([
    "Refusing to deploy: the console was built from a dirty tree, so these assets may contain",
    "work nobody reviewed.",
    "Commit the console work and rebuild, or re-run with --force if you know the difference is",
    "invisible in the built output.",
  ]);
}

let drift;
try {
  drift = git(["diff", "--name-only", `${manifest.sha}..HEAD`, "--", ...CONSOLE_PATHS]);
} catch {
  refuse([
    `Refusing to deploy: the build names commit ${manifest.sha.slice(0, 8)}, which this checkout does not have.`,
    "Rebuild the console from the commit you are deploying.",
  ]);
}

if (drift !== "") {
  refuse([
    `Refusing to deploy: the console has changed since the build's commit (${manifest.sha.slice(0, 8)}).`,
    ...drift.split("\n").map((line) => `  ${line}`),
    "",
    "Rebuild with `npm run deploy`, or deploy the Worker without assets from that commit.",
  ]);
}

console.log(
  `console assets match HEAD · built from ${manifest.sha.slice(0, 8)}` +
    (manifest.dirty ? " (dirty)" : "") +
    ` · ${git(["rev-parse", "--short", "HEAD"])}`,
);
process.exit(0);
