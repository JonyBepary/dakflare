<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import NodeCard from './NodeCard.svelte';
	import { setVarSummary, type FlowNode } from '$lib/workflow/graph';
	import type { SetVarData } from '$lib/types';

	let { id, data, selected = false }: NodeProps<FlowNode> = $props();

	const summary = $derived(setVarSummary(data as unknown as SetVarData));

	const cardTitle = $derived(
		typeof (data as { title?: unknown })?.title === 'string' &&
			((data as { title?: string }).title ?? '').trim()
			? (data as { title: string }).title.trim()
			: 'Set variable'
	);
</script>

<NodeCard nodeId={id} type="set_var" icon="key" title={cardTitle} {summary} {selected}>
	<Handle type="source" position={Position.Right} class="wf-handle" />
</NodeCard>
