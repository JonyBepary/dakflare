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
	import ExtractNode from '$lib/components/workflow/ExtractNode.svelte';
	import FlowEdgeComponent from '$lib/components/workflow/FlowEdge.svelte';
	import SendSmsNode from '$lib/components/workflow/SendSmsNode.svelte';
	import StopNode from '$lib/components/workflow/StopNode.svelte';
	import TriggerNode from '$lib/components/workflow/TriggerNode.svelte';

	import { ApiError, describeError, getWorkflow, readWorkflowIssues, saveWorkflow } from '$lib/api';
	import { ROUTES } from '$lib/paths';
	import type { WorkflowNodeType } from '$lib/types';
	import { WORKFLOW_UI, type WorkflowCanvasUi } from '$lib/workflow/context';
	import {
		NODE_LIMIT,
		NODE_META,
		RE_DEVICE_ID,
		createDraft,
		createEdge,
		createNode,
		createWorkflowId,
		fromGraph,
		mapServerIssues,
		nodeSummary,
		toGraph,
		validateWorkflow,
		type EditorIssue,
		type FlowEdge,
		type FlowNode
	} from '$lib/workflow/graph';
	import { simulate, type SimulationInput, type SimulationResult } from '$lib/workflow/simulate';
	import { setContext } from 'svelte';

	let { id }: { id: string } = $props();

	const NODE_TYPES: NodeTypes = {
		trigger: TriggerNode,
		extract: ExtractNode,
		condition: ConditionNode,
		send_sms: SendSmsNode,
		stop: StopNode
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
			workflowId = workflow.id;
			version = workflow.version;
			createdAt = workflow.created_at;
			updatedAt = workflow.updated_at;
			hasSaved = true;
			touched = false;
			serverDetails = [];
			saveError = null;
			baseline = signature();
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
	}

	function updateNodeData(nodeId: string, patch: Record<string, unknown>) {
		nodes = nodes.map((node) =>
			node.id === nodeId ? { ...node, data: { ...node.data, ...patch } } : node
		);
		if (simResult) clearSimulation();
		touch();
	}

	function updateSettings(patch: { name?: string; enabled?: boolean; deviceId?: string }) {
		if (patch.name !== undefined) name = patch.name;
		if (patch.enabled !== undefined) enabled = patch.enabled;
		if (patch.deviceId !== undefined) deviceId = patch.deviceId;
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
		const node = createNode(type, canvasCentre(), nodes);
		node.selected = true;
		nodes = [...nodes.map((item) => ({ ...item, selected: false })), node];
		simResult = null;
		simNodeIds = new Set();
		simEdgeIds = new Set();
		touch();
		announce = `Added a ${type === 'send_sms' ? 'Send SMS' : type} step.`;
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

		if (source.type === 'condition') {
			if (connection.sourceHandle !== 'true' && connection.sourceHandle !== 'false') return false;
			if (
				edges.some(
					(edge) =>
						edge.source === source.id && edge.sourceHandle === connection.sourceHandle
				)
			) {
				return false;
			}
		} else {
			if (connection.sourceHandle !== null && connection.sourceHandle !== undefined) return false;
			if (edges.some((edge) => edge.source === source.id)) return false;
		}

		return !reaches(target.id, source.id);
	}

	function beforeConnect(connection: Connection): FlowEdge | false {
		if (!isValidConnection(connection)) return false;
		const source = nodes.find((node) => node.id === connection.source);
		const handle =
			source?.type === 'condition'
				? (connection.sourceHandle as 'true' | 'false')
				: undefined;
		const edge = createEdge(connection.source, connection.target, handle, edges);
		edge.type = 'smoothstep';
		return edge;
	}

	function afterConnect(connection: Connection) {
		const source = nodes.find((node) => node.id === connection.source);
		const handle =
			source?.type === 'condition'
				? (connection.sourceHandle as 'true' | 'false')
				: undefined;
		if (simResult) clearSimulation();
		touch();
		announce = handle ? `Connected the ${handle} branch.` : 'Steps connected.';
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
				graph: toGraph(nodes, edges)
			});
			workflowId = saved.id;
			name = saved.name;
			enabled = saved.enabled;
			deviceId = saved.device_id ?? '';
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

	function runSimulation(input: SimulationInput) {
		const result = simulate(nodes, edges, input);
		simResult = result;
		simNodeIds = new Set(result.visitedNodes);
		simEdgeIds = new Set(result.visitedEdges);
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

<p class="sr-only" role="status" aria-live="polite">{announce}</p>

<div class="page editor-page">
	<PageHeader eyebrow="Automation" title={pageTitle} description={pageDescription}>
		{#if !loading && !notFound && !loadError}
			<span class="head-extras">
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
						ondelete={() => selectedNode && removeNode(selectedNode.id)}
						onselect={selectOnly}
					/>
				{:else}
					<WorkflowSettings
						{name}
						{enabled}
						{deviceId}
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
</style>
