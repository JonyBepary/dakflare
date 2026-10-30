/**
 * Magic-link delivery — AUTH_PLAN §1 factor 2, §9 sender decision.
 *
 * The sign-in route must not care how mail leaves the Worker, and the harness
 * must be able to capture a message without a provider account. So delivery is
 * one narrow interface with two implementations:
 *
 *   ResendMailer   used when `RESEND_API_KEY` is present. `RESEND_BASE_URL`
 *                  defaults to https://api.resend.com and is redirectable so a
 *                  local capture server can stand in for Resend.
 *   DisabledMailer used when the key is absent. It sends nothing and logs one
 *                  line, `[mail] mail disabled`, and never the recipient or a
 *                  token. `/v1/auth/mode` reports `magic_link:false` in this
 *                  state, so the console does not offer a door that cannot work.
 *
 * Neither implementation logs a token or a full address. A provider error is
 * logged as a status code only; the response body can echo the recipient.
 */

import type { Env } from "../index";

/** The one message a magic-link sender needs to know how to deliver. */
export interface MagicLinkMessage {
  /** Normalized recipient address. */
  to: string;
  /** Absolute `/admin/magic?token=…&email=…&next=…` URL. */
  url: string;
  /** The deployment's token lifetime, for the copy in the message. */
  expiresInSeconds: number;
}

export type MailSendResult =
  | { ok: true }
  | { ok: false; reason: "mail_disabled" | "mail_failed" };

export interface Mailer {
  sendMagicLink(message: MagicLinkMessage): Promise<MailSendResult>;
}

/** True when a real sender is configured; `/v1/auth/mode` advertises the factor from this. */
export function magicLinkMailEnabled(env: Env): boolean {
  return typeof env.RESEND_API_KEY === "string" && env.RESEND_API_KEY.trim() !== "";
}

const DEFAULT_FROM = "DakFlare <onboarding@resend.dev>";
const DEFAULT_RESEND_BASE = "https://api.resend.com";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** The plain-text part. Deliberately contains no secret other than the single-use token in `url`. */
export function buildMagicLinkText(message: MagicLinkMessage): string {
  const minutes = Math.max(1, Math.round(message.expiresInSeconds / 60));
  return [
    "Sign in to DakFlare",
    "",
    "Open this link to finish signing in:",
    "",
    message.url,
    "",
    `The link works once and expires in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`,
    "If you did not ask for it, ignore this message; nothing was signed in.",
    "",
    "DakFlare",
  ].join("\n");
}

function buildMagicLinkHtml(message: MagicLinkMessage): string {
  const minutes = Math.max(1, Math.round(message.expiresInSeconds / 60));
  const url = escapeHtml(message.url);
  return [
    '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.5;color:#1f1f1f">',
    "<h1 style=\"font-size:20px;margin:0 0 12px\">Sign in to DakFlare</h1>",
    "<p>Open this link to finish signing in:</p>",
    `<p><a href="${url}">Finish signing in</a></p>`,
    `<p>The link works once and expires in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.</p>`,
    "<p>If you did not ask for it, ignore this message; nothing was signed in.</p>",
    "<p>DakFlare</p>",
    "</div>",
  ].join("");
}

class DisabledMailer implements Mailer {
  async sendMagicLink(_message: MagicLinkMessage): Promise<MailSendResult> {
    // One line, no address, no token. This is what an operator sees locally
    // when RESEND_API_KEY is absent; the request still answers 202 so the
    // endpoint cannot be used to probe for a sender.
    console.log("[mail] mail disabled");
    return { ok: false, reason: "mail_disabled" };
  }
}

class ResendMailer implements Mailer {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
    private readonly from: string
  ) {}

  async sendMagicLink(message: MagicLinkMessage): Promise<MailSendResult> {
    try {
      const response = await fetch(`${this.baseUrl}/emails`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: this.from,
          to: [message.to],
          subject: "Your DakFlare sign-in link",
          text: buildMagicLinkText(message),
          html: buildMagicLinkHtml(message),
        }),
      });
      if (!response.ok) {
        // Status only: a provider error body can echo the recipient address.
        console.error(`[mail] resend rejected the message: HTTP ${response.status}`);
        return { ok: false, reason: "mail_failed" };
      }
      return { ok: true };
    } catch (error) {
      // A transport failure must not fail the request: the endpoint answers the
      // same 202 whether or not the address exists, and a 5xx here would be an
      // account oracle. The operator gets one line without a token or address.
      console.error(`[mail] resend request failed: ${String(error)}`);
      return { ok: false, reason: "mail_failed" };
    }
  }
}

export function mailerFor(env: Env): Mailer {
  const key = env.RESEND_API_KEY?.trim();
  if (key === undefined || key === "") return new DisabledMailer();

  const base = env.RESEND_BASE_URL?.trim() || DEFAULT_RESEND_BASE;
  const from = env.MAGIC_LINK_FROM?.trim() || DEFAULT_FROM;
  return new ResendMailer(key, base.replace(/\/+$/, ""), from);
}
