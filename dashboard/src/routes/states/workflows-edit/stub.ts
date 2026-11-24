import { session } from '$lib/session.svelte';
import { SAMPLE_DEVICES, type WorkflowEditScenario } from './fixtures';

export type MockReply =
	| { kind: 'json'; status: number; body: unknown }
	| { kind: 'hold' }
	| { kind: 'offline' };

interface WorkbenchWindow extends Window {
	__dakflareWorkflowEditStubInstalled?: boolean;
	__dakflareWorkflowEditScenario?: WorkflowEditScenario | null;
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

function handleScenario(
	scenario: WorkflowEditScenario | null,
	method: string,
	path: string
): MockReply | null {
	if (!scenario) return null;

	if (method === 'GET' && path === '/v1/devices') {
		return json({ devices: SAMPLE_DEVICES });
	}

	if (method === 'GET' && path.startsWith('/v1/admin/workflows/')) {
		const reply = scenario.getReply;
		if (!reply) return json({ error: 'not_found' }, 404);
		switch (reply.kind) {
			case 'hold':
				return hold();
			case 'not_found':
				return json({ error: 'not_found', message: 'Workflow not found.' }, 404);
			case 'error':
				return json({ error: 'load_failed', message: reply.message }, reply.status);
			case 'ok':
				return json({ workflow: reply.workflow });
		}
	}

	if (method === 'PUT' && path.startsWith('/v1/admin/workflows/')) {
		const reply = scenario.putReply;
		if (!reply) return json({ ok: true });
		switch (reply.kind) {
			case 'hold':
				return hold();
			case 'invalid':
				return json(
					{
						error: 'workflow_invalid',
						message: 'Workflow validation failed on gateway.',
						details: reply.details
					},
					400
				);
			case 'error':
				return json({ error: 'save_failed', message: reply.message }, reply.status);
			case 'ok':
				return json({ workflow: reply.workflow });
		}
	}

	if (method === 'POST' && path === '/v1/agent/synthesize') {
		const reply = scenario.synthesizeReply;
		if (!reply) {
			return json({ error: 'unavailable', message: 'Agent not configured.' }, 503);
		}
		if (reply.kind === 'unavailable') {
			return json({ error: 'agent_unavailable', message: reply.message }, reply.status);
		}
		return json(reply.judgement);
	}

	if (method === 'POST' && path === '/v1/agent/triage') {
		return json({
			intent: { choice: 'payment_credit', probability: 0.94, confidence: 0.9 },
			injection: { probability: 0.01 },
			specificity: { score: 0.88 },
			roles: [
				{ index: 0, role: 'principal_amount', probability: 0.95 },
				{ index: 1, role: 'sender_phone', probability: 0.92 },
				{ index: 2, role: 'reference_or_txid', probability: 0.96 }
			],
			invariant: { balanceAtLeastPrincipal: true },
			source: 'workers-ai'
		});
	}

	return null;
}

function defaultReply(scenario: WorkflowEditScenario | null, path: string): MockReply {
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

export function installStub(scenario: WorkflowEditScenario): void {
	if (typeof window === 'undefined') return;
	const win = window as WorkbenchWindow;
	win.__dakflareWorkflowEditScenario = scenario;
	if (win.__dakflareWorkflowEditStubInstalled) return;
	win.__dakflareWorkflowEditStubInstalled = true;

	const realFetch = window.fetch.bind(window);
	window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		const url = new URL(raw, window.location.origin);
		// Let /admin/flow.wasm and /admin/fonts/* pass through to Vite's static server.
		if (url.pathname !== '/admin/session' && !/^\/(v1|api)\//.test(url.pathname)) {
			return realFetch(input, init);
		}
		const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
		const active = win.__dakflareWorkflowEditScenario ?? null;
		const handled = handleScenario(active, method, url.pathname);
		return toResponse(handled ?? defaultReply(active, url.pathname));
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
