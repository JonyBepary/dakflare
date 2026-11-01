/**
 * Words for the approval sheet.
 *
 * The ladder and the ceiling come from the deployment, never from a list the
 * phone keeps: a rung the phone invented is a rung the Worker might refuse.
 */

/** A duration in seconds as the shortest honest phrase: "1 minute", "30 days". */
export function durationWords(seconds: number): string {
	const value = Math.max(0, Math.floor(seconds));
	if (value === 0) return '0 seconds';
	if (value % 604800 === 0) return plural(value / 604800, 'week');
	if (value % 86400 === 0) return plural(value / 86400, 'day');
	if (value % 3600 === 0) return plural(value / 3600, 'hour');
	if (value % 60 === 0) return plural(value / 60, 'minute');
	return plural(value, 'second');
}

function plural(n: number, unit: string): string {
	return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/** What the scope lets the agent do, in the sheet's words. */
export function scopePhrase(scope: string): string {
	if (scope === 'sms:send:production') return 'send SMS to';
	if (scope === 'sms:send:test') return 'send a test SMS to';
	// An unknown scope is still shown, in its own vocabulary, rather than hidden.
	return scope.replace(/:/g, ' ');
}

/** The recipients a request applies to, or the handset when it names none. */
export function targetWords(target: { recipients?: string[] } | null | undefined): string {
	const recipients = target?.recipients?.filter((value) => value.trim().length > 0) ?? [];
	return recipients.length > 0 ? recipients.join(', ') : 'this handset';
}

/** A live countdown: "12:04", "1h 03m", or the expired state. */
export function countdown(expiresAt: number, now: number): string {
	const left = expiresAt - now;
	if (left <= 0) return 'expired';
	const total = Math.ceil(left / 1000);
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;
	if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
	return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** True when the scope's ceiling is below this rung, so it cannot be granted as-is. */
export function rungBlocked(rung: number, maxSeconds: number): boolean {
	return rung > maxSeconds;
}

/**
 * The confirmation for a grant.
 *
 * `granted_s` is the deployment's number. When `clamped` is true the sheet says
 * the ceiling shortened the request rather than echoing the tapped duration.
 */
export function grantSentence(grant: {
	granted_s: number;
	requested_s: number;
	clamped: boolean;
	max_s: number;
	expires_at: number;
}): string {
	const granted = `Approved for ${durationWords(grant.granted_s)}.`;
	const expiry = ` It expires at ${clock(grant.expires_at)}.`;
	if (!grant.clamped) return `${granted}${expiry}`;
	return (
		`${granted} You asked for ${durationWords(grant.requested_s)}, but this scope allows at ` +
		`most ${durationWords(grant.max_s)}, so the grant was shortened.${expiry}`
	);
}

function clock(ms: number): string {
	return new Intl.DateTimeFormat(undefined, {
		hour: '2-digit',
		minute: '2-digit',
		hour12: false
	}).format(new Date(ms));
}
