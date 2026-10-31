/**
 * "3 workflows copied from Mi A3 when this phone was paired."
 *
 * The pair response carries `copied_workflows`, but that answer is consumed by
 * the phone, so the console cannot read it. What the console *can* read is the
 * audit row the gateway writes while it pairs: action `workflows.copied`, with
 * the new device as its subject.
 *
 * The frozen contract names the action and not the `detail` shape, so this
 * accepts the field names the Worker may reasonably use, and returns `null`
 * rather than a guess when the row carries no count it can trust. Add a name to
 * these lists — never a second parser — when the Worker settles on one.
 */

import type { AuditEvent } from './types';

export const COPIED_WORKFLOWS_ACTION = 'workflows.copied';

export interface CopiedFlows {
	/** Always 1 or more: a zero-copy pairing has nothing to say. */
	count: number;
	/** The device the flows came from, when the row names it. */
	fromId: string | null;
	/** A display label for that device, when the row carries one. */
	fromLabel: string | null;
	/** When the copy happened — the pairing. */
	at: number;
}

const COUNT_KEYS = ['copied', 'count', 'copied_workflows'] as const;
const FROM_ID_KEYS = [
	'from',
	'from_device_id',
	'source',
	'source_device_id',
	'previous_device_id',
	'old_device_id'
] as const;
const FROM_LABEL_KEYS = ['from_label', 'source_label', 'from_device_label'] as const;
const DEVICE_KEYS = ['device_id', 'to', 'to_device_id', 'new_device_id'] as const;

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function asText(value: unknown): string | null {
	return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** A count is a positive whole number, whether the row stored it as 3 or "3". */
function asCount(value: unknown): number | null {
	const number = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(number) || number < 1) return null;
	return Math.floor(number);
}

function pick(detail: Record<string, unknown>, keys: readonly string[]): unknown {
	for (const key of keys) {
		if (detail[key] !== undefined && detail[key] !== null) return detail[key];
	}
	return undefined;
}

/**
 * The newest `workflows.copied` row that belongs to this device, or `null`.
 *
 * Events arrive newest first, so the first match is the pairing that is still
 * relevant: a phone re-paired later has its own row.
 */
export function copiedFlowsFor(
	events: readonly AuditEvent[],
	deviceId: string
): CopiedFlows | null {
	if (!deviceId) return null;
	for (const event of events) {
		if (event.action !== COPIED_WORKFLOWS_ACTION) continue;
		const detail = record(event.detail);
		// A bare number is the count and nothing else.
		const bare = typeof event.detail === 'number' ? event.detail : null;
		const subject =
			event.subject === deviceId ||
			(bare === null && detail !== null && asText(pick(detail, DEVICE_KEYS)) === deviceId);
		if (!subject) continue;
		const count = asCount(bare ?? (detail ? pick(detail, COUNT_KEYS) : undefined));
		if (count === null) continue;
		return {
			count,
			fromId: detail ? asText(pick(detail, FROM_ID_KEYS)) : null,
			fromLabel: detail ? asText(pick(detail, FROM_LABEL_KEYS)) : null,
			at: event.at
		};
	}
	return null;
}
