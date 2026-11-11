<script lang="ts">
	import { onMount, setContext, tick } from 'svelte';
	import { beforeNavigate, goto, replaceState } from '$app/navigation';
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
	import '$lib/workflow/workflow.css';

	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import Notice from '$lib/components/Notice.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Spinner from '$lib/components/Spinner.svelte';
	import FlowPalette from '$lib/components/workflow/FlowPalette.svelte';
	import FlowBridge from '$lib/components/workflow/FlowBridge.svelte';
	import NodeInspector from '$lib/components/workflow/NodeInspector.svelte';
	import SimulationPanel from '$lib/components/workflow/SimulationPanel.svelte';
	import SourceSheet, { type ApplyResult } from '$lib/components/workflow/SourceSheet.svelte';
	import StepFinder from '$lib/components/workflow/StepFinder.svelte';
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
		COL_GAP,
		NODE_LIMIT,
		NODE_META,
		RE_DEVICE_ID,
		applySwitchCase,
		computeLayout,
		createDraft,
		createEdge,
		createNode,
		createWorkflowId,
		fromGraph,
		mapServerIssues,
		metaFor,
		nodeSummary,
		outlineItems,
		previewSeed,
		sourceHandles,
		toGraph,
		validateWorkflow,
		type EditorIssue,
		type FlowEdge,
		type FlowNode,
		type OutlineItem,
		type SwitchCaseOp
	} from '$lib/workflow/graph';
	import { simulate, type SimulationInput, type SimulationResult } from '$lib/workflow/simulate';
	import { runWasmFlow } from '$lib/workflow/wasm-engine';

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

	/** Below this a card's own copy stops being readable, so the map never goes there. */
	const MIN_ZOOM = 0.7;
	const DRAWER_WIDTH = 420;
	const SURFACE_KEY = 'dakflare.workflow.surface';
	const BURST_MS = 600;

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

	/* surfaces, sheets and drawers */
	let surface = $state<'steps' | 'map'>('steps');
	let settingsOpen = $state(false);
	let simulateOpen = $state(false);
	let sourceOpen = $state(false);
	let finderOpen = $state(false);
	let addOpen = $state(false);
	let checksOpen = $state(false);
	let menuOpen = $state(false);

	let stepsBtn = $state<HTMLButtonElement | null>(null);
	let addBtn = $state<HTMLButtonElement | null>(null);
	let mapBtn = $state<HTMLButtonElement | null>(null);
	let drawerEl = $state<HTMLElement | null>(null);
	let canvasEl = $state<HTMLDivElement | null>(null);

	let viewport = $state<Viewport>({ x: 0, y: 0, zoom: 1 });
	let savedViewport = $state(false);
	/** The opening view is chosen once, not every time the map is remounted. */
	let framedOnce = $state(false);
	let pointerAt = $state<{ x: number; y: number } | null>(null);
	let addFromKeyboard = $state(false);

	let simResult = $state<SimulationResult | null>(null);
	let simNodeIds = $state<Set<string>>(new Set());
	let simEdgeIds = $state<Set<string>>(new Set());

	let channel = $state('all');
	let priority = $state(100);
	let cooldownS = $state(0);
	let maxPerHour = $state(0);

	/* ------------------------------------------------------------ undo/redo */

	interface HistorySnapshot {
		nodes: FlowNode[];
		edges: FlowEdge[];
		name: string;
		enabled: boolean;
		sig: string;
	}
	let history = $state.raw<HistorySnapshot[]>([]);
	let historyIndex = $state<number>(-1);
	let isUndoingOrRedoing = false;

	/** Typing is one history entry per burst, not one per keystroke. */
	let burstKey: string | null = null;
	let burstAt = 0;

	function snapshotSig(): string {
		return JSON.stringify({ nodes, edges, name, enabled });
	}

	function pushHistory() {
		if (isUndoingOrRedoing) return;
		const sig = snapshotSig();
		if (historyIndex >= 0 && history[historyIndex]?.sig === sig) return;
		const snapshot: HistorySnapshot = {
			nodes: JSON.parse(JSON.stringify(nodes)) as FlowNode[],
			edges: JSON.parse(JSON.stringify(edges)) as FlowEdge[],
			name,
			enabled,
			sig
		};
		const next = history.slice(0, historyIndex + 1);
		if (next.length >= 50) next.shift();
		next.push(snapshot);
		history = next;
		historyIndex = next.length - 1;
	}

	/**
	 * A burst is: the state before typing, then the state after it, with nothing in
	 * between. Undo returns the value a field had before the typing started, which
	 * is what an operator means by "undo that".
	 *
	 * `beginEdit` runs before a change and `touch` after one. A keyed edit opens a
	 * burst and records nothing until it closes; an unkeyed edit is structural and
	 * is recorded at once, so deleting a step is one undo away.
	 */
	function commitBurst() {
		if (burstKey === null) return;
		burstKey = null;
		pushHistory();
	}

	function beginEdit(coalesceKey?: string) {
		touched = true;
		serverDetails = [];
		saveError = null;
		if (!coalesceKey) {
			commitBurst();
			return;
		}
		const now = Date.now();
		if (burstKey === coalesceKey && now - burstAt <= BURST_MS) {
			burstAt = now;
			return;
		}
		commitBurst();
		burstKey = coalesceKey;
		burstAt = now;
	}

	/** Records the change that just happened. */
	function touch() {
		touched = true;
		serverDetails = [];
		saveError = null;
		commitBurst();
		pushHistory();
	}

	function restore(snapshot: HistorySnapshot) {
		isUndoingOrRedoing = true;
		// Where the operator is looking is not part of the document: undoing a
		// keystroke must not also close the field it was typed into.
		const keep = nodes.find((node) => node.selected)?.id ?? null;
		const restored = JSON.parse(JSON.stringify(snapshot.nodes)) as FlowNode[];
		nodes = restored.map((node) =>
			node.selected === (node.id === keep) ? node : { ...node, selected: node.id === keep }
		);
		edges = JSON.parse(JSON.stringify(snapshot.edges)) as FlowEdge[];
		name = snapshot.name;
		enabled = snapshot.enabled;
		touched = true;
		isUndoingOrRedoing = false;
		if (simResult) clearSimulation();
	}

	function undo() {
		if (burstKey !== null) {
			// The typing never became an entry. Undo is the value before it started.
			burstKey = null;
			if (historyIndex >= 0) restore(history[historyIndex]);
			announce = 'Undo';
			return;
		}
		if (historyIndex <= 0) return;
		historyIndex -= 1;
		restore(history[historyIndex]);
		announce = 'Undo';
	}

	function redo() {
		commitBurst();
		if (historyIndex >= history.length - 1) return;
		historyIndex += 1;
		restore(history[historyIndex]);
		announce = 'Redo';
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && (checksOpen || menuOpen || addOpen)) {
			checksOpen = false;
			menuOpen = false;
			addOpen = false;
			return;
		}
		const mod = event.ctrlKey || event.metaKey;
		if (mod && event.key.toLowerCase() === 's') {
			event.preventDefault();
			void save();
			return;
		}
		if (mod && event.key.toLowerCase() === 'k') {
			event.preventDefault();
			finderOpen = true;
			return;
		}
		if (!mod) return;
		const key = event.key.toLowerCase();
		if (key !== 'z' && key !== 'y') return;
		// The source sheet edits its own text, and the finder has no document.
		if (sourceOpen || finderOpen) return;
		event.preventDefault();
		if (key === 'y' || (key === 'z' && event.shiftKey)) redo();
		else undo();
	}

	/* ------------------------------------------------------------- storage */

	function readStore(key: string): string | null {
		try {
			return window.localStorage.getItem(key);
		} catch {
			return null;
		}
	}

	function writeStore(key: string, value: string) {
		try {
			window.localStorage.setItem(key, value);
		} catch {
			// A private window refuses the write; the editor still works, it just
			// forgets where it was.
		}
	}

	const viewKey = $derived(id || 'draft');

	/** The workflow currently in the editor. The address bar can change under us. */
	// svelte-ignore state_referenced_locally
	let loadedKey = $state(id ?? '');

	function viewportStoreKey(): string {
		return `dakflare.workflow.viewport.${viewKey}`;
	}

	function restoreViewport() {
		const raw = readStore(viewportStoreKey());
		if (!raw) {
			savedViewport = false;
			return;
		}
		try {
			const parsed = JSON.parse(raw) as Partial<Viewport>;
			if (
				typeof parsed.x === 'number' &&
				typeof parsed.y === 'number' &&
				typeof parsed.zoom === 'number' &&
				Number.isFinite(parsed.x) &&
				Number.isFinite(parsed.y) &&
				Number.isFinite(parsed.zoom)
			) {
				viewport = { x: parsed.x, y: parsed.y, zoom: Math.max(parsed.zoom, MIN_ZOOM) };
				savedViewport = true;
			}
		} catch {
			savedViewport = false;
		}
	}

	function rememberViewport() {
		if (surface !== 'map') return;
		writeStore(
			viewportStoreKey(),
			JSON.stringify({
				x: Math.round(viewport.x * 100) / 100,
				y: Math.round(viewport.y * 100) / 100,
				zoom: Math.round(viewport.zoom * 1000) / 1000
			})
		);
	}

	/* -------------------------------------------------------------- derived */

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

	const issueCounts = $derived.by(() => {
		const counts = new Map<string, number>();
		for (const issue of issues) {
			if (!issue.nodeId) continue;
			counts.set(issue.nodeId, (counts.get(issue.nodeId) ?? 0) + 1);
		}
		return counts;
	});

	const blockedCount = $derived(issues.length);
	const canSave = $derived(blockedCount === 0 && !saving);

	const outline = $derived<OutlineItem[]>(outlineItems(nodes, edges));
	const seed = $derived(previewSeed(nodes));

	const drawerOpen = $derived(settingsOpen || selectedNode !== null);
	const showStepDrawer = $derived(surface === 'map' && drawerOpen);

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
		if (saving) return { text: 'Saving…', tone: 'muted' as const };
		if (saveError) return { text: 'Save failed', tone: 'danger' as const };
		if (dirty) return { text: 'Unsaved changes', tone: 'warn' as const };
		if (hasSaved) return { text: `Saved · v${version ?? 1}`, tone: 'ok' as const };
		return { text: 'Draft · not saved', tone: 'muted' as const };
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
		},
		fitAll() {
			// Replaced by FlowBridge once Svelte Flow has mounted.
		}
	};
	setContext(WORKFLOW_UI, ui);

	/* --------------------------------------------------------- leaving guard */

	let leavePrompt = $state<null | { href: string; kind: 'link' | 'back' }>(null);
	let allowLeave = false;

	beforeNavigate(({ cancel, to, type }) => {
		if (!dirty || allowLeave) return;
		cancel();
		if (!to) return;
		leavePrompt = { href: to.url.href, kind: type === 'popstate' ? 'back' : 'link' };
	});

	function handleBeforeUnload(event: BeforeUnloadEvent) {
		if (!dirty) return;
		event.preventDefault();
		event.returnValue = '';
	}

	async function discardAndLeave() {
		const target = leavePrompt;
		leavePrompt = null;
		if (!target) return;
		allowLeave = true;
		try {
			if (target.kind === 'back') {
				window.history.back();
				return;
			}
			await goto(target.href, { invalidateAll: false });
		} finally {
			allowLeave = false;
		}
	}

	onMount(() => {
		restoreViewport();
		// The surface is the operator's habit, not the flow's: a flow opened for the
		// first time opens in Steps, and after that it opens where they left it.
		surface = readStore(SURFACE_KEY) === 'map' ? 'map' : 'steps';
		loadedKey = id ?? '';
		if (!id) startDraft();
		else void load(id);
	});

	/** A fresh draft: the new-workflow state, also used when the address loses its id. */
	function startDraft() {
		const draft = createDraft();
		nodes = draft.nodes;
		edges = draft.edges;
		name = '';
		enabled = true;
		deviceId = '';
		channel = 'all';
		priority = 100;
		cooldownS = 0;
		maxPerHour = 0;
		workflowId = createWorkflowId();
		version = null;
		createdAt = null;
		updatedAt = null;
		loading = false;
		notFound = false;
		loadError = null;
		serverDetails = [];
		saveError = null;
		touched = false;
		hasSaved = false;
		simulateOpen = false;
		clearSimulation();
		selectOnly(null);
		settingsOpen = false;
		baseline = signature();
		history = [];
		historyIndex = -1;
		pushHistory();
	}

	/**
	 * The workflows list is a link away, on this same route: SvelteKit reuses the
	 * page, so the editor has to notice that the id in the address bar is a
	 * different flow, or it keeps showing the last one.
	 */
	$effect(() => {
		const key = id ?? '';
		if (key === loadedKey) return;
		loadedKey = key;
		// Our own save just put this id in the address bar; the graph is already here.
		if (key && key === workflowId) return;
		void switchWorkflow(key);
	});

	async function switchWorkflow(key: string) {
		commitBurst();
		leavePrompt = null;
		settingsOpen = false;
		sourceOpen = false;
		finderOpen = false;
		checksOpen = false;
		menuOpen = false;
		simulateOpen = false;
		clearSimulation();
		selectOnly(null);
		savedViewport = false;
		framedOnce = false;
		viewport = { x: 0, y: 0, zoom: 1 };
		restoreViewport();
		if (!key) {
			loading = false;
			startDraft();
			return;
		}
		await load(key);
		hostNotice();
	}

	/** One line at the top of the new flow, so the switch is not silent. */
	function hostNotice() {
		announce = notFound
			? 'That workflow is not on this gateway.'
			: loadError
				? 'That workflow could not be read.'
				: `Opened “${name || 'workflow'}”, ${nodeCount} ${nodeCount === 1 ? 'step' : 'steps'}.`;
	}

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

	function updateNodeData(nodeId: string, patch: Record<string, unknown>) {
		const keys = Object.keys(patch);
		const burst = keys.length === 1 ? `data:${nodeId}:${keys[0]}` : undefined;
		beginEdit(burst);
		nodes = nodes.map((node) =>
			node.id === nodeId ? { ...node, data: { ...node.data, ...patch } } : node
		);
		if (simResult) clearSimulation();
		if (!burst) touch();
	}

	/**
	 * A switch's branches are positional, so the cases and the connections have to
	 * move together. The rewrite lives in `applySwitchCase`; this only reports it.
	 */
	function updateSwitchCases(nodeId: string, op: SwitchCaseOp) {
		const burst = op.kind === 'rename' ? `cases:${nodeId}:${op.index}` : undefined;
		beginEdit(burst);
		const edit = applySwitchCase(nodes, edges, nodeId, op);
		nodes = edit.nodes;
		edges = edit.edges;
		if (simResult) clearSimulation();
		if (!burst) touch();
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
		const keys = Object.keys(patch);
		const typed = keys.length === 1 && keys[0] !== 'enabled' ? `settings:${keys[0]}` : undefined;
		beginEdit(typed);
		if (patch.name !== undefined) name = patch.name;
		if (patch.enabled !== undefined) enabled = patch.enabled;
		if (patch.deviceId !== undefined) deviceId = patch.deviceId;
		if (patch.channel !== undefined) channel = patch.channel;
		if (patch.priority !== undefined) priority = patch.priority;
		if (patch.cooldownS !== undefined) cooldownS = patch.cooldownS;
		if (patch.maxPerHour !== undefined) maxPerHour = patch.maxPerHour;
		if (!typed) touch();
	}

	function selectOnly(nodeId: string | null) {
		commitBurst();
		if (nodeId !== null) settingsOpen = false;
		nodes = nodes.map((node) =>
			node.selected === (node.id === nodeId) ? node : { ...node, selected: node.id === nodeId }
		);
		edges = edges.map((edge) => (edge.selected ? { ...edge, selected: false } : edge));
	}

	/** Select a step the way a row, a check or the finder asks for. */
	async function reveal(nodeId: string, options: { focusField?: boolean } = {}) {
		selectOnly(nodeId);
		await tick();
		if (surface === 'map') {
			ui.revealNode(nodeId, { rightInset: showStepDrawer ? DRAWER_WIDTH : 0 });
		} else {
			document
				.querySelector(`[data-step-id="${CSS.escape(nodeId)}"]`)
				?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
		}
		if (options.focusField) focusFirstField();
	}

	/** Puts the caret in the first thing the selected step lets you change. */
	function focusFirstField() {
		void tick().then(() => {
			const body = document.querySelector('[data-inspector-body]');
			const field = body?.querySelector<HTMLElement>(
				'select, textarea, input:not([type="checkbox"]):not([type="radio"]):not([disabled])'
			);
			if (!field) return;
			field.focus();
		});
	}

	function canvasCentre(): { x: number; y: number } {
		const rect = canvasEl?.getBoundingClientRect();
		const point = ui.screenToFlowPosition({
			x: (rect?.left ?? 0) + (rect?.width ?? 640) / 2,
			y: (rect?.top ?? 0) + (rect?.height ?? 540) / 2
		});
		return freeSpot({ x: point.x - 107, y: point.y - 40 });
	}

	function cursorSpot(): { x: number; y: number } {
		if (!pointerAt) return canvasCentre();
		const point = ui.screenToFlowPosition(pointerAt);
		return { x: Math.round(point.x - 107), y: Math.round(point.y - 40) };
	}

	/** A position past the right edge of the map, for adds that have no pointer. */
	function appendSpot(): { x: number; y: number } {
		if (nodes.length === 0) return { x: 40, y: 120 };
		const right = nodes.reduce(
			(best, node) => (node.position.x > best.position.x ? node : best),
			nodes[0]
		);
		return freeSpot({ x: right.position.x + COL_GAP, y: right.position.y });
	}

	/** Card-sized steps away from `start` until nothing is underneath. */
	function freeSpot(start: { x: number; y: number }): { x: number; y: number } {
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
		for (const [dx, dy] of offsets) {
			const candidate = { x: start.x + dx, y: start.y + dy };
			const taken = nodes.some(
				(node) =>
					Math.abs(node.position.x - candidate.x) < 230 &&
					Math.abs(node.position.y - candidate.y) < 130
			);
			if (!taken) return candidate;
		}
		const lowest = nodes.reduce((max, node) => Math.max(max, node.position.y), 0);
		return { x: start.x, y: lowest + 160 };
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
		const previous = selectedNode;
		const atPointer = surface === 'map' && !addFromKeyboard && pointerAt !== null;
		const position = atPointer ? cursorSpot() : surface === 'map' ? canvasCentre() : appendSpot();
		const node = createNode(type, position, nodes);
		node.selected = true;
		nodes = [...nodes.map((item) => ({ ...item, selected: false })), node];

		// One plain edge from whatever was selected, when the connection rules allow
		// exactly that: a free plain handle on the step before, and a step that may
		// receive it. The new step is already in `nodes`, so the rules can see it.
		let connected = false;
		if (previous && previous.type !== 'stop') {
			const edge = createEdge(previous.id, node.id, undefined, edges);
			edge.type = 'smoothstep';
			if (isValidConnection(edge)) {
				edges = [...edges, edge];
				connected = true;
			}
		}

		simResult = null;
		simNodeIds = new Set();
		simEdgeIds = new Set();
		touch();
		announce = `Added a ${NODE_META[type].title} step.${connected ? ' It is connected to the step before it.' : ''}`;
		// A step dropped under the pointer is already in view; only a step added by
		// keyboard or appended to the flow needs the map to go and find it.
		if (surface === 'map' && !atPointer) void tick().then(() => ui.revealNode(node.id));
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
			return !edges.some((edge) => edge.source === source.id) && !reaches(target.id, source.id);
		}

		const handle = connection.sourceHandle ?? '';
		if (!sourceHandles(source).includes(handle)) return false;
		// One connection per branch: true/false, each case, the default, or the single
		// plain handle every other kind has.
		if (
			edges.some((edge) => edge.source === source.id && (edge.sourceHandle ?? '') === handle)
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

	function openChecks() {
		commitBurst();
		checksOpen = true;
		if (issues.length === 0) {
			announce = 'Checks passed. This flow is ready to save.';
			return;
		}
		const first = issues[0];
		announce = `Checks found ${issues.length} ${issues.length === 1 ? 'problem' : 'problems'}. ${first.message}`;
		if (first.nodeId) void reveal(first.nodeId);
	}

	function runChecks() {
		// One verb: it reveals as well as selects.
		openChecks();
	}

	/* ------------------------------------------------------------- arrange */

	function arrange() {
		if (nodes.length === 0) return;
		const layout = computeLayout(nodes, edges);
		let moved = 0;
		nodes = nodes.map((node) => {
			const target = layout[node.id];
			if (!target) return node;
			if (target.x === node.position.x && target.y === node.position.y) return node;
			moved += 1;
			return { ...node, position: target };
		});
		if (moved === 0) {
			announce = 'The map is already arranged.';
			return;
		}
		touch();
		announce = `Arranged ${moved} ${moved === 1 ? 'step' : 'steps'}.`;
		void tick().then(() => ui.fitAll());
	}

	/* ---------------------------------------------------------------- saving */

	async function save() {
		if (!canSave) {
			announce = blockedReason;
			return;
		}
		commitBurst();
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
				expected_previous_version: hasSaved && version !== null ? version : undefined,
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
				outcome:
					wasmRes.outcome === 'no_trigger'
						? 'filtered'
						: wasmRes.outcome === 'partial'
							? 'delivered'
							: wasmRes.outcome,
				summary: wasmRes.outcome === 'delivered' ? 'Reply delivered via flow.wasm' : wasmRes.outcome,
				visitedNodes: visited,
				visitedEdges: [...edgeSet],
				variables: wasmRes.variables,
				sms: wasmRes.actions
					.filter((a) => a.type === 'send_sms')
					.map((a) => ({
						nodeId: '',
						to: (a as { to: string }).to,
						body: (a as { body: string }).body
					})),
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

	function togglePreview() {
		commitBurst();
		simulateOpen = !simulateOpen;
		if (!simulateOpen) clearSimulation();
	}

	/* --------------------------------------------------------------- source */

	const sourceJson = $derived(JSON.stringify(toGraph(nodes, edges), null, 2));

	function applySource(text: string): ApplyResult {
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch (error) {
			return { ok: false, error: (error as Error).message };
		}
		if (!parsed || typeof parsed !== 'object') {
			return { ok: false, error: 'The document must be a JSON object with nodes and edges.' };
		}
		const shape = parsed as { nodes?: unknown; edges?: unknown };
		if (!Array.isArray(shape.nodes) || !Array.isArray(shape.edges)) {
			return { ok: false, error: 'The document needs both a nodes array and an edges array.' };
		}
		let graph: { nodes: FlowNode[]; edges: FlowEdge[] };
		try {
			graph = fromGraph(parsed as Parameters<typeof fromGraph>[0]);
		} catch (error) {
			return { ok: false, error: (error as Error).message };
		}
		const before = nodes.length;
		const after = graph.nodes.length;
		const beforeEdges = edges.length;
		const afterEdges = graph.edges.length;
		nodes = graph.nodes;
		edges = graph.edges;
		selectOnly(null);
		if (simResult) clearSimulation();
		touch();
		announce = `Source applied: ${before} ${before === 1 ? 'step' : 'steps'} become ${after}.`;
		const steps =
			before === after
				? `${after} ${after === 1 ? 'step' : 'steps'}, unchanged`
				: `${before} ${before === 1 ? 'step' : 'steps'} become ${after}`;
		const links =
			beforeEdges === afterEdges
				? `${afterEdges} ${afterEdges === 1 ? 'connection' : 'connections'}`
				: `${beforeEdges} become ${afterEdges}`;
		return { ok: true, note: `Applied · ${steps} · ${links}.` };
	}

	/* ------------------------------------------------------------- surfaces */

	async function setSurface(next: 'steps' | 'map') {
		if (next === surface) return;
		commitBurst();
		pushHistory();
		if (surface === 'map') rememberViewport();
		surface = next;
		writeStore(SURFACE_KEY, next);
		await tick();
		if (next === 'map') framedOnce = true;
		// A mode switch must not drop the keyboard on the floor: the button that was
		// pressed is where the next Tab starts from.
		(next === 'steps' ? stepsBtn : mapBtn)?.focus();
		if (next === 'map' && selectedNode) {
			void tick().then(() => ui.revealNode(selectedNode.id));
		}
	}

	function openSettings() {
		menuOpen = false;
		settingsOpen = true;
		selectOnly(null);
	}

	/* --------------------------------------------------- scroll bookkeeping */

	let lastInspectorId: string | null = null;
	$effect(() => {
		const current = selectedNode?.id ?? null;
		if (current === lastInspectorId) return;
		lastInspectorId = current;
		void tick().then(() => {
			// A new step starts at its header, not halfway down the last one.
			if (drawerEl) drawerEl.scrollTop = 0;
			if (current && surface === 'steps') {
				document
					.querySelector(`[data-step-id="${CSS.escape(current)}"]`)
					?.scrollIntoView({ block: 'nearest' });
			}
		});
	});
</script>

<svelte:head>
	<title>{pageTitle} · Workflows · DakFlare</title>
</svelte:head>

<svelte:window
	onkeydown={handleKeydown}
	onbeforeunload={handleBeforeUnload}
	onpointerdown={(event) => {
		if (!menuOpen) return;
		const target = event.target as Node | null;
		if (target instanceof Element && target.closest('.menu-anchor')) return;
		menuOpen = false;
	}}
/>

<p class="sr-only" role="status" aria-live="polite">{announce}</p>

<div class="page editor-page">
	<PageHeader eyebrow="Automation" title={pageTitle} description={pageDescription}>
		{#if !loading && !notFound && !loadError}
			<a
				class="btn btn-ghost btn-icon btn-sm"
				href={ROUTES.workflows}
				title="Back to workflows"
				aria-label="Back to workflows"
			>
				<Icon name="arrow-down-left" size={16} />
			</a>
			<div class="undo-group">
				<button
					type="button"
					class="btn btn-ghost btn-icon btn-sm"
					onclick={undo}
					disabled={historyIndex <= 0}
					title="Undo (Ctrl+Z)"
					aria-label="Undo"
				>
					<Icon name="undo" size={16} />
				</button>
				<button
					type="button"
					class="btn btn-ghost btn-icon btn-sm"
					onclick={redo}
					disabled={historyIndex >= history.length - 1}
					title="Redo (Ctrl+Y)"
					aria-label="Redo"
				>
					<Icon name="redo" size={16} />
				</button>
			</div>

			<span class="checks-anchor">
				<button
					type="button"
					class="btn btn-sm checks-button"
					class:has-issues={blockedCount > 0}
					onclick={runChecks}
					aria-expanded={checksOpen}
					aria-haspopup="dialog"
					title="Run the structural and field checks"
				>
					<Icon name="shield" size={16} /> Run checks
					{#if blockedCount > 0}
						<span class="count">{blockedCount}</span>
					{/if}
				</button>
				{#if checksOpen}
					<ValidationList
						{issues}
						{nodes}
						onreveal={(nodeId) => {
							checksOpen = false;
							void reveal(nodeId, { focusField: true });
						}}
						onclose={() => (checksOpen = false)}
					/>
				{/if}
			</span>

			<button
				type="button"
				class="btn btn-sm"
				class:is-active={simulateOpen}
				onclick={togglePreview}
				aria-expanded={simulateOpen}
				title="Preview the flow with a sample message"
			>
				<Icon name="activity" size={16} /> Preview
			</button>

			<button
				type="button"
				class="btn btn-primary btn-sm"
				onclick={() => void save()}
				disabled={!canSave}
				aria-busy={saving}
				title={`${blockedReason} (Ctrl+S)`}
			>
				{#if saving}<Spinner />{:else}<Icon name="check" size={16} />{/if}
				Save
			</button>

			<span class="menu-anchor">
				<button
					type="button"
					class="btn btn-ghost btn-icon btn-sm"
					aria-haspopup="menu"
					aria-expanded={menuOpen}
					aria-label="More actions"
					title="More actions"
					onclick={() => (menuOpen = !menuOpen)}
				>
					<Icon name="grip" size={16} />
				</button>
				{#if menuOpen}
					<div class="menu" role="menu">
						<button
							type="button"
							class="menu-item"
							role="menuitem"
							onclick={() => {
								menuOpen = false;
								sourceOpen = true;
							}}
						>
							<Icon name="braces" size={16} />
							<span>Source</span>
							<span class="menu-note mono">JSON</span>
						</button>
						<button
							type="button"
							class="menu-item"
							role="menuitem"
							onclick={() => {
								menuOpen = false;
								arrange();
							}}
						>
							<Icon name="workflow" size={16} />
							<span>Arrange map</span>
						</button>
						<button type="button" class="menu-item" role="menuitem" onclick={openSettings}>
							<Icon name="workflow" size={16} />
							<span>Flow settings</span>
						</button>
						<button
							type="button"
							class="menu-item"
							role="menuitem"
							onclick={() => {
								menuOpen = false;
								finderOpen = true;
							}}
						>
							<Icon name="filter" size={16} />
							<span>Find a step</span>
							<span class="menu-note mono">Ctrl K</span>
						</button>
					</div>
				{/if}
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
						<Icon name="refresh" size={16} /> Try again
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
					The outline, the canvas and the step editor need a wider viewport. Open this workflow
					on a desktop to change it.
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
						<Icon name="arrow-down-left" size={16} /> Back to workflows
					</a>
					{#if !id}<span class="hint">This draft is not saved yet.</span>{/if}
				</div>
			</div>
		</div>

		<div class="work-panel" inert={sourceOpen || finderOpen ? true : undefined}>
			<div class="work-bar">
				<div class="surface-switch" role="group" aria-label="Editor surface">
					<button
						type="button"
						class="surface-btn"
						class:is-active={surface === 'steps'}
						aria-pressed={surface === 'steps'}
						bind:this={stepsBtn}
						onclick={() => void setSurface('steps')}
						title="Every step as a branch-aware outline"
					>
						Steps
					</button>
					<button
						type="button"
						class="surface-btn"
						class:is-active={surface === 'map'}
						aria-pressed={surface === 'map'}
						bind:this={mapBtn}
						onclick={() => void setSurface('map')}
						title="The diagram, with the step editor alongside"
					>
						Map
					</button>
				</div>

				<span class="chip" data-tone={saveState.tone} role="status" aria-live="polite">
					{saveState.text}
				</span>
				<span class="spacer"></span>

				<button
					type="button"
					class="btn btn-ghost btn-sm find-button"
					onclick={() => (finderOpen = true)}
					title="Find a step by name (Ctrl+K)"
				>
					<Icon name="filter" size={16} /> Find
				</button>

				<button
					type="button"
					class="btn btn-ghost btn-icon btn-sm"
					onclick={openSettings}
					aria-pressed={settingsOpen}
					aria-label="Flow settings"
					title="Flow settings: name, scope and pause"
				>
					<Icon name="workflow" size={16} />
				</button>

				<span class="add-anchor">
					<button
						type="button"
						class="btn btn-sm"
						bind:this={addBtn}
						aria-haspopup="dialog"
						aria-expanded={addOpen}
						onclick={(event) => {
							addFromKeyboard = event.detail === 0;
							addOpen = !addOpen;
						}}
						title={surface === 'map'
							? 'Add a step where the pointer is'
							: 'Add a step at the end of the flow'}
					>
						<Icon name="plus" size={16} /> Add step
					</button>
					{#if addOpen}
						<FlowPalette
							{nodeCount}
							{hasTrigger}
							onadd={addNode}
							onclose={() => {
								addOpen = false;
								// Back to the button that opened it, so the keyboard is not
								// dropped on the floor after a pick.
								void tick().then(() => addBtn?.focus());
							}}
						/>
					{/if}
				</span>

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

			{#if saveError}
				<Notice tone="danger" title="Could not save">{saveError}</Notice>
			{:else if serverDetails.length > 0}
				<Notice tone="warn" title="The gateway rejected this graph">
					{serverDetails.length}
					{serverDetails.length === 1 ? 'problem is' : 'problems are'} listed in Checks. Fix them,
					then save again.
				</Notice>
			{/if}

			<div
				class="work-surface"
				onfocusout={(event) => {
					// Leaving a field ends the typing burst, so the next edit is its own
					// undo step.
					if (!event.currentTarget.contains(event.relatedTarget as Node | null)) commitBurst();
				}}
			>
				{#if surface === 'map'}
					<div
						class="canvas-shell"
						role="group"
						aria-label="Flow canvas"
						class:has-drawer={showStepDrawer}
						bind:this={canvasEl}
						onpointermove={(event) => {
							// Where the pointer last was over the graph. Adding a step from
							// the toolbar needs to know, and the pointer leaves the canvas to
							// reach that button, so this is deliberately not cleared.
							pointerAt = { x: event.clientX, y: event.clientY };
						}}
					>
						<SvelteFlow
							bind:nodes
							bind:edges
							bind:viewport
							edgesFocusable={false}
							nodeTypes={NODE_TYPES}
							edgeTypes={EDGE_TYPES}
							minZoom={MIN_ZOOM}
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
							onmoveend={rememberViewport}
							onpaneclick={() => (settingsOpen = false)}
							onnodedragstop={() => {
								touch();
							}}
						>
							<FlowBridge
								fit={!savedViewport && !framedOnce && selectedNode === null}
								focusId={nodes.find((n) => n.type === 'trigger')?.id ?? null}
								minZoom={MIN_ZOOM}
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
									<Icon name="zap" size={16} /> Add trigger
								</button>
							</div>
						{/if}
					</div>
				{:else}
					<div class="steps-shell" class:is-empty={outline.length === 0}>
						{#if outline.length === 0}
							<div class="canvas-empty is-static">
								<span class="empty-mark"><Icon name="workflow" size={18} /></span>
								<h2>Start with a trigger</h2>
								<p>
									A flow begins when a message arrives. Add the trigger, then the steps that
									should run after it.
								</p>
								<button
									type="button"
									class="btn btn-primary btn-sm"
									onclick={() => addNode('trigger')}
								>
									<Icon name="zap" size={16} /> Add trigger
								</button>
							</div>
						{:else}
							<ul class="outline">
								{#each outline as item (item.key)}
									{#if item.kind === 'step'}
										<li
											class="outline-step"
											class:is-selected={item.node.id === selectedNode?.id}
											style="--depth: {item.depth}"
										>
											<div class="step-row-wrap">
												{#if item.repeated}
													<!-- The same step reached from another branch: a pointer to
													     where it is already listed, not a second copy of it. -->
													<button
														type="button"
														class="step-row is-ref"
														data-step-ref={item.node.id}
														onclick={() => selectOnly(item.node.id)}
														title="Already listed above; both paths end here"
													>
														<span class="step-index" aria-hidden="true">
															<Icon name="arrow-up-right" size={13} />
														</span>
														<span class="step-text">
															<strong>{metaFor(item.node.type).title}</strong>
															<small>already shown above</small>
														</span>
													</button>
												{:else}
												<button
													type="button"
													class="step-row"
													data-step-id={item.node.id}
													onclick={() => selectOnly(item.node.id)}
													aria-expanded={item.node.id === selectedNode?.id}
													title={nodeSummary(item.node)}
												>
													<span class="step-index mono">
														{item.number ?? '·'}
													</span>
													<span class="step-icon">
														<Icon name={metaFor(item.node.type).icon} size={16} />
													</span>
													<span class="step-text">
														<strong>{metaFor(item.node.type).title}</strong>
														<small>{nodeSummary(item.node)}</small>
													</span>
													{#if item.shared}
														<span
															class="step-tag"
															title="More than one connection reaches this step. The Map shows where they come from."
														>
															shared · see Map
														</span>
													{/if}
													{#if item.orphan}
														<span class="step-tag is-danger" title="The trigger cannot reach this step">
															not connected
														</span>
													{/if}
													{#if (issueCounts.get(item.node.id) ?? 0) > 0}
														<span
															class="step-issues"
															title={`${issueCounts.get(item.node.id)} to fix on this step`}
														>
															{issueCounts.get(item.node.id)}
														</span>
													{/if}
													<span class="step-open" aria-hidden="true">
														<Icon
															name={item.node.id === selectedNode?.id ? 'chevron-up' : 'chevron-down'}
															size={16}
														/>
													</span>
												</button>
												{/if}
											</div>

											{#if !item.repeated && item.node.id === selectedNode?.id}
												<div class="row-editor">
													<NodeInspector
														node={item.node}
														{nodes}
														{edges}
														{issues}
														layout="wide"
														onupdate={(patch) => updateNodeData(item.node.id, patch)}
														oncases={(op) => updateSwitchCases(item.node.id, op)}
														ondelete={() => {
															removeNode(item.node.id);
															selectOnly(null);
														}}
														onselect={selectOnly}
														onclose={() => selectOnly(null)}
													/>
												</div>
											{/if}
										</li>
									{:else}
										<li class="outline-branch" style="--depth: {item.depth}">
											<span class="branch-key {item.tone}">{item.label}</span>
											{#if item.detail}<span class="branch-detail mono">{item.detail}</span>{/if}
											<span class="branch-rule" aria-hidden="true"></span>
											{#if item.targetId}
												<span class="branch-target">{item.targetTitle}</span>
											{:else}
												<span class="branch-missing">Not connected</span>
											{/if}
										</li>
									{/if}
								{/each}
							</ul>
						{/if}
					</div>
				{/if}

				{#if settingsOpen || showStepDrawer}
					<aside class="step-drawer" aria-label="Step editor" bind:this={drawerEl}>
						{#if settingsOpen}
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
								onclose={() => (settingsOpen = false)}
							/>
						{:else if selectedNode}
							<NodeInspector
								node={selectedNode}
								{nodes}
								{edges}
								{issues}
								onupdate={(patch) => updateNodeData(selectedNode?.id ?? '', patch)}
								oncases={(op) => updateSwitchCases(selectedNode?.id ?? '', op)}
								ondelete={() => {
									if (selectedNode) removeNode(selectedNode.id);
									selectOnly(null);
								}}
								onselect={selectOnly}
								onclose={() => selectOnly(null)}
							/>
						{/if}
					</aside>
				{/if}

				{#if simulateOpen}
					<div class="preview-drawer">
						<SimulationPanel
							result={simResult}
							{nodes}
							seedSender={seed.sender}
							seedBody={seed.body}
							layout="drawer"
							onrun={runSimulation}
							onclose={togglePreview}
							onclear={clearSimulation}
						/>
					</div>
				{/if}
			</div>
		</div>
	{/if}
</div>

{#if sourceOpen}
	<SourceSheet
		open={sourceOpen}
		json={sourceJson}
		stepCount={nodeCount}
		onapply={applySource}
		onclose={() => (sourceOpen = false)}
	/>
{/if}

{#if finderOpen}
	<StepFinder
		open={finderOpen}
		{nodes}
		selectedId={selectedNode?.id ?? null}
		onpick={(nodeId) => {
			finderOpen = false;
			void reveal(nodeId, { focusField: true });
		}}
		onclose={() => (finderOpen = false)}
	/>
{/if}

<ConfirmDialog
	open={leavePrompt !== null}
	title="Leave without saving?"
	confirmLabel="Discard changes"
	onconfirm={() => void discardAndLeave()}
	oncancel={() => (leavePrompt = null)}
>
	<p>
		This flow has changes that are not saved. Leaving now discards them.
	</p>
</ConfirmDialog>

<style>
	.editor-page {
		min-width: 0;
	}

	/* ---------------------------------------------------------- header row */

	.undo-group {
		display: inline-flex;
		align-items: center;
		gap: 2px;
	}

	.checks-anchor,
	.menu-anchor,
	.add-anchor {
		position: relative;
		display: inline-flex;
	}

	.checks-button.has-issues {
		color: var(--df-state-danger-ink);
		border-color: color-mix(in srgb, var(--df-state-danger-ink) 36%, var(--df-border-hairline));
		background: color-mix(in srgb, var(--df-state-danger-bg) 55%, var(--df-surface-card));
	}

	.count {
		display: inline-grid;
		place-items: center;
		min-width: 18px;
		height: 18px;
		padding: 0 5px;
		border-radius: var(--df-p-radius-pill);
		background: var(--df-state-danger-fill);
		color: var(--df-text-on-danger);
		font-family: var(--df-p-font-mono);
		font-size: var(--df-p-text-2xs);
		font-weight: 700;
		line-height: 1;
	}

	.btn.is-active {
		background: var(--df-accent-soft);
		border-color: color-mix(in srgb, var(--df-accent-text) 32%, var(--df-border-hairline));
		color: var(--df-text-primary);
	}

	.menu {
		position: absolute;
		top: calc(100% + 6px);
		right: 0;
		z-index: 60;
		display: flex;
		flex-direction: column;
		min-width: 208px;
		padding: var(--df-p-space-1);
		border: 1px solid var(--df-border-control);
		border-radius: var(--df-p-radius-md);
		background: var(--df-surface-card);
		box-shadow: var(--df-shadow-dialog);
	}

	.menu-item {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-2);
		padding: 7px var(--df-p-space-2);
		border: 0;
		border-radius: var(--df-p-radius-xs);
		background: transparent;
		color: var(--df-text-primary);
		font-size: var(--df-p-text-base);
		text-align: left;
	}

	.menu-item:hover {
		background: var(--df-surface-well);
	}

	.menu-item :global(svg) {
		color: var(--df-text-meta);
	}

	.menu-note {
		margin-left: auto;
		font-size: 9.5px;
		color: var(--df-text-meta);
	}

	/* ----------------------------------------------------------- work panel */

	.work-panel {
		display: flex;
		flex-direction: column;
		gap: var(--df-p-space-2);
		min-width: 0;
	}

	.work-bar {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-2);
		flex-wrap: wrap;
		min-width: 0;
		padding: 6px var(--df-p-space-2);
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-md);
		background: var(--df-surface-card);
	}

	.work-bar .spacer {
		flex: 1;
	}

	.surface-switch {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		padding: 2px;
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-sm);
		background: var(--df-surface-well);
	}

	.surface-btn {
		padding: 4px 12px;
		border: 0;
		border-radius: var(--df-p-radius-xs);
		background: transparent;
		color: var(--df-text-meta);
		font-size: var(--df-p-text-sm);
		font-weight: 500;
	}

	.surface-btn:hover {
		color: var(--df-text-primary);
	}

	.surface-btn.is-active {
		background: var(--df-surface-card);
		color: var(--df-text-primary);
		font-weight: 600;
		box-shadow: var(--df-shadow-card);
	}

	.find-button {
		color: var(--df-text-secondary);
	}

	.work-surface {
		position: relative;
		min-width: 0;
	}

	/* --------------------------------------------------------------- canvas */

	.canvas-shell {
		position: relative;
		height: clamp(520px, calc(100vh - 300px), 900px);
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

	/* The step editor covers the right edge; the minimap would be behind it. */
	.canvas-shell.has-drawer :global(.svelte-flow__minimap) {
		opacity: 0;
		pointer-events: none;
	}

	.canvas-shell :global(.svelte-flow__minimap) {
		transition: opacity 140ms ease;
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

	.canvas-empty.is-static {
		position: static;
		inset: auto;
		background: transparent;
	}

	.canvas-empty .empty-mark {
		margin-bottom: 2px;
	}

	.canvas-empty h2 {
		font-size: var(--df-p-text-lg);
	}

	.canvas-empty p {
		max-width: 40ch;
		font-size: var(--df-p-text-base);
		line-height: 1.5;
		color: var(--df-text-meta);
	}

	.canvas-empty .btn {
		pointer-events: auto;
		margin-top: var(--df-p-space-2);
	}

	/* ---------------------------------------------------------------- steps */

	/* The outline scrolls in place, like the canvas: a forty-step flow must not
	   turn the page into a two-and-a-half-thousand-pixel ribbon, or the surface
	   switch and the add button scroll away from the work. */
	.steps-shell {
		height: clamp(420px, calc(100vh - 300px), 900px);
		overflow-y: auto;
		overscroll-behavior: contain;
		scroll-padding-block: var(--df-p-space-3);
		padding: var(--df-p-space-2);
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-lg);
		background: var(--df-surface-card);
	}

	.steps-shell.is-empty {
		height: auto;
		min-height: 300px;
		overflow: visible;
	}

	.outline {
		display: flex;
		flex-direction: column;
		gap: 3px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.outline-step,
	.outline-branch {
		margin-left: calc(var(--depth, 0) * 20px);
		min-width: 0;
	}

	.outline-branch {
		display: flex;
		align-items: center;
		gap: 7px;
		padding: 3px var(--df-p-space-2) 3px var(--df-p-space-3);
		color: var(--df-text-meta);
	}

	.step-row {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-2);
		width: 100%;
		min-width: 0;
		padding: 8px var(--df-p-space-2);
		border: 1px solid transparent;
		border-radius: var(--df-p-radius-sm);
		background: transparent;
		color: var(--df-text-primary);
		text-align: left;
		transition:
			background-color 130ms ease,
			border-color 130ms ease;
	}

	.step-row:hover {
		background: var(--df-surface-well);
	}

	.step-row:focus-visible {
		outline: 2px solid var(--df-accent-text);
		outline-offset: -2px;
	}

	.step-row.is-ref {
		color: var(--df-text-meta);
	}

	.step-row.is-ref .step-text strong {
		font-weight: 500;
	}

	.step-row.is-ref .step-index {
		font-size: 12px;
		color: var(--df-text-meta);
	}

	.outline-step.is-selected > .step-row-wrap > .step-row {
		border-color: var(--df-border-control);
		background: var(--df-surface-well);
	}

	.step-index {
		display: grid;
		place-items: center;
		width: 22px;
		height: 22px;
		flex: none;
		border-radius: var(--df-p-radius-xs);
		background: var(--df-surface-well);
		font-size: var(--df-p-text-2xs);
		color: var(--df-text-meta);
	}

	.step-icon {
		display: grid;
		place-items: center;
		width: 26px;
		height: 26px;
		flex: none;
		border-radius: var(--df-p-radius-sm);
		background: var(--df-surface-well);
		color: var(--df-text-secondary);
	}

	.step-text {
		display: flex;
		flex-direction: column;
		gap: 1px;
		min-width: 0;
		flex: 1;
	}

	.step-text strong {
		font-size: var(--df-p-text-base);
		font-weight: 600;
		line-height: 1.3;
	}

	.step-text small {
		font-size: var(--df-p-text-xs);
		line-height: 1.4;
		color: var(--df-text-meta);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.step-tag {
		flex: none;
		padding: 1px 7px;
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-pill);
		background: var(--df-surface-card);
		font-family: var(--df-p-font-mono);
		font-size: 9.5px;
		letter-spacing: 0.02em;
		color: var(--df-text-meta);
		white-space: nowrap;
	}

	.step-tag.is-danger {
		border-color: color-mix(in srgb, var(--df-state-danger-ink) 32%, var(--df-border-hairline));
		color: var(--df-state-danger-ink);
	}

	.step-issues {
		display: grid;
		place-items: center;
		min-width: 18px;
		height: 18px;
		padding: 0 5px;
		flex: none;
		border-radius: var(--df-p-radius-pill);
		background: var(--df-state-danger-bg);
		color: var(--df-state-danger-ink);
		font-family: var(--df-p-font-mono);
		font-size: var(--df-p-text-2xs);
		font-weight: 700;
	}

	.step-open {
		display: grid;
		place-items: center;
		width: 20px;
		height: 20px;
		flex: none;
		color: var(--df-text-meta);
	}

	.outline-branch .branch-key {
		display: inline-flex;
		align-items: center;
		height: 18px;
		padding: 0 6px;
		border: 1px solid var(--df-border-control);
		border-radius: 3px;
		font-family: var(--df-p-font-mono);
		font-size: 9px;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		background: var(--df-surface-card);
	}

	.branch-key.true {
		color: var(--df-state-ok-ink);
		border-color: color-mix(in srgb, var(--df-state-ok-ink) 36%, var(--df-border-hairline));
	}

	.branch-key.false,
	.branch-key.default {
		color: var(--df-text-meta);
	}

	.branch-key.case {
		color: var(--df-state-warn-ink);
		border-color: color-mix(in srgb, var(--df-state-warn-ink) 34%, var(--df-border-hairline));
		text-transform: none;
		letter-spacing: 0;
	}

	.branch-detail {
		max-width: 18ch;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 10px;
		color: var(--df-text-secondary);
	}

	.branch-rule {
		flex: 1;
		height: 1px;
		max-width: 40px;
		background: repeating-linear-gradient(
			to right,
			var(--df-border-control) 0 3px,
			transparent 3px 6px
		);
		opacity: 0.8;
	}

	.branch-target {
		font-size: var(--df-p-text-xs);
		color: var(--df-text-secondary);
		white-space: nowrap;
	}

	.branch-missing {
		font-size: var(--df-p-text-xs);
		color: var(--df-state-danger-ink);
	}

	/* The row that expands in place: the same fields the drawer shows, wide. */
	.row-editor {
		margin: 4px 0 var(--df-p-space-2);
		padding-left: 46px;
	}

	.row-editor :global(.inspector) {
		border-radius: var(--df-p-radius-md);
	}

	/* --------------------------------------------------------------- drawers */

	.step-drawer {
		position: absolute;
		top: var(--df-p-space-3);
		right: var(--df-p-space-3);
		bottom: var(--df-p-space-3);
		z-index: 8;
		width: min(420px, calc(100% - 24px));
		overflow-y: auto;
		overscroll-behavior: contain;
		border-radius: var(--df-p-radius-lg);
		box-shadow: var(--df-shadow-dialog);
		background: var(--df-surface-card);
	}

	.step-drawer :global(.panel) {
		border-radius: var(--df-p-radius-lg);
		box-shadow: none;
	}

	.preview-drawer {
		position: absolute;
		left: var(--df-p-space-3);
		right: var(--df-p-space-3);
		bottom: var(--df-p-space-3);
		z-index: 9;
		max-height: min(62%, 460px);
		display: flex;
	}

	.preview-drawer :global(.simulation) {
		flex: 1;
		min-width: 0;
	}

	/* ------------------------------------------------------------ switch */

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
		width: 34px;
		height: 20px;
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
		width: 14px;
		height: 14px;
		border-radius: 50%;
		background: var(--df-text-meta);
		transition:
			transform 140ms ease,
			background-color 140ms ease;
	}

	.switch input:checked + .switch-track {
		background: var(--df-accent-fill);
		border-color: var(--df-accent-fill);
	}

	.switch input:checked + .switch-track > span {
		transform: translateX(14px);
		background: var(--df-text-on-accent, #fff);
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

	/* --------------------------------------------------------- mobile block */

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

	.loading-grid {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 320px);
		gap: var(--df-p-space-3);
		padding: var(--df-p-space-4);
	}

	@media (max-width: 1080px) {
		.step-drawer {
			width: min(400px, calc(100% - 24px));
		}
	}

	@media (max-width: 900px) {
		.loading-grid {
			grid-template-columns: minmax(0, 1fr);
		}

		.preview-drawer {
			max-height: min(74%, 520px);
		}
	}

	@media (max-width: 720px) {
		.mobile-defer {
			display: block;
		}

		.work-panel {
			display: none;
		}

		.step-drawer {
			position: static;
			width: auto;
			box-shadow: none;
			background: transparent;
		}
	}

	@media (max-width: 620px) {
		.step-tag {
			display: none;
		}

		.switch-label {
			display: none;
		}

		.row-editor {
			padding-left: 0;
		}

		.step-text small {
			white-space: normal;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.canvas-shell,
		.switch-track,
		.switch-track > span,
		.step-row,
		.canvas-shell :global(.svelte-flow__minimap) {
			transition: none;
		}
	}
</style>
