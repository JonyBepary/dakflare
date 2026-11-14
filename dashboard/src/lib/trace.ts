/**
 * Operator words for one id's provenance.
 *
 * The trace endpoint answers with a verdict, the lines that justify it and the
 * records it joined. Seven verdicts are possible (`reply-fate.ts`), and none of
 * them is a word the wire uses: `paused_hitl_approval` is a fact about a
 * permission, so the screen says "waiting for approval". An unknown verdict is
 * admitted rather than dropped, because a newer Worker may know more than this
 * console does.
 *
 * The nested records are read field by field and a missing field is skipped,
 * never printed as `undefined`: the Worker owns those shapes and may grow them.
 */

import type { TraceKind, TraceResult } from './types';
import { scopeTitle } from './approvals';
import { formatRelative } from './format';

export type TraceTone = 'ok' | 'warn' | 'danger' | 'accent' | 'muted' | 'neutral';

interface VerdictWords {
	label: string;
	tone: TraceTone;
	note: string;
}

const VERDICTS: Record<string, VerdictWords> = {
	replied: {
		label: 'Replied',
		tone: 'ok',
		note: 'A reply was queued and the phone accepted it.'
	},
	queued: {
		label: 'Queued',
		tone: 'accent',
		note: 'A reply is queued but the phone has not reported a result yet.'
	},
	failed: {
		label: 'Failed',
		tone: 'danger',
		note: 'The reply reached the phone and the send did not go through.'
	},
	suppressed_cooldown: {
		label: 'Held by a cooldown',
		tone: 'warn',
		note: 'A rule matched, and its cooldown window was still open.'
	},
	suppressed_hourly_cap: {
		label: 'Held by the hourly cap',
		tone: 'warn',
		note: 'A rule matched, and it had already replied as often as it may this hour.'
	},
	no_match: {
		label: 'Nothing matched',
		tone: 'muted',
		note: 'Automation ran on this message and no rule or flow answered it.'
	},
	paused_hitl_approval: {
		label: 'Waiting for approval',
		tone: 'warn',
		note: 'An agent asked to do this, and nobody has answered the request yet.'
	}
};

export function verdictLabel(verdict: string | null | undefined): string {
	if (!verdict) return 'No verdict';
	return VERDICTS[verdict]?.label ?? 'An outcome this console does not know';
}

export function verdictTone(verdict: string | null | undefined): TraceTone {
	if (!verdict) return 'muted';
	return VERDICTS[verdict]?.tone ?? 'muted';
}

/** One sentence saying what the verdict means, for the line under it. */
export function verdictNote(verdict: string | null | undefined): string | null {
	if (!verdict) return null;
	return VERDICTS[verdict]?.note ?? null;
}

/** "a message", "an approval request": what the id turned out to be. */
export function traceKindNoun(kind: TraceKind | string): string {
	switch (kind) {
		case 'message':
			return 'a message';
		case 'command':
			return 'a command';
		case 'approval':
			return 'an approval request';
		default:
			return 'nothing this deployment knows';
	}
}

export interface LineageRow {
	label: string;
	value: string;
	note: string | null;
}

function text(value: unknown): string | null {
	if (typeof value === 'string' && value.trim() !== '') return value.trim();
	if (typeof value === 'number' && Number.isFinite(value)) return String(value);
	return null;
}

function record(value: unknown): Record<string, unknown> | null {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
	return value as Record<string, unknown>;
}

function records(value: unknown): Array<Record<string, unknown>> {
	if (!Array.isArray(value)) return [];
	return value.flatMap((entry) => {
		const row = record(entry);
		return row === null ? [] : [row];
	});
}

/** An epoch millisecond count as "4m ago"; anything else is left alone. */
function moment(value: unknown): string | null {
	const raw = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
	if (!Number.isFinite(raw) || raw <= 0) return text(value);
	return formatRelative(raw);
}

function stateWord(state: string | null): string | null {
	if (state === null) return null;
	const words: Record<string, string> = {
		PENDING: 'queued',
		LEASED: 'handed over',
		DISPATCHED: 'received by the phone',
		SENT: 'sent',
		DELIVERED: 'delivered',
		FAILED: 'failed',
		EXPIRED: 'never collected',
		PENDING_APPROVAL: 'waiting'
	};
	return words[state] ?? state.toLowerCase().replace(/_/g, ' ');
}

/**
 * The chain the trace joined, in the order it happened: what came in, what
 * automation did, what was queued, and what the phone's own object still holds.
 * A row exists only when the trace found something to put in it.
 */
export function traceLineage(trace: TraceResult): LineageRow[] {
	const rows: LineageRow[] = [];
	const message = record(trace.message);
	const approval = record(trace.approval);
	const command = record(trace.command);
	const durable = record(trace.durable_object);

	if (message !== null) {
		const id = text(message.id);
		const peer = text(message.peer);
		const direction = text(message.direction);
		if (id !== null) {
			rows.push({
				label: 'Message',
				value: id,
				note: [peer, direction === 'out' ? 'outbound' : 'inbound'].filter(Boolean).join(' · ')
			});
		}
	}

	if (approval !== null) {
		const id = text(approval.id);
		const scope = text(approval.scope);
		const state = text(approval.state);
		if (id !== null) {
			rows.push({
				label: 'Approval',
				value: id,
				note: [scope === null ? null : scopeTitle(scope), stateWord(state)]
					.filter(Boolean)
					.join(' · ')
			});
		}
	}

	const ruleRows = records(trace.automation?.rules);
	if (ruleRows.length > 0) {
		const ids = ruleRows.flatMap((row) => {
			const id = text(row.rule_id) ?? text(row.id);
			return id === null ? [] : [id];
		});
		if (ids.length > 0) {
			rows.push({
				label: ids.length === 1 ? 'Rule' : 'Rules',
				value: ids.join(', '),
				note: null
			});
		}
	}

	const flowRows = records(trace.automation?.flows);
	for (const flow of flowRows) {
		const id = text(flow.flow_id);
		if (id === null) continue;
		const version = text(flow.flow_version);
		const outcome = text(flow.outcome);
		rows.push({
			label: 'Flow run',
			value: version === null ? id : `${id} v${version}`,
			note: outcome
		});
	}

	if (command !== null) {
		const id = text(command.command_id);
		if (id !== null) {
			rows.push({
				label: 'Command',
				value: id,
				note: stateWord(text(command.state))
			});
		}
	}

	if (durable !== null) {
		const dead = records(durable.dead_letters);
		for (const letter of dead) {
			const kind = text(letter.kind) ?? 'task';
			const attempts = text(letter.attempts);
			const failedAt = moment(letter.failed_at);
			rows.push({
				label: 'Dead letter',
				value: kind,
				note: [attempts === null ? null : `after ${attempts} attempts`, failedAt]
					.filter(Boolean)
					.join(' · ')
			});
		}
		const tasks = records(durable.scheduled_tasks);
		if (tasks.length > 0) {
			const kinds = tasks.flatMap((task) => {
				const kind = text(task.kind);
				return kind === null ? [] : [kind];
			});
			if (kinds.length > 0) {
				rows.push({
					label: kinds.length === 1 ? 'Pending timer' : 'Pending timers',
					value: kinds.join(', '),
					note: null
				});
			}
		}
	}

	return rows;
}

/** Audit lines about this id, newest first: who did what, and when. */
export function traceAuditRows(trace: TraceResult): LineageRow[] {
	return records(trace.audit)
		.slice(0, 4)
		.flatMap((row) => {
			const action = text(row.action);
			if (action === null) return [];
			const actor = text(row.actor_label) ?? text(row.actor_user);
			const at = moment(row.at);
			return [
				{
					label: 'Audit',
					value: action,
					note: [actor, at].filter(Boolean).join(' · ')
				}
			];
		});
}
