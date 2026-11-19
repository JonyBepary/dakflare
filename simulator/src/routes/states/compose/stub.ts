import { app, type Device, type DeviceFacts, type TargetView } from '$lib/stores/app.svelte';
import { composer } from '$lib/stores/composer.svelte';

export const STATE_GROUPS: { id: string; label: string; items: { key: string; label: string }[] }[] = [
	{
		id: 'states-boot-access',
		label: 'Boot & Access',
		items: [
			{ key: 'booting', label: 'Booting' },
			{ key: 'no-backend', label: 'No backend' },
			{ key: 'no-device', label: 'No device' },
			{ key: 'permission-denied', label: 'Permission denied' },
			{ key: 'carrier-off', label: 'Carrier offline' },
			{ key: 'multi-device', label: 'Multi-device' }
		]
	},
	{
		id: 'states-recipient',
		label: 'Recipient',
		items: [
			{ key: 'blank', label: 'Blank form' },
			{ key: 'valid-recipient', label: 'Valid number' },
			{ key: 'mask-recipient', label: 'Mask sender' },
			{ key: 'shortcode-recipient', label: 'Shortcode' },
			{ key: 'bad-chars-recipient', label: 'Invalid characters' },
			{ key: 'short-recipient', label: 'Too short' },
			{ key: 'long-recipient', label: 'Too long' }
		]
	},
	{
		id: 'states-segments',
		label: 'Message & Segments',
		items: [
			{ key: 'gsm7-single', label: 'GSM-7 single' },
			{ key: 'gsm7-multi', label: 'GSM-7 multi-part' },
			{ key: 'ucs2-single', label: 'UCS-2 single' },
			{ key: 'ucs2-multi', label: 'UCS-2 multi-part' },
			{ key: 'over-cap', label: 'Over 1600 cap' }
		]
	},
	{
		id: 'states-send',
		label: 'Send',
		items: [
			{ key: 'sending', label: 'Sending' },
			{ key: 'send-failed', label: 'Send failed' }
		]
	}
];

export const DEFAULT_STATE = 'blank';
export const ALL_KEYS = STATE_GROUPS.flatMap((g) => g.items.map((i) => i.key));

export function resolveStateKey(raw: string | null): string {
	return raw && ALL_KEYS.includes(raw) ? raw : DEFAULT_STATE;
}

const NOW = Date.now();
const HOUR = 3_600_000;

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
	updated_at: NOW - 5 * 60_000
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

function applyComposerFixture(key: string) {
	switch (key) {
		case 'valid-recipient':
			composer.newMessage = { to: '+15550104829', body: '' };
			break;
		case 'mask-recipient':
			composer.newMessage = { to: 'DAKFLARE', body: 'Reply test' };
			break;
		case 'shortcode-recipient':
			composer.newMessage = { to: '16216', body: 'STOP' };
			break;
		case 'bad-chars-recipient':
			composer.newMessage = { to: '+1 (555) 010-4829', body: 'Hello' };
			break;
		case 'short-recipient':
			composer.newMessage = { to: '+1555', body: 'Hello' };
			break;
		case 'long-recipient':
			composer.newMessage = { to: '+155501048290123456', body: 'Hello' };
			break;
		case 'gsm7-single':
			composer.newMessage = {
				to: '+15550104829',
				body: 'Courier arriving at 14:30. Gate B is unlocked for drop-off.'
			};
			break;
		case 'gsm7-multi':
			composer.newMessage = {
				to: '+15550104829',
				body:
					'DakFlare dispatch manifest #483920: EUR 1250.00 cleared {bay-4} [SIM 1]. ' +
					'Courier arriving at 14:30 sharp with signed receipt; please confirm temperature log before sealing container #991.'
			};
			break;
		case 'ucs2-single':
			composer.newMessage = {
				to: '+8801711000002',
				body: 'আপনার যাচাইকরণ কোড ৪৮৩৯২০। এই কোড কারো সাথে শেয়ার করবেন না।'
			};
			break;
		case 'ucs2-multi':
			composer.newMessage = {
				to: '+8801711000002',
				body:
					'আপনার ডেলিভারি পার্সেল #৪৮৩৯২০ দক্ষিণ গেটে পৌঁছেছে। রসিদ সংগ্রহ করতে অনুগ্রহ করে কাউন্টার ২-এ যোগাযোগ করুন এবং পরিচয়পত্র সাথে রাখুন।'
			};
			break;
		case 'over-cap':
			composer.newMessage = {
				to: '+15550104829',
				body: 'A'.repeat(1605)
			};
			break;
		case 'sending':
		case 'send-failed':
			composer.newMessage = {
				to: '+15550104829',
				body: 'Courier arriving at 14:30. Gate B.'
			};
			break;
		default:
			composer.newMessage = { to: '', body: '' };
			break;
	}
}

export async function applyState(key: string): Promise<void> {
	const myEpoch = ++epoch;
	activeState = key;
	const noBackend = key === 'no-backend';
	resetStores(!noBackend);
	applyComposerFixture(key);

	if (noBackend) {
		delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
		await app.boot();
		return;
	}

	const devices =
		key === 'no-device' ? [] : key === 'multi-device' ? [DEV_1, DEV_2] : [DEV_1];

	const handle = (cmd: string): unknown => {
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
				return devices;
			case 'get_last_contact':
				return NOW - 35_000;
			case 'get_device_pairing':
				return NOW - 10 * 24 * HOUR;
			case 'get_offline':
				return key === 'carrier-off';
			case 'list_messages_page':
				return { messages: [], has_more: false };
			case 'get_device_facts':
				if (key === 'permission-denied') {
					return {
						...DEFAULT_FACTS,
						permissions: { sms: true, send: false, phone_numbers: true }
					};
				}
				return DEFAULT_FACTS;
			case 'send_sms':
				if (key === 'sending') return hold();
				if (key === 'send-failed') {
					return Promise.reject('SIM 1 radio error 38: network out of order');
				}
				return { local_id: 'loc_demo_01' };
			default:
				return null;
		}
	};

	(window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
		invoke: (cmd: string) => {
			if (myEpoch !== epoch) return hold();
			return Promise.resolve().then(() => {
				if (myEpoch !== epoch) return hold();
				return handle(cmd);
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
