#!/usr/bin/env node
/**
 * agent-patch-check — the four patch verbs, composed without a browser.
 *
 * The console's palette reads an operator's sentence into one candidate patch.
 * Until now it understood only insertions; this proves the other three verbs too:
 * that a move rewires both sides of the seam, that a rename touches the title and
 * nothing else, that a removal splices its neighbours back together and refuses a
 * branch, that every verb's summary is stable (the Worker hashes it into the apply
 * token), and that none of them mutate the graph they were read against.
 *
 * It imports the real `agent-patch.ts`. The only concession to Node is the same
 * resolve hook `webmcp-check.mjs` uses for the `$lib/` alias and extensionless TS
 * imports.
 *
 * Run from `dashboard/`:
 *
 *   node --experimental-strip-types scripts/agent-patch-check.mjs
 *
 * Exit codes follow the repo's semantics: 0 all assertions passed, 1 a check
 * failed, 2 the module could not be loaded.
 */

import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* ---------------------------------------------------------------- the alias */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD = path.resolve(HERE, '..');
const LIB_ROOT = path.join(DASHBOARD, 'src', 'lib');

function fileIfPresent(candidate) {
	try {
		return existsSync(candidate) ? candidate : null;
	} catch {
		return null;
	}
}

registerHooks({
	resolve(specifier, context, nextResolve) {
		let base = null;
		if (specifier.startsWith('$lib/')) {
			base = path.join(LIB_ROOT, specifier.slice(5));
		} else if (
			(specifier.startsWith('./') || specifier.startsWith('../')) &&
			context.parentURL &&
			context.parentURL.startsWith('file:') &&
			!path.extname(specifier)
		) {
			base = path.resolve(path.dirname(fileURLToPath(context.parentURL)), specifier);
		}

		if (base) {
			for (const candidate of [base, `${base}.ts`, path.join(base, 'index.ts')]) {
				const found = fileIfPresent(candidate);
				if (found) return { url: pathToFileURL(found).href, shortCircuit: true };
			}
		}
		return nextResolve(specifier, context);
	}
});

/* ------------------------------------------------------------- the harness */

const results = [];

async function check(name, fn) {
	try {
		await fn();
		results.push({ name, ok: true });
		console.log(`ok - ${name}`);
	} catch (error) {
		results.push({ name, ok: false, error });
		console.log(`not ok - ${name}`);
		console.log(`  ${String(error && error.message ? error.message : error).replace(/\n/g, '\n  ')}`);
	}
}

const { composePatch, allPatchEntries, describePatchEntries } = await import(
	pathToFileURL(path.join(LIB_ROOT, 'components', 'workflow', 'agent-patch.ts')).href
).catch((error) => {
	console.error('Could not import agent-patch.ts:', error);
	process.exit(2);
});

/* ------------------------------------------------------------- the fixtures */

function makeNode(id, type, x, y, data) {
	return { id, type, position: { x, y }, data };
}

function makeEdge(id, source, target, sourceHandle) {
	const edge = { id, source, target };
	if (sourceHandle !== undefined) edge.sourceHandle = sourceHandle;
	return edge;
}

/** Four steps, one chain: Trigger → Extract → Delay → Send SMS. */
function linearFlow() {
	return {
		nodes: [
			makeNode('t1', 'trigger', 40, 120, {
				kind: 'incoming',
				sender: { mode: 'any' },
				body: { mode: 'any' }
			}),
			makeNode('x2', 'extract', 320, 120, {
				source: 'body',
				pattern: '(?<order>[A-Z]+)',
				flags: ''
			}),
			makeNode('d3', 'delay', 600, 120, { seconds: 30 }),
			makeNode('s4', 'send_sms', 880, 120, { to: '{{sender}}', body: 'thanks' })
		],
		edges: [makeEdge('e1', 't1', 'x2'), makeEdge('e2', 'x2', 'd3'), makeEdge('e3', 'd3', 's4')]
	};
}

/** Four steps with one branch: Trigger → Condition → (true) Send SMS / (false) Stop. */
function branchingFlow() {
	return {
		nodes: [
			makeNode('t1', 'trigger', 40, 120, {
				kind: 'incoming',
				sender: { mode: 'any' },
				body: { mode: 'any' }
			}),
			makeNode('c2', 'condition', 320, 120, { left: 'order', op: 'exists' }),
			makeNode('s3', 'send_sms', 600, 40, { to: '{{sender}}', body: 'yes' }),
			makeNode('p4', 'stop', 600, 200, { reason: '' })
		],
		edges: [
			makeEdge('e1', 't1', 'c2'),
			makeEdge('e2', 'c2', 's3', 'true'),
			makeEdge('e3', 'c2', 'p4', 'false')
		]
	};
}

function snapshot(graph) {
	return JSON.parse(JSON.stringify(graph));
}

function patchOf(result) {
	assert.equal(result.ok, true, `expected a patch, got: ${result.ok ? '' : result.reason}`);
	return result.value;
}

function hasEdge(edges, source, target) {
	return edges.some((edge) => edge.source === source && edge.target === target);
}

function idsOf(nodes) {
	return nodes.map((node) => node.id).sort();
}

/** A verb may add ids, and may drop the ids it removes; it may never rewrite one. */
function assertIdsKept(original, result) {
	const patched = new Set(result.patch.nodes.map((node) => node.id));
	for (const node of original.nodes) {
		if (result.removedIds.includes(node.id)) {
			assert.equal(patched.has(node.id), false, `${node.id} was removed, not rewritten`);
			continue;
		}
		assert.equal(patched.has(node.id), true, `${node.id} keeps its id`);
	}
}

/* ----------------------------------------------------------- insertions */

await check('insert after rewires the anchor to the new step', async () => {
	const graph = linearFlow();
	const before = snapshot(graph);
	const value = patchOf(composePatch('add a delay after 2', graph));
	const addedId = value.addedIds[0];

	assert.equal(value.patch.nodes.length, 5);
	assert.equal(value.patch.nodes.find((node) => node.id === addedId).type, 'delay');
	assert.ok(hasEdge(value.patch.edges, 'x2', addedId), 'anchor leads to the new step');
	assert.ok(hasEdge(value.patch.edges, addedId, 'd3'), 'new step leads where the anchor led');
	assert.equal(hasEdge(value.patch.edges, 'x2', 'd3'), false, 'old edge was rerouted');
	assert.deepEqual(value.added.map((entry) => entry.title), ['Delay']);
	assert.match(value.summary, /^Add a Delay step after step 2,/);
	assertIdsKept(graph, value);
	assert.deepEqual(graph, before, 'the input graph is untouched');
});

await check('insert before moves the incoming connection to the new step', async () => {
	const graph = linearFlow();
	const before = snapshot(graph);
	const value = patchOf(composePatch('add a webhook before step 3', graph));
	const addedId = value.addedIds[0];

	assert.equal(value.patch.nodes.length, 5);
	assert.equal(value.patch.nodes.find((node) => node.id === addedId).type, 'webhook');
	assert.ok(hasEdge(value.patch.edges, 'x2', addedId), 'predecessor leads to the new step');
	assert.ok(hasEdge(value.patch.edges, addedId, 'd3'), 'new step leads to the anchor');
	assert.equal(hasEdge(value.patch.edges, 'x2', 'd3'), false);
	assert.match(value.summary, /^Add a Webhook step before step 3,/);
	assert.deepEqual(graph, before);
});

await check('insert at the end appends after the last step', async () => {
	const graph = linearFlow();
	const before = snapshot(graph);
	const value = patchOf(composePatch('add a send sms at the end', graph));
	const addedId = value.addedIds[0];

	assert.equal(value.patch.nodes.length, 5);
	assert.ok(hasEdge(value.patch.edges, 's4', addedId), 'last step leads to the new step');
	assert.equal(value.patch.edges.filter((edge) => edge.source === addedId).length, 0);
	assert.deepEqual(graph, before);
});

/* --------------------------------------------------------------- moves */

await check('move rewires the moved step in and out of the chain', async () => {
	const graph = linearFlow();
	const before = snapshot(graph);
	const value = patchOf(composePatch('move 2 after 3', graph));

	assert.equal(value.summary, 'Move Extract after step 3');
	assert.equal(value.patch.nodes.length, 4);
	assert.deepEqual(idsOf(value.patch.nodes), ['d3', 's4', 't1', 'x2'], 'ids are not rewritten');
	assert.ok(hasEdge(value.patch.edges, 't1', 'd3'), 'the gap is closed');
	assert.ok(hasEdge(value.patch.edges, 'd3', 'x2'), 'anchor leads to the moved step');
	assert.ok(hasEdge(value.patch.edges, 'x2', 's4'), 'moved step leads to the old successor');
	assert.equal(hasEdge(value.patch.edges, 't1', 'x2'), false, 'old incoming edge is gone');
	assert.equal(hasEdge(value.patch.edges, 'x2', 'd3'), false, 'old outgoing edge is gone');
	assert.equal(value.patch.edges.filter((edge) => edge.target === 'x2').length, 1);
	assert.equal(value.patch.edges.filter((edge) => edge.source === 'x2').length, 1);
	assert.deepEqual(value.modifiedIds, ['x2']);
	assert.deepEqual(
		value.patch.edges.map((edge) => edge.id).sort(),
		graph.edges.map((edge) => edge.id).sort(),
		'edges are rewired, not replaced'
	);
	assert.equal(describePatchEntries(allPatchEntries(value)), 'Extract');

	const moved = value.patch.nodes.find((node) => node.id === 'x2');
	assert.notDeepEqual(moved.position, { x: 320, y: 120 }, 'the card moves near its new place');
	assertIdsKept(graph, value);
	assert.deepEqual(graph, before, 'the input graph is untouched');
});

await check('move before rewires the anchor between the moved step and itself', async () => {
	const graph = linearFlow();
	const before = snapshot(graph);
	const value = patchOf(composePatch('move 2 before 4', graph));

	assert.equal(value.summary, 'Move Extract before step 4');
	// t1 → d3 → x2 → s4
	assert.ok(hasEdge(value.patch.edges, 't1', 'd3'), 'the gap is closed');
	assert.ok(hasEdge(value.patch.edges, 'd3', 'x2'), 'the predecessor leads to the moved step');
	assert.ok(hasEdge(value.patch.edges, 'x2', 's4'), 'the moved step leads to the anchor');
	assert.equal(hasEdge(value.patch.edges, 't1', 'x2'), false);
	assert.equal(hasEdge(value.patch.edges, 'x2', 'd3'), false);
	assert.deepEqual(graph, before);
});

await check('move refuses a position that is not on this flow', async () => {
	for (const [sentence, pattern] of [
		['move 2 after 9', /no step 9/],
		['move 1 after 3', /trigger/i],
		['move 2 after 2', /itself/],
		['move 3 after 4', /last step/]
	]) {
		const result = composePatch(sentence, linearFlow());
		assert.equal(result.ok, false, `${sentence} must be refused`);
		assert.match(result.reason, pattern, `${sentence} explains why`);
	}
});

await check('move refuses a branching step and a branch anchor', async () => {
	const branchStep = composePatch('move 2 after 3', branchingFlow());
	assert.equal(branchStep.ok, false);
	assert.match(branchStep.reason, /branch/i);

	const branchAnchor = composePatch('move 3 after 2', branchingFlow());
	assert.equal(branchAnchor.ok, false);
	assert.match(branchAnchor.reason, /branch/i);
});

/* -------------------------------------------------------------- renames */

await check('rename changes the title only', async () => {
	const graph = linearFlow();
	const before = snapshot(graph);
	const value = patchOf(composePatch('rename 3 to Parse receipt', graph));
	const renamed = value.patch.nodes.find((node) => node.id === 'd3');

	assert.equal(value.summary, 'Rename Delay to Parse receipt');
	assert.equal(renamed.id, 'd3', 'the id is unchanged');
	assert.equal(renamed.type, 'delay', 'the kind is unchanged');
	assert.equal(renamed.data.title, 'Parse receipt');
	assert.deepEqual(
		value.patch.edges,
		graph.edges,
		'every connection is exactly the one before the rename'
	);
	assert.deepEqual(value.addedIds, []);
	assert.deepEqual(value.modifiedIds, ['d3']);
	assert.equal(describePatchEntries(allPatchEntries(value)), 'Parse receipt');
	assert.deepEqual(idsOf(value.patch.nodes), idsOf(graph.nodes), 'no id was rewritten');
	assert.deepEqual(graph, before, 'the input graph is untouched');
});

await check('rename refuses a step with no title on this flow', async () => {
	const missing = composePatch('rename 9 to Anything', linearFlow());
	assert.equal(missing.ok, false);
	assert.match(missing.reason, /no step 9/);

	const blank = composePatch('rename 2 to', linearFlow());
	assert.equal(blank.ok, false);
	assert.match(blank.reason, /rename 2 to/);
});

/* ------------------------------------------------------------- removals */

await check('remove with one in and one out reconnects the neighbours', async () => {
	const graph = linearFlow();
	const before = snapshot(graph);
	const value = patchOf(composePatch('remove step 3', graph));

	assert.equal(value.summary, 'Remove step 3');
	assert.equal(value.patch.nodes.length, 3);
	assert.equal(value.patch.nodes.some((node) => node.id === 'd3'), false);
	assert.ok(hasEdge(value.patch.edges, 'x2', 's4'), 'the neighbours are joined');
	assert.equal(value.patch.edges.some((edge) => edge.source === 'd3' || edge.target === 'd3'), false);
	assert.deepEqual(value.removedIds, ['d3']);
	const spliced = value.patch.edges.find((edge) => edge.id === 'e2');
	assert.ok(spliced, 'the incoming edge keeps its id');
	assert.equal(spliced.source, 'x2');
	assert.equal(spliced.target, 's4');
	assert.equal(describePatchEntries(allPatchEntries(value)), 'Delay');
	assertIdsKept(graph, value);
	assert.deepEqual(graph, before, 'the input graph is untouched');
});

await check('remove refuses a branching step', async () => {
	const graph = branchingFlow();
	const before = snapshot(graph);
	const result = composePatch('remove 2', graph);

	assert.equal(result.ok, false);
	assert.match(result.reason, /branch/i);
	assert.deepEqual(graph, before, 'a refusal changes nothing');
});

await check('remove refuses the trigger', async () => {
	const result = composePatch('delete step 1', linearFlow());
	assert.equal(result.ok, false);
	assert.match(result.reason, /trigger/);
});

/* ------------------------------------------------- every verb, one summary */

await check('every verb yields the same summary across two runs', async () => {
	const graph = linearFlow();
	for (const sentence of [
		'add a delay after 2',
		'move 2 after 3',
		'rename 3 to Parse receipt',
		'remove step 3'
	]) {
		const first = composePatch(sentence, graph);
		const second = composePatch(sentence, graph);
		assert.equal(first.ok, true, `${sentence} composes`);
		assert.equal(second.ok, true, `${sentence} composes again`);
		assert.equal(first.value.summary, second.value.summary, `${sentence} keeps its summary`);
		assert.equal(typeof first.value.summary, 'string');
		assert.ok(first.value.summary.length > 0);
		if (!sentence.startsWith('add ')) {
			// Without a generated id there is nothing left to differ: a move,
			// rename or removal composes the same graph twice.
			assert.deepEqual(first.value.patch, second.value.patch);
		}
	}
});

await check('a sentence it cannot read changes nothing and says why', async () => {
	const graph = linearFlow();
	const before = snapshot(graph);
	for (const sentence of ['move the delay', 'rename step 3', 'delete', 'make it nicer']) {
		const result = composePatch(sentence, graph);
		assert.equal(result.ok, false, `${sentence} is refused`);
		assert.equal(typeof result.reason, 'string');
		assert.ok(result.reason.length > 0);
	}
	assert.deepEqual(graph, before);
});

/* ------------------------------------------------------------------ end */

const failed = results.filter((entry) => !entry.ok);
console.log('');
console.log(`# ${results.length - failed.length} passed, ${failed.length} failed`);
process.exitCode = failed.length === 0 ? 0 : 1;
