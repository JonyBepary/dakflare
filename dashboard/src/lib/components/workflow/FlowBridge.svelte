<script lang="ts">
	/**
	 * Rendered inside <SvelteFlow> only to hand the editor the instance helpers that
	 * live in the flow's context. It draws nothing.
	 */
	import { getContext, onMount } from 'svelte';
	import { useSvelteFlow } from '@xyflow/svelte';
	import { WORKFLOW_UI, type WorkflowCanvasUi } from '$lib/workflow/context';

	const ui = getContext<WorkflowCanvasUi>(WORKFLOW_UI);
	const { screenToFlowPosition, setCenter, getZoom, getNode, fitView } = useSvelteFlow();

	ui.screenToFlowPosition = (point) => screenToFlowPosition(point);

	ui.revealNode = (id) => {
		const node = getNode(id);
		if (!node) return;
		void setCenter(node.position.x + 107, node.position.y + 42, {
			zoom: getZoom(),
			duration: 260
		});
	};

	// Fit once, when the flow first mounts. This is deliberately not the `fitView`
	// prop: that re-runs whenever the node list changes, which would yank the
	// viewport away from a step the operator just added.
	onMount(() => {
		let inner = 0;
		const outer = requestAnimationFrame(() => {
			inner = requestAnimationFrame(() => {
				void fitView({ padding: 0.18, maxZoom: 1, duration: 0 });
			});
		});
		return () => {
			cancelAnimationFrame(outer);
			cancelAnimationFrame(inner);
		};
	});
</script>
