/**
 * Archive state of one device row.
 *
 * `archived_at` is the only signal: a number means the operator archived it, and
 * `null` or a missing field (a Worker without the column yet) means the device is
 * in the fleet. Nothing else about a device is changed by archiving, which is why
 * this is a predicate and not a state machine.
 */

import type { Device } from './types';

export function isArchived(device: Pick<Device, 'archived_at'>): boolean {
	const at = device.archived_at;
	return typeof at === 'number' && Number.isFinite(at) && at > 0;
}

/** The stamp for "archived 3d ago", or `null` for a device still in the fleet. */
export function archivedAt(device: Pick<Device, 'archived_at'>): number | null {
	return isArchived(device) ? (device.archived_at as number) : null;
}
