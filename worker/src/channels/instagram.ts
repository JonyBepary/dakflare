/**
 * Instagram Messaging connector, for all three ways Meta lets a business own an
 * Instagram account. The three are genuinely different products, not labels on
 * the same token, so the host AND the app secret that verifies the webhook both
 * depend on the mode:
 *
 *  - `instagram_login`   — "Instagram API with Instagram Login"
 *    https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login
 *    Token is an Instagram User access token; API host is `graph.instagram.com`.
 *    The webhook is signed with the Instagram app's secret.
 *
 *  - `facebook_login`    — "Instagram API with Facebook Login"
 *    https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login
 *    Token is a Facebook Page access token for the linked Page; host is
 *    `graph.facebook.com`; webhook signed with the Facebook app's secret.
 *
 *  - `unified_login`     — "Instagram API with Facebook Login for Business"
 *    (the flow the console calls unified login / business login)
 *    https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login-for-business
 *    Token is a Business Integration System User token (no Page required);
 *    host is `graph.facebook.com`; webhook signed with that Facebook app's secret.
 *
 * The mode is stored on the connector row (`auth_mode`) and is never inferred
 * from the shape of a token — getting it wrong sends a valid token to the wrong
 * host, which reads as an auth failure rather than a configuration mistake.
 */

import {
  verifyMetaWebhookSignature,
  type MetaStatusUpdate,
} from "./meta-common";
import type {
  InboundMessagePayload,
  OutboundDeliveryResult,
  OutboundMessageParams,
} from "../plugins/types";

export type InstagramAuthMode = "unified_login" | "instagram_login" | "facebook_login";

export interface InstagramCredentials {
  authMode: InstagramAuthMode;
  /** The Instagram professional account id; also the connector's `account_id`. */
  igUserId: string;
  /** Instagram User, Page, or Business Integration System User token by mode. */
  accessToken: string;
  /**
   * The app secret for the app that owns this login. Instagram Login and
   * Facebook Login apps have different secrets; the connector's sealed
   * credential carries the one that matches `authMode`.
   */
  appSecret: string;
  graphVersion?: string;
}

const DEFAULT_GRAPH_VERSION = "v21.0";

/** Meta's "outside the 24-hour window" code/subcode pair for Instagram. */
const WINDOW_EXPIRED_CODE = 10;
const WINDOW_EXPIRED_SUBCODE = 2534022;

/**
 * The one place the host switch lives.
 *
 * `instagram_login` is the only mode whose calls go to `graph.instagram.com`.
 * Both Facebook Login variants are Facebook Graph calls.
 */
export function resolveInstagramApiHost(authMode: InstagramAuthMode): string {
  return authMode === "instagram_login"
    ? "https://graph.instagram.com"
    : "https://graph.facebook.com";
}

export async function verifyInstagramWebhook(
  req: Request,
  rawBody: Uint8Array | ArrayBuffer | string,
  creds: Pick<InstagramCredentials, "appSecret">
): Promise<boolean> {
  return verifyMetaWebhookSignature(req, rawBody, creds.appSecret);
}

export interface ParsedInstagramWebhook {
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
 * Parse an `instagram` webhook envelope.
 *
 * Facebook-Login deliveries put events in `entry[].messaging`; Instagram-Login
 * deliveries put them in `entry[].changes[].value` with `field === "messages"`.
 * Both are accepted because the connector supports both products, and a parser
 * that understood only one would silently drop every event on half the fleet.
 */
export function parseInstagramWebhook(rawBody: string): ParsedInstagramWebhook {
  const messages: InboundMessagePayload[] = [];
  const statuses: MetaStatusUpdate[] = [];

  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawBody === "" ? "{}" : rawBody);
    const record = asRecord(parsed);
    if (record === null || record.object !== "instagram") return { messages, statuses };
    payload = record;
  } catch {
    return { messages, statuses };
  }

  for (const entry of asRecords(payload.entry)) {
    const igAccountId = String(entry.id ?? "");

    // Facebook Login shape.
    const events: Array<Record<string, unknown>> = [...asRecords(entry.messaging)];

    // Instagram Login shape: changes[].value carries the same event object.
    for (const change of asRecords(entry.changes)) {
      if (change.field !== "messages") continue;
      const value = asRecord(change.value);
      if (value !== null) events.push(value);
    }

    for (const event of events) {
      const sender = asRecord(event.sender);
      const senderId = String(sender?.id ?? "");
      const timestamp = typeof event.timestamp === "number" ? event.timestamp : Date.now();
      if (senderId === "") continue;

      const message = asRecord(event.message);
      if (message !== null && message.is_echo !== true && message.is_deleted !== true) {
        messages.push({
          channel: "instagram",
          channelMessageId: String(message.mid ?? `${senderId}:${timestamp}`),
          sender: senderId, // IGSID
          recipient: igAccountId,
          body: typeof message.text === "string" ? message.text : "",
          timestamp,
          hasMedia: Array.isArray(message.attachments) && message.attachments.length > 0,
          rawPayload: event,
        });
      }

      const read = asRecord(event.read);
      if (read !== null && typeof read.mid === "string") {
        statuses.push({
          channel: "instagram",
          channelMessageId: read.mid,
          peerId: senderId,
          status: "read",
          timestamp,
        });
      }

      const delivery = asRecord(event.delivery);
      if (delivery !== null && Array.isArray(delivery.mids)) {
        for (const mid of delivery.mids) {
          if (typeof mid !== "string") continue;
          statuses.push({
            channel: "instagram",
            channelMessageId: mid,
            peerId: senderId,
            status: "delivered",
            timestamp:
              typeof delivery.watermark === "number" ? delivery.watermark : timestamp,
          });
        }
      }
    }
  }

  return { messages, statuses };
}

interface GraphErrorBody {
  error?: { code?: number; error_subcode?: number; message?: string };
}

/**
 * Send a DM, or a private reply to a comment.
 *
 * `commentId` switches the recipient to `{ comment_id }`, which is Meta's
 * private-reply shape: it sends one DM to the comment author and does not need
 * an IGSID up front. Everything else is a normal 24-hour-window reply.
 */
export async function sendInstagramOutbound(
  params: OutboundMessageParams & { commentId?: string },
  creds: InstagramCredentials
): Promise<OutboundDeliveryResult> {
  const host = resolveInstagramApiHost(creds.authMode);
  const version = creds.graphVersion ?? DEFAULT_GRAPH_VERSION;
  const url = `${host}/${version}/${encodeURIComponent(creds.igUserId)}/messages`;

  const recipient =
    params.commentId !== undefined
      ? { comment_id: params.commentId }
      : { id: params.to };

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${creds.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipient,
        message: params.mediaUrl
          ? { attachment: { type: "image", payload: { url: params.mediaUrl } } }
          : { text: params.body },
      }),
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
    const code = error?.error?.code;
    const subcode = error?.error?.error_subcode;

    if (res.status === 429) {
      return {
        success: false,
        state: "RETRY_BACKOFF",
        errorCode: "rate_limited",
        substate: typeof error?.error?.message === "string"
          ? error.error.message.slice(0, 120)
          : undefined,
      };
    }

    const windowExpired =
      (code === WINDOW_EXPIRED_CODE && subcode === WINDOW_EXPIRED_SUBCODE) ||
      subcode === 2018278;
    return {
      success: false,
      state: windowExpired
        ? "FAILED_PERMANENT"
        : res.status >= 500
          ? "RETRY_BACKOFF"
          : "FAILED_PERMANENT",
      errorCode: windowExpired
        ? "window_expired"
        : `instagram_error_${code ?? res.status}`,
      substate: typeof error?.error?.message === "string"
        ? error.error.message.slice(0, 120)
        : undefined,
    };
  }

  const data = (await res.json().catch(() => null)) as { message_id?: string } | null;
  return {
    success: true,
    channelMessageId: data?.message_id ?? "",
    state: "ACCEPTED_BY_CHANNEL",
    substate: `instagram_${creds.authMode}_accepted`,
  };
}
