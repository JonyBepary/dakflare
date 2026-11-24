import type { WorkflowPatchHandoff } from '$lib/assistant';
import type { AgentJudgement } from '$lib/components/workflow/agent';
import type { Device, Workflow, WorkflowIssue } from '$lib/types';
import type { StateGroup } from './StateSwitcher.svelte';

export type WorkflowEditStateKey =
	| 'loading'
	| 'not-found'
	| 'load-error'
	| 'new-draft'
	| 'empty-steps'
	| 'steps-populated'
	| 'steps-inspector'
	| 'steps-extract-sample'
	| 'map-populated'
	| 'map-inspector'
	| 'map-unsupported'
	| 'checks-clean'
	| 'checks-issues'
	| 'preview-idle'
	| 'preview-delivered'
	| 'preview-filtered'
	| 'settings-open'
	| 'add-palette'
	| 'source-readonly'
	| 'source-error'
	| 'finder-steps'
	| 'finder-agent'
	| 'finder-agent-unavailable'
	| 'ghost-judged-approval'
	| 'ghost-missing-token'
	| 'ghost-unjudged'
	| 'ghost-blocking-problems'
	| 'dirty-unsaved'
	| 'saving'
	| 'save-error'
	| 'server-rejected'
	| 'leave-confirm'
	| 'member-session'
	| 'member-draft'
	| 'member-ghost';

export type WorkflowSurface = 'steps' | 'map';

export interface WorkflowEditScenario {
	key: WorkflowEditStateKey;
	label: string;
	/** The account the stubbed session answers as. Defaults to an owner. */
	role?: 'owner' | 'member';
	id: string;
	surface: WorkflowSurface;
	getReply?:
		| { kind: 'ok'; workflow: Workflow }
		| { kind: 'not_found' }
		| { kind: 'error'; status: number; message: string }
		| { kind: 'hold' };
	putReply?:
		| { kind: 'ok'; workflow: Workflow }
		| { kind: 'invalid'; details: WorkflowIssue[] }
		| { kind: 'error'; status: number; message: string }
		| { kind: 'hold' };
	synthesizeReply?:
		| { kind: 'ok'; judgement: AgentJudgement }
		| { kind: 'unavailable'; status: number; message: string };
	externalPatch?: WorkflowPatchHandoff;
}

export const WORKFLOW_EDIT_GROUPS: ReadonlyArray<StateGroup> = [
	{
		heading: 'Document',
		states: [
			{ key: 'loading', label: 'Loading workflow' },
			{ key: 'not-found', label: 'Workflow not found (404)' },
			{ key: 'load-error', label: 'Load failed (500)' },
			{ key: 'new-draft', label: 'New draft' },
			{ key: 'empty-steps', label: 'Empty graph' }
		]
	},
	{
		heading: 'Steps & Map',
		states: [
			{ key: 'steps-populated', label: 'Steps outline (shared)' },
			{ key: 'steps-inspector', label: 'Steps inspector (UCS-2)' },
			{ key: 'steps-extract-sample', label: 'Pattern builder sheet' },
			{ key: 'map-populated', label: 'Map canvas' },
			{ key: 'map-inspector', label: 'Map inspector drawer' },
			{ key: 'map-unsupported', label: 'Unsupported step on Map' }
		]
	},
	{
		heading: 'Checks & Preview',
		states: [
			{ key: 'checks-clean', label: 'Checks passed' },
			{ key: 'checks-issues', label: 'Checks with issues (>6)' },
			{ key: 'preview-idle', label: 'Preview drawer idle' },
			{ key: 'preview-delivered', label: 'Preview matched (WASM)' },
			{ key: 'preview-filtered', label: 'Preview filtered out' }
		]
	},
	{
		heading: 'Overlays & Source',
		states: [
			{ key: 'settings-open', label: 'Flow settings drawer' },
			{ key: 'add-palette', label: 'Add step palette' },
			{ key: 'source-readonly', label: 'Source JSON sheet' },
			{ key: 'source-error', label: 'Source JSON parse error' },
			{ key: 'finder-steps', label: 'Step finder' },
			{ key: 'finder-agent', label: 'Agent mode (judged)' },
			{ key: 'finder-agent-unavailable', label: 'Agent unavailable (503)' }
		]
	},
	{
		heading: 'Agent Patches (Ghost)',
		states: [
			{ key: 'ghost-judged-approval', label: 'Judged patch + token' },
			{ key: 'ghost-missing-token', label: 'Approval without token' },
			{ key: 'ghost-unjudged', label: 'Unjudged external patch' },
			{ key: 'ghost-blocking-problems', label: 'Patch with blocking error' }
		]
	},
	{
		heading: 'Saving',
		states: [
			{ key: 'dirty-unsaved', label: 'Unsaved changes' },
			{ key: 'saving', label: 'Saving in flight' },
			{ key: 'save-error', label: 'Save failed (502)' },
			{ key: 'server-rejected', label: 'Gateway rejected graph' },
			{ key: 'leave-confirm', label: 'Unsaved leave guard' }
		]
	},
	{
		heading: 'Session',
		states: [
			{ key: 'member-session', label: 'Member session (read-only)' },
			{ key: 'member-draft', label: 'Member session, new workflow' },
			{ key: 'member-ghost', label: 'Member session, staged patch' }
		]
	}
];

export const DEFAULT_WORKFLOW_EDIT_STATE: WorkflowEditStateKey = 'steps-populated';

const VALID_KEYS = new Set<string>(
	WORKFLOW_EDIT_GROUPS.flatMap((group) => group.states.map((item) => item.key))
);

export function isWorkflowEditState(value: string | null): value is WorkflowEditStateKey {
	return value !== null && VALID_KEYS.has(value);
}

const NOW = Date.now();

export const SAMPLE_DEVICES: Device[] = [
	{
		device_id: 'dev_px6a_desk_01',
		label: 'Pixel 6a · Desk',
		fcm_token: 'fcm_px6a_live',
		paired_at: NOW - 12 * 86_400_000,
		last_seen: NOW - 18_000,
		sim_slot: 1,
		archived_at: null,
		revoked_at: null
	},
	{
		device_id: 'dev_ga54_field_02',
		label: 'Galaxy A54 · Field',
		fcm_token: 'fcm_ga54_live',
		paired_at: NOW - 5 * 86_400_000,
		last_seen: NOW - 3 * 60_000,
		sim_slot: 2,
		archived_at: null,
		revoked_at: null
	}
];

export const BKASH_WORKFLOW: Workflow = {
	id: 'wf_bkash_order_01',
	name: 'bKash Payment Confirmation',
	enabled: true,
	device_id: 'dev_px6a_desk_01',
	channel: 'sms',
	priority: 100,
	cooldown_s: 30,
	max_per_hour: 120,
	version: 3,
	created_at: NOW - 10 * 86_400_000,
	updated_at: NOW - 25 * 60_000,
	graph: {
		nodes: [
			{
				id: 'n_trigger',
				type: 'trigger',
				position: { x: 40, y: 180 },
				data: {
					kind: 'incoming',
					sender: { mode: 'prefix', value: 'bKash' },
					body: { mode: 'keyword', value: 'You have received' }
				}
			},
			{
				id: 'n_extract',
				type: 'extract',
				position: { x: 300, y: 180 },
				data: {
					source: 'body',
					pattern:
						'You have received Tk (?<amount>[0-9,]+\\.[0-9]{2}) from (?<payer>01[3-9][0-9]{8})\\. TrxID (?<trx_id>[A-Z0-9]{8,12})',
					flags: '',
					template_spec: {
						sample_body: 'You have received Tk 800.00 from 01712345678. TrxID 8G56H7J8K9',
						spans: [
							{ role: 'trigger', name: 'prefix', start: 0, end: 17 },
							{ role: 'extract', name: 'amount', slot_type: 'money_bdt', start: 21, end: 27 },
							{ role: 'extract', name: 'payer', slot_type: 'phone_bd', start: 33, end: 44 },
							{ role: 'extract', name: 'trx_id', slot_type: 'trx_id', start: 52, end: 62 }
						]
					}
				}
			},
			{
				id: 'n_cond',
				type: 'condition',
				position: { x: 560, y: 180 },
				data: {
					left: '{{amount}}',
					op: 'exists'
				}
			},
			{
				id: 'n_switch',
				type: 'switch',
				position: { x: 830, y: 110 },
				data: {
					value: '{{payer}}',
					cases: ['01712345678', '01999999999']
				}
			},
			{
				id: 'n_hook',
				type: 'webhook',
				position: { x: 1120, y: 30 },
				data: {
					url: 'https://ops.example.com/webhooks/bkash',
					body: '{"trx_id":"{{trx_id}}","amount":"{{amount}}"}'
				}
			},
			{
				id: 'n_delay',
				type: 'delay',
				position: { x: 1120, y: 200 },
				data: {
					seconds: 15
				}
			},
			{
				id: 'n_sms',
				type: 'send_sms',
				position: { x: 1410, y: 110 },
				data: {
					to: '{{payer}}',
					body: 'Confirmed: Tk {{amount}} received (TrxID {{trx_id}}). Thank you for shopping with Dhaka Mart!'
				}
			},
			{
				id: 'n_stop_done',
				type: 'stop',
				position: { x: 1680, y: 110 },
				data: {
					reason: 'Confirmation queued'
				}
			},
			{
				id: 'n_stop_skip',
				type: 'stop',
				position: { x: 830, y: 310 },
				data: {
					reason: 'No amount parsed'
				}
			}
		],
		edges: [
			{ id: 'e1', source: 'n_trigger', target: 'n_extract' },
			{ id: 'e2', source: 'n_extract', target: 'n_cond' },
			{ id: 'e3', source: 'n_cond', target: 'n_switch', sourceHandle: 'true' },
			{ id: 'e4', source: 'n_cond', target: 'n_stop_skip', sourceHandle: 'false' },
			{ id: 'e5', source: 'n_switch', target: 'n_hook', sourceHandle: 'case:0' },
			{ id: 'e6', source: 'n_switch', target: 'n_delay', sourceHandle: 'case:1' },
			{ id: 'e7', source: 'n_switch', target: 'n_delay', sourceHandle: 'default' },
			{ id: 'e8', source: 'n_hook', target: 'n_sms' },
			{ id: 'e9', source: 'n_delay', target: 'n_sms' },
			{ id: 'e10', source: 'n_sms', target: 'n_stop_done' }
		]
	}
};

export const BKASH_UCS2_WORKFLOW: Workflow = {
	...BKASH_WORKFLOW,
	id: 'wf_bkash_ucs2_01',
	graph: {
		...BKASH_WORKFLOW.graph,
		nodes: BKASH_WORKFLOW.graph.nodes.map((node) =>
			node.id === 'n_sms'
				? {
						...node,
						data: {
							to: '{{payer}}',
							body: 'We’ve confirmed Tk {{amount}} (TrxID {{trx_id}}). Thank you for shopping with Dhaka Mart!'
						}
					}
				: node
		)
	}
};

export const EMPTY_WORKFLOW: Workflow = {
	id: 'wf_empty',
	name: 'Blank Draft Flow',
	enabled: false,
	device_id: null,
	version: 1,
	created_at: NOW - 60_000,
	updated_at: NOW - 60_000,
	graph: {
		nodes: [],
		edges: []
	}
};

export const UNSUPPORTED_WORKFLOW: Workflow = {
	id: 'wf_unsupported_03',
	name: 'AI Spam Triage Pipeline',
	enabled: true,
	device_id: 'dev_px6a_desk_01',
	version: 2,
	created_at: NOW - 3 * 86_400_000,
	updated_at: NOW - 2 * 3_600_000,
	graph: {
		nodes: [
			{
				id: 'n_trigger',
				type: 'trigger',
				position: { x: 40, y: 150 },
				data: {
					kind: 'incoming',
					sender: { mode: 'any', value: '' },
					body: { mode: 'any', value: '' }
				}
			},
			{
				id: 'n_ai_step',
				type: 'ai_classify',
				position: { x: 320, y: 150 },
				data: {
					model: '@cf/meta/llama-3.1-8b-instruct',
					labels: ['payment', 'support', 'spam'],
					threshold: 0.72
				}
			},
			{
				id: 'n_stop',
				type: 'stop',
				position: { x: 600, y: 150 },
				data: { reason: 'Triaged' }
			}
		],
		edges: [
			{ id: 'eu1', source: 'n_trigger', target: 'n_ai_step' },
			{ id: 'eu2', source: 'n_ai_step', target: 'n_stop' }
		]
	}
};

export const BROKEN_WORKFLOW: Workflow = {
	id: 'wf_broken_checks_02',
	name: '   ',
	enabled: true,
	device_id: 'bad id!',
	version: 1,
	created_at: NOW - 86_400_000,
	updated_at: NOW - 600_000,
	graph: {
		nodes: [
			{
				id: 'nb_trigger',
				type: 'trigger',
				position: { x: 40, y: 120 },
				data: {
					kind: 'incoming',
					sender: { mode: 'regex', value: '[unclosed' },
					body: { mode: 'any', value: '' }
				}
			},
			{
				id: 'nb_extract',
				type: 'extract',
				position: { x: 280, y: 120 },
				data: { source: 'body', pattern: '(?<bad>[unclosed' }
			},
			{
				id: 'nb_set',
				type: 'set_var',
				position: { x: 520, y: 120 },
				data: { name: 'sender', value: 'override' }
			},
			{
				id: 'nb_cond',
				type: 'condition',
				position: { x: 760, y: 120 },
				data: { left: '', op: 'equals', right: 'yes' }
			},
			{
				id: 'nb_hook',
				type: 'webhook',
				position: { x: 1000, y: 80 },
				data: { url: 'http://insecure.local/hook', body: '{}' }
			},
			{
				id: 'nb_sms',
				type: 'send_sms',
				position: { x: 1240, y: 80 },
				data: { to: '', body: 'Ref {{missing_var}}' }
			},
			{
				id: 'nb_orphan',
				type: 'delay',
				position: { x: 520, y: 280 },
				data: { seconds: 10 }
			}
		],
		edges: [
			{ id: 'eb1', source: 'nb_trigger', target: 'nb_extract' },
			{ id: 'eb2', source: 'nb_extract', target: 'nb_set' },
			{ id: 'eb3', source: 'nb_set', target: 'nb_cond' },
			{ id: 'eb4', source: 'nb_cond', target: 'nb_hook', sourceHandle: 'true' },
			{ id: 'eb5', source: 'nb_hook', target: 'nb_sms' }
		]
	}
};

const UNJUDGED_PATCH: WorkflowPatchHandoff = {
	intent: 'Add a confirmation webhook tag after extract',
	flowId: 'wf_bkash_order_01',
	patch: {
		nodes: [
			...BKASH_WORKFLOW.graph.nodes,
			{
				id: 'n_tag_var',
				type: 'set_var',
				position: { x: 430, y: 310 },
				data: { name: 'source_tag', value: 'bkash-sms' }
			}
		],
		edges: [
			...BKASH_WORKFLOW.graph.edges.filter((e) => e.id !== 'e2'),
			{ id: 'ep_1', source: 'n_extract', target: 'n_tag_var' },
			{ id: 'ep_2', source: 'n_tag_var', target: 'n_cond' }
		]
	}
};

const BLOCKING_PATCH: WorkflowPatchHandoff = {
	intent: 'Insert an unlinked VIP check before webhook',
	flowId: 'wf_bkash_order_01',
	patch: {
		nodes: [
			...BKASH_WORKFLOW.graph.nodes,
			{
				id: 'n_vip_cond',
				type: 'condition',
				position: { x: 980, y: 30 },
				data: { left: '{{amount}}', op: 'equals', right: '5000.00' }
			}
		],
		edges: [
			...BKASH_WORKFLOW.graph.edges.filter((e) => e.id !== 'e5'),
			{ id: 'epb_1', source: 'n_switch', target: 'n_vip_cond', sourceHandle: 'case:0' },
			{ id: 'epb_2', source: 'n_vip_cond', target: 'n_hook', sourceHandle: 'true' }
			// Missing 'false' branch -> triggers blocking structure issue
		]
	}
};

export const SCENARIOS: Record<WorkflowEditStateKey, WorkflowEditScenario> = {
	loading: {
		key: 'loading',
		label: 'Loading workflow',
		id: 'wf_loading',
		surface: 'steps',
		getReply: { kind: 'hold' }
	},
	'not-found': {
		key: 'not-found',
		label: 'Workflow not found (404)',
		id: 'wf_missing_99',
		surface: 'steps',
		getReply: { kind: 'not_found' }
	},
	'load-error': {
		key: 'load-error',
		label: 'Load failed (500)',
		id: 'wf_error_500',
		surface: 'steps',
		getReply: { kind: 'error', status: 500, message: 'D1 query failed for workflow graph.' }
	},
	'new-draft': {
		key: 'new-draft',
		label: 'New draft',
		id: '',
		surface: 'steps'
	},
	'empty-steps': {
		key: 'empty-steps',
		label: 'Empty graph',
		id: 'wf_empty',
		surface: 'steps',
		getReply: { kind: 'ok', workflow: EMPTY_WORKFLOW }
	},
	'steps-populated': {
		key: 'steps-populated',
		label: 'Steps outline (shared)',
		id: 'wf_bkash_order_01',
		surface: 'steps',
		getReply: { kind: 'ok', workflow: BKASH_WORKFLOW }
	},
	'steps-inspector': {
		key: 'steps-inspector',
		label: 'Steps inspector (UCS-2)',
		id: 'wf_bkash_ucs2_01',
		surface: 'steps',
		getReply: { kind: 'ok', workflow: BKASH_UCS2_WORKFLOW }
	},
	'steps-extract-sample': {
		key: 'steps-extract-sample',
		label: 'Pattern builder sheet',
		id: 'wf_bkash_order_01',
		surface: 'steps',
		getReply: { kind: 'ok', workflow: BKASH_WORKFLOW }
	},
	'map-populated': {
		key: 'map-populated',
		label: 'Map canvas',
		id: 'wf_bkash_order_01',
		surface: 'map',
		getReply: { kind: 'ok', workflow: BKASH_WORKFLOW }
	},
	'map-inspector': {
		key: 'map-inspector',
		label: 'Map inspector drawer',
		id: 'wf_bkash_order_01',
		surface: 'map',
		getReply: { kind: 'ok', workflow: BKASH_WORKFLOW }
	},
	'map-unsupported': {
		key: 'map-unsupported',
		label: 'Unsupported step on Map',
		id: 'wf_unsupported_03',
		surface: 'map',
		getReply: { kind: 'ok', workflow: UNSUPPORTED_WORKFLOW }
	},
	'checks-clean': {
		key: 'checks-clean',
		label: 'Checks passed',
		id: 'wf_bkash_order_01',
		surface: 'steps',
		getReply: { kind: 'ok', workflow: BKASH_WORKFLOW }
	},
	'checks-issues': {
		key: 'checks-issues',
		label: 'Checks with issues (>6)',
		id: 'wf_broken_checks_02',
		surface: 'steps',
		getReply: { kind: 'ok', workflow: BROKEN_WORKFLOW }
	},
	'preview-idle': {
		key: 'preview-idle',
		label: 'Preview drawer idle',
		id: 'wf_bkash_order_01',
		surface: 'map',
		getReply: { kind: 'ok', workflow: BKASH_WORKFLOW }
	},
	'preview-delivered': {
		key: 'preview-delivered',
		label: 'Preview matched (WASM)',
		id: 'wf_bkash_order_01',
		surface: 'map',
		getReply: { kind: 'ok', workflow: BKASH_WORKFLOW }
	},
	'preview-filtered': {
		key: 'preview-filtered',
		label: 'Preview filtered out',
		id: 'wf_bkash_order_01',
		surface: 'map',
		getReply: { kind: 'ok', workflow: BKASH_WORKFLOW }
	},
	'settings-open': {
		key: 'settings-open',
		label: 'Flow settings drawer',
		id: 'wf_bkash_order_01',
		surface: 'steps',
		getReply: { kind: 'ok', workflow: BKASH_WORKFLOW }
	},
	'add-palette': {
		key: 'add-palette',
		label: 'Add step palette',
		id: 'wf_bkash_order_01',
		surface: 'steps',
		getReply: { kind: 'ok', workflow: BKASH_WORKFLOW }
	},
	'source-readonly': {
		key: 'source-readonly',
		label: 'Source JSON sheet',
		id: 'wf_bkash_order_01',
		surface: 'steps',
		getReply: { kind: 'ok', workflow: BKASH_WORKFLOW }
	},
	'source-error': {
		key: 'source-error',
		label: 'Source JSON parse error',
		id: 'wf_bkash_order_01',
		surface: 'steps',
		getReply: { kind: 'ok', workflow: BKASH_WORKFLOW }
	},
	'finder-steps': {
		key: 'finder-steps',
		label: 'Step finder',
		id: 'wf_bkash_order_01',
		surface: 'steps',
		getReply: { kind: 'ok', workflow: BKASH_WORKFLOW }
	},
	'finder-agent': {
		key: 'finder-agent',
		label: 'Agent mode (judged)',
		id: 'wf_bkash_order_01',
		surface: 'steps',
		getReply: { kind: 'ok', workflow: BKASH_WORKFLOW },
		synthesizeReply: {
			kind: 'ok',
			judgement: {
				faithful: { score: 0.91, probability: 0.93, confidence: 0.88 },
				approval_required: true,
				apply_token: 'app_tok_7f4c91b2e3d0'
			}
		}
	},
	'finder-agent-unavailable': {
		key: 'finder-agent-unavailable',
		label: 'Agent unavailable (503)',
		id: 'wf_bkash_order_01',
		surface: 'steps',
		getReply: { kind: 'ok', workflow: BKASH_WORKFLOW },
		synthesizeReply: {
			kind: 'unavailable',
			status: 503,
			message: 'Workers AI quota exhausted for this window.'
		}
	},
	'ghost-judged-approval': {
		key: 'ghost-judged-approval',
		label: 'Judged patch + token',
		id: 'wf_bkash_order_01',
		surface: 'steps',
		getReply: { kind: 'ok', workflow: BKASH_WORKFLOW },
		synthesizeReply: {
			kind: 'ok',
			judgement: {
				faithful: { score: 0.91, probability: 0.93, confidence: 0.88 },
				approval_required: true,
				apply_token: 'app_tok_7f4c91b2e3d0'
			}
		}
	},
	'ghost-missing-token': {
		key: 'ghost-missing-token',
		label: 'Approval without token',
		id: 'wf_bkash_order_01',
		surface: 'steps',
		getReply: { kind: 'ok', workflow: BKASH_WORKFLOW },
		synthesizeReply: {
			kind: 'ok',
			judgement: {
				faithful: { score: 0.64, probability: 0.68, confidence: 0.59 },
				approval_required: true,
				apply_token: null
			}
		}
	},
	'ghost-unjudged': {
		key: 'ghost-unjudged',
		label: 'Unjudged external patch',
		id: 'wf_bkash_order_01',
		surface: 'steps',
		getReply: { kind: 'ok', workflow: BKASH_WORKFLOW },
		externalPatch: UNJUDGED_PATCH
	},
	'ghost-blocking-problems': {
		key: 'ghost-blocking-problems',
		label: 'Patch with blocking error',
		id: 'wf_bkash_order_01',
		surface: 'steps',
		getReply: { kind: 'ok', workflow: BKASH_WORKFLOW },
		externalPatch: BLOCKING_PATCH
	},
	'dirty-unsaved': {
		key: 'dirty-unsaved',
		label: 'Unsaved changes',
		id: 'wf_bkash_order_01',
		surface: 'steps',
		getReply: { kind: 'ok', workflow: BKASH_WORKFLOW }
	},
	saving: {
		key: 'saving',
		label: 'Saving in flight',
		id: 'wf_bkash_order_01',
		surface: 'steps',
		getReply: { kind: 'ok', workflow: BKASH_WORKFLOW },
		putReply: { kind: 'hold' }
	},
	'save-error': {
		key: 'save-error',
		label: 'Save failed (502)',
		id: 'wf_bkash_order_01',
		surface: 'steps',
		getReply: { kind: 'ok', workflow: BKASH_WORKFLOW },
		putReply: { kind: 'error', status: 502, message: 'Upstream Worker binding timed out.' }
	},
	'server-rejected': {
		key: 'server-rejected',
		label: 'Gateway rejected graph',
		id: 'wf_bkash_order_01',
		surface: 'steps',
		getReply: { kind: 'ok', workflow: BKASH_WORKFLOW },
		putReply: {
			kind: 'invalid',
			details: [
				{
					path: 'nodes[4].data.url',
					message: 'Webhook destination is not on the allowlisted host list.'
				},
				{
					path: 'max_per_hour',
					message: 'Hourly send cap exceeds deployment limit (60).'
				}
			]
		}
	},
	'leave-confirm': {
		key: 'leave-confirm',
		label: 'Unsaved leave guard',
		id: 'wf_bkash_order_01',
		surface: 'steps',
		getReply: { kind: 'ok', workflow: BKASH_WORKFLOW }
	},
	// The same saved graph, read by a member: the document is identical, the
	// write controls are not. Nothing here is special-cased in the editor.
	'member-session': {
		key: 'member-session',
		label: 'Member session (read-only)',
		role: 'member',
		id: 'wf_bkash_order_01',
		surface: 'steps',
		getReply: { kind: 'ok', workflow: BKASH_WORKFLOW }
	},
	// A member at `/workflows/edit` with no id: there is no document to read and
	// no way to save one, so the editor is not drawn at all.
	'member-draft': {
		key: 'member-draft',
		label: 'Member session, new workflow',
		role: 'member',
		id: '',
		surface: 'steps'
	},
	// An agent staged a patch for a member's session: the diff is readable and
	// revertible, Accept is not available.
	'member-ghost': {
		key: 'member-ghost',
		label: 'Member session, staged patch',
		role: 'member',
		id: 'wf_bkash_order_01',
		surface: 'steps',
		getReply: { kind: 'ok', workflow: BKASH_WORKFLOW },
		externalPatch: UNJUDGED_PATCH
	}
};

export function scenarioFor(state: WorkflowEditStateKey): WorkflowEditScenario {
	return SCENARIOS[state];
}

export function syncEditorStorage(state: WorkflowEditStateKey): void {
	if (typeof window === 'undefined') return;
	const scenario = scenarioFor(state);
	try {
		window.localStorage.setItem('dakflare.workflow.surface', scenario.surface);
		window.localStorage.removeItem(`dakflare.workflow.viewport.${scenario.id || 'draft'}`);
	} catch {
		// Storage may be blocked in restricted contexts.
	}
}
