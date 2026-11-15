/**
 * The agent turn loop — native tool calling.
 *
 * One turn is one model call. The model is given the tool manifest as a native
 * `tools` array and streams prose as it writes it. When the reply carries
 * structured tool calls, the loop executes them through the same journal and
 * authorization path as before, appends an `assistant` message with the calls
 * and one `tool` message per result (the shape every chat-completions provider
 * expects), and asks the model again. A reply with no tool calls is the answer.
 *
 * The old prompt-forced `{"answer":…,"calls":[…]}` envelope is gone: there is
 * no JSON parser and no raw JSON in the panel. A provider that cannot
 * tool-call simply never returns `toolCalls`, so its prose is the answer — the
 * one fallback path. A provider without streaming is supported through
 * `chat()`: the loop emits the finished answer once.
 *
 * The loop is bounded twice: at most `maxCalls` (4) calls per turn and at most
 * `maxTurns` (6) turns per session. A model-supplied call id is never used for
 * idempotency; the loop derives that from `opts.idempotencyKey` and the turn
 * index, so a model cannot choose the key its own effect is deduplicated on.
 *
 * The model adapter is INJECTED. There is no live model anywhere in this file,
 * which is what makes the loop testable with a fake and keeps the provider
 * decision in `resolveAdapter` where the console already makes it.
 *
 * Every model call charges `opts.budget` — the agent's own counter. The console
 * chat budget is a different table and never appears here.
 */

import type { Env } from "../index";
import type {
  ChatMessage,
  ChatStreamEvent,
  ChatToolCall,
  ChatToolDefinition,
} from "../lib/ai/types";
import type { AgentActor, AgentBudget, AgentTool, ToolResult } from "./types";
import type { Journal } from "./journal";

/** What a model call returns; a subset of the adapter's `ChatResult`. */
export interface ModelReply {
  text: string;
  tokensIn?: number;
  tokensOut?: number;
  toolCalls?: ChatToolCall[];
}

export interface ModelAdapter {
  chat(
    messages: ChatMessage[],
    options: { maxOutputTokens?: number; timeoutMs?: number; tools?: ChatToolDefinition[] }
  ): Promise<ModelReply>;
  /** Optional. Without it the loop calls `chat()` and emits the answer once. */
  chatStream?(
    messages: ChatMessage[],
    options: { maxOutputTokens?: number; timeoutMs?: number; tools?: ChatToolDefinition[] },
    onEvent: (event: ChatStreamEvent) => void
  ): Promise<ModelReply>;
}

export type RunFrame =
  | { type: "token"; text: string }
  | { type: "answer"; text: string }
  | { type: "status"; phase: string }
  | { type: "tool"; tool: string; ok: boolean; result: ToolResult }
  | { type: "calls"; calls: Array<{ tool: string; input: Record<string, unknown> }> }
  | { type: "error"; reason: string; message: string };

export interface RunTurnOptions {
  model: ModelAdapter;
  journal: Journal;
  budget: AgentBudget;
  /** Server-held idempotency key; never model-supplied. */
  idempotencyKey: string;
  signal?: AbortSignal;
  /** Conversation so far. Appended in place; the caller persists it. */
  history?: ChatMessage[];
  maxCalls?: number;
  maxTurns?: number;
  /**
   * How often a `waiting` status is emitted while a model call is in flight.
   * Defaults to 10 s: a silent WebSocket is dropped by idle proxies and some
   * browsers well before a slow reasoning turn returns.
   */
  heartbeatMs?: number;
  onEvent?: (frame: RunFrame) => void;
  /**
   * What the model may do this turn, in the gateway's own words: whether
   * autonomy is on, until when, and what is left of today's caps. Without it the
   * model refuses acts it is allowed to take, because it cannot see grants.
   */
  autonomyNote?: string;
}

export interface RunTurnResult {
  answer: string;
  turns: number;
  calls: number;
  stopped: "answer" | "turn_cap" | "aborted";
}

const DEFAULT_MAX_CALLS = 4;
const DEFAULT_MAX_TURNS = 6;
/**
 * Reasoning models spend output budget before they write the answer: with 1024
 * the visible content came back empty while the turn still billed. 2048 leaves
 * room for the thinking that precedes the first token.
 */
const MAX_OUTPUT_TOKENS = 2_048;
/** A turn may take longer than a one-shot chat; the loop is the patient path. */
const AGENT_MODEL_TIMEOUT_MS = 60_000;
/**
 * A model call can think for most of a minute. A socket that says nothing for
 * that long is dropped by idle proxies and some browsers, and the panel shows
 * a stalled link. This is the default cadence of the `waiting` status frame.
 */
export const WAITING_HEARTBEAT_MS = 10_000;

function estimateTokens(text: string): number {
  return text === "" ? 0 : Math.ceil(text.length / 3);
}

function billed(result: ModelReply, prompt: string): number {
  const input = result.tokensIn ?? estimateTokens(prompt);
  const output = result.tokensOut ?? estimateTokens(result.text);
  return Math.max(0, input) + Math.max(0, output);
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Parse a provider-supplied `function.arguments` string defensively.
 *
 * Providers send this as a JSON string, and a small model can send malformed
 * JSON or a non-object. That is a fact about the call, not a crash: the caller
 * turns a failure into a `bad_arguments` tool result the model can read.
 */
function parseArguments(raw: string):
  | { ok: true; input: Record<string, unknown> }
  | { ok: false; message: string } {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (trimmed === "") return { ok: true, input: {} };
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const object = asObject(parsed);
    if (object === null) {
      return { ok: false, message: "the tool arguments were not a JSON object" };
    }
    return { ok: true, input: object };
  } catch (error) {
    return {
      ok: false,
      message: `the tool arguments were not valid JSON: ${String(error).slice(0, 120)}`,
    };
  }
}

/** Arguments for the `calls` frame, which is presentation only. */
function previewArguments(raw: string): Record<string, unknown> {
  const parsed = parseArguments(raw);
  return parsed.ok ? parsed.input : {};
}

function buildSystemPrompt(tools: AgentTool[], autonomy?: string): string {
  const manifest = tools.map((tool) => `${tool.name} (${tool.kind}) — ${tool.description}`);
  return [
    "You are the DakFlare agent. DakFlare is a self-hosted SMS gateway; one phone is the radio and the Worker is the coordinator.",
    "Use the provided tools when the operator's request needs data or an action. If no tool is needed, answer in plain prose. Do not wrap the answer in JSON and do not print a tool call as text.",
    "Do not announce work: never answer \"I will check…\", \"let me look…\" or \"checking…\" without calling the tool in the same turn. Either call it, or state plainly that no tool covers the question.",
    "At most 4 tool calls per turn. A tool whose kind is act performs the effect immediately; the server authorises it and returns a refusal that names the reason. Do not refuse an act yourself: call it when the autonomy note allows acting, then report what the tool returned.",
    "Never invent an idempotency key, a grant id, a recipient or a flow id. Use only ids the tools returned or the operator supplied.",
    autonomy === undefined || autonomy === ""
      ? "No autonomy note was supplied; act only if a tool result says it succeeded."
      : autonomy,
    "Available tools:",
    manifest.join("\n"),
  ].join("\n");
}

/**
 * Run one operator message through the loop.
 *
 * The user message is appended before the first model call; tool results are
 * appended as `tool` messages between turns. The caller owns `history` and its
 * persistence.
 */
export async function runTurn(
  env: Env,
  actor: AgentActor,
  sessionId: string,
  message: string,
  tools: AgentTool[],
  opts: RunTurnOptions
): Promise<RunTurnResult> {
  const maxCalls = Math.max(1, opts.maxCalls ?? DEFAULT_MAX_CALLS);
  const maxTurns = Math.max(1, opts.maxTurns ?? DEFAULT_MAX_TURNS);
  const history = opts.history ?? [];
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
  const signal = opts.signal ?? new AbortController().signal;
  const toolDefinitions: ChatToolDefinition[] = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));

  const emit = (frame: RunFrame): void => {
    try {
      opts.onEvent?.(frame);
    } catch {
      // A closed socket must not fail the turn.
    }
  };

  /**
   * The terminal marker. Token deltas already reached the operator through
   * `token` frames; the answer frame carries the same text once at the end so
   * a resume has one definitive value.
   */
  const emitAnswer = (text: string): void => {
    emit({ type: "status", phase: "answering" });
    emit({ type: "answer", text });
  };

  const invokeModel = async (
    messages: ChatMessage[],
    onToken: (event: ChatStreamEvent) => void
  ): Promise<ModelReply> => {
    const options = {
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      timeoutMs: AGENT_MODEL_TIMEOUT_MS,
      tools: toolDefinitions,
    };
    if (typeof opts.model.chatStream === "function") {
      return await opts.model.chatStream(messages, options, onToken);
    }
    return await opts.model.chat(messages, options);
  };

  history.push({ role: "user", content: message });

  const firstTurn = opts.journal.nextTurn(sessionId);
  if (firstTurn > maxTurns) {
    const answer = `turn cap reached (${maxTurns} turns per session)`;
    emitAnswer(answer);
    return { answer, turns: 0, calls: 0, stopped: "turn_cap" };
  }

  const systemPrompt = buildSystemPrompt(tools, opts.autonomyNote);
  let turns = 0;
  let executed = 0;

  for (let turn = firstTurn; turn <= maxTurns; turn++) {
    if (signal.aborted) {
      return { answer: "aborted", turns, calls: executed, stopped: "aborted" };
    }

    opts.journal.setTurn(sessionId, turn);
    const messages: ChatMessage[] = [{ role: "system", content: systemPrompt }, ...history];
    const promptText = messages.map((entry) => entry.content).join("\n");

    let result: ModelReply;
    let streamed = "";
    const onToken = (event: ChatStreamEvent): void => {
      if (event.type !== "token" || event.text === "") return;
      streamed += event.text;
      emit({ type: "token", text: event.text });
    };

    // Announced before the wait, so a slow model call shows as work rather
    // than a stalled link.
    emit({ type: "status", phase: "thinking" });
    const heartbeat = setInterval(
      () => emit({ type: "status", phase: "waiting" }),
      Math.max(1, opts.heartbeatMs ?? WAITING_HEARTBEAT_MS)
    );
    try {
      result = await invokeModel(messages, onToken);
    } catch (first) {
      // A provider that is momentarily at capacity is not a failed turn. One
      // retry after a short pause covers the "at capacity" answers seen live,
      // and an auth or format error still fails immediately.
      const reason = first instanceof Error && "reason" in first ? String(first.reason) : "";
      const retryable = reason === "provider_rate_limited" || reason === "provider_unavailable";
      if (retryable) {
        await new Promise((resolve) => setTimeout(resolve, 900));
        try {
          // Tokens from the failed attempt were already shown; do not repeat
          // them on the retry or the operator sees the same sentence twice.
          result = await invokeModel(messages, () => {});
        } catch (second) {
          opts.onEvent?.({
            type: "error",
            reason: second instanceof Error && "reason" in second ? String(second.reason) : "model_error",
            message: String(second).slice(0, 200),
          });
          return { answer: "", turns, calls: executed, stopped: "aborted" };
        }
      } else {
        opts.onEvent?.({
          type: "error",
          reason: first instanceof Error ? first.name : "model_error",
          message: String(first).slice(0, 200),
        });
        return { answer: "", turns, calls: executed, stopped: "aborted" };
      }
    } finally {
      clearInterval(heartbeat);
    }

    turns += 1;

    // A model that answers "I'll check…" without a tool call has done nothing.
    // One nudge, bounded, only when no tool has run yet in this turn.
    const promises = /^\s*(i('| wi)ll|let me|checking|looking|i am going to|i'm going to)\b/i.test(
      result.text.trim()
    );
    if (promises && (result.toolCalls?.length ?? 0) === 0 && executed === 0) {
      messages.push({
        role: "user",
        content:
          "You answered that you would look, but no tool was called. Call the tool now, " +
          "or say plainly that no tool covers it.",
      });
      continue;
    }

    // Charged per model call, before the reply is interpreted. The counter is
    // the agent's, not the console chat budget.
    await opts.budget.chargeTokens(billed(result, promptText));

    // A streaming adapter may have returned an empty `text` if it only counted
    // deltas; the deltas it emitted are the same answer.
    const replyText = result.text !== "" ? result.text : streamed;
    const toolCalls = result.toolCalls ?? [];
    opts.journal.finishTurn(sessionId, turn);

    if (toolCalls.length === 0) {
      if (replyText.trim() === "") {
        // An empty completion is a provider fact, not an answer. Say so instead
        // of returning a blank turn the operator has to guess about.
        opts.onEvent?.({
          type: "error",
          reason: "empty_completion",
          message: "the model returned no text for this turn",
        });
        return { answer: "", turns, calls: executed, stopped: "aborted" };
      }
      emitAnswer(replyText);
      return { answer: replyText, turns, calls: executed, stopped: "answer" };
    }

    // The assistant message carries the calls so each `tool` result below has
    // a matching `tool_call_id` in the next request.
    history.push({ role: "assistant", content: replyText, toolCalls });
    emit({
      type: "calls",
      calls: toolCalls.map((call) => ({
        tool: call.name,
        input: previewArguments(call.arguments),
      })),
    });

    const capMessage = `this turn allows at most ${maxCalls} calls; this one was not executed`;

    for (let index = 0; index < toolCalls.length; index++) {
      const call = toolCalls[index];
      let toolResult: ToolResult;

      if (index >= maxCalls) {
        // The assistant message above named every call, so every call needs a
        // tool response or the next request is malformed. A withheld call gets
        // a refusal rather than silence.
        toolResult = { ok: false, reason: "call_cap", message: capMessage };
      } else {
        const parsedArguments = parseArguments(call.arguments);
        if (!parsedArguments.ok) {
          toolResult = {
            ok: false,
            reason: "bad_arguments",
            message: parsedArguments.message,
          };
        } else {
          const tool = toolsByName.get(call.name);
          if (tool === undefined) {
            toolResult = {
              ok: false,
              reason: "unknown_tool",
              message: `there is no tool named "${call.name}"`,
            };
          } else {
            emit({ type: "status", phase: `tool:${call.name}` });
            const callId = `${opts.idempotencyKey}:${turn}:${index}`;
            const ctx = {
              env,
              actor,
              callId,
              journal: opts.journal,
              budget: opts.budget,
              signal,
            };
            try {
              toolResult = await tool.execute(parsedArguments.input, ctx);
            } catch (error) {
              toolResult = {
                ok: false,
                reason: "tool_failed",
                message: `the tool threw: ${String(error).slice(0, 200)}`,
              };
            }
            executed += 1;
          }
        }
      }

      history.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        content: JSON.stringify(toolResult),
      });
      emit({ type: "tool", tool: call.name, ok: toolResult.ok, result: toolResult });
    }

    if (turn === maxTurns) {
      const withheld = toolCalls.length - Math.min(toolCalls.length, maxCalls);
      const answer =
        withheld > 0
          ? `turn cap reached (${maxTurns} turns per session); ${withheld} call(s) were not executed`
          : `turn cap reached (${maxTurns} turns per session)`;
      emitAnswer(answer);
      return { answer, turns, calls: executed, stopped: "turn_cap" };
    }
  }

  const answer = `turn cap reached (${maxTurns} turns per session)`;
  emitAnswer(answer);
  return { answer, turns, calls: executed, stopped: "turn_cap" };
}
