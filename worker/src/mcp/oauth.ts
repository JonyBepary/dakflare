/**
 * OAuth 2.1 discovery for the MCP endpoint (RFC 9728 + RFC 8414).
 *
 * The gateway authenticates MCP with a static `dkf_agt_` bearer today; there is
 * no OAuth authorization server in this repository. This module still serves
 * the two documents a conformant client looks for, because that is how a client
 * discovers that a 401 is about a bearer token at all:
 *
 *   /.well-known/oauth-protected-resource        RFC 9728 resource metadata
 *   /.well-known/oauth-authorization-server      RFC 8414 issuer metadata
 *
 * ## Honest by omission
 *
 * The issuer metadata advertises the protocol capabilities this deployment can
 * honour (`code` + PKCE S256, public and `client_secret_post` clients, the agent
 * scopes). It does **not** advertise `authorization_endpoint`, `token_endpoint`
 * or `registration_endpoint`: no such routes exist, and a discovery document
 * that points at a 404 is worse than one that omits the field. When an OAuth
 * front door is added on top of `agent_tokens`, those three fields are the only
 * change this file needs.
 *
 * ## Audience binding (RFC 8707)
 *
 * A resource server must reject a token minted for a different resource.
 * `audienceProblem` is the check the route calls after verifying a token: a
 * token whose `aud` does not name this deployment's `/mcp` URL is a 401 with a
 * `WWW-Authenticate` challenge pointing at the metadata above. An opaque
 * `dkf_agt_` token has no `aud`, which is not a mismatch — the type check is
 * what distinguishes "no audience" from "the wrong audience".
 */

export interface OAuthEnv {
  /** Public origin of this Worker, when configured. */
  AUTH_BASE_URL?: string;
}

/** The resource identifier this deployment protects. */
export function mcpResourceUrl(request: Request): string {
  return new URL("/mcp", new URL(request.url).origin).toString();
}

function issuerFor(request: Request, env: OAuthEnv | undefined): string {
  const configured = env?.AUTH_BASE_URL?.trim();
  if (configured !== undefined && configured !== "") {
    try {
      return new URL(configured).origin;
    } catch {
      // A malformed AUTH_BASE_URL must not make discovery fail; the request
      // origin is always a truthful issuer for this Worker.
    }
  }
  return new URL(request.url).origin;
}

function resourceMetadataUrl(request: Request): string {
  return new URL("/.well-known/oauth-protected-resource", new URL(request.url).origin).toString();
}

/** RFC 9728 §2: what this resource is, and how to present a token to it. */
export function protectedResourceMetadata(request: Request, env?: OAuthEnv): Record<string, unknown> {
  return {
    resource: mcpResourceUrl(request),
    authorization_servers: [issuerFor(request, env)],
    bearer_methods_supported: ["header"],
    resource_documentation: new URL("/docs/mcp", new URL(request.url).origin).toString(),
  };
}

/**
 * RFC 8414: what this issuer can do.
 *
 * No endpoint URLs are present because none exist (see the module comment).
 */
export function authorizationServerMetadata(request: Request, env?: OAuthEnv): Record<string, unknown> {
  return {
    issuer: issuerFor(request, env),
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    // A static bearer token is the credential this deployment accepts. The
    // client is told so rather than left to infer it from a 401.
    bearer_methods_supported: ["header"],
  };
}

const NO_STORE = { "Cache-Control": "public, max-age=300" } as const;

/**
 * Serve `/.well-known/*`.
 *
 * Returns 404 with a JSON body for any other well-known path, so the route
 * lane can mount this on the prefix without a second predicate.
 */
export async function handleWellKnown(request: Request, env?: OAuthEnv): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return Response.json(
      { error: "method_not_allowed", message: "well-known metadata is read-only" },
      { status: 405, headers: { ...NO_STORE, Allow: "GET, HEAD" } }
    );
  }

  const pathname = new URL(request.url).pathname.replace(/\/+$/, "");

  if (pathname === "/.well-known/oauth-protected-resource") {
    return Response.json(protectedResourceMetadata(request, env), { status: 200, headers: NO_STORE });
  }
  if (pathname === "/.well-known/oauth-authorization-server") {
    return Response.json(authorizationServerMetadata(request, env), { status: 200, headers: NO_STORE });
  }

  return Response.json(
    { error: "not_found", message: "no metadata at this well-known path" },
    { status: 404, headers: NO_STORE }
  );
}

/* ────────────────────────────── challenges ────────────────────────────── */

/** The `WWW-Authenticate` value for a 401 from this resource (RFC 6750 + 9728). */
export function bearerChallenge(
  request: Request,
  options: { error?: "invalid_token" | "insufficient_scope" | "invalid_request"; description?: string } = {}
): string {
  const parts = ['Bearer realm="dakflare"', `resource_metadata="${resourceMetadataUrl(request)}"`];
  if (options.error !== undefined) {
    parts.push(`error="${options.error}"`);
    if (options.description !== undefined) {
      parts.push(`error_description="${options.description.replace(/"/g, "'")}"`);
    }
  }
  return parts.join(", ");
}

/** The 401 every failed MCP credential gets, with the metadata pointer. */
export function mcpUnauthorized(
  request: Request,
  reason: string,
  error: "invalid_token" | "insufficient_scope" | "invalid_request" = "invalid_token"
): Response {
  return Response.json(
    { error: "unauthorized", message: reason },
    {
      status: 401,
      headers: {
        "WWW-Authenticate": bearerChallenge(request, { error }),
        "Cache-Control": "no-store",
      },
    }
  );
}

function normalizeResource(value: string): string {
  try {
    const url = new URL(value);
    // Trailing slash is the one difference RFC 8707 §2.2 says to ignore.
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return value.replace(/\/+$/, "");
  }
}

/**
 * RFC 8707 audience check. `null` means the token may be used here.
 *
 * `undefined`/`null` is not a failure: an opaque agent token carries no
 * audience, and the resource server's own credential check already ran. A
 * present audience must contain this resource; anything else is a 401 naming
 * the metadata document, so the client can discover what it should have asked
 * for.
 */
export function audienceProblem(
  request: Request,
  audience: string | string[] | undefined | null
): Response | null {
  if (audience === undefined || audience === null) return null;

  const expected = normalizeResource(mcpResourceUrl(request));
  const presented = (Array.isArray(audience) ? audience : [audience]).map(normalizeResource);

  if (presented.some((value) => value === expected)) return null;

  return mcpUnauthorized(
    request,
    `token audience does not include ${mcpResourceUrl(request)}`,
    "invalid_token"
  );
}
