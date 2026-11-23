/**
 * Generic Integration Surface v1 routes.
 *
 *   GET  /v1/integration/manifest                  — capabilities, signing, limits
 *   GET  /v1/integration/health                    — database, fleet, delivery queue
 *   POST /v1/webhooks/:id/deliveries/:deliveryId/replay
 *
 * Nothing here names a vertical. A consumer reads the manifest, signs nothing
 * (the Worker signs), and replays a delivery by its own id — the three things an
 * integration needs and the three things this deployment can promise.
 *
 * The manifest is deliberately data, not prose: a receiver that verifies
 * signatures can read the canonical format, the header names and the skew window
 * from the deployment it is talking to instead of from a document that may be
 * older than the release.
 */

import type { Env } from "../index";
import type { AdminActor } from "../audit";
import { requestMeta, writeAudit } from "../audit";
import { TOKEN_SCOPES } from "../lib/agent-scopes";
import {
  DEFAULT_MAX_SKEW_SECONDS,
  ENVELOPE_VERSION,
  HEADER_DELIVERY,
  HEADER_KEY_ID,
  HEADER_SIGNATURE,
  HEADER_TIMESTAMP,
  HEADER_TRACE_ID,
} from "../lib/integration-envelope";
import pkg from "../../package.json";

export function handleIntegrationManifest(req: Request): Response {
  const traceId = req.headers.get(HEADER_TRACE_ID) ?? crypto.randomUUID();
  return Response.json(
    {
      schema_version: "1.0",
      dakflare_version: pkg.version,
      capabilities: [
        "outbound_webhooks_v1",
        "service_tokens",
        "transactional_sms",
        "device_lifecycle_events",
        "delivery_replay",
        "content_policy_allowlist",
        "trace_propagation",
      ],
      scopes: TOKEN_SCOPES,
      // The same contract, reached two other ways. The HTTP routes above stay
      // canonical: the RPC entrypoints dispatch through them, so an error is the
      // same error and a limiter is the same limiter.
      rpc: {
        admin: {
          entrypoint: "DakFlareAdminApi",
          auth: "trusted service binding, same account, no token",
          methods: [
            "manifest",
            "integrationHealth",
            "listDevices",
            "mintServiceToken",
            "createWebhook",
            "putWorkflow",
            "listWebhookDeliveries",
            "replayDelivery",
          ],
        },
        runtime: {
          entrypoint: "DakFlareRuntimeApi",
          auth: "service token passed per call; no admin credential, no escape hatch",
          methods: ["manifest", "integrationHealth", "devices", "messages", "sendSms"],
          enforces: ["sms:send:transactional", "allowed_device_ids", "allowed_channels", "max_per_hour", "idempotency_key"],
        },
        inbound: {
          transport: "https",
          auth: "v1 envelope, X-Dakflare-Delivery as nonce and idempotency key, 300 s skew",
          note: "delivery stays a signed webhook; it is not an RPC",
        },
      },
      signing: {
        version: ENVELOPE_VERSION,
        alg: "HMAC-SHA256",
        // The receiver recomputes this exactly: version, timestamp, delivery id,
        // raw body, joined by dots, with the body left byte-for-byte alone.
        canonical: "v1.<unix_seconds>.<delivery_id>.<raw_body>",
        max_skew_seconds: DEFAULT_MAX_SKEW_SECONDS,
        headers: {
          timestamp: HEADER_TIMESTAMP,
          delivery: HEADER_DELIVERY,
          signature: HEADER_SIGNATURE,
          key_id: HEADER_KEY_ID,
          trace_id: HEADER_TRACE_ID,
        },
      },
      limits: {
        max_ack_bytes: 2048,
        max_allowlist_patterns: 20,
        default_service_sends_per_hour: 120,
      },
    },
    { headers: { [HEADER_TRACE_ID]: traceId } }
  );
}

export async function handleIntegrationHealth(req: Request, env: Env): Promise<Response> {
  const traceId = req.headers.get(HEADER_TRACE_ID) ?? crypto.randomUUID();
  const [deviceCounts, deliveryCounts, lastDelivery] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN revoked_at IS NULL THEN 1 ELSE 0 END) AS active
         FROM devices`
    ).first<{ total: number; active: number }>(),
    env.DB.prepare(
      `SELECT state, COUNT(*) AS count
         FROM integration_deliveries
        GROUP BY state`
    ).all<{ state: string; count: number }>(),
    env.DB.prepare(
      `SELECT MAX(delivered_at) AS last_delivery_at
         FROM integration_deliveries
        WHERE state = 'DELIVERED'`
    ).first<{ last_delivery_at: number | null }>(),
  ]);

  const byState: Record<string, number> = {
    PENDING: 0,
    RETRYING: 0,
    DELIVERED: 0,
    DEAD_LETTER: 0,
  };
  for (const row of deliveryCounts.results ?? []) {
    byState[row.state] = row.count;
  }

  return Response.json(
    {
      ok: true,
      dakflare_version: pkg.version,
      devices: {
        total: deviceCounts?.total ?? 0,
        active: deviceCounts?.active ?? 0,
      },
      deliveries: {
        pending: byState.PENDING,
        retrying: byState.RETRYING,
        delivered: byState.DELIVERED,
        dead_letter: byState.DEAD_LETTER,
        last_delivery_at: lastDelivery?.last_delivery_at ?? null,
      },
    },
    { headers: { [HEADER_TRACE_ID]: traceId } }
  );
}

/**
 * Replay one delivery.
 *
 * The row is looked up by BOTH ids, so an operator holding a delivery id from
 * one hook cannot replay it through another — the 404 is the same answer a
 * nonexistent id gets, which is also the answer that leaks least. A delivered
 * row is refused rather than re-sent: replay is for a receiver that missed it,
 * not a way to duplicate a notification that worked.
 */
export async function handleWebhookDeliveryReplay(
  req: Request,
  env: Env,
  actor: AdminActor,
  webhookId: string,
  deliveryId: string
): Promise<Response> {
  const traceId = req.headers.get(HEADER_TRACE_ID) ?? crypto.randomUUID();
  const row = await env.DB.prepare(
    `SELECT d.id, d.webhook_id, d.event_type, d.payload_json, d.state,
            w.target_url, w.enabled, w.custom_headers_json
       FROM integration_deliveries d
       JOIN webhooks w ON w.id = d.webhook_id
      WHERE d.id = ? AND d.webhook_id = ? AND w.kind = 'outbound'`
  )
    .bind(deliveryId, webhookId)
    .first<{
      id: string;
      webhook_id: string;
      event_type: string;
      payload_json: string;
      state: string;
      target_url: string;
      enabled: number;
      custom_headers_json: string | null;
    }>();

  if (row === null) {
    return Response.json({ error: "delivery_not_found" }, { status: 404 });
  }
  if (row.enabled !== 1) {
    return Response.json({ error: "webhook_disabled" }, { status: 409 });
  }
  if (row.state === "DELIVERED") {
    return Response.json({ error: "already_delivered" }, { status: 409 });
  }

  const now = Date.now();
  const reset = await env.DB.prepare(
    `UPDATE integration_deliveries
        SET state = 'PENDING', next_attempt_at = ?, last_error = NULL, trace_id = ?
      WHERE id = ? AND webhook_id = ? AND state <> 'DELIVERED'`
  )
    .bind(now, traceId, deliveryId, webhookId)
    .run();
  if (Number(reset.meta?.changes ?? 0) === 0) {
    // The row was delivered between the read and the update.
    return Response.json({ error: "already_delivered" }, { status: 409 });
  }

  let customHeaders: Record<string, string> = {};
  if (row.custom_headers_json !== null) {
    try {
      const parsed: unknown = JSON.parse(row.custom_headers_json);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof value === "string") customHeaders[name] = value;
        }
      }
    } catch {
      // A malformed header blob must not block a replay; send without it.
      customHeaders = {};
    }
  }

  if (env.WEBHOOK_QUEUE === undefined) {
    return Response.json({ error: "webhook_queue_unavailable" }, { status: 503 });
  }
  await env.WEBHOOK_QUEUE.send({
    deliveryId: row.id,
    webhookId: row.webhook_id,
    eventType: row.event_type,
    url: row.target_url,
    headers: { "Content-Type": "application/json", ...customHeaders },
    body: row.payload_json,
    traceId,
    replay: true,
  });

  await writeAudit(env, {
    action: "webhook.delivery.replay",
    actor: { userId: actor.userId, label: actor.label },
    subject: `${webhookId}:${deliveryId}`,
    detail: { trace_id: traceId, previous_state: row.state },
    ...requestMeta(req),
  });

  return Response.json(
    {
      replayed: true,
      webhook_id: webhookId,
      delivery_id: deliveryId,
      trace_id: traceId,
    },
    { status: 202, headers: { [HEADER_TRACE_ID]: traceId } }
  );
}
