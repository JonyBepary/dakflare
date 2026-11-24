import type { StateGroup } from './StateSwitcher.svelte';

export type LoginStateKey =
	| 'checking'
	| 'unreachable'
	| 'check-failed'
	| 'no-auth-secret'
	| 'doors-all'
	| 'doors-passkey-magic'
	| 'doors-passkey-only'
	| 'doors-insecure-origin'
	| 'doors-passkey-unsupported'
	| 'doors-passkey-busy'
	| 'doors-passkey-error'
	| 'doors-secret-missing'
	| 'doors-password-checking'
	| 'doors-password-refused'
	| 'doors-session-failed'
	| 'password-client'
	| 'password-server-kdf'
	| 'password-busy'
	| 'password-error'
	| 'password-rate-limited'
	| 'magic-form'
	| 'magic-restart'
	| 'magic-sending'
	| 'magic-error'
	| 'magic-sent'
	| 'totp-from-passkey'
	| 'totp-from-password'
	| 'totp-from-magic'
	| 'totp-checking'
	| 'totp-invalid'
	| 'recovery-code'
	| 'challenge-spent'
	| 'legacy-token'
	| 'legacy-token-verifying'
	| 'legacy-token-error'
	| 'fallback-token-only'
	| 'fallback-auth-live';

export const DEFAULT_LOGIN_STATE: LoginStateKey = 'doors-all';

export const LOGIN_ROUTE_PARAM_KEYS = ['step', 'door', 'restart', 'next'] as const;

export const LOGIN_GROUPS: ReadonlyArray<StateGroup> = [
	{
		heading: 'Connection',
		states: [
			{ key: 'checking', label: 'Checking deployment' },
			{ key: 'unreachable', label: 'Gateway unreachable' },
			{ key: 'check-failed', label: 'Check failed (5xx)' },
			{ key: 'no-auth-secret', label: 'Auth secret missing' }
		]
	},
	{
		heading: 'Doors',
		states: [
			{ key: 'doors-all', label: 'All sign-in doors' },
			{ key: 'doors-passkey-magic', label: 'Passkey & email link' },
			{ key: 'doors-passkey-only', label: 'Passkey only' },
			{ key: 'doors-insecure-origin', label: 'Insecure origin warning' },
			{ key: 'doors-passkey-unsupported', label: 'Browser lacks passkeys' },
			{ key: 'doors-passkey-busy', label: 'Passkey waiting' },
			{ key: 'doors-passkey-error', label: 'Passkey dismissed' },
			{ key: 'doors-secret-missing', label: 'Passkey 503 no secret' },
			{ key: 'doors-password-checking', label: 'Checking password support' },
			{ key: 'doors-password-refused', label: 'Passwords switched off' },
			{ key: 'doors-session-failed', label: 'Post-login read failed' }
		]
	},
	{
		heading: 'Password',
		states: [
			{ key: 'password-client', label: 'Password (client KDF)' },
			{ key: 'password-server-kdf', label: 'Password (server KDF)' },
			{ key: 'password-busy', label: 'Deriving & checking' },
			{ key: 'password-error', label: 'Wrong email or password' },
			{ key: 'password-rate-limited', label: 'Password rate-limited' }
		]
	},
	{
		heading: 'Email link',
		states: [
			{ key: 'magic-form', label: 'Request sign-in link' },
			{ key: 'magic-restart', label: 'Link already used' },
			{ key: 'magic-sending', label: 'Sending link' },
			{ key: 'magic-error', label: 'Link rate-limited' },
			{ key: 'magic-sent', label: 'Check your email' }
		]
	},
	{
		heading: 'Two-step',
		states: [
			{ key: 'totp-from-passkey', label: '2FA after passkey' },
			{ key: 'totp-from-password', label: '2FA after password' },
			{ key: 'totp-from-magic', label: '2FA after email link' },
			{ key: 'totp-checking', label: 'Checking 2FA code' },
			{ key: 'totp-invalid', label: 'Invalid 2FA code' },
			{ key: 'recovery-code', label: 'Recovery code entry' },
			{ key: 'challenge-spent', label: 'Challenge used up' }
		]
	},
	{
		heading: 'Admin token',
		states: [
			{ key: 'legacy-token', label: 'Legacy admin token' },
			{ key: 'legacy-token-verifying', label: 'Verifying token' },
			{ key: 'legacy-token-error', label: 'Token rejected' },
			{ key: 'fallback-token-only', label: 'Fallback (token only)' },
			{ key: 'fallback-auth-live', label: 'Fallback (accounts live)' }
		]
	}
];

export type FetchOutcome =
	| { kind: 'hold' }
	| { kind: 'offline' }
	| {
			kind: 'json';
			status: number;
			body: unknown;
			headers?: Record<string, string>;
	  };

export type BrowserSupportMock = 'yes' | 'insecure' | 'no';

export type PasskeyGetMock =
	| { kind: 'none' }
	| { kind: 'resolve' }
	| { kind: 'reject'; name: string; message: string };

export type LoginAction =
	| 'none'
	| 'click-door-passkey'
	| 'click-door-password'
	| 'click-door-magic'
	| 'click-fallback-password'
	| 'submit-password'
	| 'submit-magic'
	| 'submit-totp'
	| 'open-recovery'
	| 'submit-legacy-token';

export interface LoginScenario {
	key: LoginStateKey;
	routeParams: Record<string, string>;
	support: BrowserSupportMock;
	passkeyGet: PasskeyGetMock;
	action: LoginAction;
	mode: FetchOutcome;
	getSession: FetchOutcome;
	adminSessionPost: FetchOutcome;
	secondMe?: FetchOutcome;
	challenge: FetchOutcome;
	magicLink: FetchOutcome;
	salt: FetchOutcome;
	passwordSignIn: FetchOutcome;
	passkeyOptions: FetchOutcome;
	passkeyVerify: FetchOutcome;
	totpVerify: FetchOutcome;
}

const MODE_ALL: FetchOutcome = {
	kind: 'json',
	status: 200,
	body: {
		auth_mode: 'new',
		auth_configured: true,
		password_mode: 'client-derived',
		password_configured: true,
		magic_link: true,
		magic_link_ttl_s: 900
	}
};

const MODE_PASSKEY_MAGIC: FetchOutcome = {
	kind: 'json',
	status: 200,
	body: {
		auth_mode: 'new',
		auth_configured: true,
		password_mode: 'off',
		password_configured: false,
		magic_link: true,
		magic_link_ttl_s: 900
	}
};

const MODE_PASSKEY_ONLY: FetchOutcome = {
	kind: 'json',
	status: 200,
	body: {
		auth_mode: 'new',
		auth_configured: true,
		password_mode: 'off',
		password_configured: false,
		magic_link: false,
		magic_link_ttl_s: 900
	}
};

const MODE_SERVER_KDF: FetchOutcome = {
	kind: 'json',
	status: 200,
	body: {
		auth_mode: 'new',
		auth_configured: true,
		password_mode: 'server-kdf',
		password_configured: true,
		magic_link: true,
		magic_link_ttl_s: 900
	}
};

const MODE_NO_SECRET: FetchOutcome = {
	kind: 'json',
	status: 200,
	body: {
		auth_mode: 'new',
		auth_configured: false,
		password_mode: 'off',
		password_configured: false,
		magic_link: false,
		magic_link_ttl_s: 900
	}
};

const MODE_LEGACY: FetchOutcome = {
	kind: 'json',
	status: 200,
	body: {
		auth_mode: 'legacy',
		auth_configured: false,
		password_mode: 'off',
		password_configured: false,
		magic_link: false,
		magic_link_ttl_s: 900
	}
};

const MODE_FALLBACK_404: FetchOutcome = {
	kind: 'json',
	status: 404,
	body: { error: 'not_found' }
};

const DEFAULT_PASSKEY_OPTIONS: FetchOutcome = {
	kind: 'json',
	status: 200,
	body: {
		challenge: 'dGVzdC1jaGFsbGVuZ2UtMzItYnl0ZXMtbG9uZw',
		rpId: 'localhost',
		userVerification: 'preferred'
	}
};

const DEFAULT_SALT: FetchOutcome = {
	kind: 'json',
	status: 200,
	body: {
		salt: 'MDEyMzQ1Njc4OWFiY2RlZg==',
		iterations: 100_000,
		mode: 'c'
	}
};

const BASE_DEFAULTS = {
	routeParams: {} as Record<string, string>,
	support: 'yes' as BrowserSupportMock,
	passkeyGet: { kind: 'none' } as PasskeyGetMock,
	action: 'none' as LoginAction,
	mode: MODE_ALL,
	getSession: { kind: 'json', status: 200, body: null } as FetchOutcome,
	adminSessionPost: { kind: 'json', status: 401, body: { error: 'unauthorized' } } as FetchOutcome,
	challenge: { kind: 'json', status: 200, body: { pending: false } } as FetchOutcome,
	magicLink: { kind: 'json', status: 202, body: { ok: true } } as FetchOutcome,
	salt: DEFAULT_SALT,
	passwordSignIn: { kind: 'json', status: 401, body: { error: 'invalid_credentials' } } as FetchOutcome,
	passkeyOptions: DEFAULT_PASSKEY_OPTIONS,
	passkeyVerify: { kind: 'json', status: 200, body: { twoFactorRedirect: true } } as FetchOutcome,
	totpVerify: { kind: 'json', status: 400, body: { code: 'INVALID_CODE' } } as FetchOutcome
};

function scenario(
	key: LoginStateKey,
	overrides: Partial<Omit<LoginScenario, 'key'>>
): LoginScenario {
	return {
		...BASE_DEFAULTS,
		...overrides,
		key
	};
}

export const LOGIN_SCENARIOS: Record<LoginStateKey, LoginScenario> = {
	// 1. Connection
	checking: scenario('checking', {
		mode: { kind: 'hold' }
	}),
	unreachable: scenario('unreachable', {
		mode: { kind: 'offline' }
	}),
	'check-failed': scenario('check-failed', {
		mode: {
			kind: 'json',
			status: 502,
			body: { error: 'internal_error', message: 'Upstream mode probe returned 502 Bad Gateway.' }
		}
	}),
	'no-auth-secret': scenario('no-auth-secret', {
		mode: MODE_NO_SECRET
	}),

	// 2. Doors
	'doors-all': scenario('doors-all', {
		mode: MODE_ALL
	}),
	'doors-passkey-magic': scenario('doors-passkey-magic', {
		mode: MODE_PASSKEY_MAGIC
	}),
	'doors-passkey-only': scenario('doors-passkey-only', {
		mode: MODE_PASSKEY_ONLY
	}),
	'doors-insecure-origin': scenario('doors-insecure-origin', {
		mode: MODE_ALL,
		support: 'insecure'
	}),
	'doors-passkey-unsupported': scenario('doors-passkey-unsupported', {
		mode: MODE_PASSKEY_ONLY,
		support: 'no'
	}),
	'doors-passkey-busy': scenario('doors-passkey-busy', {
		action: 'click-door-passkey',
		passkeyOptions: { kind: 'hold' }
	}),
	'doors-passkey-error': scenario('doors-passkey-error', {
		action: 'click-door-passkey',
		passkeyGet: {
			kind: 'reject',
			name: 'NotAllowedError',
			message: 'The operation either timed out or was not allowed.'
		}
	}),
	'doors-secret-missing': scenario('doors-secret-missing', {
		action: 'click-door-passkey',
		passkeyOptions: {
			kind: 'json',
			status: 503,
			body: { error: 'auth_unavailable', message: 'No auth secret configured.' }
		}
	}),
	'doors-password-checking': scenario('doors-password-checking', {
		mode: MODE_FALLBACK_404,
		getSession: { kind: 'json', status: 200, body: null },
		action: 'click-fallback-password',
		passwordSignIn: { kind: 'hold' }
	}),
	'doors-password-refused': scenario('doors-password-refused', {
		mode: MODE_FALLBACK_404,
		getSession: { kind: 'json', status: 200, body: null },
		action: 'click-fallback-password',
		passwordSignIn: {
			kind: 'json',
			status: 403,
			body: { error: 'password_disabled', message: 'Passwords are disabled.' }
		}
	}),
	'doors-session-failed': scenario('doors-session-failed', {
		action: 'click-door-passkey',
		passkeyGet: { kind: 'resolve' },
		passkeyVerify: { kind: 'json', status: 200, body: { twoFactorRedirect: false } },
		getSession: {
			kind: 'json',
			status: 200,
			body: { user: { id: 'usr_01j9z4k7q3f8m2v6t0b1c5dn', email: 'jony@example.com' } }
		},
		secondMe: {
			kind: 'json',
			status: 500,
			body: { error: 'internal_error', message: 'D1 session lookup failed.' }
		}
	}),

	// 3. Password
	'password-client': scenario('password-client', {
		mode: MODE_ALL,
		action: 'click-door-password'
	}),
	'password-server-kdf': scenario('password-server-kdf', {
		mode: MODE_SERVER_KDF,
		action: 'click-door-password'
	}),
	'password-busy': scenario('password-busy', {
		action: 'submit-password',
		salt: { kind: 'hold' }
	}),
	'password-error': scenario('password-error', {
		action: 'submit-password',
		passwordSignIn: { kind: 'json', status: 401, body: { error: 'invalid_credentials' } }
	}),
	'password-rate-limited': scenario('password-rate-limited', {
		action: 'submit-password',
		passwordSignIn: {
			kind: 'json',
			status: 429,
			body: { error: 'rate_limited', retryAfter: 30 },
			headers: { 'Retry-After': '30' }
		}
	}),

	// 4. Email link
	'magic-form': scenario('magic-form', {
		action: 'click-door-magic'
	}),
	'magic-restart': scenario('magic-restart', {
		routeParams: { door: 'magic', restart: '1' }
	}),
	'magic-sending': scenario('magic-sending', {
		action: 'submit-magic',
		magicLink: { kind: 'hold' }
	}),
	'magic-error': scenario('magic-error', {
		action: 'submit-magic',
		magicLink: {
			kind: 'json',
			status: 429,
			body: { error: 'rate_limited', retryAfter: 45 },
			headers: { 'Retry-After': '45' }
		}
	}),
	'magic-sent': scenario('magic-sent', {
		action: 'submit-magic',
		magicLink: { kind: 'json', status: 202, body: { ok: true } }
	}),

	// 5. Two-step
	'totp-from-passkey': scenario('totp-from-passkey', {
		action: 'click-door-passkey',
		passkeyGet: { kind: 'resolve' },
		passkeyVerify: { kind: 'json', status: 200, body: { twoFactorRedirect: true } }
	}),
	'totp-from-password': scenario('totp-from-password', {
		action: 'submit-password',
		passwordSignIn: { kind: 'json', status: 200, body: { twoFactorRedirect: true } }
	}),
	'totp-from-magic': scenario('totp-from-magic', {
		routeParams: { step: 'code' },
		challenge: { kind: 'json', status: 200, body: { pending: true } }
	}),
	'totp-checking': scenario('totp-checking', {
		action: 'submit-totp',
		passkeyGet: { kind: 'resolve' },
		passkeyVerify: { kind: 'json', status: 200, body: { twoFactorRedirect: true } },
		totpVerify: { kind: 'hold' }
	}),
	'totp-invalid': scenario('totp-invalid', {
		action: 'submit-totp',
		passkeyGet: { kind: 'resolve' },
		passkeyVerify: { kind: 'json', status: 200, body: { twoFactorRedirect: true } },
		totpVerify: { kind: 'json', status: 400, body: { code: 'INVALID_CODE' } }
	}),
	'recovery-code': scenario('recovery-code', {
		action: 'open-recovery',
		passkeyGet: { kind: 'resolve' },
		passkeyVerify: { kind: 'json', status: 200, body: { twoFactorRedirect: true } }
	}),
	'challenge-spent': scenario('challenge-spent', {
		action: 'submit-totp',
		passkeyGet: { kind: 'resolve' },
		passkeyVerify: { kind: 'json', status: 200, body: { twoFactorRedirect: true } },
		totpVerify: {
			kind: 'json',
			status: 429,
			body: { code: 'TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE', retryAfter: 60 },
			headers: { 'Retry-After': '60' }
		}
	}),

	// 6. Admin token
	'legacy-token': scenario('legacy-token', {
		mode: MODE_LEGACY
	}),
	'legacy-token-verifying': scenario('legacy-token-verifying', {
		mode: MODE_LEGACY,
		action: 'submit-legacy-token',
		adminSessionPost: { kind: 'hold' }
	}),
	'legacy-token-error': scenario('legacy-token-error', {
		mode: MODE_LEGACY,
		action: 'submit-legacy-token',
		adminSessionPost: { kind: 'json', status: 401, body: { error: 'unauthorized' } }
	}),
	'fallback-token-only': scenario('fallback-token-only', {
		mode: MODE_FALLBACK_404,
		getSession: { kind: 'json', status: 503, body: { error: 'auth_unavailable' } }
	}),
	'fallback-auth-live': scenario('fallback-auth-live', {
		mode: MODE_FALLBACK_404,
		getSession: { kind: 'json', status: 200, body: null }
	})
};

export function isLoginStateKey(value: string | null): value is LoginStateKey {
	return value !== null && Object.hasOwn(LOGIN_SCENARIOS, value);
}
