/**
 * CLI contract checks for `templates`, `contacts`, `schedule` and the `up`
 * pre-flight plan.
 *
 * Node's built-in runner plus a local HTTP server, in the same style as
 * connectors-and-webhooks.test.mjs: the assertions are about the request that
 * reached the Worker, not only about what the CLI printed.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, '../bin/dakflare.js');
const REPO = path.resolve(HERE, '../..');

let server;
let baseUrl;
let configDir;
let requests = [];

function run(args, { env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        DAKFLARE_CONFIG: configDir,
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

function lastRequest() {
  return requests[requests.length - 1];
}

test.before(async () => {
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dakflare-cli-dx-'));
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const contentType = req.headers['content-type'] ?? null;
      let body = null;
      if (raw !== '' && String(contentType).includes('application/json')) {
        body = JSON.parse(raw);
      }
      requests.push({ method: req.method, path: req.url, contentType, raw, body });
      res.setHeader('Content-Type', 'application/json');

      if (req.method === 'GET' && req.url === '/v1/admin/templates') {
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            templates: [
              {
                id: 'tpl_1',
                name: 'order_update',
                channel: 'whatsapp',
                body: 'Order {{id}} is ready',
                variables: ['id'],
                created_at: 1700000000000,
                updated_at: 1700000000000,
              },
            ],
          })
        );
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/admin/templates') {
        res.statusCode = 201;
        res.end(
          JSON.stringify({
            template: {
              id: 'tpl_1',
              name: body.name,
              channel: body.channel,
              body: body.body,
              variables: ['id'],
            },
            variables: ['id'],
          })
        );
        return;
      }
      if (req.method === 'DELETE' && req.url === '/v1/admin/templates/tpl_1') {
        res.statusCode = 200;
        res.end(JSON.stringify({ ok: true, id: 'tpl_1' }));
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/admin/contacts/import') {
        res.statusCode = 200;
        res.end(JSON.stringify({ ok: true, imported: 2, skipped: 1 }));
        return;
      }
      if (req.method === 'GET' && req.url.startsWith('/v1/scheduled')) {
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            scheduled: [
              {
                id: 'sch_1',
                channel: 'sms',
                target_type: 'device',
                target_id: 'dev_1',
                to_peer: '+8801540196080',
                body: 'reminder',
                send_at: 1800000000000,
                status: 'PENDING',
              },
            ],
          })
        );
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/scheduled') {
        res.statusCode = 201;
        res.end(
          JSON.stringify({
            scheduled: {
              id: 'sch_1',
              ...body,
              status: 'PENDING',
            },
          })
        );
        return;
      }
      if (req.method === 'DELETE' && req.url === '/v1/scheduled/sch_1') {
        res.statusCode = 200;
        res.end(JSON.stringify({ ok: true, cancelled: true }));
        return;
      }
      if (req.method === 'DELETE' && req.url === '/v1/scheduled/late') {
        res.statusCode = 409;
        res.end(JSON.stringify({ error: 'not_cancellable' }));
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

test('templates create posts name, channel and body', async () => {
  const result = await run([
    'templates',
    'create',
    '--name',
    'order_update',
    '--channel',
    'whatsapp',
    '--body',
    'Order {{id}} is ready',
  ]);

  assert.equal(result.code, 0, result.stderr);
  const request = lastRequest();
  assert.equal(request.method, 'POST');
  assert.equal(request.path, '/v1/admin/templates');
  assert.deepEqual(request.body, {
    name: 'order_update',
    channel: 'whatsapp',
    body: 'Order {{id}} is ready',
  });
  assert.match(result.stdout, /Created template tpl_1/);
});

test('templates create defaults to channel any and --agent is one JSON document', async () => {
  const result = await run([
    'templates',
    'create',
    '--name',
    'plain',
    '--body',
    'hello',
    '--agent',
  ]);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim().split('\n').length, 1);
  assert.deepEqual(lastRequest().body, { name: 'plain', channel: 'any', body: 'hello' });
  const document = JSON.parse(result.stdout);
  assert.equal(document.data.template.id, 'tpl_1');
  assert.deepEqual(document.data.variables, ['id']);
});

test('templates create --dry-run prints the request and sends nothing', async () => {
  const result = await run([
    'templates',
    'create',
    '--name',
    'order_update',
    '--body',
    'Order {{id}} is ready',
    '--dry-run',
    '--agent',
  ]);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(requests.length, 0, 'dry-run must not call the Worker');
  assert.equal(result.stdout.trim().split('\n').length, 1);
  const document = JSON.parse(result.stdout);
  assert.equal(document.data.dry_run, true);
  assert.deepEqual(document.data.request, {
    method: 'POST',
    path: '/v1/admin/templates',
    body: { name: 'order_update', channel: 'any', body: 'Order {{id}} is ready' },
  });
});

test('templates delete --yes removes the template', async () => {
  const result = await run(['templates', 'delete', 'tpl_1', '--yes', '--agent']);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(lastRequest().method, 'DELETE');
  assert.equal(lastRequest().path, '/v1/admin/templates/tpl_1');
  assert.equal(JSON.parse(result.stdout).data.deleted, true);
});

test('contacts import sends raw CSV with text/csv', async () => {
  const csv = 'name,phone\nAyesha,+8801540196080\nRafiq,+8801540196081\n';
  const file = path.join(configDir, 'contacts.csv');
  await fs.writeFile(file, csv, 'utf8');

  const result = await run(['contacts', 'import', file, '--agent']);

  assert.equal(result.code, 0, result.stderr);
  const request = lastRequest();
  assert.equal(request.method, 'POST');
  assert.equal(request.path, '/v1/admin/contacts/import');
  assert.equal(request.contentType, 'text/csv');
  assert.equal(request.raw, csv, 'the CSV must reach the Worker byte for byte');
  assert.equal(request.body, null);
  const document = JSON.parse(result.stdout);
  assert.equal(document.data.imported, 2);
  assert.equal(document.data.skipped, 1);
});

test('schedule create infers target_type device for sms and parses --at', async () => {
  const result = await run([
    'schedule',
    'create',
    '--target',
    'dev_1',
    '--to',
    '+8801540196080',
    '--body',
    'reminder',
    '--at',
    '2026-12-01T09:00:00Z',
    '--agent',
  ]);

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(lastRequest().body, {
    channel: 'sms',
    target_type: 'device',
    target_id: 'dev_1',
    to_peer: '+8801540196080',
    body: 'reminder',
    send_at: Date.parse('2026-12-01T09:00:00Z'),
  });
  assert.equal(result.stdout.trim().split('\n').length, 1);
  assert.equal(JSON.parse(result.stdout).data.scheduled.status, 'PENDING');
});

test('schedule create infers target_type connector for a channel send', async () => {
  const result = await run([
    'schedule',
    'create',
    '--target',
    'conn_abc',
    '--to',
    '+8801540196080',
    '--body',
    'reminder',
    '--at',
    '2026-12-01T09:00:00Z',
    '--channel',
    'whatsapp',
    '--template-id',
    'order_update',
  ]);

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(lastRequest().body, {
    channel: 'whatsapp',
    target_type: 'connector',
    target_id: 'conn_abc',
    to_peer: '+8801540196080',
    body: 'reminder',
    send_at: Date.parse('2026-12-01T09:00:00Z'),
    template_id: 'order_update',
  });
});

test('schedule create --dry-run sends nothing', async () => {
  const result = await run([
    'schedule',
    'create',
    '--target',
    'dev_1',
    '--to',
    '+8801540196080',
    '--body',
    'reminder',
    '--at',
    '2026-12-01T09:00:00Z',
    '--dry-run',
    '--agent',
  ]);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(requests.length, 0);
  const document = JSON.parse(result.stdout);
  assert.equal(document.data.request.method, 'POST');
  assert.equal(document.data.request.path, '/v1/scheduled');
});

test('schedule create missing --to exits 2 without a request', async () => {
  const result = await run([
    'schedule',
    'create',
    '--target',
    'dev_1',
    '--body',
    'reminder',
    '--at',
    '2026-12-01T09:00:00Z',
  ]);

  assert.equal(result.code, 2);
  assert.equal(requests.length, 0);
  assert.match(result.stderr, /--to/);
});

test('schedule create rejects a non-ISO --at with exit 2', async () => {
  const result = await run([
    'schedule',
    'create',
    '--target',
    'dev_1',
    '--to',
    '+8801540196080',
    '--body',
    'reminder',
    '--at',
    'tomorrow',
  ]);

  assert.equal(result.code, 2);
  assert.equal(requests.length, 0);
  assert.match(result.stderr, /ISO-8601/);
});

test('schedule list passes --status and reads the array', async () => {
  const result = await run(['schedule', 'list', '--status', 'PENDING', '--agent']);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(lastRequest().path, '/v1/scheduled?status=PENDING');
  assert.equal(JSON.parse(result.stdout).data.scheduled[0].id, 'sch_1');
});

test('schedule cancel exits 5 on 409 not_cancellable', async () => {
  const result = await run(['schedule', 'cancel', 'late', '--yes', '--agent']);

  assert.equal(result.code, 5);
  const document = JSON.parse(result.stdout);
  assert.equal(document.error.code, 'not_cancellable');
});

test('up --dry-run lists the pre-flight steps and writes nothing', async () => {
  const fakeBin = await fs.mkdtemp(path.join(os.tmpdir(), 'dakflare-fake-cf-'));
  const cfPath = path.join(fakeBin, 'cf');
  await fs.writeFile(
    cfPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('fake-cf 1.0.0'); process.exit(0); }
if (args[0] === 'accounts') { console.log('[]'); process.exit(0); }
if (args[0] === 'd1') { console.log(JSON.stringify([{ name: 'sms_gateway', uuid: 'db-1' }])); process.exit(0); }
if (args[0] === 'kv') { console.log(JSON.stringify([{ title: 'KV', id: 'kv-1' }])); process.exit(0); }
if (args[0] === 'queues') { console.log('result_info: {"count":0}'); console.log('[]'); process.exit(0); }
process.exit(0);
`,
    { mode: 0o755 }
  );
  await fs.chmod(cfPath, 0o755);

  const devVars = path.join(REPO, 'worker', '.dev.vars');
  const wranglerConfig = path.join(REPO, 'worker', 'cloudflare.config.ts');
  const beforeVars = await fs.readFile(devVars, 'utf8');
  const beforeConfig = await fs.readFile(wranglerConfig, 'utf8');
  const beforeConfigDir = await fs.readdir(configDir);

  const result = await run(['up', '--dry-run', '--agent'], {
    env: { PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}` },
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim().split('\n').length, 1);
  const plan = JSON.parse(result.stdout).data.plan.join('\n');
  assert.match(plan, /deps worker:/);
  assert.match(plan, /deps dashboard:/);
  assert.match(plan, /WEBHOOK_SECRET_KEY/);
  assert.match(plan, /queue dakflare-webhook-queue: create/);
  assert.match(plan, /queue dakflare-ingest-queue: create/);
  assert.match(plan, /queue dakflare-ingest-dlq: create/);

  assert.equal(await fs.readFile(devVars, 'utf8'), beforeVars, '.dev.vars must not change');
  assert.equal(await fs.readFile(wranglerConfig, 'utf8'), beforeConfig, 'ids must not change');
  assert.deepEqual(await fs.readdir(configDir), beforeConfigDir, 'config must not be written');

  await fs.rm(fakeBin, { recursive: true, force: true });
});

test('up --dry-run adds the cf login step when cf is not authenticated', async () => {
  const fakeBin = await fs.mkdtemp(path.join(os.tmpdir(), 'dakflare-fake-cf-'));
  const cfPath = path.join(fakeBin, 'cf');
  await fs.writeFile(
    cfPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('fake-cf 1.0.0'); process.exit(0); }
if (args[0] === 'accounts') { process.exit(1); }
process.exit(0);
`,
    { mode: 0o755 }
  );
  await fs.chmod(cfPath, 0o755);

  const result = await run(['up', '--dry-run', '--agent'], {
    env: { PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}` },
  });

  assert.equal(result.code, 0, result.stderr);
  const plan = JSON.parse(result.stdout).data.plan.join('\n');
  assert.match(plan, /cf auth login \(not authenticated\)/);
  assert.match(plan, /cf not authenticated/);

  await fs.rm(fakeBin, { recursive: true, force: true });
});
