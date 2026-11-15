/**
 * AI assistant settings and the daily token budget.
 *
 * Two stores, on purpose:
 *
 *   provider/model/base_url  live in D1 (`ai_settings`, one row) so the console
 *                             can change them without a deploy.
 *   the API key               never lives in D1. `AI_CHAT_API_KEY` is a Worker
 *                             secret, read per request; the settings response
 *                             says only whether it is present.
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
   * Set when an env-supplied base URL failed `validateBaseUrl`. It is not
   * stored and it never reaches an adapter: a caller must refuse the request
   * before resolving, so the key is not sent to a URL the PUT route would not
   * have accepted.
   */
  baseUrlError?: string;
}

/** The env slice this module reads; kept minimal so tests need no Worker Env. */
export interface AiSettingsEnv {
  DB: D1Database;
  AI_CHAT_PROVIDER?: string;
  AI_CHAT_MODEL?: string;
  AI_CHAT_BASE_URL?: string;
  AI_CHAT_API_KEY?: string;
  AI_DAILY_TOKEN_BUDGET?: string;
}

interface AiSettingsRow {
  provider: string;
  model: string;
  base_url: string | null;
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

  // An env value is configuration like any other: the PUT route validates what
  // an operator types, so the env path must apply the same rule. An invalid
  // value reads as an error rather than a base URL, so nothing can send the key
  // to a plain-http host that is not loopback.
  let baseUrlError: string | undefined;
  let baseUrl: string | null = null;
  if (provider === "openai-compatible" && rawBase !== "") {
    const checked = validateBaseUrl(rawBase);
    if (checked.ok) {
      baseUrl = checked.value;
    } else {
      baseUrlError = `AI_CHAT_BASE_URL is invalid: ${checked.message}`;
    }
  }

  return {
    provider,
    model,
    // workers-ai has no base URL, whatever a stale var says.
    baseUrl,
    ...(baseUrlError === undefined ? {} : { baseUrlError }),
  };
}

/** Read the stored settings, falling back to env defaults. */
export async function readSettings(env: AiSettingsEnv): Promise<AiSettings> {
  const row = await env.DB.prepare(
    `SELECT provider, model, base_url FROM ai_settings WHERE id = 1 LIMIT 1`
  ).first<AiSettingsRow>();

  if (row === null || row === undefined) return envSettings(env);

  // A hand-edited row must not reach an adapter that did not validate it. An
  // unknown provider reads as the env default instead of being passed through.
  const provider = isChatProviderKind(row.provider) ? row.provider : envSettings(env).provider;
  const model =
    typeof row.model === "string" && row.model.trim() !== ""
      ? row.model.trim()
      : DEFAULT_MODELS[provider];

  return {
    provider,
    model,
    baseUrl:
      provider === "openai-compatible" && row.base_url !== null && row.base_url !== ""
        ? stripTrailingSlash(row.base_url)
        : null,
  };
}

/** Upsert the singleton. `updatedBy` is the actor label, never an id from a body. */
export async function writeSettings(
  env: AiSettingsEnv,
  settings: AiSettings,
  updatedBy: string
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO ai_settings (id, provider, model, base_url, updated_at, updated_by)
       VALUES (1, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       provider = excluded.provider,
       model = excluded.model,
       base_url = excluded.base_url,
       updated_at = excluded.updated_at,
       updated_by = excluded.updated_by`
  )
    .bind(settings.provider, settings.model, settings.baseUrl, Date.now(), updatedBy)
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
