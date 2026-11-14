<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import NodeCard from './NodeCard.svelte';
	import { webhookSummary, type FlowNode } from '$lib/workflow/graph';
	import type { WebhookData } from '$lib/types';

	let { id, data, selected = false }: NodeProps<FlowNode> = $props();

	const summary = $derived(webhookSummary(data as unknown as WebhookData));

	const cardTitle = $derived(
		typeof (data as { title?: unknown })?.title === 'string' &&
			((data as { title?: string }).title ?? '').trim()
			? (data as { title: string }).title.trim()
			: 'Webhook'
	);
</script>

<NodeCard nodeId={id} type="webhook" icon="external" title={cardTitle} {summary} {selected}>
	<Handle type="source" position={Position.Right} class="wf-handle" />
</NodeCard>
