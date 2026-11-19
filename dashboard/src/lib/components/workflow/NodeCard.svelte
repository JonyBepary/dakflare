<script lang="ts">
	import type { Snippet } from 'svelte';
	import { getContext } from 'svelte';
	import { Handle, NodeToolbar, Position } from '@xyflow/svelte';
	import Icon, { type IconName } from '$lib/components/Icon.svelte';
	import { WORKFLOW_UI, type WorkflowCanvasUi } from '$lib/workflow/context';
	import { WORKFLOW_GHOST, type WorkflowGhostUi } from './ghost';
	import type { CanvasNodeType } from '$lib/workflow/graph';

	let {
		nodeId,
		type,
		icon,
		title,
		summary,
		selected = false,
		hasTarget = true,
		canDuplicate = true,
		children
	}: {
		nodeId: string;
		type: CanvasNodeType;
		icon: IconName;
		title: string;
		summary: string;
		selected?: boolean;
		hasTarget?: boolean;
		canDuplicate?: boolean;
		children?: Snippet;
	} = $props();

	const ui = getContext<WorkflowCanvasUi>(WORKFLOW_UI);
	const active = $derived(ui.activeNodeIds.has(nodeId));
	// Present only while a patch is staged. A card that is not part of one draws
	// exactly as it did before.
	const ghost = getContext<WorkflowGhostUi | undefined>(WORKFLOW_GHOST);
	const ghostKind = $derived(ghost?.kindOf(nodeId) ?? null);
</script>

<div
	class="wf-node wf-node-{type}"
	class:is-selected={selected}
	class:is-active={active}
	class:is-ghost={ghostKind !== null}
	class:is-ghost-added={ghostKind === 'added'}
	data-node-id={nodeId}
	data-ghost={ghostKind ?? undefined}
>
	{#if hasTarget}
		<Handle type="target" position={Position.Left} class="wf-handle" />
	{/if}

	<div class="wf-node-head">
		<span class="wf-node-icon"><Icon name={icon} size={16} /></span>
		<span class="wf-node-type">{title}</span>
		{#if active}
			<span class="wf-node-ran" title="Visited in the last preview">ran</span>
		{/if}
		{#if ghostKind !== null}
			<span class="wf-node-ghost" title="Part of the patch waiting for you to accept or revert">
				{ghostKind === 'added' ? 'new' : 'changed'}
			</span>
		{/if}
	</div>

	<p class="wf-node-summary" title={summary}>{summary}</p>

	{@render children?.()}

	{#if ui.canEdit}
		<NodeToolbar class="wf-toolbar" offset={8}>
			{#if canDuplicate}
				<button
					type="button"
					class="wf-tool"
					onclick={() => ui.duplicateNode(nodeId)}
					title="Duplicate node"
					aria-label={`Duplicate ${title} node`}
				>
					<Icon name="copy" size={16} />
				</button>
				<span class="wf-tool-sep" aria-hidden="true"></span>
			{/if}
			<button
				type="button"
				class="wf-tool wf-tool-danger"
				onclick={() => ui.deleteNode(nodeId)}
				title="Delete node"
				aria-label={`Delete ${title} node`}
			>
				<Icon name="trash" size={16} />
			</button>
		</NodeToolbar>
	{/if}
</div>

<style>
	/* A staged card is drawn, not applied: a dashed edge, a wash, and a word in
	   the head that says which half of the patch it is. Scoped on purpose — the
	   rest of the card is styled by `workflow.css`, which is shared. */
	.wf-node.is-ghost {
		border-style: dashed;
		border-color: var(--df-state-info-ink);
		background: color-mix(in srgb, var(--df-state-info-bg) 55%, var(--df-surface-card));
		box-shadow: none;
	}

	.wf-node.is-ghost:hover {
		transform: none;
		box-shadow: var(--df-shadow-card);
	}

	.wf-node.is-ghost-added {
		outline: 1px dashed color-mix(in srgb, var(--df-state-info-ink) 55%, transparent);
		outline-offset: 3px;
	}

	.wf-node-ghost {
		margin-left: auto;
		padding: 0 6px;
		border-radius: var(--df-p-radius-pill);
		background: var(--df-state-info-bg);
		color: var(--df-state-info-ink);
		font-family: var(--df-p-font-mono);
		font-size: 9px;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}

	.wf-node.is-ghost .wf-node-type {
		color: var(--df-state-info-ink);
	}

	@media (prefers-reduced-motion: reduce) {
		.wf-node.is-ghost:hover {
			transform: none;
		}
	}
</style>

