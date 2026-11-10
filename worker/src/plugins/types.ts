/**
 * DakFlare Plugin System & Channel Connector Interfaces — v7.0
 *
 * Implements the Tachiyomi/Mihon-inspired plugin contract for messaging channels,
 * filters, actions, and agent tools.
 */

import type { Env } from "../index";
import type { CanonicalLifecycle } from "../lib/canonical-lifecycle";

export interface InboundMessagePayload {
  channel: string;
  channelMessageId: string;
  sender: string;
  recipient: string;
  body: string;
  timestamp: number;
  hasMedia?: boolean;
  mediaUrl?: string;
  mediaMimeType?: string;
  rawPayload?: unknown;
}

export interface OutboundMessageParams {
  to: string;
  body: string;
  templateId?: string;
  templateArgs?: Record<string, string>;
  mediaUrl?: string;
  mediaMimeType?: string;
}

export interface OutboundDeliveryResult {
  success: boolean;
  channelMessageId?: string;
  state: "ACCEPTED_BY_CHANNEL" | "DELIVERED" | "RETRY_BACKOFF" | "FAILED_PERMANENT";
  substate?: string;
  retryAfterSeconds?: number;
  errorCode?: string;
  lifecycle?: CanonicalLifecycle;
}

export interface ChannelSessionWindow {
  windowOpen: boolean;
  expiresAt?: number;
  requiresTemplate: boolean;
}

export interface ChannelPlugin {
  readonly id: string; // e.g. "builtin:telegram", "builtin:whatsapp", "builtin:sms"
  readonly name: string;
  readonly channel: string; // "telegram" | "whatsapp" | "sms"

  /** Validates cryptographic signature or webhook secret token. */
  verifyWebhook(req: Request, rawBody: string, env: Env): Promise<boolean>;

  /** Parses incoming channel payload into normalized messages. */
  parseInbound(req: Request, rawBody: string, env: Env): Promise<InboundMessagePayload[]>;

  /** Sends outbound message via platform API or queued gateway. */
  sendOutbound(params: OutboundMessageParams, env: Env): Promise<OutboundDeliveryResult>;

  /** Checks if active 24h conversational session window is open. */
  getSessionWindow?(peerId: string, env: Env): Promise<ChannelSessionWindow>;
}

export interface PluginManifest {
  schema_version: "1";
  id: string;
  name: string;
  version: string;
  kind: Array<"channel" | "filter" | "action" | "ai_tool" | "domain_connector">;
  runtime: "wasi" | "worker";
  min_dakflare_version: string;
  signature_ed25519?: string;
  sha256?: string;
  permissions?: {
    allowed_hosts?: string[];
    secrets?: string[];
    scopes?: string[];
    pii_access?: "masked_or_consented" | "unrestricted";
  };
}
