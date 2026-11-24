import { session } from '$lib/session.svelte';
import type { EnrolScenario, FetchOutcome } from './fixtures';

interface SavedEnrolDescriptors {
	isSecureContext?: PropertyDescriptor;
	publicKeyCredential?: PropertyDescriptor;
	navigatorCredentials?: PropertyDescriptor;
}

declare global {
	interface Window {
		__dakflareEnrolRealFetch?: typeof window.fetch;
		__dakflareEnrolScenario?: EnrolScenario;
		__dakflareEnrolDescriptors?: SavedEnrolDescriptors;
	}
}

class MockPublicKeyCredential {
	readonly id = 'cred_01j9z4k7q3f8m2v6t0b1c5dn';
	readonly rawId = new Uint8Array(16).buffer;
	readonly type = 'public-key';
	readonly response = {};
	getClientExtensionResults(): Record<string, unknown> {
		return {};
	}
}

function saveDescriptorsOnce(): void {
	if (typeof window === 'undefined' || window.__dakflareEnrolDescriptors) return;
	window.__dakflareEnrolDescriptors = {
		isSecureContext: Object.getOwnPropertyDescriptor(window, 'isSecureContext'),
		publicKeyCredential: Object.getOwnPropertyDescriptor(window, 'PublicKeyCredential'),
		navigatorCredentials: Object.getOwnPropertyDescriptor(navigator, 'credentials')
	};
}

function restoreProperty(
	target: object,
	key: string,
	original: PropertyDescriptor | undefined
): void {
	try {
		const current = Object.getOwnPropertyDescriptor(target, key);
		if (current && current.configurable === false) return;
		if (original) {
			Object.defineProperty(target, key, original);
		} else {
			delete (target as Record<string, unknown>)[key];
		}
	} catch {
		// Ignore non-configurable host properties.
	}
}

export function restoreEnrolGlobals(): void {
	if (typeof window === 'undefined') return;
	const saved = window.__dakflareEnrolDescriptors;
	if (!saved) return;
	restoreProperty(window, 'isSecureContext', saved.isSecureContext);
	restoreProperty(window, 'PublicKeyCredential', saved.publicKeyCredential);
	restoreProperty(navigator, 'credentials', saved.navigatorCredentials);
}

function setSecureContext(value: boolean): void {
	try {
		const desc = Object.getOwnPropertyDescriptor(window, 'isSecureContext');
		if (desc && desc.configurable === false) return;
		Object.defineProperty(window, 'isSecureContext', {
			configurable: true,
			enumerable: true,
			get: () => value
		});
	} catch {
		// Ignore environments where window.isSecureContext cannot be redefined.
	}
}

function makeMockCredential(): PublicKeyCredential {
	const Ctor = window.PublicKeyCredential ?? MockPublicKeyCredential;
	const cred = Object.create(Ctor.prototype) as PublicKeyCredential;
	Object.defineProperties(cred, {
		id: { value: 'cred_01j9z4k7q3f8m2v6t0b1c5dn', enumerable: true },
		rawId: { value: new Uint8Array(16).buffer, enumerable: true },
		type: { value: 'public-key', enumerable: true },
		response: {
			value: {
				clientDataJSON: new Uint8Array(16).buffer,
				attestationObject: new Uint8Array(32).buffer,
				getTransports: () => ['internal']
			},
			enumerable: true
		},
		getClientExtensionResults: { value: () => ({}), enumerable: true }
	});
	return cred;
}

function applyBrowserSupport(scenario: EnrolScenario): void {
	saveDescriptorsOnce();
	restoreEnrolGlobals();

	const mockCredentials = {
		create: async (): Promise<Credential | null> => {
			if (scenario.ceremony.kind === 'reject') {
				throw new DOMException(scenario.ceremony.message, scenario.ceremony.name);
			}
			if (scenario.ceremony.kind === 'resolve') {
				return makeMockCredential();
			}
			return null;
		},
		get: async (): Promise<Credential | null> => null
	};

	try {
		const credsDesc = Object.getOwnPropertyDescriptor(navigator, 'credentials');
		if (!credsDesc || credsDesc.configurable !== false) {
			Object.defineProperty(navigator, 'credentials', {
				configurable: true,
				value: mockCredentials
			});
		}
	} catch {
		// Ignore if navigator.credentials is locked down.
	}

	if (scenario.support === 'insecure') {
		setSecureContext(false);
		return;
	}

	setSecureContext(true);

	if (scenario.support === 'no') {
		try {
			const desc = Object.getOwnPropertyDescriptor(window, 'PublicKeyCredential');
			if (!desc || desc.configurable !== false) {
				Object.defineProperty(window, 'PublicKeyCredential', {
					configurable: true,
					writable: true,
					value: undefined
				});
			}
		} catch {
			// Ignore if non-configurable.
		}
		return;
	}

	if (typeof window.PublicKeyCredential === 'undefined') {
		try {
			Object.defineProperty(window, 'PublicKeyCredential', {
				configurable: true,
				writable: true,
				value: MockPublicKeyCredential
			});
		} catch {
			// Ignore if non-configurable.
		}
	}
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' }
	});
}

function settleOutcome(outcome: FetchOutcome): Promise<Response> {
	if (outcome.kind === 'hold') return new Promise<Response>(() => {});
	if (outcome.kind === 'offline') {
		return Promise.reject(new TypeError('Failed to fetch'));
	}
	return Promise.resolve(jsonResponse(outcome.body, outcome.status));
}

export function installEnrolStub(scenario: EnrolScenario): void {
	if (typeof window === 'undefined') return;
	window.__dakflareEnrolScenario = scenario;
	session.clear();
	applyBrowserSupport(scenario);

	if (!window.__dakflareEnrolRealFetch) {
		window.__dakflareEnrolRealFetch = window.fetch.bind(window);
	}
	const realFetch = window.__dakflareEnrolRealFetch;

	window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const rawUrl =
			typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		let url: URL;
		try {
			url = new URL(rawUrl, window.location.origin);
		} catch {
			return realFetch(input, init);
		}

		const isApi =
			url.pathname === '/admin/session' || /^\/(v1|api\/auth)\//.test(url.pathname);
		if (!isApi) return realFetch(input, init);

		const active = window.__dakflareEnrolScenario ?? scenario;
		const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();

		if (url.pathname === '/admin/session' && method === 'GET') {
			return jsonResponse({ ok: true, expires_at: Date.now() + 8 * 3_600_000 });
		}
		if (url.pathname === '/v1/admin/health') {
			return jsonResponse({ ok: true, status: 'healthy', checks: [] });
		}
		if (url.pathname === '/v1/admin/alerts') {
			return jsonResponse({ alerts: [] });
		}
		if (url.pathname === '/v1/admin/approvals') {
			return jsonResponse({ approvals: [] });
		}
		if (url.pathname === '/v1/admin/agent/autonomy') {
			return jsonResponse({ enabled: false, expires_at: null, grants: [] });
		}
		if (url.pathname === '/v1/admin/agent/runtime') {
			return jsonResponse({ ok: true, providers: [] });
		}
		if (url.pathname === '/v1/auth/me' && method === 'GET') {
			return settleOutcome(active.me);
		}
		if (url.pathname === '/api/auth/passkey/list-user-passkeys' && method === 'GET') {
			return settleOutcome(active.listPasskeys);
		}
		if (url.pathname === '/api/auth/passkey/generate-register-options' && method === 'GET') {
			return settleOutcome(active.generateRegisterOptions);
		}
		if (url.pathname === '/api/auth/passkey/verify-registration' && method === 'POST') {
			return settleOutcome(active.verifyRegistration);
		}
		if (url.pathname === '/api/auth/sign-out' && method === 'POST') {
			return jsonResponse({ ok: true });
		}

		return jsonResponse({ error: 'not_found' }, 404);
	};
}
