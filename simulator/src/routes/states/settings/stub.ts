import {
	app,
	type Device,
	type DeviceFacts,
	type RetentionStatus,
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
			{ key: 'fresh-install', label: 'Fresh install (empty)' }
		]
	},
	{
		id: 'states-pairing-target',
		label: 'Pairing & Target',
		items: [
			{ key: 'configured-paired', label: 'Target & paired device' },
			{ key: 'pair-link-valid', label: 'Pair link opened (valid)' },
			{ key: 'pair-link-malformed', label: 'Pair link malformed' },
			{ key: 'pair-and-target-errors', label: 'Pair & target errors' }
		]
	},
	{
		id: 'states-android-retention',
		label: 'Android & Retention',
		items: [
			{ key: 'sms-other-app', label: 'Other default SMS app' },
			{ key: 'sms-unreported', label: 'SMS role unreported' }
		]
	},
	{
		id: 'states-dialogs',
		label: 'Dialogs',
		items: [{ key: 'delete-confirm', label: 'Delete device dialog' }]
	}
];

export const DEFAULT_STATE = 'configured-paired';
export const ALL_KEYS = STATE_GROUPS.flatMap((g) => g.items.map((i) => i.key));

export const VALID_PAIR_LINK =
	'dakflare://pair?u=https%3A%2F%2Fdakflare-prod.example.workers.dev&c=AB12CD34EF56';
export const MALFORMED_PAIR_LINK = 'dakflare://pair?u=not-a-url&c=123';

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
	updated_at: NOW - 35_000
};

const DEV_2: Device = {
	device_id: 'dev_01ja2m9x8r1p4n7c2w5k8y3q',
	public_key_spki: 'MCowBQYDK2VwAyEBa9dF4kR2mN7pQ1wX5zC8vB3nL6jK0hG4fD2sA9eR5t=',
	platform: 'android',
	platform_id: null,
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

const DEFAULT_FACTS: DeviceFacts = {
	self_number: '+8801711000001',
	sim_slot: 0,
	sim_carrier: 'Grameenphone',
	permissions: { sms: true, send: true, phone_numbers: true },
	battery_optimized: true,
	default_sms_app: 'dev.dakflare.device'
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

	let devicesState =
		key === 'fresh-install'
			? []
			: key === 'configured-paired'
				? [{ ...DEV_1 }, { ...DEV_2 }]
				: [{ ...DEV_1 }];

	let targetState: TargetView =
		key === 'fresh-install'
			? { base_url: null, has_admin_token: false }
			: { ...DEFAULT_TARGET };

	let retentionState: RetentionStatus =
		key === 'fresh-install'
			? { policy: 'forever', last_purge_at: null, last_deleted: null }
			: key === 'sms-other-app'
				? { policy: 'days:90', last_purge_at: NOW - 20 * MIN, last_deleted: 0 }
				: key === 'sms-unreported'
					? { policy: 'messages:1000', last_purge_at: NOW - 2 * DAY, last_deleted: 42 }
					: { policy: 'days:30', last_purge_at: NOW - 3 * HOUR, last_deleted: 14 };

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
				return targetState;
			case 'save_target': {
				if (key === 'pair-and-target-errors') {
					return Promise.reject('Target URL must use https:// (or http://localhost)');
				}
				const baseUrl = String(args.baseUrl ?? '').trim();
				if (!baseUrl) return Promise.reject('Target URL is required');
				targetState = {
					base_url: baseUrl.replace(/\/+$/, ''),
					has_admin_token: Boolean(args.adminToken) || targetState.has_admin_token
				};
				return null;
			}
			case 'schema_version':
				return 8;
			case 'list_devices':
				return devicesState;
			case 'get_last_contact': {
				const id = args.deviceId as string;
				if (id === DEV_2.device_id) return NOW - 6 * MIN;
				return NOW - 35_000;
			}
			case 'get_device_pairing': {
				const id = args.deviceId as string;
				if (id === DEV_2.device_id) return null;
				return NOW - 9 * DAY;
			}
			case 'get_offline':
				return false;
			case 'list_messages_page':
				return { messages: [], has_more: false };
			case 'get_device_facts':
				if (key === 'fresh-install') {
					return { ...DEFAULT_FACTS, default_sms_app: 'none' };
				}
				if (key === 'sms-other-app') {
					return { ...DEFAULT_FACTS, default_sms_app: 'com.google.android.apps.messaging' };
				}
				if (key === 'sms-unreported') {
					return { ...DEFAULT_FACTS, default_sms_app: null };
				}
				return DEFAULT_FACTS;
			case 'get_retention':
				if (key === 'booting') return hold();
				return retentionState;
			case 'set_retention':
				retentionState = {
					policy: String(args.policy ?? 'forever'),
					last_purge_at: Date.now(),
					last_deleted: 0
				};
				return retentionState;
			case 'pair_with_code':
				if (key === 'pair-and-target-errors') {
					return Promise.reject('401 pairing code expired or already used');
				}
				return `Paired as ${String(args.deviceId)}. Cached 2 flows.`;
			case 'pair_device':
				return `Self-paired ${String(args.deviceId)}.`;
			case 'request_default_sms_role':
				return null;
			case 'create_device': {
				const created: Device = {
					device_id: `dev_${Date.now().toString(36)}`,
					public_key_spki: 'MCowBQYDK2VwAyEAnewKeyDemo1234567890abcdef=',
					platform: 'android',
					platform_id: (args.platformId as string | null) ?? null,
					label: String(args.label ?? 'New handset'),
					carrier: (args.carrier as string | null) ?? null,
					sim_slot: Number(args.simSlot ?? 0),
					created_at: Date.now(),
					updated_at: Date.now()
				};
				devicesState = [created, ...devicesState];
				return created;
			}
			case 'delete_device': {
				const id = String(args.deviceId ?? '');
				devicesState = devicesState.filter((d) => d.device_id !== id);
				return true;
			}
			case 'purge_messages':
				if (key === 'pair-and-target-errors') {
					return Promise.reject('403 admin token missing or rejected');
				}
				return 12;
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

	if (key === 'booting') {
		void app.boot();
		return;
	}

	await app.boot();
	if (myEpoch !== epoch) return;
}
