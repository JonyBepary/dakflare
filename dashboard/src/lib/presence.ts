/**
 * Device reachability vocabulary (CONSOLE_UX §2).
 *
 * `ws_connected` alone cannot describe a phone: a backgrounded handset is not
 * "idle", and `paired_at` is not a contact time. Presence is computed from the
 * socket plus the authenticated `last_seen` timestamp; wake capability is a
 * separate fact (`push` when an FCM token exists, `poll-only` otherwise).
 */

import type { Device } from './types';

export type DevicePresence = 'live' | 'synced' | 'stale' | 'offline' | 'unknown';
export type WakeMode = 'push' | 'poll-only';
export type PresenceTone = 'ok' | 'warn' | 'danger' | 'muted';

export const SYNCED_MAX_MS = 15 * 60_000;
export const STALE_MAX_MS = 24 * 60 * 60_000;

export interface PresenceMeta {
	label: DevicePresence;
	tone: PresenceTone;
	meaning: string;
}

export const PRESENCE_META: Record<DevicePresence, PresenceMeta> = {
	live: { label: 'live', tone: 'ok', meaning: 'connected now' },
	synced: { label: 'synced', tone: 'ok', meaning: 'in contact within the last 15 minutes' },
	stale: { label: 'stale', tone: 'warn', meaning: 'last contact within 24 hours' },
	offline: { label: 'offline', tone: 'danger', meaning: 'no contact for more than 24 hours' },
	unknown: { label: 'unknown', tone: 'muted', meaning: 'no last contact recorded' }
};

type PresenceInput = Pick<Device, 'last_seen'>;

/**
 * A connected socket is direct evidence of reachability. Without one, trust
 * `last_seen`; a missing (or zero) timestamp is honestly unknown rather than
 * "just paired", which is what `paired_at` used to be mistaken for.
 */
export function devicePresence(
	device: PresenceInput,
	wsConnected: boolean | null | undefined,
	now = Date.now()
): DevicePresence {
	if (wsConnected === true) return 'live';
	const lastSeen = device.last_seen;
	if (typeof lastSeen !== 'number' || !Number.isFinite(lastSeen) || lastSeen <= 0) {
		return 'unknown';
	}
	const age = Math.max(0, now - lastSeen);
	if (age <= SYNCED_MAX_MS) return 'synced';
	if (age <= STALE_MAX_MS) return 'stale';
	return 'offline';
}

export function wakeMode(device: Pick<Device, 'fcm_token'>): WakeMode {
	return device.fcm_token ? 'push' : 'poll-only';
}

export function deviceLabel(device: Pick<Device, 'label'>): string | null {
	const label = device.label?.trim();
	return label ? label : null;
}

/** Label first when the gateway has one; the id stays the fallback primary. */
export function devicePrimary(device: Pick<Device, 'device_id' | 'label'>): string {
	return deviceLabel(device) ?? device.device_id;
}

/** The id is worth showing separately only when a label took the primary slot. */
export function deviceSecondary(
	device: Pick<Device, 'device_id' | 'label'>
): string | null {
	return deviceLabel(device) ? device.device_id : null;
}

/** Native `<option>` cannot be styled, so carry both values in one string. */
export function deviceOptionLabel(device: Pick<Device, 'device_id' | 'label'>): string {
	const label = deviceLabel(device);
	return label ? `${label} — ${device.device_id}` : device.device_id;
}

export function presenceCounts(states: readonly DevicePresence[]): Record<DevicePresence, number> {
	const counts: Record<DevicePresence, number> = {
		live: 0,
		synced: 0,
		stale: 0,
		offline: 0,
		unknown: 0
	};
	for (const state of states) counts[state] += 1;
	return counts;
}
