<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import NodeCard from './NodeCard.svelte';
	import { extractSummary, type FlowNode } from '$lib/workflow/graph';
	import type { ExtractData } from '$lib/types';

	let { id, data, selected = false }: NodeProps<FlowNode> = $props();

	const summary = $derived(extractSummary(data as unknown as ExtractData));
</script>

<NodeCard nodeId={id} type="extract" icon="braces" title="Extract" {summary} {selected}>
	<Handle type="source" position={Position.Right} class="wf-handle" />
</NodeCard>
