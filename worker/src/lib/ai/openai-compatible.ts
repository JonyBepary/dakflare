/**
 * OpenAI-compatible chat adapter (`POST {baseUrl}/chat/completions`).
 *
 * This is the escape hatch for a self-hoster who wants a hosted model that is
 * not Workers AI: OpenAI, Together, Groq, an Ollama or vLLM box on localhost.
 * It speaks the one shape all of them share.
 *
 * Three rules that are load-bearing:
 *
 *   1. The key is read from `AI_CHAT_API_KEY` and never logged, echoed or
 *      stored. It goes into exactly one header.
 *   2. The call is time-boxed at 20 s. A Worker has its own wall clock, but a
 *      hung provider would hold a request (and a budget reservation) open, so
 *      the adapter aborts first. The agent loop asks for 60 s because a turn
 *      may think longer than a one-shot chat.
 *   3. A non-2xx body is NOT returned. Provider error bodies routinely quote the
 *      request, which is the operator's prompt and possibly console context;
 *      only the status is surfaced.
 *
 * Native tool calling: the adapter forwards `tools` as the function manifest
 * and `tool_choice: "auto"`, then reads `message.tool_calls` as structured
 * objects. `chatStream` adds `stream: true` and forwards `delta.content` as
 * token deltas while accumulating `delta.tool_calls[]` by index. A provider
 * that ignores `stream` and answers JSON is handled by the same body parser.
 */

import type {
  ChatAdapter,
  ChatMessage,
  ChatOptions,
  ChatResult,
  ChatStreamEvent,
  ChatToolCall,
  ChatToolDefinition,
} from "./types";
import { ChatAdapterError, clampOutputTokens, readTokenCount } from "./types";

const DEFAULT_TIMEOUT_MS = 20_000;

export interface OpenAiCompatibleOptions {
  /** Origin only, no trailing slash. Validated by the settings route. */
  baseUrl: string;
  apiKey: string;
  model: string;
}

interface OpenAiContentPart {
  type?: unknown;
  text?: unknown;
}

interface OpenAiFunctionCall {
  name?: unknown;
  arguments?: unknown;
}

interface OpenAiToolCall {
  index?: unknown;
  id?: unknown;
  function?: OpenAiFunctionCall;
}

interface OpenAiMessage {
  content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: unknown;
}

interface OpenAiChoice {
  message?: OpenAiMessage;
  delta?: OpenAiMessage;
  finish_reason?: unknown;
}

interface OpenAiResponse {
  choices?: OpenAiChoice[];
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
  };
}

/** `content` is a string for most providers and a part list for a few. */
function extractContent(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return null;
  const parts: string[] = [];
  for (const part of value) {
    if (part !== null && typeof part === "object") {
      const text = (part as OpenAiContentPart).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.length === 0 ? null : parts.join("");
}

/** One tool call object, tolerant of the shapes providers return. */
function readToolCall(value: unknown, index: number): ChatToolCall | null {
  if (value === null || typeof value !== "object") return null;
  const entry = value as OpenAiToolCall;
  const fn = entry.function;
  if (fn === null || typeof fn !== "object" || typeof fn.name !== "string") return null;
  const rawArguments = fn.arguments;
  const args =
    typeof rawArguments === "string"
      ? rawArguments
      : rawArguments === undefined || rawArguments === null
        ? ""
        : JSON.stringify(rawArguments);
  const id =
    typeof entry.id === "string" && entry.id !== ""
      ? entry.id
      : `call_${index}`;
  return { id, name: fn.name, arguments: args };
}

function readToolCalls(value: unknown): ChatToolCall[] {
  if (!Array.isArray(value)) return [];
  const calls: ChatToolCall[] = [];
  value.forEach((entry, index) => {
    const call = readToolCall(entry, index);
    if (call !== null) calls.push(call);
  });
  return calls;
}

/**
 * The provider's own error sentence, when it sent one.
 *
 * Bounded and shape-guarded: `{ error: { message } }`, `{ message }`, or
 * `{ error: "text" }`. Everything else is dropped, so a provider that echoes
 * the request body cannot put the prompt (or a key) into our error path.
 */
async function readProviderMessage(response: Response): Promise<string | null> {
  try {
    const text = await response.text();
    if (text === "" || text.length > 8_000) return null;
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    const inner = record.error;
    const message =
      typeof record.message === "string"
        ? record.message
        : inner !== null && typeof inner === "object"
          ? (inner as { message?: unknown }).message
          : inner;
    if (typeof message !== "string") return null;
    const trimmed = message.trim();
    return trimmed === "" ? null : trimmed.slice(0, 200);
  } catch {
    return null;
  }
}

function providerError(status: number, detail: string | null, retryAfter: string | null): ChatAdapterError {
  if (status === 429) {
    return new ChatAdapterError(
      "provider_rate_limited",
      detail ?? "the provider is rate limiting this key",
      retryAfter ?? undefined
    );
  }
  if (status === 401 || status === 403) {
    return new ChatAdapterError(
      "provider_auth",
      detail ?? `the provider refused the key (HTTP ${status})`
    );
  }
  return new ChatAdapterError(
    "provider_unavailable",
    detail ?? `the provider answered ${status}`
  );
}

function requestMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  return messages.map((message) => {
    if (message.role === "tool") {
      return {
        role: "tool",
        tool_call_id: message.toolCallId ?? "",
        content: message.content,
      };
    }
    if (message.role === "assistant" && message.toolCalls !== undefined && message.toolCalls.length > 0) {
      return {
        role: "assistant",
        // OpenAI wants null here when the turn is only tool calls; an empty
        // string is accepted too but null is the documented shape.
        content: message.content === "" ? null : message.content,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        })),
      };
    }
    return { role: message.role, content: message.content };
  });
}

function requestTools(tools: ChatToolDefinition[] | undefined): Array<Record<string, unknown>> | undefined {
  if (tools === undefined || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function requestBody(
  model: string,
  messages: ChatMessage[],
  opts: ChatOptions,
  stream: boolean
): Record<string, unknown> {
  const tools = requestTools(opts.tools);
  return {
    model,
    messages: requestMessages(messages),
    max_tokens: clampOutputTokens(opts.maxOutputTokens),
    ...(opts.temperature === undefined ? {} : { temperature: opts.temperature }),
    ...(tools === undefined ? {} : { tools, tool_choice: "auto" }),
    ...(stream ? { stream: true } : {}),
  };
}

function resultFromResponse(body: unknown, model: string, options: OpenAiCompatibleOptions): ChatResult {
  const parsed = (body !== null && typeof body === "object" ? body : {}) as OpenAiResponse;
  const choice = parsed.choices?.[0];
  const content = extractContent(choice?.message?.content) ?? "";
  const toolCalls = readToolCalls(choice?.message?.tool_calls);
  if (content === "" && toolCalls.length === 0) {
    throw new ChatAdapterError("unparseable", "the provider returned no message content");
  }
  return {
    text: content,
    tokensIn: readTokenCount(parsed.usage?.prompt_tokens),
    tokensOut: readTokenCount(parsed.usage?.completion_tokens),
    ...(toolCalls.length === 0 ? {} : { toolCalls }),
    ...(typeof choice?.finish_reason === "string" ? { finishReason: choice.finish_reason } : {}),
    model: options.model,
    provider: "openai-compatible",
  };
}

interface AccumulatedToolCall {
  id: string;
  name: string;
  arguments: string;
}

interface StreamAccumulator {
  text: string;
  calls: Map<number, AccumulatedToolCall>;
  tokensIn?: number;
  tokensOut?: number;
  finishReason?: string;
  done: boolean;
  /** Characters the model spent thinking (`reasoning`/`reasoning_content`). */
  reasoningChars?: number;
}

function applyStreamEvent(state: StreamAccumulator, data: string, onEvent: (event: ChatStreamEvent) => void): void {
  if (data === "[DONE]") {
    state.done = true;
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return;
  }
  if (parsed === null || typeof parsed !== "object") return;
  const record = parsed as OpenAiResponse & { error?: unknown };
  // `usage: null` is what several gateways send on every streaming chunk (the
  // real counts arrive in the last one). Guarding only `undefined` made every
  // event throw, which surfaced as "the provider streamed no content".
  const usage = record.usage;
  if (usage !== undefined && usage !== null) {
    const input = readTokenCount(usage.prompt_tokens);
    const output = readTokenCount(usage.completion_tokens);
    if (input !== undefined) state.tokensIn = input;
    if (output !== undefined) state.tokensOut = output;
  }
  const choice = record.choices?.[0];
  if (choice === undefined) return;
  if (typeof choice.finish_reason === "string" && choice.finish_reason !== "") {
    state.finishReason = choice.finish_reason;
    // The turn is complete even if the provider keeps the socket open. The
    // reader stops here rather than waiting for a `[DONE]` that may not come.
    state.done = true;
  }
  const delta = choice.delta ?? choice.message;
  // A reasoning model emits its thinking first, in `reasoning` (Token Lab's
  // Qwen/DeepSeek) or `reasoning_content`. It is not the answer: count it so an
  // empty answer can say "the model reasoned but never answered" instead of
  // "no content".
  const reasoning = (delta as { reasoning?: unknown; reasoning_content?: unknown } | undefined);
  for (const value of [reasoning?.reasoning, reasoning?.reasoning_content]) {
    if (typeof value === "string") state.reasoningChars = (state.reasoningChars ?? 0) + value.length;
  }
  const content = extractContent(delta?.content);
  if (content !== null && content !== "") {
    state.text += content;
    onEvent({ type: "token", text: content });
  }
  if (Array.isArray(delta?.tool_calls)) {
    for (const entry of delta.tool_calls) {
      if (entry === null || typeof entry !== "object") continue;
      const call = entry as OpenAiToolCall;
      const index = typeof call.index === "number" ? call.index : state.calls.size;
      const existing = state.calls.get(index) ?? { id: "", name: "", arguments: "" };
      if (typeof call.id === "string" && call.id !== "") existing.id = call.id;
      if (call.function !== undefined && call.function !== null) {
        if (typeof call.function.name === "string" && call.function.name !== "") {
          existing.name = call.function.name;
        }
        const fragment = call.function.arguments;
        if (typeof fragment === "string") existing.arguments += fragment;
        else if (fragment !== undefined && fragment !== null) existing.arguments += JSON.stringify(fragment);
      }
      state.calls.set(index, existing);
    }
  }
}

export function createOpenAiCompatibleAdapter(
  options: OpenAiCompatibleOptions
): ChatAdapter {
  const endpoint = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  const send = async (messages: ChatMessage[], opts: ChatOptions, stream: boolean): Promise<Response> => {
    const timeoutMs =
      typeof opts.timeoutMs === "number" && opts.timeoutMs > 0
        ? Math.trunc(opts.timeoutMs)
        : DEFAULT_TIMEOUT_MS;
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify(requestBody(options.model, messages, opts, stream)),
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (name === "TimeoutError" || name === "AbortError") {
        throw new ChatAdapterError(
          "timeout",
          `the provider did not answer within ${Math.round(timeoutMs / 1000)} s`
        );
      }
      throw new ChatAdapterError(
        "provider_unavailable",
        `the provider could not be reached: ${String(error).slice(0, 200)}`
      );
    }

    if (!response.ok) {
      // The status decides the reason, and the provider's own sentence is
      // worth showing: "Invalid API key" and "quota exceeded" are two
      // different operator actions. Only `error.message` is read, never the
      // raw body and never a header, so nothing can quote the prompt or the
      // key back at us.
      const detail = await readProviderMessage(response);
      throw providerError(response.status, detail, response.headers.get("retry-after"));
    }
    return response;
  };

  return {
    kind: "openai-compatible",

    async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
      const response = await send(messages, opts, false);
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new ChatAdapterError("unparseable", "the provider returned a non-JSON body");
      }
      return resultFromResponse(body, options.model, options);
    },

    async chatStream(
      messages: ChatMessage[],
      opts: ChatOptions = {},
      onEvent: (event: ChatStreamEvent) => void
    ): Promise<ChatResult> {
      const response = await send(messages, opts, true);

      // A provider that ignores `stream` answers with one JSON document. The
      // same parser handles it; its prose is emitted once, at the end.
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("text/event-stream") || response.body === null) {
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          throw new ChatAdapterError("unparseable", "the provider returned a non-JSON body");
        }
        const result = resultFromResponse(body, options.model, options);
        if (result.text !== "") onEvent({ type: "token", text: result.text });
        return result;
      }

      const state: StreamAccumulator = { text: "", calls: new Map(), done: false };
      // The first bytes verbatim: an empty stream is only diagnosable if we can
      // say what the provider actually sent (an error object inside a 200, a
      // gateway notice, an SSE dialect we do not split).
      let rawHead = "";
      let eventFailure = "";
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      // One `data:` line is one event. The SSE spec allows a blank line between
      // events, but providers differ on the separator (\n vs \r\n vs a single
      // newline), and splitting on a blank line silently produced zero events
      // against a provider that streams valid single-line chunks. Line-oriented
      // parsing handles every dialect we have observed.
      const drain = (flush: boolean): boolean => {
        buffer = buffer.replace(/\r\n/g, "\n");
        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line.startsWith("data:")) {
            const data = line.slice(5).trim();
            if (data !== "") {
              try {
                applyStreamEvent(state, data, onEvent);
              } catch (error) {
                if (eventFailure === "") eventFailure = String(error).slice(0, 120);
              }
            }
            if (state.done) return true;
          }
          newline = buffer.indexOf("\n");
        }
        if (flush) {
          const line = buffer.trim();
          buffer = "";
          if (line.startsWith("data:")) {
            const data = line.slice(5).trim();
            if (data !== "") {
              try {
                applyStreamEvent(state, data, onEvent);
              } catch (error) {
                if (eventFailure === "") eventFailure = String(error).slice(0, 120);
              }
            }
          }
        }
        return state.done;
      };

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          if (rawHead.length < 400) rawHead += chunk.slice(0, 400 - rawHead.length);
          buffer += chunk;
          if (drain(false)) {
            // `finish_reason` or `[DONE]`: stop reading and release the stream.
            await reader.cancel().catch(() => {});
            break;
          }
        }
        if (!state.done) {
          buffer += decoder.decode();
          drain(true);
        }
      } catch (error) {
        // A mid-stream abort is not a lost turn: whatever prose and calls
        // arrived are still usable, so return them with the reason. Only a
        // stream that produced nothing at all becomes a failure.
        const name = error instanceof Error ? error.name : "";
        const reason = name === "TimeoutError" ? "timeout" : "aborted";
        const partialCalls = [...state.calls.entries()]
          .sort(([a], [b]) => a - b)
          .map(([index, call]) => ({
            id: call.id === "" ? `call_${index}` : call.id,
            name: call.name,
            arguments: call.arguments,
          }))
          .filter((call) => call.name !== "");
        if (state.text === "" && partialCalls.length === 0) {
          if (reason === "timeout") {
            throw new ChatAdapterError("timeout", "the provider stopped streaming before any content");
          }
          // An unusable stream is a transport fact, not a lost turn: ask once
          // without streaming, which every gateway we support also serves.
          try {
            const fallback = await send(messages, opts, false);
            const body: unknown = await fallback.json();
            const result = resultFromResponse(body, options.model, options);
            if (result.text !== "") onEvent({ type: "token", text: result.text });
            return result;
          } catch {
            throw new ChatAdapterError(
              "provider_unavailable",
              "the stream ended before any content (" +
                (eventFailure || "no events applied") +
                ((state.reasoningChars ?? 0) > 0
                  ? `; the model streamed ${state.reasoningChars ?? 0} characters of reasoning and no answer, so its budget went to thinking`
                  : "") +
                "): " +
                rawHead.replace(/\s+/g, " ").slice(0, 160)
            );
          }
        }
        return {
          text: state.text,
          tokensIn: state.tokensIn,
          tokensOut: state.tokensOut,
          ...(partialCalls.length === 0 ? {} : { toolCalls: partialCalls }),
          finishReason: reason,
          model: options.model,
          provider: "openai-compatible",
        };
      }

      const toolCalls = [...state.calls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([index, call]) => ({
          id: call.id === "" ? `call_${index}` : call.id,
          name: call.name,
          arguments: call.arguments,
        }))
        .filter((call) => call.name !== "");

      if (state.text === "" && toolCalls.length === 0) {
        throw new ChatAdapterError(
          "unparseable",
          "the provider streamed no message content (" +
            (eventFailure || "no events applied") +
            (state.reasoningChars ? `; ${state.reasoningChars} chars of reasoning` : "") +
            "): " +
            rawHead.replace(/\s+/g, " ").slice(0, 200)
        );
      }

      return {
        text: state.text,
        tokensIn: state.tokensIn,
        tokensOut: state.tokensOut,
        ...(toolCalls.length === 0 ? {} : { toolCalls }),
        ...(state.finishReason === undefined ? {} : { finishReason: state.finishReason }),
        model: options.model,
        provider: "openai-compatible",
      };
    },
  };
}
