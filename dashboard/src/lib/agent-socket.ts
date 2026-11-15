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
 *     → { type:"turn",   streamId, idempotencyKey, conversationId }  first frame of a turn
 *     → { type:"status", phase }     "thinking" | "tool:<name>" | "answering" | "waiting"
 *     → { type:"token",  text }                     only from a server that streams text
 *     → { type:"calls",  calls:[{tool, input}] }    the batch it is about to run
 *     → { type:"tool",   tool, ok, result }         after one of those calls settles
 *     → { type:"answer", text, calls, proposals? }  at the end
 *     → { type:"error",  reason, message }          when the turn was refused
 *     ← { type:"ask", message, idempotencyKey }
 *     ← { type:"resume", streamId, from }           replay from a sequence, then tail
 *
 *   GET /agents/assistant/assistant/streams/<streamId>?from=<seq>
 *     text/event-stream: one frame per `data:` line with its sequence in `id:`,
 *     ending in `event: done` (or `event: timeout` while the turn is still live)
 *
 *   GET    /v1/admin/agent/runtime   { enabled, schemaVersion, sessions, pinnedName }
 *   GET    /v1/admin/agent/autonomy  { enabled, expiresAt, caps:{sms,writes}, usage:{day,tokens,writes,sms} }
 *   POST   /v1/admin/agent/autonomy  { smsCap?, writeCap?, minutes? }
 *   DELETE /v1/admin/agent/autonomy  revoke, and stop every open session
 *
 * Six things shape the code below, because each one is a place a console can
 * lie about what it knows:
 *
 *  1. **The ticket is where a refusal is diagnosable.** A browser hides the HTTP
 *     status of a failed upgrade: `onerror` carries nothing and `onclose` carries
 *     a code the server did not choose. So every refusal that matters — a missing,
 *     expired, spent or foreign ticket, an untrusted origin — happens on the POST,
 *     and this module resolves it as a state with a sentence rather than waiting
 *     for a silent close.
 *  2. **A tool's output is dropped, not stored.** A `tool` frame carries a
 *     `result`, and a successful result carries the tool's raw output. This module
 *     keeps only a refusal's reason and message: a line here is a tool, a verdict
 *     and the gateway's own words, so rendering a tool's JSON is not something a
 *     future template can do by accident.
 *  3. **The client owns the idempotency key.** The model never supplies one, and a
 *     retry after a link that died mid-answer must not become a second turn. `ask`
 *     returns the key it used, and the panel reuses it for "try that again".
 *  4. **A reconnect re-fetches a ticket.** A ticket is single use and lives 60 s;
 *     reconnecting with the old one is a guaranteed refusal. Retries are
 *     exponential, capped, and stop dead on a terminal refusal.
 *  5. **A dropped turn is asked for, not given up on.** Every frame of a turn is
 *     in a durable stream, so a close mid-turn is a lost *presentation*, not a
 *     lost answer. The panel sends `resume` with the last sequence it applied;
 *     when the socket will not come back, `readTurnStream` reads the same stream
 *     over SSE. Both paths feed `applyAgentFrame`, and its sequence rule is what
 *     stops the answer being rendered twice.
 *  6. **Nothing throws.** Every entry point answers with an outcome, for the same
 *     reason `assistant.ts` does: a failure is something the panel prints, not an
 *     exception that blanks it.
 *
 * What this module does not do: it does not judge a turn. Frames are passed to
 * `applyAgentFrame`, which is pure, so the panel's rendering is decided by data
 * the gateway sent and not by the order a screenshot happened to catch.
 *
 * Sequences. The stream's own numbering is what `from` addresses, and the `turn`
 * frame is the turn's first streamed frame, so a client that counts turn frames
 * from it addresses the same sequence the server stores. A frame that carries
 * `seq` (or an SSE `id:`) is trusted over the count. Terminal frames are the
 * exception to the sequence rule: an `answer` is refused on the turn's state,
 * never on a number, because a numbering mismatch must not be able to drop — or
 * double — the one frame the operator is waiting for.
 */

import { failureFromAnswer, type Failure, type Proposal } from './assistant';

/* ------------------------------------------------------------- endpoints */

const TICKET_PATH = '/v1/admin/agent/ticket';
const RUNTIME_PATH = '/v1/admin/agent/runtime';
const AUTONOMY_PATH = '/v1/admin/agent/autonomy';

/** The object name is pinned server-side; the path repeats it and chooses nothing. */
const SOCKET_PATH = '/agents/assistant/assistant';

/** The same turn, read over HTTP when the socket will not stay up. */
const STREAM_PATH = `${SOCKET_PATH}/streams`;

/** The Worker's routing marker for cookie-authenticated calls. Not a secret. */
const ADMIN_HEADER = 'X-Admin-Session';

const REQUEST_TIMEOUT_MS = 15_000;

/** A stream read may span a slow turn; it is not a request that answers once. */
const STREAM_TIMEOUT_MS = 60_000;

/** The panel's field stops at 500 characters; the contract names no larger limit. */
export const MAX_QUESTION = 500;

/* ---------------------------------------------------------------- shapes */

/**
 * One tool call the gateway announced.
 *
 * `ok` is `boolean | null` because a `calls` frame announces the batch *before*
 * it runs: `null` is "queued, not settled", and it is not the same fact as
 * `false`, which would print every announced call as refused. The verdict, and
 * the reason that goes with it, arrive on the `tool` frame that settles the run.
 */
export interface AgentCall {
	tool: string;
	ok: boolean | null;
}

/** A settled step's verdict. Three states, because "no" has two different causes. */
export type AgentStepVerdict = 'ok' | 'refused' | 'failed';

/**
 * One step of a turn, in the order the gateway worked.
 *
 * The identity is positional, not nominal: `index` is the step's place in the
 * turn's own sequence and `seq` is the frame that settled it, so a turn that
 * reads the same tool twice gets two rows and a replayed frame gets one.
 */
export interface AgentStep {
	/** 1-based place in the turn, in the order the gateway ran the steps. */
	index: number;
	tool: string;
	/** `refused` is the gateway saying no before the tool ran; `failed` is it running and breaking. */
	verdict: AgentStepVerdict;
	/** The gateway's own sentence. Never a sentence this console wrote. */
	reason: string | null;
	/** The gateway's own token, when it sent one beside the sentence. */
	code: string | null;
	/** The frame's own instant, when the gateway stamped it. Not a client clock. */
	settledAt: number | null;
	/** The stream sequence that settled the step; the row's identity across a replay. */
	seq: number;
}

/**
 * One server frame. `tool.result` is read for a refusal's reason and nothing
 * else: see the header. `answer` carries `proposals` only when the gateway sends
 * them — the stage-A contract names none, and an answer without them is complete.
 *
 * `seq` is the frame's position in the turn's durable stream, when the server
 * states it. `at` is the server's own instant for the frame, in epoch
 * milliseconds, when it stamps one; a client clock is never substituted, because
 * a replay would then produce times that never happened.
 */
interface Sequenced {
	seq?: number;
	at?: number;
}

export type AgentFrame = Sequenced &
	(
		| { type: 'ready'; name: string }
		| {
				type: 'turn';
				streamId: string;
				idempotencyKey: string | null;
				conversationId: string | null;
		  }
		| { type: 'status'; phase: string }
		| { type: 'token'; text: string }
		| { type: 'tool'; name: string; ok: boolean; reason: string | null; code: string | null }
		| { type: 'answer'; text: string; calls: number; proposals: Proposal[] }
		| { type: 'calls'; calls: AgentCall[] }
		| { type: 'error'; reason: string; message: string }
	);

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

/** A sequence is a non-negative integer; anything else is not one the stream could hold. */
function readSeq(value: unknown): number | undefined {
	const seq = readFinite(value);
	return seq === null || !Number.isInteger(seq) || seq < 0 ? undefined : seq;
}

/**
 * A frame's own instant, in epoch milliseconds.
 *
 * An ISO string is accepted because the Worker writes timestamps that way
 * elsewhere, and `Date.parse` is the same conversion the console uses for every
 * other time. A value that is not one is `undefined`: no measurement is better
 * than a wrong one, and the panel then prints no elapsed time at all.
 */
function readStamp(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
	if (typeof value === 'string' && value.trim() !== '') {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
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
 * A refusal's wording, kept as two fields that stay distinct.
 *
 * `reason` is the operator's sentence and `code` is the gateway's token, and they
 * are only separated when *both* were sent: a frame that carries a single
 * `reason` gives one sentence, and printing it twice (once as a code and once as
 * a reason) would be this console's duplication, not the gateway's.
 *
 * The successful branch is never read at all, which is where a tool's output is
 * dropped: `{ ok: true, output: "…" }` has no path into the panel.
 */
function readOutcome(value: unknown): { reason: string | null; code: string | null } {
	if (typeof value === 'string') {
		const reason = readString(value);
		return { reason, code: null };
	}
	if (!isRecord(value)) return { reason: null, code: null };
	const token = readString(value.reason);
	const message = readString(value.message);
	if (message !== null) return { reason: message, code: token };
	// A refusal that names no sentence: its token is the gateway's own word for it,
	// and `error` is the spelling a handler's 4xx body uses.
	return { reason: token ?? readString(value.error), code: null };
}

/**
 * The `calls` frame, or `null` when it does not carry calls.
 *
 * Two shapes arrive here and they are not the same statement. A batch is
 * `{ tool, input }` with no verdict: the gateway is saying what it is about to
 * run. A summary is the same list with `ok`: it is saying what already ran. The
 * missing `ok` is read as `null` — "queued" — never as `false`, because that
 * would print every announced call as refused.
 */
function readCalls(value: unknown): AgentCall[] | null {
	if (!Array.isArray(value)) return null;
	const calls: AgentCall[] = [];
	for (const entry of value) {
		if (!isRecord(entry)) return null;
		const tool = readString(entry.tool) ?? readString(entry.name);
		if (tool === null) return null;
		calls.push({ tool, ok: typeof entry.ok === 'boolean' ? entry.ok : null });
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
	const seq = readSeq(raw.seq);
	const at = readStamp(raw.at);
	switch (raw.type) {
		case 'ready':
			return { type: 'ready', name: readString(raw.name) ?? '', seq, at };
		case 'turn': {
			// The announcement is what makes a turn resumable, so a frame without a
			// stream id is not one this console can use.
			const streamId = readString(raw.streamId);
			if (streamId === null) return null;
			return {
				type: 'turn',
				streamId,
				idempotencyKey: readString(raw.idempotencyKey),
				conversationId: readString(raw.conversationId),
				seq,
				at
			};
		}
		case 'status': {
			// The phase is the server's token. It is not validated against the three the
			// contract names: an unknown phase is printed as work in progress, which is
			// still true, rather than dropped into a panel that looks stuck.
			const phase = readString(raw.phase);
			return phase === null ? null : { type: 'status', phase, seq, at };
		}
		case 'token':
			// An empty token is legal and prints nothing.
			return typeof raw.text === 'string' ? { type: 'token', text: raw.text, seq, at } : null;
		case 'tool': {
			// `tool` is the loop's spelling, `name` the older one; either way the rest
			// of the frame is untouched, and a successful `result` is read to nothing.
			const name = readString(raw.name) ?? readString(raw.tool);
			if (name === null || typeof raw.ok !== 'boolean') return null;
			const outcome = raw.ok ? { reason: null, code: null } : readOutcome(raw.result);
			return {
				type: 'tool',
				name,
				ok: raw.ok,
				reason: outcome.reason,
				code: outcome.code,
				seq,
				at
			};
		}
		case 'answer':
			if (typeof raw.text !== 'string') return null;
			return {
				type: 'answer',
				text: raw.text,
				calls: readFinite(raw.calls) ?? 0,
				proposals: readProposals(raw.proposals),
				seq,
				at
			};
		case 'calls': {
			const calls = readCalls(raw.calls);
			return calls === null ? null : { type: 'calls', calls, seq, at };
		}
		case 'error':
			return {
				type: 'error',
				// `error` is the spelling the resume path uses for `stream_not_found`;
				// `reason` is the turn's own. Both are the gateway's token, not ours.
				reason: readString(raw.reason) ?? readString(raw.error) ?? 'unspecified',
				message: readString(raw.message) ?? '',
				seq,
				at
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
 *
 * `steps` and `queue` are the timeline, and they are two different statements:
 * `queue` is the batch the gateway announced it is about to run, and `steps` are
 * the runs that settled, in the order they settled. A step exists only because a
 * `tool` frame said so.
 */
export interface AgentTurn {
	question: string;
	/** The key this turn was asked with. A retry reuses it. */
	key: string;
	text: string;
	/** The runs that settled, in the gateway's own order. */
	steps: AgentStep[];
	/** The calls the last `calls` frame announced and that have not settled yet. */
	queue: AgentCall[];
	/** How many tool runs the answer frame reported. `null` before it arrives. */
	calls: number | null;
	refusal: { reason: string; message: string } | null;
	proposals: Proposal[];
	status: 'streaming' | 'answered' | 'refused';
	/** The durable stream the turn lives in, from its `turn` frame. `null` until announced. */
	streamId: string | null;
	/** The conversation the server filed the turn under, when it said. */
	conversationId: string | null;
	/** The last sequence applied. `-1` before the first frame. */
	seq: number;
	/** The server's latest progress phase, cleared by a terminal frame. */
	phase: string | null;
}

export function beginTurn(question: string, key: string): AgentTurn {
	return {
		question,
		key,
		text: '',
		steps: [],
		queue: [],
		calls: null,
		refusal: null,
		proposals: [],
		status: 'streaming',
		streamId: null,
		conversationId: null,
		seq: -1,
		phase: null
	};
}

/** What one frame did: the turn it produced, and whether it was new. */
export interface AgentFrameResult {
	turn: AgentTurn;
	/** Applied and not seen before. A panel announces only these. */
	fresh: boolean;
	/** The sequence the frame occupies; the turn's own when it was dropped. */
	seq: number;
}

/**
 * The reasons that are the gateway saying **no**, and the ones that are it
 * saying **it broke**.
 *
 * The authorisation gate (`worker/src/agent/grants.ts`) names all of these but
 * `rule_rejected`, which is the other policy refusal a tool returns. Everything
 * else that failed is a failure: the tool ran and broke, the call was malformed,
 * or the tool does not exist. A token this console has never seen stays `failed`,
 * because a refusal is a claim about who said no and an unknown token is not
 * evidence of one.
 */
const REFUSAL_CODES: ReadonlySet<string> = new Set([
	'autonomy_off',
	'autonomy_other_session',
	'autonomy_expired',
	'sms_cap',
	'write_cap',
	'no_grant',
	'grant_expired',
	'rule_rejected'
]);

/** `ok`, or one of the two ways a `tool` frame can say it did not run. */
function stepVerdict(ok: boolean, code: string | null): AgentStepVerdict {
	if (ok) return 'ok';
	return code !== null && REFUSAL_CODES.has(code) ? 'refused' : 'failed';
}

/**
 * One settled step, in the turn's own order.
 *
 * The head of the announced batch is consumed, but only its *place* is used: the
 * gateway runs a batch in the order it announced it, so the next `tool` frame is
 * the next step even when two steps call the same tool. That is the whole reason
 * this is positional — grouping by tool name would merge two runs into one row
 * and call the second run's verdict the first one's.
 *
 * A row that already carries this frame's sequence is replaced in place, so a
 * replay rebuilds the timeline instead of extending it.
 */
function settleStep(
	turn: AgentTurn,
	frame: Extract<AgentFrame, { type: 'tool' }>,
	seq: number
): { steps: AgentStep[]; queue: AgentCall[] } {
	const verdict = stepVerdict(frame.ok, frame.code);

	const known = turn.steps.findIndex((step) => step.seq === seq);
	if (known >= 0) {
		const steps = turn.steps.slice();
		steps[known] = {
			...steps[known],
			tool: frame.name,
			verdict,
			reason: frame.reason,
			code: frame.code,
			settledAt: frame.at ?? null
		};
		return { steps, queue: turn.queue };
	}

	const step: AgentStep = {
		index: turn.steps.length + 1,
		tool: frame.name,
		verdict,
		reason: frame.reason,
		code: frame.code,
		settledAt: frame.at ?? null,
		seq
	};
	return {
		steps: [...turn.steps, step],
		queue: turn.queue.length > 0 ? turn.queue.slice(1) : turn.queue
	};
}

/**
 * One frame, applied to one turn. Pure, so the panel holds no frame logic.
 *
 * `at` is the frame's sequence when the caller knows it (the SSE `id:`, or a
 * server-sent `seq`); otherwise the turn counts its own frames from the `turn`
 * announcement. Three rules decide what a resumed stream can and cannot do:
 *
 *  - A terminal frame is folded in only while the turn is streaming. That is what
 *    keeps a replayed `answer` from being rendered twice, and it is deliberately
 *    independent of the sequence number.
 *  - Any other frame whose sequence was already applied is dropped. A replay,
 *    whether it repeats one frame or a hundred, changes nothing.
 *  - A `turn` frame is idempotent: it names the stream and the key the server
 *    used, and both only ever get more specific.
 *
 * The timeline follows the same rule one level down: a step is settled by the
 * `tool` frame that carries its sequence, so a replayed frame replaces the row it
 * already made and never adds a second one.
 */
export function applyAgentFrame(turn: AgentTurn, frame: AgentFrame, at?: number): AgentFrameResult {
	if (frame.type === 'ready') return { turn, fresh: false, seq: turn.seq };

	const terminal = frame.type === 'answer' || frame.type === 'error';
	if (terminal && turn.status !== 'streaming') {
		return { turn, fresh: false, seq: turn.seq };
	}
	if (!terminal && turn.status !== 'streaming' && frame.type !== 'turn') {
		return { turn, fresh: false, seq: turn.seq };
	}

	const seq = at ?? frame.seq ?? turn.seq + 1;
	if (!terminal && seq <= turn.seq) return { turn, fresh: false, seq: turn.seq };

	switch (frame.type) {
		case 'turn':
			return {
				turn: {
					...turn,
					streamId: frame.streamId,
					// The server names the key it ran the turn under. A retry must use that
					// one, not the one this panel happened to mint.
					key: frame.idempotencyKey ?? turn.key,
					conversationId: frame.conversationId ?? turn.conversationId,
					seq
				},
				fresh: true,
				seq
			};
		case 'status':
			return { turn: { ...turn, phase: frame.phase, seq }, fresh: true, seq };
		case 'token':
			return { turn: { ...turn, text: turn.text + frame.text, seq }, fresh: true, seq };
		case 'tool': {
			const { steps, queue } = settleStep(turn, frame, seq);
			return { turn: { ...turn, steps, queue, seq }, fresh: true, seq };
		}
		case 'calls': {
			// An empty list is not a summary of anything; the running queue stands.
			if (frame.calls.length === 0) {
				return { turn: { ...turn, seq }, fresh: false, seq };
			}
			// A batch is what the gateway is *about* to run: it queues steps and does
			// not create one. A call that never settles is never shown as work done.
			if (frame.calls.every((call) => call.ok === null)) {
				return { turn: { ...turn, queue: frame.calls, seq }, fresh: true, seq };
			}
			// A summary with verdicts. `tool` frames own the timeline, so a summary
			// that arrives after them says nothing this panel has not already got.
			return { turn: { ...turn, seq }, fresh: false, seq };
		}
		case 'answer':
			return {
				turn: {
					...turn,
					text: frame.text !== '' ? frame.text : turn.text,
					calls: frame.calls,
					proposals: frame.proposals,
					phase: null,
					status: 'answered',
					seq
				},
				fresh: true,
				seq
			};
		case 'error':
			return {
				turn: {
					...turn,
					refusal: { reason: frame.reason, message: frame.message },
					phase: null,
					status: 'refused',
					seq
				},
				fresh: true,
				seq
			};
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
	/** The close code, when a socket closed. `null` for a refusal before one existed. */
	code: number | null;
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

export type AgentResumeOutcome =
	| { status: 'sent' }
	/** The link is not open; the resume frame was not sent. */
	| { status: 'waiting'; message: string };

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

	/**
	 * Ask for the rest of a turn.
	 *
	 * `from` is the first sequence the panel does not have: the server replays the
	 * stream from there and then tails the live turn. A closed socket answers
	 * `waiting` rather than throwing — the caller decides whether to wait for the
	 * next open or read the stream over HTTP instead.
	 */
	resume(streamId: string, from: number): AgentResumeOutcome {
		const socket = this.#socket;
		if (socket === null || socket.readyState !== openState()) {
			return { status: 'waiting', message: 'The agent link is not open, so the turn was not resumed.' };
		}
		try {
			socket.send(
				JSON.stringify({ type: 'resume', streamId, from: Math.max(0, Math.floor(from)) })
			);
		} catch {
			return { status: 'waiting', message: 'The link closed while the turn was being resumed.' };
		}
		return { status: 'sent' };
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
					code: null,
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
						code: null,
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
			return { status: 'failed', trouble: { stage: 'ticket', reason, detail, code: null, retryable: false } };
		}
		if (response.status === 401 || response.status === 403) {
			return { status: 'failed', trouble: { stage: 'ticket', reason, detail, code: null, retryable: false } };
		}
		// A route that is not there will not be there on the second attempt either.
		if (response.status === 404 || response.status === 405 || response.status === 501) {
			return { status: 'failed', trouble: { stage: 'ticket', reason, detail, code: null, retryable: false } };
		}
		// A limiter or a 5xx can clear; the backoff is the honest answer.
		return { status: 'failed', trouble: { stage: 'ticket', reason, detail, code: null, retryable: true } };
	}

	#openSocket(ticket: string): void {
		if (typeof WebSocket === 'undefined') {
			this.#fail({
				stage: 'upgrade',
				reason: null,
				detail: 'this browser has no WebSocket',
				code: null,
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
			this.#fail({ stage: 'upgrade', reason: null, detail: null, code: null, retryable: true });
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
	const code = event.code > 0 ? event.code : null;
	const detail = code === null ? null : `close ${code}`;

	// The two reasons the Worker closes with that a retry cannot fix.
	if (reason === 'agent_schema_ahead' || reason === 'agent_runtime_off') {
		return { stage: 'upgrade', reason, detail, code, retryable: false };
	}

	return { stage: opened ? 'socket' : 'upgrade', reason, detail, code, retryable: true };
}

function parseFrame(data: unknown): AgentFrame | null {
	if (typeof data !== 'string') return null;
	try {
		return readAgentFrame(JSON.parse(data));
	} catch {
		return null;
	}
}

/* -------------------------------------------------------- the same turn, over HTTP */

/** The SSE read of one turn's stream, addressed from the first sequence still wanted. */
export function agentStreamPath(streamId: string, from: number): string {
	return `${STREAM_PATH}/${encodeURIComponent(streamId)}?from=${Math.max(0, Math.floor(from))}`;
}

export interface TurnStreamOptions {
	streamId: string;
	/** The first sequence the caller does not have. */
	from: number;
	/** Each frame, with its SSE `id:` when the stream numbered it. */
	onFrame: (frame: AgentFrame, seq?: number) => void;
	/** Aborted when the panel closes or the turn is answered elsewhere. */
	signal?: AbortSignal;
	timeoutMs?: number;
}

export type TurnStreamOutcome =
	/** `event: done`: the stream settled. The answer either arrived or never existed. */
	| { status: 'done' }
	/** `event: timeout`: the turn is still live and the server stopped tailing. */
	| { status: 'timeout' }
	| { status: 'failed'; reason: string | null; message: string | null };

/**
 * Read one turn's durable stream over HTTP, for the case where the socket will
 * not stay open.
 *
 * `fetch` rather than `EventSource` on purpose: EventSource cannot send the
 * console's admin marker header, and its automatic reconnect would re-read a turn
 * the panel is already holding. The parser below is the SSE shape the endpoint
 * writes: `id:`, `data:`, named control events, blank-line separated, comments
 * ignored.
 */
export async function readTurnStream(options: TurnStreamOptions): Promise<TurnStreamOutcome> {
	const controller = new AbortController();
	const relay = () => controller.abort();
	options.signal?.addEventListener('abort', relay, { once: true });
	const timer = setTimeout(
		() => controller.abort(),
		options.timeoutMs ?? STREAM_TIMEOUT_MS
	);

	const finish = () => {
		clearTimeout(timer);
		options.signal?.removeEventListener('abort', relay);
	};

	let response: Response;
	try {
		response = await fetch(agentStreamPath(options.streamId, options.from), {
			headers: {
				Accept: 'text/event-stream',
				[ADMIN_HEADER]: '1'
			},
			credentials: 'same-origin',
			signal: controller.signal
		});
	} catch {
		finish();
		return { status: 'failed', reason: null, message: null };
	}

	if (!response.ok || response.body === null) {
		// The route's own refusal, when it sent one: `stream_not_found`, a missing
		// identity, a deployment where the runtime went off.
		const body = await readBody(response);
		finish();
		return {
			status: 'failed',
			reason: isRecord(body) ? (readString(body.error) ?? readString(body.reason)) : null,
			message: serverMessage(body)
		};
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });

			for (;;) {
				const cut = blockEnd(buffer);
				if (cut === null) break;
				const block = buffer.slice(0, cut.at);
				buffer = buffer.slice(cut.next);
				const control = readStreamBlock(block, options.onFrame);
				if (control !== null) {
					finish();
					return control;
				}
			}
		}
		finish();
		// A connection that ends without `done` is not a turn that finished.
		return { status: 'failed', reason: null, message: null };
	} catch {
		finish();
		return { status: 'failed', reason: null, message: null };
	}
}

/** Where the next complete SSE block ends, and where the one after it starts. */
function blockEnd(buffer: string): { at: number; next: number } | null {
	const plain = buffer.indexOf('\n\n');
	const crlf = buffer.indexOf('\r\n\r\n');
	if (plain < 0 && crlf < 0) return null;
	if (crlf >= 0 && (plain < 0 || crlf < plain)) return { at: crlf, next: crlf + 4 };
	return { at: plain, next: plain + 2 };
}

/** One block: a frame to pass on, a control answer, or nothing worth printing. */
function readStreamBlock(
	block: string,
	onFrame: (frame: AgentFrame, seq?: number) => void
): TurnStreamOutcome | null {
	let event = '';
	let id: number | undefined;
	const data: string[] = [];

	for (const line of block.split(/\r?\n/)) {
		if (line === '' || line.startsWith(':')) continue;
		const colon = line.indexOf(':');
		const field = colon < 0 ? line : line.slice(0, colon);
		let value = colon < 0 ? '' : line.slice(colon + 1);
		if (value.startsWith(' ')) value = value.slice(1);
		if (field === 'event') event = value;
		else if (field === 'data') data.push(value);
		else if (field === 'id') id = readSeq(value);
	}

	if (event === 'done') return { status: 'done' };
	if (event === 'timeout') return { status: 'timeout' };
	if (event === 'error') {
		const reason = readJsonReason(data.join('\n'));
		return { status: 'failed', reason, message: null };
	}
	if (data.length === 0) return null;

	let raw: unknown;
	try {
		raw = JSON.parse(data.join('\n'));
	} catch {
		return null;
	}
	const frame = readAgentFrame(raw);
	// An unknown frame is skipped, never turned into one: the stream is numbered,
	// so the next frame still lands where it belongs.
	if (frame !== null) onFrame(frame, id);
	return null;
}

/** The `reason` an `event: error` block carries, when it carries one. */
function readJsonReason(data: string): string | null {
	if (data === '') return null;
	try {
		const body: unknown = JSON.parse(data);
		return isRecord(body) ? (readString(body.reason) ?? readString(body.error)) : null;
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
 * What the server says it is doing, in this console's words.
 *
 * The phase tokens are the contract's: `thinking`, `answering`, `waiting` (the
 * loop's heartbeat) and `tool:<name>` for a run in progress. The tool sentences
 * are the operator's phrasing of what that tool does, and an unknown name keeps
 * its own token rather than being rounded to something this console guessed.
 */
export function agentPhaseLine(phase: string): string {
	if (phase === 'thinking') return 'Reading this deployment';
	if (phase === 'answering') return 'Writing the answer';
	if (phase === 'waiting') return 'Still working';
	if (phase.startsWith('tool:')) {
		const tool = phase.slice(5);
		switch (tool) {
			case 'fleet_health':
				return 'Reading the fleet';
			case 'telemetry':
				return 'Running telemetry';
			case 'search_messages':
				return 'Searching the delivery record';
			case 'message_timeline':
				return 'Reading the message timeline';
			case 'diagnose':
				return 'Checking the device';
			case 'flow_ast':
				return 'Reading the flow';
			case 'flow_runs':
				return 'Reading the flow runs';
			case 'read_rules':
				return 'Reading the rules';
			case 'create_rule':
				return 'Drafting a rule';
			case 'create_template':
				return 'Drafting a template';
			case 'stage_workflow_patch':
				return 'Staging the patch';
			case 'create_rule_now':
				return 'Creating a rule';
			case 'send_sms':
				return 'Sending the message';
			case 'deploy_flow':
				return 'Deploying the flow';
			default:
				return `Running ${tool}`;
		}
	}
	return 'Working';
}

/**
 * What one step did, in the operator's words.
 *
 * Two forms, because the verdict decides which one is true. A step that ran is
 * past tense — "Created a rule" — and a step that was refused or broke names the
 * operation without claiming it happened — "Create a rule". The chip beside it
 * carries the outcome, so the row never has to say "could not" twice, and a
 * refused row can never read as though the effect landed.
 *
 * An unknown tool is `Called <name>` / `Call <name>`: the row exists because the
 * gateway received a call with that name, and what the tool does is not something
 * this console can make up.
 */
export function agentStepLine(tool: string, verdict: AgentStepVerdict = 'ok'): string {
	const ran = verdict === 'ok';
	switch (tool) {
		case 'fleet_health':
			return 'Read the fleet';
		case 'telemetry':
			return ran ? 'Ran telemetry' : 'Run telemetry';
		case 'search_messages':
			return ran ? 'Searched the delivery record' : 'Search the delivery record';
		case 'message_timeline':
			return 'Read the message timeline';
		case 'diagnose':
			return ran ? 'Checked the device' : 'Check the device';
		case 'flow_ast':
			return 'Read the flow';
		case 'flow_runs':
			return 'Read the flow runs';
		case 'read_rules':
			return 'Read the rules';
		case 'create_rule':
			return ran ? 'Drafted a rule' : 'Draft a rule';
		case 'create_template':
			return ran ? 'Drafted a template' : 'Draft a template';
		case 'stage_workflow_patch':
			return ran ? 'Staged a workflow patch' : 'Stage a workflow patch';
		case 'create_rule_now':
			return ran ? 'Created a rule' : 'Create a rule';
		case 'send_sms':
			return ran ? 'Sent a message' : 'Send a message';
		case 'deploy_flow':
			return ran ? 'Deployed the flow' : 'Deploy the flow';
		default:
			return ran ? `Called ${tool}` : `Call ${tool}`;
	}
}

/**
 * The gap between two steps, from the stamps the frames themselves carried.
 *
 * Rendered beside a row, never computed from a client clock: a replay that
 * arrives minutes later would otherwise date work that happened in a second.
 * Sub-second work reads in milliseconds, a minute or more in minutes and
 * seconds, and nothing at all when the frames carried no stamp.
 */
export function agentStepElapsed(ms: number): string {
	const value = Math.max(0, ms);
	if (value < 10) return 'now';
	if (value < 1_000) return `${Math.round(value)} ms`;
	if (value < 60_000) return `${(value / 1_000).toFixed(1)} s`;
	const total = Math.round(value / 1_000);
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	return `${minutes} m ${String(seconds).padStart(2, '0')} s`;
}

/**
 * The close, as a diagnostic line: `link closed (1006)`, plus the server's reason
 * when it gave one.
 *
 * It is a fact, not a verdict: no close at this stage is evidence against the
 * gateway, and a reconnect in progress has not failed, so the panel prints this
 * next to the turn rather than printing a sentence that blames anything.
 */
export function agentCloseNote(trouble: AgentTrouble): string | null {
	if (trouble.stage === 'ticket') return null;
	const head = trouble.code === null ? 'link closed' : `link closed (${trouble.code})`;
	return trouble.reason === null ? head : `${head} · ${trouble.reason}`;
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
	/**
	 * Who opened this window. A window is per operator, so a session that did not
	 * open it is refused with `autonomy_other_session` even while it is open.
	 * Absent from an older Worker, where the notion did not exist.
	 */
	actor?: string | null;
	/** True when the caller is the operator the window belongs to. */
	mine?: boolean | null;
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
		actor: typeof value.actor === 'string' ? value.actor : null,
		mine: typeof value.mine === 'boolean' ? value.mine : null,
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
