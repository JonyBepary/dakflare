<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import NodeCard from './NodeCard.svelte';
	import { sendSummary, type FlowNode } from '$lib/workflow/graph';
	import type { SendSmsData } from '$lib/types';

	let { id, data, selected = false }: NodeProps<FlowNode> = $props();

	const summary = $derived(sendSummary(data as unknown as SendSmsData));

	const cardTitle = $derived(
		typeof (data as { title?: unknown })?.title === 'string' &&
			((data as { title?: string }).title ?? '').trim()
			? (data as { title: string }).title.trim()
			: 'Send SMS'
	);
</script>

<NodeCard nodeId={id} type="send_sms" icon="send" title={cardTitle} {summary} {selected}>
	<Handle type="source" position={Position.Right} class="wf-handle" />
</NodeCard>
