/**
 * Conversation policy for the agent runtime — pass 4.
 *
 * The conversation is owned by the operator, not by a socket: the WebSocket
 * path and `say()` both resolve `conversation:<actor label>`, so a reconnect
 * or a CLI call reads the same memory. Sessions supplies the durable store
 * (`cf_agents_session_*`); this module is the small amount of policy the SDK
 * deliberately leaves to the host:
 *
 *   - how a message gets a stable id across retries;
 *   - how a finished turn is marked so a retry can answer from storage
 *     instead of calling the model twice;
 *   - how a byte budget becomes a prompt, newest messages first.
 *
 * `worker/src/lib/__checks__/agent-sessions.mjs` drives the real Sessions
 * capability through a fake SQLite seam, so these helpers are checked against
 * the API the runtime actually calls rather than a second implementation.
 */

import type { Session, SessionMessage } from "agents/sessions";
import type { ChatMessage } from "../lib/ai/types";
import { ATTACHMENT_BLOCK_HEADER } from "./attachments";
import { sha256Hex } from "./journal";

/** Prefix of the one durable conversation per operator. */
export const CONVERSATION_PREFIX = "conversation:";

/**
 * How much conversation the prompt may carry.
 *
 * 32 KiB is roughly 8k tokens at four bytes per token. The old window was 60
 * *rows*: a handful of long tool results or a media-sized message could blow
 * past a model's context, while a run of short turns would still be cut short.
 * A byte budget bounds what is actually hydrated, and Sessions always returns
 * at least the newest message even when it alone exceeds the budget.
 */
export const HISTORY_BUDGET_BYTES = 32 * 1024;

/** The subset of a Session the conversation helpers use. */
export type ConversationSession = Pick<
  Session,
  "appendMessage" | "getMessage" | "getRecentHistory"
>;

/** One durable conversation id per operator, shared by socket and HTTP paths. */
/**
 * The operator's conversation.
 *
 * Versioned, because a transcript is training data for the next turn. The first
 * protocol asked the model for a JSON envelope and stored those replies as
 * assistant messages; replaying them taught the model to answer in JSON again
 * even after the loop moved to native tool calling. Bumping the prefix retires
 * that transcript instead of trying to sanitise it — the old rows stay in the
 * object's SQLite, unreferenced.
 *
 * Bump this whenever the message contract changes shape.
 */
const CONVERSATION_VERSION = "v2";

export function conversationIdFor(actorLabel: string): string {
  return `${CONVERSATION_PREFIX}${CONVERSATION_VERSION}:${actorLabel}`;
}

/**
 * Stable ids for the messages one turn appends.
 *
 * The turn key is server-held (or the caller's opt-in idempotency key), and
 * the index is the message's position within the turn, so a retry appends
 * the same ids and Sessions turns the second write into an idempotent no-op.
 */
export function turnMessageId(idempotencyKey: string, index: number): string {
  return `${idempotencyKey}:m${index}`;
}

/** The marker that makes a finished turn replayable without re-running it. */
export function turnAnswerId(idempotencyKey: string): string {
  return `${idempotencyKey}:answer`;
}

/** A message part list for plain text. */
export function textParts(content: string): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text: content }];
}

/** Flatten the text parts of a stored message. */
export function messageText(message: SessionMessage): string {
  const parts = Array.isArray(message.parts) ? message.parts : [];
  return parts
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

/*
 * The conversation table is left in place but unreferenced in this pass.
 * Migration 0014_agent_drop_messages.sql (next pass) drops `agent_messages`
 * once an object that has served on this code for a deploy has no rows left
 * to copy. Writing the DROP in this pass would discard a running object's
 * transcript at upgrade time instead of letting it age out.
 */

/**
 * Most recent conversation that fits the byte budget, newest first.
 *
 * `getRecentHistory` picks the longest newest suffix within the budget but
 * returns it root → leaf. Reversing here makes "newest first" explicit at the
 * seam; `toChatHistory` reverses back for the model, which expects
 * chronological order.
 */
export async function readHistoryNewestFirst(
  session: ConversationSession,
  budgetBytes: number = HISTORY_BUDGET_BYTES
): Promise<{
  messages: SessionMessage[];
  truncated: boolean;
  totalContentBytes: number;
}> {
  const recent = await session.getRecentHistory(budgetBytes);
  return {
    messages: [...recent.messages].reverse(),
    truncated: recent.truncated,
    totalContentBytes: recent.totalContentBytes,
  };
}

/**
 * Prompt history from a newest-first read: chronological, user/assistant only.
 *
 * A `system` role is used for the turn-result marker, which exists for replay
 * and must never be sent to the model as conversation.
 */
export function toChatHistory(newestFirst: SessionMessage[]): ChatMessage[] {
  const chronological = [...newestFirst].reverse();
  const history: ChatMessage[] = [];
  for (const message of chronological) {
    if (message.role !== "user" && message.role !== "assistant" && message.role !== "tool") continue;
    const meta = (message.metadata ?? {}) as Record<string, unknown>;
    const toolCalls = Array.isArray(meta.toolCalls)
      ? (meta.toolCalls as ChatMessage["toolCalls"])
      : undefined;
    const toolCallId = typeof meta.toolCallId === "string" ? meta.toolCallId : undefined;
    const name = typeof meta.name === "string" ? meta.name : undefined;
    history.push({
      role: message.role,
      content: messageText(message),
      ...(toolCalls !== undefined && toolCalls.length > 0 ? { toolCalls } : {}),
      ...(toolCallId !== undefined ? { toolCallId } : {}),
      ...(name !== undefined ? { name } : {}),
    });
  }
  return history;
}

export interface TurnAppendOptions {
  /**
   * The files whose text was folded into the first (user) message.
   *
   * The full block stays in `parts` because a later turn's prompt needs it;
   * the marker and the names let the panel read strip the body without
   * duplicating the operator's text in metadata.
   */
  attachmentNames?: string[];
}

/** Append the entries one turn produced, each under its retry-stable id. */
export async function appendTurnMessages(
  session: ConversationSession,
  idempotencyKey: string,
  entries: ChatMessage[],
  options: TurnAppendOptions = {}
): Promise<void> {
  const attachmentNames = (options.attachmentNames ?? []).filter(
    (name): name is string => typeof name === "string" && name !== ""
  );
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const markAttachments =
      index === 0 && entry.role === "user" && attachmentNames.length > 0;
    await session.appendMessage(
      {
        id: turnMessageId(idempotencyKey, index),
        role: entry.role,
        parts: textParts(entry.content),
        metadata: {
          turn: idempotencyKey,
          ...(markAttachments
            ? { attachmentBlock: true, attachmentNames }
            : {}),
          ...(entry.toolCalls !== undefined && entry.toolCalls.length > 0
            ? { toolCalls: entry.toolCalls }
            : {}),
          ...(entry.toolCallId !== undefined ? { toolCallId: entry.toolCallId } : {}),
          ...(entry.name !== undefined ? { name: entry.name } : {}),
        },
      },
      { source: "server" }
    );
  }
}

/**
 * The visible form of a stored user message whose text carried attachments.
 *
 * Removes the block from the first attachment header on, and appends one line
 * naming the files. The model still sees the full stored text; only the panel
 * read is rewritten.
 */
export function stripAttachmentBlock(text: string, names: string[]): string {
  const marker = `\n\n${ATTACHMENT_BLOCK_HEADER}`;
  const at = text.indexOf(marker);
  const visible = at >= 0 ? text.slice(0, at) : text;
  const line =
    names.length > 0 ? `[attached: ${names.join(", ")}]` : "[attached files omitted]";
  return visible.trim() === "" ? line : `${visible}\n\n${line}`;
}

/** A recorded answer and the message it answered. */
export interface RecordedAnswer {
  answer: string;
  /** Hex SHA-256 of the user message, or null for a row written before this. */
  messageHash: string | null;
}

/** Record the clean answer so the same turn id can be replayed. */
export async function recordTurnAnswer(
  session: ConversationSession,
  idempotencyKey: string,
  answer: string,
  messageHash?: string
): Promise<void> {
  await session.appendMessage(
    {
      id: turnAnswerId(idempotencyKey),
      role: "system",
      parts: textParts(answer),
      metadata: {
        turn: idempotencyKey,
        kind: "turn-result",
        ...(messageHash !== undefined && messageHash !== ""
          ? { messageHash }
          : {}),
      },
    },
    { source: "server" }
  );
}

/** The recorded answer and message hash, or null for a new turn. */
export async function readTurnAnswerRecord(
  session: ConversationSession,
  idempotencyKey: string
): Promise<RecordedAnswer | null> {
  const stored = await session.getMessage(turnAnswerId(idempotencyKey));
  if (stored === null) return null;
  const metadata = (stored.metadata ?? {}) as Record<string, unknown>;
  return {
    answer: messageText(stored),
    messageHash:
      typeof metadata.messageHash === "string" ? metadata.messageHash : null,
  };
}

/** The clean answer recorded for a finished turn, or null for a new one. */
export async function readTurnAnswer(
  session: ConversationSession,
  idempotencyKey: string
): Promise<string | null> {
  const stored = await readTurnAnswerRecord(session, idempotencyKey);
  return stored === null ? null : stored.answer;
}

/** Hash of the operator's message, used to bind a key to its text. */
export function messageFingerprint(message: string): Promise<string> {
  return sha256Hex(message);
}

/**
 * Run a turn unless its key already has a recorded answer.
 *
 * `run` is the ONLY place a model call can happen, so a replay that never calls
 * it is a replay that made no second model call. Both the socket turn and
 * `say()` go through this, which is what makes them behave the same.
 */
export async function withRecordedTurn<T>(
  session: ConversationSession,
  idempotencyKey: string,
  run: () => Promise<T>,
  replay: (answer: string) => T
): Promise<T> {
  const answer = await readTurnAnswer(session, idempotencyKey);
  if (answer !== null) return replay(answer);
  return run();
}

/* ─────────────────────── claiming a turn key ────────────────────────────── */

/**
 * How long a claim may live before another caller may take it.
 *
 * A caught failure releases the claim immediately and an evicted fiber is
 * released by `onFiberRecovered`, so this is the backstop for a process that
 * died without either. It must exceed the longest a live turn can run: six
 * model calls at the loop's 60 s timeout, plus tool time.
 */
export const TURN_CLAIM_TTL_MS = 6 * 60_000;

/** How long a loser waits for the winner's answer before it returns busy. */
export const TURN_CLAIM_WAIT_MS = 30_000;

/** How often the loser re-reads the recorded answer while it waits. */
export const TURN_CLAIM_POLL_MS = 100;

/** The claim surface. Real implementation is the object's SQLite; checks use a Map. */
export interface TurnClaimStore {
  /** True for exactly the caller that created (or reclaimed an expired) row. */
  claim(key: string, messageHash: string, now: number, expiresAt: number): Promise<boolean>;
  release(key: string): Promise<void>;
}

export type ClaimedTurn<T> =
  | { status: "ran"; value: T }
  | { status: "replayed"; answer: string }
  | { status: "conflict"; message: string }
  | { status: "busy"; message: string };

/** The 409 sentence both transports use when a key is reused for other text. */
export function keyConflictMessage(idempotencyKey: string): string {
  return (
    `idempotency key "${idempotencyKey}" was already used for a different message; ` +
    "send the original message with that key, or use a new key"
  );
}

/** The bounded refusal a loser gets when the winner has not settled in time. */
export function turnInProgressMessage(idempotencyKey: string): string {
  return (
    `a turn with idempotency key "${idempotencyKey}" is still running; ` +
    `retry after it settles`
  );
}

/**
 * Run one turn at most once per key, even when two requests arrive together.
 *
 * Claim before the work: exactly one caller creates the claim row, and every
 * other caller either replays the answer that is already stored or polls for
 * the winner's answer. The poll is bounded by `waitMs` (30 s) and then returns
 * `busy` rather than hanging. A claim is released on a thrown failure and after
 * every completed run, so a retry can run whether the turn failed or succeeded.
 * A successful run records the answer inside `run`; the claim is then released,
 * because the stored answer — not the claim — is what makes a replay safe.
 */
export async function runClaimedTurn<T>(options: {
  session: ConversationSession;
  key: string;
  messageHash: string;
  claims: TurnClaimStore;
  run: () => Promise<T>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  waitMs?: number;
  pollMs?: number;
}): Promise<ClaimedTurn<T>> {
  const now = options.now ?? (() => Date.now());
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const waitMs = options.waitMs ?? TURN_CLAIM_WAIT_MS;
  const pollMs = Math.max(1, options.pollMs ?? TURN_CLAIM_POLL_MS);

  const recorded = async (): Promise<ClaimedTurn<T> | null> => {
    const stored = await readTurnAnswerRecord(options.session, options.key);
    if (stored === null) return null;
    if (
      stored.messageHash !== null &&
      stored.messageHash !== options.messageHash
    ) {
      return {
        status: "conflict",
        message: keyConflictMessage(options.key),
      };
    }
    return { status: "replayed", answer: stored.answer };
  };

  const already = await recorded();
  if (already !== null) return already;

  const won = await options.claims.claim(
    options.key,
    options.messageHash,
    now(),
    now() + TURN_CLAIM_TTL_MS
  );
  if (!won) {
    const deadline = now() + waitMs;
    for (;;) {
      const settled = await recorded();
      if (settled !== null) return settled;
      const remaining = deadline - now();
      if (remaining <= 0) {
        return {
          status: "busy",
          message: turnInProgressMessage(options.key),
        };
      }
      await sleep(Math.min(pollMs, remaining));
    }
  }

  let value: T;
  try {
    value = await options.run();
  } catch (error) {
    await options.claims.release(options.key);
    throw error;
  }
  await options.claims.release(options.key);
  return { status: "ran", value };
}

/* ─────────────────────── readable conversation (panel) ──────────────────── */

/**
 * What `GET /v1/admin/agent/conversation` returns for one message.
 *
 * Only `user` and `assistant` rows with text are exposed. The `turn-result`
 * `system` marker is the assistant's final answer (kept out of the prompt so a
 * replay marker is never re-sent as conversation); it is presented as an
 * assistant message here. Tool rows and other system rows are skipped.
 */
export interface ConversationReadMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: string;
}

/** The read/clear shape the panel route needs from a session handle. */
export interface ConversationReadSession {
  getRecentHistory(
    maxContentBytes: number
  ): Promise<{ messages: SessionMessage[]; truncated: boolean }>;
  clearMessages(): Promise<void>;
}

/**
 * How much transcript a panel read may hydrate.
 *
 * The route asks for 1–100 messages; 256 KiB covers 100 ordinary turns and
 * bounds the isolate's memory when a turn carried a large attachment. A
 * transcript that exceeds it reports `truncated: true` rather than growing
 * without limit.
 */
export const CONVERSATION_READ_BUDGET_BYTES = 256 * 1024;

/**
 * The newest `limit` readable messages, oldest first.
 *
 * Read through `getRecentHistory` — the same bounded API prompt hydration uses —
 * so this cannot materialise an unbounded transcript inside the object.
 * `truncated` covers both reasons a window can be partial: older rows existed,
 * or readable messages were dropped to fit the byte budget.
 */
export async function readConversationMessages(
  session: ConversationReadSession,
  limit: number,
  budgetBytes: number = CONVERSATION_READ_BUDGET_BYTES
): Promise<{ messages: ConversationReadMessage[]; truncated: boolean }> {
  const cap = Math.max(1, Math.min(100, Math.trunc(limit)));
  const recent = await session.getRecentHistory(budgetBytes);
  const readable: ConversationReadMessage[] = [];
  for (const message of recent.messages) {
    let role: "user" | "assistant";
    if (message.role === "user" || message.role === "assistant") {
      role = message.role;
    } else if (message.role === "system") {
      const metadata = (message.metadata ?? {}) as Record<string, unknown>;
      if (metadata.kind !== "turn-result") continue;
      role = "assistant";
    } else {
      continue;
    }
    const metadata = (message.metadata ?? {}) as Record<string, unknown>;
    const attachmentNames = Array.isArray(metadata.attachmentNames)
      ? metadata.attachmentNames.filter(
          (name): name is string => typeof name === "string" && name !== ""
        )
      : [];
    const raw = messageText(message);
    // A stored turn keeps the file body for the model's next prompt. The panel
    // already has the file, so serve the operator's words plus one naming line.
    const text =
      metadata.attachmentBlock === true
        ? stripAttachmentBlock(raw, attachmentNames)
        : raw;
    if (text.trim() === "") continue;
    // Sessions returns Date for rows written through append(), but an
    // imported row can come back as the ISO string SQLite stored. Accept both.
    const createdAt = message.createdAt;
    const at =
      createdAt instanceof Date
        ? createdAt.toISOString()
        : typeof createdAt === "string"
          ? new Date(createdAt).toISOString()
          : new Date().toISOString();
    readable.push({
      id: message.id,
      role,
      text,
      at,
    });
  }
  return {
    messages: readable.slice(-cap),
    truncated: recent.truncated || readable.length > cap,
  };
}

/** Clear one operator's conversation. A later turn starts a fresh history. */
export async function clearConversationMessages(session: ConversationReadSession): Promise<void> {
  await session.clearMessages();
}

