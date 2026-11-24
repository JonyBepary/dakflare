import type { StateGroup } from './StateSwitcher.svelte';

export type EnrolStateKey =
	| 'checking'
	| 'failed'
	| 'existing'
	| 'unsupported-insecure'
	| 'unsupported-no'
	| 'ready'
	| 'ready-no-email'
	| 'pending'
	| 'error-cancelled'
	| 'error-invalid-state'
	| 'error-challenge-expired'
	| 'error-offline';

export const DEFAULT_ENROL_STATE: EnrolStateKey = 'ready';

export const ENROL_GROUPS: ReadonlyArray<StateGroup> = [
	{
		heading: 'Account check',
		states: [
			{ key: 'checking', label: 'Checking account' },
			{ key: 'failed', label: 'Account read failed' },
			{ key: 'existing', label: 'Already has passkey' }
		]
	},
	{
		heading: 'Browser support',
		states: [
			{ key: 'unsupported-insecure', label: 'Insecure origin' },
			{ key: 'unsupported-no', label: 'No passkey API' }
		]
	},
	{
		heading: 'Create passkey',
		states: [
			{ key: 'ready', label: 'Ready (with email)' },
			{ key: 'ready-no-email', label: 'Ready (no email)' },
			{ key: 'pending', label: 'Waiting for passkey' },
			{ key: 'error-cancelled', label: 'Prompt dismissed' },
			{ key: 'error-invalid-state', label: 'Device already has key' },
			{ key: 'error-challenge-expired', label: 'Challenge expired' },
			{ key: 'error-offline', label: 'Gateway unreachable' }
		]
	}
];

export type FetchOutcome =
	| { kind: 'hold' }
	| { kind: 'offline' }
	| { kind: 'json'; status: number; body: unknown };

export type BrowserSupportMock = 'yes' | 'insecure' | 'no';

export type CeremonyMock =
	| { kind: 'none' }
	| { kind: 'resolve' }
	| { kind: 'reject'; name: string; message: string };

export interface EnrolScenario {
	key: EnrolStateKey;
	support: BrowserSupportMock;
	ceremony: CeremonyMock;
	submitCreate: boolean;
	me: FetchOutcome;
	listPasskeys: FetchOutcome;
	generateRegisterOptions: FetchOutcome;
	verifyRegistration: FetchOutcome;
}

function makeMeOutcome(email: string): FetchOutcome {
	return {
		kind: 'json',
		status: 200,
		body: {
			ok: true,
			user: {
				id: 'usr_01j9z4k7q3f8m2v6t0b1c5dn',
				email,
				name: email ? 'jony' : 'Operator',
				role: 'owner',
				twoFactorEnabled: false
			},
			expires_at: Date.now() + 7 * 86_400_000,
			auth_mode: 'new'
		}
	};
}

const DEFAULT_ME = makeMeOutcome('jony@example.com');
const EMPTY_PASSKEYS: FetchOutcome = { kind: 'json', status: 200, body: [] };
const REGISTER_OPTIONS: FetchOutcome = {
	kind: 'json',
	status: 200,
	body: {
		challenge: 'dGVzdC1jaGFsbGVuZ2UtMzItYnl0ZXMtbG9uZw',
		rp: { name: 'DakFlare', id: 'localhost' },
		user: {
			id: 'dXNyXzAxajl6NGs3cTNmOG0ydjZ0MGIxYzVkbg',
			name: 'jony@example.com',
			displayName: 'jony'
		},
		pubKeyCredParams: [{ type: 'public-key', alg: -7 }]
	}
};

export const ENROL_SCENARIOS: Record<EnrolStateKey, EnrolScenario> = {
	checking: {
		key: 'checking',
		support: 'yes',
		ceremony: { kind: 'none' },
		submitCreate: false,
		me: { kind: 'hold' },
		listPasskeys: EMPTY_PASSKEYS,
		generateRegisterOptions: REGISTER_OPTIONS,
		verifyRegistration: { kind: 'json', status: 200, body: { ok: true } }
	},
	failed: {
		key: 'failed',
		support: 'yes',
		ceremony: { kind: 'none' },
		submitCreate: false,
		me: {
			kind: 'json',
			status: 500,
			body: { error: 'internal_error', message: 'D1 session lookup failed.' }
		},
		listPasskeys: EMPTY_PASSKEYS,
		generateRegisterOptions: REGISTER_OPTIONS,
		verifyRegistration: { kind: 'json', status: 200, body: { ok: true } }
	},
	existing: {
		key: 'existing',
		support: 'yes',
		ceremony: { kind: 'none' },
		submitCreate: false,
		me: DEFAULT_ME,
		listPasskeys: {
			kind: 'json',
			status: 200,
			body: [
				{
					id: 'pk_01j9z4k7q3f8m2v6t0b1c5dn',
					name: 'MacBook Pro · Touch ID',
					createdAt: '2026-11-12T09:14:00.000Z'
				}
			]
		},
		generateRegisterOptions: REGISTER_OPTIONS,
		verifyRegistration: { kind: 'json', status: 200, body: { ok: true } }
	},
	'unsupported-insecure': {
		key: 'unsupported-insecure',
		support: 'insecure',
		ceremony: { kind: 'none' },
		submitCreate: false,
		me: DEFAULT_ME,
		listPasskeys: EMPTY_PASSKEYS,
		generateRegisterOptions: REGISTER_OPTIONS,
		verifyRegistration: { kind: 'json', status: 200, body: { ok: true } }
	},
	'unsupported-no': {
		key: 'unsupported-no',
		support: 'no',
		ceremony: { kind: 'none' },
		submitCreate: false,
		me: DEFAULT_ME,
		listPasskeys: EMPTY_PASSKEYS,
		generateRegisterOptions: REGISTER_OPTIONS,
		verifyRegistration: { kind: 'json', status: 200, body: { ok: true } }
	},
	ready: {
		key: 'ready',
		support: 'yes',
		ceremony: { kind: 'none' },
		submitCreate: false,
		me: DEFAULT_ME,
		listPasskeys: EMPTY_PASSKEYS,
		generateRegisterOptions: REGISTER_OPTIONS,
		verifyRegistration: { kind: 'json', status: 200, body: { ok: true } }
	},
	'ready-no-email': {
		key: 'ready-no-email',
		support: 'yes',
		ceremony: { kind: 'none' },
		submitCreate: false,
		me: makeMeOutcome(''),
		listPasskeys: EMPTY_PASSKEYS,
		generateRegisterOptions: REGISTER_OPTIONS,
		verifyRegistration: { kind: 'json', status: 200, body: { ok: true } }
	},
	pending: {
		key: 'pending',
		support: 'yes',
		ceremony: { kind: 'none' },
		submitCreate: true,
		me: DEFAULT_ME,
		listPasskeys: EMPTY_PASSKEYS,
		generateRegisterOptions: { kind: 'hold' },
		verifyRegistration: { kind: 'json', status: 200, body: { ok: true } }
	},
	'error-cancelled': {
		key: 'error-cancelled',
		support: 'yes',
		ceremony: {
			kind: 'reject',
			name: 'NotAllowedError',
			message: 'The operation either timed out or was not allowed.'
		},
		submitCreate: true,
		me: DEFAULT_ME,
		listPasskeys: EMPTY_PASSKEYS,
		generateRegisterOptions: REGISTER_OPTIONS,
		verifyRegistration: { kind: 'json', status: 200, body: { ok: true } }
	},
	'error-invalid-state': {
		key: 'error-invalid-state',
		support: 'yes',
		ceremony: {
			kind: 'reject',
			name: 'InvalidStateError',
			message: 'The authenticator was previously registered.'
		},
		submitCreate: true,
		me: DEFAULT_ME,
		listPasskeys: EMPTY_PASSKEYS,
		generateRegisterOptions: REGISTER_OPTIONS,
		verifyRegistration: { kind: 'json', status: 200, body: { ok: true } }
	},
	'error-challenge-expired': {
		key: 'error-challenge-expired',
		support: 'yes',
		ceremony: { kind: 'resolve' },
		submitCreate: true,
		me: DEFAULT_ME,
		listPasskeys: EMPTY_PASSKEYS,
		generateRegisterOptions: REGISTER_OPTIONS,
		verifyRegistration: {
			kind: 'json',
			status: 400,
			body: { error: 'CHALLENGE_NOT_FOUND' }
		}
	},
	'error-offline': {
		key: 'error-offline',
		support: 'yes',
		ceremony: { kind: 'none' },
		submitCreate: true,
		me: DEFAULT_ME,
		listPasskeys: EMPTY_PASSKEYS,
		generateRegisterOptions: { kind: 'offline' },
		verifyRegistration: { kind: 'json', status: 200, body: { ok: true } }
	}
};

export function isEnrolStateKey(value: string | null): value is EnrolStateKey {
	return value !== null && Object.hasOwn(ENROL_SCENARIOS, value);
}
