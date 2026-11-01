/**
 * Operator words for the agent control plane.
 *
 * A scope is a wire value (`sms:send:production`), and an operator deciding a
 * request should never have to decode one. Every scope this console can meet has
 * a sentence here; anything newer falls back to a plain statement that the
 * permission is unrecognised, and the raw value is still shown beside it so a
 * CLI user can match the two.
 *
 * The ladder labels and durations are derived from the seconds the API sends,
 * never from a list in this file: `GRANT_LADDER_S` lives in the Worker, and a
 * second copy here would drift.
 */

interface ScopeWords {
	/** What the agent is asking to do, in operator words. */
	title: string;
	/** Why the scope's ceiling exists, given the ceiling already formatted. */
	cap: (max: string) => string;
}

const SCOPE_WORDS: Record<string, ScopeWords> = {
	'sms:send:production': {
		title: 'Send production SMS',
		cap: (max) => `Production SMS is capped at ${max}.`
	},
	enable_shortcode: {
		title: 'Accept messages from shortcodes',
		cap: (max) => `Shortcode messages are capped at ${max}.`
	},
	dlq_bulk_replay: {
		title: 'Retry a batch of failed messages',
		cap: (max) => `Bulk replays are capped at ${max}.`
	},
	flow_deploy_prod: {
		title: 'Deploy a flow to production',
		cap: (max) => `Production flow deploys are capped at ${max}.`
	},
	'rules:write': {
		title: 'Edit automation rules',
		cap: (max) => `Rule edits are capped at ${max}.`
	},
	'webhooks:write': {
		title: 'Edit webhooks',
		cap: (max) => `Webhook edits are capped at ${max}.`
	},
	'messages:read': {
		title: 'Read messages',
		cap: (max) => `Message reads are capped at ${max}.`
	},
	'devices:read': {
		title: 'Read devices',
		cap: (max) => `Device reads are capped at ${max}.`
	},
	'flows:read': {
		title: 'Read automation',
		cap: (max) => `Automation reads are capped at ${max}.`
	},
	'audit:read': {
		title: 'Read the audit log',
		cap: (max) => `Audit reads are capped at ${max}.`
	},
	'sms:send': {
		title: 'Send SMS',
		cap: (max) => `Agent sends are capped at ${max}.`
	},
	'messages:purge': {
		title: 'Delete message history',
		cap: (max) => `Message deletion is capped at ${max}.`
	},
	'alerts:write': {
		title: 'Acknowledge alerts',
		cap: (max) => `Alert changes are capped at ${max}.`
	},
	'flows:write': {
		title: 'Save automation flows',
		cap: (max) => `Flow edits are capped at ${max}.`
	},
	'devices:write': {
		title: 'Manage handsets',
		cap: (max) => `Handset changes are capped at ${max}.`
	}
};

/** The human sentence for a scope. Never returns the raw value on its own. */
export function scopeTitle(scope: string): string {
	return SCOPE_WORDS[scope]?.title ?? 'An unrecognised permission';
}

/** Plain seconds as words: 900 becomes "15 minutes", 86400 becomes "1 day". */
export function durationWords(seconds: number): string {
	const value = Math.max(0, Math.round(seconds));
	if (value < 60) return `${value} ${value === 1 ? 'second' : 'seconds'}`;
	if (value < 3_600) {
		const minutes = Math.round(value / 60);
		return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
	}
	if (value < 86_400) {
		const hours = Math.round(value / 3_600);
		return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
	}
	const days = Math.round(value / 86_400);
	return `${days} ${days === 1 ? 'day' : 'days'}`;
}

/** A ladder rung as a control label: 60 becomes "1m", 604800 becomes "7d". */
export function rungLabel(seconds: number): string {
	if (seconds >= 86_400 && seconds % 86_400 === 0) return `${seconds / 86_400}d`;
	if (seconds >= 3_600 && seconds % 3_600 === 0) return `${seconds / 3_600}h`;
	if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60}m`;
	return `${seconds}s`;
}

/** The scope's ceiling in a sentence, or `null` when the scope has no rule. */
export function scopeCapNote(scope: string, maxS: number | null): string | null {
	if (maxS === null) return null;
	const max = durationWords(maxS);
	return SCOPE_WORDS[scope]?.cap(max) ?? `This permission is capped at ${max}.`;
}

/** "1d, 7d and 30d", used for the rungs a ceiling puts out of reach. */
export function listWords(items: string[]): string {
	if (items.length === 0) return '';
	if (items.length === 1) return items[0];
	return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * A countdown for the card, at the precision that matters:
 * days for long grants, minutes for the common case, seconds for the last hour.
 */
export function countdownLabel(ms: number): string {
	if (ms <= 0) return 'Expired';
	let total = Math.ceil(ms / 1_000);
	const days = Math.floor(total / 86_400);
	total %= 86_400;
	const hours = Math.floor(total / 3_600);
	total %= 3_600;
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	const pad = (value: number) => String(value).padStart(2, '0');

	if (days > 0) return `${days}d ${pad(hours)}h`;
	if (hours > 0) return `${hours}h ${pad(minutes)}m`;
	if (minutes > 0) return `${minutes}m ${pad(seconds)}s`;
	return `${seconds}s`;
}
