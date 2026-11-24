/**
 * `window.fetch`, faked at the one boundary the page uses.
 *
 * The real page reaches the gateway through `$lib/assistant.ts` and
 * `$lib/agent-socket.ts`, and only through `fetch`:
 *
 *   GET    /v1/admin/ai/settings
 *   PUT    /v1/admin/ai/settings
 *   GET    /v1/admin/ai/models
 *   POST   /v1/admin/ai/test
 *   POST   /v1/admin/ai/system1/test
 *   GET    /v1/admin/agent/runtime
 *   GET    /v1/admin/agent/autonomy
 *   POST   /v1/admin/agent/autonomy
 *   DELETE /v1/admin/agent/autonomy
 *
 * Replacing `fetch` feeds the page the real wire shapes without touching either
 * module, the component, or the route it came from.
 *
 * The shell around the page also reads the session and its pill counts, so those
 * answer too: a 401 anywhere else would send the console's global handler to
 * `/login` and take the page with it.
 */
import type { Scenario, WirePlan } from './scenarios';
import { PRODUCT_AUTONOMY, PRODUCT_RUNTIME } from './scenarios';

type FetchHandler = (
	input: RequestInfo | URL,
	init: RequestInit | undefined,
	realFetch: typeof window.fetch
) => Promise<Response>;

interface WorkbenchWindow extends Window {
	__dakflareFetchInstalled?: boolean;
	__dakflareFetchHandler?: FetchHandler;
	__benchRequests?: RecordedRequest[];
}

/**
 * Every request that carried a body, in the order the page made it.
 *
 * A save is only observable at this boundary: the page sends `AiSettingsInput`,
 * which has no key member, and the workbench's job is to show what was actually
 * on the wire rather than what the form looked like. `window.__benchRequests`
 * exposes the same array so a driver script can read a Save body back.
 */
export interface RecordedRequest {
	method: string;
	path: string;
	body: string | null;
}

const requests: RecordedRequest[] = [];

export function recordedRequests(): RecordedRequest[] {
	return requests.slice();
}

function answer(plan: WirePlan): Promise<Response> {
	switch (plan.kind) {
		case 'json':
			return Promise.resolve(
				new Response(JSON.stringify(plan.body), {
					status: plan.status,
					headers: { 'content-type': 'application/json' }
				})
			);
		case 'text':
			return Promise.resolve(
				new Response(plan.text, {
					status: plan.status,
					headers: { 'content-type': 'text/html' }
				})
			);
		case 'offline':
			return Promise.reject(new TypeError('Failed to fetch'));
		case 'hold':
			// Never settles: "reading", "saving", "testing", "opening" and
			// "revoking" hold still until the switcher moves.
			return new Promise<Response>(() => undefined);
	}
}

/** Fall through to `/v1/auth/me` so `session.role` is always resolved cleanly. */
function sessionPlan(): WirePlan {
	return { kind: 'json', status: 401, body: { error: 'missing_auth_headers' } };
}

function mePlan(scenario: Scenario): WirePlan {
	const role = scenario.session === 'member' ? 'member' : 'owner';
	return {
		kind: 'json',
		status: 200,
		body: {
			ok: true,
			user: {
				id: role === 'member' ? 'usr_rae_02' : 'usr_01j9z4k7q3f8m2v6t0b1c5dn',
				email: role === 'member' ? 'rae.molina@example.com' : 'jony@example.com',
				name: role === 'member' ? 'Rae Molina' : 'Jony Reyes',
				role,
				twoFactorEnabled: true
			},
			expires_at: Date.now() + 8 * 60 * 60 * 1000,
			auth_mode: 'new'
		}
	};
}

/** The rail's pill counts, in this deployment's numbers. */
const HEALTH = {
	ok: true,
	version: '6.1.0',
	schema_ready: true,
	migrations: ['0001_init', '0031_ai_settings'],
	bindings: { DB: true, AI: true },
	missing_bindings: [],
	retention_days: 30,
	counts: { devices: 1, messages: 246, rules: 1, open_alerts: 0 },
	open_alerts: 0,
	last_message_at: 1_763_200_240_000,
	auth_mode: 'new',
	auth_configured: true
};

const json = (body: unknown): WirePlan => ({ kind: 'json', status: 200, body });

function planFor(scenario: Scenario, method: string, path: string): WirePlan {
	if (path.endsWith('/v1/admin/ai/settings')) {
		if (method === 'PUT') return scenario.save ?? { kind: 'hold' };
		return scenario.settings;
	}
	if (path.endsWith('/v1/admin/ai/system1/test')) return scenario.system1Test ?? { kind: 'hold' };
	if (path.endsWith('/v1/admin/ai/models')) return scenario.models ?? { kind: 'hold' };
	if (path.endsWith('/v1/admin/ai/test')) return scenario.test ?? { kind: 'hold' };
	// The agent runtime: on, with no window open, when a state is not about it.
	// That is this deployment's baseline, so every other state reads like the
	// product rather than like a deployment that never turned the agent on.
	if (path.endsWith('/v1/admin/agent/runtime')) {
		return scenario.runtime ?? json(PRODUCT_RUNTIME);
	}
	if (path.endsWith('/v1/admin/agent/autonomy')) {
		if (method === 'POST') return scenario.autonomyPost ?? { kind: 'hold' };
		if (method === 'DELETE') return scenario.autonomyDelete ?? { kind: 'hold' };
		return scenario.autonomy ?? json(PRODUCT_AUTONOMY);
	}
	if (path.endsWith('/admin/session')) return sessionPlan();
	if (path.endsWith('/v1/auth/me')) return mePlan(scenario);
	if (path.endsWith('/v1/admin/health')) return json(HEALTH);
	if (path.endsWith('/v1/admin/alerts')) return json({ alerts: [] });
	if (path.endsWith('/v1/admin/approvals')) return json({ approvals: [] });
	return json({});
}

export function installStub(scenario: Scenario): void {
	if (typeof window === 'undefined') return;
	requests.length = 0;

	const win = window as WorkbenchWindow;
	win.__benchRequests = requests;
	win.__dakflareFetchHandler = (input, init, realFetch) => {
		const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		const url = new URL(raw, window.location.origin);
		const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();

		// Anything that is not the console's own surface (the dev server's module
		// graph, a font, a probe) still goes where it was going.
		if (!/^\/(v1|admin|api)\//.test(url.pathname)) return realFetch(input, init);

		if (method !== 'GET') {
			const body = init?.body;
			requests.push({
				method,
				path: url.pathname,
				body: typeof body === 'string' ? body : body === undefined || body === null ? null : '[stream]'
			});
		}

		return answer(planFor(scenario, method, url.pathname));
	};

	if (win.__dakflareFetchInstalled) return;
	win.__dakflareFetchInstalled = true;

	const realFetch = window.fetch.bind(window);
	window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const handler = win.__dakflareFetchHandler;
		return handler ? handler(input, init, realFetch) : realFetch(input, init);
	};
}
