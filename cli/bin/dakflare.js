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
const CLI_VERSION = '6.3.0-alpha.1';

const HOME = os.homedir();
const CONFIG_DIR = process.env.DAKFLARE_CONFIG
  ? path.resolve(process.env.DAKFLARE_CONFIG)
  : path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'dakflare');
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
/**
 * The exact inks, chosen for a LIGHT background: mint-700, butter-700, coral-700
 * and umber-400 from `design/tokens.css`.
 *
 * They measure 6.0 to 6.8:1 on white and 2.4 to 2.8:1 on `#1e1e1e`, so emitting
 * them unconditionally made the output WORSE the more capable the terminal was.
 * The terminal is the one surface whose background we do not control, which is
 * why the default is the 16-colour palette: it delegates to the theme the
 * operator already chose and tuned for contrast.
 */
const TRUECOLOR_LIGHT = {
  ok: '31,107,69',
  warn: '122,83,16',
  fail: '178,59,32',
  muted: '107,97,83',
  accent: '178,59,32',
};

/**
 * The same roles for a DARK background: mint-400, butter-400, coral-400 and
 * umber-300, the ascending steps of the same ramps. Measured 8.1 to 9.6:1 on
 * `#1e1e1e`.
 */
const TRUECOLOR_DARK = {
  ok: '74,222,128',
  warn: '251,191,36',
  fail: '248,113,113',
  muted: '168,162,158',
  accent: '249,115,22',
};

const ANSI16 = { ok: '32', warn: '33', fail: '31', muted: '2', accent: '31' };

/**
 * Which background the terminal has, as best we can tell without a round trip.
 *
 * `COLORFGBG` is the classic xterm hint (`fg;bg`, and the bg is often `default`).
 * `DAKFLARE_TRUECOLOR=light|dark` overrides it for a terminal that does not set
 * anything. With no signal at all the answer is `null`, and the caller falls back
 * to the 16-colour palette rather than guessing.
 */
function terminalBackground() {
  const forced = String(process.env.DAKFLARE_TRUECOLOR ?? '').toLowerCase();
  if (forced === 'light' || forced === 'dark') return forced;

  const hint = process.env.COLORFGBG;
  if (typeof hint !== 'string' || hint === '') return null;
  const parts = hint.split(';');
  const bg = Number(parts[parts.length - 1]);
  if (!Number.isFinite(bg)) return null;
  if (bg === 7 || bg === 15 || (bg >= 9 && bg <= 15)) return 'light';
  if (bg >= 0 && bg <= 8) return 'dark';
  return null;
}

/** Set once by `main`; `--agent` turns colour, prompts and pretty JSON off. */
let AGENT = false;

/** The output mode for this run: pretty `--json`, or compact `--agent`. */
let MODE = { json: false, agent: false };

function colorMode() {
  if (AGENT || process.env.NO_COLOR) return 'none';
  if (!process.stdout.isTTY) return 'none';
  // Truecolor only when the background is known: the ink set depends on it, and
  // guessing is how the palette ended up at 2.4:1 on a dark terminal.
  if (!String(process.env.COLORTERM ?? '').toLowerCase().includes('truecolor')) return 'ansi';
  return terminalBackground() === null ? 'ansi' : 'truecolor';
}

function paint(role, text) {
  const mode = colorMode();
  if (mode === 'none') return text;
  if (mode === 'ansi') return `\x1b[${ANSI16[role]}m${text}\x1b[0m`;
  const inks = terminalBackground() === 'dark' ? TRUECOLOR_DARK : TRUECOLOR_LIGHT;
  return `\x1b[38;2;${inks[role]}m${text}\x1b[0m`;
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
  worker_not_found: { exit: 2, category: 'usage', remediation: 'dakflare up', fix: 'run from the repository root' },
  token_file: { exit: 2, category: 'usage' },
  confirmation_required: { exit: 2, category: 'usage', remediation: 'dakflare revoke <device-id> --yes', fix: 'confirm non-interactively' },
  keytool_missing: { exit: 2, category: 'tooling', remediation: 'install a JDK', fix: 'keytool is not on PATH' },

  device_unknown: { exit: 3, category: 'not_found', remediation: 'dakflare devices', fix: 'list the paired devices' },
  command_unknown: { exit: 3, category: 'not_found', remediation: 'dakflare devices', fix: 'find the command id' },
  unknown_command: { exit: 3, category: 'not_found', remediation: 'dakflare capabilities', fix: 'list the commands' },
  input_required: { exit: 2, category: 'usage' },
  cf_missing: { exit: 2, category: 'tooling', remediation: 'npm i -g cf', fix: 'install the Cloudflare CLI, then `cf auth login`' },
  cf_not_authenticated: { exit: 4, category: 'permission', remediation: 'cf auth login', fix: 'authenticate cf, then re-run' },
  cf_failed: { exit: 1, category: 'internal' },
  provision_failed: { exit: 6, category: 'precondition' },
  not_registered: { exit: 3, category: 'not_found', remediation: 'dakflare auth bootstrap --email you@example.com', fix: 'create the owner account' },
  keystore_missing: { exit: 3, category: 'not_found' },
  fingerprint_missing: { exit: 3, category: 'not_found' },

  unauthorized: { exit: 4, category: 'permission', remediation: 'dakflare init', fix: 're-verify the admin token' },

  exists: { exit: 5, category: 'conflict' },
  owner_exists: { exit: 5, category: 'conflict', fix: 'an owner already exists on this deployment' },
  already_registered: { exit: 5, category: 'conflict', fix: 'that address already has an account' },

  // The agent control plane (v6.1). These are the outcomes an autonomous caller
  // has to tell apart: "a human has to decide" (6, and it becomes retryable),
  // "you spent your hour" (6, wait for resets_at), and "you may not do that at
  // all" (4, a different credential is the fix).
  approval_required: {
    exit: 6,
    category: 'precondition',
    retryable: true,
    remediation: 'dakflare auth approvals',
    fix: 'a human must approve the request, then retry',
  },
  agent_quota_exceeded: {
    exit: 6,
    category: 'precondition',
    retryable: true,
    fix: 'the agent token spent its hourly SMS budget; wait for resets_at',
  },
  forbidden: { exit: 4, category: 'permission', fix: 'this credential cannot perform that action' },
  already_revoked: { exit: 5, category: 'conflict' },
  not_pending: { exit: 5, category: 'conflict' },
  // A signed apply handle is the caller's document: a bad one is a usage error,
  // a handle from another request is a conflict, and one past its max_uses has
  // nothing left to spend (6, so a caller knows a fresh ask is the fix).
  invalid_apply_token: { exit: 2, category: 'usage', remediation: 'dakflare ask "<intent>" --flow <id>', fix: 'a tampered or malformed apply handle' },
  apply_token_required: { exit: 2, category: 'usage', fix: 'this request must be approved with the ag1_ handle it was minted with' },
  apply_token_mismatch: { exit: 5, category: 'conflict', fix: 'the handle names a different flow, hash or request' },
  handle_exhausted: { exit: 6, category: 'precondition', remediation: 'dakflare ask "<intent>" --flow <id>', fix: 'the handle has spent its max_uses' },
  expired: { exit: 6, category: 'precondition', remediation: 'dakflare auth approvals' },
  not_grantable: { exit: 4, category: 'permission' },
  bad_target: { exit: 2, category: 'usage' },
  not_found: { exit: 3, category: 'not_found' },
  // v6.1 P1. A refused graph is the caller's document, so it is a usage error and
  // `details` carries the issues. A lost race is a conflict and retrying with the
  // version the response names is the fix.
  workflow_invalid: { exit: 2, category: 'usage' },
  // v6.1 P2. The samples cannot produce a trustworthy pattern, or the engine is
  // not where the CLI expects it. Both are the caller's to fix, so both are 2.
  synthesis_refused: { exit: 2, category: 'usage' },
  // The new pattern would change what history reads. Nothing was written; the
  // operator has to decide whether the history or the pattern is wrong.
  heal_refused: { exit: 6, category: 'precondition' },
  wasm_missing: { exit: 2, category: 'tooling' },
  // v7.1 WS8. No built engine is a precondition, not a tooling slip: `flow test`
  // refuses to score an engine that is not there rather than reporting a pass.
  flow_engine_missing: {
    exit: 6,
    category: 'precondition',
    remediation: './simulator/flow-wasm/build.sh',
    fix: 'build the flow engine, then retry',
  },
  flow_graph_missing: { exit: 6, category: 'precondition' },
  flow_schema_missing: { exit: 2, category: 'tooling' },
  version_conflict: {
    exit: 5,
    category: 'conflict',
    retryable: true,
    fix: 're-read the workflow, merge, and retry with the current version',
  },

  no_device: { exit: 6, category: 'precondition', remediation: 'dakflare pair', fix: 'pair a handset first' },
  bad_health: { exit: 6, category: 'precondition', remediation: 'dakflare doctor --json', fix: 'see which check fails' },
  keystore_password_missing: { exit: 6, category: 'precondition' },
  keytool_failed: { exit: 6, category: 'precondition' },
  revoke_failed: { exit: 6, category: 'precondition' },

  network: { exit: 75, category: 'temporary', retryable: true },

  // The console assistant's provider is a precondition, not a network fault:
  // without a key or a binding no request can succeed, and repeating it changes
  // nothing until the operator stores the secret. The budget is a conflict: the
  // request was understood and refused, and it resets at UTC midnight.
  ai_key_missing: {
    exit: 6,
    category: 'precondition',
    remediation: aiKeyCommand(),
    fix: 'store the AI provider key as a Worker secret, then retry',
  },
  ai_precondition: { exit: 6, category: 'precondition' },
  ai_unavailable: { exit: 75, category: 'temporary', retryable: true },
  budget_exhausted: {
    exit: 5,
    category: 'conflict',
    fix: "the daily AI token budget is spent; it resets at UTC midnight",
  },
  bad_request: { exit: 2, category: 'usage' },

  // Channel connectors. A missing or disabled connector is not a malformed
  // request; it is a target the caller has to fix, and a closed messaging
  // window is a conflict rather than a failure of the send itself.
  connector_not_found: { exit: 3, category: 'not_found', remediation: 'dakflare connectors list' },
  connector_exists: { exit: 5, category: 'conflict', remediation: 'dakflare connectors list' },
  connector_disabled: { exit: 6, category: 'precondition', remediation: 'dakflare connectors update <id> --enabled true' },
  connector_secret_unavailable: { exit: 6, category: 'precondition' },
  window_expired: { exit: 5, category: 'conflict', fix: 'the 24h service window is closed; use a template or an allowed tag' },
  unsupported_channel: { exit: 2, category: 'usage' },

  // `fix` names the two ways a target can be absent or ambiguous. A malformed
  // run key and two targets at once are the caller's document (usage); a key or
  // a flow that does not exist is a not-found, like every other unknown id.
  invalid_flow_run_id: {
    exit: 2,
    category: 'usage',
    fix: 'a run id is device_id/local_id/flow_id/flow_version, as flow_runs returns it',
  },
  ambiguous_flow_target: { exit: 2, category: 'usage', fix: 'use --flow or --run, not both' },
  flow_run_not_found: { exit: 3, category: 'not_found' },
  no_flow_runs: {
    exit: 3,
    category: 'not_found',
    fix: 'let the flow run once, or target a message with --message-id',
  },

  internal: { exit: 1, category: 'internal' },
  bad_response: { exit: 1, category: 'internal' },
  cancelled: { exit: 1, category: 'internal' },
};

const DEFAULT_ERROR_RULE = { exit: 1, category: 'internal', retryable: false };

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
    response: {
      checks: '[{name, status, detail}]',
      counts: '{pass, fail, skip}',
      summary: 'the same counts as one line',
    },
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
    response: { devices: '[{device_id, label, sim_slot, paired_at, last_seen, fcm}]' },
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
    response: {
      command_id: 'the id `status` takes',
      replayed: 'true when an idempotency key matched an existing command',
      state: 'PENDING|LEASED|DISPATCHED|SENT|DELIVERED|FAILED|EXPIRED',
      verification: '{passed, state, terminal, reason, next_command}',
      channel_message_id: 'connector send: the platform message id',
      delivery: 'connector send: the channel delivery result',
    },
    summary: 'Queue one outbound SMS, or send through a channel connector',
    effect: 'mutating',
    usage:
      'dakflare send --to <e164> --body <text> [--device <id>] [--no-wait] [--wait [duration]] [--until <state>] [--idempotency-key <k>] | send --channel <whatsapp|telegram|messenger|instagram> --connector <id> --to <destination> --body <text> [--template-id <id>] [--media-url <url>] [--human-agent-tag] [--comment-id <id>]',
    flags: {
      to: { type: 'string', required: true, note: 'E.164 recipient, or the platform destination for a connector' },
      body: { type: 'string', required: true, note: 'message text, max 4096 characters' },
      device: { type: 'string', note: 'send through this device; default is the freshest' },
      'no-wait': { type: 'boolean', note: 'queue and return immediately' },
      wait: { type: 'duration', note: 'how long to follow it, default 10s, max 5m' },
      until: { type: 'state', note: 'pending|dispatched|sent|delivered, default sent' },
      'idempotency-key': { type: 'string', note: 'a retry with the same key returns the same command' },
      channel: { type: 'string', note: 'connector send: whatsapp|telegram|messenger|instagram' },
      connector: { type: 'string', note: 'connector send: the connector id from `connectors list`' },
      'template-id': { type: 'string', note: 'connector send: WhatsApp template id' },
      'media-url': { type: 'string', note: 'connector send: media URL' },
      'human-agent-tag': { type: 'boolean', note: 'connector send: Messenger HUMAN_AGENT outside the 24h window' },
      'comment-id': { type: 'string', note: 'connector send: Instagram private reply to a comment' },
    },
    examples: [
      'dakflare send --to +8801540196080 --body "deploy ack"',
      'dakflare send --to +8801540196080 --body "ack" --idempotency-key ci-1234 --agent',
      'dakflare send --to +8801540196080 --body "ack" --no-wait',
      'dakflare send --channel whatsapp --connector conn_abc --to +8801540196080 --body "ack"',
      'dakflare send --channel telegram --connector conn_bot --to 123456789 --body "ack" --agent',
    ],
  },
  connectors: {
    response: {
      connectors: '[{id, channel, account_id, execution_tier, auth_mode, label, enabled, secret_set, secret_updated_at, last_event_at, created_at, updated_at}]',
      connector: 'the created or updated connector, with secret_set and never the secret',
      webhook_url: 'the ingress URL built from the Worker URL and the connector id',
    },
    summary: 'List, create, update or delete channel connectors (list|create|update|delete)',
    effect: 'mutating',
    usage:
      'dakflare connectors <list|create|update|delete> [options]',
    flags: {
      channel: { type: 'string', note: 'create: whatsapp|telegram|messenger|instagram' },
      'account-id': { type: 'string', note: 'create: the platform account, Page, number or chat id' },
      label: { type: 'string', note: 'create|update: a display name, max 64 characters' },
      'auth-mode': { type: 'string', note: 'create|update: the platform auth mode' },
      'access-token': { type: 'string', note: 'create|update: access token; sealed at rest, never printed' },
      'bot-token': { type: 'string', note: 'create|update: Telegram bot token; sealed at rest, never printed' },
      'app-secret': { type: 'string', note: 'create|update: Meta app secret; sealed at rest, never printed' },
      'verify-token': { type: 'string', note: 'create|update: Meta verify token; sealed at rest, never printed' },
      'secret-token': { type: 'string', note: 'create|update: Telegram secret token; sealed at rest, never printed' },
      enabled: { type: 'string', note: 'create|update: true or false' },
      'dry-run': { type: 'boolean', note: 'create: print the request with credentials redacted; send nothing' },
      yes: { type: 'boolean', note: 'delete: skip the confirmation prompt' },
    },
    examples: [
      'dakflare connectors list --agent',
      'dakflare connectors create --channel whatsapp --account-id 1234567890 --label "Sales line" --access-token "$WA_TOKEN" --dry-run',
      'dakflare connectors create --channel telegram --account-id 123456789 --label "Support bot" --bot-token "$BOT_TOKEN" --secret-token "$TG_SECRET"',
      'dakflare connectors update conn_abc --label "Sales" --enabled false',
      'dakflare connectors delete conn_abc --yes',
    ],
  },
  webhooks: {
    response: {
      webhooks: '[{id, name, enabled, created_by, created_at, last_delivery_at}]',
      secret: 'the signing secret, returned only by create and shown once',
      deliveries: '[{id, webhook_id, received_at, body_json, status, answer_text, error}]',
    },
    summary: 'List, create, delete inbound agent webhooks or read deliveries (list|create|delete|deliveries)',
    effect: 'mutating',
    usage: 'dakflare webhooks <list|create|delete|deliveries> [options]',
    flags: {
      name: { type: 'string', note: 'create: a display name, default "webhook"' },
      'dry-run': { type: 'boolean', note: 'create: print the request; send nothing' },
      yes: { type: 'boolean', note: 'delete: skip the confirmation prompt' },
    },
    examples: [
      'dakflare webhooks list --agent',
      'dakflare webhooks create --name "billing events"',
      'dakflare webhooks deliveries wh_abc --agent',
      'dakflare webhooks delete wh_abc --yes',
    ],
  },
  templates: {
    response: {
      templates: '[{id,name,channel,body,variables,created_at,updated_at}]',
      template: 'create: the stored template',
      variables: 'create: the variable names found in the body',
    },
    summary: 'List, create or delete message templates (list|create|delete)',
    effect: 'mutating',
    usage: 'dakflare templates <list|create|delete> [options]',
    flags: {
      name: { type: 'string', note: 'create: template name' },
      body: { type: 'string', note: 'create: body text, with {{variables}}' },
      channel: {
        type: 'string',
        note: 'create: any|sms|whatsapp|telegram|messenger|instagram, default any',
      },
      'dry-run': { type: 'boolean', note: 'create: print the request; send nothing' },
      yes: { type: 'boolean', note: 'delete: skip the confirmation prompt' },
    },
    examples: [
      'dakflare templates list --agent',
      'dakflare templates create --name order_update --channel whatsapp --body "Order {{id}} is ready"',
      'dakflare templates delete tpl_abc --yes',
    ],
  },
  contacts: {
    response: {
      imported: 'rows written',
      skipped: 'rows skipped',
    },
    summary: 'Import contacts from a CSV file',
    effect: 'mutating',
    usage: 'dakflare contacts import <file.csv>',
    flags: {},
    examples: ['dakflare contacts import contacts.csv --agent'],
  },
  schedule: {
    response: {
      scheduled: '[{id,channel,target_type,target_id,to_peer,body,send_at,status}]',
    },
    summary: 'List, create or cancel scheduled sends (list|create|cancel)',
    effect: 'mutating',
    usage: 'dakflare schedule <list|create|cancel> [options]',
    flags: {
      status: { type: 'string', note: 'list: filter by status' },
      target: { type: 'string', note: 'create: device id for sms, or connector id' },
      to: { type: 'string', note: 'create: recipient' },
      body: { type: 'string', note: 'create: message text' },
      at: { type: 'string', note: 'create: ISO-8601 send time' },
      channel: {
        type: 'string',
        note: 'create: sms|whatsapp|telegram|messenger|instagram, default sms',
      },
      'template-id': { type: 'string', note: 'create: template id for a connector send' },
      'dry-run': { type: 'boolean', note: 'create: print the request; send nothing' },
      yes: { type: 'boolean', note: 'cancel: skip the confirmation prompt' },
    },
    examples: [
      'dakflare schedule list --agent',
      'dakflare schedule create --target dev_pixel4a --to +8801540196080 --body "reminder" --at 2026-12-01T09:00:00Z',
      'dakflare schedule cancel sch_abc --yes',
    ],
  },
  status: {
    response: {
      command: 'the stored command row',
      state: 'the same vocabulary as send',
      verification: '{passed, state, terminal, reason, next_command}',
    },
    summary: "Read one command's state, or follow it",
    effect: 'read',
    usage: 'dakflare status <command-id> [--device <id>] [--wait [duration]] [--until <state>]',
    flags: {
      device: { type: 'string', note: 'the phone that owns the command' },
      wait: { type: 'duration', note: 'follow it, default 30s' },
      until: { type: 'state', note: 'pending|dispatched|sent|delivered, default delivered' },
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
    summary:
      'Accounts and the agent control plane (bootstrap|invite|invites|reset|mint-agent-token|agent-tokens|revoke-agent-token|approvals|approve|reject|grants)',
    effect: 'mutating',
    usage: 'dakflare auth <subcommand> [options]',
    flags: {
      email: { type: 'string', note: 'the account address' },
      role: { type: 'string', note: 'owner|admin|member, invite only' },
      ttl: { type: 'number', note: 'invite lifetime, or agent token lifetime, in seconds' },
      yes: { type: 'boolean', note: 'skip the confirmation (reset, revoke-*)' },
      name: { type: 'string', note: 'mint-agent-token: a short name for the agent' },
      scope: {
        type: 'string',
        note: 'mint-agent-token: comma-separated scopes, e.g. messages:read,sms:send',
      },
      device: { type: 'string', note: 'mint-agent-token: bind the token to one handset' },
      'max-per-hour': { type: 'number', note: 'mint-agent-token: SMS budget, default 20' },
      for: {
        type: 'duration',
        note: 'approve: 1m, 5m, 15m, 30m, 1h, 1d, 7d or 30d; clamped per scope',
      },
      all: { type: 'boolean', note: 'agent-tokens: include revoked tokens' },
      token: { type: 'string', note: 'grants: filter by agent token id' },
      live: { type: 'boolean', note: 'grants: only grants still inside their window' },
      state: { type: 'string', note: 'approvals: filter by state, e.g. PENDING' },
    },
    examples: [
      'dakflare auth bootstrap --email you@example.com',
      'dakflare auth invite --email teammate@example.com --role member',
      'dakflare auth mint-agent-token --name "night shift" --scope messages:read,sms:send',
      'dakflare auth approvals',
      'dakflare auth approve 6f0c… --for 15m',
      'dakflare auth grants --live',
    ],
  },
  up: {
    response: {
      url: 'the deployed Worker',
      database_id: 'the D1 id written into cloudflare.config.ts',
      kv_namespace_id: 'the KV id',
      healthy: 'whether the deployment answered',
      owner: '{state, email, link}',
      pairing: '{code, expires_in}',
    },
    summary: 'Provision the deployment: resources, deploy, owner, pairing',
    effect: 'mutating',
    usage: 'dakflare up [--email <address>] [--yes] [--dry-run]',
    flags: {
      email: { type: 'string', note: 'owner address; skips the bootstrap prompt' },
      yes: { type: 'boolean', note: 'skip the confirmation before deploying' },
      'dry-run': { type: 'boolean', note: 'resolve, check and print the plan; change nothing' },
    },
    examples: [
      'dakflare up --dry-run',
      'dakflare up --email you@example.com --yes',
    ],
  },
  flows: {
    summary: 'Apply or heal a flow document (apply|heal)',
    effect: 'mutating',
    usage: 'dakflare flows apply <file> [--id <id>] [--dry-run] [--agent] | flows heal <id> --samples <file>',
    flags: {
      id: { type: 'string', note: 'flow id (positional arg alternative for apply/heal)' },
      file: { type: 'string', note: 'convenience alternative to the positional <file>' },
      'dry-run': { type: 'boolean', note: 'print the diff and change nothing' },
      force: {
        type: 'boolean',
        note: 'drop expected_previous_version from the document before writing',
      },
      samples: { type: 'string', note: 'heal: the {body, value} examples of the new template' },
      group: { type: 'string', note: 'heal: capture-group name override' },
      device: { type: 'string', note: 'heal: handset whose inbound history is re-checked' },
      node: { type: 'string', note: 'heal: which extract node, default the only one' },
      'corpus-limit': {
        type: 'number',
        note: 'heal: inbound messages to re-check, default 200',
      },
    },
    examples: [
      'dakflare flows apply flow.json --dry-run',
      'dakflare flows apply flow.json',
      'dakflare flows heal wf_orders --samples new-template.json --dry-run',
    ],
  },
  rules: {
    summary: 'List, write, update, delete or test auto-reply rules (list|apply|update|delete|test)',
    effect: 'mutating',
    usage: 'dakflare rules <list|apply|update|delete|test> [options]',
    flags: {
      id: { type: 'string', note: 'update|delete: rule id (alternative to positional <rule-id>)' },
      file: { type: 'string', note: 'apply: a rule or a {rules:[...]} document' },
      'dry-run': { type: 'boolean', note: 'apply: print the diff and change nothing' },
      enabled: { type: 'boolean', note: 'update: enable the rule' },
      disabled: { type: 'boolean', note: 'update: pause the rule without deleting it' },
      name: { type: 'string', note: 'update: new display name' },
      priority: { type: 'number', note: 'update: rule priority (integer)' },
      'matcher-type': { type: 'string', note: 'update: exact|prefix|regex|any' },
      'matcher-value': { type: 'string', note: 'update: sender pattern' },
      'body-type': { type: 'string', note: 'update: exact|contains|regex|any' },
      'body-value': { type: 'string', note: 'update: body pattern' },
      reply: { type: 'string', note: 'update: reply template (empty disables reply)' },
      cooldown: { type: 'number', note: 'update: per-sender cooldown in seconds' },
      'max-per-hour': { type: 'number', note: 'update: maximum replies per hour' },
      'sim-slot': { type: 'number', note: 'update: 0 (auto), 1 or 2' },
      'allow-shortcode': { type: 'boolean', note: 'update: permit replying to shortcodes' },
      'no-shortcode': { type: 'boolean', note: 'update: forbid replying to shortcodes' },
      yes: { type: 'boolean', note: 'delete: skip confirmation prompt' },
      peer: { type: 'string', note: 'test: the E.164 sender to evaluate' },
      body: { type: 'string', note: 'test: the message body to evaluate' },
      device: { type: 'string', note: 'update|test: target device scope ("all" clears scope)' },
    },
    examples: [
      'dakflare rules list --agent',
      'dakflare rules apply rules.json --dry-run',
      'dakflare rules update rule_orders --disabled --agent',
      'dakflare rules test --peer +8801540196080 --body "PAID 500"',
    ],
  },
  extract: {
    summary: 'Derive an extraction pattern from examples (synthesize)',
    effect: 'read',
    usage:
      'dakflare extract synthesize --samples <file> [--group <name>] [--verify-d1-limit <n>] [--device <id>]',
    flags: {
      samples: { type: 'string', note: 'JSON file of {body, value} pairs, and optional negatives' },
      group: { type: 'string', note: 'capture-group name, default "value"' },
      'verify-d1-limit': {
        type: 'number',
        note: 'also run the pattern over this many recent inbound messages',
      },
      device: { type: 'string', note: 'with --verify-d1-limit, which handset to read' },
    },
    examples: [
      'dakflare extract synthesize --samples bKash.json',
      'dakflare extract synthesize --samples bKash.json --group trx_id --verify-d1-limit 200',
    ],
  },
  ask: {
    summary: 'Ask for a patch to a flow, judged for faithfulness (v7.1)',
    effect: 'mutating',
    usage:
      'dakflare ask "<intent>" --flow <id> [--diff-summary <text>] [--corpus-report <text>] [--ndjson] [--dry-run]',
    flags: {
      flow: { type: 'string', required: true, note: 'the flow id the patch is for' },
      'diff-summary': {
        type: 'string',
        note: 'what the patch changes, max 4000 chars; default describes the intent',
      },
      'corpus-report': { type: 'string', note: 'the corpus numbers the judge should weigh, max 1000 chars' },
      ndjson: { type: 'boolean', note: 'one JSON object per phase on stdout' },
      'dry-run': { type: 'boolean', note: 'print the request; send nothing' },
    },
    response: {
      faithful: '{score, probability, confidence} or null',
      approval_required: 'true when a human must approve before apply',
      apply_token: 'the ag1_ handle a later `flow apply` spends, or null',
    },
    examples: [
      'dakflare ask "capture the trx id from bKash confirmations" --flow wf_bkash',
      'dakflare ask "tighten the amount group" --flow wf_bkash --ndjson',
      'dakflare ask "tighten the amount group" --flow wf_bkash --dry-run --json',
    ],
  },
  fix: {
    summary: 'Explain a flow failure as a root-cause card (v7.1)',
    effect: 'read',
    usage:
      'dakflare fix (--flow <id> | --run <run-id>) [--message-id <id>] [--message <text>] [--pattern <regex>] [--ndjson] [--dry-run]',
    flags: {
      flow: {
        type: 'string',
        note: "the flow, sent as flow_id; diagnoses against its most recent stored run",
      },
      run: {
        type: 'string',
        note: 'one stored run, sent as flow_run_id (device_id/local_id/flow_id/flow_version)',
      },
      'message-id': { type: 'string', note: 'the stored message to explain' },
      message: { type: 'string', note: 'diagnose this body directly instead of a stored row' },
      pattern: { type: 'string', note: 'also check this pattern for a word-boundary cut' },
      ndjson: { type: 'boolean', note: 'one JSON object per phase on stdout' },
      'dry-run': { type: 'boolean', note: 'print the request; send nothing' },
    },
    response: {
      card: '{code, summary, offset, highlight, encoding, segments, fix}',
    },
    examples: [
      'dakflare fix --flow wf_bkash --message-id 6cb13963-f33c-49d0-b87f-2cc72844a426',
      'dakflare fix --run dev1/local-1/wf_bkash/3 --pattern "REF" --json',
      'dakflare fix --flow wf_bkash --message "Paid 500 at REF 12A45" --pattern "REF" --json',
      'dakflare fix --flow wf_bkash --message-id 6cb13963 --ndjson',
    ],
  },
  flow: {
    summary: 'Test a flow against a corpus, or spend an apply handle (test|apply)',
    effect: 'mutating',
    usage:
      'dakflare flow test --flow <id> --corpus <file.jsonl> [--json] | flow apply --token <handle> [--totp <code>]',
    flags: {
      flow: { type: 'string', note: 'test: the flow whose graph is run' },
      corpus: { type: 'string', note: 'test: JSONL rows of {sender?, body, expect?}' },
      token: { type: 'string', note: 'apply: the ag1_ handle `ask` printed' },
      totp: { type: 'string', note: 'apply: six-digit code, sent as X-Dakflare-Totp' },
    },
    response: {
      precision: 'correct extracted values / produced values, or null',
      recall: 'expected values produced correctly / expected values, or null',
      specificity: 'fixed-token mass / (fixed + wildcard), an estimate',
      dfa_estimate: 'construct count / 2048-state budget, an estimate',
      linear_time_guaranteed: 'true only when every pattern is RE2-compilable',
      mismatches: '[{row, body, outcome, problems}]',
    },
    examples: [
      'dakflare flow test --flow wf_bkash --corpus corpus.jsonl',
      'dakflare flow test --flow wf_bkash --corpus corpus.jsonl --json',
      'dakflare flow apply --token ag1_eyJmbG93X2lkIjoi...',
    ],
  },
  mcp: {
    summary: 'Serve this deployment over MCP on stdio (serve)',
    effect: 'read',
    usage: 'dakflare mcp serve [--token <t> | --token-file <path>] [--version <v>]',
    flags: {
      token: { type: 'string', note: 'agent token; prefer --token-file' },
      'token-file': { type: 'string', note: 'read the agent token from a file' },
      version: { type: 'string', note: 'protocol revision, default 2026-07-28' },
    },
    examples: [
      'dakflare mcp serve --token-file ~/.dakflare-agent-token',
      'dakflare mcp serve --token "$DKF_AGENT_TOKEN"',
    ],
  },
  trace: {
    summary: 'Explain one id: message, command or approval request',
    effect: 'read',
    usage: 'dakflare trace <id> [--device <id>] [--agent]',
    flags: {
      id: { type: 'string', note: 'message, command or approval id (alternative to positional <id>)' },
      device: { type: 'string', note: 'disambiguate a local id, which is per device' },
    },
    examples: [
      'dakflare trace 6cb13963-f33c-49d0-b87f-2cc72844a426',
      'dakflare trace 567f8234-dec5-48f9-81ca-32e0b6531fe9 --agent',
    ],
  },
  alerts: {
    summary: 'Open operator alerts, newest first',
    effect: 'read',
    usage: 'dakflare alerts [--all] [--agent]',
    flags: { all: { type: 'boolean', note: 'include acknowledged and resolved alerts' } },
    examples: ['dakflare alerts', 'dakflare alerts --all --agent'],
  },
  dlq: {
    summary: "A device object's dead letters, newest first",
    effect: 'read',
    usage: 'dakflare dlq [--device <id>] [--limit <n>]',
    flags: {
      device: { type: 'string', note: 'default is the freshest paired device' },
      limit: { type: 'number', note: 'rows, 1-200, default 50' },
    },
    examples: ['dakflare dlq', 'dakflare dlq --device dev63f3953f417d587f --limit 10 --agent'],
  },
  ws: {
    summary: "Inspect a device's live sockets (inspect)",
    effect: 'read',
    usage: 'dakflare ws inspect [--device <id>]',
    flags: { device: { type: 'string', note: 'default is the freshest paired device' } },
    examples: ['dakflare ws inspect', 'dakflare ws inspect --device dev63f3953f417d587f --agent'],
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
    summary: 'The flag contract for one command, the state machines (states), or the flow v2 schema (--flow-v2)',
    effect: 'read',
    usage: 'dakflare schema <command|states> | schema --flow-v2 [--json]',
    flags: {
      'flow-v2': { type: 'boolean', note: 'print the dakflare.flow/v2 JSON Schema instead of a command contract' },
    },
    examples: [
      'dakflare schema send --agent',
      'dakflare schema states --agent',
      'dakflare schema --flow-v2 --json',
    ],
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
  ai: {
    summary: 'Read or change the console AI provider, list its models, and probe chat or System One (providers|configure|models|test)',
    effect: 'mutating',
    usage:
      'dakflare ai providers [--json] | ai configure --provider <workers-ai|openai-compatible> [--model <id>] [--base-url <url>] [--system1-model <id>] [--system1-base-url <url>] [--dry-run] [--json] | ai models [--json] | ai test [--system-one] [--json]',
    flags: {
      provider: { type: 'string', note: 'configure: workers-ai or openai-compatible' },
      model: {
        type: 'string',
        note: 'configure: chat model id; omitted uses the provider default',
      },
      'base-url': {
        type: 'string',
        note: 'configure: required for openai-compatible; https, or http on localhost',
      },
      'system1-model': {
        type: 'string',
        note: 'configure: System One model id; omitted inherits the chat model',
      },
      'system1-base-url': {
        type: 'string',
        note: 'configure: System One base URL; omitted inherits the chat base; refused for workers-ai',
      },
      'system-one': {
        type: 'boolean',
        note: 'test: probe the System One decision route instead of chat',
      },
      'dry-run': { type: 'boolean', note: 'configure: print the request; change nothing' },
    },
    response: {
      provider: 'workers-ai|openai-compatible',
      model: 'the chat model id',
      models: 'ai models: [{id, owned_by?}] with source static|provider',
      base_url: 'https URL, or null for workers-ai',
      system1: '{provider, model, base_url, inherits_base}',
      api_key_configured: 'whether both roles have a key on the Worker',
      key_source: '{chat, system1}: the secret name that answered each role, or none',
      answers: 'ai test --system-one: {id: {type, choice?, probability, noul?, score?, legend?}}',
      budget: '{day, used, limit}',
    },
    examples: [
      'dakflare ai providers',
      'dakflare ai providers --agent',
      'dakflare ai configure --provider workers-ai',
      'dakflare ai configure --provider openai-compatible --model gpt-4o-mini --base-url https://api.openai.com/v1 --system1-model Clef --system1-base-url https://api.tokenlab.amd.com/v1 --dry-run',
      'dakflare ai models --json',
      'dakflare ai test --json',
      'dakflare ai test --system-one --json',
    ],
  },
};

/**
 * Commands whose repetition can cause a second real-world effect.
 * Auto-derived from COMMAND_SPECS so new mutating/destructive commands are never omitted.
 */
const MUTATING = new Set(
  Object.entries(COMMAND_SPECS)
    .filter(([, spec]) => spec.effect === 'mutating' || spec.effect === 'destructive')
    .map(([name]) => name)
);

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
  // `schema_version` describes the document; this describes the tool that wrote
  // it. They move for different reasons — `ok` became `status` in 0.2.0 without
  // the envelope's shape changing.
  return { profile: 'default', cli_version: CLI_VERSION, worker_url: cfg?.url ?? null };
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
      // same answer for reads. Two codes are the exception, and they earn it by
      // definition: an approval request and a spent budget both mean the action
      // did NOT happen, so retrying after a human answers is safe.
      safe_to_retry:
        retryable &&
        (!MUTATING.has(CURRENT_COMMAND) ||
          payload?.idempotent === true ||
          code === 'approval_required' ||
          code === 'agent_quota_exceeded'),
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
      ...((summary ?? summaryFor(CURRENT_COMMAND, data)) === undefined
        ? {}
        : { summary: summary ?? summaryFor(CURRENT_COMMAND, data) }),
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
  'name',
  'scope',
  'max-per-hour',
  'for',
  'state',
  'file',
  'id',
  'peer',
  'samples',
  'group',
  'verify-d1-limit',
  'sub',
  'version',
  'node',
  'corpus-limit',
  'flow',
  'run',
  'message-id',
  'message',
  'pattern',
  'corpus',
  'totp',
  'diff-summary',
  'corpus-report',
  'provider',
  'model',
  'base-url',
  'system1-model',
  'system1-base-url',
  'api-key',
  'priority',
  'matcher-type',
  'matcher-value',
  'body-type',
  'body-value',
  'reply',
  'cooldown',
  'sim-slot',
  'channel',
  'connector',
  'account-id',
  'auth-mode',
  'access-token',
  'bot-token',
  'app-secret',
  'verify-token',
  'secret-token',
  'template-id',
  'comment-id',
  'media-url',
  'at',
  'target',
  'status',
]);

const KNOWN_BOOLEAN_FLAGS = new Set([
  'json',
  'agent',
  'help',
  'local',
  'force',
  'qr',
  'yes',
  'no-wait',
  'dry-run',
  'all',
  'live',
  'ndjson',
  'system-one',
  'enabled',
  'disabled',
  'allow-shortcode',
  'no-shortcode',
  'flow-v2',
  'human-agent-tag',
]);

function looksLikeCliFlag(arg) {
  if (!arg || !arg.startsWith('--') || arg === '--') return false;
  const raw = arg.slice(2);
  const eq = raw.indexOf('=');
  const name = eq === -1 ? raw : raw.slice(0, eq);
  return VALUE_FLAGS.has(name) || KNOWN_BOOLEAN_FLAGS.has(name);
}

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
      if (VALUE_FLAGS.has(key) && next !== undefined && !looksLikeCliFlag(next)) {
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
    if (required) {
      // Structured, because "which flag did I forget" is the failure an agent
      // hits most often and the one it should not have to read prose to fix.
      throw new CliError(`--${name} is required`, 2, {
        error: 'input_required',
        missing: [`--${name}`],
      });
    }
    return undefined;
  }
  if (value === true || value === '') throw usage(`--${name} needs a value`);
  return String(value);
}

/**
 * Throw once for every required flag that is absent.
 *
 * `stringFlag(..., { required: true })` reports one flag at a time; a command
 * that needs three should not make the caller discover them one call at a time.
 */
function requireFlags(flags, names) {
  const missing = names.filter((name) => flags[name] === undefined).map((name) => `--${name}`);
  if (missing.length === 0) return;
  throw new CliError(`${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} required`, 2, {
    error: 'input_required',
    missing,
  });
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
    throw new CliError(`${why}: run \`dakflare init\` first.`, 2, { error: 'no_config' });
  }
  if (typeof cfg.url !== 'string' || cfg.url === '' || typeof cfg.token !== 'string' || cfg.token === '') {
    throw new CliError(
      `the config at ${CONFIG_FILE} needs both "url" and "token": run \`dakflare init\` again.`,
      2,
      { error: 'no_config' }
    );
  }
  return { ...cfg, url: cfg.url.replace(/\/+$/, '') };
}

/* ───────────────────────────── HTTP ───────────────────────────── */

let d1SessionBookmark = null;

async function api(
  cfg,
  method,
  pathname,
  body,
  { timeout = DEFAULT_TIMEOUT_MS, headers = {}, raw = false } = {}
) {
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
        ...(d1SessionBookmark ? { 'X-D1-Bookmark': d1SessionBookmark } : {}),
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    const reason =
      error?.name === 'AbortError'
        ? `request timed out after ${Math.round(timeout / 1000)}s`
        : String(error?.message ?? error);
    throw new CliError(
      `cannot reach ${base}: ${reason}. Check the Worker URL and your connection.`,
      1,
      { error: 'network', url: base }
    );
  } finally {
    clearTimeout(timer);
  }

  const incomingBookmark = response.headers.get('x-d1-bookmark');
  if (incomingBookmark) d1SessionBookmark = incomingBookmark;

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
  if (data && typeof data === 'object') {
    if (typeof data.error === 'string') return data.error;
    // The channel send routes report a delivery failure as `errorCode` rather
    // than `error`, because the 200-shaped result and the failure share a type.
    if (typeof data.errorCode === 'string') return data.errorCode;
  }
  return `HTTP ${status}`;
}

function httpStatusExitCode(status) {
  if (status === 401 || status === 403) return 4;
  if (status === 404) return 3;
  if (status === 409) return 5;
  if (status === 429 || status === 503) return 75;
  return 1;
}

/** Convert a response into a useful message without ever including the token. */
function requestFailure(what, result) {
  const detail = apiErrorBody(result.data, result.status);
  const code = ERROR_RULES[detail]?.exit ?? httpStatusExitCode(result.status);
  return new CliError(`${what} failed: ${detail} (HTTP ${result.status})`, code, {
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

function devicePresenceState(lastSeenMs, now = Date.now()) {
  if (lastSeenMs === null || lastSeenMs === undefined) return 'unknown';
  const age = Math.max(0, now - Number(lastSeenMs));
  if (age <= 120_000) return 'live';
  if (age <= 900_000) return 'synced';
  if (age <= 86_400_000) return 'stale';
  return 'offline';
}

function publicDevice(device) {
  return {
    device_id: device.device_id,
    label: device.label ?? null,
    sim_slot: device.sim_slot ?? null,
    paired_at: device.paired_at ?? null,
    last_seen: device.last_seen ?? null,
    state:
      device.revoked_at === null || device.revoked_at === undefined
        ? devicePresenceState(device.last_seen)
        : 'revoked',
    revoked_at: device.revoked_at ?? null,
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

/** Whether a directory carries the files a Worker project is built from. */
function looksLikeWorkerDir(directory) {
  if (fs.existsSync(path.join(directory, 'package.json'))) return true;
  if (fs.existsSync(path.join(directory, 'cloudflare.config.ts'))) return true;
  try {
    return fs
      .readdirSync(directory)
      .some((name) => /^wrangler.*\.(toml|json|jsonc)$/.test(name));
  } catch {
    return false;
  }
}

/**
 * Where `init --local` may write, and nowhere else.
 *
 * An explicit directory from `up` bypasses discovery. Otherwise the only
 * candidate is `worker/` under the current directory, and only when it looks
 * like the Worker. There is deliberately no `__dirname` fallback here: that
 * would let a run outside a checkout rotate another project's `.dev.vars`.
 */
function resolveLocalWorkerDir(explicit) {
  if (explicit !== null && explicit !== undefined) return explicit;
  const candidate = path.join(process.cwd(), 'worker');
  if (fs.existsSync(candidate) && looksLikeWorkerDir(candidate)) return candidate;
  throw new CliError(
    'no worker/ directory here that looks like the Worker (package.json, wrangler.toml or cloudflare.config.ts). ' +
      'Run this from the repository root, or use `dakflare up`.',
    2,
    { error: 'worker_not_found', cwd: process.cwd() }
  );
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

async function initLocal(flags, json, workerDirectory = null, { quiet = false } = {}) {
  const directory = resolveLocalWorkerDir(workerDirectory);
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
    WEBHOOK_SECRET_KEY: crypto.randomBytes(32).toString('base64'),
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

  if (quiet) return 0;

  if (json) {
    emitJson({
          ok: true,
          local: true,
          file,
          mode: '600',
          generated: Object.keys(generated),
          widths: Object.fromEntries(Object.entries(generated).map(([key, value]) => [key, value.length])),
        }, MODE);
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

function parseTokenFileContent(raw) {
  const trimmed = String(raw ?? '').trim();
  const envMatch = /^ADMIN_TOKEN=(.+)$/m.exec(trimmed);
  return envMatch ? envMatch[1].trim() : trimmed;
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
      token = parseTokenFileContent(fs.readFileSync(file, 'utf8'));
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
    emitJson({
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
        }, MODE);
    return healthy ? 0 : 1;
  }

  out(`DakFlare init: ${url}`);
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

/** Every serial `adb devices` reports, in order, whatever its state. */
function attachedSerials() {
  const result = runAdb(['devices'], 8000);
  if (result.error || result.status !== 0) return [];
  return String(result.stdout || '')
    .split(/\r?\n/)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/)[0])
    .filter(Boolean);
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
    // "no adb device attached" is wrong when one *is* attached and a pin points
    // elsewhere: `--serial` or ANDROID_SERIAL naming a stale address used to
    // report an empty bench, which sends the operator to look at the phone
    // instead of at the variable.
    const wanted = serialFlag ?? process.env.ANDROID_SERIAL ?? null;
    const attached = attachedSerials();
    const detail = wanted
      ? `${wanted} is not attached (attached: ${attached.length > 0 ? attached.join(', ') : 'none'})`
      : 'no adb device attached';
    checks.push({ name: 'phone-role', status: 'skip', detail });
    checks.push({ name: 'phone-build', status: 'skip', detail });
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
        ? `${CONFIG_FILE} is not valid JSON: run \`dakflare init\``
        : `${CONFIG_FILE} is missing: run \`dakflare init\``
    );
    return finishDoctor(checks, json, null);
  }

  if (typeof cfg.url !== 'string' || cfg.url === '' || typeof cfg.token !== 'string' || cfg.token === '') {
    add('config', 'fail', `${CONFIG_FILE} needs both "url" and "token": run \`dakflare init\``);
    return finishDoctor(checks, json, null);
  }

  const url = cfg.url.replace(/\/+$/, '');
  if (process.platform !== 'win32' && mode !== null && (mode & 0o077) !== 0) {
    add('config', 'fail', `${CONFIG_FILE} mode ${modeString(mode)}; expected 600: run \`chmod 600 ${CONFIG_FILE}\``);
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
    add('health', 'fail', `HTTP ${health.status}: admin token rejected`);
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
    data.schema_ready === true ? 'ready (d1_migrations present and counts readable)' : 'not ready: apply D1 migrations'
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
      ? `reachable: devices ${data.counts.devices ?? '?'} · messages ${data.counts.messages ?? '?'} · rules ${data.counts.rules ?? '?'}`
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
      add('phone', 'skip', 'no paired devices: run `dakflare pair`');
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
        else add('phone', 'fail', `${detail}; older than ${maxAgeMinutes}m: is the gateway running?`);
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
    emitJson({
          ok: healthy,
          url: url ?? null,
          version: version ?? null,
          checked_at: new Date().toISOString(),
          checks,
          summary: `${counts.pass} passed, ${counts.fail} failed, ${counts.skip} skipped`,
          counts,
        }, MODE);
    if (!healthy) process.exitCode = 1;
    return;
  }

  out(`DakFlare doctor${url ? `: ${url}` : ''}`);
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
      (healthy ? '' : `: ${fail('not healthy')}`)
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
    emitJson({
          ok: true,
          pairing_code: code,
          expires_at: expiresAt,
          expires_at_iso: iso(expiresAt),
          ttl_seconds: ttl,
          deep_link: deepLink,
          label: label ?? null,
          ...(qr ? { qr } : {}),
        }, MODE);
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
    emitJson({ ok: true, devices }, MODE);
    return;
  }

  out(`Devices (${devices.length})`);
  if (devices.length === 0) {
    out('  no paired devices: run `dakflare pair`');
    return;
  }

  const idWidth = Math.max(9, ...devices.map((device) => String(device.device_id).length));
  const labelWidth = Math.max(5, ...devices.map((device) => String(device.label ?? '—').length));
  const stateWidth = 7;
  out(
    `  ${pad('ID', idWidth)}  ${pad('LABEL', labelWidth)}  SIM  ${pad('STATE', stateWidth)}  LAST SEEN`
  );
  for (const device of devices) {
    const seconds = ageSeconds(device.last_seen);
    out(
      `  ${pad(device.device_id, idWidth)}  ${pad(device.label ?? '—', labelWidth)}  ${pad(
        device.sim_slot ?? '—',
        3
      )}  ${pad(device.state ?? 'unknown', stateWidth)}  ${iso(device.last_seen)} (${humanAge(seconds)})`
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
      `no paired device with id "${deviceId}": run \`dakflare devices\` to list them.`,
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
    emitJson({ ok: true, device_id: deviceId, d1_deleted: d1Deleted }, MODE);
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
  LEASED: { rank: 1, terminal: false, meaning: 'the phone was handed it and has 60 s to confirm' },
  DISPATCHED: { rank: 2, terminal: false, meaning: 'the phone confirmed it has it and is sending' },
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
  sent: 'SENT',
  delivered: 'DELIVERED',
};

/**
 * The canonical state machines catalog across the DakFlare ecosystem.
 * Exposed to agents and tools via `dakflare schema states`.
 */
const STATE_MACHINES = {
  command: {
    initial: 'PENDING',
    terminal: ['DELIVERED', 'FAILED', 'EXPIRED'],
    states: Object.keys(COMMAND_STATES),
    predecessors: {
      PENDING: ['LEASED'],
      LEASED: ['PENDING'],
      DISPATCHED: ['LEASED'],
      SENT: ['DISPATCHED'],
      DELIVERED: ['SENT'],
      FAILED: ['DISPATCHED', 'SENT'],
      EXPIRED: ['PENDING', 'LEASED', 'DISPATCHED'],
    },
    meanings: Object.fromEntries(
      Object.entries(COMMAND_STATES).map(([k, v]) => [k, v.meaning])
    ),
  },
  grant: {
    initial: 'ACTIVE',
    terminal: ['EXPIRED', 'REVOKED'],
    states: ['ACTIVE', 'EXPIRED', 'REVOKED'],
    transitions: {
      ACTIVE: ['EXPIRED', 'REVOKED'],
      EXPIRED: [],
      REVOKED: [],
    },
  },
  approval: {
    initial: 'PENDING',
    terminal: ['APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED'],
    states: ['PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED'],
    transitions: {
      PENDING: ['APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED'],
      APPROVED: [],
      REJECTED: [],
      EXPIRED: [],
      CANCELLED: [],
    },
  },
  alert: {
    initial: 'OPEN',
    terminal: ['RESOLVED', 'PURGED'],
    states: ['OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'PURGED'],
    transitions: {
      OPEN: ['ACKNOWLEDGED', 'RESOLVED'],
      ACKNOWLEDGED: ['RESOLVED'],
      RESOLVED: ['PURGED'],
      PURGED: [],
    },
  },
  token: {
    initial: 'ACTIVE',
    terminal: ['EXPIRED', 'REVOKED'],
    states: ['ACTIVE', 'EXPIRED', 'REVOKED'],
    transitions: {
      ACTIVE: ['EXPIRED', 'REVOKED'],
      EXPIRED: [],
      REVOKED: [],
    },
  },
  device: {
    states: ['live', 'synced', 'stale', 'offline', 'unknown', 'revoked'],
    meanings: {
      live: 'Reachable now. An authenticated WebSocket or signed poll answered moments ago.',
      synced: 'Reachable on next poll. Answered a signed contact recently.',
      stale: 'May be asleep or backgrounded. Last signed contact is getting old.',
      offline: 'No signed contact within 24h, or carrier disabled.',
      unknown: 'No signed contact recorded yet.',
      revoked: 'Revoked tombstone kept for message history; the handset must pair again.',
    },
  },
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

  // A revoked device is a tombstone the console keeps for its record; it is not
  // a target. Ranking it by `last_seen` would pick a phone that cannot answer.
  const all = await listDevices(cfg);
  const devices = all
    .filter((device) => device.revoked_at === null || device.revoked_at === undefined)
    .map(publicDevice);
  if (devices.length === 0) {
    throw new CliError(
      all.length === 0
        ? 'no paired device yet: run `dakflare pair` first.'
        : 'every paired device is revoked: pair one again.',
      1,
      { error: 'no_device' }
    );
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
function verificationFor(command, { timedOut = false, deviceId = null } = {}) {
  const meta = stateMeta(command.state);
  const passed = command.state === 'DELIVERED' ? true : meta.terminal ? false : null;
  const errorCode = typeof command.error_code === 'string' && command.error_code !== '' ? command.error_code : null;
  const errorMessage = typeof command.error_message === 'string' && command.error_message !== '' ? command.error_message : null;
  const reason =
    COMMAND_STATES[command.state] === undefined
      ? 'state_unknown'
      : timedOut
        ? 'timeout'
        : command.state === 'DELIVERED'
          ? 'carrier_confirmed'
          : command.state === 'SENT'
            ? 'radio_accepted_delivery_not_claimed'
            : command.state === 'FAILED'
              ? errorCode ?? 'refused'
              : command.state === 'EXPIRED'
                ? 'expired_before_collection'
                : 'in_flight';

  const deviceFlag = deviceId ? ` --device ${deviceId}` : '';
  const modeFlag = MODE.agent ? ' --agent' : MODE.json ? ' --json' : '';
  return {
    passed,
    state: command.state,
    terminal: meta.terminal,
    reason,
    ...(errorCode === null ? {} : { error_code: errorCode }),
    ...(errorMessage === null ? {} : { error_message: errorMessage }),
    next_command:
      passed === true
        ? null
        : command.state === 'FAILED'
          ? `dakflare trace ${command.command_id}${deviceFlag}${modeFlag}`
          : command.state === 'EXPIRED'
            ? null
            : `dakflare status ${command.command_id}${deviceFlag} --wait 60s${modeFlag}`,
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
  if (command.state === 'FAILED' && (command.error_code || command.error_message)) {
    const reason = [command.error_code, command.error_message].filter(Boolean).join(' — ');
    out(`  reason        ${reason}`);
  } else if (command.state === 'EXPIRED') {
    out('  reason        handset did not collect this command before its TTL elapsed');
  }
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
  const next = verificationFor(command, { deviceId }).next_command;
  if (next) out(`  next          ${next}`);
}

/* ────────────────────── connectors and webhooks ────────────────────── */

const CONNECTOR_CREDENTIAL_FLAGS = [
  ['access-token', 'accessToken'],
  ['bot-token', 'botToken'],
  ['app-secret', 'appSecret'],
  ['verify-token', 'verifyToken'],
  ['secret-token', 'secretToken'],
];

function connectorWebhookUrl(cfg, channel, id) {
  return `${cfg.url}/v1/channels/${encodeURIComponent(channel)}/${encodeURIComponent(id)}/webhook`;
}

function connectorSecret(flags) {
  const secret = {};
  for (const [flag, key] of CONNECTOR_CREDENTIAL_FLAGS) {
    if (flags[flag] === undefined) continue;
    const value = stringFlag(flags, flag);
    if (value === '') throw usage(`--${flag} needs a value`);
    secret[key] = value;
  }
  return Object.keys(secret).length === 0 ? null : secret;
}

function redactConnectorSecret(body) {
  if (body.secret === undefined) return body;
  const secret = {};
  for (const key of Object.keys(body.secret)) secret[key] = '<redacted>';
  return { ...body, secret };
}

function booleanFlagValue(flags, name) {
  const value = flags[name];
  if (value === undefined) return undefined;
  if (value === true || value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw usage(`--${name} must be true or false`);
}

/**
 * `connectors` accepts `--enabled true|false`, but `enabled` is a bare boolean
 * for `rules update`. Normalize the two-word form before the shared parser so
 * neither command needs a private argument grammar.
 */
function connectorArgv(argv) {
  const normalized = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--enabled' && (next === 'true' || next === 'false' || next === '0' || next === '1')) {
      normalized.push(`--enabled=${next}`);
      index += 1;
      continue;
    }
    normalized.push(arg);
  }
  return normalized;
}

function printConnectorRows(cfg, rows) {
  if (rows.length === 0) {
    out('No channel connectors configured.');
    return;
  }
  out(`Connectors (${rows.length})`);
  for (const connector of rows) {
    const state = connector.enabled ? ok('active') : muted('paused');
    const secret = connector.secret_set
      ? `secret set${connector.secret_updated_at ? ` ${iso(connector.secret_updated_at)}` : ''}`
      : 'no secret';
    out(
      `  ${String(connector.id).padEnd(22)} ${String(connector.channel).padEnd(10)} ${state.padEnd(8)} ${connector.account_id}  ${connector.label ?? ''}`
    );
    out(muted(`    ${secret}`));
    out(muted(`    ${connectorWebhookUrl(cfg, connector.channel, connector.id)}`));
  }
}

async function commandConnectors(argv) {
  const [sub = 'list', ...args] = argv;
  if (sub === '--help' || sub === '-h') return printHelp('connectors');
  const { flags, rest } = parseArgv(connectorArgv(args));
  if (flags.help) return printHelp('connectors');
  assertCommandFlags(flags, 'connectors');

  if (sub === 'list') {
    const cfg = requireConfig();
    const result = await api(cfg, 'GET', '/v1/admin/connectors');
    if (result.status !== 200) throw requestFailure('listing connectors', result);
    const raw = Array.isArray(result.data?.connectors) ? result.data.connectors : [];
    const connectors = raw.map((connector) => ({
      ...connector,
      webhook_url: connectorWebhookUrl(cfg, connector.channel, connector.id),
    }));
    if (MODE.json) {
      emitJson({ ok: true, connectors }, MODE);
      return 0;
    }
    printConnectorRows(cfg, connectors);
    return 0;
  }

  if (sub === 'create') {
    requireFlags(flags, ['channel', 'account-id', 'label']);
    const channel = stringFlag(flags, 'channel').toLowerCase();
    if (!CONNECTOR_CHANNELS.includes(channel)) {
      throw usage(`--channel must be one of ${CONNECTOR_CHANNELS.join(', ')}`);
    }
    const accountId = stringFlag(flags, 'account-id');
    const label = stringFlag(flags, 'label');
    const secret = connectorSecret(flags);
    if (secret === null) {
      throw usage(
        'a credential is required: pass --access-token, --bot-token, --app-secret, --verify-token or --secret-token'
      );
    }
    const body = {
      channel,
      account_id: accountId,
      label,
      secret,
    };
    const authMode = stringFlag(flags, 'auth-mode');
    if (authMode !== undefined) body.auth_mode = authMode;
    const enabled = booleanFlagValue(flags, 'enabled');
    if (enabled !== undefined) body.enabled = enabled;

    if (flags['dry-run'] === true) {
      const redacted = redactConnectorSecret(body);
      const pathname = '/v1/admin/connectors';
      if (MODE.json) {
        emitJson(
          { ok: true, dry_run: true, request: { method: 'POST', path: pathname, body: redacted } },
          MODE
        );
        return 0;
      }
      printDryRun(pathname, redacted);
      return 0;
    }

    const cfg = requireConfig();
    const result = await api(cfg, 'POST', '/v1/admin/connectors', body);
    if (result.status !== 201 && result.status !== 200) {
      throw requestFailure('creating the connector', result);
    }
    const connector = result.data ?? {};
    const webhookUrl = connectorWebhookUrl(cfg, connector.channel ?? channel, connector.id ?? '');
    if (MODE.json) {
      emitJson({ ok: true, connector, webhook_url: webhookUrl }, MODE);
      return 0;
    }
    out(`Created connector ${connector.id ?? ''} (${connector.channel ?? channel})`);
    out(`  account       ${connector.account_id ?? accountId}`);
    out(`  secret        stored sealed; it is never returned by the API`);
    out(`  webhook       ${webhookUrl}`);
    return 0;
  }

  if (sub === 'update') {
    const id = rest[0];
    if (!id) throw usage('dakflare connectors update <id> [--label <name>] [--enabled true|false]');
    if (rest.length > 1) throw usage(`unexpected argument "${rest[1]}"`);
    const body = {};
    const label = stringFlag(flags, 'label');
    if (label !== undefined) body.label = label;
    const authMode = stringFlag(flags, 'auth-mode');
    if (authMode !== undefined) body.auth_mode = authMode;
    const enabled = booleanFlagValue(flags, 'enabled');
    if (enabled !== undefined) body.enabled = enabled;
    const secret = connectorSecret(flags);
    if (secret !== null) body.secret = secret;
    if (Object.keys(body).length === 0) {
      throw usage('nothing to update: pass --label, --enabled, --auth-mode or a credential flag');
    }

    const cfg = requireConfig();
    const result = await api(cfg, 'PATCH', `/v1/admin/connectors/${encodeURIComponent(id)}`, body);
    if (result.status !== 200) throw requestFailure(`updating connector ${id}`, result);
    const connector = result.data ?? {};
    const webhookUrl =
      connector.channel === undefined
        ? null
        : connectorWebhookUrl(cfg, connector.channel, connector.id ?? id);
    if (MODE.json) {
      emitJson(
        {
          ok: true,
          connector,
          ...(webhookUrl === null ? {} : { webhook_url: webhookUrl }),
        },
        MODE
      );
      return 0;
    }
    out(`Updated connector ${id}`);
    out(`  secret        ${connector.secret_set ? 'stored sealed' : 'not set'}; it is never returned by the API`);
    return 0;
  }

  if (sub === 'delete') {
    const id = rest[0];
    if (!id) throw usage('dakflare connectors delete <id> [--yes]');
    if (rest.length > 1) throw usage(`unexpected argument "${rest[1]}"`);
    if (flags.yes !== true) {
      const proceed = await confirm(`Delete connector ${id}?`);
      if (!proceed) throw new CliError('cancelled', 2, { error: 'cancelled' });
    }
    const cfg = requireConfig();
    const result = await api(cfg, 'DELETE', `/v1/admin/connectors/${encodeURIComponent(id)}`);
    if (result.status !== 200 && result.status !== 204) {
      throw requestFailure(`deleting connector ${id}`, result);
    }
    if (MODE.json) {
      emitJson({ ok: true, id, deleted: true }, MODE);
      return 0;
    }
    out(`Deleted connector ${id}`);
    return 0;
  }

  throw usage(`unknown connectors subcommand "${sub}" (expected list|create|update|delete)`);
}

async function commandWebhooks(argv) {
  const [sub = 'list', ...args] = argv;
  if (sub === '--help' || sub === '-h') return printHelp('webhooks');
  const { flags, rest } = parseArgv(args);
  if (flags.help) return printHelp('webhooks');
  assertCommandFlags(flags, 'webhooks');

  if (sub === 'list') {
    const cfg = requireConfig();
    const result = await api(cfg, 'GET', '/v1/admin/webhooks');
    if (result.status !== 200) throw requestFailure('listing webhooks', result);
    const webhooks = Array.isArray(result.data?.webhooks) ? result.data.webhooks : [];
    if (MODE.json) {
      emitJson({ ok: true, webhooks }, MODE);
      return 0;
    }
    if (webhooks.length === 0) {
      out('No inbound webhooks configured.');
      return 0;
    }
    out(`Webhooks (${webhooks.length})`);
    for (const webhook of webhooks) {
      const state = webhook.enabled ? ok('active') : muted('paused');
      out(`  ${String(webhook.id).padEnd(22)} ${state.padEnd(8)} ${webhook.name ?? ''}`);
    }
    return 0;
  }

  if (sub === 'create') {
    const name = stringFlag(flags, 'name') ?? 'webhook';
    const body = { name };
    const pathname = '/v1/admin/webhooks';
    if (flags['dry-run'] === true) {
      if (MODE.json) {
        emitJson(
          { ok: true, dry_run: true, request: { method: 'POST', path: pathname, body } },
          MODE
        );
        return 0;
      }
      printDryRun(pathname, body);
      return 0;
    }
    const cfg = requireConfig();
    const result = await api(cfg, 'POST', pathname, body);
    if (result.status !== 201 && result.status !== 200) {
      throw requestFailure('creating the webhook', result);
    }
    const webhook = result.data ?? {};
    if (MODE.json) {
      emitJson({ ok: true, ...webhook }, MODE);
      return 0;
    }
    out(`Created webhook ${webhook.id ?? ''}`);
    out(`  name          ${webhook.name ?? name}`);
    if (typeof webhook.secret === 'string' && webhook.secret !== '') {
      out(`  signing secret (shown once): ${webhook.secret}`);
      out(muted('  store it now; the deployment will not return it again'));
    }
    return 0;
  }

  if (sub === 'deliveries') {
    const id = rest[0];
    if (!id) throw usage('dakflare webhooks deliveries <id>');
    if (rest.length > 1) throw usage(`unexpected argument "${rest[1]}"`);
    const cfg = requireConfig();
    const result = await api(cfg, 'GET', `/v1/admin/webhooks/${encodeURIComponent(id)}/deliveries`);
    if (result.status !== 200) throw requestFailure(`reading deliveries for ${id}`, result);
    const deliveries = Array.isArray(result.data?.deliveries) ? result.data.deliveries : [];
    if (MODE.json) {
      emitJson({ ok: true, deliveries }, MODE);
      return 0;
    }
    if (deliveries.length === 0) {
      out('No deliveries recorded.');
      return 0;
    }
    out(JSON.stringify(deliveries, null, 2));
    return 0;
  }

  if (sub === 'delete') {
    const id = rest[0];
    if (!id) throw usage('dakflare webhooks delete <id> [--yes]');
    if (rest.length > 1) throw usage(`unexpected argument "${rest[1]}"`);
    if (flags.yes !== true) {
      const proceed = await confirm(`Delete webhook ${id}?`);
      if (!proceed) throw new CliError('cancelled', 2, { error: 'cancelled' });
    }
    const cfg = requireConfig();
    const result = await api(cfg, 'DELETE', `/v1/admin/webhooks/${encodeURIComponent(id)}`);
    if (result.status !== 200 && result.status !== 204) {
      throw requestFailure(`deleting webhook ${id}`, result);
    }
    if (MODE.json) {
      emitJson({ ok: true, id, deleted: true }, MODE);
      return 0;
    }
    out(`Deleted webhook ${id}`);
    return 0;
  }

  throw usage(`unknown webhooks subcommand "${sub}" (expected list|create|delete|deliveries)`);
}

async function commandSendConnector(flags) {
  const channel = stringFlag(flags, 'channel').toLowerCase();
  if (!CONNECTOR_CHANNELS.includes(channel)) {
    throw usage(`--channel must be one of ${CONNECTOR_CHANNELS.join(', ')}`);
  }
  const connectorId = stringFlag(flags, 'connector', { required: true });
  requireFlags(flags, ['to', 'body']);
  const to = stringFlag(flags, 'to', { required: true });
  const body = stringFlag(flags, 'body', { required: true });
  if (to === '') throw usage('--to must not be empty');
  if (body.length === 0) throw usage('--body must not be empty');
  if (body.length > MAX_BODY_CHARS) throw usage(`--body is limited to ${MAX_BODY_CHARS} characters`);

  for (const smsOnly of ['device', 'idempotency-key', 'wait', 'until', 'no-wait']) {
    if (flags[smsOnly] !== undefined) {
      throw usage(`--${smsOnly} is only used by the SMS send path`);
    }
  }

  const requestBody = { to, body };
  const templateId = stringFlag(flags, 'template-id');
  if (templateId !== undefined) requestBody.template_id = templateId;
  const mediaUrl = stringFlag(flags, 'media-url');
  if (mediaUrl !== undefined) requestBody.media_url = mediaUrl;
  const commentId = stringFlag(flags, 'comment-id');
  if (commentId !== undefined) requestBody.comment_id = commentId;
  if (flags['human-agent-tag'] === true) requestBody.use_human_agent_tag = true;

  const cfg = requireConfig();
  const pathname = `/v1/channels/${encodeURIComponent(channel)}/${encodeURIComponent(connectorId)}/send`;
  const result = await api(cfg, 'POST', pathname, requestBody);
  if (result.status !== 200) throw requestFailure('sending the channel message', result);
  const delivery = result.data ?? {};
  const state = typeof delivery.state === 'string' ? delivery.state : 'UNKNOWN';
  const passed = state === 'DELIVERED';
  const verification = {
    passed,
    state,
    terminal: state === 'DELIVERED' || state === 'FAILED_PERMANENT',
    reason: delivery.errorCode ?? null,
    next_command: null,
  };

  if (MODE.json) {
    emitJson(
      {
        ok: true,
        channel,
        connector_id: connectorId,
        to,
        channel_message_id: delivery.channelMessageId ?? null,
        state,
        delivery,
        verification,
      },
      MODE
    );
    return 0;
  }

  out('Sent through channel connector');
  out(`  connector     ${connectorId} (${channel})`);
  out(`  to            ${to}`);
  out(`  state         ${state}`);
  out(`  message       ${delivery.channelMessageId ?? 'not assigned'}`);
  if (delivery.errorCode) out(`  reason        ${delivery.errorCode}`);
  return 0;
}

/* ───────────────────────────── send ───────────────────────────── */

function looksLikeE164(value) {
  return /^\+[1-9]\d{6,14}$/.test(value);
}

const CONNECTOR_CHANNELS = ['whatsapp', 'telegram', 'messenger', 'instagram'];

async function commandSend(argv) {
  const { flags } = parseArgv(argv);
  if (flags.help) return printHelp('send');
  assertCommandFlags(flags, 'send');

  const hasChannel = flags.channel !== undefined;
  const hasConnector = flags.connector !== undefined;
  if (hasChannel !== hasConnector) {
    throw usage('--channel and --connector must be used together');
  }
  if (hasChannel) return commandSendConnector(flags);

  const json = MODE.json;
  const cfg = requireConfig();

  requireFlags(flags, ['to', 'body']);
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

  let result;
  try {
    result = await api(cfg, 'POST', '/v1/sms/send', {
      device_id: deviceId,
      to,
      body,
      ...(idempotencyKey === undefined ? {} : { idempotency_key: idempotencyKey }),
    });
  } catch (error) {
    if (error instanceof CliError && error.payload?.error === 'network' && idempotencyKey !== undefined) {
      error.payload.idempotent = true;
    }
    throw error;
  }
  if (result.status === 404 && result.data?.error === 'device_unknown') {
    throw new CliError(
      `device_unknown: "${deviceId}" is not in the D1 registry. Run \`dakflare devices\`.`,
      1,
      { error: 'device_unknown' }
    );
  }
  // 202 means an agent token asked and a human has to decide. It is not a failure
  // and it is not a send; reporting either would be a lie the caller acts on.
  if (result.status === 202 && result.data?.approval_request) {
    const approval = result.data.approval_request;
    if (json) {
      emitJson(
        {
          ok: false,
          error: 'approval_required',
          to,
          sent: false,
          approval_request: approval,
          next: result.data.next,
        },
        MODE
      );
      return exitCodeFor('approval_required');
    }
    out(warn('Not sent. A human has to approve this first.'));
    out(`  approval       ${approval.id}`);
    out(`  scope          ${approval.scope}`);
    out(`  target         ${describeTarget(approval.target)}`);
    out(`  ceiling        ${approval.max_s === null ? 'n/a' : humanDuration(approval.max_s)}`);
    out(`  expires        ${iso(approval.expires_at)}`);
    out(`  approve        dakflare auth approve ${approval.id} --for 15m`);
    return exitCodeFor('approval_required');
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

  const verification = verificationFor(command, { timedOut, deviceId });

  if (json) {
    emitJson({
          // `ok` means the Worker answered and the command exists. The outcome is
          // `verification`, and the exit code follows it when --wait was asked for.
          ok: true,
          context: { ...baseContext(), device_id: deviceId },
          // A fact the caller should notice, not the answer. `device_selection`
          // used to sit in `data`, where it read like a result.
          warnings:
            deviceNote === null
              ? []
              : [`device selection: ${deviceNote}; pass --device to choose`],
          to,
          command_id: commandId,
          replayed,
          state: command.state,
          error_code: command.error_code ?? null,
          error_message: command.error_message ?? null,
          lifecycle: command.lifecycle ?? null,
          verification,
        }, MODE);
    process.exitCode = outcomeExitCode(command, timedOut);
    return;
  }

  out(replayed ? 'Already queued (idempotency key matched)' : 'Queued outbound message');
  out(`  command       ${commandId}`);
  out(`  device        ${deviceId}${deviceNote ? ` (${deviceNote})` : ''}`);
  out(`  to            ${to}`);
  out(`  state         ${command.state}`);
  out(`  meaning       ${stateMeta(command.state).meaning}`);
  if (command.state === 'FAILED' && (command.error_code || command.error_message)) {
    const reason = [command.error_code, command.error_message].filter(Boolean).join(' — ');
    out(`  reason        ${reason}`);
  } else if (command.state === 'EXPIRED') {
    out('  reason        handset did not collect this command before its TTL elapsed');
  }
  if (verification.reason === 'timeout') {
    out(`  not confirmed  the command is still in flight; check with status rather than sending again`);
  }
  if (verification.next_command) out(`  next          ${verification.next_command}`);
  return outcomeExitCode(command, timedOut);
}

/* ─────────────────────── templates, contacts, schedule ─────────────────────── */

const TEMPLATE_CHANNELS = ['any', ...CONNECTOR_CHANNELS];
const SCHEDULE_CHANNELS = ['sms', ...CONNECTOR_CHANNELS];

function isoOrRaw(value) {
  if (value === null || value === undefined) return 'unknown';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function dryRunRequest(method, pathname, body) {
  if (MODE.json) {
    emitJson({ ok: true, dry_run: true, request: { method, path: pathname, body } }, MODE);
    return;
  }
  printDryRun(pathname, body, method);
}

async function commandTemplates(argv) {
  let [sub = 'list', ...args] = argv;
  if (sub === '--help' || sub === '-h') return printHelp('templates');
  if (sub.startsWith('-')) {
    args = [sub, ...args];
    sub = 'list';
  }
  const { flags, rest } = parseArgv(args);
  if (flags.help) return printHelp('templates');
  assertCommandFlags(flags, 'templates');

  if (sub === 'list') {
    const cfg = requireConfig();
    const result = await api(cfg, 'GET', '/v1/admin/templates');
    if (result.status !== 200) throw requestFailure('listing templates', result);
    const templates = Array.isArray(result.data?.templates) ? result.data.templates : [];
    if (MODE.json) {
      emitJson({ ok: true, templates }, MODE);
      return 0;
    }
    if (templates.length === 0) {
      out('No message templates configured.');
      return 0;
    }
    out(`Templates (${templates.length})`);
    for (const template of templates) {
      const variables = Array.isArray(template.variables) ? template.variables : [];
      out(
        `  ${pad(template.id, 22)} ${pad(template.channel ?? 'any', 10)} ${template.name ?? ''}` +
          (variables.length === 0 ? '' : muted(`  (${variables.join(', ')})`))
      );
    }
    return 0;
  }

  if (sub === 'create') {
    requireFlags(flags, ['name', 'body']);
    const channel = (stringFlag(flags, 'channel') ?? 'any').toLowerCase();
    if (!TEMPLATE_CHANNELS.includes(channel)) {
      throw usage(`--channel must be one of ${TEMPLATE_CHANNELS.join(', ')}`);
    }
    const body = {
      name: stringFlag(flags, 'name'),
      channel,
      body: stringFlag(flags, 'body'),
    };
    const pathname = '/v1/admin/templates';
    if (flags['dry-run'] === true) {
      dryRunRequest('POST', pathname, body);
      return 0;
    }
    const cfg = requireConfig();
    const result = await api(cfg, 'POST', pathname, body);
    if (result.status !== 201 && result.status !== 200) {
      throw requestFailure('creating the template', result);
    }
    const template = result.data?.template ?? result.data ?? {};
    const variables = Array.isArray(result.data?.variables)
      ? result.data.variables
      : Array.isArray(template.variables)
        ? template.variables
        : [];
    if (MODE.json) {
      emitJson({ ok: true, template, variables }, MODE);
      return 0;
    }
    out(`Created template ${template.id ?? ''} (${template.channel ?? channel})`);
    if (variables.length > 0) out(`  variables     ${variables.join(', ')}`);
    return 0;
  }

  if (sub === 'delete') {
    const id = rest[0];
    if (!id) throw usage('dakflare templates delete <id> [--yes]');
    if (rest.length > 1) throw usage(`unexpected argument "${rest[1]}"`);
    if (flags.yes !== true) {
      const proceed = await confirm(`Delete template ${id}?`);
      if (!proceed) throw new CliError('cancelled', 2, { error: 'cancelled' });
    }
    const cfg = requireConfig();
    const result = await api(cfg, 'DELETE', `/v1/admin/templates/${encodeURIComponent(id)}`);
    if (result.status !== 200 && result.status !== 204) {
      throw requestFailure(`deleting template ${id}`, result);
    }
    if (MODE.json) {
      emitJson({ ok: true, id, deleted: true }, MODE);
      return 0;
    }
    out(`Deleted template ${id}`);
    return 0;
  }

  throw usage(`unknown templates subcommand "${sub}" (expected list|create|delete)`);
}

async function commandContacts(argv) {
  let [sub = 'import', ...args] = argv;
  if (sub === '--help' || sub === '-h') return printHelp('contacts');
  if (sub.startsWith('-')) {
    args = [sub, ...args];
    sub = 'import';
  }
  const { flags, rest } = parseArgv(args);
  if (flags.help) return printHelp('contacts');
  assertCommandFlags(flags, 'contacts');
  if (sub !== 'import') throw usage(`unknown contacts subcommand "${sub}" (expected import)`);

  const file = rest[0];
  if (!file) throw usage('dakflare contacts import <file.csv>');
  if (rest.length > 1) throw usage(`unexpected argument "${rest[1]}"`);

  let csv;
  try {
    csv = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new CliError(`cannot read ${file}: ${String(error?.message ?? error)}`, 2, {
      error: 'input_missing',
      file,
    });
  }

  const cfg = requireConfig();
  const result = await api(cfg, 'POST', '/v1/admin/contacts/import', csv, {
    headers: { 'Content-Type': 'text/csv', Accept: 'application/json' },
    raw: true,
  });
  if (result.status !== 200 && result.status !== 201) {
    throw requestFailure('importing contacts', result);
  }
  const imported = Number(result.data?.imported ?? 0);
  const skipped = Number(result.data?.skipped ?? 0);
  if (MODE.json) {
    emitJson({ ok: true, imported, skipped }, MODE);
    return 0;
  }
  out(`Imported ${plural(imported, 'contact')}${skipped > 0 ? `; skipped ${skipped}` : ''}.`);
  return 0;
}

async function commandSchedule(argv) {
  let [sub = 'list', ...args] = argv;
  if (sub === '--help' || sub === '-h') return printHelp('schedule');
  if (sub.startsWith('-')) {
    args = [sub, ...args];
    sub = 'list';
  }
  const { flags, rest } = parseArgv(args);
  if (flags.help) return printHelp('schedule');
  assertCommandFlags(flags, 'schedule');

  if (sub === 'list') {
    const cfg = requireConfig();
    const status = stringFlag(flags, 'status');
    const pathname =
      '/v1/scheduled' + (status === undefined ? '' : `?status=${encodeURIComponent(status)}`);
    const result = await api(cfg, 'GET', pathname);
    if (result.status !== 200) throw requestFailure('listing scheduled sends', result);
    const scheduled = Array.isArray(result.data?.scheduled) ? result.data.scheduled : [];
    if (MODE.json) {
      emitJson({ ok: true, scheduled }, MODE);
      return 0;
    }
    if (scheduled.length === 0) {
      out('No scheduled sends.');
      return 0;
    }
    out(`Scheduled sends (${scheduled.length})`);
    for (const item of scheduled) {
      out(
        `  ${pad(item.id, 22)} ${pad(isoOrRaw(item.send_at), 24)} ${pad(item.channel ?? '', 10)} ` +
          `${pad(item.status ?? '', 10)} ${item.to_peer ?? ''}`
      );
    }
    return 0;
  }

  if (sub === 'create') {
    requireFlags(flags, ['target', 'to', 'body', 'at']);
    const channel = (stringFlag(flags, 'channel') ?? 'sms').toLowerCase();
    if (!SCHEDULE_CHANNELS.includes(channel)) {
      throw usage(`--channel must be one of ${SCHEDULE_CHANNELS.join(', ')}`);
    }
    const sendAt = Date.parse(stringFlag(flags, 'at'));
    if (Number.isNaN(sendAt)) {
      throw usage('--at must be an ISO-8601 timestamp, for example 2026-12-01T09:00:00Z');
    }
    const body = {
      channel,
      target_type: channel === 'sms' ? 'device' : 'connector',
      target_id: stringFlag(flags, 'target'),
      to_peer: stringFlag(flags, 'to'),
      body: stringFlag(flags, 'body'),
      send_at: sendAt,
    };
    const templateId = stringFlag(flags, 'template-id');
    if (templateId !== undefined) body.template_id = templateId;

    const pathname = '/v1/scheduled';
    if (flags['dry-run'] === true) {
      dryRunRequest('POST', pathname, body);
      return 0;
    }
    const cfg = requireConfig();
    const result = await api(cfg, 'POST', pathname, body);
    if (result.status !== 201 && result.status !== 200) {
      throw requestFailure('scheduling the send', result);
    }
    const scheduled = result.data?.scheduled ?? result.data ?? {};
    if (MODE.json) {
      emitJson({ ok: true, scheduled }, MODE);
      return 0;
    }
    out(`Scheduled ${scheduled.id ?? ''} for ${isoOrRaw(scheduled.send_at ?? sendAt)}`);
    return 0;
  }

  if (sub === 'cancel') {
    const id = rest[0];
    if (!id) throw usage('dakflare schedule cancel <id> [--yes]');
    if (rest.length > 1) throw usage(`unexpected argument "${rest[1]}"`);
    if (flags.yes !== true) {
      const proceed = await confirm(`Cancel scheduled send ${id}?`);
      if (!proceed) throw new CliError('cancelled', 2, { error: 'cancelled' });
    }
    const cfg = requireConfig();
    const result = await api(cfg, 'DELETE', `/v1/scheduled/${encodeURIComponent(id)}`);
    if (result.status !== 200 && result.status !== 204) {
      throw requestFailure(`cancelling ${id}`, result);
    }
    if (MODE.json) {
      emitJson({ ok: true, id, cancelled: true }, MODE);
      return 0;
    }
    out(`Cancelled ${id}`);
    return 0;
  }

  throw usage(`unknown schedule subcommand "${sub}" (expected list|create|cancel)`);
}

/* ───────────────────────────── up ───────────────────────────── */

/**
 * `dakflare up` — the whole install, on the operator's own account.
 *
 * The CLI itself never talks to Cloudflare; this command shells out to `cf`,
 * which owns auth and the Worker upload. `cf` is a hard requirement rather than
 * an optional one: a second deploy path (wrangler) would differ from this one
 * only on someone else's machine, which is the hardest kind of bug to reproduce.
 *
 * Every step converges. An existing database, namespace or deployment is reused,
 * so running `up` twice is safe and running it on a live deployment repairs it
 * rather than replacing it.
 */
async function commandUp(argv) {
  const { flags } = parseArgv(argv);
  if (flags.help) return printHelp('up');
  assertCommandFlags(flags, 'up');

  const nodeMajor = Number(String(process.versions.node).split('.')[0]);
  if (!Number.isFinite(nodeMajor) || nodeMajor < 22) {
    throw new CliError(
      `dakflare needs Node 22 or newer; this is Node ${process.versions.node}. Install Node 22+ and re-run.`,
      6,
      { error: 'node_too_old', node: process.versions.node, floor: '22' }
    );
  }

  const dryRun = flags['dry-run'] === true;
  const email = stringFlag(flags, 'email');
  if (email !== undefined && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw usage('--email must be an address, for example you@example.com');
  }

  const workerDir = path.join(__dirname, '..', '..', 'worker');
  const repoRoot = path.join(workerDir, '..');
  const plan = [];

  // 1. Dependencies and local secrets: both are inputs to the deploy below.
  ensureRepoDependencies(repoRoot, dryRun, plan);
  await ensureWebhookSecretKey(workerDir, dryRun, plan);

  // 2. cf, and a session it can use. Both failures name the fix rather than
  //    leaving the operator to guess why a deploy did not happen.
  const version = cf(['--version'], { allowFailure: true });
  if (version === null) {
    throw new CliError('the Cloudflare CLI (`cf`) is not on PATH.', 2, {
      error: 'cf_missing',
    });
  }
  let authenticated = cf(['accounts', 'list'], { allowFailure: true }) !== null;
  if (!authenticated && dryRun) {
    plan.push('cf auth login (not authenticated)');
  }
  if (!authenticated && !dryRun) {
    if (MODE.agent || !process.stdin.isTTY) {
      throw new CliError(
        '`cf` is installed but not authenticated. Run `cf auth login`, then re-run `dakflare up`.',
        4,
        { error: 'cf_not_authenticated' }
      );
    }
    out('Cloudflare CLI is not logged in. Launching `cf auth login` now...');
    const login = spawnSync('cf', ['auth', 'login'], { stdio: 'inherit' });
    if (login.error || login.status !== 0) {
      throw new CliError(
        '`cf auth login` did not complete. Run it, then re-run `dakflare up`.',
        4,
        { error: 'cf_not_authenticated' }
      );
    }
    authenticated = cf(['accounts', 'list'], { allowFailure: true }) !== null;
    if (!authenticated) {
      throw new CliError(
        '`cf` is still not authenticated. Run `cf auth login`, then re-run `dakflare up`.',
        4,
        { error: 'cf_not_authenticated' }
      );
    }
  }

  // 3. Converge the resources. `d1 list --name` is a search, so the match is on
  //    the exact name; anything else would adopt the preview database. Queues
  //    come before the deploy so the consumer configuration can bind them.
  let databaseId;
  let namespaceId;
  if (authenticated) {
    databaseId = ensureD1('sms_gateway', dryRun, plan);
    namespaceId = ensureKv('KV', dryRun, plan);
    ensureQueues(dryRun, plan);
  } else {
    databaseId = '<new-database-id>';
    namespaceId = '<new-namespace-id>';
    plan.push('d1 sms_gateway: create or reuse (cf not authenticated)');
    plan.push('kv KV: create or reuse (cf not authenticated)');
    for (const name of UP_QUEUES) plan.push(`queue ${name}: create if missing (cf not authenticated)`);
  }

  // 4. Write the ids into the config the deploy reads.
  const configPath = path.join(workerDir, 'cloudflare.config.ts');
  const configChange = writeConfigIds(configPath, databaseId, namespaceId, dryRun);
  plan.push(configChange);

  // 5. Migrate, then deploy with the secrets `init --local` already wrote.
  plan.push(`cf d1 migrations apply ${databaseId} --remote`);
  plan.push('cf deploy --secrets-file .dev.vars');
  plan.push(
    email === undefined
      ? 'owner: skipped (pass --email to bootstrap one)'
      : `owner: bootstrap ${email} (skipped if one exists)`
  );
  plan.push('pair: mint one pairing code');

  if (dryRun) {
    if (MODE.json) {
      emitJson({ ok: true, summary: `plan: ${plan.length} steps`, dry_run: true, plan }, MODE);
      return 0;
    }
    out('Plan (nothing was changed)');
    for (const step of plan) out(`  ${step}`);
    out('');
    out('Re-run without --dry-run to apply.');
    return 0;
  }

  if (flags.yes !== true) {
    const confirmed = await confirm(`Deploy to the account cf is logged into? [y/N] `);
    if (!confirmed) {
      throw new CliError('cancelled before deploying.', 1, { error: 'cancelled' });
    }
  }

  runCf(['d1', 'migrations', 'apply', databaseId, '--remote'], workerDir, 'applying migrations');

  const dashboardEntry = path.join(workerDir, 'public', 'admin', 'index.html');
  if (!fs.existsSync(dashboardEntry)) {
    const built = spawnSync('npm', ['run', 'build:dashboard'], {
      cwd: workerDir,
      encoding: 'utf8',
    });
    if (built.error || built.status !== 0) {
      throw new CliError(
        `building console assets failed: ${(built.stderr || built.stdout || built.error?.message || '').trim()}`,
        1,
        { error: 'provision_failed', step: 'build:dashboard' }
      );
    }
  }

  const deploy = runCf(['deploy', '--secrets-file', '.dev.vars'], workerDir, 'deploying');

  // 6. Verify against the deployment, not against the exit status of a deploy.
  const url = readDeployUrl(deploy.stdout) ?? readConfigUrl();
  if (url === null) {
    throw new CliError(
      'the deploy succeeded but its URL could not be read; run `dakflare init --url <url>`.',
      6,
      { error: 'provision_failed' }
    );
  }
  const upToken = readUpAdminToken(workerDir);
  const health = await fetchHealthFor(url, upToken);

  // 7. Save the deployment so `doctor` and every other command work without a
  //    second `init --url`.
  let savedConfigPath = null;
  if (upToken !== '') {
    saveConfig({ url, token: upToken, installedAt: new Date().toISOString() });
    savedConfigPath = CONFIG_FILE;
  }

  // 8. The owner account, then a pairing code. Both are what "installed" means:
  //    a deployment nobody can sign in to, or pair with, is not one.
  const owner = await bootstrapOwner(url, email, upToken);
  const pairing = await mintPairingCode(url, upToken);
  const deepLink = pairing?.code
    ? `dakflare://pair?u=${encodeURIComponent(url)}&c=${encodeURIComponent(pairing.code)}`
    : null;
  const qr = deepLink !== null && !MODE.json ? qrText(deepLink) : null;

  if (MODE.json) {
    emitJson(
      {
        ok: true,
        summary: `deployed ${url}`,
        url,
        database_id: databaseId,
        kv_namespace_id: namespaceId,
        healthy: health,
        config: { path: savedConfigPath, saved: savedConfigPath !== null },
        owner,
        pairing,
        deep_link: deepLink,
      },
      MODE
    );
    return 0;
  }
  out(`Deployed ${url}`);
  out(`  database      ${databaseId}`);
  out(`  kv namespace  ${namespaceId}`);
  out(`  config        ${savedConfigPath ?? 'not saved (no admin token found)'}`);
  out(`  health        ${health ? 'ok' : 'not healthy: run `dakflare doctor`'}`);
  if (owner.state === 'created') {
    out('');
    out('Owner invite (shown once):');
    out(`  ${owner.link}`);
  } else if (owner.state === 'exists') {
    out('  owner         already exists; no invite minted');
  } else if (owner.state === 'skipped' || owner.state === 'failed') {
    out(`  owner         ${owner.state} (${owner.reason ?? `HTTP ${owner.status ?? '?'}`})`);
  }
  if (pairing?.code) {
    out('');
    out(`Pairing code ${pairing.code} (expires in ${pairing.expires_in}s)`);
    if (deepLink !== null) out(`  link          ${deepLink}`);
    if (qr) {
      out('');
      out(qr);
    }
  }
  return 0;
}

/** Run `cf`, returning stdout, or null when the command failed. */
function cf(args, { allowFailure = false, cwd } = {}) {
  const result = spawnSync('cf', args, { cwd, encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    if (allowFailure) return null;
    throw new CliError(
      `cf ${args.join(' ')} failed: ${(result.stderr || result.stdout || result.error?.message || '').trim()}`,
      1,
      { error: 'cf_failed' }
    );
  }
  return result.stdout;
}

/** Run `cf` and turn a failure into a named step, so the operator knows where it stopped. */
function runCf(args, cwd, step) {
  const result = spawnSync('cf', args, { cwd, encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    const detail = (result.stderr || result.stdout || result.error?.message || '').trim();
    throw new CliError(`cf ${step} failed: ${detail}`, 1, { error: 'cf_failed', step });
  }
  return result;
}

function cfJson(args) {
  const raw = cf(args);
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * `cf queues list` prints a `result_info:` line before its JSON array, so the
 * document starts at the first `[` rather than at byte zero.
 */
function cfJsonArray(args) {
  const raw = String(cf(args) ?? '');
  const start = raw.indexOf('[');
  if (start === -1) return null;
  try {
    const parsed = JSON.parse(raw.slice(start));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const UP_QUEUES = ['dakflare-webhook-queue', 'dakflare-ingest-queue', 'dakflare-ingest-dlq'];

/**
 * Install what the build and deploy read. A missing `node_modules` is repaired
 * rather than reported: the install is convergent and the failure names the
 * exact directory that broke.
 */
function ensureRepoDependencies(repoRoot, dryRun, plan) {
  for (const dir of ['worker', 'dashboard']) {
    const full = path.join(repoRoot, dir);
    if (!fs.existsSync(path.join(full, 'package.json'))) {
      plan.push(`deps ${dir}: no package.json (skipped)`);
      continue;
    }
    if (fs.existsSync(path.join(full, 'node_modules'))) {
      plan.push(`deps ${dir}: node_modules present`);
      continue;
    }
    if (dryRun) {
      plan.push(`deps ${dir}: npm install (node_modules missing)`);
      continue;
    }
    out(`Installing dependencies in ${dir}/...`);
    const result = spawnSync('npm', ['install'], { cwd: full, encoding: 'utf8' });
    if (result.error || result.status !== 0) {
      const detail = (result.stderr || result.stdout || result.error?.message || '').trim();
      throw new CliError(
        `npm install failed in ${full} (exit ${result.status ?? 'n/a'}): ${detail}`,
        1,
        { error: 'dependency_install_failed', directory: full }
      );
    }
    plan.push(`deps ${dir}: installed`);
  }
}

/**
 * `worker/.dev.vars` must exist and carry WEBHOOK_SECRET_KEY before the deploy,
 * because a sealed webhook secret cannot be created without it. An existing file
 * gains only the missing key; its other lines are never touched.
 */
async function ensureWebhookSecretKey(workerDir, dryRun, plan) {
  const file = path.join(workerDir, '.dev.vars');
  if (!fs.existsSync(file)) {
    if (dryRun) {
      plan.push(
        'worker/.dev.vars: create (ADMIN_TOKEN, AUTH_PEPPER, BETTER_AUTH_SECRET, WEBHOOK_SECRET_KEY)'
      );
      return;
    }
    await initLocal({}, false, workerDir, { quiet: true });
    plan.push('worker/.dev.vars: created with WEBHOOK_SECRET_KEY');
    return;
  }

  const raw = fs.readFileSync(file, 'utf8');
  if (/^WEBHOOK_SECRET_KEY=/m.test(raw)) {
    plan.push('worker/.dev.vars: present (WEBHOOK_SECRET_KEY set)');
    return;
  }
  if (dryRun) {
    plan.push('worker/.dev.vars: append WEBHOOK_SECRET_KEY');
    return;
  }
  const separator = raw === '' || raw.endsWith('\n') ? '' : '\n';
  fs.appendFileSync(
    file,
    `${separator}WEBHOOK_SECRET_KEY=${crypto.randomBytes(32).toString('base64')}\n`,
    { encoding: 'utf8', mode: 0o600 }
  );
  plan.push('worker/.dev.vars: appended WEBHOOK_SECRET_KEY');
}

/** Create the queues the Worker consumes, before the deploy binds them. */
function ensureQueues(dryRun, plan) {
  const rows = cfJsonArray(['queues', 'list']) ?? [];
  const existing = new Set(
    rows.map((row) => row.queue_name ?? row.name).filter((name) => typeof name === 'string')
  );
  for (const name of UP_QUEUES) {
    if (existing.has(name)) {
      plan.push(`queue ${name}: reuse`);
      continue;
    }
    if (dryRun) {
      plan.push(`queue ${name}: create`);
      continue;
    }
    runCf(['queues', 'create', name], undefined, `creating queue ${name}`);
    plan.push(`queue ${name}: created`);
  }
}

/** The database id, creating it only when the name is not already taken. */
function ensureD1(name, dryRun, plan) {
  const rows = cfJson(['d1', 'list', '--name', name]) ?? [];
  const existing = rows.find((row) => row.name === name);
  if (existing?.uuid) {
    plan.push(`d1 ${name}: reuse ${existing.uuid}`);
    return existing.uuid;
  }
  if (dryRun) {
    plan.push(`d1 ${name}: create`);
    return '<new-database-id>';
  }
  const created = cfJson(['d1', 'create', name]);
  const uuid = created?.uuid ?? created?.result?.uuid;
  if (typeof uuid !== 'string') {
    throw new CliError('`cf d1 create` did not return an id.', 6, { error: 'provision_failed' });
  }
  return uuid;
}

/** The namespace id, matched on the exact title. */
function ensureKv(title, dryRun, plan) {
  const rows = cfJson(['kv', 'namespaces', 'list']) ?? [];
  const existing = rows.find((row) => row.title === title);
  if (existing?.id) {
    plan.push(`kv ${title}: reuse ${existing.id}`);
    return existing.id;
  }
  if (dryRun) {
    plan.push(`kv ${title}: create`);
    return '<new-namespace-id>';
  }
  const created = cfJson(['kv', 'namespaces', 'create', title]);
  const id = created?.id ?? created?.result?.id;
  if (typeof id !== 'string') {
    throw new CliError('`cf kv namespaces create` did not return an id.', 6, {
      error: 'provision_failed',
    });
  }
  return id;
}

/**
 * Put both ids into `cloudflare.config.ts`, editing in place.
 *
 * The file is regenerated from the template only when it is missing: a fork
 * starts from the template, and the maintainer's copy may carry local edits that
 * a regeneration would silently drop.
 */
function writeConfigIds(configPath, databaseId, namespaceId, dryRun) {
  const templatePath = path.join(path.dirname(configPath), 'cloudflare.config.template.ts');
  let source;
  try {
    source = fs.readFileSync(configPath, 'utf8');
  } catch {
    source = fs.readFileSync(templatePath, 'utf8');
  }

  const withKv = source.replace(
    /(KV: bindings\.kv\(\{[\s\S]*?id:\s*")[^"]*(")/,
    `$1${namespaceId}$2`
  );
  const withDb = withKv.replace(
    /(DB: bindings\.d1\(\{)([\s\S]*?)(\})/,
    (match, head, body, tail) =>
      /id:\s*"[^"]*"/.test(body)
        ? `${head}${body.replace(/id:\s*"[^"]*"/, `id: "${databaseId}"`)}${tail}`
        : `${head}${body.trimEnd()}\n\t\t\t\tid: "${databaseId}",\n\t\t\t${tail}`
  );

  if (withDb === source) {
    return 'cloudflare.config.ts: ids already match';
  }
  if (!dryRun) fs.writeFileSync(configPath, withDb);
  return `cloudflare.config.ts: ${dryRun ? 'would set' : 'set'} DB and KV ids`;
}

/** The deployment URL from a `cf deploy` transcript, if it prints one. */
function readDeployUrl(stdout) {
  const match = /https:\/\/[A-Za-z0-9.-]+\.workers\.dev/.exec(String(stdout ?? ''));
  return match ? match[0] : null;
}

function readConfigUrl() {
  const { cfg } = readConfig();
  return typeof cfg?.url === 'string' && cfg.url !== '' ? cfg.url.replace(/\/+$/, '') : null;
}

function readUpAdminToken(workerDir) {
  const saved = readConfig().cfg?.token;
  if (typeof saved === 'string' && saved.trim() !== '') return saved.trim();
  const varsFile = path.join(workerDir, '.dev.vars');
  try {
    if (fs.existsSync(varsFile)) {
      const parsed = parseTokenFileContent(fs.readFileSync(varsFile, 'utf8'));
      if (parsed !== '') return parsed;
    }
  } catch {
    /* ignore unreadable .dev.vars */
  }
  return '';
}

/** One health read, without needing a config that points at the new deployment. */
async function fetchHealthFor(url, token = '') {
  try {
    const response = await fetch(`${url}/v1/admin/health`, {
      headers: {
        Accept: 'application/json',
        'X-Dakflare-Client': 'cli',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    return response.status === 200 || response.status === 503;
  } catch {
    return false;
  }
}

/**
 * Create the owner, or report that one exists.
 *
 * `auth bootstrap` refuses once an owner is present, which on a second `up` is
 * the correct and uninteresting outcome.
 */
async function bootstrapOwner(url, email, fallbackToken = '') {
  const address = email ?? process.env.DAKFLARE_OWNER_EMAIL;
  if (address === undefined || address === '') {
    return { state: 'skipped', reason: 'no --email given' };
  }
  const cfg = { url, token: readConfig().cfg?.token || fallbackToken || '' };
  if (cfg.token === '') return { state: 'skipped', reason: 'no admin token saved' };

  const result = await api(cfg, 'POST', '/v1/admin/bootstrap', { email: address, role: 'owner' });
  if (result.status === 201 || result.status === 200) {
    return { state: 'created', email: address, link: result.data?.link ?? null };
  }
  if (result.status === 409) return { state: 'exists', email: address };
  return { state: 'failed', email: address, status: result.status };
}

/** Mint one pairing code so the install ends with a phone-ready deployment. */
async function mintPairingCode(url, fallbackToken = '') {
  const cfg = { url, token: readConfig().cfg?.token || fallbackToken || '' };
  if (cfg.token === '') return null;
  const result = await api(cfg, 'POST', '/v1/admin/pairing-code', {
    ttl_ms: DEFAULT_PAIR_TTL_S * 1000,
  });
  if (result.status !== 200) return null;
  return {
    code: result.data?.pairing_code ?? null,
    expires_in: Math.round(((result.data?.expires_at ?? 0) - Date.now()) / 1000) || DEFAULT_PAIR_TTL_S,
  };
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

  if (flags['flow-v2'] === true || rest[0] === 'flow-v2' || rest[0] === 'flow/v2') {
    return printFlowV2Schema();
  }

  if (rest[0] === 'states' || rest[0] === 'lifecycle') {
    const statesSchema = {
      command: 'states',
      summary: 'State machines and transition contracts across commands, grants, approvals, alerts, tokens, and presence',
      machines: STATE_MACHINES,
      global: ['--json', '--agent', '--help'],
    };
    if (MODE.json) {
      emitJson({ ok: true, ...statesSchema }, MODE);
      return 0;
    }
    out(JSON.stringify(statesSchema, null, 2));
    return 0;
  }

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
    // Only the commands whose `data` carries a decision document it; the rest
    // rely on the uniform envelope, where `data` is a list or a string.
    ...(spec.response === undefined ? {} : { response: spec.response }),
    global: ['--json', '--agent', '--help'],
  };

  if (MODE.json) {
    emitJson({ ok: true, ...schema }, MODE);
    return 0;
  }
  out(JSON.stringify(schema, null, 2));
  return 0;
}

/**
 * `schema --flow-v2` — the canonical flow document contract, as a document.
 *
 * With `--json` this is the schema and nothing else: a caller piping it into a
 * validator must not have to unwrap an envelope. Without it, a person gets the
 * shape in six lines and the path the file lives at.
 */
function printFlowV2Schema() {
  let raw;
  try {
    raw = fs.readFileSync(FLOW_V2_SCHEMA_PATH, 'utf8');
  } catch (error) {
    throw new CliError(
      `cannot read ${FLOW_V2_SCHEMA_PATH}: ${error?.message ?? error}. The schema ships with the CLI.`,
      2,
      { error: 'flow_schema_missing', schema: FLOW_V2_SCHEMA_PATH }
    );
  }

  if (MODE.json) {
    // Deliberately not the envelope: `--json` promises the schema document,
    // and `--agent` requires one compact single-line JSON document on stdout.
    out(MODE.agent ? JSON.stringify(JSON.parse(raw)) : raw.trimEnd());
    return 0;
  }

  let document;
  try {
    document = JSON.parse(raw);
  } catch {
    throw new CliError(`${FLOW_V2_SCHEMA_PATH} is not valid JSON.`, 2, {
      error: 'flow_schema_missing',
      schema: FLOW_V2_SCHEMA_PATH,
    });
  }
  const nodeKinds = document?.$defs?.node?.properties?.type?.enum ?? [];
  out(`Flow IR        ${document?.properties?.schema?.const ?? 'dakflare.flow/v2'}`);
  out(`Schema file    ${FLOW_V2_SCHEMA_PATH}`);
  out(`Nodes          ${nodeKinds.join(', ')}`);
  out(`Limits         ${document?.properties?.nodes?.maxItems ?? '?'} nodes, ${document?.properties?.edges?.maxItems ?? '?'} edges`);
  out(`Edges          id, source, target, sourceHandle (true|false, case:<i>|default), label`);
  out(`Template spans role (trigger|extract|ignore), name, slot_type, start, end, optional`);
  out(`Apply handle   ${Object.keys(document?.$defs?.authority_target?.properties ?? {}).join(', ')}`);
  out(muted('  `dakflare schema --flow-v2 --json` prints the schema itself, nothing else'));
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

/**
 * One sentence per command, written once and derived from the payload only where
 * the payload is the answer.
 *
 * A summary that restates `data` wastes the caller's tokens; a summary that says
 * what happened is what makes a log readable. Commands with nothing interesting
 * to say get a plain sentence rather than an invented one.
 */
const SUMMARY_BUILDERS = {
  init: (data) => (data.local === true ? 'wrote worker/.dev.vars' : 'deployment configured'),
  doctor: (data) =>
    data.counts
      ? `${data.counts.pass} passed, ${data.counts.fail} failed, ${data.counts.skip} skipped`
      : 'checked the deployment',
  pair: () => 'pairing code minted',
  devices: (data) => `${(data.devices ?? []).length} devices paired`,
  revoke: (data) => `revoked ${data.device_id ?? 'the device'}`,
  send: (data) =>
    data.delivery
      ? data.delivery.success === true
        ? 'sent through the channel connector'
        : 'the channel refused the message'
      : data.replayed
        ? 'already queued for that key'
        : 'queued for the radio',
  status: (data) => `command is ${data.state ?? 'unknown'}`,
  connectors: (data) =>
    data.dry_run === true
      ? 'dry run, nothing sent'
      : data.connectors
        ? `${(data.connectors ?? []).length} connectors`
        : data.connector
          ? `connector ${data.connector.id ?? ''} written`.trim()
          : data.deleted === true
            ? `connector ${data.id ?? ''} deleted`.trim()
            : 'connectors',
  webhooks: (data) =>
    data.dry_run === true
      ? 'dry run, nothing sent'
      : data.webhooks
        ? `${(data.webhooks ?? []).length} webhooks`
        : data.deliveries
          ? `${(data.deliveries ?? []).length} deliveries`
          : data.secret
            ? 'webhook created; secret shown once'
            : data.deleted === true
              ? `webhook ${data.id ?? ''} deleted`.trim()
              : 'webhooks',
  audit: (data) => `${(data.entries ?? data.events ?? []).length} audit rows`,
  auth: (data) =>
    data.token
      ? 'agent token minted'
      : data.agent_tokens
        ? `${(data.agent_tokens ?? []).length} agent tokens`
        : data.approvals
          ? `${(data.approvals ?? []).length} approval requests`
          : data.grants
            ? `${(data.grants ?? []).length} grants`
            : data.grant
              ? 'authority granted'
              : data.approval
                ? `request ${data.approval.state.toLowerCase()}`
                : data.link
                  ? 'invite minted'
                  : 'owner account updated',
  key: () => 'signing key read',
  up: (data) => (data.url ? `deployed ${data.url}` : 'planned the install'),
  flows: (data) =>
    data.healed === true
      ? `flow healed to v${data.to_version}`
      : data.healed === false
        ? 'heal refused, nothing written'
        : data.applied === true
          ? 'flow applied'
          : 'flow diffed, nothing written',
  extract: (data) => (data.pattern ? 'pattern synthesized' : 'nothing synthesized'),
  ask: (data) =>
    data.approval_required === true
      ? 'patch judged; approval required'
      : data.faithful
        ? 'patch judged'
        : 'nothing judged',
  fix: (data) => (data.card?.code ? `root cause ${data.card.code}` : 'no failure signature matched'),
  flow: (data) =>
    data.spent === true
      ? 'apply handle spent'
      : data.already_decided === true
        ? `request already ${String(data.state ?? 'decided').toLowerCase()}`
        : data.linear_time_guaranteed === true
          ? `${(data.rows ?? 0) - (data.mismatches ?? []).length}/${data.rows ?? 0} corpus rows agreed`
          : 'corpus scored',
  trace: (data) => `verdict ${data.verdict ?? 'unknown'}`,
  mcp: () => 'served MCP on stdio',
  alerts: (data) => `${(data.alerts ?? []).length} open alerts`,
  dlq: (data) => `${(data.dead_letters ?? []).length} dead letters`,
  ws: (data) => `${(data.sockets ?? []).length} sockets`,
  rules: (data) =>
    data.updated === true
      ? `rule ${data.id ?? ''} updated`.trim()
      : data.deleted === true
        ? `rule ${data.id ?? ''} deleted`.trim()
        : data.applied === true
          ? `${(data.rules ?? []).length} rules applied`
          : data.matches
            ? `${(data.matches ?? []).length} rules evaluated`
            : Array.isArray(data.rules)
              ? `${data.rules.length} rules`
              : 'rules diffed, nothing written',
  capabilities: (data) => `${(data.commands ?? []).length} commands`,
  describe: (data) => `${data.command ?? 'command'} described`,
  schema: (data) => `${data.command ?? 'command'} schema`,
  examples: (data) => `${(data.examples ?? []).length} examples`,
  ai: (data) =>
    data.models
      ? `${data.models.length} models`
      : data.provider
        ? `provider ${data.provider}`
        : 'AI check ok',
};

function summaryFor(command, data) {
  const build = SUMMARY_BUILDERS[command];
  if (build === undefined) return undefined;
  try {
    return build(data ?? {});
  } catch {
    return undefined;
  }
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

  const verification = verificationFor(command, { timedOut, deviceId });

  if (json) {
    emitJson({
          ok: true,
          context: { ...baseContext(), device_id: deviceId },
          warnings:
            note === null ? [] : [`device selection: ${note}; pass --device to choose`],
          command_id: commandId,
          state: command.state,
          command,
          verification,
        }, MODE);
    process.exitCode = outcomeExitCode(command, timedOut);
    return;
  }

  renderCommand(command, { deviceId, note });
  return outcomeExitCode(command, timedOut);
}

/* ───────────────────────────── audit ───────────────────────────── */

/** The console's own invite URL: clickable in any browser, unlike the app scheme. */
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
    if (json) emitJson({ ok: false, error: 'not_registered' }, MODE);
    else out(message);
    return exitCodeFor('not_registered');
  }
  if (result.status !== 200) throw requestFailure('reset', result);

  const token = result.data?.token ?? null;
  const link = token ? `dakflare://invite?u=${encodeURIComponent(cfg.url)}&t=${encodeURIComponent(token)}` : null;
  if (json) emitJson({ ok: true, email, link }, MODE);
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
  if (sub === 'mint-agent-token') return commandAuthMintAgentToken(rest);
  if (sub === 'agent-tokens') return commandAuthAgentTokens(rest);
  if (sub === 'revoke-agent-token') return commandAuthRevokeAgentToken(rest);
  if (sub === 'approvals') return commandAuthApprovals(rest);
  if (sub === 'approve') return commandAuthApprove(rest);
  if (sub === 'reject') return commandAuthReject(rest);
  if (sub === 'grants') return commandAuthGrants(rest);
  throw usage(`unknown auth subcommand "${sub}"`);
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
    const code = result.data?.error === 'already_registered' ? 'already_registered' : 'owner_exists';
    const reason = code === 'already_registered' ? 'that address already has an account' : 'an owner already exists on this deployment';
    if (json) emitJson({ ok: false, error: code }, MODE);
    else out(reason);
    return exitCodeFor(code);
  }
  if (result.status !== 200) throw requestFailure('bootstrap', result);

  // The first owner is an invite, not an account: an account with no credential
  // has no way to obtain one once the flag flips. Redeeming creates it.
  const token = result.data?.token ?? null;
  const link = token ? `dakflare://invite?u=${encodeURIComponent(cfg.url)}&t=${encodeURIComponent(token)}` : null;
  if (json) emitJson({ ok: true, email, role: 'owner', link }, MODE);
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
    emitJson({ ok: true, email, role, link, expires_in: ttlSeconds }, MODE);
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
    emitJson({ ok: true, invites }, MODE);
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

/* ─────────────────── drift and healing (v6.1 P5) ─────────────────── */

/**
 * `flows heal <id> --samples <file>` — re-derive a broken extract, but only if it
 * still reads the history the same way.
 *
 * The gate is the point. A new pattern that fixes today's template and silently
 * changes what yesterday's messages extract would turn a visible drift into an
 * invisible one, so every historical body the OLD pattern matched must produce the
 * SAME value through the new one, byte for byte. One difference and nothing is
 * written.
 */
async function commandFlowsHeal(argv) {
  const { flags, rest } = parseArgv(argv);
  if (flags.help) return printHelp('flows');
  assertCommandFlags(flags, 'flows');
  const json = MODE.json;

  const flowId = stringFlag(flags, 'id') ?? rest[0];
  if (!flowId) throw usage('dakflare flows heal <flow-id> --samples <file>');
  const samplesFile = stringFlag(flags, 'samples');
  if (samplesFile === undefined) throw usage('--samples <file> is required: the new examples');

  const corpusLimitFlag = stringFlag(flags, 'corpus-limit');
  const corpusLimit = corpusLimitFlag === undefined ? 200 : Number(corpusLimitFlag);
  if (!Number.isFinite(corpusLimit) || corpusLimit < 1 || corpusLimit > 500) {
    throw usage('--corpus-limit must be between 1 and 500');
  }

  const cfg = requireConfig();
  const current = await api(cfg, 'GET', `/v1/admin/workflows/${encodeURIComponent(flowId)}`);
  if (current.status === 404) {
    throw new CliError(`no flow ${flowId}`, 3, { error: 'not_found', flow_id: flowId });
  }
  if (current.status !== 200) throw requestFailure('read the flow', current);
  const flow = current.data?.workflow ?? {};
  const graph = flow.graph ?? {};
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];

  // Which extract node broke. Named explicitly, or the only one there is.
  const extracts = nodes.filter((node) => node.type === 'extract');
  const nodeId = stringFlag(flags, 'node');
  const target =
    nodeId === undefined
      ? extracts.length === 1
        ? extracts[0]
        : null
      : extracts.find((node) => node.id === nodeId) ?? null;
  if (target === null) {
    throw usage(
      extracts.length === 0
        ? `${flowId} has no extract node to heal`
        : `--node is required: ${flowId} has ${extracts.length} extract nodes (${extracts.map((n) => n.id).join(', ')})`
    );
  }

  /* ---- the new pattern, from the samples ---------------------------- */
  const samplesDoc = readJsonDocument(samplesFile);
  const samples = Array.isArray(samplesDoc) ? samplesDoc : samplesDoc.samples;
  if (!Array.isArray(samples) || samples.length === 0) {
    throw usage(`${samplesFile}: expected { "samples": [ { "body", "value" } ] } or a bare array`);
  }
  const group =
    stringFlag(flags, 'group') ??
    (typeof samplesDoc?.group === 'string' ? samplesDoc.group : undefined);

  const engine = await loadFlowEngine();
  const synthesized = callFlowEngine(engine, 'synthesize_json', {
    samples,
    negatives: Array.isArray(samplesDoc?.negatives) ? samplesDoc.negatives : [],
    ...(group === undefined ? {} : { group }),
  });
  if (synthesized.ok !== true) {
    if (json) {
      emitJson(
        {
          ok: false,
          error: 'synthesis_refused',
          reason: synthesized.reason,
          message: synthesized.message,
          healed: false,
        },
        MODE
      );
      return exitCodeFor('synthesis_refused');
    }
    out(fail(`Refused: ${synthesized.message}`));
    out(`  reason         ${synthesized.reason}`);
    return exitCodeFor('synthesis_refused');
  }
  const newPattern = synthesized.result.pattern;

  /* ---- the corpus: what the OLD pattern reads today ------------------ */
  const deviceId =
    typeof flow.device_id === 'string' && flow.device_id !== ''
      ? flow.device_id
      : (await resolveDevice(cfg, stringFlag(flags, 'device'))).deviceId;

  const listed = await api(
    cfg,
    'GET',
    `/v1/messages?device_id=${encodeURIComponent(deviceId)}&limit=${Math.round(corpusLimit)}`
  );
  if (listed.status !== 200) throw requestFailure('read the history for the gate', listed);
  const corpus = (listed.data?.messages ?? []).filter((row) => row.direction === 'in');

  const oldPattern = String(target.data?.pattern ?? '');
  const groupName = synthesized.result.group;
  let regexOld = null;
  let regexNew = null;
  try {
    regexOld = oldPattern === '' ? null : new RegExp(oldPattern);
    regexNew = new RegExp(newPattern);
  } catch (error) {
    throw new CliError(`a pattern does not compile in JavaScript: ${error.message}`, 1, {
      error: 'bad_response',
    });
  }

  const breakage = [];
  let matchedBefore = 0;
  for (const row of corpus) {
    const body = String(row.body ?? '');
    const before = regexOld === null ? null : regexOld.exec(body);
    const valueBefore = before?.groups?.[groupName] ?? null;
    if (valueBefore === null) continue;
    matchedBefore += 1;
    const after = regexNew.exec(body);
    const valueAfter = after?.groups?.[groupName] ?? null;
    if (valueAfter !== valueBefore) {
      breakage.push({
        message_id: row.id,
        local_id: row.local_id,
        expected: valueBefore,
        actual: valueAfter,
      });
    }
  }

  const gate = {
    device_id: deviceId,
    checked: corpus.length,
    matched_before: matchedBefore,
    broken: breakage.length,
  };

  if (breakage.length > 0) {
    if (json) {
      emitJson(
        {
          ok: false,
          error: 'heal_refused',
          healed: false,
          flow_id: flowId,
          node_id: target.id,
          pattern: newPattern,
          gate,
          breakage: breakage.slice(0, 10),
          message: `${breakage.length} historical message(s) would extract differently`,
        },
        MODE
      );
      return exitCodeFor('heal_refused');
    }
    out(fail(`Refused: the new pattern changes ${breakage.length} of ${matchedBefore} historical extractions`));
    for (const row of breakage.slice(0, 5)) {
      out(`  ${row.local_id ?? row.message_id}  expected ${JSON.stringify(row.expected)}, got ${JSON.stringify(row.actual)}`);
    }
    out(muted('  nothing was written; a heal must not turn a visible drift into an invisible one'));
    return exitCodeFor('heal_refused');
  }

  /* ---- write it, guarded on the version we read ---------------------- */
  const healedGraph = {
    ...graph,
    nodes: nodes.map((node) =>
      node.id === target.id
        ? { ...node, data: { ...(node.data ?? {}), pattern: newPattern } }
        : node
    ),
  };

  if (flags['dry-run'] === true) {
    if (json) {
      emitJson(
        {
          ok: true,
          healed: false,
          dry_run: true,
          flow_id: flowId,
          node_id: target.id,
          from_version: flow.version,
          pattern: newPattern,
          gate,
        },
        MODE
      );
      return 0;
    }
    out(`Would heal ${flowId} (v${flow.version})`);
    out(`  node           ${target.id}`);
    out(`  pattern        ${newPattern}`);
    out(`  gate           ${matchedBefore} of ${corpus.length} historical messages still read identically`);
    out(muted('  --dry-run: nothing was written'));
    return 0;
  }

  const written = await api(cfg, 'PUT', `/v1/admin/workflows/${encodeURIComponent(flowId)}`, {
    name: flow.name,
    graph: healedGraph,
    ...(flow.device_id === undefined || flow.device_id === null ? {} : { device_id: flow.device_id }),
    enabled: flow.enabled !== false,
    expected_previous_version: flow.version,
  });
  if (written.status === 409) {
    if (json) emitJson({ ok: false, error: 'version_conflict', ...(written.data ?? {}), healed: false }, MODE);
    else out(warn(`Refused: ${written.data?.message ?? 'the flow changed while healing'}`));
    return exitCodeFor('version_conflict');
  }
  if (written.status !== 200) {
    if (written.data?.error === 'workflow_invalid') {
      const issues = written.data.details ?? [];
      if (json) emitJson({ ok: false, error: 'workflow_invalid', details: issues, healed: false }, MODE);
      else {
        out(fail(`Refused: the healed graph has ${issues.length} issue(s)`));
        for (const issue of issues) out(`  ${issue.path}: ${issue.message}`);
      }
      return exitCodeFor('workflow_invalid');
    }
    throw requestFailure('write the healed flow', written);
  }

  const result = written.data?.workflow ?? {};
  if (json) {
    emitJson(
      {
        ok: true,
        healed: true,
        flow_id: flowId,
        node_id: target.id,
        from_version: flow.version,
        to_version: result.version,
        pattern: newPattern,
        gate,
      },
      MODE
    );
    return 0;
  }
  out(`Healed ${flowId}: v${flow.version} -> v${result.version ?? '?'}`);
  out(`  node           ${target.id}`);
  out(`  pattern        ${newPattern}`);
  out(`  gate           ${matchedBefore} of ${corpus.length} historical messages read identically`);
  return 0;
}

/* ───────────────────────── MCP over stdio (v6.1 P4) ───────────────────────── */

/**
 * The protocol revision this bridge speaks.
 *
 * It is the one the Worker serves. A client may name another in `_meta`; the
 * bridge passes that through so the Worker answers `-32022` with the supported
 * list, which is more useful than the bridge guessing.
 */
const MCP_DEFAULT_VERSION = '2026-07-28';

/** Methods whose `params.name` must also travel as an `Mcp-Name` header. */
const MCP_NAMED_METHODS = new Set(['tools/call', 'resources/read', 'prompts/get']);

async function commandMcp(argv) {
  const [sub, ...rest] = argv;
  if (!sub || sub === '--help' || sub === '-h') return printHelp('mcp');
  if (sub === 'serve') return commandMcpServe(rest);
  throw usage(`unknown mcp subcommand "${sub}"`);
}

/**
 * `mcp serve` — stdio JSON-RPC on one side, the Worker's `/mcp` on the other.
 *
 * Deliberately a bridge and not a second server: the tools, their schemas and
 * their answers are the Worker's. Supports both 2025 Streamable HTTP (`initialize`
 * + `Mcp-Session-Id` + live SSE frames) and stateless `params._meta` requests.
 */
async function commandMcpServe(argv) {
  const { flags } = parseArgv(argv);
  if (flags.help) return printHelp('mcp');
  assertCommandFlags(flags, 'mcp');

  const cfg = readConfig().cfg;
  const tokenFile = stringFlag(flags, 'token-file');
  let token = stringFlag(flags, 'token');
  if (token === undefined && tokenFile !== undefined) {
    const resolved = expandHome(tokenFile);
    try {
      token = fs.readFileSync(resolved, 'utf8').trim();
    } catch (error) {
      throw new CliError(`cannot read ${resolved}: ${error?.code ?? error?.message}`, 2, {
        error: 'usage',
      });
    }
  }
  if (token === undefined) token = cfg?.token;
  if (token === undefined || token === '') {
    throw usage('an agent token is required: pass --token or --token-file');
  }
  const base = (cfg?.url ?? '').replace(/\/+$/, '');
  if (base === '') {
    throw new CliError('no Worker URL configured; run `dakflare init` first', 2, {
      error: 'no_config',
    });
  }

  const version = stringFlag(flags, 'version') ?? MCP_DEFAULT_VERSION;
  let sessionId = null;

  const isClientResponse = (msg) =>
    msg &&
    typeof msg === 'object' &&
    msg.id !== undefined &&
    msg.id !== null &&
    msg.method === undefined &&
    (msg.result !== undefined || msg.error !== undefined);

  const forward = async (message) => {
    const method = typeof message.method === 'string' ? message.method : '';
    const metaVersion = message?.params?._meta?.['io.modelcontextprotocol/protocolVersion'];
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': typeof metaVersion === 'string' ? metaVersion : version,
      ...(method ? { 'Mcp-Method': method } : {}),
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
    };
    if (MCP_NAMED_METHODS.has(method) && typeof message?.params?.name === 'string') {
      headers['Mcp-Name'] = message.params.name;
    }

    let response;
    try {
      response = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers,
        body: JSON.stringify(message),
      });
    } catch (error) {
      if (!isClientResponse(message) && message.id !== undefined) {
        process.stdout.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: message.id ?? null,
            error: { code: -32000, message: `cannot reach ${base}: ${String(error?.message ?? error)}` },
          })}\n`
        );
      }
      return;
    }

    const incomingSession = response.headers.get('mcp-session-id');
    if (incomingSession) sessionId = incomingSession;

    if (response.status === 202 || response.status === 204) return;

    const contentType = String(response.headers.get('content-type') ?? '').toLowerCase();
    if (contentType.includes('text/event-stream') && response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let dataLines = [];

      const flushEvent = () => {
        if (dataLines.length === 0) return;
        const payload = dataLines.join('\n').trim();
        dataLines = [];
        if (payload !== '' && payload !== '[DONE]') {
          process.stdout.write(`${payload}\n`);
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const rawLine = buffer.slice(0, nl).replace(/\r$/, '');
          buffer = buffer.slice(nl + 1);
          if (rawLine === '') {
            flushEvent();
          } else if (rawLine.startsWith('data:')) {
            dataLines.push(rawLine.slice(5).trimStart());
          }
        }
      }
      buffer += decoder.decode();
      if (buffer.trim() !== '') {
        for (const rawLine of buffer.split(/\r?\n/)) {
          if (rawLine.startsWith('data:')) dataLines.push(rawLine.slice(5).trimStart());
        }
      }
      flushEvent();
      return;
    }

    const text = await response.text();
    if (text.trim() === '' || isClientResponse(message)) return;
    try {
      const parsed = JSON.parse(text);
      if (message.id !== undefined) process.stdout.write(`${JSON.stringify(parsed)}\n`);
    } catch {
      if (message.id !== undefined) {
        process.stdout.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: message.id ?? null,
            error: { code: -32000, message: `HTTP ${response.status}: ${text.slice(0, 200)}` },
          })}\n`
        );
      }
    }
  };

  // Line-delimited JSON-RPC. Requests execute sequentially, while client responses
  // (e.g. answering an in-flight SSE elicitation/create) dispatch immediately.
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const inFlight = new Set();
  let queue = Promise.resolve();

  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (trimmed === '') return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch (error) {
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: `parse error: ${error.message}` },
        })}\n`
      );
      return;
    }

    if (isClientResponse(message)) {
      const p = forward(message).finally(() => inFlight.delete(p));
      inFlight.add(p);
      return;
    }

    const run = queue.then(() => forward(message));
    const tracked = run.finally(() => inFlight.delete(tracked));
    inFlight.add(tracked);
    queue = run.catch(() => {});
  });

  await new Promise((resolve) => rl.on('close', resolve));
  await Promise.all(inFlight);
  return 0;
}

/* ─────────────────────── provenance (v6.1 P3) ─────────────────────── */

/** `trace <id>`: one id, the whole story, and one word for it. */
async function commandTrace(argv) {
  const { flags, rest } = parseArgv(argv);
  if (flags.help) return printHelp('trace');
  assertCommandFlags(flags, 'trace');
  const json = MODE.json;

  const id = stringFlag(flags, 'id') ?? rest[0];
  if (!id) throw usage('dakflare trace <id> [--device <id>]');
  const device = stringFlag(flags, 'device');
  const cfg = requireConfig();

  const query = device === undefined ? '' : `?device_id=${encodeURIComponent(device)}`;
  const result = await api(cfg, 'GET', `/v1/admin/trace/${encodeURIComponent(id)}${query}`);
  if (result.status !== 200) throw requestFailure('trace', result);

  const trace = result.data ?? {};
  if (json) {
    emitJson({ ok: true, ...trace }, MODE);
    return 0;
  }

  out(`${trace.verdict}  (${trace.kind})`);
  for (const line of trace.why ?? []) out(`  ${line}`);
  if ((trace.warnings ?? []).length > 0) {
    out('');
    for (const warning of trace.warnings) out(warn(`  ${warning}`));
  }

  const message = trace.message;
  if (message) {
    out('');
    out(`  message        ${message.local_id}`);
    out(`  direction      ${message.direction}  ${message.peer}`);
    out(`  received       ${iso(message.received_at)}`);
    if (message.reply_source) {
      out(`  automation     ${message.reply_source}${message.reply_ref ? ` ${message.reply_ref}` : ''}`);
    }
    if (message.reply_command_id) out(`  reply command  ${message.reply_command_id}`);
  }

  const command = trace.command;
  if (command?.state) {
    const detail = [command.error_code, command.error_message].filter(Boolean).join(' — ');
    out(`  command state  ${command.state}${detail ? ` (${detail})` : ''}`);
  }

  const flows = trace.automation?.flows ?? [];
  if (flows.length > 0) {
    out(`  flows          ${flows.map((run) => `${run.flow_id} v${run.flow_version} ${run.outcome}`).join(', ')}`);
  }

  const approval = trace.approval;
  if (approval) {
    out(`  scope          ${approval.scope}`);
    out(`  target         ${describeTarget(approval.target)}`);
    out(`  requested      ${iso(approval.requested_at)}  expires ${iso(approval.expires_at)}`);
    if (approval.live) out(`  approve        dakflare auth approve ${approval.id} --for 15m`);
  }

  const object = trace.durable_object;
  if (object) {
    out('');
    out(`  object         queue ${object.queue_depth ?? '?'}, sockets ${(object.sockets ?? []).length}`);
    for (const task of object.scheduled_tasks ?? []) {
      out(`    timer        ${task.kind} at ${iso(task.run_at)}${task.attempts ? ` (attempt ${task.attempts})` : ''}`);
    }
    for (const letter of object.dead_letters ?? []) {
      out(`    dead letter  ${letter.kind} after ${letter.attempts} attempts at ${iso(letter.failed_at)}`);
    }
  }

  const audit = trace.audit ?? [];
  if (audit.length > 0) {
    out('');
    out(`  audit          ${audit.length} row${audit.length === 1 ? '' : 's'}`);
    for (const row of audit.slice(0, 5)) {
      out(`    ${iso(row.at)}  ${row.action}${row.actor_label ? ` by ${row.actor_label}` : ''}`);
    }
  }
  return 0;
}

/** `alerts`: the open ones by default, the history on request. */
async function commandAlerts(argv) {
  const { flags } = parseArgv(argv);
  if (flags.help) return printHelp('alerts');
  assertCommandFlags(flags, 'alerts');
  const json = MODE.json;
  const cfg = requireConfig();

  const result = await api(cfg, 'GET', `/v1/admin/alerts${flags.all === true ? '?all=1' : ''}`);
  if (result.status !== 200) throw requestFailure('alerts', result);
  const alerts = result.data?.alerts ?? [];
  const enrichedAlerts = alerts.map((alert) => ({
    ...alert,
    state: alert.resolved_at ? 'resolved' : alert.acknowledged_at ? 'acknowledged' : 'open',
  }));

  if (json) {
    emitJson({ ok: true, alerts: enrichedAlerts }, MODE);
    return 0;
  }
  if (enrichedAlerts.length === 0) {
    out('no open alerts');
    return 0;
  }
  out(`Alerts (${enrichedAlerts.length})`);
  for (const alert of enrichedAlerts) {
    const device = alert.label ?? alert.device_id ?? 'fleet';
    out(`  ${String(device).padEnd(22)} ${String(alert.kind).padEnd(16)} ${alert.state.padEnd(13)} ${iso(alert.raised_at)}`);
  }
  return 0;
}

/** `dlq`: the alarms that gave up. */
async function commandDlq(argv) {
  const { flags } = parseArgv(argv);
  if (flags.help) return printHelp('dlq');
  assertCommandFlags(flags, 'dlq');
  const json = MODE.json;
  const cfg = requireConfig();

  const limitFlag = stringFlag(flags, 'limit');
  const limit = limitFlag === undefined ? 50 : Number(limitFlag);
  if (!Number.isFinite(limit) || limit < 1 || limit > 200) {
    throw usage('--limit must be between 1 and 200');
  }
  const { deviceId } = await resolveDevice(cfg, stringFlag(flags, 'device'));

  const result = await api(
    cfg,
    'GET',
    `/v1/admin/dlq?device_id=${encodeURIComponent(deviceId)}&limit=${Math.round(limit)}`
  );
  if (result.status !== 200) throw requestFailure('read the dead letter queue', result);
  const letters = result.data?.dead_letters ?? [];

  if (json) {
    emitJson({ ok: true, device_id: deviceId, dead_letters: letters }, MODE);
    return 0;
  }
  if (letters.length === 0) {
    out(`no dead letters on ${deviceId}`);
    return 0;
  }
  out(`Dead letters on ${deviceId} (${letters.length})`);
  for (const letter of letters) {
    out(`  ${String(letter.kind).padEnd(18)} ${String(letter.attempts).padStart(2)} attempts  ${iso(letter.failed_at)}`);
    out(`    ${letter.id}`);
    if (letter.payload && letter.payload !== '{}') out(muted(`    ${String(letter.payload).slice(0, 160)}`));
  }
  return 0;
}

/** `ws inspect`: what the object thinks its sockets are, and how quiet. */
async function commandWs(argv) {
  const [sub, ...rest] = argv;
  if (!sub || sub === '--help' || sub === '-h') return printHelp('ws');
  if (sub !== 'inspect') {
    throw usage(`unknown ws subcommand "${sub}"`);
  }

  const { flags } = parseArgv(rest);
  if (flags.help) return printHelp('ws');
  assertCommandFlags(flags, 'ws');
  const json = MODE.json;
  const cfg = requireConfig();
  const { deviceId } = await resolveDevice(cfg, stringFlag(flags, 'device'));

  const result = await api(cfg, 'GET', `/v1/admin/ws?device_id=${encodeURIComponent(deviceId)}`);
  if (result.status !== 200) throw requestFailure('inspect sockets', result);
  const sockets = result.data?.sockets ?? [];

  if (json) {
    emitJson({ ok: true, device_id: deviceId, sockets }, MODE);
    return 0;
  }
  if (sockets.length === 0) {
    out(`no sockets open on ${deviceId}`);
    return 0;
  }
  out(`Sockets on ${deviceId} (${sockets.length})`);
  for (const socket of sockets) {
    const quiet = socket.quiet_ms === null ? 'no liveness evidence' : `quiet ${humanDuration(socket.quiet_ms / 1000)}`;
    out(`  ${String(socket.socket_id).slice(0, 8)}  ${String(socket.state).padEnd(10)} ${quiet}`);
    out(muted(`    accepted ${iso(socket.connected_at)}`));
  }
  return 0;
}

/* ─────────────────── extract: by-example synthesis (v6.1 P2) ─────────────────── */

/**
 * Where the flow engine can be found.
 *
 * The CLI is zero-dependency, so the only way it can run the SAME synthesis the
 * Worker runs is the committed `flow.wasm`. It is looked up beside the CLI first
 * (which is where a packaged copy would live) and then in this repository, so a
 * checkout works with no build step and one binary is committed rather than two.
 */
function flowWasmCandidates() {
  return [
    path.join(__dirname, '..', 'lib', 'flow.wasm'),
    path.join(__dirname, '..', '..', 'worker', 'src', 'wasm', 'flow.wasm'),
    path.join(process.cwd(), 'worker', 'src', 'wasm', 'flow.wasm'),
  ];
}

function flowWasmPath() {
  for (const candidate of flowWasmCandidates()) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new CliError(
    'flow.wasm not found. Run simulator/flow-wasm/build.sh, or install the CLI where it ships with the binary.',
    2,
    { error: 'wasm_missing', looked_in: flowWasmCandidates() }
  );
}

let flowEngine = null;

/** Instantiate once per process. The module imports nothing, so `{}` is right. */
async function loadFlowEngine() {
  if (flowEngine !== null) return flowEngine;
  const bytes = fs.readFileSync(flowWasmPath());
  const { instance } = await WebAssembly.instantiate(bytes, {});
  flowEngine = instance.exports;
  return flowEngine;
}

/**
 * Call one `*_json` export. The ABI is `[u32 LE length][JSON]` at the returned
 * pointer, and both buffers belong to the module.
 */
function callFlowEngine(engine, name, payload) {
  const fn = engine[name];
  if (typeof fn !== 'function') {
    throw new CliError(`this flow.wasm has no ${name} export; rebuild it`, 2, {
      error: 'wasm_missing',
    });
  }
  const input = new TextEncoder().encode(JSON.stringify(payload));
  const inputPtr = engine.alloc(input.byteLength);
  new Uint8Array(engine.memory.buffer, inputPtr, input.byteLength).set(input);

  let outputPtr;
  try {
    outputPtr = fn(inputPtr, input.byteLength);
  } finally {
    engine.dealloc(inputPtr, input.byteLength);
  }

  // Views are created after the call: alloc/run can grow memory and detach any
  // buffer captured earlier.
  const view = new DataView(engine.memory.buffer);
  const length = view.getUint32(outputPtr, true);
  const bytes = new Uint8Array(engine.memory.buffer, outputPtr + 4, length).slice();
  engine.dealloc(outputPtr, 4 + length);

  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new CliError(`${name} returned something that is not JSON`, 1, { error: 'bad_response' });
  }
}

async function commandExtract(argv) {
  const [sub, ...rest] = argv;
  if (!sub || sub === '--help' || sub === '-h') return printHelp('extract');
  if (sub === 'synthesize') return commandExtractSynthesize(rest);
  throw usage(`unknown extract subcommand "${sub}"`);
}

/**
 * `extract synthesize --samples <file>` — derive a pattern, and prove it.
 *
 * The engine refuses rather than guesses, so a refusal is a real answer and it is
 * reported with its reason instead of as a generic failure.
 */
async function commandExtractSynthesize(argv) {
  const { flags, rest } = parseArgv(argv);
  if (flags.help) return printHelp('extract');
  assertCommandFlags(flags, 'extract');
  const json = MODE.json;

  const file = stringFlag(flags, 'samples') ?? rest[0];
  if (!file) throw usage('dakflare extract synthesize --samples <file>');

  const doc = readJsonDocument(file);
  const samples = Array.isArray(doc) ? doc : doc.samples;
  if (!Array.isArray(samples) || samples.length === 0) {
    throw usage(`${file}: expected { "samples": [ { "body", "value" } ] } or a bare array`);
  }
  for (const [index, sample] of samples.entries()) {
    if (
      sample === null ||
      typeof sample !== 'object' ||
      typeof sample.body !== 'string' ||
      typeof sample.value !== 'string'
    ) {
      throw usage(`${file}: samples[${index}] needs a string body and a string value`);
    }
  }
  const negatives = Array.isArray(doc?.negatives)
    ? doc.negatives.filter((entry) => typeof entry === 'string')
    : [];
  const group = stringFlag(flags, 'group') ?? (typeof doc?.group === 'string' ? doc.group : undefined);

  const engine = await loadFlowEngine();
  const answer = callFlowEngine(engine, 'synthesize_json', {
    samples,
    negatives,
    ...(group === undefined ? {} : { group }),
  });

  if (answer.ok !== true) {
    const reason = answer.reason ?? 'synthesis_refused';
    const message = answer.message ?? 'the samples cannot produce a trustworthy pattern';
    if (json) {
      emitJson({ ok: false, error: 'synthesis_refused', reason, message }, MODE);
      return exitCodeFor('synthesis_refused');
    }
    out(fail(`Refused: ${message}`));
    out(`  reason         ${reason}`);
    out(muted('  nothing was written; the pattern is only returned when it proves itself'));
    return exitCodeFor('synthesis_refused');
  }

  const result = answer.result ?? {};

  /* ---- optional: how it behaves on real history ---------------------- */
  let history = null;
  if (flags['verify-d1-limit'] !== undefined) {
    const limit = Number(flags['verify-d1-limit']);
    if (!Number.isFinite(limit) || limit < 1 || limit > 1000) {
      throw usage('--verify-d1-limit must be between 1 and 1000');
    }
    const cfg = requireConfig();
    const { deviceId } = await resolveDevice(cfg, stringFlag(flags, 'device'));
    const listed = await api(
      cfg,
      'GET',
      `/v1/messages?device_id=${encodeURIComponent(deviceId)}&limit=${Math.round(limit)}`
    );
    if (listed.status !== 200) throw requestFailure('read message history', listed);
    const inbound = (listed.data?.messages ?? []).filter((row) => row.direction === 'in');

    // JavaScript's RegExp, because that is what the Worker and the console use to
    // preview. The synthesized pattern is checked to be portable (no RE2-only
    // constructs) by the engine before it is returned.
    let matched = 0;
    let regex = null;
    try {
      regex = new RegExp(result.pattern);
    } catch (error) {
      throw new CliError(`the pattern does not run in JavaScript: ${error.message}`, 1, {
        error: 'bad_response',
        pattern: result.pattern,
      });
    }
    for (const row of inbound) {
      if (regex.test(String(row.body ?? ''))) matched += 1;
    }
    // History has no ground truth: this says how many bodies the pattern finds a
    // value in, not whether those values were the right ones.
    history = {
      device_id: deviceId,
      checked: inbound.length,
      matched,
      match_rate: inbound.length === 0 ? null : matched / inbound.length,
    };
  }

  if (json) {
    emitJson(
      {
        ok: true,
        ...result,
        ...(history === null ? {} : { history }),
      },
      MODE
    );
    return 0;
  }

  out(`Synthesized a pattern from ${result.samples} example${result.samples === 1 ? '' : 's'}`);
  out(`  pattern        ${result.pattern}`);
  out(`  group          ${result.group}`);
  out(`  anchors        ${(result.anchors ?? []).join(' | ')}`);
  out(`  value shape    ${result.value_shape}`);
  out(`  precision      ${result.precision.toFixed(2)} on the samples given`);
  out(`  recall         ${result.recall.toFixed(2)} on the samples given`);
  if (result.negatives > 0) out(`  negatives      ${result.negatives} bodies, none matched`);
  if (history !== null) {
    out(`  history        ${history.matched} of ${history.checked} inbound messages matched`);
    out(muted('                 (history has no expected value, so this is a match count)'));
  }
  out('');
  out(muted('  Use it as an extract node: "pattern" takes the regex, and the group becomes'));
  out(muted(`  {{${result.group}}}.`));
  return 0;
}

/* ───────────────────────── flows and rules (v6.1 P1) ───────────────────────── */

/** Read a JSON document from disk, with a message that names the file. */
function readJsonDocument(file) {
  const resolved = expandHome(String(file));
  let text;
  try {
    text = fs.readFileSync(resolved, 'utf8');
  } catch (error) {
    throw new CliError(`cannot read ${resolved}: ${error?.code ?? error?.message ?? error}`, 2, {
      error: 'usage',
      path: resolved,
    });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new CliError(`${resolved} is not valid JSON: ${error.message}`, 2, {
      error: 'usage',
      path: resolved,
    });
  }
}

const stableJson = (value) => {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return 'null';
  }
};

const captureGroupsOf = (graph) => {
  const names = new Set();
  for (const node of graph?.nodes ?? []) {
    if (node.type !== 'extract' || typeof node.data?.pattern !== 'string') continue;
    for (const match of node.data.pattern.matchAll(/\(\?<([A-Za-z_][A-Za-z0-9_]*)>/g)) {
      names.add(match[1]);
    }
  }
  return [...names].sort();
};

/**
 * A structural diff of two graphs.
 *
 * It answers "what would change", not "what was re-serialised": node and edge
 * ids, their data, the variables the graph can bind, and whether the layout
 * moved. A dry run whose diff is empty is the honest way to say nothing happens.
 */
function diffGraphs(before, after) {
  const beforeNodes = new Map((before?.nodes ?? []).map((node) => [node.id, node]));
  const afterNodes = new Map((after?.nodes ?? []).map((node) => [node.id, node]));
  const beforeEdges = new Map((before?.edges ?? []).map((edge) => [edge.id, edge]));
  const afterEdges = new Map((after?.edges ?? []).map((edge) => [edge.id, edge]));

  const addedNodes = [...afterNodes.keys()].filter((id) => !beforeNodes.has(id)).sort();
  const removedNodes = [...beforeNodes.keys()].filter((id) => !afterNodes.has(id)).sort();
  const changedNodes = [...afterNodes.keys()]
    .filter((id) => beforeNodes.has(id))
    .filter((id) => {
      const beforeNode = beforeNodes.get(id);
      const afterNode = afterNodes.get(id);
      return (
        beforeNode.type !== afterNode.type ||
        stableJson(beforeNode.data) !== stableJson(afterNode.data)
      );
    })
    .sort();

  const addedEdges = [...afterEdges.keys()].filter((id) => !beforeEdges.has(id)).sort();
  const removedEdges = [...beforeEdges.keys()].filter((id) => !afterEdges.has(id)).sort();
  const changedEdges = [...afterEdges.keys()]
    .filter((id) => beforeEdges.has(id))
    .filter((id) => stableJson(beforeEdges.get(id)) !== stableJson(afterEdges.get(id)))
    .sort();

  const beforeVariables = captureGroupsOf(before);
  const afterVariables = captureGroupsOf(after);

  const beforePositions = new Map(
    (before?.nodes ?? []).map((node) => [node.id, stableJson(node.position ?? null)])
  );
  const layoutChanged = (after?.nodes ?? []).some(
    (node) => beforePositions.has(node.id) && beforePositions.get(node.id) !== stableJson(node.position ?? null)
  );

  return {
    added_nodes: addedNodes,
    removed_nodes: removedNodes,
    changed_nodes: changedNodes,
    added_edges: addedEdges,
    removed_edges: removedEdges,
    changed_edges: changedEdges,
    added_variables: afterVariables.filter((name) => !beforeVariables.includes(name)),
    removed_variables: beforeVariables.filter((name) => !afterVariables.includes(name)),
    layout_changed: layoutChanged,
    empty:
      addedNodes.length === 0 &&
      removedNodes.length === 0 &&
      changedNodes.length === 0 &&
      addedEdges.length === 0 &&
      removedEdges.length === 0 &&
      changedEdges.length === 0,
  };
}

function printDiff(diff) {
  if (diff.empty) {
    out('No structural change.');
    return;
  }
  const line = (label, values) => {
    if (values.length === 0) return;
    out(`  ${label.padEnd(16)} ${values.join(', ')}`);
  };
  line('nodes added', diff.added_nodes);
  line('nodes removed', diff.removed_nodes);
  line('nodes changed', diff.changed_nodes);
  line('edges added', diff.added_edges);
  line('edges removed', diff.removed_edges);
  line('edges changed', diff.changed_edges);
  line('vars added', diff.added_variables);
  line('vars removed', diff.removed_variables);
  if (diff.layout_changed) out(`  ${'layout'.padEnd(16)} positions would move`);
}

async function commandFlows(argv) {
  const [sub, ...rest] = argv;
  if (!sub || sub === '--help' || sub === '-h') return printHelp('flows');
  if (sub === 'apply') return commandFlowsApply(rest);
  if (sub === 'heal') return commandFlowsHeal(rest);
  throw usage(`unknown flows subcommand "${sub}"`);
}

/**
 * `flows apply <file>` — write one flow document.
 *
 * The file is `{ id, name, graph, device_id?, enabled?, expected_previous_version? }`
 * or a bare `{ nodes, edges }` with `--id` and the name taken from the file name.
 * A bare graph is what an agent produces: it has no coordinates, and the Worker
 * computes `ui_layout` on save.
 */
async function commandFlowsApply(argv) {
  const { flags, rest } = parseArgv(argv);
  if (flags.help) return printHelp('flows');
  assertCommandFlags(flags, 'flows');
  const json = MODE.json;

  const file = stringFlag(flags, 'file') ?? rest[0];
  if (!file) throw usage('dakflare flows apply <file> [--dry-run]');
  const doc = readJsonDocument(file);

  const graph = doc.graph ?? (Array.isArray(doc.nodes) ? doc : null);
  if (graph === null) throw usage(`${file} has no graph: expected { graph } or { nodes, edges }`);

  const id =
    stringFlag(flags, 'id') ??
    (typeof doc.id === 'string' && doc.id !== ''
      ? doc.id
      : path.basename(String(file)).replace(/\.json$/i, '').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64));
  const name = typeof doc.name === 'string' && doc.name !== '' ? doc.name : id;
  const cfg = requireConfig();

  if (flags['dry-run'] === true) {
    const current = await api(cfg, 'GET', `/v1/admin/workflows/${encodeURIComponent(id)}`);
    if (current.status !== 200 && current.status !== 404) {
      throw requestFailure('read the current flow', current);
    }
    const before = current.status === 200 ? current.data?.workflow?.graph ?? null : null;
    const diff = diffGraphs(before, graph);
    if (json) {
      emitJson(
        {
          ok: true,
          applied: false,
          dry_run: true,
          id,
          name,
          existed: before !== null,
          version: current.data?.workflow?.version ?? null,
          dry_run_diff: diff,
        },
        MODE
      );
      return 0;
    }
    out(`${before === null ? 'Would create' : 'Would update'} flow "${name}" (${id})`);
    printDiff(diff);
    out(muted('  --dry-run: nothing was written'));
    return 0;
  }

  const payload = { name, graph };
  if (doc.device_id !== undefined) payload.device_id = doc.device_id;
  if (doc.enabled !== undefined) payload.enabled = doc.enabled;
  if (flags.force !== true && doc.expected_previous_version !== undefined) {
    payload.expected_previous_version = doc.expected_previous_version;
  }

  const result = await api(cfg, 'PUT', `/v1/admin/workflows/${encodeURIComponent(id)}`, payload);
  if (result.status === 409) {
    if (json) emitJson({ ok: false, error: 'version_conflict', ...(result.data ?? {}) }, MODE);
    else {
      out(warn(`Refused: ${result.data?.message ?? 'the flow changed while you were editing it'}`));
      out(`  current version ${result.data?.current_version ?? 'unknown'}`);
    }
    return exitCodeFor('version_conflict');
  }
  if (result.status !== 200) {
    if (result.data?.error === 'workflow_invalid') {
      const issues = result.data.details ?? [];
      if (json) {
        emitJson({ ok: false, error: 'workflow_invalid', details: issues }, MODE);
      } else {
        out(fail(`Refused: ${issues.length} issue${issues.length === 1 ? '' : 's'}`));
        for (const issue of issues) out(`  ${issue.path === '' ? '(graph)' : issue.path}: ${issue.message}`);
      }
      return exitCodeFor('workflow_invalid');
    }
    throw requestFailure('apply the flow', result);
  }

  const workflow = result.data?.workflow ?? {};
  if (json) {
    emitJson({ ok: true, applied: true, id: workflow.id ?? id, version: workflow.version, nodes: (workflow.graph?.nodes ?? []).length }, MODE);
    return 0;
  }
  out(`Applied flow "${workflow.name ?? name}" (${workflow.id ?? id})`);
  out(`  version        ${workflow.version ?? '?'}`);
  out(`  nodes          ${(workflow.graph?.nodes ?? []).length}`);
  out(`  layout         ${workflow.graph?.ui_layout?.algorithm ?? 'none'}`);
  return 0;
}

/* ───────────────────── flow v2 agent loop (v7.1 WS8) ───────────────────── */

/**
 * The canonical v2 schema lives beside the CLI, not in the Worker.
 *
 * There was no JSON Schema anywhere in the repo (the validator in
 * `worker/src/lib/flow-ir.ts` and `simulator/flow/src/ir.rs` are the two copies
 * that are kept honest by `test-support/flow-ir-vectors.json`), so this document
 * was derived from that validator by hand. It is a description of the checker,
 * never a second checker: `schema --flow-v2 --json` prints it unchanged.
 */
const FLOW_V2_SCHEMA_PATH = path.join(__dirname, '..', 'schema', 'flow-v2.json');

/**
 * Where a built `flow.wasm` may be, most-specific first.
 *
 * `dashboard/src/lib/wasm/flow.wasm` is what a dashboard build emits; the other
 * two are the committed copies `simulator/flow-wasm/build.sh` writes. If none
 * exists, `flow test` refuses rather than scoring an imagined engine.
 */
const FLOW_WASM_CANDIDATES = [
  path.join(__dirname, '..', 'lib', 'flow.wasm'),
  path.join(__dirname, '..', '..', 'dashboard', 'src', 'lib', 'wasm', 'flow.wasm'),
  path.join(__dirname, '..', '..', 'worker', 'src', 'wasm', 'flow.wasm'),
  path.join(__dirname, '..', '..', 'dashboard', 'static', 'flow.wasm'),
  path.join(
    __dirname,
    '..',
    '..',
    'simulator',
    'flow-wasm',
    'target',
    'wasm32-unknown-unknown',
    'release',
    'dakflare_flow_wasm.wasm'
  ),
];

const FLOW_WASM_BUILD = './simulator/flow-wasm/build.sh';

/** Builtin variables the trigger binds; never counted as extracted output. */
const FLOW_BUILTIN_VARIABLES = new Set(['sender', 'body', 'received_at']);

/**
 * Characters that render as nothing and force UCS-2. Mirrors the list in
 * `worker/src/routes/agent.ts`; the CLI re-escapes them so a highlight is safe
 * even if an older Worker returns the raw bytes.
 */
const INVISIBLE_CODEPOINTS = new Set([
  0x00ad, 0x061c, 0x180e, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b,
  0x202c, 0x202d, 0x202e, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0x2066, 0x2067,
  0x2068, 0x2069, 0xfeff, 0xfff9, 0xfffa, 0xfffb,
]);

/** Make a fragment safe and honest to show: nothing invisible stays invisible. */
function visibleBytes(text) {
  let result = '';
  for (const char of String(text ?? '')) {
    const codepoint = char.codePointAt(0) ?? 0;
    if (INVISIBLE_CODEPOINTS.has(codepoint)) {
      result += `<U+${codepoint.toString(16).toUpperCase().padStart(4, '0')}>`;
    } else if (codepoint < 0x20 || codepoint === 0x7f) {
      result += `\\u${codepoint.toString(16).toUpperCase().padStart(4, '0')}`;
    } else {
      result += char;
    }
  }
  return result;
}

/**
 * Print an apply handle, masked unless the caller asked for a document.
 *
 * The handle is bearer authority for one apply, so it is not scribbled into a
 * pipeline by default: a TTY or `--json` gets the whole value, everything else
 * gets the ends and a length.
 */
function displayApplyToken(token) {
  if (token === null || token === undefined) return null;
  const value = String(token);
  if (MODE.json || (process.stdout.isTTY && !AGENT)) return value;
  if (value.length <= 12) return `${value.slice(0, 4)}…`;
  return `${value.slice(0, 8)}…${value.slice(-4)} (${value.length} chars)`;
}

/** One NDJSON writer, so every phase line is flushed as it is produced. */
function ndjson(writer) {
  return (phase, fields = {}) => {
    if (writer === null) return;
    writer.write(`${JSON.stringify({ phase, ...fields })}\n`);
  };
}

/** `--ndjson` and `--json` are two answers to the same question; pick one. */
function ndjsonEnabled(flags) {
  if (flags.ndjson !== true) return null;
  if (flags.json === true) throw usage('--ndjson and --json cannot be combined');
  return process.stdout;
}

/** GET one workflow, with the failures the agent loop can act on. */
async function fetchWorkflow(cfg, id) {
  const result = await api(cfg, 'GET', `/v1/admin/workflows/${encodeURIComponent(id)}`);
  if (result.status === 404) {
    throw new CliError(`no flow "${id}" on this deployment.`, 3, {
      error: 'not_found',
      flow_id: id,
    });
  }
  if (result.status !== 200) throw requestFailure('read the flow', result);
  const workflow = result.data?.workflow ?? null;
  if (workflow === null || typeof workflow !== 'object') {
    throw new CliError('the Worker returned no workflow document.', 1, { error: 'bad_response' });
  }
  return workflow;
}

/** A body for `ask`: the four fields `/v1/agent/synthesize` requires. */
function synthesisRequest(flags, intent, flowId) {
  const diffSummary = stringFlag(flags, 'diff-summary') ?? `intent: ${intent}`;
  const corpusReport = stringFlag(flags, 'corpus-report') ?? '';
  if (intent.length > 1_000) throw usage('the intent is at most 1000 characters');
  if (diffSummary.length > 4_000) throw usage('--diff-summary is at most 4000 characters');
  if (corpusReport.length > 1_000) throw usage('--corpus-report is at most 1000 characters');
  return {
    intent,
    flow_id: flowId,
    diff_summary: diffSummary,
    corpus_report: corpusReport,
  };
}

/** Print the request `--dry-run` would have sent, and send nothing. */
function printDryRun(pathname, body, method = 'POST') {
  out(muted('  --dry-run: nothing was sent'));
  out(`  ${method} ${pathname}`);
  out(
    JSON.stringify(body, null, 2)
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n')
  );
}

/**
 * `dakflare ask "<intent>" --flow <id>` — judge a candidate patch.
 *
 * The Worker does the judging and mints the handle; this command only reports
 * what came back. An approval that is required is not an error: the handle is
 * the thing a human's approval is spent on, so it is printed rather than the
 * command failing.
 */
async function commandAsk(argv) {
  const { flags, rest } = parseArgv(argv);
  if (flags.help) return printHelp('ask');
  assertCommandFlags(flags, 'ask');
  const stream = ndjsonEnabled(flags);
  const phase = ndjson(stream);

  const intent = rest.join(' ').trim();
  if (intent === '') throw usage('dakflare ask "<intent>" --flow <id> [--ndjson]');
  const flowId = stringFlag(flags, 'flow', { required: true });
  const body = synthesisRequest(flags, intent, flowId);
  const pathname = '/v1/agent/synthesize';

  if (flags['dry-run'] === true) {
    if (stream !== null) {
      phase('understand', { intent, flow_id: flowId, dry_run: true });
      phase('result', { dry_run: true, sent: false, request: { method: 'POST', path: pathname, body } });
      return 0;
    }
    if (MODE.json) {
      emitJson(
        { ok: true, dry_run: true, request: { method: 'POST', path: pathname, body } },
        MODE
      );
      return 0;
    }
    printDryRun(pathname, body);
    return 0;
  }

  let cfg;
  try {
    cfg = requireConfig();
    const workflow = await fetchWorkflow(cfg, flowId);    phase('understand', {
      flow_id: flowId,
      version: workflow.version ?? null,
      nodes: Array.isArray(workflow.graph?.nodes) ? workflow.graph.nodes.length : 0,
    });
    phase('propose', { request: body });

    const started = Date.now();
    const result = await api(cfg, 'POST', pathname, body);
    phase('verify', { http_status: result.status, took_ms: Date.now() - started });

    if (result.status !== 200) {
      const error = apiErrorBody(result.data, result.status);
      const message =
        result.data?.message ?? `synthesize failed: ${error} (HTTP ${result.status})`;
      if (result.status === 401 || result.status === 403) {
        throw new CliError(message, 4, { error, status: result.status });
      }
      if (error === 'ai_unavailable') {
        throw new CliError(message, 75, {
          error: 'network',
          status: result.status,
          reason: result.data?.reason ?? null,
        });
      }
      throw requestFailure('synthesize', result);
    }

    const data = result.data ?? {};
    const faithful = data.faithful ?? null;
    const approvalRequired = data.approval_required === true;
    const applyToken = typeof data.apply_token === 'string' ? data.apply_token : null;

    phase('result', {
      faithful,
      approval_required: approvalRequired,
      apply_token: applyToken,
    });

    if (stream !== null) return 0;

    if (MODE.json) {
      emitJson(
        {
          ok: true,
          flow_id: flowId,
          faithful,
          approval_required: approvalRequired,
          apply_token: applyToken,
          request: body,
        },
        MODE
      );
      return 0;
    }

    out(`Flow        ${flowId} (v${workflow.version ?? '?'})`);
    out(
      `Faithfulness ${faithful?.score === null || faithful?.score === undefined ? 'not scored' : faithful.score}` +
        (faithful?.confidence === undefined ? '' : muted(`  (confidence ${faithful.confidence})`))
    );
    if (approvalRequired) {
      out(`Approval    ${warn('required')} — a human must approve before this can be applied`);
      out(`Apply token ${displayApplyToken(applyToken)}`);
      out(muted(`  spend it with: dakflare flow apply --token <token>`));
    } else {
      out('Approval    not required');
      out(muted('  no handle was minted: the judge did not call for one'));
    }
    return 0;
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    phase('error', {
      error: error.payload?.error ?? 'internal',
      message: error.message,
      exit: exitCodeFor(error.payload?.error ?? 'internal'),
    });
    throw error;
  }
}

/** A root-cause card, as the operator reads it: code, offset, bytes, patch. */
function printRootCauseCard(card) {
  out(`Root cause  ${card.code === null ? muted('no signature matched') : fail(card.code ?? 'unknown')}`);
  out(`Summary     ${card.summary ?? ''}`);
  if (card.offset !== undefined && card.offset !== null) {
    out(`Offset      char ${card.offset.char}, byte ${card.offset.byte}`);
  }
  if (card.highlight !== undefined && card.highlight !== null) {
    const before = visibleBytes(card.highlight.before ?? '');
    const bad = visibleBytes(card.highlight.bad ?? '');
    const after = visibleBytes(card.highlight.after ?? '');
    out(`Highlight   "${before}${fail(bad)}${after}"`);
    out(`            ${' '.repeat(Math.max(0, before.length))}${fail('^'.repeat(Math.max(1, bad.length)))}`);
  }
  out(`Encoding    ${card.encoding ?? '?'}, ${card.segments ?? '?'} segment(s)`);
  if (card.fix !== undefined && card.fix !== null && card.fix.kind === 'pattern_patch') {
    out(`Patch       ${card.fix.pattern}`);
  }
}

/**
 * `dakflare fix (--flow <id> | --run <run-id>) [--message-id <id>]` — why did
 * this fail.
 *
 * The two targets are different questions and go in different fields:
 * `--flow` sends `flow_id` (the Worker diagnoses against the flow's newest run),
 * and `--run` sends `flow_run_id` (one exact run, keyed
 * `device_id/local_id/flow_id/flow_version`). `--message` and `--pattern` exist
 * so a card can be reproduced without a stored row, which is also how the tests
 * exercise the invisible-Unicode case.
 */
const FLOW_RUN_ID_SHAPE = /^[^/]+\/[^/]+\/[^/]+\/(?:0|[1-9]\d*)$/;

async function commandFix(argv) {
  const { flags } = parseArgv(argv);
  if (flags.help) return printHelp('fix');
  assertCommandFlags(flags, 'fix');
  const stream = ndjsonEnabled(flags);
  const phase = ndjson(stream);

  const flowId = stringFlag(flags, 'flow');
  const runId = stringFlag(flags, 'run');
  if (flowId === undefined && runId === undefined) {
    throw new CliError('one of --flow or --run is required', 2, {
      error: 'input_required',
      missing: ['--flow or --run'],
    });
  }
  if (flowId !== undefined && runId !== undefined) {
    throw new CliError(
      'use either --flow or --run, not both: a flow and one run are different questions.',
      2,
      { error: 'ambiguous_flow_target' }
    );
  }
  if (runId !== undefined && !FLOW_RUN_ID_SHAPE.test(runId)) {
    throw new CliError(
      '--run must be device_id/local_id/flow_id/flow_version, as flow_runs prints it.',
      2,
      { error: 'invalid_flow_run_id' }
    );
  }

  const messageId = stringFlag(flags, 'message-id');
  const message = stringFlag(flags, 'message');
  const pattern = stringFlag(flags, 'pattern');
  if (message !== undefined && message.length > 4_096) {
    throw usage('--message is at most 4096 characters');
  }

  const body = {
    ...(flowId === undefined ? {} : { flow_id: flowId }),
    ...(runId === undefined ? {} : { flow_run_id: runId }),
    ...(messageId === undefined ? {} : { message_id: messageId }),
    ...(message === undefined ? {} : { message }),
    ...(pattern === undefined ? {} : { pattern }),
  };
  const target = flowId === undefined ? { flow_run_id: runId } : { flow_id: flowId };
  const pathname = '/v1/agent/diagnose';

  if (flags['dry-run'] === true) {
    if (stream !== null) {
      phase('understand', { ...target, message_id: messageId ?? null, dry_run: true });
      phase('result', { dry_run: true, sent: false, request: { method: 'POST', path: pathname, body } });
      return 0;
    }
    if (MODE.json) {
      emitJson(
        { ok: true, dry_run: true, request: { method: 'POST', path: pathname, body } },
        MODE
      );
      return 0;
    }
    printDryRun(pathname, body);
    return 0;
  }

  let cfg;
  try {
    cfg = requireConfig();
    phase('understand', {
      ...target,
      message_id: messageId ?? null,
      inline_message: message !== undefined,
    });
    const started = Date.now();
    phase('propose', { request: body });
    const result = await api(cfg, 'POST', pathname, body);
    phase('verify', { http_status: result.status, took_ms: Date.now() - started });

    if (result.status !== 200) {
      const error = apiErrorBody(result.data, result.status);
      const text = result.data?.message ?? `diagnose failed: ${error} (HTTP ${result.status})`;
      if (result.status === 401 || result.status === 403) {
        throw new CliError(text, 4, { error, status: result.status });
      }
      throw requestFailure('diagnose', result);
    }

    const card = result.data ?? {};
    phase('result', { card });

    if (stream !== null) return 0;

    if (MODE.json) {
      emitJson({ ok: true, ...target, card }, MODE);
      return 0;
    }
    printRootCauseCard(card);
    return 0;
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    phase('error', {
      error: error.payload?.error ?? 'internal',
      message: error.message,
      exit: exitCodeFor(error.payload?.error ?? 'internal'),
    });
    throw error;
  }
}

/** The built artifact `flow test` will instantiate, or `null`. */
function findFlowWasm() {
  for (const candidate of FLOW_WASM_CANDIDATES) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* try the next one */
    }
  }
  return null;
}

/** Instantiate it with the built-in WebAssembly; no loader, no dependency. */
async function loadFlowWasm(file) {
  const bytes = fs.readFileSync(file);
  const { instance } = await WebAssembly.instantiate(bytes, {});
  const exports = instance.exports;
  for (const name of ['alloc', 'dealloc', 'run_json']) {
    if (typeof exports[name] !== 'function') {
      throw new CliError(`${file} is not a flow module: no ${name} export.`, 2, {
        error: 'wasm_missing',
        wasm: file,
      });
    }
  }
  return { file, exports };
}

/** One `[u32 LE length][JSON]` round trip through the module. */
function callFlowWasm(wasm, fn, payload) {
  const input = new TextEncoder().encode(JSON.stringify(payload));
  const inputPtr = wasm.exports.alloc(input.byteLength);
  new Uint8Array(wasm.exports.memory.buffer, inputPtr, input.byteLength).set(input);

  const outPtr = fn(inputPtr, input.byteLength);
  // Views are created after the call: alloc/run can grow memory and detach an
  // earlier buffer.
  const view = new DataView(wasm.exports.memory.buffer, outPtr, 4);
  const length = view.getUint32(0, true);
  const bytes = new Uint8Array(wasm.exports.memory.buffer, outPtr + 4, length).slice();
  wasm.exports.dealloc(outPtr, 4 + length);
  wasm.exports.dealloc(inputPtr, input.byteLength);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new CliError('flow engine returned malformed JSON', 1, { error: 'bad_response' });
  }
}

/**
 * RE2 compatibility lint, condensed from `worker/src/lib/re2-compat.ts`.
 *
 * `linear_time_guaranteed` is only ever true when every pattern in the graph is
 * something RE2 can compile: no backreference, lookaround, atomic group,
 * conditional, possessive quantifier, or nested quantifier. A pattern outside
 * that set is a real answer ("the guarantee does not hold"), not a warning.
 */
const RE_RE2_COUNTED = /^\{\d+(,\d*)?\}/;
const RE_RE2_FLAG_SETTER = /^\(\?[aiLmsux-]*\)/;
const RE_RE2_FLAG_SCOPE = /^\(\?[aiLmsux-]*:/;
const RE_RE2_NAMED_GROUP = /^\(\?P?<[A-Za-z_][A-Za-z0-9_]*>/;

function lintRe2Local(pattern) {
  if (typeof pattern !== 'string' || pattern === '') return null;

  const source = pattern;
  const stack = [];
  let i = 0;
  let lastWasGroupClose = false;
  let lastClosedGroup = null;

  const branchesOf = (frame) => {
    const cuts = [...frame.pipes, frame.end];
    const parts = [];
    let from = frame.bodyStart;
    for (const cut of cuts) {
      parts.push(source.slice(from, cut));
      from = cut + 1;
    }
    return parts;
  };
  const overlapping = (branches) => {
    const normalized = branches.map((branch) => branch.trim());
    for (let a = 0; a < normalized.length; a += 1) {
      for (let b = 0; b < normalized.length; b += 1) {
        if (a === b || normalized[a] === '') continue;
        if (normalized[b].startsWith(normalized[a])) return true;
      }
    }
    return false;
  };
  const onQuantifier = () => {
    for (const frame of stack) frame.containsQuantifier = true;
    if (!lastWasGroupClose || lastClosedGroup === null) return null;
    if (lastClosedGroup.containsQuantifier) return 'nested_quantifier';
    const descendants = [];
    const collect = (frame) => {
      for (const child of frame.children) {
        descendants.push(child);
        collect(child);
      }
    };
    collect(lastClosedGroup);
    for (const candidate of [lastClosedGroup, ...descendants]) {
      if (overlapping(branchesOf(candidate))) return 'ambiguous_alternation';
    }
    return null;
  };

  while (i < source.length) {
    const ch = source[i];

    if (ch === '\\') {
      const next = source[i + 1];
      if (next === undefined) return 'dangling_backslash';
      if (next >= '1' && next <= '9') return 'backreference';
      if (next === 'k' && (source[i + 2] === '<' || source[i + 2] === "'")) return 'backreference';
      if (next === 'Q' || next === 'E') return 'unsupported_escape_q_e';
      i += 2;
      lastWasGroupClose = false;
      lastClosedGroup = null;
      continue;
    }

    if (ch === '[') {
      let j = i + 1;
      if (source[j] === '^') j += 1;
      if (source[j] === ']') j += 1;
      let closed = false;
      while (j < source.length) {
        if (source[j] === '\\') {
          j += 2;
          continue;
        }
        if (source[j] === ']') {
          closed = true;
          break;
        }
        j += 1;
      }
      i = closed ? j + 1 : source.length;
      lastWasGroupClose = false;
      lastClosedGroup = null;
      continue;
    }

    if (ch === '(') {
      const rest = source.slice(i);
      if (rest.startsWith('(?=') || rest.startsWith('(?!')) return 'lookahead';
      if (rest.startsWith('(?<=') || rest.startsWith('(?<!')) return 'lookbehind';
      if (rest.startsWith('(?>')) return 'atomic_group';
      if (rest.startsWith('(?(')) return 'conditional';
      if (rest.startsWith('(?#')) return 'comment_group_unsupported';
      if (rest.startsWith('(?R')) return 'recursion_unsupported';
      if (rest.startsWith('(?P=') || rest.startsWith('(?P>')) return 'backreference';

      const flagSetter = RE_RE2_FLAG_SETTER.exec(rest);
      if (flagSetter) {
        i += flagSetter[0].length;
        lastWasGroupClose = false;
        lastClosedGroup = null;
        continue;
      }

      let bodyStart = i + 1;
      const named = RE_RE2_NAMED_GROUP.exec(rest);
      const flagScope = RE_RE2_FLAG_SCOPE.exec(rest);
      if (named) bodyStart = i + named[0].length;
      else if (flagScope) bodyStart = i + flagScope[0].length;
      else if (rest.startsWith('(?:')) bodyStart = i + 3;

      const frame = {
        start: i,
        bodyStart,
        end: -1,
        pipes: [],
        containsQuantifier: false,
        children: [],
      };
      const parent = stack[stack.length - 1];
      if (parent !== undefined) parent.children.push(frame);
      stack.push(frame);
      i = bodyStart;
      lastWasGroupClose = false;
      lastClosedGroup = null;
      continue;
    }

    if (ch === ')') {
      const frame = stack.pop() ?? null;
      if (frame !== null) {
        frame.end = i;
        if (frame.containsQuantifier) {
          const parent = stack[stack.length - 1];
          if (parent !== undefined) parent.containsQuantifier = true;
        }
      }
      i += 1;
      lastWasGroupClose = true;
      lastClosedGroup = frame;
      continue;
    }

    if (ch === '|') {
      const top = stack[stack.length - 1];
      if (top !== undefined) top.pipes.push(i);
      i += 1;
      lastWasGroupClose = false;
      lastClosedGroup = null;
      continue;
    }

    if (ch === '*' || ch === '+' || ch === '?') {
      if (source[i + 1] === '+') return 'possessive_quantifier';
      const problem = onQuantifier();
      if (problem !== null) return problem;
      i += 1;
      lastWasGroupClose = false;
      lastClosedGroup = null;
      continue;
    }

    if (ch === '{') {
      const counted = RE_RE2_COUNTED.exec(source.slice(i));
      if (counted === null) {
        i += 1;
        lastWasGroupClose = false;
        lastClosedGroup = null;
        continue;
      }
      const end = i + counted[0].length;
      if (source[end] === '+') return 'possessive_quantifier';
      const problem = onQuantifier();
      if (problem !== null) return problem;
      i = end;
      lastWasGroupClose = false;
      lastClosedGroup = null;
      continue;
    }

    i += 1;
    lastWasGroupClose = false;
    lastClosedGroup = null;
  }

  return stack.length > 0 ? 'unbalanced_group' : null;
}

/** Every extract pattern in a graph, in node order. */
function graphPatterns(graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  return nodes
    .filter((node) => node?.type === 'extract' && typeof node.data?.pattern === 'string')
    .map((node) => ({ node_id: node.id ?? '', pattern: node.data.pattern }));
}

/**
 * Specificity and DFA size, as ESTIMATES.
 *
 * This mirrors the shape of `evaluate_corpus_and_score` in
 * `simulator/flow/src/self_heal.rs`: count the fixed tokens a pattern pins down
 * against the wildcards it leaves open, and normalise the construct count by the
 * 2048-state budget. Neither number is a measurement of a determinised automaton;
 * they are stable and monotone in the right direction, which is what a report
 * needs. The Worker's own comment says the same about `dfa_complexity`.
 */
function patternShape(pattern) {
  let literals = 0;
  let wildcards = 0;
  let branches = 1;
  let i = 0;

  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '\\') {
      const next = pattern[i + 1];
      if (next === undefined) break;
      if ('dDwWsSbBAzZ'.includes(next)) wildcards += 1;
      else literals += 1;
      i += 2;
      continue;
    }
    if (ch === '[') {
      const close = pattern.indexOf(']', i + 1);
      i = close === -1 ? pattern.length : close + 1;
      wildcards += 1;
      continue;
    }
    if (ch === '|') {
      branches += 1;
      i += 1;
      continue;
    }
    if ('.^$(){}*+?'.includes(ch)) {
      if (ch === '.') wildcards += 1;
      i += 1;
      continue;
    }
    literals += 1;
    i += 1;
  }

  const total = literals + wildcards;
  return {
    literals,
    wildcards,
    branches,
    specificity: total === 0 ? 0 : literals / total,
    dfa_estimate: Math.min(1, (literals + wildcards + branches) / 2048),
  };
}

/** JSONL corpus: one `{ sender?, body, expect? }` object per line. */
function readCorpus(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new CliError(`no corpus at ${file}.`, 3, { error: 'not_found', file });
    }
    throw new CliError(`cannot read ${file}: ${error?.message ?? error}`, 2, { error: 'usage' });
  }

  const rows = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (line.trim() === '') return;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      throw usage(`${file}:${index + 1} is not JSON`);
    }
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw usage(`${file}:${index + 1} must be an object`);
    }
    if (typeof row.body !== 'string' || row.body === '') {
      throw usage(`${file}:${index + 1} needs a non-empty "body"`);
    }
    rows.push({
      sender: typeof row.sender === 'string' && row.sender !== '' ? row.sender : '+10000000000',
      body: row.body,
      expect: row.expect !== null && typeof row.expect === 'object' ? row.expect : null,
    });
  });

  if (rows.length === 0) throw usage(`${file} has no rows`);
  return rows;
}

/** Score every row against the built engine, and say exactly which disagreed. */
function scoreCorpus(wasm, graph, rows) {
  let expectedValues = 0;
  let recalledValues = 0;
  let producedValues = 0;
  let correctValues = 0;
  const mismatches = [];

  rows.forEach((row, index) => {
    const run = callFlowWasm(wasm, wasm.exports.run_json, {
      graph,
      message: { sender: row.sender, body: row.body },
    });

    const variables = run?.variables ?? {};
    const expected = row.expect ?? {};
    const expectedVars =
      expected.variables !== null && typeof expected.variables === 'object'
        ? expected.variables
        : {};
    const expectedOutcome = typeof expected.outcome === 'string' ? expected.outcome : null;

    const problems = [];
    if (expectedOutcome !== null && run?.outcome !== expectedOutcome) {
      problems.push({ kind: 'outcome', expected: expectedOutcome, actual: run?.outcome ?? null });
    }

    for (const [name, value] of Object.entries(expectedVars)) {
      expectedValues += 1;
      if (variables[name] === value) {
        recalledValues += 1;
      } else {
        problems.push({
          kind: 'variable',
          name,
          expected: value,
          actual: variables[name] ?? null,
        });
      }
    }

    for (const [name, value] of Object.entries(variables)) {
      if (FLOW_BUILTIN_VARIABLES.has(name)) continue;
      producedValues += 1;
      if (Object.hasOwn(expectedVars, name) && expectedVars[name] === value) correctValues += 1;
    }

    if (problems.length > 0) {
      mismatches.push({
        row: index + 1,
        body: visibleBytes(row.body).slice(0, 120),
        outcome: run?.outcome ?? null,
        problems,
      });
    }
  });

  return {
    rows: rows.length,
    recall: expectedValues === 0 ? null : recalledValues / expectedValues,
    precision: producedValues === 0 ? null : correctValues / producedValues,
    mismatches,
  };
}

/**
 * `dakflare flow test --flow <id> --corpus <file.jsonl>`
 *
 * Runs the real engine, locally, over a labelled corpus. If the artifact is not
 * there the command exits 6 and names the build: an absent engine must never read
 * as a pass. Nothing here contacts the Worker's simulation path, so the numbers
 * are the same ones the handset will produce.
 */
async function commandFlowTest(argv) {
  const { flags } = parseArgv(argv);
  if (flags.help) return printHelp('flow');
  assertCommandFlags(flags, 'flow');
  const json = MODE.json;

  const flowId = stringFlag(flags, 'flow', { required: true });
  const corpusFile = stringFlag(flags, 'corpus', { required: true });

  const wasmFile = findFlowWasm();
  if (wasmFile === null) {
    throw new CliError(
      `no built flow engine found (looked for ${FLOW_WASM_CANDIDATES.join(', ')}). ` +
        `Build it with: ${FLOW_WASM_BUILD}`,
      6,
      { error: 'flow_engine_missing', wasm_candidates: FLOW_WASM_CANDIDATES, build: FLOW_WASM_BUILD }
    );
  }

  const rows = readCorpus(corpusFile);
  const cfg = requireConfig();
  const workflow = await fetchWorkflow(cfg, flowId);
  if (workflow.graph === null || typeof workflow.graph !== 'object') {
    throw new CliError(`flow "${flowId}" has no graph.`, 6, {
      error: 'flow_graph_missing',
      flow_id: flowId,
    });
  }

  const wasm = await loadFlowWasm(wasmFile);
  const validated =
    typeof wasm.exports.validate_json === 'function'
      ? callFlowWasm(wasm, wasm.exports.validate_json, workflow.graph)
      : { ok: true, graph: workflow.graph };
  if (validated?.ok === false) {
    throw new CliError(`flow "${flowId}" does not validate; run \`dakflare flows apply\`.`, 6, {
      error: 'workflow_invalid',
      issues: validated.issues ?? [],
    });
  }
  const graph = validated?.graph ?? workflow.graph;

  const scored = scoreCorpus(wasm, graph, rows);
  const patterns = graphPatterns(graph);
  const shapes = patterns.map((entry) => ({
    node_id: entry.node_id,
    pattern: entry.pattern,
    ...patternShape(entry.pattern),
    re2: lintRe2Local(entry.pattern),
  }));
  const specificity =
    shapes.length === 0
      ? null
      : shapes.reduce((total, shape) => total + shape.specificity, 0) / shapes.length;
  const dfaEstimate =
    shapes.length === 0
      ? null
      : shapes.reduce((total, shape) => total + shape.dfa_estimate, 0) / shapes.length;
  const re2Problems = shapes.filter((shape) => shape.re2 !== null);

  const report = {
    flow_id: flowId,
    version: workflow.version ?? null,
    wasm: wasmFile,
    rows: scored.rows,
    matched_rows: scored.rows - scored.mismatches.length,
    precision: scored.precision,
    recall: scored.recall,
    specificity,
    dfa_estimate: dfaEstimate,
    linear_time_guaranteed: re2Problems.length === 0,
    re2_problems: re2Problems,
    patterns: shapes,
    mismatches: scored.mismatches,
  };

  if (json) {
    emitJson(
      {
        ok: true,
        ...report,
        verification: {
          passed: scored.mismatches.length === 0,
          rows: report.rows,
          mismatched_rows: scored.mismatches.length,
          linear_time_guaranteed: report.linear_time_guaranteed,
        },
      },
      MODE
    );
    return scored.mismatches.length === 0 ? 0 : 1;
  }

  out(`Flow        ${flowId} (v${workflow.version ?? '?'})`);
  out(`Engine      ${wasmFile}`);
  out(`Rows        ${report.matched_rows}/${report.rows} as expected`);
  out(`Precision   ${scored.precision === null ? 'n/a (no extracted values)' : scored.precision.toFixed(3)}`);
  out(`Recall      ${scored.recall === null ? 'n/a (no expected values)' : scored.recall.toFixed(3)}`);
  out(`Specificity ${specificity === null ? 'n/a (no extract pattern)' : specificity.toFixed(3)}`);
  out(`DFA est.    ${dfaEstimate === null ? 'n/a' : dfaEstimate.toFixed(3)} of the 2048-state budget`);
  out(
    `Linear time ${report.linear_time_guaranteed ? ok('guaranteed') : fail('not guaranteed')}` +
      (re2Problems.length === 0
        ? ''
        : muted(`  (${re2Problems.length} pattern(s) outside RE2: ${re2Problems.map((p) => p.re2).join(', ')})`))
  );

  if (scored.mismatches.length > 0) {
    out('');
    out(fail(`${scored.mismatches.length} row(s) disagreed with the corpus`));
    for (const row of scored.mismatches) {
      out(`  row ${row.row}  ${muted(row.body)}`);
      for (const problem of row.problems) {
        if (problem.kind === 'outcome') {
          out(`    outcome: expected ${problem.expected}, got ${problem.actual}`);
        } else {
          out(
            `    ${problem.name}: expected ${JSON.stringify(problem.expected)}, got ${JSON.stringify(problem.actual)}`
          );
        }
      }
    }
  }
  return scored.mismatches.length === 0 ? 0 : 1;
}

/** Decode `ag1_<base64url(target)>` into the target it names. */
function decodeApplyToken(raw) {
  const token = String(raw ?? '').trim();
  if (!token.startsWith('ag1_')) {
    throw new CliError('not an apply handle: expected ag1_<base64url>', 2, { error: 'bad_target' });
  }
  const payload = token.slice(4);
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) {
    throw new CliError('the apply handle is not base64url.', 2, { error: 'bad_target' });
  }
  const text = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  let target;
  try {
    target = JSON.parse(text);
  } catch {
    throw new CliError('the apply handle does not decode to a target document.', 2, {
      error: 'bad_target',
    });
  }
  if (target === null || typeof target !== 'object' || Array.isArray(target)) {
    throw new CliError('the apply handle does not name a target.', 2, { error: 'bad_target' });
  }
  if (typeof target.flow_id !== 'string' || target.flow_id === '') {
    throw new CliError('the apply handle does not name a flow.', 2, {
      error: 'bad_target',
      target,
    });
  }
  return { token, target };
}

/** Which request the handle belongs to: exact body_hash first, then flow. */
function approvalMatchesToken(approval, target) {
  // A handle names a flow deploy, so it may only spend a request for that
  // scope: answering an unrelated pending request would grant authority the
  // handle never described.
  if (approval?.scope !== undefined && approval.scope !== 'flow_deploy_prod') return false;
  const at = approval?.target;
  if (at === null || typeof at !== 'object') return false;
  if (at.flow_id !== target.flow_id) return false;
  if (typeof target.body_hash === 'string' && target.body_hash !== '') {
    // A request minted by the apply path carries no body_hash; an exact match is
    // the stronger evidence when both sides have one.
    return at.body_hash === undefined || at.body_hash === target.body_hash;
  }
  return true;
}

/**
 * `dakflare flow apply --token <handle> [--totp <code>]`
 *
 * The handle is not a new kind of authority: it decodes to the target the
 * existing approval route spends. So this command finds the request that names
 * that flow and answers it through `POST /v1/admin/approvals/:id/approve` — the
 * same route a person uses. It never mints a grant itself.
 *
 * Idempotent by handle: if the request it names is already answered, the command
 * says who answered it and exits 0 when that answer was an approval, 5 when it
 * was not. A second run therefore cannot grant twice.
 */
async function commandFlowApply(argv) {
  const { flags } = parseArgv(argv);
  if (flags.help) return printHelp('flow');
  assertCommandFlags(flags, 'flow');
  const json = MODE.json;

  const rawToken = stringFlag(flags, 'token', { required: true });
  const totp = stringFlag(flags, 'totp');
  if (totp !== undefined && !/^\d{6}$/.test(totp)) {
    throw usage('--totp expects six digits');
  }
  const { target } = decodeApplyToken(rawToken);
  const cfg = requireConfig();

  const listed = await api(cfg, 'GET', '/v1/admin/approvals');
  if (listed.status !== 200) throw requestFailure('read approvals', listed);
  const approvals = Array.isArray(listed.data?.approvals) ? listed.data.approvals : [];
  const matching = approvals.filter((approval) => approvalMatchesToken(approval, target));
  const newest = [...matching].sort((left, right) => (right.requested_at ?? 0) - (left.requested_at ?? 0));
  const pending = newest.find((approval) => approval.state === 'PENDING') ?? null;

  if (pending === null) {
    const decided = newest[0] ?? null;
    if (decided === null) {
      throw new CliError(
        `no approval request names flow ${target.flow_id}; nothing to spend. ` +
          'Ask for one (`dakflare ask`), or a human must open it.',
        6,
        { error: 'approval_required', flow_id: target.flow_id, target }
      );
    }
    const payload = {
      ok: decided.state === 'APPROVED',
      spent: false,
      already_decided: true,
      state: decided.state,
      approval_id: decided.id,
      decided_by: decided.decided_by ?? null,
      decided_at: decided.decided_at ?? null,
      grant_id: decided.grant_id ?? null,
      target,
    };
    if (decided.state === 'APPROVED') {
      if (json) emitJson(payload, MODE);
      else {
        out(ok('Already applied') + ` — ${decided.id} was approved`);
        out(`  by          ${decided.decided_by ?? 'unknown'} at ${iso(decided.decided_at)}`);
        out(`  grant       ${decided.grant_id ?? 'none'}`);
        out(muted('  the handle is spent; nothing was granted twice'));
      }
      return 0;
    }
    if (json) emitJson({ ...payload, ok: false, error: 'not_pending', message: `request is already ${decided.state.toLowerCase()}` }, MODE);
    else {
      out(fail(`Cannot spend: request ${decided.id} is ${decided.state.toLowerCase()}`));
      out(`  by          ${decided.decided_by ?? 'unknown'} at ${iso(decided.decided_at)}`);
    }
    return exitCodeFor('not_pending');
  }

  const headers = totp === undefined ? {} : { 'X-Dakflare-Totp': totp };
  const result = await api(
    cfg,
    'POST',
    `/v1/admin/approvals/${encodeURIComponent(pending.id)}/approve`,
    // The Worker verifies the signature and the handle's max_uses at the point
    // of spend, so the handle travels with the approval it is spending.
    { duration_s: 3_600, apply_token: rawToken },
    { headers }
  );

  if (result.status === 409 && apiErrorBody(result.data, result.status) === 'not_pending') {
    let decidedBy = result.data?.decided_by ?? null;
    let decidedAt = result.data?.decided_at ?? null;
    if (decidedBy === null) {
      // The route only carries these on a lost race; a plain "already decided"
      // is looked up so the answer is always who and when, not just 409.
      const after = await api(cfg, 'GET', '/v1/admin/approvals');
      const match =
        after.status === 200
          ? (after.data?.approvals ?? []).find((approval) => approval.id === pending.id)
          : undefined;
      decidedBy = match?.decided_by ?? null;
      decidedAt = match?.decided_at ?? null;
    }
    if (json) {
      emitJson(
        {
          ok: false,
          error: 'not_pending',
          message: result.data?.message ?? 'the request is no longer pending',
          approval_id: pending.id,
          decided_by: decidedBy,
          decided_at: decidedAt,
        },
        MODE
      );
    } else {
      out(fail(`Cannot spend: request ${pending.id} is already decided`));
      out(`  by          ${decidedBy ?? 'unknown'} at ${iso(decidedAt)}`);
    }
    return exitCodeFor('not_pending');
  }
  if (result.status !== 200) throw decisionFailure('apply the handle', result);

  const data = result.data ?? {};
  if (json) {
    emitJson(
      {
        ok: true,
        spent: true,
        approval_id: pending.id,
        scope: data.scope ?? null,
        target: data.target ?? target,
        grant: data.grant ?? null,
        granted_s: data.granted_s ?? null,
        clamped: data.clamped === true,
      },
      MODE
    );
    return 0;
  }
  out(ok('Applied') + ` — the handle was spent on request ${pending.id}`);
  out(`  scope       ${data.scope ?? 'unknown'}  ${describeTarget(data.target ?? target)}`);
  if (data.grant) {
    out(`  grant       ${data.grant.id}`);
    out(`  expires     ${iso(data.grant.expires_at)} (${humanDuration(data.granted_s)})`);
  }
  if (data.clamped === true) {
    out(warn(`  clamped     asked for 1h, granted ${humanDuration(data.granted_s)}`));
  }
  return 0;
}

/** `dakflare flow <test|apply>` — the v2 loop, beside `flows` (documents). */
async function commandFlow(argv) {
  const [sub, ...rest] = argv;
  if (!sub || sub === '--help' || sub === '-h') return printHelp('flow');
  if (sub === 'test') return commandFlowTest(rest);
  if (sub === 'apply') return commandFlowApply(rest);
  throw usage(`unknown flow subcommand "${sub}"`);
}

async function commandRules(argv) {
  const [sub, ...rest] = argv;
  if (!sub || sub === '--help' || sub === '-h') return printHelp('rules');
  if (sub === 'list') return commandRulesList(rest);
  if (sub === 'apply') return commandRulesApply(rest);
  if (sub === 'update') return commandRulesUpdate(rest);
  if (sub === 'delete') return commandRulesDelete(rest);
  if (sub === 'test') return commandRulesTest(rest);
  throw usage(`unknown rules subcommand "${sub}"`);
}

/** `rules list`: auto-reply rules in priority order. */
async function commandRulesList(argv) {
  const { flags } = parseArgv(argv);
  if (flags.help) return printHelp('rules');
  assertCommandFlags(flags, 'rules');
  const cfg = requireConfig();

  const result = await api(cfg, 'GET', '/v1/admin/rules');
  if (result.status !== 200) throw requestFailure('listing rules', result);
  const rules = result.data?.rules ?? [];

  if (MODE.json) {
    emitJson({ ok: true, rules }, MODE);
    return 0;
  }
  if (rules.length === 0) {
    out('no rules configured');
    return 0;
  }
  out(`Rules (${rules.length})`);
  for (const rule of rules) {
    const state = rule.enabled ? ok('enabled') : muted('paused ');
    const scope = rule.device_id ? `device:${rule.device_id}` : 'all-devices';
    out(`  ${String(rule.id).padEnd(28)} ${state}  p=${String(rule.priority ?? 0).padStart(3)}  ${scope}  ${rule.name ?? ''}`);
  }
  return 0;
}

/** `rules update <id> [options]`: patch an existing rule in place. */
async function commandRulesUpdate(argv) {
  const { flags, rest } = parseArgv(argv);
  if (flags.help) return printHelp('rules');
  assertCommandFlags(flags, 'rules');
  const id = stringFlag(flags, 'id') ?? rest[0];
  if (!id) throw usage('dakflare rules update <rule-id> [--enabled | --disabled] [--name <n>] [--reply <t>]');
  if (flags.enabled === true && flags.disabled === true) {
    throw usage('--enabled and --disabled cannot be combined');
  }

  const patch = {};
  if (flags.enabled === true) patch.enabled = true;
  if (flags.disabled === true) patch.enabled = false;
  const name = stringFlag(flags, 'name');
  if (name !== undefined) patch.name = name;
  const matcherType = stringFlag(flags, 'matcher-type');
  if (matcherType !== undefined) patch.matcher_type = matcherType;
  const matcherValue = stringFlag(flags, 'matcher-value');
  if (matcherValue !== undefined) patch.matcher_value = matcherValue;
  const bodyType = stringFlag(flags, 'body-type');
  if (bodyType !== undefined) patch.body_type = bodyType;
  const bodyValue = stringFlag(flags, 'body-value');
  if (bodyValue !== undefined) patch.body_value = bodyValue;
  const reply = stringFlag(flags, 'reply');
  if (reply !== undefined) patch.reply_template = reply;
  const device = stringFlag(flags, 'device');
  if (device !== undefined) patch.device_id = device === '' || device === 'all' ? null : device;
  for (const [flagKey, bodyKey] of [
    ['priority', 'priority'],
    ['cooldown', 'cooldown_s'],
    ['max-per-hour', 'max_per_hour'],
    ['sim-slot', 'sim_slot'],
  ]) {
    const raw = stringFlag(flags, flagKey);
    if (raw !== undefined) {
      const value = Number(raw);
      if (!Number.isFinite(value)) throw usage(`--${flagKey} must be a number`);
      patch[bodyKey] = value;
    }
  }
  if (flags['allow-shortcode'] === true) patch.allow_shortcode = true;
  if (flags['no-shortcode'] === true) patch.allow_shortcode = false;

  if (Object.keys(patch).length === 0) {
    throw usage('nothing to update: pass --enabled, --disabled, --name, --reply, or another rule field');
  }

  const cfg = requireConfig();
  const result = await api(cfg, 'PUT', `/v1/admin/rules/${encodeURIComponent(id)}`, patch);
  if (result.status !== 200) throw requestFailure(`update rule ${id}`, result);

  if (MODE.json) {
    emitJson({ ok: true, id, updated: true, rule: result.data?.rule ?? null }, MODE);
    return 0;
  }
  out(ok(`Updated rule ${id}`));
  return 0;
}

/** `rules delete <id> [--yes]`: remove a rule. */
async function commandRulesDelete(argv) {
  const { flags, rest } = parseArgv(argv);
  if (flags.help) return printHelp('rules');
  assertCommandFlags(flags, 'rules');
  const id = stringFlag(flags, 'id') ?? rest[0];
  if (!id) throw usage('dakflare rules delete <rule-id> [--yes]');
  if (flags.yes !== true) {
    const proceed = await confirm(`Delete rule ${id}?`);
    if (!proceed) throw new CliError('cancelled', 2, { error: 'cancelled' });
  }
  const cfg = requireConfig();
  const result = await api(cfg, 'DELETE', `/v1/admin/rules/${encodeURIComponent(id)}`);
  if (result.status !== 200) throw requestFailure(`delete rule ${id}`, result);
  if (MODE.json) {
    emitJson({ ok: true, id, deleted: true }, MODE);
    return 0;
  }
  out(`Deleted rule ${id}`);
  return 0;
}

/** `rules apply <file>`: one rule, or `{ rules: [...] }`. */
async function commandRulesApply(argv) {
  const { flags, rest } = parseArgv(argv);
  if (flags.help) return printHelp('rules');
  assertCommandFlags(flags, 'rules');
  const json = MODE.json;

  const file = stringFlag(flags, 'file') ?? rest[0];
  if (!file) throw usage('dakflare rules apply <file> [--dry-run]');
  const doc = readJsonDocument(file);
  const rules = Array.isArray(doc) ? doc : Array.isArray(doc.rules) ? doc.rules : [doc];
  if (rules.length === 0) throw usage(`${file} contains no rules`);
  if (!rules.every((rule) => rule && typeof rule === 'object' && typeof rule.id === 'string')) {
    throw usage(`${file}: every rule needs a string id`);
  }

  const cfg = requireConfig();
  const existing = await api(cfg, 'GET', '/v1/admin/rules');
  if (existing.status !== 200) throw requestFailure('read the current rules', existing);
  const before = new Map((existing.data?.rules ?? []).map((rule) => [rule.id, rule]));

  if (flags['dry-run'] === true) {
    // The list route returns the STORED columns (`matcher_type`, `matcher_value`,
    // ...), while the apply document uses the request shape (`matcher: {type,
    // value}`). Comparing one against the other would report every field as
    // changed, so the incoming rule is flattened to the stored shape first.
    const storedShape = (rule) => ({
      id: rule.id,
      device_id: rule.device_id ?? null,
      name: rule.name ?? null,
      enabled: rule.enabled === undefined ? 1 : rule.enabled ? 1 : 0,
      priority: rule.priority ?? null,
      matcher_type: rule.matcher?.type ?? null,
      matcher_value: rule.matcher?.value ?? null,
      body_type: rule.body_matcher?.type ?? null,
      body_value: rule.body_matcher?.value ?? null,
      reply_template: rule.reply_template ?? null,
      cooldown_s: rule.cooldown_s ?? null,
      max_per_hour: rule.max_per_hour ?? null,
      sim_slot: rule.sim_slot ?? null,
      allow_shortcode: rule.allow_shortcode === undefined ? null : rule.allow_shortcode ? 1 : 0,
    });

    const diff = rules.map((rule) => {
      const incoming = storedShape(rule);
      if (!before.has(rule.id)) return { id: rule.id, action: 'create', changed_fields: [] };
      const current = before.get(rule.id) ?? {};
      // Only the fields the document actually names: an omitted field is not a
      // request to clear it, because the route reads omissions as defaults. The
      // map is stored-key -> document-key, because the two shapes differ.
      const sourceOf = {
        device_id: 'device_id',
        name: 'name',
        enabled: 'enabled',
        priority: 'priority',
        matcher_type: 'matcher',
        matcher_value: 'matcher',
        body_type: 'body_matcher',
        body_value: 'body_matcher',
        reply_template: 'reply_template',
        cooldown_s: 'cooldown_s',
        max_per_hour: 'max_per_hour',
        sim_slot: 'sim_slot',
        allow_shortcode: 'allow_shortcode',
      };
      const changed = Object.keys(sourceOf).filter(
        (key) =>
          rule[sourceOf[key]] !== undefined &&
          stableJson(incoming[key]) !== stableJson(current[key])
      );
      return {
        id: rule.id,
        action: changed.length === 0 ? 'unchanged' : 'update',
        changed_fields: changed,
      };
    });
    if (json) {
      emitJson({ ok: true, applied: false, dry_run: true, dry_run_diff: diff }, MODE);
      return 0;
    }
    out(`Would apply ${rules.length} rule${rules.length === 1 ? '' : 's'}`);
    for (const row of diff) {
      const detail = row.action === 'create' ? 'create' : row.changed_fields.length === 0
        ? 'unchanged'
        : `update (${row.changed_fields.join(', ')})`;
      out(`  ${row.id.padEnd(28)} ${detail}`);
    }
    out(muted('  --dry-run: nothing was written'));
    return 0;
  }

  const applied = [];
  for (const rule of rules) {
    const result = await api(cfg, 'POST', '/v1/rules', rule);
    if (result.status !== 200) {
      if (json) {
        emitJson(
          {
            ok: false,
            error: apiErrorBody(result.data, result.status),
            rule_id: rule.id,
            applied,
          },
          MODE
        );
        return exitCodeFor(apiErrorBody(result.data, result.status));
      }
      throw requestFailure(`apply rule ${rule.id}`, result);
    }
    applied.push(rule.id);
  }

  if (json) {
    emitJson({ ok: true, applied: true, rules: applied }, MODE);
    return 0;
  }
  out(`Applied ${applied.length} rule${applied.length === 1 ? '' : 's'}`);
  for (const id of applied) out(`  ${id}`);
  return 0;
}

/** `rules test --peer <e164> --body <text>`: why would this message reply. */
async function commandRulesTest(argv) {
  const { flags } = parseArgv(argv);
  if (flags.help) return printHelp('rules');
  assertCommandFlags(flags, 'rules');
  const json = MODE.json;

  const peer = stringFlag(flags, 'peer');
  const body = stringFlag(flags, 'body');
  if (!peer) throw usage('--peer is required');
  if (body === undefined) throw usage('--body is required');
  const device = stringFlag(flags, 'device');
  const cfg = requireConfig();

  const result = await api(cfg, 'POST', '/v1/admin/rules/test', {
    peer,
    body,
    ...(device === undefined ? {} : { device_id: device }),
  });
  if (result.status !== 200) throw requestFailure('test the rules', result);

  const matches = result.data?.matches ?? [];
  if (json) {
    emitJson({ ok: true, peer, body, matches }, MODE);
    return 0;
  }
  if (matches.length === 0) {
    out('No rules evaluated: there is nothing to match.');
    return 0;
  }
  out(`Evaluated ${matches.length} rule${matches.length === 1 ? '' : 's'} for ${peer}`);
  for (const match of matches) {
    const state = match.matched ? 'would reply' : 'no reply';
    out(`  ${String(match.rule_id).padEnd(28)} ${state.padEnd(11)} ${match.reason ?? ''}`);
    if (match.matched && match.reply_preview) out(`    ${match.reply_preview}`);
  }
  return 0;
}

/* ────────────────── agent control plane (v6.1 P0) ────────────────── */

/**
 * The ladder an operator may pick from, mirrored from
 * `worker/src/lib/agent-scopes.ts`. It is duplicated here rather than fetched so
 * `--for 15m` can be rejected before a round trip; the Worker clamps anyway, and
 * the response says when it did.
 */
const GRANT_LADDER_S = [60, 300, 900, 1_800, 3_600, 86_400, 604_800, 2_592_000];

function humanDuration(seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0));
  if (value < 60) return `${value}s`;
  if (value < 3_600) return `${Math.round(value / 60)}m`;
  if (value < 86_400) return `${Math.round(value / 3_600)}h`;
  if (value < 604_800) return `${Math.round(value / 86_400)}d`;
  return `${Math.round(value / 2_592_000)}mo`;
}

/** `--for 15m` / `1h` / `1d` / `30d` / `900` -> seconds. */
function parseGrantDuration(value) {
  if (value === undefined || value === true) return undefined;
  const match = /^(\d+(?:\.\d+)?)(mo|s|m|h|d|w)?$/.exec(String(value).trim().toLowerCase());
  if (!match) throw usage(`--for expects a duration like 15m, 1h or 1d, got "${value}"`);
  const amount = Number(match[1]);
  const unit = match[2] ?? 's';
  const factor =
    unit === 's' ? 1
      : unit === 'm' ? 60
        : unit === 'h' ? 3_600
          : unit === 'd' ? 86_400
            : unit === 'w' ? 604_800
              : 2_592_000;
  const seconds = Math.round(amount * factor);
  if (!Number.isFinite(seconds) || seconds <= 0) throw usage('--for must be positive');
  return seconds;
}

/** A grant target, in words short enough for a table row. */
function describeTarget(target) {
  if (!target || typeof target !== 'object') return 'any';
  const parts = [];
  if (Array.isArray(target.recipients) && target.recipients.length > 0) {
    parts.push(`to ${target.recipients.join(', ')}`);
  }
  if (target.device_id) parts.push(`device ${target.device_id}`);
  if (target.flow_id) parts.push(`flow ${target.flow_id}`);
  if (target.rule_id) parts.push(`rule ${target.rule_id}`);
  return parts.length === 0 ? 'any' : parts.join(' + ');
}

/**
 * Mint an agent token. The value is printed once: the Worker stores only a
 * digest of the secret, so a lost token is replaced rather than recovered.
 */
async function commandAuthMintAgentToken(argv) {
  const { flags } = parseArgv(argv);
  if (flags.help) return printHelp('auth');
  assertFlags(flags, ['name', 'scope', 'device', 'ttl', 'max-per-hour', 'json']);
  const json = MODE.json;

  requireFlags(flags, ['name', 'scope']);
  const name = stringFlag(flags, 'name');
  const scopes = String(stringFlag(flags, 'scope'))
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (scopes.length === 0) throw usage('--scope needs at least one scope');

  const device = stringFlag(flags, 'device');
  const ttlFlag = stringFlag(flags, 'ttl');
  const ttl = ttlFlag === undefined ? undefined : Number(ttlFlag);
  if (ttl !== undefined && (!Number.isFinite(ttl) || ttl < 60)) {
    throw usage('--ttl must be at least 60 seconds');
  }
  const maxFlag = stringFlag(flags, 'max-per-hour');
  const maxPerHour = maxFlag === undefined ? undefined : Number(maxFlag);
  if (maxPerHour !== undefined && (!Number.isFinite(maxPerHour) || maxPerHour < 1)) {
    throw usage('--max-per-hour must be at least 1');
  }

  const cfg = requireConfig();
  const body = { name, scopes };
  if (device !== undefined) body.device_id = device;
  if (ttl !== undefined) body.expires_in_s = Math.round(ttl);
  if (maxPerHour !== undefined) body.max_per_hour = Math.round(maxPerHour);

  const result = await api(cfg, 'POST', '/v1/admin/agent-tokens', body);
  if (result.status !== 200) {
    const unknown = result.data?.unknown_scopes;
    if (Array.isArray(unknown) && unknown.length > 0) {
      throw new CliError(`unknown scope${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`, 2, {
        error: 'usage',
        unknown_scopes: unknown,
      });
    }
    throw requestFailure('mint agent token', result);
  }

  const token = result.data ?? {};
  if (json) {
    emitJson({ ok: true, ...token }, MODE);
    return 0;
  }

  out(`Agent token "${token.name}" (${token.id})`);
  out(`  token          ${token.token}`);
  out(`  scopes         ${(token.scopes ?? []).join(', ')}`);
  out(`  device         ${token.device_id ?? 'any handset'}`);
  out(`  budget         ${token.max_per_hour} SMS per hour`);
  out(`  expires        ${token.expires_at ? iso(token.expires_at) : 'never'}`);
  out('');
  out(warn('Shown once. Only a digest is stored, so save this value now.'));
  out(muted('A token may ASK; a production send still needs a time-boxed grant:'));
  out(muted('  dakflare auth approvals   then   dakflare auth approve <id> --for 15m'));
  return 0;
}

async function commandAuthAgentTokens(argv) {
  const { flags } = parseArgv(argv);
  if (flags.help) return printHelp('auth');
  assertFlags(flags, ['all', 'json']);
  const json = MODE.json;
  const cfg = requireConfig();

  const query = flags.all === true ? '?revoked=1' : '';
  const result = await api(cfg, 'GET', `/v1/admin/agent-tokens${query}`);
  if (result.status !== 200) throw requestFailure('agent tokens', result);

  const tokens = result.data?.agent_tokens ?? [];
  const now = Date.now();
  const enrichedTokens = tokens.map((token) => {
    const revoked = token.revoked_at !== null && token.revoked_at !== undefined;
    const expired = !revoked && token.expires_at !== null && token.expires_at <= now;
    const state = revoked ? 'revoked' : expired ? 'expired' : 'live';
    return { ...token, state };
  });

  if (json) {
    emitJson({ ok: true, agent_tokens: enrichedTokens }, MODE);
    return 0;
  }
  if (enrichedTokens.length === 0) {
    out('no agent tokens');
    return 0;
  }
  out(`Agent tokens (${enrichedTokens.length})`);
  for (const token of enrichedTokens) {
    out(
      `  ${String(token.id).padEnd(18)} ${String(token.name).slice(0, 22).padEnd(23)} ` +
        `${token.state.padEnd(8)} ${token.sent_current_hour}/${token.max_per_hour} this hour`
    );
  }
  return 0;
}

async function commandAuthRevokeAgentToken(argv) {
  const { flags, rest } = parseArgv(argv);
  if (flags.help) return printHelp('auth');
  assertFlags(flags, ['yes', 'json']);
  const json = MODE.json;
  const id = rest[0];
  if (!id) throw usage('dakflare auth revoke-agent-token <id>');

  if (flags.yes !== true) {
    const proceed = await confirm(`Revoke agent token ${id}? It stops working on its next request.`);
    if (!proceed) throw new CliError('cancelled', 2, { error: 'cancelled' });
  }

  const cfg = requireConfig();
  const result = await api(cfg, 'DELETE', `/v1/admin/agent-tokens/${encodeURIComponent(id)}`);
  if (result.status === 409) {
    if (json) emitJson({ ok: false, error: 'already_revoked', id }, MODE);
    else out('already revoked');
    return exitCodeFor('already_revoked');
  }
  if (result.status !== 200) throw decisionFailure('revoke agent token', result);

  if (json) {
    emitJson({ ok: true, id, revoked_at: result.data?.revoked_at ?? Date.now() }, MODE);
    return 0;
  }
  out(`Revoked ${id}. It is refused on its next request.`);
  return 0;
}

async function commandAuthApprovals(argv) {
  const { flags } = parseArgv(argv);
  if (flags.help) return printHelp('auth');
  assertFlags(flags, ['state', 'json']);
  const json = MODE.json;
  const state = stringFlag(flags, 'state');
  const cfg = requireConfig();

  const query = state === undefined ? '' : `?state=${encodeURIComponent(state.toUpperCase())}`;
  const result = await api(cfg, 'GET', `/v1/admin/approvals${query}`);
  if (result.status !== 200) throw requestFailure('approvals', result);

  const approvals = result.data?.approvals ?? [];
  if (json) {
    emitJson({ ok: true, approvals }, MODE);
    return 0;
  }
  if (approvals.length === 0) {
    out('no approval requests');
    return 0;
  }

  out(`Approval requests (${approvals.length})`);
  const now = Date.now();
  for (const approval of approvals) {
    const left = Math.max(0, Math.round((approval.expires_at - now) / 1000));
    out(`  ${approval.id}`);
    out(
      `    ${approval.scope}  ${describeTarget(approval.target)}  ` +
        `${approval.state.toLowerCase()}${approval.state === 'PENDING' ? `, ${humanDuration(left)} left` : ''}`
    );
    if (approval.state === 'PENDING') {
      out(
        muted(
          `    approve: dakflare auth approve ${approval.id} --for <${GRANT_LADDER_S.map(humanDuration).join('|')}>` +
            `   (max ${approval.max_s === null ? 'n/a' : humanDuration(approval.max_s)})`
        )
      );
    }
  }
  return 0;
}

/** Map the Worker's decision errors onto the CLI's exit codes. */
function decisionFailure(what, result) {
  const code = apiErrorBody(result.data, result.status);
  if (code === 'not_found' || code === 'not_pending' || code === 'expired' || code === 'not_grantable' || code === 'bad_target') {
    return new CliError(`${what} failed: ${result.data?.message ?? code}`, exitCodeFor(code), {
      error: code,
      status: result.status,
    });
  }
  return requestFailure(what, result);
}

async function commandAuthApprove(argv) {
  const { flags, rest } = parseArgv(argv);
  if (flags.help) return printHelp('auth');
  assertFlags(flags, ['for', 'json']);
  const json = MODE.json;
  const id = rest[0];
  if (!id) throw usage('dakflare auth approve <approval-id> [--for 15m]');

  const seconds = parseGrantDuration(flags.for) ?? 900;
  const cfg = requireConfig();
  const result = await api(cfg, 'POST', `/v1/admin/approvals/${encodeURIComponent(id)}/approve`, {
    duration_s: seconds,
  });
  if (result.status !== 200) throw decisionFailure('approve', result);

  const data = result.data ?? {};
  if (json) {
    emitJson({ ok: true, ...data }, MODE);
    return 0;
  }

  out(`Approved ${data.approval?.scope ?? 'authority'} for ${describeTarget(data.approval?.target)}`);
  if (data.grant) {
    out(`  grant          ${data.grant.id}`);
    out(`  expires        ${iso(data.grant.expires_at)} (${humanDuration(data.granted_s)})`);
  }
  if (data.clamped === true) {
    // Say it out loud: a silently shortened grant teaches an operator to
    // distrust the tool, and this is the one place the ceiling bends a request.
    out(
      warn(
        `  clamped        asked for ${humanDuration(data.requested_s)}, granted ${humanDuration(data.granted_s)}` +
          (data.max_s === null ? '' : ` (max ${humanDuration(data.max_s)} for this scope)`)
      )
    );
  }
  return 0;
}

async function commandAuthReject(argv) {
  const { flags, rest } = parseArgv(argv);
  if (flags.help) return printHelp('auth');
  assertFlags(flags, ['json']);
  const json = MODE.json;
  const id = rest[0];
  if (!id) throw usage('dakflare auth reject <approval-id>');

  const cfg = requireConfig();
  const result = await api(cfg, 'POST', `/v1/admin/approvals/${encodeURIComponent(id)}/reject`, {});
  if (result.status !== 200) throw decisionFailure('reject', result);

  if (json) {
    emitJson({ ok: true, ...(result.data ?? {}) }, MODE);
    return 0;
  }
  out(`Rejected ${id}. The agent keeps being refused until it asks again.`);
  return 0;
}

async function commandAuthGrants(argv) {
  const { flags, rest } = parseArgv(argv);
  if (flags.help) return printHelp('auth');
  if (rest[0] === 'revoke') return commandAuthGrantRevoke(rest.slice(1));

  assertFlags(flags, ['token', 'live', 'json']);
  const json = MODE.json;
  const cfg = requireConfig();

  const params = new URLSearchParams();
  const token = stringFlag(flags, 'token');
  if (token !== undefined) params.set('token', token);
  if (flags.live === true) params.set('live', '1');
  const query = params.toString() === '' ? '' : `?${params.toString()}`;

  const result = await api(cfg, 'GET', `/v1/admin/grants${query}`);
  if (result.status !== 200) throw requestFailure('grants', result);

  const grants = result.data?.grants ?? [];
  const now = Date.now();
  const enrichedGrants = grants.map((grant) => {
    const left = Math.round((grant.expires_at - now) / 1000);
    const state = grant.revoked_at ? 'revoked' : left > 0 ? 'live' : 'expired';
    return { ...grant, state, time_remaining_s: Math.max(0, left) };
  });

  if (json) {
    emitJson({ ok: true, grants: enrichedGrants }, MODE);
    return 0;
  }
  if (enrichedGrants.length === 0) {
    out('no grants');
    return 0;
  }
  out(`Grants (${enrichedGrants.length})`);
  for (const grant of enrichedGrants) {
    const left = grant.time_remaining_s;
    const state = grant.revoked_at ? 'revoked' : left > 0 ? `${humanDuration(left)} left` : 'expired';
    out(`  ${grant.id}`);
    out(
      `    ${grant.scope}  ${describeTarget(grant.target)}  ${state}  ` +
        `used ${grant.use_count}  by ${grant.granted_by}`
    );
  }
  return 0;
}

async function commandAuthGrantRevoke(argv) {
  const { flags, rest } = parseArgv(argv);
  if (flags.help) return printHelp('auth');
  assertFlags(flags, ['yes', 'json']);
  const json = MODE.json;
  const id = rest[0];
  if (!id) throw usage('dakflare auth grants revoke <grant-id>');

  if (flags.yes !== true) {
    const proceed = await confirm(`Revoke grant ${id}? It stops working on the next request.`);
    if (!proceed) throw new CliError('cancelled', 2, { error: 'cancelled' });
  }

  const cfg = requireConfig();
  const result = await api(cfg, 'DELETE', `/v1/admin/grants/${encodeURIComponent(id)}`);
  if (result.status !== 200) throw decisionFailure('revoke grant', result);

  if (json) {
    emitJson({ ok: true, ...(result.data ?? {}) }, MODE);
    return 0;
  }
  out(`Revoked grant ${id}. It is refused on the next request.`);
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
      emitJson({ ok: true, available: false, reason: 'not_available_on_this_deployment' }, MODE);
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
    emitJson({ ok: true, available: true, entries: entries ?? result.data }, MODE);
    return;
  }

  if (!entries) {
    emitJson(result.data, MODE);
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

/* ───────────────────────────── AI assistant ───────────────────────────── */

/**
 * The Worker's own defaults, copied so a configure without --model can still
 * send the non-empty model the settings route requires. Keep these in step with
 * `worker/src/lib/ai/settings.ts`; a model id is not something to guess.
 */
const AI_DEFAULT_MODELS = {
  'workers-ai': '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  'openai-compatible': 'gpt-4o-mini',
};

const AI_PROVIDERS = Object.keys(AI_DEFAULT_MODELS);

/**
 * The worker name a secret write needs. The CLI does not deploy, so it only
 * knows one when the operator names it; otherwise the documented default is
 * the honest answer.
 */
function aiWorkerName() {
  const configured = process.env.DAKFLARE_WORKER_NAME;
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim();
  return 'dakflare-worker';
}

function aiKeyCommand() {
  // Readiness needs a key for BOTH roles, so the command must name a secret both
  // chains read: AI_PROVIDER_API_KEY. The role-local fallbacks (AI_CHAT_API_KEY
  // for chat, TOKENLAB_API_KEY for System One) are listed after it, because a
  // command that sets only one leaves the other role reporting "none" and this
  // same message printing again.
  return `cf workers secrets update AI_PROVIDER_API_KEY --worker ${aiWorkerName()} --type secret_text`;
}

/** The role-local names, for an operator who splits providers across vendors. */
function aiKeyFallbacks() {
  return 'AI_CHAT_API_KEY (chat) or TOKENLAB_API_KEY (System One)';
}

function aiKeyMissingMessage() {
  return `No AI provider key is configured on the Worker. Set one with: ${aiKeyCommand()} — or, if the roles use different vendors, ${aiKeyFallbacks()}.`;
}

/**
 * The settings view, in the CLI's snake_case vocabulary.
 *
 * The route reports System One's *effective* model and base (already resolved
 * against chat), not its stored columns, so "inherits" is the honest reading
 * only when the two values are equal.
 */
function aiSettingsView(data) {
  const budget = data?.budget ?? {};
  const rawSystem1 = data?.system1;
  const rawKeySource = data?.keySource;
  // The unified route always reports both. A Worker still on the older settings
  // shape does not, and inventing "inherits" or "none" there would be a claim
  // the CLI cannot support, so those two members read as null instead.
  const hasSystem1 =
    rawSystem1 !== null && typeof rawSystem1 === 'object' && !Array.isArray(rawSystem1);
  const hasKeySource =
    rawKeySource !== null && typeof rawKeySource === 'object' && !Array.isArray(rawKeySource);
  const provider = data?.provider ?? null;
  const model = data?.model ?? null;
  const baseUrl = data?.baseUrl ?? null;
  const system1Model = hasSystem1 ? rawSystem1.model ?? model : null;
  const system1BaseUrl = hasSystem1 ? rawSystem1.baseUrl ?? null : null;
  const keyName = (value) =>
    typeof value === 'string' && value.trim() !== '' ? value.trim() : 'none';
  return {
    provider,
    model,
    base_url: baseUrl,
    system1: hasSystem1
      ? {
          provider: rawSystem1.provider ?? provider,
          model: system1Model,
          base_url: system1BaseUrl,
          // The gateway reports this; comparing two URLs cannot tell an
          // inherited base from an override that happens to match. workers-ai
          // has no origin at all, so "inherits the base" has no meaning there.
          inherits_base:
            provider === 'openai-compatible'
              ? typeof rawSystem1.inheritsBase === 'boolean'
                ? rawSystem1.inheritsBase
                : system1BaseUrl === baseUrl
              : null,
        }
      : null,
    api_key_configured: data?.apiKeyConfigured === true,
    key_source: hasKeySource
      ? { chat: keyName(rawKeySource.chat), system1: keyName(rawKeySource.system1) }
      : null,
    ...(typeof data?.hint === 'string' ? { hint: data.hint } : {}),
    budget: {
      day: budget.day ?? null,
      used: Number(budget.used ?? 0),
      limit: Number(budget.limit ?? 0),
    },
  };
}

/** True when the active provider cannot answer until the secret exists. */
function aiNeedsKey(view) {
  return view.provider === 'openai-compatible' && view.api_key_configured !== true;
}

function printAiSettings(view) {
  out(`  provider      ${view.provider ?? 'unknown'}`);
  out(`  chat model    ${view.model ?? 'unknown'}`);
  if (view.provider === 'openai-compatible') out(`  chat base     ${view.base_url ?? '—'}`);
  if (view.system1 === null) {
    out(muted('  system one    not reported by this Worker; deploy the unified settings route'));
  } else {
    const system1 = view.system1;
    out(`  system one    ${system1.model ?? 'unknown'}`);
    if (view.provider === 'openai-compatible') {
      out(
        `  system1 base  ${system1.base_url ?? '—'}` +
          (system1.inherits_base ? ' (inherits the chat base)' : '')
      );
    }
  }
  out(
    `  api key       ${view.api_key_configured ? 'configured' : 'not configured'}`
  );
  if (view.key_source === null) {
    out(muted('  key source    not reported by this Worker'));
  } else {
    out(`  key source    chat ${view.key_source.chat} · system1 ${view.key_source.system1}`);
  }
  out(
    `  budget        ${view.budget.used}/${view.budget.limit} tokens` +
      (view.budget.day ? ` (${view.budget.day})` : '')
  );
  if (typeof view.hint === 'string' && view.hint !== '') out(muted(`  hint          ${view.hint}`));
}

/** Validate a base URL the same way `worker/src/lib/ai/settings.ts` does. */
function aiBaseUrl(value, label = '--base-url') {
  if (typeof value !== 'string' || value.trim() === '') {
    throw usage(`${label} is required for openai-compatible`);
  }
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw usage(`${label} must be an absolute URL`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw usage(`${label} must not carry credentials`);
  }
  const loopback =
    parsed.hostname === 'localhost' ||
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === '[::1]' ||
    parsed.hostname === '::1';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw usage(`${label} must be https, or http on localhost`);
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw usage(`${label} must not carry a query or fragment`);
  }
  return parsed.toString().replace(/\/+$/, '');
}

/**
 * What the omitted System One fields will do, for `--dry-run`. Saying "inherits"
 * is better than sending empty strings: the route clears a value it does not
 * receive, and a cleared value is exactly "use the chat value".
 */
function aiSystem1InheritNote(system1, provider) {
  const parts = [];
  if (system1.model === undefined) parts.push('model');
  if (provider === 'openai-compatible' && system1.baseUrl === undefined) parts.push('base');
  if (parts.length === 0) return null;
  return `System One inherits the chat ${parts.join(' and ')}; pass --system1-model / --system1-base-url to override.`;
}

/**
 * Map one AI route refusal onto the CLI's exit codes. The status alone is not
 * enough: a 503 is a precondition when the key or binding is missing and a
 * temporary provider failure otherwise, and those must not read the same.
 */
function aiFailure(what, result) {
  const code = apiErrorBody(result.data, result.status);
  const message =
    typeof result.data?.message === 'string'
      ? result.data.message
      : `${what} failed: ${code} (HTTP ${result.status})`;

  if (result.status === 401 || result.status === 403) {
    return new CliError(message, 4, {
      error: result.status === 403 ? 'forbidden' : 'unauthorized',
      status: result.status,
    });
  }
  if (result.status === 429 && code === 'budget_exhausted') {
    const used = Number(result.data?.used ?? 0);
    const limit = Number(result.data?.limit ?? 0);
    return new CliError(
      `the daily AI token budget is exhausted: ${used}/${limit}. It resets at UTC midnight.`,
      5,
      { error: 'budget_exhausted', used, limit },
    );
  }
  if (result.status === 503 && code === 'ai_unavailable') {
    const reason = typeof result.data?.reason === 'string' ? result.data.reason : 'provider_unavailable';
    if (reason === 'missing_key') {
      return new CliError(aiKeyMissingMessage(), 6, {
        error: 'ai_key_missing',
        reason,
        remediation: aiKeyCommand(),
      });
    }
    if (reason === 'missing_binding' || reason === 'missing_base_url' || reason === 'unsupported_provider') {
      return new CliError(message, 6, { error: 'ai_precondition', reason });
    }
    return new CliError(message, 75, { error: 'ai_unavailable', reason, status: result.status });
  }
  if (result.status === 400) {
    return new CliError(message, 2, { error: 'bad_request', status: 400 });
  }
  return requestFailure(what, result);
}

/** `dakflare ai providers` — what is configured, and what the budget has left. */
async function commandAiProviders(argv) {
  const { flags } = parseArgv(argv);
  if (flags.help) return printHelp('ai');
  assertCommandFlags(flags, 'ai');
  const cfg = requireConfig();

  const result = await api(cfg, 'GET', '/v1/admin/ai/settings');
  if (result.status !== 200) throw aiFailure('read AI settings', result);
  const view = aiSettingsView(result.data);

  const needsKey = aiNeedsKey(view);
  if (MODE.json) {
    emitJson({ ok: true, ...view, warnings: needsKey ? [aiKeyMissingMessage()] : [] }, MODE);
  } else {
    out('AI settings');
    printAiSettings(view);
    if (needsKey) err(aiKeyMissingMessage());
  }

  if (needsKey) return exitCodeFor('ai_key_missing');
  return 0;
}

/** `dakflare ai configure` — write the singleton settings row. */
async function commandAiConfigure(argv) {
  const { flags } = parseArgv(argv);

  // Refused before the flag contract: the value must never reach argv, a shell
  // history or this process's argument list.
  if (flags['api-key'] !== undefined) {
    throw usage(
      '--api-key is refused: the key belongs in a Worker secret, never on the command line. ' +
        `Set it with: ${aiKeyCommand()}`,
    );
  }
  if (flags.help) return printHelp('ai');
  assertCommandFlags(flags, 'ai');

  const provider = stringFlag(flags, 'provider');
  if (!provider) throw usage('--provider is required (workers-ai or openai-compatible)');
  if (!AI_PROVIDERS.includes(provider)) {
    throw usage(`--provider must be one of ${AI_PROVIDERS.join(', ')}`);
  }

  const requestedModel = stringFlag(flags, 'model');
  const model = requestedModel ?? AI_DEFAULT_MODELS[provider];
  if (model.trim() === '') throw usage('--model needs a value');
  if (model.length > 200) throw usage('--model must be at most 200 characters');

  const rawBaseUrl = stringFlag(flags, 'base-url');
  let baseUrl = null;
  if (provider === 'openai-compatible') {
    baseUrl = aiBaseUrl(rawBaseUrl);
  } else if (rawBaseUrl !== undefined) {
    throw usage('--base-url is not used by workers-ai');
  }

  // System One is a replacement, exactly like the rest of the body: a member
  // that is absent is cleared on the row and reads back as "use the chat
  // value". So an omitted pair is left out entirely, never sent as "".
  const system1 = {};
  const rawSystem1Model = stringFlag(flags, 'system1-model');
  if (rawSystem1Model !== undefined) {
    if (rawSystem1Model.trim() === '') throw usage('--system1-model needs a value');
    if (rawSystem1Model.length > 200) {
      throw usage('--system1-model must be at most 200 characters');
    }
    system1.model = rawSystem1Model;
  }
  const rawSystem1BaseUrl = stringFlag(flags, 'system1-base-url');
  if (rawSystem1BaseUrl !== undefined) {
    if (provider !== 'openai-compatible') {
      throw usage('--system1-base-url is not used by workers-ai');
    }
    system1.baseUrl = aiBaseUrl(rawSystem1BaseUrl, '--system1-base-url');
  }

  const body = { provider, model, baseUrl };
  if (Object.keys(system1).length > 0) body.system1 = system1;
  const pathname = '/v1/admin/ai/settings';
  const method = 'PUT';

  if (flags['dry-run'] === true) {
    const inheritNote = aiSystem1InheritNote(system1, provider);
    if (MODE.json) {
      emitJson(
        {
          ok: true,
          dry_run: true,
          request: { method, path: pathname, body },
          ...(inheritNote === null ? {} : { note: inheritNote }),
        },
        MODE,
      );
      return 0;
    }
    printDryRun(pathname, body, method);
    if (inheritNote !== null) out(muted(`  note: ${inheritNote}`));
    return 0;
  }

  const cfg = requireConfig();
  const result = await api(cfg, method, pathname, body);
  if (result.status !== 200) throw aiFailure('write AI settings', result);
  const view = aiSettingsView(result.data);

  const needsKey = aiNeedsKey(view);
  if (MODE.json) {
    emitJson({ ok: true, ...view, warnings: needsKey ? [aiKeyMissingMessage()] : [] }, MODE);
  } else {
    out('AI settings updated');
    printAiSettings(view);
    if (needsKey) err(aiKeyMissingMessage());
  }

  if (needsKey) return exitCodeFor('ai_key_missing');
  return 0;
}

/** `dakflare ai test` — one tiny provider call. */
/** `ai models` — the catalog the configured provider publishes. */
async function commandAiModels(argv) {
  const { flags } = parseArgv(argv);
  if (flags.help) return printHelp('ai');
  assertCommandFlags(flags, 'ai');
  const cfg = requireConfig();

  const result = await api(cfg, 'GET', '/v1/admin/ai/models');
  if (result.status !== 200) throw aiFailure('list AI models', result);

  const models = Array.isArray(result.data?.models) ? result.data.models : [];
  const view = {
    provider: result.data?.provider ?? null,
    source: result.data?.source ?? null,
    note: typeof result.data?.note === 'string' ? result.data.note : null,
    count: models.length,
    models: models.map((entry) =>
      entry !== null && typeof entry === 'object'
        ? {
            id: String(entry.id ?? ''),
            ...(typeof entry.owned_by === 'string' ? { owned_by: entry.owned_by } : {}),
          }
        : { id: String(entry) }
    ),
  };

  if (MODE.json) {
    emitJson(view, MODE);
    return 0;
  }
  out(`${view.count} models (${view.provider ?? 'unknown'}, ${view.source ?? 'unknown'} source)`);
  for (const model of view.models) out(`  ${model.id}`);
  if (view.note !== null) out(`  note  ${view.note}`);
  return 0;
}

/** One readable line per System One answer: id, type, and its decision. */
function aiAnswerLine(id, answer) {
  const type = typeof answer?.type === 'string' ? answer.type : 'unknown';
  const probability = Number(answer?.probability ?? 0);
  const p = Number.isFinite(probability) ? probability.toFixed(2) : '0.00';
  if (type === 'choice') {
    return `  ${pad(id, 12)} ${pad(type, 7)} ${answer?.choice ?? '—'} (p ${p})`;
  }
  if (type === 'noul') {
    return `  ${pad(id, 12)} ${pad(type, 7)} noul ${p}`;
  }
  if (type === 'score') {
    // `score` is a model-weighted level and can be fractional; the legend is
    // indexed by the nearest level, so a 1.82 reads as "Medium", not as a miss.
    const rawScore = Number(answer?.score ?? 0);
    const score = Number.isFinite(rawScore) ? Math.round(rawScore * 100) / 100 : 0;
    const legend = Array.isArray(answer?.legend) ? answer.legend : [];
    const label = legend[Math.round(rawScore)];
    return `  ${pad(id, 12)} ${pad(type, 7)} ${score}${
      typeof label === 'string' ? ` (${label})` : ''
    } (p ${p})`;
  }
  return `  ${pad(id, 12)} ${type} (p ${p})`;
}

/**
 * `dakflare ai test --system-one` — one fixed decision through the same
 * selection path production uses. A 503 keeps the gateway's own reason: the
 * route distinguishes a missing key, a bad base URL, an unparseable answer and
 * an unreachable provider, and collapsing those into "failed" loses the fix.
 */
async function commandAiSystem1Test(cfg) {
  const result = await api(cfg, 'POST', '/v1/admin/ai/system1/test', {});
  if (result.status !== 200) {
    const failure = aiFailure('test the System One provider', result);
    if (result.status === 503 && failure.code === 75) {
      const reason = typeof result.data?.reason === 'string' ? result.data.reason : null;
      if (reason !== null && !failure.message.includes(reason)) {
        failure.message = `${failure.message} (reason: ${reason})`;
      }
    }
    throw failure;
  }

  const raw = result.data?.answers;
  const answers = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const view = {
    ok: true,
    provider: result.data?.provider ?? null,
    model: result.data?.model ?? null,
    took_ms: Number(result.data?.took_ms ?? 0),
    answers,
  };

  if (MODE.json) {
    emitJson(view, MODE);
    return 0;
  }

  out(`${ok('System One test ok')} (${view.provider ?? 'unknown'})`);
  out(`  model        ${view.model ?? 'unknown'}`);
  out(`  took         ${view.took_ms} ms`);
  const entries = Object.entries(answers);
  if (entries.length === 0) out(muted('  answers      none returned'));
  for (const [id, answer] of entries) out(aiAnswerLine(id, answer));
  return 0;
}

async function commandAiTest(argv) {
  const { flags } = parseArgv(argv);
  if (flags.help) return printHelp('ai');
  assertCommandFlags(flags, 'ai');
  const cfg = requireConfig();

  if (flags['system-one'] === true) return commandAiSystem1Test(cfg);

  const result = await api(cfg, 'POST', '/v1/admin/ai/test');
  if (result.status !== 200) throw aiFailure('test the AI provider', result);

  const view = {
    ok: true,
    provider: result.data?.provider ?? null,
    model: result.data?.model ?? null,
    took_ms: Number(result.data?.took_ms ?? 0),
    sample: typeof result.data?.sample === 'string' ? result.data.sample : null,
  };

  if (MODE.json) {
    emitJson(view, MODE);
    return 0;
  }
  out(`${ok('AI test ok')} (${view.provider ?? 'unknown'})`);
  out(`  model        ${view.model ?? 'unknown'}`);
  out(`  took         ${view.took_ms} ms`);
  if (view.sample !== null) out(`  sample       ${JSON.stringify(view.sample)}`);
  return 0;
}

/** Subcommand dispatch, mirroring `auth`, `flow` and `rules`. */
async function commandAi(argv) {
  const [sub, ...rest] = argv;
  if (!sub || sub === '--help' || sub === '-h') return printHelp('ai');
  // Refuse the key no matter where it appears, before any subcommand parses it.
  const { flags: aiFlags } = parseArgv(argv);
  if (aiFlags['api-key'] !== undefined) {
    throw usage(
      '--api-key is refused: the key belongs in a Worker secret, never on the command line. ' +
        `Set it with: ${aiKeyCommand()}`,
    );
  }
  if (sub === 'providers') return commandAiProviders(rest);
  if (sub === 'configure') return commandAiConfigure(rest);
  if (sub === 'models') return commandAiModels(rest);
  if (sub === 'test') return commandAiTest(rest);
  throw usage(`unknown ai subcommand "${sub}"`);
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
    ['-list', '-v', '-keystore', keystore, '-storepass:env', 'DAKFLARE_KEYSTORE_PASSWORD', '-alias', alias],
    {
      encoding: 'utf8',
      timeout: 15_000,
      env: { ...process.env, DAKFLARE_KEYSTORE_PASSWORD: password },
    }
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
    emitJson({ ok: true, keystore, alias, sha256: fingerprint }, MODE);
    return;
  }
  out('Release signing certificate');
  out(`  keystore      ${keystore}`);
  out(`  alias         ${alias}`);
  out(`  SHA-256       ${fingerprint}`);
}

/* ───────────────────────────── help ───────────────────────────── */

const HELP = {
  root: `dakflare: operate a self-hosted DakFlare deployment

Usage: dakflare <command> [options]

  init          verify a Worker and save its admin token; --local writes .dev.vars
  doctor        checklist: config, health, schema, migrations, bindings, phone
  pair          mint a pairing code; --qr renders a terminal QR
  devices       list paired devices
  revoke        revoke one device (asks first; --yes to skip)
  send          queue an SMS, or send through a channel connector
  status        read one command's state; --wait follows it to the end
  connectors    \`connectors list|create|update|delete\` channel credentials
  webhooks      \`webhooks list|create|delete|deliveries\` inbound agent hooks
  templates     \`templates list|create|delete\` message templates
  contacts      \`contacts import <file.csv>\` bulk contact import
  schedule      \`schedule list|create|cancel\` scheduled sends
  up            provision the deployment: resources, deploy, owner, pairing
  auth          accounts, invites, agent tokens, approvals, and authority grants
  flows         \`flows apply\` and \`flows heal\` for v2 flow documents
  rules         \`rules list|apply|update|delete|test\` for auto-reply rules
  extract       \`extract synthesize\` for anchored capture regexes
  trace         explain one message, command or approval id
  alerts        list operator alerts
  dlq           inspect a device's dead-letter queue
  ws            \`ws inspect\` live handset WebSockets
  mcp           \`mcp serve\` stdio bridge to Streamable HTTP /mcp
  audit         tail the audit log
  key           signing-key helpers: \`key fingerprint\`
  ai            \`ai providers\`, \`ai configure\`, \`ai models\` and \`ai test\`
  ask           ask for a flow patch; prints the score and the ag1_ handle
  fix           the root-cause card for one flow failure
  flow          \`flow test\` (local corpus) and \`flow apply\` (spend a handle)
  capabilities  every command, its effect and its flags
  describe      purpose, usage and flags for one command
  schema        the flag contract for one command, with types
  examples      real invocations for one command

Every command accepts --json and --agent. Each has its own --help.

Config: ${CONFIG_FILE} (mode 600), written by \`dakflare init\`.
Exit:   0 ok · 1 failed · 2 usage · 3 not found · 4 permission · 5 conflict · 6 precondition · 75 retryable/in-flight`,

  init: `Usage: dakflare init [--url <url>] [--token <token> | --token-file <path>]
                     [--local [--force]] [--json]

Verifies GET /v1/admin/health with the admin token, then writes
${CONFIG_FILE} (mode 600). The token is never printed.

  --url <url>          Worker base URL; prompted when omitted and a TTY is present
  --token <token>      admin token (visible in shell history; prefer --token-file)
  --token-file <path>  read the admin token from a file
  --local              do not contact a Worker; write worker/.dev.vars with fresh
                       ADMIN_TOKEN, AUTH_PEPPER, BETTER_AUTH_SECRET and
                       WEBHOOK_SECRET_KEY values
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
       dakflare send --channel <whatsapp|telegram|messenger|instagram> --connector <id> --to <destination> --body <text> [options]

Queues one outbound SMS and prints the command id and its state, or sends one
message through a channel connector and prints the platform result.

SMS options:
  --to <e164>     recipient, for example +8801540196080
  --body <text>   message text (max ${MAX_BODY_CHARS} characters)
  --device <id>   send through this device; omitted when exactly one is paired
  --no-wait       queue and return immediately instead of following the command
  --wait [d]      how long to follow it (default 10s, max 5m)
  --until <s>     stop at this state instead of waiting for delivery:
                  pending, dispatched, sent, delivered (default: sent)
  --idempotency-key <k>
                  retry-safe: the same key returns the command it already created
                  instead of sending a second SMS. The reply carries replayed:true
                  when that happened, and the exit code is still success.

Connector options (require both --channel and --connector):
  --to <dest>     phone number, Page-scoped id or Telegram chat id
  --template-id   WhatsApp template id
  --media-url     media URL to attach
  --human-agent-tag
                  Messenger HUMAN_AGENT message outside the 24h window
  --comment-id    Instagram private reply to a comment

By default the SMS command is followed for up to 10 s, so exit 0 means the radio
accepted it, 1 means FAILED or EXPIRED, and 75 means it was still in flight. With
--no-wait, exit 0 means only that the deployment queued it. The envelope's
verification.passed is true only on DELIVERED: SENT means the radio accepted it,
not that it arrived.

  For a body that begins with "-", use --body="…".`,

  connectors: `Usage: dakflare connectors <list|create|update|delete> [options]

A connector is one external platform account with its credential sealed at rest.
The credential is never returned after it is written.

  list                          id, channel, enabled state, account, label, secret
                                presence and the webhook URL
  create --channel <ch> --account-id <id> --label <name> [options]
                                whatsapp|telegram|messenger|instagram
  update <id> [options]         change the label, enabled state, auth mode or credential
  delete <id> [--yes]           remove the connector and its Durable Object

Credential flags, all sealed at rest and never printed:
  --access-token <tok>          Meta access token, or WhatsApp Cloud token
  --bot-token <tok>             Telegram bot token
  --app-secret <sec>            Meta app secret
  --verify-token <tok>          Meta webhook verify token
  --secret-token <tok>          Telegram webhook secret token

  --auth-mode <mode>            platform auth mode
  --enabled true|false          create and update
  --dry-run                     create only: print the request with credentials
                                redacted, and send nothing

The webhook URL is built from the Worker URL and the connector id. It is not
stored in D1; the API never returns it.`,

  webhooks: `Usage: dakflare webhooks <list|create|delete|deliveries> [options]

Inbound agent webhooks. A POST to /v1/webhooks/:id is signed with the hook's
secret and runs one agent turn. The signing secret is returned only by create.

  list                          id, enabled state and name
  create [--name <name>]        mint a hook; prints the signing secret once
  delete <id> [--yes]           remove the hook and its deliveries
  deliveries <id>               the last 20 deliveries, newest first

  --name <name>                 create: display name, default "webhook"
  --dry-run                     create: print the request and send nothing
  --yes                         delete: skip the confirmation prompt

Store the signing secret when create prints it. The deployment keeps a sealed
copy for verification and will not return it again.`,

  templates: `Usage: dakflare templates <list|create|delete> [options]

  list                          id, channel, name and the variables found in each body
  create --name <n> --body <text> [--channel <ch>] [--dry-run]
                                store a template; the Worker extracts its {{variables}}
  delete <id> [--yes]           remove a template

  --channel <ch>                any|sms|whatsapp|telegram|messenger|instagram, default any
  --dry-run                     create: print the request and send nothing
  --yes                         delete: skip the confirmation prompt`,

  contacts: `Usage: dakflare contacts import <file.csv> [--json]

Reads the file and POSTs it verbatim to /v1/admin/contacts/import with
Content-Type: text/csv. Nothing is buffered through JSON, so the header row and
quoting reach the Worker exactly as written.

Prints how many rows were imported and how many were skipped.`,

  schedule: `Usage: dakflare schedule <list|create|cancel> [options]

  list [--status <s>]           scheduled sends, optionally filtered by status
  create --target <id> --to <peer> --body <text> --at <ISO8601>
                                schedule one send; --at accepts any ISO-8601 timestamp
  cancel <id> [--yes]           cancel a send that has not started

  --channel <ch>                sms|whatsapp|telegram|messenger|instagram, default sms
                                sms targets a device; every other channel a connector
  --template-id <id>            create: template for a connector send
  --dry-run                     create: print the request and send nothing
  --yes                         cancel: skip the confirmation prompt

Cancel exits 5 when the Worker answers 409 not_cancellable, and 3 when the id is
unknown.`,

  status: `Usage: dakflare status <command-id> [--device <id>] [--wait [duration]] [--until <state>] [--json]

Prints one command's state straight from the Durable Object that owns it, or
follows it with --wait. Takes the same --until and returns the same exit codes as
\`dakflare send\`.

  --device <id>   the phone that owns the command; omitted when exactly one is paired
  --wait [d]      poll until the command settles (default 30s, max 5m)
  --until <s>     stop at pending, dispatched, sent or delivered`,

  auth: `Usage: dakflare auth <subcommand> [options]

  bootstrap --email <address>            create the first owner (no credential; enrol a passkey next)
  invite --email <address> [--role r] [--ttl seconds]
                                         mint a single-use invite; prints the dakflare://invite link
  invites                                list invites and whether they were used
  reset --email <address> --yes          recovery: delete the account and mint a fresh owner invite

  mint-agent-token --name <text> --scope <a,b> [--device <id>] [--ttl seconds] [--max-per-hour n]
                                         mint a dkf_agt_ token; printed once, only a digest is stored
  agent-tokens [--all]                   list agent tokens, their budget and last use
  revoke-agent-token <id> --yes          stop a token; it is refused on its next request

  approvals [--state PENDING]            what agents are waiting on, with the ladder to pick from
  approve <id> [--for 15m]               grant it for 1m|5m|15m|30m|1h|1d|7d|30d, clamped per scope
  reject <id>                            refuse it; the agent is told, and may ask again

  grants [--token <id>] [--live]         what is currently allowed, and how often it was used
  grants revoke <grant-id> --yes         close a grant window now

Roles: owner, admin, member. Agent tokens are a third credential, not a role: they
may ASK, and a time-boxed grant decides what they may DO. --agent never prompts,
so pass --yes on the revoking subcommands.`,
  mcp: `Usage: dakflare mcp serve [--token <t> | --token-file <path>] [--version <v>]

Bridges stdio MCP to this deployment. One JSON-RPC message per line in, one out;
every request is forwarded to the Worker's /v1/mcp with the Mcp-Method and
Mcp-Name headers the revision requires, so the tools, the schemas and the answers
are the Worker's, not a second implementation.

Point an MCP client at it:

  { "mcpServers": { "dakflare": {
      "command": "dakflare", "args": ["mcp", "serve", "--token-file", "/path/token"] } } }

The token is a dkf_agt_ agent token, and the tool list is filtered to the scopes
it holds. There is no admin token here: an MCP client gets an agent's reach, not
an operator's.`,

  trace: `Usage: dakflare trace <id> [--device <id>] [--agent]

One id, the whole story: the inbound row and its automation bookkeeping from D1,
the command, its timers and its sockets from the device object, the matching audit
rows, and an approval request if that is what the id is.

The first line is a verdict, and there are seven of them:

  replied               the radio accepted the reply
  queued                a reply is queued, not yet accepted
  failed                the reply command ended FAILED or EXPIRED
  suppressed_cooldown   a rule matched, its cooldown was still open
  suppressed_hourly_cap a rule matched, its hourly cap was spent
  no_match              automation ran and nothing matched
  paused_hitl_approval  an agent asked to send this and nobody has answered

The lines under it are why, with the rule id and the numbers where they exist.`,

  alerts: `Usage: dakflare alerts [--all] [--agent]

Open alerts, newest first. An alert is a fact about a device (silent too long), not
a deployment metric. A device that comes back resolves its own alert, so "open"
means unresolved AND unacknowledged. --all includes the history.`,

  dlq: `Usage: dakflare dlq [--device <id>] [--limit <n>]

Dead letters from the device object: tasks that failed past their retry budget.
They are the alarms that gave up, so they are worth reading before they are
cleared. Max 200 rows per call.`,

  ws: `Usage: dakflare ws inspect [--device <id>]

What the device object thinks its sockets are: socket id, when it was accepted,
its last liveness evidence, how long it has been quiet, and its readyState. This
is the same evidence the push path uses to decide a socket is stale, so it cannot
disagree with what actually gets closed.`,

  extract: `Usage: dakflare extract synthesize --samples <file> [options]

  synthesize --samples <file>      derive a regex from real messages, and prove it

The file is { "samples": [ { "body": "...", "value": "..." } ], "negatives": [ "..." ],
"group": "trx_id" } or a bare array of {body, value}. Every value must appear
exactly ONCE in its body: twice is refused rather than guessed, because a pattern
derived from an ambiguous span extracts the wrong number from half the traffic and
there is no way to tell which half.

The pattern is returned only after it has been run against every sample (exactly
one match, capturing exactly the expected value) and every negative (no match), so
precision and recall in the response are measured, not claimed.

  --group <name>          capture-group name, default "value"
  --verify-d1-limit <n>   also run it over n recent inbound messages from the
                          deployment. History has no ground truth, so that reports
                          HOW MANY matched, not whether the matches were right.

Runs offline against the bundled flow.wasm: the same engine the Worker uses, so
what this prints is what a flow will do.`,

  ask: `Usage: dakflare ask "<intent>" --flow <id> [options]

Asks the deployment to judge a candidate patch for one flow, and prints what it
found: the faithfulness score, whether a human must approve, and — when approval
is required — the ag1_ handle that a later \`dakflare flow apply\` spends.

  --flow <id>             the flow the patch is for (required)
  --diff-summary <text>   what changes; default is "intent: <intent>"
  --corpus-report <text>  the measured corpus numbers to weigh, max 1000 chars
  --ndjson                one JSON object per phase, one per line
  --dry-run               print the request and send nothing

Phases, in order: understand (the flow was read), propose (the request body),
verify (the HTTP outcome), result (score, approval, handle), and error when a
phase fails. The handle is only masked on a non-TTY without --json: it is bearer
authority for one apply, so it is not printed into a pipeline by accident.

A required approval is not a failure: the command exits 0 and names the handle,
because the handle is what a human's approval is for.`, 

  fix: `Usage: dakflare fix (--flow <id> | --run <run-id>) [options]

Prints the root-cause card for one failure: the code, a one-line summary, the
character offset, a before/bad/after window with the offending bytes visible,
the encoding and segment count, and the proposed pattern patch when there is one.

  --flow <id>          a flow, sent as flow_id; its newest stored run is diagnosed
  --run <run-id>       one run, sent as flow_run_id
                       (device_id/local_id/flow_id/flow_version, as flow_runs prints it)
  --message-id <id>    explain this stored message
  --message <text>     diagnose this body directly, with no stored row
  --pattern <regex>    also check whether the pattern cuts a reference in half
  --ndjson             one JSON object per phase, one per line
  --dry-run            print the request and send nothing

Use --flow or --run, not both. A flow with no stored runs is refused by name
(exit 3) rather than guessed at; a malformed run id is usage (exit 2).

Invisible characters are rendered as <U+XXXX> and control bytes as \\uXXXX, so a
zero-width space is visible in the highlight rather than silently shortening it.
Exit 0 means the card was produced, including when no signature matched: the card
says "no signature matched" and that is an answer, not a failure.`,

  flow: `Usage: dakflare flow test --flow <id> --corpus <file.jsonl> [--json]
       dakflare flow apply --token <handle> [--totp <code>]

  test   run the built flow engine over a labelled corpus, locally
  apply  spend an ag1_ handle through the existing approval route

\`flow test\` instantiates flow.wasm with Node's built-in WebAssembly — no
dependency, no Worker round trip — and scores every row. The corpus is JSONL:

  {"sender":"+8801...","body":"Paid 500 at REF 12A45","expect":{"outcome":"delivered","variables":{"amount":"500"}}}

It prints precision (correct values / produced values), recall (expected values
produced / expected values), specificity (fixed-token mass, an ESTIMATE),
dfa_estimate (construct count against the 2048-state budget, an ESTIMATE), and
linear_time_guaranteed, which is true only when every pattern is RE2-compilable
(no backreference, lookaround, atomic group, conditional, possessive quantifier
or nested quantifier). Per-row mismatches name the expected and the actual.

If no built engine exists the command exits 6 and names the build command. It
never reports a pass it did not run. A row mismatch exits 1.

\`flow apply\` decodes the handle to the target it names, finds the pending
approval request for that flow, and answers it through
POST /v1/admin/approvals/:id/approve — the same route a person uses. It does not
mint a grant itself. It is idempotent by handle: if that request is already
answered it reports who and when instead of granting twice, exiting 0 when the
answer was approval and 5 when it was not. A 401/403 exits 4.

  --totp <code>   six digits, sent as X-Dakflare-Totp; never echoed

Note the difference from \`dakflare flows apply <file>\`: that writes a flow
document, this spends authority.`,

  flows: `Usage: dakflare flows apply <file> [--id <id>] [--dry-run] [--agent]
       dakflare flows heal <id> --samples <file> [--group <name>] [--device <id>] [--dry-run]

  apply <file>    write one flow document and let the Worker compute its layout
  heal <id>       re-check an extract pattern against historical inbound messages

The file is { "id", "name", "graph", "device_id"?, "enabled"?,
"expected_previous_version"? } or a bare { "nodes", "edges" } with --id and the
name taken from the file name. A bare graph needs no coordinates: the canonical
IR ranks every node by its longest distance from the trigger and places it, so
an agent can author a flow without knowing anything about the canvas.

--dry-run prints a structural diff (nodes, edges, variables, layout) as
data.dry_run_diff and writes nothing. A stale expected_previous_version exits 5
and names the current version to retry against. A refused graph exits 2 and
prints every issue with its path.

This writes a DOCUMENT. \`dakflare flow apply --token <handle>\` is a different
command: it spends the authority an \`ask\` handle names.`,

  rules: `Usage: dakflare rules <list|apply|update|delete|test> [options]

  list             list rules in priority order
  apply <file>     write one rule or a { "rules": [ ... ] } document
  update <id>      patch one rule (--enabled|--disabled, --name, --reply, ...)
  delete <id>      remove a rule (--yes to skip prompt)
  test --peer <e164> --body <text> [--device <id>]
                   evaluate every rule and say why each would or would not reply

apply --dry-run reports create/update/unchanged per rule and writes nothing.
test is the honest answer to "why did this message get no reply": disabled,
sender_mismatch, body_mismatch and cooldown are all reported, not just matches.`,

  up: `Usage: dakflare up [--email <address>] [--yes] [--dry-run] [--agent]

Provisions the deployment on the account \`cf\` is logged into: installs missing
dependencies, writes worker/.dev.vars (with WEBHOOK_SECRET_KEY) when it is
missing, creates the D1 database, the KV namespace and the three queues if they
are missing, writes both ids into worker/cloudflare.config.ts, applies
migrations, deploys with the local secrets, checks health, saves the deployment
to the CLI config, creates the owner, and mints one pairing code (with a
scannable QR).

Every step converges, so running it twice is safe and running it on a live
deployment repairs it rather than replacing it.

  --email <address>  bootstrap this owner; skipped when one already exists
  --yes              skip the confirmation before deploying
  --dry-run          resolve, check and print the plan; change nothing

Requires \`cf\` on PATH. When it is not authenticated, an interactive run starts
\`cf auth login\`; --agent and non-TTY runs refuse and name that command. There is
no wrangler fallback on purpose: two deploy paths differ only on someone else's
machine.
`,
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
       dakflare schema states [--agent]
       dakflare schema --flow-v2 [--json]

The flag contract as data: name, type, whether it is required, and what it means.
Use this when you need to build a call rather than read about one.

--flow-v2 prints the canonical dakflare.flow/v2 JSON Schema (node types, edges,
template spans, and the fields an ag1_ apply handle carries). With --json the
schema is the whole of stdout, with no envelope, so it can be piped straight
into a validator. The document lives at ${FLOW_V2_SCHEMA_PATH}; it was derived
from worker/src/lib/flow-ir.ts, which is the checker it describes.`,
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

  ai: `Usage: dakflare ai <providers|configure|models|test> [options]

  providers                       both roles: provider, chat model, System One model
                                  (and whether it inherits the chat model/base),
                                  the key source for each role, and today's budget
  configure --provider <kind> [--model <id>] [--base-url <url>]
            [--system1-model <id>] [--system1-base-url <url>] [--dry-run]
                                  write the singleton AI settings row
  models                          the catalog the provider publishes (GET {base}/models);
                                  workers-ai answers a short static list instead
  test                            one tiny chat provider call; prints ok, provider,
                                  model, took_ms and a sample
  test --system-one               one tiny System One decision; prints provider,
                                  model, took_ms and each answer (id, type, and
                                  choice/probability, noul or score)

Providers: workers-ai (the Worker's AI binding, no key) and
openai-compatible (any /chat/completions endpoint, reached with a key).

--provider is required. --model is optional and falls back to the provider's
default. --base-url is required for openai-compatible and must be https, or
http on localhost; it is refused for workers-ai. --system1-model overrides the
model System One uses; --system1-base-url does the same for its origin, with the
same https-or-loopback rule, and is refused for workers-ai. Omitting them leaves
System One on the chat model and base, which is what --dry-run says instead of
sending empty strings. --dry-run prints the PUT request and sends nothing.

The API key is never accepted here: it belongs in a Worker secret, set with
\`cf workers secrets update AI_CHAT_API_KEY --worker <worker> --type secret_text\` (the CLI names
dakflare-worker unless DAKFLARE_WORKER_NAME says otherwise). Chat and System One
resolve their own secret, and \`ai providers\` names the one that answered each
role (or "none"). If a key is missing for openai-compatible, the command prints
that exact remediation and exits 6, because it is a precondition rather than a
network failure.

Exit: 0 ok · 2 usage or refused --api-key/--system1-base-url · 4 permission ·
5 daily budget exhausted (prints used/limit) · 6 missing key or binding ·
75 provider unreachable (a System One 503 also prints the gateway's reason)`,
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
  connectors: commandConnectors,
  webhooks: commandWebhooks,
  templates: commandTemplates,
  contacts: commandContacts,
  schedule: commandSchedule,
  up: commandUp,
  capabilities: commandCapabilities,
  describe: commandDescribe,
  schema: commandSchema,
  examples: commandExamples,
  audit: commandAudit,
  auth: commandAuth,
  flows: commandFlows,
  rules: commandRules,
  extract: commandExtract,
  ask: commandAsk,
  fix: commandFix,
  flow: commandFlow,
  trace: commandTrace,
  mcp: commandMcp,
  alerts: commandAlerts,
  dlq: commandDlq,
  ws: commandWs,
  key: commandKey,
  ai: commandAi,
};

async function main() {
  const [command, ...rest] = process.argv.slice(2);

  if (command === '--version' || command === '-v' || command === 'version') {
    out(`dakflare ${CLI_VERSION}`);
    return 0;
  }

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
    throw new CliError(`unknown command "${command}"; run \`dakflare --help\` or \`dakflare capabilities\``, 2, {
      error: 'usage',
      unknown_command: command,
    });
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
    const mapped = ERROR_RULES[error.payload?.error]?.exit;
    process.exitCode = mapped ?? (Number.isInteger(error.code) ? error.code : 1);
  } else {
    const detail = process.env.DAKFLARE_DEBUG ? String(error?.stack ?? error) : String(error?.message ?? error);
    if (json) emitJson({ ok: false, error: 'internal', message: detail }, MODE);
    else err(`dakflare: ${detail}`);
    process.exitCode = 1;
  }
}
