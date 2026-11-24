import type { AuditEvent } from '$lib/types';
import {
	buildPaginatedEvents,
	POPULATED_EVENTS,
	SINGLE_EVENT,
	type AuditStateKey
} from './fixtures';

export type MockReply =
	| { kind: 'json'; status: number; body: unknown }
	| { kind: 'hold' }
	| { kind: 'offline' };

export interface AuditScenario {
	state: AuditStateKey;
	role: 'owner' | 'member';
	handle: (method: string, path: string, url: URL) => MockReply | null;
}

interface WorkbenchWindow extends Window {
	__dakflareAuditStubInstalled?: boolean;
	__dakflareAuditScenario?: AuditScenario | null;
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

const json = (body: unknown, status = 200): MockReply => ({ kind: 'json', status, body });
const hold = (): MockReply => ({ kind: 'hold' });

function matchesCategory(action: string, category: string): boolean {
	switch (category) {
		case 'auth':
			return action.startsWith('sign_in') || action.startsWith('password') || action.startsWith('totp') || action.startsWith('invite');
		case 'device':
			return action.startsWith('device');
		case 'message':
			return action.startsWith('sms');
		case 'automation':
			return action.startsWith('rule') || action.startsWith('workflow');
		case 'agent':
			return action.startsWith('agent_token');
		case 'security':
			return action.startsWith('authority') || action.startsWith('totp') || action.startsWith('password');
		default:
			return true;
	}
}

function filterEvents(events: AuditEvent[], url: URL): AuditEvent[] {
	const category = url.searchParams.get('category') ?? 'all';
	const actor = (url.searchParams.get('actor') ?? '').trim().toLowerCase();
	const action = (url.searchParams.get('action') ?? '').trim().toLowerCase();
	const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();

	return events.filter((event) => {
		if (category !== 'all' && !matchesCategory(event.action, category)) return false;
		if (
			actor !== '' &&
			!(event.actor_label ?? '').toLowerCase().includes(actor) &&
			!(event.actor_user ?? '').toLowerCase().includes(actor)
		) {
			return false;
		}
		if (action !== '' && !event.action.toLowerCase().includes(action)) return false;
		if (q !== '') {
			const haystack = JSON.stringify(event).toLowerCase();
			if (!haystack.includes(q)) return false;
		}
		return true;
	});
}

export function scenarioFor(state: AuditStateKey): AuditScenario {
	let auditCalls = 0;
	const paginatedRows = buildPaginatedEvents(100, false);
	const tiedRows = buildPaginatedEvents(100, true);

	return {
		state,
		role: state === 'member-no-access' ? 'member' : 'owner',
		handle: (method, path, url) => {
			if (method !== 'GET' || path !== '/v1/admin/audit') return null;
			auditCalls += 1;

			switch (state) {
				case 'loading':
					return hold();
				case 'empty':
					return json({ events: [], limit: 100 });
				case 'one-entry':
					return json({ events: [SINGLE_EVENT], limit: 100 });
				case 'populated':
				case 'detail-expanded':
					return json({ events: POPULATED_EVENTS, limit: 100 });
				case 'paginated':
					return json({ events: paginatedRows, limit: 100 });
				case 'loading-more':
					if (auditCalls === 1 && !url.searchParams.has('before')) {
						return json({ events: paginatedRows, limit: 100 });
					}
					return hold();
				case 'pagination-stalled':
					return json({ events: tiedRows, limit: 100 });
				case 'load-error':
					return json(
						{
							error: 'storage_unavailable',
							message: 'Audit storage is temporarily unavailable.'
						},
						503
					);
				case 'filtered-results':
					return json({ events: filterEvents(POPULATED_EVENTS, url), limit: 100 });
				case 'filtered-empty':
					if (url.searchParams.get('q')) {
						return json({ events: [], limit: 100 });
					}
					return json({ events: POPULATED_EVENTS, limit: 100 });
				case 'member-no-access':
					return json({ error: 'forbidden', message: 'Owners and admins only.' }, 403);
			}
		}
	};
}

function defaultReply(scenario: AuditScenario | null, path: string): MockReply {
	const role = scenario?.role ?? 'owner';
	if (path === '/admin/session') {
		return json({ error: 'missing_auth_headers' }, 401);
	}
	if (path === '/v1/auth/me') {
		return json({
			ok: true,
			user: {
				id: role === 'member' ? 'usr_rae_02' : 'usr_jony_01',
				email: role === 'member' ? 'rae.molina@example.com' : 'jony@example.com',
				name: role === 'member' ? 'Rae Molina' : 'Jony Reyes',
				role,
				twoFactorEnabled: true
			},
			expires_at: Date.now() + 8 * 60 * 60 * 1000,
			auth_mode: 'new'
		});
	}
	if (path === '/v1/admin/health') {
		return json({ ...BASE_HEALTH, checked_at: Date.now() });
	}
	if (path === '/v1/admin/alerts') {
		return json({ alerts: [] });
	}
	if (path === '/v1/admin/approvals') {
		return json({ approvals: [] });
	}
	if (path === '/v1/admin/grants') {
		return json({ grants: [] });
	}
	if (path === '/v1/admin/agent/runtime') {
		return json({ enabled: false, schemaVersion: 1, sessions: 0, pinnedName: 'assistant' });
	}
	if (path === '/v1/admin/agent/autonomy') {
		return json({
			enabled: false,
			expiresAt: null,
			caps: { sms: 25, writes: 5 },
			usage: { day: '2026-11-18', tokens: 0, writes: 0, sms: 0 }
		});
	}
	return json({});
}

function toResponse(reply: MockReply): Promise<Response> {
	switch (reply.kind) {
		case 'json':
			return Promise.resolve(
				new Response(JSON.stringify(reply.body), {
					status: reply.status,
					headers: { 'content-type': 'application/json' }
				})
			);
		case 'offline':
			return Promise.reject(new TypeError('Failed to fetch'));
		case 'hold':
			return new Promise<Response>(() => {});
	}
}

export function installStub(scenario: AuditScenario): void {
	if (typeof window === 'undefined') return;
	const win = window as WorkbenchWindow;
	win.__dakflareAuditScenario = scenario;
	if (win.__dakflareAuditStubInstalled) return;
	win.__dakflareAuditStubInstalled = true;

	const realFetch = window.fetch.bind(window);
	window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		const url = new URL(raw, window.location.origin);
		if (url.pathname !== '/admin/session' && !/^\/(v1|api)\//.test(url.pathname)) {
			return realFetch(input, init);
		}
		const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
		const active = win.__dakflareAuditScenario ?? null;
		const handled = active?.handle(method, url.pathname, url) ?? null;
		return toResponse(handled ?? defaultReply(active, url.pathname));
	};
}
