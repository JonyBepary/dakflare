import {
	DRIFT_ALERT,
	OFFLINE_ALERT,
	UNKNOWN_ALERT,
	installStateStub,
	type WorkbenchScenario
} from './stub';

export type AlertsStateKey =
	| 'extraction-drift'
	| 'device-offline'
	| 'unrecognised-kind'
	| 'mixed-kinds';

const ALERTS_KEYS: ReadonlyArray<AlertsStateKey> = [
	'extraction-drift',
	'device-offline',
	'unrecognised-kind',
	'mixed-kinds'
];

function isAlertsState(raw: string | null): raw is AlertsStateKey {
	return raw !== null && (ALERTS_KEYS as readonly string[]).includes(raw);
}

function scenarioFor(state: AlertsStateKey): WorkbenchScenario {
	return {
		// A member reads the same band without the acknowledge control.
		role: 'owner',
		alerts:
			state === 'extraction-drift'
				? [DRIFT_ALERT]
				: state === 'device-offline'
					? [OFFLINE_ALERT]
					: state === 'unrecognised-kind'
						? [UNKNOWN_ALERT]
						: [DRIFT_ALERT, OFFLINE_ALERT, UNKNOWN_ALERT],
		handle: () => null
	};
}

export const ssr = false;
export const prerender = true;

export function load({ url }: { url: URL }): { state: AlertsStateKey } {
	const asked = url.searchParams.get('__state');
	const state: AlertsStateKey = isAlertsState(asked) ? asked : 'extraction-drift';
	installStateStub(scenarioFor(state));
	return { state };
}
