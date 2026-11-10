<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { beforeNavigate, replaceState } from '$app/navigation';
	import {
		Background,
		BackgroundVariant,
		Controls,
		MiniMap,
		Panel,
		SvelteFlow,
		type Connection,
		type EdgeTypes,
		type NodeTypes
	} from '@xyflow/svelte';
	import '@xyflow/svelte/dist/style.css';
	import '$lib/workflow/workflow.css';

	import Badge from '$lib/components/Badge.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import Notice from '$lib/components/Notice.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Spinner from '$lib/components/Spinner.svelte';
	import FlowPalette from '$lib/components/workflow/FlowPalette.svelte';
	import FlowBridge from '$lib/components/workflow/FlowBridge.svelte';
	import NodeInspector from '$lib/components/workflow/NodeInspector.svelte';
	import SimulationPanel from '$lib/components/workflow/SimulationPanel.svelte';
	import ValidationList from '$lib/components/workflow/ValidationList.svelte';
	import WorkflowSettings from '$lib/components/workflow/WorkflowSettings.svelte';
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

	import { ApiError, describeError, getWorkflow, readWorkflowIssues, saveWorkflow } from '$lib/api';
	import { ROUTES } from '$lib/paths';
	import type { WorkflowNodeType } from '$lib/types';
	import { WORKFLOW_UI, type WorkflowCanvasUi } from '$lib/workflow/context';
	import {
		NODE_LIMIT,
		NODE_META,
		RE_DEVICE_ID,
		applySwitchCase,
		createDraft,
		createEdge,
		createNode,
		createWorkflowId,
		fromGraph,
		mapServerIssues,
		nodeSummary,
		sourceHandles,
		toGraph,
		validateWorkflow,
		type EditorIssue,
		type FlowEdge,
		type FlowNode,
		type SwitchCaseOp
	} from '$lib/workflow/graph';
	import { simulate, type SimulationInput, type SimulationResult } from '$lib/workflow/simulate';
	import { runWasmFlow } from '$lib/workflow/wasm-engine';
	import { setContext } from 'svelte';

	let { id }: { id: string } = $props();

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

	let nodes = $state.raw<FlowNode[]>([]);
	let edges = $state.raw<FlowEdge[]>([]);

	let name = $state('');
	let enabled = $state(true);
	let deviceId = $state('');
	let workflowId = $state('');
	let version = $state<number | null>(null);
	let createdAt = $state<number | null>(null);
	let updatedAt = $state<number | null>(null);

	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let notFound = $state(false);
	let saving = $state(false);
	let saveError = $state<string | null>(null);
	let serverDetails = $state<EditorIssue[]>([]);

	let touched = $state(false);
	let baseline = $state('');
	let hasSaved = $state(false);
	let announce = $state('');
	let simulateOpen = $state(false);
	let simResult = $state<SimulationResult | null>(null);
	let simNodeIds = $state<Set<string>>(new Set());
	let simEdgeIds = $state<Set<string>>(new Set());
	let canvasEl = $state<HTMLDivElement | null>(null);
	let simulationEl = $state<HTMLDivElement | null>(null);

	let viewMode = $state<'canvas' | 'simple' | 'code'>('canvas');
	let codeText = $state('');
	let codeError = $state<string | null>(null);

	let channel = $state('all');
	let priority = $state(100);
	let cooldownS = $state(0);
	let maxPerHour = $state(0);

	// 50-state immutable undo/redo history
	interface HistorySnapshot {
		nodes: FlowNode[];
		edges: FlowEdge[];
		name: string;
		enabled: boolean;
	}
	let history = $state.raw<HistorySnapshot[]>([]);
	let historyIndex = $state<number>(-1);
	let isUndoingOrRedoing = false;

	function pushHistory() {
		if (isUndoingOrRedoing) return;
		const snapshot: HistorySnapshot = {
			nodes: JSON.parse(JSON.stringify(nodes)),
			edges: JSON.parse(JSON.stringify(edges)),
			name,
			enabled
		};
		const next = history.slice(0, historyIndex + 1);
		if (next.length >= 50) next.shift();
		next.push(snapshot);
		history = next;
		historyIndex = next.length - 1;
	}

	function undo() {
		if (historyIndex <= 0) return;
		isUndoingOrRedoing = true;
		historyIndex -= 1;
		const snapshot = history[historyIndex];
		nodes = JSON.parse(JSON.stringify(snapshot.nodes));
		edges = JSON.parse(JSON.stringify(snapshot.edges));
		name = snapshot.name;
		enabled = snapshot.enabled;
		touched = true;
		isUndoingOrRedoing = false;
		announce = 'Undo';
	}

	function redo() {
		if (historyIndex >= history.length - 1) return;
		isUndoingOrRedoing = true;
		historyIndex += 1;
		const snapshot = history[historyIndex];
		nodes = JSON.parse(JSON.stringify(snapshot.nodes));
		edges = JSON.parse(JSON.stringify(snapshot.edges));
		name = snapshot.name;
		enabled = snapshot.enabled;
		touched = true;
		isUndoingOrRedoing = false;
		announce = 'Redo';
	}

	function handleKeydown(e: KeyboardEvent) {
		const target = e.target as HTMLElement | null;
		if (
			target &&
			(target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
		) {
			return;
		}
		if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
			if (e.shiftKey) {
				e.preventDefault();
				redo();
			} else {
				e.preventDefault();
				undo();
			}
		} else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
			e.preventDefault();
			redo();
		}
	}

	function setViewMode(mode: 'canvas' | 'simple' | 'code') {
		if (mode === 'code') {
			codeText = JSON.stringify(toGraph(nodes, edges), null, 2);
			codeError = null;
		} else if (viewMode === 'code') {
			try {
				const parsed = JSON.parse(codeText);
				const graph = fromGraph(parsed);
				nodes = graph.nodes;
				edges = graph.edges;
				codeError = null;
				touch();
			} catch (err) {
				codeError = (err as Error).message;
				return;
			}
		}
		viewMode = mode;
	}

	$effect(() => {
		if (!simulateOpen) return;
		void tick().then(() => {
			const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
			simulationEl?.scrollIntoView({
				block: 'nearest',
				behavior: reduce ? 'auto' : 'smooth'
			});
		});
	});

	const selectedNode = $derived(nodes.find((node) => node.selected) ?? null);
	const nodeCount = $derived(nodes.length);
	const edgeCount = $derived(edges.length);
	const hasTrigger = $derived(nodes.some((node) => node.type === 'trigger'));

	const metaErrors = $derived.by(() => {
		const errors: Record<string, string> = {};
		if (!name.trim()) errors.name = 'Give the workflow a name before saving.';
		else if (name.length > 120) errors.name = 'Use 120 characters or fewer.';
		if (deviceId && !RE_DEVICE_ID.test(deviceId)) {
			errors.device_id = 'Device ids are 8–64 letters, digits, underscores or hyphens.';
		}
		return errors;
	});

	const clientIssues = $derived(validateWorkflow(nodes, edges));
	const issues = $derived.by(() => {
		const meta: EditorIssue[] = Object.entries(metaErrors).map(([field, message]) => ({
			kind: 'field',
			path: `workflow.${field}`,
			message
		}));
		const seen = new Set<string>();
		const combined: EditorIssue[] = [];
		for (const issue of [...serverDetails, ...clientIssues, ...meta]) {
			const key = `${issue.path}\u0000${issue.message}`;
			if (seen.has(key)) continue;
			seen.add(key);
			combined.push(issue);
		}
		return combined;
	});

	const blockedCount = $derived(issues.length);
	const canSave = $derived(blockedCount === 0 && !saving);

	function signature(): string {
		return JSON.stringify({
			name,
			enabled,
			deviceId,
			channel,
			priority,
			cooldownS,
			maxPerHour,
			graph: toGraph(nodes, edges)
		});
	}

	const dirty = $derived(touched && signature() !== baseline);

	const pageTitle = $derived(
		notFound || loadError ? 'Workflow unavailable' : name.trim() || 'Untitled workflow'
	);
	const pageDescription = $derived.by(() => {
		if (loading) return 'Loading the saved graph…';
		if (notFound) return 'This workflow may have been deleted from the gateway.';
		if (loadError) return 'The saved graph could not be read.';
		const scope = deviceId ? `Scoped to ${deviceId}` : 'Fleet-wide scope';
		return `${scope} · ${nodeCount} ${nodeCount === 1 ? 'step' : 'steps'} · runs on the phone first, with a Worker fallback`;
	});
	const saveState = $derived.by(() => {
		if (saving) return 'Saving…';
		if (saveError) return 'Save failed';
		if (dirty) return 'Unsaved changes';
		if (hasSaved) return `Saved · v${version ?? 1}`;
		return 'Draft · not saved';
	});
	const blockedReason = $derived(
		blockedCount === 0
			? 'Save workflow'
			: `${blockedCount} ${blockedCount === 1 ? 'problem' : 'problems'} to fix before saving`
	);

	/* -------------------------------------------------------------- context */

	const ui: WorkflowCanvasUi = {
		get selectedId() {
			return selectedNode?.id ?? null;
		},
		get activeNodeIds() {
			return simNodeIds;
		},
		get activeEdgeIds() {
			return simEdgeIds;
		},
		deleteNode(nodeId: string) {
			removeNode(nodeId);
		},
		duplicateNode(nodeId: string) {
			duplicateNode(nodeId);
		},
		unsupportedKind(nodeId: string) {
			const node = nodes.find((item) => item.id === nodeId);
			return node?.type === 'unsupported' ? (node.unsupportedType ?? '') : '';
		},
		screenToFlowPosition(point) {
			return point;
		},
		revealNode() {
			// Replaced by FlowBridge once Svelte Flow has mounted.
		}
	};
	setContext(WORKFLOW_UI, ui);

	beforeNavigate(({ cancel }) => {
		if (!dirty) return;
		const leave = window.confirm('This flow has unsaved changes. Leave without saving?');
		if (!leave) cancel();
	});

	onMount(() => {
		if (!id) {
			const draft = createDraft();
			nodes = draft.nodes;
			edges = draft.edges;
			workflowId = createWorkflowId();
			loading = false;
			touched = false;
			hasSaved = false;
			baseline = signature();
			history = [];
			historyIndex = -1;
			pushHistory();
		} else {
			void load(id);
		}
	});

	/* ------------------------------------------------------------ data load */

	async function load(workflowKey: string) {
		loading = true;
		loadError = null;
		notFound = false;
		try {
			const workflow = await getWorkflow(workflowKey);
			const graph = fromGraph(workflow.graph);
			nodes = graph.nodes;
			edges = graph.edges;
			name = workflow.name;
			enabled = workflow.enabled;
			deviceId = workflow.device_id ?? '';
			channel = workflow.channel ?? 'all';
			priority = workflow.priority ?? 100;
			cooldownS = workflow.cooldown_s ?? 0;
			maxPerHour = workflow.max_per_hour ?? 0;
			workflowId = workflow.id;
			version = workflow.version;
			createdAt = workflow.created_at;
			updatedAt = workflow.updated_at;
			hasSaved = true;
			touched = false;
			serverDetails = [];
			saveError = null;
			baseline = signature();
			history = [];
			historyIndex = -1;
			pushHistory();
		} catch (failure) {
			if (failure instanceof ApiError && failure.status === 404) {
				notFound = true;
			} else {
				loadError = describeError(failure);
			}
		} finally {
			loading = false;
		}
	}

	/* --------------------------------------------------------------- edits */

	function touch() {
		touched = true;
		serverDetails = [];
		saveError = null;
		pushHistory();
	}

	function updateNodeData(nodeId: string, patch: Record<string, unknown>) {
		nodes = nodes.map((node) =>
			node.id === nodeId ? { ...node, data: { ...node.data, ...patch } } : node
		);
		if (simResult) clearSimulation();
		touch();
	}

	/**
	 * A switch's branches are positional, so the cases and the connections have to
	 * move together. The rewrite lives in `applySwitchCase`; this only reports it.
	 */
	function updateSwitchCases(nodeId: string, op: SwitchCaseOp) {
		const edit = applySwitchCase(nodes, edges, nodeId, op);
		nodes = edit.nodes;
		edges = edit.edges;
		if (simResult) clearSimulation();
		touch();
		if (op.kind === 'add') {
			announce = 'Case added. Connect it from its new handle.';
		} else if (op.kind === 'remove') {
			announce = edit.dropped > 0 ? 'Case removed, along with its connection.' : 'Case removed.';
		}
	}

	function updateSettings(patch: {
		name?: string;
		enabled?: boolean;
		deviceId?: string;
		channel?: string;
		priority?: number;
		cooldownS?: number;
		maxPerHour?: number;
	}) {
		if (patch.name !== undefined) name = patch.name;
		if (patch.enabled !== undefined) enabled = patch.enabled;
		if (patch.deviceId !== undefined) deviceId = patch.deviceId;
		if (patch.channel !== undefined) channel = patch.channel;
		if (patch.priority !== undefined) priority = patch.priority;
		if (patch.cooldownS !== undefined) cooldownS = patch.cooldownS;
		if (patch.maxPerHour !== undefined) maxPerHour = patch.maxPerHour;
		touch();
	}

	function selectOnly(nodeId: string | null) {
		nodes = nodes.map((node) =>
			node.selected === (node.id === nodeId) ? node : { ...node, selected: node.id === nodeId }
		);
		edges = edges.map((edge) => (edge.selected ? { ...edge, selected: false } : edge));
	}

	function canvasCentre(): { x: number; y: number } {
		const rect = canvasEl?.getBoundingClientRect();
		const point = ui.screenToFlowPosition({
			x: (rect?.left ?? 0) + (rect?.width ?? 640) / 2,
			y: (rect?.top ?? 0) + (rect?.height ?? 540) / 2
		});
		const base = { x: point.x - 107, y: point.y - 40 };
		const offsets: Array<[number, number]> = [
			[0, 0],
			[0, 140],
			[0, 280],
			[240, 0],
			[240, 140],
			[0, 420],
			[240, 280],
			[-240, 0],
			[-240, 140],
			[0, 560]
		];

		// The centre is the first choice. Card-sized offsets only keep a second step
		// from disappearing underneath the first one.
		for (const [dx, dy] of offsets) {
			const candidate = { x: base.x + dx, y: base.y + dy };
			const taken = nodes.some(
				(node) =>
					Math.abs(node.position.x - candidate.x) < 230 &&
					Math.abs(node.position.y - candidate.y) < 130
			);
			if (!taken) return candidate;
		}
		const lowest = nodes.reduce((max, node) => Math.max(max, node.position.y), 0);
		return { x: base.x, y: lowest + 160 };
	}

	function addNode(type: WorkflowNodeType) {
		if (nodes.length >= NODE_LIMIT) {
			announce = `A flow can hold at most ${NODE_LIMIT} steps.`;
			return;
		}
		if (type === 'trigger' && hasTrigger) {
			announce = 'A flow can only have one trigger.';
			return;
		}
		const prevNode = viewMode === 'simple' && nodes.length > 0 ? nodes[nodes.length - 1] : null;
		const node = createNode(type, canvasCentre(), nodes);
		node.selected = true;
		nodes = [...nodes.map((item) => ({ ...item, selected: false })), node];
		if (prevNode && prevNode.type !== 'stop' && sourceHandles(prevNode).includes('')) {
			const hasOut = edges.some((e) => e.source === prevNode.id && !e.sourceHandle);
			if (!hasOut) {
				const edge = createEdge(prevNode.id, node.id, undefined, edges);
				edge.type = 'smoothstep';
				edges = [...edges, edge];
			}
		}
		simResult = null;
		simNodeIds = new Set();
		simEdgeIds = new Set();
		touch();
		announce = `Added a ${NODE_META[type].title} step.`;
		void tick().then(() => ui.revealNode(node.id));
	}

	function removeNode(nodeId: string) {
		const node = nodes.find((item) => item.id === nodeId);
		if (!node) return;
		nodes = nodes.filter((item) => item.id !== nodeId);
		edges = edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId);
		if (simResult) clearSimulation();
		touch();
		announce = 'Step deleted, along with its connections.';
	}

	function duplicateNode(nodeId: string) {
		const source = nodes.find((node) => node.id === nodeId);
		if (!source) return;
		if (source.type === 'unsupported') {
			announce = 'This step comes from a newer console, so it cannot be duplicated here.';
			return;
		}
		if (source.type === 'trigger' && hasTrigger) {
			announce = 'A flow can only have one trigger.';
			return;
		}
		if (nodes.length >= NODE_LIMIT) {
			announce = `A flow can hold at most ${NODE_LIMIT} steps.`;
			return;
		}
		const candidates = [
			{ x: source.position.x + 240, y: source.position.y },
			{ x: source.position.x, y: source.position.y + 140 },
			{ x: source.position.x - 240, y: source.position.y }
		];
		const position =
			candidates.find((candidate) =>
				nodes.every(
					(node) =>
						Math.abs(node.position.x - candidate.x) >= 230 ||
						Math.abs(node.position.y - candidate.y) >= 130
				)
			) ?? candidates[0];
		const copy = createNode(source.type, position, nodes);
		copy.data = JSON.parse(JSON.stringify(source.data)) as Record<string, unknown>;
		copy.selected = true;
		nodes = [...nodes.map((item) => ({ ...item, selected: false })), copy];
		if (simResult) clearSimulation();
		touch();
		announce = 'Step duplicated without its connections.';
	}

	/* ---------------------------------------------------------- connections */

	function reaches(from: string, target: string): boolean {
		const seen = new Set<string>([from]);
		const queue = [from];
		while (queue.length > 0) {
			const current = queue.shift() as string;
			for (const edge of edges) {
				if (edge.source !== current) continue;
				if (edge.target === target) return true;
				if (!seen.has(edge.target)) {
					seen.add(edge.target);
					queue.push(edge.target);
				}
			}
		}
		return false;
	}

	function isValidConnection(connection: Connection | FlowEdge): boolean {
		const source = nodes.find((node) => node.id === connection.source);
		const target = nodes.find((node) => node.id === connection.target);
		if (!source || !target) return false;
		if (source.id === target.id) return false;
		if (target.type === 'trigger') return false;
		if (source.type === 'stop') return false;

		if (source.type === 'unsupported') {
			// The editor cannot know how this step branches, so it offers at most one
			// plain connection and leaves an existing arrangement untouched.
			return (
				!edges.some((edge) => edge.source === source.id) && !reaches(target.id, source.id)
			);
		}

		const handle = connection.sourceHandle ?? '';
		if (!sourceHandles(source).includes(handle)) return false;
		// One connection per branch: true/false, each case, the default, or the single
		// plain handle every other kind has.
		if (
			edges.some(
				(edge) => edge.source === source.id && (edge.sourceHandle ?? '') === handle
			)
		) {
			return false;
		}

		return !reaches(target.id, source.id);
	}

	function handleOf(connection: Connection): string | undefined {
		const handle = connection.sourceHandle ?? '';
		return handle === '' ? undefined : handle;
	}

	function handleLabel(handle: string | undefined): string {
		if (!handle) return '';
		if (handle === 'default') return 'default';
		const match = /^case:(\d+)$/.exec(handle);
		if (match) return `case ${Number(match[1]) + 1}`;
		return handle;
	}

	function beforeConnect(connection: Connection): FlowEdge | false {
		if (!isValidConnection(connection)) return false;
		const edge = createEdge(connection.source, connection.target, handleOf(connection), edges);
		edge.type = 'smoothstep';
		return edge;
	}

	function afterConnect(connection: Connection) {
		const handle = handleOf(connection);
		if (simResult) clearSimulation();
		touch();
		announce = handle ? `Connected the ${handleLabel(handle)} branch.` : 'Steps connected.';
	}

	function connectEnded(
		_event: MouseEvent | TouchEvent,
		state: { isValid?: boolean | null; fromHandle?: unknown; toHandle?: unknown }
	) {
		if (state.isValid === false && state.fromHandle && state.toHandle) {
			announce = 'That connection is not allowed. Check the flow rules in Checks.';
		}
	}

	function handleDelete() {
		if (simResult) clearSimulation();
		touch();
		announce = 'Selection deleted.';
	}

	/* ------------------------------------------------------------ validation */

	function validateNow() {
		const count = issues.length;
		if (count === 0) {
			announce = 'Validation passed. This flow is ready to save.';
			return;
		}
		const first = issues[0];
		announce = `Validation found ${count} ${count === 1 ? 'problem' : 'problems'}. ${first.message}`;
		if (first.nodeId) selectOnly(first.nodeId);
	}

	/* ---------------------------------------------------------------- saving */

	async function save() {
		if (!canSave) {
			announce = blockedReason;
			return;
		}
		saving = true;
		saveError = null;
		serverDetails = [];
		try {
			const saved = await saveWorkflow(workflowId, {
				name: name.trim(),
				enabled,
				device_id: deviceId || null,
				channel,
				priority,
				cooldown_s: cooldownS,
				max_per_hour: maxPerHour,
				graph: toGraph(nodes, edges)
			});
			workflowId = saved.id;
			name = saved.name;
			enabled = saved.enabled;
			deviceId = saved.device_id ?? '';
			channel = saved.channel ?? 'all';
			priority = saved.priority ?? 100;
			cooldownS = saved.cooldown_s ?? 0;
			maxPerHour = saved.max_per_hour ?? 0;
			version = saved.version;
			createdAt = saved.created_at;
			updatedAt = saved.updated_at;
			hasSaved = true;
			touched = false;
			baseline = signature();
			announce = `Saved “${saved.name}”, version ${saved.version}.`;

			// A draft has no id in the address bar. Point it at the saved workflow so a
			// refresh (or a shared link) loads it instead of starting another draft.
			if (!id) {
				try {
					await replaceState(`${ROUTES.workflowEdit}?id=${encodeURIComponent(saved.id)}`, {});
				} catch {
					// The address bar is a convenience; the editor already points at the saved id.
				}
			}
		} catch (failure) {
			const details = readWorkflowIssues(failure);
			if (details.length > 0) {
				serverDetails = mapServerIssues(details, nodes, edges);
				announce = `The gateway rejected this graph: ${details.length} ${details.length === 1 ? 'problem' : 'problems'}.`;
			} else {
				saveError = describeError(failure);
				announce = saveError;
			}
		} finally {
			saving = false;
		}
	}

	/* ------------------------------------------------------------ simulation */

	async function runSimulation(input: SimulationInput) {
		try {
			const graph = toGraph(nodes, edges);
			const wasmRes = await runWasmFlow(graph, { sender: input.sender, body: input.body });
			const visited = wasmRes.steps.map((s) => s.node_id);
			simNodeIds = new Set(visited);
			const edgeSet = new Set<string>();
			for (let i = 0; i < visited.length - 1; i++) {
				const from = visited[i];
				const to = visited[i + 1];
				const edge = edges.find((e) => e.source === from && e.target === to);
				if (edge) edgeSet.add(edge.id);
			}
			simEdgeIds = edgeSet;
			simResult = {
				entered: wasmRes.matched,
				outcome: wasmRes.outcome === 'no_trigger' ? 'filtered' : wasmRes.outcome === 'partial' ? 'delivered' : wasmRes.outcome,
				summary: wasmRes.outcome === 'delivered' ? 'Reply delivered via flow.wasm' : wasmRes.outcome,
				visitedNodes: visited,
				visitedEdges: [...edgeSet],
				variables: wasmRes.variables,
				sms: wasmRes.actions
					.filter((a) => a.type === 'send_sms')
					.map((a) => ({ nodeId: '', to: (a as { to: string }).to, body: (a as { body: string }).body })),
				steps: wasmRes.steps.map((s) => ({
					nodeId: s.node_id,
					tone: s.kind === 'error' ? 'danger' : 'ok',
					text: `${s.kind}: ${s.detail}`
				})),
				warnings: wasmRes.error ? [wasmRes.error] : []
			};
		} catch {
			const result = simulate(nodes, edges, input);
			simResult = result;
			simNodeIds = new Set(result.visitedNodes);
			simEdgeIds = new Set(result.visitedEdges);
		}
	}

	function clearSimulation() {
		simResult = null;
		simNodeIds = new Set();
		simEdgeIds = new Set();
	}

	function openSimulation() {
		simulateOpen = !simulateOpen;
		if (!simulateOpen) clearSimulation();
	}
</script>

<svelte:head>
	<title>{pageTitle} · Workflows · DakFlare</title>
</svelte:head>

<svelte:window onkeydown={handleKeydown} />

<p class="sr-only" role="status" aria-live="polite">{announce}</p>

<div class="page editor-page">
	<PageHeader eyebrow="Automation" title={pageTitle} description={pageDescription}>
		{#if !loading && !notFound && !loadError}
			<span class="head-extras">
				<div class="view-mode-toggle" role="group" aria-label="Editor View">
					<button
						type="button"
						class="btn btn-sm view-btn"
						class:is-active={viewMode === 'simple'}
						onclick={() => setViewMode('simple')}
						title="Simple sequential step list"
					>
						Simple
					</button>
					<button
						type="button"
						class="btn btn-sm view-btn"
						class:is-active={viewMode === 'canvas'}
						onclick={() => setViewMode('canvas')}
						title="Visual canvas graph"
					>
						Canvas
					</button>
					<button
						type="button"
						class="btn btn-sm view-btn"
						class:is-active={viewMode === 'code'}
						onclick={() => setViewMode('code')}
						title="dakflare.flow/v3 JSON IR"
					>
						Code
					</button>
				</div>
				<Badge tone={enabled ? 'ok' : 'muted'} dot>{enabled ? 'enabled' : 'paused'}</Badge>
				{#if version !== null}
					<span class="mono version-chip">v{version}</span>
				{/if}
				<button
					type="button"
					class="btn btn-sm"
					onclick={() => selectOnly(null)}
					aria-pressed={selectedNode === null}
					title="Show the settings for this flow"
				>
					<Icon name="workflow" size={12} /> Flow settings
				</button>
			</span>
		{/if}
	</PageHeader>

	{#if loading}
		<section class="panel" aria-busy="true" aria-live="polite">
			<div class="panel-head"><h2 class="panel-title">Loading workflow</h2></div>
			<div class="loading-grid">
				<div class="skeleton" style="height: 420px"></div>
				<div class="skeleton" style="height: 420px"></div>
			</div>
		</section>
	{:else if notFound}
		<section class="panel">
			<div class="panel-body stack">
				<Notice tone="warn" title="Workflow not found">
					No workflow with id <span class="mono">{id}</span> is stored on this gateway. It may
					have been deleted, or the link may be out of date.
				</Notice>
				<div class="row">
					<a class="btn btn-primary" href={ROUTES.workflows}>Back to workflows</a>
					<!-- Same route as this page, so ask SvelteKit for a fresh document: the
					     editor only reads `?id=` when it mounts, and a draft needs that. -->
					<a class="btn" href={ROUTES.workflowEdit} data-sveltekit-reload>New workflow</a>
				</div>
			</div>
		</section>
	{:else if loadError}
		<section class="panel">
			<div class="panel-body stack">
				<Notice tone="danger" title="Could not load this workflow">{loadError}</Notice>
				<div class="row">
					<button type="button" class="btn btn-primary" onclick={() => void load(id)}>
						<Icon name="refresh" size={14} /> Try again
					</button>
					<a class="btn" href={ROUTES.workflows}>Back to workflows</a>
				</div>
			</div>
		</section>
	{:else}
		<div class="mobile-defer panel" aria-labelledby="mobile-defer-title">
			<div class="panel-body mobile-defer-body">
				<span class="empty-mark"><Icon name="workflow" size={18} /></span>
				<h2 id="mobile-defer-title">Workflow editing needs a larger screen</h2>
				<p>
					The canvas, drag-to-connect and inspector need a wider viewport. Open this workflow on a
					desktop to change it.
				</p>
				<div class="defer-summary">
					<p class="eyebrow">{nodeCount} {nodeCount === 1 ? 'step' : 'steps'} · read-only</p>
					{#if nodes.length === 0}
						<p class="hint">This flow has no steps yet.</p>
					{:else}
						<ol class="defer-list">
							{#each nodes as node, index (node.id)}
								<li>
									<span class="defer-index mono">{index + 1}</span>
									<span class="defer-step">
										<strong>{NODE_META[node.type].title}</strong>
										<small>{nodeSummary(node)}</small>
									</span>
								</li>
							{/each}
						</ol>
					{/if}
				</div>
				<div class="row">
					<a class="btn" href={ROUTES.workflows}>
						<Icon name="arrow-down-left" size={13} /> Back to workflows
					</a>
					{#if !id}<span class="hint">This draft is not saved yet.</span>{/if}
				</div>
			</div>
		</div>

		<div class="editor-grid">
			<div class="palette-col">
				<FlowPalette {nodeCount} {hasTrigger} onadd={addNode} />
			</div>

			<div class="canvas-col">
				{#if saveError}
					<Notice tone="danger" title="Could not save">{saveError}</Notice>
				{:else if serverDetails.length > 0}
					<Notice tone="warn" title="The gateway rejected this graph">
						{serverDetails.length}
						{serverDetails.length === 1 ? 'problem is' : 'problems are'} listed in Checks. Fix
						them, then save again.
					</Notice>
				{/if}

				{#if viewMode === 'canvas'}
					<div class="canvas-shell" bind:this={canvasEl}>
						<SvelteFlow
							bind:nodes
							bind:edges
							nodeTypes={NODE_TYPES}
							edgeTypes={EDGE_TYPES}
							minZoom={0.3}
							maxZoom={1.8}
							snapGrid={[16, 16]}
							deleteKey={['Backspace', 'Delete']}
							defaultMarkerColor={null}
							attributionPosition="bottom-center"
							onbeforeconnect={beforeConnect}
							onconnect={afterConnect}
							onconnectend={connectEnded}
							isValidConnection={isValidConnection}
							ondelete={handleDelete}
							onnodedragstop={() => {
								touch();
							}}
						>
							<FlowBridge />
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
							<Panel position="top-left">
								<div class="wf-toolbar-panel">
									<div class="toolbar-row">
										<a
											class="btn btn-ghost btn-icon btn-sm"
											href={ROUTES.workflows}
											title="Back to workflows"
											aria-label="Back to workflows"
										>
											<Icon name="arrow-down-left" size={14} />
										</a>
										<span class="toolbar-sep" aria-hidden="true"></span>
										<button
											type="button"
											class="btn btn-ghost btn-icon btn-sm"
											onclick={undo}
											disabled={historyIndex <= 0}
											title="Undo (Ctrl+Z)"
											aria-label="Undo"
										>
											<Icon name="undo" size={13} />
										</button>
										<button
											type="button"
											class="btn btn-ghost btn-icon btn-sm"
											onclick={redo}
											disabled={historyIndex >= history.length - 1}
											title="Redo (Ctrl+Y)"
											aria-label="Redo"
										>
											<Icon name="redo" size={13} />
										</button>
										<span class="toolbar-sep" aria-hidden="true"></span>
										<button
											type="button"
											class="btn btn-primary btn-sm"
											onclick={() => void save()}
											disabled={!canSave}
											aria-busy={saving}
											title={blockedReason}
										>
											{#if saving}<Spinner />{:else}<Icon name="check" size={12} />{/if}
											Save
										</button>
										<button
											type="button"
											class="btn btn-sm"
											onclick={validateNow}
											title="Run the structural checks"
										>
											<Icon name="shield" size={12} /> Validate
										</button>
										<button
											type="button"
											class="btn btn-sm"
											class:is-active={simulateOpen}
											onclick={openSimulation}
											aria-expanded={simulateOpen}
											title="Preview the flow with a sample message"
										>
											<Icon name="activity" size={12} /> Simulate
										</button>
									</div>
									<div class="toolbar-state">
										<span
											class="dot {dirty
												? 'dot-warn'
												: blockedCount > 0
													? 'dot-danger'
													: 'dot-ok'}"
											aria-hidden="true"
										></span>
										<span>{saveState}</span>
										{#if blockedCount > 0}
											<span class="toolbar-blocked">· {blockedCount} to fix</span>
										{/if}
										<span class="toolbar-spacer"></span>
										<label class="switch" title="Enable or pause this flow">
											<input
												type="checkbox"
												checked={enabled}
												onchange={(event) => updateSettings({ enabled: event.currentTarget.checked })}
											/>
											<span class="switch-track" aria-hidden="true"><span></span></span>
											<span class="switch-label">{enabled ? 'Enabled' : 'Paused'}</span>
										</label>
									</div>
								</div>
							</Panel>
						</SvelteFlow>

						{#if nodes.length === 0}
							<div class="canvas-empty">
								<span class="empty-mark"><Icon name="workflow" size={18} /></span>
								<h2>Start with a trigger</h2>
								<p>
									A flow begins when a message arrives. Add the trigger, then connect the steps
									that should run.
								</p>
								<button
									type="button"
									class="btn btn-primary btn-sm"
									onclick={() => addNode('trigger')}
								>
									<Icon name="zap" size={12} /> Add trigger
								</button>
							</div>
						{/if}
					</div>
				{:else if viewMode === 'simple'}
					<div class="simple-shell panel">
						<div class="view-panel-toolbar">
							<div class="toolbar-row">
								<a
									class="btn btn-ghost btn-icon btn-sm"
									href={ROUTES.workflows}
									title="Back to workflows"
									aria-label="Back to workflows"
								>
									<Icon name="arrow-down-left" size={14} />
								</a>
								<span class="toolbar-sep" aria-hidden="true"></span>
								<button
									type="button"
									class="btn btn-ghost btn-icon btn-sm"
									onclick={undo}
									disabled={historyIndex <= 0}
									title="Undo (Ctrl+Z)"
									aria-label="Undo"
								>
									<Icon name="undo" size={13} />
								</button>
								<button
									type="button"
									class="btn btn-ghost btn-icon btn-sm"
									onclick={redo}
									disabled={historyIndex >= history.length - 1}
									title="Redo (Ctrl+Y)"
									aria-label="Redo"
								>
									<Icon name="redo" size={13} />
								</button>
								<span class="toolbar-sep" aria-hidden="true"></span>
								<button
									type="button"
									class="btn btn-primary btn-sm"
									onclick={() => void save()}
									disabled={!canSave}
									aria-busy={saving}
									title={blockedReason}
								>
									{#if saving}<Spinner />{:else}<Icon name="check" size={12} />{/if}
									Save
								</button>
								<button
									type="button"
									class="btn btn-sm"
									onclick={validateNow}
									title="Run the structural checks"
								>
									<Icon name="shield" size={12} /> Validate
								</button>
								<button
									type="button"
									class="btn btn-sm"
									class:is-active={simulateOpen}
									onclick={openSimulation}
									aria-expanded={simulateOpen}
									title="Preview the flow with a sample message"
								>
									<Icon name="activity" size={12} /> Simulate
								</button>
							</div>
							<div class="toolbar-state">
								<span
									class="dot {dirty
										? 'dot-warn'
										: blockedCount > 0
											? 'dot-danger'
											: 'dot-ok'}"
									aria-hidden="true"
								></span>
								<span>{saveState}</span>
								{#if blockedCount > 0}
									<span class="toolbar-blocked">· {blockedCount} to fix</span>
								{/if}
								<span class="toolbar-spacer"></span>
								<label class="switch" title="Enable or pause this flow">
									<input
										type="checkbox"
										checked={enabled}
										onchange={(event) => updateSettings({ enabled: event.currentTarget.checked })}
									/>
									<span class="switch-track" aria-hidden="true"><span></span></span>
									<span class="switch-label">{enabled ? 'Enabled' : 'Paused'}</span>
								</label>
							</div>
						</div>

						<div class="simple-steps-container">
							{#if nodes.length === 0}
								<div class="canvas-empty">
									<span class="empty-mark"><Icon name="workflow" size={18} /></span>
									<h2>Start with a trigger</h2>
									<p>
										A flow begins when a message arrives. Add the trigger, then connect the steps
										that should run.
									</p>
									<button
										type="button"
										class="btn btn-primary btn-sm"
										onclick={() => addNode('trigger')}
									>
										<Icon name="zap" size={12} /> Add trigger
									</button>
								</div>
							{:else}
								<div class="simple-steps-list">
									{#each nodes as node, index (node.id)}
										<div
											class="simple-step-card"
											class:is-selected={node.selected}
											onclick={() => selectOnly(node.id)}
											role="button"
											tabindex="0"
											onkeydown={(e) => {
												if (e.key === 'Enter' || e.key === ' ') selectOnly(node.id);
											}}
										>
											<div class="step-num mono">{index + 1}</div>
											<div class="step-content">
												<div class="step-header">
													<strong class="step-title">{NODE_META[node.type]?.title ?? node.type}</strong>
													<Badge tone="neutral">{node.type}</Badge>
												</div>
												<div class="step-desc">{nodeSummary(node)}</div>
											</div>
											<div class="step-actions">
												<button
													type="button"
													class="btn btn-ghost btn-icon btn-sm"
													onclick={(e) => {
														e.stopPropagation();
														removeNode(node.id);
													}}
													title="Delete step"
													aria-label="Delete step"
												>
													<Icon name="trash" size={13} />
												</button>
											</div>
										</div>
										{#if index < nodes.length - 1}
											<div class="simple-step-connector" aria-hidden="true">
												<Icon name="chevron-down" size={14} />
											</div>
										{/if}
									{/each}
								</div>
							{/if}
						</div>
					</div>
				{:else if viewMode === 'code'}
					<div class="code-shell panel">
						<div class="view-panel-toolbar">
							<div class="toolbar-row">
								<a
									class="btn btn-ghost btn-icon btn-sm"
									href={ROUTES.workflows}
									title="Back to workflows"
									aria-label="Back to workflows"
								>
									<Icon name="arrow-down-left" size={14} />
								</a>
								<span class="toolbar-sep" aria-hidden="true"></span>
								<button
									type="button"
									class="btn btn-ghost btn-icon btn-sm"
									onclick={undo}
									disabled={historyIndex <= 0}
									title="Undo (Ctrl+Z)"
									aria-label="Undo"
								>
									<Icon name="undo" size={13} />
								</button>
								<button
									type="button"
									class="btn btn-ghost btn-icon btn-sm"
									onclick={redo}
									disabled={historyIndex >= history.length - 1}
									title="Redo (Ctrl+Y)"
									aria-label="Redo"
								>
									<Icon name="redo" size={13} />
								</button>
								<span class="toolbar-sep" aria-hidden="true"></span>
								<button
									type="button"
									class="btn btn-primary btn-sm"
									onclick={() => void save()}
									disabled={!canSave}
									aria-busy={saving}
									title={blockedReason}
								>
									{#if saving}<Spinner />{:else}<Icon name="check" size={12} />{/if}
									Save
								</button>
								<button
									type="button"
									class="btn btn-sm"
									onclick={validateNow}
									title="Run the structural checks"
								>
									<Icon name="shield" size={12} /> Validate
								</button>
								<button
									type="button"
									class="btn btn-sm"
									class:is-active={simulateOpen}
									onclick={openSimulation}
									aria-expanded={simulateOpen}
									title="Preview the flow with a sample message"
								>
									<Icon name="activity" size={12} /> Simulate
								</button>
							</div>
							<div class="toolbar-state">
								<span
									class="dot {dirty
										? 'dot-warn'
										: blockedCount > 0
											? 'dot-danger'
											: 'dot-ok'}"
									aria-hidden="true"
								></span>
								<span>{saveState}</span>
								{#if blockedCount > 0}
									<span class="toolbar-blocked">· {blockedCount} to fix</span>
								{/if}
								<span class="toolbar-spacer"></span>
								<label class="switch" title="Enable or pause this flow">
									<input
										type="checkbox"
										checked={enabled}
										onchange={(event) => updateSettings({ enabled: event.currentTarget.checked })}
									/>
									<span class="switch-track" aria-hidden="true"><span></span></span>
									<span class="switch-label">{enabled ? 'Enabled' : 'Paused'}</span>
								</label>
							</div>
						</div>

						<div class="code-editor-container">
							<div class="code-editor-header">
								<span class="eyebrow mono">dakflare.flow/v3 JSON</span>
								{#if codeError}
									<Badge tone="danger">Syntax error</Badge>
								{:else}
									<Badge tone="ok">Valid JSON</Badge>
								{/if}
							</div>
							{#if codeError}
								<div class="code-error-banner mono">{codeError}</div>
							{/if}
							<textarea
								class="code-textarea mono"
								bind:value={codeText}
								oninput={() => {
									try {
										const parsed = JSON.parse(codeText);
										const graph = fromGraph(parsed);
										nodes = graph.nodes;
										edges = graph.edges;
										codeError = null;
										touch();
									} catch (err) {
										codeError = (err as Error).message;
									}
								}}
								spellcheck="false"
								rows="26"
								placeholder="Paste or write dakflare.flow/v3 JSON here..."
							></textarea>
						</div>
					</div>
				{/if}

				{#if simulateOpen}
					<div class="simulation-slot" bind:this={simulationEl}>
						<SimulationPanel
							result={simResult}
							{nodes}
							onrun={runSimulation}
							onclose={openSimulation}
							onclear={clearSimulation}
						/>
					</div>
				{/if}
			</div>

			<div class="inspector-col">
				{#if selectedNode}
					<NodeInspector
						node={selectedNode}
						{nodes}
						{edges}
						{issues}
						onupdate={(patch) => updateNodeData(selectedNode?.id ?? '', patch)}
						oncases={(op) => updateSwitchCases(selectedNode?.id ?? '', op)}
						ondelete={() => selectedNode && removeNode(selectedNode.id)}
						onselect={selectOnly}
					/>
				{:else}
					<WorkflowSettings
						{name}
						{enabled}
						{deviceId}
						{channel}
						{priority}
						{cooldownS}
						{maxPerHour}
						{workflowId}
						{version}
						{createdAt}
						{updatedAt}
						{nodeCount}
						{edgeCount}
						{hasSaved}
						errors={metaErrors}
						showErrors={touched}
						onchange={updateSettings}
					/>
				{/if}

				<ValidationList {issues} onselect={selectOnly} />
			</div>
		</div>
	{/if}
</div>

<style>
	.editor-page {
		min-width: 0;
	}

	.head-extras {
		display: contents;
	}

	.mobile-defer {
		display: none;
	}

	.mobile-defer-body {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: var(--df-p-space-3);
	}

	.mobile-defer-body h2 {
		font-size: var(--df-p-text-lg);
	}

	.mobile-defer-body > p {
		max-width: 46ch;
		font-size: var(--df-p-text-base);
		line-height: 1.55;
		color: var(--df-text-meta);
	}

	.defer-summary {
		width: 100%;
		padding: var(--df-p-space-3);
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-sm);
		background: var(--df-surface-well);
	}

	.defer-list {
		display: flex;
		flex-direction: column;
		gap: 7px;
		margin: var(--df-p-space-2) 0 0;
		padding: 0;
		list-style: none;
	}

	.defer-list li {
		display: flex;
		align-items: flex-start;
		gap: var(--df-p-space-2);
	}

	.defer-index {
		display: grid;
		place-items: center;
		width: 18px;
		height: 18px;
		flex: none;
		margin-top: 1px;
		border-radius: var(--df-p-radius-xs);
		font-size: var(--df-p-text-2xs);
		color: var(--df-text-meta);
		background: var(--df-surface-card);
	}

	.defer-step {
		display: flex;
		flex-direction: column;
		gap: 1px;
		min-width: 0;
	}

	.defer-step strong {
		font-size: var(--df-p-text-base);
		font-weight: 500;
	}

	.defer-step small {
		font-size: 11px;
		line-height: 1.4;
		color: var(--df-text-meta);
		overflow-wrap: anywhere;
	}

	.version-chip {
		padding: 1px 7px;
		border-radius: var(--df-p-radius-pill);
		background: var(--df-surface-well);
		font-size: var(--df-p-text-xs);
		color: var(--df-text-meta);
	}

	.editor-grid {
		display: grid;
		grid-template-columns: 186px minmax(0, 1fr) 290px;
		gap: var(--df-p-space-3);
		align-items: start;
		min-width: 0;
	}

	.palette-col,
	.canvas-col,
	.inspector-col {
		min-width: 0;
	}

	.canvas-col,
	.inspector-col {
		display: flex;
		flex-direction: column;
		gap: var(--df-p-space-3);
	}

	.canvas-shell {
		position: relative;
		height: 600px;
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-lg);
		overflow: hidden;
		background: light-dark(var(--df-surface-well), var(--df-surface-page));
		transition: border-color 160ms ease;
	}

	.canvas-shell:focus-within {
		border-color: var(--df-border-control);
	}

	.canvas-shell :global(.svelte-flow) {
		border-radius: var(--df-p-radius-lg);
	}

	.canvas-shell :global(.svelte-flow__node:focus-visible) {
		outline: 2px solid var(--df-accent-text);
		outline-offset: 3px;
		border-radius: var(--df-p-radius-md);
	}

	.wf-toolbar-panel {
		display: flex;
		flex-direction: column;
		gap: 4px;
		width: 380px;
		max-width: calc(100vw - 56px);
		padding: var(--df-p-space-1);
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-md);
		background: var(--df-surface-card);
		box-shadow: var(--df-shadow-raised);
	}

	.toolbar-row {
		display: flex;
		align-items: center;
		gap: 5px;
		flex-wrap: wrap;
	}

	.toolbar-sep {
		width: 1px;
		height: 18px;
		background: var(--df-border-hairline);
		margin: 0 1px;
	}

	.toolbar-state {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		padding: 0 var(--df-p-space-1) 2px;
		font-family: var(--df-p-font-mono);
		font-size: var(--df-p-text-2xs);
		letter-spacing: 0.02em;
		color: var(--df-text-meta);
	}

	.toolbar-state > span:not(.dot):not(.toolbar-blocked) {
		min-width: 0;
	}

	.toolbar-spacer {
		flex: 1;
	}

	.toolbar-blocked {
		color: var(--df-state-danger-ink);
		white-space: nowrap;
	}

	.btn.is-active {
		background: var(--df-accent-soft);
		border-color: color-mix(in srgb, var(--df-accent-text) 32%, var(--df-border-hairline));
		color: var(--df-text-primary);
	}

	/* enabled switch */
	.switch {
		position: relative;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		margin-left: 1px;
		padding: 0 2px;
		cursor: pointer;
		font-size: 11px;
		color: var(--df-text-secondary);
		white-space: nowrap;
	}

	.switch input {
		position: absolute;
		opacity: 0;
		width: 1px;
		height: 1px;
	}

	.switch-track {
		position: relative;
		width: 30px;
		height: 18px;
		flex: none;
		border: 1px solid var(--df-border-control);
		border-radius: var(--df-p-radius-pill);
		background: var(--df-surface-well);
		transition:
			background-color 140ms ease,
			border-color 140ms ease;
	}

	.switch-track > span {
		position: absolute;
		top: 2px;
		left: 2px;
		width: 12px;
		height: 12px;
		border-radius: 50%;
		background: var(--df-text-meta);
		transition:
			transform 140ms ease,
			background-color 140ms ease;
	}

	.switch input:checked + .switch-track {
		background: var(--df-state-ok-bg);
		border-color: var(--df-state-ok-ink);
	}

	.switch input:checked + .switch-track > span {
		transform: translateX(12px);
		background: var(--df-state-ok-ink);
	}

	.switch input:focus-visible + .switch-track {
		outline: 2px solid var(--df-accent-text);
		outline-offset: 2px;
	}

	.switch-label {
		font-family: var(--df-p-font-mono);
		font-size: 9.5px;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--df-text-meta);
	}

	.canvas-empty {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: var(--df-p-space-2);
		padding: var(--df-p-space-5);
		text-align: center;
		pointer-events: none;
		background: color-mix(in srgb, var(--df-surface-well) 72%, transparent);
	}

	.canvas-empty .empty-mark {
		margin-bottom: 2px;
	}

	.canvas-empty h2 {
		font-size: var(--df-p-text-lg);
	}

	.canvas-empty p {
		max-width: 38ch;
		font-size: var(--df-p-text-base);
		line-height: 1.5;
		color: var(--df-text-meta);
	}

	.canvas-empty .btn {
		pointer-events: auto;
		margin-top: var(--df-p-space-2);
	}

	.loading-grid {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 320px);
		gap: var(--df-p-space-3);
		padding: var(--df-p-space-4);
	}

	@media (max-width: 1080px) {
		.editor-grid {
			grid-template-columns: 176px minmax(0, 1fr);
		}

		.inspector-col {
			grid-column: 1 / -1;
			display: grid;
			grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
			align-items: start;
		}
	}

	@media (max-width: 720px) {
		.mobile-defer {
			display: block;
		}

		.editor-grid {
			display: none;
		}

		.head-extras {
			display: none;
		}
	}

	@media (max-width: 760px) {
		.editor-grid {
			grid-template-columns: minmax(0, 1fr);
		}
		.canvas-shell {
			height: 460px;
		}

		.inspector-col {
			display: flex;
		}

		.canvas-shell :global(.svelte-flow__minimap) {
			display: none;
		}

	}

	@media (max-width: 520px) {
		.canvas-shell {
			height: 410px;
		}

		.switch-label {
			display: none;
		}

		.toolbar-row {
			gap: 4px;
		}

		.toolbar-row .btn {
			padding: 0 7px;
		}

	}

	@media (max-width: 900px) {
		.loading-grid {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.canvas-shell,
		.switch-track,
		.switch-track > span {
			transition: none;
		}
	}

	.view-mode-toggle {
		display: inline-flex;
		align-items: center;
		padding: 2px;
		background: var(--df-surface-well);
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-sm);
		gap: 2px;
	}

	.view-btn {
		padding: 3px 10px;
		font-size: var(--df-p-text-xs);
		border-radius: var(--df-p-radius-xs);
		background: transparent;
		border: none;
		color: var(--df-text-meta);
	}

	.view-btn.is-active {
		background: var(--df-surface-card);
		color: var(--df-text-main);
		font-weight: 500;
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
	}

	.simple-shell,
	.code-shell {
		display: flex;
		flex-direction: column;
		height: 640px;
		background: var(--df-surface-card);
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-md);
		overflow: hidden;
	}

	.view-panel-toolbar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--df-p-space-2);
		padding: var(--df-p-space-2) var(--df-p-space-3);
		background: var(--df-surface-well);
		border-bottom: 1px solid var(--df-border-hairline);
	}

	.simple-steps-container {
		flex: 1;
		overflow-y: auto;
		padding: var(--df-p-space-4);
	}

	.simple-steps-list {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--df-p-space-2);
		max-width: 520px;
		margin: 0 auto;
	}

	.simple-step-card {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-3);
		width: 100%;
		padding: var(--df-p-space-3);
		background: var(--df-surface-well);
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-sm);
		cursor: pointer;
		transition: border-color 0.15s ease, background 0.15s ease;
	}

	.simple-step-card:hover {
		border-color: var(--df-border-strong);
	}

	.simple-step-card.is-selected {
		border-color: var(--df-brand);
		background: var(--df-surface-card);
	}

	.step-num {
		display: grid;
		place-items: center;
		width: 24px;
		height: 24px;
		border-radius: var(--df-p-radius-xs);
		background: var(--df-surface-card);
		font-size: var(--df-p-text-xs);
		font-weight: 600;
		color: var(--df-text-meta);
		flex: none;
	}

	.step-content {
		flex: 1;
		min-width: 0;
	}

	.step-header {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-2);
		margin-bottom: 2px;
	}

	.step-title {
		font-size: var(--df-p-text-sm);
	}

	.step-desc {
		font-size: var(--df-p-text-xs);
		color: var(--df-text-meta);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.simple-step-connector {
		display: flex;
		justify-content: center;
		color: var(--df-text-meta);
		opacity: 0.6;
	}

	.code-editor-container {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		padding: var(--df-p-space-3);
	}

	.code-editor-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: var(--df-p-space-2);
	}

	.code-error-banner {
		padding: var(--df-p-space-2) var(--df-p-space-3);
		margin-bottom: var(--df-p-space-2);
		background: rgba(220, 38, 38, 0.1);
		border: 1px solid rgba(220, 38, 38, 0.3);
		border-radius: var(--df-p-radius-xs);
		font-size: var(--df-p-text-xs);
		color: #ef4444;
	}

	.code-textarea {
		flex: 1;
		width: 100%;
		resize: none;
		padding: var(--df-p-space-3);
		font-size: 13px;
		line-height: 1.5;
		background: var(--df-surface-well);
		color: var(--df-text-main);
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-sm);
		font-family: monospace;
		tab-size: 2;
	}

	.code-textarea:focus {
		outline: none;
		border-color: var(--df-brand);
	}
</style>
