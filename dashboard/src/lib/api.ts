/**
 * Same-origin admin API client.
 *
 * The admin token only ever exists as an argument to `createSession`: it is put in
 * the POST body and never written to storage or kept in module state. Everything
 * afterwards rides on the HttpOnly session cookie, which the browser attaches
 * because every request sets `credentials: 'same-origin'`.
 */

import type {
	Device,
	DeviceStatus,
	Health,
	HealthResult,
	MessagesResult,
	PairingCode,
	Rule,
	RuleInput,
	SessionInfo,
	Workflow,
	WorkflowIssue,
	WorkflowSaveInput,
	WorkflowSummary
} from './types';

const SESSION_PATH = '/admin/session';

export class ApiError extends Error {
	readonly status: number;
	readonly code: string | null;
	/** The endpoint's machine-readable payload when it sends one (`details` on a 400). */
	readonly details: unknown;

	constructor(message: string, status: number, code: string | null = null, details: unknown = null) {
		super(message);
		this.name = 'ApiError';
		this.status = status;
		this.code = code;
		this.details = details;
	}
}

const CODE_MESSAGES: Record<string, string> = {
	unauthorized: 'Your session has expired. Sign in again.',
	bad_request: 'The gateway rejected that request. Check the fields and try again.',
	device_unknown: 'That device is not registered with the gateway.',
	device_exists: 'That device is already paired. Use rotate to replace its key.',
	rule_rejected: 'The gateway rejected this rule. Check the pattern against the RE2 subset.',
	workflow_invalid: 'The gateway rejected this workflow graph. See the checks list for details.',
	not_found: 'Not found — it may already have been removed.',
	rate_limited: 'Rate limited. Wait a moment and try again.',
	daily_quota_exceeded: 'This device has used its daily write allowance.',
	storage_unavailable: 'Storage is temporarily unavailable. Try again shortly.',
	payload_too_large: 'The request was too large.',
	revoke_failed: 'The device could not be revoked. It may still be able to authenticate.',
	internal_error: 'The gateway hit an internal error.'
};

interface RequestOptions extends RequestInit {
	/** Statuses whose JSON body is still meaningful (health answers 503 when degraded). */
	allowStatuses?: number[];
	/** Skip the global 401 handling — the login screen owns its own error state. */
	silentAuth?: boolean;
}

interface RawResult<T> {
	data: T;
	status: number;
}

let unauthorizedHandler: (() => void) | null = null;

/** Registered by the layout; fired once when an authenticated call comes back 401. */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
	unauthorizedHandler = handler;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<RawResult<T>> {
	const { allowStatuses = [], silentAuth = false, headers, body, ...rest } = options;

	const requestHeaders = new Headers(headers);
	requestHeaders.set('Accept', 'application/json');
	// Cookies alone are ambiguous across middleware, and the Worker contract asks for
	// this marker on every admin call. It is not a secret; it is a routing signal.
	requestHeaders.set('X-Admin-Session', '1');
	if (body !== undefined && body !== null && !requestHeaders.has('Content-Type')) {
		requestHeaders.set('Content-Type', 'application/json');
	}

	let response: Response;
	try {
		response = await fetch(path, {
			...rest,
			body,
			headers: requestHeaders,
			credentials: 'same-origin',
			signal: rest.signal ?? AbortSignal.timeout(20_000)
		});
	} catch (error) {
		if (error instanceof DOMException && error.name === 'TimeoutError') {
			throw new ApiError('The gateway did not answer in time. Try again.', 0);
		}
		throw new ApiError('Could not reach the gateway. Check the connection and try again.', 0);
	}

	const text = await response.text();
	let payload: unknown = null;
	if (text) {
		try {
			payload = JSON.parse(text);
		} catch {
			payload = null;
		}
	}

	const ok = response.ok || allowStatuses.includes(response.status);
	if (!ok) {
		const code = extractCode(payload);
		if (response.status === 401 && !silentAuth && path !== SESSION_PATH) {
			unauthorizedHandler?.();
		}
		const fallback = `Request failed (${response.status}).`;
		const details =
			payload && typeof payload === 'object'
				? ((payload as Record<string, unknown>).details ?? null)
				: null;
		throw new ApiError(code ? (CODE_MESSAGES[code] ?? fallback) : fallback, response.status, code, details);
	}

	return { data: payload as T, status: response.status };
}

function extractCode(payload: unknown): string | null {
	if (!payload || typeof payload !== 'object') return null;
	const value = (payload as Record<string, unknown>).error;
	return typeof value === 'string' ? value : null;
}

export function describeError(error: unknown): string {
	if (error instanceof ApiError) return error.message;
	if (error instanceof Error && error.message) return error.message;
	return 'Something went wrong. Try again.';
}

async function get<T>(path: string, options: RequestOptions = {}): Promise<T> {
	return (await request<T>(path, options)).data;
}

/* ------------------------------------------------------------------ session */

export function getSession(): Promise<SessionInfo> {
	return get<SessionInfo>(SESSION_PATH, { silentAuth: true });
}

export function createSession(token: string): Promise<SessionInfo> {
	return get<SessionInfo>(SESSION_PATH, {
		method: 'POST',
		body: JSON.stringify({ token }),
		silentAuth: true
	});
}

export function deleteSession(): Promise<{ ok: boolean }> {
	return get<{ ok: boolean }>(SESSION_PATH, { method: 'DELETE', silentAuth: true });
}

/* -------------------------------------------------------------------- reads */

export async function getHealth(): Promise<HealthResult> {
	const { data, status } = await request<Health>('/v1/admin/health', {
		allowStatuses: [503]
	});
	return { health: data, httpStatus: status };
}

export async function getDevices(): Promise<Device[]> {
	const data = await get<{ devices: Device[] }>('/v1/devices');
	return data.devices ?? [];
}

export async function getDeviceStatus(deviceId: string): Promise<DeviceStatus> {
	return get<DeviceStatus>(`/v1/device/${encodeURIComponent(deviceId)}/status`);
}

export async function getMessages(
	deviceId: string,
	limit = 50,
	before?: number
): Promise<MessagesResult> {
	const params = new URLSearchParams({ device_id: deviceId, limit: String(limit) });
	if (before !== undefined) params.set('before', String(before));
	return get<MessagesResult>(`/v1/messages?${params.toString()}`);
}

export async function getRules(): Promise<Rule[]> {
	const data = await get<{ rules: Rule[] }>('/v1/admin/rules');
	return data.rules ?? [];
}

/* ---------------------------------------------------------------- workflows */

export async function getWorkflows(): Promise<WorkflowSummary[]> {
	const data = await get<{ workflows: WorkflowSummary[] }>('/v1/admin/workflows');
	return data.workflows ?? [];
}

export async function getWorkflow(id: string): Promise<Workflow> {
	const data = await get<{ workflow: Workflow }>(
		`/v1/admin/workflows/${encodeURIComponent(id)}`
	);
	return data.workflow;
}

export async function saveWorkflow(id: string, input: WorkflowSaveInput): Promise<Workflow> {
	const data = await get<{ workflow: Workflow }>(
		`/v1/admin/workflows/${encodeURIComponent(id)}`,
		{ method: 'PUT', body: JSON.stringify(input) }
	);
	return data.workflow;
}

export async function deleteWorkflow(id: string): Promise<{ ok: boolean }> {
	return get<{ ok: boolean }>(`/v1/admin/workflows/${encodeURIComponent(id)}`, {
		method: 'DELETE'
	});
}

/** Coerce the Worker's `workflow_invalid` details into the dashboard's issue shape. */
export function readWorkflowIssues(error: unknown): WorkflowIssue[] {
	if (!(error instanceof ApiError) || !Array.isArray(error.details)) return [];
	return error.details.flatMap((entry) => {
		if (!entry || typeof entry !== 'object') return [];
		const value = entry as Record<string, unknown>;
		if (typeof value.path !== 'string' || typeof value.message !== 'string') return [];
		return [{ path: value.path, message: value.message }];
	});
}

/* ------------------------------------------------------------------- writes */

export async function revokeDevice(
	deviceId: string
): Promise<{ ok: boolean; d1_deleted: number }> {
	return get(`/v1/admin/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE' });
}

export async function mintPairingCode(input: {
	ttl_ms?: number;
	device_id?: string | null;
	purpose?: 'enroll' | 'rotate';
}): Promise<PairingCode> {
	return get<PairingCode>('/v1/admin/pairing-code', {
		method: 'POST',
		body: JSON.stringify(input)
	});
}

export async function createRule(input: RuleInput): Promise<{ ok: boolean; id: string }> {
	return get<{ ok: boolean; id: string }>('/v1/rules', {
		method: 'POST',
		body: JSON.stringify(input)
	});
}

export async function deleteRule(ruleId: string): Promise<{ ok: boolean; deleted: number }> {
	return get(`/v1/admin/rules/${encodeURIComponent(ruleId)}`, { method: 'DELETE' });
}
