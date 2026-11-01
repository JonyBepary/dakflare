<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import NodeCard from './NodeCard.svelte';
	import { delaySummary, type FlowNode } from '$lib/workflow/graph';
	import type { DelayData } from '$lib/types';

	let { id, data, selected = false }: NodeProps<FlowNode> = $props();

	const summary = $derived(delaySummary(data as unknown as DelayData));
</script>

<NodeCard nodeId={id} type="delay" icon="clock" title="Delay" {summary} {selected}>
	<Handle type="source" position={Position.Right} class="wf-handle" />
</NodeCard>
