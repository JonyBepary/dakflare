#!/usr/bin/env node
/**
 * test-support/burst-probe.mjs — the limits probe.
 *
 * Local runs enforce none of Cloudflare's CPU, subrequest or memory limits, so a
 * green local suite says nothing about them. This drives real batch sizes against a
 * deployment to find the practical ceiling before the runtime complains.
 *
 * What it measures:
 *   1. incoming batch — the `env.DB.batch()` fan-out. A batch of N rows becomes N
 *      statements in ONE call, which is where D1 and CPU limits first bite.
 *   2. outbound batch — one DO round trip carrying N commands.
 *   3. a clean-up poll + ack so the probe leaves no PENDING turds behind.
 *
 * It asserts only what is unambiguous: a 2xx, the right counts, and no 5xx. It
 * reports latency rather than asserting a threshold, because the budget depends on
 * the plan.
 *
 *   WORKER_URL=https://... ADMIN_TOKEN=... node test-support/burst-probe.mjs
 */

import crypto from 'node:crypto';
import { device, admin, loadIdentity, sleep } from '../dakflare_test_harness.mjs';

const WORKER_URL = process.env.WORKER_URL;
if (!WORKER_URL) {
  console.error('WORKER_URL is required');
  process.exit(1);
}

const identity = loadIdentity({ required: true });
const results = [];
const check = (label, ok, detail = '') => {
  results.push({ label, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  [${detail}]` : ''}`);
};
const note = (label, detail) => console.log(`  NOTE  ${label}${detail ? `  [${detail}]` : ''}`);

const INCOMING_SIZES = [50, 200];
const OUTBOUND_SIZES = [25, 100];

console.log(`target: ${WORKER_URL}`);
console.log(`device: ${identity.deviceId}\n`);

/* ── 1. incoming batch fan-out ─────────────────────────────────────────────── */
for (const size of INCOMING_SIZES) {
  console.log(`-- incoming batch of ${size} --`);
  const tag = crypto.randomBytes(4).toString('hex');
  const messages = Array.from({ length: size }, (_, i) => ({
    local_id: `burst_${tag}_${i}`,
    sender: '+8801712345678',
    body: `burst message ${i} — ${'x'.repeat(80)}`,
    received_at: new Date().toISOString(),
  }));

  const t0 = Date.now();
  const r = await device(identity, 'POST', '/v1/sms/incoming/batch', {
    messages, ack_command_ids: [],
  });
  const ms = Date.now() - t0;

  check(`${size} messages accepted in one batch`, r.status === 200 && r.data?.accepted === size,
    `status ${r.status}, accepted ${r.data?.accepted}, ${ms} ms`);
  if (r.status !== 200) note('error body', JSON.stringify(r.data).slice(0, 200));

  // Idempotency at scale: the same batch again must be all duplicates, not errors.
  const t1 = Date.now();
  const again = await device(identity, 'POST', '/v1/sms/incoming/batch', {
    messages, ack_command_ids: [],
  });
  check(`${size}-message replay counted as duplicates`,
    again.status === 200 && again.data?.duplicates === size,
    `status ${again.status}, duplicates ${again.data?.duplicates}, ${Date.now() - t1} ms`);
}

/* ── 2. outbound batch ─────────────────────────────────────────────────────── */
let dispatched = [];
for (const size of OUTBOUND_SIZES) {
  console.log(`\n-- outbound batch of ${size} --`);
  const t0 = Date.now();
  const r = await admin('POST', '/v1/sms/send/batch', {
    device_id: identity.deviceId,
    commands: Array.from({ length: size }, (_, i) => ({
      to: '+8801712345678',
      body: `burst command ${i}`,
      expires_in_s: 120,
    })),
  });
  const ms = Date.now() - t0;

  check(`${size} commands enqueued in one call`,
    r.status === 200 && (r.data?.command_ids ?? []).length === size,
    `status ${r.status}, ${ms} ms`);
  if (r.status !== 200) note('error body', JSON.stringify(r.data).slice(0, 200));
  dispatched.push(...(r.data?.command_ids ?? []));
}

/* ── 3. clean up: poll, then ack everything so nothing is left PENDING ─────── */
console.log('\n-- cleanup --');
{
  const poll = await device(identity, 'POST', '/v1/sms/outgoing/poll', { ack_command_ids: [] });
  const got = (poll.data?.commands ?? []).map((c) => c.command_id);
  note('commands returned by the poll', String(got.length));
  if (got.length) {
    const ack = await device(identity, 'POST', '/v1/sms/outgoing/poll', { ack_command_ids: got });
    check('cleanup ack accepted', ack.status === 200);
    await sleep(300);
  }
  const leftover = dispatched.filter((id) => got.includes(id)).length;
  note('probe commands now acked', `${leftover} of ${dispatched.length}`);
}

const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
console.log(`\nburst probe: ${passed} passed, ${failed} failed, ${results.length} total`);
process.exit(failed ? 1 : 0);
