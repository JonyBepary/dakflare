import {
	ARCHIVED_DEVICE,
	REVOKED_DEVICE,
	SAMPLE_DEVICES,
	hold,
	installStateStub,
	json,
	offline,
	type WorkbenchScenario
} from './stub';

export type DevicesStateKey =
	| 'loading'
	| 'empty'
	| 'fleet-healthy'
	| 'fleet-degraded-offline'
	| 'with-archived-and-revoked'
	| 'load-error'
	| 'member-session'
	| 'mint-open-enroll'
	| 'mint-waiting-qr'
	| 'mint-paired'
	| 'mint-expired';

const DEVICES_KEYS: ReadonlyArray<DevicesStateKey> = [
	'loading',
	'empty',
	'fleet-healthy',
	'fleet-degraded-offline',
	'with-archived-and-revoked',
	'load-error',
	'member-session',
	'mint-open-enroll',
	'mint-waiting-qr',
	'mint-paired',
	'mint-expired'
];

function isDevicesState(raw: string | null): raw is DevicesStateKey {
	return raw !== null && (DEVICES_KEYS as readonly string[]).includes(raw);
}

const NOW = Date.now();

const NEWLY_PAIRED = {
	device_id: 'dev_op12_ops_05',
	label: 'OnePlus 12 · Ops',
	fcm_token: 'fcm_op12_live',
	paired_at: NOW - 1_000,
	last_seen: NOW - 500,
	sim_slot: 0,
	archived_at: null,
	revoked_at: null
};

const STALE_OR_OFFLINE_DEVICES = [
	{
		...SAMPLE_DEVICES[0],
		last_seen: NOW - 45 * 60_000
	},
	{
		...SAMPLE_DEVICES[1],
		fcm_token: null,
		last_seen: null
	}
];

function scenarioFor(state: DevicesStateKey): WorkbenchScenario {
	let mintedPaired = false;

	return {
		role: state === 'member-session' ? 'member' : 'owner',
		handle: (method, path, url) => {
			if (path.endsWith('/v1/devices')) {
				if (state === 'loading') return hold();
				if (state === 'load-error') return offline();
				if (state === 'empty') return json({ devices: [] });

				const includeArchived = url.searchParams.get('include_archived') === '1';
				if (state === 'fleet-degraded-offline') {
					return json({ devices: STALE_OR_OFFLINE_DEVICES });
				}
				if (state === 'with-archived-and-revoked') {
					const list = includeArchived
						? [...SAMPLE_DEVICES, ARCHIVED_DEVICE, REVOKED_DEVICE]
						: [...SAMPLE_DEVICES, REVOKED_DEVICE];
					return json({ devices: list });
				}
				if (state === 'mint-paired' && mintedPaired) {
					return json({ devices: [...SAMPLE_DEVICES, NEWLY_PAIRED] });
				}
				return json({ devices: SAMPLE_DEVICES });
			}
			if (path.includes('/v1/device/') && path.endsWith('/status')) {
				if (state === 'fleet-degraded-offline') {
					return json({ ws_connected: false, queue_depth: 4, last_poll_at: NOW - 45 * 60_000 });
				}
				if (path.includes('dev_ga54_field_02')) {
					return json({ ws_connected: false, queue_depth: 1, last_poll_at: NOW - 3 * 60_000 });
				}
				return json({ ws_connected: true, queue_depth: 0, last_poll_at: NOW - 18_000 });
			}
			if (method === 'POST' && path.endsWith('/v1/admin/pairing-code')) {
				if (state === 'mint-paired') mintedPaired = true;
				return json({
					pairing_code: 'dak_pair_01jd8zk4n9m2w7x5',
					expires_at: state === 'mint-expired' ? Date.now() + 200 : Date.now() + 900_000,
					device_id: null,
					purpose: 'enroll'
				});
			}
			return null;
		}
	};
}

export const ssr = false;
export const prerender = true;

export function load({ url }: { url: URL }): { state: DevicesStateKey } {
	const asked = url.searchParams.get('__state');
	const state: DevicesStateKey = isDevicesState(asked) ? asked : 'fleet-healthy';
	installStateStub(scenarioFor(state));
	return { state };
}
