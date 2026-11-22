/**
 * The outbound delivery ledger.
 *
 * One row per (webhook, event). The row is what makes three promises keepable:
 *
 *   - the delivery id is stable, so a retry is the same delivery and the
 *     receiver's idempotency key still works;
 *   - the attempt count is honest, so `max_attempts` means something and a
 *     replay resets a row instead of guessing;
 *   - the receiver's answer is kept (`ack_json`, capped), which is the only
 *     evidence that a webhook was accepted rather than merely delivered.
 *
 * The unique `idempotency_key` is the claim: the first insert wins and a second
 * enqueue of the same event is a no-op that returns the existing delivery.
 */

import type { Env } from "../index";
import type { OutboundWebhookMatch } from "./outbound-webhook";
import { findSubscribedWebhooks } from "./outbound-webhook";

/** The largest `ack_json` this stores. A receiver's answer is a receipt, not a log. */
export const MAX_ACK_BYTES = 2_048;

function deliveryId(): string {
  return `dlv_${crypto.randomUUID().replace(/-/g, "")}`;
}

function boundedAck(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  let serialised: string;
  try {
    serialised = JSON.stringify(value);
  } catch {
    return null;
  }
  if (serialised.length > MAX_ACK_BYTES) {
    return JSON.stringify({
      truncated: true,
      bytes: serialised.length,
      preview: serialised.slice(0, MAX_ACK_BYTES - 64),
    });
  }
  return serialised;
}

export { boundedAck };

export interface EnqueueDeliveryInput {
  webhook: OutboundWebhookMatch;
  eventType: string;
  /** Stable per event: the flow run, the message local id, the revocation time. */
  eventId: string;
  /** The JSON body the receiver gets, already through the content policy. */
  payload: unknown;
  traceId: string;
  headers?: Record<string, string>;
}

export interface EnqueueDeliveryResult {
  deliveryId: string;
  /** False when the same event was already queued for this hook. */
  enqueued: boolean;
}

/**
 * Write the ledger row and enqueue the delivery.
 *
 * A queue that is not bound (a local run without the producer) leaves the row
 * PENDING with the reason in `last_error` rather than throwing: the operator can
 * see it in `/v1/integration/health` and replay once the queue exists.
 */
export async function enqueueDelivery(
  env: Env,
  input: EnqueueDeliveryInput
): Promise<EnqueueDeliveryResult> {
  const id = deliveryId();
  const body = JSON.stringify({
    ...(typeof input.payload === "object" && input.payload !== null ? input.payload : {}),
    delivery_id: id,
    event_type: input.eventType,
  });
  const now = Date.now();
  const idempotencyKey = `${input.webhook.id}:${input.eventType}:${input.eventId}`;

  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO integration_deliveries
       (id, webhook_id, event_type, idempotency_key, payload_json, state,
        attempts, next_attempt_at, last_http_status, last_error, delivered_at,
        created_at, trace_id, ack_json)
     VALUES (?, ?, ?, ?, ?, 'PENDING', 0, ?, NULL, NULL, NULL, ?, ?, NULL)`
  )
    .bind(
      id,
      input.webhook.id,
      input.eventType,
      idempotencyKey,
      body,
      now,
      now,
      input.traceId
    )
    .run();

  if (Number(inserted.meta?.changes ?? 0) === 0) {
    const existing = await env.DB.prepare(
      `SELECT id FROM integration_deliveries WHERE idempotency_key = ?`
    )
      .bind(idempotencyKey)
      .first<{ id: string }>();
    return { deliveryId: existing?.id ?? id, enqueued: false };
  }

  if (env.WEBHOOK_QUEUE === undefined) {
    await env.DB.prepare(
      `UPDATE integration_deliveries SET last_error = ? WHERE id = ?`
    )
      .bind("webhook_queue_unavailable", id)
      .run();
    return { deliveryId: id, enqueued: false };
  }

  try {
    await env.WEBHOOK_QUEUE.send({
      deliveryId: id,
      webhookId: input.webhook.id,
      eventType: input.eventType,
      url: input.webhook.target_url,
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "DakFlare-Worker/7.0",
        ...input.webhook.customHeaders,
        ...(input.headers ?? {}),
      },
      body,
      traceId: input.traceId,
    });
  } catch (error) {
    await env.DB.prepare(
      `UPDATE integration_deliveries SET state = 'RETRYING', last_error = ? WHERE id = ?`
    )
      .bind(String(error).slice(0, 500), id)
      .run();
    return { deliveryId: id, enqueued: false };
  }

  return { deliveryId: id, enqueued: true };
}

export interface DeliveryResultInput {
  deliveryId: string;
  httpStatus: number;
  ok: boolean;
  /** The receiver's parsed answer, when it sent one. */
  ack?: unknown;
  error?: string;
}

/**
 * Record what the receiver said, and decide whether the queue should retry.
 *
 * The attempt count comes from the row, not from the queue's own delivery
 * counter: a replay resets the row to PENDING and must be allowed its attempts
 * again, which a queue-level counter cannot express.
 */
export async function recordDeliveryResult(
  env: Env,
  input: DeliveryResultInput
): Promise<{ retry: boolean; deadLettered: boolean; attempts: number }> {
  const row = await env.DB.prepare(
    `SELECT d.attempts, w.max_attempts
       FROM integration_deliveries d
       JOIN webhooks w ON w.id = d.webhook_id
      WHERE d.id = ?`
  )
    .bind(input.deliveryId)
    .first<{ attempts: number; max_attempts: number | null }>();
  if (row === null) return { retry: false, deadLettered: false, attempts: 0 };

  const attempts = Number(row.attempts ?? 0) + 1;
  const maxAttempts = Math.max(1, Number(row.max_attempts ?? 8));
  const now = Date.now();

  if (input.ok) {
    await env.DB.prepare(
      `UPDATE integration_deliveries
          SET state = 'DELIVERED', attempts = ?, last_http_status = ?,
              last_error = NULL, delivered_at = ?, next_attempt_at = ?, ack_json = ?
        WHERE id = ?`
    )
      .bind(attempts, input.httpStatus, now, now, boundedAck(input.ack), input.deliveryId)
      .run();
    return { retry: false, deadLettered: false, attempts };
  }

  const deadLettered = attempts >= maxAttempts;
  await env.DB.prepare(
    `UPDATE integration_deliveries
        SET state = ?, attempts = ?, last_http_status = ?, last_error = ?,
            next_attempt_at = ?
      WHERE id = ?`
  )
    .bind(
      deadLettered ? "DEAD_LETTER" : "RETRYING",
      attempts,
      input.httpStatus,
      (input.error ?? `HTTP ${input.httpStatus}`).slice(0, 500),
      now + Math.min(60_000, 1_000 * attempts),
      input.deliveryId
    )
    .run();
  return { retry: !deadLettered, deadLettered, attempts };
}

export interface DeviceEventInput {
  type: "device.status_changed" | "device.revoked";
  deviceId: string;
  /** `online` / `offline` for a status change; `revoked` for a revocation. */
  status: "online" | "offline" | "revoked";
  at?: number;
  reason?: string;
}

/**
 * Emit a device lifecycle event to every outbound hook subscribed to it.
 *
 * Subscription is `webhooks.events_json` naming the event type. An empty list
 * means "nothing", which is the safe default for a hook created before this
 * existed: an integration that did not ask for lifecycle events must not start
 * receiving them because the deployment upgraded.
 *
 * This never throws and never blocks the caller's outcome: a lifecycle event is
 * a notification about something that already happened, and losing it must not
 * make a revocation fail.
 */
export async function emitDeviceEvent(
  env: Env,
  input: DeviceEventInput,
  traceId: string = crypto.randomUUID()
): Promise<void> {
  try {
    const hooks = await findSubscribedWebhooks(env, input.type);
    if (hooks.length === 0) return;
    const at = input.at ?? Date.now();
    for (const hook of hooks) {
      const payload: Record<string, unknown> = {
        device_id: input.deviceId,
        status: input.status,
        at,
      };
      if (input.reason !== undefined) payload.reason = input.reason;
      // One event id for the whole emission: the same transition delivered to
      // three hooks is three deliveries of one event, and a retry of any of them
      // stays that delivery.
      await enqueueDelivery(env, {
        webhook: hook,
        eventType: input.type,
        eventId: `${input.deviceId}:${input.status}:${at}`,
        payload,
        traceId,
        headers: { "X-Dakflare-Device": input.deviceId },
      });
    }
  } catch (error) {
    console.error(`[integration] ${input.type} emit failed: ${String(error)}`);
  }
}
