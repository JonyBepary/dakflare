/**
 * `GET /v1/auth/mode` — what this deployment can actually do, asked before
 * anyone signs in.
 *
 * This is the pre-session answer the login screen needed and `/v1/admin/health`
 * could never give: health sits behind the admin gate, so before sign-in it
 * usually answers 401 and the mode stayed a guess. The contract here is public
 * by design and carries no secret — only capabilities:
 *
 *   { auth_mode: "legacy" | "new", auth_configured, password_mode,
 *     password_configured, magic_link }
 *
 * Every field is read defensively. A missing boolean is `false`, and an
 * unrecognised `password_mode` is `off` (the same rule `readMode` applies, and
 * the safe side of the switch). A missing or unknown `auth_mode` is a failure
 * rather than a guess: the login screen falls back to its old behaviour, which
 * is the only honest thing to do with an answer that names no mode.
 *
 * No cookie handling and no global 401 handler: this call runs before a session
 * exists, and a refusal here is an answer, not an expired session.
 */

import { ApiError } from './api';
import { readMode, type PasswordMode } from './password';

export interface AuthModeInfo {
	auth_mode: 'legacy' | 'new';
	/** Whether a passkey can be used: an account door exists on this deployment. */
	auth_configured: boolean;
	password_mode: PasswordMode;
	/** Whether a password row can be verified at all (the pepper is present). */
	password_configured: boolean;
	/** Whether the deployment can send a sign-in link (a mailer key is present). */
	magic_link: boolean;
}

/** Turn the wire body into the five facts the login screen renders from. */
export function readAuthMode(payload: unknown): AuthModeInfo {
	const body = (payload ?? {}) as Record<string, unknown>;
	const mode = body.auth_mode;
	if (mode !== 'legacy' && mode !== 'new') {
		throw new ApiError('The gateway answered without a sign-in mode.', 0, 'auth_mode_missing');
	}
	return {
		auth_mode: mode,
		auth_configured: body.auth_configured === true,
		password_mode: readMode(body.password_mode),
		password_configured: body.password_configured === true,
		magic_link: body.magic_link === true
	};
}

/**
 * Ask the deployment how it signs people in.
 *
 * A 404 is the ordinary case for a Worker from before this route existed, and a
 * 401/403 is a proxy in front of it: both are thrown as `ApiError` so the caller
 * can tell "no answer" (status 0) and "the gateway is broken" (5xx) apart from
 * "this build does not know the route".
 */
export async function getAuthMode(): Promise<AuthModeInfo> {
	let response: Response;
	try {
		response = await fetch('/v1/auth/mode', {
			headers: { Accept: 'application/json' },
			credentials: 'same-origin',
			signal: AbortSignal.timeout(10_000)
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

	return readAuthMode(payload);
}
