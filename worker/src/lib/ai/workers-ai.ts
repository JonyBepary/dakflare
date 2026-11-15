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

/** The text in whichever of the three shapes the binding answered with. */
function readText(raw: unknown): string | null {
  if (typeof raw === "string") return raw;
  if (raw === null || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.response === "string") return record.response;
  const choices = record.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const choice = choices[0];
    if (typeof choice === "string") return choice;
    if (choice !== null && typeof choice === "object") {
      const entry = choice as { text?: unknown; message?: unknown };
      if (typeof entry.text === "string") return entry.text;
      const message = entry.message;
      if (message !== null && typeof message === "object") {
        const content = (message as { content?: unknown }).content;
        if (typeof content === "string") return content;
        // A part list, as some providers return `[{type:"text", text:"…"}]`.
        if (Array.isArray(content)) {
          const joined = content
            .map((part) =>
              part !== null && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
                ? ((part as { text: string }).text)
                : ""
            )
            .join("");
          if (joined !== "") return joined;
        }
      }
    }
  }
  return null;
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

      // Three shapes are live in the wild for the same binding: a bare string,
      // `{ response: "…" }` (the classic text-model shape), and a chat-completions
      // object with `choices[]` (measured on llama-3.3-70b in production). Read
      // all three rather than assume one and call a good answer "no text".
      const text = readText(raw);

      if (text === null) {
        // Name the shape, never the payload: "no text" alone cannot tell an
        // empty completion from a model that answered in another field or an
        // error object delivered with a 200.
        const shape =
          raw === null
            ? "null"
            : typeof raw === "object"
              ? `object with keys ${Object.keys(raw as Record<string, unknown>).join(",") || "none"}`
              : typeof raw;
        throw new ChatAdapterError(
          "unparseable",
          `Workers AI returned no text (${shape})`
        );
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
