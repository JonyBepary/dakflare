import { app, type Device, type DeviceFacts, type Message, type TargetView } from '$lib/stores/app.svelte';
import { composer } from '$lib/stores/composer.svelte';

export type StateItem = {
	key: string;
	label: string;
	group: string;
};

export const STATE_GROUPS: { id: string; label: string; items: { key: string; label: string }[] }[] = [
	{
		id: 'states-boot-access',
		label: 'Boot & Access',
		items: [
			{ key: 'booting', label: 'Booting' },
			{ key: 'no-backend', label: 'No backend' },
			{ key: 'boot-error', label: 'Boot failed' },
			{ key: 'no-device', label: 'No device identity' }
		]
	},
	{
		id: 'states-threads',
		label: 'Threads',
		items: [
			{ key: 'loading', label: 'Reading threads' },
			{ key: 'load-error', label: 'Load failed' },
			{ key: 'empty', label: 'Empty' },
			{ key: 'one-thread', label: 'One thread' },
			{ key: 'threads', label: 'Typical threads' },
			{ key: 'has-more', label: 'Paginated (has_more)' },
			{ key: 'loading-older', label: 'Loading older' },
			{ key: 'multi-device', label: 'Multi-device' }
		]
	},
	{
		id: 'states-search',
		label: 'Search',
		items: [
			{ key: 'search-too-short', label: 'Query too short' },
			{ key: 'searching', label: 'Searching' },
			{ key: 'search-empty', label: 'No matches' },
			{ key: 'search-error', label: 'Search error' },
			{ key: 'search-hits', label: 'Search hits' },
			{ key: 'search-truncated', label: 'Truncated (100+)' }
		]
	}
];

export const DEFAULT_STATE = 'threads';
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

const DEV_2: Device = {
	device_id: 'dev_01ja2m9x8r1p4n7c2w5k8y3q',
	public_key_spki: 'MCowBQYDK2VwAyEBa9dF4kR2mN7pQ1wX5zC8vB3nL6jK0hG4fD2sA9eR5t=',
	platform: 'android',
	platform_id: 'Backup Handset',
	label: 'Ops Backup SIM 2',
	carrier: 'Robi',
	sim_slot: 1,
	created_at: NOW - 7 * 24 * HOUR,
	updated_at: NOW - 5 * MIN
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

const MESSAGES_DEV_1: Message[] = [
	{
		id: 'msg_01',
		device_id: DEV_1.device_id,
		direction: 'in',
		peer: '+8801712884410',
		body: 'Verification code 483920 received. Gate courier arrived at South dock.',
		state: 'received',
		local_id: null,
		created_at: NOW - 2 * MIN
	},
	{
		id: 'msg_02',
		device_id: DEV_1.device_id,
		direction: 'out',
		peer: '+15550104829',
		body: 'Confirmed: dispatch batch #42 cleared for pickup at 14:30.',
		state: 'delivered',
		local_id: 'loc_02',
		created_at: NOW - 9 * MIN
	},
	{
		id: 'msg_03',
		device_id: DEV_1.device_id,
		direction: 'out',
		peer: '+8801819330044',
		body: 'Reply STOP to opt out of shift alerts.',
		state: 'sent',
		local_id: 'loc_03',
		created_at: NOW - 27 * MIN
	},
	{
		id: 'msg_04',
		device_id: DEV_1.device_id,
		direction: 'out',
		peer: '+15550192201',
		body: 'Queued status update for order 9084.',
		state: 'queued',
		local_id: 'loc_04',
		created_at: NOW - 45 * MIN
	},
	{
		id: 'msg_05',
		device_id: DEV_1.device_id,
		direction: 'out',
		peer: '+8801911445566',
		body: 'Radio handshake retry in progress.',
		state: 'sending',
		local_id: 'loc_05',
		created_at: NOW - 70 * MIN
	},
	{
		id: 'msg_06',
		device_id: DEV_1.device_id,
		direction: 'out',
		peer: '+447700900123',
		body: 'Alert: sensor gateway battery below 15%.',
		state: 'failed',
		local_id: 'loc_06',
		last_error: 'Radio error 38: network out of order',
		created_at: NOW - 3 * HOUR
	},
	{
		id: 'msg_07',
		device_id: DEV_1.device_id,
		direction: 'in',
		peer: 'bKash',
		body: 'Your OTP is 774129. Never share this code with anyone.',
		state: 'received',
		local_id: null,
		created_at: NOW - 5 * HOUR
	},
	{
		id: 'msg_08',
		device_id: DEV_1.device_id,
		direction: 'in',
		peer: '16216',
		body: 'DBBL Alert: A/C ****4812 credited BDT 12,500.00.',
		state: 'received',
		local_id: null,
		created_at: NOW - 11 * HOUR
	}
];

const MESSAGES_DEV_2: Message[] = [
	{
		id: 'msg_d2_01',
		device_id: DEV_2.device_id,
		direction: 'in',
		peer: '+8801811223344',
		body: 'SIM 2 failover active. Monitoring secondary line.',
		state: 'received',
		local_id: null,
		created_at: NOW - 4 * MIN
	},
	{
		id: 'msg_d2_02',
		device_id: DEV_2.device_id,
		direction: 'out',
		peer: '+15550148877',
		body: 'Backup SIM test message delivered.',
		state: 'delivered',
		local_id: 'loc_d2_02',
		created_at: NOW - 32 * MIN
	}
];

const SEARCH_HITS: Message[] = [
	MESSAGES_DEV_1[0],
	MESSAGES_DEV_1[6],
	{
		id: 'msg_hit_03',
		device_id: DEV_1.device_id,
		direction: 'out',
		peer: '+8801712884410',
		body: 'Security code verified on gateway node 2.',
		state: 'delivered',
		local_id: 'loc_hit_03',
		created_at: NOW - 22 * HOUR
	},
	{
		id: 'msg_hit_04',
		device_id: DEV_1.device_id,
		direction: 'in',
		peer: '+15550174400',
		body: 'Please resend the entry code for bay 4.',
		state: 'received',
		local_id: null,
		created_at: NOW - 30 * HOUR
	}
];

const SEARCH_TRUNCATED: Message[] = Array.from({ length: 100 }, (_, i) => ({
	id: `msg_otp_${i + 1}`,
	device_id: DEV_1.device_id,
	direction: i % 3 === 0 ? ('out' as const) : ('in' as const),
	peer: `+880171100${String(1000 + i).padStart(4, '0')}`,
	body: `OTP ${100000 + i * 73}: login confirmation from DakFlare relay.`,
	state: i % 3 === 0 ? 'delivered' : 'received',
	local_id: i % 3 === 0 ? `loc_otp_${i + 1}` : null,
	created_at: NOW - (i + 1) * 5 * MIN
}));

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

	const devices =
		key === 'no-device' ? [] : key === 'multi-device' ? [DEV_1, DEV_2] : [DEV_1];

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
				return DEFAULT_TARGET;
			case 'schema_version':
				return 8;
			case 'list_devices':
				if (key === 'boot-error') return Promise.reject('SQLite error: database file is locked');
				return devices;
			case 'get_last_contact':
				return args.deviceId === DEV_2.device_id ? NOW - 5 * MIN : NOW - 35_000;
			case 'get_device_pairing':
				return NOW - 10 * 24 * HOUR;
			case 'get_offline':
				return false;
			case 'get_device_facts':
				return DEFAULT_FACTS;
			case 'list_messages_page': {
				if (key === 'loading') return hold();
				if (key === 'load-error') {
					return Promise.reject('SQLite error: unable to read messages page');
				}
				const beforeCreatedAt = args.beforeCreatedAt as number | null;
				if (key === 'loading-older' && beforeCreatedAt !== null) return hold();
				if (key === 'empty') return { messages: [], has_more: false };
				if (key === 'one-thread') return { messages: [MESSAGES_DEV_1[0]], has_more: false };
				if (key === 'multi-device' && args.deviceId === DEV_2.device_id) {
					return { messages: MESSAGES_DEV_2, has_more: false };
				}
				return {
					messages: MESSAGES_DEV_1,
					has_more: key === 'has-more' || key === 'loading-older'
				};
			}
			case 'search_messages':
				if (key === 'searching') return hold();
				if (key === 'search-empty') return { messages: [], truncated: false };
				if (key === 'search-error') {
					return Promise.reject('SQLite FTS index unavailable on this handset');
				}
				if (key === 'search-hits') return { messages: SEARCH_HITS, truncated: false };
				if (key === 'search-truncated') return { messages: SEARCH_TRUNCATED, truncated: true };
				return { messages: [], truncated: false };
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

	if (key === 'booting' || key === 'loading') {
		void app.boot();
		return;
	}

	await app.boot();
	if (myEpoch !== epoch) return;
}
