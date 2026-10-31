#!/usr/bin/env node
/**
 * dakflare — operate a self-hosted DakFlare deployment.
 *
 * Zero dependencies, Node 22+ (global `fetch`, `node:crypto`, `node:fs`).
 *
 * The CLI talks to exactly one Worker, the one in
 * ~/.config/dakflare/config.json. It never contacts Cloudflare's API, never
 * deploys, and never prints the admin token. `init --local` is the one command
 * that writes a secret file, and it generates fresh values rather than reading
 * an existing secret.
 *
 * Exit codes: 0 ok, 1 a check or request failed, 2 usage / missing config /
 * missing local tool, 3 not found (device, command), 75 a --wait budget ran out
 * with the command still in flight. `status` and `send --wait` exit from the
 * outcome rather than the request: see `outcomeExitCode`.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createQr, renderQr } from '../lib/qr.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_VERSION = '0.1.0';

const HOME = os.homedir();
const CONFIG_DIR = path.join(HOME, '.config', 'dakflare');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const KEYSTORE_FILE = path.join(CONFIG_DIR, 'dakflare-release.jks');
const KEYSTORE_PROPS = path.join(CONFIG_DIR, 'release-keystore.txt');

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_PAIR_TTL_S = 600;
const DEFAULT_PHONE_MAX_AGE_MIN = 60;
const MAX_LABEL_CHARS = 64;
const MAX_BODY_CHARS = 4096;
/** Mirrors worker/src/lib/config.ts. */
const MAX_IDEMPOTENCY_KEY_CHARS = 128;
/** How long `send` waits when the caller does not say. */
const SEND_WAIT_MS = 10_000;

const REQUIRED_BINDINGS = [
  'DB',
  'KV',
  'DEVICE',
  'PAIR_LIMITER',
  'PAIR_GLOBAL_LIMITER',
  'ADMIN_LIMITER',
  'DEVICE_LIMITER',
  'AUTH_FAIL_LIMITER',
];

/* ───────────────────────────── output ───────────────────────────── */

/**
 * Colour, in three layers, so a role is named once and rendered once.
 *
 * The semantic token is what every call site uses; the primitive (an SGR code,
 * or nothing) is chosen here from the terminal and the mode. Nothing outside
 * this block may name a colour.
 */
const TRUECOLOR = {
  ok: '31,107,69',
  warn: '122,83,16',
  fail: '178,59,32',
  muted: '107,97,83',
  accent: '178,59,32',
};
const ANSI16 = { ok: '32', warn: '33', fail: '31', muted: '2', accent: '31' };

/** Set once by `main`; `--agent` turns colour, prompts and pretty JSON off. */
let AGENT = false;

/** The output mode for this run: pretty `--json`, or compact `--agent`. */
let MODE = { json: false, agent: false };

function colorMode() {
  if (AGENT || process.env.NO_COLOR) return 'none';
  if (!process.stdout.isTTY) return 'none';
  if (String(process.env.COLORTERM ?? '').toLowerCase().includes('truecolor')) return 'truecolor';
  return 'ansi';
}

function paint(role, text) {
  const mode = colorMode();
  if (mode === 'none') return text;
  const code = mode === 'truecolor' ? `38;2;${TRUECOLOR[role]}` : ANSI16[role];
  return `\x1b[${code}m${text}\x1b[0m`;
}

const ok = (text) => paint('ok', text);
const warn = (text) => paint('warn', text);
const fail = (text) => paint('fail', text);
const muted = (text) => paint('muted', text);

const out = (text = '') => process.stdout.write(`${text}\n`);
const err = (text = '') => process.stderr.write(`${text}\n`);

// A pipe that closes early (`dakflare pair --qr | head`) is normal, not an
// unhandled socket error.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error) => {
    if (error?.code === 'EPIPE') process.exit(0);
    throw error;
  });
}

class CliError extends Error {
  constructor(message, code = 1, payload = {}) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.payload = payload;
  }
}

const usage = (message) => new CliError(message, 2, { error: 'usage' });

/**
 * What each failure means, in one table.
 *
 * `CliError` carries a code; the exit status, the category an agent groups by,
 * whether waiting could help, and the command that usually fixes it are all
 * derived from here. Keeping them in one place is what stops the exit code and
 * the envelope from disagreeing about the same error.
 */
const ERROR_RULES = {
  usage: { exit: 2, category: 'usage' },
  no_config: { exit: 2, category: 'usage', remediation: 'dakflare init', fix: 'write the config' },
  token_file: { exit: 2, category: 'usage' },
  confirmation_required: { exit: 2, category: 'usage', remediation: 'dakflare revoke <device-id> --yes', fix: 'confirm non-interactively' },
  keytool_missing: { exit: 2, category: 'tooling', remediation: 'install a JDK', fix: 'keytool is not on PATH' },

  device_unknown: { exit: 3, category: 'not_found', remediation: 'dakflare devices', fix: 'list the paired devices' },
  command_unknown: { exit: 3, category: 'not_found', remediation: 'dakflare devices', fix: 'find the command id' },
  unknown_command: { exit: 3, category: 'not_found', remediation: 'dakflare capabilities', fix: 'list the commands' },
  not_registered: { exit: 3, category: 'not_found', remediation: 'dakflare auth bootstrap --email you@example.com', fix: 'create the owner account' },
  keystore_missing: { exit: 3, category: 'not_found' },
  fingerprint_missing: { exit: 3, category: 'not_found' },

  unauthorized: { exit: 4, category: 'permission', remediation: 'dakflare init', fix: 're-verify the admin token' },

  exists: { exit: 5, category: 'conflict' },

  no_device: { exit: 6, category: 'precondition', remediation: 'dakflare pair', fix: 'pair a handset first' },
  bad_health: { exit: 6, category: 'precondition', remediation: 'dakflare doctor --json', fix: 'see which check fails' },
  keystore_password_missing: { exit: 6, category: 'precondition' },
  keytool_failed: { exit: 6, category: 'precondition' },
  revoke_failed: { exit: 6, category: 'precondition' },

  network: { exit: 75, category: 'temporary', retryable: true },

  internal: { exit: 1, category: 'internal' },
  bad_response: { exit: 1, category: 'internal' },
  cancelled: { exit: 1, category: 'internal' },
};

const DEFAULT_ERROR_RULE = { exit: 1, category: 'internal', retryable: false };

/** Commands whose repetition can cause a second real-world effect. */
const MUTATING = new Set(['send', 'revoke', 'auth', 'init', 'pair']);

const ruleFor = (code) => ERROR_RULES[code] ?? DEFAULT_ERROR_RULE;

/** The exit status for a failure code, so call sites never pick a number. */
const exitCodeFor = (code) => ruleFor(code).exit;

/**
 * `--json` asks for a document; `--agent` asks for the same document without the
 * bytes an agent does not need. Both mean "no prose on stdout".
 */
function outputMode(flags) {
  const agent = flags.agent === true;
  return { agent, json: agent || flags.json === true };
}

/* ───────────────────────── command surface ───────────────────────── */

/**
 * What every command accepts, in data rather than in prose.
 *
 * `assertFlags` reads this, so a flag cannot be accepted by one path and absent
 * from `capabilities`; `capabilities`, `describe`, `schema` and `examples` read
 * the same entries. Help text stays prose, because a person reads it.
 *
 * `effect` is what an agent needs before it calls anything: `read` changes
 * nothing, `mutating` changes local or deployment state, `destructive` cannot be
 * undone.
 */
const COMMAND_SPECS = {
  init: {
    summary: 'Verify a Worker and save its admin token',
    effect: 'mutating',
    usage: 'dakflare init [--url <url>] [--token <token> | --token-file <path>] [--local] [--force]',
    flags: {
      url: { type: 'string', note: 'Worker base URL' },
      token: { type: 'string', note: 'admin token; prefer --token-file' },
      'token-file': { type: 'string', note: 'read the admin token from a file' },
      local: { type: 'boolean', note: 'write worker/.dev.vars instead of contacting a Worker' },
      force: { type: 'boolean', note: 'with --local, replace an existing .dev.vars' },
    },
    examples: [
      'dakflare init --url https://dakflare-worker.example.workers.dev --token-file ~/.token',
      'dakflare init --local',
    ],
  },
  doctor: {
    summary: 'Check config, edge, schema, migrations, bindings and the handset',
    effect: 'read',
    usage: 'dakflare doctor [--max-age <minutes>] [--serial <adb-serial>]',
    flags: {
      'max-age': { type: 'number', note: 'how stale a phone contact may be, default 60' },
      serial: { type: 'string', note: 'adb serial for the phone checks' },
    },
    examples: ['dakflare doctor --json', 'dakflare doctor --serial 100.110.66.88:5555'],
  },
  pair: {
    summary: 'Mint a pairing code for a handset',
    effect: 'mutating',
    usage: 'dakflare pair [--label <text>] [--qr] [--ttl <seconds>]',
    flags: {
      label: { type: 'string', note: 'name the device in the fleet list' },
      qr: { type: 'boolean', note: 'render the code as a terminal QR' },
      ttl: { type: 'number', note: 'code lifetime in seconds, default 600' },
    },
    examples: ['dakflare pair --qr', 'dakflare pair --label "Mi A3" --ttl 300 --json'],
  },
  devices: {
    summary: 'List paired devices and their last contact',
    effect: 'read',
    usage: 'dakflare devices',
    flags: {},
    examples: ['dakflare devices', 'dakflare devices --agent'],
  },
  revoke: {
    summary: 'Revoke one device; the phone must pair again',
    effect: 'destructive',
    usage: 'dakflare revoke <device-id> [--yes]',
    flags: { yes: { type: 'boolean', note: 'skip the confirmation prompt' } },
    examples: ['dakflare revoke dev_pixel4a --yes'],
  },
  send: {
    summary: 'Queue one outbound SMS and follow it to the radio',
    effect: 'mutating',
    usage:
      'dakflare send --to <e164> --body <text> [--device <id>] [--no-wait] [--wait [duration]] [--until <state>] [--idempotency-key <k>]',
    flags: {
      to: { type: 'string', required: true, note: 'E.164 recipient' },
      body: { type: 'string', required: true, note: 'message text, max 4096 characters' },
      device: { type: 'string', note: 'send through this device; default is the freshest' },
      'no-wait': { type: 'boolean', note: 'queue and return immediately' },
      wait: { type: 'duration', note: 'how long to follow it, default 10s, max 5m' },
      until: { type: 'state', note: 'pending|dispatched|acked|sent|delivered, default sent' },
      'idempotency-key': { type: 'string', note: 'a retry with the same key returns the same command' },
    },
    examples: [
      'dakflare send --to +8801540196080 --body "deploy ack"',
      'dakflare send --to +8801540196080 --body "ack" --idempotency-key ci-1234 --agent',
      'dakflare send --to +8801540196080 --body "ack" --no-wait',
    ],
  },
  status: {
    summary: "Read one command's state, or follow it",
    effect: 'read',
    usage: 'dakflare status <command-id> [--device <id>] [--wait [duration]] [--until <state>]',
    flags: {
      device: { type: 'string', note: 'the phone that owns the command' },
      wait: { type: 'duration', note: 'follow it, default 30s' },
      until: { type: 'state', note: 'pending|dispatched|acked|sent|delivered, default delivered' },
    },
    examples: [
      'dakflare status 6cb13963-f33c-49d0-b87f-2cc72844a426',
      'dakflare status <id> --wait 60s --until delivered --agent',
    ],
  },
  audit: {
    summary: 'Read the audit log',
    effect: 'read',
    usage: 'dakflare audit [--tail [n]] [--actor <label>] [--limit <n>]',
    flags: {
      tail: { type: 'number', note: 'tail mode; the optional value is the row count' },
      actor: { type: 'string', note: 'filter by actor label' },
      limit: { type: 'number', note: 'rows, 1-1000, default 50' },
    },
    examples: ['dakflare audit --tail 5', 'dakflare audit --limit 100 --actor owner --json'],
  },
  auth: {
    summary: 'Owner bootstrap, invites and recovery (bootstrap|invite|invites|reset)',
    effect: 'mutating',
    usage: 'dakflare auth <bootstrap|invite|invites|reset> [options]',
    flags: {
      email: { type: 'string', note: 'the account address' },
      role: { type: 'string', note: 'owner|admin|member, invite only' },
      ttl: { type: 'number', note: 'invite lifetime in seconds' },
      yes: { type: 'boolean', note: 'reset: skip the confirmation' },
    },
    examples: [
      'dakflare auth bootstrap --email you@example.com',
      'dakflare auth invite --email teammate@example.com --role member',
    ],
  },
  capabilities: {
    summary: 'List every command with its effect and flags',
    effect: 'read',
    usage: 'dakflare capabilities',
    flags: {},
    examples: ['dakflare capabilities --agent'],
  },
  describe: {
    summary: 'Purpose, usage and flags for one command',
    effect: 'read',
    usage: 'dakflare describe <command>',
    flags: {},
    examples: ['dakflare describe send'],
  },
  schema: {
    summary: 'The flag contract for one command, with types',
    effect: 'read',
    usage: 'dakflare schema <command>',
    flags: {},
    examples: ['dakflare schema send --agent'],
  },
  examples: {
    summary: 'Real invocations for one command, including a failing one',
    effect: 'read',
    usage: 'dakflare examples <command>',
    flags: {},
    examples: ['dakflare examples send'],
  },
  key: {
    summary: "Print the release signing key's SHA-256 fingerprint",
    effect: 'read',
    usage: 'dakflare key fingerprint [--keystore <path>] [--alias <name>]',
    flags: {
      keystore: { type: 'string', note: 'path to the keystore' },
      alias: { type: 'string', note: 'key alias, default dakflare' },
    },
    examples: ['dakflare key fingerprint', 'dakflare key fingerprint --json'],
  },
};

/** The flags a command accepts, in the order it declares them. */
const flagNames = (command) => Object.keys(COMMAND_SPECS[command]?.flags ?? {});

/** `assertFlags`, but the allowed list comes from the spec. */
function assertCommandFlags(flags, command) {
  const known = new Set(['json', 'agent', 'help', ...flagNames(command)]);
  for (const key of Object.keys(flags)) {
    if (!known.has(key)) throw usage(`unknown option --${key}`);
  }
}

/* ───────────────────────────── envelope ───────────────────────────── */

/** Which command is running, for the envelope. Set once by `main`. */
let CURRENT_COMMAND = null;

function baseContext() {
  const { cfg } = readConfig();
  return { profile: 'default', worker_url: cfg?.url ?? null };
}

/**
 * The one error document. Every field an agent needs to decide what to do next:
 * what failed, whether waiting helps, whether repeating is safe, and the command
 * that usually fixes it.
 */
function errorEnvelope(payload) {
  const code = typeof payload?.error === 'string' ? payload.error : 'internal';
  const rule = ruleFor(code);
  const retryable = rule.retryable === true;
  const { ok: _ok, error: _code, message, ...details } = payload ?? {};
  return {
    schema_version: '1',
    status: 'error',
    command: CURRENT_COMMAND,
    context: baseContext(),
    error: {
      code,
      category: rule.category,
      message: typeof message === 'string' ? message : code,
      retryable,
      // A retry of a mutating command can cause a second SMS or a second
      // revocation, so "could waiting help" and "is repeating safe" are only the
      // same answer for reads.
      safe_to_retry: retryable && !MUTATING.has(CURRENT_COMMAND),
      ...(rule.remediation === undefined
        ? {}
        : { remediation: [{ command: rule.remediation, description: rule.fix ?? '' }] }),
      ...(Object.keys(details).length === 0 ? {} : { details }),
    },
  };
}

/**
 * Print one result document. Pretty for a person reading `--json`, compact for
 * `--agent`, and identical in content: the envelope is not a different shape per
 * mode, only a different number of bytes.
 */
function emitJson(payload, mode) {
  let envelope;
  if (payload?.ok === false) {
    envelope = errorEnvelope(payload);
  } else {
    const { ok: _ok, verification, warnings, summary, context, ...data } = payload ?? {};
    envelope = {
      schema_version: '1',
      status: 'ok',
      command: CURRENT_COMMAND,
      ...(summary === undefined ? {} : { summary }),
      context: context ?? baseContext(),
      data,
      verification: verification ?? null,
      warnings: warnings ?? [],
    };
  }
  out(JSON.stringify(envelope, null, mode.agent ? 0 : 2));
}



/* ───────────────────────────── flags ───────────────────────────── */

const VALUE_FLAGS = new Set([
  'url',
  'token',
  'token-file',
  'label',
  'device',
  'to',
  'body',
  'actor',
  'limit',
  'ttl',
  'email',
  'role',
  'expires-in',
  'max-age',
  'serial',
  'keystore',
  'alias',
  'tail',
  'wait',
  'until',
  'idempotency-key',
]);

function parseArgv(argv) {
  const flags = Object.create(null);
  const rest = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (arg === '-h') {
      flags.help = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
        continue;
      }
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (VALUE_FLAGS.has(key) && next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
      continue;
    }
    rest.push(arg);
  }

  return { flags, rest };
}

function assertFlags(flags, allowed) {
  const known = new Set(['json', 'agent', 'help', ...allowed]);
  for (const key of Object.keys(flags)) {
    if (!known.has(key)) throw usage(`unknown option --${key}`);
  }
}

function stringFlag(flags, name, { required = false } = {}) {
  const value = flags[name];
  if (value === undefined) {
    if (required) throw usage(`--${name} is required`);
    return undefined;
  }
  if (value === true || value === '') throw usage(`--${name} needs a value`);
  return String(value);
}

/* ───────────────────────────── config ───────────────────────────── */

function readConfig() {
  let raw;
  try {
    raw = fs.readFileSync(CONFIG_FILE, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { cfg: null, reason: 'missing', detail: CONFIG_FILE };
    return { cfg: null, reason: 'unreadable', detail: String(error?.message ?? error) };
  }
  try {
    const cfg = JSON.parse(raw);
    if (!cfg || typeof cfg !== 'object') throw new Error('not an object');
    return { cfg, reason: null, detail: CONFIG_FILE };
  } catch (error) {
    return { cfg: null, reason: 'invalid', detail: String(error?.message ?? error) };
  }
}

function configMode() {
  try {
    return fs.statSync(CONFIG_FILE).mode & 0o777;
  } catch {
    return null;
  }
}

function modeString(mode) {
  return mode === null ? 'unknown' : mode.toString(8).padStart(3, '0');
}

function saveConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(CONFIG_DIR, 0o700);
  } catch {
    /* best effort on filesystems without POSIX modes */
  }

  const temporary = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(temporary, 0o600);
  } catch {
    /* best effort */
  }
  fs.renameSync(temporary, CONFIG_FILE);
  try {
    fs.chmodSync(CONFIG_FILE, 0o600);
  } catch {
    /* best effort */
  }
}

function requireConfig() {
  const { cfg, reason } = readConfig();
  if (!cfg) {
    const why =
      reason === 'invalid'
        ? `the config at ${CONFIG_FILE} is not valid JSON`
        : `no deployment is configured (${CONFIG_FILE} is missing)`;
    throw new CliError(`${why} — run \`dakflare init\` first.`, 2, { error: 'no_config' });
  }
  if (typeof cfg.url !== 'string' || cfg.url === '' || typeof cfg.token !== 'string' || cfg.token === '') {
    throw new CliError(
      `the config at ${CONFIG_FILE} needs both "url" and "token" — run \`dakflare init\` again.`,
      2,
      { error: 'no_config' }
    );
  }
  return { ...cfg, url: cfg.url.replace(/\/+$/, '') };
}

/* ───────────────────────────── HTTP ───────────────────────────── */

async function api(cfg, method, pathname, body, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
  const base = cfg.url.replace(/\/+$/, '');
  const target = `${base}${pathname}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  let response;
  try {
    response = await fetch(target, {
      method,
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Accept: 'application/json',
        'X-Dakflare-Client': 'cli',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    const reason =
      error?.name === 'AbortError'
        ? `request timed out after ${Math.round(timeout / 1000)}s`
        : String(error?.message ?? error);
    throw new CliError(
      `cannot reach ${base} — ${reason}. Check the Worker URL and your connection.`,
      1,
      { error: 'network', url: base }
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  let data = null;
  if (text !== '') {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  return { status: response.status, data, text, headers: response.headers };
}

function apiErrorBody(data, status) {
  if (data && typeof data === 'object' && typeof data.error === 'string') return data.error;
  return `HTTP ${status}`;
}

/** Convert a response into a useful message without ever including the token. */
function requestFailure(what, result) {
  const detail = apiErrorBody(result.data, result.status);
  return new CliError(`${what} failed: ${detail} (HTTP ${result.status})`, 1, {
    error: detail,
    status: result.status,
  });
}

async function fetchHealth(cfg) {
  const started = Date.now();
  const result = await api(cfg, 'GET', '/v1/admin/health');
  return { ...result, elapsedMs: Date.now() - started };
}

async function listDevices(cfg) {
  const result = await api(cfg, 'GET', '/v1/devices');
  if (result.status === 401) {
    throw new CliError('the deployment rejected the admin token (HTTP 401).', 1, {
      error: 'unauthorized',
      status: 401,
    });
  }
  if (result.status !== 200) throw requestFailure('listing devices', result);
  const devices = Array.isArray(result.data?.devices) ? result.data.devices : [];
  return devices;
}

function publicDevice(device) {
  return {
    device_id: device.device_id,
    label: device.label ?? null,
    sim_slot: device.sim_slot ?? null,
    paired_at: device.paired_at ?? null,
    last_seen: device.last_seen ?? null,
    fcm: Boolean(device.fcm_token),
  };
}

/* ───────────────────────────── formatting ───────────────────────────── */

function iso(value) {
  if (value === null || value === undefined) return 'never';
  const date = new Date(Number(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function ageSeconds(value) {
  if (value === null || value === undefined) return null;
  const delta = Date.now() - Number(value);
  return Number.isFinite(delta) ? Math.max(0, Math.round(delta / 1000)) : null;
}

function humanAge(seconds) {
  if (seconds === null) return 'never';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function pad(text, width) {
  const value = String(text ?? '');
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

function plural(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

/* ───────────────────────────── prompts ───────────────────────────── */

async function ask(question) {
  if (!process.stdin.isTTY) throw usage(`${question.replace(/: $/, '')} needs a value (pass the flag)`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    return String(await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function askHidden(question) {
  if (!process.stdin.isTTY) throw usage(`${question.replace(/: $/, '')} needs a value (pass --token)`);
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let value = '';
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
    };
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === '\r' || character === '\n') {
          cleanup();
          process.stderr.write('\n');
          resolve(value);
          return;
        }
        if (character === '\u0003') {
          cleanup();
          process.stderr.write('\n');
          reject(new CliError('cancelled', 130, { error: 'cancelled' }));
          return;
        }
        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= ' ') value += character;
      }
    };
    stdin.on('data', onData);
  });
}

async function confirm(question) {
  // `--agent` never prompts, even on a terminal: a mode that can block on input
  // is not a mode an agent can use.
  if (AGENT || !process.stdin.isTTY) {
    throw new CliError('refusing to continue without confirmation; pass --yes for a non-interactive run.', 2, {
      error: 'confirmation_required',
    });
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = String(await rl.question(question)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

/* ───────────────────────────── init ───────────────────────────── */

function findWorkerDir() {
  const candidates = [
    path.join(process.cwd(), 'worker'),
    process.cwd(),
    path.resolve(__dirname, '..', '..', 'worker'),
  ];
  for (const directory of candidates) {
    if (fs.existsSync(path.join(directory, 'wrangler.toml'))) return directory;
  }
  return null;
}

function findingsFromHealth(health) {
  const bindings = health.bindings ?? {};
  const missingRequired = REQUIRED_BINDINGS.filter((name) => !bindings[name]);
  const fcm = Boolean(bindings.FCM_SERVICE_ACCOUNT);
  const plan = health.plan ?? health.plan_type ?? health.cloudflare_plan ?? null;
  return {
    version: health.version ?? 'unknown',
    schema_ready: health.schema_ready === true,
    migrations: Array.isArray(health.migrations) ? health.migrations : [],
    missing_required: missingRequired,
    fcm,
    plan,
    retention_days: health.retention_days ?? null,
    counts: health.counts ?? null,
  };
}

function printFindings(findings) {
  out(`  version       ${findings.version}`);
  out(`  schema        ${findings.schema_ready ? 'ready' : 'NOT READY'}`);
  out(`  migrations    ${findings.migrations.length ? `${plural(findings.migrations.length, 'migration')} applied` : 'none applied'}`);
  out(
    `  bindings      ${
      findings.missing_required.length === 0
        ? 'all required present'
        : `missing ${findings.missing_required.join(', ')}`
    }${findings.fcm ? '; FCM present' : '; FCM absent (optional)'}`
  );
  out(
    `  plan          ${
      findings.plan === null
        ? 'not reported by /v1/admin/health (Cloudflare plan is not exposed)'
        : String(findings.plan)
    }`
  );
  if (findings.retention_days !== null) out(`  retention     ${findings.retention_days} days`);
  if (findings.counts) {
    out(
      `  counts        devices ${findings.counts.devices ?? '?'} · messages ${findings.counts.messages ?? '?'} · rules ${findings.counts.rules ?? '?'}`
    );
  }
}

async function initLocal(flags, json) {
  const workerDir = findWorkerDir();
  const directory = workerDir ?? process.cwd();
  const file = path.join(directory, '.dev.vars');

  if (fs.existsSync(file) && !flags.force) {
    throw new CliError(
      `${file} already exists; pass --force to replace the generated values (this rotates local secrets).`,
      2,
      { error: 'exists', file }
    );
  }

  const generated = {
    ADMIN_TOKEN: `dk_adm_${crypto.randomBytes(32).toString('base64url')}`,
    AUTH_PEPPER: `v1:${crypto.randomBytes(32).toString('base64')}`,
    BETTER_AUTH_SECRET: crypto.randomBytes(32).toString('base64'),
  };

  let existing = '';
  if (fs.existsSync(file)) {
    existing = fs.readFileSync(file, 'utf8');
  }
  const managed = new Set(Object.keys(generated));
  const kept = existing
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .filter((line) => {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=/);
      return !(match && managed.has(match[1]));
    });
  const content = [...kept, ...Object.entries(generated).map(([key, value]) => `${key}=${value}`)].join('\n');

  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${content}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }

  if (json) {
    out(emitJson({
          ok: true,
          local: true,
          file,
          mode: '600',
          generated: Object.keys(generated),
          widths: Object.fromEntries(Object.entries(generated).map(([key, value]) => [key, value.length])),
        }, MODE));
    return 0;
  }

  out('DakFlare local secrets');
  out(`  file          ${file} (mode 600)`);
  for (const key of Object.keys(generated)) out(`  ${pad(key, 21)} generated (${generated[key].length} chars)`);
  out('');
  out('  Values are not printed. Start local development with:');
  out(`    cd ${path.relative(process.cwd(), directory) || '.'} && npx wrangler dev --local`);
  return 0;
}

async function commandInit(argv) {
  const { flags } = parseArgv(argv);
  if (flags.help) return printHelp('init');
  assertCommandFlags(flags, 'init');
  const json = MODE.json;

  if (flags.local) return initLocal(flags, json);

  let url = stringFlag(flags, 'url');
  let token = stringFlag(flags, 'token');

  if (flags['token-file'] !== undefined) {
    const file = stringFlag(flags, 'token-file');
    try {
      token = fs.readFileSync(file, 'utf8').trim();
    } catch (error) {
      throw new CliError(`could not read --token-file ${file}: ${String(error?.message ?? error)}`, 2, {
        error: 'token_file',
      });
    }
    if (token === '') throw usage(`--token-file ${file} is empty`);
  }

  if (!json) {
    if (!url) url = await ask('Worker URL (https://…workers.dev): ');
    if (!token) token = await askHidden('Admin token (input hidden): ');
  }

  if (!url) throw usage('--url is required when not running interactively');
  if (!token) throw usage('--token or --token-file is required when not running interactively');

  if (!/^https?:\/\//i.test(url)) throw usage('the Worker URL must start with http:// or https://');
  url = url.replace(/\/+$/, '');

  const candidate = { url, token, installedAt: new Date().toISOString() };
  const result = await fetchHealth(candidate);

  if (result.status === 401 || result.status === 403) {
    throw new CliError(
      `the deployment rejected that admin token (HTTP ${result.status}). Check ADMIN_TOKEN for ${url}.`,
      1,
      { error: 'unauthorized', status: result.status }
    );
  }
  if (result.status !== 200 && result.status !== 503) {
    throw requestFailure('health check', result);
  }
  if (!result.data || typeof result.data !== 'object') {
    throw new CliError(`${url}/v1/admin/health did not return JSON; is that a DakFlare Worker?`, 1, {
      error: 'bad_health',
      status: result.status,
    });
  }

  saveConfig(candidate);
  const findings = findingsFromHealth(result.data);
  const healthy = result.data.ok === true;

  if (json) {
    out(emitJson({
          ok: healthy,
          url,
          config: { path: CONFIG_FILE, mode: modeString(configMode()) },
          health: {
            status: result.status,
            version: findings.version,
            schema_ready: findings.schema_ready,
            migrations: findings.migrations,
            missing_bindings: result.data.missing_bindings ?? findings.missing_required,
            plan: findings.plan,
          },
        }, MODE));
    return healthy ? 0 : 1;
  }

  out(`DakFlare init — ${url}`);
  printFindings(findings);
  out(`  config        ${CONFIG_FILE} (mode ${modeString(configMode())})`);
  out('  token         stored; never printed');
  out('');
  if (healthy) {
    out(ok('  configured.') + ' Next: `dakflare doctor`, then `dakflare pair`.');
  } else {
    out(
      warn('  saved, but the deployment is not healthy.') +
        (result.data.db_error ? ` D1 said: ${result.data.db_error}` : '') +
        ' Run `dakflare doctor`.'
    );
  }
  return healthy ? 0 : 1;
}

/* ───────────────────────────── doctor ───────────────────────────── */

function expectedMigrations() {
  const candidates = [
    path.resolve(__dirname, '..', '..', 'worker', 'migrations'),
    path.join(process.cwd(), 'worker', 'migrations'),
    path.join(process.cwd(), 'migrations'),
  ];
  for (const directory of candidates) {
    try {
      const names = fs
        .readdirSync(directory)
        .filter((name) => name.endsWith('.sql'))
        .sort();
      if (names.length > 0) return { directory, names };
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

function adbBinary() {
  return process.env.ADB || 'adb';
}

function runAdb(args, timeout = 8000) {
  return spawnSync(adbBinary(), args, { encoding: 'utf8', timeout });
}

function adbPresence() {
  const result = runAdb(['version'], 5000);
  if (result.error?.code === 'ENOENT') return { available: false, reason: 'adb is not installed' };
  if (result.error?.code === 'ETIMEDOUT') return { available: false, reason: 'adb did not answer' };
  if (result.status !== 0) {
    const detail = String(result.stderr || '')
      .trim()
      .split('\n')
      .slice(-1)[0];
    return { available: false, reason: `adb is not usable${detail ? `: ${detail}` : ''}` };
  }
  return { available: true };
}

function attachedDevice(preferredSerial) {
  const result = runAdb(['devices'], 8000);
  if (result.error || result.status !== 0) return null;
  const lines = String(result.stdout || '')
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean);
  const devices = lines
    .map((line) => line.split(/\s+/))
    .filter((parts) => parts.length >= 2)
    .map(([serial, state]) => ({ serial, state }));

  if (preferredSerial) return devices.find((device) => device.serial === preferredSerial) ?? null;
  if (process.env.ANDROID_SERIAL) {
    return devices.find((device) => device.serial === process.env.ANDROID_SERIAL) ?? null;
  }
  return devices.find((device) => device.state === 'device') ?? devices[0] ?? null;
}

function adbShell(serial, command, timeout = 8000) {
  return runAdb(['-s', serial, 'shell', ...command], timeout);
}

function classifyBuild(dump) {
  const flags = dump.match(/^\s*flags=\[([^\]]*)\]/m);
  const debuggable = flags ? /\bDEBUGGABLE\b/.test(flags[1]) : false;
  const versionName = dump.match(/versionName=(\S+)/)?.[1] ?? 'unknown';
  const versionCode = dump.match(/versionCode=(\d+)/)?.[1] ?? 'unknown';
  return { debuggable, versionName, versionCode };
}

function probePhone(checks, serialFlag, json) {
  const presence = adbPresence();
  if (!presence.available) {
    checks.push({ name: 'phone-role', status: 'skip', detail: presence.reason });
    checks.push({ name: 'phone-build', status: 'skip', detail: presence.reason });
    return;
  }

  const device = attachedDevice(serialFlag);
  if (!device) {
    checks.push({ name: 'phone-role', status: 'skip', detail: 'no adb device attached' });
    checks.push({ name: 'phone-build', status: 'skip', detail: 'no adb device attached' });
    return;
  }
  if (device.state !== 'device') {
    checks.push({ name: 'phone-role', status: 'skip', detail: `${device.serial} is ${device.state}, not ready` });
    checks.push({ name: 'phone-build', status: 'skip', detail: `${device.serial} is ${device.state}, not ready` });
    return;
  }

  const packagesResult = adbShell(device.serial, ['pm', 'list', 'packages'], 8000);
  const packages = String(packagesResult.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^package:/, ''))
    .filter((name) => /dakflare/i.test(name));

  if (packages.length === 0) {
    checks.push({
      name: 'phone-role',
      status: 'fail',
      detail: `${device.serial}: no DakFlare package installed`,
    });
    checks.push({ name: 'phone-build', status: 'skip', detail: 'no DakFlare package installed' });
    return;
  }

  const roleResult = adbShell(device.serial, ['cmd', 'role', 'get-role-holders', 'android.app.role.SMS'], 8000);
  const roleText = String(roleResult.stdout || '');
  const holders = roleText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const rolePackage = packages.find((name) => holders.includes(name)) ?? packages[0];
  if (roleResult.status !== 0 || roleText.trim() === '') {
    checks.push({
      name: 'phone-role',
      status: 'skip',
      detail: `${device.serial}: cmd role is unavailable on this Android build`,
    });
  } else if (holders.includes(rolePackage)) {
    checks.push({
      name: 'phone-role',
      status: 'pass',
      detail: `${device.serial}: android.app.role.SMS -> ${holders.join(', ')}`,
    });
  } else {
    checks.push({
      name: 'phone-role',
      status: 'fail',
      detail: `${device.serial}: android.app.role.SMS -> ${holders.join(', ') || '<none>'}; expected ${rolePackage}`,
    });
  }

  const dumpResult = adbShell(device.serial, ['dumpsys', 'package', rolePackage], 10_000);
  const dump = String(dumpResult.stdout || '');
  if (dumpResult.status !== 0 || dump.trim() === '') {
    checks.push({ name: 'phone-build', status: 'skip', detail: `could not read ${rolePackage} package info` });
    return;
  }
  const build = classifyBuild(dump);
  checks.push({
    name: 'phone-build',
    status: 'pass',
    detail: `${rolePackage}: ${build.debuggable ? 'debug (debuggable)' : 'release (not debuggable)'} v${build.versionName} (${build.versionCode})`,
  });
}

async function commandDoctor(argv) {
  const { flags } = parseArgv(argv);
  if (flags.help) return printHelp('doctor');
  assertCommandFlags(flags, 'doctor');
  const json = MODE.json;
  const serialFlag = stringFlag(flags, 'serial');
  const maxAgeFlag = stringFlag(flags, 'max-age');
  const maxAgeMinutes = maxAgeFlag === undefined ? DEFAULT_PHONE_MAX_AGE_MIN : Number(maxAgeFlag);
  if (!Number.isFinite(maxAgeMinutes) || maxAgeMinutes <= 0) {
    throw usage('--max-age must be a positive number of minutes');
  }

  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });

  const { cfg, reason } = readConfig();
  const mode = configMode();

  if (!cfg) {
    add(
      'config',
      'fail',
      reason === 'invalid'
        ? `${CONFIG_FILE} is not valid JSON — run \`dakflare init\``
        : `${CONFIG_FILE} is missing — run \`dakflare init\``
    );
    return finishDoctor(checks, json, null);
  }

  if (typeof cfg.url !== 'string' || cfg.url === '' || typeof cfg.token !== 'string' || cfg.token === '') {
    add('config', 'fail', `${CONFIG_FILE} needs both "url" and "token" — run \`dakflare init\``);
    return finishDoctor(checks, json, null);
  }

  const url = cfg.url.replace(/\/+$/, '');
  if (process.platform !== 'win32' && mode !== null && (mode & 0o077) !== 0) {
    add('config', 'fail', `${CONFIG_FILE} mode ${modeString(mode)}; expected 600 — run \`chmod 600 ${CONFIG_FILE}\``);
  } else {
    add('config', 'pass', `${url} (${CONFIG_FILE}, mode ${modeString(mode)})`);
  }

  const normalized = { ...cfg, url };
  let health;
  try {
    health = await fetchHealth(normalized);
  } catch (error) {
    add('health', 'fail', error.message);
    addSkippedDependents(add, 'health is unreachable');
    return finishDoctor(checks, json, url);
  }

  if (health.status === 401 || health.status === 403) {
    add('health', 'fail', `HTTP ${health.status} — admin token rejected`);
    add('admin-token', 'fail', 'rejected by /v1/admin/health (HTTP 401/403)');
    addSkippedDependents(add, 'the admin token was rejected');
    return finishDoctor(checks, json, url);
  }

  if (health.status !== 200 && health.status !== 503) {
    add('health', 'fail', `HTTP ${health.status} (${
      health.data && typeof health.data === 'object' && health.data.error ? health.data.error : 'unexpected response'
    })`);
    addSkippedDependents(add, `health returned HTTP ${health.status}`);
    return finishDoctor(checks, json, url);
  }

  add(
    'health',
    'pass',
    `HTTP ${health.status} in ${health.elapsedMs}ms${health.status === 503 ? ' (the Worker reports itself unhealthy)' : ''}`
  );

  const data = health.data;
  if (!data || typeof data !== 'object') {
    add('admin-token', 'fail', 'the health response was not JSON');
    addSkippedDependents(add, 'the health response was not JSON');
    return finishDoctor(checks, json, url);
  }

  add('admin-token', 'pass', `accepted (HTTP ${health.status})`);

  add(
    'schema',
    data.schema_ready === true ? 'pass' : 'fail',
    data.schema_ready === true ? 'ready (d1_migrations present and counts readable)' : 'not ready — apply D1 migrations'
  );

  const expected = expectedMigrations();
  const applied = Array.isArray(data.migrations) ? data.migrations : [];
  if (!expected) {
    add(
      'migrations',
      'skip',
      applied.length > 0
        ? `${plural(applied.length, 'migration')} reported applied; local worker/migrations not found, so completeness is unverified`
        : 'local worker/migrations not found and the Worker reports none applied'
    );
  } else {
    const missing = expected.names.filter((name) => !applied.includes(name));
    if (missing.length === 0) {
      add('migrations', 'pass', `${applied.length}/${expected.names.length} applied`);
    } else {
      add(
        'migrations',
        'fail',
        `missing ${missing.length === 1 ? missing[0] : `${missing.length}: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? '…' : ''}`}`
      );
    }
  }

  const bindings = data.bindings ?? {};
  const missingRequired = REQUIRED_BINDINGS.filter((name) => !bindings[name]);
  add(
    'bindings',
    missingRequired.length === 0 ? 'pass' : 'fail',
    missingRequired.length === 0
      ? 'DB, KV, DEVICE and all rate limiters present'
      : `missing ${missingRequired.join(', ')}`
  );
  add(
    'fcm-binding',
    bindings.FCM_SERVICE_ACCOUNT ? 'pass' : 'skip',
    bindings.FCM_SERVICE_ACCOUNT
      ? 'FCM service account present'
      : 'not configured (optional; devices are reachable only while their socket is open)'
  );

  const authMode = data.auth_mode ?? data.authMode ?? null;
  if (authMode === null) {
    add('auth-mode', 'skip', 'not reported by this deployment (the tiered auth modes are phase 2)');
  } else if (['legacy', 'new', 'off', 'client-derived', 'server-kdf'].includes(String(authMode))) {
    add('auth-mode', 'pass', String(authMode));
  } else {
    add('auth-mode', 'fail', `unknown AUTH_MODE "${String(authMode)}"`);
  }

  add(
    'd1',
    data.db_error === null && data.counts ? 'pass' : 'fail',
    data.db_error === null && data.counts
      ? `reachable — devices ${data.counts.devices ?? '?'} · messages ${data.counts.messages ?? '?'} · rules ${data.counts.rules ?? '?'}`
      : `unreachable${data.db_error ? `: ${String(data.db_error).slice(0, 180)}` : ''}`
  );

  let devices = [];
  try {
    devices = await listDevices(normalized);
  } catch (error) {
    add('phone', 'fail', error.message);
    devices = null;
  }

  if (devices) {
    if (devices.length === 0) {
      add('phone', 'skip', 'no paired devices — run `dakflare pair`');
    } else {
      const freshest = devices
        .map((device) => ({ device, seconds: ageSeconds(device.last_seen) }))
        .filter((entry) => entry.seconds !== null)
        .sort((a, b) => a.seconds - b.seconds)[0];

      if (!freshest) {
        add('phone', 'fail', `${plural(devices.length, 'device')} paired, but none has ever contacted the Worker`);
      } else {
        const label = freshest.device.label ? ` (${freshest.device.label})` : '';
        const detail = `${freshest.device.device_id}${label}: last contact ${humanAge(freshest.seconds)}`;
        if (freshest.seconds <= maxAgeMinutes * 60) add('phone', 'pass', detail);
        else add('phone', 'fail', `${detail}; older than ${maxAgeMinutes}m — is the gateway running?`);
      }
    }
  }

  probePhone(checks, serialFlag, json);
  return finishDoctor(checks, json, url, data.version);
}

function addSkippedDependents(add, why) {
  add('schema', 'skip', `not evaluated: ${why}`);
  add('migrations', 'skip', `not evaluated: ${why}`);
  add('bindings', 'skip', `not evaluated: ${why}`);
  add('fcm-binding', 'skip', `not evaluated: ${why}`);
  add('auth-mode', 'skip', `not evaluated: ${why}`);
  add('d1', 'skip', `not evaluated: ${why}`);
  add('phone', 'skip', `not evaluated: ${why}`);
  add('phone-role', 'skip', `not evaluated: ${why}`);
  add('phone-build', 'skip', `not evaluated: ${why}`);
}

function finishDoctor(checks, json, url, version) {
  // `counts` in the data, `summary` in the envelope: the envelope's summary is
  // one line of prose, and two fields with that name would collide.
  const counts = {
    pass: checks.filter((check) => check.status === 'pass').length,
    fail: checks.filter((check) => check.status === 'fail').length,
    skip: checks.filter((check) => check.status === 'skip').length,
  };
  const healthy = counts.fail === 0;

  if (json) {
    out(emitJson({
          ok: healthy,
          url: url ?? null,
          version: version ?? null,
          checked_at: new Date().toISOString(),
          checks,
          summary: `${counts.pass} passed, ${counts.fail} failed, ${counts.skip} skipped`,
          counts,
        }, MODE));
    if (!healthy) process.exitCode = 1;
    return;
  }

  out(`DakFlare doctor${url ? ` — ${url}` : ''}`);
  for (const check of checks) {
    const tag =
      check.status === 'pass'
        ? ok('[PASS]')
        : check.status === 'fail'
          ? fail('[FAIL]')
          : warn('[SKIP]');
    out(`${tag} ${pad(check.name, 14)} ${check.detail}`);
  }
  out('');
  out(
    `doctor: ${counts.pass} pass, ${counts.fail} fail, ${counts.skip} skip` +
      (healthy ? '' : ` — ${fail('not healthy')}`)
  );
  if (!healthy) process.exitCode = 1;
}

/* ───────────────────────────── pair ───────────────────────────── */

function qrText(text) {
  // Prefer the system encoder: it handles every payload length and is what an
  // operator's terminal expects. Fall back to the built-in encoder.
  const result = spawnSync('qrencode', ['-t', 'UTF8', '-m', '2', '-l', 'L', '-o', '-'], {
    input: text,
    encoding: 'utf8',
    timeout: 5000,
  });
  if (!result.error && result.status === 0 && String(result.stdout || '').trim() !== '') {
    return String(result.stdout).replace(/\s+$/, '');
  }
  return renderQr(createQr(text));
}

async function commandPair(argv) {
  const { flags } = parseArgv(argv);
  if (flags.help) return printHelp('pair');
  assertCommandFlags(flags, 'pair');
  const json = MODE.json;
  const cfg = requireConfig();
  const label = stringFlag(flags, 'label');
  if (label !== undefined) {
    if (/[\u0000-\u001f\u007f]/.test(label)) throw usage('--label must not contain control characters');
    if (label.length > MAX_LABEL_CHARS) throw usage(`--label is limited to ${MAX_LABEL_CHARS} characters`);
  }
  const ttlFlag = stringFlag(flags, 'ttl');
  const ttl = ttlFlag === undefined ? DEFAULT_PAIR_TTL_S : Number(ttlFlag);
  if (!Number.isFinite(ttl) || ttl < 1 || ttl > 86_400) throw usage('--ttl must be between 1 and 86400 seconds');

  const result = await api(cfg, 'POST', '/v1/admin/pairing-code', {
    ttl_ms: Math.round(ttl * 1000),
    ...(label === undefined ? {} : { label }),
  });
  if (result.status !== 200) throw requestFailure('minting a pairing code', result);

  const code = result.data?.pairing_code;
  if (typeof code !== 'string' || code === '') {
    throw new CliError('the Worker did not return a pairing_code', 1, { error: 'bad_response' });
  }
  const expiresAt = result.data?.expires_at ?? Date.now() + ttl * 1000;
  const deepLink = `dakflare://pair?u=${encodeURIComponent(cfg.url)}&c=${encodeURIComponent(code)}`;
  const qr = flags.qr ? qrText(deepLink) : null;

  if (json) {
    out(emitJson({
          ok: true,
          pairing_code: code,
          expires_at: expiresAt,
          expires_at_iso: iso(expiresAt),
          ttl_seconds: ttl,
          deep_link: deepLink,
          label: label ?? null,
          ...(qr ? { qr } : {}),
        }, MODE));
    return;
  }

  out('Pair a device');
  out(`  code          ${code}`);
  out(`  expires       ${iso(expiresAt)} (${plural(ttl, 'second')})`);
  out(`  link          ${deepLink}`);
  if (label !== undefined) {
    out(`  label         ${label}`);
    out('  note          this Worker revision does not persist pairing labels; the phone reports its own on pair.');
  }
  if (qr) {
    out('');
    out(qr);
  }
  out('');
  out('  Open the link on the phone, or enter the URL and code in the app.');
}

/* ───────────────────────────── devices ───────────────────────────── */

async function commandDevices(argv) {
  const { flags } = parseArgv(argv);
  if (flags.help) return printHelp('devices');
  assertCommandFlags(flags, 'devices');
  const json = MODE.json;
  const cfg = requireConfig();

  const devices = (await listDevices(cfg)).map(publicDevice);
  if (json) {
    out(emitJson({ ok: true, devices }, MODE));
    return;
  }

  out(`Devices (${devices.length})`);
  if (devices.length === 0) {
    out('  no paired devices — run `dakflare pair`');
    return;
  }

  const idWidth = Math.max(9, ...devices.map((device) => String(device.device_id).length));
  const labelWidth = Math.max(5, ...devices.map((device) => String(device.label ?? '—').length));
  out(
    `  ${pad('ID', idWidth)}  ${pad('LABEL', labelWidth)}  SIM  LAST SEEN`
  );
  for (const device of devices) {
    const seconds = ageSeconds(device.last_seen);
    out(
      `  ${pad(device.device_id, idWidth)}  ${pad(device.label ?? '—', labelWidth)}  ${pad(
        device.sim_slot ?? '—',
        3
      )}  ${iso(device.last_seen)} (${humanAge(seconds)})`
    );
  }
}

/* ───────────────────────────── revoke ───────────────────────────── */

async function commandRevoke(argv) {
  const { flags, rest } = parseArgv(argv);
  if (flags.help) return printHelp('revoke');
  assertCommandFlags(flags, 'revoke');
  const json = MODE.json;
  const cfg = requireConfig();

  const deviceId = rest[0];
  if (!deviceId) throw usage('usage: dakflare revoke <device-id> [--yes]');
  if (rest.length > 1) throw usage('revoke takes exactly one device id');

  const devices = (await listDevices(cfg)).map(publicDevice);
  const target = devices.find((device) => device.device_id === deviceId);
  if (!target) {
    throw new CliError(
      `no paired device with id "${deviceId}" — run \`dakflare devices\` to list them.`,
      1,
      { error: 'device_unknown' }
    );
  }

  const seconds = ageSeconds(target.last_seen);
  if (!flags.yes) {
    const confirmed = await confirm(
      `Revoke ${target.device_id}${target.label ? ` (${target.label})` : ''}, last seen ${humanAge(seconds)}?\n` +
        'This deletes its D1 row and wipes its Durable Object (queued commands, keys, nonces). [y/N] '
    );
    if (!confirmed) {
      out('not revoked.');
      return;
    }
  }

  const result = await api(cfg, 'DELETE', `/v1/admin/devices/${encodeURIComponent(deviceId)}`);
  if (result.status !== 200) {
    if (result.status === 502) {
      throw new CliError(
        'revoke_failed (HTTP 502): the Durable Object refused the revocation, so the device may still authenticate. Nothing was deleted in D1.',
        1,
        { error: 'revoke_failed', status: 502 }
      );
    }
    throw requestFailure('revoking the device', result);
  }

  const d1Deleted = Number(result.data?.d1_deleted ?? 0);
  if (json) {
    out(emitJson({ ok: true, device_id: deviceId, d1_deleted: d1Deleted }, MODE));
    return;
  }
  out(`revoked ${deviceId} (D1 rows deleted: ${d1Deleted})`);
}

/* ────────────────────────── command state ────────────────────────── */

/**
 * The command state machine, mirrored from `worker/src/durable-object.ts`
 * (`ALLOWED_PREDECESSORS`). The CLI does not invent vocabulary here: it reports
 * the state the Worker stores and says what that state means to a caller.
 *
 * `SENT` is deliberately NOT terminal. The radio accepting a message is not the
 * carrier delivering it, and this is the one place in the product that would
 * overstate delivery if it treated them as the same event.
 */
const COMMAND_STATES = {
  PENDING: { rank: 0, terminal: false, meaning: 'waiting for the phone to collect it' },
  DISPATCHED: { rank: 1, terminal: false, meaning: 'handed to the phone, no acknowledgement yet' },
  ACKED_BY_DEVICE: { rank: 2, terminal: false, meaning: 'the phone acknowledged it and is sending' },
  SENT: { rank: 3, terminal: false, meaning: 'the radio accepted it; delivery is not claimed' },
  DELIVERED: { rank: 4, terminal: true, meaning: 'a carrier report confirmed delivery' },
  FAILED: { rank: 4, terminal: true, meaning: 'the radio or the carrier refused it' },
  EXPIRED: { rank: 4, terminal: true, meaning: 'it expired before the phone collected it' },
};

const UNKNOWN_STATE = { rank: -1, terminal: false, meaning: 'a state this CLI does not know; upgrade it' };

const stateMeta = (state) => COMMAND_STATES[state] ?? UNKNOWN_STATE;

/** `--until` takes the word a caller would say, not the wire spelling. */
const UNTIL_ALIASES = {
  pending: 'PENDING',
  dispatched: 'DISPATCHED',
  acked: 'ACKED_BY_DEVICE',
  acknowledged: 'ACKED_BY_DEVICE',
  sent: 'SENT',
  delivered: 'DELIVERED',
};

const WAIT_DEFAULT_MS = 30_000;
const WAIT_MAX_MS = 300_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * `30s`, `2m`, `500ms`, or a bare number of seconds. Clamped on purpose: an agent
 * that passes `--wait 3600` gets a bounded call, not a hung one.
 */
function parseDuration(value, { fallbackMs = WAIT_DEFAULT_MS } = {}) {
  if (value === undefined || value === true) return fallbackMs;
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i.exec(String(value).trim());
  if (!match) throw usage(`--wait expects a duration like 30s or 2m, got "${value}"`);
  const amount = Number(match[1]);
  const unit = (match[2] ?? 's').toLowerCase();
  const ms =
    unit === 'ms' ? amount
      : unit === 's' ? amount * 1000
        : unit === 'm' ? amount * 60_000
          : amount * 3_600_000;
  if (!Number.isFinite(ms) || ms <= 0) throw usage('--wait must be a positive duration');
  return Math.min(Math.round(ms), WAIT_MAX_MS);
}

/**
 * Which phone a command goes through. `send` and `status` need the same answer:
 * a command id alone does not identify the Durable Object that holds it.
 *
 * With one device paired the choice is obvious. With several, the freshest one
 * wins and the caller is told, because choosing silently among equals is how a
 * message leaves from the wrong SIM.
 */
async function resolveDevice(cfg, explicitId) {
  if (explicitId) return { deviceId: explicitId, note: null };

  const devices = (await listDevices(cfg)).map(publicDevice);
  if (devices.length === 0) {
    throw new CliError('no paired device yet — run `dakflare pair` first.', 1, {
      error: 'no_device',
    });
  }
  if (devices.length === 1) return { deviceId: devices[0].device_id, note: null };

  const ranked = devices
    .map((device) => ({ device, seen: Number(device.last_seen ?? 0) }))
    .sort((a, b) => b.seen - a.seen);
  if (!ranked[0].seen) {
    throw usage(
      `multiple devices are paired and none has a last-seen time; pass --device <id> (${devices
        .map((device) => device.device_id)
        .join(', ')})`
    );
  }
  return {
    deviceId: ranked[0].device.device_id,
    note: `freshest of ${devices.length} paired devices`,
  };
}

/**
 * Reads one command straight from the owning Durable Object. A null command is
 * the Worker saying "no such command", which is exit 3 and not a usage error:
 * the call was well formed, the thing is not there.
 */
async function fetchCommand(cfg, deviceId, commandId) {
  const result = await api(
    cfg,
    'GET',
    `/v1/sms/commands/${encodeURIComponent(commandId)}?device_id=${encodeURIComponent(deviceId)}`
  );
  if (result.status === 404) {
    throw new CliError(`no command "${commandId}" on ${deviceId}.`, 3, {
      error: 'command_unknown',
      command_id: commandId,
      device_id: deviceId,
    });
  }
  if (result.status !== 200) throw requestFailure('reading the command', result);

  const command = result.data?.command;
  if (!command || typeof command.state !== 'string') {
    throw new CliError(`no command "${commandId}" on ${deviceId}.`, 3, {
      error: 'command_unknown',
      command_id: commandId,
      device_id: deviceId,
    });
  }
  return command;
}

/* Progress is a stderr line on a TTY only: stdout stays one document, and an
   agent gets silence followed by the result. */
let progressOpen = false;

function progressLine(command, startedAt) {
  if (!process.stderr.isTTY) return;
  const seconds = Math.round((Date.now() - startedAt) / 1000);
  process.stderr.write(`\r\x1b[K  waiting · ${command.state} · ${seconds}s`);
  progressOpen = true;
}

function clearProgress() {
  if (!progressOpen) return;
  process.stderr.write('\r\x1b[K');
  progressOpen = false;
}

/**
 * Polls until the command reaches `until`, reaches a terminal state, or the
 * budget runs out. The delay backs off, so a 30 s wait is ~15 requests, not 60,
 * and the admin rate limit is never the thing that fails.
 */
async function waitForCommand(cfg, deviceId, commandId, { until, budgetMs, quiet }) {
  const wanted = String(until ?? 'delivered').toLowerCase();
  const target = UNTIL_ALIASES[wanted];
  if (!target) {
    throw usage(`--until expects one of ${Object.keys(UNTIL_ALIASES).join(', ')}`);
  }
  const targetRank = stateMeta(target).rank;
  const startedAt = Date.now();
  const deadline = startedAt + budgetMs;

  const settled = (command) => {
    const meta = stateMeta(command.state);
    return meta.terminal || meta.rank >= targetRank;
  };

  let command = await fetchCommand(cfg, deviceId, commandId);
  let delay = 500;
  try {
    while (!settled(command)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { command, timedOut: true };
      if (!quiet) progressLine(command, startedAt);
      await sleep(Math.max(50, Math.min(delay, remaining)));
      delay = Math.min(Math.round(delay * 1.6), 3000);
      command = await fetchCommand(cfg, deviceId, commandId);
    }
    return { command, timedOut: false };
  } finally {
    if (!quiet) clearProgress();
  }
}

/**
 * The outcome, separated from the request. `passed` is true only on DELIVERED:
 * `SENT` means the radio took the message and the carrier has not confirmed it,
 * which is exactly what the landing page's "Not claimed" block says.
 */
function verificationFor(command, { timedOut = false } = {}) {
  const meta = stateMeta(command.state);
  const passed = command.state === 'DELIVERED' ? true : meta.terminal ? false : null;
  const reason =
    COMMAND_STATES[command.state] === undefined
      ? 'state_unknown'
      : command.state === 'DELIVERED'
      ? 'carrier_confirmed'
      : command.state === 'SENT'
        ? 'radio_accepted_delivery_not_claimed'
        : command.state === 'FAILED'
          ? 'refused'
          : command.state === 'EXPIRED'
            ? 'expired_before_collection'
            : timedOut
              ? 'timeout'
              : 'in_flight';

  return {
    passed,
    state: command.state,
    terminal: meta.terminal,
    reason,
    next_command:
      passed === true
        ? null
        : command.state === 'FAILED'
          ? 'dakflare doctor --json'
          : command.state === 'EXPIRED'
            ? null
            : `dakflare status ${command.command_id} --wait 60s --json`,
  };
}

/**
 * Exit code from the outcome, not from the request. 75 is "temporary": the
 * command is still queued, so retrying the *check* may succeed while retrying
 * the *send* would text someone twice. Callers distinguish the two by reading
 * `verification.passed`, never by re-running `send`.
 */
function outcomeExitCode(command, timedOut) {
  if (command.state === 'DELIVERED') return 0;
  if (stateMeta(command.state).terminal) return 1;
  return timedOut ? 75 : 0;
}

function renderCommand(command, { deviceId, note }) {
  const meta = stateMeta(command.state);
  out(`${command.command_id}  ${command.state}`);
  out(`  meaning       ${meta.meaning}`);
  if (command.to) out(`  to            ${command.to}`);
  out(`  device        ${deviceId}${note ? ` (${note})` : ''}`);
  if (Number.isFinite(command.created_at)) {
    const age = Math.max(0, Math.round((Date.now() - command.created_at) / 1000));
    out(`  age           ${age}s`);
  }
  if (Number.isFinite(command.expires_at)) {
    const left = Math.round((command.expires_at - Date.now()) / 1000);
    out(`  expires       ${left > 0 ? `in ${left}s` : 'already'}`);
  }
  const next = verificationFor(command).next_command;
  if (next) out(`  next          ${next}`);
}

/* ───────────────────────────── send ───────────────────────────── */

function looksLikeE164(value) {
  return /^\+[1-9]\d{6,14}$/.test(value);
}

async function commandSend(argv) {
  const { flags } = parseArgv(argv);
  if (flags.help) return printHelp('send');
  assertCommandFlags(flags, 'send');
  const json = MODE.json;
  const cfg = requireConfig();

  const to = stringFlag(flags, 'to', { required: true });
  const body = stringFlag(flags, 'body', { required: true });
  if (!looksLikeE164(to)) throw usage('--to must be an E.164 number, for example +8801540196080');
  if (body.length === 0) throw usage('--body must not be empty');
  if (body.length > MAX_BODY_CHARS) throw usage(`--body is limited to ${MAX_BODY_CHARS} characters`);

  const { deviceId, note: deviceNote } = await resolveDevice(cfg, stringFlag(flags, 'device'));

  // A retry with the same key returns the command it already created instead of
  // sending a second SMS. The key travels in the body because the device's
  // signature covers the body digest and not the headers.
  const idempotencyKey = stringFlag(flags, 'idempotency-key');
  if (idempotencyKey !== undefined && (idempotencyKey === '' || idempotencyKey.length > MAX_IDEMPOTENCY_KEY_CHARS)) {
    throw usage(`--idempotency-key must be 1 to ${MAX_IDEMPOTENCY_KEY_CHARS} characters`);
  }

  const result = await api(cfg, 'POST', '/v1/sms/send', {
    device_id: deviceId,
    to,
    body,
    ...(idempotencyKey === undefined ? {} : { idempotency_key: idempotencyKey }),
  });
  if (result.status === 404 && result.data?.error === 'device_unknown') {
    throw new CliError(
      `device_unknown — "${deviceId}" is not in the D1 registry. Run \`dakflare devices\`.`,
      1,
      { error: 'device_unknown' }
    );
  }
  if (result.status !== 200) throw requestFailure('queueing the message', result);

  const commandId = result.data?.command_id;
  if (typeof commandId !== 'string' || commandId === '') {
    throw new CliError('the Worker did not return a command_id', 1, { error: 'bad_response' });
  }
  // True when the key matched a command that already existed: nothing was
  // enqueued by this call, and the id is the original one.
  const replayed = result.data?.replayed === true;

  // A send now settles in seconds over the device socket, so waiting is the
  // useful default: `queued` alone sends the operator off to run `status`
  // anyway. `--no-wait` keeps the fire-and-forget contract for scripts.
  if (flags['no-wait'] === true && flags.wait !== undefined) {
    throw usage('--no-wait and --wait are opposites; pass one');
  }
  const wantsWait = flags['no-wait'] !== true;
  let command;
  let timedOut = false;

  if (wantsWait) {
    const waited = await waitForCommand(cfg, deviceId, commandId, {
      // `sent` by default, not `delivered`: ten seconds is enough for the radio
      // to accept a message and not enough for a carrier report, and waiting for
      // one that never comes would report every good send as a timeout.
      until: stringFlag(flags, 'until') ?? 'sent',
      budgetMs: parseDuration(flags.wait, { fallbackMs: SEND_WAIT_MS }),
      quiet: json || !process.stderr.isTTY,
    });
    command = waited.command;
    timedOut = waited.timedOut;
  } else {
    // One read, no polling. A read failure must not turn a queued command into a
    // failed send, so an unreadable state is reported as `unknown`, not thrown.
    try {
      command = await fetchCommand(cfg, deviceId, commandId);
    } catch {
      command = { command_id: commandId, state: 'unknown', to };
    }
  }

  const verification = verificationFor(command, { timedOut });

  if (json) {
    out(emitJson({
          // `ok` means the Worker answered and the command exists. The outcome is
          // `verification`, and the exit code follows it when --wait was asked for.
          ok: true,
          device_id: deviceId,
          device_selection: deviceNote,
          to,
          command_id: commandId,
          replayed,
          state: command.state,
          verification,
        }, MODE));
    process.exitCode = outcomeExitCode(command, timedOut);
    return;
  }

  out(replayed ? 'Already queued (idempotency key matched)' : 'Queued outbound message');
  out(`  command       ${commandId}`);
  out(`  device        ${deviceId}${deviceNote ? ` (${deviceNote})` : ''}`);
  out(`  to            ${to}`);
  out(`  state         ${command.state}`);
  out(`  meaning       ${stateMeta(command.state).meaning}`);
  if (verification.reason === 'timeout') {
    out(`  not confirmed the command is still queued; check it again rather than sending again`);
  }
  if (verification.next_command) out(`  next          ${verification.next_command}`);
  return outcomeExitCode(command, timedOut);
}

/* ───────────────────────────── discovery ───────────────────────────── */

/**
 * `capabilities` — every command in one screen, with what it does to the world.
 *
 * An agent should be able to pick a command from this without loading any help
 * text, so the effect is stated here rather than left to be inferred from prose.
 */
function commandCapabilities(argv) {
  const { flags } = parseArgv(argv);
  if (flags.help) return printHelp('capabilities');
  assertCommandFlags(flags, 'capabilities');

  const entries = Object.entries(COMMAND_SPECS).map(([name, spec]) => ({
    name,
    effect: spec.effect,
    summary: spec.summary,
    flags: flagNames(name),
  }));

  if (MODE.json) {
    emitJson({ ok: true, summary: `${entries.length} commands`, commands: entries }, MODE);
    return 0;
  }
  for (const entry of entries) {
    out(`${pad(entry.name, 13)} ${pad(entry.effect, 12)} ${entry.summary}`);
  }
  return 0;
}

/** Resolve the command a discovery subcommand was asked about. */
function specFor(rest) {
  const name = rest[0];
  if (!name) throw usage('which command? pass a name, for example `dakflare describe send`');
  const spec = COMMAND_SPECS[name];
  if (!spec) {
    throw new CliError(`no command "${name}".`, 3, {
      error: 'unknown_command',
      command: name,
    });
  }
  return { name, spec };
}

function commandDescribe(argv) {
  const { flags, rest } = parseArgv(argv);
  if (flags.help) return printHelp('describe');
  assertCommandFlags(flags, 'describe');
  const { name, spec } = specFor(rest);

  if (MODE.json) {
    emitJson(
      {
        ok: true,
        command: name,
        effect: spec.effect,
        usage: spec.usage,
        flags: Object.fromEntries(
          Object.entries(spec.flags).map(([flag, meta]) => [flag, meta.note ?? ''])
        ),
      },
      MODE
    );
    return 0;
  }
  out(spec.summary);
  out('');
  out(spec.usage);
  const names = Object.keys(spec.flags);
  if (names.length > 0) {
    out('');
    for (const flag of names) {
      out(`  --${pad(flag, 16)} ${spec.flags[flag].note ?? ''}`);
    }
  }
  return 0;
}

function commandSchema(argv) {
  const { flags, rest } = parseArgv(argv);
  if (flags.help) return printHelp('schema');
  assertCommandFlags(flags, 'schema');
  const { name, spec } = specFor(rest);

  const properties = Object.fromEntries(
    Object.entries(spec.flags).map(([flag, meta]) => [
      flag,
      {
        type: meta.type,
        ...(meta.required === true ? { required: true } : {}),
        description: meta.note ?? '',
      },
    ])
  );
  const schema = {
    command: name,
    effect: spec.effect,
    usage: spec.usage,
    flags: { type: 'object', properties, required: requiredFlags(name) },
    global: ['--json', '--agent', '--help'],
  };

  if (MODE.json) {
    emitJson({ ok: true, ...schema }, MODE);
    return 0;
  }
  out(JSON.stringify(schema, null, 2));
  return 0;
}

function commandExamples(argv) {
  const { flags, rest } = parseArgv(argv);
  if (flags.help) return printHelp('examples');
  assertCommandFlags(flags, 'examples');
  const { name, spec } = specFor(rest);

  if (MODE.json) {
    emitJson({ ok: true, command: name, examples: spec.examples }, MODE);
    return 0;
  }
  for (const example of spec.examples) out(example);
  return 0;
}

/** The flags a command cannot be called without. */
function requiredFlags(command) {
  return Object.entries(COMMAND_SPECS[command]?.flags ?? {})
    .filter(([, meta]) => meta.required === true)
    .map(([flag]) => `--${flag}`);
}

/* ───────────────────────────── status ───────────────────────────── */

/**
 * `dakflare status <command-id>` — the verb `send` was missing.
 *
 * Before this, `send` printed a command id that nothing in the CLI could look up
 * again, so the id was write-only and the outcome unreachable. The Worker has
 * served `GET /v1/sms/commands/:id` all along; nothing was using it.
 */
async function commandStatus(argv) {
  const { flags, rest } = parseArgv(argv);
  if (flags.help) return printHelp('status');
  assertCommandFlags(flags, 'status');
  const json = MODE.json;
  const cfg = requireConfig();

  const commandId = rest[0];
  if (!commandId) throw usage('status needs a command id: dakflare status <command-id>');
  if (rest.length > 1) throw usage(`unexpected argument "${rest[1]}"`);

  const { deviceId, note } = await resolveDevice(cfg, stringFlag(flags, 'device'));

  let command;
  let timedOut = false;
  if (flags.wait !== undefined) {
    const waited = await waitForCommand(cfg, deviceId, commandId, {
      until: stringFlag(flags, 'until'),
      budgetMs: parseDuration(flags.wait),
      quiet: json || !process.stderr.isTTY,
    });
    command = waited.command;
    timedOut = waited.timedOut;
  } else {
    command = await fetchCommand(cfg, deviceId, commandId);
  }

  const verification = verificationFor(command, { timedOut });

  if (json) {
    out(emitJson({
          ok: true,
          device_id: deviceId,
          device_selection: note,
          command_id: commandId,
          state: command.state,
          command,
          verification,
        }, MODE));
    process.exitCode = outcomeExitCode(command, timedOut);
    return;
  }

  renderCommand(command, { deviceId, note });
  return outcomeExitCode(command, timedOut);
}

/* ───────────────────────────── audit ───────────────────────────── */

/** The console's own invite URL — clickable in any browser, unlike the app scheme. */
function webInvite(base, token) {
  return `${base.replace(/\/+$/, '')}/admin/invite?code=${encodeURIComponent(token)}`;
}

async function commandAuthReset(argv) {
  const { flags } = parseArgv(argv);
  if (flags.help) return printHelp('auth');
  assertFlags(flags, ['email', 'ttl', 'yes', 'json']);
  const json = MODE.json;
  const email = stringFlag(flags, 'email');
  if (!email || !email.includes('@')) throw usage('--email is required');
  if (!flags.yes) {
    throw usage('refusing to reset an account without --yes (it deletes the account, its sessions and passkeys)');
  }
  const ttlFlag = stringFlag(flags, 'ttl');
  const ttlSeconds = ttlFlag === undefined ? 86400 : Number(ttlFlag);
  const cfg = requireConfig();

  const result = await api(cfg, 'POST', '/v1/admin/auth/reset-user', {
    email,
    expires_in_s: Math.round(ttlSeconds),
  });
  if (result.status === 404) {
    const message = 'that address has no account to reset';
    if (json) out(emitJson({ ok: false, error: 'not_registered' }, MODE));
    else out(message);
    return 1;
  }
  if (result.status !== 200) throw requestFailure('reset', result);

  const token = result.data?.token ?? null;
  const link = token ? `dakflare://invite?u=${encodeURIComponent(cfg.url)}&t=${encodeURIComponent(token)}` : null;
  if (json) out(emitJson({ ok: true, email, link }, MODE));
  else {
    out(`Account reset: ${email}`);
    if (link) {
      out(`  open           ${webInvite(cfg.url, token)}`);
      out(`  app            ${link}`);
    }
    out('  deleted        sessions, credentials, passkeys, authenticator');
    out('  next           redeem the invite and finish passkey enrolment.');
  }
  return 0;
}

async function commandAuth(argv) {
  const [sub, ...rest] = argv;
  if (!sub || sub === '--help' || sub === '-h') return printHelp('auth');
  if (sub === 'bootstrap') return commandAuthBootstrap(rest);
  if (sub === 'invite') return commandAuthInvite(rest);
  if (sub === 'invites') return commandAuthInvites(rest);
  if (sub === 'reset') return commandAuthReset(rest);
  err(`dakflare: unknown auth subcommand "${sub}"`);
  err('try `dakflare auth --help`');
  return 2;
}

/**
 * Create the first owner. The account has no credential by design: the owner
 * enrols a passkey from the console afterwards. Refused once an owner exists.
 */
async function commandAuthBootstrap(argv) {
  const { flags } = parseArgv(argv);
  if (flags.help) return printHelp('auth');
  assertFlags(flags, ['email', 'json']);
  const json = MODE.json;
  const email = stringFlag(flags, 'email');
  if (!email || !email.includes('@')) throw usage('--email is required');
  const cfg = requireConfig();

  const result = await api(cfg, 'POST', '/v1/admin/bootstrap', { email, role: 'owner' });
  if (result.status === 409) {
    const reason = result.data?.error === 'already_registered' ? 'that address already has an account' : 'an owner already exists on this deployment';
    if (json) out(emitJson({ ok: false, error: result.data?.error ?? 'owner_exists' }, MODE));
    else out(reason);
    return 1;
  }
  if (result.status !== 200) throw requestFailure('bootstrap', result);

  // The first owner is an invite, not an account: an account with no credential
  // has no way to obtain one once the flag flips. Redeeming creates it.
  const token = result.data?.token ?? null;
  const link = token ? `dakflare://invite?u=${encodeURIComponent(cfg.url)}&t=${encodeURIComponent(token)}` : null;
  if (json) out(emitJson({ ok: true, email, role: 'owner', link }, MODE));
  else {
    out(`Owner invite for ${email}`);
    if (link) {
      out(`  open           ${webInvite(cfg.url, token)}`);
      out(`  app            ${link}`);
    } else out('  link           not returned; re-run this command for a fresh one');
    out('  next           open the link, redeem it, then create a passkey.');
  }
  return 0;
}

/** Mint an invite. The link is printed once; only its hash is stored. */
async function commandAuthInvite(argv) {
  const { flags } = parseArgv(argv);
  if (flags.help) return printHelp('auth');
  assertFlags(flags, ['email', 'role', 'ttl', 'json']);
  const json = MODE.json;
  const email = stringFlag(flags, 'email');
  if (!email || !email.includes('@')) throw usage('--email is required');
  const role = stringFlag(flags, 'role') ?? 'member';
  if (!['owner', 'admin', 'member'].includes(role)) {
    throw usage('--role must be owner, admin or member');
  }
  const ttlFlag = stringFlag(flags, 'ttl');
  const ttlSeconds = ttlFlag === undefined ? 86400 : Number(ttlFlag);
  if (!Number.isFinite(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 604800) {
    throw usage('--ttl must be between 60 and 604800 seconds');
  }
  const cfg = requireConfig();

  const result = await api(cfg, 'POST', '/v1/admin/invites', {
    email,
    role,
    expires_in_s: Math.round(ttlSeconds),
  });
  if (result.status !== 200) throw requestFailure('invite', result);

  const token = result.data?.invite?.token ?? result.data?.token ?? null;
  const link = token ? `dakflare://invite?u=${encodeURIComponent(cfg.url)}&t=${encodeURIComponent(token)}` : null;
  if (json) {
    out(emitJson({ ok: true, email, role, link, expires_in: ttlSeconds }, MODE));
  } else {
    out(`Invite for ${email} (${role})`);
    if (link) {
      out(`  open           ${webInvite(cfg.url, token)}`);
      out(`  app            ${link}`);
    } else out('  link           not returned by this deployment; use `dakflare auth invites`');
    out(`  expires        in ${ttlSeconds} seconds`);
  }
  return 0;
}

async function commandAuthInvites(argv) {
  const { flags } = parseArgv(argv);
  if (flags.help) return printHelp('auth');
  assertFlags(flags, ['json']);
  const json = MODE.json;
  const cfg = requireConfig();
  const result = await api(cfg, 'GET', '/v1/admin/invites');
  if (result.status !== 200) throw requestFailure('invites', result);
  const invites = result.data?.invites ?? [];
  if (json) {
    out(emitJson({ ok: true, invites }, MODE));
    return 0;
  }
  if (invites.length === 0) {
    out('no invites');
    return 0;
  }
  out(`Invites (${invites.length})`);
  for (const invite of invites) {
    const used = invite.used_at ? 'used' : 'open';
    out(`  ${invite.email.padEnd(28)} ${String(invite.role).padEnd(9)} ${used}`);
  }
  return 0;
}

async function commandAudit(argv) {
  const { flags } = parseArgv(argv);
  if (flags.help) return printHelp('audit');
  assertCommandFlags(flags, 'audit');
  const json = MODE.json;
  const cfg = requireConfig();

  const actor = stringFlag(flags, 'actor');
  const limitFlag = stringFlag(flags, 'limit');
  let limit = limitFlag === undefined ? 50 : Number(limitFlag);
  if (typeof flags.tail === 'string') {
    if (limitFlag !== undefined) throw usage('use either --tail <n> or --limit <n>, not both');
    limit = Number(flags.tail);
  }
  if (!Number.isFinite(limit) || limit < 1 || limit > 1000) throw usage('--limit must be between 1 and 1000');

  const query = new URLSearchParams();
  query.set('limit', String(Math.round(limit)));
  if (actor !== undefined) query.set('actor', actor);
  if (flags.tail) query.set('tail', '1');

  const result = await api(cfg, 'GET', `/v1/admin/audit?${query.toString()}`);

  if (result.status === 404) {
    const message = 'not available on this deployment';
    if (json) {
      out(emitJson({ ok: true, available: false, reason: 'not_available_on_this_deployment' }, MODE));
    } else {
      out(message);
    }
    return;
  }
  if (result.status === 401) {
    throw new CliError('the deployment rejected the admin token (HTTP 401).', 1, {
      error: 'unauthorized',
      status: 401,
    });
  }
  if (result.status !== 200) throw requestFailure('reading the audit log', result);

  const entries =
    (Array.isArray(result.data) && result.data) ||
    (Array.isArray(result.data?.entries) && result.data.entries) ||
    (Array.isArray(result.data?.events) && result.data.events) ||
    (Array.isArray(result.data?.audit) && result.data.audit) ||
    (Array.isArray(result.data?.log) && result.data.log) ||
    null;

  if (json) {
    out(emitJson({ ok: true, available: true, entries: entries ?? result.data }, MODE));
    return;
  }

  if (!entries) {
    out(emitJson(result.data, MODE));
    return;
  }
  if (entries.length === 0) {
    out('audit log is empty');
    return;
  }

  out(`Audit (${entries.length})`);
  for (const entry of entries) {
    const at = entry.at ?? entry.created_at ?? entry.timestamp;
    out(
      `  ${pad(iso(at), 24)}  ${pad(entry.actor_label ?? entry.actor_user ?? '—', 20)}  ${pad(
        entry.action ?? '—',
        18
      )}  ${entry.subject ?? ''}`
    );
  }
}

/* ───────────────────────────── key fingerprint ───────────────────────────── */

function expandHome(value) {
  if (value.startsWith('~/')) return path.join(HOME, value.slice(2));
  return value;
}

function readProperties(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*)$/);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

function keytoolBinary() {
  if (process.env.KEYTOOL) return process.env.KEYTOOL;
  if (process.env.JAVA_HOME) {
    const candidate = path.join(process.env.JAVA_HOME, 'bin', 'keytool');
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'keytool';
}

async function commandKey(argv) {
  const { flags, rest } = parseArgv(argv);
  if (flags.help || rest.length === 0) return printHelp('key');
  const action = rest[0];
  if (action !== 'fingerprint') throw usage(`unknown key command "${action}"; try \`dakflare key fingerprint\``);
  assertCommandFlags(flags, 'key');
  const json = MODE.json;

  const props = readProperties(KEYSTORE_PROPS);
  const keystore = expandHome(
    stringFlag(flags, 'keystore') ?? process.env.DAKFLARE_KEYSTORE ?? props.keystore ?? KEYSTORE_FILE
  );
  const alias = stringFlag(flags, 'alias') ?? process.env.DAKFLARE_KEY_ALIAS ?? props.alias ?? 'dakflare';

  if (!fs.existsSync(keystore)) {
    throw new CliError(
      `release keystore not found: ${keystore}\nCreate it once; losing it means no in-place Android upgrades. See docs/PHONE_RELEASE.md.`,
      2,
      { error: 'keystore_missing', keystore }
    );
  }

  const password = process.env.DAKFLARE_KEYSTORE_PASSWORD ?? props.storePassword ?? '';
  if (!password) {
    throw new CliError(
      `no keystore password. Set DAKFLARE_KEYSTORE_PASSWORD or add storePassword= to ${KEYSTORE_PROPS}.`,
      2,
      { error: 'keystore_password_missing' }
    );
  }

  const keytool = keytoolBinary();
  const result = spawnSync(
    keytool,
    ['-list', '-v', '-keystore', keystore, '-storepass', password, '-alias', alias],
    { encoding: 'utf8', timeout: 15_000 }
  );

  if (result.error?.code === 'ENOENT') {
    throw new CliError(
      'keytool is not installed; install a JDK or set JAVA_HOME/KEYTOOL to read the signing certificate.',
      2,
      { error: 'keytool_missing' }
    );
  }
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '')
      .trim()
      .split('\n')
      .slice(-2)
      .join(' ')
      .slice(0, 300);
    throw new CliError(
      `keytool could not read ${keystore} (alias ${alias})${detail ? `: ${detail}` : ''}.`,
      1,
      { error: 'keytool_failed' }
    );
  }

  const output = `${result.stdout || ''}${result.stderr || ''}`;
  const match = output.match(/SHA256:\s*([0-9A-Fa-f:]{64,95})/);
  if (!match) {
    throw new CliError(`keytool did not report a SHA256 fingerprint for alias ${alias}.`, 1, {
      error: 'fingerprint_missing',
    });
  }
  const fingerprint = match[1].toUpperCase();

  if (json) {
    out(emitJson({ ok: true, keystore, alias, sha256: fingerprint }, MODE));
    return;
  }
  out('Release signing certificate');
  out(`  keystore      ${keystore}`);
  out(`  alias         ${alias}`);
  out(`  SHA-256       ${fingerprint}`);
}

/* ───────────────────────────── help ───────────────────────────── */

const HELP = {
  root: `dakflare — operate a self-hosted DakFlare deployment

Usage: dakflare <command> [options]

  init          verify a Worker and save its admin token; --local writes .dev.vars
  doctor        checklist: config, health, schema, migrations, bindings, phone
  pair          mint a pairing code; --qr renders a terminal QR
  devices       list paired devices
  revoke        revoke one device (asks first; --yes to skip)
  send          queue an outbound SMS through a paired phone
  status        read one command's state; --wait follows it to the end
  capabilities  every command, its effect and its flags
  describe      purpose, usage and flags for one command
  schema        the flag contract for one command, with types
  examples      real invocations for one command
  audit         tail the audit log (phase 2; says so when the endpoint is absent)
  key           signing-key helpers: \`key fingerprint\`

Every command accepts --json. Each has its own --help.

Config: ${CONFIG_FILE} (mode 600), written by \`dakflare init\`.
Exit:   0 ok · 1 failed check/request · 2 usage · 3 not found · 75 still in flight`,

  init: `Usage: dakflare init [--url <url>] [--token <token> | --token-file <path>]
                     [--local [--force]] [--json]

Verifies GET /v1/admin/health with the admin token, then writes
${CONFIG_FILE} (mode 600). The token is never printed.

  --url <url>          Worker base URL; prompted when omitted and a TTY is present
  --token <token>      admin token (visible in shell history; prefer --token-file)
  --token-file <path>  read the admin token from a file
  --local              do not contact a Worker; write worker/.dev.vars with fresh
                       ADMIN_TOKEN, AUTH_PEPPER and BETTER_AUTH_SECRET values
  --force              with --local, replace an existing .dev.vars
  --json               machine-readable output`,

  doctor: `Usage: dakflare doctor [--max-age <minutes>] [--serial <adb-serial>] [--json]

Checks, one line each, pass/fail/skip:
  config       present, and mode 600 on POSIX
  health       /v1/admin/health reachable
  admin-token  accepted by the Worker
  schema       D1 schema ready
  migrations   every local worker/migrations file applied
  bindings     DB, KV, DEVICE and all rate limiters present (FCM is optional)
  auth-mode    reported AUTH_MODE, when the deployment has one (phase 2)
  d1           counts readable, no db_error
  phone        the freshest device's last contact is within --max-age
  phone-role   android.app.role.SMS holder, when adb sees a device
  phone-build  release or debug build installed, when adb sees a device

Exit 1 if any check fails. --max-age defaults to ${DEFAULT_PHONE_MAX_AGE_MIN} minutes.
--serial or ANDROID_SERIAL selects a device; ADB overrides the adb binary.`,

  pair: `Usage: dakflare pair [--label <text>] [--qr] [--ttl <seconds>] [--json]

Mints a single-use pairing code and prints the code, the
dakflare://pair?u=…&c=… link, and with --qr a terminal QR code.

  --label <text>   display label (this Worker revision does not store it; the
                   phone reports its own label when it pairs)
  --qr             render the link as a QR code (qrencode if present, otherwise
                   the built-in encoder)
  --ttl <seconds>  lifetime, 1–86400 (default ${DEFAULT_PAIR_TTL_S})`,

  devices: `Usage: dakflare devices [--json]

Lists paired devices with label, SIM slot, pairing time and last contact.
The FCM token itself is never printed; only whether one is present.`,

  revoke: `Usage: dakflare revoke <device-id> [--yes] [--json]

Revokes a device in D1 and in its Durable Object. Asks for confirmation;
--yes skips it for automation. This is irreversible: the phone must pair again.`,

  send: `Usage: dakflare send --to <e164> --body <text> [--device <id>] [--wait [duration]] [--until <state>] [--no-wait] [--idempotency-key <k>] [--json]

Queues one outbound SMS and prints the command id and its state.

  --to <e164>     recipient, for example +8801540196080
  --body <text>   message text (max ${MAX_BODY_CHARS} characters)
  --device <id>   send through this device; omitted when exactly one is paired
  --no-wait       queue and return immediately instead of following the command
  --wait [d]      how long to follow it (default 10s, max 5m)
  --until <s>     stop at this state instead of waiting for delivery:
                  pending, dispatched, acked, sent, delivered (default: sent)
  --idempotency-key <k>
                  retry-safe: the same key returns the command it already created
                  instead of sending a second SMS. The reply carries replayed:true
                  when that happened, and the exit code is still success.

By default the command is followed for up to 10 s, so exit 0 means the radio
accepted it, 1 means FAILED or EXPIRED, and 75 means it was still in flight. With
--no-wait, exit 0 means only that the deployment queued it. The envelope's
verification.passed is true only on DELIVERED: SENT means the radio accepted it,
not that it arrived.

  For a body that begins with "-", use --body="…".`,

  status: `Usage: dakflare status <command-id> [--device <id>] [--wait [duration]] [--until <state>] [--json]

Prints one command's state straight from the Durable Object that owns it, or
follows it with --wait. Takes the same --until and returns the same exit codes as
\`dakflare send\`.

  --device <id>   the phone that owns the command; omitted when exactly one is paired
  --wait [d]      poll until the command settles (default 30s, max 5m)
  --until <s>     stop at pending, dispatched, acked, sent or delivered`,

  auth: `Usage: dakflare auth <bootstrap|invite|invites|reset> [options]

  bootstrap --email <address>            create the first owner (no credential; enrol a passkey next)
  invite --email <address> [--role r] [--ttl seconds]
                                         mint a single-use invite; prints the dakflare://invite link
  invites                                list invites and whether they were used
  reset --email <address> --yes          recovery: delete the account and mint a fresh owner invite

Roles: owner, admin, member. The invite link is shown once; only its hash is stored.`,
  capabilities: `Usage: dakflare capabilities [--agent]

Every command on one screen: its name, what it does to the world (read,
mutating, destructive), one line of purpose, and the flags it accepts.

This is the command to read first. \`--agent\` makes it one compact JSON
document; nothing here needs a second call to understand.
`,
  describe: `Usage: dakflare describe <command> [--agent]

Purpose, usage line and every flag for one command, in the words that command
uses. \`dakflare describe send\` is the two-line version of \`send --help\`.
`,
  schema: `Usage: dakflare schema <command> [--agent]

The flag contract as data: name, type, whether it is required, and what it means.
Use this when you need to build a call rather than read about one.
`,
  examples: `Usage: dakflare examples <command> [--agent]

Real invocations, including one that shows the common mistake for that command.
`,
  audit: `Usage: dakflare audit --tail [n] [--actor <label>] [--limit <n>] [--json]

Reads /v1/admin/audit. When the deployment has no audit endpoint (the phase 2
work), it prints "not available on this deployment" and exits 0.

  --tail [n]       tail mode; the optional n is the row count
  --actor <label>  filter by actor label
  --limit <n>      rows, 1–1000 (default 50)`,

  key: `Usage: dakflare key fingerprint [--keystore <path>] [--alias <name>] [--json]

Prints the release signing certificate's SHA-256 fingerprint from
${KEYSTORE_FILE} (or --keystore / DAKFLARE_KEYSTORE).

The password comes from DAKFLARE_KEYSTORE_PASSWORD or storePassword= in
${KEYSTORE_PROPS}; it is never printed.
  --alias <name>   key alias (default: dakflare)

Requires keytool (JDK). This only reads the key; it never changes it.`,
};

function printHelp(topic = 'root') {
  out(HELP[topic] ?? HELP.root);
  return 0;
}

/* ───────────────────────────── main ───────────────────────────── */

const COMMANDS = {
  init: commandInit,
  doctor: commandDoctor,
  pair: commandPair,
  devices: commandDevices,
  revoke: commandRevoke,
  send: commandSend,
  status: commandStatus,
  capabilities: commandCapabilities,
  describe: commandDescribe,
  schema: commandSchema,
  examples: commandExamples,
  audit: commandAudit,
  auth: commandAuth,
  key: commandKey,
};

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    if (command === 'help') {
      const topic = rest[0] ?? 'root';
      return printHelp(topic);
    }
    return printHelp('root');
  }

  CURRENT_COMMAND = command;

  const run = COMMANDS[command];
  if (!run) {
    err(`dakflare: unknown command "${command}"`);
    err('try `dakflare --help`');
    process.exitCode = 2;
    return;
  }

  const code = await run(rest);
  if (typeof code === 'number') process.exitCode = code;
}

try {
  // Resolved before `main` so a failure inside it still knows how to render.
  MODE = outputMode(parseArgv(process.argv.slice(2)).flags);
  AGENT = MODE.agent;
  await main();
} catch (error) {
  const json = MODE.json;
  if (error instanceof CliError) {
    if (json) {
      emitJson(
        {
          ok: false,
          error: error.payload?.error ?? 'error',
          message: error.message,
          ...(error.payload ?? {}),
        },
        MODE
      );
    } else {
      err(`dakflare: ${error.message}`);
      if (error.code === 2) err('try `dakflare <command> --help`');
    }
    process.exitCode = exitCodeFor(error.payload?.error ?? 'internal');
  } else {
    const detail = process.env.DAKFLARE_DEBUG ? String(error?.stack ?? error) : String(error?.message ?? error);
    if (json) emitJson({ ok: false, error: 'internal', message: detail }, MODE);
    else err(`dakflare: ${detail}`);
    process.exitCode = 1;
  }
}
