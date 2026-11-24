import { ALERTS_CHANGED_EVENT } from '$lib/alert-events';
import { session } from '$lib/session.svelte';

export type MockReply =
	| { kind: 'json'; status: number; body: unknown }
	| { kind: 'hold' };

export interface WorkbenchScenario {
	role?: 'owner' | 'member';
	autonomyOpen?: boolean;
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

/**
 * Closed alerts for the history disclosure: one acknowledged and left open, one
 * resolved after a silence. The Worker returns both only for `?all=1`, and the
 * stub keeps that rule so the console cannot pass by asking the wrong question.
 */
export const HISTORY_ALERTS = [
	{
		id: 'alt_hist_offline',
		device_id: 'dev_ga54_field_02',
		label: 'Galaxy A54 · Field',
		kind: 'device_offline',
		raised_at: NOW - 3 * 86_400_000,
		acknowledged_at: NOW - 3 * 86_400_000 + 3_600_000,
		resolved_at: NOW - 2 * 86_400_000,
		detail: `device silent for ${6 * 3_600_000} ms (last_seen ${new Date(NOW - 2 * 86_400_000).toISOString()})`
	},
	{
		id: 'alt_hist_drift',
		device_id: 'dev_px6a_desk_01',
		label: 'Pixel 6a · Desk',
		kind: 'extraction_drift',
		raised_at: NOW - 8 * 86_400_000,
		acknowledged_at: NOW - 7 * 86_400_000,
		resolved_at: null,
		detail: JSON.stringify({
			drifts: [
				{
					flow_id: 'wf_order_confirm',
					flow_version: 4,
					node_id: 'extract_amount',
					field: 'amount',
					misses_last_hour: 11,
					last_miss_at: NOW - 7 * 86_400_000
				}
			]
		})
	}
]

export const SAMPLE_DEVICES = [
	{
		device_id: 'dev_px6a_desk_01',
		label: 'Pixel 6a · Desk',
		fcm_token: 'fcm_px6a_live',
		paired_at: NOW - 12 * 86_400_000,
		last_seen: NOW - 18_000,
		sim_slot: 0,
		archived_at: null,
		revoked_at: null
	},
	{
		device_id: 'dev_ga54_field_02',
		label: 'Galaxy A54 · Field',
		fcm_token: 'fcm_ga54_live',
		paired_at: NOW - 5 * 86_400_000,
		last_seen: NOW - 3 * 60_000,
		sim_slot: 1,
		archived_at: null,
		revoked_at: null
	}
];

export const BASE_HEALTH = {
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

export const json = (body: unknown, status = 200): MockReply => ({
	kind: 'json',
	status,
	body
});

export const hold = (): MockReply => ({ kind: 'hold' });

function toResponse(reply: MockReply): Promise<Response> {
	switch (reply.kind) {
		case 'json':
			return Promise.resolve(
				new Response(JSON.stringify(reply.body), {
					status: reply.status,
					headers: { 'content-type': 'application/json' }
				})
			);
		case 'hold':
			return new Promise<Response>(() => {});
	}
}

function defaultReply(scenario: WorkbenchScenario, _method: string, path: string): MockReply {
	const role = scenario.role ?? 'owner';
	if (path.endsWith('/admin/session')) {
		return json({ error: 'missing_auth_headers' }, 401);
	}
	if (path.endsWith('/v1/auth/me')) {
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
		if (scenario.autonomyOpen) {
			return json({
				enabled: true,
				expiresAt: Date.now() + 38 * 60_000,
				caps: { sms: 25, writes: 5 },
				usage: { day: '2026-11-18', tokens: 420, writes: 1, sms: 2 },
				actor: 'jony@example.com',
				mine: true
			});
		}
		return json({
			enabled: false,
			expiresAt: null,
			caps: { sms: 25, writes: 5 },
			usage: { day: '2026-11-18', tokens: 0, writes: 0, sms: 0 }
		});
	}
	if (path.endsWith('/v1/agent/telemetry')) {
		return json({ answer: 'All checks healthy.', plan: 'health_summary' }, 503);
	}
	if (path.endsWith('/v1/devices')) {
		return json({ devices: SAMPLE_DEVICES });
	}
	if (path.includes('/v1/device/') && path.endsWith('/status')) {
		return json({ ws_connected: true, queue_depth: 0, last_poll_at: Date.now() - 12_000 });
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
		return toResponse(handled ?? defaultReply(scenario, method, url.pathname));
	};

	if (win.__dakflareFetchInstalled) return;
	win.__dakflareFetchInstalled = true;

	const realFetch = window.fetch.bind(window);
	window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const handler = win.__dakflareFetchHandler;
		return handler ? handler(input, init, realFetch) : realFetch(input, init);
	};
}

let lastAppliedKey = '';

export async function syncWorkbenchShell(
	key: string,
	expectedRole: 'owner' | 'member' = 'owner'
): Promise<void> {
	if (typeof window === 'undefined') return;
	const prevKey = lastAppliedKey;
	lastAppliedKey = key;

	if (session.status !== 'authed' || session.role !== expectedRole) {
		await session.check();
	}

	if (prevKey !== '' && prevKey !== key) {
		window.dispatchEvent(new Event(ALERTS_CHANGED_EVENT));
	}
}
