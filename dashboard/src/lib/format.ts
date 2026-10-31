/** Human formatting for an operator console: relative times, absolute stamps, counts. */

const absoluteFormatter = new Intl.DateTimeFormat(undefined, {
	day: '2-digit',
	month: 'short',
	year: 'numeric',
	hour: '2-digit',
	minute: '2-digit',
	second: '2-digit'
});

const clockFormatter = new Intl.DateTimeFormat(undefined, {
	hour: '2-digit',
	minute: '2-digit'
});

const dateFormatter = new Intl.DateTimeFormat(undefined, {
	day: '2-digit',
	month: 'short',
	year: 'numeric'
});

const numberFormatter = new Intl.NumberFormat();

export function formatAbsolute(value: number | null | undefined): string {
	if (!value) return '—';
	return absoluteFormatter.format(new Date(value));
}

export function formatDate(value: number | null | undefined): string {
	if (!value) return '—';
	return dateFormatter.format(new Date(value));
}

export function formatClock(value: number | null | undefined): string {
	if (!value) return '—';
	return clockFormatter.format(new Date(value));
}

/** Past this age `formatRelative` answers with a full stamp instead of "12d ago". */
export const RELATIVE_MAX_MS = 7 * 86_400_000;

/** "just now", "4m ago", "3h ago", "12 Oct 2026, 14:03" — future values read "in 4m". */
export function formatRelative(value: number | null | undefined, now = Date.now()): string {
	if (!value) return 'never';
	const diff = value - now;
	const future = diff > 0;
	const abs = Math.abs(diff);

	let text: string;
	if (abs < 10_000) text = 'just now';
	else if (abs < 60_000) text = `${Math.round(abs / 1000)}s`;
	else if (abs < 3_600_000) text = `${Math.floor(abs / 60_000)}m`;
	else if (abs < 86_400_000) text = `${Math.floor(abs / 3_600_000)}h`;
	else if (abs < RELATIVE_MAX_MS) text = `${Math.floor(abs / 86_400_000)}d`;
	else return formatAbsolute(value);

	if (text === 'just now') return text;
	return future ? `in ${text}` : `${text} ago`;
}

/** Compact duration for TTLs and cooldowns: "90s", "5 min", "1 h", "24 h". */
export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return '0s';
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes} min`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours} h`;
	return `${Math.round(hours / 24)} d`;
}

export function formatCount(value: number | null | undefined): string {
	if (value === null || value === undefined || !Number.isFinite(value)) return '—';
	return numberFormatter.format(value);
}

export function utf8Bytes(value: string): number {
	return new TextEncoder().encode(value).length;
}

export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
	return count === 1 ? singular : pluralForm;
}
