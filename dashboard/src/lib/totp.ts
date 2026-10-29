/**
 * TOTP (authenticator app) through Better Auth's own endpoints.
 *
 * Nothing here re-implements the protocol: the secret, the `otpauth://` URI,
 * the recovery codes and the check itself all come from the plugin. What this
 * module owns is the conversation with a deployment that may not have the
 * plugin at all, which is the state the Security page has to be honest about.
 *
 * The endpoints, and nothing else:
 *   POST /api/auth/two-factor/get-totp-uri            — is a secret stored?
 *   POST /api/auth/two-factor/enable                  — secret + recovery codes
 *   POST /api/auth/two-factor/verify-totp             — the code, both to finish
 *                                                       enrolment and to confirm
 *                                                       a change before it happens
 *   POST /api/auth/two-factor/disable                 — remove the factor
 *   POST /api/auth/two-factor/generate-backup-codes   — replace the old set
 *
 * `enable` writes the row unverified and leaves `user.twoFactorEnabled` alone
 * until a code is accepted, so an abandoned enrolment never locks anyone out.
 * `disable` does not itself ask for a code; this module checks one first, so the
 * control on the page cannot bypass the factor even by calling the API directly.
 */

import { ApiError, authRequest, describeError } from './api';

/** What the deployment can do, read once per page load, never assumed. */
export type TotpProbe =
	| { kind: 'on' }
	| { kind: 'off' }
	| { kind: 'signed-out' }
	| { kind: 'unavailable'; reason: 'missing' | 'no-secret' | 'disabled' | 'password' }
	| { kind: 'error'; message: string };

/**
 * Ask the plugin whether this account has a confirmed secret.
 *
 * `get-totp-uri` is the one read-only call the plugin exposes for TOTP. A 404
 * means the route is not mounted (an older Worker, or a deployment without the
 * plugin); a `TOTP_NOT_ENABLED` answer means the route is there and the account
 * has no confirmed secret. The URI it returns is deliberately discarded: the
 * secret is shown once, at enrolment, and never again.
 */
export async function probeTotp(): Promise<TotpProbe> {
	try {
		await authRequest<unknown>('/two-factor/get-totp-uri', { method: 'POST', body: {} });
		return { kind: 'on' };
	} catch (error) {
		if (!(error instanceof ApiError)) return { kind: 'error', message: describeError(error) };
		if (error.status === 404) return { kind: 'unavailable', reason: 'missing' };
		if (error.status === 503) return { kind: 'unavailable', reason: 'no-secret' };
		if (error.status === 401 || error.status === 403) return { kind: 'signed-out' };
		if (error.code === 'TOTP_NOT_ENABLED') return { kind: 'off' };
		if (error.code === 'TOTP_NOT_CONFIGURED') return { kind: 'unavailable', reason: 'disabled' };
		if (error.code === 'INVALID_PASSWORD') return { kind: 'unavailable', reason: 'password' };
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
 * Start enrolment: the plugin generates a secret and a recovery-code set, and
 * stores both against the account with `verified: false`.
 *
 * A second call after an abandoned attempt is safe — the plugin overwrites the
 * unverified row — but it does replace the codes from the first attempt, which
 * were never shown to anyone.
 */
export async function beginEnrolment(): Promise<TotpEnrolment> {
	const { data } = await authRequest<EnableResponse>('/two-factor/enable', {
		method: 'POST',
		body: { method: 'totp' }
	});
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

/** Replace the recovery-code set. The previous set stops working immediately. */
export async function regenerateRecoveryCodes(): Promise<string[]> {
	const { data } = await authRequest<{ status?: boolean; backupCodes?: string[] }>(
		'/two-factor/generate-backup-codes',
		{ method: 'POST', body: {} }
	);
	const codes = Array.isArray(data?.backupCodes)
		? data.backupCodes.filter((code): code is string => typeof code === 'string')
		: [];
	if (codes.length === 0) {
		throw new ApiError('The gateway did not return new recovery codes.', 0);
	}
	return codes;
}

/**
 * Turn the factor off. A current code is checked first, through the same
 * endpoint sign-in uses, so the account cannot be stripped of its second factor
 * by someone holding only an open session.
 */
export async function disableTotp(code: string): Promise<void> {
	await authRequest<unknown>('/two-factor/verify-totp', {
		method: 'POST',
		body: { code }
	});
	await authRequest<unknown>('/two-factor/disable', { method: 'POST', body: {} });
}

/** Six digits, or a recovery code: one line the sign-in screen can ask for. */
export function cleanCode(value: string): string {
	return value.replace(/\s+/g, '');
}

/** `123456` for a six-digit entry, `abcde-fghij` for a recovery code. */
export function isWellFormedCode(value: string, recovery: boolean): boolean {
	return recovery ? /^[a-z0-9]{5}-[a-z0-9]{5}$/i.test(value) : /^\d{6}$/.test(value);
}
