/**
 * Outbound content classification and body policy enforcement.
 *
 * Hard invariant:
 *   OTP / PIN messages detected by `isOtpOrPinMessage()` are NEVER forwarded
 *   with a raw body to any outbound webhook, regardless of `body_policy`.
 */

import { isOtpOrPinMessage } from "./commands";

export type WebhookBodyPolicy = "redacted" | "allowlisted_raw" | "full";
export type ContentClass = "otp_or_pin" | "allowlisted_raw" | "general";

export interface BodyAllowlistConfig {
  /** Case-insensitive exact sender matches (e.g. ["bKash", "Nagad"]). */
  senders?: string[];
  /** Bounded JS regex source strings (case-insensitive) matched against body. */
  body_patterns?: string[];
}

export const MAX_ALLOWLIST_PATTERNS = 20;
export const MAX_ALLOWLIST_PATTERN_LEN = 160;

export function parseBodyAllowlist(rawJson: string | null | undefined): BodyAllowlistConfig {
  if (!rawJson) return {};
  try {
    const parsed = JSON.parse(rawJson) as Record<string, unknown>;
    const senders = Array.isArray(parsed.senders)
      ? parsed.senders
          .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
          .slice(0, MAX_ALLOWLIST_PATTERNS)
      : undefined;
    const body_patterns = Array.isArray(parsed.body_patterns)
      ? parsed.body_patterns
          .filter(
            (p): p is string =>
              typeof p === "string" &&
              p.trim().length > 0 &&
              p.length <= MAX_ALLOWLIST_PATTERN_LEN
          )
          .slice(0, MAX_ALLOWLIST_PATTERNS)
      : undefined;
    return { senders, body_patterns };
  } catch {
    return {};
  }
}

export function validateBodyAllowlist(config: BodyAllowlistConfig): string | null {
  const senders = config.senders ?? [];
  const patterns = config.body_patterns ?? [];
  if (senders.length > MAX_ALLOWLIST_PATTERNS) {
    return `senders exceeds limit of ${MAX_ALLOWLIST_PATTERNS}`;
  }
  if (patterns.length > MAX_ALLOWLIST_PATTERNS) {
    return `body_patterns exceeds limit of ${MAX_ALLOWLIST_PATTERNS}`;
  }
  for (const pattern of patterns) {
    if (pattern.length > MAX_ALLOWLIST_PATTERN_LEN) {
      return `pattern exceeds max length of ${MAX_ALLOWLIST_PATTERN_LEN}`;
    }
    try {
      new RegExp(pattern, "iu");
    } catch {
      return `invalid regex pattern: ${pattern}`;
    }
  }
  return null;
}

export interface EvaluatedOutboundBody {
  content_class: ContentClass;
  include_raw_body: boolean;
  body: string | null;
  redacted_signal: boolean;
}

export function evaluateOutboundBody(input: {
  sender: string;
  body: string;
  policy: WebhookBodyPolicy;
  allowlist?: BodyAllowlistConfig;
}): EvaluatedOutboundBody {
  // 1. Hard boundary: OTP/PIN never leaves raw.
  if (isOtpOrPinMessage(input.body)) {
    return {
      content_class: "otp_or_pin",
      include_raw_body: false,
      body: null,
      redacted_signal: true,
    };
  }

  // 2. Policy = redacted (safe default).
  if (input.policy === "redacted") {
    return {
      content_class: "general",
      include_raw_body: false,
      body: null,
      redacted_signal: false,
    };
  }

  // 3. Policy = full (explicit opt-in, still subject to OTP/PIN hard boundary above).
  if (input.policy === "full") {
    return {
      content_class: "general",
      include_raw_body: true,
      body: input.body,
      redacted_signal: false,
    };
  }

  // 4. Policy = allowlisted_raw: forward raw body only on explicit sender or regex match.
  const allowlist = input.allowlist ?? {};
  const senderLower = (input.sender || "").trim().toLowerCase();
  const senderMatched = (allowlist.senders ?? []).some(
    (s) => s.trim().toLowerCase() === senderLower
  );

  let patternMatched = false;
  if (!senderMatched && (allowlist.body_patterns ?? []).length > 0) {
    for (const pattern of allowlist.body_patterns ?? []) {
      try {
        if (new RegExp(pattern, "iu").test(input.body)) {
          patternMatched = true;
          break;
        }
      } catch {
        // Ignore invalid persisted patterns safely.
      }
    }
  }

  if (senderMatched || patternMatched) {
    return {
      content_class: "allowlisted_raw",
      include_raw_body: true,
      body: input.body,
      redacted_signal: false,
    };
  }

  return {
    content_class: "general",
    include_raw_body: false,
    body: null,
    redacted_signal: false,
  };
}
