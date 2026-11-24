import type { Device, WorkflowSummary } from '$lib/types';
import type { StateGroup } from './StateSwitcher.svelte';

export type WorkflowsStateKey =
	| 'loading'
	| 'empty'
	| 'one-flow'
	| 'populated'
	| 'refreshing'
	| 'load-error'
	| 'delete-confirm'
	| 'delete-pending'
	| 'delete-error'
	| 'delete-success'
	| 'member-session';

export const WORKFLOWS_GROUPS: ReadonlyArray<StateGroup> = [
	{
		heading: 'Data',
		states: [
			{ key: 'loading', label: 'Loading workflows' },
			{ key: 'empty', label: 'No workflows yet' },
			{ key: 'one-flow', label: 'Single flow (1 step)' },
			{ key: 'populated', label: 'Saved flows' },
			{ key: 'refreshing', label: 'Refreshing list' },
			{ key: 'load-error', label: 'Load failed' }
		]
	},
	{
		heading: 'Deletion',
		states: [
			{ key: 'delete-confirm', label: 'Delete confirmation' },
			{ key: 'delete-pending', label: 'Deleting workflow' },
			{ key: 'delete-error', label: 'Delete failed' },
			{ key: 'delete-success', label: 'Deleted notice' }
		]
	},
	{
		heading: 'Session',
		states: [{ key: 'member-session', label: 'Member session (read-only)' }]
	}
];

export const DEFAULT_WORKFLOWS_STATE: WorkflowsStateKey = 'populated';

const VALID_KEYS = new Set<string>(
	WORKFLOWS_GROUPS.flatMap((group) => group.states.map((item) => item.key))
);

export function isWorkflowsState(value: string | null): value is WorkflowsStateKey {
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
		sim_slot: 0,
		archived_at: null,
		revoked_at: null
	},
	{
		device_id: 'dev_ga54_field_02',
		label: 'Galaxy A54 · Field',
		fcm_token: 'fcm_ga54_live',
		paired_at: NOW - 5 * 86_400_000,
		last_seen: NOW - 3 * 60_000,
		sim_slot: 1,
		archived_at: null,
		revoked_at: null
	}
];

export const SINGLE_WORKFLOW: WorkflowSummary = {
	id: 'wf_delivery_ack_01',
	name: 'Parcel Delivery Acknowledgement',
	enabled: true,
	device_id: 'dev_px6a_desk_01',
	updated_at: NOW - 15 * 60_000,
	node_count: 1
};

export const SAMPLE_WORKFLOWS: WorkflowSummary[] = [
	{
		id: 'wf_bkash_order_01',
		name: 'bKash Payment Confirmation & Webhook Dispatch',
		enabled: true,
		device_id: 'dev_px6a_desk_01',
		updated_at: NOW - 18 * 60_000,
		node_count: 8
	},
	{
		id: 'wf_nagad_receipt_02',
		name: 'Nagad Settlement Escalation & Warehouse Dispatch Alert (Uttara Hub)',
		enabled: true,
		device_id: null,
		updated_at: NOW - 3 * 3_600_000,
		node_count: 5
	},
	{
		id: 'wf_after_hours_hold_03',
		name: 'After-Hours Support Queue Hold',
		enabled: false,
		device_id: 'dev_ga54_field_02',
		updated_at: NOW - 2 * 86_400_000,
		node_count: 4
	},
	{
		id: 'wf_legacy_sim_probe_04',
		name: 'Retired Handset Balance Probe',
		enabled: false,
		device_id: 'dev_retired_sim_99',
		updated_at: NOW - 9 * 86_400_000,
		node_count: 3
	}
];
