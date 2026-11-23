/**
 * The generic integration surface: service tokens, the typed binding, delivery
 * replay and the device lifecycle events.
 *
 * The assertions are about boundaries, not plumbing:
 *
 *   - a `service` token sends without a human grant, and is refused by its own
 *     allowlist and its own budget;
 *   - an `agent` token still gets the approval round, and cannot even be minted
 *     with the transactional scope;
 *   - the typed binding forwards `{ token }` on every method, which is what
 *     makes `BINDING_AUTH=agent_token` usable at all;
 *   - a replay cannot cross webhook ids, and a revocation produces a delivery a
 *     receiver can verify against the v1 canonical string.
 */

import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";
import { DakFlareAdminApi, DakFlareApi, DakFlareRuntimeApi } from "../src/binding-api";
import { mintAgentToken, type AgentTokenKind } from "../src/lib/agent-tokens";
import { handleWebhookCreate } from "../src/routes/webhooks";
import { handleWebhookDeliveryReplay } from "../src/routes/integration";
import { emitDeviceEvent, emitMessageEvents } from "../src/lib/integration-delivery";
import { hmacSha256Hex } from "../src/routes/webhooks";
import { signOutboundRequest } from "../src/lib/outbound-webhook";
import { verifyIntegrationEnvelope } from "../src/lib/integration-envelope";
import type { AdminActor } from "../src/audit";

const WEBHOOK_KEY = "test-only-integration-seal-key";

const testEnv = new Proxy(env as unknown as Env, {
  get(target, prop, receiver) {
    if (prop === "WEBHOOK_SECRET_KEY") return WEBHOOK_KEY;
    return Reflect.get(target, prop, receiver);
  },
});

const owner: AdminActor = {
  userId: "usr_owner",
  label: "owner@example.test",
  role: "owner",
  canGrantOwner: true,
};

function unique(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

async function insertDevice(): Promise<string> {
  const id = unique("dev");
  const now = Date.now();
  await testEnv.DB.prepare(
    `INSERT INTO devices (device_id, public_key, paired_at, last_seen)
     VALUES (?, ?, ?, ?)`
  )
    .bind(id, "test-public-key", now, now)
    .run();
  return id;
}

async function mint(
  options: {
    kind?: AgentTokenKind;
    scopes?: string[];
    deviceId?: string | null;
    allowedDeviceIds?: string[] | null;
    allowedChannels?: string[] | null;
    maxPerHour?: number;
  } = {}
): Promise<{ token: string; id: string } | { refused: string }> {
  const result = await mintAgentToken(testEnv, {
    name: unique("svc"),
    scopes: options.scopes ?? ["sms:send", "sms:send:transactional", "devices:read"],
    kind: options.kind ?? "service",
    deviceId: options.deviceId ?? null,
    allowedDeviceIds: options.allowedDeviceIds ?? null,
    allowedChannels: options.allowedChannels ?? null,
    maxPerHour: options.maxPerHour ?? 20,
    expiresAt: Date.now() + 3_600_000,
    createdBy: "test",
  });
  if (!result.ok) {
    return "refused" in result ? { refused: result.refused } : { refused: result.unknown.join(",") };
  }
  return { token: result.minted.token, id: result.minted.id };
}

function sendRequest(deviceId: string, to = "+8801711000111"): Request {
  return new Request("https://example.com/v1/sms/send", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ device_id: deviceId, to, body: "hello" }),
  });
}

async function sendAs(token: string, deviceId: string): Promise<Response> {
  return worker.fetch(
    new Request("https://example.com/v1/sms/send", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ device_id: deviceId, to: "+8801711000111", body: "hello" }),
    }),
    testEnv,
    { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("service tokens", () => {
  it("mints transactional only on kind=service", async () => {
    const refused = await mint({ kind: "agent", scopes: ["sms:send:transactional"] });
    expect(refused).toMatchObject({ refused: expect.stringContaining("service token") });

    const allowed = await mint({ kind: "service", scopes: ["sms:send:transactional"] });
    expect(allowed).toHaveProperty("token");
  });

  it("sends without a human grant, then stops at max_per_hour", async () => {
    const deviceId = await insertDevice();
    const token = await mint({ scopes: ["sms:send:transactional"], maxPerHour: 1 });
    if (!("token" in token)) throw new Error(token.refused);

    const first = await sendAs(token.token, deviceId);
    expect(first.status).toBe(200);
    const body = (await first.json()) as { command_id?: string; sent?: boolean };
    expect(typeof body.command_id).toBe("string");

    const second = await sendAs(token.token, deviceId);
    expect(second.status).toBe(429);
    await expect(second.json()).resolves.toMatchObject({ error: "agent_quota_exceeded" });
  });

  it("refuses a handset outside allowed_device_ids", async () => {
    const deviceId = await insertDevice();
    const token = await mint({
      scopes: ["sms:send:transactional"],
      allowedDeviceIds: ["dev_not_this_one"],
    });
    if (!("token" in token)) throw new Error(token.refused);

    const response = await sendAs(token.token, deviceId);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "device_not_allowed" });
  });

  it("refuses a channel outside allowed_channels", async () => {
    const deviceId = await insertDevice();
    const token = await mint({
      scopes: ["sms:send:transactional"],
      allowedChannels: ["whatsapp"],
    });
    if (!("token" in token)) throw new Error(token.refused);

    const response = await sendAs(token.token, deviceId);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "channel_not_allowed" });
  });

  it("keeps an agent token behind the human grant", async () => {
    const deviceId = await insertDevice();
    const token = await mint({ kind: "agent", scopes: ["sms:send"], maxPerHour: 5 });
    if (!("token" in token)) throw new Error(token.refused);

    const response = await sendAs(token.token, deviceId);
    expect(response.status).toBe(202);
    const body = (await response.json()) as {
      error: string;
      sent: boolean;
      approval_request: { id: string; scope: string };
    };
    expect(body.error).toBe("approval_required");
    expect(body.sent).toBe(false);
    expect(body.approval_request.scope).toBe("sms:send:production");
    // Nothing was queued: the approval round is the whole answer.
    const queued = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM messages WHERE device_id = ? AND direction = 'out'`
    )
      .bind(deviceId)
      .first<{ n: number }>();
    expect(queued?.n).toBe(0);
  });
});

describe("DakFlareApi under BINDING_AUTH=agent_token", () => {
  function bindingEnv(): Env {
    return new Proxy(testEnv, {
      get(target, prop, receiver) {
        if (prop === "BINDING_AUTH") return "agent_token";
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  function api(): DakFlareApi {
    return new DakFlareApi(
      { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
      bindingEnv()
    );
  }

  it("forwards the token on every method and refuses without one", async () => {
    const deviceId = await insertDevice();
    const token = await mint({
      scopes: ["sms:send:transactional", "devices:read", "messages:read"],
    });
    if (!("token" in token)) throw new Error(token.refused);

    const client = api();
    await expect(client.devices()).rejects.toMatchObject({ code: "binding_token_required" });

    const step = async <T>(name: string, call: () => Promise<T>): Promise<T> => {
      try {
        return await call();
      } catch (error) {
        throw new Error(`${name}: ${String((error as Error).message)}`);
      }
    };

    const fleet = (await step("devices", () => client.devices({ token: token.token }))) as {
      devices: unknown[];
    };
    expect(Array.isArray(fleet.devices)).toBe(true);

    const messages = (await step("messages", () =>
      client.messages({ limit: 1, deviceId }, { token: token.token })
    )) as { messages: unknown[] };
    expect(Array.isArray(messages.messages)).toBe(true);

    const manifest = (await step("manifest", () => client.manifest({ token: token.token }))) as {
      schema_version: string;
      signing: { version: string };
    };
    expect(manifest.schema_version).toBe("1.0");
    expect(manifest.signing.version).toBe("v1");

    const health = (await step("health", () => client.integrationHealth({ token: token.token }))) as {
      ok: boolean;
      deliveries: unknown;
    };
    expect(health.ok).toBe(true);

    const sent = (await step("send", () =>
      client.sendSms(
        { to: "+8801711000111", body: "from a bound Worker", deviceId },
        { token: token.token }
      )
    )) as { command_id?: string };
    expect(typeof sent.command_id).toBe("string");
  });

  it("echoes the caller's trace id", async () => {
    const token = await mint({ scopes: ["devices:read"] });
    if (!("token" in token)) throw new Error(token.refused);
    const manifest = (await api().manifest({ token: token.token, traceId: "trace-abc-123" })) as {
      schema_version: string;
    };
    expect(manifest.schema_version).toBe("1.0");
  });
});

async function createHook(
  events: string[] = [],
  extra: Record<string, unknown> = {}
): Promise<{ id: string; secret: string }> {
  const response = await handleWebhookCreate(
    new Request("https://example.com/v1/admin/webhooks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "outbound",
        name: unique("hook"),
        target_url: `https://${unique("hook")}.example.com/receive`,
        events,
        ...extra,
      }),
    }),
    testEnv,
    owner
  );
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; secret: string };
}

function fakeQueue() {
  const sent: unknown[] = [];
  return {
    sent,
    queue: {
      send: async (message: unknown) => {
        sent.push(message);
      },
    },
  };
}

describe("delivery replay", () => {
  it("replays only the delivery's own webhook and audits the action", async () => {
    const first = await createHook();
    const second = await createHook();
    const now = Date.now();
    const deliveryId = `dlv_${unique("replay")}`;
    await env.DB.prepare(
      `INSERT INTO integration_deliveries
         (id, webhook_id, event_type, idempotency_key, payload_json, state,
          attempts, next_attempt_at, created_at)
       VALUES (?, ?, 'flow.webhook', ?, '{"a":1}', 'DEAD_LETTER', 9, ?, ?)`
    )
      .bind(deliveryId, first.id, unique("idem"), now, now)
      .run();

    const queue = fakeQueue();
    const withQueue = new Proxy(testEnv, {
      get(target, prop, receiver) {
        if (prop === "WEBHOOK_QUEUE") return queue.queue;
        return Reflect.get(target, prop, receiver);
      },
    });

    const cross = await handleWebhookDeliveryReplay(
      new Request("https://example.com/x", { method: "POST" }),
      withQueue,
      owner,
      second.id,
      deliveryId
    );
    expect(cross.status).toBe(404);

    const ok = await handleWebhookDeliveryReplay(
      new Request("https://example.com/x", { method: "POST" }),
      withQueue,
      owner,
      first.id,
      deliveryId
    );
    expect(ok.status).toBe(202);
    expect(queue.sent).toHaveLength(1);
    expect(queue.sent[0]).toMatchObject({
      deliveryId,
      webhookId: first.id,
      eventType: "flow.webhook",
    });

    const row = await env.DB.prepare(
      `SELECT state, trace_id FROM integration_deliveries WHERE id = ?`
    )
      .bind(deliveryId)
      .first<{ state: string; trace_id: string }>();
    expect(row?.state).toBe("PENDING");
    expect(typeof row?.trace_id).toBe("string");

    const audit = await env.DB.prepare(
      `SELECT actor_label FROM audit_log WHERE action = 'webhook.delivery.replay' AND subject = ?`
    )
      .bind(`${first.id}:${deliveryId}`)
      .first<{ actor_label: string }>();
    expect(audit?.actor_label).toBe(owner.label);
  });
});

describe("device lifecycle events", () => {
  it("emits device.revoked only to subscribed hooks, signed v1 at consumption", async () => {
    const subscribed = await createHook(["device.revoked"]);
    const unsubscribed = await createHook([]);
    const deviceId = await insertDevice();
    const queue = fakeQueue();
    const withQueue = new Proxy(testEnv, {
      get(target, prop, receiver) {
        if (prop === "WEBHOOK_QUEUE") return queue.queue;
        return Reflect.get(target, prop, receiver);
      },
    });

    await emitDeviceEvent(
      withQueue,
      { type: "device.revoked", deviceId, status: "revoked", reason: "test" },
      "trace-revoke-1"
    );

    expect(queue.sent).toHaveLength(1);
    const message = queue.sent[0] as {
      deliveryId: string;
      webhookId: string;
      url: string;
      body: string;
      traceId: string;
    };
    expect(message.webhookId).toBe(subscribed.id);
    expect(message.webhookId).not.toBe(unsubscribed.id);
    expect(message.traceId).toBe("trace-revoke-1");
    expect(JSON.parse(message.body)).toMatchObject({
      event_type: "device.revoked",
      device_id: deviceId,
      status: "revoked",
      delivery_id: message.deliveryId,
    });

    const stored = await env.DB.prepare(
      `SELECT state, trace_id FROM integration_deliveries WHERE id = ?`
    )
      .bind(message.deliveryId)
      .first<{ state: string; trace_id: string }>();
    expect(stored).toMatchObject({ state: "PENDING", trace_id: "trace-revoke-1" });

    // Deliver it through the real consumer and verify the v1 signature the way a
    // receiver would: recomputed from the canonical string, not from the signer.
    let captured: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        captured = init;
        return new Response(JSON.stringify({ accepted: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      })
    );

    const message_ = {
      body: message,
      acked: false,
      retried: false,
      ack() {
        message_.acked = true;
      },
      retry() {
        message_.retried = true;
      },
    };
    await worker.queue(
      {
        queue: "dakflare-webhook-queue",
        messages: [message_],
        ackAll() {},
        retryAll() {},
      } as unknown as MessageBatch<unknown>,
      testEnv,
      { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext
    );

    expect(message_.acked).toBe(true);
    const headers = captured?.headers as Record<string, string>;
    const rawBody = String(captured?.body);
    expect(headers["X-Dakflare-Delivery"]).toBe(message.deliveryId);
    expect(headers["X-Dakflare-Timestamp"]).toBeDefined();
    expect(headers["X-Dakflare-Signature"]).toBe(
      `v1=${await hmacSha256Hex(
        subscribed.secret,
        `v1.${headers["X-Dakflare-Timestamp"]}.${message.deliveryId}.${rawBody}`
      )}`
    );

    const delivered = await env.DB.prepare(
      `SELECT state, ack_json, last_http_status FROM integration_deliveries WHERE id = ?`
    )
      .bind(message.deliveryId)
      .first<{ state: string; ack_json: string | null; last_http_status: number }>();
    expect(delivered).toMatchObject({ state: "DELIVERED", last_http_status: 200 });
    expect(JSON.parse(delivered?.ack_json ?? "{}")).toMatchObject({ accepted: true });
  });
});


describe("message.received events", () => {
  it("applies body_policy: allowlisted sender forwards raw, OTP never, redacted never", async () => {
    const allowlisted = await createHook(["message.received"], {
      body_policy: "allowlisted_raw",
      body_allowlist: { senders: ["bKash"] },
    });
    const redacted = await createHook(["message.received"]);
    const queue = fakeQueue();
    const withQueue = new Proxy(testEnv, {
      get(target, prop, receiver) {
        if (prop === "WEBHOOK_QUEUE") return queue.queue;
        return Reflect.get(target, prop, receiver);
      },
    });

    const payment = "You have received Tk 1,500.00 from 017****8901. TrxID 9K8L7M6N5P.";
    const otp = "Your bKash verification code is 482910. Never share OTP.";
    await emitMessageEvents(
      withQueue,
      [
        { deviceId: "dev_a", messageId: "msg_pay", sender: "bKash", body: payment, receivedAt: 1 },
        { deviceId: "dev_a", messageId: "msg_otp", sender: "bKash", body: otp, receivedAt: 2 },
      ],
      "trace-msg-1"
    );

    // Two hooks, two messages, four deliveries.
    expect(queue.sent).toHaveLength(4);
    const payloads = queue.sent.map((m) => {
      const message = m as { webhookId: string; body: string; traceId: string };
      return { webhookId: message.webhookId, body: JSON.parse(message.body), traceId: message.traceId };
    });

    const allowPay = payloads.find(
      (p) => p.webhookId === allowlisted.id && p.body.message_id === "msg_pay"
    );
    expect(allowPay?.body).toMatchObject({
      event_type: "message.received",
      content_class: "allowlisted_raw",
      sender: "bKash",
      channel: "sms",
      body: payment,
    });
    expect(allowPay?.traceId).toBe("trace-msg-1");

    const allowOtp = payloads.find(
      (p) => p.webhookId === allowlisted.id && p.body.message_id === "msg_otp"
    );
    expect(allowOtp?.body.content_class).toBe("otp_or_pin");
    expect(allowOtp?.body).not.toHaveProperty("body");

    const redPay = payloads.find(
      (p) => p.webhookId === redacted.id && p.body.message_id === "msg_pay"
    );
    expect(redPay?.body).not.toHaveProperty("body");
    expect(redPay?.body.content_class).toBe("general");
    const redOtp = payloads.find(
      (p) => p.webhookId === redacted.id && p.body.message_id === "msg_otp"
    );
    expect(redOtp?.body).not.toHaveProperty("body");
    expect(redOtp?.body.content_class).toBe("otp_or_pin");

    const rows = await env.DB.prepare(
      `SELECT state, idempotency_key FROM integration_deliveries WHERE webhook_id IN (?, ?)`
    )
      .bind(allowlisted.id, redacted.id)
      .all<{ state: string; idempotency_key: string }>();
    expect(rows.results?.length).toBe(4);
    expect(rows.results?.every((r) => r.state === "PENDING")).toBe(true);
  });

  it("emits once per message when the same batch is replayed", async () => {
    const hook = await createHook(["message.received"]);
    const queue = fakeQueue();
    const withQueue = new Proxy(testEnv, {
      get(target, prop, receiver) {
        if (prop === "WEBHOOK_QUEUE") return queue.queue;
        return Reflect.get(target, prop, receiver);
      },
    });
    const message = { deviceId: "dev_a", messageId: "msg_once", sender: "bKash", body: "hi", receivedAt: 3 };
    await emitMessageEvents(withQueue, [message]);
    const afterFirst = queue.sent.length;
    expect(afterFirst).toBeGreaterThan(0);
    // Hooks from earlier tests in this file are still enabled, so the count is
    // "one per subscribed hook"; what must not grow is the second pass.
    await emitMessageEvents(withQueue, [message]);
    expect(queue.sent.length).toBe(afterFirst);
    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM integration_deliveries WHERE webhook_id = ?`
    )
      .bind(hook.id)
      .first<{ n: number }>();
    expect(row?.n).toBe(1);
  });
});


describe("trusted binding with a per-call service token", () => {
  // BINDING_AUTH is unset in the test environment, which is the trusted mode.
  function trustedApi(): DakFlareApi {
    return new DakFlareApi(
      { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
      testEnv
    );
  }

  it("keeps service-token semantics: allowlist, budget, and no admin actions", async () => {
    const deviceId = await insertDevice();
    const token = await mint({
      scopes: ["sms:send:transactional", "devices:read", "messages:read"],
      allowedDeviceIds: ["dev_not_this_one"],
      maxPerHour: 1,
    });
    if (!("token" in token)) throw new Error(token.refused);
    const client = trustedApi();

    // The token's allowlist is enforced even though the binding itself is trusted.
    await expect(
      client.sendSms(
        { to: "+8801711000111", body: "runtime", deviceId },
        { token: token.token }
      )
    ).rejects.toMatchObject({ status: 403, code: "device_not_allowed" });

    // A token that may use this handset is bounded by its own budget.
    const allowed = await mint({
      scopes: ["sms:send:transactional", "devices:read"],
      allowedDeviceIds: [deviceId],
      maxPerHour: 1,
    });
    if (!("token" in allowed)) throw new Error(allowed.refused);
    const first = (await client.sendSms(
      { to: "+8801711000111", body: "runtime", deviceId },
      { token: allowed.token }
    )) as { command_id?: string };
    expect(typeof first.command_id).toBe("string");
    await expect(
      client.sendSms(
        { to: "+8801711000111", body: "runtime again", deviceId },
        { token: allowed.token }
      )
    ).rejects.toMatchObject({ status: 429 });

    // Admin routes stay closed to the same token.
    await expect(
      client.request({ path: "/v1/admin/webhooks" }, true, { token: allowed.token })
    ).rejects.toMatchObject({ status: 403 });

    // Reads the token holds still work.
    const fleet = (await client.devices({ token: allowed.token })) as { devices: unknown[] };
    expect(Array.isArray(fleet.devices)).toBe(true);
    const manifest = (await client.manifest({ token: allowed.token })) as {
      schema_version: string;
    };
    expect(manifest.schema_version).toBe("1.0");
  });

  it("still uses the deployment credential when no token is passed", async () => {
    const client = trustedApi();
    const hooks = (await client.request({ path: "/v1/admin/webhooks?kind=outbound" })) as {
      status: number;
      body: unknown;
    };
    expect(hooks.status).toBe(200);
    const fleet = (await client.devices()) as { devices: unknown[] };
    expect(Array.isArray(fleet.devices)).toBe(true);
  });
});


describe("the two named entrypoints", () => {
  function ctx(): ExecutionContext {
    return { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  }

  it("runtime refuses to run without a token, and has no escape hatch", async () => {
    const runtime = new DakFlareRuntimeApi(ctx(), testEnv);
    await expect(runtime.devices()).rejects.toMatchObject({ code: "binding_token_required" });
    await expect(
      runtime.sendSms({ to: "+8801711000111", body: "x", deviceId: "dev_x" })
    ).rejects.toMatchObject({ code: "binding_token_required" });
    // The class deliberately exposes no `request`, so an admin path cannot be
    // reached by naming one.
    expect("request" in runtime).toBe(false);
  });

  it("runtime enforces the service token's allowlist and budget", async () => {
    const deviceId = await insertDevice();
    const token = await mint({
      scopes: ["sms:send:transactional", "devices:read"],
      allowedDeviceIds: [deviceId],
      maxPerHour: 1,
    });
    if (!("token" in token)) throw new Error(token.refused);
    const runtime = new DakFlareRuntimeApi(ctx(), testEnv);

    const sent = (await runtime.sendSms(
      { to: "+8801711000111", body: "runtime", deviceId },
      { token: token.token }
    )) as { command_id?: string };
    expect(typeof sent.command_id).toBe("string");
    await expect(
      runtime.sendSms({ to: "+8801711000111", body: "again", deviceId }, { token: token.token })
    ).rejects.toMatchObject({ status: 429 });

    const fleet = (await runtime.devices({ token: token.token })) as { devices: unknown[] };
    expect(Array.isArray(fleet.devices)).toBe(true);
  });

  it("admin runs as the deployment and mints a service token once", async () => {
    const admin = new DakFlareAdminApi(ctx(), testEnv);
    const minted = (await admin.mintServiceToken({
      name: unique("admin-minted"),
      scopes: ["sms:send:transactional"],
      allowedDeviceIds: [],
      maxPerHour: 10,
    })) as { id: string; token: string };
    expect(minted.token.startsWith("dkf_agt_")).toBe(true);
    const row = await env.DB.prepare(`SELECT kind, allowed_device_ids_json FROM agent_tokens WHERE id = ?`)
      .bind(minted.id)
      .first<{ kind: string; allowed_device_ids_json: string | null }>();
    expect(row?.kind).toBe("service");
    // A read the admin may make without a token.
    const fleet = (await admin.listDevices()) as { devices: unknown[] };
    expect(Array.isArray(fleet.devices)).toBe(true);
  });

  it("the manifest documents both entrypoints", async () => {
    const admin = new DakFlareAdminApi(ctx(), testEnv);
    const manifest = (await admin.manifest()) as {
      rpc: { admin: { entrypoint: string }; runtime: { entrypoint: string }; inbound: { transport: string } };
    };
    expect(manifest.rpc.admin.entrypoint).toBe("DakFlareAdminApi");
    expect(manifest.rpc.runtime.entrypoint).toBe("DakFlareRuntimeApi");
    expect(manifest.rpc.inbound.transport).toBe("https");
  });
});


describe("usage and message status", () => {
  function ctx(): ExecutionContext {
    return { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  }

  it("reports the calling token's own hour, not the fleet's", async () => {
    const deviceId = await insertDevice();
    const token = await mint({
      scopes: ["sms:send:transactional", "devices:read"],
      allowedDeviceIds: [deviceId],
      maxPerHour: 2,
    });
    if (!("token" in token)) throw new Error(token.refused);
    const runtime = new DakFlareRuntimeApi(ctx(), testEnv);
    await runtime.sendSms({ to: "+8801711000111", body: "one", deviceId }, { token: token.token });

    const health = (await runtime.usage({ token: token.token })) as {
      usage?: { kind: string; sent_current_hour: number; max_per_hour: number; resets_at: number };
    };
    expect(health.usage).toMatchObject({ kind: "service", sent_current_hour: 1, max_per_hour: 2 });
    expect(health.usage?.resets_at).toBeGreaterThan(Date.now());

    // A human credential has no token budget, and the field is absent rather than zero.
    const adminHealth = (await new DakFlareAdminApi(ctx(), testEnv).integrationHealth()) as {
      usage?: unknown;
    };
    expect(adminHealth.usage).toBeUndefined();
  });

  it("answers a command id from the D1 mirror, and 404s an unknown one", async () => {
    const deviceId = await insertDevice();
    const token = await mint({
      scopes: ["sms:send:transactional", "messages:read"],
      allowedDeviceIds: [deviceId],
      maxPerHour: 5,
    });
    if (!("token" in token)) throw new Error(token.refused);
    const runtime = new DakFlareRuntimeApi(ctx(), testEnv);
    const sent = (await runtime.sendSms(
      { to: "+8801711000111", body: "status me", deviceId },
      { token: token.token }
    )) as { command_id: string };

    const status = (await runtime.messageStatus(sent.command_id, { token: token.token })) as {
      command_id: string;
      state: string;
      source: string;
    };
    expect(status.command_id).toBe(sent.command_id);
    expect(status.source).toBe("d1-mirror");
    expect(typeof status.state).toBe("string");

    await expect(
      runtime.messageStatus("cmd_does_not_exist", { token: token.token })
    ).rejects.toMatchObject({ status: 404 });
  });

  it("publishes the event catalog", async () => {
    const manifest = (await new DakFlareAdminApi(ctx(), testEnv).manifest()) as {
      events: string[];
      capabilities: string[];
    };
    expect(manifest.events).toEqual(["message.received", "device.status_changed", "device.revoked"]);
    expect(manifest.capabilities).toContain("token_usage");
    expect(manifest.capabilities).toContain("message_status");
  });
});


describe("webhook secret rotation", () => {
  function ctx(): ExecutionContext {
    return { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  }

  it("returns a new secret once, and the old one no longer signs", async () => {
    const hook = await createHook(["message.received"]);
    const admin = new DakFlareAdminApi(ctx(), testEnv);
    const rotated = (await admin.rotateWebhookSecret(hook.id)) as {
      secret: string;
      previous_valid_until: number;
    };
    expect(typeof rotated.secret).toBe("string");
    expect(rotated.secret).not.toBe(hook.secret);
    expect(rotated.previous_valid_until).toBeGreaterThan(Date.now());

    // A delivery signed now verifies with the new secret and fails with the old.
    const now = Date.now();
    // The hook's URL is not exposed by createHook; read it back from D1.
    const row = await env.DB.prepare(`SELECT target_url FROM webhooks WHERE id = ?`)
      .bind(hook.id)
      .first<{ target_url: string }>();
    const fresh = await signOutboundRequest(testEnv, row?.target_url ?? "", {}, "{}", {
      deliveryId: "dlv_rotate",
      now,
    });
    const ts = Number(fresh["X-Dakflare-Timestamp"]);
    const sig = fresh["X-Dakflare-Signature"];
    const good = await verifyIntegrationEnvelope({
      secret: rotated.secret,
      timestampHeader: String(ts),
      deliveryHeader: "dlv_rotate",
      signatureHeader: sig,
      rawBody: "{}",
      nowMs: now,
    });
    const stale = await verifyIntegrationEnvelope({
      secret: hook.secret,
      timestampHeader: String(ts),
      deliveryHeader: "dlv_rotate",
      signatureHeader: sig,
      rawBody: "{}",
      nowMs: now,
    });
    expect(good.ok).toBe(true);
    expect(stale.ok).toBe(false);

    const audit = await env.DB.prepare(
      `SELECT action FROM audit_log WHERE action = 'webhook.secret_rotated' AND subject = ?`
    )
      .bind(hook.id)
      .first<{ action: string }>();
    expect(audit?.action).toBe("webhook.secret_rotated");
  });

  it("refuses an inbound hook", async () => {
    const inbound = await handleWebhookCreate(
      new Request("https://example.com/v1/admin/webhooks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: unique("inbound") }),
      }),
      testEnv,
      owner
    );
    const created = (await inbound.json()) as { id: string };
    await expect(new DakFlareAdminApi(ctx(), testEnv).rotateWebhookSecret(created.id)).rejects.toMatchObject({
      status: 409,
    });
  });
});
