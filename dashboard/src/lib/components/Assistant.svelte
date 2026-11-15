<script lang="ts">
	/**
	 * The floating assistant.
	 *
	 * One button, bottom-right, above every page of the console; one panel that is
	 * not a modal and not a route. It asks `POST /v1/admin/assistant/chat` about
	 * the page the operator is standing on, prints the answer, and renders the
	 * proposals as cards. There is no transcript: closing the panel drops the
	 * question, the answer and every proposal, and nothing is written to storage.
	 *
	 * What it deliberately does not do:
	 *
	 *  - No streaming animation and no typing indicator. A call either answered or
	 *    it did not, and the panel says which.
	 *  - No invented state. Each failure is one line from `failureLine()`, with the
	 *    gateway's own detail under it only when the gateway sent one.
	 *  - No accept on `stage_workflow_patch`. That kind belongs to the workflow
	 *    editor's ghost banner; this panel only hands the patch over when an editor
	 *    is mounted, and explains the way there when it is not.
	 *
	 * The button is fixed, so `+layout.svelte` gives the main region a floor under
	 * it: at 390px the page's last row must never end behind this control.
	 */
	import { tick } from 'svelte';
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
		type Proposal
	} from '$lib/assistant';
	import { announce } from '$lib/announce.svelte';
	import { BASE, ROUTES } from '$lib/paths';
	import AssistantProposalCard, { type ProposalResult } from './AssistantProposalCard.svelte';
	import Icon from './Icon.svelte';
	import Spinner from './Spinner.svelte';

	const uid = $props.id();
	const panelId = `assistant-panel-${uid}`;
	const inputId = `assistant-question-${uid}`;
	const contextId = `assistant-context-${uid}`;

	let open = $state(false);
	let question = $state('');
	/** The question the current answer belongs to, so Try again repeats that one. */
	let asked = $state('');
	let asking = $state(false);
	let outcome = $state<ChatOutcome | null>(null);

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

	// The sink appears and disappears with the editor, which is a different
	// component on a different route. Nothing else would tell this panel.
	$effect(() => {
		const route = page.url.pathname;
		void route;
		void outcome;
		stageReady = workflowPatchSinkReady();
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
		sequence += 1;
		launcher?.focus();
	}

	function onkeydown(event: KeyboardEvent): void {
		if (!open) return;
		if (event.key !== 'Escape') return;
		event.preventDefault();
		close();
	}

	async function runAsk(text: string): Promise<void> {
		const next = text.trim();
		if (next === '' || asking) return;

		question = next;
		asked = next;
		asking = true;
		outcome = null;
		results = {};

		const id = ++sequence;
		const result = await askAssistant({ message: next, context });
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
				<p class="panel-title">Assistant</p>
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
			{#if asking}
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
					<button type="button" class="btn btn-sm" onclick={() => void runAsk(asked)}>
						<Icon name="refresh" size={13} /> Try again
					</button>
				</div>
			{:else if outcome.status === 'plain'}
				<p class="answer">{outcome.text}</p>
			{:else}
				<p class="answer">{outcome.answer}</p>
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
			<span class="foot-note">Nothing here is saved.</span>
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

	.panel-title {
		font-family: var(--df-font-display);
		font-size: var(--df-p-text-sm);
		font-weight: 700;
		letter-spacing: -0.01em;
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
</style>
