/**
 * AI assistant settings and the daily token budget.
 *
 * Two stores, on purpose:
 *
 *   provider/model/base_url  live in D1 (`ai_settings`, one row) so the console
 *                             can change them without a deploy.
 *   the API keys              never live in D1. They are resolved per request
 *                             and PER ROLE (`providerKey(env, role)`): chat
 *                             reads `AI_PROVIDER_API_KEY` then `AI_CHAT_API_KEY`,
 *                             System One reads `AI_PROVIDER_API_KEY` then
 *                             `TOKENLAB_API_KEY`. The settings response says
 *                             which name answered each role, never a value.
 *
 * System One's optional `system1_model` / `system1_base_url` live in the same
 * row. NULL there means "use the chat model / base", and a read resolves that,
 * so a deployment that never configures System One separately needs no second
 * pair of values.
 *
 * A row that does not exist reads as the env defaults, so a fresh deployment
 * works before anyone opens the settings page. Nothing writes defaults to D1 on
 * read: a read must not spend a D1 write.
 */

import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  isChatProviderKind,
  type ChatProviderKind,
} from "./types";

/** The model each provider uses when no model is configured. */
export const DEFAULT_MODELS: Readonly<Record<ChatProviderKind, string>> = {
  // The fast fp8 70B instruct model: capable enough for a JSON-shaped answer and
  // the cheapest one in the family to run per token.
  "workers-ai": "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  // A placeholder the operator will almost certainly replace; it is a valid
  // model id on the largest compatible provider, which makes a test call useful
  // rather than an automatic 404.
  "openai-compatible": "gpt-4o-mini",
};

export const DEFAULT_PROVIDER: ChatProviderKind = "workers-ai";

export const DEFAULT_DAILY_TOKEN_BUDGET = 20_000;

/** Provider/model/baseUrl, exactly what is stored. */
export interface AiSettings {
  provider: ChatProviderKind;
  model: string;
  baseUrl: string | null;
  /**
   * System One's own model, or the chat model when no row set one. The stored
   * column is nullable ("use the chat model"); a read resolves that fallback so
   * every caller sees the effective value.
   */
  system1Model: string | null;
  /**
   * System One's own origin, or the chat base when no row set one. NULL for
   * workers-ai, which has no base URL at all.
   */
  system1BaseUrl: string | null;
  /**
   * True when the row stores no `system1_base_url` and the value above is the
   * chat origin. The console and the CLI used to infer this by comparing two
   * URLs, so an override equal to the chat base read as inherited and was
   * dropped on the next save.
   */
  system1BaseInherited: boolean;
  /**
   * Set when the CHAT base URL — from env or a hand-edited row — failed
   * `validateBaseUrl`. It never reaches an adapter: a caller must refuse the
   * request before resolving, so the key is not sent to a URL the PUT route
   * would not have accepted.
   */
  baseUrlError?: string;
  /**
   * The same for `system1_base_url`. Kept separate from `baseUrlError` so a bad
   * System One origin blocks System One without disabling chat, and so a stored
   * plain-http origin can never receive the System One bearer key.
   */
  system1BaseUrlError?: string;
}

/** The env slice this module reads; kept minimal so tests need no Worker Env. */
export interface AiSettingsEnv {
  DB: D1Database;
  AI_CHAT_PROVIDER?: string;
  AI_CHAT_MODEL?: string;
  AI_CHAT_BASE_URL?: string;
  AI_CHAT_API_KEY?: string;
  AI_DAILY_TOKEN_BUDGET?: string;
  /**
   * System One defaults, used ONLY when there is no `ai_settings` row. The row
   * wins: `system1_model` / `system1_base_url` are what a console edit changes.
   */
  TOKENLAB_BASE_URL?: string;
  TOKENLAB_SYSTEM1_MODEL?: string;
}

interface AiSettingsRow {
  provider: string;
  model: string;
  base_url: string | null;
  system1_model: string | null;
  system1_base_url: string | null;
}

/** Strip trailing slashes so `${baseUrl}/chat/completions` has one separator. */
export function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * Validate a console-supplied base URL.
 *
 * https is the rule; plain http is allowed only for a loopback host, because an
 * Ollama/vLLM box on the operator's own machine is the one legitimate reason to
 * send an API key in the clear, and it never leaves the host. Credentials in the
 * URL are refused: a base URL ends up in a hint, and a password in one would be
 * a secret in a settings response.
 */
export function validateBaseUrl(
  value: unknown
): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof value !== "string" || value.trim() === "") {
    return { ok: false, message: "baseUrl is required for openai-compatible" };
  }
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return { ok: false, message: "baseUrl is not a valid absolute URL" };
  }
  if (parsed.username !== "" || parsed.password !== "") {
    return { ok: false, message: "baseUrl must not carry credentials" };
  }
  const loopback =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "[::1]" ||
    parsed.hostname === "::1";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    return { ok: false, message: "baseUrl must be https, or http on localhost" };
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    return { ok: false, message: "baseUrl must not carry a query or fragment" };
  }
  return { ok: true, value: stripTrailingSlash(parsed.toString()) };
}

/**
 * An env-supplied base URL is configuration like any other: the PUT route
 * validates what an operator types, so the env path applies the same rule. An
 * invalid value reads as an error rather than a base URL, so nothing can send
 * the key to a plain-http host that is not loopback.
 */
function envBase(
  rawBase: string,
  label: string
): { baseUrl: string | null; error?: string } {
  if (rawBase === "") return { baseUrl: null };
  const checked = validateBaseUrl(rawBase);
  if (checked.ok) return { baseUrl: checked.value };
  return { baseUrl: null, error: `${label} is invalid: ${checked.message}` };
}

/** Settings from env, used when no row exists. */
export function envSettings(env: AiSettingsEnv): AiSettings {
  const providerFromEnv = env.AI_CHAT_PROVIDER;
  const provider = isChatProviderKind(providerFromEnv)
    ? providerFromEnv
    : DEFAULT_PROVIDER;
  const model =
    typeof env.AI_CHAT_MODEL === "string" && env.AI_CHAT_MODEL.trim() !== ""
      ? env.AI_CHAT_MODEL.trim()
      : DEFAULT_MODELS[provider];
  const rawBase =
    typeof env.AI_CHAT_BASE_URL === "string" ? stripTrailingSlash(env.AI_CHAT_BASE_URL.trim()) : "";

  let baseUrlError: string | undefined;
  let baseUrl: string | null = null;
  if (provider === "openai-compatible" && rawBase !== "") {
    const checked = envBase(rawBase, "AI_CHAT_BASE_URL");
    baseUrl = checked.baseUrl;
    baseUrlError = checked.error;
  }

  // System One defaults. TOKENLAB_* belong to the OpenAI-compatible provider,
  // so a workers-ai deployment does not inherit a Token Lab model or origin it
  // never selected. With neither var set, System One follows the chat values —
  // the same rule a row with NULL columns follows.
  const rawSystem1Base =
    typeof env.TOKENLAB_BASE_URL === "string"
      ? stripTrailingSlash(env.TOKENLAB_BASE_URL.trim())
      : "";
  // The effective model follows the provider's decision default, not the chat
  // model: see SYSTEM1_DEFAULT_WIRE_MODEL.
  let system1Model: string | null = provider === "openai-compatible" ? "Clef" : "clef";
  let system1BaseUrl: string | null = null;
  let system1BaseUrlError: string | undefined;
  let system1BaseInherited = true;
  if (provider === "openai-compatible") {
    const configuredModel =
      typeof env.TOKENLAB_SYSTEM1_MODEL === "string" ? env.TOKENLAB_SYSTEM1_MODEL.trim() : "";
    if (configuredModel !== "") system1Model = configuredModel;

    if (rawSystem1Base !== "") {
      const checked = envBase(rawSystem1Base, "TOKENLAB_BASE_URL");
      system1BaseUrl = checked.baseUrl;
      system1BaseInherited = false;
      system1BaseInherited = false;
      // Its own field, not the chat one: a bad System One origin blocks System
      // One and nothing else, which is what the field's contract says. Writing it
      // into baseUrlError used to refuse chat and /models for a decision-only
      // misconfiguration.
      if (checked.error !== undefined && system1BaseUrlError === undefined) {
        system1BaseUrlError = checked.error;
      }
    } else {
      system1BaseUrl = baseUrl;
    }
  }

  return {
    provider,
    model,
    // workers-ai has no base URL, whatever a stale var says.
    baseUrl,
    system1Model,
    system1BaseUrl,
    system1BaseInherited,
    ...(baseUrlError === undefined ? {} : { baseUrlError }),
    ...(system1BaseUrlError === undefined ? {} : { system1BaseUrlError }),
  };
}

/** Read the stored settings, falling back to env defaults. */
export async function readSettings(env: AiSettingsEnv): Promise<AiSettings> {
  const row = await env.DB.prepare(
    `SELECT provider, model, base_url, system1_model, system1_base_url
       FROM ai_settings WHERE id = 1 LIMIT 1`
  ).first<AiSettingsRow>();

  if (row === null || row === undefined) return envSettings(env);

  // A hand-edited row must not reach an adapter that did not validate it. An
  // unknown provider reads as the env default instead of being passed through.
  const provider = isChatProviderKind(row.provider) ? row.provider : envSettings(env).provider;
  const model =
    typeof row.model === "string" && row.model.trim() !== ""
      ? row.model.trim()
      : DEFAULT_MODELS[provider];

  // A row is not trusted just because the PUT route wrote it once: it can be
  // edited by hand, and a plain-http origin would receive the bearer key in the
  // clear. The stored values get the same rule the env path applies, and a
  // failure reads as "no base URL" plus an error, never as a usable origin.
  let baseUrl: string | null = null;
  let baseUrlError: string | undefined;
  if (provider === "openai-compatible" && row.base_url !== null && row.base_url !== "") {
    const checked = validateBaseUrl(stripTrailingSlash(row.base_url));
    if (checked.ok) {
      baseUrl = checked.value;
    } else {
      baseUrlError = `base_url is invalid: ${checked.message}`;
    }
  }

  // System One: its own origin when the row carries one, the chat origin
  // otherwise. The MODEL does not inherit: a gateway's decision namespace is not
  // its chat namespace (Token Lab decides with "Clef" while chatting as
  // DeepSeek), so a NULL column means the provider's decision default.
  const system1Model =
    typeof row.system1_model === "string" && row.system1_model.trim() !== ""
      ? row.system1_model.trim()
      : provider === "openai-compatible"
        ? "Clef"
        : "clef";

  let system1BaseUrl: string | null = null;
  let system1BaseUrlError: string | undefined;
  let system1BaseInherited = true;
  if (provider === "openai-compatible") {
    const storedSystem1Base =
      row.system1_base_url !== null && row.system1_base_url !== ""
        ? stripTrailingSlash(row.system1_base_url)
        : null;
    if (storedSystem1Base === null) {
      system1BaseUrl = baseUrl;
    } else {
      const checked = validateBaseUrl(storedSystem1Base);
      if (checked.ok) {
        system1BaseUrl = checked.value;
        system1BaseInherited = false;
      } else {
        system1BaseUrlError = `system1_base_url is invalid: ${checked.message}`;
      }
    }
  }

  return {
    provider,
    model,
    baseUrl,
    system1Model,
    system1BaseUrl,
    system1BaseInherited,
    ...(baseUrlError === undefined ? {} : { baseUrlError }),
    ...(system1BaseUrlError === undefined ? {} : { system1BaseUrlError }),
  };
}

/**
 * `readSettings` for a request path that must still answer when D1 is down.
 *
 * A settings read is one row on a database the same request already depends on,
 * but an assistant call should degrade to the env defaults (exactly what a
 * deployment with no row reads) rather than become a 500. Configuration errors
 * inside a row are NOT faults: they still come back as `baseUrlError`, so the
 * caller refuses to send a key where the PUT route would not have.
 */
export async function readSettingsOrEnv(env: AiSettingsEnv): Promise<AiSettings> {
  try {
    return await readSettings(env);
  } catch (error) {
    console.error(`[ai.settings] read failed; using env defaults: ${String(error).slice(0, 200)}`);
    return envSettings(env);
  }
}

/** Upsert the singleton. `updatedBy` is the actor label, never an id from a body. */
export async function writeSettings(
  env: AiSettingsEnv,
  settings: AiSettings,
  updatedBy: string
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO ai_settings
       (id, provider, model, base_url, system1_model, system1_base_url, updated_at, updated_by)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       provider = excluded.provider,
       model = excluded.model,
       base_url = excluded.base_url,
       system1_model = excluded.system1_model,
       system1_base_url = excluded.system1_base_url,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`
  )
    .bind(
      settings.provider,
      settings.model,
      settings.baseUrl,
      settings.system1Model,
      settings.system1BaseUrl,
      Date.now(),
      updatedBy
    )
    .run();
}

/* ─────────────────────────────── budget ─────────────────────────────── */

/** `YYYY-MM-DD`, UTC. The budget must not roll at a local midnight. */
export function utcDay(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

function clampBudget(value: unknown): number {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
  if (!Number.isFinite(parsed)) return DEFAULT_DAILY_TOKEN_BUDGET;
  // 0 is a legitimate "disable the assistant" value; anything absurd is clamped.
  return Math.min(10_000_000, Math.max(0, Math.trunc(parsed)));
}

export interface Budget {
  day: string;
  used: number;
  limit: number;
}

/** Today's usage and the configured ceiling, in one read. */
export async function readBudget(
  env: AiSettingsEnv,
  now: number = Date.now()
): Promise<Budget> {
  const day = utcDay(now);
  const row = await env.DB.prepare(`SELECT tokens FROM ai_usage WHERE day = ? LIMIT 1`)
    .bind(day)
    .first<{ tokens: number }>();
  const used = row === null || row === undefined ? 0 : Number(row.tokens) || 0;
  return { day, used, limit: clampBudget(env.AI_DAILY_TOKEN_BUDGET) };
}

/** Add actual (or conservatively estimated) tokens to today's row. */
export async function addTokens(
  env: AiSettingsEnv,
  day: string,
  tokens: number
): Promise<void> {
  const amount = Number.isFinite(tokens) ? Math.max(0, Math.trunc(tokens)) : 0;
  if (amount === 0) return;
  await env.DB.prepare(
    `INSERT INTO ai_usage (day, tokens) VALUES (?, ?)
     ON CONFLICT(day) DO UPDATE SET tokens = tokens + excluded.tokens`
  )
    .bind(day, amount)
    .run();
}

/**
 * A conservative token estimate for providers that omit usage.
 *
 * Deliberately 3 characters per token rather than the usual 4: undercounting a
 * spend ceiling defeats the ceiling, and a few extra counted tokens cost the
 * operator nothing but a slightly earlier 429.
 */
export function estimateTokens(text: string): number {
  if (text === "") return 0;
  return Math.ceil(text.length / 3);
}

/**
 * The tokens one call costs. Reported numbers win; each missing side is
 * estimated from the text that produced it.
 */
export function billableTokens(
  result: { tokensIn?: number; tokensOut?: number; text: string },
  promptText: string
): number {
  const input = result.tokensIn ?? estimateTokens(promptText);
  const output = result.tokensOut ?? estimateTokens(result.text);
  return Math.max(0, input) + Math.max(0, output);
}

/** The default output cap, re-exported so a route can say what it asked for. */
export { DEFAULT_MAX_OUTPUT_TOKENS };
