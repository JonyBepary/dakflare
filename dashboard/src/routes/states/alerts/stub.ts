/**
 * Alerts workbench stub.
 *
 * The banner lives in the shell, not in a page, so this stub only decides what
 * `/v1/admin/alerts` answers and lets the real `AlertBanner` draw it. The detail
 * strings are the shapes the Worker actually writes: `device_offline` is prose
 * with a millisecond count, `extraction_drift` is the `{ drifts: [...] }` JSON
 * that `flow/dispatch.ts` merges per device.
 */

export type MockReply =
	| { kind: 'json'; status: number; body: unknown }
	| { kind: 'hold' };

export interface WorkbenchScenario {
	/** The account the stubbed session answers as. Defaults to an owner. */
	role?: 'owner' | 'member';
	alerts: unknown[];
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
	counts: { devices: 2, messages: 284, rules: 4, pairing_codes: 0, open_alerts: 1 },
	open_alerts: 1,
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

/** One flow that stopped capturing what its extract node declares. */
export const DRIFT_ALERT = {
	id: 'alt_drift_01',
	device_id: 'dev_px6a_desk_01',
	label: 'Pixel 6a · Desk',
	kind: 'extraction_drift',
	raised_at: NOW - 7 * 60_000,
	acknowledged_at: null,
	resolved_at: null,
	detail: JSON.stringify({
		drifts: [
			{
				flow_id: 'wf_order_confirm',
				flow_version: 4,
				node_id: 'extract_amount',
				field: 'amount',
				misses_last_hour: 4,
				last_miss_at: NOW - 3 * 60_000
			}
		]
	})
};

/** A phone that stopped answering: the one alert that is a real outage. */
export const OFFLINE_ALERT = {
	id: 'alt_offline_02',
	device_id: 'dev_ga54_field_02',
	label: 'Galaxy A54 · Field',
	kind: 'device_offline',
	raised_at: NOW - 26 * 60_000,
	acknowledged_at: null,
	resolved_at: null,
	detail: `device silent for ${26 * 60_000} ms (last_seen ${new Date(NOW - 26 * 60_000).toISOString()})`
};

/**
 * A kind this console has no wording for. The banner must say so and keep the
 * gateway's detail, never describe it as silence.
 */
export const UNKNOWN_ALERT = {
	id: 'alt_unknown_03',
	device_id: 'dev_px6a_desk_01',
	label: 'Pixel 6a · Desk',
	kind: 'sim_rotation_failed',
	raised_at: NOW - 12 * 60_000,
	acknowledged_at: null,
	resolved_at: null,
	detail: 'SIM slot 1 refused the rotation handshake after three attempts.'
};

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
	if (path.endsWith('/v1/admin/alerts')) {
		return json({ alerts: scenario.alerts });
	}
	if (path.endsWith('/v1/admin/health')) {
		return json({ ...BASE_HEALTH, checked_at: Date.now() });
	}
	if (path.endsWith('/v1/admin/approvals')) {
		return json({ approvals: [] });
	}
	if (path.endsWith('/v1/admin/grants')) {
		return json({ grants: [] });
	}
	if (path.endsWith('/v1/devices')) {
		return json({
			devices: [
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
					last_seen: NOW - 26 * 60_000,
					sim_slot: 1,
					archived_at: null,
					revoked_at: null
				}
			]
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
