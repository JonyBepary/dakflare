<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import NodeCard from './NodeCard.svelte';
	import { setVarSummary, type FlowNode } from '$lib/workflow/graph';
	import type { SetVarData } from '$lib/types';

	let { id, data, selected = false }: NodeProps<FlowNode> = $props();

	const summary = $derived(setVarSummary(data as unknown as SetVarData));
</script>

<NodeCard nodeId={id} type="set_var" icon="key" title="Set variable" {summary} {selected}>
	<Handle type="source" position={Position.Right} class="wf-handle" />
</NodeCard>
