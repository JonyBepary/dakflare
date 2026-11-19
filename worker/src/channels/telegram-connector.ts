/**
 * Telegram Bot API connector (per-connector credentials).
 *
 * Distinct from `channels/telegram.ts`, which is the legacy env-var plugin the
 * existing `/v1/channels/telegram/webhook` route uses. This module takes the
 * bot token and webhook secret token from the connector row, so several bots
 * can live side by side without a global secret.
 *
 * Docs followed:
 *  - setWebhook `secret_token` / `X-Telegram-Bot-Api-Secret-Token`:
 *    https://core.telegram.org/bots/api#setwebhook
 *  - Update kinds (including `business_message` for Telegram Business):
 *    https://core.telegram.org/bots/api#update
 *  - Rate limits (`429` + `parameters.retry_after`):
 *    https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this
 */

import { constantTimeTokenEqual } from "./meta-common";
import type {
  InboundMessagePayload,
  OutboundDeliveryResult,
  OutboundMessageParams,
} from "../plugins/types";

export interface TelegramConnectorCredentials {
  /** Bot token from BotFather. Sealed at rest with the rest of the credential. */
  botToken: string;
  /**
   * The `secret_token` passed to `setWebhook`. Telegram echoes it in every
   * update; this is the ingress credential. Empty disables the connector's
   * webhook rather than accepting unsigned updates.
   */
  secretToken: string;
  /** Bot id or username, informational only; the connector owns `account_id`. */
  botId?: string;
}

/**
 * Verify the `X-Telegram-Bot-Api-Secret-Token` header.
 *
 * Telegram sends the value verbatim, so both sides are hashed and compared in
 * constant time for the same reason as the Meta challenge.
 */
export async function verifyTelegramWebhook(
  req: Request,
  creds: Pick<TelegramConnectorCredentials, "secretToken">
): Promise<boolean> {
  const provided = req.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (provided === null || creds.secretToken === "") return false;
  return constantTimeTokenEqual(provided, creds.secretToken);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Parse a Bot API update.
 *
 * `business_message` is a message a Telegram Business account received and
 * forwarded to its bot; it has the same inner shape as `message` but a
 * different envelope key. Treating it as unknown would make every business
 * bot silently deaf, which is the mode the schema's `business_bot` auth value
 * exists for.
 */
export function parseTelegramWebhook(rawBody: string): InboundMessagePayload[] {
  let update: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawBody === "" ? "{}" : rawBody);
    const record = asRecord(parsed);
    if (record === null) return [];
    update = record;
  } catch {
    return [];
  }

  const message =
    asRecord(update.message) ??
    asRecord(update.business_message) ??
    asRecord(update.edited_message);
  if (message === null) return [];

  const chat = asRecord(message.chat);
  const from = asRecord(message.from);
  const chatId = String(chat?.id ?? from?.id ?? "");
  if (chatId === "") return [];

  const messageId = String(message.message_id ?? "");
  const timestamp = typeof message.date === "number" ? message.date * 1000 : Date.now();

  // message_id is unique per chat, not per bot, so the chat id is part of the
  // idempotency key. A retried update carries the same pair and is deduped in
  // the connection's Durable Object.
  const eventId = `${chatId}:${messageId}`;

  return [
    {
      channel: "telegram",
      channelMessageId: eventId,
      sender: chatId,
      recipient: "bot",
      body: typeof message.text === "string" ? message.text : "",
      timestamp,
      hasMedia:
        message.photo !== undefined ||
        message.document !== undefined ||
        message.voice !== undefined ||
        message.video !== undefined,
      rawPayload: update,
    },
  ];
}

/**
 * `sendMessage`, mapping Telegram's own backpressure contract.
 *
 * Telegram answers 429 with `parameters.retry_after` in SECONDS. That is a
 * scheduled retry, not a failure: the caller must wait exactly that long. A
 * plain 5xx is also retryable but has no schedule, so it returns without a
 * `retryAfterSeconds` and the caller's own backoff decides.
 */
export async function sendTelegramOutbound(
  params: OutboundMessageParams,
  creds: TelegramConnectorCredentials
): Promise<OutboundDeliveryResult> {
  if (creds.botToken === "") {
    return {
      success: false,
      state: "FAILED_PERMANENT",
      errorCode: "telegram_bot_token_missing",
    };
  }

  const url = `https://api.telegram.org/bot${creds.botToken}/sendMessage`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: params.to, text: params.body }),
    });
  } catch (error) {
    return {
      success: false,
      state: "RETRY_BACKOFF",
      errorCode: "network_error",
      substate: String(error).slice(0, 120),
    };
  }

  const data = (await res.json().catch(() => null)) as {
    ok?: boolean;
    description?: string;
    parameters?: { retry_after?: number };
    result?: { message_id?: number };
  } | null;

  if (res.status === 429) {
    const headerRetry = Number(res.headers.get("Retry-After"));
    const retryAfter =
      typeof data?.parameters?.retry_after === "number"
        ? data.parameters.retry_after
        : Number.isFinite(headerRetry) && headerRetry > 0
          ? headerRetry
          : 5;
    return {
      success: false,
      state: "RETRY_BACKOFF",
      errorCode: "rate_limited",
      retryAfterSeconds: retryAfter,
      substate: "telegram_retry_after",
    };
  }

  if (!res.ok || data === null || data.ok === false) {
    return {
      success: false,
      state: res.status >= 500 ? "RETRY_BACKOFF" : "FAILED_PERMANENT",
      errorCode: `telegram_error_${res.status}`,
      substate:
        typeof data?.description === "string" ? data.description.slice(0, 120) : undefined,
    };
  }

  return {
    success: true,
    channelMessageId: String(data.result?.message_id ?? ""),
    state: "ACCEPTED_BY_CHANNEL",
    substate: "telegram_accepted",
  };
}
