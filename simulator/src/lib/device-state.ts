/**
 * The five device states from CONSOLE_UX.md §2, derived from the only evidence
 * this shell actually has: the carrier toggle and the last successful signed
 * contact (poll, self-pair or pair-with-code) in this session.
 *
 * `live` is not a socket state here — the webview cannot see the device
 * socket. A signed poll that answered under two minutes ago is the closest
 * honest reading, and it is labelled as such on screen.
 */
export type DeviceState = 'live' | 'synced' | 'stale' | 'offline' | 'unknown';

export const STATE_LABEL: Record<DeviceState, string> = {
	live: 'live',
	synced: 'synced',
	stale: 'stale',
	offline: 'offline',
	unknown: 'unknown'
};

const TWO_MIN = 2 * 60 * 1000;
const FIFTEEN_MIN = 15 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

export function deviceState(
	offline: boolean,
	contactAt: number | null | undefined,
	now = Date.now()
): DeviceState {
	// The carrier switch is a local fact and outranks a stale contact timestamp.
	if (offline) return 'offline';
	if (!contactAt) return 'unknown';
	const age = now - contactAt;
	if (age <= TWO_MIN) return 'live';
	if (age <= FIFTEEN_MIN) return 'synced';
	if (age <= DAY) return 'stale';
	return 'offline';
}

export function stateSentence(state: DeviceState, lastContact: number | null): string {
	switch (state) {
		case 'live':
			return 'Reachable now. A signed poll answered moments ago.';
		case 'synced':
			return 'Reachable on its next poll. It answered a signed contact recently.';
		case 'stale':
			return 'May be asleep or backgrounded. The last signed contact is getting old.';
		case 'offline':
			return lastContact
				? 'No signed contact in the last day. The deployment will read this phone as offline.'
				: 'The carrier is off on this phone. Nothing uploads until you turn it back on.';
		case 'unknown':
			return 'No signed contact recorded in this session. Poll from this screen to verify the phone.';
	}
}

export function relativeTime(ms: number | null | undefined, now = Date.now()): string {
	if (!ms) return 'no contact recorded';
	const diff = Math.max(0, now - ms);
	if (diff < 60_000) return 'just now';
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
	if (diff < DAY) return `${Math.floor(diff / 3_600_000)} h ago`;
	return `${Math.floor(diff / DAY)} d ago`;
}

export function formatWhen(ms: number): string {
	return new Intl.DateTimeFormat(undefined, {
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
		hour12: false
	}).format(new Date(ms));
}

export function formatClock(ms: number): string {
	return new Intl.DateTimeFormat(undefined, {
		hour: '2-digit',
		minute: '2-digit',
		hour12: false
	}).format(new Date(ms));
}

/** A day heading for a conversation; the hour stays on each bubble. */
export function formatDay(ms: number, now = Date.now()): string {
	const date = new Date(ms);
	const today = new Date(now);
	const yesterday = new Date(now);
	yesterday.setDate(today.getDate() - 1);

	const sameDay = (a: Date, b: Date) =>
		a.getFullYear() === b.getFullYear() &&
		a.getMonth() === b.getMonth() &&
		a.getDate() === b.getDate();

	if (sameDay(date, today)) return 'Today';
	if (sameDay(date, yesterday)) return 'Yesterday';
	return new Intl.DateTimeFormat(undefined, {
		weekday: 'short',
		month: 'short',
		day: 'numeric'
	}).format(date);
}
