#!/usr/bin/env node
/**
 * Build the precompiled Worker pack.
 *
 * The pack is a complete `cf` Build Output Specification plus the D1 migrations
 * and a small `pack.json`. Deploying it needs `cf` and a Cloudflare account, not
 * this repository, npm installs, or a Worker build:
 *
 *   cf deploy --prebuilt --secrets-file .dev.vars
 *
 * The D1 and KV ids are replaced with placeholders so one pack serves every
 * account. `dakflare up --pack <dir>` creates the resources and fills them in.
 *
 * This script is a release/CI tool and needs the newer `cf` toolchain (the one
 * that writes Build Output v1). It deliberately installs it with --no-save.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const worker = path.join(repo, 'worker');
const CF_VERSION = '1.0.0-rc.2';
const WRANGLER_VERSION = '4.166.0';

const args = process.argv.slice(2);
const outArg = args.indexOf('--out');
const outDir = outArg >= 0 ? path.resolve(args[outArg + 1]) : path.join(repo, 'dist');
const skipVerify = args.includes('--skip-verify');

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd ?? repo,
    encoding: 'utf8',
    stdio: options.inherit ? 'inherit' : 'pipe',
  });
  if (result.error || result.status !== 0) {
    const detail = (result.stderr || result.stdout || result.error?.message || '').trim();
    throw new Error(`${command} ${commandArgs.join(' ')} failed: ${detail}`);
  }
  return result.stdout ?? '';
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(source, target);
    else if (entry.isFile()) fs.copyFileSync(source, target);
  }
}

const version = readJson(path.join(worker, 'package.json')).version;
if (typeof version !== 'string' || version === '') throw new Error('worker/package.json has no version');

fs.mkdirSync(outDir, { recursive: true });

// The release toolchain, not the development one: Build Output v1 is written by
// cf 1.0.0-rc.2 and needs wrangler >= 4.163. This is CI-only and --no-save.
console.log(`Installing release toolchain: cf@${CF_VERSION}, wrangler@${WRANGLER_VERSION}`);
run('npm', ['install', '--no-save', '--no-audit', '--no-fund', `cf@${CF_VERSION}`, `wrangler@${WRANGLER_VERSION}`], {
  cwd: worker,
  inherit: false,
});

console.log('Building the console into worker/public/admin');
run('npm', ['run', 'build:dashboard'], { cwd: worker, inherit: true });

console.log('Building the Worker Build Output');
run('npx', ['cf', 'build'], { cwd: worker, inherit: true });

const output = path.join(worker, '.cloudflare', 'output', 'v1');
const workerConfigPath = path.join(output, 'workers', 'default', 'worker.config.json');
if (!fs.existsSync(workerConfigPath)) {
  throw new Error(
    'cf build did not write .cloudflare/output/v1. The local cf is probably the old beta; ' +
      `this pack needs cf ${CF_VERSION} and wrangler ${WRANGLER_VERSION}.`
  );
}

const workerConfig = readJson(workerConfigPath);
for (const binding of ['DB', 'KV']) {
  if (!workerConfig.env?.[binding]) throw new Error(`worker.config.json has no ${binding} binding`);
}
workerConfig.env.DB.id = '__DAKFLARE_D1_ID__';
workerConfig.env.KV.id = '__DAKFLARE_KV_ID__';
writeJson(workerConfigPath, workerConfig);

const stage = path.join(outDir, `dakflare-pack-${version}`);
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
copyDir(output, path.join(stage, '.cloudflare', 'output', 'v1'));
copyDir(path.join(worker, 'migrations'), path.join(stage, 'migrations'));
fs.copyFileSync(path.join(repo, 'LICENSE'), path.join(stage, 'LICENSE'));
fs.copyFileSync(path.join(repo, 'README.md'), path.join(stage, 'README.md'));

writeJson(path.join(stage, 'pack.json'), {
  schema: 1,
  version,
  worker: workerConfig.name,
  bos: '.cloudflare/output/v1',
  migrations: 'migrations',
  secrets: ['ADMIN_TOKEN', 'AUTH_PEPPER', 'BETTER_AUTH_SECRET', 'WEBHOOK_SECRET_KEY'],
  placeholders: {
    d1: '__DAKFLARE_D1_ID__',
    kv: '__DAKFLARE_KV_ID__',
  },
  requires: {
    cf: CF_VERSION,
  },
});

const archive = path.join(outDir, `dakflare-pack-${version}.tar.gz`);
fs.rmSync(archive, { force: true });
run('tar', ['-czf', archive, '-C', outDir, `dakflare-pack-${version}`]);

if (!skipVerify) {
  console.log('Verifying the pack with cf deploy --prebuilt --dry-run');
  run('npx', ['--yes', `cf@${CF_VERSION}`, 'deploy', '--prebuilt', '--dry-run'], {
    cwd: stage,
    inherit: true,
  });
  run('npx', ['--yes', `cf@${CF_VERSION}`, 'd1', 'migrations', 'apply', '00000000-0000-0000-0000-000000000000', '--dir', 'migrations', '--dry-run'], {
    cwd: stage,
    inherit: true,
  });
}

const bytes = fs.statSync(archive).size;
console.log(`\npack      ${archive}`);
console.log(`version  ${version}`);
console.log(`size     ${(bytes / 1024 / 1024).toFixed(1)} MiB`);
