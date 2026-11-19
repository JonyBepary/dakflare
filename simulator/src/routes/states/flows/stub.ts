import {
	app,
	type CachedFlow,
	type Device,
	type DeviceFacts,
	type FlowRun,
	type Message,
	type TargetView
} from '$lib/stores/app.svelte';
import { composer } from '$lib/stores/composer.svelte';

export const STATE_GROUPS: { id: string; label: string; items: { key: string; label: string }[] }[] = [
	{
		id: 'states-access-cache',
		label: 'Access & Cache',
		items: [
			{ key: 'no-backend', label: 'No backend' },
			{ key: 'loading', label: 'Reading cache' },
			{ key: 'empty', label: 'Empty cache' },
			{ key: 'read-failed-empty', label: 'Read failed (empty)' },
			{ key: 'no-device', label: 'No device identity' }
		]
	},
	{
		id: 'states-flows-runs',
		label: 'Cached Flows & Runs',
		items: [
			{ key: 'single-flow', label: 'Single flow' },
			{ key: 'all-outcomes', label: 'All run outcomes' },
			{ key: 'runs-saturated', label: '100+ runs saturated' }
		]
	},
	{
		id: 'states-sync-simulator',
		label: 'Sync & Simulator',
		items: [
			{ key: 'unconfigured', label: 'Unconfigured target' },
			{ key: 'offline', label: 'Carrier offline' },
			{ key: 'syncing', label: 'Syncing' },
			{ key: 'synced', label: 'Synced OK' },
			{ key: 'sync-failed-stale', label: 'Sync failed (stale cache)' },
			{ key: 'injecting', label: 'Injecting inbound' },
			{ key: 'injected', label: 'Injected OK' },
			{ key: 'polling', label: 'Polling outbox' },
			{ key: 'cleared', label: 'Thread cleared' }
		]
	}
];

export const DEFAULT_STATE = 'all-outcomes';
export const ALL_KEYS = STATE_GROUPS.flatMap((g) => g.items.map((i) => i.key));

export function resolveStateKey(raw: string | null): string {
	return raw && ALL_KEYS.includes(raw) ? raw : DEFAULT_STATE;
}

const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;

const DEV_1: Device = {
	device_id: 'dev_01j9z4k7q3f8m2v6t0b1c5dn',
	public_key_spki: 'MCowBQYDK2VwAyEAx3q7M2L9pK1vR8sT4wY6zN0cB5dF2gH9jK3mQ1vP7s=',
	platform: 'android',
	platform_id: 'Xiaomi Mi A3',
	label: 'Pixel Relay SIM 1',
	carrier: 'Grameenphone',
	sim_slot: 0,
	created_at: NOW - 14 * 24 * HOUR,
	updated_at: NOW - 35_000
};

const DEFAULT_TARGET: TargetView = {
	base_url: 'https://dakflare.example.workers.dev',
	has_admin_token: true
};

const DEFAULT_FACTS: DeviceFacts = {
	self_number: '+8801711000001',
	sim_slot: 0,
	sim_carrier: 'Grameenphone',
	permissions: { sms: true, send: true, phone_numbers: true },
	battery_optimized: false,
	default_sms_app: 'dev.dakflare.simulator'
};

const TWO_FLOWS: CachedFlow[] = [
	{ id: 'otp_guard', version: 2, fetched_at: NOW - 15 * MIN, node_count: 4 },
	{ id: 'after_hours_reply', version: 1, fetched_at: NOW - 4 * HOUR, node_count: 3 }
];

const THREE_FLOWS: CachedFlow[] = [
	...TWO_FLOWS,
	{ id: 'vip_escalation', version: 5, fetched_at: NOW - 10_000, node_count: 6 }
];

const ALL_OUTCOME_FLOWS: CachedFlow[] = [
	{ id: 'otp_guard', version: 2, fetched_at: NOW - 12 * MIN, node_count: 1 },
	{ id: 'support_triage', version: 4, fetched_at: NOW - 28 * MIN, node_count: 5 },
	{ id: 'compliance_hold', version: 3, fetched_at: NOW - 2 * HOUR, node_count: 4 },
	{ id: 'legacy_webhook', version: 1, fetched_at: NOW - 6 * HOUR, node_count: 3 },
	{ id: 'draft_untriggered', version: 1, fetched_at: NOW - 12 * HOUR, node_count: 2 },
	{ id: 'corrupt_cache_graph', version: 7, fetched_at: NOW - 24 * HOUR, node_count: null },
	{ id: 'never_executed_rule', version: 1, fetched_at: NOW - 48 * HOUR, node_count: 3 }
];

const ALL_OUTCOME_RUNS: FlowRun[] = [
	{
		local_id: 'run_01',
		flow_id: 'otp_guard',
		flow_version: 2,
		outcome: 'delivered',
		created_at: NOW - 3 * MIN
	},
	{
		local_id: 'run_02',
		flow_id: 'support_triage',
		flow_version: 4,
		outcome: 'filtered',
		created_at: NOW - 14 * MIN
	},
	{
		local_id: 'run_03',
		flow_id: 'compliance_hold',
		flow_version: 3,
		outcome: 'halted',
		created_at: NOW - 41 * MIN
	},
	{
		local_id: 'run_04',
		flow_id: 'legacy_webhook',
		flow_version: 1,
		outcome: 'error',
		created_at: NOW - 2 * HOUR
	},
	{
		local_id: 'run_05',
		flow_id: 'draft_untriggered',
		flow_version: 1,
		outcome: 'no_trigger',
		created_at: NOW - 5 * HOUR
	}
];

const SATURATED_RUNS: FlowRun[] = Array.from({ length: 100 }, (_, i) => ({
	local_id: `run_sat_${i + 1}`,
	flow_id: 'otp_guard',
	flow_version: 2,
	outcome: i % 5 === 0 ? 'filtered' : 'delivered',
	created_at: NOW - (i + 1) * MIN
}));

const OUTBOUND_CAPTURED: Message = {
	id: 'msg_out_01',
	device_id: DEV_1.device_id,
	direction: 'out',
	peer: '+15550001111',
	body: 'Auto-reply: OTP verified by DakFlare flow.',
	state: 'queued',
	local_id: 'loc_flow_01',
	created_at: NOW - 5_000
};

let epoch = 0;
let activeState = '';

export function currentEpoch(): number {
	return epoch;
}

export function currentRun(): { state: string; epoch: number } {
	return { state: activeState, epoch };
}

const hold = <T>() => new Promise<T>(() => {});

function resetStores(hasBackend: boolean) {
	app.booted = false;
	app.backendAvailable = hasBackend;
	app.loading = { boot: true };
	app.busy = {};
	app.schemaVersion = null;
	app.target = { base_url: null, has_admin_token: false };
	app.devices = [];
	app.selectedId = '';
	app.messages = [];
	app.messagesHasMore = false;
	app.messagesLoaded = false;
	app.offline = false;
	app.facts = null;
	app.factsLoaded = false;
	app.factsError = null;
	app.cachedFlows = [];
	app.flowRuns = [];
	app.flowsLoaded = false;
	app.flowsError = null;
	app.approvals = [];
	app.approvalsLoaded = false;
	app.approvalsError = null;
	app.approvalBusy = {};
	app.contactAt = {};
	app.lastContactAt = {};
	app.pairedAt = {};
	app.pairingAt = {};
	app.notices = {};
	app.retention = null;

	composer.draft = '';
	composer.sending = false;
	composer.failure = null;
	composer.pending = [];
	composer.repliesOpen = true;
	composer.newMessage = { to: '', body: '' };
}

export async function applyState(key: string): Promise<void> {
	const myEpoch = ++epoch;
	activeState = key;
	const noBackend = key === 'no-backend';
	resetStores(!noBackend);

	if (noBackend) {
		delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
		await app.boot();
		return;
	}

	const devices = key === 'no-device' ? [] : [DEV_1];
	let offlineState = key === 'offline';

	const handle = (cmd: string, args: Record<string, unknown>): unknown => {
		switch (cmd) {
			case 'permission_state':
				return {
					battery_exempt: true,
					sms_role: true,
					send_sms: true,
					receive_sms: true,
					notifications: true
				};
			case 'take_sms_route':
				return null;
			case 'get_target':
				if (key === 'unconfigured') return { base_url: null, has_admin_token: false };
				return DEFAULT_TARGET;
			case 'schema_version':
				return 8;
			case 'list_devices':
				return devices;
			case 'get_last_contact':
				return NOW - 35_000;
			case 'get_device_pairing':
				return NOW - 10 * 24 * HOUR;
			case 'get_offline':
				return offlineState;
			case 'set_offline':
				offlineState = Boolean(args.offline);
				return null;
			case 'list_messages_page':
				return { messages: [], has_more: false };
			case 'get_device_facts':
				return DEFAULT_FACTS;
			case 'list_cached_flows':
				if (key === 'loading') return hold();
				if (key === 'read-failed-empty') {
					return Promise.reject('SQLite error: cached_flows table locked');
				}
				if (key === 'empty') return [];
				if (key === 'single-flow') return [ALL_OUTCOME_FLOWS[0]];
				if (key === 'all-outcomes') return ALL_OUTCOME_FLOWS;
				if (key === 'runs-saturated') return TWO_FLOWS;
				if (key === 'synced') return THREE_FLOWS;
				return TWO_FLOWS;
			case 'list_flow_runs':
				if (key === 'loading') return hold();
				if (key === 'empty' || key === 'read-failed-empty') return [];
				if (key === 'single-flow') return [ALL_OUTCOME_RUNS[0]];
				if (key === 'all-outcomes') return ALL_OUTCOME_RUNS;
				if (key === 'runs-saturated') return SATURATED_RUNS;
				return [ALL_OUTCOME_RUNS[0], ALL_OUTCOME_RUNS[1]];
			case 'sync_flows':
				if (key === 'syncing') return hold();
				if (key === 'sync-failed-stale') {
					return Promise.reject('502 Bad Gateway from Worker');
				}
				return THREE_FLOWS.length;
			case 'carrier_drain':
				if (key === 'polling') return hold();
				return [OUTBOUND_CAPTURED];
			case 'carrier_inject':
				if (key === 'injecting') return hold();
				return {
					uploaded: !offlineState,
					accepted: 1,
					duplicates: 0,
					message_id: 'msg_inj_1',
					state: 'received',
					device_sent: false,
					fallback: false
				};
			case 'clear_messages':
				return 4;
			default:
				return null;
		}
	};

	(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
		invoke: (cmd: string, args: Record<string, unknown> = {}) => {
			if (myEpoch !== epoch) return hold();
			return Promise.resolve().then(() => {
				if (myEpoch !== epoch) return hold();
				return handle(cmd, args);
			});
		}
	};

	await app.boot();
	if (myEpoch !== epoch) return;
}
