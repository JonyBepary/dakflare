/**
 * AI console assistant — settings, a connectivity probe, chat, and accepting a
 * proposal.
 *
 * The dividing line this file draws: A MODEL NEVER CHANGES ANYTHING.
 *
 *   chat      produces text and drafts. It writes only `assistant_proposals`.
 *   accept    is a separate, explicit human action, and it re-validates the
 *             stored payload before it writes. `create_rule` goes through the
 *             exact `handleRulesPost` path the rules editor uses; a template and
 *             a workflow patch write nothing at all in this pass — they return a
 *             draft for the console to insert.
 *
 * Three properties are load-bearing:
 *
 *   1. The key is never stored. The provider key is read from env per request
 *      (`AI_PROVIDER_API_KEY`, then `AI_CHAT_API_KEY`, then `TOKENLAB_API_KEY`);
 *      `apiKeyConfigured` is a boolean, `keySource` a name, and no response
 *      carries the key.
 *   2. The budget is checked before a call and charged after it, from the
 *      provider's reported usage or a conservative estimate.
 *   3. A proposal id is minted here, never accepted from the client or the
 *      model, and a proposal is single-use.
 *
 * AGENT TOKENS: none of the actions below appear in `SCOPE_FOR_ACTION`, so an
 * agent token is refused with 403 before any handler runs. That is deliberate:
 * an assistant that can be driven by an agent, plus a route that spends the
 * operator's token budget, is a combination nobody asked for. The console uses a
 * human session or ADMIN_TOKEN.
 */

import type { Env } from "../index";
import type { AdminActor } from "../audit";
import { writeAudit } from "../audit";
import { readJsonBoundedResult } from "../lib/body";
import { err } from "../lib/errors";
import { handleRulesPost } from "./rules";
import { system1ConfigFor } from "./agent";
import { aliasFor, ask, type ClefQuestion, type System1Model } from "../lib/system1";
import { providerKey, providerKeys, resolveAdapter } from "../lib/ai/registry";
import {
  addTokens,
  billableTokens,
  readBudget,
  readSettings,
  readSettingsOrEnv,
  validateBaseUrl,
  writeSettings,
  type AiSettings,
  type Budget,
} from "../lib/ai/settings";
import {
  CHAT_PROVIDER_KINDS,
  ChatAdapterError,
  MAX_OUTPUT_TOKENS,
  isChatProviderKind,
  type ChatMessage,
} from "../lib/ai/types";

/** 8 KiB: one operator message and a route hint, not an upload. */
const ASSISTANT_BODY_BYTES = 8 * 1024;

const MAX_MESSAGE_CHARS = 4_096;
const MAX_ANSWER_CHARS = 4_000;
const MAX_TITLE_CHARS = 120;
const MAX_SUMMARY_CHARS = 400;
const MAX_PAYLOAD_JSON_CHARS = 8_000;
const MAX_PATCH_JSON_CHARS = 65_536;
const MAX_MODEL_CHARS = 200;

/** A draft a human can accept for 15 minutes. */
const PROPOSAL_TTL_MS = 15 * 60 * 1000;

const MAX_PROPOSALS = 3;

/** The only kinds a proposal may carry. Anything else is dropped on parse. */
/** The decision aliases Workers AI actually serves. */
const SYSTEM1_ALIASES = ["clef", "clef-flash", "clef-omni"] as const;

const PROPOSAL_KINDS = ["create_rule", "create_template", "stage_workflow_patch"] as const;
type ProposalKind = (typeof PROPOSAL_KINDS)[number];

const PROPOSAL_KIND_SET: ReadonlySet<string> = new Set(PROPOSAL_KINDS);

/* ─────────────────────────────── shared ─────────────────────────────── */

function logAssistant(
  event: string,
  fields: Record<string, string | number | boolean | null>
): void {
  try {
    console.log(`[assistant.${event}] ${JSON.stringify(fields)}`);
  } catch {
    // Logging must never fail the request.
  }
}

/**
 * One 503 shape for every "the provider could not answer" case, matching
 * `routes/agent.ts`'s `ai_unavailable`. The reason is machine-readable; the
 * message is what an operator can act on.
 */
function aiUnavailable(
  reason: string,
  message: string,
  retryAfter?: string
): Response {
  return Response.json(
    {
      error: "ai_unavailable",
      message,
      reason,
      ...(retryAfter === undefined ? {} : { retry_after: retryAfter }),
    },
    { status: 503 }
  );
}

/**
 * An env base URL that failed validation is a configuration error, not a
 * fallback opportunity. Refuse before resolving, so the key is never attached
 * to a request to that URL.
 */
function settingsRefusal(settings: AiSettings): Response | null {
  if (settings.baseUrlError !== undefined) {
    return aiUnavailable("bad_base_url", settings.baseUrlError);
  }
  return null;
}

function badRequest(message: string): Response {
  return Response.json({ error: "bad_request", message }, { status: 400 });
}

function budgetExhausted(budget: Budget): Response {
  return Response.json(
    { error: "budget_exhausted", used: budget.used, limit: budget.limit },
    { status: 429 }
  );
}

/**
 * "The role that needs a key has one."
 *
 * workers-ai needs no key at all, so the answer is true. An OpenAI-compatible
 * deployment needs one for chat and one for System One, and they are resolved
 * per role: a key that only answers chat does not make System One ready.
 */
function apiKeyConfigured(provider: AiSettings["provider"], keys: ReturnType<typeof providerKeys>): boolean {
  if (provider === "workers-ai") return true;
  return keys.chat.key !== null && keys.system1.key !== null;
}

/* ───────────────────────────── 1. settings ───────────────────────────── */

interface SettingsResponse {
  provider: string;
  model: string;
  baseUrl: string | null;
  /**
   * System One's effective values. `model` and `baseUrl` already carry the
   * "fall back to chat" resolution, so the console never has to re-implement it.
   * `provider` is echoed because it is the same selector, not a second one.
   */
  system1: {
    model: string;
    provider: string;
    baseUrl: string | null;
    /** True when the row stores no origin and this is the chat base. */
    inheritsBase: boolean;
  };
  apiKeyConfigured: boolean;
  /**
   * Which secret answered EACH role — a name, never a value. Chat and System One
   * have separate chains, and may legitimately resolve to different secrets.
   */
  keySource: { chat: string; system1: string };
  hint: string;
  budget: { day: string; used: number; limit: number };
}

function hintFor(
  settings: AiSettings,
  keys: ReturnType<typeof providerKeys>,
  configured: boolean
): string {
  const chatError = settings.baseUrlError;
  const system1Error = settings.system1BaseUrlError;
  if (settings.provider === "workers-ai") {
    return "Uses the Worker's AI binding; no API key is needed.";
  }
  if (chatError !== undefined || system1Error !== undefined) {
    return [chatError, system1Error].filter((entry): entry is string => entry !== undefined).join(" ");
  }
  if (!configured) {
    const missing = [
      keys.chat.key === null ? "chat (AI_PROVIDER_API_KEY, then AI_CHAT_API_KEY)" : null,
      keys.system1.key === null ? "System One (AI_PROVIDER_API_KEY, then TOKENLAB_API_KEY)" : null,
    ].filter((entry): entry is string => entry !== null);
    return `No key for ${missing.join(" and ")}. Set one with \`cf workers secrets update AI_PROVIDER_API_KEY --type secret_text\`; keys are never stored in D1.`;
  }
  return `Key from ${keys.chat.source} for chat and ${keys.system1.source} for System One. Requests go to ${settings.baseUrl ?? "the configured base URL"}, System One to ${settings.system1BaseUrl ?? settings.baseUrl ?? "the same base"}.`;
}

function settingsResponse(
  env: Env,
  settings: AiSettings,
  budget: Budget
): SettingsResponse {
  const keys = providerKeys(env);
  const configured = apiKeyConfigured(settings.provider, keys);
  return {
    provider: settings.provider,
    model: settings.model,
    baseUrl: settings.baseUrl,
    system1: {
      // The model never inherits the chat model (a gateway decides with a
      // different name than it chats with); the origin does, and the flag says
      // so, because two equal URLs cannot tell an inherited base from an
      // explicit override.
      model: settings.system1Model ?? settings.model,
      provider: settings.provider,
      baseUrl: settings.provider === "openai-compatible" ? settings.system1BaseUrl : null,
      inheritsBase:
        settings.provider === "openai-compatible" ? settings.system1BaseInherited : true,
    },
    apiKeyConfigured: configured,
    keySource: { chat: keys.chat.source, system1: keys.system1.source },
    hint: hintFor(settings, keys, configured),
    budget: { day: budget.day, used: budget.used, limit: budget.limit },
  };
}

/** `GET /v1/admin/ai/settings` — what the console should show. */
export async function handleAiSettingsGet(env: Env): Promise<Response> {
  const settings = await readSettings(env);
  const budget = await readBudget(env);
  return Response.json(settingsResponse(env, settings, budget));
}

/**
 * `PUT /v1/admin/ai/settings` — validated write, audited without the key.
 *
 * workers-ai has no base URL and ignores one: accepting and storing it would
 * leave a value that looks configured and is not. openai-compatible requires
 * one, and it must be https (or loopback http). The System One base gets the
 * same rule, because it is where the same key is sent.
 *
 * `system1` is optional and, like every other field here, a replacement: an
 * omitted member clears the stored value, which reads back as "use the chat
 * model / base" rather than as an error.
 */
export async function handleAiSettingsPut(
  req: Request,
  env: Env,
  actor: AdminActor
): Promise<Response> {
  const parsed = await readJsonBoundedResult(req, ASSISTANT_BODY_BYTES);
  if (!parsed.ok) return err(parsed.reason);
  const input = parsed.value;

  const rawProvider = input.provider;
  if (!isChatProviderKind(rawProvider)) {
    return badRequest(
      `provider must be one of ${CHAT_PROVIDER_KINDS.join(", ")}`
    );
  }
  const provider = rawProvider;

  const rawModel = input.model;
  if (typeof rawModel !== "string" || rawModel.trim() === "") {
    return badRequest("model must be a non-empty string");
  }
  const model = rawModel.trim();
  if (model.length > MAX_MODEL_CHARS) {
    return badRequest(`model must be at most ${MAX_MODEL_CHARS} characters`);
  }

  let baseUrl: string | null = null;
  if (provider === "openai-compatible") {
    const checked = validateBaseUrl(input.baseUrl);
    if (!checked.ok) return badRequest(checked.message);
    baseUrl = checked.value;
  } else if (typeof input.baseUrl === "string" && input.baseUrl.trim() !== "") {
    return badRequest("baseUrl is not used by workers-ai");
  }

  let system1Model: string | null = null;
  let system1BaseUrl: string | null = null;
  const rawSystem1 = input.system1;
  if (rawSystem1 !== undefined && rawSystem1 !== null) {
    if (typeof rawSystem1 !== "object" || Array.isArray(rawSystem1)) {
      return badRequest("system1 must be an object");
    }
    const system1 = rawSystem1 as Record<string, unknown>;

    if (system1.model !== undefined && system1.model !== null) {
      if (typeof system1.model !== "string" || system1.model.trim() === "") {
        return badRequest("system1.model must be a non-empty string");
      }
      const system1ModelValue = system1.model.trim();
      if (system1ModelValue.length > MAX_MODEL_CHARS) {
        return badRequest(`system1.model must be at most ${MAX_MODEL_CHARS} characters`);
      }
      // Workers AI serves exactly three decision aliases and nothing else. A
      // stored typo would be mapped to `clef` at ask time and answered
      // silently, so it is refused here where the operator can see it.
      if (
        provider === "workers-ai" &&
        !(SYSTEM1_ALIASES as readonly string[]).includes(system1ModelValue)
      ) {
        return badRequest(
          `system1.model must be one of ${SYSTEM1_ALIASES.join(", ")} for workers-ai`
        );
      }
      system1Model = system1ModelValue;
    }

    if (system1.baseUrl !== undefined && system1.baseUrl !== null) {
      if (provider === "openai-compatible") {
        const checked = validateBaseUrl(system1.baseUrl);
        if (!checked.ok) return badRequest(`system1.${checked.message}`);
        system1BaseUrl = checked.value;
      } else if (typeof system1.baseUrl === "string" && system1.baseUrl.trim() !== "") {
        return badRequest("system1.baseUrl is not used by workers-ai");
      }
    }
  }

  const settings: AiSettings = {
    provider,
    model,
    baseUrl,
    system1Model,
    system1BaseUrl,
    // What was just written: an empty System One base is the inherit case.
    system1BaseInherited: system1BaseUrl === null,
  };
  await writeSettings(env, settings, actor.label);

  await writeAudit(env, {
    action: "ai.settings.updated",
    actor: { userId: actor.userId, label: actor.label },
    // The key is not here, and cannot be: it never reaches this handler.
    detail: {
      provider,
      model,
      base_url: baseUrl,
      system1_model: system1Model,
      system1_base_url: system1BaseUrl,
    },
  });

  const budget = await readBudget(env);
  // Read the row back rather than echoing the request: "fall back to the chat
  // value" is a read-time rule, so the console must see the same effective
  // System One values from PUT and GET.
  const stored = await readSettings(env);
  return Response.json(settingsResponse(env, stored, budget));
}

/* ──────────────────────────── 2b. model catalog ──────────────────────────── */

/**
 * The models a deployment can pick, in the provider's own words.
 *
 * An OpenAI-compatible gateway publishes `GET {base}/models`, and reading it is
 * what turns a free-text model field into something an operator can choose
 * from. The Workers AI binding publishes nothing, so the list there is a short,
 * honest static one and `source` says so: a guess dressed as a catalog would be
 * worse than no picker.
 */
const WORKERS_AI_CHAT_MODELS = [
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/meta/llama-3.1-8b-instruct",
  "@cf/meta/llama-3.1-8b-instruct-fast",
  "@cf/qwen/qwen2.5-coder-32b-instruct",
];

/** `GET /v1/admin/ai/models` — what this provider offers right now. */
export async function handleAiModels(env: Env): Promise<Response> {
  const settings = await readSettingsOrEnv(env);
  const refused = settingsRefusal(settings);
  if (refused !== null) return refused;

  if (settings.provider === "workers-ai") {
    return Response.json({
      provider: settings.provider,
      source: "static",
      note: "The AI binding has no catalog endpoint; these are the text models this gateway recommends.",
      models: WORKERS_AI_CHAT_MODELS.map((id) => ({ id })),
    });
  }

  const apiKey = providerKey(env, "chat").key;
  if (apiKey === null) {
    return aiUnavailable(
      "missing_key",
      "no chat provider key is set; add one with `cf workers secrets update AI_PROVIDER_API_KEY --type secret_text` (AI_CHAT_API_KEY is also read for chat)"
    );
  }
  if (settings.baseUrl === null || settings.baseUrl === "") {
    return aiUnavailable(
      "missing_base_url",
      "openai-compatible needs a baseUrl before it has models"
    );
  }

  let response: Response;
  try {
    response = await fetch(`${settings.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    return aiUnavailable(
      "provider_unavailable",
      `the provider could not be reached: ${String(error).slice(0, 120)}`
    );
  }

  if (!response.ok) {
    const retryAfter = response.headers.get("retry-after");
    if (response.status === 429) {
      return aiUnavailable(
        "provider_rate_limited",
        "the provider is rate limiting this key",
        retryAfter ?? undefined
      );
    }
    if (response.status === 401 || response.status === 403) {
      return aiUnavailable(
        "provider_auth",
        "the provider refused the key while listing models"
      );
    }
    return aiUnavailable(
      "provider_unavailable",
      `the provider answered ${response.status} for /models`
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return aiUnavailable("unparseable", "the provider returned a non-JSON model list");
  }

  const raw = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const list = Array.isArray(raw.data)
    ? raw.data
    : Array.isArray(raw.models)
      ? raw.models
      : null;
  if (list === null) {
    return aiUnavailable("unparseable", "the provider has no data[] in its model list");
  }

  const models: Array<{ id: string; owned_by?: string }> = [];
  for (const entry of list.slice(0, 200)) {
    if (typeof entry === "string") {
      models.push({ id: entry });
      continue;
    }
    if (entry === null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id =
      typeof record.id === "string"
        ? record.id
        : typeof record.name === "string"
          ? record.name
          : null;
    if (id === null || id === "") continue;
    models.push(typeof record.owned_by === "string" ? { id, owned_by: record.owned_by } : { id });
  }

  return Response.json({ provider: settings.provider, source: "provider", models });
}

/* ─────────────────────────────── 2. test ─────────────────────────────── */

/** `POST /v1/admin/ai/test` — one tiny call, ≤64 output tokens. */
export async function handleAiTest(env: Env): Promise<Response> {
  // The existing admin limiter, keyed separately so a probe burst cannot drain
  // the budget a real chat needs. The admin gate already limits token/CLI calls;
  // this covers the session path, which has no limiter of its own.
  if (env.ADMIN_LIMITER) {
    const { success } = await env.ADMIN_LIMITER.limit({ key: "ai:test" });
    if (!success) return err("rate_limited", 429);
  }

  const settings = await readSettingsOrEnv(env);
  const refused = settingsRefusal(settings);
  if (refused !== null) {
    logAssistant("test.unavailable", { reason: "bad_base_url", provider: settings.provider });
    return refused;
  }
  const resolved = resolveAdapter(env, settings);
  if (!resolved.ok) {
    logAssistant("test.unavailable", { reason: resolved.reason, provider: settings.provider });
    return aiUnavailable(resolved.reason, resolved.message);
  }

  const budget = await readBudget(env);
  if (budget.used >= budget.limit) return budgetExhausted(budget);

  const messages: ChatMessage[] = [
    { role: "system", content: "Reply with exactly: pong" },
    { role: "user", content: "ping" },
  ];

  const started = Date.now();
  try {
    const result = await resolved.adapter.chat(messages, {
      maxOutputTokens: 64,
      temperature: 0,
    });
    const tokens = billableTokens(
      result,
      messages.map((message) => message.content).join("\n")
    );
    await addTokens(env, budget.day, tokens);
    logAssistant("test", { provider: result.provider, tokens, took_ms: Date.now() - started });

    return Response.json({
      ok: true,
      provider: result.provider,
      model: result.model,
      took_ms: Date.now() - started,
      sample: result.text.slice(0, 200),
    });
  } catch (error) {
    const reason = error instanceof ChatAdapterError ? error.reason : "provider_unavailable";
    const message =
      error instanceof ChatAdapterError ? error.message : "the provider call failed";
    logAssistant("test.failed", { reason, provider: settings.provider });
    // A failed call is not charged: no tokens were reported and the provider
    // either refused or timed out, so billing it would only make the ceiling
    // depend on the network.
    return aiUnavailable(reason, message);
  }
}

/* ─────────────────────── 2b. System 1 provider test ─────────────────────── */

/** The three ids `ask()` accepts; the alias, not the wire model name. */
const SYSTEM1_TEST_MODELS = ["clef", "clef-flash", "clef-omni"] as const;

const SYSTEM1_TEST_MODEL_SET: ReadonlySet<string> = new Set(SYSTEM1_TEST_MODELS);

/** One fixed, harmless ticket: same questions for every provider. */
const SYSTEM1_TEST_STATE = {
  ticket: "Customer cannot log in after resetting the password; error 403 on every attempt.",
};

const SYSTEM1_TEST_QUESTIONS: Record<string, ClefQuestion> = {
  team: {
    type: "choice",
    instructions: "Which team should take this support ticket? Choose the single best team.",
    criteria: {
      Billing: "Invoices, charges, refunds or payment methods",
      Accounts: "Sign-in, passwords, profiles or permissions",
      Networking: "Connectivity, DNS, latency or packet loss",
    },
  },
  urgent: {
    type: "noul",
    instructions:
      "Does this ticket need a human today, before any automation handles it?",
  },
  severity: {
    type: "score",
    instructions: "How severe is the customer impact?",
    criteria: ["Low", "Medium", "High"],
  },
};

/**
 * `POST /v1/admin/ai/system1/test` — one tiny fixed decision, through `ask()`.
 *
 * It exercises the SAME selection path production uses, so the reported
 * `provider` is what a real triage call would use. Nothing is charged to the
 * chat token budget: a System 1 call is a prefill batch, not a chat completion,
 * and capping it would make the probe disagree with the thing it probes.
 */
export async function handleSystem1Test(req: Request, env: Env): Promise<Response> {
  // A separate key from the chat probe, so a burst here cannot exhaust the
  // allowance the settings page's test needs.
  if (env.ADMIN_LIMITER) {
    const { success } = await env.ADMIN_LIMITER.limit({ key: "ai:system1:test" });
    if (!success) return err("rate_limited", 429);
  }

  // The body is optional: `{}` means "the row's model".
  const parsed = await readJsonBoundedResult(req, ASSISTANT_BODY_BYTES);
  if (!parsed.ok) return err(parsed.reason);

  // One settings read: the probe uses the same row production uses, so its
  // reported provider is what a real triage call would use.
  const settings = await readSettingsOrEnv(env);
  const config = system1ConfigFor(env, settings);
  const configRefusal = settings.system1BaseUrlError;
  if (configRefusal !== undefined) return aiUnavailable("bad_base_url", configRefusal);

  // The allowlist is the LOCAL alias set, never the wire model: the request
  // names which local label to report, and the row's model is what is sent. The
  // stored wire name is accepted too, so a console that echoes `system1.model`
  // back (for example "Clef") is not a 400.
  const storedModel = settings.system1Model?.trim() ?? "";
  const rawModel = parsed.value.model;
  const accepted =
    rawModel === undefined ||
    (typeof rawModel === "string" &&
      (SYSTEM1_TEST_MODEL_SET.has(rawModel) || (storedModel !== "" && rawModel === storedModel)));
  if (!accepted) {
    return badRequest(
      `model must be one of ${SYSTEM1_TEST_MODELS.join(", ")}${
        storedModel === "" ? "" : `, or the configured System One model (${storedModel})`
      }`
    );
  }
  const model: System1Model =
    typeof rawModel === "string" && SYSTEM1_TEST_MODEL_SET.has(rawModel)
      ? (rawModel as System1Model)
      : aliasFor(config.model);

  const started = Date.now();
  const result = await ask(config, SYSTEM1_TEST_STATE, SYSTEM1_TEST_QUESTIONS, model);
  const tookMs = Date.now() - started;

  // Report the backend that actually answered. Nothing is defaulted to a
  // provider name here: on a failure the response's `provider` is "none".
  const provider = result.provider ?? "none";

  if (!result.ok) {
    const reason = result.reason ?? "provider_unavailable";
    logAssistant("system1.test.failed", {
      reason,
      provider,
      model: result.model,
      took_ms: tookMs,
    });
    return aiUnavailable(reason, "the System 1 provider did not return an answer", result.retryAfter);
  }

  logAssistant("system1.test", {
    provider,
    model: result.model,
    took_ms: tookMs,
  });

  return Response.json({
    ok: true,
    provider,
    model: result.model,
    took_ms: tookMs,
    answers: result.answers,
  });
}

/* ─────────────────────────────── 3. chat ─────────────────────────────── */

const SYSTEM_PROMPT = [
  "You are the DakFlare console assistant. DakFlare is a self-hosted SMS gateway: one Android handset, one Cloudflare Worker, and this console.",
  "",
  "You have NO tools. You cannot read, send, save, deploy or inspect anything. Never claim to have done so. Every proposal is a DRAFT that a human must accept; say that when it matters.",
  "",
  "Answer with exactly one JSON object and nothing else — no prose before or after it, no code fences:",
  '{ "answer": string, "proposals": [ { "kind": "create_rule" | "create_template" | "stage_workflow_patch", "title": string, "summary": string, "payload": object } ] }',
  "",
  "Rules:",
  "- `answer` is 1-4 sentences of plain text. It may be an empty string only when a proposal carries the whole reply.",
  "- At most 3 proposals. Zero proposals is a normal answer.",
  "- create_rule payload: { name, matcher: { type: \"exact\"|\"prefix\"|\"suffix\"|\"glob\", value }, body_matcher: { type: \"keyword\", value }, reply_template }. NEVER author a regex matcher.",
  "- create_template payload: { name, body }.",
  '- stage_workflow_patch payload: { flow_id, ops: [ { "op": "add", "type": "<node type from the flow>", "after"|"before": "<existing node id>", "data": {...} }, { "op": "move", "id": "<node id>", "after"|"before": "<node id>" }, { "op": "rename", "id": "<node id>", "title": "..." }, { "op": "remove", "id": "<node id>" } ] }. Name steps by the ids in the flow block; do not copy the graph or step data. The server applies the operations and a human accepts the result, so an operation it cannot apply is refused rather than guessed at.',
  "- Use only ids and routes present in the context. Never invent a device, flow, message or rule id.",
].join("\n");

/** A serialised flow larger than this drops step data instead of the block. */
const MAX_FLOW_PROMPT_CHARS = 8_000;

/** The D1 columns the prompt needs; kept narrow on purpose. */
export interface FlowPromptRow {
  id: string;
  name: string;
  enabled: number;
  graph: string;
}

interface FlowGraphParts {
  nodes: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
}

function parseFlowGraph(raw: string): FlowGraphParts | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const record = asObject(parsed);
  if (record === null) return null;
  const nodes = Array.isArray(record.nodes)
    ? record.nodes.filter((node): node is Record<string, unknown> => asObject(node) !== null)
    : [];
  const edges = Array.isArray(record.edges)
    ? record.edges.filter((edge): edge is Record<string, unknown> => asObject(edge) !== null)
    : [];
  return { nodes, edges };
}

function nodePromptEntry(
  node: Record<string, unknown>
): { full: Record<string, unknown>; lean: Record<string, unknown> } | null {
  const id = typeof node.id === "string" ? node.id : null;
  if (id === null) return null;
  const type = typeof node.type === "string" ? node.type : "unknown";
  const full: Record<string, unknown> = { id, type };
  const position = asObject(node.position);
  if (
    position !== null &&
    typeof position.x === "number" &&
    typeof position.y === "number"
  ) {
    full.position = { x: position.x, y: position.y };
  }
  if (node.data !== undefined) full.data = node.data;
  return { full, lean: { id, type } };
}

/** Edge fields a branch graph actually carries; anything else is dropped. */
const EDGE_PROMPT_KEYS = ["sourceHandle", "targetHandle", "label", "branch"] as const;

function edgePromptEntry(
  edge: Record<string, unknown>
): { full: Record<string, unknown>; lean: Record<string, unknown> } | null {
  const id = typeof edge.id === "string" ? edge.id : null;
  const source = typeof edge.source === "string" ? edge.source : null;
  const target = typeof edge.target === "string" ? edge.target : null;
  if (id === null || source === null || target === null) return null;
  const full: Record<string, unknown> = { id, source, target };
  for (const key of EDGE_PROMPT_KEYS) {
    const value = edge[key];
    if (typeof value === "string" && value !== "") full[key] = value;
  }
  return { full, lean: { id, source, target } };
}

function flowPromptHeader(flow: FlowPromptRow): string {
  return [
    "Flow context from D1 (read-only; this is the operator's own configuration):",
    `flow id=${JSON.stringify(flow.id)} name=${JSON.stringify(flow.name)} enabled=${flow.enabled !== 0}`,
  ].join("\n");
}

function renderFlowBlock(
  flow: FlowPromptRow,
  nodes: Array<Record<string, unknown>>,
  edges: Array<Record<string, unknown>>,
  omitData: boolean
): string {
  const lines = [flowPromptHeader(flow)];
  if (omitData) {
    lines.push(
      "Step data was omitted from this block to stay within the prompt budget; ids and connections are complete."
    );
  }
  lines.push("Steps:");
  for (const node of nodes) lines.push(`- ${JSON.stringify(node)}`);
  lines.push("Connections:");
  for (const edge of edges) lines.push(`- ${JSON.stringify(edge)}`);
  return lines.join("\n");
}

/**
 * Build the bounded graph block for the prompt.
 *
 * `undefined` means the console named no flow (no block); `null` means it named
 * one that D1 does not hold, so the model is told to withhold a patch instead of
 * inventing a graph. The full form carries data and position; a graph over the
 * cap degrades to ids/types and edge endpoints only.
 */
export function flowPromptBlock(flow: FlowPromptRow | null | undefined): string {
  if (flow === undefined) return "";
  if (flow === null) {
    return [
      "Console context named a flowId, but no flow with that id exists in D1.",
      "Do not invent a flow id, and withhold any stage_workflow_patch proposal: a patch cannot be authored for a flow that was not found.",
    ].join("\n");
  }

  const parts = parseFlowGraph(flow.graph);
  if (parts === null) {
    return [
      flowPromptHeader(flow),
      "The stored graph could not be parsed, so its steps are not shown.",
      "Withhold any stage_workflow_patch proposal rather than guessing the graph.",
    ].join("\n");
  }

  const nodes = parts.nodes
    .map(nodePromptEntry)
    .filter((entry): entry is { full: Record<string, unknown>; lean: Record<string, unknown> } => entry !== null);
  const edges = parts.edges
    .map(edgePromptEntry)
    .filter((entry): entry is { full: Record<string, unknown>; lean: Record<string, unknown> } => entry !== null);

  const serialized = JSON.stringify({
    nodes: nodes.map((entry) => entry.full),
    edges: edges.map((entry) => entry.full),
  });
  const omitData = serialized.length > MAX_FLOW_PROMPT_CHARS;
  const block = omitData
    ? renderFlowBlock(flow, nodes.map((entry) => entry.lean), edges.map((entry) => entry.lean), true)
    : renderFlowBlock(flow, nodes.map((entry) => entry.full), edges.map((entry) => entry.full), false);

  // Last-resort guard: even lean ids can be enormous in a pathological flow.
  if (block.length > MAX_FLOW_PROMPT_CHARS) {
    return `${block.slice(0, MAX_FLOW_PROMPT_CHARS)}\n[flow context truncated to ${MAX_FLOW_PROMPT_CHARS} characters]`;
  }
  return block;
}

/** The whole system message: the fixed rules plus the optional flow block. */
export function buildSystemPrompt(flow?: FlowPromptRow | null): string {
  const block = flowPromptBlock(flow);
  return block === "" ? SYSTEM_PROMPT : `${SYSTEM_PROMPT}\n\n${block}`;
}

interface ChatContext {
  route?: string;
  flowId?: string;
}

type ParsedContext =
  | { ok: true; context: ChatContext }
  | { ok: false; message: string };

/**
 * The console may send `{ route, flowId }` ONLY.
 *
 * An allowlist rather than a strip: a future console that tries to send a
 * message body through `context` should get a 400 it can see, not silent
 * success while the body is dropped. The two values are echoed into the prompt
 * as text and are never used to build a query or a path.
 */
function parseContext(value: unknown): ParsedContext {
  if (value === undefined || value === null) return { ok: true, context: {} };
  if (typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, message: "context must be an object" };
  }

  const record = value as Record<string, unknown>;
  const allowed = new Set(["route", "flowId"]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      return { ok: false, message: "context accepts only route and flowId" };
    }
  }

  const context: ChatContext = {};
  if (record.route !== undefined && record.route !== null) {
    if (typeof record.route !== "string") {
      return { ok: false, message: "context.route must be a string" };
    }
    const route = record.route.trim();
    if (route.length > 200) return { ok: false, message: "context.route is too long" };
    if (route !== "") context.route = route;
  }
  if (record.flowId !== undefined && record.flowId !== null) {
    if (typeof record.flowId !== "string") {
      return { ok: false, message: "context.flowId must be a string" };
    }
    const flowId = record.flowId.trim();
    if (flowId.length > 128) return { ok: false, message: "context.flowId is too long" };
    if (flowId !== "") context.flowId = flowId;
  }
  return { ok: true, context };
}

interface ProposalDraft {
  kind: ProposalKind;
  title: string;
  summary: string;
  payload: Record<string, unknown>;
}

/** One parsed model reply. */
interface WithheldProposal {
  kind: string;
  reason: string;
}

interface ParsedReply {
  answer: string;
  proposals: ProposalDraft[];
  withheld: WithheldProposal[];
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeProposals(value: unknown): {
  proposals: ProposalDraft[];
  withheld: WithheldProposal[];
} {
  const drafts: ProposalDraft[] = [];
  const withheld: WithheldProposal[] = [];
  if (!Array.isArray(value)) return { proposals: drafts, withheld };

  for (const entry of value) {
    if (drafts.length >= MAX_PROPOSALS) {
      withheld.push({
        kind: "proposal",
        reason: `only ${MAX_PROPOSALS} proposals are shown at once`,
      });
      break;
    }
    const record = asObject(entry);
    if (record === null) continue;

    const kind = record.kind;
    if (typeof kind !== "string" || !PROPOSAL_KIND_SET.has(kind)) continue;

    const title = typeof record.title === "string" ? record.title.trim() : "";
    if (title === "") continue;

    const payload = asObject(record.payload);
    if (payload === null) continue;

    let payloadJson: string;
    try {
      payloadJson = JSON.stringify(payload);
    } catch {
      continue;
    }
    if (payloadJson.length > MAX_PAYLOAD_JSON_CHARS) {
      withheld.push({
        kind,
        reason: `the ${kind} proposal was dropped because its payload is ${payloadJson.length} characters, over the ${MAX_PAYLOAD_JSON_CHARS}-character limit`,
      });
      continue;
    }

    drafts.push({
      kind: kind as ProposalKind,
      title: title.slice(0, MAX_TITLE_CHARS),
      summary:
        typeof record.summary === "string" ? record.summary.trim().slice(0, MAX_SUMMARY_CHARS) : "",
      payload,
    });
  }

  return { proposals: drafts, withheld };
}

/* ───────────────────────── server-side graph composition ───────────────── */

/** The two halves of a flow, in the shape the editor persists. */
export interface FlowPatchGraph {
  nodes: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
}

export type ApplyFlowOpsResult =
  | { ok: true; graph: FlowPatchGraph }
  | { ok: false; reason: string };

const NODE_TYPE_TITLES: Record<string, string> = {
  trigger: "Trigger",
  extract: "Extract",
  set_var: "Set variable",
  condition: "Condition",
  switch: "Switch",
  delay: "Delay",
  webhook: "Webhook",
  send_sms: "Send SMS",
  reply: "Reply",
  stop: "Stop",
};

const COUNT_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
] as const;

function countWord(count: number): string {
  return COUNT_WORDS[count] ?? String(count);
}

/** The name an operator sees on a card: its override, its label, then its kind. */
function nodeDisplayTitle(node: Record<string, unknown> | null): string {
  if (node === null) return "Step";
  const data = asObject(node.data);
  if (data !== null && typeof data.title === "string" && data.title.trim() !== "") {
    return data.title.trim();
  }
  if (data !== null && typeof data.label === "string" && data.label.trim() !== "") {
    return data.label.trim();
  }
  const type = typeof node.type === "string" ? node.type : "";
  return NODE_TYPE_TITLES[type] ?? (type === "" ? "Step" : type);
}

function outgoingOf(graph: FlowPatchGraph, id: string): Array<Record<string, unknown>> {
  return graph.edges.filter((edge) => edge.source === id);
}

function incomingOf(graph: FlowPatchGraph, id: string): Array<Record<string, unknown>> {
  return graph.edges.filter((edge) => edge.target === id);
}

function cloneGraph(graph: FlowPatchGraph): FlowPatchGraph {
  try {
    return JSON.parse(JSON.stringify(graph)) as FlowPatchGraph;
  } catch {
    return {
      nodes: graph.nodes.map((node) => ({ ...node })),
      edges: graph.edges.map((edge) => ({ ...edge })),
    };
  }
}

interface MintState {
  node: number;
  edge: number;
}

/** A deterministic, collision-free node id: the same ops always compose the same graph. */
function mintNodeId(
  type: string,
  graph: FlowPatchGraph,
  state: MintState
): string {
  const stem = `n_${type.replace(/[^A-Za-z0-9_]/g, "_")}`;
  const taken = new Set(graph.nodes.map((node) => String(node.id)));
  for (;;) {
    state.node += 1;
    const id = `${stem}_${state.node}`;
    if (!taken.has(id)) return id;
  }
}

function mintEdgeId(graph: FlowPatchGraph, state: MintState): string {
  const taken = new Set(graph.edges.map((edge) => String(edge.id)));
  for (;;) {
    state.edge += 1;
    const id = `e_added_${state.edge}`;
    if (!taken.has(id)) return id;
  }
}

/** The one anchor an op names: exactly one of `after` / `before`. */
function readAnchor(
  op: Record<string, unknown>
): { where: "after" | "before"; id: string } | { error: string } {
  const after = op.after;
  const before = op.before;
  if (after !== undefined && before !== undefined) {
    return { error: "an operation cannot name both after and before" };
  }
  const where: "after" | "before" = before !== undefined ? "before" : "after";
  const raw = where === "before" ? before : after;
  if (typeof raw !== "string" || raw.trim() === "") {
    return { error: `a ${String(op.op ?? "graph")} operation needs an existing node id in ${where}` };
  }
  return { where, id: raw.trim() };
}

function removeRefusal(
  node: Record<string, unknown>,
  incoming: number,
  outgoing: number
): string {
  const title = nodeDisplayTitle(node);
  if (node.type === "trigger") {
    return `removing "${title}" is refused because the flow needs its trigger`;
  }
  const branches =
    node.type === "condition" || node.type === "switch" || incoming > 1 || outgoing > 1;
  if (branches) {
    if (outgoing > 1) {
      return `removing "${title}" is refused because it has ${countWord(outgoing)} outgoing connections`;
    }
    if (incoming > 1) {
      return `removing "${title}" is refused because it has ${countWord(incoming)} incoming connections`;
    }
    return `removing "${title}" is refused because it branches`;
  }
  return `removing "${title}" is refused because it has ${countWord(incoming)} connections in and ${countWord(outgoing)} out, so its neighbours cannot be rejoined`;
}

function applyOneOp(
  graph: FlowPatchGraph,
  op: Record<string, unknown>,
  state: MintState
): { ok: true } | { ok: false; reason: string } {
  const kind = typeof op.op === "string" ? op.op : "";

  if (kind === "add") {
    const type = typeof op.type === "string" ? op.type.trim() : "";
    if (type === "") {
      return { ok: false, reason: 'an "add" operation needs a node type' };
    }
    const anchor = readAnchor(op);
    if ("error" in anchor) return { ok: false, reason: anchor.error };
    const anchorNode = graph.nodes.find((node) => node.id === anchor.id);
    if (anchorNode === undefined) {
      return {
        ok: false,
        reason: `adding a step is refused because node "${anchor.id}" is not in the flow`,
      };
    }
    const anchorPosition = asObject(anchorNode.position);
    const x =
      anchorPosition !== null && typeof anchorPosition.x === "number"
        ? anchorPosition.x + 280
        : 0;
    const y =
      anchorPosition !== null && typeof anchorPosition.y === "number" ? anchorPosition.y : 0;
    const data = asObject(op.data);
    const created: Record<string, unknown> = {
      id: mintNodeId(type, graph, state),
      type,
      position: { x, y },
      data: data === null ? {} : JSON.parse(JSON.stringify(data)),
    };
    graph.nodes.push(created);
    if (anchor.where === "after") {
      // Splice the new step into the anchor's outgoing connection when it has
      // one, then hang the anchor's own connection on the new step.
      for (const edge of graph.edges) {
        if (edge.source === anchor.id) edge.source = created.id;
      }
      graph.edges.push({
        id: mintEdgeId(graph, state),
        source: anchor.id,
        target: created.id,
      });
    } else {
      for (const edge of graph.edges) {
        if (edge.target === anchor.id) edge.target = created.id;
      }
      graph.edges.push({
        id: mintEdgeId(graph, state),
        source: created.id,
        target: anchor.id,
      });
    }
    return { ok: true };
  }

  if (kind === "move") {
    const id = typeof op.id === "string" ? op.id.trim() : "";
    if (id === "") return { ok: false, reason: 'a "move" operation needs a node id' };
    const anchor = readAnchor(op);
    if ("error" in anchor) return { ok: false, reason: anchor.error };
    const moved = graph.nodes.find((node) => node.id === id);
    const anchorNode = graph.nodes.find((node) => node.id === anchor.id);
    if (moved === undefined) {
      return { ok: false, reason: `moving a step is refused because node "${id}" is not in the flow` };
    }
    if (anchorNode === undefined) {
      return {
        ok: false,
        reason: `moving a step is refused because node "${anchor.id}" is not in the flow`,
      };
    }
    if (moved.id === anchorNode.id) {
      return { ok: false, reason: "moving a step next to itself is refused" };
    }
    if (moved.type === "trigger") {
      return {
        ok: false,
        reason: `moving "${nodeDisplayTitle(moved)}" is refused because the trigger is where the flow starts`,
      };
    }
    const incoming = incomingOf(graph, id);
    const outgoing = outgoingOf(graph, id);
    if (incoming.length !== 1 || outgoing.length !== 1) {
      return {
        ok: false,
        reason: `moving "${nodeDisplayTitle(moved)}" is refused because it has ${countWord(incoming.length)} connections in and ${countWord(outgoing.length)} out; a move needs exactly one of each`,
      };
    }
    const inEdge = incoming[0];
    const outEdge = outgoing[0];

    // Lift the step out first: its predecessor leads where it used to lead.
    const stitch: Record<string, unknown> = { ...inEdge, target: outEdge.target };
    graph.edges = graph.edges.filter(
      (edge) => edge !== inEdge && edge !== outEdge
    );
    graph.edges.push(stitch);

    if (anchor.where === "after") {
      const outs = outgoingOf(graph, anchor.id);
      if (outs.length === 0) {
        return {
          ok: false,
          reason: `moving "${nodeDisplayTitle(moved)}" is refused because "${nodeDisplayTitle(anchorNode)}" is the last step, so nothing can go after it`,
        };
      }
      if (outs.length > 1) {
        return {
          ok: false,
          reason: `moving "${nodeDisplayTitle(moved)}" is refused because "${nodeDisplayTitle(anchorNode)}" has ${countWord(outs.length)} outgoing connections, so "after" names more than one place`,
        };
      }
      const anchorOut = outs[0];
      const successor = anchorOut.target;
      anchorOut.target = id;
      graph.edges.push({ ...outEdge, target: successor });
    } else {
      const ins = incomingOf(graph, anchor.id);
      if (ins.length === 0) {
        return {
          ok: false,
          reason: `moving "${nodeDisplayTitle(moved)}" is refused because "${nodeDisplayTitle(anchorNode)}" has no connection leading to it`,
        };
      }
      if (ins.length > 1) {
        return {
          ok: false,
          reason: `moving "${nodeDisplayTitle(moved)}" is refused because "${nodeDisplayTitle(anchorNode)}" has ${countWord(ins.length)} incoming connections, so "before" names more than one place`,
        };
      }
      const anchorIn = ins[0];
      anchorIn.target = id;
      graph.edges.push({ ...outEdge, target: anchorNode.id });
    }

    // The moved step keeps its position; only its place in the list changes.
    graph.nodes = graph.nodes.filter((node) => node.id !== id);
    graph.nodes.push(moved);
    return { ok: true };
  }

  if (kind === "rename") {
    const id = typeof op.id === "string" ? op.id.trim() : "";
    if (id === "") return { ok: false, reason: 'a "rename" operation needs a node id' };
    const node = graph.nodes.find((entry) => entry.id === id);
    if (node === undefined) {
      return { ok: false, reason: `renaming a step is refused because node "${id}" is not in the flow` };
    }
    const title = typeof op.title === "string" ? op.title.trim() : "";
    if (title === "") {
      return { ok: false, reason: 'a "rename" operation needs a non-empty title' };
    }
    node.data = { ...(asObject(node.data) ?? {}), title };
    return { ok: true };
  }

  if (kind === "remove") {
    const id = typeof op.id === "string" ? op.id.trim() : "";
    if (id === "") return { ok: false, reason: 'a "remove" operation needs a node id' };
    const node = graph.nodes.find((entry) => entry.id === id);
    if (node === undefined) {
      return { ok: false, reason: `removing a step is refused because node "${id}" is not in the flow` };
    }
    const incoming = incomingOf(graph, id);
    const outgoing = outgoingOf(graph, id);
    if (incoming.length !== 1 || outgoing.length !== 1) {
      return { ok: false, reason: removeRefusal(node, incoming.length, outgoing.length) };
    }
    const inEdge = incoming[0];
    const outEdge = outgoing[0];
    graph.nodes = graph.nodes.filter((entry) => entry !== node);
    graph.edges = graph.edges.filter(
      (edge) => edge !== inEdge && edge !== outEdge
    );
    graph.edges.push({ ...inEdge, target: outEdge.target });
    return { ok: true };
  }

  return {
    ok: false,
    reason: `an operation named "${kind === "" ? "(missing)" : kind}" is refused because the server only applies add, move, rename and remove`,
  };
}

/**
 * Compose a staged workflow patch from a model's operation list.
 *
 * The model names steps; code moves them. Every operation either applies
 * completely or is refused with one operator-readable sentence naming the step,
 * so a caller can withhold the whole proposal rather than stage half a change.
 * The input graph is copied, never mutated, and ids are minted deterministically
 * (collision-free against the graph in hand) so the same ops always compose the
 * same graph.
 */
export function applyFlowOps(graph: FlowPatchGraph, ops: unknown): ApplyFlowOpsResult {
  if (!Array.isArray(ops) || ops.length === 0) {
    return { ok: false, reason: "the operations list is empty" };
  }
  const working = cloneGraph(graph);
  const state: MintState = { node: 0, edge: 0 };

  for (let index = 0; index < ops.length; index += 1) {
    const entry = asObject(ops[index]);
    if (entry === null) {
      return { ok: false, reason: `operation ${index + 1} is not an object` };
    }
    const applied = applyOneOp(working, entry, state);
    if (!applied.ok) return applied;
  }
  return { ok: true, graph: working };
}

function tryParseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return asObject(parsed);
  } catch {
    return null;
  }
}

/**
 * Defensive parse. A model is not a JSON serialiser, so the realistic shapes
 * are: clean JSON, JSON in a fence, or a short sentence with JSON after it.
 * Those are tried in that order; anything else is returned as the answer with
 * zero proposals, because a raw sentence is more useful to the operator than an
 * error and it can never be accepted as a proposal.
 */
/**
 * Appends the closers a truncated or miscounted JSON object is missing.
 *
 * String-aware, so a brace inside a template body does not confuse it. Returns
 * null when the text is not an object, when the stack underflows (a closer with
 * no opener), or when nothing had to be added.
 */
export function closeOpenBrackets(text: string): string | null {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const char of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") stack.push("}");
    else if (char === "[") stack.push("]");
    else if (char === "}" || char === "]") {
      if (stack.pop() !== char) return null;
    }
  }
  if (inString || stack.length === 0) return null;
  return text + stack.reverse().join("");
}

/**
 * Read the `answer` value out of a reply whose JSON tail is invalid.
 *
 * A string-aware scan, not a regex: the answer may contain escaped quotes,
 * braces and newlines, and cutting at the first `"` would truncate it. Returns
 * null when no complete answer string is present.
 */
export function salvageAnswer(text: string): string | null {
  let from = 0;
  while (from < text.length) {
    const key = text.indexOf('"answer"', from);
    if (key === -1) return null;
    from = key + '"answer"'.length;
    let cursor = from;
    while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
    if (text[cursor] !== ":") continue;
    cursor += 1;
    while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
    if (text[cursor] !== '"') continue;
    cursor += 1;

    let value = "";
    let escaped = false;
    for (; cursor < text.length; cursor += 1) {
      const char = text[cursor];
      if (escaped) {
        switch (char) {
          case "n":
            value += "\n";
            break;
          case "r":
            value += "\r";
            break;
          case "t":
            value += "\t";
            break;
          case "b":
            value += "\b";
            break;
          case "f":
            value += "\f";
            break;
          case "u": {
            const hex = text.slice(cursor + 1, cursor + 5);
            if (/^[0-9a-fA-F]{4}$/.test(hex)) {
              value += String.fromCharCode(Number.parseInt(hex, 16));
              cursor += 4;
            } else {
              value += "u";
            }
            break;
          }
          default:
            value += char;
        }
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === '"') return value;
      value += char;
    }
    return null;
  }
  return null;
}

function parseModelReply(text: string): ParsedReply {
  const trimmed = text.trim();
  const candidates: string[] = [trimmed];

  const fenced = /^```(?:json)?\s*([\s\S]*?)```$/i.exec(trimmed);
  if (fenced !== null) candidates.push(fenced[1].trim());

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));
  if (first !== -1) {
    const span = trimmed.slice(first);
    // A model asked for one JSON object still miscounts a closing brace often
    // enough to matter (measured against llama-3.3-70b: a complete-looking reply
    // with one unclosed object). Closing the open brackets is a bounded repair,
    // not a guess: it only runs when the text starts with `{`, and the result
    // must still be an object carrying an `answer` string.
    candidates.push(span);
    const repaired = closeOpenBrackets(span);
    if (repaired !== null) candidates.push(repaired);
  }

  for (const candidate of candidates) {
    const parsed = tryParseJsonObject(candidate);
    if (parsed === null) continue;
    if (typeof parsed.answer !== "string") continue;
    const normalized = normalizeProposals(parsed.proposals);
    return {
      answer: parsed.answer.trim().slice(0, MAX_ANSWER_CHARS),
      proposals: normalized.proposals,
      withheld: normalized.withheld,
    };
  }

  // The reply's tail was invalid (an extra or missing closer, or a stray
  // character) but the answer itself may be intact. Keep the operator's sentence
  // instead of showing them raw JSON with zero proposals.
  const salvaged = salvageAnswer(trimmed);
  if (salvaged !== null) {
    return {
      answer: salvaged.trim().slice(0, MAX_ANSWER_CHARS),
      proposals: [],
      withheld: [],
    };
  }

  return {
    answer: trimmed.slice(0, MAX_ANSWER_CHARS),
    proposals: [],
    withheld: [],
  };
}

/** Server-minted, opaque, and short enough to be a URL segment. */
function mintProposalId(): string {
  return `ap_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

async function persistProposals(
  env: Env,
  actor: AdminActor,
  drafts: ProposalDraft[]
): Promise<Array<ProposalDraft & { id: string }>> {
  const now = Date.now();
  const expiresAt = now + PROPOSAL_TTL_MS;
  const stored: Array<ProposalDraft & { id: string }> = [];

  for (const draft of drafts) {
    const id = mintProposalId();
    try {
      await env.DB.prepare(
        `INSERT INTO assistant_proposals
           (id, kind, payload_json, created_by, created_at, expires_at, consumed_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`
      )
        .bind(id, draft.kind, JSON.stringify(draft.payload), actor.label, now, expiresAt)
        .run();
      stored.push({ id, ...draft });
    } catch (error) {
      // The answer is still valid; a proposal that could not be stored is one
      // the console must not show, so it is dropped and the failure is logged.
      console.error(`[assistant.chat] proposal insert failed: ${String(error).slice(0, 200)}`);
    }
  }

  return stored;
}

/** One narrow read: the graph a stage_workflow_patch must reproduce exactly. */
async function loadFlowForPrompt(
  env: Env,
  flowId: string
): Promise<FlowPromptRow | null> {
  const row = await env.DB.prepare(
    `SELECT id, name, enabled, graph FROM workflows WHERE id = ?`
  )
    .bind(flowId)
    .first<FlowPromptRow>();
  return row ?? null;
}

/** `POST /v1/admin/assistant/chat` — answer plus drafts, never a change. */
export async function handleAssistantChat(
  req: Request,
  env: Env,
  actor: AdminActor
): Promise<Response> {
  const parsed = await readJsonBoundedResult(req, ASSISTANT_BODY_BYTES);
  if (!parsed.ok) return err(parsed.reason);
  const input = parsed.value;

  const rawMessage = input.message;
  if (typeof rawMessage !== "string" || rawMessage.trim() === "") {
    return badRequest("message must be a non-empty string");
  }
  const message = rawMessage.trim();
  if (message.length > MAX_MESSAGE_CHARS) {
    return badRequest(`message must be at most ${MAX_MESSAGE_CHARS} characters`);
  }

  const contextResult = parseContext(input.context);
  if (!contextResult.ok) return badRequest(contextResult.message);
  const context = contextResult.context;

  const settings = await readSettingsOrEnv(env);
  const refused = settingsRefusal(settings);
  if (refused !== null) {
    logAssistant("chat.unavailable", { reason: "bad_base_url", provider: settings.provider });
    return refused;
  }
  const resolved = resolveAdapter(env, settings);
  if (!resolved.ok) {
    logAssistant("chat.unavailable", { reason: resolved.reason, provider: settings.provider });
    return aiUnavailable(resolved.reason, resolved.message);
  }

  // The server composes a patch from the model's ops, so it needs the exact
  // graph the console is looking at. Read only when the console names a flow;
  // the client never supplies graph content and `parseContext` stays a two-key
  // allowlist.
  const flow =
    context.flowId === undefined ? undefined : await loadFlowForPrompt(env, context.flowId);

  // Checked BEFORE the call: the budget is a spend ceiling, and a call that
  // starts past it would already have spent the money the ceiling exists for.
  const budget = await readBudget(env);
  if (budget.used >= budget.limit) return budgetExhausted(budget);

  const contextParts: string[] = [];
  if (context.route !== undefined) contextParts.push(`route=${context.route}`);
  if (context.flowId !== undefined) contextParts.push(`flowId=${context.flowId}`);

  const userContent =
    contextParts.length === 0
      ? message
      : `${message}\n\nConsole context: ${contextParts.join(", ")}`;

  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(flow) },
    { role: "user", content: userContent },
  ];

  const started = Date.now();
  let result;
  try {
    // The model now returns a small ops list, but a model can still overrun a
    // tight output cap on a verbose reply. The hard ceiling is the honest limit;
    // a truncated tail is repaired or salvaged by `parseModelReply`.
    result = await resolved.adapter.chat(messages, { maxOutputTokens: MAX_OUTPUT_TOKENS });
  } catch (error) {
    const reason = error instanceof ChatAdapterError ? error.reason : "provider_unavailable";
    const detail =
      error instanceof ChatAdapterError ? error.message : "the provider call failed";
    const retryAfter = error instanceof ChatAdapterError ? error.retryAfter : undefined;
    logAssistant("chat.failed", { reason, provider: settings.provider });
    return aiUnavailable(reason, detail, retryAfter);
  }

  // Charged from the provider's own count where it gave one; a provider that
  // omits usage is estimated conservatively so the ceiling still holds.
  const tokens = billableTokens(result, messages.map((entry) => entry.content).join("\n"));
  await addTokens(env, budget.day, tokens);

  const reply = parseModelReply(result.text);
  const withheld: WithheldProposal[] = [...reply.withheld];
  const drafts: ProposalDraft[] = [];

  for (const draft of reply.proposals) {
    if (draft.kind !== "stage_workflow_patch") {
      drafts.push(draft);
      continue;
    }

    // The model proposes operations; the server builds the graph. Without the
    // flow row there is nothing honest to build from, so withhold rather than
    // stage a patch the console cannot apply.
    const parts = flow === null || flow === undefined ? null : parseFlowGraph(flow.graph);
    if (flow === null || flow === undefined || parts === null) {
      withheld.push({
        kind: draft.kind,
        reason:
          flow === null || flow === undefined
            ? "the stage_workflow_patch proposal is withheld because no flow was named in the console context"
            : "the stage_workflow_patch proposal is withheld because the stored graph could not be read",
      });
      continue;
    }

    const applied = applyFlowOps(parts, draft.payload.ops);
    if (!applied.ok) {
      withheld.push({ kind: draft.kind, reason: applied.reason });
      continue;
    }

    const payload: Record<string, unknown> = {
      flow_id: flow.id,
      ops: draft.payload.ops,
      patch: applied.graph,
    };

    let patchJson: string;
    try {
      patchJson = JSON.stringify(applied.graph);
    } catch {
      withheld.push({
        kind: draft.kind,
        reason: "the stage_workflow_patch proposal is withheld because its patch is not serialisable",
      });
      continue;
    }
    if (patchJson.length > MAX_PATCH_JSON_CHARS) {
      withheld.push({
        kind: draft.kind,
        reason: `the stage_workflow_patch proposal was dropped because its patch is ${patchJson.length} characters, over the ${MAX_PATCH_JSON_CHARS}-character limit`,
      });
      continue;
    }

    let payloadJson: string;
    try {
      payloadJson = JSON.stringify(payload);
    } catch {
      withheld.push({
        kind: draft.kind,
        reason: "the stage_workflow_patch proposal is withheld because its payload is not serialisable",
      });
      continue;
    }
    if (payloadJson.length > MAX_PAYLOAD_JSON_CHARS) {
      withheld.push({
        kind: draft.kind,
        reason: `the stage_workflow_patch proposal was dropped because its payload is ${payloadJson.length} characters, over the ${MAX_PAYLOAD_JSON_CHARS}-character limit`,
      });
      continue;
    }

    drafts.push({ ...draft, payload });
  }

  const proposals = await persistProposals(env, actor, drafts);

  logAssistant("chat", {
    provider: result.provider,
    tokens,
    proposals: proposals.length,
    took_ms: Date.now() - started,
  });

  return Response.json({ answer: reply.answer, proposals, withheld });
}

/* ─────────────────────────── 4. accept proposal ─────────────────────────── */

interface ProposalRow {
  id: string;
  kind: string;
  payload_json: string;
  created_by: string;
  expires_at: number;
  consumed_at: number | null;
}

type AcceptOutcome =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; response: Response };

/**
 * `create_rule` — the only kind that writes in this pass.
 *
 * Validation order matters: the model-authored regex is refused FIRST, because
 * a field matcher and a regex matcher reach the same rule engine but only one
 * has a linter, and a model should not be authoring the one without one.
 *
 * The write itself is `handleRulesPost`, unchanged. That is what makes the
 * accept path indistinguishable from the rules editor: same allowlists, same
 * RE2 lint, same compile check, same id generation, same audit row.
 */
async function acceptCreateRule(
  env: Env,
  actor: AdminActor,
  payload: Record<string, unknown>
): Promise<AcceptOutcome> {
  const matcher = asObject(payload.matcher);
  const bodyMatcher = asObject(payload.body_matcher);

  const matcherType = String(
    matcher !== null && typeof matcher.type === "string"
      ? matcher.type
      : payload.matcher_type ?? ""
  );
  const bodyType = String(
    bodyMatcher !== null && typeof bodyMatcher.type === "string"
      ? bodyMatcher.type
      : payload.body_type ?? ""
  );

  if (matcherType === "regex" || bodyType === "regex") {
    return {
      ok: false,
      response: badRequest(
        "a model may not author a regex matcher; use exact, prefix, suffix or glob for the field matcher and keyword for the body matcher"
      ),
    };
  }
  if (!["exact", "prefix", "suffix", "glob"].includes(matcherType)) {
    return {
      ok: false,
      response: badRequest(
        "matcher.type must be one of exact, prefix, suffix or glob"
      ),
    };
  }
  if (bodyType !== "keyword") {
    return {
      ok: false,
      response: badRequest("body_matcher.type must be keyword"),
    };
  }

  const matcherValue = String(
    matcher !== null && matcher.value !== undefined ? matcher.value : payload.matcher_value ?? ""
  );
  const bodyValue = String(
    bodyMatcher !== null && bodyMatcher.value !== undefined
      ? bodyMatcher.value
      : payload.body_value ?? ""
  );

  // The shape `handleRulesPost` accepts, with the two fields a model may not set
  // forced here: a rule an assistant creates never replies to shortcodes and is
  // never scoped to a device.
  const forwarded: Record<string, unknown> = {
    matcher: { type: matcherType, value: matcherValue },
    body_matcher: { type: "keyword", value: bodyValue },
    reply_template:
      typeof payload.reply_template === "string" ? payload.reply_template : "",
    enabled: payload.enabled === undefined ? true : Boolean(payload.enabled),
    allow_shortcode: false,
    allow_shortcode_reply: false,
    device_id: null,
  };
  if (typeof payload.name === "string" && payload.name.trim() !== "") {
    forwarded.name = payload.name.trim();
  }
  if (payload.priority !== undefined) forwarded.priority = payload.priority;
  if (payload.cooldown_s !== undefined || payload.cooldown_seconds !== undefined) {
    forwarded.cooldown_s = payload.cooldown_seconds ?? payload.cooldown_s;
  }
  if (payload.max_per_hour !== undefined || payload.max_replies_per_hour !== undefined) {
    forwarded.max_per_hour = payload.max_replies_per_hour ?? payload.max_per_hour;
  }

  const request = new Request("https://assistant.invalid/v1/rules", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(forwarded),
  });

  const response = await handleRulesPost(request, env, actor);
  const text = await response.text();
  let body: Record<string, unknown> | null = null;
  try {
    body = asObject(JSON.parse(text));
  } catch {
    body = null;
  }

  if (!response.ok) {
    // Pass the rules route's own refusal through untouched: `rule_rejected`
    // already explains the linter/compile failure better than this route could.
    return {
      ok: false,
      response: new Response(text, {
        status: response.status,
        headers: { "Content-Type": "application/json" },
      }),
    };
  }

  const ruleId = body !== null && typeof body.id === "string" ? body.id : null;
  return { ok: true, body: { kind: "create_rule", result: { rule_id: ruleId } } };
}

/** `create_template` — writes nothing; returns a validated draft. */
function acceptCreateTemplate(payload: Record<string, unknown>): AcceptOutcome {
  const body = typeof payload.body === "string" ? payload.body.trim() : "";
  if (body === "") {
    return { ok: false, response: badRequest("template payload needs a non-empty body") };
  }
  if (body.length > 1_000) {
    return { ok: false, response: badRequest("template body must be at most 1000 characters") };
  }
  const name =
    typeof payload.name === "string" && payload.name.trim() !== ""
      ? payload.name.trim().slice(0, MAX_TITLE_CHARS)
      : "assistant-template";

  return { ok: true, body: { kind: "create_template", result: { name, body } } };
}

/** `stage_workflow_patch` — writes nothing; returns the patch for ghost staging. */
function acceptStageWorkflowPatch(payload: Record<string, unknown>): AcceptOutcome {
  const candidate = asObject(payload.patch) ?? payload;
  let serialized: string;
  try {
    serialized = JSON.stringify(candidate);
  } catch {
    return { ok: false, response: badRequest("patch is not serialisable") };
  }
  if (serialized.length > MAX_PATCH_JSON_CHARS) {
    return { ok: false, response: badRequest("patch is too large") };
  }
  if (serialized === "{}") {
    return { ok: false, response: badRequest("patch is empty") };
  }

  const rawFlowId = payload.flow_id ?? payload.flowId;
  const flowId = typeof rawFlowId === "string" && rawFlowId.trim() !== "" ? rawFlowId.trim() : null;

  return {
    ok: true,
    body: {
      kind: "stage_workflow_patch",
      result: { staged: true, flow_id: flowId },
      patch: candidate,
    },
  };
}

/**
 * `POST /v1/admin/assistant/proposals/:id/accept`
 *
 * Reads only an unconsumed, unexpired row. Marks it consumed ONLY after the
 * kind's work succeeded: a refusal (bad payload, rule linter, storage error)
 * leaves the proposal usable, so the operator can fix the draft and retry
 * rather than being handed a dead id.
 */
export async function handleAssistantProposalAccept(
  env: Env,
  proposalId: string,
  actor: AdminActor
): Promise<Response> {
  if (!/^ap_[A-Za-z0-9_-]{8,64}$/.test(proposalId)) {
    return Response.json(
      { error: "not_found", message: "proposal is unknown, expired or already accepted" },
      { status: 404 }
    );
  }

  const row = await env.DB.prepare(
    `SELECT id, kind, payload_json, created_by, expires_at, consumed_at
       FROM assistant_proposals WHERE id = ? LIMIT 1`
  )
    .bind(proposalId)
    .first<ProposalRow>();

  const now = Date.now();
  if (
    row === null ||
    row === undefined ||
    row.consumed_at !== null ||
    row.expires_at <= now
  ) {
    return Response.json(
      { error: "not_found", message: "proposal is unknown, expired or already accepted" },
      { status: 404 }
    );
  }

  let payload: Record<string, unknown> | null = null;
  try {
    payload = asObject(JSON.parse(row.payload_json));
  } catch {
    payload = null;
  }
  if (payload === null) {
    return Response.json(
      { error: "not_found", message: "the stored proposal payload is unreadable" },
      { status: 409 }
    );
  }

  let outcome: AcceptOutcome;
  switch (row.kind) {
    case "create_rule":
      outcome = await acceptCreateRule(env, actor, payload);
      break;
    case "create_template":
      outcome = acceptCreateTemplate(payload);
      break;
    case "stage_workflow_patch":
      outcome = acceptStageWorkflowPatch(payload);
      break;
    default:
      // A row with an unknown kind was not written by this Worker.
      return Response.json(
        { error: "not_found", message: `unknown proposal kind "${row.kind}"` },
        { status: 409 }
      );
  }

  if (!outcome.ok) return outcome.response;

  await env.DB.prepare(
    `UPDATE assistant_proposals SET consumed_at = ?
       WHERE id = ? AND consumed_at IS NULL`
  )
    .bind(now, proposalId)
    .run();

  logAssistant("accept", { kind: row.kind, proposal: proposalId.slice(0, 12) });

  return Response.json(outcome.body);
}
