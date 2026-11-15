<script module lang="ts">
	/** What an accepted (or refused) proposal leaves on its card. */
	export interface ProposalResult {
		tone: 'ok' | 'danger';
		text: string;
		ids: string[];
		/** A draft the endpoint handed back, kept in its own mono block. */
		detail: string | null;
	}
</script>

<script lang="ts">
	/**
	 * One proposal, as a card in the floating assistant.
	 *
	 * Three kinds, three exits, and none of them is invented:
	 *
	 *  - `create_rule` / `create_template` are accepted through the endpoint, and
	 *    the card then shows what the gateway answered — the message and the id it
	 *    named, or the refusal.
	 *  - `stage_workflow_patch` is never POSTed here. It says "Stages in the editor"
	 *    and hands the patch to the mounted editor's own ghost staging; with no
	 *    editor on the page it says so and points at the editor instead.
	 *  - anything else names its kind and says nothing was changed, because this
	 *    console has no path for it.
	 *
	 * Quiet on purpose: 4px radii, one hairline, no shadow, no gradient, no avatar,
	 * and the only colour is a state word at the end of the action.
	 */
	import { ROUTES } from '$lib/paths';
	import {
		proposalAcceptsRemotely,
		proposalKindLabel,
		proposalStagesInEditor,
		type Proposal
	} from '$lib/assistant';
	import Icon from './Icon.svelte';
	import Spinner from './Spinner.svelte';

	let {
		proposal,
		result = null,
		accepting = false,
		stageReady = false,
		onaccept,
		onstage
	}: {
		proposal: Proposal;
		result?: ProposalResult | null;
		accepting?: boolean;
		stageReady?: boolean;
		onaccept: () => void;
		onstage: () => void;
	} = $props();

	const stages = $derived(proposalStagesInEditor(proposal.kind));
	const accepts = $derived(proposalAcceptsRemotely(proposal.kind));

	/**
	 * A patch says which flow it belongs to, in its own payload, when it does.
	 * Reading it here keeps the link honest: an editor opened for the wrong flow
	 * would stage the patch against a document it does not fit.
	 */
	const editorHref = $derived.by(() => {
		const payload = proposal.payload;
		const flowId =
			payload !== null && typeof payload === 'object' && !Array.isArray(payload)
				? (payload as Record<string, unknown>).flow_id
				: null;
		return typeof flowId === 'string' && flowId !== ''
			? `${ROUTES.workflowEdit}?id=${encodeURIComponent(flowId)}`
			: ROUTES.workflowEdit;
	});
</script>

<li class="proposal">
	<span class="kind mono">{proposalKindLabel(proposal.kind)}</span>
	<h3 class="title">{proposal.title}</h3>
	{#if proposal.summary !== ''}
		<p class="summary">{proposal.summary}</p>
	{/if}

	{#if result !== null}
		<p class="result" data-tone={result.tone}>
			{result.text}
			{#if result.ids.length > 0}
				<span class="ids mono">
					{#each result.ids as id, index (id)}{index > 0 ? ' · ' : ''}{id}{/each}
				</span>
			{/if}
		</p>
		{#if result.detail !== null}
			<p class="draft">{result.detail}</p>
		{/if}
	{:else if stages}
		<p class="note">Stages in the editor.</p>
		{#if stageReady}
			<div class="actions">
				<button type="button" class="btn btn-sm" onclick={onstage}>
					<Icon name="branch" size={13} /> Stage the patch
				</button>
				<span class="hint">It stays a preview until you accept it there.</span>
			</div>
		{:else}
			<p class="why">
				The editor is not open on this page, so nothing can be staged from here. This patch opens in
				the editor: <a href={editorHref}>open the workflow</a> and ask again there.
			</p>
		{/if}
	{:else if accepts}
		<div class="actions">
			<button type="button" class="btn btn-sm" onclick={onaccept} disabled={accepting} aria-busy={accepting}>
				{#if accepting}<Spinner />{:else}<Icon name="check" size={13} />{/if}
				{accepting ? 'Accepting' : 'Accept'}
			</button>
			<span class="hint">
				{proposalKindLabel(proposal.kind) === 'rule'
					? 'Creates the rule through the gateway, by the same path the rules editor uses.'
					: 'Prepares the template draft. Nothing is stored; it is yours to keep.'}
			</span>
		</div>
	{:else}
		<p class="why">
			This console has no path for a <span class="mono">{proposal.kind}</span> proposal, so nothing was
			changed.
		</p>
	{/if}
</li>

<style>
	.proposal {
		display: flex;
		flex-direction: column;
		gap: 5px;
		padding: 10px 11px;
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-xs);
		background: var(--df-surface-card);
	}

	/* The kind is a label above the title, not a pill beside it: at 380px a pill
	   and a sentence do not fit on one line. */
	.kind {
		align-self: flex-start;
		padding: 1px 5px;
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-xs);
		background: var(--df-surface-well);
		color: var(--df-text-meta);
		font-size: 10px;
		letter-spacing: 0.1em;
		line-height: 1.5;
		text-transform: uppercase;
	}

	.title {
		font-size: var(--df-p-text-sm);
		font-weight: 700;
		line-height: 1.35;
		letter-spacing: -0.01em;
		overflow-wrap: anywhere;
	}

	.summary {
		color: var(--df-text-secondary);
		font-size: var(--df-p-text-sm);
		line-height: 1.5;
		overflow-wrap: anywhere;
	}

	.note {
		color: var(--df-text-meta);
		font-size: var(--df-p-text-xs);
		letter-spacing: 0.02em;
	}

	.why {
		color: var(--df-text-secondary);
		font-size: var(--df-p-text-xs);
		line-height: 1.5;
		overflow-wrap: anywhere;
	}

	/* The button, then its one line of consequence underneath: at 380px the two
	   do not share a row without turning the sentence into a column of words. */
	.actions {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 5px;
		margin-top: 3px;
	}

	.hint {
		font-size: 11px;
		line-height: 1.45;
		color: var(--df-text-meta);
	}

	.proposal .btn {
		border-radius: var(--df-p-radius-xs);
	}

	.result {
		display: flex;
		flex-direction: column;
		gap: 3px;
		padding-top: 4px;
		border-top: 1px solid var(--df-border-hairline);
		font-size: var(--df-p-text-xs);
		line-height: 1.5;
		overflow-wrap: anywhere;
	}

	.result[data-tone='ok'] {
		color: var(--df-state-ok-ink);
	}

	.result[data-tone='danger'] {
		color: var(--df-state-danger-ink);
	}

	.ids {
		color: var(--df-text-primary);
		font-size: var(--df-p-text-xs);
	}

	/* A draft the operator is meant to keep, so it is selectable text and not a
	   quotation: mono, its own well, and no truncation. */
	.draft {
		margin-top: 2px;
		max-height: 132px;
		padding: 7px 8px;
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-xs);
		background: var(--df-surface-well);
		color: var(--df-text-primary);
		font-family: var(--df-p-font-mono);
		font-size: var(--df-p-text-xs);
		line-height: 1.5;
		white-space: pre-wrap;
		overflow-y: auto;
		overflow-wrap: anywhere;
	}
</style>
