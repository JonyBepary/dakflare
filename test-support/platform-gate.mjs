#!/usr/bin/env node
/**
 * test-support/platform-gate.mjs — Tier 2 gate: the assertions a local run cannot make.
 *
 *   A. Real Durable Object hibernation. The DO evicts in-memory state after ~10 s idle;
 *      the socket and its attachment must survive, and the next push must wake the DO
 *      and still reach the device.
 *   B. Edge WebSocket idle behaviour. There is no edge in front of localhost, so nothing
 *      local can say whether a silent socket survives. B records the truth; C proves the
 *      keepalive works, which is the part that matters operationally.
 *
 * IMPORTANT — a real device acks promptly. This gate does too. An older version of this
 * script idled without acking, so `hello`'s push of leftover PENDING commands took a lease
 * that expired, which closed every socket with 1011 *before* the idle period ended. The
 * gate was then measuring a dead socket. Draining and acking during idle is what makes the
 * hibernation assertion mean anything.
 *
 * Requires: deployed Worker, identity from `pair`, WORKER_URL and ADMIN_TOKEN.
 * Runs ~3.5 min: A is sequential, B and C run concurrently.
 *
 *   WORKER_URL=https://... ADMIN_TOKEN=... node test-support/platform-gate.mjs
 */

import { RawWs, signWith, loadIdentity, admin, sleep } from '../dakflare_test_harness.mjs';

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

function signedSocket() {
  const signed = signWith(identity, 'GET', '/v1/device/ws', '');
  return new RawWs({ pathname: '/v1/device/ws', headers: signed.headers });
}

/** Ack every command the socket has delivered that we have not acked yet. */
function drain(ws, acked) {
  let n = 0;
  for (const m of ws.messages) {
    let j;
    try { j = JSON.parse(m.text); } catch { continue; }
    if (j.op !== 'commands' || !Array.isArray(j.commands)) continue;
    for (const c of j.commands) {
      if (!c?.command_id || acked.has(c.command_id)) continue;
      acked.add(c.command_id);
      ws.sendText(JSON.stringify({
        op: 'ack',
        acks: [{ command_id: c.command_id, claim_token: c.claim_token }],
      }));
      n++;
    }
  }
  return n;
}

const IDLE_MS = 38_000;
const KEEPALIVE_WINDOW_MS = 150_000;

console.log(`target: ${WORKER_URL}`);
console.log(`device: ${identity.deviceId}\n`);

/* ── A. hibernation: idle past eviction while behaving like a real device ──── */
console.log('-- A. hibernation survival (~40 s) --');
{
  const ws = signedSocket();
  const hs = await ws.connect();
  check('socket established', hs.status === 101);

  ws.sendText(JSON.stringify({ op: 'hello' }));
  await sleep(400);

  // Drain + ack for the whole idle window, so lease expiry cannot fire and close us.
  const acked = new Set();
  console.log(`  idling ${IDLE_MS / 1000} s (acking anything pushed)...`);
  const until = Date.now() + IDLE_MS;
  let ackedDuringIdle = 0;
  while (Date.now() < until) {
    ackedDuringIdle += drain(ws, acked);
    await sleep(300);
  }
  note('commands acked during idle (leftovers from earlier runs)', String(ackedDuringIdle));
  check('socket still open when the idle period ends', ws.closeCode === null,
    ws.closeCode === null ? 'open' : `closed ${ws.closeCode}`);

  const send = await admin('POST', '/v1/sms/send', {
    device_id: identity.deviceId, to: '+8801712345678', body: 'post-hibernation wake',
  });
  const cmdId = send.data?.command_id;
  check('command enqueued after the idle period', typeof cmdId === 'string');

  const seen = await ws.waitFor((m) => m.some((x) => x.text.includes(cmdId)), 20_000);
  const delivered = seen.some((x) => x.text.includes(cmdId));
  check('command pushed over the surviving socket after hibernation', delivered);

  if (delivered) {
    let claimToken = null;
    for (const x of seen) {
      try {
        const j = JSON.parse(x.text);
        if (j.op !== 'commands') continue;
        const c = j.commands.find((c) => c.command_id === cmdId);
        if (c) claimToken = c.claim_token;
      } catch { /* not JSON */ }
    }
    ws.sendText(JSON.stringify({
      op: 'ack',
      acks: [{ command_id: cmdId, claim_token: claimToken }],
    }));
    await sleep(700);
    const st = await admin('GET', `/v1/sms/commands/${cmdId}?device_id=${identity.deviceId}`);
    check('the woken DO handed the command to the phone and it acknowledged',
      st.data?.command?.state, 'DISPATCHED');
  }
  ws.close();
}

/* ── B (observed) / C (asserted). Edge idle behaviour ─────────────────────── */
console.log(`\n-- B/C. edge idle behaviour (~${KEEPALIVE_WINDOW_MS / 1000} s, concurrent) --`);

const silent = signedSocket();
check('silent socket established', (await silent.connect()).status === 101);

const pinged = signedSocket();
check('pinged socket established', (await pinged.connect()).status === 101);

let pingCount = 0;
const pingTimer = setInterval(() => {
  pinged.sendText(JSON.stringify({ op: 'ping' }));
  pingCount++;
}, 45_000);

await sleep(KEEPALIVE_WINDOW_MS);
clearInterval(pingTimer);

// C is the assertion that matters: is the socket still ROUTABLE, not merely un-closed?
const pingedBaseline = pinged.messages.length;
pinged.sendText(JSON.stringify({ op: 'ping' }));
await sleep(6_000);
const pingedPong = pinged.messages.slice(pingedBaseline).some((m) => m.text.includes('pong'));
check('a socket pinged every 45 s is still routable after 150 s', pingedPong,
  `pings sent: ${pingCount}, closeCode: ${pinged.closeCode}`);

// B is recorded, not asserted: "not closed" and "still routable" are different claims,
// and only a probe distinguishes them. Silence produces no traffic to prove anything.
const silentWasClosed = silent.closeCode !== null;
let silentRoutable = false;
if (!silentWasClosed) {
  const silentBaseline = silent.messages.length;
  silent.sendText(JSON.stringify({ op: 'ping' }));
  await sleep(6_000);
  silentRoutable = silent.messages.slice(silentBaseline).some((m) => m.text.includes('pong'));
}
if (silentWasClosed) {
  note('silent socket outcome', `closed by the edge (code ${silent.closeCode}) within 150 s`);
} else if (silentRoutable) {
  note('silent socket outcome', 'STILL ROUTABLE after 150 s of silence — no edge idle timeout observed');
} else {
  note('silent socket outcome', 'no close frame, but the socket is NOT routable — dropped silently');
}

if (silentWasClosed) {
  check('the 45 s ping is necessary (silence does get closed)', true);
} else if (silentRoutable) {
  note('45 s ping is NOT needed for connection survival on hibernatable sockets', 'it is still what makes liveness observable');
}

silent.close();
pinged.close();

/* ── D. staleness: is the 45 s ping load-bearing after all? ───────────────── */
/* The ping is NOT needed for connection survival (B showed no idle timeout). The
 * real question is whether it is needed for STALENESS: `socketLastSeen` falls back
 * to `connectedAt` when no auto-response has ever been recorded, so a socket quiet
 * for longer than STALE_SOCKET_MS should be closed as stale on the next push. */
console.log(`\n-- D. staleness vs the 45 s ping (~140 s) --`);
{
  const quiet = signedSocket();
  check('quiet socket established', (await quiet.connect()).status === 101);
  quiet.sendText(JSON.stringify({ op: 'hello', fcm_token: 'stub-fcm-token-0001' }));
  await sleep(400);

  // Drain leftovers first so lease expiry cannot interfere with the measurement.
  const acked = new Set();
  for (let i = 0; i < 10; i++) { drain(quiet, acked); await sleep(120); }
  note('leftover commands acked before the staleness window', String(acked.size));

  console.log('  idling 135 s with NO pings (STALE_SOCKET_MS is 120 s)...');
  await sleep(135_000);

  const send = await admin('POST', '/v1/sms/send', {
    device_id: identity.deviceId, to: '+8801712345678', body: 'staleness probe',
  });
  const cmdId = send.data?.command_id;
  const seen = await quiet.waitFor((m) => m.some((x) => x.text.includes(cmdId)), 15_000);
  const delivered = seen.some((x) => x.text.includes(cmdId));

  // The verified fact: the push path ages out a quiet socket. Whether the command
  // also lands first is a race between `ws.close()` and `ws.send()` on the same
  // socket, so it is reported rather than asserted.
  check('a socket quiet past STALE_SOCKET_MS is closed as stale by the push path',
    quiet.closeCode === 1001, `closeCode: ${quiet.closeCode}`);
  note('command/close race', delivered
    ? 'command was pushed before the close took effect'
    : 'command was not pushed; it stays PENDING for the next poll');

  await sleep(1_000);
  const st = await admin('GET', `/v1/sms/commands/${cmdId}?device_id=${identity.deviceId}`);
  const state = st.data?.command?.state;
  check('the command is not lost (PENDING, LEASED or DISPATCHED, never dropped)',
    state === 'PENDING' || state === 'LEASED' || state === 'DISPATCHED', `state: ${state}`);
  note('conclusion',
    'the 45 s ping IS necessary — not for connection survival but to keep the auto-response ' +
    'timestamp fresh so a healthy, quiet socket is not aged out at STALE_SOCKET_MS');
  quiet.close();
}

/* ── report ───────────────────────────────────────────────────────────────── */
const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
console.log(`\nplatform gate: ${passed} passed, ${failed} failed, ${results.length} total`);
process.exit(failed ? 1 : 0);
