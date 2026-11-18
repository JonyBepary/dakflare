<script lang="ts">
	/**
	 * The floating assistant.
	 *
	 * One button, bottom-right, above every page of the console; one panel that is
	 * not a modal and not a route. It asks about the page the operator is standing
	 * on, prints the answer, and renders the proposals as cards.
	 *
	 * Two paths, and the deployment decides which one:
	 *
	 *  - **Stateless, and this is the default.** `POST /v1/admin/assistant/chat`
	 *    answers with one document: an answer, or plain text, or a refusal. Every
	 *    deployment behaves like this until someone turns the agent runtime on, and
	 *    nothing on this panel says anything about a runtime that is off.
	 *  - **Live.** `GET /v1/admin/agent/runtime` said `enabled: true`, so the panel
	 *    holds an `AgentLink` (`$lib/agent-socket`): a ticket, then a WebSocket. The
	 *    answer streams in, the steps that ran are drawn as a timeline under it, and
	 *    a turn that was cut off is asked for again rather than abandoned: its frames
	 *    live in a durable stream, so a dropped socket is a lost connection, not a
	 *    lost answer.
	 *
	 * Seven rules this panel keeps, on both paths:
	 *
	 *  - No invented state. Each failure is one line from `failureLine()` or
	 *    `agentTroubleLine()`, with the gateway's own detail under it only when the
	 *    gateway sent one.
	 *  - A refusal never replaces the model's words. A turn refused after the model
	 *    had written three sentences shows both, in the order they happened.
	 *  - A tool is a name and a verdict. Its output is dropped in the socket module
	 *    and there is no template here that could print it.
	 *  - A step exists because a `tool` frame settled it. The plan line counts the
	 *    batch the gateway announced in `calls`; the timeline is what already ran.
	 *    Neither is filled in from what this panel expected to happen next.
	 *  - One run is a note, several are a timeline: a lone successful read stays a
	 *    single quiet line, and the rail only appears when there is more than one
	 *    step or one of them did not succeed.
	 *  - No accept on `stage_workflow_patch`. That kind belongs to the workflow
	 *    editor's ghost banner; this panel only hands the patch over when an editor
	 *    is mounted, and explains the way there when it is not.
	 *  - A retry after a lost link reuses the turn's idempotency key, so a question
	 *    that did reach the runtime is not asked twice. The same rule makes a
	 *    resume safe: the turn is picked up where its sequence stopped, and the
	 *    answer is folded in once.
	 *
	 * The button is fixed, so `+layout.svelte` gives the main region a floor under
	 * it: at 390px the page's last row must never end behind this control.
	 */
	import { onDestroy, tick } from 'svelte';
	import { page } from '$app/state';
	import {
		acceptProposal,
		askAssistant,
		failureLine,
		failureTone,
		handPatchToEditor,
		workflowPatchSinkReady,
		type AssistantContext,
		type ChatOutcome,
		type Failure,
		type Proposal
	} from '$lib/assistant';
	import {
		AgentLink,
		agentCloseNote,
		agentLinkLabel,
		agentPhaseLine,
		agentRefusalLine,
		agentStepElapsed,
		agentStepLine,
		agentTroubleLine,
		applyAgentFrame,
		beginTurn,
		newIdempotencyKey,
		readAgentRuntime,
		readTurnStream,
		type AgentEvent,
		type AgentFrame,
		type AgentLinkState,
		type AgentTrouble,
		type AgentTurn
	} from '$lib/agent-socket';
	import { announce } from '$lib/announce.svelte';
	import { BASE, ROUTES } from '$lib/paths';
	import { session } from '$lib/session.svelte';
	import AssistantProposalCard, { type ProposalResult } from './AssistantProposalCard.svelte';
	import Icon from './Icon.svelte';
	import Spinner from './Spinner.svelte';

	const uid = $props.id();
	const panelId = `assistant-panel-${uid}`;
	const inputId = `assistant-question-${uid}`;
	const contextId = `assistant-context-${uid}`;

	/**
	 * A turn whose socket went away, and what this panel is doing about it.
	 *
	 * The durable stream means a dropped link is not the end of the answer, so the
	 * panel only says a turn was lost after it has actually tried to pick it up.
	 */
	type Recovery = { kind: 'resuming'; via: 'socket' | 'sse' } | { kind: 'lost' };

	/**
	 * Three fresh tickets and three sockets inside about a second, or the durable
	 * stream is the better path. A ticket is cheap and single use, so a reconnect
	 * is worth a few tries; it is not worth a minute of a blank panel.
	 */
	const LINK_ATTEMPTS = 3;
	const LINK_BACKOFF_MS = 300;

	/** One SSE read that times out may simply have been tailing a slow turn. */
	const STREAM_ATTEMPTS = 2;

	/** Frame types that are the resume refusing, not the turn: read the stream instead. */
	const RESUME_REFUSALS = new Set([
		'stream_not_found',
		'bad_request',
		'agent_identity_missing',
		'unauthorised'
	]);

	/** The refusal reasons this panel has a sentence for; an unknown one prints its token. */
	const NAMED_REFUSALS = new Set([
		'grant_expired',
		'cap_reached',
		'turn_cap',
		'origin_refused',
		'agent_origin_untrusted',
		'agent_origin_missing',
		'agent_runtime_off',
		'session_expired'
	]);

	let open = $state(false);
	let question = $state('');
	/** The question the current answer belongs to, so Try again repeats that one. */
	let asked = $state('');
	let asking = $state(false);
	let outcome = $state<ChatOutcome | null>(null);

	/** `unknown` until the runtime read answers; `off` never opens a socket. */
	let runtime = $state<'unknown' | 'on' | 'off'>('unknown');
	let linkState = $state<AgentLinkState>('idle');
	let trouble = $state<AgentTrouble | null>(null);
	/** The object's own name, from the `ready` frame. Shown as a title, not a claim. */
	let agentName = $state<string | null>(null);
	let turn = $state<AgentTurn | null>(null);
	/** One question held while the link is being opened. */
	let queued = $state<{ question: string; key: string } | null>(null);

	/**
	 * What happened to a turn whose link went away.
	 *
	 * `resuming` is the panel still working on the answer — `via` says whether it
	 * is on a fresh socket or reading the durable stream over HTTP. `lost` is the
	 * honest end of that road, and it is only ever reached after an attempt.
	 */
	let recovery = $state<Recovery | null>(null);
	/** The close, as a diagnostic line: `link closed (1006)`, while it matters. */
	let closeNote = $state<string | null>(null);

	let acceptingId = $state<string | null>(null);
	let results = $state<Record<string, ProposalResult>>({});
	/**
	 * Whether a workflow editor is mounted right now.
	 *
	 * The sink lives in a module variable, so this is re-read rather than
	 * subscribed: on open, whenever the route changes (the panel outlives
	 * navigation, so following the card's "open the workflow" link mounts an
	 * editor after the panel was opened), and whenever a new answer arrives.
	 */
	let stageReady = $state(false);

	let launcher = $state<HTMLButtonElement | null>(null);
	let field = $state<HTMLInputElement | null>(null);

	/** Drops an answer that arrives after the panel was closed or re-asked. */
	let sequence = 0;

	/** The live link. Not reactive: its events are mirrored into the state above. */
	let agent: AgentLink | null = null;

	/** The in-flight SSE read, when the socket would not come back. */
	let stream: AbortController | null = null;
	/** A resume that this number no longer matches is stale and changes nothing. */
	let resumeToken = 0;

	/**
	 * Where the operator is. The chat endpoint takes the route and, on the editor,
	 * the flow, so an answer can name the thing on screen instead of asking which
	 * flow was meant.
	 */
	const context = $derived.by((): AssistantContext => {
		const route = page.url.pathname;
		if (route === ROUTES.workflowEdit) {
			const flowId = page.url.searchParams.get('id');
			return flowId === null ? { route } : { route, flowId };
		}
		return { route };
	});

	const contextLabel = $derived.by(() => {
		const route = context.route ?? '';
		const short = route.startsWith(BASE) ? route.slice(BASE.length) || '/' : route;
		return context.flowId ? `${short} · flow ${context.flowId}` : short;
	});

	const canAsk = $derived(!asking && question.trim() !== '');
	const live = $derived(runtime === 'on');
	const linkWord = $derived(agentLinkLabel(linkState));
	const unfinished = $derived(turn !== null && turn.status === 'streaming');
	/**
	 * A turn whose answer stopped arriving.
	 *
	 * `recovery` is a fact about this turn, not about the link: a reconnect clears
	 * `trouble`, and the point of this line is that the frames that were coming
	 * before the drop are not coming back on their own.
	 */
	const resuming = $derived(recovery?.kind === 'resuming');
	const cutOff = $derived(unfinished && recovery?.kind === 'lost');

	/**
	 * The timeline, as the turn holds it.
	 *
	 * `steps` is what settled, and nothing else: a row appears when a `tool` frame
	 * says a run happened. `pending` is the batch the gateway announced and has not
	 * finished, which is what the plan line counts. The two are different facts and
	 * are kept apart on purpose — queuing a call is not doing it.
	 */
	const steps = $derived(turn?.steps ?? []);
	const pending = $derived(turn?.queue.length ?? 0);
	/** The plan line's place, only while a step is actually queued. */
	const planStep = $derived(steps.length + 1);
	const planTotal = $derived(steps.length + pending);

	/**
	 * One quiet line or a timeline. A single successful read is a note, not work to
	 * audit; two steps, or any step that did not succeed, is the rail.
	 */
	const timeline = $derived(steps.length >= 2 || steps.some((step) => step.verdict !== 'ok'));

	// The sink appears and disappears with the editor, which is a different
	// component on a different route. Nothing else would tell this panel.
	$effect(() => {
		const route = page.url.pathname;
		void route;
		void outcome;
		stageReady = workflowPatchSinkReady();
	});

	onDestroy(() => {
		sequence += 1;
		// A read that is still tailing must not write into a panel that is gone.
		resumeToken += 1;
		stream?.abort();
		stream = null;
		agent?.close();
		agent = null;
	});

	async function toggle(): Promise<void> {
		if (open) close();
		else await show();
	}

	async function show(): Promise<void> {
		open = true;
		stageReady = workflowPatchSinkReady();
		await tick();
		field?.focus();
		void startLive();
	}

	/** One link, tuned for a panel: a few quick reconnects, then the stream. */
	function newLink(): AgentLink {
		return new AgentLink({
			onEvent: handleAgentEvent,
			maxAttempts: LINK_ATTEMPTS,
			baseDelayMs: LINK_BACKOFF_MS
		});
	}

	/**
	 * Ask the runtime whether this deployment has one, and open a link when it does.
	 *
	 * A read that fails is not a reason to try the socket: the stateless path is
	 * the default and it works, so `off` is the honest answer to both.
	 */
	async function startLive(): Promise<void> {
		const id = sequence;
		const read = await readAgentRuntime();
		if (!open || id !== sequence) return;

		if (read.status !== 'ok' || !read.runtime.enabled) {
			runtime = 'off';
			return;
		}

		runtime = 'on';
		// The panel may have asked before this read resolved, and that ask already
		// made a link. Reuse it: closing it here would drop a turn that had started.
		if (agent === null) agent = newLink();
		await agent.connect();
	}

	function handleAgentEvent(event: AgentEvent): void {
		if (!open) return;
		if (event.kind === 'link') {
			onLink(event.state, event.trouble);
			return;
		}
		onFrame(event.frame);
	}

	/**
	 * The link moved. Most of this is the state above; the part that matters here
	 * is a turn in flight, because a close then is a transport problem the durable
	 * stream can answer.
	 */
	function onLink(state: AgentLinkState, next: AgentTrouble | null): void {
		const wasOpen = linkState === 'open';
		linkState = state;
		trouble = next;

		if (state === 'open') {
			// A reconnect during a resume is not a new question: ask for the rest of
			// the turn from where its frames stopped.
			if (recovery?.kind === 'resuming' && recovery.via === 'socket') {
				resumeOnSocket();
				return;
			}
			sendQueued();
			return;
		}

		const streaming = turn !== null && turn.status === 'streaming';
		if (wasOpen && streaming && turn !== null) {
			// The link dropped with a turn in flight. Keep the turn: it is in a
			// durable stream, so what is at stake is the connection, not the answer.
			queued = null;
			asking = false;
			closeNote = next === null ? null : agentCloseNote(next);
			if (turn.streamId === null) {
				// No stream was ever named, so there is nothing to ask for. This is the
				// one close after which the text that arrived is all there will be.
				recovery = { kind: 'lost' };
			} else {
				recovery = { kind: 'resuming', via: 'socket' };
				asking = true;
			}
		}

		if (state !== 'closed') return;

		// Final: no further attempt is coming.
		if (turn !== null && turn.status === 'streaming') {
			if (turn.streamId !== null) {
				void resumeViaStream();
				return;
			}
			asking = false;
			// Nothing arrived at all: the refusal is the story, and the line below it
			// stays the gateway's own.
			if (turn.text !== '' || turn.steps.length > 0) recovery = { kind: 'lost' };
			return;
		}

		asking = false;

		if (next?.reason === 'agent_runtime_off') {
			// The runtime went off between the read and the ticket: the stateless
			// path is the honest fallback, and it is the same question.
			const holding = queued;
			queued = null;
			runtime = 'off';
			agent?.close();
			agent = null;
			turn = null;
			if (holding !== null) {
				asking = true;
				void askStateless(holding.question);
			}
		}
	}

	/** Send the resume frame for the current turn, when a socket just came back. */
	function resumeOnSocket(): void {
		const current = turn;
		if (current === null || current.streamId === null) return;
		if (agent === null) {
			void resumeViaStream();
			return;
		}
		const sent = agent.resume(current.streamId, current.seq + 1);
		if (sent.status === 'waiting') {
			// It closed between the open event and the send. The link's own retry opens
			// another socket, and that open sends this again.
			return;
		}
	}

	/**
	 * Read the turn's durable stream over HTTP.
	 *
	 * This is the last attempt, not a first choice: the socket carries live frames,
	 * and the stream is here for the case where a browser will not keep a socket
	 * open. A `timeout` event means the turn is still live and the server stopped
	 * tailing, so one more read from where it stopped is worth making.
	 */
	async function resumeViaStream(): Promise<void> {
		const current = turn;
		if (current === null || current.streamId === null) return;

		const token = ++resumeToken;
		const streamId = current.streamId;
		recovery = { kind: 'resuming', via: 'sse' };
		asking = true;

		for (let attempt = 0; attempt < STREAM_ATTEMPTS; attempt += 1) {
			const controller = new AbortController();
			stream = controller;
			const from = (turn?.seq ?? 0) + 1;
			const result = await readTurnStream({
				streamId,
				from,
				signal: controller.signal,
				onFrame: (frame, seq) => onFrame(frame, seq)
			});
			if (stream === controller) stream = null;

			if (token !== resumeToken || !open) return;
			if (turn === null || turn.status !== 'streaming') return;
			if (result.status === 'timeout') continue;
			break;
		}

		if (token !== resumeToken || !open) return;
		if (turn !== null && turn.status === 'streaming') {
			recovery = { kind: 'lost' };
			asking = false;
		}
	}

	/** Stop any in-flight stream read and forget the recovery it belonged to. */
	function resetRecovery(): void {
		resumeToken += 1;
		stream?.abort();
		stream = null;
		recovery = null;
		closeNote = null;
	}

	/** One frame, folded into the turn it belongs to. */
	function onFrame(frame: AgentFrame, seq?: number): void {
		if (frame.type === 'ready') {
			agentName = frame.name !== '' ? frame.name : null;
			return;
		}

		const current = turn;
		// Nothing to attach a frame to: this panel did not ask the question it
		// answers. Rendering it would invent a conversation.
		if (current === null) return;

		// The socket refused the *resume*, not the turn: the stream is still there,
		// and asking for it over HTTP is the same request the socket failed to serve.
		if (frame.type === 'error' && resuming && RESUME_REFUSALS.has(frame.reason)) {
			void resumeViaStream();
			return;
		}

		const result = applyAgentFrame(current, frame, seq);
		turn = result.turn;
		if (!result.fresh) return;

		if (frame.type === 'answer') {
			asking = false;
			queued = null;
			resetRecovery();
			const count = turn?.proposals.length ?? 0;
			// The answer frame's own count when it sent one, otherwise the steps that
			// settled: a five-step turn is five tool runs whether or not the last
			// frame repeated the number.
			const calls = Math.max(frame.calls, turn?.steps.length ?? 0);
			announce(
				calls > 0
					? `The assistant answered, after ${calls} ${calls === 1 ? 'tool run' : 'tool runs'}.`
					: count === 0
						? 'The assistant answered.'
						: `The assistant answered, with ${count} ${count === 1 ? 'proposal' : 'proposals'}.`
			);
			return;
		}

		if (frame.type === 'error') {
			asking = false;
			queued = null;
			resetRecovery();
			announce(agentRefusalLine(frame.reason));
		}
	}

	function sendQueued(): void {
		const holding = queued;
		queued = null;
		if (holding === null) return;

		if (agent === null) {
			queued = holding;
			return;
		}

		const sent = agent.ask(holding.question, holding.key);
		if (sent.status === 'waiting') {
			// It closed between the event and the send. The next `open` gets it.
			queued = holding;
			return;
		}
		if (sent.status === 'refused') {
			asking = false;
			turn = null;
			const failure: Failure = { kind: 'refused', message: sent.message };
			outcome = { status: 'failed', failure };
			announce(sent.message);
		}
	}

	function close(): void {
		// No history survives: this is one question at a time, by design.
		open = false;
		question = '';
		asked = '';
		outcome = null;
		asking = false;
		acceptingId = null;
		results = {};
		turn = null;
		queued = null;
		resetRecovery();
		trouble = null;
		linkState = 'idle';
		agentName = null;
		sequence += 1;
		agent?.close();
		agent = null;
		launcher?.focus();
	}

	function onkeydown(event: KeyboardEvent): void {
		if (!open) return;
		if (event.key !== 'Escape') return;
		event.preventDefault();
		close();
	}

	/**
	 * Ask one question, on whichever path this deployment has.
	 *
	 * `reuseKey` is a retry's key: the same question, the same turn, so a runtime
	 * that did receive the first attempt answers instead of running a second one.
	 */
	function runAsk(text: string, reuseKey?: string): void {
		const next = text.trim();
		if (next === '' || asking) return;

		question = next;
		asked = next;
		asking = true;
		outcome = null;
		turn = null;
		queued = null;
		resetRecovery();
		results = {};

		if (runtime === 'on') {
			void askLive(next, reuseKey);
			return;
		}
		void askStateless(next);
	}

	async function askStateless(text: string): Promise<void> {
		const id = ++sequence;
		const result = await askAssistant({ message: text, context });
		if (id !== sequence) return;

		outcome = result;
		asking = false;
		if (result.status === 'ok') {
			const count = result.proposals.length;
			announce(
				count === 0
					? 'The assistant answered.'
					: `The assistant answered, with ${count} ${count === 1 ? 'proposal' : 'proposals'}.`
			);
		} else if (result.status === 'failed') {
			announce(failureLine(result.failure));
		}
	}

	async function askLive(text: string, reuseKey?: string): Promise<void> {
		const key = reuseKey ?? newIdempotencyKey();
		turn = beginTurn(text, key);
		queued = { question: text, key };

		if (agent === null) agent = newLink();
		if (agent.state === 'open') {
			sendQueued();
			return;
		}
		await agent.connect();
	}

	function submit(event: SubmitEvent): void {
		event.preventDefault();
		void runAsk(question);
	}

	async function accept(proposal: Proposal): Promise<void> {
		if (acceptingId !== null) return;
		acceptingId = proposal.id;
		const result = await acceptProposal(proposal.id);
		acceptingId = null;
		results = {
			...results,
			[proposal.id]:
				result.status === 'ok'
					? {
							tone: 'ok',
							text: result.message,
							ids: result.ids,
							detail: result.detail
						}
					: { tone: 'danger', text: failureLine(result.failure), ids: [], detail: null }
		};
		announce(
			result.status === 'ok' ? 'Proposal accepted.' : 'The proposal was not accepted.'
		);
	}

	/**
	 * The editor's ghost staging, reached through the sink it registers. The card
	 * only offers this when that sink exists, so a failed handover here is the
	 * editor refusing the patch (it does not fit the open flow), not this panel
	 * guessing.
	 */
	function stage(proposal: Proposal): void {
		const result = handPatchToEditor({
			intent: proposal.summary !== '' ? proposal.summary : proposal.title,
			patch: patchOf(proposal),
			flowId: flowIdOf(proposal)
		});
		results = {
			...results,
			[proposal.id]: {
				tone: result.ok ? 'ok' : 'danger',
				text: result.message,
				ids: [],
				detail: null
			}
		};
		announce(result.ok ? 'Patch staged in the editor.' : 'The patch was not staged.');
	}

	/** The flow a patch names in its own payload, or null when it names none. */
	function flowIdOf(proposal: Proposal): string | null {
		const payload = proposal.payload;
		if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
		const id = (payload as Record<string, unknown>).flow_id;
		return typeof id === 'string' && id !== '' ? id : null;
	}

	/** A payload either wraps the graph or is the graph; both shapes are honest. */
	function patchOf(proposal: Proposal): unknown {
		const payload = proposal.payload;
		if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
			const wrap = (payload as Record<string, unknown>).patch;
			if (wrap !== undefined) return wrap;
		}
		return payload;
	}

	/** A refusal is the operator's problem only when it is about them or the origin. */
	function refusalTone(reason: string): 'warn' | 'danger' {
		return reason === 'grant_expired' || reason === 'cap_reached' || reason === 'turn_cap'
			? 'warn'
			: 'danger';
	}

	/** The one line under a turn that has not produced an answer yet. */
	function waitingLine(): string {
		if (recovery?.kind === 'resuming') {
			return recovery.via === 'sse'
				? 'The link did not come back. Reading the rest of the turn from where it stopped…'
				: 'The link dropped. Asking the agent for the rest of the turn…';
		}
		if (linkState === 'retrying' || linkState === 'ticket' || linkState === 'connecting') {
			return 'Connecting to the agent…';
		}
		// The turn was announced, so the gateway has the question even though it has
		// not said what it is doing yet. This is the sentence a 25-second turn needs.
		if (turn !== null && turn.streamId !== null) {
			return 'The agent has the question and is working on it…';
		}
		return 'The model is writing…';
	}

	/**
	 * The line under a turn that stopped arriving.
	 *
	 * Two facts, and the difference is whether there was a stream to ask again: a
	 * turn that was never announced cannot be resumed, and saying so is not the
	 * same sentence as a resume that was tried and did not reach the answer.
	 */
	function lostLine(): string {
		return turn?.streamId != null
			? 'The link closed and the answer could not be picked up again. Nothing after this point arrived.'
			: 'The link closed before the answer finished. Nothing after this point arrived.';
	}

	/**
	 * The time between the step before this one and this one.
	 *
	 * It comes from the frames' own stamps, never from this browser's clock: a
	 * resume replays an hour-old turn in a second, and a clock here would date the
	 * work to when the socket happened to deliver it. `null` when either frame
	 * carried no stamp, so an unstamped turn shows no time rather than a guess.
	 */
	function gapBefore(index: number): string | null {
		if (index === 0) return null;
		const before = steps[index - 1]?.settledAt;
		const at = steps[index]?.settledAt;
		if (before === null || before === undefined || at === null || at === undefined) return null;
		if (at < before) return null;
		return agentStepElapsed(at - before);
	}
</script>

<svelte:window onkeydown={onkeydown} />

{#if open}
	<section
		id={panelId}
		class="panel"
		aria-label="Assistant"
		aria-describedby={contextId}
	>
		<header class="panel-head">
			<div class="head-copy">
				<div class="title-row">
					<p class="panel-title">Assistant</p>
					{#if live && linkWord !== ''}
						<!-- The one factual marker of the live path: a word, not a badge. It
						     is absent entirely when the runtime is off, which is the default. -->
						<span
							class="link-chip mono"
							data-state={linkState}
							title={agentName === null ? undefined : `agent ${agentName}`}
						>
							{linkWord}
						</span>
					{/if}
				</div>
				<p class="context mono" id={contextId}>{contextLabel}</p>
			</div>
			<button type="button" class="close" onclick={close} aria-label="Close the assistant">
				<Icon name="x" size={15} />
			</button>
		</header>

		<form class="ask" onsubmit={submit}>
			<label class="sr-only" for={inputId}>Your question</label>
			<input
				id={inputId}
				class="input ask-input"
				type="text"
				bind:this={field}
				bind:value={question}
				placeholder="What does this page tell me?"
				autocomplete="off"
				spellcheck="false"
				maxlength="500"
				enterkeyhint="send"
				disabled={asking}
			/>
			<button type="submit" class="btn btn-primary btn-sm ask-send" disabled={!canAsk}>
				{asking ? 'Asking' : 'Ask'}
			</button>
		</form>

		<div class="body" aria-busy={asking}>
			{#if live && (asking || turn !== null)}
				<!-- The live path. Nothing here is drawn from a frame this turn does not
				     have: the text is what arrived, the steps are what settled, the
				     refusal is what the gateway said. -->
				{#if turn !== null}
					{#if turn.phase !== null && unfinished && recovery === null}
						<!-- One quiet line, the server's own progress. No invented tokens: the
						     panel says what is happening without pretending to write. The
						     counter is the batch the gateway announced, so it can never
						     point at a step the server did not name. Once a turn is being
						     recovered, the recovery line owns this space. -->
						<p class="state quiet phase">
							<Spinner /> {agentPhaseLine(turn.phase)}{#if pending > 0 && planTotal > 1}<span
									class="phase-count"
								>· step {planStep} of {planTotal}</span>{/if}
						</p>
					{/if}

					{#if turn.text !== ''}
						<p class="answer">
							{turn.text}{#if unfinished && recovery === null && trouble === null}<span
									class="caret"
									aria-hidden="true"
								></span>{/if}
						</p>
					{/if}

					{#if steps.length === 1 && !timeline}
						<!-- One read is a note, not a timeline: no rail, no chip, no header. -->
						<p class="step-one">
							<span class="mono step-tool">{steps[0].tool}</span>
							<span>{agentStepLine(steps[0].tool)}</span>
						</p>
					{:else if timeline}
						<!-- The timeline. One row per settled step, in the order the gateway
						     ran them, with the reason on the row rather than behind a tooltip:
						     a refusal is the row an operator came here to read. -->
						<ol class="steps" aria-label="What the agent did">
							{#each steps as step, index (step.seq)}
								{@const gap = gapBefore(index)}
								<li class="step" data-verdict={step.verdict}>
									<span class="step-mark" aria-hidden="true"></span>
									<span class="step-main">
										<span class="step-head">
											<span class="step-say">{agentStepLine(step.tool, step.verdict)}</span>
											{#if gap !== null}
												<span class="step-gap mono">+{gap}</span>
											{/if}
											<span class="step-chip" data-verdict={step.verdict}>{step.verdict}</span>
										</span>
										<span class="step-tool mono">{step.tool}</span>
										{#if step.reason !== null && step.reason !== ''}
											<!-- The gateway's own words, verbatim. A step with no reason
											     prints none rather than a sentence this console wrote. -->
											<span class="step-reason">
												{#if step.code !== null && step.code !== ''}<span class="mono step-code"
														>{step.code}</span
													><span class="step-sep">{' · '}</span>{/if}{step.reason}
											</span>
										{/if}
									</span>
								</li>
							{/each}
						</ol>
					{/if}

					{#if resuming}
						<!-- The turn is still being recovered, so it is not lost: what is on
						     screen is the connection that went away, not a verdict on the agent. -->
						<p class="state waiting"><Spinner /> {waitingLine()}</p>
						{#if closeNote !== null}
							<p class="detail mono">{closeNote}</p>
						{/if}
					{:else if cutOff}
						<p class="state" data-tone="warn">{lostLine()}</p>
						{#if closeNote !== null}
							<p class="detail mono">{closeNote}</p>
						{/if}
					{/if}

					{#if turn.refusal !== null}
						<p class="state" data-tone={refusalTone(turn.refusal.reason)}>
							{agentRefusalLine(turn.refusal.reason)}
							{#if !NAMED_REFUSALS.has(turn.refusal.reason)}
								<span class="mono">reason {turn.refusal.reason}</span>
							{/if}
						</p>
						{#if turn.refusal.message !== ''}
							<p class="detail mono">{turn.refusal.message}</p>
						{/if}
					{/if}

					{#if unfinished && recovery === null && trouble !== null && linkState === 'closed'}
						<p class="state" data-tone={trouble.retryable ? 'warn' : 'danger'}>
							{agentTroubleLine(trouble)}
						</p>
						{#if trouble.detail !== null}
							<p class="detail mono">{trouble.detail}</p>
						{/if}
					{/if}

					{#if unfinished && recovery === null && trouble === null && turn.phase === null && turn.text === '' && steps.length === 0 && pending === 0 && turn.refusal === null}
						<p class="state waiting"><Spinner /> {waitingLine()}</p>
					{/if}

					{#if cutOff || (unfinished && linkState === 'closed' && trouble !== null && turn.refusal === null)}
						<div class="retry">
							<!-- The same key, so a turn the runtime already started is not started
							     again: this asks for its answer, not for a second attempt. -->
							<button type="button" class="btn btn-sm" onclick={() => runAsk(asked, turn?.key)}>
								<Icon name="refresh" size={13} /> Try again
							</button>
						</div>
					{/if}

					{#if turn.proposals.length > 0}
						<ul class="proposals">
							{#each turn.proposals as proposal (proposal.id)}
								<AssistantProposalCard
									{proposal}
									result={results[proposal.id] ?? null}
									accepting={acceptingId === proposal.id}
									{stageReady}
									onaccept={() => void accept(proposal)}
									onstage={() => stage(proposal)}
								/>
							{/each}
						</ul>
					{/if}
				{:else}
					<p class="state waiting"><Spinner /> Asking the assistant…</p>
				{/if}
			{:else if asking}
				<p class="state waiting"><Spinner /> Asking the assistant…</p>
			{:else if outcome === null}
				<p class="state quiet">
					One question about this page. Nothing is kept after you close this panel.
				</p>
			{:else if outcome.status === 'failed'}
				<p class="state" data-tone={failureTone(outcome.failure)}>
					{failureLine(outcome.failure)}
				</p>
				{#if outcome.failure.kind === 'unavailable'}
					{#if outcome.failure.detail}
						<p class="detail mono">{outcome.failure.detail}</p>
					{/if}
					<p class="state quiet">
						{#if session.canViewSecurity}
							An owner sets the model and the chat key. <a href="{BASE}/security/ai">AI settings</a>
						{:else}
							Ask an owner or admin to set the model and chat key.
						{/if}
					</p>
				{:else if outcome.failure.kind === 'exhausted' && outcome.failure.day}
					<p class="detail mono">day {outcome.failure.day}</p>
				{/if}
				<div class="retry">
					<button type="button" class="btn btn-sm" onclick={() => runAsk(asked)}>
						<Icon name="refresh" size={13} /> Try again
					</button>
				</div>
			{:else if outcome.status === 'plain'}
				<p class="answer">{outcome.text}</p>
			{:else}
				<p class="answer">{outcome.answer}</p>
				{#if outcome.withheld.length > 0}
					<!-- A proposal the gateway refused to hand over. Saying so is the
					     difference between "the model suggested nothing" and "the model
					     suggested something the gateway would not stage". -->
					<ul class="withheld">
						{#each outcome.withheld as reason, index (index)}
							<li class="withheld-line">{reason}</li>
						{/each}
					</ul>
				{/if}
				{#if outcome.proposals.length > 0}
					<ul class="proposals">
						{#each outcome.proposals as proposal (proposal.id)}
							<AssistantProposalCard
								{proposal}
								result={results[proposal.id] ?? null}
								accepting={acceptingId === proposal.id}
								{stageReady}
								onaccept={() => void accept(proposal)}
								onstage={() => stage(proposal)}
							/>
						{/each}
					</ul>
				{/if}
			{/if}
		</div>

		<footer class="panel-foot">
			<span class="foot-note">
				{#if live}
					Live agent · it can act only while an autonomy window is open.
				{:else}
					Nothing here is saved.
				{/if}
			</span>
		</footer>
	</section>
{/if}

<button
	bind:this={launcher}
	type="button"
	class="launcher"
	aria-expanded={open}
	aria-controls={open ? panelId : undefined}
	aria-label={open ? 'Close the assistant' : 'Ask the assistant'}
	onclick={() => void toggle()}
>
	<span class="launcher-mark"><Icon name="sparkles" size={15} /></span>
	<span class="launcher-label">Ask</span>
</button>

<style>
	/* The one floating control in the console. A 44px target, 4px corners, a
	   hairline instead of a shadow, and the accent kept to the glyph: a coral
	   button here would compete with whatever the page is asking for. */
	.launcher {
		position: fixed;
		right: 16px;
		bottom: calc(16px + env(safe-area-inset-bottom, 0px));
		z-index: 70;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 7px;
		min-width: 44px;
		height: 44px;
		padding: 0 14px;
		border: 1px solid var(--df-border-control);
		border-radius: var(--df-p-radius-xs);
		background: var(--df-surface-card);
		color: var(--df-text-primary);
		font-size: var(--df-p-text-sm);
		font-weight: 600;
		line-height: 1;
		transition:
			background-color 140ms ease,
			border-color 140ms ease,
			transform var(--df-p-dur-press) ease-out;
	}

	.launcher:active {
		transform: scale(0.97);
	}

	/* The glyph carries the console's one accent; the plate stays quiet. */
	.launcher-mark {
		display: grid;
		place-items: center;
		color: var(--df-accent-text);
	}

	.launcher[aria-expanded='true'] {
		background: var(--df-surface-well);
		border-color: var(--df-border-strong);
	}

	@media (hover: hover) and (pointer: fine) {
		.launcher:hover {
			background: var(--df-surface-well);
			border-color: var(--df-border-strong);
		}
	}

	/* The panel sits directly above the launcher and never wider than the phone
	   it is on. No scrim and no focus trap: the page behind stays usable, which is
	   what "not a modal" means here. */
	.panel {
		position: fixed;
		right: 16px;
		bottom: calc(70px + env(safe-area-inset-bottom, 0px));
		z-index: 70;
		display: flex;
		flex-direction: column;
		width: min(380px, calc(100vw - 32px));
		max-height: min(70vh, 620px);
		border: 1px solid var(--df-border-control);
		border-radius: var(--df-p-radius-xs);
		background: var(--df-surface-card);
		overflow: hidden;
	}

	.panel-head {
		display: flex;
		align-items: flex-start;
		gap: var(--df-p-space-2);
		padding: 10px 11px 8px;
		border-bottom: 1px solid var(--df-border-hairline);
	}

	.head-copy {
		min-width: 0;
	}

	.title-row {
		display: flex;
		align-items: baseline;
		gap: 8px;
		flex-wrap: wrap;
	}

	.panel-title {
		font-family: var(--df-font-display);
		font-size: var(--df-p-text-sm);
		font-weight: 700;
		letter-spacing: -0.01em;
	}

	/* A word, not a badge: 9.5px mono on a hairline, and the ink says which state. */
	.link-chip {
		padding: 0 4px;
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-xs);
		color: var(--df-text-meta);
		font-size: 9.5px;
		letter-spacing: 0.08em;
		line-height: 1.5;
		text-transform: uppercase;
	}

	.link-chip[data-state='open'] {
		color: var(--df-state-ok-ink);
	}

	.link-chip[data-state='ticket'],
	.link-chip[data-state='connecting'],
	.link-chip[data-state='retrying'] {
		color: var(--df-state-warn-ink);
	}

	.link-chip[data-state='closed'] {
		color: var(--df-state-danger-ink);
	}

	.context {
		margin-top: 2px;
		color: var(--df-text-meta);
		font-size: var(--df-p-text-xs);
		overflow-wrap: anywhere;
	}

	.close {
		flex: none;
		margin-left: auto;
		display: grid;
		place-items: center;
		width: 28px;
		height: 28px;
		margin-top: -3px;
		margin-right: -3px;
		border: 1px solid transparent;
		border-radius: var(--df-p-radius-xs);
		background: transparent;
		color: var(--df-text-meta);
	}

	@media (hover: hover) and (pointer: fine) {
		.close:hover {
			background: var(--df-surface-well);
			color: var(--df-text-primary);
		}
	}

	.ask {
		display: flex;
		gap: 6px;
		align-items: stretch;
		padding: 10px 11px 0;
	}

	.ask-input {
		flex: 1;
		min-width: 0;
		min-height: 36px;
		font-size: var(--df-p-text-sm);
		/* The assistant's own geometry: 4px, the smaller step of the console's
		   radius scale, so the panel reads as a tool rather than a card. */
		border-radius: var(--df-p-radius-xs);
	}

	/* Same reason as the field: every control inside the panel is 4px. */
	.panel .btn {
		border-radius: var(--df-p-radius-xs);
	}

	.ask-send {
		flex: none;
		height: 36px;
	}

	.body {
		display: flex;
		flex-direction: column;
		gap: 8px;
		min-height: 0;
		padding: 10px 11px 11px;
		overflow-y: auto;
	}

	.state {
		font-size: var(--df-p-text-sm);
		line-height: 1.5;
	}

	.state.quiet {
		color: var(--df-text-meta);
	}

	.state.waiting {
		display: flex;
		align-items: center;
		gap: 7px;
		color: var(--df-text-secondary);
	}

	/* The server's own progress, one line: a small moving mark for liveness and
	   the phase in the console's quiet ink. It never grows into a transcript. */
	.state.phase {
		display: flex;
		align-items: center;
		gap: 7px;
		color: var(--df-text-secondary);
		font-size: var(--df-p-text-xs);
	}

	.state[data-tone='danger'] {
		color: var(--df-state-danger-ink);
	}

	.state[data-tone='warn'] {
		color: var(--df-state-warn-ink);
	}

	.detail {
		margin-top: -4px;
		color: var(--df-text-meta);
		font-size: var(--df-p-text-xs);
		overflow-wrap: anywhere;
	}

	/* The provider's line breaks are its own: an answer shaped like a list stays
	   a list, and nothing is reflowed into a paragraph. */
	.answer {
		color: var(--df-text-primary);
		font-size: var(--df-p-text-sm);
		line-height: 1.55;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	/* One thin block, blinking: the only motion the panel adds, and it disappears
	   the moment the answer is complete or the motion is unwelcome. */
	.caret {
		display: inline-block;
		width: 2px;
		height: 1em;
		margin-left: 2px;
		vertical-align: -0.15em;
		background: var(--df-accent-text);
		animation: caret-blink 1s steps(2, start) infinite;
	}

	@keyframes caret-blink {
		50% {
			opacity: 0;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.caret {
			animation: none;
		}
	}

	/* A lone successful read is a note, not a timeline: one quiet line with the
	   tool's own name beside it, and no rail, chip or header to read past. */
	.step-one {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 6px;
		margin: 0;
		color: var(--df-text-secondary);
		font-size: var(--df-p-text-xs);
		line-height: 1.45;
	}

	.step-one .step-tool {
		color: var(--df-text-meta);
	}

	/* The timeline: one row per settled step, hung on a hairline rail. The rail is
	   the only chrome — no card, no header, no shadow. It sits under the answer the
	   way a ledger sits under a paragraph, and a new row grows downward without
	   moving the prose above it. */
	.steps {
		display: flex;
		flex-direction: column;
		margin: 0;
		padding: 0 0 0 12px;
		list-style: none;
		border-left: 1px solid var(--df-border-control);
	}

	.step {
		position: relative;
		padding: 6px 0;
	}

	.step + .step {
		border-top: 1px solid var(--df-border-hairline);
	}

	/* The node on the rail. Filled by verdict, so a refusal is findable before the
	   words on the row are read. */
	.step-mark {
		position: absolute;
		left: -16px;
		top: 10px;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--df-state-ok-ink);
	}

	.step[data-verdict='refused'] .step-mark {
		background: var(--df-state-warn-ink);
	}

	.step[data-verdict='failed'] .step-mark {
		background: var(--df-state-danger-ink);
	}

	/* The row that did not run is the one an operator came to read: it keeps its
	   place, takes a tint, and puts the gateway's reason on the row at reading
	   size — not behind a tooltip, and never in place of the model's words. */
	.step[data-verdict='refused'],
	.step[data-verdict='failed'] {
		margin-left: -8px;
		padding-left: 8px;
		padding-right: 6px;
		border-radius: var(--df-p-radius-xs);
	}

	.step[data-verdict='refused'] {
		background: color-mix(in srgb, var(--df-state-warn-bg) 70%, transparent);
		box-shadow: inset 2px 0 0 var(--df-state-warn-ink);
	}

	.step[data-verdict='failed'] {
		background: color-mix(in srgb, var(--df-state-danger-bg) 70%, transparent);
		box-shadow: inset 2px 0 0 var(--df-state-danger-ink);
	}

	.step-main {
		display: flex;
		flex-direction: column;
		gap: 1px;
		min-width: 0;
	}

	.step-head {
		display: flex;
		align-items: baseline;
		gap: 6px;
		flex-wrap: wrap;
		min-width: 0;
	}

	.step-say {
		flex: 1 1 auto;
		min-width: 0;
		color: var(--df-text-primary);
		font-size: var(--df-p-text-sm);
		line-height: 1.35;
		overflow-wrap: anywhere;
	}

	/* The verdict, in the gateway's three words. Lowercase and mono on purpose: it
	   is an outcome token, not a label this console composed. */
	.step-chip {
		flex: none;
		padding: 0 4px;
		border: 1px solid color-mix(in srgb, currentColor 40%, transparent);
		border-radius: var(--df-p-radius-xs);
		font-family: var(--df-font-mono);
		font-size: 9px;
		letter-spacing: 0.01em;
		line-height: 1.5;
		color: var(--df-state-ok-ink);
	}

	.step-chip[data-verdict='refused'] {
		color: var(--df-state-warn-ink);
	}

	.step-chip[data-verdict='failed'] {
		color: var(--df-state-danger-ink);
	}

	/* The time the gateway itself stamped between the step before and this one.
	   Meta ink: it is evidence, not a headline. */
	.step-gap {
		flex: none;
		margin-left: auto;
		color: var(--df-text-meta);
		font-size: 9.5px;
		letter-spacing: 0.02em;
	}

	.step-tool {
		color: var(--df-text-meta);
		font-size: 10px;
		line-height: 1.4;
		overflow-wrap: anywhere;
	}

	.step-reason {
		margin-top: 2px;
		color: var(--df-text-primary);
		font-size: 11.5px;
		line-height: 1.45;
		overflow-wrap: anywhere;
		white-space: pre-wrap;
	}

	.step-code {
		color: var(--df-text-secondary);
	}

	.step-sep {
		color: var(--df-text-meta);
	}

	/* The plan line's counter: the batch the gateway announced, in mono so it reads
	   as a position rather than as prose. */
	.phase-count {
		color: var(--df-text-meta);
		font-family: var(--df-font-mono);
		font-size: var(--df-p-text-2xs);
		letter-spacing: 0.02em;
	}

	.retry {
		margin-top: 2px;
	}

	.proposals {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin: 2px 0 0;
		padding: 0;
		list-style: none;
	}

	.panel-foot {
		padding: 7px 11px;
		border-top: 1px solid var(--df-border-hairline);
		background: var(--df-surface-well);
	}

	.foot-note {
		color: var(--df-text-meta);
		font-size: 10.5px;
		letter-spacing: 0.02em;
	}

	@media (max-width: 420px) {
		.launcher {
			right: 12px;
			bottom: calc(12px + env(safe-area-inset-bottom, 0px));
		}

		.panel {
			right: 12px;
			left: 12px;
			width: auto;
			bottom: calc(64px + env(safe-area-inset-bottom, 0px));
		}

		.close {
			width: 44px;
			height: 44px;
			margin-top: -8px;
			margin-right: -8px;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.launcher {
			transition: none;
		}
		.launcher:active {
			transform: none;
		}
	}

	.withheld {
		margin: var(--df-p-space-2) 0 0;
		padding: 0 0 0 var(--df-p-space-3);
		list-style: none;
		border-left: 2px solid var(--df-state-warn-ink);
	}

	.withheld-line {
		color: var(--df-text-secondary);
		font-size: var(--df-p-text-xs);
		line-height: 1.5;
	}
</style>
