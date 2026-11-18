/**
 * Streamable HTTP transport, protocol-agnostic core.
 *
 * This file has **no imports** and touches only Web-standard globals (`Request`,
 * `Response`, `ReadableStream`, `crypto.randomUUID`, `setTimeout`). That is
 * deliberate: `worker/src/mcp/__checks__/run.mjs` imports this module directly
 * under `node`, so the transport's failure modes (406, 400, session mint/echo,
 * elicitation timeout) are proven without a Worker runtime or a D1 binding.
 *
 * The Worker-facing half is `http.ts`: it builds the tool descriptors from
 * `tools.ts` and the elicitation driver from `elicitation.ts`, then calls
 * `handleStreamableRequest` here.
 *
 * ## Two dialects, chosen by what the client sends
 *
 *   stateful   2025-era streamable HTTP. A POST `initialize` without
 *              `params._meta` mints an `Mcp-Session-Id`, every later request
 *              must echo it, and an unknown id is `404`.
 *   stateless  2026-era per-request envelope. A message carrying `params._meta`
 *              is served without a session, and `GET` answers `405` because
 *              there is no session stream to hold open.
 *
 * Batches are one POST whose body is an array. A batch that includes a
 * mutating tool streams every elicitation request and its result on the same
 * SSE response, in order.
 *
 * ## Elicitation correlation
 *
 * A mutating tool cannot run until a human answers. The POST that called it
 * opens an SSE response and writes an `elicitation/create` request. The client
 * answers with a normal JSON-RPC response POST carrying that id; the registry
 * below resolves it, and the original stream continues with the tool result.
 * The map is bounded and every entry has a 60-second timer, so a client that
 * walks away aborts the call instead of leaving a parked promise.
 */

/** The header a stateful client must echo. */
export const MCP_SESSION_HEADER = "Mcp-Session-Id";

/** A session that has not been touched for this long is gone. */
export const SESSION_TTL_MS = 30 * 60_000;

/** Bounded so an unauthenticated stream of `initialize` calls cannot grow memory. */
export const MAX_SESSIONS = 512;

/** Same bound for in-flight elicitations. */
export const MAX_ELICITATIONS = 256;

/** A human gets one minute to answer before the tool call is aborted. */
export const DEFAULT_ELICITATION_TIMEOUT_MS = 60_000;

/** 4 MiB, the same bound the SDK's handler uses. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Upper bound on messages in one batch. */
export const MAX_BATCH_SIZE = 64;

/** Protocols this endpoint speaks, oldest first. The last is preferred. */
export const SUPPORTED_PROTOCOLS = ["2025-03-26", "2025-06-18", "2025-11-25", "2026-07-28"] as const;

/**
 * JSON-RPC codes.
 *
 * -32768..-32000 is the implementation-defined band, so the five custom codes
 * below are legal and cannot be confused with the spec's parse/invalid/method
 * errors. The elicitation trio is what a client checks to tell "a human said
 * no" from "a human never answered" from "the code was wrong".
 */
export const JSON_RPC = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  NOT_ACCEPTABLE: -32000,
  SESSION_NOT_FOUND: -32001,
  ELICITATION_DECLINED: -32002,
  ELICITATION_TIMEOUT: -32003,
  ELICITATION_REJECTED: -32004,
} as const;

export type JsonRpcId = string | number | null;
export type JsonRpcMessage = Record<string, unknown>;

/* ────────────────────────────── tool surface ────────────────────────────── */

/** Plain, already-converted input schema: the transport never sees zod. */
export interface ToolDescriptor {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  call: (args: Record<string, unknown>) => Promise<ToolCallOutcome>;
}

export interface ToolCallOutcome {
  /** The one line a model reads. */
  text: string;
  /** Structured content, when the tool has an output schema. */
  structured?: Record<string, unknown>;
  /** A tool-level refusal: the call completed, the answer is an error. */
  isError?: boolean;
  /** A pre-built MCP result (the SDK's MRTR `input_required` shape). */
  raw?: unknown;
}

export interface ElicitationRequestSpec {
  message: string;
  requestedSchema: Record<string, unknown>;
  /**
   * Opaque value handed back to `complete` with the answer. `elicitation.ts`
   * puts the payload hash here, so the arguments a human confirmed and the
   * arguments that execute can be compared.
   */
  state?: unknown;
}

export interface ElicitationAnswer {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}

export interface ElicitationDriver {
  /** `null` when this tool needs no human. May be async (it hashes the payload). */
  request(
    toolName: string,
    args: Record<string, unknown>
  ): ElicitationRequestSpec | null | Promise<ElicitationRequestSpec | null>;
  /** Throws `ElicitationFailure` to abort the call. */
  complete(
    toolName: string,
    args: Record<string, unknown>,
    answer: ElicitationAnswer,
    state: unknown
  ): Promise<void>;
}

/** Thrown by a driver to abort a tool call with a specific JSON-RPC code. */
export class ElicitationFailure extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = "ElicitationFailure";
    this.code = code;
  }
}

/* ─────────────────────────────── sessions ─────────────────────────────── */

export interface SessionState {
  id: string;
  createdAt: number;
  lastSeen: number;
  initialized: boolean;
  protocolVersion: string | null;
}

/** Bounded, TTL'd in-memory session table (one per isolate). */
export class SessionStore {
  _map: Map<string, SessionState>;

  constructor() {
    this._map = new Map();
  }

  get size(): number {
    return this._map.size;
  }

  create(now: number): SessionState {
    this.sweep(now);
    if (this._map.size >= MAX_SESSIONS) {
      // Oldest insertion wins the eviction: Map preserves insertion order and a
      // session is never re-inserted on touch, so the first key is the oldest.
      const oldest = this._map.keys().next();
      if (oldest.done !== true) this._map.delete(oldest.value);
    }
    const session: SessionState = {
      id: crypto.randomUUID(),
      createdAt: now,
      lastSeen: now,
      initialized: false,
      protocolVersion: null,
    };
    this._map.set(session.id, session);
    return session;
  }

  get(id: string, now: number): SessionState | null {
    const session = this._map.get(id);
    if (session === undefined) return null;
    if (now - session.lastSeen > SESSION_TTL_MS) {
      this._map.delete(id);
      return null;
    }
    session.lastSeen = now;
    return session;
  }

  delete(id: string): boolean {
    return this._map.delete(id);
  }

  sweep(now: number): number {
    let removed = 0;
    for (const [id, session] of this._map) {
      if (now - session.lastSeen > SESSION_TTL_MS) {
        this._map.delete(id);
        removed += 1;
      }
    }
    return removed;
  }
}

/* ───────────────────────────── elicitations ───────────────────────────── */

interface PendingElicitation {
  id: string;
  actorKey: string | null;
  createdAt: number;
  resolve: (answer: ElicitationAnswer) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Thrown as the rejection reason when the 60-second window closes. */
export class ElicitationTimeoutError extends Error {
  constructor() {
    super("Elicitation timed out");
    this.name = "ElicitationTimeoutError";
  }
}

/**
 * Correlation map for `elicitation/create`.
 *
 * `create` allocates the id and the timer in one step, so a response that
 * arrives before the tool-call stream reaches its `await` still settles the
 * promise rather than being dropped.
 */
export class ElicitationRegistry {
  _map: Map<string, PendingElicitation>;

  constructor() {
    this._map = new Map();
  }

  get size(): number {
    return this._map.size;
  }

  create(
    now: number,
    timeoutMs: number,
    actorKey: string | null = null
  ): { id: string; promise: Promise<ElicitationAnswer> } {
    if (this._map.size >= MAX_ELICITATIONS) {
      const oldest = this._map.keys().next();
      if (oldest.done !== true) {
        const entry = this._map.get(oldest.value);
        if (entry !== undefined) {
          this._map.delete(oldest.value);
          if (entry.timer !== null) clearTimeout(entry.timer);
          entry.reject(new ElicitationTimeoutError());
        }
      }
    }

    const id = `elicit-${crypto.randomUUID()}`;
    const promise = new Promise<ElicitationAnswer>((resolve, reject) => {
      const entry: PendingElicitation = {
        id,
        actorKey,
        createdAt: now,
        resolve,
        reject,
        timer: null,
      };
      this._map.set(id, entry);
      entry.timer = setTimeout(() => {
        if (this._map.delete(id)) reject(new ElicitationTimeoutError());
      }, timeoutMs);
    });

    return { id, promise };
  }

  /** Resolve a pending request from a client's JSON-RPC response. */
  settle(id: string, message: JsonRpcMessage, actorKey: string | null = null): boolean {
    const entry = this._map.get(id);
    if (entry === undefined) return false;
    if (entry.actorKey !== null && actorKey !== entry.actorKey) return false;
    this._map.delete(id);
    if (entry.timer !== null) clearTimeout(entry.timer);

    const error = message.error;
    if (error !== undefined) {
      entry.reject(new ElicitationFailure(JSON_RPC.ELICITATION_DECLINED, "Elicitation failed"));
      return true;
    }

    const result = message.result;
    if (result === null || typeof result !== "object" || Array.isArray(result)) {
      entry.reject(new ElicitationFailure(JSON_RPC.INVALID_PARAMS, "Elicitation answer had no result"));
      return true;
    }
    const row = result as Record<string, unknown>;
    const action = row.action;
    if (action !== "accept" && action !== "decline" && action !== "cancel") {
      entry.reject(new ElicitationFailure(JSON_RPC.INVALID_PARAMS, "Elicitation answer had no action"));
      return true;
    }
    const answer: ElicitationAnswer = { action };
    if (row.content !== undefined) {
      if (row.content === null || typeof row.content !== "object" || Array.isArray(row.content)) {
        entry.reject(new ElicitationFailure(JSON_RPC.INVALID_PARAMS, "Elicitation content must be an object"));
        return true;
      }
      answer.content = row.content as Record<string, unknown>;
    }
    entry.resolve(answer);
    return true;
  }

  /** Drop everything: the isolate is going away. */
  clear(): void {
    for (const entry of this._map.values()) {
      if (entry.timer !== null) clearTimeout(entry.timer);
      entry.reject(new ElicitationTimeoutError());
    }
    this._map.clear();
  }
}

/* ─────────────────────────────── helpers ─────────────────────────────── */

/**
 * Factories, so a caller can hold the store across requests without importing
 * the class. `http.ts` creates one of each at module scope.
 */
export function createSessionStore(): SessionStore {
  return new SessionStore();
}

export function createElicitationRegistry(): ElicitationRegistry {
  return new ElicitationRegistry();
}

export interface StreamableDeps {
  tools: ToolDescriptor[];
  serverInfo: { name: string; version: string };
  elicitation?: ElicitationDriver;
  actorKey?: string | null;
  elicitationTimeoutMs?: number;
  /** Shared across requests in the isolate; defaults are created per call. */
  sessions?: SessionStore;
  elicitations?: ElicitationRegistry;
  now?: () => number;
  onError?: (error: unknown) => void;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function rpcId(message: JsonRpcMessage): JsonRpcId {
  const id = message.id;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

export function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown): JsonRpcMessage {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
}

export function rpcResult(id: JsonRpcId, result: unknown): JsonRpcMessage {
  return { jsonrpc: "2.0", id, result };
}

function isRequest(message: JsonRpcMessage): boolean {
  return typeof message.method === "string" && message.id !== undefined;
}

function isNotification(message: JsonRpcMessage): boolean {
  return typeof message.method === "string" && message.id === undefined;
}

function isClientResponse(message: JsonRpcMessage): boolean {
  return typeof message.method !== "string" && message.id !== undefined;
}

function hasMeta(message: JsonRpcMessage): boolean {
  const params = message.params;
  return isObject(params) && params._meta !== undefined;
}

function paramsOf(message: JsonRpcMessage): Record<string, unknown> {
  return isObject(message.params) ? message.params : {};
}

function jsonResponse(body: unknown, status: number, sessionId?: string | null): Response {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (sessionId !== undefined && sessionId !== null) headers.set(MCP_SESSION_HEADER, sessionId);
  return Response.json(body, { status, headers });
}

function httpError(
  status: number,
  code: number,
  message: string,
  sessionId?: string | null,
  extraHeaders?: HeadersInit
): Response {
  const headers = new Headers(extraHeaders ?? {});
  headers.set("Content-Type", "application/json");
  if (sessionId !== undefined && sessionId !== null) headers.set(MCP_SESSION_HEADER, sessionId);
  return Response.json(rpcError(null, code, message), { status, headers });
}

function sseHeaders(sessionId: string | null): Headers {
  const headers = new Headers({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  if (sessionId !== null) headers.set(MCP_SESSION_HEADER, sessionId);
  return headers;
}

function frame(message: unknown): Uint8Array {
  const encoder = new TextEncoder();
  return encoder.encode(`event: message\ndata: ${JSON.stringify(message)}\n\n`);
}

function acceptable(req: Request): boolean {
  const accept = req.headers.get("accept") ?? "";
  return /\bapplication\/json\b/i.test(accept) || /\btext\/event-stream\b/i.test(accept);
}

/* ─────────────────────────────── engine ─────────────────────────────── */

interface Prepared {
  message: JsonRpcMessage;
  spec: ElicitationRequestSpec | null;
}

/**
 * Serve one HTTP request. The caller has already authenticated and filtered
 * the tool list to what the credential may use.
 */
export async function handleStreamableRequest(req: Request, deps: StreamableDeps): Promise<Response> {
  const now = deps.now ?? Date.now;
  const sessions = deps.sessions ?? new SessionStore();
  const elicitations = deps.elicitations ?? new ElicitationRegistry();
  const timeoutMs = deps.elicitationTimeoutMs ?? DEFAULT_ELICITATION_TIMEOUT_MS;

  try {
    if (req.method === "GET") return await handleGet(req, sessions, now);
    if (req.method === "DELETE") return handleDelete(req, sessions);
    if (req.method !== "POST") {
      return httpError(405, JSON_RPC.INVALID_REQUEST, "Method not allowed. Use POST.", null, {
        Allow: "POST",
      });
    }
    return await handlePost(req, deps, sessions, elicitations, now(), timeoutMs);
  } catch (error) {
    // A stack trace is for the log, never for the client.
    deps.onError?.(error);
    return httpError(500, JSON_RPC.INTERNAL_ERROR, "Internal error");
  }
}

function handleGet(req: Request, sessions: SessionStore, now: () => number): Response {
  if (!/\btext\/event-stream\b/i.test(req.headers.get("accept") ?? "")) {
    return httpError(406, JSON_RPC.NOT_ACCEPTABLE, "Not Acceptable: GET requires text/event-stream");
  }

  const header = req.headers.get(MCP_SESSION_HEADER);
  if (header === null || header === "") {
    // Stateless: there is no session stream to hold open.
    return httpError(405, JSON_RPC.INVALID_REQUEST, "Method not allowed: this endpoint is stateless.", null, {
      Allow: "POST",
    });
  }

  const session = sessions.get(header, now());
  if (session === null) {
    return httpError(404, JSON_RPC.SESSION_NOT_FOUND, "Session not found");
  }

  // The session stream exists for server-initiated traffic. Elicitation rides
  // the POST that asked the question, so this stream is a heartbeat + future
  // channel; it is still opened so a 2025 client sees the documented shape.
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(": connected\n\n"));
      timer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
        } catch {
          if (timer !== null) clearInterval(timer);
        }
      }, 15_000);
    },
    cancel() {
      if (timer !== null) clearInterval(timer);
    },
  });

  return new Response(stream, { status: 200, headers: sseHeaders(session.id) });
}

function handleDelete(req: Request, sessions: SessionStore): Response {
  const header = req.headers.get(MCP_SESSION_HEADER);
  if (header === null || header === "") {
    return httpError(405, JSON_RPC.INVALID_REQUEST, "Method not allowed: this endpoint is stateless.", null, {
      Allow: "POST",
    });
  }
  if (!sessions.delete(header)) {
    return httpError(404, JSON_RPC.SESSION_NOT_FOUND, "Session not found");
  }
  return new Response(null, { status: 204 });
}

async function handlePost(
  req: Request,
  deps: StreamableDeps,
  sessions: SessionStore,
  elicitations: ElicitationRegistry,
  now: number,
  timeoutMs: number
): Promise<Response> {
  if (!acceptable(req)) {
    return httpError(
      406,
      JSON_RPC.NOT_ACCEPTABLE,
      "Not Acceptable: Accept must include application/json or text/event-stream"
    );
  }

  const contentType = (req.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (contentType !== "application/json") {
    return httpError(415, JSON_RPC.INVALID_REQUEST, "Unsupported Media Type: Content-Type must be application/json");
  }

  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) {
    return httpError(413, JSON_RPC.INVALID_REQUEST, "Request body too large");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return httpError(400, JSON_RPC.PARSE_ERROR, "Parse error: body is not JSON");
  }

  const batch = Array.isArray(parsed);
  const rawMessages: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  if (batch && rawMessages.length === 0) {
    return httpError(400, JSON_RPC.INVALID_REQUEST, "Invalid Request: empty batch");
  }
  if (batch && rawMessages.length > MAX_BATCH_SIZE) {
    return httpError(400, JSON_RPC.INVALID_REQUEST, `Invalid Request: batch exceeds ${MAX_BATCH_SIZE} messages`);
  }
  const messages: JsonRpcMessage[] = [];
  for (const raw of rawMessages) {
    if (!isObject(raw) || raw.jsonrpc !== "2.0") {
      return httpError(400, JSON_RPC.INVALID_REQUEST, "Invalid Request: expected a JSON-RPC 2.0 message");
    }
    if (typeof raw.method !== "string" && !("result" in raw) && !("error" in raw)) {
      return httpError(400, JSON_RPC.INVALID_REQUEST, "Invalid Request: message has neither method nor result");
    }
    messages.push(raw);
  }

  // A JSON-RPC response to OUR elicitation request needs no session check: the
  // id is unguessable and the registry is the authority that it was pending.
  const onlyClientResponses = messages.every((message) => isClientResponse(message));
  if (onlyClientResponses) {
    let settled = 0;
    for (const message of messages) {
      if (elicitations.settle(String(message.id), message, deps.actorKey ?? null)) settled += 1;
    }
    if (settled === 0) {
      return httpError(400, JSON_RPC.INVALID_REQUEST, "Invalid Request: no elicitation is waiting for that id");
    }
    return new Response(null, { status: 202 });
  }

  const header = req.headers.get(MCP_SESSION_HEADER);
  let session: SessionState | null = null;
  if (header !== null && header !== "") {
    session = sessions.get(header, now);
    if (session === null) {
      return httpError(404, JSON_RPC.SESSION_NOT_FOUND, "Session not found");
    }
  }

  const stateless = messages.some((message) => hasMeta(message));
  const initRequest = messages.find((message) => isRequest(message) && message.method === "initialize");
  if (initRequest !== undefined && !stateless) {
    if (session === null) session = sessions.create(now);
    session.initialized = true;
    const requested = paramsOf(initRequest).protocolVersion;
    session.protocolVersion =
      typeof requested === "string" && (SUPPORTED_PROTOCOLS as readonly string[]).includes(requested)
        ? requested
        : SUPPORTED_PROTOCOLS[SUPPORTED_PROTOCOLS.length - 1];
  }

  const hasUninitializedRequest = messages.some(
    (message) => isRequest(message) && message.method !== "initialize"
  );
  if (session === null && !stateless && hasUninitializedRequest) {
    return httpError(
      400,
      JSON_RPC.INVALID_REQUEST,
      `Bad Request: ${MCP_SESSION_HEADER} header is required`
    );
  }

  // Resolve elicitation specs before deciding the response shape: a mutating
  // call must stream, and `request()` is where the driver hashes the payload.
  const prepared: Prepared[] = [];
  for (const message of messages) {
    let spec: ElicitationRequestSpec | null = null;
    if (deps.elicitation !== undefined && isRequest(message) && message.method === "tools/call") {
      const params = paramsOf(message);
      if (typeof params.name === "string") {
        const args = isObject(params.arguments) ? params.arguments : {};
        spec = (await deps.elicitation.request(params.name, args)) ?? null;
      }
    }
    prepared.push({ message, spec });
  }

  const streaming = prepared.some((entry) => entry.spec !== null);
  const sessionId = session?.id ?? null;

  if (streaming) {
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const emit = (message: JsonRpcMessage) => {
          try {
            controller.enqueue(frame(message));
          } catch {
            // Client disconnected; the timeout timers will settle what remains.
          }
        };
        for (const entry of prepared) {
          const response = await runOne(
            entry,
            deps,
            elicitations,
            now,
            timeoutMs,
            emit
          );
          if (response !== null) emit(response);
        }
        try {
          controller.close();
        } catch {
          // already cancelled
        }
      },
    });
    return new Response(stream, { status: 200, headers: sseHeaders(sessionId) });
  }

  const out: JsonRpcMessage[] = [];
  for (const entry of prepared) {
    const response = await runOne(entry, deps, elicitations, now, timeoutMs, undefined);
    if (response !== null) out.push(response);
  }

  if (out.length === 0) {
    const headers = new Headers();
    if (sessionId !== null) headers.set(MCP_SESSION_HEADER, sessionId);
    return new Response(null, { status: 202, headers });
  }

  return jsonResponse(batch ? out : out[0], 200, sessionId);
}

async function runOne(
  entry: Prepared,
  deps: StreamableDeps,
  elicitations: ElicitationRegistry,
  now: number,
  timeoutMs: number,
  emit: ((message: JsonRpcMessage) => void) | undefined
): Promise<JsonRpcMessage | null> {
  const { message, spec } = entry;

  if (isClientResponse(message)) {
    elicitations.settle(String(message.id), message, deps.actorKey ?? null);
    return null;
  }
  if (isNotification(message)) return null;
  if (!isRequest(message)) return null;

  const id = rpcId(message);
  const method = message.method as string;
  const params = paramsOf(message);

  try {
    switch (method) {
      case "initialize": {
        const requested = params.protocolVersion;
        const version =
          typeof requested === "string" && (SUPPORTED_PROTOCOLS as readonly string[]).includes(requested)
            ? requested
            : SUPPORTED_PROTOCOLS[SUPPORTED_PROTOCOLS.length - 1];
        return rpcResult(id, {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: deps.serverInfo,
        });
      }
      case "ping":
        return rpcResult(id, {});
      case "server/discover":
        return rpcResult(id, {
          protocolVersions: [...SUPPORTED_PROTOCOLS],
          serverInfo: deps.serverInfo,
          capabilities: { tools: { listChanged: false } },
        });
      case "tools/list":
        return rpcResult(id, {
          tools: deps.tools.map((tool) => ({
            name: tool.name,
            title: tool.title,
            description: tool.description,
            inputSchema: tool.inputSchema,
            ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
            ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
          })),
        });
      case "tools/call": {
        const name = params.name;
        if (typeof name !== "string" || name === "") {
          return rpcError(id, JSON_RPC.INVALID_PARAMS, "Invalid params: tools/call needs a tool name");
        }
        if (params.arguments !== undefined && !isObject(params.arguments)) {
          return rpcError(id, JSON_RPC.INVALID_PARAMS, "Invalid params: arguments must be an object");
        }
        const args = isObject(params.arguments) ? params.arguments : {};
        const tool = deps.tools.find((candidate) => candidate.name === name);
        if (tool === undefined) {
          // Same answer as the registered-tools surface: an out-of-scope tool is
          // indistinguishable from one that does not exist.
          return rpcError(id, JSON_RPC.METHOD_NOT_FOUND, `Method not found: ${name}`);
        }

        if (spec !== null && deps.elicitation !== undefined) {
          if (emit === undefined) {
            return rpcError(id, JSON_RPC.INTERNAL_ERROR, "Internal error: elicitation needs a stream");
          }
          const { id: elicitId, promise } = elicitations.create(
            now,
            timeoutMs,
            deps.actorKey ?? null
          );
          emit({
            jsonrpc: "2.0",
            id: elicitId,
            method: "elicitation/create",
            params: { message: spec.message, requestedSchema: spec.requestedSchema },
          });

          let answer: ElicitationAnswer;
          try {
            answer = await promise;
          } catch (error) {
            if (error instanceof ElicitationFailure) {
              return rpcError(id, error.code, error.message);
            }
            return rpcError(
              id,
              JSON_RPC.ELICITATION_TIMEOUT,
              "Elicitation timed out; the tool call was not executed."
            );
          }

          if (answer.action !== "accept") {
            return rpcError(
              id,
              JSON_RPC.ELICITATION_DECLINED,
              `Elicitation ${answer.action === "cancel" ? "cancelled" : "declined"}; the tool call was not executed.`
            );
          }

          try {
            await deps.elicitation.complete(name, args, answer, spec.state);
          } catch (error) {
            if (error instanceof ElicitationFailure) {
              return rpcError(id, error.code, error.message);
            }
            throw error;
          }
        }

        const outcome = await tool.call(args);
        if (outcome.raw !== undefined) return rpcResult(id, outcome.raw);
        return rpcResult(id, {
          content: [{ type: "text", text: outcome.text }],
          ...(outcome.structured === undefined ? {} : { structuredContent: outcome.structured }),
          ...(outcome.isError === true ? { isError: true } : {}),
        });
      }
      default:
        return rpcError(id, JSON_RPC.METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  } catch (error) {
    deps.onError?.(error);
    return rpcError(id, JSON_RPC.INTERNAL_ERROR, "Internal error");
  }
}
