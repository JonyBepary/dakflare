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
import { runAsAgent } from "../lib/authority";
import {
  ASSISTANT_OBJECT_NAME,
  mintTicket,
  type MintedTicket,
} from "../lib/agent-runtime";
import { AGENT_SCHEMA_VERSION } from "../agent/runtime";

const TICKET_ACTION = "mint agent runtime tickets";
const RUNTIME_READ_ACTION = "read the agent runtime";

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
