/**
 * The chat adapter contract for the console assistant.
 *
 * Deliberately tiny: the routes own policy (auth, budget, prompt, JSON parsing)
 * and an adapter owns exactly one provider call. That keeps a second provider a
 * new file rather than a branch inside a route, and it keeps the one property
 * that matters testable: every adapter caps output tokens and reports usage
 * honestly, because the daily budget is only real if the number is.
 */

export type ChatRole = "system" | "user" | "assistant" | "tool";

/** A tool call exactly as the provider returned it. */
export interface ChatToolCall {
  id: string;
  name: string;
  /**
   * The raw `function.arguments` string. Kept as text, not parsed: a provider
   * may send malformed JSON and the agent loop must be able to report that
   * instead of throwing inside an adapter.
   */
  arguments: string;
}

/** The JSON-schema manifest both chat-completions shapes accept. */
export interface ChatToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
  /** Assistant messages that called tools. */
  toolCalls?: ChatToolCall[];
  /** `role: "tool"`: which assistant call this result answers. */
  toolCallId?: string;
  /** `role: "tool"`: the tool name, which Workers AI also accepts. */
  name?: string;
}

/** A streaming delta. Nothing else is streamed: the loop owns the frames. */
export type ChatStreamEvent = { type: "token"; text: string };

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
  /**
   * Tools the model may call. The loop supplies the same manifest to every
   * model call; an adapter that cannot express tools ignores it and the model
   * simply answers in prose.
   */
  tools?: ChatToolDefinition[];
}

export interface ChatResult {
  text: string;
  /** Prompt tokens, when the provider reports them. */
  tokensIn?: number;
  /** Completion tokens, when the provider reports them. */
  tokensOut?: number;
  /** Structured calls, when the provider returned any. */
  toolCalls?: ChatToolCall[];
  /** The provider's own stop reason, when it sent one. */
  finishReason?: string;
  /** The model that actually answered (the adapter echoes what it was given). */
  model: string;
  /** The provider kind, so a response can never claim a different backend. */
  provider: ChatProviderKind;
}

export interface ChatAdapter {
  kind: ChatProviderKind;
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult>;
  /**
   * Streaming chat. Optional: an adapter without it keeps working through
   * `chat()`, and the loop emits the finished answer once. A streaming adapter
   * emits only prose deltas, and returns the same `ChatResult` as `chat()`.
   */
  chatStream?(
    messages: ChatMessage[],
    opts: ChatOptions,
    onEvent: (event: ChatStreamEvent) => void
  ): Promise<ChatResult>;
}

/** Why an adapter could not answer. The routes turn these into one 503 shape. */
export type ChatFailureReason =
  | "provider_unavailable"
  | "provider_rate_limited"
  | "provider_auth"
  | "unparseable"
  | "timeout";

export class ChatAdapterError extends Error {
  readonly reason: ChatFailureReason;
  /** A provider's `Retry-After`, when it sent one. Advisory, never a promise. */
  readonly retryAfter?: string;

  constructor(reason: ChatFailureReason, message: string, retryAfter?: string) {
    super(message);
    this.name = "ChatAdapterError";
    this.reason = reason;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
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
