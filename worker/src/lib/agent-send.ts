/**
 * The send gate for agent tokens.
 *
 * A person sending from the console or the CLI is authenticated by a session or
 * the admin token and is trusted to mean it. An agent is not: it is an LLM with
 * a prompt, and a prompt can be talked into a loop that spends real money on
 * real SMS. So an agent send has to clear three things, in this order, and the
 * order is deliberate:
 *
 *   1. TARGET. The token may be bound to one handset, and the request must use
 *      it. A fleet-wide token's device is decided by its grant.
 *   2. GRANT. A live `sms:send:production` grant whose target covers these
 *      recipients, spent with one conditional UPDATE so a window that closed
 *      between the lookup and the send cannot be used.
 *   3. BUDGET. The token's fixed hourly window, spent with one conditional
 *      UPDATE for the same reason.
 *
 * No grant is not a refusal: it is an approval REQUEST, which the operator
 * answers with a duration. That is the whole design — the agent is told what a
 * human has to decide, instead of given an error it can retry around.
 */

import type { Env } from "../index";
import {
  consumeGrantUse,
  findLiveGrant,
  requestApproval,
  type ApprovalRecord,
  type GrantRecord,
} from "./authority";
import { consumeSendQuota, peekSendQuota } from "./agent-tokens";
import { GRANT_LADDER_S, SCOPE_CAPS } from "./agent-scopes";

/** The grant scope every send is checked against. There is no unsandboxed path. */
export const SEND_GRANT_SCOPE = "sms:send:production";

export interface AgentSendIdentity {
  tokenId: string;
  /** The handset this token is bound to, or null for fleet-wide. */
  boundDeviceId: string | null;
}

export interface AgentSendRequest {
  deviceId: string;
  /** Every number this call would transmit to. */
  recipients: string[];
  /** A batch requires the grant to cover ALL of them, not just one. */
  allRecipients: boolean;
  reason?: string;
}

export type AgentSendAuthority =
  | { ok: true; grant: GrantRecord }
  | { ok: false; kind: "approval"; approval: ApprovalRecord }
  | { ok: false; kind: "quota"; used: number; limit: number; resets_at: number }
  | { ok: false; kind: "device_mismatch"; boundDeviceId: string };

export async function authorizeAgentSend(
  env: Env,
  identity: AgentSendIdentity,
  request: AgentSendRequest
): Promise<AgentSendAuthority> {
  if (identity.boundDeviceId !== null && identity.boundDeviceId !== request.deviceId) {
    return { ok: false, kind: "device_mismatch", boundDeviceId: identity.boundDeviceId };
  }

  const target = {
    recipients: request.recipients,
    device_id: request.deviceId,
  };

  const grant = await findLiveGrant(env, identity.tokenId, SEND_GRANT_SCOPE, target, {
    allRecipients: request.allRecipients,
  });
  if (grant === null) {
    const approval = await requestApproval(env, {
      agentTokenId: identity.tokenId,
      scope: SEND_GRANT_SCOPE,
      target,
      reason: request.reason ?? null,
    });
    return { ok: false, kind: "approval", approval };
  }

  // Budget peek before the grant is spent: an approval request must not draw on
  // the hour's allowance, and a send refused for budget must not inflate
  // `use_count`. The authoritative spend below re-checks the same condition.
  const peek = await peekSendQuota(env, identity.tokenId);
  if (!peek.ok) {
    return {
      ok: false,
      kind: "quota",
      used: peek.used,
      limit: peek.limit,
      resets_at: peek.resets_at,
    };
  }

  // The lookup said yes; the update is the authority. A grant revoked or expired
  // in between loses here, and the caller turns that into a fresh request rather
  // than a send.
  const spent = await consumeGrantUse(env, grant.id);
  if (!spent) {
    const approval = await requestApproval(env, {
      agentTokenId: identity.tokenId,
      scope: SEND_GRANT_SCOPE,
      target,
      reason: request.reason ?? null,
    });
    return { ok: false, kind: "approval", approval };
  }

  // The spend is the authority. It can lose to a concurrent request that took the
  // last slot between the peek and here, and then the send does not happen.
  const quota = await consumeSendQuota(env, identity.tokenId);
  if (!quota.ok) {
    return {
      ok: false,
      kind: "quota",
      used: quota.used,
      limit: quota.limit,
      resets_at: quota.resets_at,
    };
  }

  return { ok: true, grant };
}

/**
 * The 202 an agent receives instead of a send.
 *
 * `sent: false` is stated rather than implied: an agent reading this must not
 * conclude the SMS went out, and `verification`-style honesty about what did and
 * did not happen is this repo's habit for a reason.
 */
export function approvalResponse(approval: ApprovalRecord): Response {
  const cap = SCOPE_CAPS[approval.scope];
  return Response.json(
    {
      error: "approval_required",
      sent: false,
      state: "PENDING",
      approval_request: {
        id: approval.id,
        scope: approval.scope,
        target: approval.target,
        requested_at: approval.requested_at,
        expires_at: approval.expires_at,
        ladder_s: GRANT_LADDER_S,
        max_s: cap?.max_ttl_s ?? null,
      },
      next: `a human must approve this: dakflare auth approve ${approval.id} --for <duration>`,
    },
    { status: 202 }
  );
}

/** The 429 an agent receives when its own hour is spent. */
export function quotaResponse(quota: {
  used: number;
  limit: number;
  resets_at: number;
}): Response {
  return Response.json(
    {
      error: "agent_quota_exceeded",
      message: `this agent token may send ${quota.limit} SMS per hour; it has sent ${quota.used}`,
      used: quota.used,
      limit: quota.limit,
      resets_at: quota.resets_at,
      retryable: true,
    },
    { status: 429 }
  );
}

export type AgentSendEnforcement =
  | { ok: true; grantId: string | null }
  | { ok: false; response: Response };

/**
 * One call the send routes can make: either "carry on with this grant id" or
 * "here is the response".
 *
 * A human caller (no agent token) passes straight through with `grantId: null`,
 * so the routes keep one code path and the agent rule lives in one place.
 */
export async function enforceAgentSend(
  env: Env,
  actor: { agentTokenId?: string; agentDeviceId?: string | null } | undefined,
  request: AgentSendRequest
): Promise<AgentSendEnforcement> {
  if (actor?.agentTokenId === undefined) return { ok: true, grantId: null };

  const authority = await authorizeAgentSend(
    env,
    { tokenId: actor.agentTokenId, boundDeviceId: actor.agentDeviceId ?? null },
    request
  );

  if (authority.ok) return { ok: true, grantId: authority.grant.id };
  if (authority.kind === "approval") {
    return { ok: false, response: approvalResponse(authority.approval) };
  }
  if (authority.kind === "quota") {
    return { ok: false, response: quotaResponse(authority) };
  }
  return {
    ok: false,
    response: Response.json(
      {
        error: "forbidden",
        message: `this agent token is bound to ${authority.boundDeviceId}`,
      },
      { status: 403 }
    ),
  };
}
