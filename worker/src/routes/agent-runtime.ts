/**
 * Agent runtime control routes — pass 3, stage A.
 *
 * Two routes only, and both are human-surface:
 *
 *   POST /v1/admin/agent/ticket   mint one 60-second, single-use upgrade ticket
 *   GET  /v1/admin/agent/runtime  what the shell is: enabled, schema, pin
 *
 * The ticket action is deliberately ABSENT from `SCOPE_FOR_ACTION`, so an agent
 * token is refused before the handler runs. A credential that can mint the
 * ticket that opens the runtime is a credential that can enter it.
 *
 * The GET goes through `runAsAgent` because that is the function a future tool
 * will call too: one place resolves the actor, checks the token scope, applies
 * the limiter and records the use. Stage A wires no tool, so this route is the
 * only caller besides the upgrade gate in the entry point.
 */

import type { Env } from "../index";
import type { AdminActor } from "../audit";
import { writeAudit } from "../audit";
import { assertHuman, runAsAgent } from "../lib/authority";
import {
  AUTONOMY_TOKEN_ID,
  enableAutonomy,
  mintAutonomyGrants,
  readAutonomyStatus,
  revokeAutonomy,
} from "../agent/grants";
import { listGrants } from "../lib/authority";
import { readJsonBoundedResult } from "../lib/body";
import { MAX_BODY_BYTES } from "../lib/config";
import { err } from "../lib/errors";
import {
  ASSISTANT_OBJECT_NAME,
  mintTicket,
  type MintedTicket,
} from "../lib/agent-runtime";
import { AGENT_SCHEMA_VERSION } from "../agent/runtime";

const TICKET_ACTION = "mint agent runtime tickets";
const RUNTIME_READ_ACTION = "read the agent runtime";
const AUTONOMY_READ_ACTION = "read agent autonomy";

export function agentRuntimeEnabled(env: Pick<Env, "AGENT_RUNTIME">): boolean {
  return env.AGENT_RUNTIME === "on";
}

/**
 * `POST /v1/admin/agent/ticket`.
 *
 * A ticket needs the Better Auth session row, not just any write-capable
 * credential: it is bound to that session id, and the upgrade gate redeems it
 * against the session on the socket request. An ADMIN_TOKEN caller has no
 * session, so it is refused here with the reason rather than minting a ticket
 * nothing can redeem.
 */
export async function handleAgentTicketMint(
  _req: Request,
  env: Env,
  actor: AdminActor
): Promise<Response> {
  if (!agentRuntimeEnabled(env)) {
    return Response.json({ error: "agent_runtime_off" }, { status: 503 });
  }
  if (actor.sessionId === undefined || actor.sessionId === "") {
    return Response.json(
      {
        error: "permission",
        message: `${TICKET_ACTION} needs a signed-in human session; ` +
          "an admin token or an agent credential has no session to bind a ticket to",
      },
      { status: 403 }
    );
  }

  const minted: MintedTicket = await mintTicket(env, actor.sessionId, ASSISTANT_OBJECT_NAME);
  return Response.json(minted, { status: 201 });
}

/**
 * `GET /v1/admin/agent/runtime` — `{enabled, schemaVersion, sessions, pinnedName}`.
 *
 * When the runtime is off the Durable Object is never touched: asking it for a
 * status would create the object on a deployment that deliberately has no
 * runtime.
 */
export async function handleAgentRuntimeRead(req: Request, env: Env): Promise<Response> {
  return runAsAgent(
    req,
    env,
    RUNTIME_READ_ACTION,
    async (_actor) => {
      const enabled = agentRuntimeEnabled(env);
      if (!enabled) {
        return Response.json({
          enabled: false,
          schemaVersion: AGENT_SCHEMA_VERSION,
          sessions: 0,
          pinnedName: ASSISTANT_OBJECT_NAME,
        });
      }

      let status: {
        schemaVersion?: number;
        connections?: number;
      } = {};
      try {
        const stub = env.ASSISTANT?.get(env.ASSISTANT.idFromName(ASSISTANT_OBJECT_NAME));
        if (stub !== undefined) {
          const response = await stub.fetch("https://assistant/__runtime/status");
          if (response.ok) status = (await response.json()) as typeof status;
        }
      } catch (error) {
        console.error(`[agent] runtime status unavailable: ${String(error)}`);
      }

      return Response.json({
        enabled,
        schemaVersion:
          typeof status.schemaVersion === "number" ? status.schemaVersion : AGENT_SCHEMA_VERSION,
        sessions: typeof status.connections === "number" ? status.connections : 0,
        pinnedName: ASSISTANT_OBJECT_NAME,
      });
    },
    "read"
  );
}

/* ───────────────────────────── autonomy window ───────────────────────────── */

/** `GET /v1/admin/agent/autonomy` — the window, the caps and today's spend. */
export async function handleAutonomyRead(req: Request, env: Env): Promise<Response> {
  return runAsAgent(
    req,
    env,
    AUTONOMY_READ_ACTION,
    async (actor) => {
      const human = assertHuman(actor);
      if (!human.ok) return human.response;
      const status = await readAutonomyStatus(env);
      const grants = await listGrants(env, { tokenId: AUTONOMY_TOKEN_ID, liveOnly: true });
      return Response.json({
        ...status,
        grants: grants.map((grant) => ({
          id: grant.id,
          scope: grant.scope,
          target: grant.target,
          expires_at: grant.expires_at,
          use_count: grant.use_count,
        })),
      });
    },
    "read"
  );
}

interface AutonomyBody {
  ttl_s?: number;
  sms_cap?: number;
  write_cap?: number;
  recipients?: string[];
  flows?: Array<{ flow_id?: string; graph_hash?: string }>;
  rules?: Array<{ rule_id?: string; body_hash?: string }>;
  sms_max_uses?: number;
  write_max_uses?: number;
  /** Grant rules:write with no target — any rule, bounded by the write cap. */
  allow_rules?: boolean;
  allowRules?: boolean;
}

function readInteger(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.max(min, Math.min(max, numeric));
}

/**
 * `POST /v1/admin/agent/autonomy` — turn autonomy on for a bounded window.
 *
 * The request names the effects: `recipients` for SMS, `flows` with a graph
 * hash, `rules` with a body hash. There is no "all recipients" shorthand,
 * because the grant table would have to interpret it as a wildcard and that is
 * the one thing a grant must never be.
 */
export async function handleAutonomyEnable(
  req: Request,
  env: Env,
  actor: AdminActor
): Promise<Response> {
  const human = assertHuman(actor);
  if (!human.ok) return human.response;

  const parsed = await readJsonBoundedResult(req, MAX_BODY_BYTES);
  if (!parsed.ok) return err(parsed.reason);
  const input = parsed.value as AutonomyBody;

  const ttlS = readInteger(input.ttl_s, 3_600, 60, 3_600);
  const smsCap = readInteger(input.sms_cap, 10, 0, 1_000);
  const writeCap = readInteger(input.write_cap, 50, 0, 1_000);

  const recipients = Array.isArray(input.recipients)
    ? input.recipients.filter((entry): entry is string => typeof entry === "string")
    : [];
  const flows: Array<{ flow_id: string; graph_hash?: string }> = Array.isArray(input.flows)
    ? input.flows
        .filter((entry) => entry !== null && typeof entry === "object")
        .map((entry) => ({
          flow_id: typeof entry.flow_id === "string" ? entry.flow_id : "",
          ...(typeof entry.graph_hash === "string" ? { graph_hash: entry.graph_hash } : {}),
        }))
        .filter((entry) => entry.flow_id !== "")
    : [];
  const rules: Array<{ rule_id?: string; body_hash?: string }> = Array.isArray(input.rules)
    ? input.rules
        .filter((entry) => entry !== null && typeof entry === "object")
        .map((entry) => ({
          ...(typeof entry.rule_id === "string" ? { rule_id: entry.rule_id } : {}),
          ...(typeof entry.body_hash === "string" ? { body_hash: entry.body_hash } : {}),
        }))
    : [];

  const row = await enableAutonomy(env, {
    // Bound to the caller: a window is per session, not per deployment.
    actor: actor.label,
    ttl_s: ttlS,
    sms_cap: smsCap,
    write_cap: writeCap,
    recipients,
    flows,
    rules,
    // The operator's explicit "any rule" consent, which is the only way a rule
    // act can be authorised: its id is minted by the act.
    allow_rules: input.allow_rules === true || input.allowRules === true,
    sms_max_uses:
      input.sms_max_uses === undefined ? undefined : readInteger(input.sms_max_uses, smsCap, 1, 1_000),
    write_max_uses:
      input.write_max_uses === undefined
        ? undefined
        : readInteger(input.write_max_uses, writeCap, 1, 1_000),
    updated_by: actor.label,
  });

  const minted = await mintAutonomyGrants(env, actor, {
    ttl_s: ttlS,
    sms_cap: smsCap,
    write_cap: writeCap,
    recipients,
    flows,
    rules,
    sms_max_uses: input.sms_max_uses,
    write_max_uses: input.write_max_uses,
    allow_rules: input.allow_rules === true || input.allowRules === true,
  });

  await writeAudit(env, {
    action: "agent.autonomy_enabled",
    actor: { userId: actor.userId, label: actor.label },
    subject: "autonomy",
    detail: {
      expires_at: row.expires_at,
        actor: typeof row.actor === "string" ? row.actor : null,
        mine: (typeof row.actor === "string" ? row.actor : null) === actor.label,
      sms_cap: smsCap,
      write_cap: writeCap,
      grants: minted.grants.map((grant) => ({ id: grant.id, scope: grant.scope })),
    },
  });

  return Response.json(
    {
      enabled: true,
      expires_at: row.expires_at,
      sms_cap: smsCap,
      write_cap: writeCap,
      grants: minted.grants.map((grant) => ({
        id: grant.id,
        scope: grant.scope,
        target: grant.target,
        expires_at: grant.expires_at,
      })),
      refusals: minted.refusals,
    },
    { status: 201 }
  );
}

/**
 * `DELETE /v1/admin/agent/autonomy` — the kill switch.
 *
 * Revokes the window and every autonomy grant, then tells the pinned object to
 * close its sessions. `AGENT_RUNTIME=off` is the other half: it answers 503
 * before the object is touched.
 */
export async function handleAutonomyRevoke(
  _req: Request,
  env: Env,
  actor: AdminActor
): Promise<Response> {
  const human = assertHuman(actor);
  if (!human.ok) return human.response;

  const revokedGrants = await revokeAutonomy(env, actor.label);

  let closed = 0;
  try {
    const stub = env.ASSISTANT?.get(env.ASSISTANT.idFromName(ASSISTANT_OBJECT_NAME));
    if (stub !== undefined) {
      const response = await stub.fetch("https://assistant/__runtime/kill", { method: "POST" });
      if (response.ok) {
        const body = (await response.json()) as { closed?: number };
        closed = Number(body.closed ?? 0);
      }
    }
  } catch (error) {
    console.error(`[agent] kill switch could not reach the object: ${String(error)}`);
  }

  await writeAudit(env, {
    action: "agent.autonomy_revoked",
    actor: { userId: actor.userId, label: actor.label },
    subject: "autonomy",
    detail: { revoked_grants: revokedGrants, closed },
  });

  return Response.json({ enabled: false, revoked_grants: revokedGrants, sessions_closed: closed });
}

/**
 * `POST /v1/admin/agent/say` — one non-streaming turn for a machine caller.
 *
 * The console talks over the WebSocket; this exists so the CLI and a harness can
 * exercise the same loop, tools, grants and journal without a browser session.
 * It is admin-only, its action is absent from SCOPE_FOR_ACTION, and it refuses
 * when the runtime is off.
 */
export async function handleAgentSay(
  req: Request,
  env: Env,
  actor: AdminActor
): Promise<Response> {
  if (!agentRuntimeEnabled(env)) {
    return Response.json({ error: "agent_runtime_off" }, { status: 503 });
  }
  if (env.ASSISTANT === undefined) {
    return Response.json(
      { error: "agent_runtime_off", message: "the ASSISTANT binding is not configured" },
      { status: 503 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad_request", message: "body must be JSON" }, { status: 400 });
  }
  const message =
    body !== null && typeof body === "object" && typeof (body as { message?: unknown }).message === "string"
      ? ((body as { message: string }).message).trim()
      : "";
  if (message === "") {
    return Response.json(
      { error: "bad_request", message: "message must be a non-empty string" },
      { status: 400 }
    );
  }
  if (message.length > 2_000) {
    return Response.json(
      { error: "bad_request", message: "message must be at most 2000 characters" },
      { status: 400 }
    );
  }

  const stub = env.ASSISTANT.getByName(ASSISTANT_OBJECT_NAME);
  const result = await stub.say(actor, message);
  if (!result.ok) {
    return Response.json(
      { error: "agent_refused", reason: result.reason, message: result.message },
      { status: 503 }
    );
  }
  return Response.json(result);
}
