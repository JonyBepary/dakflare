import { WorkerEntrypoint } from "cloudflare:workers";
import { BindingError, readBindingAuth, type BindingRequestInput, type BindingResponse } from "./binding";
import { HEADER_TRACE_ID } from "./lib/integration-envelope";
import { handleFetch, type Env } from "./index";

/**
 * The typed worker-to-worker interface. See `src/binding.ts` for the contract and the trust
 * modes; this class is the mechanism.
 *
 * It lives in the entry module because a `WorkerEntrypoint` must be exported from it, and it
 * calls `handleFetch` directly rather than over a binding to itself — same router, same scopes,
 * same limiters, one code path.
 *
 * Every method takes `{ token }`, not just `sendSms`/`ask`. That was the bug this surface fixes:
 * under `BINDING_AUTH=agent_token` the read methods had nowhere to put the credential, so a
 * consumer that chose the least-privilege mode could not read the fleet it was allowed to read.
 *
 * `traceId` is echoed into every call so one integration request is one trace across the caller,
 * this Worker, and — for an outbound webhook it causes — the receiver.
 */
export interface BindingCallOptions {
  /** Required in `agent_token` mode; ignored in `trusted` mode. */
  token?: string;
  /** Correlates the call with the caller's own request. Generated when absent. */
  traceId?: string;
}

export class DakFlareApi extends WorkerEntrypoint<Env> {
  /** `GET /v1/auth/mode` — is the Worker alive, and which auth mode is it in. Needs no credential. */
  async health(options: BindingCallOptions = {}): Promise<unknown> {
    return (await this.#call({ path: "/v1/auth/mode" }, false, options)).body;
  }

  /** `GET /v1/integration/manifest` — capabilities, signing scheme and limits. */
  async manifest(options: BindingCallOptions = {}): Promise<unknown> {
    return (await this.#call({ path: "/v1/integration/manifest" }, true, options)).body;
  }

  /** `GET /v1/integration/health` — database, fleet and delivery-queue health. */
  async integrationHealth(options: BindingCallOptions = {}): Promise<unknown> {
    return (await this.#call({ path: "/v1/integration/health" }, true, options)).body;
  }

  /** Deployment counts and status. `GET /v1/admin/health`. */
  async deployment(options: BindingCallOptions = {}): Promise<unknown> {
    return (await this.#call({ path: "/v1/admin/health" }, true, options)).body;
  }

  /** The paired fleet. `GET /v1/devices`. */
  async devices(options: BindingCallOptions = {}): Promise<unknown> {
    return (await this.#call({ path: "/v1/devices" }, true, options)).body;
  }

  /** The message log. `GET /v1/messages`. */
  async messages(
    query: { limit?: number; deviceId?: string; direction?: string } = {},
    options: BindingCallOptions = {}
  ): Promise<unknown> {
    const params = new URLSearchParams();
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    if (query.deviceId !== undefined) params.set("device_id", query.deviceId);
    if (query.direction !== undefined) params.set("direction", query.direction);
    const suffix = params.toString() === "" ? "" : `?${params.toString()}`;
    return (await this.#call({ path: `/v1/messages${suffix}` }, true, options)).body;
  }

  /** One SMS through the same path a CLI or an agent uses. `POST /v1/sms/send`. */
  async sendSms(
    input: { to: string; body: string; deviceId?: string; idempotencyKey?: string },
    options: BindingCallOptions = {}
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
        },
        true,
        options
      )
    ).body;
  }

  /** One agent turn. `POST /v1/admin/agent/say`. */
  async ask(
    message: string,
    options: BindingCallOptions & { idempotencyKey?: string } = {}
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
        },
        true,
        options
      )
    ).body;
  }

  /**
   * The escape hatch: anything under `/v1`, with the same authentication rules. A route added to
   * the HTTP API is callable here the day it ships, which is the point — the binding surface
   * cannot fall behind.
   */
  async request(
    input: BindingRequestInput,
    needsCredential = true,
    options: BindingCallOptions = {}
  ): Promise<BindingResponse> {
    return this.#call(input, needsCredential, options);
  }

  /**
   * Dispatch through the real router.
   *
   * `needsCredential` is false only for the routes that are public by design (`/v1/auth/mode`),
   * so a health check from a bound Worker does not require the deployment to hold a credential.
   */
  async #call(
    input: BindingRequestInput,
    needsCredential = true,
    options: BindingCallOptions = {}
  ): Promise<BindingResponse> {
    const mode = readBindingAuth(this.env.BINDING_AUTH);
    const headers = new Headers({ "content-type": "application/json", ...(input.headers ?? {}) });
    // The client header is what gives a machine caller its own conversation and its own
    // attachment namespace, so a binding is not silently sharing a transcript with the CLI.
    headers.set("x-dakflare-client", "binding");

    const traceId = options.traceId ?? headers.get(HEADER_TRACE_ID) ?? crypto.randomUUID();
    headers.set(HEADER_TRACE_ID, traceId);

    const token = options.token ?? input.token;
    if (needsCredential) {
      if (mode === "agent_token") {
        if (token === undefined || token === "") {
          throw new BindingError(
            "binding_token_required",
            "BINDING_AUTH=agent_token: pass { token } with a dkf_agt_ token.",
            401
          );
        }
        headers.set("authorization", `Bearer ${token}`);
      } else if (token !== undefined && token !== "") {
        // A trusted caller may deliberately present a weaker credential than the
        // binding's own. That cannot escalate — the caller could already run as
        // the deployment — and it is the only way a runtime send keeps service
        // token semantics: `allowed_device_ids`, `allowed_channels` and the
        // hourly budget live on the token, and a send as ADMIN_TOKEN has none of
        // them. Provisioning and admin calls still use the binding's credential
        // by passing no token.
        headers.set("authorization", `Bearer ${token}`);
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


/**
 * Runtime entrypoint: the surface a business Worker uses for traffic.
 *
 * It has no escape hatch, no admin route and no way to run as the deployment:
 * every method requires the caller's own service token, so `allowed_device_ids`,
 * `allowed_channels` and `max_per_hour` are enforced by the send gate. It
 * delegates to the same router as `DakFlareApi`, which is why error codes and
 * statuses are the HTTP ones.
 */
export class DakFlareRuntimeApi extends WorkerEntrypoint<Env> {
  async manifest(options: BindingCallOptions = {}): Promise<unknown> {
    return this.#inner().manifest(this.#require(options));
  }

  async integrationHealth(options: BindingCallOptions = {}): Promise<unknown> {
    return this.#inner().integrationHealth(this.#require(options));
  }

  async devices(options: BindingCallOptions = {}): Promise<unknown> {
    return this.#inner().devices(this.#require(options));
  }

  async messages(
    query: { limit?: number; deviceId?: string; direction?: string } = {},
    options: BindingCallOptions = {}
  ): Promise<unknown> {
    return this.#inner().messages(query, this.#require(options));
  }

  async sendSms(
    input: { to: string; body: string; deviceId?: string; idempotencyKey?: string },
    options: BindingCallOptions = {}
  ): Promise<unknown> {
    return this.#inner().sendSms(input, this.#require(options));
  }

  /** The token's own hour: sent, limit, reset. */
  async usage(options: BindingCallOptions = {}): Promise<unknown> {
    return this.#inner().integrationHealth(this.#require(options));
  }

  /** One outbound command, by the id `sendSms` returned. */
  async messageStatus(commandId: string, options: BindingCallOptions = {}): Promise<unknown> {
    const { token } = this.#require(options);
    return (
      await this.#inner().request(
        { path: `/v1/integration/messages/${encodeURIComponent(commandId)}` },
        true,
        { token }
      )
    ).body;
  }

  #inner(): DakFlareApi {
    return new DakFlareApi(
      this.ctx as unknown as ExecutionContext,
      this.env
    );
  }

  #require(options: BindingCallOptions): BindingCallOptions {
    if (options.token === undefined || options.token === "") {
      throw new BindingError(
        "binding_token_required",
        "DakFlareRuntimeApi requires { token }: a service token with sms:send:transactional " +
          "and the scopes the call needs. There is no admin credential on this path.",
        401
      );
    }
    return options;
  }
}

/**
 * Admin entrypoint: provisioning, inspection and replay.
 *
 * It runs as the deployment, so it exists only for a caller in the same account
 * that is trusted with provisioning. It is the one place that can mint a service
 * token or create a webhook, and it refuses to run when the deployment is in
 * `agent_token` mode — an admin path with no admin credential is a
 * misconfiguration, not a fallback.
 */
export class DakFlareAdminApi extends WorkerEntrypoint<Env> {
  async manifest(): Promise<unknown> {
    return this.#inner().manifest();
  }

  async integrationHealth(): Promise<unknown> {
    return this.#inner().integrationHealth();
  }

  async listDevices(): Promise<unknown> {
    return this.#inner().devices();
  }

  /** Mint a service token. The value is returned once and cannot be read back. */
  async mintServiceToken(input: {
    name: string;
    scopes: string[];
    allowedDeviceIds?: string[];
    allowedChannels?: string[];
    maxPerHour: number;
    expiresInS?: number;
  }): Promise<unknown> {
    return (
      await this.#inner().request({
        path: "/v1/admin/agent-tokens",
        method: "POST",
        body: {
          name: input.name,
          kind: "service",
          scopes: input.scopes,
          ...(input.allowedDeviceIds === undefined
            ? {}
            : { allowed_device_ids: input.allowedDeviceIds }),
          ...(input.allowedChannels === undefined
            ? {}
            : { allowed_channels: input.allowedChannels }),
          max_per_hour: input.maxPerHour,
          ...(input.expiresInS === undefined ? {} : { expires_in_s: input.expiresInS }),
        },
      })
    ).body;
  }

  /** Create an outbound hook. The signing secret is returned once. */
  async createWebhook(input: {
    name: string;
    targetUrl: string;
    events?: string[];
    bodyPolicy?: "redacted" | "allowlisted_raw" | "full";
    bodyAllowlist?: { senders?: string[]; bodyPatterns?: string[] };
    signingKeyId?: string;
    timeoutMs?: number;
    maxAttempts?: number;
    deviceId?: string;
  }): Promise<unknown> {
    return (
      await this.#inner().request({
        path: "/v1/admin/webhooks",
        method: "POST",
        body: {
          kind: "outbound",
          name: input.name,
          target_url: input.targetUrl,
          ...(input.events === undefined ? {} : { events: input.events }),
          ...(input.bodyPolicy === undefined ? {} : { body_policy: input.bodyPolicy }),
          ...(input.bodyAllowlist === undefined ? {} : { body_allowlist: input.bodyAllowlist }),
          ...(input.signingKeyId === undefined ? {} : { signing_key_id: input.signingKeyId }),
          ...(input.timeoutMs === undefined ? {} : { timeout_ms: input.timeoutMs }),
          ...(input.maxAttempts === undefined ? {} : { max_attempts: input.maxAttempts }),
          ...(input.deviceId === undefined ? {} : { device_id: input.deviceId }),
        },
      })
    ).body;
  }

  /** Create or replace a flow. The validator's answer is the route's answer. */
  async putWorkflow(id: string, input: unknown): Promise<unknown> {
    return (
      await this.#inner().request({
        path: `/v1/admin/workflows/${encodeURIComponent(id)}`,
        method: "PUT",
        body: input,
      })
    ).body;
  }

  async listWebhookDeliveries(webhookId: string): Promise<unknown> {
    return (
      await this.#inner().request({
        path: `/v1/admin/webhooks/${encodeURIComponent(webhookId)}/deliveries`,
      })
    ).body;
  }

  async replayDelivery(webhookId: string, deliveryId: string): Promise<unknown> {
    return (
      await this.#inner().request({
        path: `/v1/webhooks/${encodeURIComponent(webhookId)}/deliveries/${encodeURIComponent(deliveryId)}/replay`,
        method: "POST",
      })
    ).body;
  }

  /** Escape hatch for admin routes that do not have a typed method yet. */
  async request(input: BindingRequestInput): Promise<BindingResponse> {
    return this.#inner().request(input);
  }

  #inner(): DakFlareApi {
    if (readBindingAuth(this.env.BINDING_AUTH) !== "trusted") {
      throw new BindingError(
        "binding_untrusted",
        "DakFlareAdminApi needs BINDING_AUTH=trusted: it runs as the deployment. " +
          "Use DakFlareRuntimeApi with a service token for traffic.",
        503
      );
    }
    return new DakFlareApi(this.ctx as unknown as ExecutionContext, this.env);
  }
}
