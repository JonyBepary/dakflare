/**
 * The password factor — AUTH_PLAN §2, phase 4.
 *
 * Five endpoints, none of them under `/api/auth`:
 *
 *   POST   /v1/auth/salt               the account's salt + iteration count
 *   POST   /v1/auth/sign-in/password   {email, material} | {email, password}
 *   POST   /v1/auth/password           set or replace; live session
 *   DELETE /v1/auth/password           {code} | {password} | {material}
 *   GET    /api/auth/list-accounts     whether this account holds a credential row
 *
 * The construction, once, so the two modes cannot drift:
 *
 *   material = PBKDF2-SHA256(password, salt, iterations)   browser (m=c) or Worker (m=s)
 *   stored   = SHA-256(HMAC-SHA256(pepper_v, salt ‖ material))
 *
 * No library: PBKDF2 is `crypto.subtle` and the base64 is twelve lines, which is
 * cheaper than a dependency for one algorithm.
 *
 * ---------------------------------------------------------------------------
 * The rule that keeps accounts alive across a plan change
 * ---------------------------------------------------------------------------
 * Under `client-derived` this module ALWAYS derives the material in the browser
 * and sends `{material}` — it never sends a plaintext password, and it never
 * branches on the `m=` of the stored row. That is not an optimisation. A row
 * written on a paid deployment is tagged `m=s`; if the plan later drops to the
 * free tier the deployment goes back to `client-derived`, and the Worker there
 * refuses a plaintext body outright (`password_mode_mismatch`). The value the
 * browser derives is byte-identical to the one the Worker derived — the pepper
 * is applied after the KDF in both modes — so sending material reaches the same
 * digest and the account keeps working. Sending the plaintext because "the row
 * says s" is what locks that account out.
 *
 * Sign-in therefore always sends material, under either mode: it is the one body
 * both modes accept, and it is the cheaper of the two on a paid deployment.
 * Plaintext is used only for `server-kdf` set/replace/remove, where the contract
 * explicitly accepts it.
 */

import { ApiError, authRequest, describeError } from './api';
import type { PasswordMode } from './types';

export type { PasswordMode };

/** The Worker's bounds, in characters: `plausiblePassword`. */
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 128;

const MATERIAL_BYTES = 32;
const SALT_BYTES = 16;

/* ------------------------------------------------------------------ base64 */

/**
 * Standard base64 with padding.
 *
 * The Worker's decoder is strict: it rejects the URL-safe alphabet, missing
 * padding and anything not a multiple of four, because a stored row is a
 * security value. `btoa` already produces exactly that alphabet, so salt and
 * material are encoded here rather than through the base64url helpers passkeys
 * need.
 */
function toBase64(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> | null {
	if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
		return null;
	}
	try {
		const binary = atob(value);
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
		return bytes;
	} catch {
		return null;
	}
}

/* --------------------------------------------------------------------- KDF */

function subtle(): SubtleCrypto {
	if (typeof crypto === 'undefined' || crypto.subtle === undefined) {
		throw new PasswordFailure(
			'unavailable',
			'This browser cannot derive a password key (WebCrypto is missing). Use a passkey, or a browser that supports it.'
		);
	}
	return crypto.subtle;
}

/**
 * PBKDF2-SHA256(password, salt, iterations) → 32 bytes.
 *
 * `iterations` is always the number the gateway reported for this account, so
 * the material matches the row it will be compared against. Nothing here decides
 * the count: guessing one produces material that verifies nowhere.
 */
export async function deriveMaterial(
	password: string,
	salt: Uint8Array<ArrayBuffer>,
	iterations: number
): Promise<Uint8Array<ArrayBuffer>> {
	const base = await subtle().importKey(
		'raw',
		new TextEncoder().encode(password),
		'PBKDF2',
		false,
		['deriveBits']
	);
	const bits = await subtle().deriveBits(
		{ name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
		base,
		MATERIAL_BYTES * 8
	);
	return new Uint8Array(bits);
}

/** The three fields a `client-derived` write carries. */
export interface MaterialProof {
	material: string;
	salt: string;
	iterations: number;
}

/* -------------------------------------------------------------------- salt */

interface SaltTicket {
	salt: string;
	saltBytes: Uint8Array<ArrayBuffer>;
	iterations: number;
	/** The row's provenance when one exists; `c` for the deterministic fake salt. */
	rowMode: string;
}

/**
 * `POST /v1/auth/salt` — the account's salt and iteration count.
 *
 * The endpoint answers the same shape for an address with no account and one
 * without a password (a deterministic fake salt), on purpose. So a value here
 * proves nothing about whether the address exists, and this module never treats
 * it as though it did.
 */
async function readSaltTicket(email: string): Promise<SaltTicket> {
	const body = await accountRequest<{
		salt?: unknown;
		iterations?: unknown;
		mode?: unknown;
		pepper_version?: unknown;
	}>('/v1/auth/salt', { method: 'POST', body: { email } });

	const salt = typeof body.salt === 'string' ? body.salt : '';
	const saltBytes = fromBase64(salt);
	const iterations = Number(body.iterations);
	if (saltBytes === null || saltBytes.length !== SALT_BYTES) {
		throw new PasswordFailure(
			'unavailable',
			'The gateway answered without a usable salt. Nothing was sent; try again.'
		);
	}
	if (!Number.isSafeInteger(iterations) || iterations < 100_000 || iterations > 1_000_000) {
		throw new PasswordFailure(
			'unavailable',
			'The gateway named an iteration count this console will not run. Nothing was sent.'
		);
	}
	return {
		salt,
		saltBytes,
		iterations,
		rowMode: typeof body.mode === 'string' ? body.mode : 'c'
	};
}

/* --------------------------------------------------------- account state */

/**
 * Whether this account holds a password, read from Better Auth's own list of
 * linked accounts. The credential row *is* the password; its hash is stripped
 * from the response by the library, so nothing secret is read here — only
 * whether a row with `providerId: 'credential'` exists.
 *
 * `null` means the question could not be answered (no session, an older Worker
 * without the route). It is never treated as "not set": the page says unknown.
 */
export async function passwordIsSet(): Promise<boolean | null> {
	try {
		const { data } = await authRequest<Array<{ providerId?: unknown }>>('/list-accounts');
		if (!Array.isArray(data)) return null;
		return data.some((account) => account?.providerId === 'credential');
	} catch {
		return null;
	}
}

/* --------------------------------------------------------------- failures */

export type PasswordFailureKind =
	| 'mode-changed'
	| 'disabled'
	| 'wrong-secret'
	| 'wrong-code'
	| 'bad-input'
	| 'rate-limited'
	| 'unavailable'
	| 'forbidden'
	| 'not-set'
	| 'other';

/** A refusal the page can print without naming the wire. */
export class PasswordFailure extends Error {
	readonly kind: PasswordFailureKind;
	/** The mode the gateway named in a `password_mode_mismatch`, when it named one. */
	readonly mode: PasswordMode | null;

	constructor(kind: PasswordFailureKind, message: string, mode: PasswordMode | null = null) {
		super(message);
		this.name = 'PasswordFailure';
		this.kind = kind;
		this.mode = mode;
	}
}

/** Which sentence a 401 gets depends on what was being proved. */
export type PasswordIntent = 'sign-in' | 'set' | 'remove' | 'remove-code';

export function modeLabel(mode: PasswordMode | null): string {
	if (mode === 'client-derived') return 'derived in this browser';
	if (mode === 'server-kdf') return 'derived by the gateway';
	return 'not enabled';
}

export function readMode(value: unknown): PasswordMode {
	const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
	if (text === 'client-derived' || text === 'server-kdf') return text;
	// A typo, an unknown value or a missing field is `off`, exactly as
	// `passwordMode()` in the Worker reads it: the safe side of the switch.
	return 'off';
}

/**
 * Turn a refusal into one sentence.
 *
 * The 401 is deliberately the same sentence for a wrong password and for an
 * address with no account: the Worker spends the same work on both and answers
 * byte-identically, and copy that guessed between them would undo that.
 */
export function toPasswordFailure(error: unknown, intent: PasswordIntent): PasswordFailure {
	if (error instanceof PasswordFailure) return error;
	if (!(error instanceof ApiError)) {
		return new PasswordFailure('other', describeError(error));
	}

	const bodyMode =
		error.payload && typeof error.payload === 'object'
			? readMode((error.payload as Record<string, unknown>).mode)
			: null;

	if (error.status === 401) {
		if (intent === 'remove-code') {
			return new PasswordFailure(
				'wrong-code',
				'That code was not accepted. Nothing was changed; use the code showing now.'
			);
		}
		if (intent === 'remove') {
			return new PasswordFailure(
				'wrong-secret',
				'That password was not accepted. Nothing was changed.'
			);
		}
		return new PasswordFailure(
			'wrong-secret',
			'That email and password did not match. Nothing was changed.'
		);
	}

	if (error.code === 'password_mode_mismatch') {
		const mode = bodyMode ?? null;
		const named = mode === null ? 'a different mode' : `${modeLabel(mode)} (${mode})`;
		return new PasswordFailure(
			'mode-changed',
			`This deployment changed while this page was open: passwords are now ${named}. Nothing was changed — try again to use the new mode.`,
			mode
		);
	}

	if (error.code === 'password_disabled') {
		return new PasswordFailure(
			'disabled',
			'Passwords are switched off on this deployment. Nothing was changed.',
			'off'
		);
	}

	if (error.code === 'password_not_set') {
		return new PasswordFailure('not-set', 'This account has no password to remove.');
	}

	if (error.status === 403) {
		return new PasswordFailure(
			'forbidden',
			'Only an owner or admin can change this account’s sign-in.'
		);
	}

	if (error.status === 429) {
		const wait =
			error.retryAfter === null
				? ''
				: ` Try again in ${error.retryAfter} ${error.retryAfter === 1 ? 'second' : 'seconds'}.`;
		return new PasswordFailure('rate-limited', `Too many attempts.${wait}`);
	}

	if (error.status === 503) {
		return new PasswordFailure(
			'unavailable',
			error.serverMessage ??
				'This deployment is missing the auth secret or pepper, so no password can be stored. Nothing was changed.'
		);
	}

	if (error.status === 400) {
		return new PasswordFailure(
			'bad-input',
			intent === 'remove' || intent === 'remove-code'
				? 'The gateway asked for a different proof than this form sent — an authenticator code, if one is set. Nothing was changed.'
				: 'The gateway rejected that request. Nothing was changed.'
		);
	}

	return new PasswordFailure('other', describeError(error));
}

/* ---------------------------------------------------------------- requests */

/**
 * One `/v1/auth/*` call.
 *
 * Not `authRequest` (that is Better Auth's mount) and not `request` (that sets
 * the admin marker and fires the global 401 handler — on a sign-in form a 401 is
 * an answer, not an expired session). Cookies ride along because these routes are
 * read with `requireRole`; the 401 is returned to the caller untouched.
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
			signal: AbortSignal.timeout(30_000)
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
		throw new ApiError(message ?? `Request failed (${response.status}).`, response.status, code, null, null, message, payload);
	}

	return payload as T;
}

/* -------------------------------------------------------------------- set */

/** The browser's own 16 bytes, fresh for every write. */
function freshSalt(): Uint8Array<ArrayBuffer> {
	const salt = new Uint8Array(SALT_BYTES);
	if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') {
		throw new PasswordFailure(
			'unavailable',
			'This browser cannot make a random salt. Nothing was sent.'
		);
	}
	crypto.getRandomValues(salt);
	return salt;
}

/**
 * Produce the `{material, salt, iterations}` triple for a new password.
 *
 * A NEW salt is generated here rather than reusing the one `/v1/auth/salt`
 * returned: that salt belongs to the row being replaced (or is the deterministic
 * fake salt, which is shared by every address without a password). The iteration
 * count is taken from the gateway, so the row this writes is one the deployment
 * is willing to verify.
 */
async function newPasswordProof(email: string, password: string): Promise<MaterialProof> {
	const ticket = await readSaltTicket(email);
	const salt = freshSalt();
	const material = await deriveMaterial(password, salt, ticket.iterations);
	return { material: toBase64(material), salt: toBase64(salt), iterations: ticket.iterations };
}

/** The proof for an EXISTING password: the row's salt, the row's count. */
async function existingPasswordProof(email: string, password: string): Promise<MaterialProof> {
	const ticket = await readSaltTicket(email);
	const material = await deriveMaterial(password, ticket.saltBytes, ticket.iterations);
	return { material: toBase64(material), salt: ticket.salt, iterations: ticket.iterations };
}

export function checkPasswordLength(value: string): string | null {
	if (value.length < MIN_PASSWORD_LENGTH) {
		return `At least ${MIN_PASSWORD_LENGTH} characters. This one has ${value.length}.`;
	}
	if (value.length > MAX_PASSWORD_LENGTH) {
		return `At most ${MAX_PASSWORD_LENGTH} characters. This one has ${value.length}.`;
	}
	return null;
}

/**
 * Set or replace this account's password.
 *
 * `client-derived` sends material and nothing else — see the rule at the top of
 * the file. `server-kdf` sends the plaintext, which is the shape that mode was
 * built for; the material path is accepted there too, so a page that was open
 * across a mode change can recover by trying again.
 */
export async function setPassword(input: {
	mode: PasswordMode;
	email: string;
	password: string;
}): Promise<void> {
	const problem = checkPasswordLength(input.password);
	if (problem !== null) throw new PasswordFailure('bad-input', problem);

	if (input.mode === 'off') {
		throw new PasswordFailure(
			'disabled',
			'Passwords are switched off on this deployment. Nothing was sent.',
			'off'
		);
	}

	const body =
		input.mode === 'client-derived'
			? await newPasswordProof(input.email, input.password)
			: { password: input.password };

	try {
		await accountRequest('/v1/auth/password', { method: 'POST', body });
	} catch (error) {
		throw toPasswordFailure(error, 'set');
	}
}

/* ----------------------------------------------------------------- remove */

/**
 * Remove the password factor.
 *
 * With TOTP on, the gateway wants a current code and nothing else — the second
 * factor is the proof, so a password is not asked for. With TOTP off it wants
 * the password itself, as material under `client-derived`.
 */
export async function removePassword(input: {
	mode: PasswordMode;
	email: string;
	code?: string;
	password?: string;
}): Promise<void> {
	if (input.code !== undefined) {
		try {
			await accountRequest('/v1/auth/password', {
				method: 'DELETE',
				body: { code: input.code }
			});
		} catch (error) {
			throw toPasswordFailure(error, 'remove-code');
		}
		return;
	}

	const password = input.password ?? '';
	if (password === '') {
		throw new PasswordFailure('bad-input', 'Enter the password this account uses now.');
	}

	let body: Record<string, unknown>;
	if (input.mode === 'client-derived') {
		try {
			const proof = await existingPasswordProof(input.email, password);
			body = { material: proof.material };
		} catch (error) {
			throw toPasswordFailure(error, 'remove');
		}
	} else if (input.mode === 'server-kdf') {
		body = { password };
	} else {
		throw new PasswordFailure(
			'disabled',
			'Passwords are switched off on this deployment, so there is nothing to remove.',
			'off'
		);
	}

	try {
		await accountRequest('/v1/auth/password', { method: 'DELETE', body });
	} catch (error) {
		throw toPasswordFailure(error, 'remove');
	}
}

/* ---------------------------------------------------------------- sign in */

/**
 * Sign in with a password, on any deployment that has them on.
 *
 * The body is always `{email, material}`: the salt comes from the gateway for
 * that address (real or fake — the answer is indistinguishable, which is the
 * point), the browser runs PBKDF2, and the plaintext never leaves this device.
 * That is the only shape both modes accept, so the form needs no knowledge of
 * which mode is live to work.
 *
 * A 200 with `twoFactorRedirect` means the gateway withheld the session pending
 * an authenticator code; the caller must not look for one.
 */
export async function signInWithPassword(input: {
	email: string;
	password: string;
}): Promise<{ twoFactorRedirect: boolean }> {
	let proof: MaterialProof;
	try {
		proof = await existingPasswordProof(input.email, input.password);
	} catch (error) {
		throw toPasswordFailure(error, 'sign-in');
	}

	try {
		const body = await accountRequest<{ twoFactorRedirect?: unknown }>(
			'/v1/auth/sign-in/password',
			{ method: 'POST', body: { email: input.email, material: proof.material } }
		);
		return { twoFactorRedirect: body?.twoFactorRedirect === true };
	} catch (error) {
		throw toPasswordFailure(error, 'sign-in');
	}
}

/**
 * Is password sign-in available on this deployment, as far as an unauthenticated
 * browser can tell?
 *
 * `/v1/admin/health` carries `password_mode`, but it is admin-gated: before
 * sign-in it answers 401, so the login screen usually cannot read it. This is a
 * capability check, not a guess — the sign-in route itself refuses with
 * `password_disabled` (403) when the mode is `off`, and with the single 401 when
 * it is on. It is sent with a reserved `.example` address and an all-zero
 * material so it can never touch a real account, and it is called only when the
 * operator opens the password door, never on page load.
 *
 * Three outcomes: `on`, `off`, or `unknown` when the gateway could not answer
 * (rate limited, offline, older Worker).
 */
export async function probePasswordSignIn(): Promise<'on' | 'off' | 'unknown'> {
	try {
		await accountRequest('/v1/auth/sign-in/password', {
			method: 'POST',
			body: {
				email: 'password-check@example.invalid',
				material: toBase64(new Uint8Array(MATERIAL_BYTES))
			}
		});
		// A 200 here would mean that address signed in, which cannot happen.
		return 'unknown';
	} catch (error) {
		if (!(error instanceof ApiError)) return 'unknown';
		if (error.code === 'password_disabled') return 'off';
		if (error.code === 'password_mode_mismatch') return 'off';
		if (error.status === 401) return 'on';
		if (error.status === 400) return 'on';
		return 'unknown';
	}
}

/* --------------------------------------------------------------- strength */

export interface PasswordStrength {
	/** 0 empty, 1 short, 2 weak, 3 fair, 4 good, 5 long. */
	score: 0 | 1 | 2 | 3 | 4 | 5;
	tone: 'empty' | 'short' | 'weak' | 'fair' | 'good' | 'long';
	label: string;
	hint: string;
}

/**
 * An honest read on a password, by length alone.
 *
 * No symbol tally, no dictionary, no "score out of 100": a meter that moves when
 * someone adds `!` teaches the wrong lesson. Guessing cost grows with length
 * (and only length), so that is all this measures, and it says so.
 */
export function passwordStrength(value: string): PasswordStrength {
	const length = value.length;
	if (length === 0) {
		return {
			score: 0,
			tone: 'empty',
			label: 'Not typed yet',
			hint: `${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters. Length is what makes guessing expensive.`
		};
	}
	if (length < MIN_PASSWORD_LENGTH) {
		return {
			score: 1,
			tone: 'short',
			label: 'Too short',
			hint: `${MIN_PASSWORD_LENGTH - length} more character${MIN_PASSWORD_LENGTH - length === 1 ? '' : 's'} before the gateway will take it.`
		};
	}
	if (length < 12) {
		return {
			score: 2,
			tone: 'weak',
			label: 'Short',
			hint: 'Accepted, but a short password is the one thing here that can be guessed offline. 16 characters is a better target than 10 with punctuation.'
		};
	}
	if (length < 16) {
		return {
			score: 3,
			tone: 'fair',
			label: 'Fair',
			hint: 'Each extra character multiplies the guesses. Two more words would do more than a symbol.'
		};
	}
	if (length < 24) {
		return {
			score: 4,
			tone: 'good',
			label: 'Good length',
			hint: 'Sixteen or more: long enough that guessing is measured in years, not hours.'
		};
	}
	return {
		score: 5,
		tone: 'long',
		label: 'Long',
		hint: 'Long enough that the length, not the punctuation, is doing the work.'
	};
}
