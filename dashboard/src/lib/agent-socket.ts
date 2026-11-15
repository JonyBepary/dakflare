/**
 * The agent runtime, from this console's side: the ticket, the socket, and the
 * two admin routes that decide whether any of it exists.
 *
 * `assistant.ts` owns the stateless question — one POST, one answer. This module
 * owns the other path: a deployment with `AGENT_RUNTIME=on` answers
 * `GET /v1/admin/agent/runtime` with `enabled: true`, and the panel then asks over
 * a WebSocket instead. Nothing here is used when that read says off, which is the
 * default on every deployment.
 *
 * The wire, verbatim:
 *
 *   POST /v1/admin/agent/ticket   201 { ticket, expires_at }   single use, 60 s
 *   wss://<host>/agents/assistant/assistant?ticket=<ticket>
 *     → { type:"ready",  name }
 *     → { type:"token",  text }                     while the model writes
 *     → { type:"tool",   name, ok, output }         after a tool runs
 *     → { type:"calls",  calls:[{tool, ok, reason?}] }   when a turn used tools
 *     → { type:"answer", text, calls }              at the end
 *     → { type:"error",  reason, message }          when the turn was refused
 *     ← { type:"ask", message, idempotencyKey }
 *
 *   GET    /v1/admin/agent/runtime   { enabled, schemaVersion, sessions, pinnedName }
 *   GET    /v1/admin/agent/autonomy  { enabled, expiresAt, caps:{sms,writes}, usage:{day,tokens,writes,sms} }
 *   POST   /v1/admin/agent/autonomy  { smsCap?, writeCap?, minutes? }
 *   DELETE /v1/admin/agent/autonomy  revoke, and stop every open session
 *
 * Five things shape the code below, because each one is a place a console can
 * lie about what it knows:
 *
 *  1. **The ticket is where a refusal is diagnosable.** A browser hides the HTTP
 *     status of a failed upgrade: `onerror` carries nothing and `onclose` carries
 *     a code the server did not choose. So every refusal that matters — a missing,
 *     expired, spent or foreign ticket, an untrusted origin — happens on the POST,
 *     and this module resolves it as a state with a sentence rather than waiting
 *     for a silent close.
 *  2. **A tool's output is dropped, not stored.** The `tool` frame carries an
 *     `output` member; this module deliberately does not keep it. A line here is a
 *     tool name, a verdict and the gateway's reason, so rendering a tool's raw JSON
 *     is not something a future template can do by accident.
 *  3. **The client owns the idempotency key.** The model never supplies one, and a
 *     retry after a link that died mid-answer must not become a second turn. `ask`
 *     returns the key it used, and the panel reuses it for "try that again".
 *  4. **A reconnect re-fetches a ticket.** A ticket is single use and lives 60 s;
 *     reconnecting with the old one is a guaranteed refusal. Retries are
 *     exponential, capped, and stop dead on a terminal refusal.
 *  5. **Nothing throws.** Every entry point answers with an outcome, for the same
 *     reason `assistant.ts` does: a failure is something the panel prints, not an
 *     exception that blanks it.
 *
 * What this module does not do: it does not judge a turn. Frames are passed to
 * `applyAgentFrame`, which is pure, so the panel's rendering is decided by data
 * the gateway sent and not by the order a screenshot happened to catch.
 */

import { failureFromAnswer, type Failure, type Proposal } from './assistant';

/* ------------------------------------------------------------- endpoints */

const TICKET_PATH = '/v1/admin/agent/ticket';
const RUNTIME_PATH = '/v1/admin/agent/runtime';
const AUTONOMY_PATH = '/v1/admin/agent/autonomy';

/** The object name is pinned server-side; the path repeats it and chooses nothing. */
const SOCKET_PATH = '/agents/assistant/assistant';

/** The Worker's routing marker for cookie-authenticated calls. Not a secret. */
const ADMIN_HEADER = 'X-Admin-Session';

const REQUEST_TIMEOUT_MS = 15_000;

/** The panel's field stops at 500 characters; the contract names no larger limit. */
export const MAX_QUESTION = 500;

/* ---------------------------------------------------------------- shapes */

/** One tool run, as this console prints it: a name, a verdict, and a reason. */
export interface AgentToolCall {
	tool: string;
	ok: boolean;
	/** Why the tool did not run, when the gateway said. `null` when it ran or said nothing. */
	reason: string | null;
}

/**
 * One server frame. `tool.output` is absent on purpose: see the header. `answer`
 * carries `proposals` only when the gateway sends them — the stage-A contract
 * names none, and an answer without them is a complete answer.
 */
export type AgentFrame =
	| { type: 'ready'; name: string }
	| { type: 'token'; text: string }
	| { type: 'tool'; name: string; ok: boolean }
	| { type: 'answer'; text: string; calls: number; proposals: Proposal[] }
	| { type: 'calls'; calls: AgentToolCall[] }
	| { type: 'error'; reason: string; message: string };

/* --------------------------------------------------------------- reading */

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
	return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function readFinite(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * An instant as epoch milliseconds.
 *
 * The Worker sends `expires_at` on a ticket and `expiresAt` on the autonomy
 * window, and both have been seen as seconds and as a millisecond stamp. A
 * millisecond stamp in this decade is ~1.7e12, so anything below 1e11 cannot be
 * one; an ISO string is parsed and printed as the console prints every other time.
 */
function readInstant(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) {
		const millis = value < 100_000_000_000 ? Math.round(value * 1000) : Math.round(value);
		return millis > 0 ? millis : null;
	}
	if (typeof value === 'string' && value.trim() !== '') {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

/** The endpoint's own sentences, in the order they are worth trusting. */
function serverMessage(value: unknown): string | null {
	if (!isRecord(value)) return null;
	return (
		readString(value.message) ??
		readString(value.detail) ??
		readString(value.error_description) ??
		null
	);
}

/** `86400`, or `null` when the document is not one this console can read. */
function readCount(value: unknown): number | null {
	const count = readFinite(value);
	return count === null ? null : Math.max(0, Math.round(count));
}

/**
 * The `calls` frame, or `null` when it does not carry verdicts.
 *
 * Every entry must state `ok`. A list of calls with inputs and no verdict is a
 * different document, and reading its absent `ok` as `false` would print every
 * tool as refused — a claim the gateway never made.
 */
function readToolCalls(value: unknown): AgentToolCall[] | null {
	if (!Array.isArray(value)) return null;
	const calls: AgentToolCall[] = [];
	for (const entry of value) {
		if (!isRecord(entry)) return null;
		const tool = readString(entry.tool);
		if (tool === null || typeof entry.ok !== 'boolean') return null;
		calls.push({ tool, ok: entry.ok, reason: readString(entry.reason) });
	}
	return calls;
}

/**
 * One frame, or `null` for anything this console does not render.
 *
 * A malformed frame is not a state: the socket stays open, the panel keeps what it
 * already has, and nothing is invented from half a frame.
 */
export function readAgentFrame(raw: unknown): AgentFrame | null {
	if (!isRecord(raw)) return null;
	switch (raw.type) {
		case 'ready':
			return { type: 'ready', name: readString(raw.name) ?? '' };
		case 'token':
			// An empty token is legal and prints nothing.
			return typeof raw.text === 'string' ? { type: 'token', text: raw.text } : null;
		case 'tool': {
			// `name` is the contract; `tool` is the same member under the spelling the
			// runtime's own loop uses. Either way the rest of the frame is untouched,
			// and `output` is read to nothing on purpose.
			const name = readString(raw.name) ?? readString(raw.tool);
			if (name === null || typeof raw.ok !== 'boolean') return null;
			return { type: 'tool', name, ok: raw.ok };
		}
		case 'answer':
			if (typeof raw.text !== 'string') return null;
			return {
				type: 'answer',
				text: raw.text,
				calls: readFinite(raw.calls) ?? 0,
				proposals: readProposals(raw.proposals)
			};
		case 'calls': {
			const calls = readToolCalls(raw.calls);
			return calls === null ? null : { type: 'calls', calls };
		}
		case 'error':
			return {
				type: 'error',
				reason: readString(raw.reason) ?? 'unspecified',
				message: readString(raw.message) ?? ''
			};
		default:
			return null;
	}
}

/**
 * The `proposals` array, when a frame carries one.
 *
 * `assistant.ts` already reads this shape for the stateless endpoint, and a
 * proposal is a proposal whether it arrived over HTTP or a socket. The reader is
 * repeated here rather than exported because it is four lines and exporting it
 * would make the stateless module's internals part of this module's contract.
 */
function readProposals(value: unknown): Proposal[] {
	if (!Array.isArray(value)) return [];
	const proposals: Proposal[] = [];
	for (const entry of value) {
		if (!isRecord(entry)) continue;
		const id = readString(entry.id);
		const kind = readString(entry.kind);
		const title = readString(entry.title);
		if (id === null || kind === null || title === null) continue;
		proposals.push({
			id,
			kind,
			title,
			summary: typeof entry.summary === 'string' ? entry.summary : '',
			payload: entry.payload
		});
	}
	return proposals;
}

/* ---------------------------------------------------------------- a turn */

/**
 * One question and everything the gateway said about it.
 *
 * `text` is what has arrived so far: tokens append, and the final answer frame
 * replaces it. `refusal` is set alongside `text`, never instead of it — a turn
 * refused after the model had written three sentences shows both.
 */
export interface AgentTurn {
	question: string;
	/** The key this turn was asked with. A retry reuses it. */
	key: string;
	text: string;
	tools: AgentToolCall[];
	/** How many tool runs the answer frame reported. `null` before it arrives. */
	calls: number | null;
	refusal: { reason: string; message: string } | null;
	proposals: Proposal[];
	status: 'streaming' | 'answered' | 'refused';
}

export function beginTurn(question: string, key: string): AgentTurn {
	return {
		question,
		key,
		text: '',
		tools: [],
		calls: null,
		refusal: null,
		proposals: [],
		status: 'streaming'
	};
}

/**
 * One frame, applied to one turn. Pure, so the panel holds no frame logic.
 *
 * The `calls` frame is the turn's own summary and it is the only frame that names
 * a `reason`, so when it arrives it replaces the running list: the same runs, in
 * order, now with the gateway's verdict. An answer keeps the streamed text when it
 * arrives empty, because a final frame that says nothing is not a retraction.
 */
export function applyAgentFrame(turn: AgentTurn, frame: AgentFrame): AgentTurn {
	switch (frame.type) {
		case 'token':
			return { ...turn, text: turn.text + frame.text };
		case 'tool':
			return { ...turn, tools: [...turn.tools, { tool: frame.name, ok: frame.ok, reason: null }] };
		case 'calls':
			// An empty list is not a summary of anything; the running list stands.
			return frame.calls.length === 0 ? turn : { ...turn, tools: frame.calls };
		case 'answer':
			return {
				...turn,
				text: frame.text !== '' ? frame.text : turn.text,
				calls: frame.calls,
				proposals: frame.proposals,
				status: 'answered'
			};
		case 'error':
			return {
				...turn,
				refusal: { reason: frame.reason, message: frame.message },
				status: 'refused'
			};
		case 'ready':
			return turn;
	}
}

/* ------------------------------------------------------------ the link */

/** `closed` is final: no retry follows. `retrying` is waiting for the next one. */
export type AgentLinkState = 'idle' | 'ticket' | 'connecting' | 'open' | 'retrying' | 'closed';

/**
 * Why the link is not open. The console prints `agentTroubleLine(trouble)` and
 * `detail` under it; the machine reason stays a token, undeclared.
 */
export interface AgentTrouble {
	/** `ticket`: refused before a socket existed. `upgrade`: it never opened. `socket`: it closed. */
	stage: 'ticket' | 'upgrade' | 'socket';
	/** The gateway's own token, when it named one. */
	reason: string | null;
	/** The gateway's own sentence, when it sent one. */
	detail: string | null;
	retryable: boolean;
	/** How many attempts have failed so far. */
	attempt: number;
}

export type AgentEvent =
	| { kind: 'link'; state: AgentLinkState; trouble: AgentTrouble | null }
	| { kind: 'frame'; frame: AgentFrame };

export interface AgentLinkOptions {
	onEvent?: (event: AgentEvent) => void;
	/** Attempts including the first. The default is five, which spans ~18 s. */
	maxAttempts?: number;
	/** First backoff step. Doubles to a cap of 8 s. */
	baseDelayMs?: number;
	/** Where the socket lives. Overridable so a workbench can point it elsewhere. */
	socketUrl?: (ticket: string) => string;
}

export type AgentSendOutcome =
	| { status: 'sent'; key: string }
	/** The link is not open; nothing was sent. */
	| { status: 'waiting'; message: string }
	| { status: 'refused'; message: string };

type TicketOutcome =
	| { status: 'ok'; ticket: string }
	| { status: 'failed'; trouble: Omit<AgentTrouble, 'attempt'> };

const MAX_BACKOFF_MS = 8_000;

/** `wss:` on an https page, `ws:` on a local http one, same host, no base path. */
export function agentSocketUrl(ticket: string): string {
	if (typeof window === 'undefined') return `${SOCKET_PATH}?ticket=${encodeURIComponent(ticket)}`;
	const { protocol, host } = window.location;
	const scheme = protocol === 'https:' ? 'wss:' : 'ws:';
	return `${scheme}//${host}${SOCKET_PATH}?ticket=${encodeURIComponent(ticket)}`;
}

/** A key for one question. The server never mints it; a retry must reuse it. */
export function newIdempotencyKey(): string {
	const uuid = globalThis.crypto?.randomUUID?.();
	if (typeof uuid === 'string') return uuid;
	return `ask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function openState(): number {
	return typeof WebSocket !== 'undefined' ? WebSocket.OPEN : 1;
}

/**
 * The ticket and the socket, as one object the panel drives.
 *
 * Lifecycle is explicit: `connect()` once when the panel opens, `ask()` per
 * question, `close()` when the panel closes. There is no timer running after
 * `close()`, and a socket that was already dead is never reopened by it.
 */
export class AgentLink {
	#options: AgentLinkOptions;
	#socket: WebSocket | null = null;
	#state: AgentLinkState = 'idle';
	#trouble: AgentTrouble | null = null;
	#attempt = 0;
	#timer: ReturnType<typeof setTimeout> | null = null;
	#stopped = false;
	#generation = 0;

	constructor(options: AgentLinkOptions = {}) {
		this.#options = options;
	}

	get state(): AgentLinkState {
		return this.#state;
	}

	get trouble(): AgentTrouble | null {
		return this.#trouble;
	}

	get isOpen(): boolean {
		return this.#state === 'open';
	}

	/** Open the link, if it is not already open or opening. Resolves when that settles. */
	async connect(): Promise<void> {
		if (this.#state === 'open' || this.#state === 'ticket' || this.#state === 'connecting') return;
		this.#stopped = false;
		this.#attempt = 0;
		this.#trouble = null;
		// A retry may already be waiting on its backoff timer. Asking again now would
		// leave that timer to open a second socket behind this one.
		if (this.#timer !== null) {
			clearTimeout(this.#timer);
			this.#timer = null;
		}
		await this.#attemptConnect();
	}

	/**
	 * Send one question.
	 *
	 * `waiting` is not a failure: the link is still being opened, and the caller
	 * keeps the question and its key for the moment it opens. `refused` means the
	 * question itself cannot be sent at all.
	 */
	ask(message: string, key: string = newIdempotencyKey()): AgentSendOutcome {
		const text = message.trim().slice(0, MAX_QUESTION);
		if (text === '') {
			return { status: 'refused', message: 'Nothing was sent: the question was empty.' };
		}

		const socket = this.#socket;
		if (socket === null || socket.readyState !== openState()) {
			return { status: 'waiting', message: 'The agent link is not open, so nothing was sent.' };
		}

		try {
			socket.send(JSON.stringify({ type: 'ask', message: text, idempotencyKey: key }));
		} catch {
			return {
				status: 'waiting',
				message: 'The link closed while the question was being sent.'
			};
		}
		return { status: 'sent', key };
	}

	/** Close the socket and stop retrying. Safe to call twice. */
	close(): void {
		this.#stopped = true;
		this.#generation += 1;
		if (this.#timer !== null) {
			clearTimeout(this.#timer);
			this.#timer = null;
		}
		const socket = this.#socket;
		this.#socket = null;
		if (socket !== null) {
			try {
				socket.close(1000, 'console_closed');
			} catch {
				// A socket that already closed is exactly what was wanted.
			}
		}
		this.#attempt = 0;
		this.#emit({ kind: 'link', state: 'idle', trouble: null });
	}

	/* ------------------------------------------------------------ private */

	#emit(event: AgentEvent): void {
		try {
			this.#options.onEvent?.(event);
		} catch {
			// A throw in the panel's handler is the panel's bug; it must not become
			// an unhandled rejection in the link.
		}
	}

	#setState(state: AgentLinkState, trouble: AgentTrouble | null): void {
		this.#state = state;
		this.#trouble = trouble;
		this.#emit({ kind: 'link', state, trouble });
	}

	async #attemptConnect(): Promise<void> {
		if (this.#stopped) return;
		this.#setState('ticket', null);

		const outcome = await this.#mintTicket();
		// `close()` while the ticket was in flight is not an error.
		if (this.#stopped) return;

		if (outcome.status === 'failed') {
			this.#fail(outcome.trouble);
			return;
		}
		this.#openSocket(outcome.ticket);
	}

	async #mintTicket(): Promise<TicketOutcome> {
		let response: Response;
		try {
			response = await fetch(TICKET_PATH, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
					[ADMIN_HEADER]: '1'
				},
				credentials: 'same-origin',
				body: '{}',
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
			});
		} catch {
			return {
				status: 'failed',
				trouble: {
					stage: 'ticket',
					reason: null,
					detail: null,
					retryable: true
				}
			};
		}

		const body = await readBody(response);
		if (response.ok) {
			const ticket = isRecord(body) ? readString(body.ticket) : null;
			if (ticket === null) {
				return {
					status: 'failed',
					trouble: {
						stage: 'ticket',
						reason: 'unreadable',
						detail: serverMessage(body),
						retryable: false
					}
				};
			}
			return { status: 'ok', ticket };
		}

		const reason = isRecord(body) ? readString(body.error) : null;
		const detail = serverMessage(body);

		// 503 `agent_runtime_off` is the deployment's answer, not a fault: the panel
		// falls back to the stateless path and says nothing alarming.
		if (response.status === 503 && reason === 'agent_runtime_off') {
			return { status: 'failed', trouble: { stage: 'ticket', reason, detail, retryable: false } };
		}
		if (response.status === 401 || response.status === 403) {
			return { status: 'failed', trouble: { stage: 'ticket', reason, detail, retryable: false } };
		}
		// A route that is not there will not be there on the second attempt either.
		if (response.status === 404 || response.status === 405 || response.status === 501) {
			return { status: 'failed', trouble: { stage: 'ticket', reason, detail, retryable: false } };
		}
		// A limiter or a 5xx can clear; the backoff is the honest answer.
		return { status: 'failed', trouble: { stage: 'ticket', reason, detail, retryable: true } };
	}

	#openSocket(ticket: string): void {
		if (typeof WebSocket === 'undefined') {
			this.#fail({
				stage: 'upgrade',
				reason: null,
				detail: 'this browser has no WebSocket',
				retryable: false
			});
			return;
		}

		this.#setState('connecting', null);

		let socket: WebSocket;
		try {
			const build = this.#options.socketUrl ?? agentSocketUrl;
			socket = new WebSocket(build(ticket));
		} catch {
			this.#fail({ stage: 'upgrade', reason: null, detail: null, retryable: true });
			return;
		}

		const generation = ++this.#generation;
		this.#socket = socket;
		let opened = false;

		socket.addEventListener('open', () => {
			if (generation !== this.#generation || this.#stopped) return;
			opened = true;
			this.#attempt = 0;
			this.#setState('open', null);
		});

		socket.addEventListener('message', (event: MessageEvent) => {
			if (generation !== this.#generation || this.#stopped) return;
			const frame = parseFrame(event.data);
			// An unknown or malformed frame is dropped: the socket is still open and
			// the panel keeps what it has rather than rendering half a frame.
			if (frame !== null) this.#emit({ kind: 'frame', frame });
		});

		socket.addEventListener('error', () => {
			// Browsers report nothing here. The close event that follows is the one
			// with a code, and the ticket already answered anything diagnosable.
		});

		socket.addEventListener('close', (event: CloseEvent) => {
			if (generation !== this.#generation || this.#stopped) return;
			this.#socket = null;
			this.#fail(closeTrouble(event, opened));
		});
	}

	#fail(trouble: Omit<AgentTrouble, 'attempt'>): void {
		const attempt = this.#attempt + 1;
		const next: AgentTrouble = { ...trouble, attempt };
		const retry = trouble.retryable && attempt < (this.#options.maxAttempts ?? 5);

		if (!retry) {
			this.#setState('closed', next);
			return;
		}

		this.#attempt = attempt;
		this.#setState('retrying', next);
		const delay = Math.min(MAX_BACKOFF_MS, (this.#options.baseDelayMs ?? 600) * 2 ** (attempt - 1));
		this.#timer = setTimeout(() => {
			this.#timer = null;
			void this.#attemptConnect();
		}, delay);
	}
}

/** A close event, in the console's terms. `opened` is whether this socket ever did. */
function closeTrouble(event: CloseEvent, opened: boolean): Omit<AgentTrouble, 'attempt'> {
	const reason = readString(event.reason);
	const detail = event.code > 0 ? `close ${event.code}` : null;

	// The two reasons the Worker closes with that a retry cannot fix.
	if (reason === 'agent_schema_ahead' || reason === 'agent_runtime_off') {
		return { stage: 'upgrade', reason, detail, retryable: false };
	}

	return { stage: opened ? 'socket' : 'upgrade', reason, detail, retryable: true };
}

function parseFrame(data: unknown): AgentFrame | null {
	if (typeof data !== 'string') return null;
	try {
		return readAgentFrame(JSON.parse(data));
	} catch {
		return null;
	}
}

/* ------------------------------------------------------------- sentences */

/**
 * One line for a link that is not open.
 *
 * Known tokens get a sentence; an unknown one keeps the gateway's own sentence
 * under the generic line, so a reason added later is never renamed into something
 * this console guessed.
 */
export function agentTroubleLine(trouble: AgentTrouble): string {
	switch (trouble.reason) {
		case 'agent_runtime_off':
			return 'The agent runtime is off on this deployment.';
		case 'agent_ticket_missing':
			return 'The gateway received no ticket, so the link was not opened.';
		case 'agent_ticket_expired':
			return 'The ticket expired before the link opened. Nothing was sent.';
		case 'agent_ticket_already_used':
			return 'That ticket had already been used, so the link was not opened.';
		case 'agent_ticket_wrong_session':
			return 'The ticket was minted for another session, so the link was not opened.';
		case 'agent_origin_untrusted':
			return "The gateway does not trust this page's origin, so it refused the link.";
		case 'agent_origin_missing':
			return 'The page sent no origin, so the gateway refused the link.';
		case 'agent_schema_ahead':
			return 'The agent runtime stores a newer schema than this console knows. It refuses to serve until one side is upgraded.';
		case 'unreadable':
			return 'The gateway answered the ticket request, but not with a ticket this console can read.';
		default:
			if (trouble.stage === 'ticket') {
				return trouble.retryable
					? 'The gateway did not mint a ticket, so the link was not opened.'
					: 'The gateway refused the ticket request.';
			}
			return trouble.stage === 'upgrade'
				? 'The agent link was refused before it opened.'
				: 'The agent link closed.';
	}
}

/**
 * The refusal a turn stopped on, in the operator's words.
 *
 * `grant_expired` and `cap_reached` are the two that matter in practice: a window
 * closed, or a cap it named ran out. Both mean the agent is back to proposing, and
 * neither invalidates what the model already wrote.
 */
export function agentRefusalLine(reason: string): string {
	switch (reason) {
		case 'grant_expired':
			return 'The grant that lets the agent act has expired, so this turn stopped acting. Anything further needs a new window.';
		case 'cap_reached':
			return 'A cap on this window was reached, so the agent stopped acting. Nothing further was done; an operator can open a new window.';
		case 'origin_refused':
		case 'agent_origin_untrusted':
		case 'agent_origin_missing':
			return 'The gateway refused this page as an origin for the agent, so it did not run.';
		case 'agent_runtime_off':
			return 'The agent runtime was turned off, so this turn stopped.';
		case 'session_expired':
			return 'The session behind this link expired, so the agent stopped.';
		case 'turn_cap':
			return 'The turn reached the cap on what one question may do, so the agent stopped.';
		default:
			return 'The agent refused that turn.';
	}
}

/** The header marker's word for a link state. Empty when there is nothing to say. */
export function agentLinkLabel(state: AgentLinkState): string {
	switch (state) {
		case 'ticket':
			return 'connecting';
		case 'connecting':
			return 'connecting';
		case 'open':
			return 'live';
		case 'retrying':
			return 'reconnecting';
		case 'closed':
			return 'offline';
		case 'idle':
			return '';
	}
}

/* -------------------------------------------------------------- requests */

interface Raw {
	status: number;
	ok: boolean;
	body: unknown;
}

async function request(path: string, init: RequestInit = {}): Promise<Raw> {
	const headers = new Headers(init.headers);
	headers.set('Accept', 'application/json');
	headers.set(ADMIN_HEADER, '1');
	if (init.body !== undefined && init.body !== null && !headers.has('Content-Type')) {
		headers.set('Content-Type', 'application/json');
	}

	let response: Response;
	try {
		response = await fetch(path, {
			...init,
			headers,
			credentials: 'same-origin',
			signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
		});
	} catch {
		return { status: 0, ok: false, body: null };
	}
	return { status: response.status, ok: response.ok, body: await readBody(response) };
}

async function readBody(response: Response): Promise<unknown> {
	try {
		const text = await response.text();
		if (text === '') return null;
		try {
			return JSON.parse(text);
		} catch {
			// An answer that is not JSON is not a document any of these routes read.
			return null;
		}
	} catch {
		return null;
	}
}

/* --------------------------------------------------------------- runtime */

export interface AgentRuntime {
	enabled: boolean;
	/** The object's stored schema version, when it said. */
	schemaVersion: number | null;
	/** Open links, when it said. */
	sessions: number | null;
	/** The object name the Worker pinned. Not a choice the console makes. */
	pinnedName: string | null;
}

export type AgentRuntimeOutcome =
	| { status: 'ok'; runtime: AgentRuntime }
	| { status: 'failed'; failure: Failure };

/**
 * `GET /v1/admin/agent/runtime`.
 *
 * This is the one read that decides which assistant the panel is: `enabled` is
 * only ever true when the deployment said so, and a read that fails is not a
 * reason to try the socket — the stateless path is the default and it works.
 */
export async function readAgentRuntime(): Promise<AgentRuntimeOutcome> {
	const raw = await request(RUNTIME_PATH);
	if (!raw.ok) return { status: 'failed', failure: failureFromAnswer(raw.status, raw.body) };
	if (!isRecord(raw.body) || typeof raw.body.enabled !== 'boolean') {
		return { status: 'failed', failure: { kind: 'unreadable' } };
	}
	return {
		status: 'ok',
		runtime: {
			enabled: raw.body.enabled,
			schemaVersion: readCount(raw.body.schemaVersion),
			sessions: readCount(raw.body.sessions),
			pinnedName: readString(raw.body.pinnedName)
		}
	};
}

/* -------------------------------------------------------------- autonomy */

export interface AgentAutonomyCaps {
	sms: number | null;
	writes: number | null;
}

export interface AgentAutonomyUsage {
	day: string | null;
	tokens: number | null;
	writes: number | null;
	sms: number | null;
}

/**
 * One autonomy window, as the gateway reports it.
 *
 * `enabled` is required: it is the fact the whole block hangs on, and a document
 * without it is not one this console can print. Every number is `number | null`
 * for the same reason the token allowance is: a zero nobody sent reads as "nothing
 * has happened", which is a safer-sounding fact than "nobody said".
 */
export interface AgentAutonomy {
	enabled: boolean;
	expiresAt: number | null;
	caps: AgentAutonomyCaps;
	usage: AgentAutonomyUsage;
}

export type AutonomyOutcome =
	| { status: 'ok'; autonomy: AgentAutonomy }
	| { status: 'failed'; failure: Failure };

export type AutonomyChange =
	| { status: 'ok'; autonomy: AgentAutonomy | null }
	| { status: 'failed'; failure: Failure };

function parseAutonomy(value: unknown): AgentAutonomy | null {
	if (!isRecord(value) || typeof value.enabled !== 'boolean') return null;
	const caps = isRecord(value.caps) ? value.caps : {};
	const usage = isRecord(value.usage) ? value.usage : {};
	const day = usage.day;
	return {
		enabled: value.enabled,
		expiresAt: readInstant(value.expiresAt),
		caps: { sms: readCount(caps.sms), writes: readCount(caps.writes) },
		usage: {
			day:
				typeof day === 'string' && day.trim() !== ''
					? day
					: typeof day === 'number' && Number.isFinite(day)
						? String(day)
						: null,
			tokens: readCount(usage.tokens),
			writes: readCount(usage.writes),
			sms: readCount(usage.sms)
		}
	};
}

/** `GET /v1/admin/agent/autonomy`. */
export async function readAutonomy(): Promise<AutonomyOutcome> {
	const raw = await request(AUTONOMY_PATH);
	if (!raw.ok) return { status: 'failed', failure: failureFromAnswer(raw.status, raw.body) };
	const autonomy = parseAutonomy(raw.body);
	if (autonomy === null) return { status: 'failed', failure: { kind: 'unreadable' } };
	return { status: 'ok', autonomy };
}

export interface AutonomyInput {
	/** SMS allowed in this window. Omitted means the gateway's own default. */
	smsCap?: number;
	/** Writes allowed in this window. Omitted means the gateway's own default. */
	writeCap?: number;
	/** How long the window is. Omitted means the gateway's own default. */
	minutes?: number;
}

/** `POST /v1/admin/agent/autonomy` — mint effect-shaped grants for a window. */
export async function openAutonomy(input: AutonomyInput): Promise<AutonomyChange> {
	const body: Record<string, number> = {};
	if (input.smsCap !== undefined) body.smsCap = input.smsCap;
	if (input.writeCap !== undefined) body.writeCap = input.writeCap;
	if (input.minutes !== undefined) body.minutes = input.minutes;

	const raw = await request(AUTONOMY_PATH, { method: 'POST', body: JSON.stringify(body) });
	if (!raw.ok) return { status: 'failed', failure: failureFromAnswer(raw.status, raw.body) };
	// The route may answer with the new window or with nothing; the page re-reads
	// when it is nothing, rather than showing a window it guessed.
	return { status: 'ok', autonomy: parseAutonomy(raw.body) };
}

/** `DELETE /v1/admin/agent/autonomy` — revoke, and stop every open session. */
export async function revokeAutonomy(): Promise<AutonomyChange> {
	const raw = await request(AUTONOMY_PATH, { method: 'DELETE' });
	if (!raw.ok) return { status: 'failed', failure: failureFromAnswer(raw.status, raw.body) };
	return { status: 'ok', autonomy: parseAutonomy(raw.body) };
}

/* ---------------------------------------------------------------- labels */

/** The windows the console offers, in minutes. A window is the grant's whole life. */
export const AUTONOMY_WINDOWS: ReadonlyArray<{ minutes: number; label: string }> = [
	{ minutes: 15, label: '15 minutes' },
	{ minutes: 60, label: '1 hour' },
	{ minutes: 480, label: '8 hours' }
];

/** `1 hour`, `2 hours`, from the minutes a window was opened with. */
export function windowLabel(minutes: number): string {
	const entry = AUTONOMY_WINDOWS.find((window) => window.minutes === minutes);
	if (entry !== undefined) return entry.label;
	if (minutes < 60) return `${minutes} minutes`;
	const hours = minutes / 60;
	return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
}
