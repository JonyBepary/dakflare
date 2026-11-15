#!/usr/bin/env node
/**
 * Token Lab System 1 adapter checks.
 *
 * `system1.ts` imports nothing at runtime, so this script imports the real
 * module under plain `node` and stubs `fetch` / `AbortSignal.timeout` to assert
 * the failure modes a caller actually sees:
 *
 *   - 200 with the live response     -> parsed answers, provider "tokenlab"
 *   - configured model on the wire   -> body.model, not the local clef alias
 *   - missing key or base URL        -> provider_unavailable (never Workers AI)
 *   - 401                            -> provider_unavailable
 *   - 429                            -> retry-after preserved
 *   - malformed body                 -> unparseable
 *   - a request that never settles   -> provider_unavailable on abort
 *   - SYSTEM1_PROVIDER unset         -> Workers AI
 *   - jev with Token Lab selected    -> TypeSafe, not Token Lab
 *   - local thresholds               -> unchanged
 *
 * Run: node --experimental-strip-types src/lib/__checks__/system1-tokenlab.mjs
 */

import {
  ask,
  tokenlabConfig,
  SYSTEM1_THRESHOLDS,
  TYPESAFE_DECIDE_PATH,
  TOKENLAB_SYSTEMONE_PATH,
  TOKENLAB_TIMEOUT_MS,
} from "../system1.ts";

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

/** The verified live response, verbatim. */
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

const CONFIG = {
  SYSTEM1_PROVIDER: "tokenlab",
  TOKENLAB_BASE_URL: "https://api.tokenlab.example",
  TOKENLAB_API_KEY: "tl-test",
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

async function main() {
  console.log("tokenlab system one adapter");

  // --- config ------------------------------------------------------------
  const config = tokenlabConfig(CONFIG);
  check("config trims the trailing slash", config?.baseUrl === "https://api.tokenlab.example", JSON.stringify(config));
  check("config keeps the bearer key", config?.apiKey === "tl-test");
  check("config defaults the model to Clef", config?.model === "Clef", String(config?.model));

  const withModel = tokenlabConfig({ ...CONFIG, TOKENLAB_SYSTEM1_MODEL: "Clef-Omni", TOKENLAB_BASE_URL: "https://api.tokenlab.example/v1/" });
  check("config honours TOKENLAB_SYSTEM1_MODEL", withModel?.model === "Clef-Omni");
  check("config strips /v1/ to /v1", withModel?.baseUrl === "https://api.tokenlab.example/v1", String(withModel?.baseUrl));

  // --- 200 with the live body -------------------------------------------
  let seen = null;
  const result = await withFetch(
    async (url, init) => {
      seen = { url, init };
      return jsonResponse(LIVE_RESPONSE);
    },
    () => ask(CONFIG, STATE, QUESTIONS, "clef-flash")
  );

  check("200 -> ok", result.ok === true, JSON.stringify(result));
  check('provider is "tokenlab"', result.provider === "tokenlab", String(result.provider));
  check("requested alias is echoed (thresholds stay keyed by it)", result.model === "clef-flash", String(result.model));
  check("usage passed through", result.usage?.input_tokens === 332 && result.usage?.output_tokens === 0, JSON.stringify(result.usage));
  check(
    "choice answer normalised with probabilities",
    result.answers.team?.choice === "Accounts" &&
      result.answers.team?.probability === 0.9838 &&
      result.answers.team?.confidence === 0.9757 &&
      result.answers.team?.probabilities?.Billing === 0.0055,
    JSON.stringify(result.answers.team)
  );
  check(
    "noul answer normalised",
    result.answers.urgent?.type === "noul" && result.answers.urgent?.probability === 0.9785,
    JSON.stringify(result.answers.urgent)
  );
  check(
    "score answer normalised with legend",
    result.answers.severity?.score === 1.8943 &&
      result.answers.severity?.confidence === 0.8415 &&
      result.answers.severity?.probability === 0.9145 &&
      JSON.stringify(result.answers.severity?.legend) === JSON.stringify(["Low", "Medium", "High"]),
    JSON.stringify(result.answers.severity)
  );

  check(
    "request goes to {base}/v1/systemone",
    seen?.url === `https://api.tokenlab.example${TOKENLAB_SYSTEMONE_PATH}`,
    String(seen?.url)
  );
  check("request is POST", seen?.init?.method === "POST");
  check("bearer auth", seen?.init?.headers?.authorization === "Bearer tl-test");
  check("json content type", seen?.init?.headers?.["content-type"] === "application/json");
  check("5 s abort signal passed", seen?.init?.signal instanceof AbortSignal);
  check("timeout is 5 s", TOKENLAB_TIMEOUT_MS === 5000);

  const sent = JSON.parse(String(seen?.init?.body));
  check("body model is the configured model", sent.model === "Clef", String(sent.model));
  check("body state is the caller state", sent.state?.ticket === STATE.ticket);
  check("body questions use snake_case criteria", "billing" in (sent.questions?.team?.criteria ?? {}));
  check("choice criteria gained `other`", "other" in (sent.questions?.team?.criteria ?? {}));
  check("caller questions not mutated", QUESTIONS.team.criteria.other === undefined);

  // --- a base that already ends in /v1 is not doubled -------------------
  let v1Url = null;
  await withFetch(
    async (url) => {
      v1Url = url;
      return jsonResponse(LIVE_RESPONSE);
    },
    () => ask({ ...CONFIG, TOKENLAB_BASE_URL: "https://api.tokenlab.example/v1" }, STATE, QUESTIONS, "clef")
  );
  check(
    "/v1 base resolves to the same /v1/systemone",
    v1Url === "https://api.tokenlab.example/v1/systemone",
    String(v1Url)
  );

  // The documented default applies only when the provider is tokenlab.
  let defaultUrl = null;
  await withFetch(
    async (url) => {
      defaultUrl = url;
      return jsonResponse(LIVE_RESPONSE);
    },
    () => ask({ SYSTEM1_PROVIDER: "tokenlab", TOKENLAB_API_KEY: "tl-test" }, STATE, QUESTIONS, "clef")
  );
  check(
    "absent base defaults to the documented host",
    defaultUrl === `https://api.tokenlab.amd.com${TOKENLAB_SYSTEMONE_PATH}`,
    String(defaultUrl)
  );
  check(
    "a non-tokenlab provider gets no default base",
    tokenlabConfig({ SYSTEM1_PROVIDER: "workers-ai", TOKENLAB_API_KEY: "tl-test" }) === null
  );

  // --- every clef alias routes to Token Lab -----------------------------
  for (const alias of ["clef", "clef-flash", "clef-omni"]) {
    let aliasUrl = null;
    let aliasModel = null;
    const aliasResult = await withFetch(
      async (url, init) => {
        aliasUrl = url;
        aliasModel = JSON.parse(String(init.body)).model;
        return jsonResponse(LIVE_RESPONSE);
      },
      () => ask({ ...CONFIG, TOKENLAB_SYSTEM1_MODEL: "Clef-Max" }, STATE, QUESTIONS, alias)
    );
    check(
      `${alias} -> tokenlab with the configured model`,
      aliasResult.provider === "tokenlab" &&
        aliasResult.model === alias &&
        aliasUrl === `https://api.tokenlab.example${TOKENLAB_SYSTEMONE_PATH}` &&
        aliasModel === "Clef-Max",
      JSON.stringify({ provider: aliasResult.provider, model: aliasResult.model, url: aliasUrl, wire: aliasModel })
    );
  }

  // --- config gates ------------------------------------------------------
  // An absent base URL is not a gap when Token Lab is selected: the documented
  // default applies (asserted above). An explicitly empty or blank value IS a
  // gap, and so is a missing key.
  for (const [label, env] of [
    ["no tokenlab env", { SYSTEM1_PROVIDER: "tokenlab" }],
    [
      "base url only",
      { SYSTEM1_PROVIDER: "tokenlab", TOKENLAB_BASE_URL: "https://api.tokenlab.example" },
    ],
    [
      "explicitly empty base",
      { SYSTEM1_PROVIDER: "tokenlab", TOKENLAB_BASE_URL: "", TOKENLAB_API_KEY: "tl-test" },
    ],
    [
      "blank values",
      { SYSTEM1_PROVIDER: "tokenlab", TOKENLAB_BASE_URL: "   ", TOKENLAB_API_KEY: "  " },
    ],
  ]) {
    let called = false;
    const gated = await withFetch(
      async () => {
        called = true;
        return jsonResponse(LIVE_RESPONSE);
      },
      () => ask(env, STATE, QUESTIONS, "clef-flash")
    );
    check(
      `${label} -> provider_unavailable`,
      gated.ok === false && gated.reason === "provider_unavailable" && gated.provider === "tokenlab",
      JSON.stringify(gated)
    );
    check(`${label} does not call fetch`, called === false);
  }

  check("tokenlabConfig({}) is null", tokenlabConfig({}) === null);
  check(
    "tokenlabConfig with a key but no base is null",
    tokenlabConfig({ TOKENLAB_API_KEY: "tl-test" }) === null
  );

  // --- 401 ---------------------------------------------------------------
  const unauthorized = await withFetch(
    async () => jsonResponse({ error: "invalid token" }, 401),
    () => ask(CONFIG, STATE, QUESTIONS, "clef")
  );
  check(
    "401 -> provider_unavailable",
    unauthorized.ok === false &&
      unauthorized.reason === "provider_unavailable" &&
      unauthorized.provider === "tokenlab",
    JSON.stringify(unauthorized)
  );

  // --- 429 ---------------------------------------------------------------
  const limited = await withFetch(
    async () => jsonResponse({ error: "slow down" }, 429, { "retry-after": "12" }),
    () => ask(CONFIG, STATE, QUESTIONS, "clef")
  );
  check("429 -> provider_unavailable", limited.ok === false && limited.reason === "provider_unavailable");
  check("429 -> retry-after preserved", limited.retryAfter === "12", String(limited.retryAfter));

  // --- malformed body ----------------------------------------------------
  for (const [label, body] of [
    ["not json", "<html>nope</html>"],
    ["no answers key", { result: "ok" }],
    ["answers is an array", { answers: [] }],
    ["answers all unknown types", { answers: { team: { type: "banana" } } }],
  ]) {
    const malformed = await withFetch(
      async () => jsonResponse(body),
      () => ask(CONFIG, STATE, QUESTIONS, "clef")
    );
    check(
      `${label} -> unparseable`,
      malformed.ok === false && malformed.reason === "unparseable",
      JSON.stringify(malformed)
    );
  }

  // --- timeout -----------------------------------------------------------
  // fetch never settles; AbortSignal.timeout is stubbed to an already-aborted
  // signal so the 5 s wait is skipped without weakening the abort path.
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
      () => ask(CONFIG, STATE, QUESTIONS, "clef")
    );
    check(
      "timeout -> provider_unavailable",
      hung.ok === false && hung.reason === "provider_unavailable" && hung.provider === "tokenlab",
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

  // --- unset provider still uses Workers AI ------------------------------
  let aiModel = null;
  const aiResult = await withFetch(
    async () => {
      throw new Error("workers-ai must not call fetch");
    },
    () =>
      ask(
        {
          AI: {
            async run(model) {
              aiModel = model;
              return { answers: { team: { type: "choice", choice: "Accounts", probabilities: { Accounts: 0.9 }, confidence: 0.9 } } };
            },
          },
        },
        STATE,
        QUESTIONS,
        "clef"
      )
  );
  check(
    "SYSTEM1_PROVIDER unset -> Workers AI",
    aiResult.ok === true && aiResult.provider === "clef" && aiModel === "@cf/cloudflare/clef",
    JSON.stringify({ provider: aiResult.provider, model: aiModel })
  );

  // --- auto: Token Lab when its key is present, Workers AI otherwise -----
  let autoProvider = null;
  const autoResult = await withFetch(
    async () =>
      jsonResponse({
        answers: {
          team: { type: "choice", choice: "Accounts", probabilities: { Accounts: 0.9 }, confidence: 0.9 }
        }
      }),
    () =>
      ask(
        { TOKENLAB_BASE_URL: CONFIG.TOKENLAB_BASE_URL, TOKENLAB_API_KEY: "k" },
        STATE,
        QUESTIONS,
        "clef"
      )
  );
  autoProvider = autoResult.provider;
  check(
    "auto with a key uses Token Lab",
    autoResult.ok === true && autoProvider === "tokenlab",
    JSON.stringify({ provider: autoProvider })
  );

  // --- explicit workers-ai is never silently switched --------------------
  let forcedModel = null;
  const forced = await withFetch(
    async () => {
      throw new Error("workers-ai must not call fetch");
    },
    () =>
      ask(
        {
          SYSTEM1_PROVIDER: "workers-ai",
          TOKENLAB_BASE_URL: CONFIG.TOKENLAB_BASE_URL,
          TOKENLAB_API_KEY: "k",
          AI: {
            async run(model) {
              forcedModel = model;
              return { answers: { team: { type: "choice", choice: "Accounts", probabilities: { Accounts: 0.9 }, confidence: 0.9 } } };
            }
          }
        },
        STATE,
        QUESTIONS,
        "clef"
      )
  );
  check(
    "explicit workers-ai ignores a present Token Lab key",
    forced.ok === true && forced.provider === "clef" && forcedModel === "@cf/cloudflare/clef",
    JSON.stringify({ provider: forced.provider, model: forcedModel })
  );

  // --- jev always goes to TypeSafe --------------------------------------
  let jevSeen = null;
  const jev = await withFetch(
    async (url, init) => {
      jevSeen = { url, body: init.body };
      return jsonResponse({
        answers: { team: { type: "choice", choice: "Accounts", probabilities: { Accounts: 0.9 }, confidence: 0.9 } },
      });
    },
    () =>
      ask(
        {
          ...CONFIG,
          TYPESAFE_BASE_URL: "https://typesafe.example",
          TYPESAFE_API_KEY: "sk-test",
          TOKENLAB_SYSTEM1_MODEL: "Clef-Max",
        },
        STATE,
        QUESTIONS,
        "jev"
      )
  );
  check(
    "jev with tokenlab selected -> TypeSafe",
    jev.ok === true && jev.provider === "typesafe" && jev.model === "jev",
    JSON.stringify({ provider: jev.provider, model: jev.model })
  );
  check(
    "jev request goes to /v1/decide with model jev",
    jevSeen?.url === `https://typesafe.example${TYPESAFE_DECIDE_PATH}` &&
      JSON.parse(String(jevSeen?.body)).model === "jev",
    String(jevSeen?.url)
  );

  // --- local thresholds are untouched ------------------------------------
  check(
    "clef-flash thresholds unchanged",
    SYSTEM1_THRESHOLDS["clef-flash"].autoRouteMinConfidence === 0.9 &&
      SYSTEM1_THRESHOLDS["clef-flash"].tiebreakMinConfidence === 0.7 &&
      SYSTEM1_THRESHOLDS["clef-flash"].injectionNoulBlock === 0.7
  );
  check(
    "clef thresholds unchanged",
    SYSTEM1_THRESHOLDS.clef.autoRouteMinConfidence === 0.85 &&
      SYSTEM1_THRESHOLDS.clef.tiebreakMinConfidence === 0.65
  );
  check(
    "clef-omni thresholds unchanged",
    SYSTEM1_THRESHOLDS["clef-omni"].autoRouteMinConfidence === 0.85 &&
      SYSTEM1_THRESHOLDS["clef-omni"].tiebreakMinConfidence === 0.65
  );
  check(
    "jev thresholds unchanged",
    SYSTEM1_THRESHOLDS.jev.autoRouteMinConfidence === 0.8 &&
      SYSTEM1_THRESHOLDS.jev.tiebreakMinConfidence === 0.6
  );
  check(
    "every model still blocks injections at 0.7",
    Object.values(SYSTEM1_THRESHOLDS).every((entry) => entry.injectionNoulBlock === 0.7)
  );

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
  }
}

await main();
