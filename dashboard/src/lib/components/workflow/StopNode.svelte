<script lang="ts">
	import type { NodeProps } from '@xyflow/svelte';
	import NodeCard from './NodeCard.svelte';
	import { stopSummary, type FlowNode } from '$lib/workflow/graph';
	import type { StopData } from '$lib/types';

	let { id, data, selected = false }: NodeProps<FlowNode> = $props();

	const summary = $derived(stopSummary(data as unknown as StopData));
</script>

<NodeCard nodeId={id} type="stop" icon="stop" title="Stop" {summary} {selected}>
</NodeCard>
