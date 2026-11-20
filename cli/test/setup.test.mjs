/**
 * `dakflare setup` contract checks.
 *
 * The wizard is the first thing a new operator runs, so its non-interactive path
 * is pinned here: it must report a plan without writing, star only when asked,
 * use gh only when gh is signed in, and refuse a CLI-only checkout. The fake cf
 * and gh binaries keep the test away from the real Cloudflare/GitHub accounts.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/dakflare.js');

const tmpRoots = [];

async function temp(prefix) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpRoots.push(dir);
  return dir;
}

test.after(async () => {
  await Promise.all(
    tmpRoots.map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

function run(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        NO_COLOR: '1',
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.stdin.end();
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function executable(file, body) {
  await fs.writeFile(file, body, { mode: 0o755 });
  return file;
}

async function fakeRepo({ secrets = true } = {}) {
  const root = await temp('dakflare-setup-');
  for (const dir of ['worker', 'dashboard', 'apps/docs']) {
    await fs.mkdir(path.join(root, dir, 'node_modules'), { recursive: true });
    await fs.writeFile(path.join(root, dir, 'package.json'), '{"name":"fake"}\n');
  }
  if (secrets) {
    await fs.writeFile(
      path.join(root, 'worker', '.dev.vars'),
      'ADMIN_TOKEN=test\nWEBHOOK_SECRET_KEY=test\n',
      { mode: 0o600 }
    );
  }
  return root;
}

async function fakeCf() {
  const dir = await temp('dakflare-cf-');
  return executable(
    path.join(dir, 'cf'),
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "cf 9.0.0"; exit 0; fi
if [ "$1" = "accounts" ]; then exit 0; fi
exit 0
`
  );
}

async function fakeGh({ authenticated = true, apiOk = true } = {}) {
  const dir = await temp('dakflare-gh-');
  const log = path.join(dir, 'calls.log');
  const file = await executable(
    path.join(dir, 'gh'),
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "gh version 9.0.0"; exit 0; fi
if [ "$1" = "auth" ]; then exit ${authenticated ? 0 : 1}; fi
if [ "$1" = "api" ]; then echo "$@" >> "${log}"; exit ${apiOk ? 0 : 1}; fi
exit 1
`
  );
  return { file, log };
}

function data(result) {
  assert.equal(result.code, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout).data;
}

test('setup --help states the star and deploy contract', async () => {
  const result = await run(['setup', '--help']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Usage: dakflare setup/);
  assert.match(result.stdout, /--star/);
  assert.match(result.stdout, /--deploy/);
  assert.match(result.stdout, /never silent/i);
});

test('setup --dry-run reports checks and writes no secrets', async () => {
  const repo = await fakeRepo({ secrets: false });
  const cf = await fakeCf();
  const gh = await fakeGh();
  const config = await temp('dakflare-config-');

  const result = await run(['setup', '--dry-run', '--agent'], {
    DAKFLARE_REPO_DIR: repo,
    DAKFLARE_CF: cf,
    DAKFLARE_GH: gh.file,
    DAKFLARE_CONFIG: config,
    DAKFLARE_NO_BROWSER: '1',
  });
  const document = data(result);

  assert.equal(document.dry_run, true);
  assert.ok(document.checks.some((check) => check.name === 'worker' && check.status === 'ok'));
  assert.ok(document.checks.some((check) => check.name === 'secrets' && check.status === 'warn'));
  assert.ok(document.plan.some((step) => step.includes('worker/.dev.vars: create')));
  await assert.rejects(fs.stat(path.join(repo, 'worker', '.dev.vars')), /ENOENT/);
});

test('setup --star uses an authenticated gh for the configured repository', async () => {
  const repo = await fakeRepo();
  const cf = await fakeCf();
  const gh = await fakeGh({ authenticated: true });
  const config = await temp('dakflare-config-');

  const result = await run(['setup', '--yes', '--star', '--agent'], {
    DAKFLARE_REPO_DIR: repo,
    DAKFLARE_CF: cf,
    DAKFLARE_GH: gh.file,
    DAKFLARE_REPO: 'acme/dakflare-test',
    DAKFLARE_CONFIG: config,
    DAKFLARE_NO_BROWSER: '1',
  });
  const document = data(result);

  assert.equal(document.star.requested, true);
  assert.equal(document.star.starred, true);
  assert.equal(document.star.via, 'gh');
  const calls = await fs.readFile(gh.log, 'utf8');
  assert.match(calls, /api/);
  assert.match(calls, /--method PUT \/user\/starred\/acme\/dakflare-test/);
});

test('setup --star falls back to the URL when gh is not signed in', async () => {
  const repo = await fakeRepo();
  const cf = await fakeCf();
  const gh = await fakeGh({ authenticated: false });
  const config = await temp('dakflare-config-');

  const result = await run(['setup', '--yes', '--star', '--agent'], {
    DAKFLARE_REPO_DIR: repo,
    DAKFLARE_CF: cf,
    DAKFLARE_GH: gh.file,
    DAKFLARE_REPO: 'acme/dakflare-test',
    DAKFLARE_CONFIG: config,
    DAKFLARE_NO_BROWSER: '1',
  });
  const document = data(result);

  assert.equal(document.star.starred, false);
  assert.equal(document.star.via, 'url');
  assert.equal(document.star.gh, 'not_authenticated');
  await assert.rejects(fs.stat(gh.log), /ENOENT/);
});

test('setup --yes does not star without --star', async () => {
  const repo = await fakeRepo();
  const cf = await fakeCf();
  const gh = await fakeGh({ authenticated: true });
  const config = await temp('dakflare-config-');

  const result = await run(['setup', '--yes', '--agent'], {
    DAKFLARE_REPO_DIR: repo,
    DAKFLARE_CF: cf,
    DAKFLARE_GH: gh.file,
    DAKFLARE_CONFIG: config,
    DAKFLARE_NO_BROWSER: '1',
  });
  const document = data(result);

  assert.equal(document.star.requested, false);
  assert.equal(document.star.starred, false);
  await assert.rejects(fs.stat(gh.log), /ENOENT/);
});

test('setup refuses a checkout without worker/package.json', async () => {
  const dir = await temp('dakflare-setup-empty-');
  const config = await temp('dakflare-config-');
  const result = await run(['setup', '--dry-run', '--agent'], {
    DAKFLARE_REPO_DIR: dir,
    DAKFLARE_CONFIG: config,
  });
  assert.equal(result.code, 2);
  const document = JSON.parse(result.stdout);
  assert.equal(document.error.code, 'worker_not_found');
});
