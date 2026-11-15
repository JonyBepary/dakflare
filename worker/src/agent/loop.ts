/**
 * The agent turn loop — pass 3, stage B.
 *
 * One turn is one model call. The model answers with strict JSON:
 *
 *   { "answer": string, "calls": [ { "tool": string, "input": object } ] }
 *
 * A plain answer (no calls) ends the turn. Calls are executed one at a time,
 * their results are fed back as a user message, and the model is asked again.
 * The loop is bounded twice: at most `maxCalls` (4) calls per turn and at most
 * `maxTurns` (6) turns per session.
 *
 * The model adapter is INJECTED. There is no live model anywhere in this file,
 * which is what makes the loop testable with a fake and keeps the provider
 * decision in `resolveAdapter` where the console already makes it.
 *
 * Every model call charges `opts.budget` — the agent's own counter. The console
 * chat budget is a different table and never appears here.
 */

import type { Env } from "../index";
import type { ChatMessage } from "../lib/ai/types";
import type { AgentActor, AgentBudget, AgentTool, ToolResult } from "./types";
import type { Journal } from "./journal";

export interface ModelAdapter {
  chat(
    messages: ChatMessage[],
    options: { maxOutputTokens?: number; timeoutMs?: number }
  ): Promise<{ text: string; tokensIn?: number; tokensOut?: number }>;
}

export type RunFrame =
  | { type: "token"; text: string }
  | { type: "answer"; text: string }
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
 * room for the thinking and the JSON envelope that follows it.
 */
const MAX_OUTPUT_TOKENS = 2_048;
/** A turn may take longer than a one-shot chat; the loop is the patient path. */
const AGENT_MODEL_TIMEOUT_MS = 60_000;

function estimateTokens(text: string): number {
  return text === "" ? 0 : Math.ceil(text.length / 3);
}

function billed(result: { text: string; tokensIn?: number; tokensOut?: number }, prompt: string): number {
  const input = result.tokensIn ?? estimateTokens(prompt);
  const output = result.tokensOut ?? estimateTokens(result.text);
  return Math.max(0, input) + Math.max(0, output);
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Parse the strict envelope; a non-JSON reply is treated as a plain answer. */
export function parseEnvelope(text: string): {
  answer: string;
  calls: Array<{ tool: string; input: Record<string, unknown> }>;
} {
  const trimmed = text.trim();
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const parsed = asObject(JSON.parse(unfenced.slice(start, end + 1)));
      if (parsed !== null) {
        const answer = typeof parsed.answer === "string" ? parsed.answer : "";
        const rawCalls = Array.isArray(parsed.calls) ? parsed.calls : [];
        const calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
        for (const entry of rawCalls) {
          const record = asObject(entry);
          if (record === null || typeof record.tool !== "string") continue;
          calls.push({ tool: record.tool, input: asObject(record.input) ?? {} });
        }
        return { answer, calls };
      }
    } catch {
      // fall through to the prose answer
    }
  }
  return { answer: trimmed, calls: [] };
}

function buildSystemPrompt(tools: AgentTool[], autonomy?: string): string {
  const manifest = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    kind: tool.kind,
    parameters: tool.parameters,
  }));
  return [
    "You are the DakFlare agent. DakFlare is a self-hosted SMS gateway; one phone is the radio and the Worker is the coordinator.",
    "Answer with strict JSON only, no prose outside it:",
    '{ "answer": string, "calls": [ { "tool": string, "input": object } ] }',
    "A plain answer has an empty calls array. A tool call names one tool from the manifest and an input object.",
    "At most 4 calls per turn. A call whose kind is act performs the effect immediately; the server authorises it and answers with a refusal that names the reason. Do not refuse an act yourself: call it when the autonomy note allows acting, then report what the tool returned.",
    "Never invent an idempotency key, a grant id, a recipient or a flow id. Use only ids the tools returned or the operator supplied.",
    autonomy === undefined || autonomy === ""
      ? "No autonomy note was supplied; act only if a tool result says it succeeded."
      : autonomy,
    "Tool manifest:",
    JSON.stringify(manifest),
  ].join("\n");
}

/**
 * Run one operator message through the loop.
 *
 * The user message is appended before the first model call; tool results are
 * appended as user messages between turns. The caller owns `history` and its
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

  const emit = (frame: RunFrame): void => {
    try {
      opts.onEvent?.(frame);
    } catch {
      // A closed socket must not fail the turn.
    }
  };

  const emitAnswer = (text: string): void => {
    for (let at = 0; at < text.length; at += 48) {
      emit({ type: "token", text: text.slice(at, at + 48) });
    }
    emit({ type: "answer", text });
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

    let result: { text: string; tokensIn?: number; tokensOut?: number };
    try {
      result = await opts.model.chat(messages, {
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        // A tool-capable prompt is larger and the model thinks longer than a
        // one-shot chat; the adapter's 20 s default is not a model failure.
        timeoutMs: AGENT_MODEL_TIMEOUT_MS,
      });
    } catch (error) {
      // A transport failure is not an answer. The caller reports it as a
      // refusal with a reason, and nothing downstream mistakes it for prose.
      opts.onEvent?.({
        type: "error",
        reason: error instanceof Error ? error.name : "model_error",
        message: String(error).slice(0, 200),
      });
      return { answer: "", turns, calls: executed, stopped: "aborted" };
    }
    turns += 1;

    // Charged per model call, before the reply is interpreted. The counter is
    // the agent's, not the console chat budget.
    await opts.budget.chargeTokens(billed(result, promptText));

    if (result.text !== "") emit({ type: "token", text: result.text });

    const envelope = parseEnvelope(result.text);
    history.push({ role: "assistant", content: result.text });
    opts.journal.finishTurn(sessionId, turn);

    if (envelope.calls.length === 0) {
      const answer = envelope.answer || result.text;
      if (answer.trim() === "") {
        // An empty completion is a provider fact, not an answer. Say so instead
        // of returning a blank turn the operator has to guess about.
        opts.onEvent?.({
          type: "error",
          reason: "empty_completion",
          message: "the model returned no text for this turn",
        });
        return { answer: "", turns, calls: executed, stopped: "aborted" };
      }
      emitAnswer(answer);
      return { answer, turns, calls: executed, stopped: "answer" };
    }

    emit({ type: "calls", calls: envelope.calls });

    const batch = envelope.calls.slice(0, maxCalls);
    const withheld = envelope.calls.length - batch.length;
    const fedBack: Array<{ tool: string; result: ToolResult }> = [];

    for (let index = 0; index < batch.length; index++) {
      const call = batch[index];
      const tool = toolsByName.get(call.tool);
      if (tool === undefined) {
        const refusal: ToolResult = {
          ok: false,
          reason: "unknown_tool",
          message: `there is no tool named "${call.tool}"`,
        };
        fedBack.push({ tool: call.tool, result: refusal });
        emit({ type: "tool", tool: call.tool, ok: false, result: refusal });
        continue;
      }

      const callId = `${opts.idempotencyKey}:${turn}:${index}`;
      const ctx = {
        env,
        actor,
        callId,
        journal: opts.journal,
        budget: opts.budget,
        signal,
      };
      let toolResult: ToolResult;
      try {
        toolResult = await tool.execute(call.input, ctx);
      } catch (error) {
        toolResult = {
          ok: false,
          reason: "tool_failed",
          message: `the tool threw: ${String(error).slice(0, 200)}`,
        };
      }
      executed += 1;
      fedBack.push({ tool: call.tool, result: toolResult });
      emit({ type: "tool", tool: call.tool, ok: toolResult.ok, result: toolResult });
    }

    history.push({
      role: "user",
      content:
        `Tool results: ${JSON.stringify(fedBack)}` +
        (withheld > 0
          ? `\n${withheld} call(s) were not executed because this turn allows at most ${maxCalls}.`
          : ""),
    });

    if (turn === maxTurns) {
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
