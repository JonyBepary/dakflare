/**
 * TOTP (authenticator app) — the console side of `worker/src/auth/totp-routes.ts`.
 *
 * The plugin's own `/two-factor/enable|disable|generate-backup-codes` endpoints
 * are password-gated once an account has a credential row: they answer
 * `INVALID_PASSWORD` even though `allowPasswordless` is on, because that option
 * only makes the field optional in the schema. This module therefore talks to
 * the Worker's re-authenticated routes instead:
 *
 *   GET  /v1/auth/totp              is the factor on (no secret, no password)
 *   POST /v1/auth/totp/enable       passkey assertion in this session, then the
 *                                   plugin's secret/URI/recovery-code format
 *   POST /v1/auth/totp/disable      a current TOTP code
 *   POST /v1/auth/totp/regenerate   a current TOTP code
 *   POST /api/auth/two-factor/verify-totp   the FIRST code, still the plugin's
 *
 * Nothing here re-implements the protocol: the `otpauth://` URI, the secret, the
 * 6-digit/30-second window, the recovery codes and the check all come from the
 * plugin (through the Worker route or the plugin's own endpoint). What this
 * module owns is the re-authentication conversation and the states the Security
 * page has to be honest about.
 *
 * No request made here carries a `password` field, under either password mode.
 */

import { ApiError, authRequest, describeError } from './api';
import { signInWithPasskey } from './passkey';

/** What the deployment can do, read once per page load, never assumed. */
export type TotpProbe =
	| { kind: 'on' }
	| { kind: 'off' }
	| { kind: 'signed-out' }
	| { kind: 'unavailable'; reason: 'missing' | 'no-secret' | 'disabled' }
	| { kind: 'error'; message: string };

interface StatusBody {
	enabled?: unknown;
	verified?: unknown;
	secret_set?: unknown;
}

/**
 * One `/v1/auth/*` call. Not `authRequest` (that is Better Auth's mount) and not
 * the admin `request` (that fires the global 401 handler; on this page a 401 is
 * an answer about the factor, not a session the layout should tear down).
 */
async function accountRequest<T>(
	path: string,
	init: { method?: string; body?: unknown } = {}
): Promise<T> {
	const headers = new Headers({ Accept: 'application/json' });
	if (init.body !== undefined) headers.set('Content-Type', 'application/json');

	let response: Response;
	try {
		response = await fetch(path, {
			method: init.method ?? 'GET',
			headers,
			...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
			credentials: 'same-origin',
			signal: AbortSignal.timeout(20_000)
		});
	} catch (error) {
		if (error instanceof DOMException && error.name === 'TimeoutError') {
			throw new ApiError('The gateway did not answer in time. Try again.', 0);
		}
		throw new ApiError('Could not reach the gateway. Check the connection and try again.', 0);
	}

	const text = await response.text();
	let payload: unknown = null;
	if (text) {
		try {
			payload = JSON.parse(text);
		} catch {
			payload = null;
		}
	}

	if (!response.ok) {
		const body = (payload ?? {}) as Record<string, unknown>;
		const code = typeof body.error === 'string' ? body.error : null;
		const message = typeof body.message === 'string' ? body.message : null;
		throw new ApiError(
			message ?? `Request failed (${response.status}).`,
			response.status,
			code,
			null,
			null,
			message,
			payload
		);
	}

	return payload as T;
}

/** One sentence for a refusal, without naming the wire. */
function totpFailure(error: unknown, intent: 'enable' | 'disable' | 'regenerate'): ApiError {
	if (error instanceof ApiError) {
		if (error.code === 'reauth_required') {
			return new ApiError(
				'Confirm with your passkey before changing the authenticator. Nothing was changed.',
				403,
				'reauth_required'
			);
		}
		if (error.code === 'invalid_code') {
			return new ApiError(
				'That code was not accepted. Nothing was changed; use the code showing now.',
				401,
				'invalid_code'
			);
		}
		if (error.code === 'totp_not_enabled') {
			return new ApiError('No authenticator is set up on this account.', 409, 'totp_not_enabled');
		}
		if (error.code === 'totp_already_enabled') {
			return new ApiError('An authenticator is already set up on this account.', 409, 'totp_already_enabled');
		}
		if (error.code === 'password_not_accepted') {
			return new ApiError(
				'Changing the authenticator is confirmed with a passkey or a current code, never a password.',
				400,
				'password_not_accepted'
			);
		}
		if (error.status === 401 || error.status === 403) {
			return new ApiError(
				'Your session has expired, or this account cannot change its factors. Sign in again.',
				error.status,
				error.code
			);
		}
		if (error.status === 503) {
			return new ApiError(
				error.serverMessage ??
					'This deployment has no auth secret yet, so no authenticator can be stored. Nothing was changed.',
				503,
				error.code
			);
		}
		if (intent === 'enable') return error;
	}
	return new ApiError(describeError(error), 0);
}

/**
 * Ask the plugin whether this account has a confirmed secret.
 *
 * `/v1/auth/totp` is the Worker's own read: two booleans from D1. The plugin's
 * `get-totp-uri` cannot be used as a probe because it is password-gated for the
 * very accounts this page is about. A 404 means the route is not mounted (an
 * older Worker); 503 means the auth secret is missing.
 */
export async function probeTotp(): Promise<TotpProbe> {
	try {
		const body = await accountRequest<StatusBody>('/v1/auth/totp');
		const on = body?.enabled === true && body?.verified === true;
		return on ? { kind: 'on' } : { kind: 'off' };
	} catch (error) {
		if (!(error instanceof ApiError)) return { kind: 'error', message: describeError(error) };
		if (error.status === 404) return { kind: 'unavailable', reason: 'missing' };
		if (error.status === 503) return { kind: 'unavailable', reason: 'no-secret' };
		if (error.status === 401 || error.status === 403) return { kind: 'signed-out' };
		if (error.code === 'TOTP_NOT_CONFIGURED') return { kind: 'unavailable', reason: 'disabled' };
		return { kind: 'error', message: describeError(error) };
	}
}

export interface TotpEnrolment {
	/** `otpauth://totp/…` — what the QR encodes and what an authenticator opens. */
	uri: string;
	/** The base32 secret inside the URI, for typing it in by hand. */
	secret: string;
	/** Shown once, after a code is accepted. The plugin stores only these. */
	backupCodes: string[];
}

/** The secret parameter of an `otpauth://` URI, without pulling in a parser. */
export function readSecret(uri: string): string {
	const match = /[?&]secret=([^&]+)/i.exec(uri);
	if (match === null) return '';
	try {
		return decodeURIComponent(match[1]);
	} catch {
		return match[1];
	}
}

interface EnableResponse {
	method?: string;
	totpURI?: string;
	backupCodes?: string[];
}

/**
 * Re-assert the account's passkey. This is the proof the Worker's enable route
 * wants: the assertion mints a short-lived grant bound to the new session, so
 * the change is authorised by something the person just did, not by a password.
 *
 * A passkey sign-in replaces this browser's session. That is deliberate — the
 * grant names the session the ceremony created, so a grant cannot be spent from
 * a different browser.
 */
async function passkeyStepUp(): Promise<void> {
	let result: { twoFactorRedirect: boolean };
	try {
		result = await signInWithPasskey();
	} catch (error) {
		throw new ApiError(describeError(error), 0, 'passkey_required');
	}
	if (result.twoFactorRedirect) {
		// The account gained an authenticator since this page was loaded. The
		// assertion's session was withheld for a code; do not pretend otherwise.
		throw new ApiError(
			'This account now asks for an authenticator code. Sign in with it, then reload this page.',
			0,
			'reauth_required'
		);
	}
}

async function requestEnrolment(): Promise<EnableResponse> {
	return await accountRequest<EnableResponse>('/v1/auth/totp/enable', {
		method: 'POST',
		body: {}
	});
}

/**
 * Start enrolment: the Worker generates a secret and a recovery-code set in the
 * plugin's own format and stores both against the account with `verified: false`.
 *
 * The first attempt usually answers `reauth_required`; that is the passkey
 * prompt. After the assertion the same call is retried once. A second successful
 * call after an abandoned attempt is safe — it overwrites the unverified row —
 * but it does replace the codes from the first attempt, which were never shown
 * to anyone.
 */
export async function beginEnrolment(): Promise<TotpEnrolment> {
	let data: EnableResponse;
	try {
		data = await requestEnrolment();
	} catch (error) {
		if (!(error instanceof ApiError) || error.code !== 'reauth_required') {
			throw totpFailure(error, 'enable');
		}
		await passkeyStepUp();
		try {
			data = await requestEnrolment();
		} catch (retryError) {
			throw totpFailure(retryError, 'enable');
		}
	}

	const uri = typeof data?.totpURI === 'string' ? data.totpURI : '';
	if (uri === '') {
		throw new ApiError('The gateway answered without an authenticator URI. Try again.', 0);
	}
	const codes = Array.isArray(data?.backupCodes)
		? data.backupCodes.filter((code): code is string => typeof code === 'string')
		: [];
	return { uri, secret: readSecret(uri), backupCodes: codes };
}

/** The code the authenticator shows now. Wrong codes throw and enable nothing. */
export async function confirmEnrolment(code: string): Promise<void> {
	await authRequest<unknown>('/two-factor/verify-totp', {
		method: 'POST',
		body: { code }
	});
}

/**
 * Replace the recovery-code set. The previous set stops working immediately.
 * A current TOTP code proves the change, so no password is involved.
 */
export async function regenerateRecoveryCodes(code: string): Promise<string[]> {
	let data: { status?: boolean; backupCodes?: string[] };
	try {
		data = await accountRequest<{ status?: boolean; backupCodes?: string[] }>(
			'/v1/auth/totp/regenerate',
			{ method: 'POST', body: { code } }
		);
	} catch (error) {
		throw totpFailure(error, 'regenerate');
	}
	const codes = Array.isArray(data?.backupCodes)
		? data.backupCodes.filter((entry): entry is string => typeof entry === 'string')
		: [];
	if (codes.length === 0) {
		throw new ApiError('The gateway did not return new recovery codes.', 0);
	}
	return codes;
}

/**
 * Turn the factor off. The Worker checks the current code through the plugin's
 * own verifier before deleting anything, so the control cannot be bypassed by
 * calling the API directly.
 */
export async function disableTotp(code: string): Promise<void> {
	try {
		await accountRequest<{ ok?: boolean }>('/v1/auth/totp/disable', {
			method: 'POST',
			body: { code }
		});
	} catch (error) {
		throw totpFailure(error, 'disable');
	}
}

/** Six digits, or a recovery code: one line the sign-in screen can ask for. */
export function cleanCode(value: string): string {
	return value.replace(/\s+/g, '');
}

/** `123456` for a six-digit entry, `abcde-fghij` for a recovery code. */
export function isWellFormedCode(value: string, recovery: boolean): boolean {
	return recovery ? /^[a-z0-9]{5}-[a-z0-9]{5}$/i.test(value) : /^\d{6}$/.test(value);
}
