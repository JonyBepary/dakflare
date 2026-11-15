/**
 * Cloudflare Workers AI adapter.
 *
 * The binding is `env.AI` (see `[ai] binding = "AI"` in the wrangler configs).
 * The model is a settings value, defaulting to
 * `@cf/meta/llama-3.3-70b-instruct-fp8-fast`.
 *
 * Why a narrow interface instead of the ambient `Ai` type: `Ai.run` is a set of
 * model-name-keyed overloads, so calling it with a runtime string needs a cast
 * somewhere. Keeping the cast here means the route and the registry never see
 * it, and the surface this adapter depends on stays one method.
 *
 * Usage: Workers AI reports `usage.prompt_tokens` / `usage.completion_tokens`
 * for models that bill per token and omits `usage` for models that do not. Both
 * are honest answers, so both are passed through and the route estimates only
 * when a value is absent.
 */

import type { ChatAdapter, ChatMessage, ChatOptions, ChatResult } from "./types";
import { ChatAdapterError, clampOutputTokens, readTokenCount } from "./types";

/** The slice of the AI binding this adapter uses. */
export interface WorkersAiBinding {
  run(model: string, input: unknown): Promise<unknown>;
}

interface WorkersAiUsage {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
}

interface WorkersAiResult {
  response?: unknown;
  usage?: WorkersAiUsage;
}

export function createWorkersAiAdapter(
  binding: WorkersAiBinding,
  model: string
): ChatAdapter {
  return {
    kind: "workers-ai",
    async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
      const maxTokens = clampOutputTokens(opts.maxOutputTokens);

      let raw: unknown;
      try {
        raw = await binding.run(model, {
          messages: messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
          max_tokens: maxTokens,
          ...(opts.temperature === undefined ? {} : { temperature: opts.temperature }),
        });
      } catch (error) {
        throw new ChatAdapterError(
          "provider_unavailable",
          `Workers AI did not answer: ${String(error).slice(0, 200)}`
        );
      }

      // Most text models answer `{ response: "…" }`; a string result is what a
      // few of the smaller models return. Both are the text, neither is assumed.
      const text =
        typeof raw === "string"
          ? raw
          : raw !== null && typeof raw === "object" &&
              typeof (raw as WorkersAiResult).response === "string"
            ? ((raw as WorkersAiResult).response as string)
            : null;

      if (text === null) {
        throw new ChatAdapterError("unparseable", "Workers AI returned no text");
      }

      const usage =
        raw !== null && typeof raw === "object" ? (raw as WorkersAiResult).usage : undefined;

      return {
        text,
        tokensIn: readTokenCount(usage?.prompt_tokens),
        tokensOut: readTokenCount(usage?.completion_tokens),
        model,
        provider: "workers-ai",
      };
    },
  };
}
