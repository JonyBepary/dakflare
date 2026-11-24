import type { StateGroup } from './StateSwitcher.svelte';

export type InviteStateKey =
	| 'form-empty'
	| 'form-typed'
	| 'pending'
	| 'bad-format'
	| 'elsewhere'
	| 'no-secret'
	| 'invite-invalid'
	| 'already-registered'
	| 'rate-limited'
	| 'session-failed'
	| 'offline';

export const DEFAULT_INVITE_STATE: InviteStateKey = 'form-empty';

export const INVITE_ROUTE_PARAM_KEYS = ['code', 'invite', 'token', 't', 'next'] as const;

export const SAMPLE_INVITE_TOKEN = 'dki_8wK2mQp9vR4xTn7bLz3cJf6hYd1sAe5g';

export const INVITE_GROUPS: ReadonlyArray<StateGroup> = [
	{
		heading: 'Entry',
		states: [
			{ key: 'form-empty', label: 'Empty form' },
			{ key: 'form-typed', label: 'Code entered' },
			{ key: 'pending', label: 'Opening invite' }
		]
	},
	{
		heading: 'Link problems',
		states: [
			{ key: 'bad-format', label: 'Unreadable link' },
			{ key: 'elsewhere', label: 'Other deployment' },
			{ key: 'no-secret', label: 'Missing auth secret' }
		]
	},
	{
		heading: 'Redeem errors',
		states: [
			{ key: 'invite-invalid', label: 'Expired or used' },
			{ key: 'already-registered', label: 'Already registered' },
			{ key: 'rate-limited', label: 'Rate limited' },
			{ key: 'session-failed', label: 'No session issued' },
			{ key: 'offline', label: 'Gateway unreachable' }
		]
	}
];

export type RedeemOutcome =
	| { kind: 'hold' }
	| { kind: 'offline' }
	| { kind: 'json'; status: number; body: Record<string, unknown> };

export type InviteAction = 'none' | 'fill-only' | 'fill-and-submit';

export interface InviteScenario {
	key: InviteStateKey;
	routeParams: Record<string, string>;
	redeem: RedeemOutcome;
	action: InviteAction;
}

export const INVITE_SCENARIOS: Record<InviteStateKey, InviteScenario> = {
	'form-empty': {
		key: 'form-empty',
		routeParams: {},
		redeem: { kind: 'json', status: 500, body: { error: 'internal_error' } },
		action: 'none'
	},
	'form-typed': {
		key: 'form-typed',
		routeParams: {},
		redeem: { kind: 'json', status: 500, body: { error: 'internal_error' } },
		action: 'fill-only'
	},
	pending: {
		key: 'pending',
		routeParams: { code: SAMPLE_INVITE_TOKEN },
		redeem: { kind: 'hold' },
		action: 'none'
	},
	'bad-format': {
		key: 'bad-format',
		routeParams: { code: 'not-a-valid-invite' },
		redeem: { kind: 'json', status: 400, body: { error: 'bad_request' } },
		action: 'none'
	},
	elsewhere: {
		key: 'elsewhere',
		routeParams: {
			code: `dakflare://invite?u=${encodeURIComponent('https://sms.north-relay.example.com')}&t=${SAMPLE_INVITE_TOKEN}`
		},
		redeem: { kind: 'json', status: 403, body: { error: 'invite_invalid' } },
		action: 'none'
	},
	'no-secret': {
		key: 'no-secret',
		routeParams: { t: SAMPLE_INVITE_TOKEN },
		redeem: { kind: 'json', status: 503, body: { error: 'auth_unavailable' } },
		action: 'none'
	},
	'invite-invalid': {
		key: 'invite-invalid',
		routeParams: {},
		redeem: { kind: 'json', status: 403, body: { error: 'invite_invalid' } },
		action: 'fill-and-submit'
	},
	'already-registered': {
		key: 'already-registered',
		routeParams: {},
		redeem: { kind: 'json', status: 409, body: { error: 'already_registered' } },
		action: 'fill-and-submit'
	},
	'rate-limited': {
		key: 'rate-limited',
		routeParams: {},
		redeem: { kind: 'json', status: 429, body: { error: 'rate_limited' } },
		action: 'fill-and-submit'
	},
	'session-failed': {
		key: 'session-failed',
		routeParams: {},
		redeem: { kind: 'json', status: 503, body: { error: 'session_failed' } },
		action: 'fill-and-submit'
	},
	offline: {
		key: 'offline',
		routeParams: {},
		redeem: { kind: 'offline' },
		action: 'fill-and-submit'
	}
};

export function isInviteStateKey(value: string | null): value is InviteStateKey {
	return value !== null && Object.hasOwn(INVITE_SCENARIOS, value);
}
