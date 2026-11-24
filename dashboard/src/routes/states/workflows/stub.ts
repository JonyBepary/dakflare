import { session } from '$lib/session.svelte';
import {
	SAMPLE_DEVICES,
	SAMPLE_WORKFLOWS,
	SINGLE_WORKFLOW,
	type WorkflowsStateKey
} from './fixtures';

export type MockReply =
	| { kind: 'json'; status: number; body: unknown }
	| { kind: 'hold' }
	| { kind: 'offline' };

export interface WorkflowsScenario {
	state: WorkflowsStateKey;
	/** The account the stubbed session answers as. Defaults to an owner. */
	role?: 'owner' | 'member';
	handle: (method: string, path: string) => MockReply | null;
}

interface WorkbenchWindow extends Window {
	__dakflareWorkflowsStubInstalled?: boolean;
	__dakflareWorkflowsScenario?: WorkflowsScenario | null;
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

export function scenarioFor(state: WorkflowsStateKey): WorkflowsScenario {
	let workflowReads = 0;

	return {
		state,
		role: state === 'member-session' ? 'member' : 'owner',
		handle: (method, path) => {
			if (method === 'GET' && path === '/v1/devices') {
				return json({ devices: SAMPLE_DEVICES });
			}

			if (method === 'GET' && path === '/v1/admin/workflows') {
				workflowReads += 1;
				switch (state) {
					case 'loading':
						return hold();
					case 'empty':
						return json({ workflows: [] });
					case 'one-flow':
						return json({ workflows: [SINGLE_WORKFLOW] });
					case 'refreshing':
						return workflowReads === 1 ? json({ workflows: SAMPLE_WORKFLOWS }) : hold();
					case 'load-error':
						return json(
							{
								error: 'storage_unavailable',
								message: 'Workflow store is temporarily unavailable.'
							},
							503
						);
					default:
						return json({ workflows: SAMPLE_WORKFLOWS });
				}
			}

			if (method === 'DELETE' && path.startsWith('/v1/admin/workflows/')) {
				switch (state) {
					case 'delete-pending':
						return hold();
					case 'delete-error':
						return json(
							{
								error: 'delete_failed',
								message: 'Could not remove workflow from Durable Object cache.'
							},
							500
						);
					case 'delete-success':
						return json({ ok: true });
					default:
						return json({ ok: true });
				}
			}

			return null;
		}
	};
}

function defaultReply(scenario: WorkflowsScenario, path: string): MockReply {
	const role = scenario.role ?? 'owner';
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

export function installStub(scenario: WorkflowsScenario): void {
	if (typeof window === 'undefined') return;
	const win = window as WorkbenchWindow;
	win.__dakflareWorkflowsScenario = scenario;
	if (win.__dakflareWorkflowsStubInstalled) return;
	win.__dakflareWorkflowsStubInstalled = true;

	const realFetch = window.fetch.bind(window);
	window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		const url = new URL(raw, window.location.origin);
		if (url.pathname !== '/admin/session' && !/^\/(v1|api)\//.test(url.pathname)) {
			return realFetch(input, init);
		}
		const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
		const active = win.__dakflareWorkflowsScenario ?? null;
		const handled = active?.handle(method, url.pathname) ?? null;
		return toResponse(handled ?? defaultReply(active ?? { state: 'populated', handle: () => null }, url.pathname));
	};
}

let lastAppliedKey = '';

/** Point the console's one session at the role this state claims to be. */
export async function syncWorkbenchShell(
	key: string,
	expectedRole: 'owner' | 'member' = 'owner'
): Promise<void> {
	if (typeof window === 'undefined' || key === lastAppliedKey) return;
	lastAppliedKey = key;
	if (session.status !== 'authed' || session.role !== expectedRole) {
		await session.check();
	}
}
