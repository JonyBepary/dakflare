/**
 * Facebook Messenger Platform connector.
 *
 * Page webhooks (`object === "page"`), PSID peers, the 24-hour standard
 * window, and the optional `HUMAN_AGENT` tag that extends it to seven days.
 *
 * Docs followed:
 *  - Messenger Platform webhooks: https://developers.facebook.com/docs/messenger-platform/webhooks
 *  - Send API: https://developers.facebook.com/docs/messenger-platform/reference/send-api
 *  - Messaging window + tags: https://developers.facebook.com/docs/messenger-platform/policy/policy-overview
 *
 * Error subcode 2018278 is Meta's "this message is sent outside of the allowed
 * window"; it becomes the product's existing `window_expired` code so callers
 * do not learn a second spelling for the same condition.
 */

import { verifyMetaWebhookSignature, type MetaStatusUpdate } from "./meta-common";
import type {
  InboundMessagePayload,
  OutboundDeliveryResult,
  OutboundMessageParams,
} from "../plugins/types";

export interface MessengerCredentials {
  /** The Facebook Page id. Also the connector's `account_id`. */
  pageId: string;
  /** Page access token, not a user token: it is what the Send API accepts. */
  pageAccessToken: string;
  /** The app secret Meta shows for the app that owns the Page webhook. */
  appSecret: string;
  /** Graph version, e.g. `v21.0`. Pinned by the caller, not guessed here. */
  graphVersion?: string;
}

const DEFAULT_GRAPH_VERSION = "v21.0";

/** Messenger's "outside the 24h window" subcode. */
const WINDOW_EXPIRED_SUBCODE = 2018278;

export async function verifyMessengerWebhook(
  req: Request,
  rawBody: Uint8Array | ArrayBuffer | string,
  creds: Pick<MessengerCredentials, "appSecret">
): Promise<boolean> {
  return verifyMetaWebhookSignature(req, rawBody, creds.appSecret);
}

export interface ParsedMessengerWebhook {
  messages: InboundMessagePayload[];
  statuses: MetaStatusUpdate[];
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

/**
 * Parse a `page` webhook envelope into messages and delivery receipts.
 *
 * Echoes are skipped: an echo is the Page's own outbound message coming back,
 * and storing it as inbound would make the console show every reply twice and
 * could re-trigger a flow. Postbacks are inbound because the user acted.
 */
export function parseMessengerWebhook(rawBody: string): ParsedMessengerWebhook {
  const messages: InboundMessagePayload[] = [];
  const statuses: MetaStatusUpdate[] = [];

  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawBody === "" ? "{}" : rawBody);
    const record = asRecord(parsed);
    if (record === null || record.object !== "page") return { messages, statuses };
    payload = record;
  } catch {
    return { messages, statuses };
  }

  for (const entry of asRecords(payload.entry)) {
    const pageId = String(entry.id ?? "");
    for (const event of asRecords(entry.messaging)) {
      const sender = asRecord(event.sender);
      const senderId = String(sender?.id ?? "");
      const timestamp = typeof event.timestamp === "number" ? event.timestamp : Date.now();
      if (senderId === "") continue;

      const message = asRecord(event.message);
      if (message !== null && message.is_echo !== true && message.is_deleted !== true) {
        messages.push({
          channel: "messenger",
          channelMessageId: String(message.mid ?? `${senderId}:${timestamp}`),
          sender: senderId, // PSID
          recipient: pageId,
          body: typeof message.text === "string" ? message.text : "",
          timestamp,
          hasMedia: Array.isArray(message.attachments) && message.attachments.length > 0,
          rawPayload: event,
        });
      }

      const postback = asRecord(event.postback);
      if (postback !== null) {
        messages.push({
          channel: "messenger",
          channelMessageId: String(postback.mid ?? `pb:${senderId}:${timestamp}`),
          sender: senderId,
          recipient: pageId,
          body: typeof postback.payload === "string"
            ? postback.payload
            : typeof postback.title === "string"
              ? postback.title
              : "",
          timestamp,
          rawPayload: event,
        });
      }

      const delivery = asRecord(event.delivery);
      if (delivery !== null && Array.isArray(delivery.mids)) {
        for (const mid of delivery.mids) {
          if (typeof mid !== "string") continue;
          statuses.push({
            channel: "messenger",
            channelMessageId: mid,
            peerId: senderId,
            status: "delivered",
            timestamp:
              typeof delivery.watermark === "number" ? delivery.watermark : timestamp,
          });
        }
      }

      const read = asRecord(event.read);
      if (read !== null && typeof read.watermark === "number") {
        statuses.push({
          channel: "messenger",
          channelMessageId: `read:${senderId}:${read.watermark}`,
          peerId: senderId,
          status: "read",
          timestamp: read.watermark,
        });
      }
    }
  }

  return { messages, statuses };
}

interface GraphErrorBody {
  error?: { code?: number; error_subcode?: number; message?: string };
}

function statusFromHttp(
  httpStatus: number,
  error: GraphErrorBody | null
): { state: OutboundDeliveryResult["state"]; errorCode: string; retryAfterSeconds?: number } {
  const code = error?.error?.code;
  const subcode = error?.error?.error_subcode;
  if (httpStatus === 429) {
    return { state: "RETRY_BACKOFF", errorCode: "rate_limited" };
  }
  if (subcode === WINDOW_EXPIRED_SUBCODE || (code === 10 && subcode === 2534022)) {
    return { state: "FAILED_PERMANENT", errorCode: "window_expired" };
  }
  if (httpStatus >= 500) {
    return { state: "RETRY_BACKOFF", errorCode: `messenger_error_${code ?? httpStatus}` };
  }
  return { state: "FAILED_PERMANENT", errorCode: `messenger_error_${code ?? httpStatus}` };
}

/**
 * Send one message through the Messenger Send API.
 *
 * `useHumanAgentTag` sets `messaging_type: MESSAGE_TAG` with `HUMAN_AGENT`,
 * which is the only supported way to reply after the 24-hour window closed
 * (max seven days, and only for a human agent's reply). Without it the call is
 * `RESPONSE` and Meta rejects a closed window as `window_expired`.
 */
export async function sendMessengerOutbound(
  params: OutboundMessageParams & { useHumanAgentTag?: boolean },
  creds: MessengerCredentials
): Promise<OutboundDeliveryResult> {
  const version = creds.graphVersion ?? DEFAULT_GRAPH_VERSION;
  const url = `https://graph.facebook.com/${version}/${encodeURIComponent(creds.pageId)}/messages`;

  const body: Record<string, unknown> = {
    recipient: { id: params.to },
    messaging_type: params.useHumanAgentTag === true ? "MESSAGE_TAG" : "RESPONSE",
    message: params.mediaUrl
      ? {
          attachment: {
            type: "image",
            payload: { url: params.mediaUrl, is_reusable: true },
          },
        }
      : { text: params.body },
  };
  if (params.useHumanAgentTag === true) body.tag = "HUMAN_AGENT";

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${creds.pageAccessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return {
      success: false,
      state: "RETRY_BACKOFF",
      errorCode: "network_error",
      substate: String(error).slice(0, 120),
    };
  }

  if (!res.ok) {
    const error = (await res.json().catch(() => null)) as GraphErrorBody | null;
    const mapped = statusFromHttp(res.status, error);
    const message = error?.error?.message;
    return {
      success: false,
      state: mapped.state,
      errorCode: mapped.errorCode,
      ...(mapped.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: mapped.retryAfterSeconds }),
      substate: typeof message === "string" ? message.slice(0, 120) : undefined,
    };
  }

  const data = (await res.json().catch(() => null)) as { message_id?: string } | null;
  return {
    success: true,
    channelMessageId: data?.message_id ?? "",
    state: "ACCEPTED_BY_CHANNEL",
    substate: "meta_messenger_accepted",
  };
}
