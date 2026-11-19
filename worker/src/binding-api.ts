import { WorkerEntrypoint } from "cloudflare:workers";
import { BindingError, readBindingAuth, type BindingRequestInput, type BindingResponse } from "./binding";
import { handleFetch, type Env } from "./index";

/**
 * The typed worker-to-worker interface. See `src/binding.ts` for the contract and the trust
 * modes; this class is the mechanism.
 *
 * It lives in the entry module because a `WorkerEntrypoint` must be exported from it, and it
 * calls `handleFetch` directly rather than over a binding to itself — same router, same scopes,
 * same limiters, one code path.
 */
export class DakFlareApi extends WorkerEntrypoint<Env> {
  /** `GET /v1/auth/mode` — is the Worker alive, and which auth mode is it in. Needs no credential. */
  async health(): Promise<unknown> {
    return (await this.#call({ path: "/v1/auth/mode" }, false)).body;
  }

  /** Deployment counts and status. `GET /v1/admin/health`. */
  async deployment(): Promise<unknown> {
    return (await this.#call({ path: "/v1/admin/health" }, true)).body;
  }

  /** The paired fleet. `GET /v1/devices`. */
  async devices(): Promise<unknown> {
    return (await this.#call({ path: "/v1/devices" }, true)).body;
  }

  /** The message log. `GET /v1/messages`. */
  async messages(query: { limit?: number; deviceId?: string; direction?: string } = {}): Promise<unknown> {
    const params = new URLSearchParams();
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    if (query.deviceId !== undefined) params.set("device_id", query.deviceId);
    if (query.direction !== undefined) params.set("direction", query.direction);
    const suffix = params.toString() === "" ? "" : `?${params.toString()}`;
    return (await this.#call({ path: `/v1/messages${suffix}` }, true)).body;
  }

  /** One SMS through the same path a CLI or an agent uses. `POST /v1/sms/send`. */
  async sendSms(
    input: { to: string; body: string; deviceId?: string; idempotencyKey?: string },
    options: { token?: string } = {}
  ): Promise<unknown> {
    return (
      await this.#call(
        {
          path: "/v1/sms/send",
          method: "POST",
          body: {
            to: input.to,
            body: input.body,
            ...(input.deviceId === undefined ? {} : { device_id: input.deviceId }),
            ...(input.idempotencyKey === undefined ? {} : { idempotency_key: input.idempotencyKey }),
          },
          ...(options.token === undefined ? {} : { token: options.token }),
        },
        true
      )
    ).body;
  }

  /** One agent turn. `POST /v1/admin/agent/say`. */
  async ask(
    message: string,
    options: { idempotencyKey?: string; token?: string } = {}
  ): Promise<unknown> {
    return (
      await this.#call(
        {
          path: "/v1/admin/agent/say",
          method: "POST",
          body: {
            message,
            ...(options.idempotencyKey === undefined ? {} : { idempotencyKey: options.idempotencyKey }),
          },
          ...(options.token === undefined ? {} : { token: options.token }),
        },
        true
      )
    ).body;
  }

  /**
   * The escape hatch: anything under `/v1`, with the same authentication rules. A route added to
   * the HTTP API is callable here the day it ships, which is the point — the binding surface
   * cannot fall behind.
   */
  async request(input: BindingRequestInput, needsCredential = true): Promise<BindingResponse> {
    return this.#call(input, needsCredential);
  }

  /**
   * Dispatch through the real router.
   *
   * `needsCredential` is false only for the routes that are public by design (`/v1/auth/mode`),
   * so a health check from a bound Worker does not require the deployment to hold a credential.
   */
  async #call(input: BindingRequestInput, needsCredential = true): Promise<BindingResponse> {
    const mode = readBindingAuth(this.env.BINDING_AUTH);
    const headers = new Headers({ "content-type": "application/json", ...(input.headers ?? {}) });
    // The client header is what gives a machine caller its own conversation and its own
    // attachment namespace, so a binding is not silently sharing a transcript with the CLI.
    headers.set("x-dakflare-client", "binding");

    if (needsCredential) {
      if (mode === "agent_token") {
        if (input.token === undefined || input.token === "") {
          throw new BindingError(
            "binding_token_required",
            "BINDING_AUTH=agent_token: pass { token } with a dkf_agt_ token.",
            401
          );
        }
        headers.set("authorization", `Bearer ${input.token}`);
      } else {
        const adminToken = this.env.ADMIN_TOKEN;
        if (adminToken === undefined || adminToken === "") {
          throw new BindingError(
            "binding_untrusted",
            "BINDING_AUTH=trusted but the deployment has no ADMIN_TOKEN, so a bound Worker " +
              "cannot be given the machine identity. Set ADMIN_TOKEN, or BINDING_AUTH=agent_token.",
            503
          );
        }
        headers.set("authorization", `Bearer ${adminToken}`);
      }
    }

    const body =
      input.body === undefined
        ? undefined
        : typeof input.body === "string"
          ? input.body
          : JSON.stringify(input.body);

    const request = new Request(`https://binding.internal${input.path}`, {
      method: (input.method ?? "GET").toUpperCase(),
      headers,
      ...(body === undefined ? {} : { body }),
    });

    const response = await handleFetch(request, this.env, this.ctx as unknown as ExecutionContext);
    const bookmark = response.headers.get("x-d1-bookmark");
    const text = await response.text();

    let parsed: unknown = text;
    try {
      parsed = text === "" ? null : JSON.parse(text);
    } catch {
      // A non-JSON answer (the console shell, a redirect) is returned as text rather than thrown.
    }

    if (response.status >= 400) {
      const shape = parsed as { error?: unknown; message?: unknown } | null;
      throw new BindingError(
        typeof shape?.error === "string" ? shape.error : "binding_call_failed",
        typeof shape?.message === "string" ? shape.message : `the route answered ${response.status}`,
        response.status
      );
    }

    return { status: response.status, body: parsed, bookmark };
  }
}
