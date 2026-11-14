/**
 * Turning an operator's sentence into one candidate patch, and checking it.
 *
 * This is deliberately not a language model. The console may compose a patch and
 * ask the agent to judge it, but it must never invent a judgement — so the two
 * halves are split and stay separate:
 *
 *   `composeInsert`  reads the words here, deterministically, and says exactly
 *                    what it will change. A sentence it cannot read changes
 *                    nothing and says why.
 *   `verifyPatch`    re-reads the patched graph with the editor's own validator,
 *                    and separates the problems the patch introduced into
 *                    structural ones (which stop an accept) and field ones
 *                    (which the operator can fill in afterwards).
 *
 * The `summary` it returns is the `diff_summary` sent to `/v1/agent/synthesize`,
 * and it is also the line the ghost banner shows, so the two can never disagree.
 * It must stay stable for the same patch: the Worker hashes the request text to
 * bind an apply token, so rewriting it after the judgement would break the bind.
 */

import type { WorkflowNodeType } from '$lib/types';
import {
	COL_GAP,
	NODE_LIMIT,
	createEdge,
	createNode,
	metaFor,
	nodeSummary,
	outlineItems,
	validateWorkflow,
	type EditorIssue,
	type FlowEdge,
	type FlowNode
} from '$lib/workflow/graph';

/** The two halves of a graph, copied. The persisted format is unchanged. */
export interface FlowPatch {
	nodes: FlowNode[];
	edges: FlowEdge[];
}

/** One row of the ghost banner's "what this does" list. */
export interface PatchEntry {
	id: string;
	title: string;
	detail: string;
}

export interface PatchProblems {
	/** Problems this patch introduced, whether or not they stop an accept. */
	all: EditorIssue[];
	/** The subset that makes the patched graph structurally wrong. */
	blocking: EditorIssue[];
}

export interface ComposedPatch {
	patch: FlowPatch;
	/** The canonical sentence: `diff_summary`, and the banner's own line. */
	summary: string;
	added: PatchEntry[];
	modified: PatchEntry[];
	addedIds: string[];
	modifiedIds: string[];
	/** The step a ghost is drawn after, so the outline can find the spot. */
	anchorId: string;
}

export type ComposeResult =
	| { ok: true; value: ComposedPatch }
	| { ok: false; reason: string };

/** Words an operator is likely to use for each kind, in matching order. */
const KIND_WORDS: Array<{ pattern: RegExp; type: WorkflowNodeType }> = [
	{ pattern: /\b(trigger|start)\b/, type: 'trigger' },
	{ pattern: /\b(extract|regex|pattern|capture)\b/, type: 'extract' },
	{ pattern: /\b(set[_ ]?var|variable|assign)\b/, type: 'set_var' },
	{ pattern: /\b(condition|if|branch)\b/, type: 'condition' },
	{ pattern: /\b(switch|case)\b/, type: 'switch' },
	{ pattern: /\b(delay|wait|pause)\b/, type: 'delay' },
	{ pattern: /\b(webhook|http|request|callback)\b/, type: 'webhook' },
	{ pattern: /\b(send[_ ]?sms|sms|reply|text back|message back)\b/, type: 'send_sms' },
	{ pattern: /\b(stop|end|halt)\b/, type: 'stop' }
];

/** How an operator names a place: `after 2`, `before step 3`, `at the end`. */
const ANCHOR_WORDS = /\b(after|before)\s+(?:step\s+)?#?(\d{1,3})\b/;
const APPEND_WORDS = /\b(at the end|to the end|append|last step|after the last)\b/;

function clone<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

/** A card-sized hole near `start`, so a ghost never lands on top of a step. */
function freeSpot(nodes: readonly FlowNode[], start: { x: number; y: number }): { x: number; y: number } {
	let y = start.y;
	for (let attempt = 0; attempt < 10; attempt += 1) {
		const taken = nodes.some(
			(node) => Math.abs(node.position.x - start.x) < 230 && Math.abs(node.position.y - y) < 130
		);
		if (!taken) return { x: Math.round(start.x), y: Math.round(y) };
		y += 140;
	}
	return { x: Math.round(start.x), y: Math.round(y) };
}

function numberToNode(nodes: readonly FlowNode[], edges: readonly FlowEdge[]): Map<number, FlowNode> {
	const byNumber = new Map<number, FlowNode>();
	for (const item of outlineItems(nodes, edges)) {
		if (item.kind !== 'step' || item.repeated || item.number === null) continue;
		byNumber.set(item.number, item.node);
	}
	return byNumber;
}

/**
 * Read one sentence into one insertion.
 *
 * Only insertions are composed: they are the change a ghost can show honestly
 * (a dashed new card, and the step whose connection moves), and they are the one
 * shape where the console can be sure it understood the words. Anything else is
 * refused with the sentence that would have worked, rather than guessed at.
 */
export function composeInsert(
	intent: string,
	nodes: readonly FlowNode[],
	edges: readonly FlowEdge[],
	options: { selectedId?: string | null } = {}
): ComposeResult {
	const text = intent.trim().toLowerCase();
	if (!text) return { ok: false, reason: 'Say what to add, for example “add a delay after 2”.' };

	const kind = KIND_WORDS.find((entry) => entry.pattern.test(text))?.type ?? null;
	if (kind === null) {
		return {
			ok: false,
			reason: 'Name the kind of step to add: delay, send sms, webhook, condition, switch, extract, set var or stop.'
		};
	}

	if (kind === 'trigger') {
		return { ok: false, reason: 'A flow has one trigger, and this one already has its trigger. Add a step after it instead.' };
	}
	if (nodes.length >= NODE_LIMIT) {
		return { ok: false, reason: `A flow can hold at most ${NODE_LIMIT} steps.` };
	}

	const numbered = numberToNode(nodes, edges);
	const anchorMatch = ANCHOR_WORDS.exec(text);
	let anchor: FlowNode | null = null;
	let where: 'after' | 'before' = 'after';

	if (anchorMatch) {
		where = anchorMatch[1] === 'before' ? 'before' : 'after';
		const number = Number(anchorMatch[2]);
		anchor = numbered.get(number) ?? null;
		if (!anchor) {
			return {
				ok: false,
				reason: `This flow has no step ${number}. Steps are numbered in the order the Steps surface lists them.`
			};
		}
	} else if (APPEND_WORDS.test(text)) {
		const last = [...numbered.entries()].sort((left, right) => left[0] - right[0]).at(-1);
		anchor = last ? last[1] : null;
	} else if (options.selectedId) {
		anchor = nodes.find((node) => node.id === options.selectedId) ?? null;
	} else {
		const last = [...numbered.entries()].sort((left, right) => left[0] - right[0]).at(-1);
		anchor = last ? last[1] : null;
	}

	if (!anchor) {
		return { ok: false, reason: 'There is no step to put the new one next to yet. Add a trigger first.' };
	}
	if (where === 'before' && anchor.type === 'trigger') {
		return { ok: false, reason: 'A flow starts at its trigger, so nothing can go before it.' };
	}
	if (anchor.type === 'stop') {
		return { ok: false, reason: 'A Stop step ends the flow. Add the step before the Stop instead.' };
	}
	if (anchor.type === 'condition' || anchor.type === 'switch') {
		return {
			ok: false,
			reason: `${metaFor(anchor.type).title} branches. Add the step after one of the steps it leads to, so the branch it belongs to is clear.`
		};
	}

	// Where the new card goes: one column after the step it follows, or between
	// the step and what it leads to.
	const position = freeSpot(nodes, { x: anchor.position.x + COL_GAP, y: anchor.position.y });
	const created = createNode(kind, position, nodes);
	created.selected = false;

	const patchedNodes: FlowNode[] = [...nodes.map((node) => ({ ...node })), created];
	const patchedEdges: FlowEdge[] = edges.map((edge) => ({ ...edge }));
	const modified = new Set<string>();

	if (where === 'after') {
		if (kind === 'stop' && patchedEdges.some((edge) => edge.source === anchor.id)) {
			return {
				ok: false,
				reason: 'A Stop step has nowhere to go, and this step already leads somewhere. Put the Stop at the end of a branch instead.'
			};
		}
		// The step's plain connection moves to the new step, which keeps the flow
		// intact and is the "modified" half of the ghost.
		for (const edge of patchedEdges) {
			if (edge.source !== anchor.id || edge.sourceHandle) continue;
			edge.source = created.id;
			modified.add(anchor.id);
		}
		patchedEdges.push(createEdge(anchor.id, created.id, undefined, patchedEdges));
	} else {
		for (const edge of patchedEdges) {
			if (edge.target !== anchor.id) continue;
			edge.target = created.id;
			modified.add(edge.source);
		}
		modified.add(anchor.id);
		patchedEdges.push(createEdge(created.id, anchor.id, undefined, patchedEdges));
	}

	const added: PatchEntry[] = [
		{
			id: created.id,
			title: metaFor(kind).title,
			detail: nodeSummary(created)
		}
	];
	const modifiedList: PatchEntry[] = [...modified]
		.filter((id) => id !== created.id)
		.map((id) => {
			const node = patchedNodes.find((item) => item.id === id);
			return {
				id,
				title: node ? metaFor(node.type).title : 'Step',
				detail: node ? nodeSummary(node) : ''
			};
		});

	const anchorNumber = [...numbered.entries()].find(([, node]) => node.id === anchor?.id)?.[0] ?? null;
	const place =
		where === 'before'
			? `before step ${anchorNumber ?? ''}`.trim()
			: `after step ${anchorNumber ?? ''}`.trim();
	const title = metaFor(kind).title;
	const summary =
		where === 'after'
			? `Add a ${title} step ${place}, and connect the step that followed it to the new step.`
			: `Add a ${title} step ${place}, and move the connection that reached it to the new step.`;

	return {
		ok: true,
		value: {
			patch: { nodes: patchedNodes, edges: patchedEdges },
			summary,
			added,
			modified: modifiedList,
			addedIds: [created.id],
			modifiedIds: modifiedList.map((entry) => entry.id),
			anchorId: anchor.id
		}
	};
}

function issueKey(issue: EditorIssue): string {
	return `${issue.kind}\u0000${issue.path}\u0000${issue.message}`;
}

/**
 * Re-check the patched graph with the editor's own validator.
 *
 * Only the problems the patch *introduced* count, so a flow that was already
 * carrying a field error does not block an unrelated insertion. Structural ones
 * stop the accept: they are the console saying the graph would be wrong.
 */
export function verifyPatch(
	patched: FlowPatch,
	current: { nodes: readonly FlowNode[]; edges: readonly FlowEdge[] }
): PatchProblems {
	const before = new Set(validateWorkflow(current.nodes, current.edges).map(issueKey));
	const all = validateWorkflow(patched.nodes, patched.edges).filter(
		(issue) => !before.has(issueKey(issue))
	);
	return { all, blocking: all.filter((issue) => issue.kind === 'structure') };
}

/** True when a patch still names the same flow, for a defensive pre-apply check. */
export function patchFitsFlow(
	patched: FlowPatch,
	current: { nodes: readonly FlowNode[] }
): string | null {
	const ids = new Set<string>();
	for (const node of patched.nodes) {
		if (ids.has(node.id)) return `The patch adds two steps with the same id (${node.id}).`;
		ids.add(node.id);
	}
	if (patched.nodes.length > NODE_LIMIT) return `A flow can hold at most ${NODE_LIMIT} steps.`;
	const triggers = patched.nodes.filter((node) => node.type === 'trigger').length;
	if (triggers > 1) return 'The patch leaves the flow with two triggers.';
	for (const edge of patched.edges) {
		if (!ids.has(edge.source) || !ids.has(edge.target)) {
			return 'The patch has a connection to a step it does not contain.';
		}
	}
	if (current.nodes.length > 0 && patched.nodes.length === 0) return 'The patch removes every step.';
	return null;
}

/** The same sentence the banner shows, in one line, for a screen reader. */
export function describePatchEntries(entries: readonly PatchEntry[]): string {
	if (entries.length === 0) return 'none';
	return entries.map((entry) => entry.title).join(', ');
}
