/**
 * The carrier-receipt mirror onto `scheduled_messages`.
 *
 * A scheduled SMS row is not a `messages` row, so the status route has to copy
 * the receipt twice: the console mirror and the scheduled lifecycle. These
 * tests pin the second one against real D1, including the guard that stops a
 * late receipt from walking a terminal row backwards.
 */

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  mirrorScheduledDelivery,
  type AppliedUpdate,
  type ScheduledStatus
} from "../src/lib/scheduled";
import { consumeIngestBatch } from "../src/channels/ingest";
import type { NormalizedChannelEvent } from "../src/channels/connection-do";

interface SeedOptions {
  status?: ScheduledStatus;
  channel?: string;
  targetType?: "device" | "connector";
  dispatchRef?: string | null;
  sentAt?: number | null;
  deliveredAt?: number | null;
  lastError?: string | null;
}

async function seedRow(options: SeedOptions = {}): Promise<{ id: string; dispatchRef: string }> {
  const id = crypto.randomUUID();
  const channel = options.channel ?? "sms";
  const dispatchRef = options.dispatchRef ?? `cmd-${id}`;
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO scheduled_messages
       (id, channel, target_type, target_id, pacing_key, to_peer, body, timezone,
        send_at, status, dispatch_ref, sent_at, delivered_at, last_error,
        created_at, updated_at)
     VALUES (?, ?, ?, 'device_test', ?, '+15550001111',
             'hello', 'UTC', ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      channel,
      options.targetType ?? (channel === "sms" ? "device" : "connector"),
      `${channel}:device_test`,
      now - 1000,
      options.status ?? "sent",
      dispatchRef,
      options.sentAt ?? null,
      options.deliveredAt ?? null,
      options.lastError ?? null,
      now,
      now
    )
    .run();
  return { id, dispatchRef };
}

async function row(id: string): Promise<{
  status: ScheduledStatus;
  sent_at: number | null;
  delivered_at: number | null;
  last_error: string | null;
  updated_at: number;
}> {
  const result = await env.DB.prepare(
    `SELECT status, sent_at, delivered_at, last_error, updated_at
       FROM scheduled_messages WHERE id = ?`
  )
    .bind(id)
    .first<{
      status: ScheduledStatus;
      sent_at: number | null;
      delivered_at: number | null;
      last_error: string | null;
      updated_at: number;
    }>();
  if (!result) throw new Error("scheduled row disappeared");
  return result;
}

async function apply(updates: AppliedUpdate[], now: number): Promise<void> {
  const statements = mirrorScheduledDelivery(env.DB, "device_test", updates, now);
  if (statements.length > 0) await env.DB.batch(statements);
}

describe("mirrorScheduledDelivery", () => {
  it("moves a sent row to delivered and fills both timestamps", async () => {
    const { id, dispatchRef } = await seedRow({ status: "sent" });
    const now = Date.now();

    await apply([{ command_id: dispatchRef, status: "DELIVERED" }], now);

    const after = await row(id);
    expect(after.status).toBe("delivered");
    expect(after.delivered_at).toBe(now);
    expect(after.sent_at).toBe(now);
    expect(after.updated_at).toBe(now);
  });

  it("keeps an existing sent_at when delivery arrives later", async () => {
    const sentAt = Date.now() - 30_000;
    const { id, dispatchRef } = await seedRow({ status: "sent", sentAt });
    const now = Date.now();

    await apply([{ command_id: dispatchRef, status: "DELIVERED" }], now);

    const after = await row(id);
    expect(after.status).toBe("delivered");
    expect(after.sent_at).toBe(sentAt);
    expect(after.delivered_at).toBe(now);
  });

  it("does not regress a delivered row when a late SENT arrives", async () => {
    const deliveredAt = Date.now() - 10_000;
    const { id, dispatchRef } = await seedRow({
      status: "delivered",
      sentAt: deliveredAt,
      deliveredAt
    });

    await apply([{ command_id: dispatchRef, status: "SENT" }], Date.now());

    const after = await row(id);
    expect(after.status).toBe("delivered");
    expect(after.delivered_at).toBe(deliveredAt);
  });

  it("marks a sent row failed with the carrier reason", async () => {
    const { id, dispatchRef } = await seedRow({ status: "sent" });
    const now = Date.now();

    await apply(
      [
        {
          command_id: dispatchRef,
          status: "FAILED",
          error_code: "sms_error",
          error_message: "network rejected the PDU"
        }
      ],
      now
    );

    const after = await row(id);
    expect(after.status).toBe("failed");
    expect(after.last_error).toBe("sms_error: network rejected the PDU");
    expect(after.updated_at).toBe(now);
  });

  it("marks an EXPIRED row failed with the literal reason", async () => {
    const { id, dispatchRef } = await seedRow({ status: "dispatched" });

    await apply([{ command_id: dispatchRef, status: "EXPIRED" }], Date.now());

    const after = await row(id);
    expect(after.status).toBe("failed");
    expect(after.last_error).toBe("expired");
  });

  it("truncates an overlong failure reason to 200 characters", async () => {
    const { id, dispatchRef } = await seedRow({ status: "sent" });
    const message = "x".repeat(400);

    await apply(
      [{ command_id: dispatchRef, status: "FAILED", error_code: "e", error_message: message }],
      Date.now()
    );

    const after = await row(id);
    expect(after.status).toBe("failed");
    expect(after.last_error?.length).toBe(200);
  });

  it("leaves a cancelled row alone", async () => {
    const { id, dispatchRef } = await seedRow({ status: "cancelled", sentAt: 1 });
    const before = await row(id);

    await apply([{ command_id: dispatchRef, status: "DELIVERED" }], Date.now());

    expect(await row(id)).toEqual(before);
  });

  it("does not turn a delivered row into failed", async () => {
    const deliveredAt = Date.now() - 5_000;
    const { id, dispatchRef } = await seedRow({
      status: "delivered",
      sentAt: deliveredAt,
      deliveredAt
    });

    await apply(
      [{ command_id: dispatchRef, status: "FAILED", error_code: "late" }],
      Date.now()
    );

    const after = await row(id);
    expect(after.status).toBe("delivered");
    expect(after.last_error).toBeNull();
  });

  it("ignores a receipt that resolves to no row", async () => {
    const { id, dispatchRef } = await seedRow({ status: "sent" });
    const before = await row(id);

    await apply([{ command_id: `${dispatchRef}-unknown`, status: "DELIVERED" }], Date.now());

    expect(await row(id)).toEqual(before);
  });
});

/* ------------------------------------------------------------------------- *
 * Connector receipts through the ingest consumer
 * ------------------------------------------------------------------------- */

function statusEvent(
  channel: string,
  localId: string,
  status: string,
  timestamp: number,
  errorCode?: string
): NormalizedChannelEvent {
  return {
    connectorId: `${channel}:acct-test`,
    channel,
    accountId: "acct-test",
    eventKind: "status_update",
    // WhatsApp keys a receipt in the DO as `<wamid>:<status>`; the consumer
    // strips the suffix back to the platform message id.
    eventId: channel === "whatsapp" ? `${localId}:${status}` : localId,
    peerId: "+15550001111",
    status,
    errorCode,
    timestamp
  };
}

function ingestBatch(events: NormalizedChannelEvent[]): MessageBatch<NormalizedChannelEvent> {
  const messages = events.map((body) => ({
    body,
    attempts: 1,
    ack() {},
    retry() {}
  }));
  return {
    queue: "dakflare-ingest-queue",
    messages,
    ackAll() {},
    retryAll() {}
  } as unknown as MessageBatch<NormalizedChannelEvent>;
}

async function ingest(events: NormalizedChannelEvent[]): Promise<number> {
  return consumeIngestBatch(ingestBatch(events), env);
}

describe("connector receipt mirror", () => {
  it("advances a sent connector row to delivered and keeps it there on a late sent", async () => {
    const { id, dispatchRef } = await seedRow({
      channel: "whatsapp",
      dispatchRef: "wamid.TEST",
      status: "sent"
    });
    const now = Date.now();

    await ingest([statusEvent("whatsapp", dispatchRef, "delivered", now)]);

    const first = await row(id);
    expect(first.status).toBe("delivered");
    expect(first.delivered_at).toBeGreaterThan(0);
    expect(first.sent_at).toBe(first.delivered_at);

    await ingest([statusEvent("whatsapp", dispatchRef, "sent", now + 1000)]);

    const after = await row(id);
    expect(after.status).toBe("delivered");
    expect(after.delivered_at).toBe(first.delivered_at);
  });

  it("folds a read receipt to delivered", async () => {
    const { id } = await seedRow({
      channel: "whatsapp",
      dispatchRef: "wamid.READ",
      status: "sent"
    });

    await ingest([statusEvent("whatsapp", "wamid.READ", "read", Date.now())]);

    expect((await row(id)).status).toBe("delivered");
  });

  it("records a platform failure with its error code", async () => {
    const { id } = await seedRow({
      channel: "whatsapp",
      dispatchRef: "wamid.FAIL",
      status: "sent"
    });

    await ingest([statusEvent("whatsapp", "wamid.FAIL", "failed", Date.now(), "131047")]);

    const after = await row(id);
    expect(after.status).toBe("failed");
    expect(after.last_error).toBe("131047");
  });

  it("leaves a cancelled row alone", async () => {
    const { id } = await seedRow({
      channel: "whatsapp",
      dispatchRef: "wamid.CANCELLED",
      status: "cancelled"
    });
    const before = await row(id);

    await ingest([statusEvent("whatsapp", "wamid.CANCELLED", "delivered", Date.now())]);

    expect(await row(id)).toEqual(before);
  });

  it("moves a dispatched connector row to sent and fills sent_at", async () => {
    const { id } = await seedRow({
      channel: "telegram",
      dispatchRef: "tg-msg-1",
      status: "dispatched"
    });

    await ingest([statusEvent("telegram", "tg-msg-1", "sent", Date.now())]);

    const after = await row(id);
    expect(after.status).toBe("sent");
    expect(after.sent_at).toBeGreaterThan(0);
  });
});
