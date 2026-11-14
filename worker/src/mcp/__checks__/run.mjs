#!/usr/bin/env node
/**
 * Transport checks that do not need a Worker runtime.
 *
 * `transport.ts` and `oauth.ts` deliberately import nothing, so this script can
 * import the real modules under plain `node` (22.18+/23.6+ strips TypeScript
 * types natively) and assert the failure modes an HTTP client actually sees:
 *
 *   - 406 without an acceptable `Accept`
 *   - 400 on malformed JSON and on a malformed JSON-RPC envelope
 *   - an `Mcp-Session-Id` is minted on `initialize` and echoed afterwards
 *   - unknown sessions are 404, stateless GET is 405
 *   - the discovery documents carry the S256 shape
 *   - an unanswered elicitation aborts the tool call with -32003
 *
 * Run: node src/mcp/__checks__/run.mjs
 */

import {
  ElicitationRegistry,
  SessionStore,
  handleStreamableRequest,
  JSON_RPC,
  MCP_SESSION_HEADER,
} from "../transport.ts";
import { audienceProblem, handleWellKnown, mcpResourceUrl } from "../oauth.ts";

let passed = 0;
const failures = [];

function check(label, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ok  ${label}`);
  } else {
    failures.push(`${label}${detail === "" ? "" : ` — ${detail}`}`);
    console.log(`FAIL  ${label}${detail === "" ? "" : ` — ${detail}`}`);
  }
}

function post(body, sessionId, headers = {}) {
  const h = new Headers({ "Content-Type": "application/json", Accept: "application/json", ...headers });
  if (sessionId !== undefined && sessionId !== null) h.set(MCP_SESSION_HEADER, sessionId);
  return new Request("https://gateway.example/mcp", {
    method: "POST",
    headers: h,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const tools = [
  {
    name: "list_devices",
    title: "List devices",
    description: "Read-only.",
    inputSchema: { type: "object", properties: {} },
    call: async () => ({ text: "no devices", structured: { devices: [] } }),
  },
  {
    name: "send_sms",
    title: "Send SMS",
    description: "Mutating.",
    inputSchema: { type: "object", properties: {} },
    call: async () => ({ text: "sent", structured: { sent: true } }),
  },
];

function deps(overrides = {}) {
  return {
    tools,
    serverInfo: { name: "dakflare", version: "test" },
    sessions: new SessionStore(),
    elicitations: new ElicitationRegistry(),
    onError: () => {},
    ...overrides,
  };
}

async function main() {
  console.log("streamable transport");

  /* 406 ─────────────────────────────────────────────────────────────── */
  {
    const req = new Request("https://gateway.example/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/html" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    const res = await handleStreamableRequest(req, deps());
    const body = await res.json();
    check("406 without an acceptable Accept", res.status === 406, `status ${res.status}`);
    check("406 carries a JSON-RPC error", body?.error?.code === JSON_RPC.NOT_ACCEPTABLE, JSON.stringify(body));
  }

  /* malformed body / envelope ───────────────────────────────────────── */
  {
    const d = deps();
    const res = await handleStreamableRequest(post("{not json", null), d);
    const body = await res.json();
    check("400 on malformed JSON", res.status === 400 && body?.error?.code === JSON_RPC.PARSE_ERROR, `status ${res.status}`);

    const res2 = await handleStreamableRequest(post({ jsonrpc: "2.0", id: 7 }, null), d);
    const body2 = await res2.json();
    check(
      "400 on malformed JSON-RPC",
      res2.status === 400 && body2?.error?.code === JSON_RPC.INVALID_REQUEST,
      `status ${res2.status} ${JSON.stringify(body2)}`
    );
    check("an invalid request keeps id null, never a stack", body2?.id === null && !("stack" in body2));
  }

  /* session mint + echo ─────────────────────────────────────────────── */
  {
    const d = deps();
    const init = await handleStreamableRequest(
      post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, null),
      d
    );
    const sessionId = init.headers.get(MCP_SESSION_HEADER);
    const initBody = await init.json();
    check("initialize mints Mcp-Session-Id", typeof sessionId === "string" && sessionId.length > 0);
    check("initialize answers the requested protocol", initBody?.result?.protocolVersion === "2025-06-18");

    const list = await handleStreamableRequest(
      post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, sessionId),
      d
    );
    const listBody = await list.json();
    check("later request echoes the session id", list.headers.get(MCP_SESSION_HEADER) === sessionId);
    check("tools/list returns the tool surface", Array.isArray(listBody?.result?.tools) && listBody.result.tools.length === 2);

    const unknown = await handleStreamableRequest(
      post({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }, "not-a-session"),
      d
    );
    check("unknown session is 404", unknown.status === 404, `status ${unknown.status}`);

    const get = await handleStreamableRequest(
      new Request("https://gateway.example/mcp", { method: "GET", headers: { Accept: "text/event-stream" } }),
      d
    );
    check("GET without a session is 405 (stateless)", get.status === 405, `status ${get.status}`);
  }

  /* stateless dialect ───────────────────────────────────────────────── */
  {
    const d = deps();
    const res = await handleStreamableRequest(
      post(
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } },
        },
        null
      ),
      d
    );
    check("params._meta is served statelessly", res.status === 200 && res.headers.get(MCP_SESSION_HEADER) === null, `status ${res.status}`);
  }

  /* elicitation timeout ────────────────────────────────────────────── */
  {
    const d = deps({
      elicitationTimeoutMs: 40,
      elicitation: {
        request: async () => ({
          message: "Confirm SMS",
          requestedSchema: { type: "object" },
          state: { hash: "abc" },
        }),
        complete: async () => {
          throw new Error("complete must not run when the answer never arrives");
        },
      },
    });

    const init = await handleStreamableRequest(
      post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }, null),
      d
    );
    const sessionId = init.headers.get(MCP_SESSION_HEADER);

    const started = Date.now();
    const res = await handleStreamableRequest(
      post({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "send_sms", arguments: { to: "+8801000000000" } } }, sessionId),
      d
    );
    const stream = await res.text();
    const elapsed = Date.now() - started;

    check("mutating call opens an SSE stream", (res.headers.get("Content-Type") ?? "").includes("text/event-stream"));
    check("elicitation/create is streamed", stream.includes('"method":"elicitation/create"'));
    check(
      "timeout aborts the tool call with -32003",
      stream.includes(`"code":${JSON_RPC.ELICITATION_TIMEOUT}`),
      stream.slice(0, 300)
    );
    check("the tool never returned a result", !stream.includes('"result":{"content"'));
    check("the wait was bounded", elapsed >= 30 && elapsed < 2_000, `${elapsed}ms`);
  }

  /* oauth discovery ────────────────────────────────────────────────── */
  {
    const req = new Request("https://gateway.example/.well-known/oauth-authorization-server");
    const res = await handleWellKnown(req);
    const body = await res.json();
    check("authorization-server metadata is 200", res.status === 200);
    check("response_types_supported is code", JSON.stringify(body?.response_types_supported) === '["code"]');
    check("code_challenge_methods_supported is S256", JSON.stringify(body?.code_challenge_methods_supported) === '["S256"]');
    check(
      "token endpoint auth methods are none + client_secret_post",
      JSON.stringify(body?.token_endpoint_auth_methods_supported) === '["none","client_secret_post"]'
    );
    check("no endpoint is advertised that does not exist", !("token_endpoint" in body) && !("authorization_endpoint" in body));

    const prm = await handleWellKnown(new Request("https://gateway.example/.well-known/oauth-protected-resource"));
    const prmBody = await prm.json();
    check("protected-resource names /mcp", prmBody?.resource === "https://gateway.example/mcp", String(prmBody?.resource));
    check("bearer_methods_supported is header", JSON.stringify(prmBody?.bearer_methods_supported) === '["header"]');

    const request = new Request("https://gateway.example/mcp");
    check("matching audience is accepted", audienceProblem(request, mcpResourceUrl(request)) === null);
    const wrong = audienceProblem(request, "https://other.example/mcp");
    const challenge = wrong?.headers.get("WWW-Authenticate") ?? "";
    check("foreign audience is 401", wrong?.status === 401);
    check("401 names the resource metadata", challenge.includes("resource_metadata=") && challenge.includes("/.well-known/oauth-protected-resource"));
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
  }
}

await main();
