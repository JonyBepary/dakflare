/**
 * Turning an operator's sentence into one candidate patch, and checking it.
 *
 * This is deliberately not a language model. The console may compose a patch and
 * ask the agent to judge it, but it must never invent a judgement — so the two
 * halves are split and stay separate:
 *
 *   `composePatch`   reads the words here, deterministically, and says exactly
 *                    what it will change: an insertion, a move, a rename or a
 *                    removal. A sentence it cannot read changes nothing and
 *                    says why.
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
	NAME_LIMIT,
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
	removed: PatchEntry[];
	addedIds: string[];
	modifiedIds: string[];
	removedIds: string[];
	/** The step a ghost is drawn after, so the outline can find the spot. */
	anchorId: string;
}

/** The two halves of a graph, as an operator's sentence reads them. */
export interface PatchGraph {
	nodes: readonly FlowNode[];
	edges: readonly FlowEdge[];
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

/** The other three verbs. Each one names a step by its outline number. */
const MOVE_WORDS =
	/^move\s+(?:step\s+)?#?(\d{1,3})\s+(after|before)\s+(?:step\s+)?#?(\d{1,3})\b/;
const RENAME_WORDS = /^(?:rename|retitle)\s+(?:step\s+)?#?(\d{1,3})\s+(?:to|as)\s+(.+)$/i;
const REMOVE_WORDS = /^(?:remove|delete)\s+(?:step\s+)?#?(\d{1,3})\b/;

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
 * The title the operator sees on a card.
 *
 * The nine kinds have a fixed name in `NODE_META`; a rename stores an override in
 * the node's own `data` so the graph keeps the kind, the id and every connection.
 * Nothing else reads that field, which is exactly what a rename should touch.
 */
export function visibleTitle(node: FlowNode | null | undefined): string {
	if (!node) return 'Step';
	const title = node.data?.title;
	if (typeof title === 'string' && title.trim()) return title.trim();
	return metaFor(node.type).title;
}

function patchEntryFor(node: FlowNode): PatchEntry {
	return { id: node.id, title: visibleTitle(node), detail: nodeSummary(node) };
}

/** Why a step cannot be lifted out as one link of the chain. */
function branchRefusal(node: FlowNode, verb: 'move' | 'remove'): string {
	const title = visibleTitle(node);
	if (verb === 'move') {
		return `${title} branches, so it cannot be moved as one step. Move one of the steps it leads to instead.`;
	}
	return `${title} branches. Removing it would leave the steps it leads to unconnected, so remove a step on one branch instead.`;
}

function outgoingOf(edges: readonly FlowEdge[], id: string): FlowEdge[] {
	return edges.filter((edge) => edge.source === id);
}

function incomingOf(edges: readonly FlowEdge[], id: string): FlowEdge[] {
	return edges.filter((edge) => edge.target === id);
}

/**
 * Read one sentence into one insertion.
 *
 * This is the insertion path `composePatch` falls through to; it stays exported
 * because the insertion grammar (kind + place) is the one shape with no second
 * reading, and callers that only add steps need nothing else.
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
			removed: [],
			addedIds: [created.id],
			modifiedIds: modifiedList.map((entry) => entry.id),
			removedIds: [],
			anchorId: anchor.id
		}
	};
}

/* ----------------------------------------------------------------- moves */

function noStepReason(number: number): string {
	return `This flow has no step ${number}. Steps are numbered in the order the Steps surface lists them.`;
}

/**
 * `move 3 after 2` / `move 3 before 2`.
 *
 * The moved step is lifted out first — its one incoming edge is joined to its
 * one outgoing edge — and then dropped on the other side of the anchor. That is
 * the same chain an operator sees, rewired in place: the anchor's connection
 * becomes the moved step's way in, and the moved step keeps the way out it had.
 * Ids never change; only the two edges around the seam are rebuilt.
 */
function composeMove(
	fromNumber: number,
	where: 'after' | 'before',
	anchorNumber: number,
	graph: PatchGraph
): ComposeResult {
	const numbered = numberToNode(graph.nodes, graph.edges);
	const moved = numbered.get(fromNumber);
	const anchor = numbered.get(anchorNumber);

	if (!moved) return { ok: false, reason: noStepReason(fromNumber) };
	if (!anchor) return { ok: false, reason: noStepReason(anchorNumber) };
	if (moved.id === anchor.id) {
		return { ok: false, reason: 'A step cannot move next to itself. Name two different steps.' };
	}
	if (moved.type === 'trigger') {
		return {
			ok: false,
			reason: 'The trigger is where the flow starts, so it cannot move. Move a step after it instead.'
		};
	}
	if (moved.type === 'stop') {
		return {
			ok: false,
			reason: 'A Stop step ends the flow. Move another step before it instead of moving the Stop.'
		};
	}
	if (moved.type === 'condition' || moved.type === 'switch') {
		return { ok: false, reason: branchRefusal(moved, 'move') };
	}
	if (where === 'before' && anchor.type === 'trigger') {
		return { ok: false, reason: 'A flow starts at its trigger, so nothing can go before it.' };
	}
	if (where === 'after' && anchor.type === 'stop') {
		return { ok: false, reason: 'A Stop step ends the flow, so nothing can go after it.' };
	}
	if (
		where === 'after' &&
		(anchor.type === 'condition' || anchor.type === 'switch')
	) {
		return {
			ok: false,
			reason: `${visibleTitle(anchor)} branches. Say which step it leads to instead: move ${fromNumber} before that step.`
		};
	}

	const incoming = incomingOf(graph.edges, moved.id);
	const outgoing = outgoingOf(graph.edges, moved.id);
	if (incoming.length !== 1 || outgoing.length !== 1) {
		return {
			ok: false,
			reason: `Step ${fromNumber} has ${incoming.length} connections in and ${outgoing.length} out. A move needs exactly one of each, so the chain stays connected.`
		};
	}

	const inEdge = incoming[0];
	const outEdge = outgoing[0];

	// Lift the step out and close the gap: the predecessor now leads where the
	// moved step used to lead. The incoming edge keeps its id and its branch
	// handle; the outgoing edge is reused for the far side of the seam.
	const stitch: FlowEdge = { ...inEdge, target: outEdge.target };
	const working: FlowEdge[] = graph.edges
		.filter((edge) => edge.id !== inEdge.id && edge.id !== outEdge.id)
		.map((edge) => ({ ...edge }));
	working.push(stitch);

	if (where === 'after') {
		const outs = outgoingOf(working, anchor.id);
		if (outs.length === 0) {
			return {
				ok: false,
				reason: `Step ${anchorNumber} is the last step, so nothing can go after it. Move the step before step ${anchorNumber} instead.`
			};
		}
		if (outs.length > 1) {
			return {
				ok: false,
				reason: `${visibleTitle(anchor)} has ${outs.length} connections leaving it, so "after step ${anchorNumber}" names more than one place.`
			};
		}
		const anchorOut = outs[0];
		const successor = anchorOut.target;
		anchorOut.target = moved.id;
		working.push({ ...outEdge, target: successor });
	} else {
		const ins = incomingOf(working, anchor.id);
		if (ins.length === 0) {
			return {
				ok: false,
				reason: `Step ${anchorNumber} has no connection leading to it, so the moved step cannot join before it.`
			};
		}
		if (ins.length > 1) {
			return {
				ok: false,
				reason: `${visibleTitle(anchor)} has ${ins.length} connections leading to it, so "before step ${anchorNumber}" names more than one place.`
			};
		}
		const anchorIn = ins[0];
		anchorIn.target = moved.id;
		working.push({ ...outEdge, target: anchor.id });
	}

	const patchedNodes = graph.nodes
		.filter((node) => node.id !== moved.id)
		.map((node) => ({ ...node }));
	const movedCopy: FlowNode = { ...moved };
	const others = graph.nodes.filter((node) => node.id !== moved.id);
	movedCopy.position =
		where === 'after'
			? freeSpot(others, {
					x: anchor.position.x + COL_GAP,
					y: anchor.position.y
				})
			: freeSpot(others, {
					x: anchor.position.x - COL_GAP,
					y: anchor.position.y
				});
	patchedNodes.push(movedCopy);

	const entry = patchEntryFor(movedCopy);
	return {
		ok: true,
		value: {
			patch: { nodes: patchedNodes, edges: working },
			summary: `Move ${visibleTitle(moved)} ${where} step ${anchorNumber}`,
			added: [],
			modified: [entry],
			removed: [],
			addedIds: [],
			modifiedIds: [entry.id],
			removedIds: [],
			anchorId: moved.id
		}
	};
}

/* ---------------------------------------------------------------- rename */

/**
 * `rename 3 to Parse receipt`.
 *
 * The title is a display override on the node's own data. The kind, the id and
 * every connection stay exactly as they were, so nothing downstream of the step
 * can notice a rename.
 */
function composeRename(
	number: number,
	rawName: string,
	graph: PatchGraph
): ComposeResult {
	const node = numberToNode(graph.nodes, graph.edges).get(number);
	if (!node) return { ok: false, reason: noStepReason(number) };

	const name = rawName
		.trim()
		.replace(/^["'“”]+/, '')
		.replace(/["'“”]+$/, '')
		.trim();
	if (!name) {
		return {
			ok: false,
			reason: `Say the new title, for example "rename ${number} to Intake".`
		};
	}
	if (name.length > NAME_LIMIT) {
		return { ok: false, reason: `A title can be ${NAME_LIMIT} characters or fewer.` };
	}
	const previous = visibleTitle(node);
	if (name === previous) {
		return { ok: false, reason: `Step ${number} is already titled ${previous}.` };
	}

	const patchedNodes = graph.nodes.map((item) =>
		item.id === node.id ? { ...item, data: { ...item.data, title: name } } : { ...item }
	);
	const renamed = patchedNodes.find((item) => item.id === node.id) as FlowNode;
	const entry = patchEntryFor(renamed);

	return {
		ok: true,
		value: {
			patch: {
				nodes: patchedNodes,
				edges: graph.edges.map((edge) => ({ ...edge }))
			},
			summary: `Rename ${previous} to ${name}`,
			added: [],
			modified: [entry],
			removed: [],
			addedIds: [],
			modifiedIds: [entry.id],
			removedIds: [],
			anchorId: node.id
		}
	};
}

/* ---------------------------------------------------------------- remove */

/**
 * `remove 4` / `delete 4`.
 *
 * A removed step that has exactly one way in and one way out is spliced out:
 * its predecessor is connected straight to its successor, on the predecessor's
 * own branch handle. Anything with a branch is refused rather than guessed at,
 * because there is no single honest way to rejoin it.
 */
function composeRemove(number: number, graph: PatchGraph): ComposeResult {
	const node = numberToNode(graph.nodes, graph.edges).get(number);
	if (!node) return { ok: false, reason: noStepReason(number) };
	if (node.type === 'trigger') {
		return {
			ok: false,
			reason: 'The flow needs its trigger, so it cannot be removed.'
		};
	}

	const incoming = incomingOf(graph.edges, node.id);
	const outgoing = outgoingOf(graph.edges, node.id);
	if (incoming.length !== 1 || outgoing.length !== 1) {
		if (
			node.type === 'condition' ||
			node.type === 'switch' ||
			incoming.length > 1 ||
			outgoing.length > 1
		) {
			return { ok: false, reason: branchRefusal(node, 'remove') };
		}
		return {
			ok: false,
			reason: `Step ${number} has ${incoming.length} connections in and ${outgoing.length} out, so its neighbours cannot be rejoined.`
		};
	}

	const inEdge = incoming[0];
	const outEdge = outgoing[0];
	const patchedNodes = graph.nodes
		.filter((item) => item.id !== node.id)
		.map((item) => ({ ...item }));
	const patchedEdges = graph.edges
		.filter((edge) => edge.id !== inEdge.id && edge.id !== outEdge.id)
		.map((edge) => ({ ...edge }));
	patchedEdges.push({ ...inEdge, target: outEdge.target });

	const entry = patchEntryFor(node);
	return {
		ok: true,
		value: {
			patch: { nodes: patchedNodes, edges: patchedEdges },
			summary: `Remove step ${number}`,
			added: [],
			modified: [],
			removed: [entry],
			addedIds: [],
			modifiedIds: [],
			removedIds: [entry.id],
			anchorId: inEdge.source
		}
	};
}

/* ---------------------------------------------------------------- reading */

/**
 * Read one sentence into one candidate patch.
 *
 * Four verbs, each with one reading: `add <kind> …`, `move <n> after|before <m>`,
 * `rename <n> to <title>` and `remove|delete <n>`. A sentence that uses one of
 * those words but does not name its operands is refused with the sentence that
 * would have worked — never guessed at, and never allowed to fall through into
 * an insertion.
 */
export function composePatch(
	intent: string,
	graph: PatchGraph,
	options: { selectedId?: string | null } = {}
): ComposeResult {
	const text = intent.trim();
	if (!text) {
		return {
			ok: false,
			reason:
				'Say what to change, for example "add a delay after 2", "move 3 before 2", "rename 1 to Intake" or "remove 2".'
		};
	}

	// The first word is the verb, so a title that happens to contain "move" or
	// "remove" is still read as a title.
	const lowered = text.toLowerCase();
	const verb = lowered.split(/\s+/, 1)[0] ?? '';
	const move = verb === 'move' ? MOVE_WORDS.exec(lowered) : null;
	if (move) {
		return composeMove(
			Number(move[1]),
			move[2] === 'before' ? 'before' : 'after',
			Number(move[3]),
			graph
		);
	}
	if (verb === 'move') {
		return {
			ok: false,
			reason: 'A move names two steps: "move 3 after 2" or "move 3 before 2".'
		};
	}

	const rename = verb === 'rename' || verb === 'retitle' ? RENAME_WORDS.exec(text) : null;
	if (rename) return composeRename(Number(rename[1]), rename[2], graph);
	if (verb === 'rename' || verb === 'retitle') {
		return {
			ok: false,
			reason: 'A rename names a step and its new title: "rename 2 to Intake".'
		};
	}

	const remove = verb === 'remove' || verb === 'delete' ? REMOVE_WORDS.exec(lowered) : null;
	if (remove) return composeRemove(Number(remove[1]), graph);
	if (verb === 'remove' || verb === 'delete') {
		return {
			ok: false,
			reason: 'A removal names one step: "remove 2" or "delete step 2".'
		};
	}

	return composeInsert(intent, graph.nodes, graph.edges, options);
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

/** Every chip a composed patch draws, in banner order: added, changed, removed. */
export function allPatchEntries(
	composed: Pick<ComposedPatch, 'added' | 'modified' | 'removed'>
): PatchEntry[] {
	return [...composed.added, ...composed.modified, ...composed.removed];
}

/**
 * The same sentence the banner shows, in one line, for a screen reader.
 *
 * Pass `allPatchEntries(composed)` so a moved, renamed or removed step is named
 * here too: each list carries the chip its verb draws (`+`, `~`, `−`).
 */
export function describePatchEntries(entries: readonly PatchEntry[]): string {
	if (entries.length === 0) return 'none';
	return entries.map((entry) => entry.title).join(', ');
}
