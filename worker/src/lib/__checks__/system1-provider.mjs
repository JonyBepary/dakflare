#!/usr/bin/env node
/**
 * System One provider checks — one settings row, two backends, two key roles.
 *
 * `system1.ts` imports nothing at runtime, but the settings and key helpers it
 * is fed from do, so the resolver hook below lets plain
 * `--experimental-strip-types` follow their extensionless imports.
 *
 * What is asserted, in the order a request meets it:
 *
 *   - `readSettings` with no row    -> env defaults; TOKENLAB_* apply
 *   - a row beats those env defaults
 *   - NULL system1 columns          -> chat model / chat base
 *   - a stored base URL             -> validated on read, both columns
 *   - a D1 fault                    -> env defaults, not a 500
 *   - key chains                    -> chat and System One resolve separately
 *   - the alias vs the wire model   -> `aliasFor`, never a stored-string lookup
 *   - workers-ai path               -> AI binding, alias table, never fetch
 *   - openai-compatible path        -> POST {base}/systemone, row's wire model
 *   - no key / no base              -> provider_unavailable, no fetch
 *   - 401 / 429 / malformed / timeout -> the same mapping as before
 *   - thresholds                    -> ONE set, never indexed by a string
 *   - `jev` / `jem`                 -> invalid model, not silently answered
 *
 * Run: node --experimental-strip-types src/lib/__checks__/system1-provider.mjs
 */

import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
registerHooks({
	resolve(specifier, context, nextResolve) {
		if ((specifier.startsWith("./") || specifier.startsWith("../")) && path.extname(specifier) === "") {
			const base = context.parentURL ? path.dirname(fileURLToPath(context.parentURL)) : HERE;
			for (const suffix of [".ts", "/index.ts"]) {
				const candidate = path.resolve(base, specifier + suffix);
				if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true };
			}
		}
		return nextResolve(specifier, context);
	}
});

const {
  ask,
  aliasFor,
  system1Config,
  openAiSystem1Config,
  isSystem1Model,
  SYSTEM1_MODELS,
  SYSTEM1_THRESHOLDS,
  SYSTEM1_SYSTEMONE_PATH,
  SYSTEM1_REMOTE_TIMEOUT_MS,
} = await import("../system1.ts");
const { readSettings, readSettingsOrEnv, envSettings } = await import("../ai/settings.ts");
const { providerKey, providerKeys } = await import("../ai/registry.ts");

let passed = 0;
const failures = [];

function check(label, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ok  ${label}`);
  } else {
    failures.push(`${label}${detail === "" ? "" : ` — ${detail}`}`);
    console.log(`FAIL  ${label}${detail === "" ? "" : ` — ${detail}`}`);
  }
}

{
  // A bad TOKENLAB_BASE_URL blocks System One only. Writing it into
  // baseUrlError refused chat and /models for a decision-only mistake.
  const env = envSettings({
    AI_CHAT_PROVIDER: "openai-compatible",
    AI_CHAT_MODEL: "gpt-4o-mini",
    AI_CHAT_BASE_URL: "https://api.example.com/v1",
    TOKENLAB_BASE_URL: "http://not-loopback.example/v1"
  });
  check(
    "a bad System One env base leaves chat usable",
    env.baseUrlError === undefined && env.baseUrl === "https://api.example.com/v1",
    JSON.stringify({ chat: env.baseUrl, chatError: env.baseUrlError })
  );
  check(
    "a bad System One env base is reported on its own field",
    typeof env.system1BaseUrlError === "string" && /TOKENLAB_BASE_URL/.test(env.system1BaseUrlError),
    String(env.system1BaseUrlError)
  );
  check(
    "a bad System One env base yields no usable origin",
    env.system1BaseUrl === null,
    String(env.system1BaseUrl)
  );
}


/* ───────────────────────── a D1 stub, one row ───────────────────────── */

/** Enough of the D1 surface for `readSettings`: prepare().first(). */
function dbWith(row) {
  return {
    prepare() {
      return {
        async first() {
          if (row instanceof Error) throw row;
          return row ?? null;
        },
      };
    },
  };
}

function rowOf(overrides = {}) {
  return {
    provider: "openai-compatible",
    model: "chat-model",
    base_url: "https://chat.example/v1",
    system1_model: null,
    system1_base_url: null,
    ...overrides,
  };
}

const QUESTIONS = {
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
    instructions: "Does this ticket need a human today, before any automation handles it?",
  },
  severity: {
    type: "score",
    instructions: "How severe is the customer impact?",
    criteria: ["Low", "Medium", "High"],
  },
};

const STATE = {
  ticket: "Customer cannot log in after resetting the password; error 403 on every attempt.",
};

/** The verified live response shape, verbatim. */
const LIVE_RESPONSE = {
  answers: {
    team: {
      type: "choice",
      choice: "Accounts",
      confidence: 0.9757,
      probabilities: { Billing: 0.0055, Accounts: 0.9838, Networking: 0.0106 },
    },
    urgent: { type: "noul", noul: 0.9785 },
    severity: {
      type: "score",
      score: 1.8943,
      confidence: 0.8415,
      legend: { 0: "Low", 1: "Medium", 2: "High" },
      probabilities: { 0: 0.0202, 1: 0.0652, 2: 0.9145 },
    },
  },
  usage: { input_tokens: 332, output_tokens: 0 },
  model: "Clef",
};

/** Run `fn` with `fetch` replaced, then restore it. */
async function withFetch(stub, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** The row's resolved System One config, as a route builds it. */
const OPENAI_SETTINGS = {
  provider: "openai-compatible",
  model: "chat-model",
  baseUrl: "https://api.example/v1",
  system1Model: "Clef-Max",
  system1BaseUrl: null,
};

const openAiConfig = system1Config(OPENAI_SETTINGS, "pk-test");

async function main() {
  console.log("system one providers");

  /* ── settings: no row is the env defaults ──────────────────────────── */
  const noRow = await readSettings({
    DB: dbWith(null),
    AI_CHAT_PROVIDER: "openai-compatible",
    AI_CHAT_MODEL: "env-chat",
    AI_CHAT_BASE_URL: "https://env.example/v1",
    TOKENLAB_BASE_URL: "https://tokenlab.example/v1/",
    TOKENLAB_SYSTEM1_MODEL: "EnvModel",
  });
  check("no row: chat comes from env", noRow.model === "env-chat" && noRow.baseUrl === "https://env.example/v1");
  check(
    "no row: System One takes the TOKENLAB_* defaults",
    noRow.system1Model === "EnvModel" && noRow.system1BaseUrl === "https://tokenlab.example/v1",
    JSON.stringify({ model: noRow.system1Model, base: noRow.system1BaseUrl })
  );

  const noRowNoTokenlab = await readSettings({
    DB: dbWith(null),
    AI_CHAT_PROVIDER: "openai-compatible",
    AI_CHAT_MODEL: "env-chat",
    AI_CHAT_BASE_URL: "https://env.example/v1",
  });
  check(
    "no row: without TOKENLAB_* System One takes the provider's decision model",
    noRowNoTokenlab.system1Model === "Clef" &&
      noRowNoTokenlab.system1BaseUrl === "https://env.example/v1",
    JSON.stringify({ model: noRowNoTokenlab.system1Model, base: noRowNoTokenlab.system1BaseUrl })
  );
  check(
    "the chat model is never inherited as the decision model",
    noRowNoTokenlab.system1Model !== "env-chat",
    noRowNoTokenlab.system1Model
  );

  /* ── settings: the row wins ────────────────────────────────────────── */
  const rowWins = await readSettings({
    DB: dbWith(
      rowOf({ system1_model: "RowModel", system1_base_url: "https://row.example/v1" })
    ),
    TOKENLAB_BASE_URL: "https://tokenlab.example/v1",
    TOKENLAB_SYSTEM1_MODEL: "EnvModel",
  });
  check(
    "row beats the env defaults",
    rowWins.system1Model === "RowModel" && rowWins.system1BaseUrl === "https://row.example/v1",
    JSON.stringify({ model: rowWins.system1Model, base: rowWins.system1BaseUrl })
  );

  /* ── settings: NULL base inherits chat; NULL model is the decision default ── */
  const nullColumns = await readSettings({
    DB: dbWith(rowOf()),
    TOKENLAB_BASE_URL: "https://tokenlab.example/v1",
    TOKENLAB_SYSTEM1_MODEL: "EnvModel",
  });
  check(
    "NULL system1 columns: base inherits chat, model is the decision default",
    nullColumns.system1Model === "Clef" &&
      nullColumns.system1BaseUrl === "https://chat.example/v1",
    JSON.stringify({ model: nullColumns.system1Model, base: nullColumns.system1BaseUrl })
  );

  const workersRow = await readSettings({
    DB: dbWith(rowOf({ provider: "workers-ai", base_url: null, system1_base_url: "https://stale.example" })),
  });
  check(
    "a workers-ai row exposes no System One base, even with a stale column",
    workersRow.baseUrl === null && workersRow.system1BaseUrl === null,
    JSON.stringify({ base: workersRow.baseUrl, system1Base: workersRow.system1BaseUrl })
  );

  /* ── settings: stored base URLs are validated on read ─────────────── */
  const plainHttpChat = await readSettings({
    DB: dbWith(rowOf({ base_url: "http://not-loopback.example/v1" })),
  });
  check(
    "a hand-edited plain-http chat base reads as no base + error",
    plainHttpChat.baseUrl === null &&
      typeof plainHttpChat.baseUrlError === "string" &&
      plainHttpChat.baseUrlError.includes("https"),
    JSON.stringify({ base: plainHttpChat.baseUrl, error: plainHttpChat.baseUrlError })
  );

  const plainHttpSystem1 = await readSettings({
    DB: dbWith(rowOf({ system1_base_url: "http://not-loopback.example/v1" })),
  });
  check(
    "a hand-edited plain-http system1 base is refused, not used",
    plainHttpSystem1.system1BaseUrl === null &&
      typeof plainHttpSystem1.system1BaseUrlError === "string" &&
      plainHttpSystem1.system1BaseUrlError.includes("https"),
    JSON.stringify({
      base: plainHttpSystem1.system1BaseUrl,
      error: plainHttpSystem1.system1BaseUrlError,
    })
  );
  check(
    "a bad System One base does not disable the chat base",
    plainHttpSystem1.baseUrl === "https://chat.example/v1",
    String(plainHttpSystem1.baseUrl)
  );
  check(
    "a plain-http system1 base never reaches openAiSystem1Config",
    openAiSystem1Config(
      system1Config({ ...plainHttpSystem1, system1Model: "Clef" }, "k")
    ) === null
  );

  const loopback = await readSettings({
    DB: dbWith(rowOf({ system1_base_url: "http://127.0.0.1:8080/v1/" })),
  });
  check(
    "loopback http is still allowed on read",
    loopback.system1BaseUrl === "http://127.0.0.1:8080/v1" &&
      loopback.system1BaseUrlError === undefined,
    String(loopback.system1BaseUrl)
  );

  /* ── settings: a D1 fault degrades, not 500 ───────────────────────── */
  const degraded = await readSettingsOrEnv({
    DB: dbWith(new Error("D1_ERROR: storage unavailable")),
    AI_CHAT_PROVIDER: "openai-compatible",
    AI_CHAT_MODEL: "env-chat",
    AI_CHAT_BASE_URL: "https://env.example/v1",
  });
  check(
    "a failing settings read falls back to env defaults",
    degraded.model === "env-chat" &&
      degraded.baseUrl === "https://env.example/v1" &&
      degraded.provider === "openai-compatible",
    JSON.stringify({ model: degraded.model, base: degraded.baseUrl })
  );
  const healthy = await readSettingsOrEnv({ DB: dbWith(rowOf({ model: "row-chat" })) });
  check("a healthy read still returns the row", healthy.model === "row-chat", String(healthy.model));

  /* ── keys: per role, never one chain ──────────────────────────────── */
  const allKeys = {
    AI_PROVIDER_API_KEY: "a",
    AI_CHAT_API_KEY: "b",
    TOKENLAB_API_KEY: "c",
  };
  const both = providerKeys(allKeys);
  check(
    "canonical key answers both roles",
    both.chat.source === "AI_PROVIDER_API_KEY" && both.system1.source === "AI_PROVIDER_API_KEY"
  );

  const split = providerKeys({ AI_CHAT_API_KEY: "b", TOKENLAB_API_KEY: "c" });
  check(
    "legacy chat key answers chat only",
    split.chat.key === "b" && split.chat.source === "AI_CHAT_API_KEY" && split.system1.key === "c",
    JSON.stringify({ chat: split.chat.source, system1: split.system1.source })
  );
  check(
    "the chat key never answers System One",
    providerKey({ AI_CHAT_API_KEY: "b" }, "system1").key === null &&
      providerKey({ AI_CHAT_API_KEY: "b" }, "system1").source === "none"
  );
  check(
    "the Token Lab key never answers chat",
    providerKey({ TOKENLAB_API_KEY: "c" }, "chat").key === null &&
      providerKey({ TOKENLAB_API_KEY: "c" }, "chat").source === "none"
  );
  check(
    "blank values are skipped, not treated as a key",
    providerKey({ AI_PROVIDER_API_KEY: "  ", TOKENLAB_API_KEY: "c" }, "system1").source === "TOKENLAB_API_KEY"
  );
  check(
    "no key -> null and source none for both roles",
    providerKeys({}).chat.source === "none" && providerKeys({}).system1.source === "none"
  );

  /* ── alias vs wire model ──────────────────────────────────────────── */
  check("a stored 'Clef' maps to the clef alias", aliasFor("Clef") === "clef");
  check("a stored alias maps to itself", aliasFor("clef-omni") === "clef-omni");
  check("case is ignored", aliasFor(" CLEF-FLASH ") === "clef-flash");
  check("an unrelated wire model maps to clef", aliasFor("gpt-4o-mini") === "clef");
  check("null maps to clef", aliasFor(null) === "clef");

  /* ── workers-ai path ──────────────────────────────────────────────── */
  let aiModel = null;
  const aiResult = await withFetch(
    async () => {
      throw new Error("workers-ai must not call fetch");
    },
    () =>
      ask(
        {
          provider: "workers-ai",
          model: "clef",
          baseUrl: null,
          apiKey: null,
          ai: {
            async run(model) {
              aiModel = model;
              return {
                answers: {
                  team: { type: "choice", choice: "Accounts", probabilities: { Accounts: 0.9 }, confidence: 0.9 },
                },
              };
            },
          },
        },
        STATE,
        QUESTIONS,
        "clef"
      )
  );
  check(
    "workers-ai -> AI binding with the alias table",
    aiResult.ok === true && aiResult.provider === "workers-ai" && aiModel === "@cf/cloudflare/clef",
    JSON.stringify({ provider: aiResult.provider, model: aiModel })
  );

  const noBinding = await ask(
    { provider: "workers-ai", model: "clef", baseUrl: null, apiKey: null },
    STATE,
    QUESTIONS,
    "clef"
  );
  check(
    "workers-ai without a binding -> no_ai_binding",
    noBinding.ok === false && noBinding.reason === "no_ai_binding",
    JSON.stringify(noBinding)
  );

  /* ── openai-compatible path ───────────────────────────────────────── */
  let seen = null;
  const remoteResult = await withFetch(
    async (url, init) => {
      seen = { url, init };
      return jsonResponse(LIVE_RESPONSE);
    },
    () => ask(openAiConfig, STATE, QUESTIONS, "clef-flash")
  );

  check("200 -> ok", remoteResult.ok === true, JSON.stringify(remoteResult));
  check('provider is "openai-compatible"', remoteResult.provider === "openai-compatible");
  check(
    "requested alias is echoed (local label, not the wire name)",
    remoteResult.model === "clef-flash",
    String(remoteResult.model)
  );
  check("usage passed through", remoteResult.usage?.input_tokens === 332);
  check(
    "choice answer normalised with probabilities",
    remoteResult.answers.team?.choice === "Accounts" &&
      remoteResult.answers.team?.probability === 0.9838 &&
      remoteResult.answers.team?.confidence === 0.9757,
    JSON.stringify(remoteResult.answers.team)
  );
  check(
    "score answer normalised with a legend object",
    remoteResult.answers.severity?.score === 1.8943 &&
      JSON.stringify(remoteResult.answers.severity?.legend) === JSON.stringify(["Low", "Medium", "High"])
  );

  check(
    "request goes to {base}/systemone",
    seen?.url === `https://api.example/v1${SYSTEM1_SYSTEMONE_PATH}`,
    String(seen?.url)
  );
  check("request is POST", seen?.init?.method === "POST");
  check("bearer auth uses the System One key", seen?.init?.headers?.authorization === "Bearer pk-test");
  check("json content type", seen?.init?.headers?.["content-type"] === "application/json");
  check("5 s abort signal passed", seen?.init?.signal instanceof AbortSignal);
  check("timeout is 5 s", SYSTEM1_REMOTE_TIMEOUT_MS === 5000);

  const sent = JSON.parse(String(seen?.init?.body));
  check("body model is the configured System One model", sent.model === "Clef-Max", String(sent.model));
  check("body state is the caller state", sent.state?.ticket === STATE.ticket);
  check("body questions use snake_case criteria", "billing" in (sent.questions?.team?.criteria ?? {}));
  check("choice criteria gained `other`", "other" in (sent.questions?.team?.criteria ?? {}));
  check("caller questions not mutated", QUESTIONS.team.criteria.other === undefined);

  // A stored wire name is sent as stored, whichever alias the caller names.
  let wireSeen = null;
  await withFetch(
    async (url, init) => {
      wireSeen = JSON.parse(String(init.body)).model;
      return jsonResponse(LIVE_RESPONSE);
    },
    () =>
      ask(
        system1Config(
          { ...OPENAI_SETTINGS, system1Model: "Clef", system1BaseUrl: "https://system1.example/v1" },
          "k"
        ),
        STATE,
        QUESTIONS,
        "clef"
      )
  );
  check("a stored 'Clef' is sent unchanged", wireSeen === "Clef", String(wireSeen));

  // The per-request System One base overrides the chat base.
  let overrideUrl = null;
  await withFetch(
    async (url) => {
      overrideUrl = url;
      return jsonResponse(LIVE_RESPONSE);
    },
    () =>
      ask(
        system1Config({ ...OPENAI_SETTINGS, system1BaseUrl: "https://system1.example/v1" }, "k"),
        STATE,
        QUESTIONS,
        "clef"
      )
  );
  check(
    "system1BaseUrl wins over the chat base",
    overrideUrl === "https://system1.example/v1/systemone",
    String(overrideUrl)
  );

  check(
    "no duplicate /v1 in the path",
    openAiSystem1Config(
      system1Config({ ...OPENAI_SETTINGS, baseUrl: "https://api.example/v1", system1BaseUrl: null }, "k")
    )?.baseUrl === "https://api.example/v1"
  );

  /* ── no key / no base -> unavailable, no fetch ────────────────────── */
  let called = false;
  const noKey = await withFetch(
    async () => {
      called = true;
      return jsonResponse(LIVE_RESPONSE);
    },
    () => ask(system1Config(OPENAI_SETTINGS, null), STATE, QUESTIONS, "clef")
  );
  check(
    "no key -> provider_unavailable",
    noKey.ok === false && noKey.reason === "provider_unavailable" && noKey.provider === "openai-compatible",
    JSON.stringify(noKey)
  );
  check("no key does not call fetch", called === false);

  const noBase = await withFetch(
    async () => {
      called = true;
      return jsonResponse(LIVE_RESPONSE);
    },
    () => ask(system1Config({ ...OPENAI_SETTINGS, system1BaseUrl: null, baseUrl: null }, "k"), STATE, QUESTIONS, "clef")
  );
  check("no base (even with a key) -> provider_unavailable", noBase.ok === false);
  check("no base does not call fetch", called === false);
  check("openAiSystem1Config with no base is null", openAiSystem1Config(system1Config(OPENAI_SETTINGS, "k")) !== null);

  /* ── 401 / 429 / malformed / timeout ─────────────────────────────── */
  const unauthorized = await withFetch(
    async () => jsonResponse({ error: "invalid token" }, 401),
    () => ask(openAiConfig, STATE, QUESTIONS, "clef")
  );
  check(
    "401 -> provider_unavailable",
    unauthorized.ok === false &&
      unauthorized.reason === "provider_unavailable" &&
      unauthorized.provider === "openai-compatible",
    JSON.stringify(unauthorized)
  );

  const limited = await withFetch(
    async () => jsonResponse({ error: "slow down" }, 429, { "retry-after": "12" }),
    () => ask(openAiConfig, STATE, QUESTIONS, "clef")
  );
  check("429 -> provider_unavailable", limited.ok === false && limited.reason === "provider_unavailable");
  check("429 -> retry-after preserved", limited.retryAfter === "12", String(limited.retryAfter));

  for (const [label, body] of [
    ["not json", "<html>nope</html>"],
    ["no answers key", { result: "ok" }],
    ["answers is an array", { answers: [] }],
    ["answers all unknown types", { answers: { team: { type: "banana" } } }],
  ]) {
    const malformed = await withFetch(
      async () => jsonResponse(body),
      () => ask(openAiConfig, STATE, QUESTIONS, "clef")
    );
    check(
      `${label} -> unparseable`,
      malformed.ok === false && malformed.reason === "unparseable",
      JSON.stringify(malformed)
    );
  }

  const realTimeout = AbortSignal.timeout;
  let hungFetchCalled = false;
  Object.defineProperty(AbortSignal, "timeout", {
    configurable: true,
    writable: true,
    value: () => AbortSignal.abort(),
  });
  try {
    const hung = await withFetch(
      () => {
        hungFetchCalled = true;
        return new Promise(() => {});
      },
      () => ask(openAiConfig, STATE, QUESTIONS, "clef")
    );
    check(
      "timeout -> provider_unavailable",
      hung.ok === false && hung.reason === "provider_unavailable" && hung.provider === "openai-compatible",
      JSON.stringify(hung)
    );
    check("timeout path did reach fetch", hungFetchCalled === true);
  } finally {
    Object.defineProperty(AbortSignal, "timeout", {
      configurable: true,
      writable: true,
      value: realTimeout,
    });
  }

  /* ── thresholds: one set, no string indexing ──────────────────────── */
  check(
    "one threshold set, the strictest of the old ones",
    SYSTEM1_THRESHOLDS.autoRouteMinConfidence === 0.9 &&
      SYSTEM1_THRESHOLDS.injectionNoulBlock === 0.7,
    JSON.stringify(SYSTEM1_THRESHOLDS)
  );
  check(
    "thresholds are not a per-model table",
    SYSTEM1_THRESHOLDS["clef"] === undefined && SYSTEM1_THRESHOLDS["clef-flash"] === undefined
  );

  /* ── the retired aliases ─────────────────────────────────────────── */
  check(
    "SYSTEM1_MODELS is exactly the three clef aliases",
    JSON.stringify(Object.keys(SYSTEM1_MODELS).sort()) ===
      JSON.stringify(["clef", "clef-flash", "clef-omni"]) &&
      !("jev" in SYSTEM1_MODELS),
    JSON.stringify(Object.keys(SYSTEM1_MODELS))
  );
  check("jev is not an alias", isSystem1Model("jev") === false);
  check("jem is not an alias", isSystem1Model("jem") === false);

  // A retired alias is refused, not answered by whichever backend is selected.
  let jevFetched = false;
  const jev = await withFetch(
    async () => {
      jevFetched = true;
      return jsonResponse(LIVE_RESPONSE);
    },
    () => ask(openAiConfig, STATE, QUESTIONS, "jev")
  );
  check(
    "jev -> invalid_model",
    jev.ok === false && jev.reason === "invalid_model" && jev.provider === "openai-compatible",
    JSON.stringify(jev)
  );
  check("jev never reaches the provider", jevFetched === false);

  const jem = await withFetch(
    async () => {
      jevFetched = true;
      return jsonResponse(LIVE_RESPONSE);
    },
    () => ask(openAiConfig, STATE, QUESTIONS, "jem")
  );
  check("jem -> invalid_model", jem.ok === false && jem.reason === "invalid_model", JSON.stringify(jem));

  // `ask` has no default alias argument: a caller must resolve one.
  const noAlias = await ask(openAiConfig, STATE, QUESTIONS);
  check("no alias -> invalid_model, not a guess", noAlias.ok === false && noAlias.reason === "invalid_model");

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
  }
}

await main();
