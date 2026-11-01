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
 *   auth            auth cases: invite-only sign-up, single use, requireRole
 *                   401/403/200, machine-token path, audit rows. The legacy
 *                   selects the assertions (legacy|new); point WORKER_URL at a
 *                   Worker started with the matching mode.
 *   password        AUTH_PLAN §2 cases: salt shape/determinism, construction
 *                   parity, mode rules, sign-in, deletion. Reads the mode from
 *                   /v1/admin/health.
 *   lockout-global  the failed-auth window is in the AuthGuard Durable Object,
 *                   not isolate memory: three failures on one Worker process and
 *                   two on a restarted process still make the fifth 429, and the
 *                   lock survives another restart. Owns its `wrangler dev` and
 *                   isolated D1/DO state under /tmp/opencode.
 *   password-rotate pepper rotation end to end. Starts its own wrangler dev
 *                   (ring v1 -> v2,v1 -> v2) on PASSWORD_ROTATE_PORT, isolated
 *                   D1 state under /tmp/opencode.
 *   magic           AUTH_PLAN §1 factor 2: 202 for known/unknown/malformed,
 *                   single-use and expiry 410s, TOTP challenge, and the
 *                   no-sender deployment. Starts its own wrangler dev with a
 *                   local Resend capture on MAGIC_PORT, isolated D1 state under
 *                   /tmp/opencode.
 *   proxy           start the :8788 signing proxy for Hoppscotch.
 *   ws              connect a virtual device and hold a session open.
 *   stub            run the FCM/OAuth2 stub.
 *   reset           delete .harness-state.json
 *
 * Env: WORKER_URL (http://127.0.0.1:8787), ADMIN_TOKEN (dev-admin-token),
 *      STUB_URL (http://127.0.0.1:8790), HARNESS_ACK_TIMEOUT_MS (1500),
 *      HARNESS_LEASE_MS (6000), PROXY_PORT (8788). These two MUST match the
 *      Worker's ACK_TIMEOUT_MS and LEASE_MS; `test-support/dev.sh` sets both
 *      sides, and the lease-expiry section now fails loudly when they differ
 *      instead of quietly testing the wrong window.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const WORKER_URL = process.env.WORKER_URL ?? 'http://127.0.0.1:8787';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? 'dev-admin-token';
const STUB_URL = process.env.STUB_URL ?? 'http://127.0.0.1:8790';
const ACK_TIMEOUT_MS = Number(process.env.HARNESS_ACK_TIMEOUT_MS ?? 1500);
// Must equal the Worker's LEASE_MS. `dev.sh` passes both through `--var` and
// exports this one, but a harness started from another shell inherits nothing,
// so the default mirrors dev.sh and the lease-expiry section asserts the measured
// window against this value: a mismatch fails instead of passing by luck.
const LEASE_MS = Number(process.env.HARNESS_LEASE_MS ?? 6000);
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

/* ──────────────── password construction (AUTH_PLAN §2), independent ─────────
 *
 * Deliberately NOT imported from worker/src: the harness must be able to
 * disagree with the server about the stored value. It re-implements the four
 * lines of the contract:
 *
 *   material = PBKDF2-SHA256(password, salt, iterations)
 *   peppered = HMAC-SHA256(pepper_v, salt ‖ material)
 *   stored   = SHA-256(peppered)
 *   row      = v1$p=<v>$k=<k>$m=<c|s>$<salt-b64>$<sha256-b64>
 */
const PW_ITERATIONS = 210_000;

const b64Of = (buf) => Buffer.from(buf).toString('base64');

function pwMaterial(password, salt, iterations = PW_ITERATIONS) {
  return crypto.pbkdf2Sync(Buffer.from(password, 'utf8'), salt, iterations, 32, 'sha256');
}

function pwDigest(pepper, salt, material) {
  const peppered = crypto.createHmac('sha256', pepper).update(Buffer.concat([salt, material])).digest();
  return crypto.createHash('sha256').update(peppered).digest();
}

function pwRow({ pepper, version, iterations, mode, salt, material }) {
  return `v1$p=${version}$k=${iterations}$m=${mode}$${b64Of(salt)}$${b64Of(pwDigest(pepper, salt, material))}`;
}

function sessionCookieOf(cookies) {
  return (cookies ?? []).map((c) => c.split(';')[0]).find((c) => c.includes('session_token')) ?? null;
}

/** RFC 4648 base32, for a TOTP secret taken out of an otpauth:// URI. */
function base32Decode(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(value ?? '').replace(/=+$/, '').toUpperCase();
  let bits = 0;
  let acc = 0;
  const out = [];
  for (const char of clean) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error(`bad base32 character ${char}`);
    acc = (acc << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((acc >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/**
 * One TOTP code, RFC 6238 (HMAC-SHA1, 30 s), at a given instant.
 *
 * The instant is a parameter so the published RFC vectors can be asserted
 * against it; `totpNow` is the only caller that wants "now".
 */
function totpAt(secretBase32, nowMs, digits = 6) {
  const counter = Math.floor(nowMs / 30_000);
  const message = Buffer.alloc(8);
  message.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  message.writeUInt32BE(counter >>> 0, 4);
  const mac = crypto.createHmac('sha1', base32Decode(secretBase32)).update(message).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary =
    ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, '0');
}

function totpNow(secretBase32) {
  return totpAt(secretBase32, Date.now());
}

/* ────────────── a software WebAuthn authenticator (passkey step-up) ─────────
 *
 * The TOTP enable route re-authenticates with a passkey assertion, and this
 * harness has no browser. It therefore plays the authenticator: ES256, "none"
 * attestation, a counter, and a 50-line CBOR encoder for the two structures
 * WebAuthn needs. Everything that decides whether the assertion is valid — the
 * challenge, rpId, origin, public key, counter — comes from the Worker; this is
 * a real ceremony, not a bypass.
 */

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest();

function cborHead(major, n) {
  if (n < 24) return Buffer.from([(major << 5) | n]);
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n]);
  if (n < 0x10000) return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
  return Buffer.from([
    (major << 5) | 26,
    (n >>> 24) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 8) & 0xff,
    n & 0xff,
  ]);
}

/** Definite-length CBOR: ints, text, bytes, arrays, Maps and plain objects. */
function cbor(value) {
  if (typeof value === 'number') {
    return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  }
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([cborHead(3, bytes.length), bytes]);
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const bytes = Buffer.from(value);
    return Buffer.concat([cborHead(2, bytes.length), bytes]);
  }
  if (Array.isArray(value)) {
    return Buffer.concat([cborHead(4, value.length), ...value.map(cbor)]);
  }
  if (value instanceof Map) {
    const parts = [cborHead(5, value.size)];
    for (const [key, entry] of value) parts.push(cbor(key), cbor(entry));
    return Buffer.concat(parts);
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value);
    const parts = [cborHead(5, entries.length)];
    for (const [key, entry] of entries) parts.push(cbor(key), cbor(entry));
    return Buffer.concat(parts);
  }
  throw new Error(`cbor: unsupported value ${String(value)}`);
}

function cookieJar(cookie) {
  const jar = new Map();
  for (const part of String(cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) jar.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return jar;
}

function jarString(jar) {
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

function absorbCookies(jar, setCookies) {
  for (const raw of setCookies ?? []) {
    const pair = raw.split(';')[0];
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (value === '') jar.delete(name);
    else jar.set(name, value);
  }
}

/** One call to Better Auth's mount, carrying and absorbing the cookie jar. */
async function authCall(method, pathname, body, jar, base = WORKER_URL) {
  const headers = { Accept: 'application/json', Origin: base };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (jar && jar.size > 0) headers.Cookie = jarString(jar);
  const res = await fetch(base + pathname, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return { status: res.status, data: await res.json().catch(() => null), cookies };
}

/** Enrol a real ES256 passkey for `sessionCookie` (one registration ceremony). */
async function createPasskey(sessionCookie, base = WORKER_URL) {
  const jar = cookieJar(sessionCookie);
  const options = await authCall('GET', '/api/auth/passkey/generate-register-options', undefined, jar, base);
  absorbCookies(jar, options.cookies);
  if (options.status !== 200) return { status: options.status, data: options.data, jar };

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credentialId = crypto.randomBytes(16);
  const clientDataJSON = Buffer.from(
    JSON.stringify({
      type: 'webauthn.create',
      challenge: options.data.challenge,
      origin: base,
      crossOrigin: false,
    }),
    'utf8'
  );
  const coseKey = new Map([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, Buffer.from(jwk.x, 'base64url')],
    [-3, Buffer.from(jwk.y, 'base64url')],
  ]);
  const authData = Buffer.concat([
    sha256(Buffer.from(options.data.rp.id, 'utf8')),
    Buffer.from([0x41]), // user present + attested credential data
    Buffer.from([0, 0, 0, 0]), // sign counter
    Buffer.alloc(16), // aaguid
    Buffer.from([(credentialId.length >> 8) & 0xff, credentialId.length & 0xff]),
    credentialId,
    cbor(coseKey),
  ]);
  const attestationObject = cbor(
    new Map([
      ['fmt', 'none'],
      ['attStmt', new Map()],
      ['authData', authData],
    ])
  );

  const verified = await authCall(
    'POST',
    '/api/auth/passkey/verify-registration',
    {
      response: {
        id: credentialId.toString('base64url'),
        rawId: credentialId.toString('base64url'),
        type: 'public-key',
        response: {
          clientDataJSON: clientDataJSON.toString('base64url'),
          attestationObject: attestationObject.toString('base64url'),
        },
        clientExtensionResults: {},
      },
      name: 'harness step-up',
    },
    jar,
    base
  );
  absorbCookies(jar, verified.cookies);
  return {
    status: verified.status,
    data: verified.data,
    jar,
    privateKey,
    credentialId,
    rpId: options.data.rp.id,
    counter: 0,
    base,
  };
}

/**
 * Assert `passkey` and return the cookie jar of the session it created. The
 * Worker mints the step-up grant on this response; both cookies travel together
 * to `/v1/auth/totp/enable`.
 */
async function assertPasskey(passkey, base = passkey.base ?? WORKER_URL) {
  const jar = new Map(passkey.jar);
  const options = await authCall('GET', '/api/auth/passkey/generate-authenticate-options', undefined, jar, base);
  absorbCookies(jar, options.cookies);
  if (options.status !== 200) return { status: options.status, data: options.data, jar };

  const clientDataJSON = Buffer.from(
    JSON.stringify({
      type: 'webauthn.get',
      challenge: options.data.challenge,
      origin: base,
      crossOrigin: false,
    }),
    'utf8'
  );
  passkey.counter += 1;
  const counter = passkey.counter;
  const authData = Buffer.concat([
    sha256(Buffer.from(options.data.rpId ?? passkey.rpId, 'utf8')),
    Buffer.from([0x01]), // user present
    Buffer.from([
      (counter >>> 24) & 0xff,
      (counter >>> 16) & 0xff,
      (counter >>> 8) & 0xff,
      counter & 0xff,
    ]),
  ]);
  // WebAuthn EC2 signatures are ASN.1 DER; the verifier unwraps r/s itself.
  const signature = crypto.sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), {
    key: passkey.privateKey,
  });

  const verified = await authCall(
    'POST',
    '/api/auth/passkey/verify-authentication',
    {
      response: {
        id: passkey.credentialId.toString('base64url'),
        rawId: passkey.credentialId.toString('base64url'),
        type: 'public-key',
        response: {
          clientDataJSON: clientDataJSON.toString('base64url'),
          authenticatorData: authData.toString('base64url'),
          signature: signature.toString('base64url'),
          userHandle: null,
        },
        clientExtensionResults: {},
      },
    },
    jar,
    base
  );
  absorbCookies(jar, verified.cookies);
  return { status: verified.status, data: verified.data, jar, cookies: verified.cookies };
}


/** A tiny JSON-over-fetch helper scoped to an arbitrary base URL. */
async function api(base, method, pathname, { body, cookie, headers } = {}) {
  const res = await fetch(base + pathname, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
      ...(headers ?? {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
  const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return { status: res.status, data: await res.json().catch(() => null), cookies, headers: res.headers };
}

/* ────────────────────────────── contract §4 vectors ───────────────────────── */

/**
 * §4.2 vectors live in one file, `test-support/protocol-vectors.json`, so the
 * Worker, the phone (Rust) and this harness cannot drift apart. The Python
 * checker in `test-support/` keeps its own transcription on purpose and asserts
 * it against the same file; that is what makes it a third opinion rather than a
 * second copy.
 */
const VECTORS_FILE = path.join(HERE, 'test-support', 'protocol-vectors.json');
const CONTRACT = JSON.parse(fs.readFileSync(VECTORS_FILE, 'utf8'));

const VECTORS = CONTRACT.canonical.map((vector) => ({
  id: vector.id,
  method: vector.method,
  pathname: vector.pathname,
  timestamp: vector.timestamp,
  nonce: vector.nonce,
  body: vector.body,
  len: vector.body_bytes,
  sha: vector.body_sha256,
  canonical: vector.canonical,
}));

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

/**
 * Re-encode a 64-byte P1363 signature as minimal ASN.1 DER. Used by `selftest`
 * to prove derToP1363 agrees with Node's own P1363 output for the SAME (r, s):
 * two separate signatures cannot be compared because ECDSA is randomized (§4.3).
 */
function derFromP1363(p1363) {
  const integer = (bytes) => {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0x00) i++;
    let v = bytes.subarray(i);
    if (v[0] & 0x80) v = Buffer.concat([Buffer.from([0x00]), v]);
    return Buffer.concat([Buffer.from([0x02, v.length]), v]);
  };
  const body = Buffer.concat([
    integer(p1363.subarray(0, 32)),
    integer(p1363.subarray(32, 64)),
  ]);
  const header = body.length < 0x80
    ? Buffer.from([0x30, body.length])
    : Buffer.from([0x30, 0x81, body.length]);
  return Buffer.concat([header, body]);
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
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(STATE_FILE, JSON.stringify(identity, null, 2), { mode: 0o600 });
  try { fs.chmodSync(STATE_FILE, 0o600); } catch { /* best effort */ }
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
    headers: {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
      // Machine-credential marker (AUTH_PLAN §8). Harmless in legacy mode; in
      // AUTH_MODE=new it is what separates the CLI path from a human session.
      'X-Dakflare-Client': 'cli',
      'Content-Type': 'application/json',
    },
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

  // RFC 6238 Appendix B. A TOTP that is wrong by a digit is indistinguishable
  // from a wrong code at sign-in, so the published vectors are asserted here
  // instead of only being exercised end to end against a live Worker.
  for (const vector of CONTRACT.totp.vectors) {
    const at = vector.time * 1000;
    rep.check(`TOTP t=${vector.time} 8-digit`, totpAt(CONTRACT.totp.secret_base32, at, 8), vector.digits8);
    rep.check(`TOTP t=${vector.time} 6-digit`, totpAt(CONTRACT.totp.secret_base32, at, 6), vector.digits6);
  }
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

  // Prove the converter agrees with Node's own P1363 output for the same (r,s).
  // ECDSA is randomized, so we re-encode Node's P1363 bytes as minimal DER and
  // convert that back; equality is exact, not merely "both verify".
  {
    const p = crypto.sign('sha256', msg, { key: priv, dsaEncoding: 'ieee-p1363' });
    const reDer = derFromP1363(p);
    rep1.check('Node P1363 -> minimal DER -> derToP1363 round-trips exactly',
      derToP1363(reDer).toString('hex'), p.toString('hex'));
    rep1.check('the round-trip DER is one of the 70/71/72-byte forms',
      [70, 71, 72].includes(reDer.length), true);
  }

  // §4.3: DER inputs are 72, 71 and 70 bytes; each must convert to exactly 64.
  const convLen = new Map();
  let first72 = null;
  for (let i = 0; i < 600 && convLen.size < 3; i++) {
    const d = crypto.sign('sha256', Buffer.from('pad' + i), priv);
    if (d.length !== 70 && d.length !== 71 && d.length !== 72) continue;
    if (d.length === 72 && !first72) first72 = d;
    convLen.set(d.length, derToP1363(d).length);
  }
  rep1.check('saw all three DER input lengths 70, 71 and 72',
    [...convLen.keys()].sort((a, b) => a - b), [70, 71, 72]);
  for (const n of [70, 71, 72]) {
    rep1.check(`DER input length ${n} -> exactly 64 bytes`, convLen.get(n), 64);
  }
  if (first72) {
    rep1.check('naive slice(-64) is NOT the conversion for a 72-byte DER',
      derToP1363(first72).equals(first72.subarray(first72.length - 64)), false);
  } else {
    rep1.check('found a 72-byte DER to prove naive slice(-64) wrong', false, true);
  }
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

/** POST /v1/device/pair with an identity's device_id + SPKI. Never throws on HTTP errors. */
async function pairRequest(identity, pairingCode) {
  const res = await fetch(`${WORKER_URL}/v1/device/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pairing_code: pairingCode,
      device_id: identity.deviceId,
      public_key_spki: identity.publicKeySpki,
    }),
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

/**
 * `pair` and `suite` write: they create devices, rules and messages. Pointed at
 * a deployed Worker by a stray WORKER_URL they would pollute production, and the
 * first symptom is a 401 from the admin mint, which reads like an auth bug.
 *
 * A local stack is the default. A deployed Worker needs HARNESS_REMOTE=1, which
 * the lease-expiry section already understands.
 */
function refuseNonLocal(command) {
  let host;
  try {
    host = new URL(WORKER_URL).hostname;
  } catch {
    console.error(`refusing ${command}: WORKER_URL is not a URL: ${WORKER_URL}`);
    process.exit(2);
  }
  const local = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (local || process.env.HARNESS_REMOTE === '1') return;
  console.error(`refusing ${command} against ${WORKER_URL}: it creates devices, rules and messages.`);
  console.error('Start a local stack (test-support/dev.sh), or set HARNESS_REMOTE=1 to mean it.');
  process.exit(2);
}

async function cmdPair() {
  refuseNonLocal('pair');
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
  const expiredRes = await pairRequest(identity, shortLived.data.pairing_code);
  if (expiredRes.status !== 401) {
    throw new Error(`expired pairing code -> ${expiredRes.status}, want 401 (contract §11.4)`);
  }
  console.log('expired code -> 401');

  const paired = await fetch(`${WORKER_URL}/v1/device/pair`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pairing_code: minted.data.pairing_code, device_id: identity.deviceId, public_key_spki: identity.publicKeySpki }),
  });
  if (paired.status !== 200) throw new Error(`pair failed: ${paired.status} ${await paired.text()}`);
  console.log(`pair -> ${paired.status}`);

  const reuse = await pairRequest(identity, minted.data.pairing_code);
  if (reuse.status !== 401) {
    throw new Error(`reused pairing code -> ${reuse.status}, want 401`);
  }
  console.log('reuse -> 401');

  // The load-bearing check: a signed request must now succeed, which proves the
  // Durable Object actually registered the key (not just D1).
  const live = { ...identity, privateKey: priv(identity) };
  const probe = await device(live, 'POST', '/v1/sms/outgoing/poll', { acks: [] });
  console.log(`post-pair signed request -> ${probe.status} (want 200)`);
  if (probe.status !== 200) {
    throw new Error(`D1/DO divergence: pairing returned 200 but signed requests fail: ${JSON.stringify(probe.data)}`);
  }

  saveIdentity(identity);
  const mode = fs.statSync(STATE_FILE).mode & 0o777;
  if (mode !== 0o600) throw new Error(`state file mode is ${mode.toString(8)}, expected 600`);
  console.log(`\nidentity saved to ${path.relative(HERE, STATE_FILE)}`);
}

function priv(identity) {
  return crypto.createPrivateKey(identity.privateKeyPem);
}

/* ─────────────────────────────────── suite ───────────────────────────────── */

async function cmdSuite() {
  refuseNonLocal('suite');
  const identity = loadIdentity();
  console.log(`== suite ==\nworker: ${WORKER_URL}\ndevice: ${identity.deviceId}\nack timeout: ${ACK_TIMEOUT_MS} ms\nlease: ${LEASE_MS} ms\n`);

  let allOk = true;
  const run = (rep) => { allOk = rep.print() && allOk; console.log(); };

  /* ── pairing (§11.4) ───────────────────────────────────────────────────── */
  console.log('-- pairing --');
  {
    const rep = new Report('pairing');

    // §11.4: negative ttl_ms is clamped to >= 1000 ms, so it is NOT pre-expired.
    const neg = newIdentity();
    const negCode = await admin('POST', '/v1/admin/pairing-code', { ttl_ms: -1000 });
    rep.check('ttl_ms:-1000 still mints a code (clamped, not pre-expired)', negCode.status, 200);
    rep.check('...and that code pairs successfully', (await pairRequest(neg, negCode.data.pairing_code)).status, 200);

    // Expiry must be provoked with ttl_ms:1000 and a ~1.2 s wait.
    const fresh = newIdentity();
    const shortCode = await admin('POST', '/v1/admin/pairing-code', { ttl_ms: 1000 });
    await sleep(1250);
    rep.check('expired code -> 401', (await pairRequest(fresh, shortCode.data.pairing_code)).status, 401);

    const code = await admin('POST', '/v1/admin/pairing-code', { ttl_ms: 60_000 });
    rep.check('valid code -> 200', (await pairRequest(fresh, code.data.pairing_code)).status, 200);
    rep.check('re-used code -> 401', (await pairRequest(fresh, code.data.pairing_code)).status, 401);

    // The load-bearing check: a signed request must work immediately, which proves
    // D1 and the device's Durable Object agree rather than one half-registering.
    const live = { ...fresh, privateKey: crypto.createPrivateKey(fresh.privateKeyPem) };
    rep.check('signed request after pairing -> 200 (D1/DO agree)',
      (await device(live, 'POST', '/v1/sms/outgoing/poll', { acks: [] })).status, 200);

    await admin('DELETE', `/v1/admin/devices/${fresh.deviceId}`);
    await admin('DELETE', `/v1/admin/devices/${neg.deviceId}`);
    run(rep);
  }

  // Register an FCM token up front. The Durable Object looks up the device's
  // stored fcm_token before pushing, so without this the wake path has no target
  // and correctly declines to call FCM at all.
  await device(identity, 'POST', '/v1/sms/outgoing/poll', {
    acks: [], fcm_token: 'stub-fcm-token-0001',
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

  /* ── re-pair inheritance + device archive (2026-10-30 cutover) ─────────── */
  console.log('-- re-pair inheritance + device archive --');
  {
    const rep = new Report('re-pair inheritance');
    const label = `Harness Reinstall ${crypto.randomBytes(3).toString('hex')}`;

    /** Mint a code (optionally scoped/rotate) and pair `idn` with it. */
    const pairWith = async (idn, { label: reported, mint } = {}) => {
      const minted = await admin('POST', '/v1/admin/pairing-code', {
        ttl_ms: 60_000, ...(mint ?? {}),
      });
      const res = await fetch(`${WORKER_URL}/v1/device/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pairing_code: minted.data?.pairing_code,
          device_id: idn.deviceId,
          public_key_spki: idn.publicKeySpki,
          ...(reported === undefined ? {} : { label: reported }),
        }),
      });
      return { status: res.status, data: await res.json().catch(() => null) };
    };

    const workflows = async () =>
      (await admin('GET', '/v1/admin/workflows')).data?.workflows ?? [];
    const flowsFor = async (deviceId) =>
      (await workflows()).filter((w) => w.device_id === deviceId);
    const fleet = async (query = '') =>
      (await admin('GET', `/v1/devices${query}`)).data?.devices ?? [];
    const waitFor = async (fn, tries = 40) => {
      for (let i = 0; i < tries; i++) {
        const value = await fn();
        if (value) return value;
        await sleep(100);
      }
      return null;
    };

    /* 1. The old phone: pair with a label, then build two flows. ---------- */
    const old = newIdentity();
    const oldKey = { ...old, privateKey: crypto.createPrivateKey(old.privateKeyPem) };
    const firstPair = await pairWith(old, { label });
    rep.check('pair the original device with a label -> 200', firstPair.status, 200);
    rep.check('...a first pair copies nothing', firstPair.data?.copied_workflows, 0);

    const graph = (to) => ({
      nodes: [
        { id: 'trigger_1', type: 'trigger', position: { x: 0, y: 0 }, data: { kind: 'incoming' } },
        { id: 'send_1', type: 'send_sms', position: { x: 0, y: 100 }, data: { to, body: 'ack {{body}}' } },
        { id: 'stop_1', type: 'stop', position: { x: 0, y: 200 }, data: { reason: 'done' } },
      ],
      edges: [
        { id: 'edge_1', source: 'trigger_1', target: 'send_1' },
        { id: 'edge_2', source: 'send_1', target: 'stop_1' },
      ],
    });
    const originals = [
      { id: `harness_flow_a_${crypto.randomBytes(4).toString('hex')}`,
        name: 'Harness flow A', graph: graph('{{sender}}') },
      { id: `harness_flow_b_${crypto.randomBytes(4).toString('hex')}`,
        name: 'Harness flow B', graph: graph('+8801700000002') },
    ];
    for (const flow of originals) {
      const saved = await admin('PUT', `/v1/admin/workflows/${flow.id}`, {
        name: flow.name, device_id: old.deviceId, graph: flow.graph,
      });
      rep.check(`save ${flow.name} for the original device -> 200`, saved.status, 200);
    }
    rep.check('the original device owns both flows', (await flowsFor(old.deviceId)).length, 2);

    /* 2. The reinstalled phone: a NEW device_id, the same label. ---------- */
    const fresh = newIdentity();
    const secondPair = await pairWith(fresh, { label });
    rep.check('pair a NEW device with the same label -> 200', secondPair.status, 200);
    rep.check('...the pair response reports copied_workflows: 2',
      secondPair.data?.copied_workflows, 2);

    const copied = await flowsFor(fresh.deviceId);
    rep.check('the new device now owns two flows', copied.length, 2);
    rep.check('...every copied id is a fresh wf_ id',
      copied.every((w) => /^wf_[0-9a-f]{16}$/.test(w.id)), true);
    rep.check('...each name says where it came from',
      copied.every((w) => w.name.endsWith(` (copied from ${old.deviceId})`)), true);

    const sourceDocs = [];
    for (const flow of originals) {
      sourceDocs.push((await admin('GET', `/v1/admin/workflows/${flow.id}`)).data?.workflow);
    }
    let copiesMatch = true;
    const copiedVersions = [];
    for (const row of copied) {
      const doc = (await admin('GET', `/v1/admin/workflows/${row.id}`)).data?.workflow;
      copiedVersions.push(doc?.version);
      const base = String(doc?.name ?? '').replace(/ \(copied from .*\)$/, '');
      const source = sourceDocs.find((s) => s?.name === base);
      if (!source || JSON.stringify(doc?.graph) !== JSON.stringify(source.graph)) copiesMatch = false;
    }
    rep.check('...each copy starts at version 1', copiedVersions, [1, 1]);
    rep.check('...each copy carries the original graph', copiesMatch, true);

    /* 3. The originals are untouched. ------------------------------------ */
    const after = await flowsFor(old.deviceId);
    rep.check('the original device still owns both flows', after.length, 2);
    rep.check('...with the same ids',
      after.map((w) => w.id).sort(), originals.map((f) => f.id).sort());
    const originalVersions = [];
    for (const flow of originals) {
      originalVersions.push((await admin('GET', `/v1/admin/workflows/${flow.id}`)).data?.workflow?.version);
    }
    rep.check('...and version 1 (never re-saved)', originalVersions, [1, 1]);

    /* 4. Re-pairing the new device does not duplicate or overwrite. ------ */
    const again = await pairWith(fresh, {
      label,
      mint: { device_id: fresh.deviceId, purpose: 'rotate' },
    });
    rep.check('re-pair the new device with the same label -> 200', again.status, 200);
    rep.check('...it copies nothing a second time', again.data?.copied_workflows, 0);
    rep.check('...and the new device still owns exactly two flows',
      (await flowsFor(fresh.deviceId)).length, 2);

    /* 5. Archive keeps the history and hides the row. -------------------- */
    const historyId = `arch_${crypto.randomBytes(6).toString('hex')}`;
    const posted = await device(oldKey, 'POST', '/v1/sms/incoming/batch', {
      messages: [{
        local_id: historyId,
        sender: '+8801700000003',
        body: 'archive history probe',
        received_at: new Date().toISOString(),
      }],
      acks: [],
    });
    rep.check('the original device relays one message -> 200', posted.status, 200);

    const archived = await admin('POST', `/v1/admin/devices/${old.deviceId}/archive`);
    rep.check('archive -> 200', archived.status, 200);
    rep.check('...archived_at is set', typeof archived.data?.archived_at, 'number');
    rep.check('...changed is true', archived.data?.changed, true);
    rep.check('an archived device is hidden from GET /v1/devices',
      (await fleet()).some((d) => d.device_id === old.deviceId), false);
    const listed = (await fleet('?include_archived=1')).find((d) => d.device_id === old.deviceId);
    rep.check('...but ?include_archived=1 still lists it', Boolean(listed), true);
    rep.check('...with archived_at exposed', typeof listed?.archived_at, 'number');

    const history = await admin('GET', `/v1/messages?device_id=${old.deviceId}&limit=200`);
    rep.check('an archived device still answers /v1/messages -> 200', history.status, 200);
    rep.check('...its history is intact',
      (history.data?.messages ?? []).some((m) => m.local_id === historyId), true);

    const rearchived = await admin('POST', `/v1/admin/devices/${old.deviceId}/archive`);
    rep.check('archiving twice is a no-op 200', rearchived.status, 200);
    rep.check('...it does not move the timestamp',
      rearchived.data?.archived_at, archived.data?.archived_at);
    rep.check('...and reports changed: false', rearchived.data?.changed, false);

    /* 6. Unarchive restores it. ------------------------------------------ */
    const unarchived = await admin('POST', `/v1/admin/devices/${old.deviceId}/unarchive`);
    rep.check('unarchive -> 200', unarchived.status, 200);
    rep.check('...archived_at is null', unarchived.data?.archived_at, null);
    const visible = (await fleet()).find((d) => d.device_id === old.deviceId);
    rep.check('...the device is back in GET /v1/devices', Boolean(visible), true);
    rep.check('...with archived_at null', visible?.archived_at, null);

    /* 7. A poll from an archived device un-archives it automatically. ---- */
    await admin('POST', `/v1/admin/devices/${old.deviceId}/archive`);
    rep.check('re-archive for the poll case',
      (await fleet()).some((d) => d.device_id === old.deviceId), false);
    const polled = await device(oldKey, 'POST', '/v1/sms/outgoing/poll', { acks: [] });
    rep.check('an archived device can still poll -> 200', polled.status, 200);
    const back = await waitFor(async () =>
      (await fleet()).find((d) => d.device_id === old.deviceId && d.archived_at === null) ?? null);
    rep.check('a poll from an archived device un-archives it', Boolean(back), true);

    /* 8. Audit: both new events are recorded. ---------------------------- */
    const copyEvents = ((await admin('GET', '/v1/admin/audit?action=workflows.copied&limit=50'))
      .data?.events ?? []).filter((e) => e.subject === fresh.deviceId);
    const copyEvent = copyEvents.find((e) => e.detail?.count === 2);
    rep.check('audit has workflows.copied for the new device', Boolean(copyEvent), true);
    rep.check('...detail names both devices',
      [copyEvent?.detail?.from, copyEvent?.detail?.to], [old.deviceId, fresh.deviceId]);
    rep.check('...detail carries the count', copyEvent?.detail?.count, 2);
    rep.check('...the repeat pair is audited as count 0 with the skip counted',
      copyEvents.some((e) => e.detail?.count === 0 && e.detail?.skipped === 2), true);

    const autoEvent = ((await admin('GET', '/v1/admin/audit?action=device.unarchived&limit=50'))
      .data?.events ?? []).find((e) => e.subject === old.deviceId && e.detail?.automatic === true);
    rep.check('audit has the automatic device.unarchived', Boolean(autoEvent), true);

    rep.check('audit has device.archived for the device',
      ((await admin('GET', '/v1/admin/audit?action=device.archived&limit=50'))
        .data?.events ?? []).some((e) => e.subject === old.deviceId), true);

    /* 9. Teardown: delete every flow created here, then revoke both. ----- */
    for (const row of [...(await flowsFor(old.deviceId)), ...(await flowsFor(fresh.deviceId))]) {
      await admin('DELETE', `/v1/admin/workflows/${row.id}`);
    }
    rep.check('every flow created here is gone',
      (await flowsFor(old.deviceId)).length + (await flowsFor(fresh.deviceId)).length, 0);
    await admin('DELETE', `/v1/admin/devices/${old.deviceId}`);
    await admin('DELETE', `/v1/admin/devices/${fresh.deviceId}`);
    rep.check('both harness devices are revoked',
      (await fleet('?include_archived=1')).filter(
        (d) => d.device_id === old.deviceId || d.device_id === fresh.deviceId).length, 0);

    run(rep);
  }

  /* ── outbound reply state ──────────────────────────────────────────────── */
  console.log('-- outbound reply state --');
  {
    const rep = new Report('reply state');
    const readLog = async () =>
      (await admin('GET', `/v1/messages?device_id=${identity.deviceId}&limit=200`)).data?.messages ?? [];
    const readRows = async (localId) => (await readLog()).filter((m) => m.local_id === localId);

    /* 1. A `sent` report is stored and returned. -------------------------- */
    const localId = `state_${crypto.randomBytes(6).toString('hex')}`;
    const sentAt = new Date().toISOString();
    const entry = (extra = {}) => ({
      local_id: localId,
      to: '+15550001111',
      body: 'reply state probe',
      sent_at: sentAt,
      ...extra,
    });

    const sent = await device(identity, 'POST', '/v1/sms/incoming/batch', {
      outbound: [entry({ state: 'sent' })],
      acks: [],
    });
    rep.check('outbound[] sent -> 200', sent.status, 200);
    const sentRow = (await readRows(localId))[0];
    rep.check('outbound row is visible in /v1/messages', Boolean(sentRow), true);
    rep.check('...direction=out', sentRow?.direction, 'out');
    rep.check('...reply_state=sent', sentRow?.reply_state, 'sent');
    rep.check('...reply_error is null', sentRow?.reply_error, null);
    const firstId = sentRow?.id;

    /* 2. Re-upload with `delivered` updates the same row ------------------- */
    const delivered = await device(identity, 'POST', '/v1/sms/incoming/batch', {
      outbound: [entry({ state: 'delivered' })],
      acks: [],
    });
    rep.check('re-upload as delivered -> 200', delivered.status, 200);
    const deliveredRows = await readRows(localId);
    rep.check('...still exactly one row (dedupe key intact)', deliveredRows.length, 1);
    rep.check('...row id did not change', deliveredRows[0]?.id, firstId);
    rep.check('...reply_state updated to delivered', deliveredRows[0]?.reply_state, 'delivered');

    /* 3. A failed reply is visible with its capped error ------------------- */
    const failedId = `state_${crypto.randomBytes(6).toString('hex')}`;
    const longError = `radio refused ${'x'.repeat(240)}`;
    const failed = await device(identity, 'POST', '/v1/sms/incoming/batch', {
      outbound: [{
        ...entry({ state: 'failed', error: longError }),
        local_id: failedId,
      }],
      acks: [],
    });
    rep.check('failed outbound -> 200', failed.status, 200);
    const failedRow = (await readRows(failedId))[0];
    rep.check('failed row is visible (not silently dropped)', Boolean(failedRow), true);
    rep.check('...reply_state=failed', failedRow?.reply_state, 'failed');
    rep.check('...reply_error capped at 200 chars', failedRow?.reply_error?.length, 200);
    rep.check('...error text preserved up to the cap',
      failedRow?.reply_error, longError.slice(0, 200));

    /* 4. An unknown state is rejected, never stored ------------------------ */
    const badState = await device(identity, 'POST', '/v1/sms/incoming/batch', {
      outbound: [entry({ state: 'exploded' })],
      acks: [],
    });
    rep.check('unknown state -> 400', badState.status, 400);
    rep.check('...error is bad_request', badState.data?.error, 'bad_request');
    rep.check('...no row was written', (await readRows(localId)).length, 1);

    /* 5. A failed outbound never marks an inbound message answered --------- */
    const inboundId = `state_in_${crypto.randomBytes(6).toString('hex')}`;
    await device(identity, 'POST', '/v1/sms/incoming/batch', {
      messages: [{
        local_id: inboundId,
        sender: '+8801999999998',
        body: 'reply state probe, no rule matches this',
        received_at: new Date().toISOString(),
      }],
      acks: [],
    });
    const failedReplyId = `state_${crypto.randomBytes(6).toString('hex')}`;
    await device(identity, 'POST', '/v1/sms/incoming/batch', {
      outbound: [{
        ...entry({ state: 'failed', error: 'radio refused' }),
        local_id: failedReplyId,
      }],
      acks: [],
    });
    const inboundRow = (await readRows(inboundId))[0];
    rep.check('inbound row still reads reply_state null', inboundRow?.reply_state, null);
    rep.check('a failed outbound did not set auto_reply on the inbound row',
      inboundRow?.auto_reply, 0);
    rep.check('...and did not claim a rule replied', inboundRow?.reply_source, null);

    /* 6. Older clients: direction:"out" entries still carry state ---------- */
    const legacyId = `state_${crypto.randomBytes(6).toString('hex')}`;
    const legacy = await device(identity, 'POST', '/v1/sms/incoming/batch', {
      messages: [{
        local_id: legacyId,
        sender_e164: '+15550001112',
        body: 'legacy outbound shape',
        received_at: new Date().toISOString(),
        direction: 'out',
        state: 'sent',
      }],
      acks: [],
    });
    rep.check('direction:"out" + state -> 200', legacy.status, 200);
    rep.check('...reply_state=sent', (await readRows(legacyId))[0]?.reply_state, 'sent');

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
      const r = await device(identity, 'POST', '/v1/sms/outgoing/poll', { acks: [] }, { nonce });
      rep.check(`X-Nonce ${label} -> malformed_header`, r.data?.error, 'malformed_header');
    }

    for (const [label, ts] of [
      ['"+" prefix', '+' + Date.now()],
      ['trailing ".0"', Date.now() + '.0'],
      ['exponent', '1.7e12'],
      ['12 digits', '177647040000'],
    ]) {
      const r = await device(identity, 'POST', '/v1/sms/outgoing/poll', { acks: [] }, { ts });
      rep.check(`X-Timestamp ${label} -> malformed_header`, r.data?.error, 'malformed_header');
    }
    // §1.2.1: leading whitespace is stripped by the HTTP parser, so the padded
    // form is asserted in `selftest` as a validator unit test, not here.

    const tamper = await device(identity, 'POST', '/v1/sms/outgoing/poll', { acks: [] },
      {
        signBodyStr: JSON.stringify({ acks: [] }),
        sendBodyStr: JSON.stringify({ acks: [{ command_id: 'tampered', claim_token: 'tampered' }] }),
      });
    rep.check('body tamper -> invalid_signature', tamper.data?.error, 'invalid_signature');

    const shortSig = await device(identity, 'POST', '/v1/sms/outgoing/poll', { acks: [] }, { sigB64: 'AAAA' });
    rep.check('3-byte signature -> bad_signature_length', shortSig.data?.error, 'bad_signature_length');

    const query = await device(identity, 'POST', '/v1/sms/outgoing/poll', { acks: [] }, { query: '?x=1', sigB64: 'AAAA' });
    rep.check('query string -> 400 unexpected_query (before crypto)', query.data?.error, 'unexpected_query');
    rep.check('query string status is 400 not 401', query.status, 400);
    run(rep);
  }

  /* ── replay guard (§5) ─────────────────────────────────────────────────── */
  console.log('-- replay guard (§5) --');
  {
    const rep = new Report('replay');
    const first = await device(identity, 'POST', '/v1/sms/outgoing/poll', { acks: [] });
    rep.check('fresh nonce -> 200', first.status, 200);
    const replay = await device(identity, 'POST', '/v1/sms/outgoing/poll', { acks: [] },
      { ts: first.signed.ts, nonce: first.signed.nonce, sigB64: first.signed.sigB64 });
    rep.check('same nonce again -> nonce_replay', replay.data?.error, 'nonce_replay');

    // same millisecond, different nonce: must succeed
    const ms = String(Date.now());
    const a = await device(identity, 'POST', '/v1/sms/outgoing/poll', { acks: [] }, { ts: ms });
    const b = await device(identity, 'POST', '/v1/sms/outgoing/poll', { acks: [] }, { ts: ms });
    rep.check('two fresh nonces in the SAME millisecond -> both 200', a.status === 200 && b.status === 200, true);

    // The withdrawn evicted_max_ts design fails at 33; assert 40.
    let burstOk = 0;
    const failures = [];
    for (let i = 0; i < 40; i++) {
      const r = await device(identity, 'POST', '/v1/sms/outgoing/poll', { acks: [] });
      if (r.status === 200) burstOk++; else failures.push(`${i}:${r.status}:${r.data?.error}`);
    }
    rep.check('40 consecutive in-window requests all 200 (kills evicted_max_ts)', burstOk, 40);
    if (failures.length) console.log(`        failures: ${failures.slice(0, 5).join(', ')}`);

    const [c1, c2] = await Promise.all([
      device(identity, 'POST', '/v1/sms/outgoing/poll', { acks: [] }),
      device(identity, 'POST', '/v1/sms/outgoing/poll', { acks: [] }),
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
      ['negative lookahead (?!a)', '(?!a)'],
      ['lookbehind (?<=a)', '(?<=a)'],
      ['negative lookbehind (?<!a)', '(?<!a)'],
      ['nested quantifier (a+)+', '(a+)+'],
      ['nested quantifier (?:a+)+', '(?:a+)+'],
      ['nested quantifier (a+b+)+', '(a+b+)+'],
      ['nested quantifier ((a+))+', '((a+))+'],
      ['nested quantifier ((a+)(b+))+', '((a+)(b+))+'],
      ['nested counted (a{1,50}){1,50}', '(a{1,50}){1,50}'],
      ['overlapping alternation (a|a)+$', '(a|a)+$'],
      ['overlapping alternation (a|aa)+$', '(a|aa)+$'],
      ['backreference \\1', 'a\\1'],
      ['named backref \\k<n>', 'a\\k<n>'],
      ['possessive a*+', 'a*+'],
      ['possessive a++', 'a++'],
      ['possessive a{2,3}+', 'a{2,3}+'],
      ['atomic group (?>a)', '(?>a)'],
      ['conditional (?(1)a)', '(?(1)a)'],
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

  /* ── console surface (§11.11–§11.12) ───────────────────────────────────── */
  console.log('-- console surface (§11.11–§11.12) --');
  {
    const rep = new Report('console surface');
    const consoleDevice = newIdentity();
    const consoleKey = {
      ...consoleDevice,
      privateKey: crypto.createPrivateKey(consoleDevice.privateKeyPem),
    };

    // Counts the section must restore. Everything below is scoped to this fresh
    // device, so a leak is visible as a non-zero delta rather than hidden in a
    // global total that other sections also move.
    const rulesBefore = ((await admin('GET', '/v1/admin/rules')).data?.rules ?? []).length;
    const devicesBefore = ((await admin('GET', '/v1/devices')).data?.devices ?? []).length;
    const messagesBefore =
      ((await admin('GET', `/v1/messages?device_id=${consoleDevice.deviceId}&limit=200`)).data
        ?.messages ?? []).length;

    const pairWith = async (pairingCode, extra) => {
      const res = await fetch(`${WORKER_URL}/v1/device/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pairing_code: pairingCode,
          device_id: consoleDevice.deviceId,
          public_key_spki: consoleDevice.publicKeySpki,
          ...extra,
        }),
      });
      return { status: res.status, data: await res.json().catch(() => null) };
    };
    const mintPair = async (extra = {}) =>
      (await admin('POST', '/v1/admin/pairing-code', { ttl_ms: 60_000, ...extra })).data
        ?.pairing_code || null;

    /* 1. pairing metadata (§11.12) ---------------------------------------- */
    const enrollCode = await mintPair();
    rep.check('control-character label -> 400',
      (await pairWith(enrollCode, { label: 'bad\u0007label' })).status, 400);
    rep.check('sim_slot 3 -> 400',
      (await pairWith(enrollCode, { label: 'ok', sim_slot: 3 })).status, 400);

    const label = '  Console Suite Phone  ';
    const paired = await pairWith(enrollCode, { label, sim_slot: 1 });
    rep.check('pair with label + sim_slot:1 -> 200', paired.status, 200);

    const fleet = async () =>
      (await admin('GET', '/v1/devices')).data?.devices ?? [];
    const deviceRow = async () =>
      (await fleet()).find((d) => d.device_id === consoleDevice.deviceId);
    const row1 = await deviceRow();
    rep.check('fleet returns the new device', Boolean(row1), true);
    rep.check('label persisted trimmed', row1?.label, label.trim());
    rep.check('sim_slot persisted', row1?.sim_slot, 1);
    rep.check('paired_at is exposed as a number', typeof row1?.paired_at, 'number');
    rep.check('last_seen is exposed as a number', typeof row1?.last_seen, 'number');

    /* 2. re-pair without metadata preserves it (COALESCE) ------------------ */
    const rotateCode = await mintPair({
      device_id: consoleDevice.deviceId,
      purpose: 'rotate',
    });
    const repaired = await pairWith(rotateCode, {});
    rep.check('re-pair omitting label/sim_slot -> 200', repaired.status, 200);
    const row2 = await deviceRow();
    rep.check('re-pair preserved the label', row2?.label, label.trim());
    rep.check('re-pair preserved sim_slot', row2?.sim_slot, 1);

    /* 3. rule reply (§11.11) ----------------------------------------------- */
    const ruleId = `console_${crypto.randomBytes(6).toString('hex')}`;
    const sender = '+8801712345678';
    const ruleBody = 'please keyword now';
    const replyTemplate = 'RULEACK {sender} | {body} | {matched}';
    const created = await admin('POST', '/v1/rules', {
      id: ruleId,
      device_id: consoleDevice.deviceId,
      name: 'console suite probe',
      matcher: { type: 'exact', value: sender },
      body_matcher: { type: 'keyword', value: 'keyword' },
      reply_template: replyTemplate,
      // Highest precedence, so a pre-existing global rule in a dirty local
      // database cannot answer first and make this section's reply ambiguous.
      priority: 1_000_000,
      cooldown_seconds: 3600,
      max_per_hour: 100,
    });
    rep.check('create a device-scoped rule -> 200', created.status, 200);

    const firstLocalId = `console_${crypto.randomBytes(6).toString('hex')}`;
    const firstBatch = await device(consoleKey, 'POST', '/v1/sms/incoming/batch', {
      messages: [{
        local_id: firstLocalId,
        sender,
        body: ruleBody,
        received_at: new Date().toISOString(),
      }],
      acks: [],
    });
    rep.check('matching inbound -> 200', firstBatch.status, 200);
    rep.check('accepted 1', firstBatch.data?.accepted, 1);
    const replyCmd = (firstBatch.data?.commands ?? []).find(
      (c) => typeof c.body === 'string' && c.body.startsWith('RULEACK ')
    );
    rep.check('response contains a reply command', Boolean(replyCmd), true);
    rep.check('reply template substituted {sender}/{body}/{matched}',
      replyCmd?.body, `RULEACK ${sender} | ${ruleBody} | keyword`);

    const readLog = async () =>
      (await admin('GET', `/v1/messages?device_id=${consoleDevice.deviceId}&limit=200`))
        .data?.messages ?? [];
    const log1 = await readLog();
    const inbound1 = log1.find((m) => m.local_id === firstLocalId);
    rep.check('inbound row records reply_source=rule', inbound1?.reply_source, 'rule');
    rep.check('inbound row records reply_ref=rule id', inbound1?.reply_ref, ruleId);
    rep.check('inbound row records reply_command_id',
      inbound1?.reply_command_id, replyCmd?.command_id);
    const outbound1 = log1.find(
      (m) => m.direction === 'out' && m.local_id === replyCmd?.command_id
    );
    rep.check('outbound mirror row exists', Boolean(outbound1), true);
    rep.check('outbound id === local_id === reply_command_id',
      [outbound1?.id, outbound1?.local_id, replyCmd?.command_id],
      [replyCmd?.command_id, replyCmd?.command_id, replyCmd?.command_id]);

    /* 4. cooldown suppresses the second reply ------------------------------ */
    const secondLocalId = `console_${crypto.randomBytes(6).toString('hex')}`;
    const secondBatch = await device(consoleKey, 'POST', '/v1/sms/incoming/batch', {
      messages: [{
        local_id: secondLocalId,
        sender,
        body: 'second keyword message',
        received_at: new Date().toISOString(),
      }],
      acks: [],
    });
    rep.check('second matching inbound inside cooldown -> 200', secondBatch.status, 200);
    rep.check('accepted 1', secondBatch.data?.accepted, 1);
    rep.check('cooldown suppressed the reply command',
      (secondBatch.data?.commands ?? []).some(
        (c) => typeof c.body === 'string' && c.body.startsWith('RULEACK ')
      ), false);
    const inbound2 = (await readLog()).find((m) => m.local_id === secondLocalId);
    rep.check('cooldown-suppressed row has reply_source null', inbound2?.reply_source, null);

    /* 5. non-matching sender gets no rule reply ---------------------------- */
    const thirdLocalId = `console_${crypto.randomBytes(6).toString('hex')}`;
    const thirdBatch = await device(consoleKey, 'POST', '/v1/sms/incoming/batch', {
      messages: [{
        local_id: thirdLocalId,
        sender: '+8801999999999',
        body: 'nothing to see here',
        received_at: new Date().toISOString(),
      }],
      acks: [],
    });
    rep.check('non-matching inbound -> 200', thirdBatch.status, 200);
    rep.check('accepted 1', thirdBatch.data?.accepted, 1);
    const inbound3 = (await readLog()).find((m) => m.local_id === thirdLocalId);
    rep.check('non-matching row was not answered by a rule',
      inbound3?.reply_source === 'rule', false);

    /* 6. dry-run test endpoint explains each non-match --------------------- */
    const testRule = async (peer, body) => {
      const res = await admin('POST', '/v1/admin/rules/test', {
        device_id: consoleDevice.deviceId,
        peer,
        body,
      });
      return (res.data?.matches ?? []).find((m) => m.rule_id === ruleId);
    };
    const beforeTest = (await readLog()).length;
    const testMatch = await testRule(sender, 'suite keyword sample');
    rep.check('rules/test matching sample -> matched', testMatch?.reason, 'matched');
    rep.check('rules/test matched flag is true', testMatch?.matched, true);
    rep.check('rules/test sender mismatch -> sender_mismatch',
      (await testRule('+8801999999999', 'suite keyword sample'))?.reason, 'sender_mismatch');
    rep.check('rules/test body mismatch -> body_mismatch',
      (await testRule(sender, 'no trigger'))?.reason, 'body_mismatch');
    rep.check('rules/test wrote no reply', (await readLog()).length, beforeTest);

    /* 7. device command history: newest-first, documented fields, clamped -- */
    // One extra operator send makes "newest-first" falsifiable: with a single
    // command the ordering would be true by construction.
    const marker = `console marker ${crypto.randomBytes(4).toString('hex')}`;
    rep.check('operator send to the console device -> 200',
      (await admin('POST', '/v1/sms/send', {
        device_id: consoleDevice.deviceId, to: sender, body: marker,
      })).status, 200);

    const history = await admin(
      'GET', `/v1/admin/devices/${consoleDevice.deviceId}/commands?limit=50`
    );
    const commands = history.data?.commands ?? [];
    rep.check('GET device commands -> 200', history.status, 200);
    rep.check('history includes the rule reply and the operator send',
      commands.some((c) => c.command_id === replyCmd?.command_id) &&
        commands.some((c) => c.body === marker), true);
    rep.check('command rows expose the documented fields', commands.every((c) =>
      typeof c.command_id === 'string' && typeof c.to_e164 === 'string' &&
      typeof c.body === 'string' && typeof c.priority === 'string' &&
      typeof c.state === 'string' && typeof c.created_at === 'number' &&
      typeof c.expires_at === 'number'), true);
    rep.check('commands are newest-first', commands.every(
      (c, i) => i === 0 || commands[i - 1].created_at >= c.created_at), true);

    const one = await admin(
      'GET', `/v1/admin/devices/${consoleDevice.deviceId}/commands?limit=1`
    );
    const oneCommands = one.data?.commands ?? [];
    rep.check('limit=1 returns one command', oneCommands.length, 1);
    rep.check('limit=1 returns the newest command',
      oneCommands[0]?.command_id, commands[0]?.command_id);

    const zero = await admin(
      'GET', `/v1/admin/devices/${consoleDevice.deviceId}/commands?limit=0`
    );
    rep.check('limit=0 clamps up to 1', (zero.data?.commands ?? []).length, 1);
    const huge = await admin(
      'GET', `/v1/admin/devices/${consoleDevice.deviceId}/commands?limit=999`
    );
    rep.check('limit=999 clamps down to 50',
      (huge.data?.commands ?? []).length, Math.min(50, commands.length));

    /* 8. clean up, and prove the section left no residue ------------------- */
    rep.check('delete the rule -> 200',
      (await admin('DELETE', `/v1/admin/rules/${ruleId}`)).status, 200);
    rep.check('purge the device messages -> 200',
      (await admin('DELETE', `/v1/messages?device_id=${consoleDevice.deviceId}`)).status, 200);
    rep.check('device has no messages after purge', (await readLog()).length, 0);
    rep.check('revoke the device -> 200',
      (await admin('DELETE', `/v1/admin/devices/${consoleDevice.deviceId}`)).status, 200);
    rep.check('revoked device can no longer sign -> 401',
      (await device(consoleKey, 'POST', '/v1/sms/outgoing/poll', { acks: [] })).status,
      401);

    const rulesAfter = ((await admin('GET', '/v1/admin/rules')).data?.rules ?? []).length;
    const devicesAfter = ((await admin('GET', '/v1/devices')).data?.devices ?? []).length;
    const messagesAfter =
      ((await admin('GET', `/v1/messages?device_id=${consoleDevice.deviceId}&limit=200`)).data
        ?.messages ?? []).length;
    rep.check('rule count returned to its pre-section value', rulesAfter, rulesBefore);
    rep.check('device count returned to its pre-section value', devicesAfter, devicesBefore);
    rep.check('message count returned to its pre-section value', messagesAfter, messagesBefore);
    run(rep);
  }

  /* ── incoming batch (§5.4) ─────────────────────────────────────────────── */
  console.log('-- incoming batch --');
  {
    const rep = new Report('incoming');
    const localId = 'suite_' + crypto.randomBytes(6).toString('hex');
    const msg = { local_id: localId, sender: '+8801712345678', body: 'hello', received_at: new Date().toISOString() };

    const first = await device(identity, 'POST', '/v1/sms/incoming/batch', { messages: [msg], acks: [] });
    rep.check('first insert -> 200', first.status, 200);
    rep.check('accepted 1', first.data?.accepted, 1);

    const dup = await device(identity, 'POST', '/v1/sms/incoming/batch', { messages: [msg], acks: [] });
    rep.check('same (device_id, local_id) -> duplicates 1', dup.data?.duplicates, 1);

    const badDate = await device(identity, 'POST', '/v1/sms/incoming/batch', {
      messages: [{ ...msg, local_id: localId + '_b', received_at: '9999-12-31T00:00:00.000Z' }], acks: [],
    });
    rep.check('received_at year 9999 -> 400', badDate.status, 400);

    const ancient = await device(identity, 'POST', '/v1/sms/incoming/batch', {
      messages: [{ ...msg, local_id: localId + '_c', received_at: '1970-01-01T00:00:00.000Z' }], acks: [],
    });
    rep.check('received_at 1970 -> 400 (bounded)', ancient.status, 400);

    const malformed = await device(identity, 'POST', '/v1/sms/incoming/batch', undefined, { bodyStr: '{not json' });
    rep.check('malformed JSON -> 400 not 500', malformed.status, 400);

    const missingLocal = await device(identity, 'POST', '/v1/sms/incoming/batch', {
      messages: [{ sender: '+8801712345678', body: 'x', received_at: new Date().toISOString() }], acks: [],
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

    const readState = async (id = cmdId) => {
      const r = await admin('GET', `/v1/sms/commands/${id}?device_id=${identity.deviceId}`);
      return { status: r.status, state: r.data?.command?.state };
    };

    rep.check('new command is PENDING', (await readState()).state, 'PENDING');

    // §11.5: an unknown command id is a successful read with `command: null`;
    // only a missing device_id is a 404. This used to be a 404 and drifted.
    const unknownCommand = await admin(
      'GET', `/v1/sms/commands/does-not-exist?device_id=${identity.deviceId}`
    );
    rep.check('unknown command id -> 200', unknownCommand.status, 200);
    rep.check('...reports command: null', unknownCommand.data?.command, null);
    const missingDevice = await admin('GET', '/v1/sms/commands/does-not-exist');
    rep.check('missing device_id -> 404', missingDevice.status, 404);

    const msgs = await admin('GET', `/v1/messages?device_id=${identity.deviceId}&limit=50`);
    rep.check('outbound row persisted with direction=out',
      (msgs.data?.messages ?? []).some((m) => m.direction === 'out' && m.body === 'suite lifecycle'), true);

    const poll1 = await device(identity, 'POST', '/v1/sms/outgoing/poll', { acks: [] });
    const polledCmd = (poll1.data?.commands ?? []).find((c) => c.command_id === cmdId);
    rep.check('poll returns the pending command', Boolean(polledCmd), true);
    rep.check('poll took a lease', (await readState()).state, 'LEASED');
    const claimToken = polledCmd?.claim_token;
    rep.check('the polled command carries a claim_token', typeof claimToken, 'string');

    // The lease is EXCLUSIVE. A second transport asking at the same moment must
    // not receive the command that is already LEASED: this is the race the atomic
    // claim exists for, and the reason read-then-mark was replaced.
    const concurrentPoll = await device(identity, 'POST', '/v1/sms/outgoing/poll', { acks: [] });
    rep.check('a LEASED command is NOT handed to a second poll',
      (concurrentPoll.data?.commands ?? []).some((c) => c.command_id === cmdId), false);

    const ack = await device(identity, 'POST', '/v1/sms/outgoing/poll',
      { acks: [{ command_id: cmdId, claim_token: claimToken }] });
    rep.check('ack -> 200', ack.status, 200);
    rep.check('ack moved it to DISPATCHED', (await readState()).state, 'DISPATCHED');
    rep.check('acked command not re-returned', (ack.data?.commands ?? []).some((c) => c.command_id === cmdId), false);

    await device(identity, 'POST', '/v1/sms/status/batch', { updates: [{ command_id: cmdId, status: 'SENT' }] });
    rep.check('SENT applied', (await readState()).state, 'SENT');
    await device(identity, 'POST', '/v1/sms/status/batch', { updates: [{ command_id: cmdId, status: 'DELIVERED' }] });
    rep.check('DELIVERED applied', (await readState()).state, 'DELIVERED');

    const staleAck = await device(identity, 'POST', '/v1/sms/outgoing/poll',
      { acks: [{ command_id: cmdId, claim_token: claimToken }] });
    rep.check('stale ack returns 200 (no-op, not an error)', staleAck.status, 200);
    rep.check('stale ack did NOT regress DELIVERED', (await readState()).state, 'DELIVERED');

    // The retired v5.2.1 key is refused, not ignored. Silence would leave an old
    // handset believing it acknowledged while its leases churn underneath it.
    const retiredPoll = await device(identity, 'POST', '/v1/sms/outgoing/poll',
      { ack_command_ids: [cmdId] });
    rep.check('retired ack_command_ids on poll -> 400', retiredPoll.status, 400);
    const retiredBatch = await device(identity, 'POST', '/v1/sms/incoming/batch',
      { messages: [], ack_command_ids: [] });
    rep.check('retired ack_command_ids on batch -> 400', retiredBatch.status, 400);

    // A wrong claim_token must be accepted (200) and do nothing: the command is
    // still LEASED and stays claimable by its real token holder.
    const wrongTokened = await admin('POST', '/v1/sms/send', {
      device_id: identity.deviceId, to: '+8801712345678', body: 'wrong token probe',
    });
    const wrongId = wrongTokened.data?.command_id;
    const wrongPoll = await device(identity, 'POST', '/v1/sms/outgoing/poll', { acks: [] });
    const wrongCmd = (wrongPoll.data?.commands ?? []).find((c) => c.command_id === wrongId);
    rep.check('a fresh command is LEASED by the poll', (await readState(wrongId)).state, 'LEASED');
    const wrongAck = await device(identity, 'POST', '/v1/sms/outgoing/poll',
      { acks: [{ command_id: wrongId, claim_token: 'deadbeefdeadbeefdeadbeefdeadbeef' }] });
    rep.check('ack with a wrong claim_token -> 200', wrongAck.status, 200);
    rep.check('...but it did NOT move the LEASED command', (await readState(wrongId)).state, 'LEASED');
    // Drain it with the real token so it is not left behind for later sections.
    await device(identity, 'POST', '/v1/sms/outgoing/poll',
      { acks: [{ command_id: wrongId, claim_token: wrongCmd?.claim_token }] });

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
    const tokens = new Map();
    for (const m of ws.messages.slice(before)) {
      try {
        const j = JSON.parse(m.text);
        if (j.op === 'commands') {
          for (const c of j.commands) {
            delivered.push(c.command_id);
            tokens.set(c.command_id, c.claim_token);
          }
        }
      } catch { /* not JSON */ }
    }
    const unique = new Set(delivered);
    rep.check('every batch command delivered over WS', unique.size, 5);
    rep.check('no command delivered twice (kills the O(N^2) re-push)', delivered.length, unique.size);

    // ack them so the lease-expiry path is not the subject of the next assertion
    ws.sendText(JSON.stringify({
      op: 'ack',
      acks: [...unique].map((id) => ({ command_id: id, claim_token: tokens.get(id) })),
    }));
    await sleep(400);
    const acked = await admin('GET', `/v1/sms/commands/${[...unique][0]}?device_id=${identity.deviceId}`);
    rep.check('WS ack advanced a command', acked.data?.command?.state, 'DISPATCHED');

    ws.close();
    run(rep);
  }

  /* ── lease expiry + FCM wake (§5.5 alarm) ──────────────────────────────── */
  console.log(`-- lease expiry (${LEASE_MS} ms) + FCM wake --`);
  {
    const rep = new Report('lease expiry');
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
      rep.check('command pushed and LEASED', dispatched.data?.command?.state, 'LEASED');
      // The lease started when the push happened, which is before this read. The
      // window is measured from HERE, so the close assertion below cannot eat
      // into it: measuring from after that wait made the observed value
      // `LEASE_MS` minus however long the close took, which is a coin flip
      // against any threshold.
      const leaseStartedAt = Date.now();

      // A real deployment's alarm scheduling adds latency; allow for it. The
      // lease expires at LEASE_MS, independent of ACK_TIMEOUT_MS, and the two
      // timers are separate: in production the socket closes at 8 s while the
      // lease still has 52 s to run, so the state is polled, not inferred from
      // the close.
      // The two timers are separate and in that order: `ack_wake` closes the
      // socket at ACK_TIMEOUT_MS without touching the lease, and only
      // `lease_expiry` reverts at LEASE_MS. Assert the close first, then that the
      // command is STILL leased: a close that released the lease would be the
      // duplicate send this machine exists to prevent.
      const closeCode = await ws.waitForClose(ACK_TIMEOUT_MS + (REMOTE ? 20_000 : 4_000));
      rep.check('the unacked socket is closed with 1011', closeCode, 1011);
      const afterClose = await admin('GET', `/v1/sms/commands/${cmdId}?device_id=${identity.deviceId}`);
      rep.check('closing the socket does NOT release the lease',
        afterClose.data?.command?.state, 'LEASED');

      const revertDeadline = leaseStartedAt + LEASE_MS + (REMOTE ? 25_000 : 5_000);
      let revertedState = null;
      while (Date.now() < revertDeadline) {
        const r = await admin('GET', `/v1/sms/commands/${cmdId}?device_id=${identity.deviceId}`);
        revertedState = r.data?.command?.state ?? null;
        if (revertedState !== 'LEASED') break;
        await sleep(200);
      }
      // The window the Worker actually used, not the one this process assumed.
      // A harness started from another shell does not inherit dev.sh's exports,
      // and a silent mismatch here makes every timing assertion below test the
      // wrong duration while still passing.
      const observedLeaseMs = Date.now() - leaseStartedAt;
      rep.checkFn('the lease window matches LEASE_MS (harness and Worker agree)', () =>
        (observedLeaseMs >= LEASE_MS * 0.75 && observedLeaseMs <= LEASE_MS * 1.6 + 2_000)
        || `${observedLeaseMs} ms observed, ${LEASE_MS} ms expected`);
      // The lease expires with no socket left to hand it to, so it reverts and
      // falls back to the wake push. (The re-delivery path is its own section.)
      rep.check('lease expiry returned it to the queue', revertedState === 'PENDING', true);

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
        rep.check('lease expiry triggered an FCM wake push', (fcmAfter?.sendCalls ?? 0) > sendsBefore, true);
        rep.check('FCM assertion was structurally valid (no validation errors)',
          (fcmAfter?.validationErrors ?? []).length, 0);
      }
      ws.close();

      // A command that IS acked must NOT be reverted: lease expiry only returns
      // still-LEASED commands to PENDING.
      const ackSigned = signWith(identity, 'GET', '/v1/device/ws', '');
      const ackWs = new RawWs({ pathname: '/v1/device/ws', headers: ackSigned.headers });
      await ackWs.connect();
      ackWs.sendText(JSON.stringify({ op: 'hello', fcm_token: 'stub-fcm-token-0001' }));
      await sleep(200);
      const ackSend = await admin('POST', '/v1/sms/send', {
        device_id: identity.deviceId, to: '+8801712345678', body: 'acked before lease expiry',
      });
      const ackId = ackSend.data?.command_id;
      const ackFrame = await ackWs.waitFor((m) => m.some((x) => x.text.includes(ackId)), 10_000);
      let ackToken = null;
      for (const x of ackFrame) {
        try {
          const j = JSON.parse(x.text);
          if (j.op === 'commands') {
            const c = j.commands.find((c) => c.command_id === ackId);
            if (c) ackToken = c.claim_token;
          }
        } catch { /* not JSON */ }
      }
      ackWs.sendText(JSON.stringify({ op: 'ack', acks: [{ command_id: ackId, claim_token: ackToken }] }));
      await sleep(250);
      const ackedState = await admin('GET', `/v1/sms/commands/${ackId}?device_id=${identity.deviceId}`);
      rep.check('acked command moved to DISPATCHED', ackedState.data?.command?.state, 'DISPATCHED');
      await sleep(LEASE_MS + 500);
      const stillAcked = await admin('GET', `/v1/sms/commands/${ackId}?device_id=${identity.deviceId}`);
      rep.check('an acked command is NOT reverted by lease expiry',
        stillAcked.data?.command?.state, 'DISPATCHED');
      ackWs.close();
    }
    run(rep);
  }

  /* ── a lost push is re-delivered at lease expiry, not at the drain ─────── */
  console.log('-- lease recovery (re-delivery after expiry) --');
  {
    const rep = new Report('lease recovery');

    // Socket 1 carries the frame, then goes away before the ack. That is the
    // half-open case that made a command wait 90 s in production: the write
    // succeeds, the phone never reads it, and nothing else claims the command.
    const first = signWith(identity, 'GET', '/v1/device/ws', '');
    const ws1 = new RawWs({ pathname: '/v1/device/ws', headers: first.headers });
    await ws1.connect();
    ws1.sendText(JSON.stringify({ op: 'hello', fcm_token: 'stub-fcm-token-0001' }));
    await sleep(200);

    const send = await admin('POST', '/v1/sms/send', {
      device_id: identity.deviceId, to: '+8801712345678', body: 'lost push recovery',
    });
    const cmdId = send.data?.command_id;

    const tokenFrom = (msgs) => {
      for (const x of msgs) {
        try {
          const j = JSON.parse(x.text);
          if (j.op !== 'commands') continue;
          const c = j.commands.find((c) => c.command_id === cmdId);
          if (c) return c.claim_token;
        } catch { /* not JSON */ }
      }
      return null;
    };

    await ws1.waitFor((m) => tokenFrom(m) !== null, 10_000);
    const token1 = tokenFrom(ws1.messages);
    rep.check('the command is pushed and leased', typeof token1, 'string');

    // The device never acks. The edge closes the socket it wrote to, and the
    // lease is deliberately NOT released: the send may still be in flight.
    const closed = await ws1.waitForClose(ACK_TIMEOUT_MS + 4_000);
    rep.check('the silent socket is closed with 1011', closed, 1011);
    const stillLeased = await admin('GET', `/v1/sms/commands/${cmdId}?device_id=${identity.deviceId}`);
    rep.check('the lease survives the close', stillLeased.data?.command?.state, 'LEASED');

    // The device reconnects while the lease is still held. `hello` must not steal
    // it: re-delivering a live lease is the duplicate this machine prevents.
    const second = signWith(identity, 'GET', '/v1/device/ws', '');
    const ws2 = new RawWs({ pathname: '/v1/device/ws', headers: second.headers });
    await ws2.connect();
    ws2.sendText(JSON.stringify({ op: 'hello', fcm_token: 'stub-fcm-token-0001' }));
    await sleep(600);
    rep.check('a reconnect does NOT steal a live lease', tokenFrom(ws2.messages), null);

    // At expiry the edge hands it over again, with a fresh token, so the first
    // holder's late ack cannot apply to the new lease.
    const deadline = Date.now() + LEASE_MS + 5_000;
    let token2 = null;
    while (Date.now() < deadline && token2 === null) {
      await sleep(200);
      token2 = tokenFrom(ws2.messages.splice(0));
    }
    rep.check('the expired lease is re-delivered to the live socket', typeof token2, 'string');
    rep.check('the re-delivery carries a fresh claim_token', token2 !== token1, true);

    ws2.sendText(JSON.stringify({ op: 'ack', acks: [{ command_id: cmdId, claim_token: token2 }] }));
    await sleep(300);
    const recovered = await admin('GET', `/v1/sms/commands/${cmdId}?device_id=${identity.deviceId}`);
    rep.check('the re-delivered command acks to DISPATCHED',
      recovered.data?.command?.state, 'DISPATCHED');

    // And the token from the lease that expired must stay dead.
    ws2.sendText(JSON.stringify({ op: 'ack', acks: [{ command_id: cmdId, claim_token: token1 }] }));
    await sleep(300);
    const afterStale = await admin('GET', `/v1/sms/commands/${cmdId}?device_id=${identity.deviceId}`);
    rep.check('the expired lease\'s token stays rejected',
      afterStale.data?.command?.state, 'DISPATCHED');

    ws2.close();
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

    // Idempotency (CLI slice 2b). Lives here, at the end, because the commands
    // these checks enqueue are deliberately left PENDING and would otherwise
    // show up in the poll and lease-expiry assertions above.
    const key = `suite-idem-${Date.now()}`;
    const first = await admin('POST', '/v1/sms/send', {
      device_id: identity.deviceId, to: '+8801712345678', body: 'idempotent', idempotency_key: key,
    });
    rep.check('send with an idempotency key -> 200', first.status, 200);
    rep.check('...reports replayed false', first.data?.replayed, false);

    const replay = await admin('POST', '/v1/sms/send', {
      device_id: identity.deviceId, to: '+8801712345678', body: 'idempotent', idempotency_key: key,
    });
    rep.check('replay with the same key -> 200', replay.status, 200);
    rep.check('...returns the original command id', replay.data?.command_id, first.data?.command_id);
    rep.check('...reports replayed true', replay.data?.replayed, true);

    const other = await admin('POST', '/v1/sms/send', {
      device_id: identity.deviceId, to: '+8801712345678', body: 'idempotent',
      idempotency_key: `${key}-b`,
    });
    rep.check('a different key creates a new command',
      other.data?.command_id !== first.data?.command_id, true);

    const tooLong = await admin('POST', '/v1/sms/send', {
      device_id: identity.deviceId, to: '+8801712345678', body: 'x', idempotency_key: 'k'.repeat(129),
    });
    rep.check('over-long key -> 400', tooLong.status, 400);

    const batchKey = await admin('POST', '/v1/sms/send/batch', {
      device_id: identity.deviceId,
      commands: [{ to: '+8801712345678', body: 'x', idempotency_key: 'nope' }],
    });
    rep.check('batch with a key -> 400', batchKey.status, 400);
    rep.check('...names the reason', batchKey.data?.error, 'idempotency_key_not_supported_in_batch');

    run(rep);
  }

  /* ── flow IR v2 (v6.1 P1) ─────────────────────────────────────────────── */
  console.log('-- flow IR v2 --');
  {
    const rep = new Report('flow IR');

    // The same vector file `simulator/flow` is tested against. If the Worker's
    // copy and the Rust one disagree, one of them fails here.
    const vectors = JSON.parse(
      fs.readFileSync(path.join(HERE, 'test-support', 'flow-ir-vectors.json'), 'utf8')
    );
    const created = [];

    for (const vector of vectors) {
      const id = `ir_${crypto.randomBytes(4).toString('hex')}`;
      const res = await admin('PUT', `/v1/admin/workflows/${id}`, {
        name: 'IR vector',
        graph: vector.graph,
      });

      if (vector.ok) {
        rep.check(`${vector.name} -> accepted`, res.status, 200);
        if (res.status === 200) {
          created.push(id);
          const graph = res.data?.workflow?.graph ?? {};
          const positions = graph.ui_layout?.positions ?? {};
          rep.check(`${vector.name}: ui_layout names the algorithm`,
            graph.ui_layout?.algorithm, 'rank-v1');
          rep.check(`${vector.name}: every node has a position`,
            (graph.nodes ?? []).every((node) => positions[node.id] !== undefined), true);
          // The transitional mirror: v6.0 readers still find node.position.
          rep.check(`${vector.name}: node.position mirrors the layout`,
            (graph.nodes ?? []).every((node) =>
              node.position?.x === positions[node.id]?.x &&
              node.position?.y === positions[node.id]?.y), true);
          // A document that arrived with a position for every node keeps them.
          if (vector.layout_preserved === true) {
            rep.check(`${vector.name}: a hand-arranged canvas is not reflowed`,
              (vector.graph.nodes ?? []).every((node) =>
                positions[node.id]?.x === node.position.x &&
                positions[node.id]?.y === node.position.y), true);
          }
        }
      } else {
        rep.check(`${vector.name} -> refused`, res.status, 400);
        rep.check(`${vector.name}: names workflow_invalid`, res.data?.error, 'workflow_invalid');
        rep.checkFn(`${vector.name}: the issue says why`, () =>
          JSON.stringify(res.data?.details ?? []).includes(vector.contains));
      }
    }

    // The optimistic guard is one conditional UPDATE, so a stale version loses.
    const conflictId = `ir_${crypto.randomBytes(4).toString('hex')}`;
    const first = await admin('PUT', `/v1/admin/workflows/${conflictId}`, {
      name: 'conflict probe',
      graph: vectors.find((vector) => vector.ok).graph,
    });
    rep.check('create a workflow -> 200', first.status, 200);
    if (first.status === 200) created.push(conflictId);
    const version = first.data?.workflow?.version;
    rep.check(' ...starts at version 1', version, 1);

    const fresh = await admin('PUT', `/v1/admin/workflows/${conflictId}`, {
      name: 'conflict probe',
      graph: vectors.find((vector) => vector.ok).graph,
      expected_previous_version: version,
    });
    rep.check('a write with the current version -> 200', fresh.status, 200);
    rep.check(' ...bumps the version', fresh.data?.workflow?.version, 2);

    const stale = await admin('PUT', `/v1/admin/workflows/${conflictId}`, {
      name: 'conflict probe',
      graph: vectors.find((vector) => vector.ok).graph,
      expected_previous_version: version,
    });
    rep.check('a write with the stale version -> 409', stale.status, 409);
    rep.check(' ...names version_conflict', stale.data?.error, 'version_conflict');
    rep.check(' ...and the current version to retry against', stale.data?.current_version, 2);

    for (const id of created) await admin('DELETE', `/v1/admin/workflows/${id}`);
    const remaining = (await admin('GET', '/v1/admin/workflows')).data?.workflows ?? [];
    rep.check('the suite deleted every workflow it created',
      remaining.filter((row) => created.includes(row.id)).length, 0);

    run(rep);
  }

  /* ── by-example synthesis (v6.1 P2) ──────────────────────────────────── */
  console.log('-- by-example synthesis --');
  {
    const rep = new Report('synthesis');

    // Driven through the shipped command, in a throwaway HOME, so this proves the
    // binary an operator runs rather than a function that happens to exist.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dakflare-synth-'));
    const runCli = (...args) =>
      spawnSync(process.execPath, [path.join(HERE, 'cli', 'bin', 'dakflare.js'), ...args], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, NO_COLOR: '1' },
      });
    const docOf = (run) => JSON.parse(run.stdout.trim().split('\n').pop());

    const bKash = path.join(home, 'bkash.json');
    fs.writeFileSync(
      bKash,
      JSON.stringify({
        group: 'trx_id',
        samples: [
          {
            body: 'You have received Tk 500.00 from 01712345678. TrxID: DHK1234ABC at 2026-11-01 10:22.',
            value: 'DHK1234ABC',
          },
          {
            body: 'Payment of Tk 250.00 received. Txn ID= DHK5678XYZ on 01-11-2026.',
            value: 'DHK5678XYZ',
          },
        ],
        negatives: ['Your daily limit is Tk 25000. Dial *247# for help.'],
      })
    );

    const synthesized = runCli('extract', 'synthesize', '--samples', bKash, '--agent');
    rep.check('two bKash examples synthesize a pattern -> exit 0', synthesized.status, 0);
    const pattern = docOf(synthesized).data ?? {};
    rep.checkFn('the pattern anchors on both labels as one alternation', () =>
      String(pattern.pattern).startsWith('(?:TrxID|Txn\\s+ID)[\\s:=]*'));
    rep.check('...both anchors are named', (pattern.anchors ?? []).length, 2);
    rep.check('...precision on the samples is 1.0', pattern.precision, 1);
    rep.check('...recall on the samples is 1.0', pattern.recall, 1);
    rep.check('...the negative corpus was checked', pattern.negatives, 1);
    rep.checkFn('...and the value is a shape, not the example itself', () =>
      String(pattern.value_shape).includes('[A-Za-z0-9]') &&
      !String(pattern.value_shape).includes('DHK1234ABC'));

    // A value that appears twice cannot be anchored, and guessing which one is
    // the extraction is how half the traffic gets the wrong number.
    const ambiguous = path.join(home, 'ambiguous.json');
    fs.writeFileSync(
      ambiguous,
      JSON.stringify({
        samples: [
          { body: 'TrxID: DHK1234ABC. The code DHK1234ABC is final.', value: 'DHK1234ABC' },
        ],
      })
    );
    const refused = runCli('extract', 'synthesize', '--samples', ambiguous, '--agent');
    rep.check('a value that appears twice -> exit 2', refused.status, 2);
    rep.checkFn('...named synthesis_refused with the reason', () => {
      const doc = docOf(refused);
      return doc.status === 'error' &&
        doc.error?.code === 'synthesis_refused' &&
        doc.error?.details?.reason === 'value_ambiguous';
    });

    fs.rmSync(home, { recursive: true, force: true });
    run(rep);
  }

  /* ── extraction drift and healing (v6.1 P5) ───────────────────────────── */
  console.log('-- extraction drift and healing --');
  {
    const rep = new Report('drift');
    const tag = crypto.randomBytes(3).toString('hex');
    const flowId = `wf_drift_${tag}`;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dakflare-heal-'));
    const runCli = (...args) =>
      spawnSync(process.execPath, [path.join(HERE, 'cli', 'bin', 'dakflare.js'), ...args], {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, NO_COLOR: '1', WORKER_URL },
      });
    const docOf = (run) => JSON.parse((run.stdout ?? '').trim().split('\n').pop());
    fs.mkdirSync(path.join(home, '.config', 'dakflare'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.config', 'dakflare', 'config.json'),
      JSON.stringify({ url: WORKER_URL, token: ADMIN_TOKEN })
    );

    const postInbound = async (localId, body) =>
      device(identity, 'POST', '/v1/sms/incoming/batch', {
        messages: [{ local_id: localId, sender: '+8801700000600', body, received_at: new Date().toISOString() }],
        acks: [],
      });

    const created = await admin('PUT', `/v1/admin/workflows/${flowId}`, {
      name: 'Drift probe',
      enabled: true,
      graph: {
        nodes: [
          { id: 't1', type: 'trigger', data: { kind: 'incoming' } },
          { id: 'x1', type: 'extract', data: { source: 'body', pattern: 'order (?<order>[A-Z0-9]{6})' } },
          { id: 's1', type: 'send_sms', data: { to: '{{sender}}', body: 'Order {{order}} confirmed.' } },
          { id: 'e1', type: 'stop', data: {} },
        ],
        edges: [
          { id: 'a', source: 't1', target: 'x1' },
          { id: 'b', source: 'x1', target: 's1' },
          { id: 'c', source: 's1', target: 'e1' },
        ],
      },
    });
    rep.check('a flow with one extract node -> 200', created.status, 200);

    // Drift is one open alert per device (the alerts table's partial unique index
    // is on (device_id, kind)), so a drifted flow from an earlier run would hide
    // this one. Clear the slate first; the alert names its flow in `detail`.
    for (const row of (await admin('GET', '/v1/admin/alerts')).data?.alerts ?? []) {
      if (row.kind === 'extraction_drift') await admin('POST', `/v1/admin/alerts/${row.id}/ack`);
    }

    /* ---- the history the old pattern reads --------------------------- */
    await postInbound(`heal_old_a_${tag}`, 'order ABC123 is on its way');
    await postInbound(`heal_old_b_${tag}`, 'order XYZ789 has shipped');

    /* ---- the template changes: two misses in an hour ------------------ */
    await postInbound(`heal_new_a_${tag}`, 'Your order #AB12 changed format, ref TXN99.');
    await postInbound(`heal_new_b_${tag}`, 'Another one with ref TXN77.');

    const alerts = (await admin('GET', '/v1/admin/alerts')).data?.alerts ?? [];
    const drift = alerts.find((row) => row.kind === 'extraction_drift');
    rep.check('two misses in an hour raise extraction_drift', drift?.kind, 'extraction_drift');
    const detail = (() => {
      try {
        return JSON.parse(drift?.detail ?? '{}');
      } catch {
        return {};
      }
    })();
    // One open alert per device, so the detail is a LIST of every flow currently
    // drifting rather than the first one to trip it.
    const drifted = (detail.drifts ?? []).find((row) => row.flow_id === flowId);
    rep.check('...naming the flow that drifted', drifted?.flow_id, flowId);
    rep.check('...and the field that stopped matching', drifted?.field, 'order');

    /* ---- a heal that would change history is refused ------------------ */
    const narrow = path.join(home, 'narrow.json');
    fs.writeFileSync(
      narrow,
      JSON.stringify({
        group: 'order',
        samples: [
          { body: 'Your order #AB12 changed format, ref TXN99.', value: 'TXN99' },
          { body: 'Another one with ref TXN77.', value: 'TXN77' },
        ],
      })
    );
    const refused = runCli('flows', 'heal', flowId, '--samples', narrow, '--agent');
    rep.check('a heal that breaks history exits 6', refused.status, 6);
    rep.checkFn('...naming heal_refused and how many it would break', () => {
      const doc = docOf(refused);
      return doc.status === 'error' && doc.error?.code === 'heal_refused' && doc.error?.details?.gate?.broken >= 1;
    });
    const untouched = await admin('GET', `/v1/admin/workflows/${flowId}`);
    rep.check('...and nothing was written', untouched.data?.workflow?.version, 1);

    /* ---- a heal that covers both templates is accepted ---------------- */
    const union = path.join(home, 'union.json');
    fs.writeFileSync(
      union,
      JSON.stringify({
        group: 'order',
        samples: [
          { body: 'order ABC123 is on its way', value: 'ABC123' },
          { body: 'order XYZ789 has shipped', value: 'XYZ789' },
          { body: 'Another one with ref TXN77.', value: 'TXN77' },
        ],
      })
    );
    const healed = runCli('flows', 'heal', flowId, '--samples', union, '--agent');
    rep.check('a heal that keeps every historical extraction exits 0', healed.status, 0);
    const healedDoc = docOf(healed).data ?? {};
    rep.check('...bumps the version', healedDoc.to_version, 2);
    rep.check('...and reports a gate with nothing broken', healedDoc.gate?.broken, 0);
    rep.checkFn('...having re-checked the real history', () => (healedDoc.gate?.matched_before ?? 0) >= 2);

    const after = await admin('GET', `/v1/admin/workflows/${flowId}`);
    rep.checkFn('...and the stored pattern is the new one', () =>
      String(after.data?.workflow?.graph?.nodes?.find((node) => node.id === 'x1')?.data?.pattern ?? '')
        .includes('order'));

    /* ---- teardown ----------------------------------------------------- */
    await admin('DELETE', `/v1/admin/workflows/${flowId}`);
    if (drift?.id !== undefined) await admin('POST', `/v1/admin/alerts/${drift.id}/ack`);
    fs.rmSync(home, { recursive: true, force: true });
    run(rep);
  }

  /* ── MCP (v6.1 P4) ─────────────────────────────────────────────────────── */
  console.log('-- MCP --');
  {
    const rep = new Report('mcp');
    const VERSION = '2026-07-28';
    const CAPS = { elicitation: { form: {} } };

    const mcpCall = async (token, method, params, headers = {}) => {
      const res = await fetch(`${WORKER_URL}/v1/mcp`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'MCP-Protocol-Version': VERSION,
          'Mcp-Method': method,
          ...headers,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: Math.floor(Math.random() * 1e6),
          method,
          params: {
            ...(params ?? {}),
            _meta: {
              'io.modelcontextprotocol/protocolVersion': VERSION,
              'io.modelcontextprotocol/clientInfo': { name: 'harness', version: '0' },
              'io.modelcontextprotocol/clientCapabilities': CAPS,
            },
          },
        }),
      });
      return { status: res.status, data: await res.json().catch(() => null) };
    };

    const mint = async (name, scopes) =>
      (await admin('POST', '/v1/admin/agent-tokens', { name, scopes, max_per_hour: 10 })).data;

    const full = await mint('mcp harness', [
      'messages:read', 'devices:read', 'flows:read', 'sms:send',
    ]);

    /* ---- discover --------------------------------------------------- */
    const discover = await mcpCall(full.token, 'server/discover');
    rep.check('server/discover -> 200', discover.status, 200);
    rep.check('...advertises the current revision',
      (discover.data?.result?.supportedVersions ?? []).includes(VERSION), true);
    rep.check('...names this server',
      discover.data?.result?._meta?.['io.modelcontextprotocol/serverInfo']?.name, 'dakflare');

    const noVersion = await fetch(`${WORKER_URL}/v1/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${full.token}`,
        'Content-Type': 'application/json',
        'Mcp-Method': 'tools/list',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} }),
    });
    const noVersionBody = await noVersion.json().catch(() => null);
    rep.check('a request with no version claim -> 400', noVersion.status, 400);
    rep.check('...is -32022', noVersionBody?.error?.code, -32022);
    rep.check('...and names the supported version',
      (noVersionBody?.error?.data?.supported ?? []).includes(VERSION), true);

    /* ---- tools/list -------------------------------------------------- */
    const list = await mcpCall(full.token, 'tools/list');
    const tools = list.data?.result?.tools ?? [];
    rep.check('tools/list -> 200', list.status, 200);
    rep.check('seven tools', tools.length, 7);
    rep.check('...every one carries an outputSchema',
      tools.every((tool) => tool.outputSchema !== undefined), true);
    rep.check('...the result carries ttlMs and cacheScope',
      typeof list.data?.result?.ttlMs === 'number' &&
      typeof list.data?.result?.cacheScope === 'string', true);
    rep.checkFn('...x-mcp-header sits on a string property, never a number', () => {
      for (const tool of tools) {
        for (const property of Object.values(tool.inputSchema?.properties ?? {})) {
          if (property['x-mcp-header'] === undefined) continue;
          if (!['string', 'integer', 'boolean'].includes(property.type)) return `${tool.name} annotates ${property.type}`;
        }
      }
      return true;
    });

    const deviceHeader = tools
      .find((tool) => tool.name === 'read_messages')
      ?.inputSchema?.properties?.device_id?.['x-mcp-header'];
    rep.check('read_messages mirrors device_id into a header', deviceHeader, 'Device-Id');

    /* ---- header agreement -------------------------------------------- */
    const mismatch = await mcpCall(
      full.token,
      'tools/call',
      { name: 'read_messages', arguments: { device_id: 'dev_here', limit: 1 } },
      { 'Mcp-Name': 'read_messages', 'Mcp-Param-Device-Id': 'dev_somewhere_else' }
    );
    rep.check('a Mcp-Param-Device-Id that disagrees with the body -> 400', mismatch.status, 400);
    rep.check('...is -32020', mismatch.data?.error?.code, -32020);

    const nameMismatch = await mcpCall(
      full.token,
      'tools/call',
      { name: 'trace', arguments: { id: 'x' } },
      { 'Mcp-Name': 'send_sms' }
    );
    rep.check('an Mcp-Name that disagrees with the body -> -32020', nameMismatch.data?.error?.code, -32020);

    /* ---- structured results ------------------------------------------ */
    const traceCall = await mcpCall(
      full.token, 'tools/call',
      { name: 'trace', arguments: { id: 'no-such-id-anywhere' } },
      { 'Mcp-Name': 'trace' }
    );
    rep.check('tools/call -> 200', traceCall.status, 200);
    rep.check('...returns structured content', typeof traceCall.data?.result?.structuredContent?.verdict, 'string');
    rep.check('...and a text block for a model to read',
      Array.isArray(traceCall.data?.result?.content) && traceCall.data.result.content[0].type, 'text');

    /* ---- the scope is the tool list ---------------------------------- */
    const narrow = await mint('mcp narrow', ['messages:read']);
    const narrowList = await mcpCall(narrow.token, 'tools/list');
    const narrowTools = (narrowList.data?.result?.tools ?? []).map((tool) => tool.name);
    rep.check('a read-only token sees fewer tools', narrowTools.length < 7, true);
    rep.check('...and does not see send_sms', narrowTools.includes('send_sms'), false);
    const denied = await mcpCall(
      narrow.token, 'tools/call',
      { name: 'send_sms', arguments: { device_id: identity.deviceId, to: '+8801700000300', body: 'nope' } },
      { 'Mcp-Name': 'send_sms' }
    );
    // The SDK answers an unregistered tool with `-32602` (invalid params) rather
    // than `-32601`; both are "there is no such tool", and what matters is that
    // the call never reaches a handler.
    rep.check('calling it anyway -> an error, not a send',
      [-32601, -32602].includes(denied.data?.error?.code), true);
    const deniedCommands = await admin('GET', `/v1/messages?device_id=${identity.deviceId}&limit=20`);
    rep.check('...and nothing was queued',
      (deniedCommands.data?.messages ?? []).some((row) => row.body === 'nope'), false);

    /* ---- MRTR: the approval round ------------------------------------ */
    const recipient = '+8801700000400';
    const asked = await mcpCall(
      full.token, 'tools/call',
      { name: 'send_sms', arguments: { device_id: identity.deviceId, to: recipient, body: 'mcp round' } },
      { 'Mcp-Name': 'send_sms' }
    );
    rep.check('a send with no grant -> input_required', asked.data?.result?.resultType, 'input_required');
    const inputRequest = asked.data?.result?.inputRequests?.approval;
    rep.check('...carrying an elicitation', inputRequest?.method, 'elicitation/create');
    rep.checkFn('...whose message names the approval to obtain', () =>
      String(inputRequest?.params?.message ?? '').includes('auth approve'));
    rep.check('...and opaque requestState',
      typeof asked.data?.result?.requestState, 'string');

    const approvalId = JSON.parse(asked.data.result.requestState).approval_request_id;
    const approved = await admin('POST', `/v1/admin/approvals/${approvalId}/approve`, { duration_s: 300 });
    rep.check('a human approves the request', approved.status, 200);

    const retried = await mcpCall(
      full.token, 'tools/call',
      {
        name: 'send_sms',
        arguments: { device_id: identity.deviceId, to: recipient, body: 'mcp round' },
        inputResponses: { approval: { action: 'accept', content: { decision: 'retry' } } },
      },
      { 'Mcp-Name': 'send_sms' }
    );
    rep.check('the retry with inputResponses sends', retried.data?.result?.structuredContent?.sent, true);
    rep.check('...and names the command',
      typeof retried.data?.result?.structuredContent?.command_id, 'string');

    /* ---- the CLI speaks the same contract ---------------------------- */
    const cliHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dakflare-mcp-'));
    const tokenFile = path.join(cliHome, 'agent-token');
    fs.writeFileSync(tokenFile, full.token);
    // The bridge reads the Worker URL from the same config `init` writes; only the
    // credential comes from the file, because an MCP client gets an agent's reach.
    fs.mkdirSync(path.join(cliHome, '.config', 'dakflare'), { recursive: true });
    fs.writeFileSync(
      path.join(cliHome, '.config', 'dakflare', 'config.json'),
      JSON.stringify({ url: WORKER_URL, token: full.token })
    );
    // A real client sends the per-request envelope; the bridge forwards whatever
    // it is given, so this is the client's job, not the bridge's.
    const meta = {
      'io.modelcontextprotocol/protocolVersion': VERSION,
      'io.modelcontextprotocol/clientInfo': { name: 'harness', version: '0' },
      'io.modelcontextprotocol/clientCapabilities': CAPS,
    };
    const stdin = [
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: meta } }),
      JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'trace', arguments: { id: 'no-such-id-anywhere' }, _meta: meta },
      }),
    ].join('\n') + '\n';
    const bridged = spawnSync(
      process.execPath,
      [path.join(HERE, 'cli', 'bin', 'dakflare.js'), 'mcp', 'serve', '--token-file', tokenFile],
      { input: stdin, encoding: 'utf8', env: { ...process.env, HOME: cliHome, NO_COLOR: '1' } }
    );
    const lines = (bridged.stdout ?? '').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    rep.check('the CLI bridge answers tools/list', (lines[0]?.result?.tools ?? []).length, 7);
    rep.checkFn('...with the same tool names as the endpoint', () => {
      const bridgeNames = (lines[0].result.tools ?? []).map((tool) => tool.name).sort();
      const workerNames = tools.map((tool) => tool.name).sort();
      return JSON.stringify(bridgeNames) === JSON.stringify(workerNames);
    });
    rep.checkFn('...and the same trace answer', () => {
      const viaBridge = lines[1]?.result?.structuredContent;
      const viaWorker = traceCall.data?.result?.structuredContent;
      return viaBridge?.verdict === viaWorker?.verdict && viaBridge?.kind === viaWorker?.kind;
    });
    fs.rmSync(cliHome, { recursive: true, force: true });

    /* ---- teardown ----------------------------------------------------- */
    for (const token of [full, narrow]) {
      await admin('DELETE', `/v1/admin/agent-tokens/${token.id}`);
    }
    run(rep);
  }

  /* ── provenance: seven verdicts (v6.1 P3) ─────────────────────────────── */
  console.log('-- provenance: seven verdicts --');
  {
    const rep = new Report('provenance');

    const traceOf = async (id) =>
      (await admin('GET', `/v1/admin/trace/${encodeURIComponent(id)}?device_id=${identity.deviceId}`))
        .data;
    const postInbound = async (localId, sender, body) =>
      device(identity, 'POST', '/v1/sms/incoming/batch', {
        messages: [{ local_id: localId, sender, body, received_at: new Date().toISOString() }],
        acks: [],
      });
    const inboundRow = async (localId) => {
      const listed = await admin('GET', `/v1/messages?device_id=${identity.deviceId}&limit=100`);
      return (listed.data?.messages ?? []).find((row) => row.local_id === localId);
    };
    /**
     * Move a reply command to a terminal state the way the phone would.
     *
     * It cannot assume a fresh poll will hand it over: if a socket from an earlier
     * section is still listed, the push already leased the command and a poll
     * returns nothing. So it reads the object's own row for the claim token and
     * acks with whatever lease exists, then reports the status.
     */
    const driveReply = async (commandId, status) => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const trace = await admin(
          'GET', `/v1/admin/trace/${commandId}?device_id=${identity.deviceId}`
        );
        const command = trace.data?.durable_object?.command;
        if (command === null || command === undefined) break;
        if (['DISPATCHED', 'SENT', 'DELIVERED', 'FAILED', 'EXPIRED'].includes(command.state)) break;

        if (command.state === 'LEASED' && typeof command.claim_token === 'string') {
          await device(identity, 'POST', '/v1/sms/outgoing/poll', {
            acks: [{ command_id: commandId, claim_token: command.claim_token }],
          });
        } else {
          const poll = await device(identity, 'POST', '/v1/sms/outgoing/poll', { acks: [] });
          const polled = (poll.data?.commands ?? []).find((row) => row.command_id === commandId);
          if (polled !== undefined) {
            await device(identity, 'POST', '/v1/sms/outgoing/poll', {
              acks: [{ command_id: commandId, claim_token: polled.claim_token }],
            });
          }
        }
        await sleep(120);
      }
      await device(identity, 'POST', '/v1/sms/status/batch', {
        updates: [{ command_id: commandId, status }],
      });
    };

    // Local ids are unique per device, so a fixed one would resolve to the PREVIOUS
    // run's row (and its reply command, already driven to SENT). Every id this
    // section writes carries a run suffix.
    const runTag = crypto.randomBytes(3).toString('hex');
    const lid = (name) => `prov_${name}_${runTag}`;

    const created = [];
    const makeRule = async (bodyKeyword, extra) => {
      const id = `prov_${crypto.randomBytes(3).toString('hex')}`;
      created.push(id);
      const res = await admin('POST', '/v1/rules', {
        id,
        name: `provenance ${bodyKeyword}`,
        matcher: { type: 'prefix', value: '+880' },
        body_matcher: { type: 'keyword', value: bodyKeyword },
        reply_template: 'ack',
        ...extra,
      });
      rep.check(`create a rule for ${bodyKeyword} -> 200`, res.status, 200);
      return id;
    };

    // The set of verdicts the trace actually returns. The exit criterion is that
    // this ends with all seven in it.
    const seen = new Set();

    /* ---- no_match ---------------------------------------------------- */
    await postInbound(lid('nomatch'), '+8801700000100', 'nothing here matches anything');
    const nothing = await inboundRow(lid('nomatch'));
    const tNothing = await traceOf(nothing.id);
    rep.check('no_match: a message nothing matched', tNothing.verdict, 'no_match');
    seen.add(tNothing.verdict);

    /* ---- queued, then replied ---------------------------------------- */
    await makeRule('prov-reply', { priority: 10 });
    await postInbound(lid('reply'), '+8801700000101', 'prov-reply hello');
    const replyRow = await inboundRow(lid('reply'));
    rep.check('a rule replied and the row records the command', typeof replyRow?.reply_command_id, 'string');
    const tQueued = await traceOf(replyRow.id);
    rep.check('queued: the reply has not reached the radio', tQueued.verdict, 'queued');
    seen.add(tQueued.verdict);

    await driveReply(replyRow.reply_command_id, 'SENT');
    const tReplied = await traceOf(replyRow.id);
    rep.check('replied: the radio accepted the reply', tReplied.verdict, 'replied');
    seen.add(tReplied.verdict);

    /* ---- failed ------------------------------------------------------ */
    await makeRule('prov-fail', { priority: 11 });
    await postInbound(lid('fail'), '+8801700000102', 'prov-fail now');
    const failRow = await inboundRow(lid('fail'));
    await driveReply(failRow.reply_command_id, 'FAILED');
    const tFailed = await traceOf(failRow.id);
    rep.check('failed: the reply command ended FAILED', tFailed.verdict, 'failed');
    seen.add(tFailed.verdict);

    /* ---- suppressed by cooldown -------------------------------------- */
    await makeRule('prov-cool', { cooldown_s: 300, priority: 20 });
    await postInbound(lid('cool_1'), '+8801700000103', 'prov-cool one');
    await postInbound(lid('cool_2'), '+8801700000104', 'prov-cool two');
    const coolRow = await inboundRow(lid('cool_2'));
    const tCool = await traceOf(coolRow.id);
    rep.check('suppressed_cooldown: the rule matched and was held back', tCool.verdict, 'suppressed_cooldown');
    rep.checkFn('...and the trace names the rule that held it', () => {
      const ruleId = tCool.message?.reply_verdict_detail?.rule_id;
      return typeof ruleId === 'string' && (tCool.why ?? []).some((line) => String(line).includes(ruleId));
    });
    seen.add(tCool.verdict);

    /* ---- suppressed by the hourly cap -------------------------------- */
    await makeRule('prov-cap', { max_per_hour: 1, cooldown_s: 0, priority: 30 });
    await postInbound(lid('cap_1'), '+8801700000105', 'prov-cap one');
    await postInbound(lid('cap_2'), '+8801700000106', 'prov-cap two');
    const capRow = await inboundRow(lid('cap_2'));
    const tCap = await traceOf(capRow.id);
    rep.check('suppressed_hourly_cap: the cap was already spent', tCap.verdict, 'suppressed_hourly_cap');
    seen.add(tCap.verdict);

    /* ---- paused for a human ------------------------------------------ */
    const agent = await admin('POST', '/v1/admin/agent-tokens', {
      name: 'provenance probe',
      scopes: ['sms:send'],
    });
    const ask = await fetch(WORKER_URL + '/v1/sms/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${agent.data.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        device_id: identity.deviceId,
        to: '+8801700000199',
        body: 'prov hitl',
      }),
    });
    const asked = await ask.json();
    rep.check('an agent send with no grant -> 202', ask.status, 202);
    const tHitl = await traceOf(asked.approval_request.id);
    rep.check('paused_hitl_approval: the request is waiting on a person', tHitl.verdict, 'paused_hitl_approval');
    seen.add(tHitl.verdict);

    // The handset can answer it too: it is the party who can see whether sending
    // is safe, and it may only answer a request that names it.
    const askedSend = {
      device_id: identity.deviceId,
      to: '+8801700000199',
      body: 'prov hitl',
    };
    const approveFromPhone = async (duration) =>
      device(identity, 'POST', `/v1/device/approvals/${asked.approval_request.id}/approve`, {
        duration_s: duration,
      });

    const deviceList = await device(identity, 'GET', '/v1/device/approvals');
    rep.check('the handset lists the request that names it', deviceList.status, 200);
    const listed = (deviceList.data?.approvals ?? []).find(
      (row) => row.id === asked.approval_request.id
    );
    rep.check('...with the same ladder the console offers', (listed?.ladder_s ?? []).length, 8);
    rep.check('...and the scope ceiling', listed?.max_s, 3600);

    const unknownApproval = await device(
      identity, 'POST', '/v1/device/approvals/not-a-real-request/approve', { duration_s: 60 }
    );
    rep.check('an unknown request from the handset -> 404', unknownApproval.status, 404);

    const phoneApproved = await approveFromPhone(900);
    rep.check('the handset approves for 15 minutes', phoneApproved.status, 200);
    rep.check('...granting what it asked for', phoneApproved.data?.granted_s, 900);
    rep.check('...and reporting the ceiling', phoneApproved.data?.max_s, 3600);

    const phoneOverAsk = await approveFromPhone(2_592_000);
    rep.check('a second answer to a decided request -> 409', phoneOverAsk.status, 409);

    // Two approvers at once: exactly one may win. Before the claim moved into a
    // single conditional UPDATE both answered ok, and the first grant had already
    // been superseded, so one person was told they had granted something that no
    // longer existed.
    const raced = await admin('POST', '/v1/admin/agent-tokens', {
      name: 'race probe', scopes: ['sms:send'], max_per_hour: 1,
    });
    const raceAsk = await fetch(WORKER_URL + '/v1/sms/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${raced.data.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: identity.deviceId, to: '+8801700000198', body: 'race' }),
    });
    const raceId = (await raceAsk.json()).approval_request.id;
    const [first, second] = await Promise.all([
      admin('POST', `/v1/admin/approvals/${raceId}/approve`, { duration_s: 300 }),
      admin('POST', `/v1/admin/approvals/${raceId}/approve`, { duration_s: 900 }),
    ]);
    const winners = [first.status, second.status].filter((status) => status === 200);
    rep.check('two concurrent approvals: exactly one wins', winners.length, 1);
    rep.check('...and the other is a conflict',
      [first.status, second.status].filter((status) => status === 409).length, 1);
    const raceGrants = (await admin('GET', `/v1/admin/grants?token=${raced.data.id}&live=1`)).data?.grants ?? [];
    rep.check('...leaving exactly one live grant', raceGrants.length, 1);
    await admin('DELETE', `/v1/admin/agent-tokens/${raced.data.id}`);

    const sentAfterApproval = await fetch(WORKER_URL + '/v1/sms/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${agent.data.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(askedSend),
    });
    rep.check('the agent send now goes out -> 200', sentAfterApproval.status, 200);

    rep.check('all seven verdicts are reachable', seen.size, 7);

    /* ---- the other verbs --------------------------------------------- */
    const alerts = await admin('GET', '/v1/admin/alerts');
    rep.check('alerts list -> 200', alerts.status, 200);
    rep.check('...is an array', Array.isArray(alerts.data?.alerts), true);

    const dlq = await admin('GET', `/v1/admin/dlq?device_id=${identity.deviceId}&limit=5`);
    rep.check('dead letters -> 200', dlq.status, 200);
    rep.check('...is an array', Array.isArray(dlq.data?.dead_letters), true);

    const sockets = await admin('GET', `/v1/admin/ws?device_id=${identity.deviceId}`);
    rep.check('socket inspection -> 200', sockets.status, 200);
    rep.check('...is an array', Array.isArray(sockets.data?.sockets), true);

    const unknown = await traceOf('no-such-id-anywhere');
    rep.check('an id nobody owns -> kind unknown', unknown.kind, 'unknown');

    /* ---- teardown ------------------------------------------------------ */
    await admin('DELETE', `/v1/admin/agent-tokens/${agent.data.id}`);
    for (const id of created) await admin('DELETE', `/v1/admin/rules/${id}`);
    const remaining = (await admin('GET', '/v1/admin/rules')).data?.rules ?? [];
    rep.check('the suite deleted every rule it created here',
      remaining.filter((row) => created.includes(row.id)).length, 0);

    run(rep);
  }

  /* ── agent control plane (v6.1 P0) ─────────────────────────────────────── */
  console.log('-- agent control plane (v6.1 P0) --');
  {
    const rep = new Report('agent control plane');

    // Talk to the Worker as an agent token: no X-Dakflare-Client, no admin token.
    const agentApi = async (token, method, pathname, body) => {
      const res = await fetch(WORKER_URL + pathname, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, data: await res.json().catch(() => null) };
    };

    const mint = async (name, scopes, extra = {}) => {
      const res = await admin('POST', '/v1/admin/agent-tokens', { name, scopes, ...extra });
      return res;
    };

    const created = [];
    const approving = async (approvalId, durationS) =>
      admin('POST', `/v1/admin/approvals/${approvalId}/approve`, { duration_s: durationS });
    /** Ask once and return the approval the Worker opened. */
    const askAndApprove = async (token, to, durationS) => {
      const asked = await agentApi(token, 'POST', '/v1/sms/send', {
        device_id: identity.deviceId, to, body: 'p0',
      });
      const approvalId = asked.data?.approval_request?.id;
      if (approvalId === undefined) return { asked, approvalId: null, approved: null };
      return { asked, approvalId, approved: await approving(approvalId, durationS) };
    };

    /* identity and blast radius ------------------------------------------- */
    const agent = await mint('p0 agent', ['messages:read', 'sms:send'], { max_per_hour: 20 });
    created.push(agent.data?.id);
    rep.check('mint an agent token -> 200', agent.status, 200);
    rep.checkFn('the token is dkf_agt_<16 hex>_<secret>',
      () => /^dkf_agt_[0-9a-f]{16}_[A-Za-z0-9_-]{40,}$/.test(String(agent.data?.token)));
    rep.check('the mint does not echo the digest', 'token_hash' in (agent.data ?? {}), false);
    rep.check('the list never carries the token',
      ((await admin('GET', '/v1/admin/agent-tokens')).data?.agent_tokens ?? [])
        .some((row) => 'token' in row || 'token_hash' in row), false);

    // "The token appears nowhere in logs" is an exit criterion, so it is proven
    // rather than asserted: the secret half must not appear in any audit row.
    const tokenSecret = String(agent.data?.token).split('_').slice(3).join('_');
    const auditAfterMint = await admin('GET', '/v1/admin/audit?limit=50');
    rep.checkFn('the token secret never reaches the audit log',
      () => tokenSecret.length > 0 &&
        JSON.stringify(auditAfterMint.data ?? {}).includes(tokenSecret) === false);
    const mintRow = (auditAfterMint.data?.events ?? [])
      .find((row) => row.action === 'agent_token.minted' && row.subject === agent.data?.id);
    rep.check('the mint is audited', mintRow !== undefined, true);
    rep.check('...recording the prefix, never the value', mintRow?.detail?.token_prefix, 'dkf_agt_');

    const unknownScope = await mint('bad', ['devices:revoke']);
    rep.check('minting a never-grantable scope -> 400', unknownScope.status, 400);
    rep.check('...and it is named, not dropped',
      (unknownScope.data?.unknown_scopes ?? []).includes('devices:revoke'), true);

    rep.check('a scoped read is allowed -> 200',
      (await agentApi(agent.data.token, 'GET',
        `/v1/messages?device_id=${identity.deviceId}&limit=1`)).status, 200);
    rep.check('revoking a device is refused by construction -> 403',
      (await agentApi(agent.data.token, 'DELETE', '/v1/admin/devices/dev_does_not_exist')).status, 403);
    rep.check('minting another token is refused -> 403',
      (await agentApi(agent.data.token, 'POST', '/v1/admin/agent-tokens',
        { name: 'x', scopes: ['messages:read'] })).status, 403);
    rep.check('reading the grant table is refused -> 403',
      (await agentApi(agent.data.token, 'GET', '/v1/admin/grants')).status, 403);

    /* a production send needs a grant -------------------------------------- */
    const recipient = '+8801711111111';
    const firstAsk = await agentApi(agent.data.token, 'POST', '/v1/sms/send', {
      device_id: identity.deviceId, to: recipient, body: 'p0 agent',
    });
    rep.check('a production send with no grant -> 202', firstAsk.status, 202);
    rep.check('...says nothing was sent', firstAsk.data?.sent, false);
    const first = firstAsk.data?.approval_request;
    rep.check('...names the grant scope', first?.scope, 'sms:send:production');
    rep.check('...names the recipient it is limited to',
      (first?.target?.recipients ?? []).includes(recipient), true);
    rep.check('...offers the eight-rung ladder', (first?.ladder_s ?? []).length, 8);
    rep.check('...states the one-hour ceiling for production SMS', first?.max_s, 3600);

    const repeat = await agentApi(agent.data.token, 'POST', '/v1/sms/send', {
      device_id: identity.deviceId, to: recipient, body: 'p0 agent',
    });
    rep.check('repeating the same ask returns the same request',
      repeat.data?.approval_request?.id, first?.id);
    const elsewhere = await agentApi(agent.data.token, 'POST', '/v1/sms/send', {
      device_id: identity.deviceId, to: '+8801722222222', body: 'p0 agent',
    });
    rep.check('a different recipient opens a different request',
      elsewhere.data?.approval_request?.id !== first?.id, true);

    /* the ceiling bends the request, and says so --------------------------- */
    const monthLong = await approving(first.id, 2_592_000);
    rep.check('approving a 30-day request -> 200', monthLong.status, 200);
    rep.check('...is clamped to one hour', monthLong.data?.granted_s, 3600);
    rep.check('...reports it clamped', monthLong.data?.clamped, true);
    rep.check('...and names what was asked for', monthLong.data?.requested_s, 2_592_000);
    rep.check('...with that scope\'s ceiling', monthLong.data?.max_s, 3600);
    const grant = monthLong.data?.grant;

    const sent = await agentApi(agent.data.token, 'POST', '/v1/sms/send', {
      device_id: identity.deviceId, to: recipient, body: 'p0 granted',
    });
    rep.check('the same send under a live grant -> 200', sent.status, 200);
    rep.check('...and queues a command', typeof sent.data?.command_id, 'string');

    const outside = await agentApi(agent.data.token, 'POST', '/v1/sms/send', {
      device_id: identity.deviceId, to: '+8801733333333', body: 'p0 outside',
    });
    rep.check('a grant for one recipient does not cover another -> 202', outside.status, 202);

    const liveGrants = (await admin('GET', `/v1/admin/grants?token=${agent.data.id}&live=1`)).data?.grants ?? [];
    rep.check('the grant records the send it authorised',
      (liveGrants.find((row) => row.id === grant?.id)?.use_count ?? 0) >= 1, true);

    /* revoking a grant is immediate ---------------------------------------- */
    rep.check('revoking the grant -> 200',
      (await admin('DELETE', `/v1/admin/grants/${grant?.id}`)).status, 200);
    const afterGrantRevoke = await agentApi(agent.data.token, 'POST', '/v1/sms/send', {
      device_id: identity.deviceId, to: recipient, body: 'p0 after revoke',
    });
    rep.check('the next send after the grant was revoked -> 202', afterGrantRevoke.status, 202);

    /* a 15-minute grant is enough, and its own hour is finite -------------- */
    const shortLived = await approving(afterGrantRevoke.data.approval_request.id, 900);
    rep.check('a 15-minute grant is granted in full', shortLived.data?.granted_s, 900);
    rep.check('...and is not reported as clamped', shortLived.data?.clamped, false);

    const budgetToken = await mint('p0 budget', ['sms:send'], { max_per_hour: 2 });
    created.push(budgetToken.data?.id);
    const budgetApproval = await askAndApprove(budgetToken.data.token, '+8801744444444', 900);
    rep.check('a second agent gets its own request',
      budgetApproval.approvalId !== null, true);
    const firstOfTwo = await agentApi(budgetToken.data.token, 'POST', '/v1/sms/send', {
      device_id: identity.deviceId, to: '+8801744444444', body: 'budget 1',
    });
    const secondOfTwo = await agentApi(budgetToken.data.token, 'POST', '/v1/sms/send', {
      device_id: identity.deviceId, to: '+8801744444444', body: 'budget 2',
    });
    rep.check('two sends inside the budget -> 200',
      [firstOfTwo.status, secondOfTwo.status], [200, 200]);
    const thirdSend = await agentApi(budgetToken.data.token, 'POST', '/v1/sms/send', {
      device_id: identity.deviceId, to: '+8801744444444', body: 'budget 3',
    });
    rep.check('the third send with a budget of 2 -> 429', thirdSend.status, 429);
    rep.check('...names agent_quota_exceeded', thirdSend.data?.error, 'agent_quota_exceeded');
    rep.check('...and is retryable', thirdSend.data?.retryable, true);

    /* an agent cannot approve its own request, and revocation is immediate -- */
    const pendingForRefusal = await agentApi(budgetToken.data.token, 'POST', '/v1/sms/send', {
      device_id: identity.deviceId, to: '+8801755555555', body: 'needs approval',
    });
    rep.check('an agent cannot approve its own request -> 403',
      (await agentApi(budgetToken.data.token, 'POST',
        `/v1/admin/approvals/${pendingForRefusal.data?.approval_request?.id}/approve`,
        { duration_s: 900 })).status, 403);
    rep.check('revoking an agent token -> 200',
      (await admin('DELETE', `/v1/admin/agent-tokens/${agent.data.id}`)).status, 200);
    rep.check('the revoked token is refused on its next request -> 401',
      (await agentApi(agent.data.token, 'GET', '/v1/messages')).status, 401);

    /* the CLI, as an agent: exit codes are part of the contract ------------- */
    const cliHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dakflare-agent-cli-'));
    const cliConfigDir = path.join(cliHome, '.config', 'dakflare');
    fs.mkdirSync(cliConfigDir, { recursive: true });
    const cliToken = await mint('p0 cli', ['sms:send', 'messages:read', 'devices:read'], {
      max_per_hour: 1,
    });
    created.push(cliToken.data?.id);
    fs.writeFileSync(
      path.join(cliConfigDir, 'config.json'),
      JSON.stringify({ url: WORKER_URL, token: cliToken.data.token })
    );
    const runCli = (...args) =>
      spawnSync(process.execPath, [path.join(HERE, 'cli', 'bin', 'dakflare.js'), ...args], {
        encoding: 'utf8',
        env: { ...process.env, HOME: cliHome, NO_COLOR: '1' },
      });
    const cliSend = (...extra) =>
      runCli('send', '--device', identity.deviceId, '--to', '+8801766666666',
        '--body', 'cli agent', '--no-wait', '--agent', ...extra);

    // The CLI envelope nests the failure under `error`, so read it there.
    const cliDoc = (run) => JSON.parse(run.stdout.trim().split('\n').pop());

    const cliNoGrant = cliSend();
    rep.check('`dakflare send` as an agent with no grant exits 6', cliNoGrant.status, 6);
    rep.checkFn('...and the document says approval_required', () => {
      const doc = cliDoc(cliNoGrant);
      return doc.status === 'error' && doc.error?.code === 'approval_required';
    });
    rep.checkFn('...and that nothing was sent', () => cliDoc(cliNoGrant).error?.details?.sent === false);

    const cliApprovalId = cliDoc(cliNoGrant).error?.details?.approval_request?.id;
    await approving(cliApprovalId, 900);
    rep.check('the agent CLI sends once the grant exists -> exit 0', cliSend().status, 0);
    const cliOverBudget = cliSend();
    rep.check('the second send against a budget of 1 exits 6', cliOverBudget.status, 6);
    rep.checkFn('...with agent_quota_exceeded', () =>
      cliDoc(cliOverBudget).error?.code === 'agent_quota_exceeded');
    rep.checkFn('...and safe_to_retry, because nothing was sent', () =>
      cliDoc(cliOverBudget).error?.safe_to_retry === true);

    // `audit` needs audit:read, which this token does not hold. Chosen over
    // `revoke` because the CLI checks the device locally first and would answer
    // not-found (exit 3) without ever reaching the gate.
    const cliDenied = runCli('audit', '--agent');
    rep.check('an agent CLI on an out-of-scope read -> exit 4', cliDenied.status, 4);
    rep.checkFn('...with forbidden', () => cliDoc(cliDenied).error?.code === 'forbidden');

    /* teardown ------------------------------------------------------------- */
    for (const id of created) {
      if (typeof id === 'string') await admin('DELETE', `/v1/admin/agent-tokens/${id}`);
    }
    const remaining = (await admin('GET', '/v1/admin/agent-tokens')).data?.agent_tokens ?? [];
    rep.check('the suite revokes every token it minted',
      remaining.filter((row) => created.includes(row.id)).length, 0);
    fs.rmSync(cliHome, { recursive: true, force: true });

    run(rep);
  }

  console.log(allOk ? 'SUITE PASSED' : 'SUITE FAILED');
  process.exit(allOk ? 0 : 1);
}


/* ───────────────────────────── auth command ──────────────────────────────── */

/**
 * Auth cases (AUTH_PLAN §3–§5). Run against a Worker started with the mode you
 * want to prove:
 *
 *   WORKER_URL=http://127.0.0.1:8787 node dakflare_test_harness.mjs auth
 *
 * The invite/redeem/audit cases are mode-independent; the admin-gate cases
 * differ by mode (403 vs 401 for a member session) and are asserted accordingly.
 */
async function cmdAuth() {
  // One mode now: the legacy ADMIN_TOKEN-only path is gone.
  const mode = 'new';
  console.log(`== auth (mode=${mode}) ==\nworker: ${WORKER_URL}\n`);
  const rep = new Report('auth');

  const raw = async (method, pathname, { body, cookie } = {}) => {
    const res = await fetch(WORKER_URL + pathname, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    return { status: res.status, data: await res.json().catch(() => null), cookies };
  };

  const email = `auth-${Date.now()}-${crypto.randomBytes(3).toString('hex')}@example.test`;

  // 0. Pre-auth mode probe: public, exact keys, configuration only.
  const modeProbe = await raw('GET', '/v1/auth/mode');
  rep.check('GET /v1/auth/mode is unauthenticated -> 200', modeProbe.status, 200);
  rep.check(
    'mode payload has exactly the documented keys',
    Object.keys(modeProbe.data ?? {}).sort(),
    ['auth_configured', 'auth_mode', 'magic_link', 'magic_link_ttl_s', 'password_configured', 'password_mode']
  );
  rep.check("health reports the one auth mode", modeProbe.data?.auth_mode, mode);
  rep.check('auth_configured is a boolean', typeof modeProbe.data?.auth_configured, 'boolean');
  rep.check('password_configured is a boolean', typeof modeProbe.data?.password_configured, 'boolean');
  rep.check('magic_link is a boolean', typeof modeProbe.data?.magic_link, 'boolean');
  rep.check(
    'password_mode is one of the three documented values',
    ['off', 'client-derived', 'server-kdf'].includes(modeProbe.data?.password_mode),
    true
  );
  if (process.env.AUTH_PASSWORD_MODE) {
    rep.check(
      'mode reports the deployed AUTH_PASSWORD_MODE',
      modeProbe.data?.password_mode,
      process.env.AUTH_PASSWORD_MODE
    );
  }

  // 1. No public registration: Better Auth's email sign-up is disabled.
  const signup = await raw('POST', '/api/auth/sign-up/email', {
    body: { email, password: 'not-a-real-password', name: 'probe' },
  });
  rep.check('public email sign-up is refused', signup.status >= 400, true);

  // 2. Redeem without a live invite is refused.
  const unknown = await raw('POST', '/v1/auth/redeem', {
    body: { token: 'dki_' + 'A'.repeat(43) },
  });
  rep.check('redeem without a valid invite -> 403', unknown.status, 403);

  // 3. Invite creation (admin/machine gate).
  const created = await admin('POST', '/v1/admin/invites', {
    email,
    role: 'member',
    expires_in_s: 300,
  });
  rep.check('invite created -> 200', created.status, 200);
  rep.check('invite answer carries a one-time token', typeof created.data?.token, 'string');
  const inviteId = created.data?.id;
  const inviteToken = created.data?.token;

  // 4. Redeem it: creates the account and a session cookie.
  const redeemed = await raw('POST', '/v1/auth/redeem', { body: { token: inviteToken } });
  rep.check('redeem with a live invite -> 200', redeemed.status, 200);
  rep.check('redeemed account has the invited role', redeemed.data?.user?.role, 'member');
  const sessionCookie = redeemed.cookies
    .map((c) => c.split(';')[0])
    .find((c) => c.includes('session_token')) ?? null;
  rep.check('redeem sets a session cookie', typeof sessionCookie, 'string');

  // 5. Single use: the same token cannot create a second account.
  const again = await raw('POST', '/v1/auth/redeem', { body: { token: inviteToken } });
  rep.check('invite is single use -> 403 on the second redeem', again.status, 403);

  // 6. requireRole: 401 without a session, 200 with one.
  const anonMe = await raw('GET', '/v1/auth/me');
  rep.check('requireRole without a session -> 401', anonMe.status, 401);
  const me = await raw('GET', '/v1/auth/me', { cookie: sessionCookie });
  rep.check('requireRole with a session -> 200', me.status, 200);
  rep.check('session resolves the member role', me.data?.user?.role, 'member');

  // 7. Role permissions differ by mode. In `new`, a member reads every
  //    operational surface and is refused every mutation with a sentence; an
  //    admin does both. The legacy token path must stay intact.
  const memberOnAdmin = await raw('GET', '/v1/admin/health', { cookie: sessionCookie });
  {
    rep.check('member session reads health -> 200 (AUTH_MODE=new)', memberOnAdmin.status, 200);
    const adminNoCred = await fetch(`${WORKER_URL}/v1/admin/health`);
    rep.check('no credential on an admin route -> 401', adminNoCred.status, 401);
    const cli = await admin('GET', '/v1/admin/health');
    rep.check('ADMIN_TOKEN + X-Dakflare-Client: cli still works', cli.status, 200);

    // Reads: everything operational, including the audit log.
    for (const pathname of [
      '/v1/devices',
      '/v1/messages?device_id=dev-none',
      '/v1/admin/rules',
      '/v1/admin/audit',
    ]) {
      const read = await raw('GET', pathname, { cookie: sessionCookie });
      rep.check(`member reads ${pathname} -> 200`, read.status, 200);
    }

    // Writes: refused, with a sentence that names the action.
    const memberSend = await raw('POST', '/v1/sms/send', {
      cookie: sessionCookie,
      body: { device_id: 'dev-none', to: '+15555550100', body: 'hi' },
    });
    rep.check('member send SMS -> 403', memberSend.status, 403);
    rep.check(
      'member send 403 names the refused action',
      typeof memberSend.data?.message === 'string' && memberSend.data.message.includes('send SMS'),
      true
    );

    const memberRevoke = await raw('DELETE', '/v1/admin/devices/dev-none', { cookie: sessionCookie });
    rep.check('member revoke device -> 403', memberRevoke.status, 403);
    rep.check(
      'member revoke 403 is a sentence naming the action',
      /cannot revoke devices/.test(memberRevoke.data?.message ?? ''),
      true
    );

    const memberInvite = await raw('POST', '/v1/admin/invites', {
      cookie: sessionCookie,
      body: { email: `member-cannot-${Date.now()}@example.test`, role: 'member', expires_in_s: 300 },
    });
    rep.check('member create invite -> 403', memberInvite.status, 403);
    rep.check(
      'member invite 403 is a sentence naming the action',
      /cannot create invites/.test(memberInvite.data?.message ?? ''),
      true
    );

    const memberRule = await raw('POST', '/v1/rules', {
      cookie: sessionCookie,
      body: { name: 'member-rule', match: 'contains', value: 'x', reply: 'y' },
    });
    rep.check('member save rule -> 403', memberRule.status, 403);
    rep.check(
      'member rule 403 is a sentence naming the action',
      /cannot save rules/.test(memberRule.data?.message ?? ''),
      true
    );

    // A member manages their own factors: AUTH_PLAN §6 says the second factor is
    // optional for every role, which is only true if every role can enrol it.
    // `self` covers exactly /v1/auth/password and /v1/auth/totp/*.
    const memberFactor = await raw('POST', '/v1/auth/totp/enable', { cookie: sessionCookie });
    rep.check(
      'member may manage their own factor (reauth, not role refusal)',
      memberFactor.status !== 403 || !/cannot change authentication factors/.test(memberFactor.data?.message ?? ''),
      true
    );
    const memberInviteWrite = await raw('POST', '/v1/admin/invites', {
      cookie: sessionCookie,
      body: { email: 'x@example.test', role: 'member', expires_in_s: 600 },
    });
    rep.check('member cannot create invites', memberInviteWrite.status, 403);

    // An admin does both.
    const adminEmail = `auth-admin-${Date.now()}-${crypto.randomBytes(3).toString('hex')}@example.test`;
    const adminInvite = await admin('POST', '/v1/admin/invites', {
      email: adminEmail,
      role: 'admin',
      expires_in_s: 300,
    });
    rep.check('admin invite created for the role test', adminInvite.status, 200);
    const adminRedeem = await raw('POST', '/v1/auth/redeem', { body: { token: adminInvite.data?.token } });
    rep.check('admin account redeemed', adminRedeem.status, 200);
    const adminCookie = sessionCookieOf(adminRedeem.cookies);
    rep.check('admin session cookie present', typeof adminCookie, 'string');
    const adminRead = await raw('GET', '/v1/admin/health', { cookie: adminCookie });
    rep.check('admin session reads health -> 200', adminRead.status, 200);
    const adminWrite = await raw('POST', '/v1/admin/invites', {
      cookie: adminCookie,
      body: { email: `admin-wrote-${Date.now()}@example.test`, role: 'member', expires_in_s: 300 },
    });
    rep.check('admin session creates an invite -> 200', adminWrite.status, 200);
    if (adminWrite.data?.id) await admin('DELETE', `/v1/admin/invites/${adminWrite.data.id}`);
  }

  // 8. Audit rows: invite created/redeemed and a sign-in.
  const auditInvite = await admin('GET', '/v1/admin/audit?limit=200&action=invite.created');
  rep.check(
    'audit_log has invite.created for this invite',
    (auditInvite.data?.events ?? []).some((e) => e.subject === inviteId),
    true
  );
  const auditRedeem = await admin('GET', '/v1/admin/audit?limit=200&action=invite.redeemed');
  rep.check(
    'audit_log has invite.redeemed for this invite',
    (auditRedeem.data?.events ?? []).some((e) => e.subject === inviteId),
    true
  );
  const auditSignIn = await admin('GET', '/v1/admin/audit?limit=200&action=sign_in.success');
  rep.check(
    'audit_log has sign_in.success for this account',
    (auditSignIn.data?.events ?? []).some((e) => e.actor_user === redeemed.data?.user?.id),
    true
  );

  // 9. Cleanup: the synthetic invite is spent; the account is left in place so
  //    repeated runs show real history rather than a wiped table.
  const allOk = rep.print();
  console.log(allOk ? 'AUTH CASES PASSED' : 'AUTH CASES FAILED');
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
        acks: [],
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

    const pollA = await device(A, "POST", "/v1/sms/outgoing/poll", { acks: [] });
    rep.check("A receives the command", (pollA.data?.commands ?? []).some((c) => c.command_id === cmdId), true);

    const pollB = await device(B, "POST", "/v1/sms/outgoing/poll", { acks: [] });
    const pollC = await device(C, "POST", "/v1/sms/outgoing/poll", { acks: [] });
    rep.check("B receives nothing", (pollB.data?.commands ?? []).length, 0);
    rep.check("C receives nothing", (pollC.data?.commands ?? []).length, 0);

    // B cannot ack a command that belongs to A's object. It never held the lease,
    // so it sends a syntactically valid but wrong claim_token.
    const crossAck = await device(B, "POST", "/v1/sms/outgoing/poll", {
      acks: [{ command_id: cmdId, claim_token: "deadbeefdeadbeefdeadbeefdeadbeef" }],
    });
    rep.check("B acking A's command is accepted-but-ignored", crossAck.status, 200);
    const stateA = await admin("GET", `/v1/sms/commands/${cmdId}?device_id=${A.deviceId}`);
    // Not asserting LEASED exactly: the lease may have expired back to PENDING by
    // now. The point is that B's ack did not advance it to DISPATCHED.
    rep.check("B's ack did not advance A's command to DISPATCHED",
      stateA.data?.command?.state !== "DISPATCHED", true);
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
      (await device(B, "POST", "/v1/sms/outgoing/poll", { acks: [] })).status, 401);
    rep.check("A still works -> 200",
      (await device(A, "POST", "/v1/sms/outgoing/poll", { acks: [] })).status, 200);
    rep.check("C still works -> 200",
      (await device(C, "POST", "/v1/sms/outgoing/poll", { acks: [] })).status, 200);
    run(rep);
  }

  console.log("-- key rotation: same device_id, new keypair --");
  {
    const rep = new Report("rotation");
    const oldKey = A.privateKey;
    const rotated = newIdentity();          // new key, same device id
    rotated.deviceId = A.deviceId;
    const mint = await admin("POST", "/v1/admin/pairing-code", { ttl_ms: 60_000, device_id: A.deviceId, purpose: "rotate" });
    const enroll = await admin("POST", "/v1/admin/pairing-code", { ttl_ms: 60_000 });
    const rebind = await fetch(`${WORKER_URL}/v1/device/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pairing_code: enroll.data.pairing_code,
        device_id: A.deviceId,
        public_key_spki: rotated.publicKeySpki,
      }),
    });
    rep.check("an enroll code cannot rebind an existing device -> 409", rebind.status, 409);
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
      (await device(newKeyIdentity, "POST", "/v1/sms/outgoing/poll", { acks: [] })).status, 200);

    const staleIdentity = { deviceId: A.deviceId, privateKey: oldKey, publicKeySpki: A.publicKeySpki };
    const stale = await device(staleIdentity, "POST", "/v1/sms/outgoing/poll", { acks: [] });
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
    const mint2 = await admin("POST", "/v1/admin/pairing-code", { ttl_ms: 60_000, device_id: A.deviceId, purpose: "rotate" });
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
        { messages: Array.from({ length: 501 }, (_, i) => msg(i)), acks: [] })).status, 400);

    rep.check("201-command send batch -> 400",
      (await admin("POST", "/v1/sms/send/batch", {
        device_id: identity.deviceId,
        commands: Array.from({ length: 201 }, () => ({ to: "+8801712345678", body: "x" })),
      })).status, 400);

    rep.check("501 status updates -> 400",
      (await device(identity, "POST", "/v1/sms/status/batch",
        { updates: Array.from({ length: 501 }, () => ({ command_id: "x", status: "SENT" })) })).status, 400);

    rep.check("201 acks -> 400",
      (await device(identity, "POST", "/v1/sms/outgoing/poll",
        { acks: Array.from({ length: 201 }, () => ({ command_id: "x", claim_token: "y" })) })).status, 400);

    rep.check("5000-char message body -> 400",
      (await device(identity, "POST", "/v1/sms/incoming/batch",
        { messages: [{ ...msg(999), body: "y".repeat(5000) }], acks: [] })).status, 400);

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
      (await device(victimKey, "POST", "/v1/sms/outgoing/poll", { acks: [] })).status, 200);

    const revoked = await admin("DELETE", `/v1/admin/devices/${victim.deviceId}`);
    rep.check("DELETE /v1/admin/devices/:id -> 200", revoked.status, 200);

    // Proves revocation reaches the DO: D1 is not what verifies signatures.
    const afterRevoke = await device(victimKey, "POST", "/v1/sms/outgoing/poll", { acks: [] });
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
        if (j.op === 'commands') {
          ws.sendText(JSON.stringify({
            op: 'ack',
            acks: j.commands.map((c) => ({ command_id: c.command_id, claim_token: c.claim_token })),
          }));
        }
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

/* ─────────────────────────── password command ─────────────────────────────── */

/**
 * AUTH_PLAN §2, phase 4.
 *
 * Reads the mode from `/v1/admin/health` rather than the environment, so the
 * assertion set always describes the Worker actually under test. Start the
 * Worker with AUTH_PEPPER set (a Worker secret locally, `--var` is fine) and
 * AUTH_PASSWORD_MODE to one of off|client-derived|server-kdf.
 *
 * TOTP-challenge-on-password-sign-in is exercised by construction in
 * `auth/handler.ts` (`startSecondFactorChallenge` is the same function the
 * passkey path calls); enrolling a real TOTP secret is phase 3's test.
 */
async function cmdPassword() {
  const health = await admin('GET', '/v1/admin/health');
  if (health.status !== 200) {
    console.error(`cannot read /v1/admin/health (${health.status}); check ADMIN_TOKEN and the Worker`);
    process.exit(1);
  }
  const mode = health.data?.password_mode ?? 'off';
  console.log(`== password (AUTH_PASSWORD_MODE=${mode}) ==\nworker: ${WORKER_URL}\n`);
  const rep = new Report('password');

  // The pre-auth probe the login page uses must be public and agree with health.
  const modeProbe = await api(WORKER_URL, 'GET', '/v1/auth/mode');
  rep.check('GET /v1/auth/mode is unauthenticated -> 200', modeProbe.status, 200);
  rep.check(
    'mode payload has exactly the documented keys',
    Object.keys(modeProbe.data ?? {}).sort(),
    ['auth_configured', 'auth_mode', 'magic_link', 'magic_link_ttl_s', 'password_configured', 'password_mode']
  );
  rep.check('mode agrees with health on password_mode', modeProbe.data?.password_mode, mode);
  rep.check('mode password_configured is a boolean', typeof modeProbe.data?.password_configured, 'boolean');
  rep.check('mode auth_configured is a boolean', typeof modeProbe.data?.auth_configured, 'boolean');
  rep.check('mode magic_link is a boolean', typeof modeProbe.data?.magic_link, 'boolean');

  const email = `pw-${Date.now()}-${crypto.randomBytes(3).toString('hex')}@example.test`;
  const unknown = `pw-nobody-${crypto.randomBytes(4).toString('hex')}@example.test`;
  const password = 'correct horse battery staple';
  const raw = (method, pathname, opts) => api(WORKER_URL, method, pathname, opts);
  // Better Auth's CSRF check wants an Origin on state-changing POSTs. `api()`
  // does not set one, so wrap the calls that reach /api/auth/* explicitly.
  const betterAuth = async (pathname, body, cookie, headers = {}) => {
    const res = await fetch(WORKER_URL + pathname, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: WORKER_URL,
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      body: JSON.stringify(body),
    });
    const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    return { status: res.status, data: await res.json().catch(() => null), cookies, headers: res.headers };
  };

  // ---------------------------------------------------------------- salt shape
  const miss1 = await raw('POST', '/v1/auth/salt', { body: { email: unknown } });
  const miss2 = await raw('POST', '/v1/auth/salt', { body: { email: unknown } });
  rep.check('salt for an unknown address -> 200', miss1.status, 200);
  rep.check(
    'salt shape is exactly {salt,iterations,mode,pepper_version}',
    Object.keys(miss1.data ?? {}).sort(),
    ['iterations', 'mode', 'pepper_version', 'salt']
  );
  rep.check('fake salt is deterministic', miss1.data?.salt, miss2.data?.salt);
  rep.check('fake iterations are the contract 210000', miss1.data?.iterations, PW_ITERATIONS);
  rep.check('fake mode is c', miss1.data?.mode, 'c');
  rep.checkFn('fake salt decodes to 16 bytes', () => {
    const bytes = Buffer.from(miss1.data?.salt ?? '', 'base64');
    return bytes.length === 16 || `got ${bytes.length} bytes`;
  });

  // ------------------------------------------------- construction parity (pure)
  // Same password, same salt, same iterations: the digest must not depend on
  // who ran the inner KDF. Only the m= tag may differ.
  {
    const pepper = crypto.createHash('sha256').update('harness-parity-pepper').digest();
    const salt = crypto.createHash('sha256').update('harness-parity-salt').digest().subarray(0, 16);
    const asClient = pwRow({
      pepper, version: 2, iterations: PW_ITERATIONS, mode: 'c', salt,
      material: pwMaterial(password, salt),
    });
    const asWorker = pwRow({
      pepper, version: 2, iterations: PW_ITERATIONS, mode: 's', salt,
      material: pwMaterial(password, salt),
    });
    const withoutMode = (row) => row.split('$').filter((_, i) => i !== 3).join('$');
    rep.check('client and Worker material are byte-identical', b64Of(pwMaterial(password, salt)), b64Of(pwMaterial(password, salt)));
    rep.check('stored digest is identical in both modes (only m= differs)', withoutMode(asClient), withoutMode(asWorker));
    rep.check('row matches the contract shape', /^v1\$p=\d+\$k=\d+\$m=[cs]\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/.test(asClient), true);
  }

  // ---------------------------------------------------------------- an account
  const created = await admin('POST', '/v1/admin/invites', { email, role: 'admin', expires_in_s: 300 });
  rep.check('invite created', created.status, 200);
  const redeemed = await raw('POST', '/v1/auth/redeem', { body: { token: created.data?.token } });
  rep.check('invite redeemed -> 200', redeemed.status, 200);
  const session = sessionCookieOf(redeemed.cookies);
  rep.check('redeem sets a session cookie', typeof session, 'string');

  // A real account with NO password must look exactly like an unknown address:
  // same fields, same iteration count, same deterministic salt for the address.
  const noPassword = await raw('POST', '/v1/auth/salt', { body: { email } });
  const noPasswordAgain = await raw('POST', '/v1/auth/salt', { body: { email } });
  rep.check(
    'an account without a password has the same salt shape as unknown',
    Object.keys(noPassword.data ?? {}).sort(),
    Object.keys(miss1.data ?? {}).sort()
  );
  rep.check('it gets the same fake iteration count', noPassword.data?.iterations, PW_ITERATIONS);
  rep.check('it gets fake mode c', noPassword.data?.mode, 'c');
  rep.check('its fake salt is deterministic', noPassword.data?.salt, noPasswordAgain.data?.salt);

  // ------------------------------------------------------------------ set
  const preSalt = Buffer.from(noPassword.data.salt, 'base64');
  const preIterations = noPassword.data.iterations;
  const material = pwMaterial(password, preSalt, preIterations);

  if (mode === 'off') {
    const set = await raw('POST', '/v1/auth/password', { cookie: session, body: { password } });
    rep.check('mode off refuses a set -> 403 password_disabled', [set.status, set.data?.error], [403, 'password_disabled']);
    const sign = await raw('POST', '/v1/auth/sign-in/password', { body: { email, password } });
    rep.check('mode off refuses password sign-in -> 403 password_disabled', [sign.status, sign.data?.error], [403, 'password_disabled']);
    const matSign = await raw('POST', '/v1/auth/sign-in/password', {
      body: { email, material: b64Of(material) },
    });
    rep.check('mode off refuses material sign-in too', matSign.status, 403);
    const allOk = rep.print();
    console.log(allOk ? 'PASSWORD CASES PASSED' : 'PASSWORD CASES FAILED');
    process.exit(allOk ? 0 : 1);
  }

  if (mode === 'client-derived') {
    const plaintext = await raw('POST', '/v1/auth/password', { cookie: session, body: { password } });
    rep.check('client-derived refuses a plaintext set -> 403', [plaintext.status, plaintext.data?.error], [403, 'password_mode_mismatch']);
    const set = await raw('POST', '/v1/auth/password', {
      cookie: session,
      body: { material: b64Of(material), salt: b64Of(preSalt), iterations: preIterations },
    });
    rep.check('client-derived set with {material} -> 200', set.status, 200);
    rep.check('set reports m=c provenance via the row', (await raw('POST', '/v1/auth/salt', { body: { email } })).data?.mode, 'c');
  } else {
    const set = await raw('POST', '/v1/auth/password', { cookie: session, body: { password } });
    rep.check('server-kdf set with {password} -> 200', set.status, 200);
    rep.check('set reports m=s provenance via the row', (await raw('POST', '/v1/auth/salt', { body: { email } })).data?.mode, 's');
  }

  const stored = await raw('POST', '/v1/auth/salt', { body: { email } });
  rep.check('salt after set is no longer the fake salt', stored.data?.salt === miss1.data?.salt, false);
  rep.check('salt after set reports 210000 iterations', stored.data?.iterations, PW_ITERATIONS);

  // ------------------------------------------------------- sign-in, both paths
  const rowSalt = Buffer.from(stored.data.salt, 'base64');
  const rowMaterial = pwMaterial(password, rowSalt, stored.data.iterations);

  const wrongBody = mode === 'server-kdf' ? { password: 'definitely-not-the-password' } : { material: b64Of(crypto.randomBytes(32)) };
  const wrong = await raw('POST', '/v1/auth/sign-in/password', { body: { email, ...wrongBody } });
  const nobodysBody = mode === 'server-kdf' ? { password: 'definitely-not-the-password' } : { material: b64Of(crypto.randomBytes(32)) };
  const nobodys = await raw('POST', '/v1/auth/sign-in/password', { body: { email: unknown, ...nobodysBody } });
  rep.check('wrong secret -> 401', wrong.status, 401);
  rep.check('unknown address -> 401', nobodys.status, 401);
  rep.check('wrong secret and unknown address are byte-identical', wrong.data, nobodys.data);

  if (mode === 'client-derived') {
    const plaintext = await raw('POST', '/v1/auth/sign-in/password', { body: { email, password } });
    rep.check('client-derived refuses a plaintext sign-in -> 403', [plaintext.status, plaintext.data?.error], [403, 'password_mode_mismatch']);
  }

  const signInStarted = performance.now();
  const signedIn = await raw('POST', '/v1/auth/sign-in/password', {
    body: { email, ...(mode === 'server-kdf' ? { password } : { material: b64Of(rowMaterial) }) },
  });
  const signInMs = performance.now() - signInStarted;
  rep.check('sign-in -> 200', signedIn.status, 200);
  rep.check('sign-in returns the same account', signedIn.data?.user?.email, email);
  const signedCookie = sessionCookieOf(signedIn.cookies);
  rep.check('sign-in sets a session cookie', typeof signedCookie, 'string');
  if (signedCookie) {
    const me = await raw('GET', '/v1/auth/me', { cookie: signedCookie });
    rep.check('the session minted by sign-in resolves via requireRole', me.status, 200);
    rep.check('it is the same user', me.data?.user?.email, email);
  }

  // ---------------------------------------------------- cross-mode parity, live
  // A row written from client material must verify with the plaintext, and a row
  // written from the plaintext must verify with material. Same stored value,
  // whoever ran PBKDF2 — this is the upgrade promise of AUTH_PLAN §2.
  if (mode === 'server-kdf') {
    const salt2 = crypto.randomBytes(16);
    const material2 = pwMaterial(password, salt2);
    const byMaterial = await raw('POST', '/v1/auth/password', {
      cookie: session,
      body: { material: b64Of(material2), salt: b64Of(salt2), iterations: PW_ITERATIONS },
    });
    rep.check('server-kdf accepts a client-derived set', byMaterial.status, 200);
    const withPassword = await raw('POST', '/v1/auth/sign-in/password', { body: { email, password } });
    rep.check('a row set from material verifies with {password}', withPassword.status, 200);
    const withMaterial = await raw('POST', '/v1/auth/sign-in/password', {
      body: { email, material: b64Of(material2) },
    });
    rep.check('…and with {material} too', withMaterial.status, 200);
  }

  // ---------------------------------------------- TOTP changes need re-authentication
  // This account has a password in BOTH modes — the case the plugin's own
  // enable/disable/generate-backup-codes endpoints answer with INVALID_PASSWORD.
  // First prove a password is NOT a proof, then enrol with a passkey assertion.
  const passkey = await createPasskey(session);
  rep.check('a passkey is enrolled for the step-up', passkey.status, 200);

  const passwordProof = await raw('POST', '/v1/auth/totp/enable', { cookie: session, body: { password } });
  rep.check(
    'enable with a password instead of a passkey -> 400 password_not_accepted',
    [passwordProof.status, passwordProof.data?.error],
    [400, 'password_not_accepted']
  );
  const noGrant = await raw('POST', '/v1/auth/totp/enable', { cookie: session });
  rep.check(
    'enable without a passkey assertion -> 403 reauth_required',
    [noGrant.status, noGrant.data?.error],
    [403, 'reauth_required']
  );

  const stepUp = await assertPasskey(passkey);
  rep.check('passkey assertion for the step-up -> 200', stepUp.status, 200);
  const enableStarted = performance.now();
  const enable = await raw('POST', '/v1/auth/totp/enable', { cookie: jarString(stepUp.jar) });
  const enableMs = performance.now() - enableStarted;
  rep.check('enable with a passkey assertion -> 200', enable.status, 200);
  console.log(
    `  timing: TOTP enable ${enableMs.toFixed(1)} ms; ` +
      `password sign-in (${mode}) ${signInMs.toFixed(1)} ms`
  );
  const totpURI = enable.data?.totpURI;
  const totpSecret = totpURI ? new URL(totpURI).searchParams.get('secret') : null;
  rep.check('enable returns an otpauth URI with a secret', typeof totpSecret, 'string');
  rep.check(
    'enable returns ten recovery codes',
    Array.isArray(enable.data?.backupCodes) ? enable.data.backupCodes.length : -1,
    10
  );
  const verified = await betterAuth(
    '/api/auth/two-factor/verify-totp',
    { code: totpNow(totpSecret) },
    jarString(stepUp.jar)
  );
  rep.check('the first TOTP code verifies -> 200', verified.status, 200);
  // The plugin rotates the session when it flips twoFactorEnabled on.
  let totpCookie = sessionCookieOf(verified.cookies) ?? jarString(stepUp.jar);

  // The recovery-code row must be the plugin's own format, not just a plausible
  // array: the plugin's verifier reads and consumes one of them here.
  const backupCode = Array.isArray(enable.data?.backupCodes) ? enable.data.backupCodes[0] : null;
  const backupVerified = await betterAuth(
    '/api/auth/two-factor/verify-backup-code',
    { code: backupCode },
    totpCookie
  );
  rep.check(
    'a recovery code from the Worker-generated set verifies through the plugin -> 200',
    backupVerified.status,
    200
  );

  const challenged = await raw('POST', '/v1/auth/sign-in/password', {
    body: { email, ...(mode === 'server-kdf' ? { password } : { material: b64Of(rowMaterial) }) },
  });
  rep.check(
    'password sign-in for a TOTP account returns the challenge',
    [challenged.status, challenged.data?.twoFactorRedirect, challenged.data?.twoFactorMethods],
    [200, true, ['totp']]
  );
  const challengeSessionCookies = challenged.cookies.filter((c) => c.includes('session_token='));
  rep.check(
    '…and no usable session cookie',
    challengeSessionCookies.some((c) => c.split(';')[0].split('=')[1] !== ''),
    false
  );
  rep.check(
    '…any session cookie is explicitly expired',
    challengeSessionCookies.every((c) => /Max-Age=0/.test(c)),
    true
  );
  rep.check(
    '…but a two_factor cookie',
    challenged.cookies.some((c) => c.includes('two_factor=')),
    true
  );

  const wrongCode = String((Number(totpNow(totpSecret)) + 1) % 1_000_000).padStart(6, '0');
  const disableNoCode = await raw('POST', '/v1/auth/totp/disable', { cookie: totpCookie, body: {} });
  rep.check('disable without a code -> 401', disableNoCode.status, 401);
  if (mode === 'client-derived') {
    const disableWithPassword = await raw('POST', '/v1/auth/totp/disable', {
      cookie: totpCookie,
      body: { password },
    });
    rep.check(
      'client-derived: a password does not authorise disable -> 400 password_not_accepted',
      [disableWithPassword.status, disableWithPassword.data?.error],
      [400, 'password_not_accepted']
    );
  }
  const disableWrong = await raw('POST', '/v1/auth/totp/disable', {
    cookie: totpCookie,
    body: { code: wrongCode },
  });
  rep.check('disable with a wrong code -> 401', disableWrong.status, 401);
  const disable = await raw('POST', '/v1/auth/totp/disable', {
    cookie: totpCookie,
    body: { code: totpNow(totpSecret) },
  });
  rep.check('disable with a current code -> 200', disable.status, 200);
  const statusOff = await raw('GET', '/v1/auth/totp', { cookie: totpCookie });
  rep.check(
    'status after disable says off',
    [statusOff.data?.enabled, statusOff.data?.verified],
    [false, false]
  );

  // Re-enrol so regenerate (and the password-delete code path below) has a live
  // factor. A second assertion is required: the grant is single-use.
  const stepUp2 = await assertPasskey(passkey);
  rep.check('a second passkey assertion -> 200', stepUp2.status, 200);
  const enable2 = await raw('POST', '/v1/auth/totp/enable', { cookie: jarString(stepUp2.jar) });
  rep.check('re-enable with a passkey assertion -> 200', enable2.status, 200);
  const totpSecret2 = enable2.data?.totpURI
    ? new URL(enable2.data.totpURI).searchParams.get('secret')
    : null;
  const verified2 = await betterAuth(
    '/api/auth/two-factor/verify-totp',
    { code: totpNow(totpSecret2) },
    jarString(stepUp2.jar)
  );
  rep.check('the re-enrolment code verifies -> 200', verified2.status, 200);
  totpCookie = sessionCookieOf(verified2.cookies) ?? jarString(stepUp2.jar);

  const regenNoCode = await raw('POST', '/v1/auth/totp/regenerate', { cookie: totpCookie, body: {} });
  rep.check('regenerate without a code -> 401', regenNoCode.status, 401);
  const regen = await raw('POST', '/v1/auth/totp/regenerate', {
    cookie: totpCookie,
    body: { code: totpNow(totpSecret2) },
  });
  rep.check('regenerate with a current code -> 200', regen.status, 200);
  rep.check(
    'regenerate returns ten codes',
    Array.isArray(regen.data?.backupCodes) ? regen.data.backupCodes.length : -1,
    10
  );

  const delNoCode = await raw('DELETE', '/v1/auth/password', { cookie: totpCookie, body: { code: wrongCode } });
  rep.check('delete with a wrong TOTP code -> 401', delNoCode.status, 401);
  const del = await raw('DELETE', '/v1/auth/password', {
    cookie: totpCookie,
    body: { code: totpNow(totpSecret2) },
  });
  rep.check('delete with a fresh TOTP code -> 200', del.status, 200);

  const afterDelete = await raw('POST', '/v1/auth/salt', { body: { email } });
  rep.check('after delete the address falls back to its fake salt', afterDelete.data?.salt, noPasswordAgain.data?.salt);
  const afterSignIn = await raw('POST', '/v1/auth/sign-in/password', {
    body: { email, ...(mode === 'server-kdf' ? { password } : { material: b64Of(rowMaterial) }) },
  });
  rep.check('after delete the old secret no longer signs in -> 401', afterSignIn.status, 401);

  // ------------------------------------------------------- lockout (AUTH_PLAN §3)
  // The account above has no password and no TOTP by now, so use a fresh one.
  // The Worker is expected to be started with a short
  // AUTH_LOCKOUT_WINDOW_SECONDS for this command; the wait below is taken from
  // the 429's own `retry_after`, so the assertion still describes the Worker
  // under test rather than a harness constant.
  const lockEmail = `lock-${Date.now()}-${crypto.randomBytes(3).toString('hex')}@example.test`;
  const lockPassword = 'correct horse battery staple';
  // TEST-NET addresses, unique per run: the IP window lives in the Worker
  // isolate, so a fixed address would inherit a previous run's failures.
  const lockIpTag = crypto.randomBytes(2);
  const lockIpPassword = `198.51.100.${(lockIpTag[0] % 200) + 10}`;
  const lockIpTotp = `203.0.113.${(lockIpTag[1] % 200) + 10}`;
  const lockIpUnknown = `192.0.2.${((lockIpTag[0] + lockIpTag[1]) % 200) + 10}`;
  const lockInvite = await admin('POST', '/v1/admin/invites', {
    email: lockEmail,
    role: 'admin',
    expires_in_s: 300,
  });
  rep.check('lockout: invite created', lockInvite.status, 200);
  const lockRedeemed = await raw('POST', '/v1/auth/redeem', { body: { token: lockInvite.data?.token } });
  rep.check('lockout: invite redeemed', lockRedeemed.status, 200);
  const lockSession = sessionCookieOf(lockRedeemed.cookies);
  const lockSaltRes = await raw('POST', '/v1/auth/salt', { body: { email: lockEmail } });
  const lockSalt = Buffer.from(lockSaltRes.data?.salt ?? '', 'base64');
  const lockIterations = lockSaltRes.data?.iterations ?? PW_ITERATIONS;
  const lockMaterial = pwMaterial(lockPassword, lockSalt, lockIterations);
  const lockSet = await raw('POST', '/v1/auth/password', {
    cookie: lockSession,
    body: { material: b64Of(lockMaterial), salt: b64Of(lockSalt), iterations: lockIterations },
  });
  rep.check('lockout: password set', lockSet.status, 200);

  const wrongLockMaterial = crypto.randomBytes(32);
  const lockSignIn = (material, ip) =>
    raw('POST', '/v1/auth/sign-in/password', {
      body: { email: lockEmail, material: b64Of(material) },
      headers: { 'CF-Connecting-IP': ip },
    });

  const knownStatuses = [];
  let knownFifth = null;
  for (let i = 0; i < 5; i += 1) {
    const r = await lockSignIn(wrongLockMaterial, lockIpPassword);
    knownStatuses.push(r.status);
    if (i === 4) knownFifth = r;
  }
  rep.check('lockout: four wrong passwords -> 401', knownStatuses.slice(0, 4), [401, 401, 401, 401]);
  rep.check('lockout: fifth wrong password -> 429', knownFifth?.status, 429);
  rep.check(
    'lockout: 429 Retry-After header matches retry_after',
    Number(knownFifth?.headers?.get?.('retry-after')),
    knownFifth?.data?.retry_after
  );
  rep.check('lockout: 429 carries a console sentence', typeof knownFifth?.data?.message, 'string');
  const lockWindow = Number(knownFifth?.data?.retry_after ?? 1);
  rep.check('lockout: retry_after is a positive whole number of seconds', Number.isInteger(lockWindow) && lockWindow > 0, true);

  const knownCorrectDuring = await lockSignIn(lockMaterial, lockIpPassword);
  rep.check('lockout: correct password during the lockout is still 429', knownCorrectDuring.status, 429);

  const knownSpray = [];
  for (let i = 0; i < 3; i += 1) knownSpray.push(await lockSignIn(wrongLockMaterial, lockIpPassword));
  rep.check('lockout: spraying while locked stays 429', knownSpray.map((r) => r.status), [429, 429, 429]);
  rep.check(
    'lockout: spraying does not extend the password lockout',
    knownSpray[knownSpray.length - 1].data?.retry_after <= lockWindow,
    true
  );

  await sleep((lockWindow + 1) * 1000);
  const knownAfter = await lockSignIn(lockMaterial, lockIpPassword);
  rep.check('lockout: correct password after the window -> 200', knownAfter.status, 200);
  const knownCleared = await lockSignIn(wrongLockMaterial, lockIpPassword);
  rep.check('lockout: the success cleared the account counter (next wrong is 401)', knownCleared.status, 401);

  // An unknown address must produce the same sequence. The account counter is
  // keyed by the normalized email, so it costs the same as a real account and
  // the 429 body does not say whether the address exists.
  const unknownLockEmail = `nobody-${crypto.randomBytes(4).toString('hex')}@example.test`;
  const unknownStatuses = [];
  let unknownFifth = null;
  for (let i = 0; i < 5; i += 1) {
    const r = await raw('POST', '/v1/auth/sign-in/password', {
      body: { email: unknownLockEmail, material: b64Of(wrongLockMaterial) },
      headers: { 'CF-Connecting-IP': lockIpUnknown },
    });
    unknownStatuses.push(r.status);
    if (i === 4) unknownFifth = r;
  }
  rep.check('lockout: an unknown address has the same status sequence as a known one', unknownStatuses, knownStatuses);
  rep.check(
    'lockout: the unknown-address 429 has the same shape',
    [unknownFifth?.status, typeof unknownFifth?.data?.retry_after],
    [429, 'number']
  );

  // Enrol TOTP on the lockout account, then count wrong codes on the sign-in
  // challenge and on the live-session regenerate route.
  const lockPasskey = await createPasskey(lockSession);
  rep.check('lockout: passkey enrolled for the step-up', lockPasskey.status, 200);
  const lockStepUp = await assertPasskey(lockPasskey);
  rep.check('lockout: passkey assertion -> 200', lockStepUp.status, 200);
  const lockEnable = await raw('POST', '/v1/auth/totp/enable', { cookie: jarString(lockStepUp.jar) });
  rep.check('lockout: TOTP enabled', lockEnable.status, 200);
  const lockSecret = lockEnable.data?.totpURI
    ? new URL(lockEnable.data.totpURI).searchParams.get('secret')
    : null;
  rep.check('lockout: enable returns a TOTP secret', typeof lockSecret, 'string');
  const lockVerified = await betterAuth(
    '/api/auth/two-factor/verify-totp',
    { code: totpNow(lockSecret) },
    jarString(lockStepUp.jar)
  );
  rep.check('lockout: the first TOTP code verifies', lockVerified.status, 200);
  const lockTotpCookie = sessionCookieOf(lockVerified.cookies) ?? jarString(lockStepUp.jar);

  const lockChallenge = await raw('POST', '/v1/auth/sign-in/password', {
    body: { email: lockEmail, material: b64Of(lockMaterial) },
    headers: { 'CF-Connecting-IP': lockIpTotp },
  });
  rep.check(
    'lockout: password sign-in for the TOTP account returns the challenge',
    [lockChallenge.status, lockChallenge.data?.twoFactorRedirect],
    [200, true]
  );
  const challengeJar = new Map();
  absorbCookies(challengeJar, lockChallenge.cookies);
  const challengeCookie = jarString(challengeJar);
  // A fixed code that is not the current one and stays wrong across the wait
  // (a `current + 1` code can become current when the 30-second step rolls).
  const wrongLockCode = totpNow(lockSecret) === '000000' ? '000001' : '000000';

  const codeStatuses = [];
  let codeFifth = null;
  for (let i = 0; i < 5; i += 1) {
    const r = await betterAuth(
      '/api/auth/two-factor/verify-totp',
      { code: wrongLockCode },
      challengeCookie,
      { 'CF-Connecting-IP': lockIpTotp }
    );
    codeStatuses.push(r.status);
    if (i === 4) codeFifth = r;
  }
  rep.check('lockout: four wrong sign-in codes -> 401', codeStatuses.slice(0, 4), [401, 401, 401, 401]);
  rep.check('lockout: fifth wrong sign-in code -> 429', codeFifth?.status, 429);
  rep.check(
    'lockout: sign-in 429 carries Retry-After',
    Number(codeFifth?.headers?.get?.('retry-after')),
    codeFifth?.data?.retry_after
  );

  const codeCorrectDuring = await betterAuth(
    '/api/auth/two-factor/verify-totp',
    { code: totpNow(lockSecret) },
    challengeCookie,
    { 'CF-Connecting-IP': lockIpTotp }
  );
  rep.check('lockout: correct code during the lockout is still 429', codeCorrectDuring.status, 429);

  const codeSpray = [];
  for (let i = 0; i < 3; i += 1) {
    codeSpray.push(
      await betterAuth(
        '/api/auth/two-factor/verify-totp',
        { code: wrongLockCode },
        challengeCookie,
        { 'CF-Connecting-IP': lockIpTotp }
      )
    );
  }
  rep.check('lockout: spraying codes while locked stays 429', codeSpray.map((r) => r.status), [429, 429, 429]);
  rep.check(
    'lockout: spraying does not extend the code lockout',
    codeSpray[codeSpray.length - 1].data?.retry_after <= Number(codeFifth?.data?.retry_after ?? 0),
    true
  );

  const codeWindow = Number(codeFifth?.data?.retry_after ?? 1);
  await sleep((codeWindow + 1) * 1000);
  const codeAfter = await betterAuth(
    '/api/auth/two-factor/verify-totp',
    { code: totpNow(lockSecret) },
    challengeCookie,
    { 'CF-Connecting-IP': lockIpTotp }
  );
  rep.check('lockout: correct code after the window -> 200', codeAfter.status, 200);
  const codeSession = sessionCookieOf(codeAfter.cookies);
  rep.check('lockout: ...and it mints a session', typeof codeSession, 'string');

  const liveCookie = codeSession ?? lockTotpCookie;
  const regenStatuses = [];
  let regenFifth = null;
  for (let i = 0; i < 5; i += 1) {
    const r = await raw('POST', '/v1/auth/totp/regenerate', {
      cookie: liveCookie,
      body: { code: wrongLockCode },
      headers: { 'CF-Connecting-IP': lockIpTotp },
    });
    regenStatuses.push(r.status);
    if (i === 4) regenFifth = r;
  }
  rep.check('lockout: four wrong regenerate codes -> 401', regenStatuses.slice(0, 4), [401, 401, 401, 401]);
  rep.check('lockout: fifth wrong regenerate code -> 429', regenFifth?.status, 429);

  const regenCorrectDuring = await raw('POST', '/v1/auth/totp/regenerate', {
    cookie: liveCookie,
    body: { code: totpNow(lockSecret) },
    headers: { 'CF-Connecting-IP': lockIpTotp },
  });
  rep.check('lockout: correct regenerate during the lockout is still 429', regenCorrectDuring.status, 429);

  const regenWindow = Number(regenFifth?.data?.retry_after ?? 1);
  await sleep((regenWindow + 1) * 1000);
  const regenAfter = await raw('POST', '/v1/auth/totp/regenerate', {
    cookie: liveCookie,
    body: { code: totpNow(lockSecret) },
    headers: { 'CF-Connecting-IP': lockIpTotp },
  });
  rep.check('lockout: correct regenerate after the window -> 200', regenAfter.status, 200);

  const allOk = rep.print();
  console.log(allOk ? 'PASSWORD CASES PASSED' : 'PASSWORD CASES FAILED');
  process.exit(allOk ? 0 : 1);
}

/* ───────────────────────────── magic-link command ─────────────────────────── */

const MAGIC_PORT = Number(process.env.MAGIC_PORT ?? 8798);

/**
 * AUTH_PLAN §1 factor 2, end to end.
 *
 * The command owns its Worker because two of the assertions are about
 * deployment state that cannot be changed on a running `wrangler dev`:
 *
 *   - expiry needs a short MAGIC_LINK_TTL_SECONDS (the contract's 15 minutes
 *     would make the command take a quarter of an hour);
 *   - "no sender configured" needs a Worker without RESEND_API_KEY, and the
 *     mode endpoint must then say magic_link:false.
 *
 * A local HTTP server stands in for Resend (`RESEND_BASE_URL`), so the command
 * can assert the exact message and prove that an unknown address produces no
 * mail at all. D1 state is isolated under /tmp/opencode, like password-rotate.
 */
async function cmdMagic() {
  const { spawn, spawnSync } = await import('node:child_process');
  const workerDir = path.join(HERE, 'worker');
  const stateDir = path.join('/tmp/opencode', `dakflare-magic-${Date.now()}`);
  const base = `http://127.0.0.1:${MAGIC_PORT}`;
  const rep = new Report('magic');
  const servers = [];
  const mail = [];

  const secret = crypto.randomBytes(32).toString('base64');

  // A minimal Resend stand-in: records the JSON body of POST /emails and
  // answers the way Resend does. It never sees a real provider key.
  const capture = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/emails') {
        try { mail.push(JSON.parse(body)); } catch { mail.push({ raw: body }); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: `capture-${mail.length}` }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise((resolve) => capture.listen(0, '127.0.0.1', resolve));
  const captureBase = `http://127.0.0.1:${capture.address().port}`;

  const stopWorker = async (server) => {
    if (server.proc.exitCode !== null) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { server.proc.kill('SIGKILL'); } catch { /* gone */ }
        resolve();
      }, 10_000);
      server.proc.once('exit', () => { clearTimeout(timer); resolve(); });
      server.proc.kill('SIGTERM');
    });
    await sleep(500);
  };

  const startWorker = async ({ sender, ttl, label }) => {
    const args = [
      'wrangler', 'dev', '--local',
      '--port', String(MAGIC_PORT),
      '--persist-to', stateDir,
      '--var', `AUTH_BASE_URL:${base}`,
      '--var', `AUTH_TRUSTED_ORIGINS:${base}`,
      '--var', `BETTER_AUTH_SECRET:${secret}`,
      '--var', `ADMIN_TOKEN:${ADMIN_TOKEN}`,
      '--var', 'AUTH_PASSWORD_MODE:off',
    ];
    if (ttl !== undefined) args.push('--var', `MAGIC_LINK_TTL_SECONDS:${ttl}`);
    if (sender) {
      args.push('--var', 'RESEND_API_KEY:harness-resend-key');
      args.push('--var', `RESEND_BASE_URL:${captureBase}`);
      args.push('--var', 'MAGIC_LINK_FROM:DakFlare <onboarding@resend.dev>');
    }

    const proc = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', args, {
      cwd: workerDir,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    proc.stdout.on('data', (chunk) => { log += chunk; });
    proc.stderr.on('data', (chunk) => { log += chunk; });
    const server = { proc, label, log: () => log };
    servers.push(server);

    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) {
        throw new Error(`${label}: wrangler dev exited (${proc.exitCode})\n${log.slice(-4000)}`);
      }
      try {
        const res = await fetch(`${base}/v1/admin/health`, {
          headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
        });
        if (res.ok) return server;
      } catch { /* not listening yet */ }
      await sleep(400);
    }
    throw new Error(`${label}: wrangler dev did not become ready\n${log.slice(-4000)}`);
  };

  const raw = async (method, pathname, { body, cookie, headers } = {}) => {
    const res = await fetch(base + pathname, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
        ...(headers ?? {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    return { status: res.status, data: await res.json().catch(() => null), cookies, headers: res.headers };
  };

  const adminAt = async (method, pathname, body) => {
    const res = await fetch(base + pathname, {
      method,
      headers: {
        Authorization: `Bearer ${ADMIN_TOKEN}`,
        'X-Dakflare-Client': 'cli',
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  };

  const makeAccount = async (label) => {
    const email = `magic-${label}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}@example.test`;
    const invite = await adminAt('POST', '/v1/admin/invites', {
      email,
      role: 'admin',
      expires_in_s: 300,
    });
    if (invite.status !== 200) throw new Error(`invite for ${label} failed: ${invite.status}`);
    const redeemed = await raw('POST', '/v1/auth/redeem', { body: { token: invite.data?.token } });
    return { email, session: sessionCookieOf(redeemed.cookies), redeemed };
  };

  /**
   * Request a link. The Worker answers 202 before it writes the row or calls
   * the provider (`ctx.waitUntil`), so a positive expectation polls the local
   * capture; a negative one gives a late message a chance to show up before the
   * "nothing was sent" assertion.
   */
  const requestAndCapture = async (email, expectMail = true) => {
    const before = mail.length;
    const res = await raw('POST', '/v1/auth/magic-link', { body: { email } });
    if (expectMail) {
      const deadline = Date.now() + 5_000;
      while (mail.length === before && Date.now() < deadline) await sleep(25);
    } else {
      await sleep(250);
    }
    return { res, before };
  };

  const tokenFrom = (message) => {
    const text = String(message?.text ?? '');
    const line = text.split('\n').find((entry) => entry.startsWith('http'));
    if (!line) return null;
    const url = new URL(line);
    return {
      url,
      token: url.searchParams.get('token'),
      email: url.searchParams.get('email'),
      next: url.searchParams.get('next'),
      text,
    };
  };

  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const migrate = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', [
      'wrangler', 'd1', 'migrations', 'apply', 'sms_gateway', '--local', '--persist-to', stateDir,
    ], { cwd: workerDir, encoding: 'utf8' });
    if (migrate.status !== 0) {
      throw new Error(`wrangler d1 migrations apply failed:\n${migrate.stderr ?? ''}${migrate.stdout ?? ''}`);
    }

    // ---- 1. a sender is configured: the factor is advertised ----------------
    let server = await startWorker({ sender: true, ttl: 3, label: 'sender configured' });

    const mode = await raw('GET', '/v1/auth/mode');
    rep.check('mode with a sender -> 200', mode.status, 200);
    rep.check('mode advertises the magic-link factor', mode.data?.magic_link, true);
    rep.check('mode reports the configured TTL', mode.data?.magic_link_ttl_s, 3);

    const known = await makeAccount('known');
    rep.check('known account created', known.redeemed.status, 200);

    // ---- 2. known and unknown addresses answer the same 202 -----------------
    const knownReq = await requestAndCapture(known.email);
    rep.check('request for a known address -> 202', knownReq.res.status, 202);
    rep.check('request body is exactly {ok:true}', knownReq.res.data, { ok: true });
    rep.check('a message was sent for the known address', mail.length, knownReq.before + 1);

    const unknownEmail = `magic-nobody-${crypto.randomBytes(4).toString('hex')}@example.test`;
    const unknownReq = await requestAndCapture(unknownEmail, false);
    rep.check('request for an unknown address -> 202', unknownReq.res.status, 202);
    rep.check('unknown body is byte-identical to known', unknownReq.res.data, knownReq.res.data);
    rep.check('no message was sent for the unknown address', mail.length, knownReq.before + 1);

    const malformed = await requestAndCapture('not-an-address', false);
    rep.check('malformed address -> 202, same body', [malformed.res.status, malformed.res.data], [202, { ok: true }]);
    rep.check('malformed address sent no message', mail.length, knownReq.before + 1);

    // ---- 3. the exact message ----------------------------------------------
    const message = mail[mail.length - 1];
    const link = tokenFrom(message);
    rep.check('the message is addressed to the known account', message?.to, [known.email]);
    rep.check('the link is /admin/magic', link?.url?.pathname, '/admin/magic');
    rep.check('the link carries the account address', link?.email, known.email);
    rep.check('the link defaults next to the console overview', link?.next, '/admin');
    rep.check('the token is 32 random bytes in base64url', /^[A-Za-z0-9_-]{43}$/.test(link?.token ?? ''), true);
    rep.check('the token is not the stored form', link?.token?.includes('$') ?? true, false);

    console.log('\n--- captured magic-link mail (text/plain) ---');
    console.log(link?.text ?? '(none)');
    console.log('--- end captured mail ---\n');

    const bodyText = String(message?.text ?? '') + String(message?.html ?? '');
    rep.check('the mail does not contain ADMIN_TOKEN', bodyText.includes(ADMIN_TOKEN), false);
    rep.check('the mail does not contain BETTER_AUTH_SECRET', bodyText.includes(secret), false);
    rep.check('the mail does not contain AUTH_PEPPER', bodyText.includes('AUTH_PEPPER'), false);

    // ---- 4. consume once, then not again -----------------------------------
    const consumed = await raw('POST', '/v1/auth/magic-link/consume', {
      body: { token: link?.token },
    });
    rep.check('first consume -> 200', consumed.status, 200);
    rep.check('first consume body is {ok:true}', consumed.data, { ok: true });
    const session = sessionCookieOf(consumed.cookies);
    rep.check('first consume sets a session cookie', typeof session, 'string');
    if (session) {
      const me = await raw('GET', '/v1/auth/me', { cookie: session });
      rep.check('the magic-link session resolves via requireRole', me.status, 200);
      rep.check('it is the account the link was sent to', me.data?.user?.email, known.email);
    }

    const second = await raw('POST', '/v1/auth/magic-link/consume', {
      body: { token: link?.token },
    });
    rep.check('second consume -> 410 used', [second.status, second.data?.error], [410, 'used']);

    // ---- 5. expiry ----------------------------------------------------------
    const expiringReq = await requestAndCapture(known.email);
    const expiringLink = tokenFrom(mail[mail.length - 1]);
    rep.check('a second link was sent', mail.length, expiringReq.before + 1);
    await sleep(4_000);
    const expired = await raw('POST', '/v1/auth/magic-link/consume', {
      body: { token: expiringLink?.token },
    });
    rep.check('an expired link -> 410 expired', [expired.status, expired.data?.error], [410, 'expired']);

    // ---- 6. a TOTP account gets the challenge, never a session -------------
    const totpAccount = await makeAccount('totp');
    rep.check('TOTP account created', totpAccount.redeemed.status, 200);
    const passkey = await createPasskey(totpAccount.session, base);
    rep.check('passkey enrolled for the step-up', passkey.status, 200);
    const stepUp = await assertPasskey(passkey, base);
    rep.check('passkey assertion -> 200', stepUp.status, 200);
    const enable = await raw('POST', '/v1/auth/totp/enable', { cookie: jarString(stepUp.jar) });
    rep.check('TOTP enabled', enable.status, 200);
    const totpSecret = enable.data?.totpURI
      ? new URL(enable.data.totpURI).searchParams.get('secret')
      : null;
    rep.check('enable returns a TOTP secret', typeof totpSecret, 'string');
    const verified = await authCall(
      'POST',
      '/api/auth/two-factor/verify-totp',
      { code: totpNow(totpSecret) },
      stepUp.jar,
      base
    );
    rep.check('the first TOTP code verifies', verified.status, 200);

    const totpReq = await requestAndCapture(totpAccount.email);
    rep.check('request for the TOTP account -> 202', totpReq.res.status, 202);
    const totpLink = tokenFrom(mail[mail.length - 1]);
    const totpConsume = await raw('POST', '/v1/auth/magic-link/consume', {
      body: { token: totpLink?.token },
    });
    rep.check(
      'TOTP consume returns the same challenge shape as a passkey',
      [totpConsume.status, totpConsume.data?.twoFactorRedirect, totpConsume.data?.twoFactorMethods],
      [200, true, ['totp']]
    );
    const sessionCookies = totpConsume.cookies.filter((cookie) => cookie.includes('session_token='));
    rep.check(
      'TOTP consume leaves no usable session cookie',
      sessionCookies.some((cookie) => cookie.split(';')[0].split('=')[1] !== ''),
      false
    );
    rep.check(
      'any session cookie on the challenge is explicitly expired',
      sessionCookies.every((cookie) => /Max-Age=0/.test(cookie)),
      true
    );
    rep.check(
      'TOTP consume sets a two_factor cookie',
      totpConsume.cookies.some((cookie) => cookie.includes('two_factor=')),
      true
    );
    const challengeJar = new Map();
    absorbCookies(challengeJar, totpConsume.cookies);
    const codeVerified = await authCall(
      'POST',
      '/api/auth/two-factor/verify-totp',
      { code: totpNow(totpSecret) },
      challengeJar,
      base
    );
    rep.check('the challenge code completes the sign-in -> 200', codeVerified.status, 200);
    rep.check('…and mints a session', typeof sessionCookieOf(codeVerified.cookies), 'string');

    // ---- 7. no sender: mode says false, request still 202, no mail ---------
    await stopWorker(server);
    server = await startWorker({ sender: false, label: 'no sender' });

    const offMode = await raw('GET', '/v1/auth/mode');
    rep.check('mode without a sender -> 200', offMode.status, 200);
    rep.check('mode says magic_link:false', offMode.data?.magic_link, false);
    rep.check('mode still reports the default TTL', offMode.data?.magic_link_ttl_s, 900);

    const beforeOff = mail.length;
    const offReq = await requestAndCapture(known.email, false);
    rep.check('a request without a sender still answers 202', offReq.res.status, 202);
    rep.check('…with the same body', offReq.res.data, { ok: true });
    rep.check('…and sends nothing', mail.length, beforeOff);
    const logDeadline = Date.now() + 2_000;
    while (!server.log().includes('[mail] mail disabled') && Date.now() < logDeadline) {
      await sleep(25);
    }
    rep.check('the no-op sender logs "mail disabled"', server.log().includes('[mail] mail disabled'), true);

    await stopWorker(server);
  } finally {
    for (const server of servers) {
      await stopWorker(server).catch(() => {});
    }
    await new Promise((resolve) => capture.close(resolve));
    fs.rmSync(stateDir, { recursive: true, force: true });
  }

  const allOk = rep.print();
  console.log(allOk ? 'MAGIC CASES PASSED' : 'MAGIC CASES FAILED');
  process.exit(allOk ? 0 : 1);
}

/* ──────────────────────── pepper rotation command ─────────────────────────── */

const ROTATE_PORT = Number(process.env.PASSWORD_ROTATE_PORT ?? 8799);

/**
 * Pepper rotation, end to end, with its own `wrangler dev` lifecycle.
 *
 * A pepper version only changes meaning when the SECRET changes, so a live
 * Worker cannot exercise "v1 row, v2 ring" in place. This command therefore:
 *
 *   1. starts a Worker with a v1-only ring and sets a password (row p=1);
 *   2. restarts it with v2,v1 — the row still verifies through the v1 entry:
 *      that is the rotation window, and the old pepper is still doing its job;
 *   3. calls /v1/admin/auth/rotate-pepper with v2 (installed -> confirmed) and
 *      with a v3 that is not installed (returns the ring to install, writes
 *      nothing);
 *   4. signs in again: the row re-wraps to p=2 at sign-in (AUTH_PLAN §8), and
 *      /salt then reports pepper_version 2;
 *   5. restarts with the v2-only ring and signs in once more, proving the old
 *      pepper can be dropped.
 *
 * It needs BETTER_AUTH_SECRET and ADMIN_TOKEN in worker/.dev.vars, and a free
 * port (PASSWORD_ROTATE_PORT, default 8799). D1 state is isolated under
 * /tmp/opencode so a running dev server is untouched.
 */
async function cmdPasswordRotate() {
  const { spawn, spawnSync } = await import('node:child_process');
  const workerDir = path.join(HERE, 'worker');
  const stateDir = path.join('/tmp/opencode', `dakflare-rotate-${Date.now()}`);
  const base = `http://127.0.0.1:${ROTATE_PORT}`;
  const rep = new Report('pepper-rotation');
  const servers = [];

  const startWorker = async (pepper, label) => {
    const proc = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', [
      'wrangler', 'dev', '--local',
      '--port', String(ROTATE_PORT),
      '--persist-to', stateDir,
      '--var', `AUTH_BASE_URL:${base}`,
      '--var', `AUTH_PEPPER:${pepper}`,
      '--var', 'AUTH_PASSWORD_MODE:client-derived',
      '--var', 'AUTH_TRUSTED_ORIGINS:' + base,
    ], { cwd: workerDir, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });

    let log = '';
    proc.stdout.on('data', (chunk) => { log += chunk; });
    proc.stderr.on('data', (chunk) => { log += chunk; });
    const server = { proc, label, log: () => log };
    servers.push(server);

    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) throw new Error(`${label}: wrangler dev exited (${proc.exitCode})\n${log.slice(-4000)}`);
      try {
        const res = await fetch(`${base}/v1/admin/health`, {
          headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
        });
        if (res.ok) return server;
      } catch { /* not listening yet */ }
      await sleep(400);
    }
    throw new Error(`${label}: wrangler dev did not become ready\n${log.slice(-4000)}`);
  };

  const stopWorker = async (server) => {
    if (server.proc.exitCode !== null) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { server.proc.kill('SIGKILL'); } catch { /* gone */ }
        resolve();
      }, 10_000);
      server.proc.once('exit', () => { clearTimeout(timer); resolve(); });
      server.proc.kill('SIGTERM');
    });
    await sleep(500);
  };

  const pepperA = crypto.randomBytes(32);
  const pepperB = crypto.randomBytes(32);
  const pepperC = crypto.randomBytes(32);
  const ringV1 = `v1:${b64Of(pepperA)}`;
  const ringV2 = `v2:${b64Of(pepperB)},v1:${b64Of(pepperA)}`;

  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const migrate = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', [
      'wrangler', 'd1', 'migrations', 'apply', 'sms_gateway', '--local', '--persist-to', stateDir,
    ], { cwd: workerDir, encoding: 'utf8' });
    if (migrate.status !== 0) {
      throw new Error(`wrangler d1 migrations apply failed:\n${migrate.stderr ?? ''}${migrate.stdout ?? ''}`);
    }

    // ---- 1. a row sealed with v1 -----------------------------------------
    let server = await startWorker(ringV1, 'ring v1');
    const email = `rotate-${Date.now()}-${crypto.randomBytes(3).toString('hex')}@example.test`;
    const password = 'rotation test password';

    const inviteRes = await fetch(`${base}/v1/admin/invites`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ADMIN_TOKEN}`,
        'X-Dakflare-Client': 'cli',
      },
      body: JSON.stringify({ email, role: 'admin', expires_in_s: 300 }),
    });
    const invite = await inviteRes.json().catch(() => null);
    rep.check('invite created on the v1 ring', inviteRes.status, 200);

    const redeemRes = await fetch(`${base}/v1/auth/redeem`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: invite?.token }),
    });
    const redeemCookies = redeemRes.headers.getSetCookie?.() ?? [];
    const redeem = await redeemRes.json().catch(() => null);
    const session = sessionCookieOf(redeemCookies);
    rep.check('account created on the v1 ring', redeemRes.status, 200);
    rep.check('redeem session cookie present', typeof session, 'string');

    const salt1 = await (await fetch(`${base}/v1/auth/salt`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }),
    })).json();
    rep.check('v1 salt is reported as pepper_version 1', salt1?.pepper_version, 1);
    const material = pwMaterial(password, Buffer.from(salt1.salt, 'base64'), salt1.iterations);
    const setRes = await fetch(`${base}/v1/auth/password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: session },
      body: JSON.stringify({ material: b64Of(material), salt: salt1.salt, iterations: salt1.iterations }),
    });
    rep.check('password set on the v1 ring', setRes.status, 200);

    await stopWorker(server);

    // ---- 2. install v2, keep v1: the rotation window ----------------------
    server = await startWorker(ringV2, 'ring v2,v1');
    const signIn = async () => await fetch(`${base}/v1/auth/sign-in/password`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, material: b64Of(material) }),
    });

    // Nothing has signed in since the restart, so the row is still sealed with v1.
    const saltWindow = await (await fetch(`${base}/v1/auth/salt`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }),
    })).json();
    rep.check('after installing v2 the untouched row is still p=1', saltWindow?.pepper_version, 1);

    const adminCall = async (pathname, body) => {
      const res = await fetch(base + pathname, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ADMIN_TOKEN}`,
          'X-Dakflare-Client': 'cli',
        },
        body: JSON.stringify(body),
      });
      return { status: res.status, data: await res.json().catch(() => null) };
    };

    const confirmed = await adminCall('/v1/admin/auth/rotate-pepper', { pepper: b64Of(pepperB) });
    rep.check('rotate with the installed active pepper -> 200', confirmed.status, 200);
    rep.check('rotate confirms it is installed', confirmed.data?.installed, true);
    rep.check('rotate reports the pending p=1 row', confirmed.data?.pending, 1);
    rep.check('rotate does not rewrite rows eagerly', confirmed.data?.migrated, 0);

    const proposed = await adminCall('/v1/admin/auth/rotate-pepper', { pepper: b64Of(pepperC) });
    rep.check('rotate with an uninstalled pepper -> 200 (proposal)', proposed.status, 200);
    rep.check('…reports installed=false', proposed.data?.installed, false);
    rep.check('…returns the ring to install', proposed.data?.ring,
      `v3:${b64Of(pepperC)},v2:${b64Of(pepperB)},v1:${b64Of(pepperA)}`);

    // ---- 3. sign in: the row re-wraps to v2 ------------------------------
    // This is the rotation window: v1 is no longer active but is still in the
    // ring, so the p=1 row verifies; success re-derives the outer layer with v2.
    const inWindow = await signIn();
    rep.check('a p=1 row still verifies while v1 is in the ring', inWindow.status, 200);
    const saltAfter = await (await fetch(`${base}/v1/auth/salt`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }),
    })).json();
    rep.check('sign-in re-wrapped the row to pepper_version 2', saltAfter?.pepper_version, 2);

    const settled = await adminCall('/v1/admin/auth/rotate-pepper', { pepper: b64Of(pepperB) });
    rep.check('rotate now reports no pending rows', settled.data?.pending, 0);

    await stopWorker(server);

    // ---- 4. drop v1: the row is fully migrated ---------------------------
    server = await startWorker(`v2:${b64Of(pepperB)}`, 'ring v2 only');
    const finalSignIn = await signIn();
    rep.check('sign-in still works with the old pepper removed', finalSignIn.status, 200);

    await stopWorker(server);
  } finally {
    for (const server of servers) {
      await stopWorker(server).catch(() => {});
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
  }

  const allOk = rep.print();
  console.log(allOk ? 'PEPPER ROTATION CASES PASSED' : 'PEPPER ROTATION CASES FAILED');
  process.exit(allOk ? 0 : 1);
}

/* ─────────────────────── global lockout command ──────────────────────────── */

const LOCKOUT_GLOBAL_PORT = Number(process.env.LOCKOUT_GLOBAL_PORT ?? 8797);

/**
 * The failed-auth window used to be isolate memory, so an attacker rotating
 * Cloudflare locations got a fresh 5-failure budget at each. It now lives in one
 * globally named AuthGuard Durable Object.
 *
 * Local `wrangler dev` runs one isolate per process. This command therefore
 * starts a Worker, records three failures, stops it (which discards the isolate
 * cache), starts a second process on the same persisted D1/DO state, and records
 * two more: the fifth is still 429. A third restart then shows the lock itself
 * survives, and a success clears it in the object, not just in one process's
 * memory.
 *
 * Two simultaneous `wrangler dev` processes are deliberately not used: each
 * owns its own Miniflare and they would contend on the same local DO SQLite file.
 * The restart exercises exactly the property that matters — the counter is not
 * in the isolate — without that flake.
 */
async function cmdLockoutGlobal() {
  const { spawn, spawnSync } = await import('node:child_process');
  const workerDir = path.join(HERE, 'worker');
  const stateDir = path.join('/tmp/opencode', `dakflare-lockout-${Date.now()}`);
  const base = `http://127.0.0.1:${LOCKOUT_GLOBAL_PORT}`;
  const rep = new Report('lockout-global');
  const servers = [];

  const pepper = 'v1:' + crypto.createHash('sha256').update('lockout-global-pepper').digest('base64');
  const secret = crypto.randomBytes(32).toString('base64');

  const startWorker = async (label) => {
    const proc = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', [
      'wrangler', 'dev', '--local',
      '--port', String(LOCKOUT_GLOBAL_PORT),
      '--persist-to', stateDir,
      '--var', `AUTH_BASE_URL:${base}`,
      '--var', `AUTH_TRUSTED_ORIGINS:${base}`,
      '--var', `BETTER_AUTH_SECRET:${secret}`,
      '--var', `AUTH_PEPPER:${pepper}`,
      '--var', 'AUTH_PASSWORD_MODE:client-derived',
      '--var', 'AUTH_LOCKOUT_WINDOW_SECONDS:20',
      '--var', `ADMIN_TOKEN:${ADMIN_TOKEN}`,
    ], { cwd: workerDir, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });

    let log = '';
    proc.stdout.on('data', (chunk) => { log += chunk; });
    proc.stderr.on('data', (chunk) => { log += chunk; });
    const server = { proc, label, log: () => log };
    servers.push(server);

    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) {
        throw new Error(`${label}: wrangler dev exited (${proc.exitCode})\n${log.slice(-4000)}`);
      }
      try {
        const res = await fetch(`${base}/v1/admin/health`, {
          headers: {
            Authorization: `Bearer ${ADMIN_TOKEN}`,
            'X-Dakflare-Client': 'cli',
          },
        });
        if (res.ok) return server;
      } catch { /* not listening yet */ }
      await sleep(400);
    }
    throw new Error(`${label}: wrangler dev did not become ready\n${log.slice(-4000)}`);
  };

  const stopWorker = async (server) => {
    if (server.proc.exitCode !== null) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { server.proc.kill('SIGKILL'); } catch { /* gone */ }
        resolve();
      }, 10_000);
      server.proc.once('exit', () => { clearTimeout(timer); resolve(); });
      server.proc.kill('SIGTERM');
    });
    await sleep(500);
  };

  const adminAt = async (method, pathname, body) => {
    const res = await fetch(base + pathname, {
      method,
      headers: {
        Authorization: `Bearer ${ADMIN_TOKEN}`,
        'X-Dakflare-Client': 'cli',
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  };

  const raw = (method, pathname, opts) => api(base, method, pathname, opts);

  let server = null;
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    const migrate = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', [
      'wrangler', 'd1', 'migrations', 'apply', 'sms_gateway', '--local', '--persist-to', stateDir,
    ], { cwd: workerDir, encoding: 'utf8' });
    if (migrate.status !== 0) {
      throw new Error(`wrangler d1 migrations apply failed:\n${migrate.stderr ?? ''}${migrate.stdout ?? ''}`);
    }

    const email = `global-lock-${Date.now()}-${crypto.randomBytes(3).toString('hex')}@example.test`;
    const password = 'correct horse battery staple';
    const wrongMaterial = crypto.randomBytes(32);

    server = await startWorker('first isolate');
    const invite = await adminAt('POST', '/v1/admin/invites', {
      email,
      role: 'admin',
      expires_in_s: 300,
    });
    rep.check('lockout-global: invite created', invite.status, 200);
    const redeemed = await raw('POST', '/v1/auth/redeem', { body: { token: invite.data?.token } });
    rep.check('lockout-global: invite redeemed', redeemed.status, 200);
    const session = sessionCookieOf(redeemed.cookies);
    const saltRes = await raw('POST', '/v1/auth/salt', { body: { email } });
    const salt = Buffer.from(saltRes.data?.salt ?? '', 'base64');
    const iterations = saltRes.data?.iterations ?? PW_ITERATIONS;
    const material = pwMaterial(password, salt, iterations);
    const set = await raw('POST', '/v1/auth/password', {
      cookie: session,
      body: { material: b64Of(material), salt: b64Of(salt), iterations },
    });
    rep.check('lockout-global: password set', set.status, 200);

    const signIn = (candidate, ip) => raw('POST', '/v1/auth/sign-in/password', {
      body: { email, material: b64Of(candidate) },
      headers: { 'CF-Connecting-IP': ip },
    });

    const ipA = `198.51.100.${(crypto.randomBytes(1)[0] % 200) + 10}`;
    const first = [];
    for (let i = 0; i < 3; i += 1) first.push(await signIn(wrongMaterial, ipA));
    rep.check('lockout-global: three failures on the first process -> 401', first.map((r) => r.status), [401, 401, 401]);

    // Stopping wrangler dev discards the isolate-local cache. A second process
    // reads the same persisted Durable Object.
    await stopWorker(server);
    server = await startWorker('second isolate');
    const ipB = `203.0.113.${(crypto.randomBytes(1)[0] % 200) + 10}`;
    const fourth = await signIn(wrongMaterial, ipB);
    const fifth = await signIn(wrongMaterial, ipB);
    rep.check('lockout-global: the fourth failure overall -> 401', fourth.status, 401);
    rep.check('lockout-global: the fifth failure overall, on a new process -> 429', fifth.status, 429);
    rep.check(
      'lockout-global: the 429 carries Retry-After',
      Number(fifth.headers?.get?.('retry-after')),
      fifth.data?.retry_after
    );
    const lockWindow = Number(fifth.data?.retry_after ?? 1);

    // A third process has an empty cache: the lock must come from the object.
    await stopWorker(server);
    server = await startWorker('third isolate');
    const correctDuring = await signIn(material, ipB);
    rep.check('lockout-global: the lock survives a third process (correct password still 429)', correctDuring.status, 429);

    await sleep((lockWindow + 1) * 1000);
    const correctAfter = await signIn(material, ipB);
    rep.check('lockout-global: correct password after the window -> 200', correctAfter.status, 200);
    const afterClear = await signIn(wrongMaterial, ipB);
    rep.check('lockout-global: the success cleared the account in the object (next wrong -> 401)', afterClear.status, 401);

    await stopWorker(server);
  } finally {
    for (const running of servers) {
      await stopWorker(running).catch(() => {});
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
  }

  const allOk = rep.print();
  console.log(allOk ? 'GLOBAL LOCKOUT CASES PASSED' : 'GLOBAL LOCKOUT CASES FAILED');
  process.exit(allOk ? 0 : 1);
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
  auth: cmdAuth,
  password: cmdPassword,
  'lockout-global': cmdLockoutGlobal,
  'password-rotate': cmdPasswordRotate,
  magic: cmdMagic,
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
