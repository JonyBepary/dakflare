<script lang="ts">
	/**
	 * Rendered inside <SvelteFlow> only to hand the editor the instance helpers that
	 * live in the flow's context. It draws nothing.
	 */
	import { getContext, onMount } from 'svelte';
	import { useSvelteFlow } from '@xyflow/svelte';
	import { WORKFLOW_UI, type WorkflowCanvasUi } from '$lib/workflow/context';

	let {
		fit = true,
		focusId = null,
		minZoom = 0.7,
		onframed = null
	}: {
		/** Choose an opening view. False when a viewport was already saved. */
		fit?: boolean;
		/** Where to look when the whole graph cannot be shown at a readable zoom. */
		focusId?: string | null;
		minZoom?: number;
		onframed?: (() => void) | null;
	} = $props();

	// Read once, at creation: this decides the first viewport, so a later render
	// must not be able to cancel a frame that is already scheduled.
	// svelte-ignore state_referenced_locally
	const shouldFrame = fit;

	const ui = getContext<WorkflowCanvasUi>(WORKFLOW_UI);
	const { screenToFlowPosition, setCenter, getZoom, getNode, fitView } = useSvelteFlow();

	ui.screenToFlowPosition = (point) => screenToFlowPosition(point);

	ui.revealNode = (id, options) => {
		const node = getNode(id);
		if (!node) return;
		const zoom = getZoom();
		// A drawer over the right edge hides what is underneath it, so a revealed
		// step is centred in the space that is still visible, not in the whole canvas.
		const inset = (options?.rightInset ?? 0) / 2 / Math.max(zoom, 0.01);
		void setCenter(node.position.x + 107 + inset, node.position.y + 42, {
			zoom,
			duration: 240
		});
	};

	/**
	 * Frame the graph on something readable.
	 *
	 * Fitting a forty-step chain into a thousand pixels asks for a zoom of 0.09,
	 * which renders every card as a blank rectangle. So: fit when fitting stays
	 * above the floor, otherwise hold the floor and centre the trigger, and let the
	 * step finder and the minimap do the navigating.
	 */
	async function frame(duration: number) {
		const done = await fitView({ padding: 0.16, maxZoom: 1, minZoom, duration });
		if (!done) return;
		const zoom = getZoom();
		const node = focusId ? getNode(focusId) : undefined;
		if (node && zoom <= minZoom + 0.001) {
			await setCenter(node.position.x + 107, node.position.y + 42, {
				zoom: minZoom + 0.1,
				duration
			});
		}
	}

	ui.fitAll = () => {
		void frame(200);
	};

	onMount(() => {
		let inner = 0;
		const outer = requestAnimationFrame(() => {
			inner = requestAnimationFrame(() => {
				if (!shouldFrame) {
					onframed?.();
					return;
				}
				void frame(0).finally(() => onframed?.());
			});
		});
		return () => {
			cancelAnimationFrame(outer);
			cancelAnimationFrame(inner);
		};
	});
</script>
