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
				<span class="palette-icon"><Icon name={meta.icon} size={14} /></span>
				<span class="palette-text">
					<span class="palette-name">{meta.title}</span>
					<span class="palette-blurb">{meta.blurb}</span>
				</span>
				<span class="palette-mark" aria-hidden="true">
					{#if type === 'trigger' && hasTrigger}
						<Icon name="check" size={11} />
					{:else}
						<Icon name="plus" size={11} />
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
	}

	.palette-head {
		padding: 11px 12px 9px;
		border-bottom: 1px solid var(--line);
	}

	.palette-copy {
		margin-top: 4px;
		font-size: 11px;
		line-height: 1.4;
		color: var(--ink-3);
	}

	.palette-list {
		display: flex;
		flex-direction: column;
		padding: 5px;
		gap: 2px;
	}

	.palette-item {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		min-width: 0;
		padding: 7px 7px;
		border: 1px solid transparent;
		border-radius: var(--r-sm);
		background: transparent;
		color: var(--ink);
		text-align: left;
		transition:
			background-color 130ms ease,
			border-color 130ms ease;
	}

	.palette-item:hover:not(:disabled) {
		background: var(--surface-2);
		border-color: var(--line);
	}

	.palette-item:active:not(:disabled) {
		background: var(--surface-3);
	}

	.palette-item.is-disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}

	.palette-icon {
		display: grid;
		place-items: center;
		width: 24px;
		height: 24px;
		flex: none;
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		background: var(--surface-2);
		color: var(--ink-2);
	}

	.palette-text {
		display: flex;
		flex-direction: column;
		gap: 1px;
		min-width: 0;
	}

	.palette-name {
		font-size: 12px;
		font-weight: 600;
		line-height: 1.25;
	}

	.palette-blurb {
		font-size: 10.5px;
		line-height: 1.35;
		color: var(--ink-3);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.palette-mark {
		display: grid;
		place-items: center;
		margin-left: auto;
		width: 16px;
		height: 16px;
		flex: none;
		border-radius: 3px;
		color: var(--ink-3);
	}

	.palette-item:hover:not(:disabled) .palette-mark {
		background: var(--surface);
		color: var(--accent);
	}

	.palette-note {
		margin-top: auto;
		padding: 9px 12px;
		border-top: 1px solid var(--line);
		background: color-mix(in srgb, var(--surface-2) 40%, var(--surface));
		border-radius: 0 0 var(--r) var(--r);
		font-size: 10.5px;
		line-height: 1.45;
		color: var(--ink-3);
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

	@media (max-width: 420px) {
		.palette-item {
			padding: 6px;
		}

		.palette-blurb {
			white-space: normal;
			display: -webkit-box;
			-webkit-line-clamp: 2;
			line-clamp: 2;
			-webkit-box-orient: vertical;
		}
	}
</style>
