import { session } from '$lib/session.svelte';
import type { FetchOutcome, LoginScenario } from './fixtures';

interface SavedLoginDescriptors {
	isSecureContext?: PropertyDescriptor;
	publicKeyCredential?: PropertyDescriptor;
	navigatorCredentials?: PropertyDescriptor;
}

declare global {
	interface Window {
		__dakflareLoginRealFetch?: typeof window.fetch;
		__dakflareLoginScenario?: LoginScenario;
		__dakflareLoginMounted?: boolean;
		__dakflareLoginMeCount?: number;
		__dakflareLoginDescriptors?: SavedLoginDescriptors;
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
	if (typeof window === 'undefined' || window.__dakflareLoginDescriptors) return;
	window.__dakflareLoginDescriptors = {
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

export function restoreLoginGlobals(): void {
	if (typeof window === 'undefined') return;
	const saved = window.__dakflareLoginDescriptors;
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

function makeAssertionCredential(): PublicKeyCredential {
	const Ctor = window.PublicKeyCredential ?? MockPublicKeyCredential;
	const cred = Object.create(Ctor.prototype) as PublicKeyCredential;
	Object.defineProperties(cred, {
		id: { value: 'cred_01j9z4k7q3f8m2v6t0b1c5dn', enumerable: true },
		rawId: { value: new Uint8Array(16).buffer, enumerable: true },
		type: { value: 'public-key', enumerable: true },
		response: {
			value: {
				clientDataJSON: new Uint8Array(16).buffer,
				authenticatorData: new Uint8Array(37).buffer,
				signature: new Uint8Array(64).buffer,
				userHandle: null
			},
			enumerable: true
		},
		getClientExtensionResults: { value: () => ({}), enumerable: true }
	});
	return cred;
}

function applyBrowserSupport(scenario: LoginScenario): void {
	saveDescriptorsOnce();
	restoreLoginGlobals();

	const mockCredentials = {
		get: async (): Promise<Credential | null> => {
			if (scenario.passkeyGet.kind === 'reject') {
				throw new DOMException(scenario.passkeyGet.message, scenario.passkeyGet.name);
			}
			if (scenario.passkeyGet.kind === 'resolve') {
				return makeAssertionCredential();
			}
			return null;
		},
		create: async (): Promise<Credential | null> => null
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
		// Ignore if navigator.credentials cannot be redefined.
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

function jsonResponse(
	body: unknown,
	status = 200,
	extraHeaders?: Record<string, string>
): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json', ...(extraHeaders ?? {}) }
	});
}

function settleOutcome(outcome: FetchOutcome): Promise<Response> {
	if (outcome.kind === 'hold') return new Promise<Response>(() => {});
	if (outcome.kind === 'offline') {
		return Promise.reject(new TypeError('Failed to fetch'));
	}
	return Promise.resolve(jsonResponse(outcome.body, outcome.status, outcome.headers));
}

export function markLoginWorkbenchMounted(): void {
	if (typeof window === 'undefined') return;
	window.__dakflareLoginMounted = true;
	session.clear();
}

export function installLoginStub(scenario: LoginScenario): void {
	if (typeof window === 'undefined') return;
	window.__dakflareLoginScenario = scenario;
	window.__dakflareLoginMeCount = 0;
	if (window.__dakflareLoginMounted) {
		session.clear();
	}
	applyBrowserSupport(scenario);

	if (!window.__dakflareLoginRealFetch) {
		window.__dakflareLoginRealFetch = window.fetch.bind(window);
	}
	const realFetch = window.__dakflareLoginRealFetch;

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

		const active = window.__dakflareLoginScenario ?? scenario;
		const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();

		// Phase 1: +layout.svelte bootSession() before workbench mounts
		if (url.pathname === '/admin/session' && method === 'GET') {
			if (!window.__dakflareLoginMounted || session.status === 'unknown') {
				return jsonResponse({ ok: true, expires_at: Date.now() + 8 * 3_600_000 });
			}
			return jsonResponse({ error: 'missing_auth_headers' }, 401);
		}

		// Layout background endpoints
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

		// Phase 2: login/+page.svelte endpoints
		if (url.pathname === '/v1/auth/me' && method === 'GET') {
			window.__dakflareLoginMeCount = (window.__dakflareLoginMeCount ?? 0) + 1;
			if (window.__dakflareLoginMeCount >= 2 && active.secondMe) {
				return settleOutcome(active.secondMe);
			}
			return jsonResponse({ error: 'unauthorized' }, 401);
		}
		if (url.pathname === '/v1/auth/mode' && method === 'GET') {
			return settleOutcome(active.mode);
		}
		if (url.pathname === '/api/auth/get-session' && method === 'GET') {
			return settleOutcome(active.getSession);
		}
		if (url.pathname === '/api/auth/sign-out' && method === 'POST') {
			return jsonResponse({ ok: true });
		}
		if (url.pathname === '/admin/session' && method === 'POST') {
			return settleOutcome(active.adminSessionPost);
		}
		if (url.pathname === '/v1/auth/challenge' && method === 'GET') {
			return settleOutcome(active.challenge);
		}
		if (url.pathname === '/v1/auth/magic-link' && method === 'POST') {
			return settleOutcome(active.magicLink);
		}
		if (url.pathname === '/v1/auth/salt' && method === 'POST') {
			return settleOutcome(active.salt);
		}
		if (url.pathname === '/v1/auth/sign-in/password' && method === 'POST') {
			return settleOutcome(active.passwordSignIn);
		}
		if (url.pathname === '/api/auth/passkey/generate-authenticate-options' && method === 'GET') {
			return settleOutcome(active.passkeyOptions);
		}
		if (url.pathname === '/api/auth/passkey/verify-authentication' && method === 'POST') {
			return settleOutcome(active.passkeyVerify);
		}
		if (url.pathname === '/api/auth/two-factor/verify-totp' && method === 'POST') {
			return settleOutcome(active.totpVerify);
		}

		return jsonResponse({ error: 'not_found' }, 404);
	};
}
