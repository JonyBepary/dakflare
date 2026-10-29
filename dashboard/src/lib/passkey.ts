/**
 * Passkeys without a client library.
 *
 * Better Auth owns the protocol under `/api/auth/passkey/*`; the browser only
 * needs the two WebAuthn ceremonies and the base64url translation between them.
 * That is ~120 lines, so no second dependency is added to a console that has
 * none for auth (AUTH_PLAN §3).
 *
 * The endpoints used, and nothing else:
 *   GET  /api/auth/passkey/generate-authenticate-options
 *   POST /api/auth/passkey/verify-authentication
 *   GET  /api/auth/passkey/generate-register-options
 *   POST /api/auth/passkey/verify-registration
 *   GET  /api/auth/passkey/list-user-passkeys
 *   POST /api/auth/two-factor/verify-totp | verify-backup-code
 *
 * `/passkey/add-passkey` does not exist in `@better-auth/passkey` 1.7.14; the
 * pair above is what "add a passkey to this account" means in this version.
 */

import { ApiError, authRequest } from './api';
import type { PasskeySummary } from './types';

/* --------------------------------------------------------------- support */

export type PasskeySupport = 'yes' | 'insecure' | 'no';

/** Whether this browser can run either ceremony, and if not, which wall it hit. */
export function passkeySupport(): PasskeySupport {
	if (typeof window === 'undefined' || typeof navigator === 'undefined') return 'no';
	if (typeof navigator.credentials === 'undefined') return 'no';
	if (window.isSecureContext !== true) return 'insecure';
	if (typeof window.PublicKeyCredential === 'undefined') return 'no';
	return 'yes';
}

/* ------------------------------------------------------------ base64url */

function b64urlToBytes(value: string): Uint8Array<ArrayBuffer> {
	const padded = value.replace(/-/g, '+').replace(/_/g, '/');
	const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
	const bytes = new Uint8Array(new ArrayBuffer(binary.length));
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

function bytesToB64url(value: ArrayBuffer): string {
	const bytes = new Uint8Array(value);
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* ---------------------------------------------------------------- types */

/** The subset of the plugin's option JSON this console reads. */
interface CredentialDescriptorJSON {
	id: string;
	type?: string;
	transports?: string[];
}

interface AuthenticationOptionsJSON {
	challenge: string;
	rpId?: string;
	timeout?: number;
	userVerification?: UserVerificationRequirement;
	allowCredentials?: CredentialDescriptorJSON[];
}

interface RegistrationOptionsJSON {
	challenge: string;
	rp: { name: string; id: string };
	user: { id: string; name: string; displayName: string };
	/** What the server will verify. Honoured as sent; ES256/RS256 only as a fallback. */
	pubKeyCredParams?: Array<{ type: 'public-key'; alg: number }>;
	timeout?: number;
	attestation?: AttestationConveyancePreference;
	authenticatorSelection?: AuthenticatorSelectionCriteria;
	excludeCredentials?: CredentialDescriptorJSON[];
}

/** A failure the page can explain without naming a protocol noun. */
export class PasskeyFailure extends Error {
	readonly reason: 'cancelled' | 'unavailable' | 'rejected' | 'unknown';

	constructor(
		reason: 'cancelled' | 'unavailable' | 'rejected' | 'unknown',
		message: string
	) {
		super(message);
		this.name = 'PasskeyFailure';
		this.reason = reason;
	}
}

function describeCeremonyError(error: unknown): PasskeyFailure {
	const name =
		error instanceof DOMException || error instanceof Error ? error.name : '';
	if (name === 'NotAllowedError' || name === 'AbortError') {
		return new PasskeyFailure(
			'cancelled',
			'The passkey prompt was dismissed, or this device has no passkey for the console. Try again.'
		);
	}
	if (name === 'SecurityError') {
		return new PasskeyFailure(
			'unavailable',
			'The browser blocked the passkey prompt for this address. Open the console on the address it was set up for.'
		);
	}
	if (name === 'InvalidStateError') {
		return new PasskeyFailure(
			'rejected',
			'This device already holds a passkey for the account. Sign in with it, or use another device to add one.'
		);
	}
	return new PasskeyFailure('unknown', 'The passkey step did not finish. Try again.');
}

/* ------------------------------------------------------------ sign in */

/**
 * Ask the browser for a discoverable passkey and hand the answer to Better Auth.
 * Returns once the server has accepted it; whether a session exists is the
 * caller's next question, because a TOTP account answers without one.
 */
export async function signInWithPasskey(): Promise<void> {
	const support = passkeySupport();
	if (support !== 'yes') {
		throw new PasskeyFailure(
			'unavailable',
			support === 'insecure'
				? 'Passkeys need a secure address. Open the console over https, or on localhost.'
				: 'This browser cannot use passkeys. Open the console in one that can.'
		);
	}

	const { data: options } = await authRequest<AuthenticationOptionsJSON>(
		'/passkey/generate-authenticate-options'
	);

	const publicKey: PublicKeyCredentialRequestOptions = {
		challenge: b64urlToBytes(options.challenge),
		...(options.rpId === undefined ? {} : { rpId: options.rpId }),
		...(options.timeout === undefined ? {} : { timeout: options.timeout }),
		...(options.userVerification === undefined
			? {}
			: { userVerification: options.userVerification }),
		...(options.allowCredentials === undefined
			? {}
			: {
					allowCredentials: options.allowCredentials.map((entry) => ({
						id: b64urlToBytes(entry.id),
						type: 'public-key' as const,
						...(entry.transports === undefined ? {} : { transports: entry.transports as AuthenticatorTransport[] })
					}))
				})
	};

	let credential: Credential | null;
	try {
		credential = await navigator.credentials.get({ publicKey });
	} catch (error) {
		throw describeCeremonyError(error);
	}
	if (!(credential instanceof PublicKeyCredential)) {
		throw new PasskeyFailure('unknown', 'The passkey step did not finish. Try again.');
	}

	const response = credential.response as AuthenticatorAssertionResponse;
	await authRequest<unknown>('/passkey/verify-authentication', {
		method: 'POST',
		body: {
			response: {
				id: credential.id,
				rawId: bytesToB64url(credential.rawId),
				type: credential.type,
				response: {
					clientDataJSON: bytesToB64url(response.clientDataJSON),
					authenticatorData: bytesToB64url(response.authenticatorData),
					signature: bytesToB64url(response.signature),
					userHandle: response.userHandle ? bytesToB64url(response.userHandle) : null
				},
				clientExtensionResults: credential.getClientExtensionResults()
			}
		}
	});
}

/* -------------------------------------------------------------- enrol */

/** Add a passkey to the signed-in account. `name` labels it for later removal. */
export async function addPasskey(name: string): Promise<void> {
	const support = passkeySupport();
	if (support !== 'yes') {
		throw new PasskeyFailure(
			'unavailable',
			support === 'insecure'
				? 'Passkeys need a secure address. Open the console over https, or on localhost.'
				: 'This browser cannot make a passkey.'
		);
	}

	const label = name.trim() === '' ? undefined : name.trim();
	const query = label === undefined ? '' : `?name=${encodeURIComponent(label)}`;
	const { data: options } = await authRequest<RegistrationOptionsJSON>(
		`/passkey/generate-register-options${query}`
	);

	const publicKey: PublicKeyCredentialCreationOptions = {
		challenge: b64urlToBytes(options.challenge),
		rp: options.rp,
		user: {
			id: b64urlToBytes(options.user.id),
			name: options.user.name,
			displayName: options.user.displayName
		},
		pubKeyCredParams: options.pubKeyCredParams ?? [
			{ type: 'public-key', alg: -7 },
			{ type: 'public-key', alg: -257 }
		],
		...(options.timeout === undefined ? {} : { timeout: options.timeout }),
		...(options.attestation === undefined ? {} : { attestation: options.attestation }),
		...(options.authenticatorSelection === undefined
			? {}
			: { authenticatorSelection: options.authenticatorSelection }),
		...(options.excludeCredentials === undefined
			? {}
			: {
					excludeCredentials: options.excludeCredentials.map((entry) => ({
						id: b64urlToBytes(entry.id),
						type: 'public-key' as const
					}))
				})
	};

	let credential: Credential | null;
	try {
		credential = await navigator.credentials.create({ publicKey });
	} catch (error) {
		throw describeCeremonyError(error);
	}
	if (!(credential instanceof PublicKeyCredential)) {
		throw new PasskeyFailure('unknown', 'The passkey was not created. Try again.');
	}

	const response = credential.response as AuthenticatorAttestationResponse;
	const transports =
		typeof response.getTransports === 'function' ? response.getTransports() : undefined;

	await authRequest<unknown>('/passkey/verify-registration', {
		method: 'POST',
		body: {
			response: {
				id: credential.id,
				rawId: bytesToB64url(credential.rawId),
				type: credential.type,
				response: {
					clientDataJSON: bytesToB64url(response.clientDataJSON),
					attestationObject: bytesToB64url(response.attestationObject),
					...(transports === undefined ? {} : { transports })
				},
				clientExtensionResults: credential.getClientExtensionResults()
			},
			...(label === undefined ? {} : { name: label })
		}
	});
}

/** The account's passkeys. A 401 (no session) is reported as an empty list. */
export async function listPasskeys(): Promise<PasskeySummary[]> {
	try {
		const { data } = await authRequest<PasskeySummary[]>('/passkey/list-user-passkeys');
		return Array.isArray(data) ? data : [];
	} catch (error) {
		if (error instanceof ApiError && (error.status === 401 || error.status === 403)) return [];
		throw error;
	}
}

/* ------------------------------------------------------- second factor */

/** A six-digit code from an authenticator app. */
export async function verifyAuthenticatorCode(code: string): Promise<void> {
	await authRequest<unknown>('/two-factor/verify-totp', { method: 'POST', body: { code } });
}

/** A single-use recovery code, when the authenticator is gone. */
export async function verifyRecoveryCode(code: string): Promise<void> {
	await authRequest<unknown>('/two-factor/verify-backup-code', { method: 'POST', body: { code } });
}
