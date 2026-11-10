/**
 * WhatsApp Business Cloud API Channel Connector — v7.0
 *
 * Implements Meta Cloud API webhook receiver (X-Hub-Signature-256 HMAC verification),
 * 24-hour conversational window tracking in D1, and Graph API outbound transmission.
 */

import type { Env } from "../index";
import type {
  ChannelPlugin,
  ChannelSessionWindow,
  InboundMessagePayload,
  OutboundDeliveryResult,
  OutboundMessageParams,
} from "../plugins/types";
import { computeCommandLifecycle } from "../lib/canonical-lifecycle";

const WINDOW_DURATION_MS = 24 * 60 * 60 * 1000;

export class WhatsAppCloudChannelPlugin implements ChannelPlugin {
  readonly id = "builtin:whatsapp";
  readonly name = "WhatsApp Business Cloud API";
  readonly channel = "whatsapp";

  async verifyWebhook(req: Request, rawBody: string, env: Env): Promise<boolean> {
    const signature = req.headers.get("X-Hub-Signature-256");
    const secret = (env as unknown as Record<string, string | undefined>).WHATSAPP_APP_SECRET;
    if (!secret || !signature || !signature.startsWith("sha256=")) return false;

    const expectedHex = signature.slice(7);
    if (expectedHex.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(expectedHex)) return false;

    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );

    const sigBytes = new Uint8Array(
      expectedHex.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) ?? []
    );

    return crypto.subtle.verify("HMAC", key, sigBytes, enc.encode(rawBody));
  }

  async parseInbound(_req: Request, rawBody: string, _env: Env): Promise<InboundMessagePayload[]> {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody || "{}");
    } catch {
      return [];
    }

    const entries = (payload.entry ?? []) as Array<Record<string, unknown>>;
    const results: InboundMessagePayload[] = [];

    for (const entry of entries) {
      const changes = (entry.changes ?? []) as Array<Record<string, unknown>>;
      for (const change of changes) {
        const val = change.value as Record<string, unknown> | undefined;
        if (!val) continue;

        const messages = (val.messages ?? []) as Array<Record<string, unknown>>;
        for (const msg of messages) {
          const from = String(msg.from ?? "");
          const msgId = String(msg.id ?? "");
          const textObj = msg.text as { body?: string } | undefined;
          const body = textObj?.body ?? "";
          const ts = typeof msg.timestamp === "string" ? Number(msg.timestamp) * 1000 : Date.now();

          if (!from) continue;

          results.push({
            channel: "whatsapp",
            channelMessageId: msgId,
            sender: from,
            recipient: "business",
            body,
            timestamp: ts,
            rawPayload: msg,
          });
        }
      }
    }

    return results;
  }

  async getSessionWindow(peerId: string, env: Env): Promise<ChannelSessionWindow> {
    try {
      const row = await env.DB.prepare(
        `SELECT session_state, window_expires_at FROM conversations
          WHERE channel = 'whatsapp' AND peer_id = ?`
      )
        .bind(peerId)
        .first<{ session_state: string; window_expires_at: number }>();

      if (!row) {
        return { windowOpen: false, requiresTemplate: true };
      }

      const now = Date.now();
      const open = row.session_state === "WINDOW_OPEN" && row.window_expires_at > now;
      return {
        windowOpen: open,
        expiresAt: row.window_expires_at,
        requiresTemplate: !open,
      };
    } catch {
      return { windowOpen: false, requiresTemplate: true };
    }
  }

  async sendOutbound(params: OutboundMessageParams, env: Env): Promise<OutboundDeliveryResult> {
    const vars = env as unknown as Record<string, string | undefined>;
    const token = vars.WHATSAPP_ACCESS_TOKEN;
    const phoneId = vars.WHATSAPP_PHONE_NUMBER_ID;

    if (!token || !phoneId) {
      return {
        success: false,
        state: "FAILED_PERMANENT",
        errorCode: "whatsapp_credentials_missing",
        lifecycle: computeCommandLifecycle({
          channel: "whatsapp",
          state: "FAILED",
          created_at: Date.now(),
          error_code: "whatsapp_credentials_missing",
        }),
      };
    }

    // Check conversation policy window
    const session = await this.getSessionWindow(params.to, env);
    if (session.requiresTemplate && !params.templateId) {
      return {
        success: false,
        state: "FAILED_PERMANENT",
        errorCode: "template_required",
        substate: "24h_customer_service_window_expired",
        lifecycle: computeCommandLifecycle({
          channel: "whatsapp",
          state: "FAILED",
          created_at: Date.now(),
          error_code: "template_required",
        }),
      };
    }

    const url = `https://graph.facebook.com/v21.0/${phoneId}/messages`;
    let requestBody: Record<string, unknown>;

    if (params.templateId) {
      requestBody = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: params.to,
        type: "template",
        template: {
          name: params.templateId,
          language: { code: "en_US" },
        },
      };
    } else {
      requestBody = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: params.to,
        type: "text",
        text: { body: params.body },
      };
    }

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    if (!res.ok) {
      const errJson = (await res.json().catch(() => null)) as {
        error?: { message?: string; code?: number };
      } | null;
      return {
        success: false,
        state: "FAILED_PERMANENT",
        errorCode: `whatsapp_error_${errJson?.error?.code ?? res.status}`,
        substate: errJson?.error?.message?.slice(0, 100),
        lifecycle: computeCommandLifecycle({
          channel: "whatsapp",
          state: "FAILED",
          created_at: Date.now(),
          error_code: `whatsapp_error_${res.status}`,
        }),
      };
    }

    const result = (await res.json().catch(() => null)) as {
      messages?: Array<{ id?: string }>;
    } | null;
    const msgId = result?.messages?.[0]?.id ?? "";

    return {
      success: true,
      channelMessageId: msgId,
      state: "ACCEPTED_BY_CHANNEL",
      substate: "meta_graph_api_accepted",
      lifecycle: computeCommandLifecycle({
        channel: "whatsapp",
        state: "SENT",
        created_at: Date.now(),
      }),
    };
  }
}
