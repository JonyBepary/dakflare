/**
 * Settings -> adapter.
 *
 * One place decides whether a configured provider can actually answer, so a
 * route never has to know that `AI` is a binding and `AI_CHAT_API_KEY` is a
 * secret. The refusals are values, not exceptions, because each one is a useful
 * message to the operator rather than a bug.
 *
 * An unknown provider is refused here AND in `readSettings`. That is not
 * redundant: `readSettings` protects a hand-edited row, and this protects a
 * caller that built settings in code.
 */

import { createOpenAiCompatibleAdapter } from "./openai-compatible";
import { createWorkersAiAdapter, type WorkersAiBinding } from "./workers-ai";
import type { AiSettings } from "./settings";
import { isChatProviderKind, type ChatAdapter } from "./types";

export interface AdapterEnv {
  AI?: unknown;
  AI_CHAT_API_KEY?: string;
}

export type AdapterFailureReason =
  | "unsupported_provider"
  | "missing_binding"
  | "missing_key"
  | "missing_base_url";

export type AdapterResolution =
  | { ok: true; adapter: ChatAdapter }
  | { ok: false; reason: AdapterFailureReason; message: string };

export function resolveAdapter(env: AdapterEnv, settings: AiSettings): AdapterResolution {
  if (!isChatProviderKind(settings.provider)) {
    return {
      ok: false,
      reason: "unsupported_provider",
      message: `unknown AI provider "${String(settings.provider)}"; expected workers-ai or openai-compatible`,
    };
  }

  if (settings.provider === "workers-ai") {
    if (env.AI === undefined || env.AI === null) {
      return {
        ok: false,
        reason: "missing_binding",
        message: "the Workers AI binding is not configured; add [ai] binding = \"AI\"",
      };
    }
    return {
      ok: true,
      adapter: createWorkersAiAdapter(env.AI as WorkersAiBinding, settings.model),
    };
  }

  // openai-compatible.
  const apiKey =
    typeof env.AI_CHAT_API_KEY === "string" ? env.AI_CHAT_API_KEY.trim() : "";
  if (apiKey === "") {
    return {
      ok: false,
      reason: "missing_key",
      message:
        "AI_CHAT_API_KEY is not set; add it with `cf workers secrets update AI_CHAT_API_KEY --type secret_text` (it is never stored in D1)",
    };
  }
  if (settings.baseUrl === null || settings.baseUrl === "") {
    return {
      ok: false,
      reason: "missing_base_url",
      message: "openai-compatible needs a baseUrl; save one on the AI settings page",
    };
  }

  return {
    ok: true,
    adapter: createOpenAiCompatibleAdapter({
      baseUrl: settings.baseUrl,
      apiKey,
      model: settings.model,
    }),
  };
}
