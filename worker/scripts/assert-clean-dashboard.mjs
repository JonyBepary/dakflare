#!/usr/bin/env node
/**
 * Refuse to ship console assets that no commit describes.
 *
 * `cf deploy` uploads whatever is in `worker/public/admin`. That directory is a build
 * artifact, so it is not in git, and nothing about it says which source produced it. On
 * 2026-11-19 this shipped a half-finished panel to production: a work lane had run the
 * dashboard build to verify its own work, and `deploy:no-dashboard` — which means "do not
 * rebuild", not "do not upload" — published those files one commit early.
 *
 * The rule this enforces: the console you deploy is the console at HEAD. Dirty dashboard
 * source means the assets on disk may contain something nobody reviewed; a dirty artifact
 * is worse than a stale one, because a stale one is honest about being old.
 *
 * Escape hatch: `--force` (or `DAKFLARE_ALLOW_DIRTY_ASSETS=1`) when the difference is
 * known to be cosmetic and shipping now matters more than the rule.
 *
 * Exit codes: 0 clean, 6 precondition (dirty tree, assets missing).
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const assets = resolve(here, "..", "public", "admin", "index.html");

const forced = process.argv.includes("--force") || process.env.DAKFLARE_ALLOW_DIRTY_ASSETS === "1";

function git(args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

if (!existsSync(assets)) {
  console.error(
    "Refusing to deploy: worker/public/admin/index.html is missing.\n" +
      "Run `npm run build:dashboard` (or `npm run deploy`) so the console exists before uploading.",
  );
  process.exit(6);
}

let dirty;
try {
  const tracked = git(["status", "--porcelain", "--", "dashboard/src", "dashboard/static", "dashboard/package.json"]);
  const untrackedStates = git(["status", "--porcelain", "--untracked-files=normal", "--", "dashboard/src/routes/states"]);
  // Workbenches are deliberately local; they never reach a build (prebuild refuses), so a
  // change under routes/states is not a reason to block a deploy.
  const lines = `${tracked}\n${untrackedStates}`
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .filter((line) => !/dashboard\/src\/routes\/states\//.test(line));
  dirty = lines;
} catch (error) {
  console.error(`Refusing to deploy: could not read git status.\n${String(error.message)}`);
  process.exit(6);
}

if (dirty.length === 0) {
  console.log(`console assets verified clean · built from HEAD (${git(["rev-parse", "--short", "HEAD"])})`);
  process.exit(0);
}

const list = dirty.map((line) => `  ${line}`).join("\n");
if (forced) {
  console.warn(
    `Shipping console assets built from a dirty tree because --force was given:\n${list}\n` +
      "Whatever is in these files is now live.",
  );
  process.exit(0);
}

console.error(
  `Refusing to deploy: the console source differs from HEAD, so worker/public/admin may be a\n` +
    `build nobody reviewed.\n\n${list}\n\n` +
    "Commit the console work first, then deploy — the assets are rebuilt by `npm run deploy`.\n" +
    "If this difference is known to be invisible in the built output, re-run with --force.\n",
);
process.exit(6);
