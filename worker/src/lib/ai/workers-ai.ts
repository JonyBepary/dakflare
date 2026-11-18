/**
 * Cloudflare Workers AI adapter.
 *
 * The binding is `env.AI` (see `[ai] binding = "AI"` in the wrangler configs).
 * The model is a settings value, defaulting to
 * `@cf/meta/llama-3.3-70b-instruct-fp8-fast`.
 *
 * Why a narrow interface instead of the ambient `Ai` type: `Ai.run` is a set of
 * model-name-keyed overloads, so calling it with a runtime string needs a cast
 * somewhere. Keeping the cast here means the route and the registry never see
 * it, and the surface this adapter depends on stays one method.
 *
 * Usage: Workers AI reports `usage.prompt_tokens` / `usage.completion_tokens`
 * for models that bill per token and omits `usage` for models that do not. Both
 * are honest answers, so both are passed through and the route estimates only
 * when a value is absent.
 *
 * Tools and streaming: the installed `@cloudflare/workers-types` declares both
 * `AiTextGenerationInput.tools` (function manifest) and `.stream`, so this
 * adapter forwards `tools` and, in `chatStream`, `stream: true`. Not every
 * Workers AI model implements tool calling, and the binding answers in one of
 * two shapes: chat-completions (`choices[0].message`) or the classic text shape
 * (`{ response, tool_calls }`). A model that ignores either option falls back
 * through the non-streaming parse path below: `chatStream` still works and
 * emits the finished text once, and a model that cannot tool-call returns prose
 * with no `toolCalls`. There is no second prompt parser.
 */

import type {
  ChatAdapter,
  ChatMessage,
  ChatOptions,
  ChatResult,
  ChatStreamEvent,
  ChatToolCall,
} from "./types";
import { ChatAdapterError, clampOutputTokens, readTokenCount } from "./types";

/** The slice of the AI binding this adapter uses. */
export interface WorkersAiBinding {
  run(model: string, input: unknown): Promise<unknown>;
}

interface WorkersAiUsage {
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
}

interface WorkersAiResult {
  response?: unknown;
  tool_calls?: unknown;
  usage?: WorkersAiUsage;
  choices?: unknown;
}

interface WorkersAiToolCall {
  index?: unknown;
  id?: unknown;
  name?: unknown;
  arguments?: unknown;
  function?: { name?: unknown; arguments?: unknown };
}

/** The text in whichever of the three shapes the binding answered with. */
function readText(raw: unknown): string | null {
  if (typeof raw === "string") return raw;
  if (raw === null || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.response === "string") return record.response;
  const choices = record.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const choice = choices[0];
    if (typeof choice === "string") return choice;
    if (choice !== null && typeof choice === "object") {
      const entry = choice as { text?: unknown; message?: unknown };
      if (typeof entry.text === "string") return entry.text;
      const message = entry.message;
      if (message !== null && typeof message === "object") {
        const content = (message as { content?: unknown }).content;
        if (typeof content === "string") return content;
        // A part list, as some providers return `[{type:"text", text:"…"}]`.
        if (Array.isArray(content)) {
          const joined = content
            .map((part) =>
              part !== null && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
                ? ((part as { text: string }).text)
                : ""
            )
            .join("");
          if (joined !== "") return joined;
        }
      }
    }
  }
  return null;
}

function readOneToolCall(value: unknown, index: number): ChatToolCall | null {
  if (value === null || typeof value !== "object") return null;
  const entry = value as WorkersAiToolCall;
  // Newer shape: { id, type, function: { name, arguments } }.
  // Classic shape: { name, arguments: object|string }.
  const name =
    typeof entry.function?.name === "string"
      ? entry.function.name
      : typeof entry.name === "string"
        ? entry.name
        : null;
  if (name === null) return null;
  const rawArguments =
    entry.function !== undefined ? entry.function.arguments : entry.arguments;
  const args =
    typeof rawArguments === "string"
      ? rawArguments
      : rawArguments === undefined || rawArguments === null
        ? ""
        : JSON.stringify(rawArguments);
  const id =
    typeof entry.id === "string" && entry.id !== "" ? entry.id : `call_${index}`;
  return { id, name, arguments: args };
}

/** Tool calls from either the top-level classic shape or a chat message. */
function readToolCalls(raw: unknown): ChatToolCall[] {
  if (raw === null || typeof raw !== "object") return [];
  const record = raw as WorkersAiResult;
  let value: unknown = record.tool_calls;
  if (value === undefined) {
    const choices = record.choices;
    if (Array.isArray(choices) && choices.length > 0) {
      const first = choices[0];
      if (first !== null && typeof first === "object") {
        const message = (first as { message?: unknown }).message;
        if (message !== null && typeof message === "object") {
          value = (message as { tool_calls?: unknown }).tool_calls;
        }
      }
    }
  }
  if (!Array.isArray(value)) return [];
  const calls: ChatToolCall[] = [];
  value.forEach((entry, index) => {
    const call = readOneToolCall(entry, index);
    if (call !== null) calls.push(call);
  });
  return calls;
}

function readUsage(raw: unknown): WorkersAiUsage | undefined {
  return raw !== null && typeof raw === "object" ? (raw as WorkersAiResult).usage : undefined;
}

function inputMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  return messages.map((message) => {
    if (message.role === "tool") {
      // Workers AI's `RoleScopedChatInput` supports role "tool", optional `name`,
      // and OpenAI-compatible models also read `tool_call_id`.
      return {
        role: "tool",
        content: message.content,
        name: message.name ?? "",
        ...(message.toolCallId !== undefined ? { tool_call_id: message.toolCallId } : {}),
      };
    }
    if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
      return {
        role: "assistant",
        content: message.content,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: {
            name: call.name,
            arguments: call.arguments,
          },
        })),
      };
    }
    return { role: message.role, content: message.content };
  });
}

function inputTools(opts: ChatOptions): Array<Record<string, unknown>> | undefined {
  if (opts.tools === undefined || opts.tools.length === 0) return undefined;
  return opts.tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function inputBody(messages: ChatMessage[], opts: ChatOptions, stream: boolean): Record<string, unknown> {
  const tools = inputTools(opts);
  return {
    messages: inputMessages(messages),
    max_tokens: clampOutputTokens(opts.maxOutputTokens),
    ...(opts.temperature === undefined ? {} : { temperature: opts.temperature }),
    ...(tools === undefined ? {} : { tools }),
    ...(stream ? { stream: true } : {}),
  };
}

function resultFromRaw(raw: unknown, model: string): ChatResult {
  const text = readText(raw);
  const toolCalls = readToolCalls(raw);
  if (text === null && toolCalls.length === 0) {
    // Name the shape, never the payload: "no text" alone cannot tell an
    // empty completion from a model that answered in another field or an
    // error object delivered with a 200.
    const shape =
      raw === null
        ? "null"
        : typeof raw === "object"
          ? `object with keys ${Object.keys(raw as Record<string, unknown>).join(",") || "none"}`
          : typeof raw;
    throw new ChatAdapterError("unparseable", `Workers AI returned no text (${shape})`);
  }
  const usage = readUsage(raw);
  return {
    text: text ?? "",
    tokensIn: readTokenCount(usage?.prompt_tokens),
    tokensOut: readTokenCount(usage?.completion_tokens),
    ...(toolCalls.length === 0 ? {} : { toolCalls }),
    model,
    provider: "workers-ai",
  };
}

export function createWorkersAiAdapter(
  binding: WorkersAiBinding,
  model: string
): ChatAdapter {
  const run = async (messages: ChatMessage[], opts: ChatOptions, stream: boolean): Promise<unknown> => {
    try {
      return await binding.run(model, inputBody(messages, opts, stream));
    } catch (error) {
      throw new ChatAdapterError(
        "provider_unavailable",
        `Workers AI did not answer: ${String(error).slice(0, 200)}`
      );
    }
  };

  return {
    kind: "workers-ai",

    async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
      const raw = await run(messages, opts, false);
      return resultFromRaw(raw, model);
    },

    async chatStream(
      messages: ChatMessage[],
      opts: ChatOptions = {},
      onEvent: (event: ChatStreamEvent) => void
    ): Promise<ChatResult> {
      const raw = await run(messages, opts, true);

      // A model that ignores `stream` (or a binding that resolved it to one
      // object) answers in the non-streaming shapes. Emit the text once.
      if (raw === null || typeof raw !== "object" || !(raw instanceof ReadableStream)) {
        if (typeof raw === "string") {
          if (raw !== "") onEvent({ type: "token", text: raw });
          return { text: raw, model, provider: "workers-ai" };
        }
        const result = resultFromRaw(raw, model);
        if (result.text !== "") onEvent({ type: "token", text: result.text });
        return result;
      }

      const reader = raw.getReader();
      const decoder = new TextDecoder();
      const accumulated: Array<{ id: string; name: string; arguments: string }> = [];
      let text = "";
      let usage: WorkersAiUsage | undefined;
      let buffer = "";

      const apply = (data: string): void => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          return;
        }
        if (parsed === null || typeof parsed !== "object") return;
        const record = parsed as WorkersAiResult & {
          choices?: Array<{ delta?: { content?: unknown; tool_calls?: unknown } }>;
        };
        if (typeof record.response === "string" && record.response !== "") {
          text += record.response;
          onEvent({ type: "token", text: record.response });
        }
        const delta = record.choices?.[0]?.delta;
        if (delta && typeof delta === "object") {
          if (typeof delta.content === "string" && delta.content !== "") {
            text += delta.content;
            onEvent({ type: "token", text: delta.content });
          }
          if (Array.isArray(delta.tool_calls)) {
            delta.tool_calls.forEach((rawEntry, index) => {
              if (rawEntry === null || typeof rawEntry !== "object") return;
              const entry = rawEntry as {
                index?: unknown;
                id?: unknown;
                function?: { name?: unknown; arguments?: unknown };
              };
              const callIndex =
                typeof entry.index === "number" && Number.isInteger(entry.index) && entry.index >= 0
                  ? entry.index
                  : index;
              while (accumulated.length <= callIndex) {
                accumulated.push({ id: `call_${accumulated.length}`, name: "", arguments: "" });
              }
              const target = accumulated[callIndex];
              if (typeof entry.id === "string" && entry.id !== "") target.id = entry.id;
              if (entry.function && typeof entry.function === "object") {
                if (typeof entry.function.name === "string" && entry.function.name !== "") {
                  target.name = entry.function.name;
                }
                if (typeof entry.function.arguments === "string") {
                  target.arguments += entry.function.arguments;
                }
              }
            });
          }
        }
        const chunkUsage = readUsage(parsed);
        if (chunkUsage !== undefined) usage = chunkUsage;
        if (Array.isArray(record.tool_calls)) {
          record.tool_calls.forEach((entry, index) => {
            const call = readOneToolCall(entry, accumulated.length + index);
            if (call === null) return;
            const explicitIndex =
              entry !== null && typeof entry === "object" && typeof (entry as { index?: unknown }).index === "number";
            const explicitId =
              entry !== null && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string";
            // OpenAI-style streams send fragments addressed by `index`; the
            // classic Workers AI shape repeats the whole call. Replace an
            // existing call rather than appending it twice, and append when
            // the model genuinely returned a second call.
            const existing = accumulated.findIndex((candidate) =>
              explicitId || explicitIndex ? candidate.id === call.id : candidate.name === call.name
            );
            if (existing === -1) accumulated.push(call);
            else accumulated[existing] = call;
          });
        }
      };

      const drain = (flush: boolean): void => {
        buffer = buffer.replace(/\r\n/g, "\n");
        for (;;) {
          const boundary = buffer.indexOf("\n\n");
          if (boundary === -1) break;
          const rawEvent = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = rawEvent
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (data !== "" && data !== "[DONE]") apply(data);
        }
        if (flush && buffer.trim() !== "") {
          const data = buffer
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (data !== "" && data !== "[DONE]") apply(data);
          buffer = "";
        }
      };

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          drain(false);
        }
        buffer += decoder.decode();
        drain(true);
      } catch (error) {
        if (text === "" && accumulated.length === 0) {
          throw new ChatAdapterError(
            "provider_unavailable",
            `Workers AI stream failed: ${String(error).slice(0, 200)}`
          );
        }
        return {
          text,
          tokensIn: readTokenCount(usage?.prompt_tokens),
          tokensOut: readTokenCount(usage?.completion_tokens),
          ...(accumulated.length === 0 ? {} : { toolCalls: accumulated }),
          finishReason: "aborted",
          model,
          provider: "workers-ai",
        };
      }

      if (text === "" && accumulated.length === 0) {
        throw new ChatAdapterError("unparseable", "Workers AI streamed no message content");
      }

      return {
        text,
        tokensIn: readTokenCount(usage?.prompt_tokens),
        tokensOut: readTokenCount(usage?.completion_tokens),
        ...(accumulated.length === 0 ? {} : { toolCalls: accumulated }),
        model,
        provider: "workers-ai",
      };
    },
  };
}
