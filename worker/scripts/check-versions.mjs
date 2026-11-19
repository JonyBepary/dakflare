#!/usr/bin/env node
/**
 * One version, or the release does not happen.
 *
 * The version lives in two files — `cli/bin/dakflare.js` (`CLI_VERSION`, what `dakflare
 * --version` prints) and `worker/package.json` (what the deployment is) — and a release adds a
 * third statement of it: the tag. A tag that disagrees with either is how a release ends up
 * shipping something other than what it is called.
 *
 *   node worker/scripts/check-versions.mjs             # do the two files agree?
 *   node worker/scripts/check-versions.mjs v6.2.0      # …and does the tag agree with them?
 *
 * Exit codes: 0 agree, 1 disagree, 6 a version could not be read.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");

function readPackageVersion() {
  const pkg = JSON.parse(readFileSync(resolve(root, "worker", "package.json"), "utf8"));
  return typeof pkg.version === "string" ? pkg.version : null;
}

function readCliVersion() {
  const source = readFileSync(resolve(root, "cli", "bin", "dakflare.js"), "utf8");
  const match = source.match(/const CLI_VERSION = '([^']+)'/);
  return match === null ? null : match[1];
}

const packageVersion = readPackageVersion();
const cliVersion = readCliVersion();

if (packageVersion === null || cliVersion === null) {
  console.error(
    `could not read a version: worker/package.json=${packageVersion ?? "missing"}, ` +
      `cli/bin/dakflare.js CLI_VERSION=${cliVersion ?? "missing"}`,
  );
  process.exit(6);
}

const problems = [];
if (cliVersion !== packageVersion) {
  problems.push(`the CLI says ${cliVersion}, the Worker package says ${packageVersion}`);
}

const tag = process.argv[2];
if (tag !== undefined) {
  const named = tag.replace(/^v/, "");
  if (named !== packageVersion) problems.push(`the tag names ${named}, the code says ${packageVersion}`);
}

if (problems.length > 0) {
  console.error(`version mismatch:\n${problems.map((line) => `  - ${line}`).join("\n")}`);
  process.exit(1);
}

console.log(
  tag === undefined
    ? `versions agree: ${packageVersion}`
    : `versions agree: ${packageVersion} (tag ${tag})`,
);
process.exit(0);
