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
	ExtractData,
	SendSmsData,
	StopData,
	TriggerData,
	WorkflowEdge,
	WorkflowGraph,
	WorkflowIssue,
	WorkflowNodeType
} from '$lib/types';

export type FlowNode = Node<Record<string, unknown>, WorkflowNodeType>;
export type FlowEdge = Edge<Record<string, unknown>, 'smoothstep'>;

export const NODE_TYPES: WorkflowNodeType[] = [
	'trigger',
	'extract',
	'condition',
	'send_sms',
	'stop'
];

export const NODE_META: Record<
	WorkflowNodeType,
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
	condition: {
		title: 'Condition',
		icon: 'branch',
		blurb: 'Branch on a value'
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
	}
};

export const NODE_LIMIT = 50;
export const EDGE_LIMIT = 100;
export const NAME_LIMIT = 120;
export const SMS_TO_LIMIT = 32;
export const SMS_BODY_LIMIT = 4096;

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
		case 'condition':
			return { left: '', op: 'equals', right: '' };
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
		type: node.type as WorkflowNodeType,
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
		if (edge.sourceHandle === 'true' || edge.sourceHandle === 'false') {
			next.sourceHandle = edge.sourceHandle;
		}
		if (typeof edge.label === 'string' && edge.label.length > 0) next.label = edge.label;
		return next;
	});

	return { nodes: workflowNodes, edges: workflowEdges };
}

export function fromGraph(graph: WorkflowGraph | null | undefined): {
	nodes: FlowNode[];
	edges: FlowEdge[];
} {
	const rawNodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
	const rawEdges = Array.isArray(graph?.edges) ? graph.edges : [];

	const nodes: FlowNode[] = rawNodes
		.filter((node) => node && typeof node.id === 'string' && NODE_TYPES.includes(node.type))
		.map((node) => ({
			id: node.id,
			type: node.type,
			position: {
				x: Number.isFinite(node.position?.x) ? node.position.x : 0,
				y: Number.isFinite(node.position?.y) ? node.position.y : 0
			},
			data:
				node.data && typeof node.data === 'object' && !Array.isArray(node.data)
					? ({ ...node.data } as Record<string, unknown>)
					: {}
		}));

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
			if (edge.sourceHandle === 'true' || edge.sourceHandle === 'false') {
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
	sourceHandle: 'true' | 'false' | undefined,
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

export function nodeSummary(node: FlowNode): string {
	switch (node.type) {
		case 'trigger':
			return triggerSummary(nodeData<TriggerData>(node));
		case 'extract':
			return extractSummary(nodeData<ExtractData>(node));
		case 'condition':
			return conditionSummary(nodeData<ConditionData>(node));
		case 'send_sms':
			return sendSummary(nodeData<SendSmsData>(node));
		case 'stop':
			return stopSummary(nodeData<StopData>(node));
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

/** Every template name the flow can resolve right now, built-ins first. */
export function templateVariables(nodes: readonly FlowNode[]): string[] {
	const names = new Set<string>(BUILTIN_VARIABLES);
	for (const node of nodes) {
		if (node.type !== 'extract') continue;
		for (const name of extractGroupNames(nodeData<ExtractData>(node).pattern ?? '')) {
			names.add(name);
		}
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

export function templateNames(value: string): { names: string[]; unterminated: boolean } {
	const names: string[] = [];
	let from = 0;
	for (;;) {
		const open = value.indexOf('{{', from);
		if (open === -1) return { names, unterminated: false };
		const close = value.indexOf('}}', open + 2);
		if (close === -1) return { names, unterminated: true };
		names.push(value.slice(open + 2, close).trim());
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

	/* Templates are checked last: they may name a group from any extract node. */
	const allowed = new Set<string>(BUILTIN_VARIABLES);
	nodes.forEach((node) => {
		if (node.type !== 'extract') return;
		for (const name of extractGroupNames(nodeData<ExtractData>(node).pattern ?? '')) {
			allowed.add(name);
		}
	});
	nodes.forEach((node, index) => {
		const data = node.data as Record<string, unknown>;
		const fields: Array<[string, unknown]> = [];
		if (node.type === 'condition') {
			fields.push(['left', data.left], ['right', data.right]);
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
						message: `Unknown variable “{{${name}}}”. Add it from an extract node or use sender, body or received_at.`
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
		if (source && source.type !== 'condition' && edge.sourceHandle) {
			issues.push({
				path: `${path}.sourceHandle`,
				message: 'Only a condition can use true/false branches.'
			});
		}
		if (source && source.type === 'condition' && !edge.sourceHandle) {
			issues.push({
				path: `${path}.sourceHandle`,
				message: 'Choose the true or false branch for this connection.'
			});
		}
		if (
			edge.sourceHandle !== undefined &&
			edge.sourceHandle !== 'true' &&
			edge.sourceHandle !== 'false'
		) {
			issues.push({ path: `${path}.sourceHandle`, message: 'Branch must be true or false.' });
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

/** Resolve the target at the end of a condition's true/false branch. */
export function branchTarget(
	node: FlowNode,
	handle: 'true' | 'false',
	edges: readonly FlowEdge[],
	nodes: readonly FlowNode[]
): FlowNode | null {
	const edge = edges.find((item) => item.source === node.id && item.sourceHandle === handle);
	if (!edge) return null;
	return nodes.find((item) => item.id === edge.target) ?? null;
}

export function nodeLabel(node: FlowNode | null): string {
	if (!node) return 'nothing';
	const title = NODE_META[node.type].title;
	if (node.type === 'stop') return 'Stop';
	if (node.type === 'condition') return 'Condition';
	return title;
}
