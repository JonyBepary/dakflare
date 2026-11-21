/**
 * `dakflare up` and the deploy secrets file.
 *
 * A local `.dev.vars` is also the deploy input. Its auth origins must never
 * become production secrets: `AUTH_BASE_URL=http://127.0.0.1:8787` makes the
 * WebAuthn rpId 127.0.0.1, and a local trusted-origin list rejects the live
 * console. This pins both halves: the local values are filtered into
 * `.dev.vars.deploy`, and a leftover secret from an earlier deploy is deleted
 * so it cannot survive the omission. A public origin is left alone.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../bin/dakflare.js");
const roots = [];

async function temp(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

test.after(async () => {
  await Promise.all(roots.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function run(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, NO_COLOR: "1", DAKFLARE_NO_BROWSER: "1", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function fakeCf(dir) {
  const file = path.join(dir, "cf");
  await fs.writeFile(
    file,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "9.0.0"; exit 0; fi
if [ "$1" = "accounts" ]; then exit 0; fi
if [ "$1" = "d1" ]; then echo '[{"name":"sms_gateway","uuid":"db-test"}]'; exit 0; fi
if [ "$1" = "kv" ]; then echo '[{"title":"KV","id":"kv-test"}]'; exit 0; fi
if [ "$1" = "queues" ]; then echo '[]'; exit 0; fi
if [ "$1" = "r2" ]; then exit 0; fi
exit 0
`,
    { mode: 0o755 }
  );
  return file;
}

async function fakePack(dir, devVars) {
  const pack = path.join(dir, "pack");
  const worker = path.join(pack, ".cloudflare/output/v1/workers/default");
  await fs.mkdir(worker, { recursive: true });
  await fs.mkdir(path.join(pack, "migrations"), { recursive: true });
  await fs.writeFile(path.join(pack, "migrations/0001_baseline.sql"), "SELECT 1;\n");
  await fs.writeFile(
    path.join(pack, "pack.json"),
    JSON.stringify({
      schema: 1,
      version: "9.9.9",
      worker: "dakflare-worker",
      bos: ".cloudflare/output/v1",
      migrations: "migrations",
      requires: { cf: "1.0.0" },
    })
  );
  await fs.writeFile(
    path.join(worker, "worker.config.json"),
    JSON.stringify({ name: "dakflare-worker", env: { DB: {}, KV: {} } })
  );
  await fs.writeFile(path.join(pack, ".dev.vars"), devVars);
  return pack;
}

async function planFor(devVars) {
  const dir = await temp("dakflare-up-");
  const cf = await fakeCf(dir);
  const pack = await fakePack(dir, devVars);
  const result = await run(["up", "--pack", pack, "--dry-run", "--agent"], {
    DAKFLARE_CF: cf,
    DAKFLARE_CONFIG: path.join(dir, "config.json"),
  });
  assert.equal(result.code, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout).data.plan;
}

test("a local auth origin is filtered and its old secret is deleted", async () => {
  const plan = await planFor(
    [
      'AUTH_BASE_URL="http://127.0.0.1:8787"',
      'AUTH_TRUSTED_ORIGINS="http://127.0.0.1:8787"',
      "ADMIN_TOKEN=dk_adm_test",
      "",
    ].join("\n")
  );
  const text = plan.join("\n");
  assert.match(text, /auth: local AUTH_\* origins are not deployed/);
  assert.match(text, /secret AUTH_BASE_URL: delete the local-only value/);
  assert.match(text, /secret AUTH_TRUSTED_ORIGINS: delete the local-only value/);
  assert.match(text, /--secrets-file \.dev\.vars\.deploy/);
});

test("a public auth origin is deployed, not deleted", async () => {
  const plan = await planFor(
    [
      "AUTH_BASE_URL=https://console.example.com",
      "AUTH_TRUSTED_ORIGINS=https://console.example.com",
      "ADMIN_TOKEN=dk_adm_test",
      "",
    ].join("\n")
  );
  const text = plan.join("\n");
  assert.doesNotMatch(text, /delete the local-only value/);
  assert.match(text, /--secrets-file \.dev\.vars(?!\.deploy)/);
});
