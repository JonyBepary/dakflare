/**
 * Magic links — AUTH_PLAN §1 factor 2.
 *
 *   POST /v1/auth/magic-link          {email}  → 202 {ok:true}
 *   POST /v1/auth/magic-link/consume  {token}  → 200 {ok:true} + session cookie
 *                                             | 410 {error:"expired"|"used"}
 *
 * Two rules shape this module:
 *
 * 1. The request endpoint answers the same thing for a known and an unknown
 *    address, and so does this screen. A refusal is only worth naming when it
 *    says nothing about the account: too many requests, or no answer at all.
 * 2. The token is spent by the POST and by nothing else. The page a link opens
 *    never calls `consumeMagicLink` on load — corporate mail scanners
 *    (Outlook SafeLinks, Gmail, Proton) prefetch every URL in a message, and a
 *    GET that consumed the token would burn the credential before its owner
 *    clicked.
 *
 * The token is never stored, logged or put anywhere but the request body.
 */

import { ApiError } from './api';

/** How long a link lives, as the Worker mints it. Copy only; the Worker decides. */
export const MAGIC_LINK_MINUTES = 15;

export type MagicFailureKind =
	| 'expired'
	| 'used'
	| 'unusable'
	| 'rate-limited'
	| 'unavailable'
	| 'bad-input'
	| 'other';

/** A refusal the page can print without naming the wire. */
export class MagicFailure extends Error {
	readonly kind: MagicFailureKind;
	/** Seconds the server asked for, when it said so. `null` means it did not. */
	readonly retryAfter: number | null;

	constructor(kind: MagicFailureKind, message: string, retryAfter: number | null = null) {
		super(message);
		this.name = 'MagicFailure';
		this.kind = kind;
		this.retryAfter = retryAfter;
	}
}

/* ---------------------------------------------------------------- requests */

/**
 * One `/v1/auth/*` call.
 *
 * Not `authRequest` (that is Better Auth's mount) and not the admin `request`
 * (that fires the global 401 handler — on a sign-in form a 401 is an answer).
 */
async function authJson<T>(path: string, init: { method: string; body: unknown }): Promise<T> {
	let response: Response;
	try {
		response = await fetch(path, {
			method: init.method,
			headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
			body: JSON.stringify(init.body),
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
			readRetryAfter(response, payload),
			message,
			payload
		);
	}

	return payload as T;
}

/** `Retry-After` (seconds or an HTTP date) or a `retryAfter` body field. */
function readRetryAfter(response: Response, payload: unknown): number | null {
	const header = response.headers.get('retry-after');
	if (header !== null) {
		const seconds = Number(header.trim());
		if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds);
		const date = Date.parse(header);
		if (Number.isFinite(date)) {
			const delta = Math.ceil((date - Date.now()) / 1000);
			if (delta > 0) return delta;
		}
	}
	if (payload && typeof payload === 'object') {
		const value = (payload as Record<string, unknown>).retryAfter;
		const seconds = typeof value === 'number' ? value : Number(value);
		if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds);
	}
	return null;
}

function waitSentence(retryAfter: number | null): string {
	if (retryAfter === null) return '';
	return ` Try again in ${retryAfter} ${retryAfter === 1 ? 'second' : 'seconds'}.`;
}

/**
 * Ask for a link. Resolves for every answer that says nothing about whether the
 * address exists — including a 4xx from a deployment that refuses the request
 * for a reason of its own.
 *
 * Throws only when the screen must change what it says:
 *   - 429 → `rate-limited` (with the server's own wait, when it gave one)
 *   - 5xx / no answer → `unavailable` (a link may not have been sent)
 */
export async function requestMagicLink(email: string, next?: string): Promise<void> {
	try {
		await authJson<{ ok?: boolean }>('/v1/auth/magic-link', {
			method: 'POST',
			body: { email }
		});
	} catch (error) {
		if (!(error instanceof ApiError)) {
			throw new MagicFailure('unavailable', 'The request did not finish. Try again.');
		}
		if (error.status === 429) {
			throw new MagicFailure(
				'rate-limited',
				`Too many link requests from this network.${waitSentence(error.retryAfter)}`,
				error.retryAfter
			);
		}
		if (error.status === 0) {
			throw new MagicFailure(
				'unavailable',
				'The gateway did not answer, so a link may not have been sent. Try again in a moment.'
			);
		}
		if (error.status >= 500) {
			throw new MagicFailure(
				'unavailable',
				'The mail could not be sent just now, so a link may not arrive. Try again in a moment.'
			);
		}
		// 400/401/403/404/409/422 and anything else: the same neutral answer a
		// known address gets, because the alternative is an address oracle.
	}
}

/**
 * Spend the token. This is the only call in the console that does, and it runs
 * from a button press — never from a page load.
 */
export async function consumeMagicLink(token: string): Promise<void> {
	try {
		await authJson<{ ok?: boolean }>('/v1/auth/magic-link/consume', {
			method: 'POST',
			body: { token }
		});
	} catch (error) {
		throw toMagicFailure(error);
	}
}

function toMagicFailure(error: unknown): MagicFailure {
	if (!(error instanceof ApiError)) {
		return new MagicFailure('other', 'The link could not be used. Try again.');
	}
	if (error.status === 410) {
		// The contract's two words, kept apart: each has its own next action.
		if (error.code === 'used') {
			return new MagicFailure('used', 'This link was already used.');
		}
		if (error.code === 'expired') {
			return new MagicFailure('expired', 'This link has expired.');
		}
		return new MagicFailure('unusable', 'This link no longer works.');
	}
	if (error.status === 429) {
		return new MagicFailure(
			'rate-limited',
			`Too many attempts.${waitSentence(error.retryAfter)}`,
			error.retryAfter
		);
	}
	if (error.status === 0) {
		return new MagicFailure(
			'unavailable',
			'The gateway did not answer, so nothing was spent. Try again.'
		);
	}
	if (error.status === 400 || error.status === 404) {
		return new MagicFailure('bad-input', 'That link is not complete. Ask for a new one.');
	}
	if (error.status === 503) {
		return new MagicFailure(
			'unavailable',
			error.serverMessage ?? 'Sign-in links are not available on this deployment right now.'
		);
	}
	return new MagicFailure('other', error.message || 'The link could not be used. Try again.');
}

/* ------------------------------------------------------------------- link */

/**
 * The token a link carries.
 *
 * `token` is the contract's name; `t` is accepted because the CLI's invite links
 * already use that short form and an operator hand-editing a link should not get
 * a dead page for it.
 */
export function readMagicToken(params: Pick<URLSearchParams, 'get'>): string | null {
	const value = params.get('token') ?? params.get('t');
	if (value === null) return null;
	const token = value.trim();
	return token === '' ? null : token;
}

/**
 * The address the link was minted for.
 *
 * The consume contract answers `{ok:true}` and a cookie — it does not say who
 * the session belongs to before the token is spent, so the landing page can only
 * show the address the link itself carries. `email` is the contract's addition to
 * the link (see the report): without it the page says "the address on the
 * account" rather than inventing one.
 */
export function readMagicAddress(params: Pick<URLSearchParams, 'get'>): string | null {
	const value = params.get('email') ?? params.get('e');
	if (value === null) return null;
	const address = value.trim();
	return address === '' ? null : address;
}
