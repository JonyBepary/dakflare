/**
 * The chat adapter contract for the console assistant.
 *
 * Deliberately tiny: the routes own policy (auth, budget, prompt, JSON parsing)
 * and an adapter owns exactly one provider call. That keeps a second provider a
 * new file rather than a branch inside a route, and it keeps the one property
 * that matters testable: every adapter caps output tokens and reports usage
 * honestly, because the daily budget is only real if the number is.
 */

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/**
 * `workers-ai` is the Worker's own AI binding (no key). `openai-compatible` is
 * any `/chat/completions` endpoint, reached with `AI_CHAT_API_KEY`.
 */
export const CHAT_PROVIDER_KINDS = ["workers-ai", "openai-compatible"] as const;

export type ChatProviderKind = (typeof CHAT_PROVIDER_KINDS)[number];

export function isChatProviderKind(value: unknown): value is ChatProviderKind {
  return (
    typeof value === "string" &&
    (CHAT_PROVIDER_KINDS as readonly string[]).includes(value)
  );
}

/** Every adapter defaults to 400 output tokens and refuses to exceed this. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 400;

/**
 * A hard ceiling no caller can raise. A proposal list and a short answer fit in
 * 400 tokens; 1024 is headroom without letting a request turn into a page of
 * prose the route would then have to truncate.
 */
export const MAX_OUTPUT_TOKENS = 1_024;

export interface ChatOptions {
  /** Output-token cap. Clamped to [1, MAX_OUTPUT_TOKENS]; default 400. */
  maxOutputTokens?: number;
  temperature?: number;
  /** Per-call timeout for HTTP adapters. Default 20 s. */
  timeoutMs?: number;
}

export interface ChatResult {
  text: string;
  /** Prompt tokens, when the provider reports them. */
  tokensIn?: number;
  /** Completion tokens, when the provider reports them. */
  tokensOut?: number;
  /** The model that actually answered (the adapter echoes what it was given). */
  model: string;
  /** The provider kind, so a response can never claim a different backend. */
  provider: ChatProviderKind;
}

export interface ChatAdapter {
  kind: ChatProviderKind;
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult>;
}

/** Why an adapter could not answer. The routes turn these into one 503 shape. */
export type ChatFailureReason =
  | "provider_unavailable"
  | "unparseable"
  | "timeout";

export class ChatAdapterError extends Error {
  readonly reason: ChatFailureReason;

  constructor(reason: ChatFailureReason, message: string) {
    super(message);
    this.name = "ChatAdapterError";
    this.reason = reason;
  }
}

/** Shared clamp so the default and the ceiling cannot drift between adapters. */
export function clampOutputTokens(requested: number | undefined): number {
  const value =
    typeof requested === "number" && Number.isFinite(requested)
      ? Math.trunc(requested)
      : DEFAULT_MAX_OUTPUT_TOKENS;
  return Math.min(MAX_OUTPUT_TOKENS, Math.max(1, value));
}

/** A token count from an upstream body, or `undefined` if it is not one. */
export function readTokenCount(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.trunc(value);
}
