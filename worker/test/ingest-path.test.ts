/**
 * Ingest consumer and Android edge-batch endpoint.
 *
 * These run in the Workers Vitest pool because the assertions are about the real D1
 * constraints, the real `ChannelConnection` Durable Object and the real P-256 verification
 * path — a node stub would agree with whatever this module does instead of with what D1 and
 * the DO do.
 *
 * What is asserted:
 *   - a 50-event delivery is ONE `DB.batch` and every statement stays under 100 parameters;
 *   - a platform `read` receipt lands as `delivered` and never as the literal `read`;
 *   - a settled (`failed`) row is not resurrected, and a replayed receipt writes nothing;
 *   - a thrown D1 batch retries every message and acks none;
 *   - a dead-letter delivery writes one row per message and acks;
 *   - an oversized edge body is 413 naming the byte limit, an unsigned one is 401;
 *   - the same `local_id` twice is one message and the second upload reports `deduplicated`.
 */

import { env } from "cloudflare:test";
import { handleMessagesList } from "../src/routes/incoming";
import { describe, expect, it } from "vitest";

import { consumeIngestBatch, consumeIngestDeadLetter } from "../src/channels/ingest";
import { handleEdgeIncomingBatch } from "../src/routes/edge-incoming";
import { buildCanonicalStringFromDigest, toHex } from "../src/auth/canonical";
import type { NormalizedChannelEvent } from "../src/channels/connection-do";
import type { Env } from "../src/index";

const EDGE_PATH = "/v1/edge/incoming/batch";

/* ------------------------------------------------------------------------- *
 * Test doubles
 * ------------------------------------------------------------------------- */

interface FakeMessage {
  body: unknown;
  attempts: number;
  acked: boolean;
  retried: boolean;
  ack(): void;
  retry(): void;
}

function fakeMessage(body: unknown, attempts = 1): FakeMessage {
  const message: FakeMessage = {
    body,
    attempts,
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

function fakeBatch<T>(queue: string, messages: FakeMessage[]): MessageBatch<T> {
  return {
    queue,
    messages,
    ackAll() {
      for (const message of messages) message.ack();
    },
    retryAll() {
      for (const message of messages) message.retry();
    },
  } as unknown as MessageBatch<T>;
}

/**
 * A `DB` wrapper that records the batch count and the number of `?` placeholders in each
 * prepared statement, then delegates to the real binding. This observes the boundary D1
 * sees, not this module's source.
 */
function countingEnv(): {
  wrapped: Env;
  stats: { batchCalls: number; paramCounts: number[] };
} {
  const stats = { batchCalls: 0, paramCounts: [] as number[] };
  const db = {
    prepare(sql: string) {
      stats.paramCounts.push((sql.match(/\?/g) ?? []).length);
      return env.DB.prepare(sql);
    },
    batch(statements: D1PreparedStatement[]) {
      stats.batchCalls += 1;
      return env.DB.batch(statements);
    },
    exec(query: string) {
      return env.DB.exec(query);
    },
    dump() {
      return env.DB.dump();
    },
  } as unknown as D1Database;
  return { wrapped: { ...env, DB: db } as Env, stats };
}

/** `DB` whose writes always fail, shaped enough for `prepare`/`bind` to run first. */
function failingDbEnv(): Env {
  const statement = { bind: () => ({}) };
  const db = {
    prepare: () => statement,
    batch: async () => {
      throw new Error("d1 unavailable");
    },
  } as unknown as D1Database;
  return { ...env, DB: db } as Env;
}

/* ------------------------------------------------------------------------- *
 * Device setup for the signed edge route
 * ------------------------------------------------------------------------- */

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function registerDevice(deviceId: string): Promise<{
  privateKey: CryptoKey;
}> {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  const spkiB64 = bytesToBase64(spki);
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO devices (device_id, public_key, paired_at, last_seen)
     VALUES (?, ?, ?, ?)`
  )
    .bind(deviceId, spkiB64, now, now)
    .run();

  const stub = env.DEVICE.get(env.DEVICE.idFromName(deviceId));
  const paired = await stub.fetch("https://do/__pair", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ device_id: deviceId, public_key_spki: spkiB64 }),
  });
  if (paired.status !== 200) {
    throw new Error(`pair failed: ${paired.status} ${await paired.text()}`);
  }

  return { privateKey: pair.privateKey };
}

async function signedEdgeRequest(
  deviceId: string,
  privateKey: CryptoKey,
  body: string
): Promise<Request> {
  const timestamp = String(Date.now());
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const digest = toHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)))
  );
  const canonical = buildCanonicalStringFromDigest(
    { method: "POST", pathname: EDGE_PATH, timestampHeader: timestamp, nonce },
    digest
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      privateKey,
      new TextEncoder().encode(canonical)
    )
  );

  return new Request(`https://example.com${EDGE_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Device-Id": deviceId,
      "X-Timestamp": timestamp,
      "X-Nonce": nonce,
      "X-Signature": bytesToBase64(signature),
    },
    body,
  });
}

/* ------------------------------------------------------------------------- *
 * Consumer
 * ------------------------------------------------------------------------- */

describe("INGEST_QUEUE consumer", () => {
  it("writes a 50-event delivery in one batch with <100 parameters per statement", async () => {
    const { wrapped, stats } = countingEnv();
    const now = Date.now();
    const events: NormalizedChannelEvent[] = Array.from({ length: 50 }, (_value, index) => ({
      connectorId: "whatsapp:acct-50",
      channel: "whatsapp",
      accountId: "acct-50",
      eventKind: "inbound_message",
      eventId: `batch-50-${index}`,
      peerId: `+1555000${String(index).padStart(4, "0")}`,
      body: `message ${index}`,
      timestamp: now,
    }));
    const messages = events.map((event) => fakeMessage(event));
    const batch = fakeBatch<NormalizedChannelEvent>("dakflare-ingest-queue", messages);

    const written = await consumeIngestBatch(batch, wrapped);

    // 50 conversations + 50 messages, all in one round-trip.
    expect(stats.batchCalls).toBe(1);
    expect(written).toBe(100);
    expect(stats.paramCounts.every((count) => count > 0 && count <= 100)).toBe(true);
    expect(Math.max(...stats.paramCounts)).toBeLessThanOrEqual(100);
    expect(messages.every((message) => message.acked)).toBe(true);

    const stored = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM messages WHERE device_id = ?`
    )
      .bind("channel:whatsapp:acct-50")
      .first<{ n: number }>();
    expect(stored?.n).toBe(50);

    const conversations = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM conversations WHERE channel = ? AND account_id = ?`
    )
      .bind("whatsapp", "acct-50")
      .first<{ n: number }>();
    expect(conversations?.n).toBe(50);
  });

  it("maps platform `read` to delivered and never stores the literal read", async () => {
    const deviceId = "channel:whatsapp:read-acct";
    const now = Date.now();
    const statuses = [
      { localId: "read-sent", state: "sent" },
      { localId: "read-queued", state: "queued" },
      { localId: "read-failed", state: "failed" },
    ];
    for (const entry of statuses) {
      await env.DB.prepare(
        `INSERT INTO messages
           (id, device_id, local_id, direction, peer, body, received_at, channel, reply_state)
         VALUES (?, ?, ?, 'out', ?, ?, ?, 'whatsapp', ?)`
      )
        .bind(
          crypto.randomUUID(),
          deviceId,
          entry.localId,
          "+15550001111",
          "outbound",
          now,
          entry.state
        )
        .run();
    }

    const messages = statuses.map((entry) =>
      fakeMessage({
        connectorId: "whatsapp:read-acct",
        channel: "whatsapp",
        accountId: "read-acct",
        eventKind: "status_update",
        eventId: entry.localId,
        peerId: "+15550001111",
        status: "read",
        timestamp: now,
      } satisfies NormalizedChannelEvent)
    );
    const written = await consumeIngestBatch(
      fakeBatch<NormalizedChannelEvent>("dakflare-ingest-queue", messages),
      env
    );

    // `queued` and `sent` advance; `failed` is terminal and is not matched at all.
    expect(written).toBe(2);

    const rows = await env.DB.prepare(
      `SELECT local_id, reply_state FROM messages WHERE device_id = ? ORDER BY local_id`
    )
      .bind(deviceId)
      .all<{ local_id: string; reply_state: string }>();
    const byId = new Map((rows.results ?? []).map((row) => [row.local_id, row.reply_state]));
    expect(byId.get("read-sent")).toBe("delivered");
    expect(byId.get("read-queued")).toBe("delivered");
    expect(byId.get("read-failed")).toBe("failed");

    const illegal = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM messages WHERE device_id = ? AND reply_state NOT IN
         ('queued', 'sent', 'failed', 'delivered')`
    )
      .bind(deviceId)
      .first<{ n: number }>();
    expect(illegal?.n).toBe(0);

    // Replaying the same receipts is a no-op: settled rows do not move, and the guard
    // rejects the same-state transition, so no row is counted as written.
    const replayMessages = messages.map((message) => fakeMessage(message.body));
    const replayWritten = await consumeIngestBatch(
      fakeBatch<NormalizedChannelEvent>("dakflare-ingest-queue", replayMessages),
      env
    );
    expect(replayWritten).toBe(0);

    const after = await env.DB.prepare(
      `SELECT local_id, reply_state FROM messages WHERE device_id = ? ORDER BY local_id`
    )
      .bind(deviceId)
      .all<{ local_id: string; reply_state: string }>();
    expect(after.results).toEqual(rows.results);
  });

  it("retries instead of acking when the D1 batch throws", async () => {
    const event: NormalizedChannelEvent = {
      connectorId: "sms:fail-device",
      channel: "sms",
      accountId: "fail-device",
      eventKind: "inbound_message",
      eventId: "fail-1",
      peerId: "+15550002222",
      body: "hello",
      timestamp: Date.now(),
    };
    const messages = [fakeMessage(event), fakeMessage({ ...event, eventId: "fail-2" })];
    const batch = fakeBatch<NormalizedChannelEvent>("dakflare-ingest-queue", messages);

    await consumeIngestBatch(batch, failingDbEnv());

    expect(messages.every((message) => message.retried)).toBe(true);
    expect(messages.some((message) => message.acked)).toBe(false);
  });

  it("keeps a replayed event as a single message (INSERT OR IGNORE)", async () => {
    const event: NormalizedChannelEvent = {
      connectorId: "telegram:replay-device",
      channel: "telegram",
      accountId: "replay-device",
      eventKind: "inbound_message",
      eventId: "replay-1",
      peerId: "99887766",
      body: "one message",
      timestamp: Date.now(),
    };
    const messages = [fakeMessage(event), fakeMessage(event)];
    const written = await consumeIngestBatch(
      fakeBatch<NormalizedChannelEvent>("dakflare-ingest-queue", messages),
      env
    );

    // One message insert + one conversation upsert; the duplicate message is ignored.
    expect(written).toBe(2);
    const stored = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM messages WHERE device_id = ? AND local_id = ?`
    )
      .bind("channel:telegram:replay-device", "replay-1")
      .first<{ n: number }>();
    expect(stored?.n).toBe(1);
  });
});

/* ------------------------------------------------------------------------- *
 * Dead-letter consumer
 * ------------------------------------------------------------------------- */

describe("ingest dead letters", () => {
  it("writes one row per failed body, then acks", async () => {
    const queue = "dakflare-ingest-dlq-test-ok";
    const messages = [
      fakeMessage({ eventId: "dl-1", channel: "sms" }, 3),
      fakeMessage({ eventId: "dl-2", channel: "whatsapp" }, 4),
    ];
    const batch = fakeBatch<unknown>(queue, messages);

    await consumeIngestDeadLetter(batch, env);

    expect(messages.every((message) => message.acked)).toBe(true);
    const rows = await env.DB.prepare(
      `SELECT body_json, attempts FROM ingest_dead_letters WHERE queue = ? ORDER BY attempts`
    )
      .bind(queue)
      .all<{ body_json: string; attempts: number }>();
    expect(rows.results?.length).toBe(2);
    expect(JSON.parse(rows.results?.[0]?.body_json ?? "null")).toEqual({
      eventId: "dl-1",
      channel: "sms",
    });
    expect(rows.results?.[0]?.attempts).toBe(3);
    expect(rows.results?.[1]?.attempts).toBe(4);
  });

  it("retries the dead-letter batch when its own write fails", async () => {
    const messages = [fakeMessage({ eventId: "dl-fail-1" }, 3)];
    const batch = fakeBatch<unknown>("dakflare-ingest-dlq-test-fail", messages);

    await consumeIngestDeadLetter(batch, failingDbEnv());

    expect(messages[0]?.retried).toBe(true);
    expect(messages[0]?.acked).toBe(false);
  });
});

/* ------------------------------------------------------------------------- *
 * Edge endpoint
 * ------------------------------------------------------------------------- */

describe("POST /v1/edge/incoming/batch", () => {
  it("answers 401 for an unsigned request", async () => {
    const request = new Request(`https://example.com${EDGE_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: "unsigned-device", messages: [] }),
    });

    const response = await handleEdgeIncomingBatch(request, env, {} as ExecutionContext);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "missing_auth_headers" });
  });

  it("answers 413 naming the byte limit for an oversized body", async () => {
    const deviceId = "edge-oversize-device";
    await env.DB.prepare(
      `INSERT OR IGNORE INTO devices (device_id, public_key, paired_at, last_seen)
       VALUES (?, 'not-a-real-key', ?, ?)`
    )
      .bind(deviceId, Date.now(), Date.now())
      .run();

    const oversized = JSON.stringify({
      device_id: deviceId,
      messages: [],
      pad: "x".repeat(300_000),
    });
    const timestamp = String(Date.now());
    const request = new Request(`https://example.com${EDGE_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Device-Id": deviceId,
        "X-Timestamp": timestamp,
        "X-Nonce": crypto.randomUUID().replace(/-/g, ""),
        // 64 zero bytes, base64. The size check aborts before this is ever verified.
        "X-Signature": bytesToBase64(new Uint8Array(64)),
      },
      body: oversized,
    });

    const response = await handleEdgeIncomingBatch(request, env, {} as ExecutionContext);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "payload_too_large",
      limit_bytes: 262_144,
    });
  });

  it("treats the same local_id twice as one message and one deduplicated count", async () => {
    const deviceId = "edge-dup-device";
    const { privateKey } = await registerDevice(deviceId);
    const body = JSON.stringify({
      device_id: deviceId,
      messages: [
        {
          channel: "sms",
          local_id: "dup-1",
          sender: "+15551234567",
          body: "hello from the handset",
          received_at: Date.now(),
        },
      ],
    });

    const first = await handleEdgeIncomingBatch(
      await signedEdgeRequest(deviceId, privateKey, body),
      env,
      {} as ExecutionContext
    );
    expect(first.status).toBe(202);
    await expect(first.json()).resolves.toEqual({ accepted: 1, deduplicated: 0 });

    const second = await handleEdgeIncomingBatch(
      await signedEdgeRequest(deviceId, privateKey, body),
      env,
      {} as ExecutionContext
    );
    expect(second.status).toBe(202);
    await expect(second.json()).resolves.toEqual({ accepted: 0, deduplicated: 1 });

    // The consumer is the D1 half; replay the same event twice and it is still one row.
    const event: NormalizedChannelEvent = {
      connectorId: `sms:${deviceId}`,
      channel: "sms",
      accountId: deviceId,
      eventKind: "inbound_message",
      eventId: "dup-1",
      peerId: "+15551234567",
      body: "hello from the handset",
      timestamp: Date.now(),
    };
    await consumeIngestBatch(
      fakeBatch<NormalizedChannelEvent>("dakflare-ingest-queue", [
        fakeMessage(event),
        fakeMessage(event),
      ]),
      env
    );

    const stored = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM messages WHERE device_id = ? AND local_id = ?`
    )
      .bind(`channel:sms:${deviceId}`, "dup-1")
      .first<{ n: number }>();
    expect(stored?.n).toBe(1);
  });
});

/* ------------------------------------------------------------------------- *
 * Queue failure: the dedupe ledger must not outlive a delivery that never happened
 * ------------------------------------------------------------------------- */

describe("ingestEvents queue failure", () => {
  it("rolls the ledger back so a retry is accepted, not deduplicated", async () => {
    const accountId = `rollback-${Date.now()}`;
    const stub = env.CHANNEL_CONN.getByName(`messenger:${accountId}`);
    const queue = env.INGEST_QUEUE as unknown as { sendBatch: (messages: unknown) => Promise<void> };
    const proto = Object.getPrototypeOf(queue) as { sendBatch: (messages: unknown) => Promise<void> };
    const original = proto.sendBatch;
    let failOnce = true;
    proto.sendBatch = async function (messages: unknown) {
      if (failOnce) {
        failOnce = false;
        throw new Error("queue unavailable");
      }
      return original.call(this, messages);
    };

    const event = {
      connectorId: "conn_rollback",
      channel: "messenger",
      accountId,
      eventKind: "inbound_message" as const,
      eventId: `mid.rollback.${accountId}`,
      peerId: "psid-rollback",
      body: "first delivery attempt",
      timestamp: Date.now(),
    };

    try {
      // The queue refused, so nothing was delivered: the call answers a retryable outcome
      // rather than throwing across the RPC boundary (which the runtime reports as an uncaught
      // exception for a condition the caller is meant to handle).
      const first = await stub.ingestEvents([event]);
      expect(first).toMatchObject({ ok: false, error: "queue_unavailable", accepted: 0, deduplicated: 0 });

      // Meta retries the same event id. If the ledger had kept the row, this would answer
      // `deduplicated: 1` and the message would be lost without a trace.
      const retried = await stub.ingestEvents([{ ...event, body: "retry" }]);
      expect(retried).toMatchObject({ ok: true, accepted: 1, deduplicated: 0 });
    } finally {
      proto.sendBatch = original;
    }
  });
});

/* ------------------------------------------------------------------------- *
 * Keyset pagination across rows that share a millisecond
 * ------------------------------------------------------------------------- */

describe("GET /v1/messages same-millisecond paging", () => {
  it("returns five rows sharing one millisecond across three pages, no duplicates, none skipped", async () => {
    const deviceId = `paging-${Date.now()}`;
    const receivedAt = Date.now();
    const ids = ["page-a", "page-b", "page-c", "page-d", "page-e"];
    for (const [index, id] of ids.entries()) {
      await env.DB.prepare(
        `INSERT INTO messages (id, device_id, local_id, direction, peer, body, received_at)
         VALUES (?, ?, ?, 'in', ?, ?, ?)`
      )
        .bind(id, deviceId, `local-${id}`, "+8801700000000", `body ${index}`, receivedAt)
        .run();
    }

    const seen: string[] = [];
    let cursor: { before: number; before_id: string } | null = null;
    for (let page = 0; page < 5; page += 1) {
      const url = new URL("https://example.com/v1/messages");
      url.searchParams.set("device_id", deviceId);
      url.searchParams.set("limit", "2");
      if (cursor !== null) {
        url.searchParams.set("before", String(cursor.before));
        url.searchParams.set("before_id", cursor.before_id);
      }
      const response = await handleMessagesList(env, url);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        messages: Array<{ id: string; received_at: number }>;
        next_cursor: { before: number; before_id: string } | null;
      };
      for (const row of body.messages) {
        // Every row on this device is one of ours; the same millisecond is deliberate.
        expect(row.received_at).toBe(receivedAt);
        seen.push(row.id);
      }
      cursor = body.next_cursor;
      if (cursor === null) break;
    }

    expect(seen).toHaveLength(ids.length);
    expect(new Set(seen).size).toBe(ids.length);
    expect([...seen].sort()).toEqual([...ids].sort());
  });

  it("refuses before_id without before, rather than guessing a position", async () => {
    const url = new URL("https://example.com/v1/messages");
    url.searchParams.set("device_id", "anything");
    url.searchParams.set("before_id", "page-a");
    const response = await handleMessagesList(env, url);
    expect(response.status).toBe(400);
  });
});
