/**
 * The boundaries for the assistant workbench: `window.fetch`, and `WebSocket`.
 *
 * It patches both once, only in a browser, and only answers what this route
 * needs:
 *
 *   POST /v1/admin/assistant/chat                       the stateless question
 *   POST /v1/admin/assistant/proposals/:id/accept       the one write a card makes
 *   GET  /v1/admin/agent/runtime                        which panel this deployment has
 *   POST /v1/admin/agent/ticket                         the upgrade ticket
 *   GET  /v1/admin/agent/autonomy                       the window (not read by the panel)
 *   GET  /v1/admin/agent/conversation                   the durable transcript
 *   DELETE /v1/admin/agent/conversation                 clearing it
 *   GET  /v1/admin/agent/attachments                    the kept files
 *   POST /v1/admin/agent/attachments                    one multipart file
 *   DELETE /v1/admin/agent/attachments/:id              removing a chip
 *   POST /v1/admin/agent/say                            the question, with key and files
 *   new WebSocket('ws://…/agents/assistant/assistant')  the live link
 *   the shell's own reads                               session, health, alerts, approvals
 *
 * Everything else falls through to the real `fetch` and the real `WebSocket`.
 * `$lib/agent-socket.ts` is untouched: it still mints a ticket, still validates
 * every frame, still drops a tool's output, and still decides when a refusal is
 * terminal. A state that cannot be reached from these boundaries is a state that
 * does not exist, and the report says so.
 *
 * The socket is scripted, not queued: a plan names the moment each frame arrives
 * after the open, and whether the link closes. That is what makes "streaming with
 * no answer yet" and "closed mid-answer" different states rather than different
 * screenshots of the same one.
 */

import type { MockReply, MockSet, SocketPlan, SsePlan } from './fixtures';

type FetchHandler = (
	input: RequestInfo | URL,
	init: RequestInit | undefined,
	realFetch: typeof window.fetch
) => Promise<Response>;

interface StubbedWindow extends Window {
	__dakflareFetchInstalled?: boolean;
	__dakflareFetchHandler?: FetchHandler;
	__assistantSocketInstalled?: boolean;
	/** Every frame the panel sent, so a driven turn can be checked, not assumed. */
	__assistantWorkbenchSent?: string[];
	/** Every `/v1/admin/agent/say` body, so a retry's key can be compared. */
	__assistantWorkbenchAsks?: string[];
	/** How many say requests have been made, for a state whose second answer differs. */
	__assistantWorkbenchSays?: number;
	/**
	 * The harness state, on the window rather than in this module.
	 *
	 * The patch below is installed once per document and closes over this module's
	 * bindings. A hot update re-evaluates the module, so a switcher that wrote to a
	 * fresh `mock` would be writing to an object the installed handler never reads —
	 * every live state then silently answered with the runtime-off default. The
	 * window is the one object both the old closure and the new module share.
	 */
	__assistantWorkbenchMock?: MockSet;
	__assistantWorkbenchTickets?: number;
	__assistantWorkbenchPlan?: SocketPlan;
	__assistantWorkbenchConnections?: number;
}

/** The real constructor, kept before the patch: the dev server's own link still works. */
let realSocket: typeof WebSocket | null = null;

function harness(): StubbedWindow {
	return window as StubbedWindow;
}

/** The mock the switcher last chose. Empty until a state runs. */
function currentMock(): MockSet {
	return harness().__assistantWorkbenchMock ?? {};
}

/** Chosen by the switcher before the launcher is clicked. */
export function setMock(next: MockSet): void {
	const target = harness();
	target.__assistantWorkbenchMock = next;
	target.__assistantWorkbenchTickets = 0;
	target.__assistantWorkbenchConnections = 0;
	target.__assistantWorkbenchSays = 0;
	target.__assistantWorkbenchAsks = [];
	// The socket plan is read when the panel constructs one, which is after this.
	target.__assistantWorkbenchPlan = next.socket ?? {};
}

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

function answer(reply: MockReply): Promise<Response> {
	switch (reply.kind) {
		case 'json':
			return Promise.resolve(jsonResponse(reply.status, reply.body));
		case 'text':
			return Promise.resolve(
				new Response(reply.body, {
					status: reply.status,
					headers: { 'content-type': 'text/plain; charset=utf-8' }
				})
			);
		case 'throw':
			return Promise.reject(new TypeError('Failed to fetch'));
		case 'hold':
			// Accepted and never answered. The component's own `asking` /
			// `accepting` lock is what the screenshot then shows.
			return new Promise<Response>(() => {});
	}
}

/** The runtime's own answer when a state does not name one: off, which is the default. */
const RUNTIME_OFF = {
	enabled: false,
	schemaVersion: 1,
	sessions: 0,
	pinnedName: 'assistant'
};

/** A 201 the panel can read: a ticket and the moment it stops being usable. */
function freshTicket(): MockReply {
	const ticket = `tk_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
	return { kind: 'json', status: 201, body: { ticket, expires_at: Date.now() + 60_000 } };
}

/**
 * The durable stream, as the real route writes it.
 *
 * One frame per `data:` line with its sequence in `id:`, a blank line between
 * events, and a named event at the end. The reader on the console side is the
 * real one; this only has to be the bytes.
 */
function streamResponse(scripted: SsePlan): Response {
	if (scripted.missing === true) {
		return jsonResponse(404, { error: 'stream_not_found' });
	}

	const encoder = new TextEncoder();
	let stopped = false;

	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			const write = (text: string): void => {
				if (stopped) return;
				try {
					controller.enqueue(encoder.encode(text));
				} catch {
					stopped = true;
				}
			};

			void (async () => {
				let elapsed = 0;
				let seq = 0;
				for (const entry of scripted.events ?? []) {
					const wait = Math.max(0, entry.at - elapsed);
					elapsed = entry.at;
					if (wait > 0) await new Promise<void>((resolve) => window.setTimeout(resolve, wait));
					if (stopped) return;
					const id = entry.seq ?? seq;
					seq = id + 1;
					write(`id: ${id}\ndata: ${JSON.stringify(entry.frame ?? {})}\n\n`);
				}
				if ((scripted.endAt ?? 0) > 0) {
					await new Promise<void>((resolve) =>
						window.setTimeout(resolve, scripted.endAt ?? 0)
					);
				}
				write(`event: ${scripted.end ?? 'done'}\ndata: {}\n\n`);
				if (stopped) return;
				stopped = true;
				try {
					controller.close();
				} catch {
					// Already closed by the reader going away.
				}
			})();
		},
		cancel() {
			stopped = true;
		}
	});

	return new Response(body, {
		status: 200,
		headers: {
			'content-type': 'text/event-stream; charset=utf-8',
			'cache-control': 'no-store'
		}
	});
}

const HEALTH = {
	ok: true,
	version: '6.1.0',
	schema_ready: true,
	migrations: [],
	bindings: { DB: true, SMS_QUEUE: true, DEVICE_HUB: true, ADMIN_LIMITER: true },
	missing_bindings: [],
	retention_days: 30,
	counts: { devices: 1, messages: 214, rules: 3, pairing_codes: 0, open_alerts: 0 },
	open_alerts: 0,
	last_message_at: Date.now() - 90_000,
	checked_at: Date.now(),
	auth_mode: 'new',
	auth_configured: true
};

/* ------------------------------------------------------------ the socket */

type Listener = (event: unknown) => void;
type SocketProperty = 'onopen' | 'onmessage' | 'onclose' | 'onerror';

/** How long after construction the upgrade resolves. A real one is not instant either. */
const OPEN_AFTER_MS = 30;

/**
 * First, then the reconnects in order; the last plan repeats for every later one.
 *
 * Read from the window for the same reason as the mock: the class below is
 * constructed through the patch `installFetchStub` installed, which may predate a
 * hot update of this module.
 */
function planFor(index: number): SocketPlan {
	const plan = harness().__assistantWorkbenchPlan ?? {};
	if (index === 0) return plan;
	const later = plan.next ?? [];
	if (later.length === 0) return plan;
	return later[Math.min(index - 1, later.length - 1)];
}

/**
 * One scripted connection.
 *
 * It answers the four members the client uses (`open`, `message`, `close`,
 * `error`), the two ways of subscribing to them, and `send`. A URL that is not the
 * agent's is handed to the real constructor, so the dev server's own link is not
 * collateral.
 */
class FakeSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;

	readyState = 0;
	url: string;
	onopen: Listener | null = null;
	onmessage: Listener | null = null;
	onclose: Listener | null = null;
	onerror: Listener | null = null;

	#timers: number[] = [];
	#listeners = new Map<string, Set<Listener>>();
	/** Set while this connection is waiting for the client's `resume` frame. */
	#awaiting: SocketPlan | null = null;

	constructor(url: string) {
		this.url = url;
		if (!url.includes('/agents/') || !window.location.pathname.includes('/states/assistant')) {
			const real = realSocket;
			// Not this workbench's socket. Returning an object from a constructor is
			// legal and is the least invasive way to leave everything else alone.
			return (real === null ? this : new real(url)) as unknown as FakeSocket;
		}

		const scripted = planFor(harness().__assistantWorkbenchConnections ?? 0);
		harness().__assistantWorkbenchConnections = (harness().__assistantWorkbenchConnections ?? 0) + 1;
		const target = window as StubbedWindow;
		target.__assistantWorkbenchSent ??= [];

		if (scripted.refuse === true) {
			// A refused upgrade produces a close and no open, and carries no status a
			// browser will show. The ticket POST is where a refusal is diagnosable.
			this.#later(() => this.#close(scripted.closeCode ?? 1006, scripted.closeReason ?? ''), 40);
			return;
		}

		this.#later(() => {
			this.readyState = 1;

			// A resumed turn says nothing until it is asked: the frames are what the
			// resume frame brings back, not what the connection carries on its own.
			// The flag is set before the open event, because a client that resumes the
			// moment the socket opens sends its frame inside that event.
			if (scripted.awaitResume === true) this.#awaiting = scripted;

			this.#emit('open', { type: 'open' });

			if (scripted.ready !== false) {
				this.#emit('message', {
					type: 'message',
					data: JSON.stringify({ type: 'ready', name: 'assistant' })
				});
			}

			if (scripted.awaitResume === true) return;

			this.#play(scripted);
		}, OPEN_AFTER_MS);
	}

	addEventListener(type: string, listener: Listener): void {
		const set = this.#listeners.get(type) ?? new Set<Listener>();
		set.add(listener);
		this.#listeners.set(type, set);
	}

	removeEventListener(type: string, listener: Listener): void {
		this.#listeners.get(type)?.delete(listener);
	}

	send(data: string): void {
		const target = window as StubbedWindow;
		target.__assistantWorkbenchSent ??= [];
		target.__assistantWorkbenchSent.push(data);

		const awaiting = this.#awaiting;
		if (awaiting === null) return;

		let isResume = false;
		try {
			const parsed: unknown = JSON.parse(data);
			isResume =
				typeof parsed === 'object' &&
				parsed !== null &&
				(parsed as Record<string, unknown>).type === 'resume';
		} catch {
			isResume = false;
		}
		if (!isResume) return;

		this.#awaiting = null;
		this.#play(awaiting);
	}

	close(code = 1000, reason = ''): void {
		if (this.readyState === 3) return;
		this.#close(code, reason);
	}

	/** The rest of this connection's story, timed from now. */
	#play(scripted: SocketPlan): void {
		for (const entry of scripted.frames ?? []) {
			this.#later(() => {
				this.#emit('message', { type: 'message', data: JSON.stringify(entry.frame) });
			}, entry.at);
		}

		if (scripted.closeAt !== undefined) {
			this.#later(
				() => this.#close(scripted.closeCode ?? 1006, scripted.closeReason ?? ''),
				scripted.closeAt
			);
		}
	}

	#later(run: () => void, ms: number): void {
		this.#timers.push(window.setTimeout(run, ms));
	}

	#emit(type: string, event: unknown): void {
		const property = this[`on${type}` as SocketProperty];
		property?.(event);
		for (const listener of this.#listeners.get(type) ?? []) listener(event);
	}

	#close(code: number, reason: string): void {
		for (const timer of this.#timers) window.clearTimeout(timer);
		this.#timers = [];
		this.readyState = 3;
		this.#emit('close', { type: 'close', code, reason, wasClean: code === 1000 });
	}
}

/* ------------------------------------------------------------- installing */

export function installFetchStub(): void {
	if (typeof window === 'undefined') return;
	const target = window as StubbedWindow;

	if (!target.__assistantSocketInstalled) {
		target.__assistantSocketInstalled = true;
		realSocket = window.WebSocket;
		window.WebSocket = FakeSocket as unknown as typeof WebSocket;
	}

	target.__dakflareFetchHandler = (input, init, realFetch) => {
		const raw = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
		let path: string;
		try {
			path = new URL(raw, window.location.href).pathname;
		} catch {
			return realFetch(input, init);
		}

		if (path === '/v1/admin/assistant/chat') {
			const reply = currentMock().chat;
			return reply === undefined
				? Promise.reject(new Error('the workbench has no chat fixture for this state'))
				: answer(reply);
		}

		if (path === '/v1/admin/agent/say') {
			const win = harness();
			win.__assistantWorkbenchSays = (win.__assistantWorkbenchSays ?? 0) + 1;
			win.__assistantWorkbenchAsks ??= [];
			if (typeof init?.body === 'string') win.__assistantWorkbenchAsks.push(init.body);
			const mock = currentMock();
			// A retry is the second request; a state can give it a different answer,
			// which is how `replayed` is reached honestly.
			if (win.__assistantWorkbenchSays > 1 && mock.sayAfter !== undefined) {
				return answer(mock.sayAfter);
			}
			const reply = mock.say ?? mock.chat;
			return reply === undefined
				? Promise.reject(new Error('the workbench has no say fixture for this state'))
				: answer(reply);
		}

		if (path === '/v1/admin/agent/conversation') {
			const mock = currentMock();
			if ((init?.method ?? 'GET').toUpperCase() === 'DELETE') {
				return mock.clear === undefined
					? Promise.resolve(jsonResponse(200, { ok: true }))
					: answer(mock.clear);
			}
			return answer(
				mock.conversation ?? {
					kind: 'json',
					status: 200,
					body: { conversation: 'conversation:owner@example.com', messages: [], truncated: false }
				}
			);
		}

		if (path === '/v1/admin/agent/attachments') {
			const mock = currentMock();
			if ((init?.method ?? 'GET').toUpperCase() === 'POST') {
				return mock.upload === undefined
					? Promise.reject(new Error('the workbench has no upload fixture for this state'))
					: answer(mock.upload);
			}
			return answer(mock.attachments ?? { kind: 'json', status: 200, body: { attachments: [] } });
		}

		if (/^\/v1\/admin\/agent\/attachments\/[^/]+$/.test(path)) {
			const mock = currentMock();
			return mock.remove === undefined
				? Promise.resolve(jsonResponse(200, { ok: true }))
				: answer(mock.remove);
		}

		if (/^\/v1\/admin\/assistant\/proposals\/[^/]+\/accept$/.test(path)) {
			const reply = currentMock().accept;
			return reply === undefined
				? Promise.reject(new Error('the workbench has no accept fixture for this state'))
				: answer(reply);
		}

		if (path === '/v1/admin/agent/runtime') {
			return answer(currentMock().runtime ?? { kind: 'json', status: 200, body: RUNTIME_OFF });
		}

		if (path === '/v1/admin/agent/ticket') {
			const win = harness();
			win.__assistantWorkbenchTickets = (win.__assistantWorkbenchTickets ?? 0) + 1;
			const mock = currentMock();
			// A state can hold the second ticket to freeze a reconnect: the link then
			// sits in `ticket`, which is what a screenshot of a dropped link shows.
			if (win.__assistantWorkbenchTickets > 1 && mock.ticketAfter !== undefined) {
				return answer(mock.ticketAfter);
			}
			return answer(mock.ticket ?? freshTicket());
		}

		if (path === '/v1/admin/agent/autonomy') {
			// The panel never reads this; answered so a stray read is not a 404 that
			// looks like the runtime refusing the page.
			return Promise.resolve(
				jsonResponse(200, {
					enabled: false,
					expiresAt: null,
					caps: { sms: null, writes: null },
					usage: { day: null, tokens: null, writes: null, sms: null }
				})
			);
		}

		// The durable stream, read over HTTP when the socket will not come back.
		if (/^\/agents\/assistant\/assistant\/streams\/[^/]+$/.test(path)) {
			const scripted = currentMock().sse;
			return Promise.resolve(
				scripted === undefined
					? jsonResponse(404, { error: 'stream_not_found' })
					: streamResponse(scripted)
			);
		}

		// The shell around the panel. Without these the layout cannot boot in a
		// dev server with no Worker behind it, and the panel would never mount.
		if (path === '/admin/session') {
			return Promise.resolve(jsonResponse(401, { error: 'missing_auth_headers' }));
		}
		if (path === '/v1/auth/me') {
			return Promise.resolve(
				jsonResponse(200, {
					ok: true,
					user: {
						id: 'usr_jony_01',
						email: 'jony@example.com',
						name: 'Jony Reyes',
						role: 'owner',
						twoFactorEnabled: true
					},
					expires_at: Date.now() + 6 * 60 * 60 * 1000,
					auth_mode: 'new'
				})
			);
		}
		if (path === '/v1/admin/health') return Promise.resolve(jsonResponse(200, HEALTH));
		if (path === '/v1/admin/alerts') return Promise.resolve(jsonResponse(200, { alerts: [] }));
		if (path === '/v1/admin/approvals') {
			return Promise.resolve(jsonResponse(200, { approvals: [] }));
		}

		return realFetch(input, init);
	};

	if (target.__dakflareFetchInstalled) return;
	target.__dakflareFetchInstalled = true;

	const realFetch = window.fetch.bind(window);
	window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const handler = target.__dakflareFetchHandler;
		return handler ? handler(input, init, realFetch) : realFetch(input, init);
	};
}
