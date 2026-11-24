import type { Device } from '$lib/types';
import {
	DEFAULT_DEVICE_DETAIL_STATE,
	DEVICE_LABELS,
	isDeviceDetailState,
	type DeviceDetailStateKey
} from './fixtures';
import { installStub, scenarioFor } from './stub';

export const ssr = false;
export const prerender = true;

export function load({ url }: { url: URL }): {
	state: DeviceDetailStateKey;
	role: 'owner' | 'member';
	deviceId: string;
	device: Device | null;
	deviceLabels: Record<string, string>;
} {
	const raw = url.searchParams.get('__state');
	const state = isDeviceDetailState(raw) ? raw : DEFAULT_DEVICE_DETAIL_STATE;
	const scenario = scenarioFor(state);

	if (typeof window !== 'undefined') {
		installStub(scenario);
	}

	return {
		state,
		role: scenario.role ?? 'owner',
		deviceId: scenario.deviceId,
		device: scenario.device,
		deviceLabels: DEVICE_LABELS
	};
}
