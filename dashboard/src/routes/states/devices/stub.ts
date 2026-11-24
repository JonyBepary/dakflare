import { session } from '$lib/session.svelte';

export type MockReply =
	| { kind: 'json'; status: number; body: unknown }
	| { kind: 'hold' }
	| { kind: 'offline' };

export interface WorkbenchScenario {
	/** The account the stubbed session answers as. Defaults to an owner. */
	role?: 'owner' | 'member';
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

export const ARCHIVED_DEVICE = {
	device_id: 'dev_spare_drawer_03',
	label: 'Pixel 5 · Spare',
	fcm_token: null,
	paired_at: NOW - 40 * 86_400_000,
	last_seen: NOW - 9 * 86_400_000,
	sim_slot: 0,
	archived_at: NOW - 3 * 86_400_000,
	revoked_at: null
};

export const REVOKED_DEVICE = {
	device_id: 'dev_lost_handset_04',
	label: 'Redmi Note · Retired',
	fcm_token: null,
	paired_at: NOW - 90 * 86_400_000,
	last_seen: NOW - 21 * 86_400_000,
	sim_slot: 0,
	archived_at: null,
	revoked_at: NOW - 7 * 86_400_000
};

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

export const json = (body: unknown, status = 200): MockReply => ({
	kind: 'json',
	status,
	body
});

export const hold = (): MockReply => ({ kind: 'hold' });
export const offline = (): MockReply => ({ kind: 'offline' });

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
		return json({
			enabled: false,
			expiresAt: null,
			caps: { sms: 25, writes: 5 },
			usage: { day: '2026-11-18', tokens: 0, writes: 0, sms: 0 }
		});
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

/**
 * Point the console's one session at the role the scenario needs, so a screen
 * that reads `session.canWrite` is drawn for the account the workbench claims.
 */
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
