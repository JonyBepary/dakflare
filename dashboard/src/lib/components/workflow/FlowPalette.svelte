<script lang="ts">
	/**
	 * The step catalogue, as a popover: nine kinds, one click each.
	 *
	 * It used to be a permanent 186px column beside the canvas, which cost the
	 * graph a quarter of its width. The palette is a door, not a room, so it opens
	 * from the "Add step" button and closes as soon as something is picked.
	 */
	import Icon from '$lib/components/Icon.svelte';
	import { NODE_LIMIT, NODE_META, NODE_TYPES } from '$lib/workflow/graph';
	import type { WorkflowNodeType } from '$lib/types';

	let {
		nodeCount,
		hasTrigger,
		onadd,
		onclose
	}: {
		nodeCount: number;
		hasTrigger: boolean;
		onadd: (type: WorkflowNodeType) => void;
		onclose: () => void;
	} = $props();

	let listEl = $state<HTMLDivElement | null>(null);

	const atLimit = $derived(nodeCount >= NODE_LIMIT);

	function disabled(type: WorkflowNodeType): boolean {
		if (atLimit) return true;
		return type === 'trigger' && hasTrigger;
	}

	function firstEnabled(): HTMLButtonElement | null {
		const buttons = [...(listEl?.querySelectorAll<HTMLButtonElement>('button.palette-item') ?? [])];
		return buttons.find((button) => !button.disabled) ?? buttons[0] ?? null;
	}

	$effect(() => {
		const button = firstEnabled();
		button?.focus();
	});

	function onkeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			event.stopPropagation();
			onclose();
			return;
		}
		if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Tab') return;
		const buttons = [...(listEl?.querySelectorAll<HTMLButtonElement>('button.palette-item') ?? [])];
		const usable = buttons.filter((button) => !button.disabled);
		if (usable.length === 0) return;
		const at = usable.indexOf(document.activeElement as HTMLButtonElement);
		if (event.key === 'Tab' && !event.shiftKey && at === usable.length - 1) return;
		event.preventDefault();
		const next =
			event.key === 'ArrowUp' || (event.key === 'Tab' && event.shiftKey)
				? usable[(at <= 0 ? usable.length : at) - 1]
				: usable[(at + 1) % usable.length];
		next?.focus();
	}
</script>

<svelte:window
	onpointerdown={(event) => {
		const target = event.target as Node | null;
		const inside =
			Boolean(target && listEl?.contains(target)) ||
			(target instanceof Element && Boolean(target.closest('.add-anchor')));
		if (!inside) onclose();
	}}
/>

<div
	class="palette-pop"
	bind:this={listEl}
	role="dialog"
	tabindex="-1"
	aria-label="Add a step"
	onkeydown={onkeydown}
>
	<p class="palette-title">Add a step</p>
	<div class="palette-list">
		{#each NODE_TYPES as type (type)}
			{@const meta = NODE_META[type]}
			{@const isDisabled = disabled(type)}
			<button
				type="button"
				class="palette-item"
				class:is-disabled={isDisabled}
				disabled={isDisabled}
				onclick={() => {
					onadd(type);
					onclose();
				}}
				title={isDisabled
					? type === 'trigger' && hasTrigger
						? 'A flow can only have one trigger'
						: `A flow can hold at most ${NODE_LIMIT} steps`
					: `Add ${meta.title}`}
			>
				<span class="palette-icon"><Icon name={meta.icon} size={16} /></span>
				<span class="palette-text">
					<span class="palette-name">{meta.title}</span>
					<span class="palette-blurb">{meta.blurb}</span>
				</span>
				{#if type === 'trigger' && hasTrigger}
					<span class="palette-mark" aria-hidden="true"><Icon name="check" size={16} /></span>
				{/if}
			</button>
		{/each}
	</div>
	<p class="palette-note">
		{#if atLimit}
			This flow is at the {NODE_LIMIT}-step limit.
		{:else if hasTrigger}
			Drag from a handle to connect the new step.
		{:else}
			Every flow starts with one trigger.
		{/if}
	</p>
</div>

<style>
	.palette-pop {
		position: absolute;
		top: calc(100% + 6px);
		left: 0;
		z-index: 60;
		width: 288px;
		max-width: calc(100vw - 32px);
		padding: var(--df-p-space-1);
		border: 1px solid var(--df-border-control);
		border-radius: var(--df-p-radius-md);
		background: var(--df-surface-card);
		box-shadow: var(--df-shadow-dialog);
	}

	.palette-title {
		padding: 5px var(--df-p-space-2) 4px;
		font-family: var(--df-p-font-mono);
		font-size: var(--df-p-text-2xs);
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--df-text-meta);
	}

	.palette-list {
		display: flex;
		flex-direction: column;
		gap: 1px;
	}

	.palette-item {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-2);
		width: 100%;
		min-width: 0;
		padding: 6px var(--df-p-space-2);
		border: 1px solid transparent;
		border-radius: var(--df-p-radius-sm);
		background: transparent;
		color: var(--df-text-primary);
		text-align: left;
		transition:
			background-color 130ms ease,
			border-color 130ms ease;
	}

	.palette-item:hover:not(:disabled),
	.palette-item:focus-visible {
		background: var(--df-surface-well);
		border-color: var(--df-border-hairline);
		outline: none;
	}

	.palette-item:focus-visible {
		outline: 2px solid var(--df-accent-text);
		outline-offset: -2px;
	}

	.palette-item.is-disabled {
		cursor: not-allowed;
		opacity: 0.5;
	}

	.palette-icon {
		display: grid;
		place-items: center;
		width: 24px;
		height: 24px;
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
		line-height: 1.3;
		color: var(--df-text-meta);
	}

	.palette-mark {
		display: grid;
		place-items: center;
		margin-left: auto;
		width: 18px;
		height: 18px;
		flex: none;
		color: var(--df-text-meta);
	}

	.palette-note {
		margin-top: 3px;
		padding: 5px var(--df-p-space-2) 3px;
		border-top: 1px solid var(--df-border-hairline);
		font-size: var(--df-p-text-2xs);
		line-height: 1.4;
		color: var(--df-text-meta);
	}

	@media (prefers-reduced-motion: reduce) {
		.palette-item {
			transition: none;
		}
	}
</style>
