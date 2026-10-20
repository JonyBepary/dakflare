<script lang="ts">
	import type { Snippet } from 'svelte';
	import { getContext } from 'svelte';
	import { Handle, NodeToolbar, Position } from '@xyflow/svelte';
	import Icon, { type IconName } from '$lib/components/Icon.svelte';
	import { WORKFLOW_UI, type WorkflowCanvasUi } from '$lib/workflow/context';
	import type { WorkflowNodeType } from '$lib/types';

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
		type: WorkflowNodeType;
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
</script>

<div
	class="wf-node wf-node-{type}"
	class:is-selected={selected}
	class:is-active={active}
	data-node-id={nodeId}
>
	{#if hasTarget}
		<Handle type="target" position={Position.Left} class="wf-handle" />
	{/if}

	<div class="wf-node-head">
		<span class="wf-node-icon"><Icon name={icon} size={13} strokeWidth={1.7} /></span>
		<span class="wf-node-type">{title}</span>
		{#if active}
			<span class="wf-node-ran" title="Visited in the last preview">ran</span>
		{/if}
	</div>

	<p class="wf-node-summary" title={summary}>{summary}</p>

	{@render children?.()}

	<NodeToolbar class="wf-toolbar" offset={8}>
		{#if canDuplicate}
			<button
				type="button"
				class="wf-tool"
				onclick={() => ui.duplicateNode(nodeId)}
				title="Duplicate node"
				aria-label={`Duplicate ${title} node`}
			>
				<Icon name="copy" size={12} />
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
			<Icon name="trash" size={12} />
		</button>
	</NodeToolbar>
</div>
