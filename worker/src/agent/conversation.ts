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

/** Append the entries one turn produced, each under its retry-stable id. */
export async function appendTurnMessages(
  session: ConversationSession,
  idempotencyKey: string,
  entries: ChatMessage[]
): Promise<void> {
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    await session.appendMessage(
      {
        id: turnMessageId(idempotencyKey, index),
        role: entry.role,
        parts: textParts(entry.content),
        metadata: {
          turn: idempotencyKey,
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

/** Record the clean answer so the same turn id can be replayed. */
export async function recordTurnAnswer(
  session: ConversationSession,
  idempotencyKey: string,
  answer: string
): Promise<void> {
  await session.appendMessage(
    {
      id: turnAnswerId(idempotencyKey),
      role: "system",
      parts: textParts(answer),
      metadata: { turn: idempotencyKey, kind: "turn-result" },
    },
    { source: "server" }
  );
}

/** The clean answer recorded for a finished turn, or null for a new one. */
export async function readTurnAnswer(
  session: ConversationSession,
  idempotencyKey: string
): Promise<string | null> {
  const stored = await session.getMessage(turnAnswerId(idempotencyKey));
  return stored === null ? null : messageText(stored);
}
