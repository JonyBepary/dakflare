/**
 * Telegram Bot API Channel Connector — v7.0
 *
 * Implements official Telegram Bot webhook receiver and outbound sender
 * with 429 retry_after rate limit backoff.
 */

import type { Env } from "../index";
import type {
  ChannelPlugin,
  InboundMessagePayload,
  OutboundDeliveryResult,
  OutboundMessageParams,
} from "../plugins/types";
import { computeCommandLifecycle } from "../lib/canonical-lifecycle";

export class TelegramChannelPlugin implements ChannelPlugin {
  readonly id = "builtin:telegram";
  readonly name = "Telegram Bot API";
  readonly channel = "telegram";

  async verifyWebhook(req: Request, _rawBody: string, env: Env): Promise<boolean> {
    const secret = req.headers.get("X-Telegram-Bot-Api-Secret-Token");
    const vars = env as unknown as Record<string, string | undefined>;
    const expected = vars.TELEGRAM_WEBHOOK_SECRET ?? vars.TELEGRAM_SECRET_TOKEN;
    if (!expected || !secret) return false;

    const enc = new TextEncoder();
    const [a, b] = await Promise.all([
      crypto.subtle.digest("SHA-256", enc.encode(secret)),
      crypto.subtle.digest("SHA-256", enc.encode(expected)),
    ]);
    const viewA = new Uint8Array(a);
    const viewB = new Uint8Array(b);
    let diff = 0;
    for (let i = 0; i < viewA.length; i++) diff |= viewA[i] ^ viewB[i];
    return diff === 0;
  }

  async parseInbound(_req: Request, rawBody: string, _env: Env): Promise<InboundMessagePayload[]> {
    let update: Record<string, unknown>;
    try {
      update = JSON.parse(rawBody || "{}");
    } catch {
      return [];
    }

    const message = (update.message ?? update.edited_message) as Record<string, unknown> | undefined;
    if (!message || typeof message !== "object") return [];

    const chat = message.chat as Record<string, unknown> | undefined;
    const from = message.from as Record<string, unknown> | undefined;
    const chatId = String(chat?.id ?? from?.id ?? "");
    const text = typeof message.text === "string" ? message.text : "";
    const messageId = String(message.message_id ?? "");
    const date = typeof message.date === "number" ? message.date * 1000 : Date.now();

    if (!chatId) return [];

    return [
      {
        channel: "telegram",
        channelMessageId: messageId,
        sender: chatId,
        recipient: "bot",
        body: text,
        timestamp: date,
        rawPayload: update,
      },
    ];
  }

  async sendOutbound(params: OutboundMessageParams, env: Env): Promise<OutboundDeliveryResult> {
    const token = (env as unknown as Record<string, string | undefined>).TELEGRAM_BOT_TOKEN;
    if (!token) {
      return {
        success: false,
        state: "FAILED_PERMANENT",
        errorCode: "telegram_bot_token_missing",
        lifecycle: computeCommandLifecycle({
          channel: "telegram",
          state: "FAILED",
          created_at: Date.now(),
          error_code: "telegram_bot_token_missing",
        }),
      };
    }

    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: params.to,
        text: params.body,
      }),
    });

    if (res.status === 429) {
      const data = (await res.json().catch(() => null)) as {
        parameters?: { retry_after?: number };
      } | null;
      const retryAfter = data?.parameters?.retry_after ?? 5;
      return {
        success: false,
        state: "RETRY_BACKOFF",
        retryAfterSeconds: retryAfter,
        lifecycle: computeCommandLifecycle({
          channel: "telegram",
          state: "RETRY_BACKOFF",
          created_at: Date.now(),
          retry_after: retryAfter,
        }),
      };
    }

    if (!res.ok) {
      const errText = await res.text().catch(() => "unknown");
      return {
        success: false,
        state: "FAILED_PERMANENT",
        errorCode: `telegram_error_${res.status}`,
        substate: errText.slice(0, 100),
        lifecycle: computeCommandLifecycle({
          channel: "telegram",
          state: "FAILED",
          created_at: Date.now(),
          error_code: `telegram_error_${res.status}`,
        }),
      };
    }

    const json = (await res.json().catch(() => null)) as {
      result?: { message_id?: number };
    } | null;
    const msgId = String(json?.result?.message_id ?? "");

    return {
      success: true,
      channelMessageId: msgId,
      state: "DELIVERED",
      substate: "telegram_delivered",
      lifecycle: computeCommandLifecycle({
        channel: "telegram",
        state: "DELIVERED",
        created_at: Date.now(),
      }),
    };
  }
}
