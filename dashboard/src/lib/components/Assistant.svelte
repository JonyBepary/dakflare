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
	 *    answer streams in, each tool run is one line, and a turn that was cut off
	 *    says so. Proposals are the same cards either way.
	 *
	 * Five rules this panel keeps, on both paths:
	 *
	 *  - No invented state. Each failure is one line from `failureLine()` or
	 *    `agentTroubleLine()`, with the gateway's own detail under it only when the
	 *    gateway sent one.
	 *  - A refusal never replaces the model's words. A turn refused after the model
	 *    had written three sentences shows both, in the order they happened.
	 *  - A tool is a name and a verdict. Its output is dropped in the socket module
	 *    and there is no template here that could print it.
	 *  - No accept on `stage_workflow_patch`. That kind belongs to the workflow
	 *    editor's ghost banner; this panel only hands the patch over when an editor
	 *    is mounted, and explains the way there when it is not.
	 *  - A retry after a lost link reuses the turn's idempotency key, so a question
	 *    that did reach the runtime is not asked twice.
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
		agentLinkLabel,
		agentRefusalLine,
		agentTroubleLine,
		applyAgentFrame,
		beginTurn,
		newIdempotencyKey,
		readAgentRuntime,
		type AgentEvent,
		type AgentFrame,
		type AgentLinkState,
		type AgentTrouble,
		type AgentTurn
	} from '$lib/agent-socket';
	import { announce } from '$lib/announce.svelte';
	import { BASE, ROUTES } from '$lib/paths';
	import AssistantProposalCard, { type ProposalResult } from './AssistantProposalCard.svelte';
	import Icon from './Icon.svelte';
	import Spinner from './Spinner.svelte';

	const uid = $props.id();
	const panelId = `assistant-panel-${uid}`;
	const inputId = `assistant-question-${uid}`;
	const contextId = `assistant-context-${uid}`;

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
	/** The link dropped while this turn was in flight. It survives the reconnect. */
	let lost = $state(false);

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
	 * `lost` is a fact about this turn, not about the link: a reconnect clears
	 * `trouble`, and the point of this line is that the frames that were coming
	 * before the drop are not coming back.
	 */
	const cutOff = $derived(turn !== null && turn.status === 'streaming' && lost);

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
		agent?.close();
		agent = new AgentLink({ onEvent: handleAgentEvent });
		await agent.connect();
	}

	function handleAgentEvent(event: AgentEvent): void {
		if (!open) return;

		if (event.kind === 'link') {
			const wasOpen = linkState === 'open';
			linkState = event.state;
			trouble = event.trouble;

			// The socket dropped with a turn in flight. The turn stays where it is, and
			// the panel stops saying it is asking: it is waiting for the operator's
			// next move, which is Try again with the same key.
			if (wasOpen && event.state !== 'open' && turn !== null && turn.status === 'streaming') {
				lost = true;
				asking = false;
				queued = null;
			}

			if (event.state === 'open') {
				sendQueued();
				return;
			}

			if (event.state !== 'closed') return;

			// The link is final. A question that was never asked is no longer being
			// asked; a question that was answered keeps its answer.
			asking = false;

			if (event.trouble?.reason === 'agent_runtime_off') {
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
			return;
		}

		onFrame(event.frame);
	}

	/** One frame, folded into the turn it belongs to. */
	function onFrame(frame: AgentFrame): void {
		if (frame.type === 'ready') {
			agentName = frame.name !== '' ? frame.name : null;
			return;
		}

		const current = turn;
		// Nothing to attach a frame to: this panel did not ask the question it
		// answers. Rendering it would invent a conversation.
		if (current === null) return;

		turn = applyAgentFrame(current, frame);

		if (frame.type === 'answer') {
			asking = false;
			queued = null;
			const count = turn?.proposals.length ?? 0;
			const calls = frame.calls;
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
		lost = false;
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
		lost = false;
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

		if (agent === null) agent = new AgentLink({ onEvent: handleAgentEvent });
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

	/** The line under a partial answer, in the link's own words. */
	function linkWaitingLine(): string {
		if (linkState === 'retrying') return 'The link dropped. Reconnecting…';
		if (linkState === 'open') return 'The model is writing…';
		return 'Connecting to the agent…';
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
				     have: the text is what arrived, the tools are what ran, the refusal
				     is what the gateway said. -->
				{#if turn !== null}
					{#if turn.text !== ''}
						<p class="answer">
							{turn.text}{#if unfinished && trouble === null}<span class="caret" aria-hidden="true"
								></span>{/if}
						</p>
					{/if}

					{#if turn.tools.length > 0}
						<ul class="tools" aria-label="Tool runs">
							{#each turn.tools as call, index (index)}
								<li class="tool" class:refused={!call.ok}>
									<span class="tool-head">
										<span class="mono tool-name">{call.tool}</span>
										<span class="tool-verdict">{call.ok ? 'ran' : 'refused'}</span>
									</span>
									{#if call.reason !== null && call.reason !== ''}
										<!-- The gateway's own reason. A refusal with no reason prints
										     none, rather than a sentence this console invented. -->
										<span class="tool-reason">{call.reason}</span>
									{/if}
								</li>
							{/each}
						</ul>
					{/if}

					{#if cutOff}
						<p class="state" data-tone="warn">
							The link closed before the answer finished. Nothing after this point arrived.
						</p>
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

					{#if unfinished && !lost && trouble !== null && linkState === 'closed'}
						<p class="state" data-tone={trouble.retryable ? 'warn' : 'danger'}>
							{agentTroubleLine(trouble)}
						</p>
						{#if trouble.detail !== null}
							<p class="detail mono">{trouble.detail}</p>
						{/if}
					{/if}

					{#if unfinished && !lost && trouble === null && turn.text === '' && turn.tools.length === 0 && turn.refusal === null}
						<p class="state waiting"><Spinner /> {linkWaitingLine()}</p>
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
						An owner sets the model and the chat key. <a href="{BASE}/security/ai">AI settings</a>
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

	/* One run per row: the name, the verdict, and the gateway's reason under it
	   when it gave one. A tool's output is deliberately not part of this shape. */
	.tools {
		display: flex;
		flex-direction: column;
		margin: 0;
		padding: 0;
		list-style: none;
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-xs);
	}

	.tool {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
		padding: 5px 9px;
	}

	.tool + .tool {
		border-top: 1px solid var(--df-border-hairline);
	}

	.tool-head {
		display: flex;
		align-items: baseline;
		gap: 8px;
		flex-wrap: wrap;
		min-width: 0;
	}

	.tool-name {
		min-width: 0;
		color: var(--df-text-primary);
		font-size: var(--df-p-text-xs);
		overflow-wrap: anywhere;
	}

	.tool-verdict {
		flex: none;
		color: var(--df-state-ok-ink);
		font-size: var(--df-p-text-2xs);
	}

	.tool.refused .tool-verdict {
		color: var(--df-state-warn-ink);
	}

	.tool-reason {
		color: var(--df-text-meta);
		font-size: 11px;
		line-height: 1.45;
		overflow-wrap: anywhere;
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
