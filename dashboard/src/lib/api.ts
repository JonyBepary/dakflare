/**
 * Same-origin admin API client.
 *
 * The admin token only ever exists as an argument to `createSession`: it is put in
 * the POST body and never written to storage or kept in module state. Everything
 * afterwards rides on the HttpOnly session cookie, which the browser attaches
 * because every request sets `credentials: 'same-origin'`.
 */

import type {
	Alert,
	ApprovalDecision,
	ApprovalRequest,
	AuditResult,
	CommandInfo,
	Device,
	DeviceCommand,
	DeviceStatus,
	Health,
	HealthResult,
	InviteList,
	MeInfo,
	MessagesResult,
	MintedInvite,
	PairingCode,
	RedeemInfo,
	Rule,
	RuleInput,
	RuleTestResult,
	SessionInfo,
	Workflow,
	WorkflowIssue,
	WorkflowSaveInput,
	WorkflowSummary
} from './types';

const SESSION_PATH = '/admin/session';

/** Better Auth's mount. Same origin, cookies only — no second client library. */
const AUTH_BASE = '/api/auth';

export class ApiError extends Error {
	readonly status: number;
	readonly code: string | null;
	/** The endpoint's machine-readable payload when it sends one (`details` on a 400). */
	readonly details: unknown;
	/**
	 * Seconds the endpoint asked us to wait, when it said so. `null` means it
	 * did not: no countdown is invented from a bare 429.
	 */
	readonly retryAfter: number | null;
	/** The endpoint's own sentence, kept when our copy is the one shown. */
	readonly serverMessage: string | null;
	/**
	 * The whole decoded body, when it was JSON. Some refusals carry the fact that
	 * explains them — a `password_mode_mismatch` names the mode the deployment
	 * moved to — and a sentence written without that value would be a guess.
	 */
	readonly payload: unknown;

	constructor(
		message: string,
		status: number,
		code: string | null = null,
		details: unknown = null,
		retryAfter: number | null = null,
		serverMessage: string | null = null,
		payload: unknown = null
	) {
		super(message);
		this.name = 'ApiError';
		this.status = status;
		this.code = code;
		this.details = details;
		this.retryAfter = retryAfter;
		this.serverMessage = serverMessage;
		this.payload = payload;
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
	internal_error: 'The gateway hit an internal error.',
	// Approval decisions. Each one names what to do about the stale row.
	not_pending: 'That request was already answered or has expired. Refresh to see the current queue.',
	expired: 'That request expired before it was answered. Refresh to see the current queue.',
	not_grantable: 'This gateway cannot grant that permission. Reject the request and ask the agent for a permission with a known ceiling.',
	bad_target: 'The request does not name who it applies to, so it cannot be granted. Reject it and ask the agent to send a new request.',
	// Account paths (AUTH_PLAN §4). Each one names the next action, not the wire.
	invite_invalid: 'That invite was already used or has expired. Ask the owner for a new one.',
	already_registered: 'That address already has an account. Sign in instead.',
	forbidden: 'This account is not allowed to do that.',
	session_failed: 'The invite worked, but no session was issued. Open the link again.',
	auth_unavailable: 'This deployment has no auth secret yet.',
	owner_exists: 'This deployment already has an owner. Sign in instead.',
	// Better Auth's two-factor error codes (plugins/two-factor/error-code.ts).
	// Each names the next action rather than echoing the wire.
	INVALID_CODE: 'That code was not accepted. Check the authenticator and use the code showing now.',
	INVALID_BACKUP_CODE: 'That recovery code was not accepted. Each one works once — check the one you typed.',
	TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE: 'Too many attempts. Sign in with your passkey again to start over.',
	ACCOUNT_TEMPORARILY_LOCKED: 'Too many failed codes on this account.',
	INVALID_TWO_FACTOR_COOKIE: 'This sign-in expired before the code was entered. Start again with your passkey.',
	TOTP_ALREADY_ENABLED: 'An authenticator is already set up on this account.',
	TOTP_NOT_ENABLED: 'No authenticator is set up on this account yet.',
	TOTP_NOT_CONFIGURED: 'Authenticator codes are not available on this deployment.',
	TWO_FACTOR_NOT_ENABLED: 'Two-factor is not set up on this account.',
	INVALID_PASSWORD: 'This deployment asked for a password to change two-factor, and this account has none.'
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
		throw new ApiError(code ? (CODE_MESSAGES[code] ?? fallback) : fallback, response.status, code, details, null, null, payload);
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

/* --------------------------------------------------------------- accounts */

/**
 * `GET /v1/auth/me` — the Better Auth session, when this deployment is on
 * `AUTH_MODE=new`. A 401 here is not an error the layout shows: it means the
 * legacy cookie is the one to ask about.
 */
export function getMe(): Promise<MeInfo> {
	return get<MeInfo>('/v1/auth/me', { silentAuth: true });
}

/** `POST /v1/auth/redeem` — spends the invite and answers with the session cookie. */
export function redeemInvite(token: string): Promise<RedeemInfo> {
	return get<RedeemInfo>('/v1/auth/redeem', {
		method: 'POST',
		body: JSON.stringify({ token }),
		silentAuth: true
	});
}

/**
 * One request to the Better Auth mount.
 *
 * The library owns its routes, cookies and error envelope, so this is a thin
 * JSON fetch rather than an admin call: no `X-Admin-Session`, no `/v1` prefix,
 * and no global 401 handling — these run before a console session exists.
 */
export async function authRequest<T>(
	path: string,
	init: { method?: string; body?: unknown } = {}
): Promise<{ data: T; status: number }> {
	const method = init.method ?? 'GET';
	// Better Auth's router answers 415 to a POST with no JSON content type, and
	// `/sign-out` has no body of its own. Sending `{}` keeps every POST on the
	// mount well-formed — without it a sign-out silently did nothing.
	const body = init.body ?? (method === 'GET' || method === 'HEAD' ? undefined : {});

	const headers = new Headers({ Accept: 'application/json' });
	if (body !== undefined) headers.set('Content-Type', 'application/json');

	let response: Response;
	try {
		response = await fetch(`${AUTH_BASE}${path}`, {
			method,
			headers,
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			credentials: 'same-origin',
			signal: AbortSignal.timeout(20_000)
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

	if (!response.ok) {
		const code = extractCode(payload) ?? extractField(payload, 'code');
		const fallback = `Request failed (${response.status}).`;
		const retryAfter = readRetryAfter(response, payload);
		throw new ApiError(
			code ? (CODE_MESSAGES[code] ?? fallback) : fallback,
			response.status,
			code,
			null,
			retryAfter,
			extractField(payload, 'message'),
			payload
		);
	}

	return { data: payload as T, status: response.status };
}

/**
 * The wait the server itself asked for: a `Retry-After` header (seconds, or an
 * HTTP date), or a `retryAfter` field in the body. `null` when it said nothing,
 * so no timer is ever invented on the screen.
 */
function readRetryAfter(response: Response, payload: unknown): number | null {
	const header = response.headers.get('retry-after');
	if (header !== null) {
		const seconds = Number(header.trim());
		if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds);
		const date = Date.parse(header);
		if (Number.isFinite(date)) {
			const delta = Math.ceil((date - Date.now()) / 1000);
			if (delta > 0) return delta;
		}
	}
	if (payload && typeof payload === 'object') {
		const value = (payload as Record<string, unknown>).retryAfter;
		const seconds = typeof value === 'number' ? value : Number(value);
		if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds);
	}
	return null;
}

/** The current Better Auth session, or `null`. Throws 503 when `/api/auth` is off. */
export async function getAuthSession(): Promise<unknown> {
	const { data } = await authRequest<unknown>('/get-session');
	return data ?? null;
}

export async function signOutAccount(): Promise<void> {
	try {
		await authRequest<unknown>('/sign-out', { method: 'POST' });
	} catch {
		// Leaving the screen matters more than the cookie clearing itself.
	}
}

/* ------------------------------------------------------------------ invites */

/**
 * `GET /v1/admin/invites` — pending and spent rows, with the gateway's clock.
 *
 * The list is the operator's record of who may still make an account; `now` is
 * what decides whether a row is open or expired, so the page does not have to
 * trust the browser's clock for that call.
 */
export function getInvites(): Promise<InviteList> {
	return get<InviteList>('/v1/admin/invites');
}

/**
 * `POST /v1/admin/invites` — mint one single-use invite.
 *
 * The response's `token` is the only copy that will ever exist outside the
 * invitee's hands. Refusals worth naming: `already_registered` (409) and
 * `forbidden` (403) when a non-owner asks for the owner role.
 */
export function createInvite(input: {
	email: string;
	role: 'owner' | 'admin' | 'member';
	expires_in_s: number;
}): Promise<MintedInvite> {
	return get<MintedInvite>('/v1/admin/invites', {
		method: 'POST',
		body: JSON.stringify(input)
	});
}

/** `DELETE /v1/admin/invites/:id` — revoke an unspent invite; 404 when it is gone. */
export function revokeInvite(id: string): Promise<{ ok: boolean; deleted: number }> {
	return get(`/v1/admin/invites/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/* ------------------------------------------------------------------- audit */

export interface AuditQuery {
	limit?: number;
	/** Keyset cursor: the `at` of the oldest row already shown. */
	before?: number;
	actor?: string;
	action?: string;
}

export function getAudit(query: AuditQuery = {}): Promise<AuditResult> {
	const params = new URLSearchParams({ limit: String(query.limit ?? 100) });
	if (query.before !== undefined) params.set('before', String(query.before));
	if (query.actor) params.set('actor', query.actor);
	if (query.action) params.set('action', query.action);
	return get<AuditResult>(`/v1/admin/audit?${params.toString()}`);
}

/* --------------------------------------------------------------- approvals */

/**
 * `GET /v1/admin/approvals`: the queue a human answers.
 *
 * `state=PENDING` is the read the screen needs, and the Worker also drops rows
 * whose `expires_at` has passed even when their stored state still says
 * `PENDING`, so every row here can be answered now.
 */
export async function getApprovals(state = 'PENDING'): Promise<ApprovalRequest[]> {
	const query = state === '' ? '' : `?state=${encodeURIComponent(state)}`;
	const data = await get<{ approvals: ApprovalRequest[] }>(`/v1/admin/approvals${query}`);
	return data.approvals ?? [];
}

/**
 * `POST /v1/admin/approvals/:id/approve` mints the grant.
 *
 * The response is the only evidence that a grant exists: the screen must not
 * call an approval successful before this resolves with `ok: true`.
 */
export function approveApproval(
	id: string,
	durationS: number
): Promise<ApprovalDecision> {
	return get<ApprovalDecision>(
		`/v1/admin/approvals/${encodeURIComponent(id)}/approve`,
		{ method: 'POST', body: JSON.stringify({ duration_s: durationS }) }
	);
}

/** `POST /v1/admin/approvals/:id/reject` closes the request without a grant. */
export function rejectApproval(
	id: string
): Promise<{ ok: boolean; approval: ApprovalRequest }> {
	return get<{ ok: boolean; approval: ApprovalRequest }>(
		`/v1/admin/approvals/${encodeURIComponent(id)}/reject`,
		{ method: 'POST', body: JSON.stringify({}) }
	);
}

function extractField(payload: unknown, field: string): string | null {
	if (!payload || typeof payload !== 'object') return null;
	const value = (payload as Record<string, unknown>)[field];
	return typeof value === 'string' ? value : null;
}


/* -------------------------------------------------------------------- reads */

export async function getHealth(silentAuth = false): Promise<HealthResult> {
	const { data, status } = await request<Health>('/v1/admin/health', {
		allowStatuses: [503],
		silentAuth
	});
	return { health: data, httpStatus: status };
}

/**
 * `GET /v1/devices` — the fleet, active devices only unless asked otherwise.
 *
 * `include_archived` is the whole toggle: the default read is the fleet the
 * operator works with, and archived rows are a separate, explicit request.
 */
export async function getDevices(includeArchived = false): Promise<Device[]> {
	const query = includeArchived ? '?include_archived=1' : '';
	const data = await get<{ devices: Device[] }>(`/v1/devices${query}`);
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

/* ------------------------------------------------------------------ alerts */

export async function getAlerts(all = false): Promise<Alert[]> {
	const data = await get<{ alerts: Alert[] }>(
		`/v1/admin/alerts${all ? '?all=1' : ''}`
	);
	return data.alerts ?? [];
}

export async function acknowledgeAlert(
	alertId: string
): Promise<{ ok: boolean; id: string; acknowledged_at: number }> {
	return get<{ ok: true; id: string; acknowledged_at: number }>(
		`/v1/admin/alerts/${encodeURIComponent(alertId)}/ack`,
		{ method: 'POST' }
	);
}

/* ----------------------------------------------------------- device history */

export async function getDeviceCommands(
	deviceId: string,
	limit = 20
): Promise<DeviceCommand[]> {
	const params = new URLSearchParams({ limit: String(limit) });
	const data = await get<{ commands: DeviceCommand[] }>(
		`/v1/admin/devices/${encodeURIComponent(deviceId)}/commands?${params.toString()}`
	);
	return data.commands ?? [];
}

/* --------------------------------------------------------------- outbound */

export async function sendSms(input: {
	device_id: string;
	to: string;
	body: string;
}): Promise<{ command_id: string }> {
	return get<{ command_id: string }>('/v1/sms/send', {
		method: 'POST',
		body: JSON.stringify(input)
	});
}

/**
 * Current state of one command. An unknown id is a successful read with
 * `command: null` — only a missing `device_id` is a 404 — so the UI must not
 * treat `null` as a transport failure.
 */
export async function getCommand(
	deviceId: string,
	commandId: string
): Promise<CommandInfo | null> {
	const params = new URLSearchParams({ device_id: deviceId });
	const data = await get<{ command: CommandInfo | null }>(
		`/v1/sms/commands/${encodeURIComponent(commandId)}?${params.toString()}`
	);
	return data.command ?? null;
}

export async function purgeMessages(
	deviceId: string
): Promise<{ ok: boolean; deleted: number; flow_runs_deleted: number }> {
	const params = new URLSearchParams({ device_id: deviceId });
	return get(`/v1/messages?${params.toString()}`, { method: 'DELETE' });
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

/**
 * `POST /v1/admin/devices/:id/archive` — takes the device out of the fleet list.
 *
 * Nothing is destroyed: the key, the message history and the queue stay, and the
 * gateway unarchives the row by itself the next time the phone polls.
 */
export async function archiveDevice(deviceId: string): Promise<{ ok: boolean }> {
	return get(`/v1/admin/devices/${encodeURIComponent(deviceId)}/archive`, {
		method: 'POST'
	});
}

/** `POST /v1/admin/devices/:id/unarchive` — puts the device back in the fleet list. */
export async function unarchiveDevice(deviceId: string): Promise<{ ok: boolean }> {
	return get(`/v1/admin/devices/${encodeURIComponent(deviceId)}/unarchive`, {
		method: 'POST'
	});
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

/** Dry-run the saved rules against one sample message. Nothing is sent or written. */
export async function testRules(input: {
	device_id?: string;
	peer: string;
	body: string;
}): Promise<RuleTestResult> {
	return get<RuleTestResult>('/v1/admin/rules/test', {
		method: 'POST',
		body: JSON.stringify(input)
	});
}
