/**
 * Native SMS Handset Radio Channel Connector — v7.0
 *
 * Wraps the existing Android handset radio queue and WebSocket lease
 * into the unified ChannelPlugin interface.
 */

import type { Env } from "../index";
import type {
  ChannelPlugin,
  InboundMessagePayload,
  OutboundDeliveryResult,
  OutboundMessageParams,
} from "../plugins/types";
import { enqueueOutboundCommand } from "../lib/commands";
import { computeCommandLifecycle } from "../lib/canonical-lifecycle";

export class SmsChannelPlugin implements ChannelPlugin {
  readonly id = "builtin:sms";
  readonly name = "DakFlare Handset Radio (SMS)";
  readonly channel = "sms";

  async verifyWebhook(_req: Request, _rawBody: string, _env: Env): Promise<boolean> {
    // Handset uses ECDSA P-256 canonical string signature verification in routes/incoming.ts
    return true;
  }

  async parseInbound(_req: Request, _rawBody: string, _env: Env): Promise<InboundMessagePayload[]> {
    // Handset parses inbound SMS PDU and posts to /v1/sms/incoming/batch
    return [];
  }

  async sendOutbound(params: OutboundMessageParams, env: Env): Promise<OutboundDeliveryResult> {
    // Look up primary paired device
    const device = await env.DB.prepare(
      `SELECT device_id FROM devices WHERE archived_at IS NULL AND revoked_at IS NULL ORDER BY last_seen DESC LIMIT 1`
    ).first<{ device_id: string }>();

    if (!device) {
      return {
        success: false,
        state: "FAILED_PERMANENT",
        errorCode: "no_paired_handset",
        lifecycle: computeCommandLifecycle({
          channel: "sms",
          state: "FAILED",
          created_at: Date.now(),
          error_code: "no_paired_handset",
        }),
      };
    }

    const commandId = crypto.randomUUID();
    const enqueued = await enqueueOutboundCommand(env, {
      deviceId: device.device_id,
      commandId,
      to: params.to,
      body: params.body,
      priority: "normal",
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    });

    if (!enqueued.ok) {
      return {
        success: false,
        state: "FAILED_PERMANENT",
        errorCode: "enqueue_failed",
        lifecycle: computeCommandLifecycle({
          channel: "sms",
          state: "FAILED",
          created_at: Date.now(),
          error_code: "enqueue_failed",
        }),
      };
    }

    return {
      success: true,
      channelMessageId: commandId,
      state: "ACCEPTED_BY_CHANNEL",
      substate: "queued_for_handset_lease",
      lifecycle: computeCommandLifecycle({
        channel: "sms",
        state: "PENDING",
        created_at: Date.now(),
      }),
    };
  }
}
