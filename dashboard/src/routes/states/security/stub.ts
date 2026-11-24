import type { PasswordMode, Role } from '$lib/types';
import {
	REGENERATED_BACKUP_CODES,
	SAMPLE_BACKUP_CODES,
	SAMPLE_INVITES,
	SAMPLE_PASSKEYS,
	SAMPLE_TOTP_URI,
	type SecurityStateKey
} from './fixtures';

export type MockReply =
	| { kind: 'json'; status: number; body: unknown }
	| { kind: 'hold' }
	| { kind: 'offline' };

export interface SecurityScenario {
	state: SecurityStateKey;
	authMode: 'new' | 'legacy';
	role: Role;
	handle: (method: string, path: string) => MockReply | null;
}

interface WorkbenchWindow extends Window {
	__dakflareSecurityStubInstalled?: boolean;
	__dakflareSecurityScenario?: SecurityScenario | null;
}

const NOW = Date.now();

const BASE_HEALTH = {
	ok: true,
	version: '6.1.0',
	schema_ready: true,
	migrations: ['0001_init', '0031_ai_settings'],
	bindings: { DB: true, SMS_QUEUE: true, DEVICE_HUB: true, ADMIN_LIMITER: true, AI: true },
	missing_bindings: [],
	retention_days: 30,
	counts: { devices: 2, messages: 284, rules: 4, pairing_codes: 0, open_alerts: 0 },
	open_alerts: 0,
	last_message_at: NOW - 42_000,
	checked_at: NOW,
	auth_mode: 'new',
	auth_configured: true
};

const json = (body: unknown, status = 200): MockReply => ({ kind: 'json', status, body });
const hold = (): MockReply => ({ kind: 'hold' });
const offline = (): MockReply => ({ kind: 'offline' });

function totpInitialEnabled(state: SecurityStateKey): boolean {
	return (
		state === 'totp-on' ||
		state === 'totp-disable-open' ||
		state === 'totp-disable-pending' ||
		state === 'totp-disable-error' ||
		state === 'totp-disabled-notice' ||
		state === 'codes-regenerate-dialog' ||
		state === 'codes-regenerate-pending' ||
		state === 'codes-regenerate-error' ||
		state === 'codes-regenerated-reveal' ||
		state === 'pw-remove-with-totp'
	);
}

function passwordModeFor(state: SecurityStateKey): PasswordMode {
	if (state === 'pw-server-set') return 'server-kdf';
	if (
		state === 'passkeys-none-pw-only' ||
		state === 'pw-no-pepper' ||
		state === 'pw-status-unknown' ||
		state === 'pw-client-not-set' ||
		state === 'pw-form-strength' ||
		state === 'pw-form-saving' ||
		state === 'pw-form-error' ||
		state === 'pw-saved-notice' ||
		state === 'pw-remove-with-password' ||
		state === 'pw-remove-with-totp' ||
		state === 'pw-remove-pending' ||
		state === 'pw-remove-error' ||
		state === 'pw-removed-notice'
	) {
		return 'client-derived';
	}
	return 'off';
}

function hasCredentialRow(state: SecurityStateKey): boolean {
	return (
		state === 'passkeys-none-pw-only' ||
		state === 'pw-server-set' ||
		state === 'pw-remove-with-password' ||
		state === 'pw-remove-with-totp' ||
		state === 'pw-remove-pending' ||
		state === 'pw-remove-error' ||
		state === 'pw-removed-notice'
	);
}

export function scenarioFor(state: SecurityStateKey): SecurityScenario {
	const authMode: 'new' | 'legacy' = state === 'legacy-admin-token' ? 'legacy' : 'new';
	const role: Role =
		state === 'member-no-access'
			? 'member'
			: state === 'invites-mint-admin-warn'
				? 'admin'
				: 'owner';
	let inviteGoneRemoved = false;

	return {
		state,
		authMode,
		role,
		handle: (method, path) => {
			if (path === '/admin/session') {
				return authMode === 'legacy'
					? json({ ok: true, expires_at: Date.now() + 8 * 3_600_000 })
					: json({ error: 'missing_auth_headers' }, 401);
			}

			// TOTP probe
			if (method === 'GET' && path === '/v1/auth/totp') {
				switch (state) {
					case 'loading':
						return hold();
					case 'totp-unavailable-missing':
						return json({ error: 'not_found' }, 404);
					case 'totp-unavailable-no-secret':
						return json(
							{
								error: 'auth_secret_missing',
								message: 'Set BETTER_AUTH_SECRET before storing authenticator secrets.'
							},
							503
						);
					case 'totp-unavailable-disabled':
						return json({ error: 'TOTP_NOT_CONFIGURED' }, 400);
					case 'totp-signed-out':
						return json({ error: 'unauthorized' }, 401);
					case 'totp-probe-error':
						return offline();
					default:
						return json({
							enabled: totpInitialEnabled(state),
							verified: totpInitialEnabled(state),
							secret_set: totpInitialEnabled(state)
						});
				}
			}

			if (method === 'POST' && path === '/v1/auth/totp/enable') {
				if (state === 'totp-enrol-starting') return hold();
				return json({
					method: 'totp',
					totpURI: SAMPLE_TOTP_URI,
					backupCodes: SAMPLE_BACKUP_CODES
				});
			}

			if (method === 'POST' && path === '/api/auth/two-factor/verify-totp') {
				if (state === 'totp-enrol-verifying') return hold();
				if (state === 'totp-enrol-code-error') {
					return json({ code: 'INVALID_CODE', message: 'Invalid TOTP code.' }, 401);
				}
				return json({ status: true });
			}

			if (method === 'POST' && path === '/v1/auth/totp/disable') {
				if (state === 'totp-disable-pending') return hold();
				if (state === 'totp-disable-error') {
					return json({ error: 'invalid_code' }, 401);
				}
				return json({ ok: true });
			}

			if (method === 'POST' && path === '/v1/auth/totp/regenerate') {
				if (state === 'codes-regenerate-pending') return hold();
				if (state === 'codes-regenerate-error') {
					return json({ error: 'invalid_code' }, 401);
				}
				return json({ status: true, backupCodes: REGENERATED_BACKUP_CODES });
			}

			// Health (password mode)
			if (method === 'GET' && path === '/v1/admin/health') {
				if (state === 'pw-health-error') {
					return json({ error: 'health_failed', message: 'Gateway health probe failed.' }, 500);
				}
				const passwordMode = passwordModeFor(state);
				return json({
					...BASE_HEALTH,
					checked_at: Date.now(),
					password_mode: passwordMode,
					password_configured: state !== 'pw-no-pepper'
				});
			}

			// Passkeys
			if (method === 'GET' && path === '/api/auth/passkey/list-user-passkeys') {
				if (state === 'passkeys-error') {
					return json({ error: 'passkey_list_failed', message: 'Could not read passkeys.' }, 500);
				}
				if (state === 'passkeys-none-pw-only') {
					return json([]);
				}
				return json(SAMPLE_PASSKEYS);
			}

			// Password endpoints
			if (method === 'GET' && path === '/api/auth/list-accounts') {
				if (state === 'pw-status-unknown') {
					return json({ error: 'accounts_failed' }, 500);
				}
				return json(hasCredentialRow(state) ? [{ providerId: 'credential' }] : []);
			}

			if (method === 'POST' && path === '/v1/auth/salt') {
				return json({
					salt: 'dGVzdHNhbHQxMjM0NTY3OA==',
					iterations: 100000,
					mode: 'c'
				});
			}

			if (method === 'POST' && path === '/v1/auth/password') {
				if (state === 'pw-form-saving') return hold();
				if (state === 'pw-form-error') {
					return json({ error: 'password_mode_mismatch', mode: 'server-kdf' }, 409);
				}
				return json({ ok: true });
			}

			if (method === 'DELETE' && path === '/v1/auth/password') {
				if (state === 'pw-remove-pending') return hold();
				if (state === 'pw-remove-error') {
					return json({ error: 'invalid_credentials', message: 'Proof rejected.' }, 401);
				}
				return json({ ok: true });
			}

			// Invites
			if (method === 'GET' && path === '/v1/admin/invites') {
				if (state === 'invites-empty') return json({ invites: [], now: Date.now() });
				if (state === 'invites-error-403') {
					return json({ error: 'forbidden', message: 'Forbidden.' }, 403);
				}
				if (state === 'invites-error-offline') return offline();
				const list = inviteGoneRemoved ? SAMPLE_INVITES.slice(1) : SAMPLE_INVITES;
				return json({ invites: list, now: Date.now() });
			}

			if (method === 'POST' && path === '/v1/admin/invites') {
				if (state === 'invites-mint-pending') return hold();
				if (state === 'invites-mint-conflict') {
					return json({ error: 'already_registered' }, 409);
				}
				return json({
					id: 'inv_minted_04',
					email: 'samira.ops@example.com',
					role: 'admin',
					expires_at: Date.now() + 7 * 86_400_000,
					token: 'dk_inv_7f9a2c4e1b8d6035a2f1'
				});
			}

			if (method === 'DELETE' && path.startsWith('/v1/admin/invites/')) {
				if (state === 'invites-revoke-pending') return hold();
				if (state === 'invites-revoke-error') {
					return json({ error: 'forbidden', message: 'Role downgraded.' }, 403);
				}
				if (state === 'invites-revoke-gone') {
					inviteGoneRemoved = true;
					return json({ error: 'not_found' }, 404);
				}
				return json({ ok: true, deleted: 1 });
			}

			return null;
		}
	};
}

function defaultReply(scenario: SecurityScenario | null, path: string): MockReply {
	const role = scenario?.role ?? 'owner';
	if (path === '/v1/auth/me') {
		return json({
			ok: true,
			user: {
				id: role === 'member' ? 'usr_rae_02' : role === 'admin' ? 'usr_nadia_03' : 'usr_jony_01',
				email:
					role === 'member'
						? 'rae.molina@example.com'
						: role === 'admin'
							? 'nadia.karim@example.com'
							: 'jony@example.com',
				name: role === 'member' ? 'Rae Molina' : role === 'admin' ? 'Nadia Karim' : 'Jony Reyes',
				role,
				twoFactorEnabled: true
			},
			expires_at: Date.now() + 8 * 60 * 60 * 1000,
			auth_mode: 'new'
		});
	}
	if (path === '/v1/admin/alerts') {
		return json({ alerts: [] });
	}
	if (path === '/v1/admin/approvals') {
		return json({ approvals: [] });
	}
	if (path === '/v1/admin/grants') {
		return json({ grants: [] });
	}
	if (path === '/v1/admin/agent/runtime') {
		return json({ enabled: false, schemaVersion: 1, sessions: 0, pinnedName: 'assistant' });
	}
	if (path === '/v1/admin/agent/autonomy') {
		return json({
			enabled: false,
			expiresAt: null,
			caps: { sms: 25, writes: 5 },
			usage: { day: '2026-11-18', tokens: 0, writes: 0, sms: 0 }
		});
	}
	return json({});
}

function toResponse(reply: MockReply): Promise<Response> {
	switch (reply.kind) {
		case 'json':
			return Promise.resolve(
				new Response(JSON.stringify(reply.body), {
					status: reply.status,
					headers: { 'content-type': 'application/json' }
				})
			);
		case 'offline':
			return Promise.reject(new TypeError('Failed to fetch'));
		case 'hold':
			return new Promise<Response>(() => {});
	}
}

export function installStub(scenario: SecurityScenario): void {
	if (typeof window === 'undefined') return;
	const win = window as WorkbenchWindow;
	win.__dakflareSecurityScenario = scenario;
	if (win.__dakflareSecurityStubInstalled) return;
	win.__dakflareSecurityStubInstalled = true;

	const realFetch = window.fetch.bind(window);
	window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		const url = new URL(raw, window.location.origin);
		if (url.pathname !== '/admin/session' && !/^\/(v1|api)\//.test(url.pathname)) {
			return realFetch(input, init);
		}
		const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
		const active = win.__dakflareSecurityScenario ?? null;
		const handled = active?.handle(method, url.pathname) ?? null;
		return toResponse(handled ?? defaultReply(active, url.pathname));
	};
}
