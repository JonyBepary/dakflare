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
	 * Why this card exists, when the gateway said.
	 *
	 * `payload` is `unknown` and the marker is optional: a proposal the model
	 * chose arrives from `/v1/admin/assistant/chat` with no `origin` at all, and
	 * a gateway that predates the marker sends none either. Only the gateway's
	 * exact word is read, so nothing becomes "prepared" by accident.
	 */
	const actRefused = $derived.by(() => {
		const payload = proposal.payload;
		return (
			payload !== null &&
			typeof payload === 'object' &&
			!Array.isArray(payload) &&
			(payload as Record<string, unknown>).origin === 'act_refused'
		);
	});

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
	<h4 class="title">{proposal.title}</h4>
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
				<!-- The visible text stays "Stage the patch"; the name adds the proposal,
				     because two patches on one answer would otherwise be two controls
				     with one accessible name. -->
				<button
					type="button"
					class="btn btn-sm"
					aria-label={`Stage the patch: ${proposal.title}`}
					onclick={onstage}
				>
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
			<button
				type="button"
				class="btn btn-sm"
				aria-label={`Accept: ${proposal.title}`}
				onclick={onaccept}
				disabled={accepting}
				aria-busy={accepting}
			>
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
			This console has no path for a <span class="mono kind-inline">{proposal.kind}</span> proposal, so nothing was
			changed.
		</p>
	{/if}

	{#if actRefused}
		<!-- Context for the action above, not a subtitle under the title: the card
		     exists because an act was refused, not because the model chose to
		     propose. A sentence, never a heading, and never a warning. -->
		<p class="cause">
			Prepared because the agent's own attempt was refused and no autonomy window covers it. Accepting it
			is you applying the change by hand.
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
		font-size: var(--df-p-text-xs);
		letter-spacing: 0.1em;
		line-height: 1.5;
		text-transform: uppercase;
	}

	/* A card title sits under the panel's "This turn" heading, so it is an h4:
	   the heading order is h2 panel, h3 section, h4 card. */
	.title {
		margin: 0;
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

	/* `.mono` scales to 0.94em, which would put this token under 11px inside an
	   11px sentence; the size is restated at the floor. */
	.kind-inline {
		font-size: var(--df-p-text-xs);
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

	/* The card's own footnote. Meta ink and the 11px floor: it explains the
	   action above it, so it must not read as a second heading or a warning. */
	.cause {
		margin-top: 1px;
		color: var(--df-text-meta);
		font-size: 11px;
		line-height: 1.45;
		overflow-wrap: anywhere;
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

	/* The editor's standalone link takes the console's 44px floor on touch. */
	@media (max-width: 720px), (pointer: coarse) {
		.proposal .btn {
			min-height: 44px;
		}

		.why :global(a) {
			display: inline-flex;
			align-items: center;
			min-height: 44px;
			padding: 0;
		}
	}
</style>
