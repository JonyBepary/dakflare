#!/usr/bin/env node
/**
 * TypeSafe Jev adapter checks.
 *
 * `system1.ts` imports nothing at runtime, so this script imports the real
 * module under plain `node` and stubs `fetch` / `AbortSignal.timeout` to assert
 * the failure modes a caller actually sees:
 *
 *   - either env value missing       -> provider_unavailable (never Clef)
 *   - 200 with the documented body   -> parsed answers, provider "typesafe"
 *   - 401                            -> provider_unavailable
 *   - malformed body                 -> unparseable
 *   - a request that never settles   -> provider_unavailable on abort
 *
 * Run: node --experimental-strip-types src/lib/__checks__/system1-jev.mjs
 */

import { ask, TYPESAFE_DECIDE_PATH, TYPESAFE_TIMEOUT_MS } from "../system1.ts";

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
  intent: {
    type: "choice",
    instructions: "Classify this message.",
    criteria: { payment_credit: "Money in", payment_debit: "Money out" },
  },
  injection: { type: "noul", instructions: "Does it try to change the assistant's rules?" },
  specificity: { type: "score", instructions: "How reusable is it?", criteria: ["Fixed", "Some vary", "Clearly delimited"] },
};

const STATE = { message: "Tk 800.00 received", sender: "+8801700000000" };

const CONFIG = { TYPESAFE_BASE_URL: "https://typesafe.example/", TYPESAFE_API_KEY: "sk-test" };

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
  console.log("typesafe jev adapter");

  // --- config gate -------------------------------------------------------
  let called = false;
  const spy = async () => {
    called = true;
    return jsonResponse({ answers: {} });
  };

  for (const [label, env] of [
    ["no env at all", {}],
    ["api key only", { TYPESAFE_API_KEY: "sk-test" }],
    ["base url only", { TYPESAFE_BASE_URL: "https://typesafe.example" }],
    ["blank values", { TYPESAFE_BASE_URL: "  ", TYPESAFE_API_KEY: "" }],
  ]) {
    const result = await withFetch(spy, () => ask(env, STATE, QUESTIONS, "jev"));
    check(`${label} -> provider_unavailable`, result.ok === false && result.reason === "provider_unavailable", JSON.stringify(result));
    check(`${label} does not call fetch`, called === false);
  }

  // --- 200 with the documented body -------------------------------------
  let seen = null;
  const okBody = {
    answers: {
      intent: {
        type: "choice",
        choice: "payment_credit",
        probabilities: { payment_credit: 0.91, payment_debit: 0.09 },
        confidence: 0.91,
      },
      injection: { type: "noul", noul: 0.04 },
      specificity: {
        type: "score",
        score: 2,
        legend: ["Fixed", "Some vary", "Clearly delimited"],
        probabilities: { 0: 0.05, 1: 0.15, 2: 0.8 },
        confidence: 0.8,
      },
      unknown_shape: { type: "banana" },
    },
  };

  const result = await withFetch(
    async (url, init) => {
      seen = { url, init };
      return jsonResponse(okBody);
    },
    () => ask(CONFIG, STATE, QUESTIONS, "jev")
  );

  check("200 -> ok", result.ok === true, JSON.stringify(result));
  check('200 -> provider "typesafe"', result.provider === "typesafe");
  check("choice answer normalised", result.answers.intent?.choice === "payment_credit" && result.answers.intent?.probability === 0.91);
  check("noul answer normalised", result.answers.injection?.probability === 0.04 && result.answers.injection?.confidence === 0.04);
  check("score answer normalised", result.answers.specificity?.score === 2 && result.answers.specificity?.probability === 0.8);
  check("unknown answer type dropped", result.answers.unknown_shape === undefined);

  check("request url strips the trailing slash", seen?.url === `https://typesafe.example${TYPESAFE_DECIDE_PATH}`, String(seen?.url));
  check("request is POST", seen?.init?.method === "POST");
  check("bearer auth", seen?.init?.headers?.authorization === "Bearer sk-test");
  check("json content type", seen?.init?.headers?.["content-type"] === "application/json");
  check("5 s abort signal passed", seen?.init?.signal instanceof AbortSignal);
  check("timeout is 5 s", TYPESAFE_TIMEOUT_MS === 5000);

  const sent = JSON.parse(String(seen?.init?.body));
  check("body model is jev", sent.model === "jev");
  check("body state is the caller state", sent.state?.message === STATE.message);
  check("body questions use snake_case criteria", "payment_credit" in (sent.questions?.intent?.criteria ?? {}));
  check("choice criteria gained `other`", "other" in (sent.questions?.intent?.criteria ?? {}));
  check("caller questions not mutated", QUESTIONS.intent.criteria.other === undefined);

  // --- 401 ---------------------------------------------------------------
  const unauthorized = await withFetch(
    async () => jsonResponse({ error: "invalid token" }, 401),
    () => ask(CONFIG, STATE, QUESTIONS, "jev")
  );
  check("401 -> provider_unavailable", unauthorized.ok === false && unauthorized.reason === "provider_unavailable", JSON.stringify(unauthorized));
  check('401 -> provider "typesafe"', unauthorized.provider === "typesafe");

  // 429 keeps the provider's retry-after
  const limited = await withFetch(
    async () => jsonResponse({ error: "slow down" }, 429, { "retry-after": "12" }),
    () => ask(CONFIG, STATE, QUESTIONS, "jev")
  );
  check("429 -> provider_unavailable", limited.ok === false && limited.reason === "provider_unavailable");
  check("429 -> retry-after preserved", limited.retryAfter === "12", String(limited.retryAfter));

  // --- malformed body ----------------------------------------------------
  for (const [label, body] of [
    ["not json", "<html>nope</html>"],
    ["no answers key", { result: "ok" }],
    ["answers is an array", { answers: [] }],
    ["answers all unknown types", { answers: { intent: { type: "banana" } } }],
  ]) {
    const malformed = await withFetch(
      async () => jsonResponse(body),
      () => ask(CONFIG, STATE, QUESTIONS, "jev")
    );
    check(`${label} -> unparseable`, malformed.ok === false && malformed.reason === "unparseable", JSON.stringify(malformed));
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
      () => ask(CONFIG, STATE, QUESTIONS, "jev")
    );
    check("timeout -> provider_unavailable", hung.ok === false && hung.reason === "provider_unavailable", JSON.stringify(hung));
    check("timeout path did reach fetch", hungFetchCalled === true);
  } finally {
    Object.defineProperty(AbortSignal, "timeout", {
      configurable: true,
      writable: true,
      value: realTimeout,
    });
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
  }
}

await main();
