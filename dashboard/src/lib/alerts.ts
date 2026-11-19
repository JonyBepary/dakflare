/**
 * Operator words for an alert.
 *
 * The banner used to read every row as silence: the headline was
 * "has not been heard from" whatever `kind` said, and neither `kind` nor
 * `detail` was ever rendered. An extraction-drift alert therefore read as a dead
 * phone, which is the one thing it is not.
 *
 * A kind owns three things here — its word, its loudness, and a sentence that is
 * true of it. The gateway does not send a severity, so severity follows the kind:
 * a phone that stopped answering is an outage and reads red; a flow that stopped
 * extracting is a warning; a kind this console has never heard of is neutral and
 * says so, because an unknown alert must never be dressed up as a known one.
 */

import type { Alert } from './types';
import { formatDuration } from './format';

export type AlertSeverity = 'danger' | 'warn' | 'info';

export interface AlertKind {
	/** How this console names the kind, in a chip. */
	label: string;
	/** `false` for a kind newer than this console: the raw `kind` is shown too. */
	known: boolean;
	severity: AlertSeverity;
	/** One alert of this kind, naming the device. */
	headline: (device: string) => string;
	/** Several alerts, all of this kind. */
	headlineMany: (count: number) => string;
	/** The `detail` in operator words. An empty list means it said nothing. */
	detail: (value: string | null) => string[];
}

const KINDS: Record<string, AlertKind> = {
	device_offline: {
		label: 'Device silent',
		known: true,
		severity: 'danger',
		headline: (device) => `${device} has not been heard from`,
		headlineMany: (count) => `${count} devices have not been heard from`,
		detail: (value) => {
			if (value === null) return [];
			// The gateway writes "device silent for 1800000 ms (last_seen <iso>)".
			// The count is as of the moment the alert was raised, which is the fact;
			// the row's own "raised …" already carries how long ago that was.
			const silent = /device silent for (\d+) ms/i.exec(value);
			if (silent !== null) {
				return [`No authenticated contact for ${formatDuration(Number(silent[1]))}.`];
			}
			if (/last_seen unknown/i.test(value)) {
				return ['The gateway has no record of when this phone last answered.'];
			}
			return [value];
		}
	},
	extraction_drift: {
		label: 'Extraction drift',
		known: true,
		severity: 'warn',
		headline: (device) => `${device} is running a flow that cannot read what it expects`,
		headlineMany: (count) => `${count} devices are running a flow that cannot read what it expects`,
		detail: (value) => driftLines(value)
	}
};

/** The kind's words, or a neutral statement for a kind this console does not know. */
export function alertKind(kind: string): AlertKind {
	const known = KINDS[kind];
	if (known !== undefined) return known;
	return {
		// The raw kind is the label: inventing words for a kind nobody here has
		// seen is how a new alert ends up described wrongly.
		label: kind,
		known: false,
		severity: 'info',
		headline: (device) => `${device} raised an alert this console does not recognise`,
		headlineMany: (count) => `${count} alerts this console does not recognise`,
		detail: (value) => (value === null ? [] : [value])
	};
}

/** The heading for one banner carrying zero or more alerts. */
export function alertsHeadline(alerts: Alert[]): string {
	const first = alerts[0];
	if (first === undefined) return '';
	if (alerts.length === 1) {
		return alertKind(first.kind).headline(alertName(first));
	}
	const kinds = new Set(alerts.map((alert) => alert.kind));
	if (kinds.size === 1) {
		return alertKind(first.kind).headlineMany(alerts.length);
	}
	// Mixed kinds: no single kind's sentence is true of the whole band.
	return `${alerts.length} alerts need attention`;
}

/** The loudest severity present: red beats amber beats neutral. */
export function alertsSeverity(alerts: Alert[]): AlertSeverity {
	if (alerts.some((alert) => alertKind(alert.kind).severity === 'danger')) return 'danger';
	if (alerts.some((alert) => alertKind(alert.kind).severity === 'warn')) return 'warn';
	return 'info';
}

/** A device's label, or its id when the fleet read could not name it. */
export function alertName(alert: Alert): string {
	const label = alert.label?.trim();
	return label ? label : alert.device_id;
}

/**
 * `{"drifts":[{ flow_id, flow_version, node_id, field, misses_last_hour,
 * last_miss_at }]}` — one entry per flow currently drifting. A detail this
 * console cannot parse is shown verbatim rather than dropped: the alert is still
 * true even when its shape is newer than this build.
 */
function driftLines(value: string | null): string[] {
	if (value === null || value.trim() === '') {
		return ['The gateway did not say which flow or field drifted.'];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return [value];
	}
	if (parsed === null || typeof parsed !== 'object') return [value];
	const drifts = (parsed as { drifts?: unknown }).drifts;
	if (!Array.isArray(drifts) || drifts.length === 0) return [value];

	const lines: string[] = [];
	for (const entry of drifts) {
		if (entry === null || typeof entry !== 'object') continue;
		const row = entry as Record<string, unknown>;
		const field = typeof row.field === 'string' ? row.field : null;
		const flow = typeof row.flow_id === 'string' ? row.flow_id : null;
		const node = typeof row.node_id === 'string' ? row.node_id : null;
		const misses = typeof row.misses_last_hour === 'number' ? row.misses_last_hour : null;

		const subject = field === null ? 'A capture group' : `“${field}”`;
		const count =
			misses === null
				? 'did not match'
				: `did not match in ${misses} ${misses === 1 ? 'message' : 'messages'} from the last hour`;
		const where = [flow === null ? null : `flow ${flow}`, node === null ? null : `step ${node}`]
			.filter((part): part is string => part !== null)
			.join(', ');
		lines.push(`${subject} ${count}${where === '' ? '' : ` (${where})`}.`);
	}
	return lines.length === 0 ? [value] : lines;
}
