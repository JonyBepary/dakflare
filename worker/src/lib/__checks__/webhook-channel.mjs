#!/usr/bin/env node
/**
 * Inbound webhook channel — policy checks.
 *
 * The real route module runs against an in-memory SQLite database loaded with
 * `migrations/0015_webhooks.sql`, and the agent turn is a recording stub. The
 * act gate is the real `authorizeActWithStore` over a permissive store, so the
 * refusal below is the production one, not a mock.
 *
 * Asserted:
 *   - a correctly signed body is accepted; a truncated, wrong-length, or
 *     otherwise wrong signature is 401;
 *   - the signature comparison is the constant-time helper, over the raw body;
 *   - a repeated x-dakflare-delivery returns the stored answer with
 *     `replayed: true` and runs no second turn;
 *   - a missing delivery id is 400, a disabled hook is 403, an oversized body
 *     is 413, and an exhausted per-hook limiter is 429;
 *   - the webhook actor is refused by `authorizeAct` with
 *     `webhook_cannot_act`, while a normal actor that does not own the window
 *     is refused with `autonomy_other_session`;
 *   - every admin response omits `secret_hash` and `secret_sealed`, while the
 *     database stores SHA-256(secret) and a sealed copy, never the clear value.
 *
 * Run: node --experimental-strip-types src/lib/__checks__/webhook-channel.mjs
 */

import { registerHooks } from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_ROOT = path.resolve(HERE, "../../..");

function resolveExtensionless(specifier, context, nextResolve) {
  if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    path.extname(specifier) === ""
  ) {
    const base = context.parentURL ? path.dirname(fileURLToPath(context.parentURL)) : HERE;
    for (const suffix of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
      const candidate = path.resolve(base, specifier + suffix);
      if (existsSync(candidate)) {
        return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
    }
  }
  return nextResolve(specifier, context, nextResolve);
}

registerHooks({ resolve: resolveExtensionless });

const {
  MAX_WEBHOOK_BODY_BYTES,
  handleWebhookCreate,
  handleWebhookDelete,
  handleWebhookDeliveries,
  handleWebhookIngress,
  handleWebhookList,
  timingSafeEqualHex,
  verifyWebhookSignature,
} = await import("../../routes/webhooks.ts");
const { authorizeActWithStore } = await import("../../agent/grants.ts");
const { scopeForAction } = await import("../agent-scopes.ts");

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

/* ── the real schema, in memory ───────────────────────────────────────── */

function makeD1() {
  const db = new DatabaseSync(":memory:");
  // The whole ledger in order: 0015 ALTERs the outbound `webhooks` table that
  // 0002 created, which is exactly the production shape.
  const migrations = path.join(WORKER_ROOT, "migrations");
  for (const file of readdirSync(migrations).filter((entry) => entry.endsWith(".sql")).sort()) {
    db.exec(readFileSync(path.join(migrations, file), "utf8"));
  }
  return {
    prepare(sql) {
      const statement = db.prepare(sql);
      const state = { args: [] };
      return {
        bind(...args) {
          state.args = args;
          return this;
        },
        async first() {
          return statement.get(...state.args) ?? null;
        },
        async all() {
          return { results: statement.all(...state.args) };
        },
        async run() {
          const result = statement.run(...state.args);
          return { meta: { changes: Number(result.changes) } };
        },
      };
    },
    raw: db,
  };
}

const human = {
  userId: "user_1",
  label: "owner@example.test",
  role: "owner",
  canGrantOwner: true,
};

const answers = [];
const env = {
  AGENT_RUNTIME: "on",
  DB: makeD1(),
  ADMIN_TOKEN: "check-secret",
  // Sealing uses its own key: a webhook secret must not be derivable from a
  // bearer credential, so the check supplies the real one.
  WEBHOOK_SECRET_KEY: "check-webhook-sealing-key",
  ADMIN_LIMITER: { limit: async () => ({ success: true }) },
  ASSISTANT: {
    getByName() {
      return {
        async say(actor, message) {
          answers.push({ actor, message });
          return {
            ok: true,
            answer: `answer to ${message}`,
            calls: [],
            tokens: null,
            took_ms: 1,
          };
        },
      };
    },
  },
};

function sign(secret, body) {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

function ingress(body, deliveryId, signature) {
  const headers = {
    "x-dakflare-signature": signature ?? `sha256=${sign(secret, body)}`,
  };
  if (deliveryId !== undefined) headers["x-dakflare-delivery"] = deliveryId;
  return new Request("https://worker.test/v1/webhooks/hook_1", {
    method: "POST",
    headers,
    body,
  });
}

/* ── create, list, never the secret ───────────────────────────────────── */

let secret = "";
let hookId = "";

{
  for (const action of [
    "create webhooks",
    "list webhooks",
    "delete webhooks",
    "read webhook deliveries",
  ]) {
    check(`"${action}" is invisible to an agent token`, scopeForAction(action) === null);
  }
}

{
  const response = await handleWebhookCreate(
    new Request("https://worker.test/v1/admin/webhooks", {
      method: "POST",
      body: JSON.stringify({ name: "ci" }),
    }),
    env,
    human
  );
  const body = await response.json();
  hookId = body.id;
  secret = body.secret;
  check("create returns 201", response.status === 201, String(response.status));
  check("create returns an id", typeof hookId === "string" && hookId.startsWith("wh_"));
  check("create returns the secret once", typeof secret === "string" && secret.length === 64);

  const serialized = JSON.stringify(body);
  check("create response omits secret_hash", !serialized.includes("secret_hash"));
  check("create response omits the sealed copy", !serialized.includes("secret_sealed"));

  const stored = env.DB.raw.prepare("SELECT * FROM webhooks WHERE id = ?").get(hookId);
  check("the secret is stored as SHA-256", stored.secret_hash.length === 64 && stored.secret_hash !== secret);
  check("the sealed copy is not the clear secret", stored.secret_sealed !== secret);
}

{
  const response = await handleWebhookList(env, human);
  const body = await response.json();
  const serialized = JSON.stringify(body);
  check("list returns the hook", body.webhooks.length === 1 && body.webhooks[0].id === hookId);
  check("list never returns secret_hash", !serialized.includes("secret_hash"));
  check("list never returns the secret", !serialized.includes(secret));
}

/* ── signature accept / reject ────────────────────────────────────────── */

{
  check("constant-time compare accepts equal values", timingSafeEqualHex("aabb", "aabb") === true);
  check("constant-time compare refuses one byte", timingSafeEqualHex("aabb", "aabc") === false);
  check("constant-time compare refuses a length mismatch", timingSafeEqualHex("aabb", "aabbcc") === false);

  const source = readFileSync(path.join(WORKER_ROOT, "src/routes/webhooks.ts"), "utf8");
  check(
    "the verifier compares through the constant-time helper",
    /timingSafeEqualHex\(expected, provided\)/.test(source)
  );

  const body = JSON.stringify({ message: "hello" });
  const good = await verifyWebhookSignature(secret, body, `sha256=${sign(secret, body)}`);
  check("a correct signature is accepted", good === true);
  const bad = await verifyWebhookSignature(secret, body, `sha256=${"0".repeat(64)}`);
  check("a wrong signature is refused", bad === false);
  const truncated = await verifyWebhookSignature(secret, body, `sha256=${sign(secret, body).slice(0, 32)}`);
  check("a truncated signature is refused", truncated === false);
  const wrongLength = await verifyWebhookSignature(secret, body, `sha256=${sign(secret, body)}00`);
  check("a wrong-length signature is refused", wrongLength === false);
  const unprefixed = await verifyWebhookSignature(secret, body, sign(secret, body));
  check("a signature without the sha256= prefix is refused", unprefixed === false);
}

/* ── ingress, replay, refusals ────────────────────────────────────────── */

{
  const body = JSON.stringify({ message: "deploy finished" });
  const first = await handleWebhookIngress(ingress(body, "delivery-1"), env, hookId);
  const firstBody = await first.json();
  check("a signed delivery is accepted", first.status === 200, String(first.status));
  check("the answer is returned", firstBody.answer === "answer to deploy finished", JSON.stringify(firstBody));
  check("the turn ran exactly once", answers.length === 1);
  check("the actor is the webhook label", answers[0].actor.label === `webhook:${hookId}`);
  check("the actor role is webhook", answers[0].actor.role === "webhook");

  const second = await handleWebhookIngress(ingress(body, "delivery-1"), env, hookId);
  const secondBody = await second.json();
  check("a repeated delivery is 200", second.status === 200, String(second.status));
  check("a repeated delivery says replayed", secondBody.replayed === true, JSON.stringify(secondBody));
  check("a repeated delivery returns the stored answer", secondBody.answer === firstBody.answer);
  check("a repeated delivery runs no second turn", answers.length === 1, `turns ${answers.length}`);

  const stored = env.DB.raw
    .prepare("SELECT status, answer_text FROM webhook_deliveries WHERE id = ?")
    .get("delivery-1");
  check("the answer is stored on the delivery row", stored.status === "succeeded" && stored.answer_text === firstBody.answer);
}

{
  const body = JSON.stringify({ message: "x" });
  const bad = await handleWebhookIngress(
    ingress(body, "delivery-bad", `sha256=${"0".repeat(64)}`),
    env,
    hookId
  );
  const parsed = await bad.json();
  check("a bad signature is 401", bad.status === 401 && parsed.error === "invalid_signature", `${bad.status} ${JSON.stringify(parsed)}`);

  const truncated = await handleWebhookIngress(
    ingress(body, "delivery-truncated", `sha256=${sign(secret, body).slice(0, 32)}`),
    env,
    hookId
  );
  check("a truncated signature is 401", truncated.status === 401);

  const noDelivery = await handleWebhookIngress(ingress(body, undefined), env, hookId);
  const noDeliveryBody = await noDelivery.json();
  check(
    "a missing delivery id is 400",
    noDelivery.status === 400 && noDeliveryBody.error === "bad_request",
    `${noDelivery.status} ${JSON.stringify(noDeliveryBody)}`
  );

  check("refused requests ran no turn", answers.length === 1);
}

{
  env.DB.raw.prepare("UPDATE webhooks SET enabled = 0 WHERE id = ?").run(hookId);
  const body = JSON.stringify({ message: "while disabled" });
  const disabled = await handleWebhookIngress(ingress(body, "delivery-disabled"), env, hookId);
  const parsed = await disabled.json();
  check(
    "a disabled hook is refused",
    disabled.status === 403 && parsed.error === "webhook_disabled",
    `${disabled.status} ${JSON.stringify(parsed)}`
  );
  check("a disabled hook runs no turn", answers.length === 1);
  env.DB.raw.prepare("UPDATE webhooks SET enabled = 1 WHERE id = ?").run(hookId);
}

{
  const large = "x".repeat(MAX_WEBHOOK_BODY_BYTES + 1);
  const oversized = await handleWebhookIngress(
    new Request("https://worker.test/v1/webhooks/hook_1", {
      method: "POST",
      headers: {
        "x-dakflare-signature": `sha256=${sign(secret, large)}`,
        "x-dakflare-delivery": "delivery-large",
      },
      body: large,
    }),
    env,
    hookId
  );
  check("an oversized body is refused", oversized.status === 413, String(oversized.status));
  check("an oversized body runs no turn", answers.length === 1);
}

{
  const runtimeOff = { ...env, AGENT_RUNTIME: "off" };
  const body = JSON.stringify({ message: "runtime off" });
  const offResponse = await handleWebhookIngress(ingress(body, "delivery-runtime-off"), runtimeOff, hookId);
  check("AGENT_RUNTIME=off returns 503", offResponse.status === 503, String(offResponse.status));
}

{
  const limited = {
    ...env,
    ADMIN_LIMITER: { limit: async () => ({ success: false }) },
  };
  const body = JSON.stringify({ message: "over budget" });
  const response = await handleWebhookIngress(ingress(body, "delivery-limited"), limited, hookId);
  check("an exhausted per-hook limiter is 429", response.status === 429, String(response.status));
}

/* ── no human session means no act ────────────────────────────────────── */

{
  const autonomy = {
    enabled: 1,
    sms_cap: 5,
    write_cap: 5,
    expires_at: Date.now() + 60_000,
    updated_by: "owner@example.test",
    allow_rules: 1,
    actor: "owner@example.test",
  };
  const store = {
    async readAutonomy() {
      return autonomy;
    },
    async readUsage() {
      return { tokens: 0, writes: 0, sms: 0 };
    },
    async chargeUsage() {
      return "ok";
    },
    async refundUsage() {},
    async findGrant() {
      return { id: "grant_1", scope: "rules:write", target: {} };
    },
    async consumeGrant() {
      return true;
    },
    async refundGrant() {},
  };

  const webhookActor = {
    userId: null,
    label: `webhook:${hookId}`,
    role: "webhook",
    canGrantOwner: false,
  };
  const refused = await authorizeActWithStore(store, webhookActor, {
    kind: "write",
    scope: "rules:write",
    target: {},
  });
  check(
    "a webhook actor is refused by authorizeAct",
    refused.ok === false && refused.reason === "webhook_cannot_act",
    refused.ok ? "allowed" : refused.reason
  );

  // The actor trick alone: a normal actor that does not own the live window is
  // refused before any grant is read. This is why `webhook:…` can never match a
  // window a person opened; the explicit refusal above covers an ownerless row.
  const otherActor = {
    userId: "user_2",
    label: "someone-else@example.test",
    role: "admin",
    canGrantOwner: false,
  };
  const other = await authorizeActWithStore(store, otherActor, {
    kind: "write",
    scope: "rules:write",
    target: {},
  });
  check(
    "a non-owner actor is refused with autonomy_other_session",
    other.ok === false && other.reason === "autonomy_other_session",
    other.ok ? "allowed" : other.reason
  );

  // An ownerless row (migration 0013 shape) would accept the label check; the
  // webhook refusal must still apply.
  const ownerless = { ...autonomy, actor: null };
  const ownerlessStore = { ...store, async readAutonomy() { return ownerless; } };
  const stillRefused = await authorizeActWithStore(ownerlessStore, webhookActor, {
    kind: "write",
    scope: "rules:write",
    target: {},
  });
  check(
    "a webhook actor cannot spend an ownerless window either",
    stillRefused.ok === false && stillRefused.reason === "webhook_cannot_act",
    stillRefused.ok ? "allowed" : stillRefused.reason
  );
}

/* ── deliveries and delete ────────────────────────────────────────────── */

{
  const response = await handleWebhookDeliveries(env, hookId, human);
  const body = await response.json();
  const serialized = JSON.stringify(body);
  check("deliveries lists the stored rows", body.deliveries.length >= 1);
  check("deliveries never returns secret_hash", !serialized.includes("secret_hash"));
  check("deliveries never returns the secret", !serialized.includes(secret));

  const deleted = await handleWebhookDelete(env, hookId, human);
  check("delete returns ok", deleted.status === 200);
  const missing = await handleWebhookDelete(env, hookId, human);
  check("deleting a missing hook is 404", missing.status === 404);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
