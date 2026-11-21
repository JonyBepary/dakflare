#!/usr/bin/env node
/**
 * Build the standalone CLI binaries for a release.
 *
 * These are Bun-compiled executables: no Node install is needed to run
 * `init`, `send`, `status`, `doctor`, `setup`, or a pack deploy. A deploy still
 * uses `cf` (which is Node), so the installer may install Node for that one
 * tool; the CLI itself no longer depends on it.
 *
 * Generated names are stable so `install.sh` and the release page can use
 * `@latest` without knowing the version:
 *
 *   dakflare-linux-x64
 *   dakflare-linux-arm64
 *   dakflare-darwin-x64
 *   dakflare-darwin-arm64
 *   dakflare-windows-x64.exe
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const cli = path.join(repo, 'cli', 'bin', 'dakflare.js');
const outArg = process.argv.indexOf('--out');
const outDir = outArg >= 0 ? path.resolve(process.argv[outArg + 1]) : path.join(repo, 'dist');
const bun = process.env.BUN || 'bun';

const targets = [
  ['bun-linux-x64', 'dakflare-linux-x64', false],
  ['bun-linux-arm64', 'dakflare-linux-arm64', false],
  ['bun-darwin-x64', 'dakflare-darwin-x64', false],
  ['bun-darwin-arm64', 'dakflare-darwin-arm64', false],
  ['bun-windows-x64', 'dakflare-windows-x64', true],
];

fs.mkdirSync(outDir, { recursive: true });

function version() {
  const result = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error('the CLI does not run');
  return result.stdout.trim().replace(/^dakflare\s+/, '');
}

const releaseVersion = version();

for (const [target, name, windows] of targets) {
  const file = path.join(outDir, windows ? `${name}.exe` : name);
  console.log(`build ${target} -> ${path.basename(file)}`);
  const result = spawnSync(bun, ['build', '--compile', `--target=${target}`, cli, '--outfile', file], {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    const detail = (result.stderr || result.stdout || result.error?.message || '').trim();
    throw new Error(`bun ${target} failed: ${detail}`);
  }
  if (!fs.existsSync(file)) throw new Error(`bun ${target} wrote no ${file}`);
  if (!windows) fs.chmodSync(file, 0o755);
  const sum = spawnSync('sha256sum', [file], { cwd: outDir, encoding: 'utf8' });
  if (sum.status === 0) {
    fs.writeFileSync(`${file}.sha256`, sum.stdout.replace(file, path.basename(file)));
  }
}

console.log(`\nCLI binaries for ${releaseVersion} are in ${outDir}`);
