<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import NodeCard from './NodeCard.svelte';
	import { triggerSummary, type FlowNode } from '$lib/workflow/graph';
	import type { TriggerData } from '$lib/types';

	let { id, data, selected = false }: NodeProps<FlowNode> = $props();

	const summary = $derived(triggerSummary(data as unknown as TriggerData));
</script>

<NodeCard nodeId={id} type="trigger" icon="zap" title="Trigger" {summary} {selected} hasTarget={false} canDuplicate={false}>
	<Handle type="source" position={Position.Right} class="wf-handle" />
</NodeCard>
