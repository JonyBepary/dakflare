/**
 * `POST /v1/agent/telemetry` — the client behind the console's one question box.
 *
 * The endpoint maps an operator question to ONE bounded query and returns rows.
 * It is read-only by construction: no message is written, no SMS is sent and no
 * grant is spent, which is why the panel that calls it can sit on the Overview
 * page next to the state it reads.
 *
 * Three rules shape this module:
 *
 *   1. Nothing here throws. A read that fails is an OUTCOME the panel renders, so
 *      the caller never needs a try/catch that would swallow a real bug into an
 *      empty table.
 *   2. The response is `unknown` until each field is checked. A missing plan, a
 *      missing `took_ms` or a row without a value becomes an em dash on screen;
 *      it is never filled in from the request.
 *   3. Rows are data. `telemetryTable` derives columns from the keys the rows
 *      actually carry and `telemetryCell` turns one value into one string; no key
 *      is renamed into a sentence and no row is summarised into prose.
 *
 * The permission is the Worker's, not this file's: `/v1/agent/telemetry` sits
 * behind `withAdminAccess(..., "read", ...)` (`worker/src/index.ts`), which every
 * signed-in role holds (`worker/src/auth/guard.ts`). The panel gates on the same
 * thing rather than inventing a narrower rule.
 */

import { formatAbsolute } from './format';

/** The six plans the Worker's allowlist accepts, verbatim (`routes/agent.ts`). */
export const TELEMETRY_PLANS = [
	'fleet_health',
	'stuck_outbox',
	'sim_signal_ranking',
	'workflow_failures',
	'authority_audit',
	'unmatched_drift'
] as const;

export type TelemetryPlan = (typeof TELEMETRY_PLANS)[number];

const PLAN_SET: ReadonlySet<string> = new Set(TELEMETRY_PLANS);

/** True when a server-supplied plan name is one of the six. Used to label, not to filter. */
export function isTelemetryPlan(value: unknown): value is TelemetryPlan {
	return typeof value === 'string' && PLAN_SET.has(value);
}

/**
 * One operator question per plan.
 *
 * Each sentence also names the area the Worker's deterministic keyword fallback
 * looks for (`PLAN_KEYWORDS` in `routes/agent.ts`), so an example still routes
 * during an AI outage rather than dead-ending in a 400.
 */
export const PLAN_EXAMPLE: Readonly<Record<TelemetryPlan, string>> = {
	fleet_health: 'Which devices are offline?',
	stuck_outbox: 'Which outbound messages are stuck?',
	sim_signal_ranking: 'Which SIMs have the worst signal?',
	workflow_failures: 'Which flow runs failed today?',
	authority_audit: 'What authority has been granted?',
	unmatched_drift: 'Where is extraction drifting?'
};

/** The example for a plan the console does not know falls back to the plan name itself. */
export function planExample(plan: string): string {
	return isTelemetryPlan(plan) ? PLAN_EXAMPLE[plan] : plan;
}

/* ------------------------------------------------------------------ shapes */

/** One row as the Worker sent it: flat, unknown, and printed as it arrived. */
export type TelemetryRow = Record<string, unknown>;

export interface TelemetryColumn {
	/** The row key, untouched. */
	key: string;
	/** The same key with underscores opened up, for the header cell only. */
	label: string;
	/** Share of the table's width, as a percentage, from the longest value in the column. */
	width: number;
}

export interface TelemetryTable {
	columns: TelemetryColumn[];
	/** Keys the cap left out, so the table can say it is narrower than the row. */
	hidden: number;
}

/** Six is the width a compact table can carry without squeezing a value to a stub. */
export const MAX_COLUMNS = 6;

/** A column is never narrower than this many characters, however short its values. */
const MIN_WEIGHT = 7;
/** Past this many characters a column is allowed to ellipsize rather than widen. */
const MAX_WEIGHT = 24;

/**
 * Columns come from the rows, in the order the keys first appear.
 *
 * `fleet_health` and `authority_audit` run two statements, and the Worker tags
 * every row with its `group`, so that lands first. Two groups with different
 * shapes produce a union; the cap keeps the first six and reports the rest
 * instead of silently dropping them.
 *
 * Widths come from the longest value each column actually carries, so a `group`
 * name does not get the same sixth of the table as a two-digit slot number. Any
 * value still longer than its share is ellipsized by the cell, with the whole
 * value in its title.
 */
export function telemetryTable(rows: TelemetryRow[], cap = MAX_COLUMNS): TelemetryTable {
	const keys: string[] = [];
	const seen = new Set<string>();
	for (const row of rows) {
		for (const key of Object.keys(row)) {
			if (seen.has(key)) continue;
			seen.add(key);
			keys.push(key);
		}
	}

	const kept = keys.slice(0, cap).map((key) => {
		let longest = key.length;
		for (const row of rows) {
			const length = telemetryCell(key, row[key]).text.length;
			if (length > longest) longest = length;
		}
		return {
			key,
			label: key.replaceAll('_', ' '),
			weight: Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, longest))
		};
	});

	const total = kept.reduce((sum, column) => sum + column.weight, 0);
	const columns = kept.map((column) => ({
		key: column.key,
		label: column.label,
		width: total === 0 ? 100 / Math.max(1, kept.length) : (column.weight / total) * 100
	}));

	return { columns, hidden: Math.max(0, keys.length - columns.length) };
}

export interface TelemetryCell {
	/** Always printable: an em dash when there is nothing to print. */
	text: string;
	/** The untruncated value, for a title, when the cell shortens it. */
	title: string | null;
	/** True for the em dash, so the cell can be toned down rather than read as data. */
	empty: boolean;
}

const EMPTY_CELL: TelemetryCell = { text: '—', title: null, empty: true };

/** Epoch milliseconds stored under a `_at` key (and `last_seen`) print as a stamp. */
function isInstantKey(key: string): boolean {
	return key === 'last_seen' || key.endsWith('_at');
}

/** A plausible `Date.now()` value, not a count that happens to be large. */
function isEpochMs(value: number): boolean {
	return Number.isFinite(value) && value > 1_000_000_000_000 && value < 10_000_000_000_000;
}

function fromObject(value: object): string {
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

/**
 * One value, one string. No prose, no rounding, no unit the payload did not carry.
 *
 * A `_at` column becomes an absolute stamp because that is the console's spelling
 * for a time everywhere else, and the raw number stays in the title. Every other
 * value is printed as it arrived, flattened onto one line because a table cell is
 * one line; the title keeps the untouched form.
 */
export function telemetryCell(key: string, value: unknown): TelemetryCell {
	if (value === null || value === undefined) return EMPTY_CELL;

	if (typeof value === 'string') {
		if (value === '') return EMPTY_CELL;
		const flat = value.replace(/\s+/g, ' ').trim();
		if (flat === '') return EMPTY_CELL;
		return { text: flat, title: flat === value ? null : value, empty: false };
	}

	if (typeof value === 'number') {
		if (isInstantKey(key) && isEpochMs(value)) {
			return { text: formatAbsolute(value), title: String(value), empty: false };
		}
		return { text: String(value), title: null, empty: false };
	}

	if (typeof value === 'boolean') {
		return { text: value ? 'true' : 'false', title: null, empty: false };
	}

	if (typeof value === 'object') {
		const text = fromObject(value);
		return text === '' ? EMPTY_CELL : { text, title: text.length > 42 ? text : null, empty: false };
	}

	// `bigint` and `symbol` cannot arrive over JSON, but `unknown` says they might.
	const text = String(value);
	return text === '' ? EMPTY_CELL : { text, title: null, empty: false };
}

/* ---------------------------------------------------------------- outcomes */

export interface TelemetryAnswer {
	/** The resolved plan, or a name the console does not know. `null` when absent. */
	plan: string | null;
	rows: TelemetryRow[];
	/**
	 * `null` when the field was absent: the note it drives is only shown for a
	 * literal `true`, so absence prints nothing rather than claiming "not cut".
	 */
	truncated: boolean | null;
	tookMs: number | null;
}

export type UnavailableReason =
	| 'network'
	| 'signed-out'
	| 'forbidden'
	| 'rate-limited'
	| 'plan-unavailable'
	| 'gateway';

export type TelemetryOutcome =
	| { kind: 'answered'; answer: TelemetryAnswer }
	| { kind: 'refused'; message: string | null; plans: string[] }
	| {
			kind: 'unavailable';
			reason: UnavailableReason;
			status: number;
			/** The endpoint's own sentence, when it sent one. Never a substituted one. */
			detail: string | null;
	  };

/* --------------------------------------------------------------- transport */

const ENDPOINT = '/v1/agent/telemetry';
const TIMEOUT_MS = 20_000;
/** The contract's own limit (`TelemetryBody`: `z.string().max(500)`). */
const MAX_QUESTION = 500;

function textField(payload: unknown, field: string): string | null {
	if (!payload || typeof payload !== 'object') return null;
	const value = (payload as Record<string, unknown>)[field];
	return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function rowsField(payload: unknown): TelemetryRow[] {
	if (!payload || typeof payload !== 'object') return [];
	const value = (payload as Record<string, unknown>).rows;
	if (!Array.isArray(value)) return [];
	return value.map((row) =>
		row !== null && typeof row === 'object' && !Array.isArray(row)
			? (row as TelemetryRow)
			: { value: row }
	);
}

function numberField(payload: unknown, field: string): number | null {
	if (!payload || typeof payload !== 'object') return null;
	const value = (payload as Record<string, unknown>)[field];
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The plan names a 400 carries; the contract's six when the body omitted them. */
function plansField(payload: unknown): string[] {
	if (!payload || typeof payload !== 'object') return [...TELEMETRY_PLANS];
	const value = (payload as Record<string, unknown>).plans;
	if (!Array.isArray(value)) return [...TELEMETRY_PLANS];
	const plans = value.filter((plan): plan is string => typeof plan === 'string' && plan !== '');
	return plans.length > 0 ? plans : [...TELEMETRY_PLANS];
}

function reasonFor(status: number): UnavailableReason {
	switch (status) {
		case 401:
			return 'signed-out';
		case 403:
			return 'forbidden';
		case 429:
			return 'rate-limited';
		case 503:
			// "Plan unavailable": the routing model is not answering. The Worker's
			// keyword fallback may still resolve the next question, so a retry is
			// worth offering rather than reporting the whole read as broken.
			return 'plan-unavailable';
		default:
			return 'gateway';
	}
}

async function readPayload(response: Response): Promise<unknown> {
	try {
		const text = await response.text();
		if (text === '') return null;
		try {
			return JSON.parse(text);
		} catch {
			return null;
		}
	} catch {
		// A body that dies mid-read is a read that failed, not an exception the
		// panel has to know about.
		return null;
	}
}

/**
 * Ask the gateway one question. Resolves to what happened; never rejects.
 *
 * The request carries `X-Admin-Session` because the legacy cookie gate refuses a
 * cookie-authenticated call without it, and `credentials: 'same-origin'` because
 * the session is the credential. A 401 here does not sign the operator out: this
 * is one read on one page, and the layout's own health poll owns that decision.
 */
export async function askFleet(question: string): Promise<TelemetryOutcome> {
	const asked = question.trim().slice(0, MAX_QUESTION);
	if (asked === '') {
		return {
			kind: 'refused',
			message: 'Nothing was sent: the question was empty.',
			plans: [...TELEMETRY_PLANS]
		};
	}

	let response: Response;
	try {
		response = await fetch(ENDPOINT, {
			method: 'POST',
			headers: {
				Accept: 'application/json',
				'Content-Type': 'application/json',
				// Not a secret: the Worker's CSRF marker for cookie-authenticated calls.
				'X-Admin-Session': '1'
			},
			credentials: 'same-origin',
			body: JSON.stringify({ question: asked }),
			signal: AbortSignal.timeout(TIMEOUT_MS)
		});
	} catch (error) {
		const detail =
			error instanceof DOMException && error.name === 'TimeoutError'
				? `No answer within ${Math.round(TIMEOUT_MS / 1000)} seconds.`
				: 'The request never reached the gateway.';
		return { kind: 'unavailable', reason: 'network', status: 0, detail };
	}

	const payload = await readPayload(response);

	if (response.ok) {
		return {
			kind: 'answered',
			answer: {
				plan: textField(payload, 'plan'),
				rows: rowsField(payload),
				truncated:
					payload !== null &&
					typeof payload === 'object' &&
					typeof (payload as Record<string, unknown>).truncated === 'boolean'
						? ((payload as Record<string, unknown>).truncated as boolean)
						: null,
				tookMs: numberField(payload, 'took_ms')
			}
		};
	}

	if (response.status === 400) {
		return {
			kind: 'refused',
			message: textField(payload, 'message'),
			plans: plansField(payload)
		};
	}

	return {
		kind: 'unavailable',
		reason: reasonFor(response.status),
		status: response.status,
		detail: textField(payload, 'message')
	};
}
