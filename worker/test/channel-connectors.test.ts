/**
 * Channel connector layer: sealing and redaction, human-only administration,
 * Meta signature/challenge handling, DO dedupe, Instagram host switching,
 * Telegram 429 mapping, and the `read` → `delivered` reply-state fold.
 *
 * These run inside the Workers pool because the dedupe assertion needs the real
 * `ChannelConnection` Durable Object and `applyD1Migrations` gives the handlers
 * the real `channel_connectors` table.
 */

import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/index";
import type { AdminActor } from "../src/audit";
import {
  handleMetaChallenge,
  toReplyState,
  verifyMetaWebhookSignature,
} from "../src/channels/meta-common";
import { resolveInstagramApiHost } from "../src/channels/instagram";
import {
  parseTelegramWebhook,
  sendTelegramOutbound,
} from "../src/channels/telegram-connector";
import {
  handleChannelWebhook,
  handleConnectorCreate,
  handleConnectorDelete,
  handleConnectorList,
  handleConnectorUpdate,
  sendConnectorOutbound,
} from "../src/routes/channel-connectors";

/**
 * The pool supplies real bindings but no `WEBHOOK_SECRET_KEY`; the deployment
 * keeps sealing material out of `wrangler.toml`, so the test adds one the same
 * way a secret is supplied at runtime.
 */
const testEnv = new Proxy(env as unknown as Env, {
  get(target, prop, receiver) {
    if (prop === "WEBHOOK_SECRET_KEY") return "test-only-channel-seal-key";
    return Reflect.get(target, prop, receiver);
  },
});

const owner: AdminActor = {
  userId: null,
  label: "test-owner",
  role: "owner",
  canGrantOwner: true,
};

const member: AdminActor = {
  userId: "usr_member",
  label: "member@example.test",
  role: "member",
  canGrantOwner: false,
};

const agent: AdminActor = {
  userId: null,
  label: "agent:dkf_agt_test",
  role: "agent",
  canGrantOwner: false,
  agentTokenId: "agt_test",
};

function unique(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function jsonRequest(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function signMeta(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body)
  );
  const hex = Array.from(new Uint8Array(signature), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  return `sha256=${hex}`;
}

const APP_SECRET = "meta-app-secret-value";

async function createMessengerConnector(): Promise<{ id: string; accountId: string }> {
  const accountId = unique("page");
  const response = await handleConnectorCreate(
    jsonRequest("https://example.com/v1/admin/channel-connectors", {
      channel: "messenger",
      account_id: accountId,
      execution_tier: "worker_do",
      label: "Test Page",
      secret: {
        appSecret: APP_SECRET,
        verifyToken: "verify-token-value",
        accessToken: "page-access-token-value",
      },
    }),
    testEnv,
    owner
  );
  expect(response.status).toBe(201);
  const body = (await response.json()) as { id: string };
  return { id: body.id, accountId };
}

describe("Meta signature verification", () => {
  it("accepts a correct HMAC over the raw bytes", async () => {
    const rawBody = JSON.stringify({ object: "page", entry: [] });
    const request = new Request("https://example.com/hook", {
      method: "POST",
      headers: { "X-Hub-Signature-256": await signMeta(APP_SECRET, rawBody) },
    });
    expect(await verifyMetaWebhookSignature(request, rawBody, APP_SECRET)).toBe(true);
  });

  it("rejects a tampered body", async () => {
    const rawBody = JSON.stringify({ object: "page", entry: [] });
    const request = new Request("https://example.com/hook", {
      method: "POST",
      headers: { "X-Hub-Signature-256": await signMeta(APP_SECRET, rawBody) },
    });
    expect(await verifyMetaWebhookSignature(request, `${rawBody} `, APP_SECRET)).toBe(false);
  });

  it("rejects a missing header", async () => {
    const rawBody = "{}";
    const request = new Request("https://example.com/hook", { method: "POST" });
    expect(await verifyMetaWebhookSignature(request, rawBody, APP_SECRET)).toBe(false);
  });

  it("rejects a non-hex signature", async () => {
    const rawBody = "{}";
    const request = new Request("https://example.com/hook", {
      method: "POST",
      headers: { "X-Hub-Signature-256": `sha256=${"z".repeat(64)}` },
    });
    expect(await verifyMetaWebhookSignature(request, rawBody, APP_SECRET)).toBe(false);
  });
});

describe("Meta subscription challenge", () => {
  it("echoes the challenge only with the right verify token", async () => {
    const url = new URL(
      "https://example.com/hook?hub.mode=subscribe&hub.verify_token=right-token&hub.challenge=424242"
    );

    const good = await handleMetaChallenge(url, "right-token");
    expect(good.status).toBe(200);
    expect(await good.text()).toBe("424242");

    const wrong = await handleMetaChallenge(url, "wrong-token");
    expect(wrong.status).toBe(403);

    const missing = await handleMetaChallenge(url, undefined);
    expect(missing.status).toBe(403);
  });
});

describe("connector administration", () => {
  it("never returns the secret or its hash, in create or list", async () => {
    const response = await handleConnectorCreate(
      jsonRequest("https://example.com/v1/admin/channel-connectors", {
        channel: "messenger",
        account_id: unique("page_secret"),
        label: "Redacted Page",
        secret: {
          appSecret: "super-secret-app-value",
          verifyToken: "super-secret-verify-value",
          accessToken: "super-secret-access-value",
        },
      }),
      testEnv,
      owner
    );
    expect(response.status).toBe(201);

    const text = await response.text();
    expect(text).not.toContain("super-secret-app-value");
    expect(text).not.toContain("super-secret-verify-value");
    expect(text).not.toContain("super-secret-access-value");

    const created = JSON.parse(text) as Record<string, unknown>;
    expect(created.secret_set).toBe(true);
    expect(created).not.toHaveProperty("secret");
    expect(created).not.toHaveProperty("secret_sealed");
    expect(created).not.toHaveProperty("secret_hash");

    const listResponse = await handleConnectorList(testEnv, owner);
    expect(listResponse.status).toBe(200);
    const listText = await listResponse.text();
    expect(listText).not.toContain("super-secret-app-value");
    expect(listText).not.toContain("secret_sealed");
    expect(listText).not.toContain("secret_hash");
  });

  it("refuses member and agent tokens at every admin handler", async () => {
    const { id } = await createMessengerConnector();
    const createBody = {
      channel: "messenger",
      account_id: unique("page_refused"),
      label: "Refused",
      secret: { appSecret: "a", verifyToken: "b", accessToken: "c" },
    };

    for (const actor of [member, agent]) {
      const created = await handleConnectorCreate(
        jsonRequest("https://example.com/v1/admin/channel-connectors", createBody),
        testEnv,
        actor
      );
      expect(created.status).toBe(403);

      const listed = await handleConnectorList(testEnv, actor);
      expect(listed.status).toBe(403);

      const updated = await handleConnectorUpdate(
        jsonRequest("https://example.com/v1/admin/channel-connectors", { label: "x" }),
        testEnv,
        actor,
        id
      );
      expect(updated.status).toBe(403);

      const deleted = await handleConnectorDelete(testEnv, actor, id);
      expect(deleted.status).toBe(403);
    }

    // The owner's connector still exists after every refused delete.
    const stillThere = await handleConnectorList(testEnv, owner);
    const body = (await stillThere.json()) as { connectors: Array<{ id: string }> };
    expect(body.connectors.some((connector) => connector.id === id)).toBe(true);
  });
});

describe("webhook ingress", () => {
  it("deduplicates a replayed Meta event in the per-account Durable Object", async () => {
    const { id, accountId } = await createMessengerConnector();
    const rawBody = JSON.stringify({
      object: "page",
      entry: [
        {
          id: accountId,
          time: Date.now(),
          messaging: [
            {
              sender: { id: "psid_dedupe" },
              timestamp: Date.now(),
              message: { mid: unique("mid"), text: "hello" },
            },
          ],
        },
      ],
    });
    const signature = await signMeta(APP_SECRET, rawBody);

    const first = await handleChannelWebhook(
      new Request(`https://example.com/v1/channels/messenger/${id}/webhook`, {
        method: "POST",
        headers: { "X-Hub-Signature-256": signature },
        body: rawBody,
      }),
      testEnv,
      "messenger",
      id
    );
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      accepted: number;
      deduplicated: number;
    };
    expect(firstBody.accepted).toBe(1);

    const second = await handleChannelWebhook(
      new Request(`https://example.com/v1/channels/messenger/${id}/webhook`, {
        method: "POST",
        headers: { "X-Hub-Signature-256": signature },
        body: rawBody,
      }),
      testEnv,
      "messenger",
      id
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      accepted: number;
      deduplicated: number;
    };
    expect(secondBody.accepted).toBe(0);
    expect(secondBody.deduplicated).toBe(1);
  });

  it("answers the GET challenge with the sealed verify token", async () => {
    const { id } = await createMessengerConnector();
    const url = `https://example.com/v1/channels/messenger/${id}/webhook?hub.mode=subscribe&hub.verify_token=verify-token-value&hub.challenge=98765`;
    const response = await handleChannelWebhook(
      new Request(url, { method: "GET" }),
      testEnv,
      "messenger",
      id
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("98765");
  });
});

describe("reply-state vocabulary", () => {
  it("folds Meta's read receipt to delivered, never writing read", () => {
    expect(toReplyState("read")).toBe("delivered");
    expect(toReplyState("delivered")).toBe("delivered");
    expect(toReplyState("sent")).toBe("sent");
    expect(toReplyState("failed")).toBe("failed");
  });
});

describe("Instagram auth modes", () => {
  it("selects graph.instagram.com only for instagram_login", () => {
    expect(resolveInstagramApiHost("instagram_login")).toBe("https://graph.instagram.com");
    expect(resolveInstagramApiHost("facebook_login")).toBe("https://graph.facebook.com");
    expect(resolveInstagramApiHost("unified_login")).toBe("https://graph.facebook.com");
  });
});

describe("Telegram connector", () => {
  it("parses a business_message update", () => {
    const parsed = parseTelegramWebhook(
      JSON.stringify({
        update_id: 77,
        business_message: {
          message_id: 10,
          date: 1_763_600_000,
          chat: { id: 555, type: "private" },
          from: { id: 555 },
          text: "order status?",
        },
      })
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0].sender).toBe("555");
    expect(parsed[0].body).toBe("order status?");
  });

  it("maps a 429 retry_after to a scheduled retry, not a failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { ok: false, description: "Too Many Requests", parameters: { retry_after: 7 } },
          { status: 429 }
        )
      )
    );
    try {
      const result = await sendTelegramOutbound(
        { to: "555", body: "hello" },
        { botToken: "bot-token", secretToken: "hook-secret" }
      );
      expect(result.success).toBe(false);
      expect(result.state).toBe("RETRY_BACKOFF");
      expect(result.retryAfterSeconds).toBe(7);
      expect(result.errorCode).toBe("rate_limited");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

/* ------------------------------------------------------------------------- *
 * WhatsApp Cloud: connector path and the shared parser
 * ------------------------------------------------------------------------- */

import { consumeIngestBatch } from "../src/channels/ingest";
import type { NormalizedChannelEvent } from "../src/channels/connection-do";
import {
  WhatsAppCloudChannelPlugin,
  parseWhatsAppCloudWebhook,
  whatsappMessageIdFromEventId,
  whatsappStatusEventId,
} from "../src/channels/whatsapp-cloud";

const legacyEnv = new Proxy(env as unknown as Env, {
  get(target, prop, receiver) {
    if (prop === "WHATSAPP_APP_SECRET") return APP_SECRET;
    if (prop === "WHATSAPP_ACCESS_TOKEN") return "legacy-access-token";
    if (prop === "WHATSAPP_PHONE_NUMBER_ID") return "legacy-phone-id";
    if (prop === "WHATSAPP_VERIFY_TOKEN") return "legacy-verify-token";
    return Reflect.get(target, prop, receiver);
  },
});

async function createWhatsAppConnector(): Promise<{ id: string; accountId: string }> {
  const accountId = unique("phone");
  const response = await handleConnectorCreate(
    jsonRequest("https://example.com/v1/admin/channel-connectors", {
      channel: "whatsapp",
      account_id: accountId,
      execution_tier: "worker_do",
      auth_mode: "cloud_api",
      label: "Test Number",
      secret: {
        appSecret: APP_SECRET,
        verifyToken: "wa-verify-token",
        accessToken: "wa-access-token",
      },
    }),
    testEnv,
    owner
  );
  expect(response.status).toBe(201);
  const body = (await response.json()) as { id: string };
  return { id: body.id, accountId };
}

function whatsappPayload(accountId: string, wamid: string): string {
  return JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: `waba_${accountId}`,
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { phone_number_id: accountId },
              messages: [
                {
                  from: "15550001111",
                  id: wamid,
                  timestamp: "1763600000",
                  type: "text",
                  text: { body: "hello from whatsapp" },
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

describe("WhatsApp Cloud connector ingress", () => {
  it("ingests one message with a correct signature and answers 200", async () => {
    const { id, accountId } = await createWhatsAppConnector();
    const wamid = unique("wamid");
    const rawBody = whatsappPayload(accountId, wamid);
    const response = await handleChannelWebhook(
      new Request(`https://example.com/v1/channels/whatsapp/${id}/webhook`, {
        method: "POST",
        headers: { "X-Hub-Signature-256": await signMeta(APP_SECRET, rawBody) },
        body: rawBody,
      }),
      testEnv,
      "whatsapp",
      id
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { accepted: number };
    expect(body.accepted).toBe(1);
  });

  it("refuses a tampered body as 401", async () => {
    const { id, accountId } = await createWhatsAppConnector();
    const rawBody = whatsappPayload(accountId, unique("wamid"));
    const signature = await signMeta(APP_SECRET, rawBody);
    const response = await handleChannelWebhook(
      new Request(`https://example.com/v1/channels/whatsapp/${id}/webhook`, {
        method: "POST",
        headers: { "X-Hub-Signature-256": signature },
        body: `${rawBody} `,
      }),
      testEnv,
      "whatsapp",
      id
    );
    expect(response.status).toBe(401);
  });

  it("deduplicates a replayed wamid in the Durable Object", async () => {
    const { id, accountId } = await createWhatsAppConnector();
    const rawBody = whatsappPayload(accountId, unique("wamid"));
    const signature = await signMeta(APP_SECRET, rawBody);
    const send = () =>
      handleChannelWebhook(
        new Request(`https://example.com/v1/channels/whatsapp/${id}/webhook`, {
          method: "POST",
          headers: { "X-Hub-Signature-256": signature },
          body: rawBody,
        }),
        testEnv,
        "whatsapp",
        id
      );

    const first = (await (await send()).json()) as { accepted: number };
    expect(first.accepted).toBe(1);
    const second = (await (await send()).json()) as {
      accepted: number;
      deduplicated: number;
    };
    expect(second.accepted).toBe(0);
    expect(second.deduplicated).toBe(1);
  });

  it("refuses a connector whose secret is not sealed, by name", async () => {
    const accountId = unique("phone_unsealed");
    const id = `conn_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO channel_connectors
         (id, channel, account_id, execution_tier, auth_mode, label, secret_sealed,
          secret_hash, enabled, created_by, created_at, updated_at)
       VALUES (?, 'whatsapp', ?, 'worker_do', 'cloud_api', 'Unsealed', NULL, NULL, 1, 'test', ?, ?)`
    )
      .bind(id, accountId, now, now)
      .run();

    const rawBody = whatsappPayload(accountId, unique("wamid"));
    const response = await handleChannelWebhook(
      new Request(`https://example.com/v1/channels/whatsapp/${id}/webhook`, {
        method: "POST",
        headers: { "X-Hub-Signature-256": await signMeta(APP_SECRET, rawBody) },
        body: rawBody,
      }),
      testEnv,
      "whatsapp",
      id
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("connector_secret_unavailable");
  });

  it("parses statuses and skips coexistence fields by name", () => {
    const parsed = parseWhatsAppCloudWebhook(
      JSON.stringify({
        object: "whatsapp_business_account",
        entry: [
          {
            id: "waba_1",
            changes: [
              { field: "smb_message_echoes", value: { message_echoes: [{ id: "echo" }] } },
              { field: "history", value: { history: [] } },
              {
                field: "messages",
                value: {
                  statuses: [
                    {
                      id: "wamid.status.1",
                      status: "read",
                      recipient_id: "15550001111",
                      timestamp: "1763600001",
                    },
                    {
                      id: "wamid.status.2",
                      status: "failed",
                      recipient_id: "15550001111",
                      timestamp: "1763600002",
                      errors: [{ code: 131026 }],
                    },
                  ],
                },
              },
            ],
          },
        ],
      })
    );
    expect(parsed.skippedFields).toEqual(["smb_message_echoes", "history"]);
    expect(parsed.statuses).toHaveLength(2);
    expect(parsed.statuses[0].status).toBe("read");
    expect(parsed.statuses[1].errorCode).toBe("131026");
  });

  it("moves reply_state forward on receipts and never writes read", async () => {
    const accountId = unique("status_acct");
    const wamid = unique("wamid");
    const deviceId = `channel:whatsapp:${accountId}`;
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO messages
         (id, device_id, local_id, direction, peer, body, received_at, channel, reply_state)
       VALUES (?, ?, ?, 'out', ?, ?, ?, 'whatsapp', 'queued')`
    )
      .bind(crypto.randomUUID(), deviceId, wamid, "15550001111", "outbound", now)
      .run();

    const batch = (status: string) => {
      const event: NormalizedChannelEvent = {
        connectorId: `whatsapp:${accountId}`,
        channel: "whatsapp",
        accountId,
        eventKind: "status_update",
        eventId: whatsappStatusEventId(wamid, status),
        peerId: "15550001111",
        status,
        timestamp: now,
      };
      return {
        queue: "dakflare-ingest-queue",
        messages: [
          {
            id: crypto.randomUUID(),
            timestamp: new Date(),
            body: event,
            attempts: 1,
            ack: () => undefined,
            retry: () => undefined,
          },
        ],
        ackAll: () => undefined,
        retryAll: () => undefined,
      } as unknown as MessageBatch<NormalizedChannelEvent>;
    };

    // The connector keys receipts by `<wamid>:<status>`; the consumer strips it.
    expect(whatsappMessageIdFromEventId(whatsappStatusEventId(wamid, "read"))).toBe(wamid);

    await consumeIngestBatch(batch("sent"), testEnv);
    let row = await env.DB.prepare(
      `SELECT reply_state FROM messages WHERE device_id = ? AND local_id = ?`
    )
      .bind(deviceId, wamid)
      .first<{ reply_state: string }>();
    expect(row?.reply_state).toBe("sent");

    await consumeIngestBatch(batch("read"), testEnv);
    row = await env.DB.prepare(
      `SELECT reply_state FROM messages WHERE device_id = ? AND local_id = ?`
    )
      .bind(deviceId, wamid)
      .first<{ reply_state: string }>();
    expect(row?.reply_state).toBe("delivered");

    const illegal = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM messages WHERE device_id = ?
         AND reply_state NOT IN ('queued', 'sent', 'failed', 'delivered')`
    )
      .bind(deviceId)
      .first<{ n: number }>();
    expect(illegal?.n).toBe(0);
  });
});

describe("legacy WhatsApp Cloud path", () => {
  it("still verifies, parses and sends through the env credential", async () => {
    const plugin = new WhatsAppCloudChannelPlugin();
    const rawBody = whatsappPayload("legacy-phone-id", unique("wamid"));
    const request = new Request("https://example.com/v1/channels/whatsapp/webhook", {
      method: "POST",
      headers: { "X-Hub-Signature-256": await signMeta(APP_SECRET, rawBody) },
    });

    expect(await plugin.verifyWebhook(request, rawBody, legacyEnv)).toBe(true);
    const parsed = await plugin.parseInbound(request, rawBody, legacyEnv);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].body).toBe("hello from whatsapp");

    const peer = unique("1555");
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO conversations
         (id, channel, account_id, peer_id, session_state, window_expires_at, last_inbound_at,
          created_at, updated_at)
       VALUES (?, 'whatsapp', 'default', ?, 'WINDOW_OPEN', ?, ?, ?, ?)`
    )
      .bind(`conv_legacy_${peer}`, peer, now + 3_600_000, now, now, now)
      .run();

    const captured: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        captured.push({
          url: String(url),
          body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        });
        return Response.json({ messages: [{ id: "wamid.out.1" }] });
      })
    );
    try {
      const result = await plugin.sendOutbound({ to: peer, body: "legacy reply" }, legacyEnv);
      expect(result.success).toBe(true);
      expect(captured).toHaveLength(1);
      expect(captured[0].url).toContain("/legacy-phone-id/messages");
      expect((captured[0].body as { text?: { body?: string } }).text?.body).toBe(
        "legacy reply"
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

/* ------------------------------------------------------------------------- *
 * Outbound through a connector: the sealed credential, not the environment
 * ------------------------------------------------------------------------- */

describe("connector outbound", () => {
  it("sends with the connector's own token and page id", async () => {
    const { id, accountId } = await createMessengerConnector();
    // A conversation opens with an inbound message: without one the 24-hour window is closed and
    // the send is refused (correctly), which is what the first version of this test discovered.
    const stub = testEnv.CHANNEL_CONN.getByName(`messenger:${accountId}`);
    await stub.ingestEvents([
      {
        connectorId: id,
        channel: "messenger",
        accountId,
        eventKind: "inbound_message",
        eventId: `mid.window.${accountId}`,
        peerId: "psid-42",
        body: "hello",
        timestamp: Date.now(),
      },
    ]);
    const calls: Array<{ url: string; auth: string | null; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({
          url: String(url),
          auth: new Headers(init.headers).get("authorization"),
          body: JSON.parse(String(init.body)),
        });
        return Response.json({ message_id: "mid.sent.1" });
      })
    );
    try {
      const result = await sendConnectorOutbound(testEnv, "messenger", id, {
        to: "psid-42",
        body: "hello from the connector",
      });
      expect(result.success).toBe(true);
      expect(result.channelMessageId).toBe("mid.sent.1");
      expect(calls).toHaveLength(1);
      // The page access token sealed at creation is what authorises the send; the deployment's
      // environment credential is never involved.
      expect(calls[0].auth).toBe("Bearer page-access-token-value");
      expect(calls[0].url).toContain(encodeURIComponent(accountId));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports a closed 24-hour window as window_expired", async () => {
    const { id } = await createMessengerConnector();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { error: { code: 10, error_subcode: 2018278, message: "outside the window" } },
          { status: 400 }
        )
      )
    );
    try {
      const result = await sendConnectorOutbound(testEnv, "messenger", id, {
        to: "psid-42",
        body: "too late",
      });
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("window_expired");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refuses an unknown connector by name rather than sending", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const result = await sendConnectorOutbound(testEnv, "messenger", "conn_missing", {
        to: "psid-42",
        body: "nobody",
      });
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("connector_not_found");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
