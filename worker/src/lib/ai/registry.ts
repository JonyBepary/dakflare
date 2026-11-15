/**
 * Settings -> adapter, and the one place a provider API key is resolved.
 *
 * A route never has to know that `AI` is a binding or which secret name holds
 * the key. The refusals are values, not exceptions, because each one is a
 * useful message to the operator rather than a bug.
 *
 * A key is resolved PER ROLE, never as one first-non-empty chain: chat has its
 * own legacy name and System One has another, and the canonical name overrides
 * both. A deployment that rotates only its chat key must not silently hand the
 * old System One key to a different origin, and vice versa.
 *
 * An unknown provider is refused here AND in `readSettings`. That is not
 * redundant: `readSettings` protects a hand-edited row, and this protects a
 * caller that built settings in code.
 */

import { createOpenAiCompatibleAdapter } from "./openai-compatible";
import { createWorkersAiAdapter, type WorkersAiBinding } from "./workers-ai";
import type { AiSettings } from "./settings";
import { isChatProviderKind, type ChatAdapter } from "./types";

/** The two things a key can be for. They may resolve to different secrets. */
export type KeyRole = "chat" | "system1";

/**
 * The secrets each role may arrive under, in precedence order.
 *
 * `AI_PROVIDER_API_KEY` is canonical for both. The legacy names are role-local:
 * `AI_CHAT_API_KEY` answers chat and `/models` only, `TOKENLAB_API_KEY` answers
 * System One only. Neither leaks into the other role.
 */
export const PROVIDER_KEY_NAMES: Readonly<Record<KeyRole, readonly ProviderSecretName[]>> = {
  chat: ["AI_PROVIDER_API_KEY", "AI_CHAT_API_KEY"],
  system1: ["AI_PROVIDER_API_KEY", "TOKENLAB_API_KEY"],
};

export type ProviderSecretName = "AI_PROVIDER_API_KEY" | "AI_CHAT_API_KEY" | "TOKENLAB_API_KEY";

/** A secret name, or "none" when the role has no key. Never a value. */
export type ProviderKeySource = ProviderSecretName | "none";

export interface ProviderKey {
  /** The secret value, or null when this role has no key. Never serialise this. */
  key: string | null;
  /** Which secret answered this role; "none" when it has no key. */
  source: ProviderKeySource;
}

export interface ProviderKeyEnv {
  AI_PROVIDER_API_KEY?: string;
  AI_CHAT_API_KEY?: string;
  TOKENLAB_API_KEY?: string;
}

/** The first non-empty secret FOR THIS ROLE, and its name. */
export function providerKey(env: ProviderKeyEnv, role: KeyRole): ProviderKey {
  for (const name of PROVIDER_KEY_NAMES[role]) {
    const value = env[name];
    if (typeof value === "string" && value.trim() !== "") {
      return { key: value.trim(), source: name };
    }
  }
  return { key: null, source: "none" };
}

/** Both roles in one call, for a response that has to report both. */
export function providerKeys(env: ProviderKeyEnv): Record<KeyRole, ProviderKey> {
  return { chat: providerKey(env, "chat"), system1: providerKey(env, "system1") };
}

export interface AdapterEnv extends ProviderKeyEnv {
  AI?: unknown;
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
  const { key } = providerKey(env, "chat");
  if (key === null) {
    return {
      ok: false,
      reason: "missing_key",
      message:
        "no chat provider key is set; add one with `cf workers secrets update AI_PROVIDER_API_KEY --type secret_text` (AI_CHAT_API_KEY is also read for chat, and neither is ever stored in D1)",
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
      apiKey: key,
      model: settings.model,
    }),
  };
}
