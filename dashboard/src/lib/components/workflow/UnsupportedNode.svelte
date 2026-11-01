<script lang="ts">
	import { getContext } from 'svelte';
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import NodeCard from './NodeCard.svelte';
	import { WORKFLOW_UI, type WorkflowCanvasUi } from '$lib/workflow/context';
	import type { FlowNode } from '$lib/workflow/graph';

	let { id, selected = false }: NodeProps<FlowNode> = $props();

	const ui = getContext<WorkflowCanvasUi>(WORKFLOW_UI);
	const kind = $derived(ui.unsupportedKind(id));
	const summary = $derived(
		kind ? `Kind “${kind}” is kept exactly as it is.` : 'Kept exactly as it is.'
	);
</script>

<NodeCard
	nodeId={id}
	type="unsupported"
	icon="alert"
	title="Unsupported step"
	{summary}
	{selected}
	canDuplicate={false}
>
	<div class="wf-unsupported-note">
		<span class="wf-unsupported-tag">not editable here</span>
	</div>
	<Handle type="source" position={Position.Right} class="wf-handle" />
</NodeCard>
