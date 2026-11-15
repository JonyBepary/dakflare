/**
 * OpenAI-compatible chat adapter (`POST {baseUrl}/chat/completions`).
 *
 * This is the escape hatch for a self-hoster who wants a hosted model that is
 * not Workers AI: OpenAI, Together, Groq, an Ollama or vLLM box on localhost.
 * It speaks the one shape all of them share.
 *
 * Three rules that are load-bearing:
 *
 *   1. The key is read from `AI_CHAT_API_KEY` and never logged, echoed or
 *      stored. It goes into exactly one header.
 *   2. The call is time-boxed at 20 s. A Worker has its own wall clock, but a
 *      hung provider would hold a request (and a budget reservation) open, so
 *      the adapter aborts first.
 *   3. A non-2xx body is NOT returned. Provider error bodies routinely quote the
 *      request, which is the operator's prompt and possibly console context;
 *      only the status is surfaced.
 */

import type { ChatAdapter, ChatMessage, ChatOptions, ChatResult } from "./types";
import { ChatAdapterError, clampOutputTokens, readTokenCount } from "./types";

const DEFAULT_TIMEOUT_MS = 20_000;

export interface OpenAiCompatibleOptions {
  /** Origin only, no trailing slash. Validated by the settings route. */
  baseUrl: string;
  apiKey: string;
  model: string;
}

interface OpenAiContentPart {
  type?: unknown;
  text?: unknown;
}

interface OpenAiResponse {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
  };
}

/** `content` is a string for most providers and a part list for a few. */
function extractContent(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;
  const parts: string[] = [];
  for (const part of value) {
    if (part !== null && typeof part === "object") {
      const text = (part as OpenAiContentPart).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.length === 0 ? null : parts.join("");
}

export function createOpenAiCompatibleAdapter(
  options: OpenAiCompatibleOptions
): ChatAdapter {
  const endpoint = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  return {
    kind: "openai-compatible",
    async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
      const maxTokens = clampOutputTokens(opts.maxOutputTokens);
      const timeoutMs =
        typeof opts.timeoutMs === "number" && opts.timeoutMs > 0
          ? Math.trunc(opts.timeoutMs)
          : DEFAULT_TIMEOUT_MS;

      let response: Response;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify({
            model: options.model,
            messages: messages.map((message) => ({
              role: message.role,
              content: message.content,
            })),
            max_tokens: maxTokens,
            ...(opts.temperature === undefined ? {} : { temperature: opts.temperature }),
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const name = error instanceof Error ? error.name : "";
        if (name === "TimeoutError" || name === "AbortError") {
          throw new ChatAdapterError(
            "timeout",
            `the provider did not answer within ${Math.round(timeoutMs / 1000)} s`
          );
        }
        throw new ChatAdapterError(
          "provider_unavailable",
          `the provider could not be reached: ${String(error).slice(0, 200)}`
        );
      }

      if (!response.ok) {
        // Status only: never the body, which can quote the prompt.
        throw new ChatAdapterError(
          "provider_unavailable",
          `the provider answered ${response.status}`
        );
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new ChatAdapterError("unparseable", "the provider returned a non-JSON body");
      }

      const parsed = (body !== null && typeof body === "object" ? body : {}) as OpenAiResponse;
      const content = extractContent(parsed.choices?.[0]?.message?.content);
      if (content === null) {
        throw new ChatAdapterError("unparseable", "the provider returned no message content");
      }

      return {
        text: content,
        tokensIn: readTokenCount(parsed.usage?.prompt_tokens),
        tokensOut: readTokenCount(parsed.usage?.completion_tokens),
        model: options.model,
        provider: "openai-compatible",
      };
    },
  };
}
