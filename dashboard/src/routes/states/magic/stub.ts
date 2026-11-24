import type { FetchOutcome, MagicScenario } from './fixtures';

declare global {
	interface Window {
		__dakflareMagicRealFetch?: typeof window.fetch;
		__dakflareMagicScenario?: MagicScenario;
		__dakflareMagicMounted?: boolean;
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

export function markMagicWorkbenchMounted(): void {
	if (typeof window === 'undefined') return;
	window.__dakflareMagicMounted = true;
}

export function installMagicStub(scenario: MagicScenario): void {
	if (typeof window === 'undefined') return;
	window.__dakflareMagicScenario = scenario;

	if (!window.__dakflareMagicRealFetch) {
		window.__dakflareMagicRealFetch = window.fetch.bind(window);
	}
	const realFetch = window.__dakflareMagicRealFetch;

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

		const active = window.__dakflareMagicScenario ?? scenario;
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
		if (url.pathname === '/v1/auth/magic-link/consume' && method === 'POST') {
			return settleOutcome(active.consume);
		}
		if (url.pathname === '/v1/auth/me' && method === 'GET') {
			return settleOutcome(active.me);
		}

		return jsonResponse({ error: 'not_found' }, 404);
	};
}
