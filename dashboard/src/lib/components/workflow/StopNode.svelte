<script lang="ts">
	import type { NodeProps } from '@xyflow/svelte';
	import NodeCard from './NodeCard.svelte';
	import { stopSummary, type FlowNode } from '$lib/workflow/graph';
	import type { StopData } from '$lib/types';

	let { id, data, selected = false }: NodeProps<FlowNode> = $props();

	const summary = $derived(stopSummary(data as unknown as StopData));

	const cardTitle = $derived(
		typeof (data as { title?: unknown })?.title === 'string' &&
			((data as { title?: string }).title ?? '').trim()
			? (data as { title: string }).title.trim()
			: 'Stop'
	);
</script>

<NodeCard nodeId={id} type="stop" icon="stop" title={cardTitle} {summary} {selected}>
</NodeCard>
