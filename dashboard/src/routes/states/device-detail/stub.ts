import { session } from '$lib/session.svelte';
import type { Device } from '$lib/types';
import {
	ARCHIVED_DEVICE,
	COPIED_AUDIT_KNOWN,
	COPIED_AUDIT_UNKNOWN_SOURCE,
	commandInfoFor,
	FAILED_TRACE,
	LIVE_DEVICE,
	OFFLINE_DEVICE,
	REVOKED_DEVICE,
	REVOKED_EMPTY_DEVICE,
	SAMPLE_COMMANDS,
	SAMPLE_COMMANDS_WITH_LONG,
	SAMPLE_MESSAGES,
	SAMPLE_MESSAGES_WITH_LONG,
	STALE_DEVICE,
	SYNCED_DEVICE,
	UNKNOWN_DEVICE,
	type DeviceDetailStateKey
} from './fixtures';

export type MockReply =
	| { kind: 'json'; status: number; body: unknown }
	| { kind: 'hold' }
	| { kind: 'offline' };

export interface DeviceDetailScenario {
	state: DeviceDetailStateKey;
	/** The account the stubbed session answers as. Defaults to an owner. */
	role?: 'owner' | 'member';
	deviceId: string;
	device: Device | null;
	handle: (method: string, path: string, url: URL) => MockReply | null;
}

interface WorkbenchWindow extends Window {
	__dakflareDeviceDetailStubInstalled?: boolean;
	__dakflareDeviceDetailScenario?: DeviceDetailScenario | null;
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

function pickDevice(state: DeviceDetailStateKey): { deviceId: string; device: Device | null } {
	switch (state) {
		case 'presence-synced':
			return { deviceId: SYNCED_DEVICE.device_id, device: SYNCED_DEVICE };
		case 'presence-stale':
			return { deviceId: STALE_DEVICE.device_id, device: STALE_DEVICE };
		case 'presence-offline':
			return { deviceId: OFFLINE_DEVICE.device_id, device: OFFLINE_DEVICE };
		case 'presence-unknown':
			return { deviceId: UNKNOWN_DEVICE.device_id, device: UNKNOWN_DEVICE };
		case 'device-null-fallback':
			return { deviceId: 'dev_orphan_link_99', device: null };
		case 'member-session':
			return { deviceId: LIVE_DEVICE.device_id, device: LIVE_DEVICE };
		case 'archived':
		case 'unarchive-error':
			return { deviceId: ARCHIVED_DEVICE.device_id, device: ARCHIVED_DEVICE };
		case 'revoked':
			return { deviceId: REVOKED_DEVICE.device_id, device: REVOKED_DEVICE };
		case 'revoked-empty':
			return { deviceId: REVOKED_EMPTY_DEVICE.device_id, device: REVOKED_EMPTY_DEVICE };
		default:
			return { deviceId: LIVE_DEVICE.device_id, device: LIVE_DEVICE };
	}
}

export function scenarioFor(state: DeviceDetailStateKey): DeviceDetailScenario {
	const { deviceId, device } = pickDevice(state);

	return {
		state,
		role: state === 'member-session' ? 'member' : 'owner',
		deviceId,
		device,
		handle: (method, path, _url) => {
			// Status
			if (method === 'GET' && path === `/v1/device/${deviceId}/status`) {
				if (state === 'loading') return hold();
				if (state === 'device-null-fallback') {
					return json({ error: 'device_not_found', message: 'No paired device with that id.' }, 404);
				}
				if (state === 'status-and-commands-error') {
					return json({ error: 'do_unreachable', message: 'DeviceHub Durable Object timed out.' }, 503);
				}
				if (state === 'presence-synced' || state === 'presence-stale' || state === 'presence-offline' || state === 'presence-unknown' || state === 'archived' || state === 'unarchive-error') {
					return json({ ws_connected: false, queue_depth: 0 });
				}
				return json({ ws_connected: true, queue_depth: 2 });
			}

			// Messages
			if (method === 'GET' && path === '/v1/messages') {
				if (state === 'loading') return hold();
				if (state === 'messages-error') {
					return json({ error: 'db_error', message: 'D1 read failed while loading messages.' }, 500);
				}
				if (
					state === 'revoked-empty' ||
					state === 'outbound-empty' ||
					state === 'status-and-commands-error' ||
					state === 'device-null-fallback'
				) {
					return json({ messages: [], limit: 20 });
				}
				if (state === 'messages-expanded') {
					return json({ messages: SAMPLE_MESSAGES_WITH_LONG, limit: 20 });
				}
				return json({ messages: SAMPLE_MESSAGES, limit: 20 });
			}

			// Copied workflows audit
			if (method === 'GET' && path === '/v1/admin/audit') {
				if (state === 'presence-offline') {
					return json({ events: COPIED_AUDIT_UNKNOWN_SOURCE, limit: 100 });
				}
				if (state === 'presence-live') {
					return json({ events: COPIED_AUDIT_KNOWN, limit: 100 });
				}
				return json({ events: [], limit: 100 });
			}

			// Outbound commands
			if (method === 'GET' && path === `/v1/admin/devices/${deviceId}/commands`) {
				if (state === 'outbound-loading') return hold();
				if (state === 'status-and-commands-error') {
					return json({ error: 'upstream_502', message: 'Command queue index unavailable.' }, 502);
				}
				if (state === 'outbound-empty' || state === 'device-null-fallback') {
					return json({ commands: [] });
				}
				if (state === 'outbound-expanded') {
					return json({ commands: SAMPLE_COMMANDS_WITH_LONG });
				}
				return json({ commands: SAMPLE_COMMANDS });
			}

			// CommandTracker single command poll
			if (method === 'GET' && path.startsWith('/v1/sms/commands/')) {
				const cmdId = path.split('/').pop() ?? '';
				return json({ command: commandInfoFor(cmdId) });
			}

			// Trace
			if (method === 'GET' && path.startsWith('/v1/admin/trace/')) {
				return json(FAILED_TRACE);
			}

			// Send SMS
			if (method === 'POST' && path === '/v1/sms/send') {
				if (state === 'send-error') {
					return json(
						{ error: 'rate_limited', message: 'Daily device SMS quota reached (120/120).' },
						429
					);
				}
				return json({ ok: true, command_id: 'cmd_new_queued_01' });
			}

			// Archive / Unarchive / Revoke / Purge
			if (method === 'POST' && path === `/v1/admin/devices/${deviceId}/archive`) {
				if (state === 'archive-error') {
					return json({ error: 'archive_failed', message: 'Could not archive device in D1.' }, 500);
				}
				return json({ ok: true });
			}

			if (method === 'POST' && path === `/v1/admin/devices/${deviceId}/unarchive`) {
				if (state === 'unarchive-error') {
					return json({ error: 'unarchive_failed', message: 'Could not unarchive device right now.' }, 500);
				}
				return json({ ok: true });
			}

			if (method === 'DELETE' && path === `/v1/admin/devices/${deviceId}`) {
				if (state === 'revoke-pending') return hold();
				if (state === 'revoke-error') {
					return json({ error: 'revoke_failed', message: 'Could not destroy device key in Durable Object.' }, 500);
				}
				return json({ ok: true, d1_deleted: 1 });
			}

			if (method === 'DELETE' && path === '/v1/messages') {
				if (state === 'purge-error') {
					return json({ error: 'purge_failed', message: 'Message purge rolled back in D1.' }, 500);
				}
				return json({ ok: true, deleted: 6, flow_runs_deleted: 2 });
			}

			return null;
		}
	};
}

function defaultReply(scenario: DeviceDetailScenario, path: string): MockReply {
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

export function installStub(scenario: DeviceDetailScenario): void {
	if (typeof window === 'undefined') return;
	const win = window as WorkbenchWindow;
	win.__dakflareDeviceDetailScenario = scenario;
	if (win.__dakflareDeviceDetailStubInstalled) return;
	win.__dakflareDeviceDetailStubInstalled = true;

	const realFetch = window.fetch.bind(window);
	window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		const url = new URL(raw, window.location.origin);
		if (url.pathname !== '/admin/session' && !/^\/(v1|api)\//.test(url.pathname)) {
			return realFetch(input, init);
		}
		const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
		const active = win.__dakflareDeviceDetailScenario ?? null;
		const handled = active?.handle(method, url.pathname, url) ?? null;
		return toResponse(handled ?? defaultReply(active ?? { state: 'presence-live', deviceId: '', device: null, handle: () => null }, url.pathname));
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
