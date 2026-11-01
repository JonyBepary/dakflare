/**
 * The workflow graph as the dashboard edits it.
 *
 * The API contract is deliberately narrower than what Svelte Flow wants: the
 * canvas decorates nodes with `selected`, `measured`, `width`, … and the editor
 * needs typed node data. Everything in this module translates between the two
 * and answers the questions the UI asks repeatedly — what does this node *say*,
 * which template names exist, and is the current draft storable?
 *
 * Client validation mirrors worker/src/lib/workflow.ts on purpose. It is not a
 * security boundary (the Worker validates again); it is what keeps Save disabled
 * until the graph is something the Worker will accept.
 */

import type { Edge, Node } from '@xyflow/svelte';
import type { IconName } from '$lib/components/Icon.svelte';
import type {
	ConditionData,
	DelayData,
	ExtractData,
	SendSmsData,
	SetVarData,
	StopData,
	SwitchData,
	TriggerData,
	WebhookData,
	WorkflowEdge,
	WorkflowGraph,
	WorkflowIssue,
	WorkflowNodeType,
	WorkflowUiLayout
} from '$lib/types';

/**
 * A card on the canvas. `unsupported` is not a kind of step: it is the shape the
 * editor gives a node whose `type` it does not know, so the node and its data
 * survive a load and can be handed back on save.
 */
export type CanvasNodeType = WorkflowNodeType | 'unsupported';

export type FlowNode = Node<Record<string, unknown>, CanvasNodeType> & {
	/** The original `type` string of an unsupported node, kept for a round trip. */
	unsupportedType?: string;
};
export type FlowEdge = Edge<Record<string, unknown>, 'smoothstep'>;

/** The nine kinds, in the order the palette shows them (the Worker's order). */
export const NODE_TYPES: WorkflowNodeType[] = [
	'trigger',
	'extract',
	'set_var',
	'condition',
	'switch',
	'delay',
	'webhook',
	'send_sms',
	'stop'
];

export const NODE_META: Record<
	CanvasNodeType,
	{ title: string; icon: IconName; blurb: string }
> = {
	trigger: {
		title: 'Trigger',
		icon: 'zap',
		blurb: 'When a message arrives'
	},
	extract: {
		title: 'Extract',
		icon: 'braces',
		blurb: 'Pull data out with a pattern'
	},
	set_var: {
		title: 'Set variable',
		icon: 'key',
		blurb: 'Name a value for later steps'
	},
	condition: {
		title: 'Condition',
		icon: 'branch',
		blurb: 'Branch on a value'
	},
	switch: {
		title: 'Switch',
		icon: 'workflow',
		blurb: 'One branch per case'
	},
	delay: {
		title: 'Delay',
		icon: 'clock',
		blurb: 'Wait before the next step'
	},
	webhook: {
		title: 'Webhook',
		icon: 'external',
		blurb: 'POST to an https address'
	},
	send_sms: {
		title: 'Send SMS',
		icon: 'send',
		blurb: 'Reply with a template'
	},
	stop: {
		title: 'Stop',
		icon: 'stop',
		blurb: 'End this flow here'
	},
	unsupported: {
		title: 'Unsupported step',
		icon: 'alert',
		blurb: 'From a newer build of the console'
	}
};

/** What a card can be told without the editor knowing the component. */
export function metaFor(type: CanvasNodeType | string): (typeof NODE_META)[CanvasNodeType] {
	const table = NODE_META as Record<string, (typeof NODE_META)[CanvasNodeType]>;
	return table[type] ?? NODE_META.unsupported;
}

export function isWorkflowNodeType(value: unknown): value is WorkflowNodeType {
	return typeof value === 'string' && (NODE_TYPES as string[]).includes(value);
}

/**
 * The same ceilings as `worker/src/lib/flow-ir.ts` (`MAX_NODES`, `MAX_EDGES`).
 *
 * They were 50 and 100 here, which meant an agent could `flows apply` a 60-node
 * document the API accepted and then find Save disabled in the editor. One
 * number, enforced by the side that stores it, mirrored here so the canvas never
 * refuses a graph the Worker would take.
 */
export const NODE_LIMIT = 200;
export const EDGE_LIMIT = 400;
export const NAME_LIMIT = 120;
export const SMS_TO_LIMIT = 32;
export const SMS_BODY_LIMIT = 4096;
export const MAX_CASES = 8;
export const MAX_TEMPLATE_CHARS = 2048;
export const MIN_DELAY_SECONDS = 1;
export const MAX_DELAY_SECONDS = 300;

const BUILTIN_VARIABLES = ['sender', 'body', 'received_at'] as const;
const RESERVED_GROUPS = new Set<string>(BUILTIN_VARIABLES);
const RE_WORKFLOW_ID = /^[A-Za-z0-9_-]{1,64}$/;
const RE_GROUP_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
export const RE_DEVICE_ID = /^[A-Za-z0-9_-]{8,64}$/;

/* ------------------------------------------------------------------ ids */

function randomId(length = 10): string {
	const bytes = new Uint8Array(Math.ceil(length / 2));
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, length);
}

export function createWorkflowId(): string {
	return `wf_${randomId(12)}`;
}

export function createNodeId(existing: Iterable<string> = []): string {
	const taken = new Set(existing);
	for (;;) {
		const id = `n_${randomId(10)}`;
		if (!taken.has(id)) return id;
	}
}

function createEdgeId(existing: Iterable<string> = []): string {
	const taken = new Set(existing);
	for (;;) {
		const id = `e_${randomId(10)}`;
		if (!taken.has(id)) return id;
	}
}

/* -------------------------------------------------------------- defaults */

export function defaultData(type: WorkflowNodeType): Record<string, unknown> {
	switch (type) {
		case 'trigger':
			return { kind: 'incoming', sender: { mode: 'any' }, body: { mode: 'any' } };
		case 'extract':
			return { source: 'body', pattern: '', flags: '' };
		case 'set_var':
			return { name: '', value: '' };
		case 'condition':
			return { left: '', op: 'equals', right: '' };
		case 'switch':
			return { value: '{{body}}', cases: [''] };
		case 'delay':
			return { seconds: 30 };
		case 'webhook':
			return { url: '', body: '' };
		case 'send_sms':
			return { to: '{{sender}}', body: '' };
		case 'stop':
			return { reason: '' };
	}
}

export function createNode(
	type: WorkflowNodeType,
	position: { x: number; y: number },
	nodes: readonly FlowNode[] = []
): FlowNode {
	return {
		id: createNodeId(nodes.map((node) => node.id)),
		type,
		position: { x: Math.round(position.x), y: Math.round(position.y) },
		data: defaultData(type)
	};
}

/** A fresh draft: one trigger, positioned where the eye lands first. */
export function createDraft(): { nodes: FlowNode[]; edges: FlowEdge[] } {
	return {
		nodes: [createNode('trigger', { x: 40, y: 120 })],
		edges: []
	};
}

/* ------------------------------------------------------- contract ⇄ canvas */

function cleanData(data: Record<string, unknown>): Record<string, unknown> {
	try {
		return JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
	} catch {
		return {};
	}
}

/** Strip everything Svelte Flow adds so the payload is exactly the contract. */
export function toGraph(nodes: readonly FlowNode[], edges: readonly FlowEdge[]): WorkflowGraph {
	const workflowNodes = nodes.map((node) => ({
		id: node.id,
		// An unsupported card puts its original kind back, so saving a graph the
		// console only half understands does not rewrite it.
		type: node.type === 'unsupported' ? (node.unsupportedType ?? 'unsupported') : node.type,
		position: {
			x: Math.round(node.position.x * 100) / 100,
			y: Math.round(node.position.y * 100) / 100
		},
		data: cleanData(node.data)
	}));

	const workflowEdges: WorkflowEdge[] = edges.map((edge) => {
		const next: WorkflowEdge = {
			id: edge.id,
			source: edge.source,
			target: edge.target
		};
		if (typeof edge.sourceHandle === 'string' && edge.sourceHandle.length > 0) {
			next.sourceHandle = edge.sourceHandle;
		}
		if (typeof edge.label === 'string' && edge.label.length > 0) next.label = edge.label;
		return next;
	});

	return { nodes: workflowNodes, edges: workflowEdges };
}

function finite(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
}

function positionOf(value: unknown): { x: number; y: number } | null {
	if (!value || typeof value !== 'object') return null;
	const point = value as { x?: unknown; y?: unknown };
	const x = finite(point.x);
	const y = finite(point.y);
	return x === null || y === null ? null : { x, y };
}

function layoutOf(value: unknown): Record<string, { x: number; y: number }> {
	if (!value || typeof value !== 'object') return {};
	const positions = (value as WorkflowUiLayout).positions;
	if (!positions || typeof positions !== 'object') return {};
	const out: Record<string, { x: number; y: number }> = {};
	for (const [id, point] of Object.entries(positions)) {
		const placed = positionOf(point);
		if (placed) out[id] = placed;
	}
	return out;
}

/**
 * Last resort for a node the layout does not mention, which only happens when a
 * document reaches the console without a Worker pass. Nothing lands on 0,0: a
 * stack of cards on one spot cannot be untangled by hand.
 */
function loosePosition(index: number): { x: number; y: number } {
	return { x: 40 + (index % 4) * 280, y: 120 + Math.floor(index / 4) * 160 };
}

export function fromGraph(graph: WorkflowGraph | null | undefined): {
	nodes: FlowNode[];
	edges: FlowEdge[];
} {
	const rawNodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
	const rawEdges = Array.isArray(graph?.edges) ? graph.edges : [];
	const layout = layoutOf(graph?.ui_layout);

	const nodes: FlowNode[] = [];
	rawNodes.forEach((node, index) => {
		if (!node || typeof node.id !== 'string') return;
		const kind = isWorkflowNodeType(node.type) ? node.type : null;
		// A node's own position is the operator's arrangement and wins. Only a node
		// without one falls back to the Worker's layout.
		const position = positionOf(node.position) ?? layout[node.id] ?? loosePosition(index);
		nodes.push({
			id: node.id,
			type: kind ?? 'unsupported',
			...(kind === null
				? { unsupportedType: typeof node.type === 'string' ? node.type : '' }
				: {}),
			position,
			data:
				node.data && typeof node.data === 'object' && !Array.isArray(node.data)
					? ({ ...node.data } as Record<string, unknown>)
					: {}
		});
	});

	const known = new Set(nodes.map((node) => node.id));
	const edges: FlowEdge[] = rawEdges
		.filter(
			(edge) =>
				edge &&
				typeof edge.id === 'string' &&
				known.has(edge.source) &&
				known.has(edge.target)
		)
		.map((edge) => {
			const next: FlowEdge = {
				id: edge.id,
				source: edge.source,
				target: edge.target,
				type: 'smoothstep'
			};
			if (typeof edge.sourceHandle === 'string' && edge.sourceHandle.length > 0) {
				next.sourceHandle = edge.sourceHandle;
			}
			if (typeof edge.label === 'string') next.label = edge.label;
			return next;
		});

	return { nodes, edges };
}

export function createEdge(
	source: string,
	target: string,
	sourceHandle: string | undefined,
	edges: readonly FlowEdge[]
): FlowEdge {
	const edge: FlowEdge = {
		id: createEdgeId(edges.map((item) => item.id)),
		source,
		target,
		type: 'smoothstep'
	};
	if (sourceHandle) edge.sourceHandle = sourceHandle;
	return edge;
}

/* -------------------------------------------------------------- summaries */

export function nodeData<T>(node: FlowNode): T {
	return node.data as unknown as T;
}

export function triggerSummary(data: TriggerData): string {
	const sender = data.sender ?? { mode: 'any' as const };
	const body = data.body ?? { mode: 'any' as const };
	const senderText =
		sender.mode === 'any'
			? 'Any sender'
			: sender.mode === 'regex'
				? `Sender /${sender.value ?? ''}/`
				: sender.mode === 'prefix'
					? `Sender starts ${sender.value ?? ''}`
					: `Sender is ${sender.value ?? ''}`;
	const bodyText =
		body.mode === 'any'
			? 'any body'
			: body.mode === 'regex'
				? `body /${body.value ?? ''}/`
				: `body contains “${body.value ?? ''}”`;
	return `${senderText} · ${bodyText}`;
}

export function extractSummary(data: ExtractData): string {
	const pattern = data.pattern.trim();
	const fields = extractGroupNames(pattern).length;
	const fieldText = `${fields} ${fields === 1 ? 'field' : 'fields'}`;
	if (!pattern) return `${data.source} · no pattern yet`;
	return `${data.source} · ${fieldText}`;
}

const OP_LABEL: Record<ConditionData['op'], string> = {
	equals: 'equals',
	not_equals: 'is not',
	contains: 'contains',
	matches: 'matches',
	exists: 'exists'
};

export function conditionSummary(data: ConditionData): string {
	if (!data.left.trim()) return 'No value chosen yet';
	if (data.op === 'exists') return `${data.left} exists`;
	return `${data.left || 'value'} ${OP_LABEL[data.op]} ${data.right ?? ''}`.trim();
}

export function sendSummary(data: SendSmsData): string {
	if (!data.body.trim()) return `to ${data.to || 'nobody'} · no message yet`;
	const preview = data.body.replace(/\s+/g, ' ').trim();
	return `to ${data.to || 'nobody'} · “${preview.length > 34 ? `${preview.slice(0, 34)}…` : preview}”`;
}

export function stopSummary(data: StopData): string {
	return data.reason?.trim() ? data.reason.trim() : 'Flow ends here';
}

export function setVarSummary(data: SetVarData): string {
	const name = data.name?.trim();
	const value = data.value?.replace(/\s+/g, ' ').trim();
	if (!name) return 'No variable name yet';
	if (!value) return `${name} · no value yet`;
	return `${name} = ${value.length > 30 ? `${value.slice(0, 30)}…` : value}`;
}

export function switchSummary(data: SwitchData): string {
	const cases = Array.isArray(data.cases) ? data.cases : [];
	const filled = cases.filter((value) => value.trim().length > 0);
	if (!data.value?.trim()) return 'No value chosen yet';
	if (filled.length === 0) return `${data.value} · no cases yet`;
	return `${data.value} · ${filled.length} ${filled.length === 1 ? 'case' : 'cases'} + default`;
}

export function delaySummary(data: DelayData): string {
	const seconds = Number(data.seconds);
	if (!Number.isFinite(seconds)) return 'No wait set yet';
	if (seconds === 1) return 'Wait 1 second';
	if (seconds < 60) return `Wait ${seconds} seconds`;
	if (seconds % 60 === 0) return `Wait ${seconds / 60} ${seconds === 60 ? 'minute' : 'minutes'}`;
	const minutes = Math.floor(seconds / 60);
	const rest = seconds % 60;
	return `Wait ${minutes}m ${rest}s`;
}

export function webhookSummary(data: WebhookData): string {
	const url = data.url?.trim();
	if (!url) return 'No address yet';
	const short = url.replace(/^https?:\/\//, '');
	return `POST ${short.length > 34 ? `${short.slice(0, 34)}…` : short}`;
}

/** The branch handle a case uses. Positional on purpose: the IR numbers cases. */
export function caseHandle(index: number): string {
	return `case:${index}`;
}

export const DEFAULT_HANDLE = 'default';

export function nodeSummary(node: FlowNode): string {
	switch (node.type) {
		case 'trigger':
			return triggerSummary(nodeData<TriggerData>(node));
		case 'extract':
			return extractSummary(nodeData<ExtractData>(node));
		case 'set_var':
			return setVarSummary(nodeData<SetVarData>(node));
		case 'condition':
			return conditionSummary(nodeData<ConditionData>(node));
		case 'switch':
			return switchSummary(nodeData<SwitchData>(node));
		case 'delay':
			return delaySummary(nodeData<DelayData>(node));
		case 'webhook':
			return webhookSummary(nodeData<WebhookData>(node));
		case 'send_sms':
			return sendSummary(nodeData<SendSmsData>(node));
		case 'stop':
			return stopSummary(nodeData<StopData>(node));
		case 'unsupported':
			return node.unsupportedType
				? `${node.unsupportedType} · kept as it is`
				: 'Kept as it is';
	}
}

/* ---------------------------------------------------------- template names */

/**
 * Named capture groups declared by a pattern. Hand-written so an inert `\(?<x>`
 * or a bracket class never looks like a capture — the same scan the Worker does,
 * so hints and server errors agree.
 */
export function extractGroupNames(pattern: string): string[] {
	const names: string[] = [];
	let i = 0;
	while (i < pattern.length) {
		const ch = pattern[i];
		if (ch === '\\') {
			i += 2;
			continue;
		}
		if (ch === '[') {
			let j = i + 1;
			if (pattern[j] === '^') j++;
			if (pattern[j] === ']') j++;
			while (j < pattern.length) {
				if (pattern[j] === '\\') {
					j += 2;
					continue;
				}
				if (pattern[j] === ']') {
					j++;
					break;
				}
				j++;
			}
			i = j;
			continue;
		}
		if (ch === '(' && pattern[i + 1] === '?') {
			let p = i + 2;
			if (pattern[p] === 'P') p++;
			if (pattern[p] === '<' && pattern[p + 1] !== '=' && pattern[p + 1] !== '!') {
				p++;
				const start = p;
				while (p < pattern.length && pattern[p] !== '>') p++;
				if (pattern[p] === '>') names.push(pattern.slice(start, p));
			}
		}
		i++;
	}
	return names;
}

/** Names a node binds for the rest of the path: extract groups and set_var names. */
export function boundNamesOf(node: FlowNode): string[] {
	if (node.type === 'extract') {
		return extractGroupNames(nodeData<ExtractData>(node).pattern ?? '');
	}
	if (node.type === 'set_var') {
		const name = nodeData<SetVarData>(node).name ?? '';
		return RE_GROUP_NAME.test(name) && !RESERVED_GROUPS.has(name) ? [name] : [];
	}
	return [];
}

/** Every template name the flow can resolve right now, built-ins first. */
export function templateVariables(nodes: readonly FlowNode[]): string[] {
	const names = new Set<string>(BUILTIN_VARIABLES);
	for (const node of nodes) {
		for (const name of boundNamesOf(node)) names.add(name);
	}
	return [...names];
}

export interface RegexCheck {
	valid: boolean;
	error: string | null;
	groups: string[];
}

export function checkRegex(pattern: string, flags = ''): RegexCheck {
	if (!pattern) return { valid: false, error: 'Pattern is empty.', groups: [] };
	let compiled: RegExp;
	try {
		compiled = new RegExp(pattern, flags);
	} catch (error) {
		return {
			valid: false,
			error: error instanceof Error ? error.message : 'Pattern is not valid JavaScript regex.',
			groups: []
		};
	}
	return {
		valid: true,
		error: null,
		groups: (compiled as RegExp & { groups?: Record<string, string> }).groups
			? Object.keys((compiled as RegExp & { groups?: Record<string, string> }).groups ?? {})
			: extractGroupNames(pattern)
	};
}

/** `{{vars.name}}` is the same variable as `{{name}}`; the Worker strips the alias. */
export function normalizeTemplateName(name: string): string {
	return name.startsWith('vars.') ? name.slice(5) : name;
}

export function templateNames(value: string): { names: string[]; unterminated: boolean } {
	const names: string[] = [];
	let from = 0;
	for (;;) {
		const open = value.indexOf('{{', from);
		if (open === -1) return { names, unterminated: false };
		const close = value.indexOf('}}', open + 2);
		if (close === -1) return { names, unterminated: true };
		names.push(normalizeTemplateName(value.slice(open + 2, close).trim()));
		from = close + 2;
	}
}

/* --------------------------------------------------------------- validation */

export interface EditorIssue extends WorkflowIssue {
	kind: 'structure' | 'field';
	nodeId?: string;
	edgeId?: string;
}

function indexIssues(
	issues: WorkflowIssue[],
	nodes: readonly FlowNode[],
	edges: readonly FlowEdge[],
	kind: EditorIssue['kind'] = 'field'
): EditorIssue[] {
	return issues.map((issue) => {
		const nodeMatch = /^nodes\[(\d+)\]/.exec(issue.path);
		const edgeMatch = /^edges\[(\d+)\]/.exec(issue.path);
		const edge = edgeMatch ? edges[Number(edgeMatch[1])] : undefined;
		return {
			...issue,
			kind,
			nodeId: nodeMatch ? nodes[Number(nodeMatch[1])]?.id : edge?.source,
			edgeId: edge?.id
		};
	});
}

/**
 * Structural problems the canvas can see without looking at field values:
 * one trigger, legal out-degrees, legal handles, no loops, everything reachable.
 */
export function structuralIssues(
	nodes: readonly FlowNode[],
	edges: readonly FlowEdge[]
): EditorIssue[] {
	const issues: WorkflowIssue[] = [];
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const outgoing = new Map<string, FlowEdge[]>();
	const incoming = new Map<string, FlowEdge[]>();
	const knownEdges = edges.filter(
		(edge) => byId.has(edge.source) && byId.has(edge.target) && edge.source !== edge.target
	);

	for (const edge of knownEdges) {
		const out = outgoing.get(edge.source);
		if (out) out.push(edge);
		else outgoing.set(edge.source, [edge]);
		const inc = incoming.get(edge.target);
		if (inc) inc.push(edge);
		else incoming.set(edge.target, [edge]);
	}

	const triggers = nodes.filter((node) => node.type === 'trigger');
	if (triggers.length !== 1) {
		issues.push({
			path: 'nodes',
			message:
				triggers.length === 0
					? 'The flow needs exactly one trigger. Add one from the palette.'
					: `The flow can only have one trigger (found ${triggers.length}).`
		});
	}

	nodes.forEach((node, index) => {
		const outs = outgoing.get(node.id) ?? [];
		const ins = incoming.get(node.id) ?? [];
		const path = `nodes[${index}]`;

		if (node.type === 'trigger') {
			for (const edge of ins) {
				issues.push({
					path,
					message: 'The trigger cannot have incoming connections.'
				});
			}
			if (outs.length !== 1) {
				issues.push({
					path,
					message: `The trigger needs exactly one outgoing connection (found ${outs.length}).`
				});
			}
			return;
		}

		if (node.type === 'stop') {
			if (outs.length > 0) {
				issues.push({ path, message: 'Stop is the end of a flow and cannot connect onwards.' });
			}
			return;
		}

		if (node.type === 'unsupported') {
			// The console does not know this kind's shape or its rules. Leaving it
			// alone is the only honest check it can make.
			return;
		}

		if (node.type === 'condition') {
			const handles = new Set(outs.map((edge) => edge.sourceHandle));
			if (outs.length !== 2) {
				issues.push({
					path,
					message: `A condition needs two branches (found ${outs.length}).`
				});
			}
			if (!(handles.has('true') && handles.has('false'))) {
				issues.push({
					path,
					message: ins.length
						? 'Connect both the true and false branches.'
						: 'Connect both branches so the flow knows where to go.'
				});
			}
			return;
		}

		if (node.type === 'switch') {
			const cases = switchCases(node);
			const expected = cases.length + 1;
			if (outs.length !== expected) {
				issues.push({
					path,
					message: `A switch with ${cases.length} ${cases.length === 1 ? 'case' : 'cases'} needs ${expected} connections: one per case and one for the default (found ${outs.length}).`
				});
			}
			const seen = new Set<string>();
			for (const edge of outs) {
				const handle = edge.sourceHandle ?? '';
				const at = `edges[${edges.indexOf(edge)}]`;
				if (seen.has(handle)) {
					issues.push({
						path: at,
						message: 'Two connections leave the same branch. Remove one of them.'
					});
					continue;
				}
				seen.add(handle);
				if (handle === 'default') continue;
				const match = /^case:(\d+)$/.exec(handle);
				if (!match) {
					issues.push({
						path: at,
						message:
							handle === ''
								? 'This connection has no branch. Drag it from one of the case handles.'
								: `“${handle}” is not a branch of this switch. Drag the connection from a case or the default.`
					});
					continue;
				}
				if (Number(match[1]) >= cases.length) {
					issues.push({
						path: at,
						message: `This connection leaves case ${Number(match[1]) + 1}, which no longer exists. Reconnect it to a case or the default.`
					});
				}
			}
			if (!seen.has('default')) {
				issues.push({
					path,
					message: 'Connect the default branch, so a value that matches no case has somewhere to go.'
				});
			}
			return;
		}

		if (outs.length !== 1) {
			issues.push({
				path,
				message: `${NODE_META[node.type].title} needs exactly one outgoing connection (found ${outs.length}).`
			});
		}
	});

	// One cycle is enough to reject the graph; report the edge that closes it.
	const state = new Map<string, 'open' | 'closed'>();
	let cycleEdge: FlowEdge | null = null;
	for (const node of nodes) {
		if (cycleEdge) break;
		if (state.get(node.id) === 'closed') continue;
		const stack: Array<{ id: string; next: number }> = [{ id: node.id, next: 0 }];
		state.set(node.id, 'open');
		while (stack.length > 0 && !cycleEdge) {
			const top = stack[stack.length - 1];
			const outs = outgoing.get(top.id) ?? [];
			if (top.next >= outs.length) {
				state.set(top.id, 'closed');
				stack.pop();
				continue;
			}
			const edge = outs[top.next];
			top.next += 1;
			const targetState = state.get(edge.target);
			if (targetState === 'open') {
				cycleEdge = edge;
				break;
			}
			if (!targetState) {
				state.set(edge.target, 'open');
				stack.push({ id: edge.target, next: 0 });
			}
		}
	}
	if (cycleEdge) {
		const index = edges.indexOf(cycleEdge);
		issues.push({
			path: `edges[${index}]`,
			message: 'This connection closes a loop. Flows must run in one direction.'
		});
	}

	if (triggers.length === 1) {
		const reached = new Set<string>([triggers[0].id]);
		const queue = [triggers[0].id];
		while (queue.length > 0) {
			const id = queue.shift() as string;
			for (const edge of outgoing.get(id) ?? []) {
				if (reached.has(edge.target)) continue;
				reached.add(edge.target);
				queue.push(edge.target);
			}
		}
		nodes.forEach((node, index) => {
			if (!reached.has(node.id)) {
				issues.push({
					path: `nodes[${index}]`,
					message: 'This node cannot be reached from the trigger.'
				});
			}
		});
	}

	return indexIssues(issues, nodes, edges, 'structure');
}

/** Field-level problems: regexes, templates, required values and limits. */
export function fieldIssues(nodes: readonly FlowNode[], edges: readonly FlowEdge[]): EditorIssue[] {
	const issues: WorkflowIssue[] = [];
	const groupOwners = new Map<string, number>();

	nodes.forEach((node, index) => {
		const base = `nodes[${index}].data`;
		const data = node.data as Record<string, unknown>;
		const add = (field: string, message: string) =>
			issues.push({ path: field ? `${base}.${field}` : base, message });

		if (node.type === 'unsupported') return;

		if (node.type === 'trigger') {
			const trigger = data as unknown as TriggerData;
			if (trigger.kind !== 'incoming') {
				add('kind', "Trigger kind must be 'incoming'.");
			}
			if (trigger.sender && trigger.sender.mode !== 'any') {
				if (!trigger.sender.value?.trim()) {
					add('sender.value', 'Add a sender value, or use “Any sender”.');
				} else if (trigger.sender.mode === 'regex') {
					const check = checkRegex(trigger.sender.value);
					if (!check.valid) add('sender.value', `Regex rejected: ${check.error}`);
				}
			}
			if (trigger.body && trigger.body.mode !== 'any') {
				if (!trigger.body.value?.trim()) {
					add('body.value', 'Add a body value, or use “Any body”.');
				} else if (trigger.body.mode === 'regex') {
					const check = checkRegex(trigger.body.value);
					if (!check.valid) add('body.value', `Regex rejected: ${check.error}`);
				}
			}
			return;
		}

		if (node.type === 'extract') {
			const extract = data as unknown as ExtractData;
			if (extract.source !== 'body' && extract.source !== 'sender') {
				add('source', "Source must be 'body' or 'sender'.");
			}
			if (extract.flags !== undefined && extract.flags !== '' && extract.flags !== 'i') {
				add('flags', 'Flags must be empty or “i”.');
			}
			const pattern = typeof extract.pattern === 'string' ? extract.pattern : '';
			if (!pattern) {
				add('pattern', 'Add a pattern with at least one named group.');
				return;
			}
			const check = checkRegex(pattern, extract.flags === 'i' ? 'i' : '');
			if (!check.valid) {
				add('pattern', `Regex rejected: ${check.error}`);
				return;
			}
			const names = extractGroupNames(pattern);
			if (names.length === 0) {
				add('pattern', 'Add a named group, e.g. (?<order_id>[0-9]+).');
				return;
			}
			const seen = new Set<string>();
			for (const name of names) {
				if (!RE_GROUP_NAME.test(name)) {
					add('pattern', `Capture group “${name}” must start with a letter and be 32 characters or fewer.`);
					continue;
				}
				if (RESERVED_GROUPS.has(name)) {
					add('pattern', `“${name}” is a reserved variable name.`);
					continue;
				}
				if (seen.has(name)) {
					add('pattern', `Capture group “${name}” appears twice in one pattern.`);
					continue;
				}
				seen.add(name);
				const owner = groupOwners.get(name);
				if (owner !== undefined) {
					add('pattern', `“${name}” is already captured by an earlier extract node.`);
					continue;
				}
				groupOwners.set(name, index);
			}
			return;
		}

		if (node.type === 'set_var') {
			const setVar = data as unknown as SetVarData;
			const name = typeof setVar.name === 'string' ? setVar.name : '';
			if (!name.trim()) {
				add('name', 'Name the variable, for example note.');
			} else if (!RE_GROUP_NAME.test(name)) {
				add('name', 'Use up to 32 letters, digits or underscores, starting with a letter or an underscore.');
			} else if (RESERVED_GROUPS.has(name)) {
				add('name', `“${name}” is a built-in name. Choose another one.`);
			} else {
				const owner = groupOwners.get(name);
				if (owner !== undefined) {
					add('name', `“${name}” is already bound by an earlier step. Choose another name, or remove that step.`);
				} else {
					groupOwners.set(name, index);
				}
			}
			if (typeof setVar.value !== 'string' || !setVar.value.trim()) {
				add('value', 'Add the value to store. Text and {{variables}} both work.');
			} else if (setVar.value.length > MAX_TEMPLATE_CHARS) {
				add('value', `Value must be ${MAX_TEMPLATE_CHARS} characters or fewer.`);
			}
			return;
		}

		if (node.type === 'condition') {
			const condition = data as unknown as ConditionData;
			if (typeof condition.left !== 'string' || !condition.left.trim()) {
				add('left', 'Choose the value this branch tests.');
			}
			const ops: ConditionData['op'][] = ['equals', 'not_equals', 'contains', 'matches', 'exists'];
			if (!ops.includes(condition.op)) {
				add('op', 'Choose a comparison.');
				return;
			}
			if (condition.op === 'exists') return;
			if (typeof condition.right !== 'string' || !condition.right.trim()) {
				add('right', `Add the value to compare with (“${OP_LABEL[condition.op]}”).`);
				return;
			}
			if (condition.op === 'matches') {
				const check = checkRegex(condition.right);
				if (!check.valid) add('right', `Regex rejected: ${check.error}`);
			}
			return;
		}

		if (node.type === 'switch') {
			const branch = data as unknown as SwitchData;
			const value = typeof branch.value === 'string' ? branch.value : '';
			if (!value.trim()) {
				add('value', 'Choose the value to compare, for example {{body}}.');
			} else if (value.length > MAX_TEMPLATE_CHARS) {
				add('value', `Value must be ${MAX_TEMPLATE_CHARS} characters or fewer.`);
			}
			const cases = switchCases(node);
			if (cases.length === 0) {
				add('cases', 'Add at least one case, so the switch has something to match.');
			} else if (cases.length > MAX_CASES) {
				add('cases', `A switch holds at most ${MAX_CASES} cases. Remove one before saving.`);
			}
			const seen = new Map<string, number>();
			cases.forEach((label, caseIndex) => {
				if (!label.trim()) {
					add(`cases[${caseIndex}]`, `Fill in case ${caseIndex + 1}, or remove it.`);
					return;
				}
				const first = seen.get(label);
				if (first !== undefined) {
					add(
						`cases[${caseIndex}]`,
						`“${label}” is already case ${first + 1}. Remove the duplicate, because only the first match runs.`
					);
					return;
				}
				seen.set(label, caseIndex);
			});
			return;
		}

		if (node.type === 'delay') {
			const seconds = Number((data as unknown as DelayData).seconds);
			if (
				!Number.isInteger(seconds) ||
				seconds < MIN_DELAY_SECONDS ||
				seconds > MAX_DELAY_SECONDS
			) {
				add(
					'seconds',
					`Choose a whole number of seconds from ${MIN_DELAY_SECONDS} to ${MAX_DELAY_SECONDS}.`
				);
			}
			return;
		}

		if (node.type === 'webhook') {
			const hook = data as unknown as WebhookData;
			const url = typeof hook.url === 'string' ? hook.url : '';
			if (!url.trim()) {
				add('url', 'Add the https address to call.');
			} else if (!(url.startsWith('https://') || url.startsWith('http://127.0.0.1'))) {
				add('url', 'Only https addresses can be called. Start the address with https://.');
			} else if (url.length > MAX_TEMPLATE_CHARS) {
				add('url', `Address must be ${MAX_TEMPLATE_CHARS} characters or fewer.`);
			}
			if (typeof hook.body !== 'string') {
				add('body', 'Add the body to send. Leave it empty to send nothing.');
			} else if (hook.body.length > MAX_TEMPLATE_CHARS) {
				add('body', `Body must be ${MAX_TEMPLATE_CHARS} characters or fewer.`);
			}
			return;
		}

		if (node.type === 'send_sms') {
			const sms = data as unknown as SendSmsData;
			if (typeof sms.to !== 'string' || !sms.to.trim()) {
				add('to', 'Add a recipient. Use {{sender}} to reply to the incoming number.');
			} else if (sms.to.length > SMS_TO_LIMIT) {
				add('to', `Recipient must be ${SMS_TO_LIMIT} characters or fewer.`);
			}
			if (typeof sms.body !== 'string' || !sms.body.trim()) {
				add('body', 'Write the message to send.');
			} else if (sms.body.length > SMS_BODY_LIMIT) {
				add('body', `Message must be ${SMS_BODY_LIMIT} characters or fewer.`);
			}
			return;
		}

		if (node.type === 'stop' && data.reason !== undefined && typeof data.reason !== 'string') {
			add('reason', 'Reason must be text.');
		}
	});

	/* Templates are checked last: they may name a variable from any earlier step. */
	const allowed = new Set<string>(BUILTIN_VARIABLES);
	nodes.forEach((node) => {
		for (const name of boundNamesOf(node)) allowed.add(name);
	});
	nodes.forEach((node, index) => {
		const data = node.data as Record<string, unknown>;
		const fields: Array<[string, unknown]> = [];
		if (node.type === 'set_var') {
			fields.push(['value', data.value]);
		} else if (node.type === 'condition') {
			fields.push(['left', data.left], ['right', data.right]);
		} else if (node.type === 'switch') {
			fields.push(['value', data.value]);
		} else if (node.type === 'webhook') {
			fields.push(['url', data.url], ['body', data.body]);
		} else if (node.type === 'send_sms') {
			fields.push(['to', data.to], ['body', data.body]);
		}
		for (const [field, raw] of fields) {
			if (typeof raw !== 'string') continue;
			const { names, unterminated } = templateNames(raw);
			if (unterminated) {
				issues.push({
					path: `nodes[${index}].data.${field}`,
					message: "Unclosed “{{”. Add the matching “}}”."
				});
				continue;
			}
			for (const name of names) {
				if (!allowed.has(name)) {
					issues.push({
						path: `nodes[${index}].data.${field}`,
						message: `Unknown variable “{{${name}}}”. Add it from an extract or set variable step, or use sender, body or received_at.`
					});
				}
			}
		}
	});

	return indexIssues(issues, nodes, edges);
}

export function edgeIssues(edges: readonly FlowEdge[], nodes: readonly FlowNode[]): EditorIssue[] {
	const issues: WorkflowIssue[] = [];
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const seen = new Set<string>();

	edges.forEach((edge, index) => {
		const path = `edges[${index}]`;
		if (!RE_WORKFLOW_ID.test(edge.id)) {
			issues.push({ path: `${path}.id`, message: 'Edge id is not valid.' });
		} else if (seen.has(edge.id)) {
			issues.push({ path: `${path}.id`, message: 'Duplicate edge id.' });
		} else {
			seen.add(edge.id);
		}
		const source = byId.get(edge.source);
		const target = byId.get(edge.target);
		if (!source) {
			issues.push({ path: `${path}.source`, message: 'Connection starts at a node that is gone.' });
		}
		if (!target) {
			issues.push({ path: `${path}.target`, message: 'Connection ends at a node that is gone.' });
		}
		if (edge.source === edge.target) {
			issues.push({ path: `${path}.target`, message: 'A node cannot connect to itself.' });
		}
		const handle = edge.sourceHandle ?? '';
		if (source?.type === 'condition') {
			if (!handle) {
				issues.push({
					path: `${path}.sourceHandle`,
					message: 'Drag this connection from the true or false handle.'
				});
			} else if (handle !== 'true' && handle !== 'false') {
				issues.push({
					path: `${path}.sourceHandle`,
					message: 'A condition connects from its true or false handle.'
				});
			}
		} else if (source?.type === 'switch') {
			if (!handle) {
				issues.push({
					path: `${path}.sourceHandle`,
					message: 'Drag this connection from a case handle or the default handle.'
				});
			} else if (handle !== DEFAULT_HANDLE && !/^case:\d+$/.test(handle)) {
				issues.push({
					path: `${path}.sourceHandle`,
					message: 'A switch connects from a case or the default.'
				});
			}
		} else if (source && source.type !== 'unsupported' && handle) {
			issues.push({
				path: `${path}.sourceHandle`,
				message: 'Only a condition or a switch uses branches. Redraw this connection from the plain handle.'
			});
		}
	});

	return indexIssues(issues, nodes, edges);
}

export function validateWorkflow(
	nodes: readonly FlowNode[],
	edges: readonly FlowEdge[]
): EditorIssue[] {
	const issues: EditorIssue[] = [];
	if (nodes.length > NODE_LIMIT) {
		issues.push({
			kind: 'structure',
			path: 'nodes',
			message: `A flow can hold at most ${NODE_LIMIT} nodes.`
		});
	}
	if (edges.length > EDGE_LIMIT) {
		issues.push({
			kind: 'structure',
			path: 'edges',
			message: `A flow can hold at most ${EDGE_LIMIT} connections.`
		});
	}
	return [
		...issues,
		...structuralIssues(nodes, edges),
		...fieldIssues(nodes, edges),
		...edgeIssues(edges, nodes)
	];
}

/** Server issue paths are index-based; resolve them onto the current nodes/edges. */
export function mapServerIssues(
	details: WorkflowIssue[],
	nodes: readonly FlowNode[],
	edges: readonly FlowEdge[]
): EditorIssue[] {
	return details.map((detail) => {
		const nodeMatch = /^nodes\[(\d+)\]/.exec(detail.path);
		const edgeMatch = /^edges\[(\d+)\]/.exec(detail.path);
		const edge = edgeMatch ? edges[Number(edgeMatch[1])] : undefined;
		const looksStructural =
			!/\.(data|id|source|target|sourceHandle|label)(\.|$)/.test(detail.path) &&
			/^(nodes(\[\d+\])?|edges(\[\d+\])?|)$/.test(detail.path);
		return {
			...detail,
			kind: looksStructural ? 'structure' : 'field',
			nodeId: nodeMatch ? nodes[Number(nodeMatch[1])]?.id : edge?.source,
			edgeId: edge?.id
		};
	});
}

export function issuesForNode(issues: readonly EditorIssue[], node: FlowNode): EditorIssue[] {
	return issues.filter((issue) => issue.nodeId === node.id);
}

export function fieldErrorsForNode(
	issues: readonly EditorIssue[],
	node: FlowNode,
	nodes: readonly FlowNode[]
): Record<string, string> {
	const index = nodes.findIndex((item) => item.id === node.id);
	const prefix = `nodes[${index}].data.`;
	const errors: Record<string, string> = {};
	for (const issue of issues) {
		if (!issue.path.startsWith(prefix)) continue;
		const field = issue.path.slice(prefix.length);
		if (!errors[field]) errors[field] = issue.message;
	}
	return errors;
}

/* ------------------------------------------------------------ switch cases */

/** The cases a switch declares, index-aligned. Anything that is not a string reads as empty. */
export function switchCaseList(data: SwitchData): string[] {
	const raw = data.cases;
	if (!Array.isArray(raw)) return [];
	return raw.map((value) => (typeof value === 'string' ? value : ''));
}

export function switchCases(node: FlowNode): string[] {
	return switchCaseList(nodeData<SwitchData>(node));
}

export interface SwitchBranch {
	handle: string;
	label: string;
	/** Null for the default branch. */
	index: number | null;
}

/** Every source handle a switch draws, in order: one per case, then default. */
export function switchBranchesOf(data: SwitchData): SwitchBranch[] {
	const branches = switchCaseList(data).map((label, index) => ({
		handle: caseHandle(index),
		label,
		index
	}));
	return [...branches, { handle: DEFAULT_HANDLE, label: 'default', index: null }];
}

export function switchBranches(node: FlowNode): SwitchBranch[] {
	return switchBranchesOf(nodeData<SwitchData>(node));
}

/** Every source handle a node offers. A plain node has one, unnamed. */
export function sourceHandles(node: FlowNode): string[] {
	switch (node.type) {
		case 'stop':
			return [];
		case 'condition':
			return ['true', 'false'];
		case 'switch':
			return switchBranches(node).map((branch) => branch.handle);
		default:
			return [''];
	}
}

export type SwitchCaseOp =
	| { kind: 'rename'; index: number; value: string }
	| { kind: 'add'; value?: string }
	| { kind: 'remove'; index: number };

export interface SwitchCaseEdit {
	nodes: FlowNode[];
	edges: FlowEdge[];
	/** Connections dropped because the case they left is gone. */
	dropped: number;
}

/**
 * Edit a switch's cases and keep the canvas honest.
 *
 * Branch handles are positional (`case:0`, `case:1`, ...), so removing a case in
 * the middle of the list shifts every later case up one. The connections shift
 * with their cases, and only the removed case loses its branch.
 */
export function applySwitchCase(
	nodes: readonly FlowNode[],
	edges: readonly FlowEdge[],
	nodeId: string,
	op: SwitchCaseOp
): SwitchCaseEdit {
	const node = nodes.find((item) => item.id === nodeId);
	if (!node || node.type !== 'switch') return { nodes: [...nodes], edges: [...edges], dropped: 0 };

	const previous = switchCases(node);
	let cases: string[];
	let nextEdges: readonly FlowEdge[] = edges;
	let dropped = 0;

	if (op.kind === 'add') {
		if (previous.length >= MAX_CASES) return { nodes: [...nodes], edges: [...edges], dropped: 0 };
		cases = [...previous, op.value ?? ''];
	} else if (op.kind === 'rename') {
		if (op.index < 0 || op.index >= previous.length) {
			return { nodes: [...nodes], edges: [...edges], dropped: 0 };
		}
		cases = previous.map((value, index) => (index === op.index ? op.value : value));
	} else {
		if (op.index < 0 || op.index >= previous.length) {
			return { nodes: [...nodes], edges: [...edges], dropped: 0 };
		}
		cases = previous.filter((_value, index) => index !== op.index);
		nextEdges = edges.flatMap((edge) => {
			const handle = edge.sourceHandle ?? '';
			if (edge.source !== nodeId || handle === '') return [edge];
			const match = /^case:(\d+)$/.exec(handle);
			if (!match) return [edge];
			const at = Number(match[1]);
			if (at === op.index) {
				dropped += 1;
				return [];
			}
			if (at > op.index) return [{ ...edge, sourceHandle: caseHandle(at - 1) }];
			return [edge];
		});
	}

	const nextNodes = nodes.map((item) =>
		item.id === nodeId ? { ...item, data: { ...item.data, cases } } : item
	);
	return { nodes: nextNodes, edges: [...nextEdges], dropped };
}

/** Resolve the target at the end of any branch handle. */
export function handleTarget(
	node: FlowNode,
	handle: string,
	edges: readonly FlowEdge[],
	nodes: readonly FlowNode[]
): FlowNode | null {
	const edge = edges.find((item) => item.source === node.id && (item.sourceHandle ?? '') === handle);
	if (!edge) return null;
	return nodes.find((item) => item.id === edge.target) ?? null;
}

export function nodeLabel(node: FlowNode | null): string {
	if (!node) return 'nothing';
	const title = metaFor(node.type).title;
	if (node.type === 'stop') return 'Stop';
	if (node.type === 'condition') return 'Condition';
	return title;
}
