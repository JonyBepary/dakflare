#!/usr/bin/env node
/**
 * webmcp-check — the WebMCP registration, exercised without a browser.
 *
 * Chrome's `document.modelContext` is not in this machine's verification
 * browser, so this script proves everything about `webmcp.ts` that does not need
 * Chrome: which tools it registers, their annotations, that every registration
 * shares one AbortSignal, that cleanup aborts and unregisters, that a browser
 * without the API gets a no-op, and that the declarative attribute helpers never
 * emit `toolautosubmit`.
 *
 * It imports the real modules. The only concessions to Node are:
 *   - a resolve hook for the `$lib/` alias and extensionless TS imports;
 *   - a stub for `$app/paths`, which SvelteKit normally provides;
 *   - a stubbed `document` / `navigator`.
 *
 * Run from `dashboard/`:
 *
 *   node --experimental-strip-types scripts/webmcp-check.mjs
 *
 * Exit codes follow the repo's semantics: 0 all assertions passed, 1 a check
 * failed, 2 the module could not be loaded.
 */

import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* ---------------------------------------------------------------- the alias */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD = path.resolve(HERE, '..');
const LIB_ROOT = path.join(DASHBOARD, 'src', 'lib');
const PATHS_STUB = `data:text/javascript;base64,${Buffer.from(
	'export function resolve(p) { return p; }\n'
).toString('base64')}`;

function fileIfPresent(candidate) {
	try {
		return existsSync(candidate) ? candidate : null;
	} catch {
		return null;
	}
}

// Node 22.18+ strips types on its own; the flag is passed anyway so the command
// works on older 22.x too. SvelteKit's `$lib` alias and extensionless TS imports
// are resolved here; `$app/paths` is the one SvelteKit virtual module the
// imported graph needs, and its `resolve()` returns the path unchanged in a test.
registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === '$app/paths') return { url: PATHS_STUB, shortCircuit: true };

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

/* ------------------------------------------------------------- the globe */

const REAL_NAVIGATOR = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

function setDocument(value) {
	Object.defineProperty(globalThis, 'document', {
		value,
		configurable: true,
		writable: true
	});
}

function setNavigator(value) {
	Object.defineProperty(globalThis, 'navigator', {
		value,
		configurable: true,
		writable: true
	});
}

/* ---------------------------------------------------------------- the checks */

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

const EXPECTED_NAMES = [
	'dakflare_get_flow_ast',
	'dakflare_stage_flow_patch',
	'dakflare_synthesize_pattern',
	'dakflare_diagnose_message'
];

const AST = {
	flow_id: 'wf_check',
	name: 'Check flow',
	enabled: true,
	dirty: false,
	staged_patch: null,
	graph: {
		nodes: [{ id: 'n1', kind: 'trigger' }],
		edges: []
	}
};

function makeHost(overrides = {}) {
	const staged = [];
	const host = {
		getFlowAst: () => AST,
		stagePatch: (input) => {
			staged.push(input);
			return { ok: true, message: 'Staged 1 addition for review.', added: 1, modified: 0 };
		},
		...overrides
	};
	return { host, staged };
}

function recordingContext({ withUnregister = true } = {}) {
	const registrations = [];
	const unregistered = [];
	const context = {
		registerTool(tool, options) {
			registrations.push({ tool, options });
		}
	};
	if (withUnregister) {
		context.unregisterTool = (name) => {
			unregistered.push(name);
		};
	}
	return { context, registrations, unregistered };
}

const { registerWorkflowTools, webMcpAvailable } = await import(
	pathToFileURL(path.join(LIB_ROOT, 'components', 'workflow', 'webmcp.ts')).href
).catch((error) => {
	console.error('Could not import webmcp.ts:', error);
	process.exit(2);
});

const { toolForm, toolParam } = await import(
	pathToFileURL(path.join(LIB_ROOT, 'components', 'workflow', 'webmcp-attributes.ts')).href
);

/* 1 — names, annotations, schemas. */
await check('four tools register with the expected names', async () => {
	const { host } = makeHost();
	const { context, registrations } = recordingContext();
	setDocument({ modelContext: context });
	setNavigator({});

	const cleanup = registerWorkflowTools(host);
	assert.deepEqual(
		registrations.map((entry) => entry.tool.name),
		EXPECTED_NAMES
	);
	cleanup();
});

await check('annotations mark get_flow_ast and diagnose_message read-only', async () => {
	const { host } = makeHost();
	const { context, registrations } = recordingContext();
	setDocument({ modelContext: context });
	setNavigator({});

	const cleanup = registerWorkflowTools(host);
	const byName = Object.fromEntries(registrations.map((entry) => [entry.tool.name, entry.tool]));

	for (const name of ['dakflare_get_flow_ast', 'dakflare_diagnose_message']) {
		assert.equal(byName[name].annotations.readOnlyHint, true, `${name} readOnlyHint`);
		assert.equal(byName[name].annotations.destructiveHint, false, `${name} destructiveHint`);
		assert.equal(byName[name].annotations.idempotentHint, true, `${name} idempotentHint`);
	}
	cleanup();
});

await check('stage_flow_patch is consequential and says so in its description', async () => {
	const { host } = makeHost();
	const { context, registrations } = recordingContext();
	setDocument({ modelContext: context });
	setNavigator({});

	const cleanup = registerWorkflowTools(host);
	const stage = registrations.find(
		(entry) => entry.tool.name === 'dakflare_stage_flow_patch'
	).tool;

	assert.equal(stage.annotations.readOnlyHint, false);
	assert.equal(stage.annotations.consequentialHint, true);
	assert.equal(stage.annotations.destructiveHint, true);
	assert.equal(stage.annotations.idempotentHint, false);
	assert.match(stage.description, /Consequential/);
	assert.match(stage.description, /not applied, not saved/);
	assert.deepEqual(stage.inputSchema.required, ['intent', 'patch']);
	cleanup();
});

await check('synthesize_pattern is a write-free local computation', async () => {
	const { host } = makeHost();
	const { context, registrations } = recordingContext();
	setDocument({ modelContext: context });
	setNavigator({});

	const cleanup = registerWorkflowTools(host);
	const synth = registrations.find(
		(entry) => entry.tool.name === 'dakflare_synthesize_pattern'
	).tool;

	assert.equal(synth.annotations.readOnlyHint, false);
	assert.equal(synth.annotations.destructiveHint, false);
	assert.deepEqual(synth.inputSchema.required, ['sample']);
	cleanup();
});

await check('every tool carries a description and an object input schema', async () => {
	const { host } = makeHost();
	const { context, registrations } = recordingContext();
	setDocument({ modelContext: context });
	setNavigator({});

	const cleanup = registerWorkflowTools(host);
	for (const { tool } of registrations) {
		assert.equal(typeof tool.description, 'string');
		assert.ok(tool.description.length > 40, `${tool.name} has a real description`);
		assert.equal(tool.inputSchema.type, 'object');
		assert.equal(typeof tool.execute, 'function');
	}
	cleanup();
});

/* 2 — one signal for every registration. */
await check('each registration receives the same, initially un-aborted AbortSignal', async () => {
	const { host } = makeHost();
	const { context, registrations } = recordingContext();
	setDocument({ modelContext: context });
	setNavigator({});

	const cleanup = registerWorkflowTools(host);
	assert.equal(registrations.length, 4);

	const signals = registrations.map((entry) => entry.options && entry.options.signal);
	assert.ok(signals[0] instanceof AbortSignal);
	for (const signal of signals) assert.equal(signal, signals[0]);
	assert.equal(signals[0].aborted, false);
	assert.equal(registrations.every((entry) => entry.options && 'signal' in entry.options), true);
	cleanup();
});

/* 3 — cleanup: abort and unregister, once. */
await check('cleanup aborts the shared signal and unregisters every tool', async () => {
	const { host } = makeHost();
	const { context, registrations, unregistered } = recordingContext();
	setDocument({ modelContext: context });
	setNavigator({});

	const cleanup = registerWorkflowTools(host);
	const signal = registrations[0].options.signal;

	cleanup();

	assert.equal(signal.aborted, true, 'signal aborted');
	assert.deepEqual(unregistered, EXPECTED_NAMES, 'unregisterTool called per tool');
});

await check('cleanup is idempotent', async () => {
	const { host } = makeHost();
	const { context, unregistered } = recordingContext();
	setDocument({ modelContext: context });
	setNavigator({});

	const cleanup = registerWorkflowTools(host);
	cleanup();
	cleanup();

	assert.deepEqual(unregistered, EXPECTED_NAMES);
});

await check('without unregisterTool, cleanup still aborts the signal', async () => {
	const { host } = makeHost();
	const { context, registrations, unregistered } = recordingContext({ withUnregister: false });
	setDocument({ modelContext: context });
	setNavigator({});

	const cleanup = registerWorkflowTools(host);
	assert.equal('unregisterTool' in context, false);
	cleanup();

	assert.equal(registrations[0].options.signal.aborted, true);
	assert.deepEqual(unregistered, []);
});

/* 4 — no API at all. */
await check('with no modelContext, registration is a no-op and cleanup does not throw', async () => {
	const { host } = makeHost();
	setDocument({});
	setNavigator({});

	assert.equal(webMcpAvailable(), false);
	const cleanup = registerWorkflowTools(host);
	assert.equal(typeof cleanup, 'function');
	assert.doesNotThrow(() => cleanup());
});

await check('with no document and no navigator.modelContext, cleanup does not throw', async () => {
	const { host } = makeHost();
	delete globalThis.document;
	setNavigator({});

	const cleanup = registerWorkflowTools(host);
	assert.equal(webMcpAvailable(), false);
	assert.doesNotThrow(() => cleanup());
});

await check('navigator.modelContext is used when document.modelContext is absent', async () => {
	const { host } = makeHost();
	const { context, registrations } = recordingContext();
	setDocument({});
	setNavigator({ modelContext: context });

	const cleanup = registerWorkflowTools(host);
	assert.deepEqual(
		registrations.map((entry) => entry.tool.name),
		EXPECTED_NAMES
	);
	assert.equal(webMcpAvailable(), true);
	cleanup();
});

await check('a context without registerTool is treated as absent', async () => {
	const { host } = makeHost();
	const { context, registrations } = recordingContext();
	delete context.registerTool;
	setDocument({ modelContext: context });
	setNavigator({});

	const cleanup = registerWorkflowTools(host);
	assert.equal(registrations.length, 0);
	assert.equal(webMcpAvailable(), false);
	cleanup();
});

/* 5 — the tools actually run against the host. */
await check('get_flow_ast returns the live graph from the host', async () => {
	const { host } = makeHost();
	const { context, registrations } = recordingContext();
	setDocument({ modelContext: context });
	setNavigator({});

	const cleanup = registerWorkflowTools(host);
	const tool = registrations.find((entry) => entry.tool.name === 'dakflare_get_flow_ast').tool;
	const answer = await tool.execute({});

	assert.equal(answer.content[0].type, 'text');
	assert.deepEqual(JSON.parse(answer.content[0].text), AST);
	cleanup();
});

await check('stage_flow_patch hands intent and patch to the editor and reports staging', async () => {
	const { host, staged } = makeHost();
	const { context, registrations } = recordingContext();
	setDocument({ modelContext: context });
	setNavigator({});

	const cleanup = registerWorkflowTools(host);
	const tool = registrations.find(
		(entry) => entry.tool.name === 'dakflare_stage_flow_patch'
	).tool;
	const patch = { nodes: [{ id: 'delay-1', kind: 'delay' }], edges: [] };
	const answer = await tool.execute({ intent: 'add a delay', patch });

	assert.deepEqual(staged, [{ intent: 'add a delay', patch }]);
	assert.notEqual(answer.isError, true);
	const body = JSON.parse(answer.content[0].text);
	assert.equal(body.ok, true);
	assert.equal(body.added, 1);
	cleanup();
});

await check('a refused stage is reported as an error, not a success', async () => {
	const { host } = makeHost({
		stagePatch: () => ({
			ok: false,
			message: 'Node ids must be unique.',
			added: 0,
			modified: 0
		})
	});
	const { context, registrations } = recordingContext();
	setDocument({ modelContext: context });
	setNavigator({});

	const cleanup = registerWorkflowTools(host);
	const tool = registrations.find(
		(entry) => entry.tool.name === 'dakflare_stage_flow_patch'
	).tool;
	const answer = await tool.execute({ intent: 'add', patch: { nodes: [], edges: [] } });

	assert.equal(answer.isError, true);
	assert.match(answer.content[0].text, /unique/);
	cleanup();
});

/* 6 — declarative attributes. */
await check('toolForm emits toolname and tooldescription only', async () => {
	const attrs = toolForm('dakflare_ask_agent', 'Ask the agent for one change.');
	assert.deepEqual(attrs, {
		toolname: 'dakflare_ask_agent',
		tooldescription: 'Ask the agent for one change.'
	});
	assert.equal('toolautosubmit' in attrs, false);
});

await check('toolParam emits toolparamtitle and toolparamdescription only', async () => {
	const attrs = toolParam('Intent', 'The change the operator wants.');
	assert.deepEqual(attrs, {
		toolparamtitle: 'Intent',
		toolparamdescription: 'The change the operator wants.'
	});
	assert.equal('toolautosubmit' in attrs, false);
});

await check('a mutating form never gets toolautosubmit', async () => {
	for (const [name, description] of [
		['dakflare_ask_agent', 'Ask the agent for one change.'],
		['dakflare_autotag_spans', 'Tag the highlighted parts of the sample.']
	]) {
		const form = { ...toolForm(name, description), ...toolParam('Intent', 'One sentence.') };
		assert.equal('toolautosubmit' in form, false, `${name} must not auto-submit`);
		assert.equal(form.toolname, name);
		assert.ok(form.toolparamdescription);
	}
});

await check('the editor forms in source carry no toolautosubmit attribute', async () => {
	for (const file of ['StepFinder.svelte', 'PatternSheet.svelte']) {
		const source = await readFile(
			path.join(LIB_ROOT, 'components', 'workflow', file),
			'utf8'
		);
		assert.equal(
			/toolautosubmit/i.test(source),
			false,
			`${file} must not auto-submit a mutating form`
		);
	}
});

/* ----------------------------------------------------------------------- end */

// Restore the host globals we replaced, so a future import in this process sees
// Node's own navigator again.
if (REAL_NAVIGATOR) Object.defineProperty(globalThis, 'navigator', REAL_NAVIGATOR);
delete globalThis.document;

const failed = results.filter((entry) => !entry.ok);
console.log('');
console.log(`# ${results.length - failed.length} passed, ${failed.length} failed`);
process.exitCode = failed.length === 0 ? 0 : 1;
