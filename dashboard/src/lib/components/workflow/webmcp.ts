/**
 * WebMCP tools for the workflow editor.
 *
 * WebMCP (W3C, Chrome origin trial) lets a page declare what an agent may do
 * here, instead of leaving the agent to guess from the DOM. The contract is
 * small and we follow it literally:
 *
 *   const ctx = document.modelContext ?? navigator.modelContext
 *   ctx.registerTool(tool, { signal })    // unregistered when the signal aborts
 *   ctx.unregisterTool?.(tool.name)       // the older shape, for a build without signals
 *
 * Every registration is a progressive enhancement: a browser without the API
 * gets a no-op cleanup and the editor behaves exactly as before. Registration is
 * also scoped to this editor's lifetime — one controller per mount, aborted on
 * destroy — so the tools never outlive the flow they describe.
 *
 * What the four tools may do is deliberately narrow:
 *
 *   dakflare_get_flow_ast      read the open graph. Nothing is written.
 *   dakflare_stage_flow_patch  put a patch in the ghost banner. It is staging,
 *                              not applying: a person still accepts it.
 *   dakflare_synthesize_pattern  compile a pattern from a sample, in the page.
 *   dakflare_diagnose_message  ask the gateway why one message failed.
 *
 * None of them saves a flow. `stage_flow_patch` is the one that changes what the
 * operator sees, which is why it is annotated as consequential and named that
 * way in its description.
 */

import { synthesizeTemplate, type TemplateSpan } from '$lib/workflow/wasm-engine';
import { diagnoseMessage, unavailableCopy, type AgentOutcome } from './agent';

/** The slice of `document.modelContext` this module uses. */
interface ModelContext {
	registerTool?: (
		tool: WebMcpTool,
		options?: { signal?: AbortSignal }
	) => Promise<void> | void;
	unregisterTool?: (name: string) => Promise<void> | void;
}

interface WebMcpTool {
	name: string;
	description: string;
	inputSchema?: Record<string, unknown>;
	annotations?: {
		readOnlyHint?: boolean;
		destructiveHint?: boolean;
		idempotentHint?: boolean;
		openWorldHint?: boolean;
	};
	execute: (
		input: Record<string, unknown>,
		options?: { signal?: AbortSignal }
	) => Promise<unknown>;
}

interface WebMcpGlobal {
	modelContext?: ModelContext;
}

/**
 * `document.modelContext` is the current home of the API; `navigator.modelContext`
 * is where the earlier preview put it. Ask the document first, then the
 * navigator, and treat anything without `registerTool` as absent.
 */
function modelContext(): ModelContext | null {
	if (typeof document !== 'undefined') {
		const fromDocument = (document as unknown as WebMcpGlobal).modelContext;
		if (fromDocument && typeof fromDocument.registerTool === 'function') return fromDocument;
	}
	if (typeof navigator !== 'undefined') {
		const fromNavigator = (navigator as unknown as WebMcpGlobal).modelContext;
		if (fromNavigator && typeof fromNavigator.registerTool === 'function') return fromNavigator;
	}
	return null;
}

/** True when this browser exposes WebMCP at all. Useful for a debug line. */
export function webMcpAvailable(): boolean {
	return modelContext() !== null;
}

/** What the editor hands the tools. Both read the live editor, not a copy. */
export interface WorkflowToolHost {
	getFlowAst(): unknown;
	stagePatch(input: { intent: string; patch: unknown }): {
		ok: boolean;
		message: string;
		added: number;
		modified: number;
	};
}

function text(value: unknown): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
	return {
		content: [
			{
				type: 'text',
				text: typeof value === 'string' ? value : JSON.stringify(value, null, 2)
			}
		]
	};
}

function refuse(message: string) {
	return {
		content: [{ type: 'text' as const, text: message }],
		isError: true
	};
}

/** A sample's spans, either supplied by the agent or found here. */
function readSpans(value: unknown): TemplateSpan[] | null {
	if (value === undefined || value === null) return null;
	if (!Array.isArray(value)) return null;
	const spans: TemplateSpan[] = [];
	for (const entry of value) {
		if (!entry || typeof entry !== 'object') continue;
		const span = entry as Record<string, unknown>;
		const start = typeof span.start === 'number' ? span.start : NaN;
		const end = typeof span.end === 'number' ? span.end : NaN;
		if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
		const role = span.role === 'trigger' || span.role === 'ignore' ? span.role : 'extract';
		spans.push({
			role,
			name: typeof span.name === 'string' && span.name ? span.name : `field_${spans.length + 1}`,
			start,
			end,
			...(typeof span.slot_type === 'string' ? { slot_type: span.slot_type } : {})
		});
	}
	return spans;
}

function buildTools(host: WorkflowToolHost): WebMcpTool[] {
	return [
		{
			name: 'dakflare_get_flow_ast',
			description:
				'Reads the workflow open in the editor: its id, name, and the full graph of steps and connections in the DakFlare workflow contract. Read-only; nothing is changed.',
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			inputSchema: { type: 'object', properties: {}, additionalProperties: false },
			async execute() {
				return text(host.getFlowAst());
			}
		},
		{
			name: 'dakflare_stage_flow_patch',
			description:
				'Stages one patch to the workflow that is open, so a person can review it as a preview on the map and in the outline. Consequential: the editor changes what it shows, but the patch is not applied, not saved, and the operator must still accept it. Replaces any patch already staged.',
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
			inputSchema: {
				type: 'object',
				properties: {
					intent: {
						type: 'string',
						description:
							'What the patch is for, in one sentence, in the operator’s words.'
					},
					patch: {
						type: 'object',
						description:
							'The proposed graph: { "nodes": [...], "edges": [...] } in the workflow contract. Node ids must be unique.',
						properties: {
							nodes: { type: 'array', items: { type: 'object' } },
							edges: { type: 'array', items: { type: 'object' } }
						},
						required: ['nodes', 'edges']
					}
				},
				required: ['intent', 'patch']
			},
			async execute(input) {
				const intent = typeof input.intent === 'string' ? input.intent : '';
				const result = host.stagePatch({ intent, patch: input.patch });
				return result.ok ? text(result) : refuse(result.message);
			}
		},
		{
			name: 'dakflare_synthesize_pattern',
			description:
				'Builds an extraction pattern from one sample SMS in the page, entirely on this device. Returns the pattern, its capture groups and whether it compiles. Nothing is saved.',
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
			inputSchema: {
				type: 'object',
				properties: {
					sample: { type: 'string', description: 'The full SMS body to build the pattern from.' },
					spans: {
						type: 'array',
						description:
							'Optional parts of the message to keep, as { start, end, role, name }. Offsets are character positions in the sample. Omit to let the page find them.',
						items: {
							type: 'object',
							properties: {
								start: { type: 'number' },
								end: { type: 'number' },
								role: { type: 'string', enum: ['trigger', 'extract', 'ignore'] },
								name: { type: 'string' },
								slot_type: { type: 'string' }
							},
							required: ['start', 'end']
						}
					}
				},
				required: ['sample']
			},
			async execute(input) {
				const sample = typeof input.sample === 'string' ? input.sample : '';
				if (!sample.trim()) return refuse('The sample message is empty.');
				const spans = readSpans(input.spans);
				const result = await synthesizeTemplate(sample, spans ?? []);
				if (!result.ok) {
					return refuse(result.message ?? 'That sample could not be turned into a pattern.');
				}
				return text({
					pattern: result.result?.pattern ?? '',
					variables: result.result?.variables ?? [],
					trigger_phrases: result.result?.trigger_phrases ?? []
				});
			}
		},
		{
			name: 'dakflare_diagnose_message',
			description:
				'Asks the gateway why one message did not behave: invisible characters, a pattern that no longer matches, a dead approval, a spoofed balance or a failed webhook. Returns one root cause. Read-only.',
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
			inputSchema: {
				type: 'object',
				properties: {
					message: { type: 'string', description: 'The SMS body to diagnose.' },
					pattern: {
						type: 'string',
						description: 'Optional extraction pattern to test the body against.'
					}
				},
				required: ['message']
			},
			async execute(input) {
				const message = typeof input.message === 'string' ? input.message : '';
				if (!message.trim()) return refuse('The message is empty.');
				const pattern = typeof input.pattern === 'string' ? input.pattern : undefined;
				const answer: AgentOutcome<unknown> = pattern
					? await diagnoseMessage({ message, pattern })
					: await diagnoseMessage({ message });
				if (answer.status === 'unavailable') {
					return refuse(unavailableCopy(answer.reason));
				}
				if (answer.status === 'refused') return refuse(answer.message);
				return text(answer.data);
			}
		}
	];
}

/**
 * Register the four tools for as long as the caller keeps the returned cleanup.
 *
 * Safe to call anywhere: with no WebMCP in the browser it registers nothing and
 * returns a cleanup that does nothing. `AbortController` is created before the
 * first registration, so a component that unmounts while a registration is still
 * resolving still ends up with no tools.
 */
export function registerWorkflowTools(host: WorkflowToolHost): () => void {
	const context = modelContext();
	if (!context) return () => {};

	const controller = new AbortController();
	const names: string[] = [];

	for (const tool of buildTools(host)) {
		try {
			const pending = context.registerTool?.(tool, { signal: controller.signal });
			names.push(tool.name);
			if (pending && typeof (pending as Promise<void>).catch === 'function') {
				(pending as Promise<void>).catch(() => {
					// A refused registration is not the editor's problem: the tool is
					// simply not offered. The page keeps working.
				});
			}
		} catch {
			// Registration is an enhancement, never a precondition.
		}
	}

	let done = false;
	return () => {
		if (done) return;
		done = true;
		// The current API unregisters on abort; the earlier preview wanted a name.
		try {
			controller.abort();
		} catch {
			// Nothing to do: an already-aborted signal is still a valid teardown.
		}
		for (const name of names) {
			try {
				const pending = context.unregisterTool?.(name);
				if (pending && typeof (pending as Promise<void>).catch === 'function') {
					(pending as Promise<void>).catch(() => {});
				}
			} catch {
				// Same as above: a missing or failing unregister leaves the abort.
			}
		}
	};
}
