import {
	BASE_HEALTH,
	HISTORY_ALERTS,
	SAMPLE_DEVICES,
	hold,
	installStateStub,
	json,
	type WorkbenchScenario
} from './stub';

export type OverviewStateKey =
	| 'loading'
	| 'first-run-no-devices'
	| 'healthy-fleet'
	| 'active-alerts'
	| 'active-alerts-member'
	| 'alert-history'
	| 'alert-history-member'
	| 'degraded-storage'
	| 'load-error'
	| 'member-session'
	| 'autonomy-open';

const OVERVIEW_KEYS: ReadonlyArray<OverviewStateKey> = [
	'loading',
	'first-run-no-devices',
	'healthy-fleet',
	'active-alerts',
	'active-alerts-member',
	'alert-history',
	'alert-history-member',
	'degraded-storage',
	'load-error',
	'member-session',
	'autonomy-open'
];

function isOverviewState(raw: string | null): raw is OverviewStateKey {
	return raw !== null && (OVERVIEW_KEYS as readonly string[]).includes(raw);
}

const NOW = Date.now();

function scenarioFor(state: OverviewStateKey): WorkbenchScenario {
	return {
		role:
			state === 'member-session' || state === 'alert-history-member' || state === 'active-alerts-member'
				? 'member'
				: 'owner',
		autonomyOpen: state === 'autonomy-open',
		handle: (method, path, url) => {
			if (
				(state === 'alert-history' || state === 'alert-history-member') &&
				path.endsWith('/v1/admin/alerts')
			) {
				return json({ alerts: url.searchParams.get('all') === '1' ? HISTORY_ALERTS : [] });
			}
			if (path.endsWith('/v1/admin/health')) {
				if (state === 'loading') return hold();
				if (state === 'load-error') {
					return json({ error: 'internal_error', message: 'Worker health probe failed.' }, 500);
				}
				if (state === 'first-run-no-devices') {
					return json({
						...BASE_HEALTH,
						checked_at: NOW,
						counts: { devices: 0, messages: 0, rules: 0, pairing_codes: 0, open_alerts: 0 },
						open_alerts: 0,
						last_message_at: null
					});
				}
				if (state === 'active-alerts' || state === 'active-alerts-member') {
					return json({
						...BASE_HEALTH,
						checked_at: NOW,
						counts: { devices: 2, messages: 284, rules: 4, pairing_codes: 0, open_alerts: 2 },
						open_alerts: 2
					});
				}
				if (state === 'degraded-storage') {
					return json(
						{
							...BASE_HEALTH,
							ok: false,
							schema_ready: false,
							missing_bindings: ['SMS_QUEUE'],
							db_error: 'D1 read timed out after 3000 ms',
							counts: null,
							open_alerts: 0,
							checked_at: NOW
						},
						503
					);
				}
				return json({ ...BASE_HEALTH, checked_at: NOW });
			}
			if (path.endsWith('/v1/devices')) {
				if (state === 'loading') return hold();
				if (state === 'first-run-no-devices') return json({ devices: [] });
				return json({ devices: SAMPLE_DEVICES });
			}
			if (path.includes('/v1/device/') && path.endsWith('/status')) {
				if (state === 'active-alerts' && path.includes('dev_ga54_field_02')) {
					return json({ ws_connected: false, queue_depth: 3, last_poll_at: NOW - 40 * 60_000 });
				}
				return json({ ws_connected: true, queue_depth: 0, last_poll_at: NOW - 15_000 });
			}
			if (path.endsWith('/v1/admin/alerts')) {
				if (state === 'active-alerts' || state === 'active-alerts-member') {
					return json({
						alerts: [
							{
								id: 'alt_01',
								device_id: 'dev_ga54_field_02',
								label: 'Galaxy A54 · Field',
								kind: 'device_offline',
								raised_at: NOW - 24 * 60_000,
								acknowledged_at: null,
								detail: 'No authenticated poll or socket ping in 24 minutes.'
							},
							{
								id: 'alt_02',
								device_id: 'dev_px6a_desk_01',
								label: 'Pixel 6a · Desk',
								kind: 'device_offline',
								raised_at: NOW - 3 * 3_600_000,
								acknowledged_at: null,
								detail: 'Socket dropped during background battery optimization.'
							}
						]
					});
				}
				return json({ alerts: [] });
			}
			if (method === 'POST' && path.endsWith('/v1/admin/alerts/ack-all')) {
				return json({ ok: true, acknowledged: 2 });
			}
			return null;
		}
	};
}

export const ssr = false;
export const prerender = true;

export function load({ url }: { url: URL }): { state: OverviewStateKey } {
	const asked = url.searchParams.get('__state');
	const state: OverviewStateKey = isOverviewState(asked) ? asked : 'healthy-fleet';
	installStateStub(scenarioFor(state));
	return { state };
}
