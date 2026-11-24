import type { StateGroup } from './StateSwitcher.svelte';

export type MagicStateKey =
	| 'missing'
	| 'ready-with-email'
	| 'ready-anonymous'
	| 'pending'
	| 'done'
	| 'done-session-error'
	| 'expired'
	| 'used'
	| 'unusable'
	| 'rate-limited'
	| 'unavailable'
	| 'bad-input'
	| 'offline';

export const DEFAULT_MAGIC_STATE: MagicStateKey = 'ready-with-email';

export const MAGIC_ROUTE_PARAM_KEYS = ['token', 't', 'email', 'e', 'next'] as const;

export const SAMPLE_MAGIC_TOKEN = 'dkm_4fN9pQ2wX7vB1cK8mR5tY3zH6jL0sD9a';
export const SAMPLE_MAGIC_EMAIL = 'jony@example.com';

export const MAGIC_GROUPS: ReadonlyArray<StateGroup> = [
	{
		heading: 'Link arrival',
		states: [
			{ key: 'missing', label: 'Missing token' },
			{ key: 'ready-with-email', label: 'Ready (addressed)' },
			{ key: 'ready-anonymous', label: 'Ready (no address)' }
		]
	},
	{
		heading: 'Signing in',
		states: [
			{ key: 'pending', label: 'Checking link' },
			{ key: 'done', label: 'Signed in' },
			{ key: 'done-session-error', label: 'Session check failed' }
		]
	},
	{
		heading: 'Link rejected',
		states: [
			{ key: 'expired', label: 'Link expired' },
			{ key: 'used', label: 'Already used' },
			{ key: 'unusable', label: 'Link unusable' }
		]
	},
	{
		heading: 'Retryable errors',
		states: [
			{ key: 'rate-limited', label: 'Rate limited' },
			{ key: 'unavailable', label: 'Mail links off' },
			{ key: 'bad-input', label: 'Rejected input' },
			{ key: 'offline', label: 'Gateway unreachable' }
		]
	}
];

export type FetchOutcome =
	| { kind: 'hold' }
	| { kind: 'offline' }
	| { kind: 'json'; status: number; body: Record<string, unknown>; headers?: Record<string, string> };

export interface MagicScenario {
	key: MagicStateKey;
	routeParams: Record<string, string>;
	clickSignIn: boolean;
	consume: FetchOutcome;
	me: FetchOutcome;
}

const DEFAULT_ME: FetchOutcome = {
	kind: 'json',
	status: 200,
	body: {
		ok: true,
		user: {
			id: 'usr_01j9z4k7q3f8m2v6t0b1c5dn',
			email: SAMPLE_MAGIC_EMAIL,
			name: 'jony',
			role: 'owner',
			twoFactorEnabled: false
		},
		expires_at: Date.now() + 7 * 86_400_000,
		auth_mode: 'new'
	}
};

const ADDRESSED_PARAMS = { token: SAMPLE_MAGIC_TOKEN, email: SAMPLE_MAGIC_EMAIL };

export const MAGIC_SCENARIOS: Record<MagicStateKey, MagicScenario> = {
	missing: {
		key: 'missing',
		routeParams: {},
		clickSignIn: false,
		consume: { kind: 'json', status: 400, body: { error: 'bad_request' } },
		me: DEFAULT_ME
	},
	'ready-with-email': {
		key: 'ready-with-email',
		routeParams: ADDRESSED_PARAMS,
		clickSignIn: false,
		consume: { kind: 'json', status: 200, body: { ok: true } },
		me: DEFAULT_ME
	},
	'ready-anonymous': {
		key: 'ready-anonymous',
		routeParams: { t: SAMPLE_MAGIC_TOKEN },
		clickSignIn: false,
		consume: { kind: 'json', status: 200, body: { ok: true } },
		me: DEFAULT_ME
	},
	pending: {
		key: 'pending',
		routeParams: ADDRESSED_PARAMS,
		clickSignIn: true,
		consume: { kind: 'hold' },
		me: DEFAULT_ME
	},
	done: {
		key: 'done',
		routeParams: ADDRESSED_PARAMS,
		clickSignIn: true,
		consume: { kind: 'json', status: 200, body: { ok: true } },
		me: { kind: 'hold' }
	},
	'done-session-error': {
		key: 'done-session-error',
		routeParams: ADDRESSED_PARAMS,
		clickSignIn: true,
		consume: { kind: 'json', status: 200, body: { ok: true } },
		me: {
			kind: 'json',
			status: 500,
			body: { error: 'internal_error', message: 'D1 session lookup failed.' }
		}
	},
	expired: {
		key: 'expired',
		routeParams: ADDRESSED_PARAMS,
		clickSignIn: true,
		consume: { kind: 'json', status: 410, body: { error: 'expired' } },
		me: DEFAULT_ME
	},
	used: {
		key: 'used',
		routeParams: ADDRESSED_PARAMS,
		clickSignIn: true,
		consume: { kind: 'json', status: 410, body: { error: 'used' } },
		me: DEFAULT_ME
	},
	unusable: {
		key: 'unusable',
		routeParams: ADDRESSED_PARAMS,
		clickSignIn: true,
		consume: { kind: 'json', status: 410, body: { error: 'revoked' } },
		me: DEFAULT_ME
	},
	'rate-limited': {
		key: 'rate-limited',
		routeParams: ADDRESSED_PARAMS,
		clickSignIn: true,
		consume: {
			kind: 'json',
			status: 429,
			body: { error: 'rate_limited', retryAfter: 45 },
			headers: { 'Retry-After': '45' }
		},
		me: DEFAULT_ME
	},
	unavailable: {
		key: 'unavailable',
		routeParams: ADDRESSED_PARAMS,
		clickSignIn: true,
		consume: {
			kind: 'json',
			status: 503,
			body: {
				error: 'auth_unavailable',
				message: 'Sign-in links are not available on this deployment right now.'
			}
		},
		me: DEFAULT_ME
	},
	'bad-input': {
		key: 'bad-input',
		routeParams: ADDRESSED_PARAMS,
		clickSignIn: true,
		consume: { kind: 'json', status: 400, body: { error: 'bad_request' } },
		me: DEFAULT_ME
	},
	offline: {
		key: 'offline',
		routeParams: ADDRESSED_PARAMS,
		clickSignIn: true,
		consume: { kind: 'offline' },
		me: DEFAULT_ME
	}
};

export function isMagicStateKey(value: string | null): value is MagicStateKey {
	return value !== null && Object.hasOwn(MAGIC_SCENARIOS, value);
}
