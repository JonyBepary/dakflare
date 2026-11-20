/**
 * WhatsApp Business Cloud API connector (v7.0).
 *
 * The parsing and sending here are shared by two callers:
 *
 *  - the legacy env-credential plugin used by `/v1/channels/whatsapp/webhook`
 *    (`WhatsAppCloudChannelPlugin`), and
 *  - the per-connector path, which passes the sealed credential's app secret,
 *    token and phone number id instead of reading deployment-wide variables.
 *
 * One parser and one sender serve both, deliberately. Two implementations of
 * one platform is how a message arrives on the connector route but not the
 * legacy one (or the reverse), and there is no test that would notice.
 *
 * Docs followed:
 *  - Webhook payload (`object: "whatsapp_business_account"`, `changes[].value`):
 *    https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples
 *  - Media/interactive/button message shapes:
 *    https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/components
 *  - Coexistence adds fields such as `smb_message_echoes` and `history` to the
 *    same webhook: https://developers.facebook.com/docs/whatsapp/embedded-signup/coexistence
 */

import type { Env } from "../index";
import type {
  ChannelPlugin,
  ChannelSessionWindow,
  InboundMessagePayload,
  OutboundDeliveryResult,
  OutboundMessageParams,
} from "../plugins/types";
import type { MetaDeliveryStatus, MetaStatusUpdate } from "./meta-common";
import { computeCommandLifecycle } from "../lib/canonical-lifecycle";

/** Meta's customer-service window. */
export const WHATSAPP_WINDOW_MS = 24 * 60 * 60 * 1000;

const WHATSAPP_VERIFY_KEYS = new Map<string, Promise<CryptoKey>>();

function getWhatsAppVerifyKey(secret: string): Promise<CryptoKey> {
  let cached = WHATSAPP_VERIFY_KEYS.get(secret);
  if (cached === undefined) {
    if (WHATSAPP_VERIFY_KEYS.size >= 8) WHATSAPP_VERIFY_KEYS.clear();
    cached = crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );
    WHATSAPP_VERIFY_KEYS.set(secret, cached);
  }
  return cached;
}

/* ───────────────────────────── shared parser ───────────────────────────── */

export interface ParsedWhatsAppCloudWebhook {
  messages: InboundMessagePayload[];
  statuses: MetaStatusUpdate[];
  /**
   * `changes[].field` values this parser does not understand, by name.
   *
   * Coexistence puts `smb_message_echoes` and `history` beside `messages` in
   * the same delivery. They are skipped explicitly rather than guessed at: a
   * half-stored echo would show the operator their own reply as an inbound
   * customer message.
   */
  skippedFields: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asRecords(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const item of value) {
    const record = asRecord(item);
    if (record !== null) out.push(record);
  }
  return out;
}

/** WhatsApp timestamps are Unix seconds as strings in some payloads. */
function whatsappTimestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed < 1e12 ? parsed * 1000 : parsed;
  }
  return Date.now();
}

/**
 * The user-visible text of one inbound message.
 *
 * Text is the simple case. Captions on media are what the customer actually
 * typed, interactive/list/button replies carry the option the customer chose,
 * and a bare reaction has no text at all — empty body, not a fabricated one.
 */
function whatsappMessageBody(message: Record<string, unknown>): string {
  const text = asRecord(message.text);
  if (text !== null && typeof text.body === "string") return text.body;

  for (const mediaType of ["image", "video", "document", "audio"]) {
    const media = asRecord(message[mediaType]);
    if (media !== null && typeof media.caption === "string") return media.caption;
  }

  const interactive = asRecord(message.interactive);
  if (interactive !== null) {
    const buttonReply = asRecord(interactive.button_reply);
    if (buttonReply !== null && typeof buttonReply.title === "string") {
      return buttonReply.title;
    }
    const listReply = asRecord(interactive.list_reply);
    if (listReply !== null && typeof listReply.title === "string") return listReply.title;
  }

  const button = asRecord(message.button);
  if (button !== null) {
    if (typeof button.text === "string") return button.text;
    if (typeof button.payload === "string") return button.payload;
  }

  return "";
}

function whatsappHasMedia(message: Record<string, unknown>): boolean {
  for (const mediaType of ["image", "video", "document", "audio", "sticker"]) {
    if (message[mediaType] !== undefined) return true;
  }
  return false;
}

const WHATSAPP_STATUSES = new Set<string>(["sent", "delivered", "read", "failed"]);

function whatsappStatus(value: unknown): MetaDeliveryStatus | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return WHATSAPP_STATUSES.has(normalized) ? (normalized as MetaDeliveryStatus) : null;
}

/**
 * Parse the WhatsApp Business Account webhook shape.
 *
 * Shared by the legacy plugin and the connector ingress. It returns both
 * messages and statuses: the legacy route only consumed messages, so folding
 * statuses in here loses nothing and means receipts are parsed exactly once.
 */
export function parseWhatsAppCloudWebhook(rawBody: string): ParsedWhatsAppCloudWebhook {
  const messages: InboundMessagePayload[] = [];
  const statuses: MetaStatusUpdate[] = [];
  const skippedFields: string[] = [];

  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawBody === "" ? "{}" : rawBody);
    const record = asRecord(parsed);
    if (record === null) return { messages, statuses, skippedFields };
    payload = record;
  } catch {
    return { messages, statuses, skippedFields };
  }

  // The legacy parser accepted any envelope with `entry`; keep that tolerance
  // while preferring the documented object name.
  for (const entry of asRecords(payload.entry)) {
    for (const change of asRecords(entry.changes)) {
      const field = typeof change.field === "string" ? change.field : "";
      if (field !== "messages") {
        if (field !== "") skippedFields.push(field);
        continue;
      }

      const value = asRecord(change.value);
      if (value === null) continue;

      for (const message of asRecords(value.messages)) {
        const from = String(message.from ?? "");
        const messageId = String(message.id ?? "");
        if (from === "" || messageId === "") continue;

        messages.push({
          channel: "whatsapp",
          channelMessageId: messageId,
          sender: from, // wa_id
          recipient: "business",
          body: whatsappMessageBody(message),
          timestamp: whatsappTimestamp(message.timestamp),
          hasMedia: whatsappHasMedia(message),
          rawPayload: message,
        });
      }

      for (const receipt of asRecords(value.statuses)) {
        const messageId = String(receipt.id ?? "");
        const status = whatsappStatus(receipt.status);
        const peerId = String(receipt.recipient_id ?? "");
        if (messageId === "" || status === null) continue;

        const firstError = asRecords(receipt.errors)[0];
        const errorCode =
          firstError !== undefined && firstError.code !== undefined
            ? String(firstError.code)
            : undefined;

        statuses.push({
          channel: "whatsapp",
          channelMessageId: messageId,
          peerId,
          status,
          timestamp: whatsappTimestamp(receipt.timestamp),
          errorCode,
        });
      }
    }
  }

  return { messages, statuses, skippedFields };
}

/**
 * Dedupe identity for a receipt.
 *
 * `wamid` alone is not enough: `sent` then `delivered` are two real receipts
 * for one message, and the Durable Object's ledger would drop the second as a
 * replay. `wamid:status` keeps them distinct. `ingest.ts` strips the suffix
 * again before matching `messages.local_id`.
 */
export function whatsappStatusEventId(messageId: string, status: string): string {
  return `${messageId}:${status}`;
}

const STATUS_SUFFIX = /:(sent|delivered|read|failed)$/;

/** Recover the `wamid` a receipt event points at. */
export function whatsappMessageIdFromEventId(eventId: string): string {
  return eventId.replace(STATUS_SUFFIX, "");
}

/* ───────────────────────────── shared sender ───────────────────────────── */

export interface WhatsAppCloudCredentials {
  /** System user or business integration token. */
  accessToken: string;
  /** `phone_number_id`; also the connector's `account_id`. */
  phoneNumberId: string;
  graphVersion?: string;
}

export interface WhatsAppCloudSendOptions {
  /**
   * The window answer, when the caller already has one (the connector path
   * reads it from the Durable Object). Omitted, the legacy plugin supplies the
   * D1 `conversations` answer before calling, preserving its old behaviour.
   */
  session?: ChannelSessionWindow;
  graphVersion?: string;
}

const DEFAULT_GRAPH_VERSION = "v21.0";

function credentialsMissing(): OutboundDeliveryResult {
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

/**
 * Send one Cloud API message with explicit credentials.
 *
 * The legacy plugin and the connector path both land here; only the credential
 * source and the window lookup differ. Request body, error mapping and the
 * result shape are unchanged from the pre-refactor plugin.
 */
export async function sendWhatsAppCloudOutbound(
  params: OutboundMessageParams,
  credentials: WhatsAppCloudCredentials,
  options: WhatsAppCloudSendOptions = {}
): Promise<OutboundDeliveryResult> {
  if (credentials.accessToken === "" || credentials.phoneNumberId === "") {
    return credentialsMissing();
  }

  if (options.session !== undefined && options.session.requiresTemplate && !params.templateId) {
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

  const version = credentials.graphVersion ?? options.graphVersion ?? DEFAULT_GRAPH_VERSION;
  const url = `https://graph.facebook.com/${version}/${credentials.phoneNumberId}/messages`;
  let requestBody: Record<string, unknown>;

  if (params.templateId) {
    requestBody = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: params.to,
      type: "template",
      template: {
        name: params.templateId,
        language: { code: params.templateLanguage ?? "en_US" },
        ...(params.templateArgs && params.templateArgs.length > 0
          ? {
              components: [
                {
                  type: "body",
                  parameters: params.templateArgs.map((text) => ({ type: "text", text })),
                },
              ],
            }
          : {}),
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
      Authorization: `Bearer ${credentials.accessToken}`,
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

/* ───────────────────────────── legacy plugin ───────────────────────────── */

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
    const key = await getWhatsAppVerifyKey(secret);

    const sigBytes = new Uint8Array(
      expectedHex.match(/.{1,2}/g)?.map((byte) => parseInt(byte, 16)) ?? []
    );

    return crypto.subtle.verify("HMAC", key, sigBytes, enc.encode(rawBody));
  }

  async parseInbound(_req: Request, rawBody: string, _env: Env): Promise<InboundMessagePayload[]> {
    return parseWhatsAppCloudWebhook(rawBody).messages;
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
      return credentialsMissing();
    }

    // Check conversation policy window
    const session = await this.getSessionWindow(params.to, env);
    return sendWhatsAppCloudOutbound(
      params,
      { accessToken: token, phoneNumberId: phoneId },
      { session }
    );
  }
}
