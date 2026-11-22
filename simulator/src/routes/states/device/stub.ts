import {
	app,
	type ApprovalGrant,
	type Device,
	type DeviceFacts,
	type PendingApproval,
	type TargetView
} from '$lib/stores/app.svelte';
import { composer } from '$lib/stores/composer.svelte';

export const STATE_GROUPS: { id: string; label: string; items: { key: string; label: string }[] }[] = [
	{
		id: 'states-lifecycle',
		label: 'Lifecycle',
		items: [
			{ key: 'booting', label: 'Opening database' },
			{ key: 'no-backend', label: 'Browser preview' },
			{ key: 'no-identity', label: 'No device identity' },
			{ key: 'unconfigured', label: 'Unconfigured target' }
		]
	},
	{
		id: 'states-connectivity',
		label: 'Connectivity',
		items: [
			{ key: 'live', label: 'Live · healthy handset' },
			{ key: 'synced', label: 'Synced · recent contact' },
			{ key: 'stale', label: 'Stale · sleeping' },
			{ key: 'offline-carrier', label: 'Offline · carrier off' },
			{ key: 'offline-aged', label: 'Offline · >24h silent' },
			{ key: 'unknown', label: 'Unknown · never polled' }
		]
	},
	{
		id: 'states-approvals-handset',
		label: 'Approvals & Handset',
		items: [
			{ key: 'approvals-loading', label: 'Approvals & facts loading' },
			{ key: 'approvals-pending', label: 'Approvals waiting (ceiling)' },
			{ key: 'approvals-error', label: 'Approvals & facts failed' },
			{ key: 'facts-empty', label: 'Nothing reported by Android' }
		]
	}
];

export const DEFAULT_STATE = 'live';
export const ALL_KEYS = STATE_GROUPS.flatMap((g) => g.items.map((i) => i.key));

export function resolveStateKey(raw: string | null): string {
	return raw && ALL_KEYS.includes(raw) ? raw : DEFAULT_STATE;
}

const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const DEV_1: Device = {
	device_id: 'dev_01j9z4k7q3f8m2v6t0b1c5dn',
	public_key_spki: 'MCowBQYDK2VwAyEAx3q7M2L9pK1vR8sT4wY6zN0cB5dF2gH9jK3mQ1vP7s=',
	platform: 'android',
	platform_id: 'Xiaomi Mi A3',
	label: 'Pixel Relay SIM 1',
	carrier: 'Grameenphone',
	sim_slot: 0,
	created_at: NOW - 14 * DAY,
	updated_at: NOW - 25_000
};

const DEV_2: Device = {
	device_id: 'dev_01ja2m9x8r1p4n7c2w5k8y3q',
	public_key_spki: 'MCowBQYDK2VwAyEBa9dF4kR2mN7pQ1wX5zC8vB3nL6jK0hG4fD2sA9eR5t=',
	platform: 'android',
	platform_id: 'Backup Handset',
	label: 'Ops Backup SIM 2',
	carrier: 'Robi',
	sim_slot: 1,
	created_at: NOW - 7 * DAY,
	updated_at: NOW - 6 * MIN
};

const DEFAULT_TARGET: TargetView = {
	base_url: 'https://dakflare.example.workers.dev',
	has_admin_token: true
};

const FULL_FACTS: DeviceFacts = {
	self_number: '+8801711000001',
	sim_slot: 0,
	sim_carrier: 'Grameenphone',
	permissions: { sms: true, send: true, phone_numbers: true },
	battery_optimized: true,
	default_sms_app: 'dev.dakflare.device'
};

const PENDING_APPROVALS: PendingApproval[] = [
	{
		id: 'apr_01j9z8w2m5k4n7p1q3r6s9tv',
		scope: 'sms:send:production',
		target: { recipients: ['+8801712884410', '+15550104829'] },
		reason: 'Incident responder agent needs to send customer outage updates.',
		requested_at: NOW - 45_000,
		expires_at: NOW + 14 * MIN,
		ladder_s: [60, 300, 900, 3600, 86400],
		max_s: 900
	},
	{
		id: 'apr_01j9z7b1c2d3e4f5g6h7j8km',
		scope: 'sms:send:test',
		target: { device_id: DEV_1.device_id },
		reason: 'Smoke test before shift handover.',
		requested_at: NOW - 25 * MIN,
		expires_at: NOW - 5 * MIN,
		ladder_s: [60, 300, 900],
		max_s: 900
	}
];

let epoch = 0;

export function currentEpoch(): number {
	return epoch;
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
	const noBackend = key === 'no-backend';
	resetStores(!noBackend);

	if (noBackend) {
		delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
		await app.boot();
		return;
	}

	const devices =
		key === 'no-identity' ? [] : key === 'live' ? [DEV_1, DEV_2] : [DEV_1];
	let approvalsState = key === 'approvals-pending' ? [...PENDING_APPROVALS] : [];

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
				if (key === 'booting') return hold();
				if (key === 'unconfigured') return { base_url: null, has_admin_token: false };
				return DEFAULT_TARGET;
			case 'schema_version':
				return 8;
			case 'list_devices':
				return devices;
			case 'get_offline':
				return key === 'offline-carrier';
			case 'get_last_contact': {
				const id = args.deviceId as string;
				if (id === DEV_2.device_id) return NOW - 6 * MIN;
				if (key === 'live' || key === 'approvals-pending' || key === 'approvals-loading') {
					return NOW - 25_000;
				}
				if (key === 'synced') return NOW - 6 * MIN;
				if (key === 'stale') return NOW - 4 * HOUR;
				if (key === 'offline-aged') return NOW - 3 * DAY;
				if (key === 'offline-carrier' || key === 'unknown') return null;
				return NOW - 25_000;
			}
			case 'get_device_pairing':
				if (key === 'unknown') return null;
				return NOW - 9 * DAY;
			case 'list_messages_page':
				return { messages: [], has_more: false };
			case 'get_device_facts':
				if (key === 'approvals-loading') return hold();
				if (key === 'approvals-error') {
					return Promise.reject('Android bridge unavailable in this session');
				}
				if (key === 'facts-empty') {
					return {
						self_number: null,
						sim_slot: null,
						sim_carrier: null,
						permissions: null,
						battery_optimized: null,
						default_sms_app: null
					};
				}
				if (key === 'synced') {
					return {
						...FULL_FACTS,
						permissions: { sms: true, send: true, phone_numbers: false },
						battery_optimized: false,
						default_sms_app: 'com.google.android.apps.messaging'
					};
				}
				if (key === 'stale') {
					return {
						...FULL_FACTS,
						self_number: null
					};
				}
				if (key === 'offline-carrier') {
					return {
						...FULL_FACTS,
						default_sms_app: 'none'
					};
				}
				return FULL_FACTS;
			case 'list_approvals':
				if (key === 'approvals-loading') return hold();
				if (key === 'approvals-error') {
					return Promise.reject('401 device signature rejected by deployment');
				}
				return approvalsState;
			case 'approve_approval': {
				const approvalId = args.approvalId as string;
				const durationS = Number(args.durationS ?? 60);
				const item = approvalsState.find((a) => a.id === approvalId);
				const maxS = item?.max_s ?? 900;
				const grantedS = Math.min(durationS, maxS);
				approvalsState = approvalsState.filter((a) => a.id !== approvalId);
				const grant: ApprovalGrant = {
					granted_s: grantedS,
					requested_s: durationS,
					clamped: grantedS < durationS,
					max_s: maxS,
					expires_at: Date.now() + grantedS * 1000
				};
				return grant;
			}
			case 'reject_approval': {
				const approvalId = args.approvalId as string;
				approvalsState = approvalsState.filter((a) => a.id !== approvalId);
				return null;
			}
			case 'poll_device':
				return {
					commands: [],
					flows: { ok: true, count: 3, error: null }
				};
			case 'revoke_device':
				return null;
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

	if (key === 'booting' || key === 'approvals-loading') {
		void app.boot();
		return;
	}

	await app.boot();
	if (myEpoch !== epoch) return;
}
