/**
 * Approval requests and authority grants — the human side of the control plane.
 *
 * Answering a request is the ONLY way a grant is created, and a grant is the only
 * thing that lets an agent do something that costs money or interrupts traffic.
 * So this file is where the blast radius is decided, and it decides it twice:
 *
 *   `clampGrantDuration` is applied here rather than trusted from the request,
 *   and `validateTarget` runs again when the grant is minted, so a request that
 *   was stored with a stale or malformed target cannot become a wildcard.
 *
 * All five routes are human-only: they are absent from `SCOPE_FOR_ACTION`, so an
 * agent token cannot approve its own request. That is the whole point.
 */

import type { Env } from "../index";
import type { AdminActor } from "../audit";
import { requestMeta, writeAudit } from "../audit";
import { err } from "../lib/errors";
import { readJsonBoundedResult } from "../lib/body";
import { MAX_BODY_BYTES } from "../lib/config";
import { GRANT_LADDER_S, SCOPE_CAPS } from "../lib/agent-scopes";
import {
  decideApproval,
  listApprovals,
  listGrants,
  revokeGrant,
  type ApprovalRecord,
  type GrantRecord,
} from "../lib/authority";
import { AUTHORITY_GUARD_OBJECT_NAME } from "../authority-guard";

/** What an approver needs to render the menu, without a second call. */
function describeApproval(approval: ApprovalRecord): Record<string, unknown> {
  const cap = SCOPE_CAPS[approval.scope];
  return {
    id: approval.id,
    agent_token_id: approval.agent_token_id,
    scope: approval.scope,
    target: approval.target,
    reason: approval.reason,
    state: approval.state,
    requested_at: approval.requested_at,
    expires_at: approval.expires_at,
    decided_by: approval.decided_by,
    decided_at: approval.decided_at,
    grant_id: approval.grant_id,
    // The ladder the operator may pick from, and the ceiling this scope will
    // actually honour. Both, because they are different numbers on purpose.
    ladder_s: GRANT_LADDER_S,
    max_s: cap?.max_ttl_s ?? null,
  };
}

function describeGrant(grant: GrantRecord, now = Date.now()): Record<string, unknown> {
  return {
    id: grant.id,
    agent_token_id: grant.agent_token_id,
    scope: grant.scope,
    target: grant.target,
    granted_by: grant.granted_by,
    granted_at: grant.granted_at,
    expires_at: grant.expires_at,
    live: grant.revoked_at === null && grant.expires_at > now,
    revoked_at: grant.revoked_at,
    use_count: grant.use_count,
    last_used_at: grant.last_used_at,
    approval_request_id: grant.approval_request_id,
  };
}

/** `GET /v1/admin/approvals[?state=PENDING]` */
export async function handleApprovalsList(env: Env, url: URL): Promise<Response> {
  const state = url.searchParams.get("state") ?? undefined;
  const approvals = await listApprovals(env, state === undefined ? {} : { state });
  return Response.json({ approvals: approvals.map(describeApproval) });
}

/** `GET /v1/admin/grants[?live=1][&token=<id>]` */
export async function handleGrantsList(env: Env, url: URL): Promise<Response> {
  const tokenId = url.searchParams.get("token") ?? undefined;
  const liveOnly = url.searchParams.get("live") === "1";
  const grants = await listGrants(env, {
    ...(tokenId === undefined ? {} : { tokenId }),
    liveOnly,
  });
  const now = Date.now();
  return Response.json({ grants: grants.map((grant) => describeGrant(grant, now)) });
}

/**
 * `POST /v1/admin/approvals/:id/approve` — `{ duration_s }`.
 *
 * The response names what was ASKED for and what was GRANTED whenever the two
 * differ, so a 30-day request that became a one-hour grant says so instead of
 * leaving the operator to notice later.
 */
export async function handleApprovalApprove(
  req: Request,
  env: Env,
  id: string,
  actor: AdminActor
): Promise<Response> {
  const parsed = await readJsonBoundedResult(req, MAX_BODY_BYTES);
  if (!parsed.ok) return err(parsed.reason);
  const input = parsed.value;

  const raw = input.duration_s;
  const durationS =
    raw === undefined || raw === null
      ? 900
      : typeof raw === "number" && Number.isFinite(raw)
        ? Math.trunc(raw)
        : Number.NaN;
  if (!Number.isFinite(durationS)) return err("bad_request", 400);

  const decided = await decideApproval(env, id, "approve", {
    by: actor.label,
    durationS,
  });
  if (!decided.ok) {
    const status = decided.error === "not_found" ? 404 : decided.error === "not_pending" ? 409 : 400;
    return Response.json({ error: decided.error, message: decided.message }, { status });
  }

  if (decided.grant !== null) await armGrantExpiry(env, decided.grant);

  await writeAudit(env, {
    action: "authority.granted",
    actor: { userId: actor.userId, label: actor.label },
    subject: decided.approval.agent_token_id,
    detail: {
      approval_request_id: id,
      grant_id: decided.grant?.id ?? null,
      scope: decided.approval.scope,
      target: decided.approval.target,
      granted_s: decided.clamped?.seconds ?? null,
      requested_s: decided.clamped?.requested_s ?? null,
      clamped: decided.clamped?.clamped ?? false,
      expires_at: decided.grant?.expires_at ?? null,
    },
    ...requestMeta(req),
  });

  return Response.json({
    ok: true,
    approval: describeApproval(decided.approval),
    // What was granted, not only for how long.
    scope: decided.approval.scope,
    target: decided.approval.target,
    grant: decided.grant === null ? null : describeGrant(decided.grant),
    granted_s: decided.clamped?.seconds ?? null,
    requested_s: decided.clamped?.requested_s ?? null,
    clamped: decided.clamped?.clamped ?? false,
    max_s: decided.clamped?.max_s ?? null,
  });
}

/** `POST /v1/admin/approvals/:id/reject` */
export async function handleApprovalReject(
  req: Request,
  env: Env,
  id: string,
  actor: AdminActor
): Promise<Response> {
  const decided = await decideApproval(env, id, "reject", { by: actor.label });
  if (!decided.ok) {
    const status = decided.error === "not_found" ? 404 : decided.error === "not_pending" ? 409 : 400;
    return Response.json({ error: decided.error, message: decided.message }, { status });
  }

  await writeAudit(env, {
    action: "authority.rejected",
    actor: { userId: actor.userId, label: actor.label },
    subject: decided.approval.agent_token_id,
    detail: { approval_request_id: id, scope: decided.approval.scope },
    ...requestMeta(req),
  });

  return Response.json({ ok: true, approval: describeApproval(decided.approval) });
}

/** `DELETE /v1/admin/grants/:id` — takes effect on the next request. */
export async function handleGrantRevoke(
  req: Request,
  env: Env,
  id: string,
  actor: AdminActor
): Promise<Response> {
  const grant = await revokeGrant(env, id);
  if (grant === null) {
    return Response.json({ error: "not_found", message: `no live grant ${id}` }, { status: 404 });
  }
  await cancelGrantExpiry(env, grant.id);

  await writeAudit(env, {
    action: "authority.revoked",
    actor: { userId: actor.userId, label: actor.label },
    subject: grant.agent_token_id,
    detail: {
      grant_id: grant.id,
      scope: grant.scope,
      target: grant.target,
      used: grant.use_count,
    },
    ...requestMeta(req),
  });

  return Response.json({ ok: true, grant: describeGrant(grant) });
}

/**
 * Arm the Durable Object timer for a grant.
 *
 * Best-effort on purpose: D1 refuses an expired grant with or without this timer,
 * so a failed schedule costs an audit row, never a second of extra authority.
 */
export async function armGrantExpiry(env: Env, grant: GrantRecord): Promise<void> {
  const namespace = env.AUTHORITY_GUARD;
  if (namespace === undefined) return;
  try {
    const stub = namespace.get(namespace.idFromName(AUTHORITY_GUARD_OBJECT_NAME));
    await stub.schedule(grant.id, grant.scope, grant.agent_token_id, grant.expires_at);
  } catch (error) {
    console.error(`[authority] could not arm expiry for ${grant.id}: ${String(error)}`);
  }
}

async function cancelGrantExpiry(env: Env, grantId: string): Promise<void> {
  const namespace = env.AUTHORITY_GUARD;
  if (namespace === undefined) return;
  try {
    const stub = namespace.get(namespace.idFromName(AUTHORITY_GUARD_OBJECT_NAME));
    await stub.cancel(grantId);
  } catch (error) {
    console.error(`[authority] could not cancel expiry for ${grantId}: ${String(error)}`);
  }
}
