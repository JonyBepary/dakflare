export type MockReply = { kind: 'json'; status: number; body: unknown };

export interface WorkbenchScenario {
	handle: (method: string, path: string, url: URL, bodyText: string | null) => MockReply | null;
}

type FetchHandler = (
	input: RequestInfo | URL,
	init: RequestInit | undefined,
	realFetch: typeof window.fetch
) => Promise<Response>;

interface WorkbenchWindow extends Window {
	__dakflareFetchInstalled?: boolean;
	__dakflareFetchHandler?: FetchHandler;
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

const json = (body: unknown, status = 200): MockReply => ({
	kind: 'json',
	status,
	body
});

function toResponse(reply: MockReply): Promise<Response> {
	return Promise.resolve(
		new Response(JSON.stringify(reply.body), {
			status: reply.status,
			headers: { 'content-type': 'application/json' }
		})
	);
}

function defaultReply(_method: string, path: string): MockReply {
	if (path.endsWith('/admin/session')) {
		return json({ error: 'missing_auth_headers' }, 401);
	}
	if (path.endsWith('/v1/auth/me')) {
		return json({
			ok: true,
			user: {
				id: 'usr_jony_01',
				email: 'jony@example.com',
				name: 'Jony Reyes',
				role: 'owner',
				twoFactorEnabled: true
			},
			expires_at: Date.now() + 8 * 60 * 60 * 1000,
			auth_mode: 'new'
		});
	}
	if (path.endsWith('/v1/admin/health')) {
		return json({ ...BASE_HEALTH, checked_at: Date.now() });
	}
	if (path.endsWith('/v1/admin/alerts')) {
		return json({ alerts: [] });
	}
	if (path.endsWith('/v1/admin/approvals')) {
		return json({ approvals: [] });
	}
	if (path.endsWith('/v1/admin/agent/runtime')) {
		return json({ enabled: false, schemaVersion: 1, sessions: 0, pinnedName: 'assistant' });
	}
	if (path.endsWith('/v1/admin/agent/autonomy')) {
		return json({
			enabled: false,
			expiresAt: null,
			caps: { sms: 25, writes: 5 },
			usage: { day: '2026-11-18', tokens: 0, writes: 0, sms: 0 }
		});
	}
	return json({});
}

export function installStateStub(scenario: WorkbenchScenario): void {
	if (typeof window === 'undefined') return;
	const win = window as WorkbenchWindow;
	win.__dakflareFetchHandler = (input, init, realFetch) => {
		const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		const url = new URL(raw, window.location.origin);
		if (!/^\/(v1|admin|api)\//.test(url.pathname)) return realFetch(input, init);

		const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
		const bodyText = typeof init?.body === 'string' ? init.body : null;
		const handled = scenario.handle(method, url.pathname, url, bodyText);
		return toResponse(handled ?? defaultReply(method, url.pathname));
	};

	if (win.__dakflareFetchInstalled) return;
	win.__dakflareFetchInstalled = true;

	const realFetch = window.fetch.bind(window);
	window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const handler = win.__dakflareFetchHandler;
		return handler ? handler(input, init, realFetch) : realFetch(input, init);
	};
}
