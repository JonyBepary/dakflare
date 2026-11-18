#!/usr/bin/env node
/**
 * Agent attachments and the visible turn — the backend half of "agentic enough".
 *
 * The policy lives in `src/agent/attachments.ts`; this drives it with in-memory
 * seams plus the real Sessions capability, so the assertions are about the code
 * the route and the Durable Object call, not a second implementation.
 *
 * Asserted:
 *   - text files are read into the prompt under a header naming the file, and a
 *     set of files is truncated to 64 KiB across the whole block;
 *   - an image is named in the prompt and explicitly marked unseeable, and its
 *     bytes are never read;
 *   - an attachment past 24 h refuses the turn and names the id;
 *   - the 1 MiB file cap and the 3-per-operator cap each refuse with the limit
 *     in the message;
 *   - an unknown attachment id is a named 400, not a silent drop;
 *   - a turn with a recorded key replays without invoking the model path, and
 *     the replay is labelled `replayed: true`;
 *   - the deployment-wide daily SMS cap refuses before a grant is read;
 *   - an act refused for authority carries `origin: "act_refused"` in the
 *     proposal payload.
 *
 * Run: node --experimental-strip-types src/lib/__checks__/agent-attachments.mjs
 */

import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function resolveExtensionless(specifier, context, nextResolve) {
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && path.extname(specifier) === "") {
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
  ATTACHMENT_TTL_MS,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_OPERATOR,
  TEXT_PROMPT_BUDGET_BYTES,
  attachmentKind,
  attachmentPromptBlock,
  checkUpload,
  objectKeyFor,
  resolveAttachments,
  turnRefusalStatus,
} = await import("../../agent/attachments.ts");
const {
  appendTurnMessages,
  clearConversationMessages,
  conversationIdFor,
  readConversationMessages,
  recordTurnAnswer,
  withRecordedTurn,
} = await import("../../agent/conversation.ts");
const { createCapabilityHost } = await import("./agent-capability-harness.mjs");

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

const byteLength = (text) => new TextEncoder().encode(text).byteLength;

/* ── seams ───────────────────────────────────────────────────────────── */

/**
 * An in-memory attachment store and blob store.
 *
 * `blobs.readIds` records every text read, which is how "an image is named, not
 * sent" is asserted: the id must never appear there.
 */
function makeDeps(rows = []) {
  const meta = new Map(rows.map((row) => [row.id, row]));
  const texts = new Map();
  const readIds = [];
  const store = {
    async insert(row) {
      meta.set(row.id, row);
    },
    async list() {
      return [...meta.values()];
    },
    async find(actorHash, id) {
      const row = meta.get(id);
      if (row === undefined) return null;
      return row.actor_hash === actorHash ? row : null;
    },
    async remove(_actorHash, id) {
      meta.delete(id);
    },
    async count() {
      return meta.size;
    },
  };
  const blobs = {
    async put() {},
    async getText(key) {
      readIds.push(key);
      return texts.has(key) ? texts.get(key) : null;
    },
    async delete() {},
  };
  return { store, blobs, meta, texts, readIds };
}

function textRow(id, name, key, text, overrides = {}) {
  return {
    id,
    actor_hash: "hash",
    actor: "alice@example.com",
    name,
    kind: attachmentKind(name),
    bytes: byteLength(text),
    r2_key: key,
    created_at: Date.now(),
    expires_at: Date.now() + ATTACHMENT_TTL_MS,
    ...overrides,
  };
}

const NOW = Date.now();

/* ── 1. text is read, and the whole block is truncated to 64 KiB ─────── */

{
  const big = "a".repeat(70 * 1024);
  const second = "b".repeat(10 * 1024);
  const rows = [
    textRow("att_big", "big.txt", "agent/hash/att_big/big.txt", big),
    textRow("att_two", "second.md", "agent/hash/att_two/second.md", second),
  ];
  const deps = makeDeps(rows);
  deps.texts.set(rows[0].r2_key, big);
  deps.texts.set(rows[1].r2_key, second);

  const resolved = await resolveAttachments(
    ["att_big", "att_two"],
    "hash",
    deps,
    NOW
  );
  check("two text attachments resolve", resolved.ok === true, JSON.stringify(resolved).slice(0, 120));
  if (resolved.ok) {
    check(
      "the prompt names each file",
      resolved.block.includes("--- file: big.txt (text,") &&
        resolved.block.includes("--- file: second.md (text,"),
      resolved.block.slice(0, 80)
    );
    check(
      "the block is bounded at 64 KiB of file text (plus headers)",
      byteLength(resolved.block) <= TEXT_PROMPT_BUDGET_BYTES + 400,
      `block ${byteLength(resolved.block)} bytes`
    );
    check(
      "the oversize file is marked truncated",
      resolved.block.includes("[truncated: showing"),
      resolved.block.slice(-120)
    );
    check(
      "the second file is still named after the budget is spent",
      resolved.block.includes("--- file: second.md"),
      ""
    );
  }
}

/* ── 2. an image is named, marked unseeable, and never read ──────────── */

{
  const image = {
    id: "att_png",
    actor_hash: "hash",
    actor: "alice@example.com",
    name: "screenshot.png",
    kind: "image",
    bytes: 4096,
    r2_key: "agent/hash/att_png/screenshot.png",
    created_at: NOW,
    expires_at: NOW + ATTACHMENT_TTL_MS,
  };
  const deps = makeDeps([image]);
  const resolved = await resolveAttachments(["att_png"], "hash", deps, NOW);
  check("an image resolves as a named file", resolved.ok === true);
  if (resolved.ok) {
    check(
      "the prompt says the model cannot see the image",
      /cannot see this file/.test(resolved.block),
      resolved.block
    );
    check(
      "the image bytes are never read",
      deps.readIds.length === 0,
      JSON.stringify(deps.readIds)
    );
  }
  const other = { ...image, id: "att_bin", name: "capture.bin", kind: "other" };
  const otherDeps = makeDeps([other]);
  const otherResolved = await resolveAttachments(["att_bin"], "hash", otherDeps, NOW);
  check(
    "another binary is likewise named, not sent",
    otherResolved.ok === true &&
      /cannot see this file/.test(otherResolved.block) &&
      otherDeps.readIds.length === 0
  );
}

/* ── 3. an expired attachment refuses by name ────────────────────────── */

{
  const old = textRow("att_old", "notes.txt", "agent/hash/att_old/notes.txt", "hello", {
    created_at: NOW - ATTACHMENT_TTL_MS - 1_000,
    expires_at: NOW - 1_000,
  });
  const deps = makeDeps([old]);
  deps.texts.set(old.r2_key, "hello");
  const resolved = await resolveAttachments(["att_old"], "hash", deps, NOW);
  check(
    "an attachment older than 24 h refuses the turn",
    resolved.ok === false && resolved.reason === "attachment_expired",
    JSON.stringify(resolved)
  );
  check(
    "the expiry refusal names the attachment and its deadline",
    resolved.ok === false &&
      resolved.message.includes("att_old") &&
      resolved.message.includes("expired at"),
    resolved.ok ? "" : resolved.message
  );
  check("the expired file is not read", deps.readIds.length === 0, JSON.stringify(deps.readIds));
}

/* ── 4. limits ───────────────────────────────────────────────────────── */

{
  const tooBig = checkUpload({
    name: "big.zip",
    size: MAX_ATTACHMENT_BYTES + 1,
    liveCount: 0,
  });
  check(
    "a file over 1 MiB is refused with 413",
    tooBig !== null && tooBig.status === 413 && tooBig.error === "attachment_too_large",
    JSON.stringify(tooBig)
  );
  check(
    "the size refusal names the 1 MiB limit",
    tooBig !== null && tooBig.message.includes(String(MAX_ATTACHMENT_BYTES)) && /1 MiB/.test(tooBig.message),
    tooBig?.message ?? ""
  );
  check(
    "a file exactly at 1 MiB is allowed",
    checkUpload({ name: "ok.txt", size: MAX_ATTACHMENT_BYTES, liveCount: 0 }) === null
  );

  const atCap = checkUpload({
    name: "fourth.txt",
    size: 10,
    liveCount: MAX_ATTACHMENTS_PER_OPERATOR,
  });
  check(
    "a fourth attachment is refused with 409",
    atCap !== null && atCap.status === 409 && atCap.error === "attachment_limit",
    JSON.stringify(atCap)
  );
  check(
    "the cap refusal names the 3-file limit",
    atCap !== null && atCap.message.includes("at most 3 attachments"),
    atCap?.message ?? ""
  );
  check(
    "the third attachment is allowed",
    checkUpload({ name: "third.txt", size: 10, liveCount: 2 }) === null
  );
}

/* ── 5. unknown id is a named 400 ────────────────────────────────────── */

{
  const deps = makeDeps([]);
  const resolved = await resolveAttachments(["att_missing"], "hash", deps, NOW);
  check(
    "an unknown attachment id refuses the turn",
    resolved.ok === false && resolved.reason === "unknown_attachment",
    JSON.stringify(resolved)
  );
  check(
    "the unknown-id refusal names the id and is a 400",
    resolved.ok === false &&
      resolved.message.includes("att_missing") &&
      turnRefusalStatus(resolved.reason) === 400,
    resolved.ok ? "" : resolved.message
  );
  check(
    "an expired id is also a 400",
    turnRefusalStatus("attachment_expired") === 400 &&
      turnRefusalStatus("too_many") === 400
  );
  check(
    "a provider failure stays a 503",
    turnRefusalStatus("provider_unavailable") === 503
  );
}

/* ── 6. a recorded turn replays without a second model call ──────────── */

{
  const harness = await createCapabilityHost();
  const { Sessions } = await import("agents/sessions");
  const sessions = new Sessions();
  harness.lifecycle.use(sessions);
  await harness.lifecycle.start();
  const session = sessions.session(conversationIdFor("alice"));

  let modelCalls = 0;
  const first = await withRecordedTurn(
    session,
    "say:retry-key",
    async () => {
      modelCalls += 1;
      await appendTurnMessages(session, "say:retry-key", [
        { role: "user", content: "what is in notes.txt?" },
        { role: "assistant", content: "the first line is hello" },
      ]);
      await recordTurnAnswer(session, "say:retry-key", "the first line is hello");
      return { ok: true, answer: "the first line is hello", replayed: false };
    },
    (answer) => ({ ok: true, answer, calls: [], took_ms: 0, replayed: true })
  );
  check("the first turn calls the model once", modelCalls === 1 && first.replayed === false);

  const second = await withRecordedTurn(
    session,
    "say:retry-key",
    async () => {
      modelCalls += 1;
      throw new Error("the model must not be called for a replay");
    },
    (answer) => ({ ok: true, answer, calls: [], took_ms: 0, replayed: true })
  );
  check(
    "the same key replays the recorded answer",
    second.ok === true && second.answer === "the first line is hello",
    JSON.stringify(second)
  );
  check("a replay makes no second model call", modelCalls === 1, `calls ${modelCalls}`);
  check("the replay is labelled replayed:true", second.replayed === true);

  const rows = harness.db
    .prepare("SELECT COUNT(*) AS n FROM cf_agents_session_messages")
    .get();
  check("a replay appends no transcript row", Number(rows.n) === 3, `rows ${rows.n}`);

  /* ── 6b. the transcript is readable, newest last ───────────────────── */

  const { readConversationMessages } = await import("../../agent/conversation.ts");
  const panelSession = sessions.session(conversationIdFor("rae"));
  // Mirrors a real turn: the user message is persisted by `appendTurnMessages`,
  // the final answer only as the `turn-result` marker.
  await appendTurnMessages(panelSession, "say:one", [
    { role: "user", content: "first question" },
  ]);
  await recordTurnAnswer(panelSession, "say:one", "first answer");
  await appendTurnMessages(panelSession, "say:two", [
    { role: "user", content: "second question" },
  ]);
  await recordTurnAnswer(panelSession, "say:two", "second answer");

  const transcript = await readConversationMessages(panelSession, 40);
  check(
    "the transcript exposes the answer markers as assistant messages",
    transcript.messages.map((entry) => entry.role).join(",") ===
      "user,assistant,user,assistant",
    JSON.stringify(transcript.messages.map((entry) => entry.role))
  );
  check(
    "the transcript is newest last",
    transcript.messages.at(-1)?.text === "second answer",
    transcript.messages.at(-1)?.text ?? ""
  );
  check("a complete transcript is not truncated", transcript.truncated === false);
  check(
    "the limit keeps the newest and reports truncation",
    (await readConversationMessages(panelSession, 1)).messages[0]?.text === "second answer" &&
      (await readConversationMessages(panelSession, 1)).truncated === true
  );

  await clearConversationMessages(panelSession);
  check(
    "clearing the conversation empties it",
    (await readConversationMessages(panelSession, 40)).messages.length === 0
  );
}

/* ── 7. the deployment-wide daily SMS cap, before any grant ──────────── */

{
  const { authorizeActWithStore } = await import("../../agent/grants.ts");
  let grantReads = 0;
  const makeStore = (autonomy) => ({
    readAutonomy: async () => autonomy,
    readUsage: async () => ({ tokens: 0, writes: 0, sms: 20 }),
    chargeUsage: async () => "ok",
    refundUsage: async () => {},
    findGrant: async () => {
      grantReads += 1;
      return {
        id: "g1",
        agent_token_id: "autonomy:agent",
        scope: "sms:send:production",
        target: {},
        granted_by: "tester",
        granted_at: 0,
        expires_at: NOW + 60_000,
        revoked_at: null,
        use_count: 0,
        last_used_at: null,
        approval_request_id: null,
      };
    },
    consumeGrant: async () => true,
    refundGrant: async () => {},
  });
  const actor = { userId: "u1", label: "tester", role: "admin", canGrantOwner: true };
  const effect = {
    kind: "sms",
    scope: "sms:send:production",
    target: { recipients: ["+15550000001"] },
  };

  const decision = await authorizeActWithStore(
    makeStore({
      enabled: 1,
      sms_cap: 100,
      write_cap: 50,
      daily_sms_cap: 20,
      expires_at: NOW + 60_000,
      updated_by: "tester",
      actor: "tester",
    }),
    actor,
    effect,
    NOW
  );
  check(
    "the deployment daily SMS cap refuses at the limit",
    decision.ok === false && decision.reason === "daily_sms_cap",
    JSON.stringify(decision)
  );
  check(
    "the daily cap message names the limit",
    decision.ok === false && decision.message.includes("20/day"),
    decision.ok ? "" : decision.message
  );
  check("the daily cap refuses before a grant is read", grantReads === 0, `reads ${grantReads}`);

  // A row written before migration 0016 has no column value in the fixture;
  // the default is 20, not "unlimited".
  const legacy = await authorizeActWithStore(
    makeStore({
      enabled: 1,
      sms_cap: 100,
      write_cap: 50,
      expires_at: NOW + 60_000,
      updated_by: "tester",
      actor: "tester",
    }),
    actor,
    effect,
    NOW
  );
  check(
    "a row without the column is read as the default 20",
    legacy.ok === false && legacy.reason === "daily_sms_cap",
    JSON.stringify(legacy)
  );
  check("the legacy row also refuses before a grant", grantReads === 0, `reads ${grantReads}`);
}

/* ── 8. a refused act's proposal says why ────────────────────────────── */

{
  const { createActTools } = await import("../../agent/act.ts");
  const staged = [];
  const tools = createActTools({
    authorize: async () => ({ ok: false, reason: "autonomy_off", message: "agent autonomy is off" }),
    dispatch: {
      async proposeRule(payload) {
        staged.push(payload);
        return { id: "ap_origin" };
      },
      async createRule() {
        return Response.json({ id: "r_should_not_exist" });
      },
      async sendSms() {
        return Response.json({});
      },
      async deployFlow() {
        return Response.json({});
      },
    },
  });
  const tool = tools.find((entry) => entry.name === "create_rule_now");
  const journal = {
    async reserve() {
      return { replay: false };
    },
    fail() {},
    complete() {},
    deriveKey: () => "k",
    nextTurn: () => 1,
    finishTurn() {},
    setTurn() {},
    forTurn() {
      return journal;
    },
  };
  const result = await tool.execute(
    {
      matcher: { type: "exact", value: "STOP" },
      body_matcher: { type: "keyword", value: "stop" },
      reply_template: "Stopped.",
    },
    {
      env: {},
      actor: { userId: "u1", label: "tester", role: "admin", canGrantOwner: true },
      callId: "call_1",
      journal,
      budget: { chargeTokens: async () => {} },
      signal: new AbortController().signal,
    }
  );
  check("the refused act offers a proposal", result.ok === true && staged.length === 1);
  check(
    "the proposal payload carries origin=act_refused",
    staged[0]?.origin === "act_refused",
    JSON.stringify(staged[0]).slice(0, 160)
  );
  check(
    "the rule's own fields survive the marker",
    staged[0]?.reply_template === "Stopped." && staged[0]?.matcher?.value === "STOP"
  );
}

/* ── key naming is per operator and path-safe ────────────────────────── */

check(
  "the R2 key is agent/<actor-hash>/<id>/<name>",
  objectKeyFor("abc123", "att_1", "notes.txt") === "agent/abc123/att_1/notes.txt"
);
check(
  "a path-like name cannot escape its prefix",
  objectKeyFor("abc123", "att_1", "../../secret.txt") === "agent/abc123/att_1/secret.txt",
  objectKeyFor("abc123", "att_1", "../../secret.txt")
);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exitCode = 1;
}
