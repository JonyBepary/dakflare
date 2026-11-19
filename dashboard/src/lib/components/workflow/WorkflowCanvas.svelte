<script lang="ts">
	import {
		Background,
		BackgroundVariant,
		Controls,
		MiniMap,
		SvelteFlow,
		type Connection,
		type EdgeTypes,
		type NodeTypes,
		type Viewport
	} from '@xyflow/svelte';
	import '@xyflow/svelte/dist/style.css';

	import FlowBridge from '$lib/components/workflow/FlowBridge.svelte';
	import ConditionNode from '$lib/components/workflow/ConditionNode.svelte';
	import DelayNode from '$lib/components/workflow/DelayNode.svelte';
	import ExtractNode from '$lib/components/workflow/ExtractNode.svelte';
	import FlowEdgeComponent from '$lib/components/workflow/FlowEdge.svelte';
	import SendSmsNode from '$lib/components/workflow/SendSmsNode.svelte';
	import SetVarNode from '$lib/components/workflow/SetVarNode.svelte';
	import StopNode from '$lib/components/workflow/StopNode.svelte';
	import SwitchNode from '$lib/components/workflow/SwitchNode.svelte';
	import TriggerNode from '$lib/components/workflow/TriggerNode.svelte';
	import UnsupportedNode from '$lib/components/workflow/UnsupportedNode.svelte';
	import WebhookNode from '$lib/components/workflow/WebhookNode.svelte';
	import type { FlowEdge, FlowNode } from '$lib/workflow/graph';

	let {
		nodes = $bindable<FlowNode[]>(),
		edges = $bindable<FlowEdge[]>(),
		viewport = $bindable<Viewport>(),
		minZoom = 0.7,
		staged = false,
		canEdit = true,
		savedViewport = false,
		framedOnce = $bindable(false),
		focusId = null,
		onbeforeconnect,
		onconnect,
		onconnectend,
		isValidConnection,
		ondelete,
		onmoveend,
		onpaneclick,
		onnodedragstop
	}: {
		nodes: FlowNode[];
		edges: FlowEdge[];
		viewport: Viewport;
		minZoom?: number;
		staged?: boolean;
		/** `false` hides the keys and tools that change the graph: a member's view. */
		canEdit?: boolean;
		savedViewport?: boolean;
		framedOnce: boolean;
		focusId?: string | null;
		onbeforeconnect: (connection: Connection) => FlowEdge | false;
		onconnect: (connection: Connection) => void;
		onconnectend: (
			event: MouseEvent | TouchEvent,
			state: { isValid?: boolean | null; fromHandle?: unknown; toHandle?: unknown }
		) => void;
		isValidConnection: (connection: Connection | FlowEdge) => boolean;
		ondelete: () => void;
		onmoveend: () => void;
		onpaneclick: () => void;
		onnodedragstop: () => void;
	} = $props();

	const NODE_TYPES: NodeTypes = {
		trigger: TriggerNode,
		extract: ExtractNode,
		set_var: SetVarNode,
		condition: ConditionNode,
		switch: SwitchNode,
		delay: DelayNode,
		webhook: WebhookNode,
		send_sms: SendSmsNode,
		stop: StopNode,
		// A kind this build does not know still gets a card, so it survives a load
		// and is written back unchanged on save.
		unsupported: UnsupportedNode
	};

	const EDGE_TYPES: EdgeTypes = {
		smoothstep: FlowEdgeComponent
	};
</script>

<SvelteFlow
	bind:nodes
	bind:edges
	bind:viewport
	edgesFocusable={false}
	nodeTypes={NODE_TYPES}
	edgeTypes={EDGE_TYPES}
	{minZoom}
	maxZoom={1.8}
	snapGrid={[16, 16]}
	deleteKey={staged || !canEdit ? [] : ['Backspace', 'Delete']}
	nodesDraggable={!staged}
	nodesConnectable={!staged}
	defaultMarkerColor={null}
	attributionPosition="bottom-center"
	{onbeforeconnect}
	{onconnect}
	{onconnectend}
	{isValidConnection}
	{ondelete}
	{onmoveend}
	{onpaneclick}
	{onnodedragstop}
>
	<FlowBridge
		fit={!savedViewport && !framedOnce}
		{focusId}
		{minZoom}
		onframed={() => (framedOnce = true)}
	/>
	<Background variant={BackgroundVariant.Dots} gap={20} size={1.2} />
	<Controls position="bottom-left" />
	<MiniMap
		position="bottom-right"
		width={160}
		height={110}
		pannable
		zoomable
		nodeBorderRadius={3}
		nodeColor="var(--df-text-meta)"
		nodeStrokeColor="transparent"
	/>
</SvelteFlow>
