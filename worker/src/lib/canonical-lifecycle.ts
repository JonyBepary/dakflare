/**
 * DakFlare Canonical Lifecycle Engine — v7.0
 *
 * Normalizes multi-platform delivery, conversation, and device states
 * (SMS, WhatsApp, Telegram, Signal) into a uniform, edge-computed lifecycle tuple:
 *   (state, substate, is_terminal, settled, remediation)
 *
 * Implements PROTOCOL_CONTRACT_V5 + Multi-Platform Hub Specification §3.
 */

export type CanonicalDeliveryState =
  | "QUEUED"
  | "LEASED_OR_DISPATCHING"
  | "ACCEPTED_BY_CHANNEL"
  | "DELIVERED"
  | "READ"
  | "SETTLED_SENT"
  | "FAILED_PERMANENT"
  | "EXPIRED"
  | "RETRY_BACKOFF"
  | "FALLBACK_TRIGGERED";

export interface LifecycleRemediation {
  command: string;
  description: string;
}

export interface CanonicalLifecycle {
  channel: string;
  state: CanonicalDeliveryState;
  substate: string | null;
  is_terminal: boolean;
  settled: boolean;
  remediation: LifecycleRemediation | null;
}

/** 5-minute grace window for carriers that omit SMS-STATUS-REPORT PDUs. */
const SMS_SETTLED_GRACE_MS = 5 * 60 * 1000;

export interface CommandLifecycleInput {
  channel?: string | null;
  state: string;
  created_at: number;
  now?: number;
  error_code?: string | null;
  retry_after?: number | null;
}

/**
 * Computes canonical outbound delivery lifecycle for any channel command.
 */
export function computeCommandLifecycle(input: CommandLifecycleInput): CanonicalLifecycle {
  const channel = (input.channel || "sms").toLowerCase();
  const rawState = (input.state || "").toUpperCase();
  const now = input.now ?? Date.now();
  const elapsed = now - input.created_at;

  switch (rawState) {
    case "PENDING":
    case "QUEUED":
      return {
        channel,
        state: "QUEUED",
        substate: "awaiting_dispatch",
        is_terminal: false,
        settled: false,
        remediation: null,
      };

    case "LEASED":
      return {
        channel,
        state: "LEASED_OR_DISPATCHING",
        substate: "transport_leased",
        is_terminal: false,
        settled: false,
        remediation: null,
      };

    case "DISPATCHED":
      return {
        channel,
        state: "LEASED_OR_DISPATCHING",
        substate: "radio_dispatching",
        is_terminal: false,
        settled: false,
        remediation: null,
      };

    case "SENT":
      if (channel === "sms") {
        if (elapsed >= SMS_SETTLED_GRACE_MS) {
          return {
            channel,
            state: "SETTLED_SENT",
            substate: "carrier_pdu_omitted_settled",
            is_terminal: true,
            settled: true,
            remediation: null,
          };
        }
        return {
          channel,
          state: "ACCEPTED_BY_CHANNEL",
          substate: "awaiting_carrier_pdu",
          is_terminal: false,
          settled: false,
          remediation: null,
        };
      }
      return {
        channel,
        state: "ACCEPTED_BY_CHANNEL",
        substate: "channel_accepted",
        is_terminal: false,
        settled: false,
        remediation: null,
      };

    case "DELIVERED":
      return {
        channel,
        state: "DELIVERED",
        substate: "peer_delivered",
        is_terminal: true,
        settled: true,
        remediation: null,
      };

    case "READ":
      return {
        channel,
        state: "READ",
        substate: "peer_read",
        is_terminal: true,
        settled: true,
        remediation: null,
      };

    case "RETRY_BACKOFF":
      return {
        channel,
        state: "RETRY_BACKOFF",
        substate: input.retry_after ? `retry_after_${input.retry_after}s` : "rate_limited",
        is_terminal: false,
        settled: false,
        remediation: {
          command: "dakflare status --wait",
          description: "automatic exponential backoff in flight",
        },
      };

    case "FALLBACK_TRIGGERED":
      return {
        channel,
        state: "FALLBACK_TRIGGERED",
        substate: "routed_to_fallback_channel",
        is_terminal: false,
        settled: false,
        remediation: null,
      };

    case "EXPIRED":
      return {
        channel,
        state: "EXPIRED",
        substate: "ttl_expired",
        is_terminal: true,
        settled: true,
        remediation: {
          command: "dakflare send ...",
          description: "resend with fresh idempotency key if peer did not receive",
        },
      };

    case "FAILED":
    default:
      return {
        channel,
        state: "FAILED_PERMANENT",
        substate: input.error_code || "delivery_failed",
        is_terminal: true,
        settled: true,
        remediation: {
          command: "dakflare doctor",
          description: "check channel connection and radio health",
        },
      };
  }
}

export type ConnectorState =
  | "UNCONFIGURED"
  | "PAIRING_QR_READY"
  | "HANDSHAKING"
  | "LIVE_SOCKET"
  | "SYNCED_POLLING"
  | "DEGRADED_RATE_LIMITED"
  | "REAUTH_REQUIRED"
  | "REVOKED";

export interface DeviceLifecycleInput {
  archived_at: number | null;
  ws_connected: boolean;
  last_seen_at: number | null;
  now?: number;
}

/**
 * Computes canonical lifecycle for an Android handset or companion connector.
 */
export function computeDeviceLifecycle(input: DeviceLifecycleInput): {
  state: ConnectorState;
  substate: string | null;
  is_online: boolean;
} {
  const now = input.now ?? Date.now();

  if (input.archived_at !== null) {
    return {
      state: "REVOKED",
      substate: "device_archived_or_revoked",
      is_online: false,
    };
  }

  if (input.ws_connected) {
    return {
      state: "LIVE_SOCKET",
      substate: "persistent_websocket_open",
      is_online: true,
    };
  }

  const elapsed = input.last_seen_at ? now - input.last_seen_at : Infinity;
  // If seen within 120s, it is actively polling over HTTP.
  if (elapsed <= 120_000) {
    return {
      state: "SYNCED_POLLING",
      substate: `http_poll_${Math.round(elapsed / 1000)}s_ago`,
      is_online: true,
    };
  }

  return {
    state: "HANDSHAKING",
    substate: input.last_seen_at ? `dormant_offline` : "never_connected",
    is_online: false,
  };
}
