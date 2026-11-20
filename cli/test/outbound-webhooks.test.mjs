/**
 * CLI contract checks for outbound webhooks and `webhooks test`.
 *
 * Uses Node's built-in test runner and a local HTTP server, so it asserts the
 * request that reaches the Worker as well as the text and exit code.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/dakflare.js');

let server;
let baseUrl;
let configDir;
let requests = [];

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        DAKFLARE_CONFIG: configDir,
        NO_COLOR: '1',
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

function lastRequest() {
  return requests[requests.length - 1];
}

test.before(async () => {
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dakflare-outbound-cli-'));
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const body = raw === '' ? null : JSON.parse(raw);
      requests.push({ method: req.method, path: req.url, body });
      res.setHeader('Content-Type', 'application/json');

      if (req.method === 'POST' && req.url === '/v1/admin/webhooks') {
        res.statusCode = 201;
        res.end(
          JSON.stringify({
            id: 'wh_out',
            name: body.name,
            kind: body.kind ?? 'inbound',
            target_url: body.target_url ?? null,
            secret: 'whsec_out_only_shown_once',
            enabled: true,
          })
        );
        return;
      }
      if (req.method === 'GET' && req.url === '/v1/admin/webhooks?kind=outbound') {
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            webhooks: [
              {
                id: 'wh_out',
                name: 'delivery feed',
                kind: 'outbound',
                target_url: 'https://example.com/hooks/sms',
                enabled: true,
                events: ['delivered', 'failed'],
                custom_headers: {},
                timeout_ms: 5000,
                max_attempts: 3,
                created_by: 'owner',
                created_at: 1700000000000,
                last_delivery_at: null,
                secret_set: true,
              },
            ],
          })
        );
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/admin/webhooks/wh_out/test') {
        res.statusCode = 200;
        res.end(JSON.stringify({ ok: true, status: 200, latency_ms: 123, signed: true }));
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/admin/webhooks/wh_fail/test') {
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            ok: false,
            status: 500,
            latency_ms: 42,
            signed: true,
            error: 'the target returned HTTP 500',
          })
        );
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/admin/webhooks/wh_missing/test') {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'not_found' }));
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/admin/webhooks/wh_conflict/test') {
        res.statusCode = 409;
        res.end(JSON.stringify({ error: 'webhook_disabled' }));
        return;
      }
      if (req.method === 'DELETE') {
        res.statusCode = 200;
        res.end(JSON.stringify({ deleted: true, id: 'wh_out' }));
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not_found' }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
  await fs.writeFile(
    path.join(configDir, 'config.json'),
    JSON.stringify({ url: baseUrl, token: 'test-admin-token' }),
    { mode: 0o600 }
  );
});

test.beforeEach(() => {
  requests = [];
});

test.after(async () => {
  if (server !== undefined) await new Promise((resolve) => server.close(resolve));
  if (configDir !== undefined) await fs.rm(configDir, { recursive: true, force: true });
});

test('outbound create posts the target and prints the secret once', async () => {
  const result = await run([
    'webhooks',
    'create',
    '--kind',
    'outbound',
    '--name',
    'delivery feed',
    '--url',
    'https://example.com/hooks/sms',
  ]);

  assert.equal(result.code, 0, result.stderr);
  const request = lastRequest();
  assert.equal(request.method, 'POST');
  assert.equal(request.path, '/v1/admin/webhooks');
  assert.deepEqual(request.body, {
    kind: 'outbound',
    name: 'delivery feed',
    target_url: 'https://example.com/hooks/sms',
  });
  assert.match(result.stdout, /Created outbound webhook wh_out/);
  assert.match(result.stdout, /signing secret \(shown once\): whsec_out_only_shown_once/);
  assert.match(result.stdout, /will not be shown again/);
});

test('outbound create sends events and the timeout when given', async () => {
  const result = await run([
    'webhooks',
    'create',
    '--kind',
    'outbound',
    '--name',
    'delivery feed',
    '--url',
    'https://example.com/hooks/sms',
    '--event',
    'delivered',
    '--event',
    'failed,sent',
    '--timeout-ms',
    '5000',
    '--agent',
  ]);

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(lastRequest().body, {
    kind: 'outbound',
    name: 'delivery feed',
    target_url: 'https://example.com/hooks/sms',
    events: ['delivered', 'failed', 'sent'],
    timeout_ms: 5000,
  });
  assert.equal(result.stdout.trim().split('\n').length, 1, '--agent must emit one JSON document');
  const document = JSON.parse(result.stdout);
  assert.equal(document.data.id, 'wh_out');
});

test('list --kind outbound sends the filter and prints the target URL', async () => {
  const result = await run(['webhooks', 'list', '--kind', 'outbound']);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(lastRequest().method, 'GET');
  assert.equal(lastRequest().path, '/v1/admin/webhooks?kind=outbound');
  assert.match(result.stdout, /outbound/);
  assert.match(result.stdout, /https:\/\/example\.com\/hooks\/sms/);
});

test('list --kind outbound --agent emits one JSON document with the target', async () => {
  const result = await run(['webhooks', 'list', '--kind', 'outbound', '--agent']);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim().split('\n').length, 1);
  const document = JSON.parse(result.stdout);
  assert.equal(document.data.webhooks[0].kind, 'outbound');
  assert.equal(document.data.webhooks[0].target_url, 'https://example.com/hooks/sms');
});

test('test posts /test and prints the status, latency and signature state', async () => {
  const result = await run(['webhooks', 'test', 'wh_out']);

  assert.equal(result.code, 0, result.stderr);
  const request = lastRequest();
  assert.equal(request.method, 'POST');
  assert.equal(request.path, '/v1/admin/webhooks/wh_out/test');
  assert.match(result.stdout, /ok 200 \(123 ms, signed\)/);
});

test('test exits 1 and prints the server sentence when ok is false', async () => {
  const result = await run(['webhooks', 'test', 'wh_fail']);

  assert.equal(result.code, 1);
  assert.match(result.stdout, /the target returned HTTP 500/);
});

test('test exits 3 on 404 and 5 on 409', async () => {
  const missing = await run(['webhooks', 'test', 'wh_missing']);
  assert.equal(missing.code, 3);

  const conflict = await run(['webhooks', 'test', 'wh_conflict']);
  assert.equal(conflict.code, 5);
});

test('an unknown --kind exits 2 without a request', async () => {
  const result = await run(['webhooks', 'list', '--kind', 'sideways']);

  assert.equal(result.code, 2);
  assert.equal(requests.length, 0);
  assert.match(result.stderr, /--kind must be inbound or outbound/);
});

test('outbound create without --url exits 2 without a request', async () => {
  const result = await run([
    'webhooks',
    'create',
    '--kind',
    'outbound',
    '--name',
    'delivery feed',
  ]);

  assert.equal(result.code, 2);
  assert.equal(requests.length, 0);
  assert.match(result.stderr, /--url/);
});

test('delete without --yes in a non-interactive session exits 2 without a request', async () => {
  const result = await run(['webhooks', 'delete', 'wh_out']);

  assert.equal(result.code, 2);
  assert.equal(requests.length, 0);
  assert.match(result.stderr, /confirmation/);
});

test('outbound create --dry-run prints the request and sends nothing', async () => {
  const result = await run([
    'webhooks',
    'create',
    '--kind',
    'outbound',
    '--name',
    'delivery feed',
    '--url',
    'https://example.com/hooks/sms',
    '--event',
    'delivered',
    '--dry-run',
    '--agent',
  ]);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(requests.length, 0, 'dry-run must not call the Worker');
  assert.equal(result.stdout.trim().split('\n').length, 1);
  const document = JSON.parse(result.stdout);
  assert.equal(document.data.dry_run, true);
  assert.equal(document.data.request.method, 'POST');
  assert.equal(document.data.request.path, '/v1/admin/webhooks');
  assert.deepEqual(document.data.request.body, {
    kind: 'outbound',
    name: 'delivery feed',
    target_url: 'https://example.com/hooks/sms',
    events: ['delivered'],
  });
  assert.equal(result.stdout.includes('whsec_out_only_shown_once'), false);
});

test('test --agent keeps a refused target as data, not an internal error', async () => {
  const result = await run(['webhooks', 'test', 'wh_fail', '--agent']);

  assert.equal(result.code, 1);
  assert.equal(result.stdout.trim().split('\n').length, 1);
  const document = JSON.parse(result.stdout);
  assert.equal(document.status, 'ok');
  assert.equal(document.data.accepted, false);
  assert.equal(document.data.status, 500);
  assert.equal(document.data.signed, true);
  assert.equal(document.data.ok, undefined);
});
