#!/usr/bin/env node
/**
 * dakflare_test_harness.mjs — independent conformance harness for the SMS gateway.
 *
 * This is a "Virtual Android Device": a zero-dependency Node client that speaks the
 * frozen wire protocol of PROTOCOL_CONTRACT_V5.md from the contract text alone. It is
 * deliberately NOT derived from worker/src — its only value is that it can disagree
 * with the server.
 *
 * Commands:
 *   selftest        pure; no server. P-256 keygen, DER->P1363, contract §4 vectors.
 *   verify-vectors  assert only the §4.2 canonical vectors byte-for-byte.
 *   pair            mint a code, pair a fresh device, persist identity.
 *   suite           the full conformance battery.
 *   proxy           start the :8788 signing proxy for Hoppscotch.
 *   ws              connect a virtual device and hold a session open.
 *   stub            run the FCM/OAuth2 stub.
 *   reset           delete .harness-state.json
 *
 * Env: WORKER_URL (http://127.0.0.1:8787), ADMIN_TOKEN (dev-admin-token),
 *      STUB_URL (http://127.0.0.1:8790), HARNESS_ACK_TIMEOUT_MS (1500),
 *      PROXY_PORT (8788).
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const WORKER_URL = process.env.WORKER_URL ?? 'http://127.0.0.1:8787';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? 'dev-admin-token';
const STUB_URL = process.env.STUB_URL ?? 'http://127.0.0.1:8790';
const ACK_TIMEOUT_MS = Number(process.env.HARNESS_ACK_TIMEOUT_MS ?? 1500);
const PROXY_PORT = Number(process.env.PROXY_PORT ?? 8788);
const WORKER_HOST = new URL(WORKER_URL);

/**
 * Identity is stored PER TARGET. A single `.harness-state.json` meant a local run
 * silently replaced the identity paired against the deployed Worker, so the next
 * remote run authenticated as a device that does not exist there and every request
 * failed with `device_unknown`. The file name now carries the host.
 */
const TARGET_KEY = WORKER_HOST.host.replace(/[^A-Za-z0-9.-]/g, '_');
const STATE_FILE = path.join(HERE, `.harness-state.${TARGET_KEY}.json`);

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/* ────────────────────────────── contract §4 vectors ───────────────────────── */

const VECTORS = [
  {
    id: 'A', method: 'POST', pathname: '/v1/sms/outgoing/poll',
    timestamp: '1776470400000', nonce: 'a3f1c0d29b7e4f8a1c6d5e2b9f0a7c34',
    body: '{"ack_command_ids":[],"fcm_token":"fcm-test-token-0001"}',
    len: 56,
    sha: 'f8c6ca3e8d50126cc59e541a6644ef1db7c3eec01b155a8310dea13143b9f0a9',
    canonical: 'POST\n/v1/sms/outgoing/poll\n1776470400000\na3f1c0d29b7e4f8a1c6d5e2b9f0a7c34\nf8c6ca3e8d50126cc59e541a6644ef1db7c3eec01b155a8310dea13143b9f0a9',
  },
  {
    id: 'B', method: 'GET', pathname: '/v1/device/ws',
    timestamp: '1776470400000', nonce: '0f1e2d3c4b5a69788796a5b4c3d2e1f0',
    body: '', len: 0, sha: EMPTY_SHA256,
    canonical: `GET\n/v1/device/ws\n1776470400000\n0f1e2d3c4b5a69788796a5b4c3d2e1f0\n${EMPTY_SHA256}`,
  },
  {
    id: 'C', method: 'POST', pathname: '/v1/sms/incoming/batch',
    timestamp: '1776470400000', nonce: 'deadbeefcafebabe0123456789abcdef',
    body: '{"messages":[{"local_id":"m_0001","sender":"+8801712345678","body":"\u0986\u09b8\u09b8\u09be\u09b2\u09be\u09ae\u09c1 \u0986\u09b2\u09be\u0987\u0995\u09c1\u09ae","received_at":"2026-04-18T09:15:00.000Z"}]}',
    len: 159,
    sha: '1459860ca2b1d0a6e64d93d02246fb1f6c04d574b75bcdd485881d5830486fc6',
    canonical: 'POST\n/v1/sms/incoming/batch\n1776470400000\ndeadbeefcafebabe0123456789abcdef\n1459860ca2b1d0a6e64d93d02246fb1f6c04d574b75bcdd485881d5830486fc6',
  },
];

/* ─────────────────────────────── contract §1/§2 ───────────────────────────── */

const RE_TIMESTAMP = /^\d{13}$/;
const RE_NONCE = /^[0-9a-f]{32}$/;
const RE_DEVICE_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** §2.1 — the five-line canonical string. Five lines, four \n, no trailing newline. */
function buildCanonicalString({ method, pathname, timestampHeader, nonce, bodyBytes }) {
  const bodyHex = crypto.createHash('sha256').update(bodyBytes).digest('hex');
  return [method.toUpperCase(), pathname, timestampHeader, nonce, bodyHex].join('\n');
}

function bodySha256(bodyStr) {
  return crypto.createHash('sha256').update(Buffer.from(bodyStr, 'utf8')).digest('hex');
}

/* ────────────────────────────── contract §3 DER→P1363 ─────────────────────── */

/**
 * §3.1 — parse ASN.1 DER SEQUENCE{ INTEGER r, INTEGER s } and emit raw r||s,
 * left-padded to exactly 32 bytes each. Deliberately NOT "slice the last 64 bytes".
 */
export function derToP1363(der) {
  const b = Buffer.from(der);
  let i = 0;

  const readLength = () => {
    let len = b[i++];
    if (len & 0x80) {
      const n = len & 0x7f;
      if (n === 0 || n > 4) throw new Error('DER: unsupported length encoding');
      len = 0;
      for (let k = 0; k < n; k++) len = (len << 8) | b[i++];
    }
    return len;
  };

  if (b[i++] !== 0x30) throw new Error('DER: expected SEQUENCE (0x30)');
  const seqLen = readLength();
  if (i + seqLen !== b.length) throw new Error(`DER: SEQUENCE length ${seqLen} != remaining ${b.length - i}`);

  const readInt = () => {
    if (b[i++] !== 0x02) throw new Error('DER: expected INTEGER (0x02)');
    const len = readLength();
    let v = b.subarray(i, i + len);
    i += len;
    // strip leading 0x00 padding added to keep the integer positive
    while (v.length > 1 && v[0] === 0x00) v = v.subarray(1);
    if (v.length > 32) throw new Error(`DER: integer is ${v.length} bytes, too wide for P-256`);
    const out = Buffer.alloc(32);
    v.copy(out, 32 - v.length);
    return out;
  };

  const r = readInt();
  const s = readInt();
  if (i !== b.length) throw new Error('DER: trailing bytes after s');
  return Buffer.concat([r, s]); // exactly 64
}

/* ────────────────────────────────── identity ──────────────────────────────── */

function newIdentity() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const deviceId = 'dev' + crypto.randomBytes(8).toString('hex');
  if (!RE_DEVICE_ID.test(deviceId)) throw new Error('generated device_id violates §1.1');
  return {
    deviceId,
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKeySpki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  };
}

export function loadIdentity({ required = true } = {}) {
  if (!fs.existsSync(STATE_FILE)) {
    if (required) throw new Error('no identity: run `node dakflare_test_harness.mjs pair` first');
    return null;
  }
  const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  return {
    deviceId: raw.deviceId,
    publicKeySpki: raw.publicKeySpki,
    privateKey: crypto.createPrivateKey(raw.privateKeyPem),
  };
}

function saveIdentity(identity) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(identity, null, 2));
}

/* ───────────────────────────────── signed requests ───────────────────────── */

export function signWith(identity, method, pathname, bodyStr, { ts, nonce } = {}) {
  const timestampHeader = ts ?? String(Date.now());
  const n = nonce ?? crypto.randomBytes(16).toString('hex');
  const canonical = buildCanonicalString({
    method, pathname, timestampHeader, nonce: n,
    bodyBytes: Buffer.from(bodyStr ?? '', 'utf8'),
  });
  const sig = crypto.sign('sha256', Buffer.from(canonical, 'utf8'), {
    key: identity.privateKey, dsaEncoding: 'ieee-p1363',
  });
  if (sig.length !== 64) throw new Error(`P1363 signature is ${sig.length} bytes, expected 64`);
  return {
    canonical, ts: timestampHeader, nonce: n, sigB64: sig.toString('base64'),
    headers: {
      'X-Device-Id': identity.deviceId,
      'X-Timestamp': timestampHeader,
      'X-Nonce': n,
      'X-Signature': sig.toString('base64'),
    },
  };
}

export async function admin(method, pathname, body) {
  const res = await fetch(WORKER_URL + pathname, {
    method,
    headers: { Authorization: `Bearer ${ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

export async function device(identity, method, pathname, bodyObj, opts = {}) {
  const defaultBody = bodyObj === undefined ? '' : JSON.stringify(bodyObj);
  // Sign and send can differ — that is how a tamper test works. Default: identical.
  const signBody = opts.signBodyStr ?? opts.bodyStr ?? defaultBody;
  const sendBody = opts.sendBodyStr ?? opts.bodyStr ?? defaultBody;
  const signed = signWith(identity, method, pathname, signBody, opts);
  const headers = { ...signed.headers, ...(opts.headers ?? {}) };
  if (opts.sigB64 !== undefined) headers['X-Signature'] = opts.sigB64;
  if (sendBody) headers['Content-Type'] = 'application/json';
  const res = await fetch(WORKER_URL + pathname + (opts.query ?? ''), {
    method, headers, body: sendBody || undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null), signed };
}

/* ────────────────────── raw RFC 6455 WebSocket client ─────────────────────── */
/* Node's global WebSocket cannot set the four signed headers, and §1.2 forbids
 * query strings, so the handshake must be written by hand. */

export class RawWs {
  constructor({ pathname, headers, host = WORKER_HOST }) {
    this.pathname = pathname;
    this.headers = headers;
    this.host = host;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.handshakeDone = false;
    this.handshake = null;
    this.messages = [];
    this.closeCode = null;
    this.closeReason = '';
    this._waiters = [];
  }

  async connect(timeoutMs = 5000) {
    const key = crypto.randomBytes(16).toString('base64');
    const lines = [
      `GET ${this.pathname} HTTP/1.1`,
      `Host: ${this.host.host}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      ...Object.entries(this.headers).map(([k, v]) => `${k}: ${v}`),
      '', '',
    ];
    const expectedAccept = crypto.createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');

    this.socket = net.connect(Number(this.host.port || 80), this.host.hostname);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('WS connect timeout')), timeoutMs);
      this.socket.once('connect', () => { clearTimeout(t); resolve(); });
      this.socket.once('error', (e) => { clearTimeout(t); reject(e); });
    });
    this.socket.write(lines.join('\r\n'));

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('WS handshake timeout')), timeoutMs);
      const onData = (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        const idx = this.buffer.indexOf('\r\n\r\n');
        if (idx < 0) return;
        clearTimeout(t);
        this.socket.off('data', onData);
        const head = this.buffer.subarray(0, idx).toString('latin1');
        this.buffer = this.buffer.subarray(idx + 4);
        const [statusLine, ...headerLines] = head.split('\r\n');
        const status = Number(statusLine.split(' ')[1]);
        const hdrs = {};
        for (const h of headerLines) {
          const c = h.indexOf(':');
          if (c > 0) hdrs[h.slice(0, c).trim().toLowerCase()] = h.slice(c + 1).trim();
        }
        this.handshake = { status, headers: hdrs, expectedAccept };
        this.handshakeDone = true;
        this.socket.on('data', (d) => this._onData(d));
        this.socket.on('close', () => this._flush());
        resolve();
      };
      this.socket.on('data', onData);
      this.socket.once('error', (e) => { clearTimeout(t); reject(e); });
    });
    return this.handshake;
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const frame = this._parseFrame();
      if (!frame) break;
      if (frame.opcode === 0x1) {
        this.messages.push({ at: Date.now(), text: frame.payload.toString('utf8') });
      } else if (frame.opcode === 0x8) {
        this.closeCode = frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : 1005;
        this.closeReason = frame.payload.length > 2 ? frame.payload.subarray(2).toString('utf8') : '';
        try { this.socket.end(); } catch { /* ignore */ }
      } else if (frame.opcode === 0x9) {
        this._writeFrame(0xA, frame.payload);
      }
      // 0xA (pong) and 0x0 (continuation) need no action for our text-only use
    }
    this._flush();
  }

  _parseFrame() {
    const b = this.buffer;
    if (b.length < 2) return null;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (b.length < 4) return null;
      len = b.readUInt16BE(2); offset = 4;
    } else if (len === 127) {
      if (b.length < 10) return null;
      len = Number(b.readBigUInt64BE(2)); offset = 10;
    }
    let maskKey = null;
    if (masked) {
      if (b.length < offset + 4) return null;
      maskKey = b.subarray(offset, offset + 4); offset += 4;
    }
    if (b.length < offset + len) return null;
    let payload = b.subarray(offset, offset + len);
    if (maskKey) {
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i & 3];
    }
    this.buffer = b.subarray(offset + len);
    return { opcode, payload };
  }

  _writeFrame(opcode, payload) {
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
    const len = data.length;
    const mask = crypto.randomBytes(4);
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode;
    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) masked[i] = data[i] ^ mask[i & 3];
    try { this.socket.write(Buffer.concat([header, mask, masked])); } catch { /* closed */ }
  }

  sendText(s) { this._writeFrame(0x1, s); }
  sendPing(p = '') { this._writeFrame(0x9, p); }
  sendClose(code = 1000, reason = '') {
    const r = Buffer.from(reason, 'utf8');
    const p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code, 0); r.copy(p, 2);
    this._writeFrame(0x8, p);
  }

  /** Wait until predicate(messages) is true, or timeout. Returns messages. */
  async waitFor(predicate, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (predicate(this.messages)) return this.messages;
      if (Date.now() > deadline) return this.messages;
      await sleep(25);
    }
  }

  async waitForClose(timeoutMs = 4000) {
    const deadline = Date.now() + timeoutMs;
    while (this.closeCode === null && Date.now() < deadline) await sleep(25);
    return this.closeCode;
  }

  _flush() { for (const w of this._waiters.splice(0)) w(); }

  close() { try { this.socket?.destroy(); } catch { /* ignore */ } }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ────────────────────────────── assertion runner ──────────────────────────── */

const deepEqual = (a, b) => {
  if (Object.is(a, b)) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
};

class Report {
  constructor(title) { this.title = title; this.rows = []; }
  check(label, actual, expected) {
    const ok = deepEqual(actual, expected);
    this.rows.push({ ok, label, actual, expected });
    return ok;
  }
  checkFn(label, fn) {
    let ok = false, detail = '';
    try { const r = fn(); ok = r === true; if (!ok) detail = String(r); }
    catch (e) { ok = false; detail = `threw: ${e.message}`; }
    this.rows.push({ ok, label, actual: detail || undefined });
    return ok;
  }
  print() {
    const pass = this.rows.filter((r) => r.ok).length;
    const fail = this.rows.length - pass;
    for (const r of this.rows) {
      if (r.ok) {
        console.log(`  PASS  ${r.label}`);
      } else {
        const got = r.actual === undefined ? '' : ` (got ${JSON.stringify(r.actual)}`;
        const want = r.expected === undefined ? '' : `, want ${JSON.stringify(r.expected)}`;
        console.log(`  FAIL  ${r.label}${got}${want}${got ? ')' : ''}`);
      }
    }
    console.log(`\n  ${this.title}: ${pass} passed, ${fail} failed, ${this.rows.length} total`);
    return fail === 0;
  }
}

/* ────────────────────────────────── commands ─────────────────────────────── */

function cmdVerifyVectors() {
  const rep = new Report('vectors');
  for (const v of VECTORS) {
    const bytes = Buffer.from(v.body, 'utf8');
    rep.check(`${v.id} body_bytes_len (UTF-8, not chars)`, bytes.length, v.len);
    rep.check(`${v.id} body_sha256`, bodySha256(v.body), v.sha);
    const canonical = buildCanonicalString({
      method: v.method, pathname: v.pathname,
      timestampHeader: v.timestamp, nonce: v.nonce, bodyBytes: bytes,
    });
    rep.check(`${v.id} canonical string`, canonical, v.canonical);
    rep.check(`${v.id} five lines`, canonical.split('\n').length, 5);
    rep.check(`${v.id} no trailing newline`, canonical.endsWith('\n'), false);
    rep.check(`${v.id} lowercase hex digest`, /^[0-9a-f]{64}$/.test(bodySha256(v.body)), true);
  }
  rep.check('SHA-256("") is the §2.3 empty-body digest', bodySha256(''), EMPTY_SHA256);
  rep.check('GET/HEAD must sign the empty-body digest, not ""',
    buildCanonicalString({ method: 'GET', pathname: '/v1/device/ws', timestampHeader: '1'.repeat(13), nonce: '0'.repeat(32), bodyBytes: Buffer.alloc(0) }).split('\n')[4],
    EMPTY_SHA256);
  rep.check('method is uppercased', buildCanonicalString({
    method: 'post', pathname: '/x', timestampHeader: '1'.repeat(13), nonce: '0'.repeat(32), bodyBytes: Buffer.alloc(0),
  }).split('\n')[0], 'POST');
  return rep;
}

function cmdSelftest() {
  console.log('== selftest (no server required) ==\n');
  let ok = true;

  console.log('-- grammar (contract §1.1) --');
  const rep0 = new Report('grammar');
  rep0.check('13 digits accepted', RE_TIMESTAMP.test('1776470400000'), true);
  rep0.check('space-padded rejected by the validator (unit-only, see §1.2.1)', RE_TIMESTAMP.test(' 1776470400000'), false);
  rep0.check('"+" prefix rejected', RE_TIMESTAMP.test('+1776470400000'), false);
  rep0.check('trailing ".0" rejected', RE_TIMESTAMP.test('1776470400000.0'), false);
  rep0.check('exponent rejected', RE_TIMESTAMP.test('1.7e12'), false);
  rep0.check('12 digits rejected', RE_TIMESTAMP.test('177647040000'), false);
  rep0.check('32 lowercase hex nonce accepted', RE_NONCE.test('a'.repeat(32)), true);
  rep0.check('uppercase nonce rejected', RE_NONCE.test('A'.repeat(32)), false);
  rep0.check('31-char nonce rejected', RE_NONCE.test('a'.repeat(31)), false);
  rep0.check('non-hex nonce rejected', RE_NONCE.test('z'.repeat(32)), false);
  ok = rep0.print() && ok;

  console.log('\n-- DER -> P1363 (contract §3.1) --');
  const rep1 = new Report('derToP1363');
  const identity = newIdentity();
  const priv = crypto.createPrivateKey(identity.privateKeyPem);
  const msg = Buffer.from(VECTORS[0].canonical, 'utf8');
  const der = crypto.sign('sha256', msg, priv);
  const p1363 = derToP1363(der);
  rep1.check('converter output is exactly 64 bytes', p1363.length, 64);
  rep1.check('DER input is not 64 bytes (the trap this exists for)', der.length !== 64, true);
  rep1.check('converted signature verifies with node:crypto P1363', crypto.verify('sha256', msg, { key: crypto.createPublicKey(priv), dsaEncoding: 'ieee-p1363' }, p1363), true);
  // Equivalence with Node's P1363 encoding cannot be shown by comparing two
  // signatures: ECDSA is randomized, so two signatures over identical bytes differ
  // (contract §4.3). Use a hand-built DER known-answer test instead.
  const rBytes = Buffer.alloc(32); rBytes[0] = 0x80; rBytes.fill(0xab, 1);
  const rDer = Buffer.concat([Buffer.from([0x00]), rBytes]); // high bit set -> needs 0x00 pad
  const derKat = Buffer.concat([
    Buffer.from([0x30, 2 + rDer.length + 2 + 32]),
    Buffer.from([0x02, rDer.length]), rDer,
    Buffer.from([0x02, 32]), rBytes,
  ]);
  rep1.check('KAT: DER with a 0x00-padded r converts to exact r||s',
    derToP1363(derKat).toString('hex'), Buffer.concat([rBytes, rBytes]).toString('hex'));
  rep1.check('KAT: padded-r DER is longer than the 64-byte output',
    [derKat.length > 64, derToP1363(derKat).length], [true, 64]);

  const shortS = Buffer.alloc(32); shortS[31] = 0x7f;
  const derKat2 = Buffer.concat([
    Buffer.from([0x30, 2 + rDer.length + 2 + 1]),
    Buffer.from([0x02, rDer.length]), rDer,
    Buffer.from([0x02, 0x01, 0x7f]),
  ]);
  rep1.check('KAT: a 1-byte DER s is left-padded to 32 bytes',
    derToP1363(derKat2).toString('hex'), Buffer.concat([rBytes, shortS]).toString('hex'));

  const p1363Node = crypto.sign('sha256', msg, { key: priv, dsaEncoding: 'ieee-p1363' });
  rep1.check('node P1363 output is also 64 bytes', p1363Node.length, 64);
  rep1.check('both encodings verify the same message independently',
    crypto.verify('sha256', msg, { key: crypto.createPublicKey(priv), dsaEncoding: 'ieee-p1363' }, p1363Node), true);

  // force leading-zero padding: sign many messages until a DER int needs padding
  let sawPad = false, sawShort = false;
  for (let i = 0; i < 200 && !(sawPad && sawShort); i++) {
    const d = crypto.sign('sha256', Buffer.from('pad' + i), priv);
    const len = d.length;
    if (len === 72) sawPad = true;
    if (len < 71) sawShort = true;
    if (derToP1363(d).length !== 64) { rep1.check(`64 bytes for DER len ${len}`, false, true); break; }
  }
  rep1.check('saw a 72-byte DER (leading-zero padded integer) and converted it', sawPad, true);
  rep1.check('saw a short DER (<71 bytes) and converted it', sawShort, true);
  rep1.checkFn('garbage DER is rejected, not silently mis-sliced', () => {
    try { derToP1363(Buffer.from('not a der signature at all')); return 'accepted garbage'; }
    catch { return true; }
  });
  ok = rep1.print() && ok;

  console.log('\n-- contract §4.2 vectors --');
  ok = cmdVerifyVectors().print() && ok;

  console.log(ok ? '\nSELFTEST OK' : '\nSELFTEST FAILED');
  process.exit(ok ? 0 : 1);
}

async function cmdPair() {
  console.log('== pair ==\n');
  const identity = newIdentity();
  console.log(`device_id: ${identity.deviceId}`);

  const minted = await admin('POST', '/v1/admin/pairing-code', { ttl_ms: 60_000 });
  if (minted.status !== 200) throw new Error(`mint failed: ${minted.status}`);
  console.log(`pairing_code: ${minted.data.pairing_code}`);

  // Expiry: ttl_ms is clamped to >=1000, so a negative TTL yields a VALID code.
  // Expiry must be provoked with a 1 s TTL and a short wait (contract §11.4).
  const shortLived = await admin('POST', '/v1/admin/pairing-code', { ttl_ms: 1000 });
  await sleep(1250);
  const expiredRes = await fetch(`${WORKER_URL}/v1/device/pair`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pairing_code: shortLived.data.pairing_code, device_id: identity.deviceId, public_key_spki: identity.publicKeySpki }),
  });
  console.log(`expired code -> ${expiredRes.status} (want 401)`);

  const paired = await fetch(`${WORKER_URL}/v1/device/pair`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pairing_code: minted.data.pairing_code, device_id: identity.deviceId, public_key_spki: identity.publicKeySpki }),
  });
  if (paired.status !== 200) throw new Error(`pair failed: ${paired.status} ${await paired.text()}`);
  console.log(`pair -> ${paired.status}`);

  const reuse = await fetch(`${WORKER_URL}/v1/device/pair`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pairing_code: minted.data.pairing_code, device_id: identity.deviceId, public_key_spki: identity.publicKeySpki }),
  });
  console.log(`reuse -> ${reuse.status} (want 401)`);

  // The load-bearing check: a signed request must now succeed, which proves the
  // Durable Object actually registered the key (not just D1).
  const live = { ...identity, privateKey: priv(identity) };
  const probe = await device(live, 'POST', '/v1/sms/outgoing/poll', { ack_command_ids: [] });
  console.log(`post-pair signed request -> ${probe.status} (want 200)`);
  if (probe.status !== 200) {
    throw new Error(`D1/DO divergence: pairing returned 200 but signed requests fail: ${JSON.stringify(probe.data)}`);
  }

  saveIdentity(identity);
  console.log(`\nidentity saved to ${path.relative(HERE, STATE_FILE)}`);
}

function priv(identity) {
  return crypto.createPrivateKey(identity.privateKeyPem);
}

/* ─────────────────────────────────── suite ───────────────────────────────── */

async function cmdSuite() {
  const identity = loadIdentity();
  console.log(`== suite ==\nworker: ${WORKER_URL}\ndevice: ${identity.deviceId}\nack timeout: ${ACK_TIMEOUT_MS} ms\n`);

  let allOk = true;
  const run = (rep) => { allOk = rep.print() && allOk; console.log(); };

  // Register an FCM token up front. The Durable Object looks up the device's
  // stored fcm_token before pushing, so without this the wake path has no target
  // and correctly declines to call FCM at all.
  await device(identity, 'POST', '/v1/sms/outgoing/poll', {
    ack_command_ids: [], fcm_token: 'stub-fcm-token-0001',
  });

  /* ── admin surface ─────────────────────────────────────────────────────── */
  console.log('-- admin surface --');
  {
    const rep = new Report('admin');
    const noAuth = await fetch(`${WORKER_URL}/v1/devices`);
    rep.check('GET /v1/devices without token -> 401', noAuth.status, 401);
    const wrong = await fetch(`${WORKER_URL}/v1/devices`, { headers: { Authorization: 'Bearer nope' } });
    rep.check('wrong token -> 401', wrong.status, 401);
    rep.check('GET /v1/devices -> 200', (await admin('GET', '/v1/devices')).status, 200);
    rep.check('GET /v1/messages -> 200', (await admin('GET', `/v1/messages?device_id=${identity.deviceId}`)).status, 200);
    rep.check('GET /v1/device/:id/status -> 200', (await admin('GET', `/v1/device/${identity.deviceId}/status`)).status, 200);
    const st = await admin('GET', `/v1/device/${identity.deviceId}/status`);
    rep.check('status exposes ws_connected', typeof st.data?.ws_connected, 'boolean');
    rep.check('status exposes queue_depth', typeof st.data?.queue_depth, 'number');
    run(rep);
  }

  /* ── auth rejection ────────────────────────────────────────────────────── */
  console.log('-- auth rejection (§1.1, §3.2) --');
  {
    const rep = new Report('auth');
    const bare = await fetch(`${WORKER_URL}/v1/sms/outgoing/poll`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    rep.check('no headers -> missing_auth_headers', (await bare.json()).error, 'missing_auth_headers');

    for (const [label, nonce] of [
      ['uppercase', 'A'.repeat(32)],
      ['31 chars', 'a'.repeat(31)],
      ['33 chars', 'a'.repeat(33)],
      ['non-hex', 'z'.repeat(32)],
    ]) {
      const r = await device(identity, 'POST', '/v1/sms/outgoing/poll', { ack_command_ids: [] }, { nonce });
      rep.check(`X-Nonce ${label} -> malformed_header`, r.data?.error, 'malformed_header');
    }

    for (const [label, ts] of [
      ['"+" prefix', '+' + Date.now()],
      ['trailing ".0"', Date.now() + '.0'],
      ['exponent', '1.7e12'],
      ['12 digits', '177647040000'],
    ]) {
      const r = await device(identity, 'POST', '/v1/sms/outgoing/poll', { ack_command_ids: [] }, { ts });
      rep.check(`X-Timestamp ${label} -> malformed_header`, r.data?.error, 'malformed_header');
    }
    // §1.2.1: leading whitespace is stripped by the HTTP parser, so the padded
    // form is asserted in `selftest` as a validator unit test, not here.

    const tamper = await device(identity, 'POST', '/v1/sms/outgoing/poll', { ack_command_ids: [] },
      {
        signBodyStr: JSON.stringify({ ack_command_ids: [] }),
        sendBodyStr: JSON.stringify({ ack_command_ids: ['tampered'] }),
      });
    rep.check('body tamper -> invalid_signature', tamper.data?.error, 'invalid_signature');

    const shortSig = await device(identity, 'POST', '/v1/sms/outgoing/poll', { ack_command_ids: [] }, { sigB64: 'AAAA' });
    rep.check('3-byte signature -> bad_signature_length', shortSig.data?.error, 'bad_signature_length');

    const query = await device(identity, 'POST', '/v1/sms/outgoing/poll', { ack_command_ids: [] }, { query: '?x=1', sigB64: 'AAAA' });
    rep.check('query string -> 400 unexpected_query (before crypto)', query.data?.error, 'unexpected_query');
    rep.check('query string status is 400 not 401', query.status, 400);
    run(rep);
  }

  /* ── replay guard (§5) ─────────────────────────────────────────────────── */
  console.log('-- replay guard (§5) --');
  {
    const rep = new Report('replay');
    const first = await device(identity, 'POST', '/v1/sms/outgoing/poll', { ack_command_ids: [] });
    rep.check('fresh nonce -> 200', first.status, 200);
    const replay = await device(identity, 'POST', '/v1/sms/outgoing/poll', { ack_command_ids: [] },
      { ts: first.signed.ts, nonce: first.signed.nonce, sigB64: first.signed.sigB64 });
    rep.check('same nonce again -> nonce_replay', replay.data?.error, 'nonce_replay');

    // same millisecond, different nonce: must succeed
    const ms = String(Date.now());
    const a = await device(identity, 'POST', '/v1/sms/outgoing/poll', { ack_command_ids: [] }, { ts: ms });
    const b = await device(identity, 'POST', '/v1/sms/outgoing/poll', { ack_command_ids: [] }, { ts: ms });
    rep.check('two fresh nonces in the SAME millisecond -> both 200', a.status === 200 && b.status === 200, true);

    // The withdrawn evicted_max_ts design fails at 33; assert 40.
    let burstOk = 0;
    const failures = [];
    for (let i = 0; i < 40; i++) {
      const r = await device(identity, 'POST', '/v1/sms/outgoing/poll', { ack_command_ids: [] });
      if (r.status === 200) burstOk++; else failures.push(`${i}:${r.status}:${r.data?.error}`);
    }
    rep.check('40 consecutive in-window requests all 200 (kills evicted_max_ts)', burstOk, 40);
    if (failures.length) console.log(`        failures: ${failures.slice(0, 5).join(', ')}`);

    const [c1, c2] = await Promise.all([
      device(identity, 'POST', '/v1/sms/outgoing/poll', { ack_command_ids: [] }),
      device(identity, 'POST', '/v1/sms/outgoing/poll', { ack_command_ids: [] }),
    ]);
    rep.check('two concurrent signed requests -> both 200', c1.status === 200 && c2.status === 200, true);
    run(rep);
  }

  /* ── rules linter (§7) ─────────────────────────────────────────────────── */
  console.log('-- rules linter (§7) --');
  {
    const rep = new Report('rules');
    const createdRules = [];
    const post = async (value) => {
      const id = crypto.randomUUID();
      const res = await admin('POST', '/v1/rules', {
        id, name: 'probe',
        matcher: { type: 'regex', value },
        body_matcher: { type: 'keyword', value: 'help' },
        reply_template: 'ok',
      });
      if (res.status === 200) createdRules.push(id);
      return res;
    };

    for (const [label, pattern] of [
      ['lookahead (?=a)', '(?=a)'],
      ['lookbehind (?<=a)', '(?<=a)'],
      ['nested quantifier ((a+))+', '((a+))+'],
      ['nested quantifier ((a+)(b+))+', '((a+)(b+))+'],
      ['nested counted (a{1,50}){1,50}', '(a{1,50}){1,50}'],
      ['overlapping alternation (a|a)+$', '(a|a)+$'],
      ['overlapping alternation (a|aa)+$', '(a|aa)+$'],
      ['backreference \\1', 'a\\1'],
      ['named backref \\k<n>', 'a\\k<n>'],
      ['possessive a*+', 'a*+'],
      ['atomic group (?>a)', '(?>a)'],
      ['600-byte pattern', 'x'.repeat(600)],
    ]) {
      const r = await post(pattern);
      rep.check(`rejects ${label} -> 400`, r.status, 400);
    }

    const good = await post('^\\+880[0-9]{9}$');
    rep.check('accepts a valid RE2 pattern -> 200', good.status, 200);
    const good2 = await post('(abc)+');
    rep.check('accepts (abc)+ (not nested) -> 200', good2.status, 200);
    const good3 = await post('(a|b)+');
    rep.check('accepts (a|b)+ (non-overlapping) -> 200', good3.status, 200);

    // Teardown: the suite must not leak synthetic auto-reply rules. Leaving them
    // behind is how 33 of them once ended up live in production.
    for (const id of createdRules) await admin('DELETE', `/v1/admin/rules/${id}`);
    const remaining = (await admin('GET', '/v1/admin/rules')).data?.rules ?? [];
    rep.check('suite deleted every rule it created', remaining.filter((r) => createdRules.includes(r.id)).length, 0);
    run(rep);
  }

  /* ── incoming batch (§5.4) ─────────────────────────────────────────────── */
  console.log('-- incoming batch --');
  {
    const rep = new Report('incoming');
    const localId = 'suite_' + crypto.randomBytes(6).toString('hex');
    const msg = { local_id: localId, sender: '+8801712345678', body: 'hello', received_at: new Date().toISOString() };

    const first = await device(identity, 'POST', '/v1/sms/incoming/batch', { messages: [msg], ack_command_ids: [] });
    rep.check('first insert -> 200', first.status, 200);
    rep.check('accepted 1', first.data?.accepted, 1);

    const dup = await device(identity, 'POST', '/v1/sms/incoming/batch', { messages: [msg], ack_command_ids: [] });
    rep.check('same (device_id, local_id) -> duplicates 1', dup.data?.duplicates, 1);

    const badDate = await device(identity, 'POST', '/v1/sms/incoming/batch', {
      messages: [{ ...msg, local_id: localId + '_b', received_at: '9999-12-31T00:00:00.000Z' }], ack_command_ids: [],
    });
    rep.check('received_at year 9999 -> 400', badDate.status, 400);

    const ancient = await device(identity, 'POST', '/v1/sms/incoming/batch', {
      messages: [{ ...msg, local_id: localId + '_c', received_at: '1970-01-01T00:00:00.000Z' }], ack_command_ids: [],
    });
    rep.check('received_at 1970 -> 400 (bounded)', ancient.status, 400);

    const malformed = await device(identity, 'POST', '/v1/sms/incoming/batch', undefined, { bodyStr: '{not json' });
    rep.check('malformed JSON -> 400 not 500', malformed.status, 400);

    const missingLocal = await device(identity, 'POST', '/v1/sms/incoming/batch', {
      messages: [{ sender: '+8801712345678', body: 'x', received_at: new Date().toISOString() }], ack_command_ids: [],
    });
    rep.check('missing local_id -> 400', missingLocal.status, 400);
    run(rep);
  }

  /* ── command lifecycle + state machine (§6) ────────────────────────────── */
  console.log('-- command lifecycle + state machine (§6) --');
  {
    const rep = new Report('state machine');
    const send = await admin('POST', '/v1/sms/send', {
      device_id: identity.deviceId, to: '+8801712345678', body: 'suite lifecycle',
    });
    rep.check('POST /v1/sms/send -> 200', send.status, 200);
    const cmdId = send.data?.command_id;
    rep.check('returns a command_id', typeof cmdId, 'string');

    const readState = async () => {
      const r = await admin('GET', `/v1/sms/commands/${cmdId}?device_id=${identity.deviceId}`);
      return { status: r.status, state: r.data?.command?.state };
    };

    rep.check('new command is PENDING', (await readState()).state, 'PENDING');

    const msgs = await admin('GET', `/v1/messages?device_id=${identity.deviceId}&limit=50`);
    rep.check('outbound row persisted with direction=out',
      (msgs.data?.messages ?? []).some((m) => m.direction === 'out' && m.body === 'suite lifecycle'), true);

    const poll1 = await device(identity, 'POST', '/v1/sms/outgoing/poll', { ack_command_ids: [] });
    rep.check('poll returns the pending command', (poll1.data?.commands ?? []).some((c) => c.command_id === cmdId), true);
    rep.check('poll moved it to DISPATCHED', (await readState()).state, 'DISPATCHED');

    const ack = await device(identity, 'POST', '/v1/sms/outgoing/poll', { ack_command_ids: [cmdId] });
    rep.check('ack -> 200', ack.status, 200);
    rep.check('ack moved it to ACKED_BY_DEVICE', (await readState()).state, 'ACKED_BY_DEVICE');
    rep.check('acked command not re-returned', (ack.data?.commands ?? []).some((c) => c.command_id === cmdId), false);

    await device(identity, 'POST', '/v1/sms/status/batch', { updates: [{ command_id: cmdId, status: 'SENT' }] });
    rep.check('SENT applied', (await readState()).state, 'SENT');
    await device(identity, 'POST', '/v1/sms/status/batch', { updates: [{ command_id: cmdId, status: 'DELIVERED' }] });
    rep.check('DELIVERED applied', (await readState()).state, 'DELIVERED');

    const staleAck = await device(identity, 'POST', '/v1/sms/outgoing/poll', { ack_command_ids: [cmdId] });
    rep.check('stale ack returns 200 (no-op, not an error)', staleAck.status, 200);
    rep.check('stale ack did NOT regress DELIVERED', (await readState()).state, 'DELIVERED');

    const regress = await device(identity, 'POST', '/v1/sms/status/batch', { updates: [{ command_id: cmdId, status: 'SENT' }] });
    rep.check('DELIVERED->SENT returns 200', regress.status, 200);
    rep.check('DELIVERED->SENT rejected (still DELIVERED)', (await readState()).state, 'DELIVERED');

    const back = await device(identity, 'POST', '/v1/sms/status/batch', { updates: [{ command_id: cmdId, status: 'PENDING' }] });
    rep.check('DELIVERED->PENDING returns 200', back.status, 200);
    rep.check('DELIVERED->PENDING rejected', (await readState()).state, 'DELIVERED');

    // expiry, then resurrection attempt
    const expiring = await admin('POST', '/v1/sms/send', {
      device_id: identity.deviceId, to: '+8801712345678', body: 'expire me', expires_in_s: 1,
    });
    const expId = expiring.data?.command_id;
    await sleep(1400);
    const expState = await admin('GET', `/v1/sms/commands/${expId}?device_id=${identity.deviceId}`);
    rep.check('expired command is EXPIRED', expState.data?.command?.state, 'EXPIRED');
    await device(identity, 'POST', '/v1/sms/status/batch', { updates: [{ command_id: expId, status: 'SENT' }] });
    const after = await admin('GET', `/v1/sms/commands/${expId}?device_id=${identity.deviceId}`);
    rep.check('EXPIRED->SENT rejected (still EXPIRED)', after.data?.command?.state, 'EXPIRED');
    run(rep);
  }

  /* ── WebSocket (§5.5) ──────────────────────────────────────────────────── */
  console.log('-- WebSocket --');
  {
    const rep = new Report('websocket');

    const signed = signWith(identity, 'GET', '/v1/device/ws', '');
    const ws = new RawWs({ pathname: '/v1/device/ws', headers: signed.headers });
    const handshake = await ws.connect();
    rep.check('signed upgrade -> 101', handshake.status, 101);
    rep.check('Sec-WebSocket-Accept matches RFC 6455', handshake.headers['sec-websocket-accept'], handshake.expectedAccepts ?? handshake.expectedAccept);

    ws.sendText(JSON.stringify({ op: 'hello', fcm_token: 'stub-fcm-token-0001' }));
    await sleep(250);

    ws.sendText(JSON.stringify({ op: 'ping' }));
    const gotPong = await ws.waitFor((m) => m.some((x) => x.text.includes('"pong"')), 2500);
    rep.check('edge auto-response answers {"op":"ping"} with {"op":"pong"}',
      gotPong.some((x) => x.text.includes('"pong"')), true);

    // batch-send uniqueness: the O(N^2) re-push bug delivers command #1 N times
    const before = ws.messages.length;
    const batch = await admin('POST', '/v1/sms/send/batch', {
      device_id: identity.deviceId,
      commands: Array.from({ length: 5 }, (_, i) => ({ to: '+8801712345678', body: `batch ${i}` })),
    });
    rep.check('batch send -> 200', batch.status, 200);
    rep.check('batch returns 5 command ids', (batch.data?.command_ids ?? []).length, 5);
    await sleep(900);

    const delivered = [];
    for (const m of ws.messages.slice(before)) {
      try {
        const j = JSON.parse(m.text);
        if (j.op === 'commands') for (const c of j.commands) delivered.push(c.command_id);
      } catch { /* not JSON */ }
    }
    const unique = new Set(delivered);
    rep.check('every batch command delivered over WS', unique.size, 5);
    rep.check('no command delivered twice (kills the O(N^2) re-push)', delivered.length, unique.size);

    // ack them so the ack_timeout path is not the subject of the next assertion
    ws.sendText(JSON.stringify({ op: 'ack', command_ids: [...unique] }));
    await sleep(400);
    const acked = await admin('GET', `/v1/sms/commands/${[...unique][0]}?device_id=${identity.deviceId}`);
    rep.check('WS ack advanced a command', acked.data?.command?.state, 'ACKED_BY_DEVICE');

    ws.close();
    run(rep);
  }

  /* ── ack timeout + FCM wake (§5.5 alarm) ───────────────────────────────── */
  console.log(`-- ack timeout (${ACK_TIMEOUT_MS} ms) + FCM wake --`);
  {
    const rep = new Report('ack timeout');
    // Against a deployed Worker the local FCM stub is unreachable and a real send
    // needs a real service account, so that single assertion is skipped, not faked.
    const REMOTE = process.env.HARNESS_REMOTE === '1';

    let sendsBefore = null;
    if (!REMOTE) {
      const fcmBefore = await fetch(`${STUB_URL}/__log`).then((r) => r.json()).catch(() => null);
      if (!fcmBefore) {
        rep.checkFn('FCM stub reachable (start it with test-support/dev.sh)',
          () => 'stub not reachable at ' + STUB_URL);
      } else {
        sendsBefore = fcmBefore.sendCalls ?? 0;
      }
    }

    if (REMOTE || sendsBefore !== null) {
      const signed = signWith(identity, 'GET', '/v1/device/ws', '');
      const ws = new RawWs({ pathname: '/v1/device/ws', headers: signed.headers });
      await ws.connect();
      ws.sendText(JSON.stringify({ op: 'hello', fcm_token: 'stub-fcm-token-0001' }));
      await sleep(200);

      const send = await admin('POST', '/v1/sms/send', {
        device_id: identity.deviceId, to: '+8801712345678', body: 'never acked',
      });
      const cmdId = send.data?.command_id;
      await sleep(400);
      const dispatched = await admin('GET', `/v1/sms/commands/${cmdId}?device_id=${identity.deviceId}`);
      rep.check('command pushed and DISPATCHED', dispatched.data?.command?.state, 'DISPATCHED');

      // A real deployment's alarm scheduling adds latency; allow for it.
      const closeCode = await ws.waitForClose(ACK_TIMEOUT_MS + (REMOTE ? 20_000 : 4_000));
      const reverted = await admin('GET', `/v1/sms/commands/${cmdId}?device_id=${identity.deviceId}`);
      rep.check('ack_timeout reverted it to PENDING', reverted.data?.command?.state, 'PENDING');
      rep.check('ack_timeout closed the socket with 1011', closeCode, 1011);

      if (REMOTE) {
        rep.rows.push({
          ok: true,
          label: 'FCM wake assertion SKIPPED (no stub reachable from Cloudflare; needs a real FCM project)',
        });
      } else {
        let fcmAfter = null;
        for (let i = 0; i < 50; i++) {
          fcmAfter = await fetch(`${STUB_URL}/__log`).then((r) => r.json()).catch(() => null);
          if ((fcmAfter?.sendCalls ?? 0) > sendsBefore) break;
          await sleep(100);
        }
        rep.check('ack_timeout triggered an FCM wake push', (fcmAfter?.sendCalls ?? 0) > sendsBefore, true);
        rep.check('FCM assertion was structurally valid (no validation errors)',
          (fcmAfter?.validationErrors ?? []).length, 0);
      }
      ws.close();
    }
    run(rep);
  }

  /* ── token replay safety: the withdrawn design's killer, restated ──────── */
  console.log('-- negative controls --');
  {
    const rep = new Report('negative controls');
    const bogus = await admin('POST', '/v1/sms/send', { device_id: 'nonexistentdevice01', to: '+8801712345678', body: 'x' });
    rep.check('send to an unregistered device -> 404', bogus.status, 404);
    rep.check('...with the device_unknown code', bogus.data?.error, 'device_unknown');
    const bogusBatch = await admin('POST', '/v1/sms/send/batch', {
      device_id: 'nonexistentdevice01', commands: [{ to: '+8801712345678', body: 'x' }],
    });
    rep.check('batch send to an unregistered device -> 404', bogusBatch.status, 404);
    const noRoute = await fetch(`${WORKER_URL}/v1/nope`);
    rep.check('unknown route -> 404', noRoute.status, 404);
    run(rep);
  }

  console.log(allOk ? 'SUITE PASSED' : 'SUITE FAILED');
  process.exit(allOk ? 0 : 1);
}

/* ─────────────────────────── multi-device command ─────────────────────────── */

/** Pair a fresh device and return a usable signing identity. */
async function pairDevice(label) {
  const id = newIdentity();
  const mint = await admin("POST", "/v1/admin/pairing-code", { ttl_ms: 60_000 });
  const res = await fetch(`${WORKER_URL}/v1/device/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      pairing_code: mint.data.pairing_code,
      device_id: id.deviceId,
      public_key_spki: id.publicKeySpki,
    }),
  });
  if (res.status !== 200) throw new Error(`pair ${label} failed: ${res.status}`);
  return { label, ...id, privateKey: crypto.createPrivateKey(id.privateKeyPem) };
}

/**
 * Multi-device isolation and key rotation.
 *
 * Isolation matters because one Durable Object per device is the whole
 * architecture: if a command or a rule leaks across devices, the per-device DO
 * boundary is decorative. Rotation matters because a phone is lost, reflashed or
 * replaced, and re-pairing the same `device_id` must actually evict the old key.
 */
async function cmdMultiDevice() {
  console.log(`== multi-device ==\nworker: ${WORKER_URL}\n`);

  let allOk = true;
  const run = (rep) => { allOk = rep.print() && allOk; console.log(); };

  const A = await pairDevice("A");
  const B = await pairDevice("B");
  const C = await pairDevice("C");
  console.log(`paired: A=${A.deviceId} B=${B.deviceId} C=${C.deviceId}\n`);

  console.log("-- independent operation --");
  {
    const rep = new Report("independence");
    for (const dev of [A, B, C]) {
      const r = await device(dev, "POST", "/v1/sms/incoming/batch", {
        messages: [{
          local_id: `md_${dev.label}`, sender: "+8801712345678",
          body: `from ${dev.label}`, received_at: new Date().toISOString(),
        }],
        ack_command_ids: [],
      });
      rep.check(`${dev.label} accepts its own batch`, r.status === 200 && r.data?.accepted === 1, true);
    }
    run(rep);
  }

  console.log("-- DO isolation: a command for A must not reach B or C --");
  {
    const rep = new Report("isolation");
    const sent = await admin("POST", "/v1/sms/send", {
      device_id: A.deviceId, to: "+8801712345678", body: "for A only",
    });
    const cmdId = sent.data?.command_id;

    const pollA = await device(A, "POST", "/v1/sms/outgoing/poll", { ack_command_ids: [] });
    rep.check("A receives the command", (pollA.data?.commands ?? []).some((c) => c.command_id === cmdId), true);

    const pollB = await device(B, "POST", "/v1/sms/outgoing/poll", { ack_command_ids: [] });
    const pollC = await device(C, "POST", "/v1/sms/outgoing/poll", { ack_command_ids: [] });
    rep.check("B receives nothing", (pollB.data?.commands ?? []).length, 0);
    rep.check("C receives nothing", (pollC.data?.commands ?? []).length, 0);

    // B cannot ack a command that belongs to A's object.
    const crossAck = await device(B, "POST", "/v1/sms/outgoing/poll", { ack_command_ids: [cmdId] });
    rep.check("B acking A's command is accepted-but-ignored", crossAck.status, 200);
    const stateA = await admin("GET", `/v1/sms/commands/${cmdId}?device_id=${A.deviceId}`);
    // Not asserting DISPATCHED exactly: the 8 s ack_timeout may legitimately have
    // reverted it to PENDING by now. The point is that B's ack did not advance it.
    rep.check("B's ack did not advance A's command to ACKED_BY_DEVICE",
      stateA.data?.command?.state !== "ACKED_BY_DEVICE", true);
    run(rep);
  }

  console.log("-- rule scoping: global vs per-device --");
  {
    const rep = new Report("rules scoping");
    const gid = `global_${crypto.randomBytes(4).toString("hex")}`;
    const aid = `devA_${crypto.randomBytes(4).toString("hex")}`;

    rep.check("create global rule -> 200", (await admin("POST", "/v1/rules", {
      id: gid, name: "global", matcher: { type: "exact", value: "+8801000000000" },
      body_matcher: { type: "keyword", value: "x" }, reply_template: "g",
    })).status, 200);

    rep.check("create A-only rule -> 200", (await admin("POST", "/v1/rules", {
      id: aid, device_id: A.deviceId, name: "A only",
      matcher: { type: "exact", value: "+8801000000001" },
      body_matcher: { type: "keyword", value: "x" }, reply_template: "a",
    })).status, 200);

    const seeA = (await device(A, "GET", "/v1/rules")).data?.rules ?? [];
    const seeB = (await device(B, "GET", "/v1/rules")).data?.rules ?? [];
    const idsA = seeA.map((r) => r.id);
    const idsB = seeB.map((r) => r.id);

    rep.check("A sees the global rule", idsA.includes(gid), true);
    rep.check("A sees its own rule", idsA.includes(aid), true);
    rep.check("B sees the global rule", idsB.includes(gid), true);
    rep.check("B does NOT see A's rule", idsB.includes(aid), false);

    await admin("DELETE", `/v1/admin/rules/${gid}`);
    await admin("DELETE", `/v1/admin/rules/${aid}`);
    run(rep);
  }

  console.log("-- fleet list + per-device revocation --");
  {
    const rep = new Report("fleet");
    const fleet = await admin("GET", "/v1/devices");
    const ids = (fleet.data?.devices ?? []).map((d) => d.device_id);
    rep.check("fleet lists A", ids.includes(A.deviceId), true);
    rep.check("fleet lists B", ids.includes(B.deviceId), true);
    rep.check("fleet lists C", ids.includes(C.deviceId), true);

    rep.check("revoke B -> 200", (await admin("DELETE", `/v1/admin/devices/${B.deviceId}`)).status, 200);
    rep.check("B is now rejected -> 401",
      (await device(B, "POST", "/v1/sms/outgoing/poll", { ack_command_ids: [] })).status, 401);
    rep.check("A still works -> 200",
      (await device(A, "POST", "/v1/sms/outgoing/poll", { ack_command_ids: [] })).status, 200);
    rep.check("C still works -> 200",
      (await device(C, "POST", "/v1/sms/outgoing/poll", { ack_command_ids: [] })).status, 200);
    run(rep);
  }

  console.log("-- key rotation: same device_id, new keypair --");
  {
    const rep = new Report("rotation");
    const oldKey = A.privateKey;
    const rotated = newIdentity();          // new key, same device id
    rotated.deviceId = A.deviceId;
    const mint = await admin("POST", "/v1/admin/pairing-code", { ttl_ms: 60_000 });
    const re = await fetch(`${WORKER_URL}/v1/device/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pairing_code: mint.data.pairing_code,
        device_id: A.deviceId,
        public_key_spki: rotated.publicKeySpki,
      }),
    });
    rep.check("re-pair the same device_id -> 200", re.status, 200);

    const newKeyIdentity = { ...rotated, privateKey: crypto.createPrivateKey(rotated.privateKeyPem) };
    rep.check("the NEW key works -> 200",
      (await device(newKeyIdentity, "POST", "/v1/sms/outgoing/poll", { ack_command_ids: [] })).status, 200);

    const staleIdentity = { deviceId: A.deviceId, privateKey: oldKey, publicKeySpki: A.publicKeySpki };
    const stale = await device(staleIdentity, "POST", "/v1/sms/outgoing/poll", { ack_command_ids: [] });
    rep.check("the OLD key is rejected -> 401", stale.status, 401);
    rep.check("...as invalid_signature", stale.data?.error, "invalid_signature");

    // Rotation must also evict a live session held by the old key holder,
    // otherwise a stolen phone keeps its socket after the owner re-pairs.
    const before = signWith(newKeyIdentity, "GET", "/v1/device/ws", "");
    const ws = new RawWs({ pathname: "/v1/device/ws", headers: before.headers });
    await ws.connect();
    ws.sendText(JSON.stringify({ op: "hello" }));
    await sleep(300);

    const rotated2 = newIdentity();
    rotated2.deviceId = A.deviceId;
    const mint2 = await admin("POST", "/v1/admin/pairing-code", { ttl_ms: 60_000 });
    await fetch(`${WORKER_URL}/v1/device/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pairing_code: mint2.data.pairing_code,
        device_id: A.deviceId,
        public_key_spki: rotated2.publicKeySpki,
      }),
    });

    const closed = await ws.waitForClose(4000);
    rep.check("rotation closes the session held by the previous key", closed !== null, true);
    if (closed !== null) console.log(`  NOTE  rotated socket closed with ${closed}`);
    ws.close();
    run(rep);
  }

  console.log("-- cleanup --");
  for (const dev of [A, C]) {
    await admin("DELETE", `/v1/admin/devices/${dev.deviceId}`).catch(() => undefined);
  }

  console.log(allOk ? "MULTI-DEVICE PASSED" : "MULTI-DEVICE FAILED");
  process.exit(allOk ? 0 : 1);
}

/* ───────────────────────────── hardening command ───────────────────────────── */

/**
 * S2/S3/S10 negatives: input caps, the 413 path, admin rule CRUD, revocation.
 * Deliberately NOT part of `suite`, because a rate-limit flood would lock the
 * runner's IP out of pairing for a minute.
 */
async function cmdHardening() {
  const identity = loadIdentity();
  console.log(`== hardening ==\nworker: ${WORKER_URL}\ndevice: ${identity.deviceId}\n`);

  let allOk = true;
  const run = (rep) => { allOk = rep.print() && allOk; console.log(); };
  const bigBody = "x".repeat(300_000);

  console.log("-- S2 input caps --");
  {
    const rep = new Report("caps");
    const msg = (i) => ({
      local_id: `cap_${i}`, sender: "+8801712345678", body: "x",
      received_at: new Date().toISOString(),
    });

    rep.check("501-row incoming batch -> 400",
      (await device(identity, "POST", "/v1/sms/incoming/batch",
        { messages: Array.from({ length: 501 }, (_, i) => msg(i)), ack_command_ids: [] })).status, 400);

    rep.check("201-command send batch -> 400",
      (await admin("POST", "/v1/sms/send/batch", {
        device_id: identity.deviceId,
        commands: Array.from({ length: 201 }, () => ({ to: "+8801712345678", body: "x" })),
      })).status, 400);

    rep.check("501 status updates -> 400",
      (await device(identity, "POST", "/v1/sms/status/batch",
        { updates: Array.from({ length: 501 }, () => ({ command_id: "x", status: "SENT" })) })).status, 400);

    rep.check("201 ack ids -> 400",
      (await device(identity, "POST", "/v1/sms/outgoing/poll",
        { ack_command_ids: Array.from({ length: 201 }, () => "x") })).status, 400);

    rep.check("5000-char message body -> 400",
      (await device(identity, "POST", "/v1/sms/incoming/batch",
        { messages: [{ ...msg(999), body: "y".repeat(5000) }], ack_command_ids: [] })).status, 400);

    rep.check("oversized admin body -> 413 (not a 500)",
      (await admin("POST", "/v1/sms/send",
        { device_id: identity.deviceId, to: "+8801712345678", body: bigBody })).status, 413);

    rep.check("oversized DEVICE body -> 413 before signature verification",
      (await device(identity, "POST", "/v1/sms/incoming/batch", { pad: bigBody })).status, 413);
    run(rep);
  }

  console.log("-- S10 admin rule CRUD --");
  {
    const rep = new Report("rules crud");
    const id = `hard_${crypto.randomBytes(4).toString("hex")}`;
    const created = await admin("POST", "/v1/rules", {
      id, name: "hardening probe",
      matcher: { type: "exact", value: "+8801712345678" },
      body_matcher: { type: "keyword", value: "help" },
      reply_template: "ok",
    });
    rep.check("create rule -> 200", created.status, 200);

    const list = await admin("GET", "/v1/admin/rules");
    rep.check("GET /v1/admin/rules -> 200", list.status, 200);
    rep.check("admin list contains the new rule",
      (list.data?.rules ?? []).some((r) => r.id === id), true);

    rep.check("DELETE rule -> 200", (await admin("DELETE", `/v1/admin/rules/${id}`)).status, 200);
    rep.check("DELETE the same rule again -> 404",
      (await admin("DELETE", `/v1/admin/rules/${id}`)).status, 404);

    const after = await admin("GET", "/v1/admin/rules");
    rep.check("rule is gone from the list",
      (after.data?.rules ?? []).some((r) => r.id === id), false);
    run(rep);
  }

  console.log("-- S10 device revocation --");
  {
    const rep = new Report("revocation");
    const victim = newIdentity();
    const mint = await admin("POST", "/v1/admin/pairing-code", { ttl_ms: 60_000 });
    const paired = await fetch(`${WORKER_URL}/v1/device/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pairing_code: mint.data.pairing_code,
        device_id: victim.deviceId,
        public_key_spki: victim.publicKeySpki,
      }),
    });
    rep.check("throwaway device pairs -> 200", paired.status, 200);

    const victimKey = { ...victim, privateKey: crypto.createPrivateKey(victim.privateKeyPem) };
    rep.check("throwaway device can sign -> 200",
      (await device(victimKey, "POST", "/v1/sms/outgoing/poll", { ack_command_ids: [] })).status, 200);

    const revoked = await admin("DELETE", `/v1/admin/devices/${victim.deviceId}`);
    rep.check("DELETE /v1/admin/devices/:id -> 200", revoked.status, 200);

    // Proves revocation reaches the DO: D1 is not what verifies signatures.
    const afterRevoke = await device(victimKey, "POST", "/v1/sms/outgoing/poll", { ack_command_ids: [] });
    rep.check("revoked device can no longer sign -> 401", afterRevoke.status, 401);
    rep.check("...and it reports device_unknown", afterRevoke.data?.error, "device_unknown");
    run(rep);
  }

  console.log(allOk ? "HARDENING PASSED" : "HARDENING FAILED");
  process.exit(allOk ? 0 : 1);
}

/* ────────────────────────────────── ws command ───────────────────────────── */

async function cmdWs() {
  const identity = loadIdentity();
  const signed = signWith(identity, 'GET', '/v1/device/ws', '');
  const ws = new RawWs({ pathname: '/v1/device/ws', headers: signed.headers });
  const h = await ws.connect();
  console.log(`connected: ${h.status}`);
  ws.sendText(JSON.stringify({ op: 'hello', fcm_token: 'stub-fcm-token-0001' }));
  console.log('sent hello; holding session open. Ctrl-C to stop.');
  const timer = setInterval(() => ws.sendText(JSON.stringify({ op: 'ping' })), 45_000);
  for (;;) {
    await sleep(500);
    for (const m of ws.messages.splice(0)) {
      console.log(`<- ${m.text}`);
      try {
        const j = JSON.parse(m.text);
        if (j.op === 'commands') ws.sendText(JSON.stringify({ op: 'ack', command_ids: j.commands.map((c) => c.command_id) }));
      } catch { /* ignore */ }
    }
    if (ws.closeCode !== null) { console.log(`closed: ${ws.closeCode} ${ws.closeReason}`); break; }
  }
  clearInterval(timer);
}

/* ──────────────────────────────── proxy command ──────────────────────────── */

async function cmdProxy() {
  const identity = loadIdentity();
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const bodyStr = Buffer.concat(chunks).toString('utf8');
    const target = new URL(req.url, WORKER_URL);
    const signed = signWith(identity, req.method, target.pathname, bodyStr);
    // Forward the caller's headers too, so admin routes keep their bearer token;
    // the signed headers are layered on top for device routes.
    const forward = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const lk = k.toLowerCase();
      if (['host', 'connection', 'content-length', 'upgrade'].includes(lk)) continue;
      forward[k] = v;
    }
    try {
      const upstream = await fetch(target, {
        method: req.method,
        headers: { ...forward, ...signed.headers, 'Content-Type': req.headers['content-type'] ?? 'application/json' },
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : bodyStr,
      });
      const text = await upstream.text();
      res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' });
      res.end(text);
      console.log(`${req.method} ${target.pathname} -> ${upstream.status}`);
    } catch (e) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'proxy_upstream_failed', detail: e.message }));
    }
  });
  server.listen(PROXY_PORT, '127.0.0.1', () => {
    console.log(`signing proxy on http://localhost:${PROXY_PORT} as ${identity.deviceId}`);
    console.log('point the Hoppscotch collection here; it injects the four signed headers.');
  });
}

/* ───────────────────────────────── stub command ──────────────────────────── */

async function cmdStub() {
  const mod = await import(pathToFileURL(path.join(HERE, 'test-support', 'fcm-stub.mjs')).href);
  const portArgIndex = process.argv.indexOf('--port');
  const port = portArgIndex >= 0 ? Number(process.argv[portArgIndex + 1]) : Number(process.env.FCM_STUB_PORT ?? 8790);
  await mod.startFcmStub({ port, serviceAccountPath: path.join(HERE, 'test-support', 'stub-service-account.json') });
  console.log(`FCM/OAuth2 stub on http://127.0.0.1:${port}`);
}

/* ─────────────────────────────────── main ────────────────────────────────── */

const COMMANDS = {
  selftest: cmdSelftest,
  'verify-vectors': () => process.exit(cmdVerifyVectors().print() ? 0 : 1),
  pair: cmdPair,
  suite: cmdSuite,
  hardening: cmdHardening,
  multidevice: cmdMultiDevice,
  proxy: cmdProxy,
  ws: cmdWs,
  stub: cmdStub,
  reset: () => {
    if (fs.existsSync(STATE_FILE)) { fs.unlinkSync(STATE_FILE); console.log('identity cleared'); }
    else console.log('nothing to clear');
  },
};

const cmd = process.argv[2];
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  if (!cmd || !COMMANDS[cmd]) {
    console.log(`usage: node dakflare_test_harness.mjs <${Object.keys(COMMANDS).join('|')}>`);
    process.exit(cmd ? 1 : 0);
  }
  await COMMANDS[cmd]();
}
