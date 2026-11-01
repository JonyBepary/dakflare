/**
 * The MCP endpoint: `POST /v1/mcp`, protocol revision 2026-07-28.
 *
 * Built on Cloudflare's sanctioned `createMcpHandler` rather than a hand-rolled
 * route, because that handler already does the four things a hand-rolled one gets
 * wrong: the per-request envelope claim and `MCP-Protocol-Version` check, the
 * `Mcp-Method`/`Mcp-Name` header/body agreement (a mismatch is `-32020`), the
 * `server/discover` answer, and MRTR. All of it is proven in the conformance
 * suite rather than asserted here.
 *
 * Two things the handler deliberately does NOT do, and this file does:
 *
 *   1. **Authentication.** The entry performs no token verification; `authInfo` is
 *      passed through as-is and never derived from headers. So the route resolves
 *      the `dkf_agt_` bearer first and only then builds a handler bound to that
 *      token. There is no path into a tool without a verified token.
 *   2. **Origin and Host validation.** The handler is validation-free by design
 *      (it can be mounted anywhere), so the Worker applies the SDK's own
 *      `hostHeaderValidationResponse` / `originValidationResponse` in front of it.
 *
 * ## Authorization is NOT conformant, and the docs say so
 *
 * MCP authorization is optional, but a server that implements it is an OAuth 2.1
 * resource server: RFC 9728 metadata, `401` with `WWW-Authenticate`, scopes. This
 * endpoint takes a static `dkf_agt_` bearer instead. That works in the clients in
 * use today and it is the same credential the CLI holds, but a conformant OAuth
 * client cannot negotiate it, and no protected-resource metadata is advertised
 * because there is no authorization server to point at. `agent_tokens` stores
 * hashes and scopes, so the OAuth phase, when a client needs it, is a new front
 * door on the same table rather than a migration.
 */

import {
  createMcpHandler,
  hostHeaderValidationResponse,
  isInputRequiredResult,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  McpServer,
  originValidationResponse,
} from "@modelcontextprotocol/server";

import type { Env } from "../index";
import type { AdminActor } from "../audit";
import { VERSION } from "../lib/version";
import { toolDefinitions, type ToolAnswer } from "./tools";

/**
 * One handler per request, bound to the token that authenticated it.
 *
 * Stateless on purpose: a fresh `McpServer` per request, no session, no socket.
 * Cross-request state lives in D1 (approvals, grants) and in the device object as
 * timers, which is where it has to survive anyway.
 */
export function createDakflareMcpHandler(env: Env, actor: AdminActor) {
  const factory = () => {
    const server = new McpServer({ name: "dakflare", version: VERSION });

    for (const tool of toolDefinitions(env)) {
      // `tools/list` is the permission surface: only what this token may use is
      // registered, so an out-of-scope call is method-not-found and there is no
      // path to a handler that the credential was not checked for.
      if (!actor.agentScopes?.includes(tool.requiredScope)) continue;
      server.registerTool(
        tool.name,
        {
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema,
          ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
        },
        async (args: Record<string, unknown>) => {
          const answer = await tool.run(args, env, actor);
          // MRTR: an input-required result is the tool's answer, not a failure.
          if (isInputRequiredResult(answer)) return answer;
          const value = answer as ToolAnswer;
          return {
            content: [{ type: "text" as const, text: value.text }],
            structuredContent: value.structured,
          };
        }
      );
    }

    return server;
  };

  return createMcpHandler(factory, { legacy: "reject" });
}

/**
 * Origin and Host validation, then the handler.
 *
 * `allowedOrigins` is empty: a browser is not a client of this endpoint, and
 * allowing any origin would let a page on another site drive the gateway with a
 * token it should not have. Non-browser clients send no `Origin`, which the check
 * permits.
 */
export async function handleMcpRequest(
  request: Request,
  env: Env,
  actor: AdminActor
): Promise<Response> {
  const rejected =
    hostHeaderValidationResponse(request, [new URL(request.url).hostname, ...localhostAllowedHostnames()]) ??
    originValidationResponse(request, localhostAllowedOrigins());
  if (rejected !== undefined) return rejected;

  const handler = createDakflareMcpHandler(env, actor);
  // The entry takes the request and an optional auth descriptor; the token was
  // already verified before this point, so there is nothing to derive here.
  const response = await handler.fetch(request);

  // `X-Accel-Buffering: no` is the documented recommendation so a proxy does not
  // buffer a stream; it costs one header and the alternative is a stalled client.
  const headers = new Headers(response.headers);
  headers.set("X-Accel-Buffering", "no");
  return new Response(response.body, { status: response.status, headers });
}
