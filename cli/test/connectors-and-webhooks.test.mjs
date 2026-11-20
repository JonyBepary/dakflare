/**
 * CLI contract checks for `connectors`, `webhooks` and connector sends.
 *
 * There is no CLI test runner in this repository, so this uses Node's built-in
 * test runner and a local HTTP server. It asserts what reaches the Worker, not
 * only what the CLI prints, because the defect this covers was a request that
 * looked right and carried no credential.
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
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dakflare-cli-'));
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const body = raw === '' ? null : JSON.parse(raw);
      requests.push({ method: req.method, path: req.url, body });
      res.setHeader('Content-Type', 'application/json');

      if (req.method === 'GET' && req.url === '/v1/admin/connectors') {
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            connectors: [
              {
                id: 'conn_abc',
                channel: 'whatsapp',
                account_id: '1234567890',
                execution_tier: 'worker_do',
                auth_mode: 'cloud_api',
                label: 'Sales line',
                enabled: true,
                secret_set: true,
                secret_updated_at: 1700000000000,
                last_event_at: null,
                created_at: 1700000000000,
                updated_at: 1700000000000,
              },
            ],
          })
        );
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/admin/connectors') {
        res.statusCode = 201;
        res.end(
          JSON.stringify({
            id: 'conn_abc',
            channel: body.channel,
            account_id: body.account_id,
            execution_tier: 'worker_do',
            auth_mode: body.auth_mode ?? 'cloud_api',
            label: body.label,
            enabled: body.enabled !== false,
            secret_set: true,
            secret_updated_at: 1700000000000,
          })
        );
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/admin/webhooks') {
        res.statusCode = 201;
        res.end(
          JSON.stringify({
            id: 'wh_abc',
            name: body.name,
            secret: 'whsec_test_only_shown_once',
            enabled: true,
            created_at: 1700000000000,
            created_by: 'owner',
          })
        );
        return;
      }
      if (req.method === 'DELETE') {
        res.statusCode = 200;
        res.end(JSON.stringify({ deleted: true }));
        return;
      }
      if (req.method === 'POST' && /^\/v1\/channels\/[^/]+\/[^/]+\/send$/.test(req.url)) {
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            success: true,
            channelMessageId: 'wamid.test-1',
            state: 'ACCEPTED_BY_CHANNEL',
          })
        );
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

test('create --dry-run prints the request with nested redacted credentials and sends nothing', async () => {
  const result = await run([
    'connectors',
    'create',
    '--channel',
    'whatsapp',
    '--account-id',
    '1234567890',
    '--label',
    'Sales line',
    '--access-token',
    'TOKEN_SECRET_VALUE',
    '--app-secret',
    'APP_SECRET_VALUE',
    '--dry-run',
    '--agent',
  ]);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(requests.length, 0, 'dry-run must not call the Worker');
  assert.equal(result.stdout.trim().split('\n').length, 1, '--agent must emit one JSON document');

  const document = JSON.parse(result.stdout);
  assert.equal(document.data.dry_run, true);
  assert.equal(document.data.request.method, 'POST');
  assert.equal(document.data.request.path, '/v1/admin/connectors');
  assert.deepEqual(document.data.request.body.secret, {
    accessToken: '<redacted>',
    appSecret: '<redacted>',
  });
  assert.equal(result.stdout.includes('TOKEN_SECRET_VALUE'), false);
  assert.equal(result.stdout.includes('APP_SECRET_VALUE'), false);
});

test('create posts the credential under a nested secret object and never prints it', async () => {
  const result = await run([
    'connectors',
    'create',
    '--channel',
    'whatsapp',
    '--account-id',
    '1234567890',
    '--label',
    'Sales line',
    '--access-token',
    'TOKEN_SECRET_VALUE',
  ]);

  assert.equal(result.code, 0, result.stderr);
  const request = lastRequest();
  assert.equal(request.method, 'POST');
  assert.equal(request.path, '/v1/admin/connectors');
  assert.deepEqual(request.body, {
    channel: 'whatsapp',
    account_id: '1234567890',
    label: 'Sales line',
    secret: { accessToken: 'TOKEN_SECRET_VALUE' },
  });
  assert.equal(request.body.access_token, undefined);
  assert.equal(result.stdout.includes('TOKEN_SECRET_VALUE'), false);
  assert.match(result.stdout, /stored sealed/);
});

test('list --agent emits one JSON document with a built webhook URL', async () => {
  const result = await run(['connectors', 'list', '--agent']);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim().split('\n').length, 1);
  const document = JSON.parse(result.stdout);
  const connector = document.data.connectors[0];
  assert.equal(connector.secret_set, true);
  assert.equal(connector.secret, undefined);
  assert.equal(
    connector.webhook_url,
    `${baseUrl}/v1/channels/whatsapp/conn_abc/webhook`
  );
});

test('an unknown channel exits 2 without a request', async () => {
  const result = await run([
    'connectors',
    'create',
    '--channel',
    'carrier-pigeon',
    '--account-id',
    '1',
    '--label',
    'Nope',
    '--access-token',
    'TOKEN_SECRET_VALUE',
  ]);

  assert.equal(result.code, 2);
  assert.equal(requests.length, 0);
  assert.match(result.stderr, /--channel must be one of/);
});

test('delete without --yes in a non-interactive session does not delete and exits 2', async () => {
  const result = await run(['connectors', 'delete', 'conn_abc']);

  assert.equal(result.code, 2);
  assert.equal(requests.length, 0);
  assert.match(result.stderr, /confirmation/);
});

test('--channel without --connector is a usage error before any request', async () => {
  const result = await run([
    'send',
    '--channel',
    'whatsapp',
    '--to',
    '+8801540196080',
    '--body',
    'hello',
  ]);

  assert.equal(result.code, 2);
  assert.equal(requests.length, 0);
  assert.match(result.stderr, /--channel and --connector must be used together/);
});

test('connector send posts the platform body and reports the delivery', async () => {
  const result = await run([
    'send',
    '--channel',
    'whatsapp',
    '--connector',
    'conn_abc',
    '--to',
    '+8801540196080',
    '--body',
    'deploy ack',
    '--template-id',
    'order_update',
    '--agent',
  ]);

  assert.equal(result.code, 0, result.stderr);
  const request = lastRequest();
  assert.equal(request.method, 'POST');
  assert.equal(request.path, '/v1/channels/whatsapp/conn_abc/send');
  assert.deepEqual(request.body, {
    to: '+8801540196080',
    body: 'deploy ack',
    template_id: 'order_update',
  });

  const document = JSON.parse(result.stdout);
  assert.equal(document.data.channel_message_id, 'wamid.test-1');
  assert.equal(document.data.state, 'ACCEPTED_BY_CHANNEL');
});

test('webhook create prints the signing secret once and the request carries only the name', async () => {
  const result = await run(['webhooks', 'create', '--name', 'billing events', '--agent']);

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(lastRequest().body, { name: 'billing events' });
  const document = JSON.parse(result.stdout);
  assert.equal(document.data.secret, 'whsec_test_only_shown_once');
});

test('capabilities reports the new command count', async () => {
  const result = await run(['capabilities', '--agent']);

  assert.equal(result.code, 0, result.stderr);
  const document = JSON.parse(result.stdout);
  assert.equal(document.data.commands.length, 29);
  assert.ok(document.data.commands.some((command) => command.name === 'connectors'));
  assert.ok(document.data.commands.some((command) => command.name === 'webhooks'));
});
