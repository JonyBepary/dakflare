<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import NodeCard from './NodeCard.svelte';
	import { webhookSummary, type FlowNode } from '$lib/workflow/graph';
	import type { WebhookData } from '$lib/types';

	let { id, data, selected = false }: NodeProps<FlowNode> = $props();

	const summary = $derived(webhookSummary(data as unknown as WebhookData));
</script>

<NodeCard nodeId={id} type="webhook" icon="external" title="Webhook" {summary} {selected}>
	<Handle type="source" position={Position.Right} class="wf-handle" />
</NodeCard>
