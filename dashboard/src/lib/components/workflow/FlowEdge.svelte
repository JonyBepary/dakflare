<script lang="ts">
	import { BaseEdge, getSmoothStepPath, type EdgeProps } from '@xyflow/svelte';
	import { getContext } from 'svelte';
	import type { FlowEdge } from '$lib/workflow/graph';
	import { WORKFLOW_UI, type WorkflowCanvasUi } from '$lib/workflow/context';

	let {
		id,
		source,
		target,
		sourceX,
		sourceY,
		targetX,
		targetY,
		sourcePosition,
		targetPosition,
		selected = false,
		markerEnd
	}: EdgeProps<FlowEdge> = $props();

	const ui = getContext<WorkflowCanvasUi>(WORKFLOW_UI);

	const path = $derived.by(() => {
		const [d] = getSmoothStepPath({
			sourceX,
			sourceY,
			sourcePosition,
			targetX,
			targetY,
			targetPosition,
			borderRadius: 14
		});
		return d;
	});

	const incident = $derived(ui.selectedId === source || ui.selectedId === target);
	const active = $derived(ui.activeEdgeIds.has(id));

	const style = $derived.by(() => {
		if (active) return 'stroke: var(--ok); stroke-width: 2;';
		if (selected || incident) return 'stroke: var(--accent); stroke-width: 2;';
		return 'stroke-width: 1.5;';
	});
</script>

<BaseEdge
	{id}
	{path}
	{markerEnd}
	{style}
	class={active ? 'wf-edge-active' : selected || incident ? 'wf-edge-accent' : undefined}
/>
