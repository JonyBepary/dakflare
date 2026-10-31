/**
 * Agent token administration — mint, list, revoke.
 *
 * These three routes are HUMAN-ONLY by construction: they are absent from
 * `SCOPE_FOR_ACTION`, so an agent token that reaches them is refused before the
 * handler runs. A credential that can mint credentials is a credential that can
 * escalate itself, which is the one thing the whole control plane cannot allow.
 *
 * The minted value is returned exactly once. Nothing stores it: the row holds
 * SHA-256 of the secret, so a lost token is replaced, never recovered.
 */

import type { Env } from "../index";
import type { AdminActor } from "../audit";
import { writeAudit, requestMeta } from "../audit";
import { err } from "../lib/errors";
import { readJsonBoundedResult } from "../lib/body";
import { MAX_BODY_BYTES } from "../lib/config";
import {
  AGENT_TOKEN_PREFIX,
  DEFAULT_AGENT_SENDS_PER_HOUR,
  MAX_AGENT_NAME_CHARS,
  clampSendsPerHour,
  getAgentToken,
  listAgentTokens,
  mintAgentToken,
  revokeAgentToken,
} from "../lib/agent-tokens";

/** A token with no lifetime is a credential nobody can retire by waiting. */
const DEFAULT_TOKEN_TTL_S = 30 * 86_400;
const MIN_TOKEN_TTL_S = 60;
const MAX_TOKEN_TTL_S = 365 * 86_400;

/** `POST /v1/admin/agent-tokens` — mint one. The value is printed once. */
export async function handleAgentTokenMint(
  req: Request,
  env: Env,
  actor: AdminActor
): Promise<Response> {
  const parsed = await readJsonBoundedResult(req, MAX_BODY_BYTES);
  if (!parsed.ok) return err(parsed.reason);
  const input = parsed.value;

  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name === "" || name.length > MAX_AGENT_NAME_CHARS) return err("bad_request", 400);

  const scopes = input.scopes;
  if (!Array.isArray(scopes) || scopes.length === 0 || scopes.length > 32) {
    return err("bad_request", 400);
  }
  if (!scopes.every((entry) => typeof entry === "string")) return err("bad_request", 400);

  const rawDevice = input.device_id;
  if (rawDevice !== undefined && rawDevice !== null && typeof rawDevice !== "string") {
    return err("bad_request", 400);
  }
  const deviceId = typeof rawDevice === "string" && rawDevice !== "" ? rawDevice : null;

  // An agent bound to a handset that is not in the fleet would look valid and
  // fail on its first send. Refuse it at mint time instead.
  if (deviceId !== null) {
    const device = await env.DB.prepare(`SELECT 1 AS ok FROM devices WHERE device_id = ?`)
      .bind(deviceId)
      .first();
    if (device === null) return err("device_unknown", 404);
  }

  const ttlRaw = input.expires_in_s;
  const ttlSeconds =
    ttlRaw === undefined || ttlRaw === null
      ? DEFAULT_TOKEN_TTL_S
      : typeof ttlRaw === "number" && Number.isFinite(ttlRaw)
        ? Math.min(MAX_TOKEN_TTL_S, Math.max(MIN_TOKEN_TTL_S, Math.trunc(ttlRaw)))
        : Number.NaN;
  if (!Number.isFinite(ttlSeconds)) return err("bad_request", 400);

  const maxPerHour = clampSendsPerHour(input.max_per_hour ?? DEFAULT_AGENT_SENDS_PER_HOUR);

  const minted = await mintAgentToken(env, {
    name,
    scopes: scopes as string[],
    deviceId,
    maxPerHour,
    expiresAt: Date.now() + ttlSeconds * 1_000,
    createdBy: actor.label,
  });
  if (!minted.ok) {
    // Named, not dropped: a token that silently lacks a scope it printed is
    // worse than one that refused to mint.
    return Response.json(
      { error: "bad_request", message: "unknown scope", unknown_scopes: minted.unknown },
      { status: 400 }
    );
  }

  await writeAudit(env, {
    action: "agent_token.minted",
    actor: { userId: actor.userId, label: actor.label },
    subject: minted.minted.id,
    detail: {
      name,
      scopes: minted.minted.record.scopes,
      device_id: deviceId,
      expires_in_s: ttlSeconds,
      max_per_hour: maxPerHour,
      token_prefix: AGENT_TOKEN_PREFIX,
    },
    ...requestMeta(req),
  });

  return Response.json({
    id: minted.minted.id,
    name,
    // Shown once. `agent-tokens` lists the same row without it.
    token: minted.minted.token,
    scopes: minted.minted.record.scopes,
    device_id: deviceId,
    max_per_hour: maxPerHour,
    expires_at: minted.minted.record.expires_at,
    created_at: minted.minted.record.created_at,
  });
}

/** `GET /v1/admin/agent-tokens` — what exists, without any secret. */
export async function handleAgentTokenList(env: Env, url: URL): Promise<Response> {
  const includeRevoked = url.searchParams.get("revoked") === "1";
  const tokens = await listAgentTokens(env, { includeRevoked });
  return Response.json({
    agent_tokens: tokens.map((token) => ({
      id: token.id,
      name: token.name,
      scopes: token.scopes,
      device_id: token.device_id,
      max_per_hour: token.max_per_hour,
      sent_current_hour: token.sent_current_hour,
      hour_window_start: token.hour_window_start,
      created_at: token.created_at,
      created_by: token.created_by,
      last_used_at: token.last_used_at,
      expires_at: token.expires_at,
      revoked_at: token.revoked_at,
    })),
  });
}

/** `DELETE /v1/admin/agent-tokens/:id` — takes effect on the next request. */
export async function handleAgentTokenRevoke(
  req: Request,
  env: Env,
  id: string,
  actor: AdminActor
): Promise<Response> {
  const existing = await getAgentToken(env, id);
  if (existing === null) {
    return Response.json({ error: "not_found", message: `no agent token ${id}` }, { status: 404 });
  }

  const revoked = await revokeAgentToken(env, id);
  if (revoked === null) {
    // Already revoked. Reporting success twice would hide a mistyped id.
    return Response.json({ error: "already_revoked", id }, { status: 409 });
  }

  await writeAudit(env, {
    action: "agent_token.revoked",
    actor: { userId: actor.userId, label: actor.label },
    subject: id,
    detail: { name: revoked.name },
    ...requestMeta(req),
  });

  return Response.json({ ok: true, id, revoked_at: revoked.revoked_at });
}
