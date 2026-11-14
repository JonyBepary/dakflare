#!/usr/bin/env node
/**
 * approval-race.mjs — prove the decide path's single-winner guarantee.
 *
 * The worker claims a pending approval with ONE conditional UPDATE
 * (`decideApproval` -> `claim`). Two approvers reading PENDING at the same time
 * must therefore produce exactly one 200 and one 409 `not_pending`; the loser
 * must be told who decided and which way. This script exercises that live,
 * through the real routes:
 *
 *   1. POST /v1/admin/agent-tokens            (admin)    mint a throwaway agent
 *   2. DELETE /v1/admin/workflows/:id         (agent)    asks for flow_deploy_prod,
 *                                                        so the Worker opens a
 *                                                        pending approval (202)
 *   3. POST /v1/admin/approvals/:id/approve   (admin, concurrent)
 *      POST /v1/admin/approvals/:id/reject    (admin, concurrent)
 *   4. GET/DELETE /v1/admin/grants, DELETE /v1/admin/agent-tokens (cleanup)
 *
 * Zero dependencies, Node 22+, global `fetch`.
 *
 * Exit codes: 0 both cases passed; 1 an assertion failed, an unexpected status
 * arrived, or cleanup failed; 2 usage/config; 6 the dev stack is not running.
 *
 * Connection resolution, in order (the harness's own styles, no hidden target):
 *   URL:   --url, DAKFLARE_URL, WORKER_URL, ~/.config/dakflare/config.json "url"
 *   Token: --token/--token-file, DAKFLARE_TOKEN, ADMIN_TOKEN, config "token"
 * Both must resolve; there is no built-in default, so a typo cannot point the
 * test at production.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CONFIG_FILE = path.join(os.homedir(), '.config', 'dakflare', 'config.json');
const DEFAULT_DURATION_S = 300;

/* ─────────────────────────────── arguments ─────────────────────────────── */

function usage() {
  return `approval-race.mjs — prove approve/reject races have one winner

Usage:
  node test-support/approval-race.mjs [--url <url>] [--token <token> | --token-file <path>]

Connection:
  --url           Worker base URL (else DAKFLARE_URL, WORKER_URL, CLI config)
  --token         admin token      (else DAKFLARE_TOKEN, ADMIN_TOKEN, CLI config)
  --token-file    read the admin token from a file (one line, trimmed)
  --help          this text

Environment:
  DAKFLARE_URL / WORKER_URL    base URL
  DAKFLARE_TOKEN / ADMIN_TOKEN admin token

Exit codes:
  0 both races passed   1 assertion/cleanup failure
  2 usage or no connection   6 dev stack not running

Start a local stack first:
  ./test-support/dev.sh
  # then, in another terminal, if your docs ask for a paired device:
  node dakflare_test_harness.mjs pair
`;
}

function parseArgs(argv) {
  const opts = { help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--url') opts.url = argv[++i];
    else if (arg.startsWith('--url=')) opts.url = arg.slice('--url='.length);
    else if (arg === '--token') opts.token = argv[++i];
    else if (arg.startsWith('--token=')) opts.token = arg.slice('--token='.length);
    else if (arg === '--token-file') opts.tokenFile = argv[++i];
    else if (arg.startsWith('--token-file=')) opts.tokenFile = arg.slice('--token-file='.length);
    else throw new UsageError(`unknown argument: ${arg}`);
  }
  return opts;
}

class UsageError extends Error {}

function readCliConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function readTokenFile(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch (error) {
    throw new UsageError(`could not read --token-file ${file}: ${error.message}`);
  }
}

function resolveConnection(opts) {
  const cfg = readCliConfig() ?? {};
  const rawUrl =
    opts.url ??
    process.env.DAKFLARE_URL ??
    process.env.WORKER_URL ??
    (typeof cfg.url === 'string' ? cfg.url : '');
  const fileToken = opts.tokenFile === undefined ? '' : readTokenFile(opts.tokenFile);
  const rawToken =
    opts.token ??
    (fileToken !== '' ? fileToken : undefined) ??
    process.env.DAKFLARE_TOKEN ??
    process.env.ADMIN_TOKEN ??
    (typeof cfg.token === 'string' ? cfg.token : '');

  const url = String(rawUrl).trim().replace(/\/+$/, '');
  const token = String(rawToken).trim();
  if (url === '' || token === '') {
    const missing = [url === '' ? 'URL' : null, token === '' ? 'token' : null]
      .filter(Boolean)
      .join(' and ');
    throw new UsageError(
      `no ${missing} configured. Pass --url/--token, set DAKFLARE_URL/DAKFLARE_TOKEN, ` +
        `or run \`dakflare init\`. (config: ${CONFIG_FILE})`
    );
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new UsageError(`--url is not a valid URL: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UsageError(`--url must be http(s), got ${parsed.protocol}`);
  }
  return { url, token };
}

/* ─────────────────────────────── HTTP ─────────────────────────────── */

class OfflineError extends Error {}

function headers(token, withBody = false) {
  return {
    Authorization: `Bearer ${token}`,
    // The harness's machine-credential marker: in AUTH_MODE=new this is what
    // selects the CLI/admin path rather than a human session.
    'X-Dakflare-Client': 'cli',
    ...(withBody ? { 'Content-Type': 'application/json' } : {}),
  };
}

async function request(base, token, method, pathname, body) {
  let res;
  try {
    res = await fetch(base + pathname, {
      method,
      headers: headers(token, body !== undefined),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw new OfflineError(`cannot reach ${base}: ${error.message}`);
  }
  const text = await res.text();
  let data = null;
  try {
    data = text === '' ? null : JSON.parse(text);
  } catch {
    data = null;
  }
  return { status: res.status, data, text };
}

async function checkHealth(base, token) {
  let res;
  try {
    res = await fetch(`${base}/v1/admin/health`, { headers: headers(token) });
  } catch (error) {
    throw new OfflineError(`cannot reach ${base}/v1/admin/health: ${error.message}`);
  }
  if (res.status !== 200) {
    throw new Error(
      `Worker is reachable at ${base} but /v1/admin/health returned ${res.status}. ` +
        `Check --token/DAKFLARE_TOKEN (admin token) and the Worker logs.`
    );
  }
}

/* ─────────────────────────────── helpers ─────────────────────────────── */

function fail(message) {
  throw new Error(message);
}

function expect(condition, message) {
  if (!condition) fail(message);
}

function isObject(value) {
  return value !== null && typeof value === 'object';
}

function shortBody(res) {
  const text = typeof res?.text === 'string' ? res.text : JSON.stringify(res?.data ?? null);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

async function mintAgent(base, adminToken, label) {
  const res = await request(base, adminToken, 'POST', '/v1/admin/agent-tokens', {
    name: label,
    scopes: ['flow_deploy_prod'],
  });
  expect(res.status === 200, `mint agent -> ${res.status}, expected 200: ${shortBody(res)}`);
  expect(isObject(res.data) && typeof res.data.token === 'string', 'mint agent: response has no token');
  expect(typeof res.data.id === 'string' && res.data.id !== '', 'mint agent: response has no id');
  return { id: res.data.id, token: res.data.token };
}

/**
 * Ask for a flow deploy through the agent route the product uses. The Worker
 * has no live grant for this flow, so it must open a pending approval (202).
 */
async function openApproval(base, agentToken, flowId) {
  const res = await request(
    base,
    agentToken,
    'DELETE',
    `/v1/admin/workflows/${encodeURIComponent(flowId)}`
  );
  const body = isObject(res.data) ? res.data : {};
  expect(
    res.status === 202 && body.error === 'approval_required',
    `open approval -> ${res.status} ${shortBody(res)}, expected 202 approval_required`
  );
  const approvalId = body.approval_request?.id;
  expect(
    typeof approvalId === 'string' && approvalId !== '',
    'open approval: response has no approval_request.id'
  );
  expect(
    body.approval_request?.scope === 'flow_deploy_prod',
    `open approval: expected flow_deploy_prod, got ${String(body.approval_request?.scope)}`
  );
  return approvalId;
}

async function listGrants(base, adminToken, agentTokenId, liveOnly = false) {
  const query = `?token=${encodeURIComponent(agentTokenId)}${liveOnly ? '&live=1' : ''}`;
  const res = await request(base, adminToken, 'GET', `/v1/admin/grants${query}`);
  expect(res.status === 200, `list grants -> ${res.status}, expected 200: ${shortBody(res)}`);
  expect(Array.isArray(res.data?.grants), 'list grants: response has no grants array');
  return res.data.grants;
}

/** "request is already approved by admin" -> "admin", as a fallback when a
 *  route (reject) does not carry structured decided_by/decided_at. */
function deciderFromMessage(message) {
  if (typeof message !== 'string') return null;
  const match = /\bby\s+(.+?)\s*$/i.exec(message);
  return match === null ? null : match[1].trim();
}

function directionFromMessage(message) {
  if (typeof message !== 'string') return null;
  if (/\balready approved\b/i.test(message)) return 'approved';
  if (/\balready rejected\b/i.test(message)) return 'rejected';
  if (/\balready expired\b/i.test(message)) return 'expired';
  return null;
}

/**
 * The loser must be told who decided and which way.
 *
 * `decideApproval` has two 409 exits:
 *   - the early "state is not PENDING" check, which carries no decided_by/at;
 *   - `lostRace`, reached when this caller's conditional claim loses, which does.
 *
 * A single-isolate `wrangler dev` serialises the two requests, so the early
 * check is the one that fires locally. That is exactly the branch the CLI
 * compensates for: on a 409 without `decided_by`, `flow apply` re-reads
 * /v1/admin/approvals and reports the decider from there (dakflare.js:5400-5409).
 * This check follows the same contract: body first, message second, lookup last,
 * and it records which of the three answered so the run can say whether the
 * body itself was complete.
 */
async function assertLoserTold(base, adminToken, approvalId, loser, winnerState, label) {
  expect(loser.status === 409, `${label}: loser -> ${loser.status}, expected 409`);
  const body = isObject(loser.data) ? loser.data : {};
  expect(
    body.error === 'not_pending',
    `${label}: loser error is ${JSON.stringify(body.error)}, expected "not_pending"`
  );

  const direction = String(winnerState).toLowerCase();
  const toldDirection = directionFromMessage(body.message);
  expect(
    toldDirection === direction,
    `${label}: loser message does not say "${direction}": ${JSON.stringify(body.message)}`
  );

  const bodyBy = typeof body.decided_by === 'string' && body.decided_by !== '' ? body.decided_by : null;
  const fromMessage = deciderFromMessage(body.message);
  let decider = bodyBy ?? fromMessage;
  let decidedAt = typeof body.decided_at === 'number' && body.decided_at > 0 ? body.decided_at : null;
  let source = bodyBy === null ? 'message' : 'body';

  if (decider === null || decidedAt === null) {
    const listed = await request(base, adminToken, 'GET', '/v1/admin/approvals');
    expect(listed.status === 200, `${label}: approval lookup -> ${listed.status}, expected 200`);
    const row = (listed.data?.approvals ?? []).find((approval) => approval.id === approvalId);
    expect(isObject(row), `${label}: decided approval ${approvalId} not found`);
    if (decider === null) {
      decider =
        typeof row.decided_by === 'string' && row.decided_by !== '' ? row.decided_by : null;
      source = 'approval lookup';
    }
    if (decidedAt === null) {
      decidedAt = typeof row.decided_at === 'number' && row.decided_at > 0 ? row.decided_at : null;
    }
  }

  expect(
    typeof decider === 'string' && decider !== '',
    `${label}: loser was not told who decided (decided_by=${JSON.stringify(body.decided_by)}, ` +
      `message=${JSON.stringify(body.message)})`
  );
  expect(
    typeof decidedAt === 'number' && decidedAt > 0,
    `${label}: loser was not told when it was decided (decided_at=${JSON.stringify(body.decided_at)})`
  );

  return {
    decider,
    decidedAt,
    // Did the 409 body itself carry the pair the task expects?
    bodyCarried: bodyBy !== null && typeof body.decided_at === 'number',
    source,
  };
}

/* ─────────────────────────────── cases ─────────────────────────────── */

async function caseApproveVsApprove(base, adminToken, agentToken, stamp) {
  const flowId = `race_approve_${stamp}`;
  const approvalId = await openApproval(base, agentToken.token, flowId);

  const [first, second] = await Promise.all([
    request(base, adminToken, 'POST', `/v1/admin/approvals/${encodeURIComponent(approvalId)}/approve`, {
      duration_s: DEFAULT_DURATION_S,
    }),
    request(base, adminToken, 'POST', `/v1/admin/approvals/${encodeURIComponent(approvalId)}/approve`, {
      duration_s: DEFAULT_DURATION_S,
    }),
  ]);

  const statuses = [first.status, second.status];
  const winners = [first, second].filter((res) => res.status === 200);
  const conflicts = [first, second].filter((res) => res.status === 409);
  expect(
    winners.length === 1 && conflicts.length === 1,
    `approve vs approve: expected one 200 and one 409, got ${statuses.join(' and ')}`
  );

  const winner = winners[0];
  const winnerBody = isObject(winner.data) ? winner.data : {};
  expect(winnerBody.ok === true, 'approve vs approve: winner body is not ok:true');
  expect(winnerBody.approval?.state === 'APPROVED',
    `approve vs approve: winner state is ${String(winnerBody.approval?.state)}, expected APPROVED`);
  expect(typeof winnerBody.grant?.id === 'string' && winnerBody.grant.id !== '',
    'approve vs approve: winner minted no grant');

  const loser = conflicts[0];
  const told = await assertLoserTold(base, adminToken, approvalId, loser, 'APPROVED', 'approve vs approve');

  const branch = (await listGrants(base, adminToken, agentToken.id)).filter(
    (grant) => grant.approval_request_id === approvalId
  );
  expect(branch.length === 1,
    `approve vs approve: expected exactly one grant for the approval, found ${branch.length}`);
  expect(branch[0].id === winnerBody.grant.id,
    `approve vs approve: live grant ${branch[0].id} is not the winner's ${winnerBody.grant.id}`);

  return {
    line:
      `case 1 approve vs approve: PASS — one 200 (grant ${winnerBody.grant.id.slice(0, 8)}…), ` +
      `one 409 not_pending; loser told ${told.decider} approved ` +
      `(${told.bodyCarried ? 'decided_by/decided_at in body' : `via ${told.source}; body omitted them`})`,
    grantIds: [winnerBody.grant.id],
  };
}

async function caseApproveVsReject(base, adminToken, agentToken, stamp) {
  const flowId = `race_decide_${stamp}`;
  const approvalId = await openApproval(base, agentToken.token, flowId);

  const [approve, reject] = await Promise.all([
    request(base, adminToken, 'POST', `/v1/admin/approvals/${encodeURIComponent(approvalId)}/approve`, {
      duration_s: DEFAULT_DURATION_S,
    }),
    request(base, adminToken, 'POST', `/v1/admin/approvals/${encodeURIComponent(approvalId)}/reject`, {}),
  ]);

  const results = [approve, reject];
  const winners = results.filter((res) => res.status === 200);
  const conflicts = results.filter((res) => res.status === 409);
  expect(
    winners.length === 1 && conflicts.length === 1,
    `approve vs reject: expected one 200 and one 409, got ${results.map((r) => r.status).join(' and ')}`
  );

  const winner = winners[0];
  const winnerBody = isObject(winner.data) ? winner.data : {};
  const winnerState = winnerBody.approval?.state;
  expect(winnerState === 'APPROVED' || winnerState === 'REJECTED',
    `approve vs reject: winner state is ${String(winnerState)}, expected APPROVED or REJECTED`);

  const loser = conflicts[0];
  const told = await assertLoserTold(base, adminToken, approvalId, loser, winnerState, 'approve vs reject');

  // The grant table, not the response, is the truth about what the losing
  // branch minted. An approval names at most one grant.
  const branch = (await listGrants(base, adminToken, agentToken.id)).filter(
    (grant) => grant.approval_request_id === approvalId
  );
  const grantIds = [];
  if (winnerState === 'APPROVED') {
    expect(typeof winnerBody.grant?.id === 'string' && winnerBody.grant.id !== '',
      'approve vs reject: approval won but minted no grant');
    expect(branch.length === 1,
      `approve vs reject: expected exactly one grant, found ${branch.length}`);
    expect(branch[0].id === winnerBody.grant.id,
      `approve vs reject: grant ${branch[0].id} is not the winner's ${winnerBody.grant.id}`);
    grantIds.push(winnerBody.grant.id);
  } else {
    expect(branch.length === 0,
      `approve vs reject: rejection won but ${branch.length} grant(s) exist for the approval`);
    expect(winnerBody.approval?.grant_id === null || winnerBody.approval?.grant_id === undefined,
      `approve vs reject: rejected approval carries grant_id ${String(winnerBody.approval?.grant_id)}`);
    expect(winnerBody.grant === null || winnerBody.grant === undefined,
      'approve vs reject: rejected response carries a grant');
  }

  return {
    line:
      `case 2 approve vs reject: PASS — ${winnerState.toLowerCase()} won; ` +
      `409 not_pending loser told ${told.decider} ${winnerState.toLowerCase()} ` +
      `(${told.bodyCarried ? 'decided_by/decided_at in body' : `via ${told.source}; body omitted them`}); ` +
      `grants for the approval: ${branch.length}`,
    grantIds,
  };
}

/* ─────────────────────────────── cleanup ─────────────────────────────── */

async function cleanup(base, adminToken, agentTokenId, grantIds) {
  const problems = [];

  for (const grantId of grantIds) {
    if (typeof grantId !== 'string' || grantId === '') continue;
    try {
      const res = await request(base, adminToken, 'DELETE', `/v1/admin/grants/${encodeURIComponent(grantId)}`);
      if (res.status !== 200 && res.status !== 404) {
        problems.push(`revoke grant ${grantId} -> ${res.status}: ${shortBody(res)}`);
      }
    } catch (error) {
      problems.push(`revoke grant ${grantId}: ${error.message}`);
    }
  }

  // Belt and braces: revoke anything live the token still holds, even if the
  // case failed before it could record the grant id.
  if (agentTokenId !== null) {
    try {
      const live = await listGrants(base, adminToken, agentTokenId, true);
      for (const grant of live) {
        const res = await request(base, adminToken, 'DELETE', `/v1/admin/grants/${encodeURIComponent(grant.id)}`);
        if (res.status !== 200 && res.status !== 404) {
          problems.push(`revoke live grant ${grant.id} -> ${res.status}: ${shortBody(res)}`);
        }
      }
      const remaining = await listGrants(base, adminToken, agentTokenId, true);
      if (remaining.length !== 0) {
        problems.push(`token still holds ${remaining.length} live grant(s) after cleanup`);
      }
    } catch (error) {
      problems.push(`verify grants: ${error.message}`);
    }

    try {
      const res = await request(
        base,
        adminToken,
        'DELETE',
        `/v1/admin/agent-tokens/${encodeURIComponent(agentTokenId)}`
      );
      if (res.status !== 200 && res.status !== 409) {
        problems.push(`revoke agent token -> ${res.status}: ${shortBody(res)}`);
      }
    } catch (error) {
      problems.push(`revoke agent token: ${error.message}`);
    }
  }

  return problems;
}

/* ─────────────────────────────── main ─────────────────────────────── */

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`approval-race: ${error.message}\n\n${usage()}`);
      return 2;
    }
    throw error;
  }
  if (opts.help) {
    process.stdout.write(usage());
    return 0;
  }

  let conn;
  try {
    conn = resolveConnection(opts);
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`approval-race: ${error.message}`);
      return 2;
    }
    throw error;
  }
  const { url: base, token: adminToken } = conn;

  try {
    await checkHealth(base, adminToken);
  } catch (error) {
    if (error instanceof OfflineError) {
      console.error(
        `approval-race: the dev stack is not running (${error.message}).\n` +
          `Start it with:\n  ./test-support/dev.sh\n` +
          `Then retry this script. (Optional, if your docs require a paired device:\n` +
          `  node dakflare_test_harness.mjs pair)`
      );
      return 6;
    }
    console.error(`approval-race: ${error.message}`);
    return 1;
  }

  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  let agent = null;
  const grantIds = new Set();
  const lines = [];
  let failed = false;

  try {
    agent = await mintAgent(base, adminToken, `approval-race ${stamp}`);
  } catch (error) {
    failed = true;
    lines.push(`setup mint agent token: FAIL — ${error.message}`);
  }

  if (agent !== null) {
    // Run both cases even if one fails: each is independent evidence, and the
    // cleanup sweep below still sees any grant the failed case minted.
    try {
      const first = await caseApproveVsApprove(base, adminToken, agent, stamp);
      lines.push(first.line);
      for (const id of first.grantIds) grantIds.add(id);
    } catch (error) {
      failed = true;
      lines.push(`case 1 approve vs approve: FAIL — ${error.message}`);
    }

    try {
      const second = await caseApproveVsReject(base, adminToken, agent, stamp);
      lines.push(second.line);
      for (const id of second.grantIds) grantIds.add(id);
    } catch (error) {
      failed = true;
      lines.push(`case 2 approve vs reject: FAIL — ${error.message}`);
    }
  }

  // Always clean, even after a failed assertion: a live grant outliving the
  // test is a real grant, not a test artefact.
  const problems = await cleanup(base, adminToken, agent?.id ?? null, grantIds);

  for (const line of lines) console.log(line);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`cleanup FAIL: ${problem}`);
  } else if (agent !== null) {
    console.log('cleanup: PASS — minted grants revoked, agent token deleted, no live grants left');
  }

  return !failed && problems.length === 0 ? 0 : 1;
}

let code;
try {
  code = await main();
} catch (error) {
  // Never a stack trace: this is a diagnostic tool for humans.
  console.error(`approval-race: unexpected error: ${error?.message ?? String(error)}`);
  code = 1;
}
process.exit(code);
