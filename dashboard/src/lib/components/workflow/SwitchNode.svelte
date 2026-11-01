<script lang="ts">
	import { Handle, Position, type NodeProps } from '@xyflow/svelte';
	import NodeCard from './NodeCard.svelte';
	import { switchBranchesOf, switchSummary, type FlowNode } from '$lib/workflow/graph';
	import type { SwitchData } from '$lib/types';

	let { id, data, selected = false }: NodeProps<FlowNode> = $props();

	const switchData = $derived(data as unknown as SwitchData);
	const summary = $derived(switchSummary(switchData));
	const branches = $derived(switchBranchesOf(switchData));
</script>

<NodeCard nodeId={id} type="switch" icon="workflow" title="Switch" {summary} {selected}>
	<div class="wf-branches">
		{#each branches as branch (branch.handle)}
			<div class="wf-branch">
				<span class="wf-branch-key wf-branch-key-wide" title={branch.label}>
					{branch.index === null ? 'default' : branch.label.trim() || `case ${branch.index + 1}`}
				</span>
				<span class="wf-branch-rule" aria-hidden="true"></span>
				<Handle id={branch.handle} type="source" position={Position.Right} class="wf-handle" />
			</div>
		{/each}
	</div>
</NodeCard>
