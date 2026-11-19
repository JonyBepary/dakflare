/**
 * The Worker-facing half of the streamable MCP transport.
 *
 * `transport.ts` owns the protocol (sessions, batches, SSE, elicitation
 * correlation). This file owns the two things that need the Worker:
 *
 *   1. the tool surface, filtered to the scopes the verified token holds, so
 *      `tools/list` remains the permission boundary it is in `server.ts`; and
 *   2. the elicitation driver, which checks a TOTP and mints an authority grant
 *      against D1 (`elicitation.ts`).
 *
 * Mount it exactly like `handleMcpRequest`:
 *
 *     import { handleStreamableMcp } from "./mcp/http";
 *     return handleStreamableMcp(req, env, actor, tokenAudience);
 *
 * `tokenAudience` is optional: a `dkf_agt_` token has no RFC 8707 audience, so
 * its `undefined` is correct. An OAuth access token passes the `aud` value it
 * verified, and a mismatch is a 401 with the protected-resource metadata URL.
 */

import { z } from "zod";
import {
  hostHeaderValidationResponse,
  isInputRequiredResult,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  originValidationResponse,
} from "@modelcontextprotocol/server";

import type { Env } from "../index";
import type { AdminActor } from "../audit";
import { VERSION } from "../lib/version";
import { toolDefinitions } from "./tools";
import { createElicitationDriver } from "./elicitation";
import { audienceProblem } from "./oauth";
import {
  createElicitationRegistry,
  createSessionStore,
  handleStreamableRequest,
  type ElicitationRegistry,
  type SessionStore,
  type ToolCallOutcome,
  type ToolDescriptor,
} from "./transport";

/**
 * Shared per isolate. Sessions and elicitation ids must outlive the request
 * that created them, because the answer arrives on a later POST.
 */
const sessions: SessionStore = createSessionStore();
const elicitations: ElicitationRegistry = createElicitationRegistry();

/** zod -> plain JSON Schema, with the draft marker stripped (MCP does not want it). */
function jsonSchema(schema: z.ZodTypeAny, io: "input" | "output"): Record<string, unknown> {
  try {
    const converted = z.toJSONSchema(schema, { io }) as Record<string, unknown>;
    delete converted.$schema;
    return converted;
  } catch {
    // A schema this version of zod cannot describe is published as an open
    // object rather than failing the whole `tools/list`.
    return { type: "object", additionalProperties: true };
  }
}

/** The tools this credential may see, as the transport's plain descriptors. */
function toolDescriptors(env: Env, actor: AdminActor): ToolDescriptor[] {
  return toolDefinitions(env)
    .filter((tool) => actor.agentScopes?.includes(tool.requiredScope))
    .map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: jsonSchema(tool.inputSchema, "input"),
      ...(tool.outputSchema === undefined ? {} : { outputSchema: jsonSchema(tool.outputSchema, "output") }),
      ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
      call: async (args: Record<string, unknown>): Promise<ToolCallOutcome> => {
        const answer = await tool.run(args, env, actor);
        if (isInputRequiredResult(answer)) {
          // MRTR answer from the SDK's own builder: pass the whole result through.
          return { text: "", raw: answer };
        }
        const structured = answer.structured;
        return {
          text: answer.text,
          structured,
          isError: typeof structured.error === "string",
        };
      },
    }));
}

/** Carry a stream through untouched while adding the proxy header. */
function withProxyHeader(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Accel-Buffering", "no");
  return new Response(response.body, { status: response.status, headers });
}

/**
 * The RFC 8707 audience a static agent token is bound to.
 *
 * The deployment's configured origin is the honest resource identifier: a
 * `dkf_agt_` token is minted by this deployment and is usable only against it.
 * When `AUTH_BASE_URL` is unset (an older deployment) `undefined` preserves the
 * previous behaviour exactly: an opaque token carries no audience, and no
 * audience is not a mismatch. A token that DOES carry one — the configured
 * resource — must match the resource being called, so a request proxied in
 * under another host is refused instead of silently accepted.
 */
export function mcpDeploymentAudience(env: Env, request: Request): string | undefined {
  const configured = env.AUTH_BASE_URL?.trim();
  if (configured === undefined || configured === "") return undefined;
  try {
    return new URL("/mcp", new URL(configured).origin).toString();
  } catch {
    // A malformed AUTH_BASE_URL is already refused by the auth routes; here it
    // means "no configured audience", not a reason to reject every MCP call.
    return undefined;
  }
}

/**
 * `POST|GET|DELETE /mcp` — one endpoint, both dialects.
 *
 * Returns 401 before reading a body when an OAuth audience does not name this
 * resource (RFC 8707). Host and Origin checks match `handleMcpRequest`: a
 * browser is not a client of this endpoint, and a wildcard origin would let any
 * page drive the gateway with a token it should not have.
 */
export async function handleStreamableMcp(
  req: Request,
  env: Env,
  actor: AdminActor,
  tokenAudience?: string | string[]
): Promise<Response> {
  const audienceRejected = audienceProblem(req, tokenAudience);
  if (audienceRejected !== null) return audienceRejected;

  const rejected =
    hostHeaderValidationResponse(req, [
      new URL(req.url).hostname,
      ...localhostAllowedHostnames(),
    ]) ?? originValidationResponse(req, localhostAllowedOrigins());
  if (rejected !== undefined) return rejected;

  const response = await handleStreamableRequest(req, {
    tools: toolDescriptors(env, actor),
    serverInfo: { name: "dakflare", version: VERSION },
    elicitation: createElicitationDriver(env, actor),
    actorKey: actor.agentTokenId ?? actor.label,
    sessions,
    elicitations,
    onError: (error: unknown) => {
      console.error(`[mcp] ${error instanceof Error ? error.message : String(error)}`);
    },
  });

  return withProxyHeader(response);
}
