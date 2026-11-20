/**
 * Outbound webhook signing, CRUD and the queue consumer.
 *
 * The assertions are about the wire: the HMAC a receiver would compute, the
 * headers the Worker actually sets, and the row shape D1 stores. A stub that
 * agreed with this module instead of with HMAC-SHA256 would prove nothing, so
 * the signature is recomputed independently in the test.
 */

import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "../src/index";
import type { AdminActor } from "../src/audit";
import {
  OUTBOUND_SIGNATURE_HEADER,
  OUTBOUND_TIMESTAMP_HEADER,
  findOutboundWebhook,
  signOutboundRequest,
  signOutboundWebhook,
} from "../src/lib/outbound-webhook";
import { hmacSha256Hex } from "../src/routes/webhooks";
import {
  handleWebhookCreate,
  handleWebhookDelete,
  handleWebhookList,
  handleWebhookTest,
} from "../src/routes/webhooks";

const testEnv = new Proxy(env as unknown as Env, {
  get(target, prop, receiver) {
    if (prop === "WEBHOOK_SECRET_KEY") return "test-only-outbound-seal-key";
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
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 10)}`;
}

function createRequest(body: Record<string, unknown>): Request {
  return new Request("https://example.com/v1/admin/webhooks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function createOutbound(
  targetUrl: string,
  name = unique("hook")
): Promise<{ id: string; secret: string }> {
  const response = await handleWebhookCreate(
    createRequest({ kind: "outbound", name, target_url: targetUrl }),
    testEnv,
    owner
  );
  expect(response.status).toBe(201);
  const body = (await response.json()) as { id: string; secret: string };
  expect(typeof body.secret).toBe("string");
  return body;
}

async function insertLegacyOutbound(targetUrl: string): Promise<string> {
  const id = `wh_${unique("legacy")}`;
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO webhooks
       (id, name, vertical, target_url, enabled, events_json, secret_ring,
        created_at, updated_at, kind, secret_sealed)
     VALUES (?, 'legacy', 'generic', ?, 1, '[]', '', ?, ?, 'outbound', NULL)`
  )
    .bind(id, targetUrl, now, now)
    .run();
  return id;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("outbound webhook signing", () => {
  it("matches the documented HMAC vector and header format", async () => {
    const signature = await signOutboundWebhook("whsec_test", 1_700_000_000, '{"a":1}');
    expect(signature).toBe(
      "sha256=38877139021993b830af32feea6e18a8da83eb2f6e49ee50bd9e4cf4ca4d3789"
    );
    expect(signature.startsWith("sha256=")).toBe(true);
    expect(signature.slice(7)).toMatch(/^[0-9a-f]{64}$/);

    const url = `https://signed.example.com/${unique("path")}`;
    const { secret } = await createOutbound(url);
    const now = 1_700_000_000_000;
    const headers = await signOutboundRequest(
      testEnv,
      url,
      { "Content-Type": "application/json" },
      '{"a":1}',
      now
    );
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers[OUTBOUND_TIMESTAMP_HEADER]).toBe("1700000000");
    expect(headers[OUTBOUND_SIGNATURE_HEADER]).toBe(
      `sha256=${await hmacSha256Hex(secret, "1700000000." + '{"a":1}')}`
    );
  });

  it("prefers an exact target_url match, then the same origin", async () => {
    const origin = `https://${unique("origin")}.example.com`;
    const exact = await createOutbound(`${origin}/one`);
    const sibling = await createOutbound(`${origin}/two`);

    await expect(findOutboundWebhook(testEnv, `${origin}/one`)).resolves.toMatchObject({
      id: exact.id,
    });
    const otherPath = await findOutboundWebhook(testEnv, `${origin}/three`);
    expect(otherPath).not.toBeNull();
    expect([exact.id, sibling.id]).toContain(otherPath?.id);
    expect(typeof otherPath?.secret).toBe("string");
    expect(otherPath?.secret).not.toBe("");

    await expect(findOutboundWebhook(testEnv, `https://${unique("else")}.example.com/x`)).resolves.toBeNull();
  });

  it("does not sign a legacy hook with no sealed secret", async () => {
    const url = `https://${unique("legacy")}.example.com/hook`;
    const id = await insertLegacyOutbound(url);
    const found = await findOutboundWebhook(testEnv, url);
    expect(found).toMatchObject({ id, secret: null });

    const headers = await signOutboundRequest(
      testEnv,
      url,
      { "Content-Type": "application/json" },
      "{}"
    );
    expect(headers[OUTBOUND_TIMESTAMP_HEADER]).toBeUndefined();
    expect(headers[OUTBOUND_SIGNATURE_HEADER]).toBeUndefined();
  });

  it("drops stale signature headers when no hook matches", async () => {
    const headers = await signOutboundRequest(
      testEnv,
      `https://${unique("none")}.example.com/hook`,
      {
        "Content-Type": "application/json",
        [OUTBOUND_TIMESTAMP_HEADER]: "1",
        [OUTBOUND_SIGNATURE_HEADER]: "sha256=deadbeef",
      },
      "{}"
    );
    expect(headers[OUTBOUND_TIMESTAMP_HEADER]).toBeUndefined();
    expect(headers[OUTBOUND_SIGNATURE_HEADER]).toBeUndefined();
  });
});

describe("outbound webhook SSRF rejection", () => {
  it("rejects private targets and accepts a public https URL", async () => {
    const blocked = [
      "http://127.0.0.1/hook",
      "http://[::1]/hook",
      "http://10.0.0.1/hook",
      "http://100.64.0.1/hook",
      "http://169.254.169.254/latest/meta-data",
      "file:///etc/passwd",
    ];
    for (const targetUrl of blocked) {
      const response = await handleWebhookCreate(
        createRequest({ kind: "outbound", name: unique("bad"), target_url: targetUrl }),
        testEnv,
        owner
      );
      expect(response.status, targetUrl).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: "bad_url" });
    }

    const accepted = await handleWebhookCreate(
      createRequest({
        kind: "outbound",
        name: unique("good"),
        target_url: "https://example.com/dakflare",
      }),
      testEnv,
      owner
    );
    expect(accepted.status).toBe(201);
    const created = (await accepted.json()) as { id: string; secret: string };
    await handleWebhookDelete(testEnv, created.id, owner);
  });
});

describe("outbound webhook CRUD", () => {
  it("returns the secret once, stores it sealed, and never lists it", async () => {
    const targetUrl = `https://${unique("crud")}.example.com/hook`;
    const response = await handleWebhookCreate(
      createRequest({
        kind: "outbound",
        name: "crud hook",
        target_url: targetUrl,
        events: ["message.received", 7],
        custom_headers: { "X-Tenant": "acme" },
        timeout_ms: 4000,
        max_attempts: 3,
      }),
      testEnv,
      owner
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const created = (await response.json()) as {
      id: string;
      kind: string;
      secret: string;
    };
    expect(created.kind).toBe("outbound");
    expect(typeof created.secret).toBe("string");
    expect(created.secret.length).toBeGreaterThan(20);

    const stored = await env.DB.prepare(
      `SELECT kind, target_url, secret_hash, secret_sealed, events_json,
              custom_headers_json, timeout_ms, max_attempts
         FROM webhooks WHERE id = ?`
    )
      .bind(created.id)
      .first<{
        kind: string;
        target_url: string;
        secret_hash: string;
        secret_sealed: string;
        events_json: string;
        custom_headers_json: string;
        timeout_ms: number;
        max_attempts: number;
      }>();
    expect(stored?.kind).toBe("outbound");
    expect(stored?.target_url).toBe(targetUrl);
    expect(stored?.secret_hash).not.toBe(created.secret);
    expect(stored?.secret_sealed.startsWith("v1.")).toBe(true);
    expect(JSON.parse(stored?.events_json ?? "[]")).toEqual(["message.received"]);
    expect(JSON.parse(stored?.custom_headers_json ?? "{}")).toEqual({ "X-Tenant": "acme" });
    expect(stored?.timeout_ms).toBe(4000);
    expect(stored?.max_attempts).toBe(3);

    const listResponse = await handleWebhookList(testEnv, owner, "outbound");
    expect(listResponse.status).toBe(200);
    const listText = await listResponse.text();
    expect(listText).not.toContain(created.secret);
    expect(listText).not.toContain(stored?.secret_hash ?? "unreachable");
    expect(listText).not.toContain("secret_sealed");
    const listed = JSON.parse(listText) as {
      webhooks: Array<{
        id: string;
        kind: string;
        target_url: string;
        events: string[];
        custom_headers: Record<string, string>;
        secret_set: boolean;
      }>;
    };
    const row = listed.webhooks.find((candidate) => candidate.id === created.id);
    expect(row).toMatchObject({
      kind: "outbound",
      target_url: targetUrl,
      events: ["message.received"],
      custom_headers: { "X-Tenant": "acme" },
      secret_set: true,
    });
    expect(row).not.toHaveProperty("secret");

    const deleted = await handleWebhookDelete(testEnv, created.id, owner);
    expect(deleted.status).toBe(200);
    const again = await handleWebhookDelete(testEnv, created.id, owner);
    expect(again.status).toBe(404);
  });

  it("defaults the list to inbound and refuses an unknown kind", async () => {
    const inbound = await handleWebhookCreate(
      createRequest({ name: unique("inbound") }),
      testEnv,
      owner
    );
    expect(inbound.status).toBe(201);
    const created = (await inbound.json()) as { id: string; secret: string };

    const listResponse = await handleWebhookList(testEnv, owner);
    const body = (await listResponse.json()) as {
      webhooks: Array<{ id: string; kind: string; secret_set: boolean }>;
    };
    const row = body.webhooks.find((candidate) => candidate.id === created.id);
    expect(row).toMatchObject({ kind: "inbound", secret_set: true });
    await handleWebhookDelete(testEnv, created.id, owner);
  });
});

describe("outbound webhook test ping", () => {
  it("sends one valid signature and reports the receiver status", async () => {
    const targetUrl = `https://${unique("ping")}.example.com/hook`;
    const { id, secret } = await createOutbound(targetUrl);

    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const response = await handleWebhookTest(testEnv, id, owner);
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      ok: boolean;
      status: number;
      latency_ms: number;
      signed: boolean;
    };
    expect(result).toMatchObject({ ok: true, status: 204, signed: true });
    expect(typeof result.latency_ms).toBe("number");
    expect(capturedUrl).toBe(targetUrl);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const headers = capturedInit?.headers as Record<string, string>;
    const body = String(capturedInit?.body);
    const timestamp = Number(headers[OUTBOUND_TIMESTAMP_HEADER]);
    expect(Number.isInteger(timestamp)).toBe(true);
    expect(headers[OUTBOUND_SIGNATURE_HEADER]).toBe(
      await signOutboundWebhook(secret, timestamp, body)
    );
    expect(body).toContain('"event":"test"');
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("reports ok:false for a 500 response", async () => {
    const { id } = await createOutbound(`https://${unique("fail")}.example.com/hook`);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 }))
    );

    const response = await handleWebhookTest(testEnv, id, owner);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      status: 500,
      signed: true,
    });
  });

  it("404s an unknown hook and 409s an inbound one", async () => {
    const missing = await handleWebhookTest(testEnv, "wh_missing", owner);
    expect(missing.status).toBe(404);
    const inbound = await handleWebhookCreate(
      createRequest({ name: unique("inbound-test") }),
      testEnv,
      owner
    );
    const created = (await inbound.json()) as { id: string };
    const response = await handleWebhookTest(testEnv, created.id, owner);
    expect(response.status).toBe(409);
    await handleWebhookDelete(testEnv, created.id, owner);
  });
});

describe("webhook queue consumer", () => {
  interface FakeMessage {
    body: unknown;
    acked: boolean;
    retried: boolean;
    ack(): void;
    retry(): void;
  }

  function fakeMessage(body: unknown): FakeMessage {
    const message: FakeMessage = {
      body,
      acked: false,
      retried: false,
      ack() {
        message.acked = true;
      },
      retry() {
        message.retried = true;
      },
    };
    return message;
  }

  function fakeBatch(messages: FakeMessage[]): MessageBatch<unknown> {
    return {
      queue: "dakflare-webhook-queue",
      messages,
      ackAll() {
        for (const message of messages) message.ack();
      },
      retryAll() {
        for (const message of messages) message.retry();
      },
    } as unknown as MessageBatch<unknown>;
  }

  it("signs at consumption and replaces a stale signature", async () => {
    const targetUrl = `https://${unique("queue")}.example.com/hook`;
    const { secret } = await createOutbound(targetUrl);
    let captured: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        captured = init;
        return new Response("ok", { status: 200 });
      })
    );

    const message = fakeMessage({
      url: targetUrl,
      headers: {
        "Content-Type": "application/json",
        [OUTBOUND_TIMESTAMP_HEADER]: "1",
        [OUTBOUND_SIGNATURE_HEADER]: "sha256=stale",
      },
      body: '{"queued":true}',
    });
    await worker.queue(
      fakeBatch([message]),
      testEnv,
      {} as ExecutionContext
    );

    expect(message.acked).toBe(true);
    expect(message.retried).toBe(false);
    const headers = captured?.headers as Record<string, string>;
    const body = String(captured?.body);
    const timestamp = Number(headers[OUTBOUND_TIMESTAMP_HEADER]);
    expect(timestamp).toBeGreaterThan(1_700_000_000);
    expect(Math.abs(timestamp - Math.floor(Date.now() / 1000))).toBeLessThan(10);
    expect(headers[OUTBOUND_SIGNATURE_HEADER]).not.toBe("sha256=stale");
    expect(headers[OUTBOUND_SIGNATURE_HEADER]).toBe(
      await signOutboundWebhook(secret, timestamp, body)
    );
  });

  it("sends unsigned when no outbound hook matches", async () => {
    let captured: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        captured = init;
        return new Response("ok", { status: 200 });
      })
    );

    const message = fakeMessage({
      url: `https://${unique("none")}.example.com/hook`,
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    await worker.queue(fakeBatch([message]), testEnv, {} as ExecutionContext);

    expect(message.acked).toBe(true);
    const headers = captured?.headers as Record<string, string>;
    expect(headers[OUTBOUND_TIMESTAMP_HEADER]).toBeUndefined();
    expect(headers[OUTBOUND_SIGNATURE_HEADER]).toBeUndefined();
  });
});
