<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { NODE_LIMIT, NODE_META, NODE_TYPES } from '$lib/workflow/graph';
	import type { WorkflowNodeType } from '$lib/types';

	let {
		nodeCount,
		hasTrigger,
		onadd
	}: {
		nodeCount: number;
		hasTrigger: boolean;
		onadd: (type: WorkflowNodeType) => void;
	} = $props();

	const atLimit = $derived(nodeCount >= NODE_LIMIT);

	function disabled(type: WorkflowNodeType): boolean {
		if (atLimit) return true;
		return type === 'trigger' && hasTrigger;
	}
</script>

<aside class="palette panel" aria-labelledby="palette-title">
	<div class="palette-head">
		<p class="eyebrow" id="palette-title">Add a step</p>
		<p class="palette-copy">Click to drop it in the middle of the canvas.</p>
	</div>

	<div class="palette-list">
		{#each NODE_TYPES as type (type)}
			{@const meta = NODE_META[type]}
			{@const isDisabled = disabled(type)}
			<button
				type="button"
				class="palette-item"
				class:is-disabled={isDisabled}
				disabled={isDisabled}
				onclick={() => onadd(type)}
				aria-describedby={type === 'trigger' && hasTrigger ? 'palette-trigger-note' : undefined}
				title={isDisabled
					? type === 'trigger' && hasTrigger
						? 'A flow can only have one trigger'
						: `A flow can hold at most ${NODE_LIMIT} steps`
					: `Add ${meta.title}`}
			>
				<span class="palette-icon"><Icon name={meta.icon} size={15} /></span>
				<span class="palette-text">
					<span class="palette-name">{meta.title}</span>
					<span class="palette-blurb">{meta.blurb}</span>
				</span>
				<span class="palette-mark" aria-hidden="true">
					{#if type === 'trigger' && hasTrigger}
						<Icon name="check" size={12} />
					{:else}
						<Icon name="plus" size={12} />
					{/if}
				</span>
			</button>
		{/each}
	</div>

	<p class="palette-note" id="palette-trigger-note">
		{#if atLimit}
			This flow is at the {NODE_LIMIT}-step limit.
		{:else if hasTrigger}
			One trigger per flow. Connect steps by dragging from a handle.
		{:else}
			Every flow starts with one trigger.
		{/if}
	</p>
</aside>

<style>
	.palette {
		display: flex;
		flex-direction: column;
		min-width: 0;
		border-radius: var(--df-p-radius-lg);
		overflow: hidden;
	}

	.palette-head {
		padding: var(--df-p-space-3) var(--df-p-space-3) var(--df-p-space-2);
		border-bottom: 1px solid var(--df-border-hairline);
		background: var(--df-surface-well);
	}

	.palette-copy {
		margin-top: 4px;
		font-size: var(--df-p-text-xs);
		line-height: 1.4;
		color: var(--df-text-meta);
	}

	.palette-list {
		display: flex;
		flex-direction: column;
		padding: var(--df-p-space-1);
		gap: 2px;
	}

	.palette-item {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-2);
		width: 100%;
		min-width: 0;
		min-height: 48px;
		padding: 7px var(--df-p-space-2);
		border: 1px solid transparent;
		border-radius: var(--df-p-radius-sm);
		background: transparent;
		color: var(--df-text-primary);
		text-align: left;
		transition:
			background-color 130ms ease,
			border-color 130ms ease,
			transform var(--df-p-dur-press) ease-out;
	}

	.palette-item:hover:not(:disabled) {
		background: var(--df-surface-well);
		border-color: var(--df-border-hairline);
	}

	.palette-item:active:not(:disabled) {
		transform: scale(0.97);
	}

	.palette-item:focus-visible {
		outline: 2px solid var(--df-accent-text);
		outline-offset: 2px;
	}

	.palette-item.is-disabled {
		cursor: not-allowed;
		opacity: 0.5;
	}

	.palette-icon {
		display: grid;
		place-items: center;
		width: 26px;
		height: 26px;
		flex: none;
		border-radius: var(--df-p-radius-sm);
		background: var(--df-surface-well);
		color: var(--df-text-secondary);
	}

	.palette-item:hover:not(:disabled) .palette-icon {
		background: var(--df-surface-card);
		color: var(--df-accent-text);
	}

	.palette-text {
		display: flex;
		flex-direction: column;
		gap: 1px;
		min-width: 0;
	}

	.palette-name {
		font-size: var(--df-p-text-base);
		font-weight: 600;
		line-height: 1.25;
	}

	.palette-blurb {
		font-size: var(--df-p-text-xs);
		line-height: 1.35;
		color: var(--df-text-meta);
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.palette-mark {
		display: grid;
		place-items: center;
		margin-left: auto;
		width: 18px;
		height: 18px;
		flex: none;
		border-radius: var(--df-p-radius-xs);
		color: var(--df-text-meta);
	}

	.palette-item:hover:not(:disabled) .palette-mark {
		color: var(--df-accent-text);
	}

	.palette-note {
		margin-top: auto;
		padding: var(--df-p-space-2) var(--df-p-space-3);
		border-top: 1px solid var(--df-border-hairline);
		background: var(--df-surface-well);
		font-size: var(--df-p-text-2xs);
		line-height: 1.45;
		color: var(--df-text-meta);
	}

	@media (max-width: 760px) {
		.palette-list {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}

		.palette-note {
			grid-column: 1 / -1;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.palette-item {
			transition: none;
		}

		.palette-item:active:not(:disabled) {
			transform: none;
		}
	}
</style>
