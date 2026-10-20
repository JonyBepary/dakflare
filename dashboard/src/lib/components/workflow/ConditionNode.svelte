<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import NodeCard from './NodeCard.svelte';
	import { conditionSummary, type FlowNode } from '$lib/workflow/graph';
	import type { ConditionData } from '$lib/types';

	let { id, data, selected = false }: NodeProps<FlowNode> = $props();

	const summary = $derived(conditionSummary(data as unknown as ConditionData));
</script>

<NodeCard nodeId={id} type="condition" icon="branch" title="Condition" {summary} {selected}>
	<div class="wf-branches">
		<div class="wf-branch">
			<span class="wf-branch-key">true</span>
			<span class="wf-branch-rule" aria-hidden="true"></span>
			<Handle id="true" type="source" position={Position.Right} class="wf-handle" />
		</div>
		<div class="wf-branch">
			<span class="wf-branch-key">false</span>
			<span class="wf-branch-rule" aria-hidden="true"></span>
			<Handle id="false" type="source" position={Position.Right} class="wf-handle" />
		</div>
	</div>
</NodeCard>
