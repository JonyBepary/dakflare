/**
 * The split agent Worker.
 *
 * It owns `AssistantAgent` (a new Durable Object namespace), the MCP tool
 * surface, and the agent conversation routes. The main Worker remains the only
 * public entrypoint, proves the actor, and forwards here through `AGENT_SVC`.
 *
 * It deliberately has no DEVICE, AUTH_GUARD, or BETTER_AUTH_SECRET binding:
 * actions that need them go back through the `CORE` service binding to the
 * main Worker's typed API.
 */

import { routeAgentRequest } from "agents/routing";
import type { Env } from "./index";
import type { AdminActor } from "./audit";
import {
  agentRuntimeEnabled,
  handleAgentConversationClear,
  handleAgentSay,
} from "./routes/agent-runtime";
import { ASSISTANT_OBJECT_NAME } from "./lib/agent-runtime";

export { AssistantAgent } from "./agent/runtime";

function actorFrom(req: Request): AdminActor | null {
  const label = req.headers.get("x-dakflare-actor");
  if (label === null || label === "") return null;
  const roleHeader = req.headers.get("x-dakflare-actor-role") ?? "agent";
  const role = (
    ["owner", "admin", "member", "machine", "agent", "webhook"].includes(roleHeader)
      ? roleHeader
      : "agent"
  ) as AdminActor["role"];
  const scopes = req.headers.get("x-dakflare-agent-scopes");
  return {
    userId: req.headers.get("x-dakflare-user-id") || null,
    label,
    role,
    canGrantOwner: role === "owner",
    agentTokenId: req.headers.get("x-dakflare-agent-token-id") || undefined,
    agentDeviceId: req.headers.get("x-dakflare-agent-device-id") || null,
    agentScopes:
      scopes === null || scopes === ""
        ? undefined
        : scopes.split(",").map((scope) => scope.trim()).filter(Boolean),
    sessionId: req.headers.get("x-dakflare-session-id") || undefined,
  };
}

function runtimeStatus(env: Env): Promise<Response> {
  return (async () => {
    let schemaVersion: number | null = null;
    let connections = 0;
    try {
      const stub = env.ASSISTANT?.getByName(ASSISTANT_OBJECT_NAME);
      if (stub !== undefined) {
        const answer = await stub.fetch("https://assistant/__runtime/status");
        if (answer.ok) {
          const body = (await answer.json()) as { schemaVersion?: number; connections?: number };
          schemaVersion = typeof body.schemaVersion === "number" ? body.schemaVersion : null;
          connections = typeof body.connections === "number" ? body.connections : 0;
        }
      }
    } catch {
      // A missing object is reported as zero sessions, not a 500.
    }
    return Response.json({
      enabled: env.AGENT_RUNTIME === "on",
      schemaVersion,
      connections,
      sessions: connections,
      pinnedName: ASSISTANT_OBJECT_NAME,
    });
  })();
}

export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/agents" || url.pathname.startsWith("/agents/")) {
      if (env.AGENT_RUNTIME !== "on") {
        return Response.json({ error: "agent_runtime_off" }, { status: 503 });
      }
      return (await routeAgentRequest(req, env)) ?? Response.json({ error: "not_found" }, { status: 404 });
    }

    if (url.pathname === "/internal/mcp") {
      const actor = actorFrom(req);
      if (actor === null) return Response.json({ error: "unauthorized" }, { status: 401 });
      // Preserve the public Host on the synthetic URL so the MCP host/origin
      // guards see the same authority the client used.
      const host = req.headers.get("x-dakflare-public-host");
      const target = new URL(req.url);
      if (host !== null && host !== "") target.host = host;
      const forwarded = new Request(target.toString(), req);
      const mcpPath = req.headers.get("x-dakflare-mcp-path");
      // Load the MCP SDK only when this route is used. Importing it at module
      // scope made the Worker's startup evaluate a zod cycle before the DO
      // entrypoint settled; the HTTP route is cold anyway.
      if (mcpPath === "/mcp") {
        const { handleStreamableMcp } = await import("./mcp/http");
        return handleStreamableMcp(forwarded, env, actor);
      }
      const { handleMcpRequest } = await import("./mcp/server");
      return handleMcpRequest(forwarded, env, actor);
    }

    if (url.pathname === "/internal/agent/runtime") {
      return runtimeStatus(env);
    }

    if (url.pathname === "/internal/agent/conversation") {
      const actor = actorFrom(req);
      if (actor === null) return Response.json({ error: "unauthorized" }, { status: 401 });
      if (req.method === "DELETE") return handleAgentConversationClear(req, env, actor);
      // A already resolved the actor; read directly instead of re-running
      // runAsAgent, which needs the main Worker's auth bindings.
      const raw = url.searchParams.get("limit");
      const parsed = raw === null ? 40 : Number(raw);
      const limit = Number.isInteger(parsed) ? Math.max(1, Math.min(100, parsed)) : 40;
      if (!agentRuntimeEnabled(env) || env.ASSISTANT === undefined) {
        return Response.json({ error: "agent_runtime_off" }, { status: 503 });
      }
      const result = await env.ASSISTANT.getByName(ASSISTANT_OBJECT_NAME).readConversation(
        { label: actor.label },
        limit
      );
      if (!result.ok) {
        return Response.json(
          { error: "agent_refused", reason: result.reason, message: result.message },
          { status: 503 }
        );
      }
      return Response.json({
        conversation: result.conversation,
        messages: result.messages,
        truncated: result.truncated,
      });
    }

    if (url.pathname === "/internal/agent/say") {
      const actor = actorFrom(req);
      if (actor === null) return Response.json({ error: "unauthorized" }, { status: 401 });
      return handleAgentSay(req, env, actor);
    }

    if (url.pathname === "/internal/agent/import" && req.method === "POST") {
      if (env.ASSISTANT === undefined) {
        return Response.json({ error: "agent_runtime_unavailable" }, { status: 503 });
      }
      const body = (await req.json().catch(() => null)) as { conversations?: unknown } | null;
      if (body === null || !Array.isArray(body.conversations)) {
        return Response.json({ error: "bad_request" }, { status: 400 });
      }
      const result = await env.ASSISTANT.getByName(ASSISTANT_OBJECT_NAME).importConversations(
        body.conversations as Parameters<
          import("./agent/runtime").AssistantAgent["importConversations"]
        >[0]
      );
      return Response.json(result);
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
