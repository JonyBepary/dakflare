#!/usr/bin/env node
/**
 * Conversation, attachment and turn-key integrity.
 *
 * Drives the real Sessions capability through the in-memory host, the real
 * `runClaimedTurn` policy, the real `AssistantAgent` frame handler, and the
 * attachment sweep against in-memory seams. Assertions are about stored rows,
 * blob objects, frame/response shapes and model-call counts.
 *
 * Asserted:
 *   - a panel read of a turn with attachments names the files but never
 *     contains the file body, while the stored turn still carries it for the
 *     model and the prompt view still sees it;
 *   - two `X-Dakflare-Client` values resolve to different conversations and
 *     different attachment namespaces; no header falls back to the old label;
 *   - the same key with the same text replays with one model call, and with
 *     different text is a named 409 conflict;
 *   - two in-flight turns with one key make one model call; the loser replays;
 *   - a failed turn releases its claim so a retry runs;
 *   - the sweep deletes an expired row and its R2 object, leaving a live one;
 *   - an invalid socket idempotency key is refused with the socket error frame.
 *
 * Run: node --experimental-strip-types src/lib/__checks__/conversation-integrity.mjs
 */

import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WASM_STUB = "data:text/javascript,export default {}";

function resolveRuntime(specifier, context, nextResolve) {
  if (specifier.endsWith(".wasm")) return { url: WASM_STUB, shortCircuit: true };
  if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    path.extname(specifier) === ""
  ) {
    const base = context.parentURL
      ? path.dirname(fileURLToPath(context.parentURL))
      : HERE;
    for (const suffix of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
      const candidate = path.resolve(base, specifier + suffix);
      if (existsSync(candidate)) {
        return { url: pathToFileURL(candidate).href, shortCircuit: true };
      }
    }
  }
  return nextResolve(specifier, context, nextResolve);
}

registerHooks({ resolve: resolveRuntime });

const { createCapabilityHost } = await import("./agent-capability-harness.mjs");
const { Sessions } = await import("agents/sessions");
const {
  appendTurnMessages,
  conversationIdFor,
  messageFingerprint,
  messageText,
  readConversationMessages,
  readHistoryNewestFirst,
  recordTurnAnswer,
  runClaimedTurn,
  toChatHistory,
  turnMessageId,
} = await import("../../agent/conversation.ts");
const {
  ATTACHMENT_TTL_MS,
  attachmentKind,
  actorHashFor,
  objectKeyFor,
  purgeExpiredAttachments,
  turnRefusalStatus,
} = await import("../../agent/attachments.ts");
const {
  machineActorFromRequest,
  runAsAgent,
} = await import("../authority.ts");
const { readIdempotencyKey } = await import("../agent-runtime.ts");
const { AssistantAgent } = await import("../../agent/runtime.ts");

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

/** The claim store the object implements over SQLite, with the same contract. */
function makeClaims() {
  const rows = new Map();
  return {
    rows,
    async claim(key, messageHash, now, expiresAt) {
      const existing = rows.get(key);
      if (existing !== undefined && existing.expiresAt > now) return false;
      rows.set(key, { messageHash, expiresAt });
      return true;
    },
    async release(key) {
      rows.delete(key);
    },
  };
}

/* ── 1. the read strips the file body and names the file ─────────────── */

{
  const harness = await createCapabilityHost();
  const sessions = new Sessions();
  harness.lifecycle.use(sessions);
  await harness.lifecycle.start();
  const session = sessions.session(conversationIdFor("reader"));

  const body = "SECRET-FILE-BODY-0123456789";
  const storedUser =
    "what is in notes.txt?\n\nAttached files from the operator:\n" +
    `--- file: notes.txt (text, ${body.length} bytes) ---\n${body}`;

  await appendTurnMessages(
    session,
    "say:file-read",
    [
      { role: "user", content: storedUser },
      { role: "assistant", content: "the first line is the secret" },
    ],
    { attachmentNames: ["notes.txt"] }
  );
  await recordTurnAnswer(session, "say:file-read", "the first line is the secret");

  const read = await readConversationMessages(session, 40);
  const user = read.messages.find((entry) => entry.role === "user");
  check(
    "the panel read never contains the file body",
    user !== undefined && !user.text.includes(body),
    user?.text ?? "missing user row"
  );
  check(
    "the panel read still names every attached file",
    user !== undefined &&
      user.text.includes("notes.txt") &&
      user.text.includes("what is in notes.txt?"),
    user?.text ?? ""
  );

  const stored = await session.getMessage(turnMessageId("say:file-read", 0));
  check(
    "the stored turn still carries the body for a later prompt",
    stored !== null && messageText(stored).includes(body)
  );
  const recent = await readHistoryNewestFirst(session);
  check(
    "the model's prompt history still sees the body",
    toChatHistory(recent.messages).some((entry) => entry.content.includes(body))
  );
}

/* ── 2. machine identities do not share a conversation or a file prefix ─ */

{
  const env = { ADMIN_TOKEN: "test-admin-token" };
  const action = "say";
  const labels = [];
  for (const client of ["machine-a", "machine-b"]) {
    const request = new Request("https://console.example/v1/admin/agent/say", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-admin-token",
        "X-Dakflare-Client": client,
      },
    });
    await runAsAgent(request, env, action, async (actor) => {
      labels.push(actor.label);
      return Response.json({ label: actor.label });
    });
  }

  check(
    "two client values produce two actors",
    labels.length === 2 && labels[0] !== labels[1],
    JSON.stringify(labels)
  );
  check(
    "two client values produce two conversations",
    conversationIdFor(labels[0]) !== conversationIdFor(labels[1]),
    labels.map((label) => conversationIdFor(label)).join(",")
  );

  const hashA = await actorHashFor(labels[0]);
  const hashB = await actorHashFor(labels[1]);
  check(
    "two client values produce two attachment namespaces",
    hashA !== hashB &&
      objectKeyFor(hashA, "att_1", "notes.txt").split("/")[1] !==
        objectKeyFor(hashB, "att_1", "notes.txt").split("/")[1],
    `${hashA} vs ${hashB}`
  );

  const headerless = machineActorFromRequest(
    new Request("https://console.example/v1/admin/agent/say")
  );
  check(
    "no client header falls back to the old label alone",
    headerless.label === "admin-token",
    headerless.label
  );
}

/* ── 3. a key is bound to its message; a valid replay makes one call ──── */

{
  const harness = await createCapabilityHost();
  const sessions = new Sessions();
  harness.lifecycle.use(sessions);
  await harness.lifecycle.start();
  const session = sessions.session(conversationIdFor("keys"));
  const claims = makeClaims();
  let modelCalls = 0;

  const run = (key, text, answer) => async () => {
    modelCalls += 1;
    const hash = await messageFingerprint(text);
    await recordTurnAnswer(session, key, answer, hash);
    return { ok: true, answer };
  };
  const hashFor = (text) => messageFingerprint(text);

  const key = "say:same-text-key";
  const text = "how many devices are online?";
  const first = await runClaimedTurn({
    session,
    key,
    messageHash: await hashFor(text),
    claims,
    run: run(key, text, "one"),
  });
  const replay = await runClaimedTurn({
    session,
    key,
    messageHash: await hashFor(text),
    claims,
    run: async () => {
      throw new Error("a replay must not call the model");
    },
  });
  check("the first turn runs and answers", first.status === "ran");
  check("the same key and text replays the answer", replay.status === "replayed" && replay.answer === "one");
  check("a valid replay makes one model call in total", modelCalls === 1, `calls ${modelCalls}`);

  const conflict = await runClaimedTurn({
    session,
    key,
    messageHash: await hashFor("a different question"),
    claims,
    run: async () => {
      throw new Error("a conflicting key must not call the model");
    },
  });
  check(
    "the same key with different text is a conflict",
    conflict.status === "conflict",
    JSON.stringify(conflict)
  );
  check(
    "the conflict names the key and maps to 409",
    conflict.status === "conflict" &&
      conflict.message.includes(key) &&
      turnRefusalStatus("idempotency_conflict") === 409,
    conflict.status === "conflict" ? conflict.message : ""
  );
  check("the conflict made no second model call", modelCalls === 1, `calls ${modelCalls}`);
}

/* ── 4. two in-flight turns with one key make one model call ──────────── */

{
  const harness = await createCapabilityHost();
  const sessions = new Sessions();
  harness.lifecycle.use(sessions);
  await harness.lifecycle.start();
  const session = sessions.session(conversationIdFor("racing"));
  const claims = makeClaims();
  const key = "say:race-key";
  const text = "what is my device doing?";
  const messageHash = await messageFingerprint(text);

  let modelCalls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const run = async () => {
    modelCalls += 1;
    await gate;
    await recordTurnAnswer(session, key, "the answer", messageHash);
    return { ok: true, answer: "the answer" };
  };

  const winner = runClaimedTurn({ session, key, messageHash, claims, run });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const loser = runClaimedTurn({ session, key, messageHash, claims, run });
  release();
  const [first, second] = await Promise.all([winner, loser]);

  check("two concurrent turns make one model call", modelCalls === 1, `calls ${modelCalls}`);
  check(
    "exactly one runs and one replays",
    [first.status, second.status].sort().join(",") === "ran,replayed",
    `${first.status},${second.status}`
  );
  check(
    "the loser returns the winner's recorded answer",
    (first.status === "replayed" ? first.answer : second.status === "replayed" ? second.answer : null) ===
      "the answer"
  );
  check("the claim is released after the turn settles", claims.rows.size === 0);
}

/* ── 5. a failed turn releases the claim so a retry runs ──────────────── */

{
  const harness = await createCapabilityHost();
  const sessions = new Sessions();
  harness.lifecycle.use(sessions);
  await harness.lifecycle.start();
  const session = sessions.session(conversationIdFor("retry"));
  const claims = makeClaims();
  const key = "say:retry-failed";
  const text = "try this again";
  const messageHash = await messageFingerprint(text);
  let attempts = 0;

  let threw = false;
  try {
    await runClaimedTurn({
      session,
      key,
      messageHash,
      claims,
      run: async () => {
        attempts += 1;
        throw new Error("provider died");
      },
    });
  } catch {
    threw = true;
  }
  check("the failed turn propagates its failure", threw === true);
  check("the failed turn releases its claim", claims.rows.size === 0);

  const retry = await runClaimedTurn({
    session,
    key,
    messageHash,
    claims,
    run: async () => {
      attempts += 1;
      await recordTurnAnswer(session, key, "recovered", messageHash);
      return { ok: true, answer: "recovered" };
    },
  });
  check("the retry with the same key runs", retry.status === "ran");
  check("the retry answered", retry.status === "ran" && retry.value.answer === "recovered");
  check("the key was attempted twice, once per run", attempts === 2, `attempts ${attempts}`);
}

/* ── 6. the sweep reclaims expired attachments and their objects ──────── */

{
  const NOW = Date.now();
  const rows = [
    {
      id: "att_expired",
      actor_hash: "hash",
      actor: "alice@example.com",
      name: "old.txt",
      kind: "text",
      bytes: 5,
      r2_key: "agent/hash/att_expired/old.txt",
      created_at: NOW - ATTACHMENT_TTL_MS - 1_000,
      expires_at: NOW - 1_000,
    },
    {
      id: "att_live",
      actor_hash: "hash",
      actor: "alice@example.com",
      name: "new.txt",
      kind: attachmentKind("new.txt"),
      bytes: 5,
      r2_key: "agent/hash/att_live/new.txt",
      created_at: NOW - 1_000,
      expires_at: NOW + ATTACHMENT_TTL_MS,
    },
  ];
  const meta = new Map(rows.map((row) => [row.id, row]));
  const objects = new Map([
    [rows[0].r2_key, "old"],
    [rows[1].r2_key, "new"],
  ]);
  const store = {
    async insert(row) {
      meta.set(row.id, row);
    },
    async list(actorHash, now) {
      return [...meta.values()].filter(
        (row) => row.actor_hash === actorHash && row.expires_at > now
      );
    },
    async find(actorHash, id) {
      const row = meta.get(id);
      return row !== undefined && row.actor_hash === actorHash ? row : null;
    },
    async remove(_actorHash, id) {
      meta.delete(id);
    },
    async count() {
      return meta.size;
    },
    async listExpired(now, limit) {
      return [...meta.values()]
        .filter((row) => row.expires_at <= now)
        .sort((left, right) => left.expires_at - right.expires_at)
        .slice(0, limit)
        .map((row) => ({ id: row.id, r2_key: row.r2_key }));
    },
    async removeById(id) {
      meta.delete(id);
    },
  };
  const blobs = {
    async put() {},
    async getText(key) {
      return objects.get(key) ?? null;
    },
    async delete(key) {
      objects.delete(key);
    },
  };

  const swept = await purgeExpiredAttachments({ store, blobs }, NOW, {
    batchSize: 10,
    maxBatches: 2,
  });
  check("the sweep reports one deleted attachment", swept.deleted === 1, `deleted ${swept.deleted}`);
  check("the expired row is gone", !meta.has("att_expired"));
  check("the live row is kept", meta.has("att_live"));
  check("the expired object is gone", !objects.has(rows[0].r2_key));
  check("the live object is kept", objects.has(rows[1].r2_key));
}

/* ── 7. an invalid socket key is refused in the socket's frame shape ──── */

{
  const harness = await createCapabilityHost();
  const agent = new AssistantAgent(harness.ctx, {});
  const frames = [];
  const connection = {
    id: "socket-1",
    state: null,
    setState(next) {
      this.state = typeof next === "function" ? next(this.state) : next;
      return this.state;
    },
    send(frame) {
      frames.push(JSON.parse(frame));
    },
    close(code, reason) {
      frames.push({ type: "close", code, reason });
    },
  };
  await agent.onConnect(connection, {
    request: new Request("https://assistant", {
      headers: {
        "x-dakflare-actor": "owner@example.test",
        "x-dakflare-actor-role": "owner",
      },
    }),
  });
  frames.length = 0;
  agent.onMessage(
    connection,
    JSON.stringify({ type: "ask", message: "hello there", idempotencyKey: "short" })
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  const error = frames.find((frame) => frame.type === "error");
  check(
    "the socket refuses an invalid key with an error frame",
    error !== undefined && error.error === "bad_request",
    JSON.stringify(frames)
  );
  check(
    "the refusal states the 8-64 character rule",
    error !== undefined && /8-64/.test(error.message ?? ""),
    error?.message ?? ""
  );
  check(
    "no ask frame or model turn was started",
    !frames.some((frame) => frame.type === "turn" || frame.type === "answer"),
    JSON.stringify(frames)
  );

  const valid = readIdempotencyKey("Abc_123-xyz");
  const tooLong = readIdempotencyKey("k".repeat(65));
  check("the shared rule accepts a valid key", valid.ok === true && valid.key === "Abc_123-xyz");
  check("the shared rule refuses an over-long key", tooLong.ok === false);
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exitCode = 1;
}
