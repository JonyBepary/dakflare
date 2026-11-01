/**
 * Approvals for the handset.
 *
 * A phone that holds the SIM is the party who can see whether sending is safe:
 * credit, signal, whether the number is correct. Making it walk to a laptop to
 * approve is the difference between a control plane an operator uses and one they
 * route around.
 *
 * So these three routes are DEVICE-authenticated, not admin-authenticated. The
 * authorisation rule is narrow and visible: a device may only answer a request
 * whose target names THAT device. A request with no device in its target is
 * fleet-wide and stays an operator decision, because a handset answering for the
 * whole fleet is exactly the unbounded authority this layer exists to prevent.
 */

import type { Env } from "../index";
import { requestMeta, writeAudit } from "../audit";
import { err } from "../lib/errors";

import { GRANT_LADDER_S, SCOPE_CAPS } from "../lib/agent-scopes";
import {
  decideApproval,
  listApprovals,
  parseTargetJson,
  type ApprovalRecord,
} from "../lib/authority";
import { armGrantExpiry } from "./approvals";

interface ApprovalRow {
  id: string;
  agent_token_id: string;
  scope: string;
  target_json: string;
  reason: string | null;
  state: string;
  requested_at: number;
  expires_at: number;
}

/** `GET /v1/device/approvals` — what this handset is being asked to allow. */
export async function handleDeviceApprovals(env: Env, deviceId: string): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT id, agent_token_id, scope, target_json, reason, state, requested_at, expires_at
       FROM approval_requests
      WHERE state = 'PENDING' AND expires_at > ?
      ORDER BY requested_at ASC
      LIMIT 50`
  )
    .bind(Date.now())
    .all<ApprovalRow>();

  const mine = (rows.results ?? []).filter((row) => {
    const target = parseTargetJson(row.target_json);
    return target.device_id === deviceId;
  });

  return Response.json({
    device_id: deviceId,
    approvals: mine.map((row) => {
      const cap = SCOPE_CAPS[row.scope];
      return {
        id: row.id,
        scope: row.scope,
        target: parseTargetJson(row.target_json),
        reason: row.reason,
        requested_at: row.requested_at,
        expires_at: row.expires_at,
        // The same ladder the console offers and the CLI accepts, sent with the
        // request so the sheet cannot drift from the policy.
        ladder_s: GRANT_LADDER_S,
        max_s: cap?.max_ttl_s ?? null,
      };
    }),
  });
}

/**
 * `POST /v1/device/approvals/:id/approve` — `{ duration_s }`.
 *
 * The duration is clamped by the same `decideApproval` the console uses, so a
 * handset cannot grant more than a browser can.
 */
export async function handleDeviceApprovalApprove(
  bodyText: string,
  env: Env,
  deviceId: string,
  rawId: string,
  meta: { ip: string | null; userAgent: string | null } = { ip: null, userAgent: null }
): Promise<Response> {
  const owner = await ownerOf(env, rawId, deviceId);
  if (owner === "not_found") return Response.json({ error: "not_found" }, { status: 404 });
  if (owner === "not_this_device") {
    return Response.json(
      { error: "forbidden", message: "this request is not for this handset" },
      { status: 403 }
    );
  }

  // The body is already read: `withDevice` consumed it to verify the signature and
  // hands it here as text. Re-reading `req` would throw, and a 500 on the only
  // route a handset has is worse than a 400.
  let input: Record<string, unknown> = {};
  if (bodyText.trim() !== "") {
    try {
      const parsed: unknown = JSON.parse(bodyText);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return err("bad_request", 400);
      }
      input = parsed as Record<string, unknown>;
    } catch {
      return err("bad_request", 400);
    }
  }
  const raw = input.duration_s;
  const durationS =
    raw === undefined || raw === null
      ? 900
      : typeof raw === "number" && Number.isFinite(raw)
        ? Math.trunc(raw)
        : Number.NaN;
  if (!Number.isFinite(durationS)) return err("bad_request", 400);

  const decided = await decideApproval(env, rawId, "approve", {
    by: `device:${deviceId}`,
    durationS,
  });
  if (!decided.ok) {
    const status = decided.error === "not_found" ? 404 : decided.error === "not_pending" ? 409 : 400;
    return Response.json({ error: decided.error, message: decided.message }, { status });
  }

  if (decided.grant !== null) await armGrantExpiry(env, decided.grant);

  await writeAudit(env, {
    action: "authority.granted",
    actor: { userId: null, label: `device:${deviceId}` },
    subject: decided.approval.agent_token_id,
    detail: {
      approval_request_id: rawId,
      grant_id: decided.grant?.id ?? null,
      scope: decided.approval.scope,
      granted_s: decided.clamped?.seconds ?? null,
      requested_s: decided.clamped?.requested_s ?? null,
      clamped: decided.clamped?.clamped ?? false,
      via: "handset",
    },
    ...meta,
  });

  return Response.json({
    ok: true,
    approval_id: rawId,
    // Repeat what was granted, not just for how long: a confirmation that names
    // only the duration cannot say which recipients an agent just acquired the
    // right to message.
    scope: decided.approval.scope,
    target: decided.approval.target,
    granted_s: decided.clamped?.seconds ?? null,
    requested_s: decided.clamped?.requested_s ?? null,
    clamped: decided.clamped?.clamped ?? false,
    max_s: decided.clamped?.max_s ?? null,
    expires_at: decided.grant?.expires_at ?? null,
  });
}

/** `POST /v1/device/approvals/:id/reject` */
export async function handleDeviceApprovalReject(
  env: Env,
  deviceId: string,
  rawId: string,
  meta: { ip: string | null; userAgent: string | null } = { ip: null, userAgent: null }
): Promise<Response> {
  const owner = await ownerOf(env, rawId, deviceId);
  if (owner === "not_found") return Response.json({ error: "not_found" }, { status: 404 });
  if (owner === "not_this_device") {
    return Response.json(
      { error: "forbidden", message: "this request is not for this handset" },
      { status: 403 }
    );
  }

  const decided = await decideApproval(env, rawId, "reject", { by: `device:${deviceId}` });
  if (!decided.ok) {
    const status = decided.error === "not_found" ? 404 : decided.error === "not_pending" ? 409 : 400;
    return Response.json({ error: decided.error, message: decided.message }, { status });
  }

  await writeAudit(env, {
    action: "authority.rejected",
    actor: { userId: null, label: `device:${deviceId}` },
    subject: decided.approval.agent_token_id,
    detail: { approval_request_id: rawId, scope: decided.approval.scope, via: "handset" },
    ...meta,
  });

  return Response.json({ ok: true, approval_id: rawId, state: decided.approval.state });
}

/**
 * Who may answer this request.
 *
 * `not_found` and `not_this_device` are separate answers on purpose: a handset
 * learning that an id exists but belongs elsewhere is a small leak, and a handset
 * being told "not found" for its own request would be a bug it cannot report.
 */
async function ownerOf(
  env: Env,
  id: string,
  deviceId: string
): Promise<"ok" | "not_found" | "not_this_device"> {
  const row = await env.DB.prepare(
    `SELECT target_json FROM approval_requests WHERE id = ?`
  )
    .bind(id)
    .first<{ target_json: string }>();
  if (row === null) return "not_found";
  const target = parseTargetJson(row.target_json);
  return target.device_id === deviceId ? "ok" : "not_this_device";
}

/** Exported for the route table's type; unused elsewhere. */
export type { ApprovalRecord };
