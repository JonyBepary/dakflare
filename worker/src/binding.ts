/**
 * The worker-to-worker interface.
 *
 * A second Worker in the same Cloudflare account — or a Cloudflare Workflow, which runs inside
 * one — can bind this script as a service and call a typed method instead of building a
 * `Request` and remembering which header carries the credential:
 *
 *   // consumer config
 *   services: [{ binding: "DAKFLARE", service: "dakflare-worker", entrypoint: "DakFlareApi" }]
 *
 *   // consumer code
 *   const sent = await env.DAKFLARE.sendSms({ to: "+88017…", body: "hello" });
 *
 * Every method delegates to the same router the public API uses (`handleFetch`), with the same
 * scope checks, rate limiters, audit rows and idempotency — this file adds a calling
 * convention, not a second code path. `request()` is the escape hatch that reaches anything
 * under `/v1`, so the surface cannot drift behind the HTTP API.
 *
 * ## Who may act
 *
 * `BINDING_AUTH` decides, read once per call so a deploy changes it without a warm isolate
 * holding the old answer:
 *
 *   trusted      (default) the binding *is* the credential: the call runs as the deployment's
 *                machine identity, exactly like a CLI holding `ADMIN_TOKEN`. This is the mode
 *                that makes `await env.DAKFLARE.sendSms(…)` work with no arguments, and it means
 *                any Worker in the account with this binding can send SMS and spend money.
 *                Choose it when the account is the trust boundary — which, for a single-owner
 *                deployment, it is.
 *   agent_token  the caller passes `{ token }`: a `dkf_agt_` token with a scope set. Reads and
 *                writes are limited by those scopes, and an act (an SMS, a write) additionally
 *                needs a live authority grant, because that is the path the token takes.
 *
 * There is deliberately no third mode where a grant replaces the token: a grant is bound to a
 * token, so "grant without a credential" has no identity to check it against. `agent_token` is
 * that mode — the token names the actor, the grant decides what the actor may do.
 *
 * When `BINDING_AUTH=trusted` but no `ADMIN_TOKEN` exists, every call refuses with
 * `binding_untrusted` rather than silently running unauthenticated: a deployment that removed
 * its machine credential must choose `agent_token`.
 */

import type { ExecutionContext } from "@cloudflare/workers-types";

/** What a caller may pass instead of a credential when the deployment trusts the binding. */
export type BindingAuth = "trusted" | "agent_token";

export interface BindingRequestInput {
  /** An absolute path under `/v1`, e.g. `/v1/messages?limit=5`. */
  path: string;
  /** Defaults to `GET`. */
  method?: string;
  /** JSON body; serialised for you. */
  body?: unknown;
  /** Extra headers. `authorization` is set by the entrypoint, never by the caller. */
  headers?: Record<string, string>;
  /** Required in `agent_token` mode; ignored in `trusted` mode. */
  token?: string;
}

export interface BindingResponse<T = unknown> {
  status: number;
  /** Parsed JSON when the route answered JSON, otherwise the text. */
  body: T;
  /** The D1 bookmark, when the router returned one — useful for a read-your-writes chain. */
  bookmark: string | null;
}

/**
 * The refusal shape every method throws, so a caller can branch on `code` rather than parse a
 * sentence. Thrown, not returned: an RPC method that fails is a rejected promise.
 */
export class BindingError extends Error {
  /** A stable code, so a caller branches on this rather than on the sentence. */
  readonly code: string;
  /** The HTTP status the same route would have answered. */
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "BindingError";
    this.code = code;
    this.status = status;
  }
}

export function readBindingAuth(value: string | undefined): BindingAuth {
  return value === "agent_token" ? "agent_token" : "trusted";
}
