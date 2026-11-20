/**
 * `init --local` writes only where it can justify writing.
 *
 * The regression this covers: run from a directory with no Worker checkout, the
 * command skipped the temp `worker/` and fell back to the CLI's own repository,
 * rotating a different project's `.dev.vars`.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, '../bin/dakflare.js');
const REPO_DEV_VARS = path.resolve(HERE, '../../worker/.dev.vars');

function run(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: '1' },
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

function exists(file) {
  return fs
    .access(file)
    .then(() => true)
    .catch(() => false);
}

test('init --local outside a checkout exits 2 and writes nothing anywhere', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'dakflare-init-nowhere-'));
  const before = await fs.readFile(REPO_DEV_VARS, 'utf8');

  const result = await run(['init', '--local', '--force', '--agent'], cwd);

  assert.equal(result.code, 2, result.stderr);
  assert.equal(await exists(path.join(cwd, 'worker', '.dev.vars')), false);
  assert.equal(await exists(path.join(cwd, '.dev.vars')), false);
  assert.equal(await fs.readFile(REPO_DEV_VARS, 'utf8'), before, 'the checkout must not be touched');

  const document = JSON.parse(result.stdout);
  assert.equal(document.status, 'error');
  assert.equal(document.error.code, 'worker_not_found');
  assert.match(document.error.message, /Run this from the repository root, or use `dakflare up`/);

  await fs.rm(cwd, { recursive: true, force: true });
});

test('init --local writes .dev.vars in a temp worker checkout with all four keys', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'dakflare-init-worker-'));
  const worker = path.join(cwd, 'worker');
  await fs.mkdir(worker);
  await fs.writeFile(path.join(worker, 'package.json'), '{}\n', 'utf8');
  const before = await fs.readFile(REPO_DEV_VARS, 'utf8');

  const result = await run(['init', '--local', '--agent'], cwd);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim().split('\n').length, 1, '--agent must emit one JSON document');
  const document = JSON.parse(result.stdout);
  assert.deepEqual(document.data.generated, [
    'ADMIN_TOKEN',
    'AUTH_PEPPER',
    'BETTER_AUTH_SECRET',
    'WEBHOOK_SECRET_KEY',
  ]);

  const file = path.join(worker, '.dev.vars');
  const content = await fs.readFile(file, 'utf8');
  for (const key of document.data.generated) {
    assert.match(content, new RegExp(`^${key}=`, 'm'), `missing ${key}`);
  }
  assert.equal(await fs.readFile(REPO_DEV_VARS, 'utf8'), before, 'the checkout must not be touched');

  await fs.rm(cwd, { recursive: true, force: true });
});
