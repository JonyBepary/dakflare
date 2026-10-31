/**
 * Authority grants and approval requests — "how much may an agent do, until when".
 *
 * Approval is not a boolean; it is a LEASE, in the same spirit as the command
 * lease in the Durable Object and for the same reason: bounded in time, held by
 * an identified party, checked at the edge on every request.
 *
 * Three rules make this hold together:
 *
 *   1. A grant has an ABSOLUTE `expires_at`. Every check is `expires_at > now`,
 *      so a retry that arrives after the window closed cannot use it, no matter
 *      what the client believes.
 *   2. A grant names a TARGET. `sms:send:production` must name recipients or a
 *      device, so "approved for fifteen minutes" cannot become "approved for
 *      anyone". A target with no constraint matches nothing.
 *   3. A missing grant is an approval REQUEST, never a refusal. An agent that
 *      cannot act is told what a human has to decide, not given an error it can
 *      retry around.
 *
 * The ceiling per scope lives in `agent-scopes.ts`; the ladder an operator picks
 * from is there too. This module enforces both.
 */

import type { Env } from "../index";
import { GRANT_LADDER_S, SCOPE_CAPS, NEVER_GRANTABLE, isTokenScope } from "./agent-scopes";

/** How long an unanswered request stays actionable. */
export const APPROVAL_TTL_MS = 15 * 60_000;

/** Bound on "show me the grants" so one call cannot read an unbounded table. */
const MAX_LIST_ROWS = 200;

export interface GrantTarget {
  /** E.164 numbers the grant is limited to. */
  recipients?: string[];
  device_id?: string;
  flow_id?: string;
  rule_id?: string;
}

export interface GrantRecord {
  id: string;
  agent_token_id: string;
  scope: string;
  target: GrantTarget;
  granted_by: string;
  granted_at: number;
  expires_at: number;
  revoked_at: number | null;
  use_count: number;
  last_used_at: number | null;
  approval_request_id: string | null;
}

export interface ApprovalRecord {
  id: string;
  agent_token_id: string;
  scope: string;
  target: GrantTarget;
  reason: string | null;
  state: "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED" | "CANCELLED";
  requested_at: number;
  expires_at: number;
  decided_by: string | null;
  decided_at: number | null;
  grant_id: string | null;
}

interface GrantRow {
  id: string;
  agent_token_id: string;
  scope: string;
  target_json: string;
  granted_by: string;
  granted_at: number;
  expires_at: number;
  revoked_at: number | null;
  use_count: number;
  last_used_at: number | null;
  approval_request_id: string | null;
}

interface ApprovalRow {
  id: string;
  agent_token_id: string;
  scope: string;
  target_json: string;
  reason: string | null;
  state: ApprovalRecord["state"];
  requested_at: number;
  expires_at: number;
  decided_by: string | null;
  decided_at: number | null;
  grant_id: string | null;
}

/* ─────────────────────────────── targets ─────────────────────────────── */

/**
 * Serialise a target with a FIXED key order.
 *
 * This is load-bearing twice over: the partial unique indexes compare the column
 * byte for byte, and grant matching is a JSON round trip. Two equivalent targets
 * that stringify differently would be two grants, which is exactly the stacking
 * the unique index exists to prevent.
 */
export function canonicalTargetJson(target: GrantTarget): string {
  const ordered: Record<string, unknown> = {};
  if (target.recipients !== undefined && target.recipients.length > 0) {
    ordered.recipients = [...new Set(target.recipients)].sort();
  }
  for (const key of ["device_id", "flow_id", "rule_id"] as const) {
    const value = target[key];
    if (typeof value === "string" && value !== "") ordered[key] = value;
  }
  return JSON.stringify(ordered);
}

export function parseTargetJson(json: string): GrantTarget {
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const row = parsed as Record<string, unknown>;
    const target: GrantTarget = {};
    if (Array.isArray(row.recipients)) {
      const recipients = row.recipients.filter(
        (entry): entry is string => typeof entry === "string" && entry !== ""
      );
      if (recipients.length > 0) target.recipients = recipients;
    }
    for (const key of ["device_id", "flow_id", "rule_id"] as const) {
      if (typeof row[key] === "string" && row[key] !== "") target[key] = row[key] as string;
    }
    return target;
  } catch {
    return {};
  }
}

/**
 * Does a grant's target cover what is being asked for?
 *
 * Every constraint in the grant must be satisfied (AND), and a grant with no
 * constraint covers nothing. The second half matters: an empty target parses
 * from `{}` and would otherwise be a wildcard, which is the one thing a grant
 * must never be.
 *
 * `allRecipients` flips the recipient check from "one of these" (a single send)
 * to "every one of these" (a batch). Without it a grant for one number would
 * authorise a batch that happened to include it.
 */
export function targetMatches(
  grant: GrantTarget,
  request: GrantTarget,
  options: { allRecipients?: boolean } = {}
): boolean {
  const constraints = Object.entries(grant).filter(([, value]) =>
    Array.isArray(value) ? value.length > 0 : typeof value === "string" && value !== ""
  );
  if (constraints.length === 0) return false;

  for (const [key, value] of constraints) {
    if (Array.isArray(value)) {
      const asked = key === "recipients" ? (request.recipients ?? []) : [];
      if (asked.length === 0) return false;
      if (options.allRecipients === true) {
        if (!asked.every((entry) => value.includes(entry))) return false;
      } else if (!asked.some((entry) => value.includes(entry))) {
        return false;
      }
    } else if (request[key as keyof GrantTarget] !== value) {
      return false;
    }
  }
  return true;
}

export type TargetProblem = { ok: true } | { ok: false; message: string };

/** Enforce what a scope's target must name. Called on grant creation. */
export function validateTarget(scope: string, target: GrantTarget): TargetProblem {
  const cap = SCOPE_CAPS[scope];
  if (cap === undefined) {
    return { ok: false, message: `${scope} cannot be granted` };
  }
  switch (cap.requires) {
    case "recipients-or-device":
      if ((target.recipients?.length ?? 0) === 0 && target.device_id === undefined) {
        return {
          ok: false,
          message: `${scope} must name the recipients or the device it applies to`,
        };
      }
      return { ok: true };
    case "device":
      return target.device_id === undefined
        ? { ok: false, message: `${scope} must name one device` }
        : { ok: true };
    case "flow":
      return target.flow_id === undefined
        ? { ok: false, message: `${scope} must name one flow` }
        : { ok: true };
    case "rule":
      return target.rule_id === undefined && target.flow_id === undefined
        ? { ok: false, message: `${scope} must name one rule or flow` }
        : { ok: true };
    case null:
      return { ok: true };
    default:
      return { ok: false, message: `${scope} has no target rule` };
  }
}

/* ─────────────────────────────── the ladder ─────────────────────────────── */

export interface ClampedDuration {
  /** What will actually be granted, in seconds. */
  seconds: number;
  /** What was asked for, unchanged, so the response can say so. */
  requested_s: number;
  /** True when the ceiling or the ladder moved the number. */
  clamped: boolean;
  /** The scope's ceiling, for the message. */
  max_s: number;
}

/**
 * Snap a requested duration onto the ladder, then apply the scope's ceiling.
 *
 * Two different corrections, deliberately in this order: the ladder answers
 * "you asked for 12 minutes, the nearest choice is 15", and the ceiling answers
 * "you asked for 30 days of production SMS, you may have one hour". A response
 * that is `clamped` names both numbers, because silently shortening a grant is
 * the kind of surprise that teaches an operator to distrust the tool.
 */
export function clampGrantDuration(scope: string, requestedSeconds: number): ClampedDuration | null {
  const cap = SCOPE_CAPS[scope];
  if (cap === undefined) return null;

  const requested = Number.isFinite(requestedSeconds) ? Math.max(1, Math.trunc(requestedSeconds)) : 60;

  let nearest = GRANT_LADDER_S[0];
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const rung of GRANT_LADDER_S) {
    const delta = Math.abs(rung - requested);
    // Ties go to the SHORTER rung: an ambiguous request should never buy more
    // authority than the number it named.
    if (delta < bestDelta || (delta === bestDelta && rung < nearest)) {
      nearest = rung;
      bestDelta = delta;
    }
  }

  const seconds = Math.min(nearest, cap.max_ttl_s);
  return {
    seconds,
    requested_s: requested,
    clamped: seconds !== requested,
    max_s: cap.max_ttl_s,
  };
}

/* ─────────────────────────────── grants ─────────────────────────────── */

function toGrant(row: GrantRow): GrantRecord {
  return {
    id: row.id,
    agent_token_id: row.agent_token_id,
    scope: row.scope,
    target: parseTargetJson(row.target_json),
    granted_by: row.granted_by,
    granted_at: row.granted_at,
    expires_at: row.expires_at,
    revoked_at: row.revoked_at,
    use_count: row.use_count,
    last_used_at: row.last_used_at,
    approval_request_id: row.approval_request_id,
  };
}

const GRANT_COLUMNS = `id, agent_token_id, scope, target_json, granted_by, granted_at,
                       expires_at, revoked_at, use_count, last_used_at, approval_request_id`;

export interface CreateGrantInput {
  agentTokenId: string;
  scope: string;
  target: GrantTarget;
  grantedBy: string;
  /** Already clamped by `clampGrantDuration`; this does not clamp again. */
  durationS: number;
  approvalRequestId?: string | null;
  now?: number;
}

export type CreateGrantResult =
  | { ok: true; grant: GrantRecord }
  | { ok: false; error: "unknown_scope" | "not_grantable" | "bad_target"; message: string };

/**
 * Create a grant, superseding any live one for the same (token, scope, target).
 *
 * Supersede-instead-of-stack is what stops an agent accumulating authority by
 * asking repeatedly: the partial unique index would reject a second live row
 * anyway, and revoking the old one first makes the operator's newest decision the
 * one that counts rather than producing a constraint error mid-approval.
 */
export async function createGrant(env: Env, input: CreateGrantInput): Promise<CreateGrantResult> {
  const never = NEVER_GRANTABLE[input.scope];
  if (never !== undefined) {
    return { ok: false, error: "not_grantable", message: `${input.scope}: ${never}` };
  }
  if (!isTokenScope(input.scope) || SCOPE_CAPS[input.scope] === undefined) {
    return { ok: false, error: "unknown_scope", message: `${input.scope} cannot be granted` };
  }
  const targetCheck = validateTarget(input.scope, input.target);
  if (!targetCheck.ok) {
    return { ok: false, error: "bad_target", message: targetCheck.message };
  }

  const now = input.now ?? Date.now();
  const targetJson = canonicalTargetJson(input.target);
  const expiresAt = now + input.durationS * 1_000;
  const id = crypto.randomUUID();

  await env.DB.batch([
    // Revoke the superseded grant first: the partial unique index only allows one
    // live row per (token, scope, target), so this must land before the insert.
    env.DB.prepare(
      `UPDATE authority_grants SET revoked_at = ?
        WHERE agent_token_id = ? AND scope = ? AND target_json = ? AND revoked_at IS NULL`
    ).bind(now, input.agentTokenId, input.scope, targetJson),
    env.DB.prepare(
      `INSERT INTO authority_grants
         (id, agent_token_id, scope, target_json, granted_by, granted_at, expires_at,
          use_count, approval_request_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
    ).bind(
      id,
      input.agentTokenId,
      input.scope,
      targetJson,
      input.grantedBy,
      now,
      expiresAt,
      input.approvalRequestId ?? null
    ),
  ]);

  return {
    ok: true,
    grant: {
      id,
      agent_token_id: input.agentTokenId,
      scope: input.scope,
      target: parseTargetJson(targetJson),
      granted_by: input.grantedBy,
      granted_at: now,
      expires_at: expiresAt,
      revoked_at: null,
      use_count: 0,
      last_used_at: null,
      approval_request_id: input.approvalRequestId ?? null,
    },
  };
}

/**
 * Find a live grant that covers this request, or `null`.
 *
 * The SQL narrows by (token, scope) and deadline; the JS match does the target,
 * because target equivalence is a structural question SQLite cannot answer on a
 * JSON column without a JSON1 extension this database does not promise.
 */
export async function findLiveGrant(
  env: Env,
  tokenId: string,
  scope: string,
  request: GrantTarget,
  options: { allRecipients?: boolean; now?: number } = {}
): Promise<GrantRecord | null> {
  const now = options.now ?? Date.now();
  const rows = await env.DB.prepare(
    `SELECT ${GRANT_COLUMNS} FROM authority_grants
      WHERE agent_token_id = ? AND scope = ? AND revoked_at IS NULL AND expires_at > ?
      ORDER BY expires_at DESC
      LIMIT 50`
  )
    .bind(tokenId, scope, now)
    .all<GrantRow>();

  for (const row of rows.results ?? []) {
    const grant = toGrant(row);
    if (targetMatches(grant.target, request, { allRecipients: options.allRecipients === true })) {
      return grant;
    }
  }
  return null;
}

/**
 * Spend one use of a live grant.
 *
 * One conditional UPDATE, so a grant that expired between the lookup and the
 * send cannot be used: `meta.changes === 0` is the refusal, and it is decided by
 * the same statement that would have counted the use.
 */
export async function consumeGrantUse(
  env: Env,
  grantId: string,
  now = Date.now()
): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE authority_grants
        SET use_count = use_count + 1, last_used_at = ?
      WHERE id = ? AND revoked_at IS NULL AND expires_at > ?`
  )
    .bind(now, grantId, now)
    .run();
  return Number(result.meta?.changes ?? 0) > 0;
}

export async function revokeGrant(
  env: Env,
  grantId: string,
  now = Date.now()
): Promise<GrantRecord | null> {
  const result = await env.DB.prepare(
    `UPDATE authority_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`
  )
    .bind(now, grantId)
    .run();
  if (Number(result.meta?.changes ?? 0) === 0) return null;
  const row = await env.DB.prepare(
    `SELECT ${GRANT_COLUMNS} FROM authority_grants WHERE id = ?`
  )
    .bind(grantId)
    .first<GrantRow>();
  return row === null ? null : toGrant(row);
}

export async function listGrants(
  env: Env,
  options: { tokenId?: string; liveOnly?: boolean; now?: number } = {}
): Promise<GrantRecord[]> {
  const now = options.now ?? Date.now();
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.tokenId !== undefined) {
    clauses.push("agent_token_id = ?");
    params.push(options.tokenId);
  }
  if (options.liveOnly === true) {
    clauses.push("revoked_at IS NULL AND expires_at > ?");
    params.push(now);
  }
  const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
  const rows = await env.DB.prepare(
    `SELECT ${GRANT_COLUMNS} FROM authority_grants ${where}
      ORDER BY granted_at DESC LIMIT ${MAX_LIST_ROWS}`
  )
    .bind(...params)
    .all<GrantRow>();
  return (rows.results ?? []).map(toGrant);
}

/* ────────────────────────── approval requests ────────────────────────── */

const APPROVAL_COLUMNS = `id, agent_token_id, scope, target_json, reason, state,
                          requested_at, expires_at, decided_by, decided_at, grant_id`;

function toApproval(row: ApprovalRow): ApprovalRecord {
  return {
    id: row.id,
    agent_token_id: row.agent_token_id,
    scope: row.scope,
    target: parseTargetJson(row.target_json),
    reason: row.reason,
    state: row.state,
    requested_at: row.requested_at,
    expires_at: row.expires_at,
    decided_by: row.decided_by,
    decided_at: row.decided_at,
    grant_id: row.grant_id,
  };
}

export interface RequestApprovalInput {
  agentTokenId: string;
  scope: string;
  target: GrantTarget;
  reason?: string | null;
  now?: number;
}

/**
 * Open an approval request, or return the one already open for this ask.
 *
 * The uniqueness key is (token, scope, target): an agent retrying its send gets
 * the SAME request back, so a retry loop cannot turn into a notification flood
 * for the operator. A stale PENDING row past its deadline is expired first, so a
 * request that timed out does not swallow the next attempt.
 */
export async function requestApproval(
  env: Env,
  input: RequestApprovalInput
): Promise<ApprovalRecord> {
  const now = input.now ?? Date.now();
  const targetJson = canonicalTargetJson(input.target);

  // Expire what should already be dead, then look for a live one.
  await env.DB.prepare(
    `UPDATE approval_requests SET state = 'EXPIRED'
      WHERE agent_token_id = ? AND scope = ? AND target_json = ?
        AND state = 'PENDING' AND expires_at <= ?`
  )
    .bind(input.agentTokenId, input.scope, targetJson, now)
    .run();

  const existing = await env.DB.prepare(
    `SELECT ${APPROVAL_COLUMNS} FROM approval_requests
      WHERE agent_token_id = ? AND scope = ? AND target_json = ? AND state = 'PENDING'
      LIMIT 1`
  )
    .bind(input.agentTokenId, input.scope, targetJson)
    .first<ApprovalRow>();
  if (existing !== null) return toApproval(existing);

  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(
      `INSERT INTO approval_requests
         (id, agent_token_id, scope, target_json, reason, state, requested_at, expires_at)
       VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?)`
    )
      .bind(
        id,
        input.agentTokenId,
        input.scope,
        targetJson,
        input.reason ?? null,
        now,
        now + APPROVAL_TTL_MS
      )
      .run();
  } catch (error) {
    // The partial unique index rejected a concurrent insert, which means another
    // request landed first. Its row is the answer.
    const raced = await env.DB.prepare(
      `SELECT ${APPROVAL_COLUMNS} FROM approval_requests
        WHERE agent_token_id = ? AND scope = ? AND target_json = ? AND state = 'PENDING'
        LIMIT 1`
    )
      .bind(input.agentTokenId, input.scope, targetJson)
      .first<ApprovalRow>();
    if (raced !== null) return toApproval(raced);
    throw error;
  }

  return {
    id,
    agent_token_id: input.agentTokenId,
    scope: input.scope,
    target: parseTargetJson(targetJson),
    reason: input.reason ?? null,
    state: "PENDING",
    requested_at: now,
    expires_at: now + APPROVAL_TTL_MS,
    decided_by: null,
    decided_at: null,
    grant_id: null,
  };
}

export async function getApproval(env: Env, id: string): Promise<ApprovalRecord | null> {
  const row = await env.DB.prepare(
    `SELECT ${APPROVAL_COLUMNS} FROM approval_requests WHERE id = ?`
  )
    .bind(id)
    .first<ApprovalRow>();
  return row === null ? null : toApproval(row);
}

export async function listApprovals(
  env: Env,
  options: { state?: string; now?: number } = {}
): Promise<ApprovalRecord[]> {
  const now = options.now ?? Date.now();
  if (options.state === "PENDING") {
    const rows = await env.DB.prepare(
      `SELECT ${APPROVAL_COLUMNS} FROM approval_requests
        WHERE state = 'PENDING' AND expires_at > ?
        ORDER BY requested_at DESC LIMIT ${MAX_LIST_ROWS}`
    )
      .bind(now)
      .all<ApprovalRow>();
    return (rows.results ?? []).map(toApproval);
  }
  const rows = await env.DB.prepare(
    `SELECT ${APPROVAL_COLUMNS} FROM approval_requests
      ORDER BY requested_at DESC LIMIT ${MAX_LIST_ROWS}`
  ).all<ApprovalRow>();
  return (rows.results ?? []).map(toApproval);
}

export type DecisionResult =
  | { ok: true; approval: ApprovalRecord; grant: GrantRecord | null; clamped: ClampedDuration | null }
  | { ok: false; error: "not_found" | "not_pending" | "expired" | "bad_target" | "not_grantable"; message: string };

/**
 * Answer a request: approve it (which mints a grant) or reject it.
 *
 * The duration is clamped HERE rather than trusted from the request, so the
 * ceiling is applied by the side that has the table, not by the side that asked.
 */
export async function decideApproval(
  env: Env,
  id: string,
  decision: "approve" | "reject",
  options: { by: string; durationS?: number; now?: number }
): Promise<DecisionResult> {
  const now = options.now ?? Date.now();
  const approval = await getApproval(env, id);
  if (approval === null) {
    return { ok: false, error: "not_found", message: `no approval request ${id}` };
  }
  if (approval.state !== "PENDING") {
    return { ok: false, error: "not_pending", message: `request is already ${approval.state}` };
  }
  if (approval.expires_at <= now) {
    await env.DB.prepare(
      `UPDATE approval_requests SET state = 'EXPIRED' WHERE id = ? AND state = 'PENDING'`
    )
      .bind(id)
      .run();
    return { ok: false, error: "expired", message: "request expired before it was answered" };
  }

  if (decision === "reject") {
    await env.DB.prepare(
      `UPDATE approval_requests SET state = 'REJECTED', decided_by = ?, decided_at = ?
        WHERE id = ? AND state = 'PENDING'`
    )
      .bind(options.by, now, id)
      .run();
    const updated = await getApproval(env, id);
    return { ok: true, approval: updated ?? approval, grant: null, clamped: null };
  }

  const clamped = clampGrantDuration(approval.scope, options.durationS ?? 900);
  if (clamped === null) {
    return {
      ok: false,
      error: "not_grantable",
      message: `${approval.scope} cannot be granted`,
    };
  }

  const created = await createGrant(env, {
    agentTokenId: approval.agent_token_id,
    scope: approval.scope,
    target: approval.target,
    grantedBy: options.by,
    durationS: clamped.seconds,
    approvalRequestId: approval.id,
    now,
  });
  if (!created.ok) {
    return {
      ok: false,
      error: created.error === "bad_target" ? "bad_target" : "not_grantable",
      message: created.message,
    };
  }

  await env.DB.prepare(
    `UPDATE approval_requests SET state = 'APPROVED', decided_by = ?, decided_at = ?, grant_id = ?
      WHERE id = ? AND state = 'PENDING'`
  )
    .bind(options.by, now, created.grant.id, id)
    .run();

  const updated = await getApproval(env, id);
  return { ok: true, approval: updated ?? approval, grant: created.grant, clamped };
}
