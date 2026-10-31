/** Shapes returned by the Worker admin API. Field names mirror worker/src/routes/. */

export interface HealthCounts {
	devices: number;
	messages: number;
	rules: number;
	pairing_codes: number;
	open_alerts: number;
}

/** Which gate answers the admin routes. `AUTH_MODE` in the Worker. */
export type AuthMode = 'legacy' | 'new';

/**
 * Which side runs the password KDF — `AUTH_PASSWORD_MODE` in the Worker.
 *
 * `off` is the default and means the factor does not exist on this deployment.
 * The mode is the deployment's capability; it is NOT a row's provenance, which
 * every stored row carries as `m=c|s`.
 */
export type PasswordMode = 'off' | 'client-derived' | 'server-kdf';

export interface Health {
	ok: boolean;
	version: string;
	schema_ready: boolean;
	migrations: string[];
	bindings: Record<string, boolean>;
	missing_bindings: string[];
	retention_days?: number;
	counts: HealthCounts | null;
	open_alerts: number;
	last_message_at: number | null;
	db_error?: string | null;
	checked_at?: number;
	auth_mode?: AuthMode;
	auth_configured?: boolean;
	/** `off` when the field is absent: a Worker without phase 4 has no password factor. */
	password_mode?: PasswordMode;
	/** Whether `AUTH_PEPPER` is set. Without it no password row can be written or read. */
	password_configured?: boolean;
}

export interface HealthResult {
	health: Health;
	/** 200 when healthy, 503 when degraded — the body is diagnostic either way. */
	httpStatus: number;
}

export interface Device {
	device_id: string;
	fcm_token: string | null;
	/** Set once, when the device enrolled or its key was rotated. */
	paired_at: number;
	/**
	 * Authenticated contact time (§11.12), not pairing time. Null while no
	 * contact has been recorded; the console reads that as `unknown`, never as
	 * "seen just now".
	 */
	last_seen: number | null;
	/** Optional; supplied by the phone at pairing when known. */
	label?: string | null;
	/** Optional; 0–2 or null when the phone did not report a slot. */
	sim_slot?: number | null;
	/**
	 * Set when the operator archived the device; `null` (or absent) while it is
	 * in the fleet. An archived row keeps its key and its message history, and
	 * the gateway clears this again by itself the next time the phone polls.
	 */
	archived_at?: number | null;
}

export interface DeviceStatus {
	ws_connected: boolean;
	queue_depth: number;
}

/* ---------------------------------------------------------------- commands */

export type CommandState =
	| 'PENDING'
	| 'LEASED'
	| 'DISPATCHED'
	| 'SENT'
	| 'DELIVERED'
	| 'FAILED'
	| 'EXPIRED';

/** `GET /v1/sms/commands/:command_id` → `{ command }`. Unknown ids return `null`. */
export interface CommandInfo {
	command_id: string;
	to: string;
	body: string;
	priority: string;
	state: CommandState | string;
	created_at: number;
	expires_at: number;
}

/**
 * What happened to a reply, from the phone's outbound mirror.
 *
 * Only four things are reported: the phone's queue, the radio's verdict, the
 * carrier's receipt, and failure. `PENDING`/`DISPATCHED` from the command state
 * both arrive here as `queued`; this console does not guess between them.
 */
export type ReplyState = 'queued' | 'sent' | 'failed' | 'delivered';

export interface Message {
	id: string;
	device_id: string;
	local_id: string;
	direction: 'in' | 'out' | string;
	peer: string;
	body: string;
	received_at: number;
	auto_reply: number;
	/** `'rule'` when the gateway rule engine answered this inbound message. */
	reply_source?: 'rule' | string | null;
	/** The rule id that answered, when `reply_source` is `'rule'`. */
	reply_ref?: string | null;
	/** The ordinary outbound command created for the rule reply. Equal to the reply row's `id`. */
	reply_command_id?: string | null;
	/**
	 * On an outbound row, the fate of that send. An inbound row carries `null`:
	 * it has no send state, and the console reads its reply's fate from the
	 * outbound row whose id is `reply_command_id`. `null` also covers older
	 * rows written before the phone reported state.
	 */
	reply_state?: ReplyState | string | null;
	/** The phone's own failure reason, when `reply_state` is `'failed'`. */
	reply_error?: string | null;
}

export interface MessagesResult {
	messages: Message[];
	limit: number;
}

/* ------------------------------------------------------------------ alerts */

export interface Alert {
	id: string;
	device_id: string;
	label: string | null;
	kind: 'device_offline' | string;
	raised_at: number;
	acknowledged_at: number | null;
	detail: string | null;
}

export interface DeviceCommand {
	command_id: string;
	to_e164: string;
	body: string;
	priority: string;
	state: CommandState | string;
	created_at: number;
	expires_at: number;
}

export type MatcherType = 'exact' | 'prefix' | 'suffix' | 'glob' | 'regex';
export type BodyType = 'keyword' | 'regex';

export interface Rule {
	id: string;
	device_id: string | null;
	name: string;
	enabled: number;
	priority: number;
	matcher_type: MatcherType | string;
	matcher_value: string;
	body_type: BodyType | string;
	body_value: string;
	reply_template: string;
	cooldown_s: number;
	max_per_hour: number;
	sim_slot: number;
	allow_shortcode: number;
	updated_at: number;
}

export interface RuleInput {
	name: string;
	device_id: string | null;
	enabled: boolean;
	priority: number;
	matcher_type: MatcherType;
	matcher_value: string;
	body_type: BodyType;
	body_value: string;
	reply_template: string;
	cooldown_s: number;
	max_per_hour: number;
	sim_slot: number;
	allow_shortcode: boolean;
}

export type RuleTestReason =
	| 'disabled'
	| 'device_mismatch'
	| 'sender_mismatch'
	| 'body_mismatch'
	| 'shortcode_blocked'
	| 'cooldown'
	| 'hourly_cap'
	| 'matched';

export interface RuleTestMatch {
	rule_id: string;
	name: string;
	matched: boolean;
	reason: RuleTestReason | string;
	/** Present when the Worker supplies it; the console can also derive it. */
	matched_text?: string;
}

export interface RuleTestResult {
	matches: RuleTestMatch[];
}

/* --------------------------------------------------------------- workflows */

export type WorkflowNodeType = 'trigger' | 'extract' | 'condition' | 'send_sms' | 'stop';

export interface WorkflowPosition {
	x: number;
	y: number;
}

export interface WorkflowNode {
	id: string;
	type: WorkflowNodeType;
	position: WorkflowPosition;
	data: Record<string, unknown>;
}

export interface WorkflowEdge {
	id: string;
	source: string;
	target: string;
	sourceHandle?: 'true' | 'false';
	label?: string;
}

export interface WorkflowGraph {
	nodes: WorkflowNode[];
	edges: WorkflowEdge[];
}

export interface WorkflowSummary {
	id: string;
	name: string;
	enabled: boolean;
	device_id: string | null;
	updated_at: number;
	node_count: number;
}

export interface Workflow {
	id: string;
	name: string;
	enabled: boolean;
	device_id: string | null;
	graph: WorkflowGraph;
	version: number;
	created_at: number;
	updated_at: number;
}

export interface WorkflowIssue {
	path: string;
	message: string;
}

export interface WorkflowSaveInput {
	name: string;
	enabled?: boolean;
	device_id?: string | null;
	graph: WorkflowGraph;
}

/** Node `data` shapes, mirroring the Worker's workflow contract. */
export type SenderMode = 'any' | 'exact' | 'prefix' | 'regex';
export type BodyMode = 'any' | 'keyword' | 'regex';
export type ConditionOp = 'equals' | 'not_equals' | 'contains' | 'matches' | 'exists';

export interface ModeSpec<Mode extends string = string> {
	mode: Mode;
	value?: string;
}

export interface TriggerData {
	kind: 'incoming';
	sender?: ModeSpec<SenderMode>;
	body?: ModeSpec<BodyMode>;
}

export interface ExtractData {
	source: 'body' | 'sender';
	pattern: string;
	flags?: '' | 'i';
}

export interface ConditionData {
	left: string;
	op: ConditionOp;
	right?: string;
}

export interface SendSmsData {
	to: string;
	body: string;
}

export interface StopData {
	reason?: string;
}

export interface PairingCode {
	pairing_code: string;
	expires_at: number;
	device_id: string | null;
	purpose: 'enroll' | 'rotate';
}

export interface SessionInfo {
	ok: boolean;
	expires_at: number;
}

/* ---------------------------------------------------------------- accounts */

export type Role = 'owner' | 'admin' | 'member';

/** `GET /v1/auth/me` — who the Better Auth session is (AUTH_MODE=new). */
export interface AuthUser {
	id: string;
	email: string;
	name: string;
	role: Role;
	twoFactorEnabled: boolean;
}

export interface MeInfo {
	ok: boolean;
	user: AuthUser;
	expires_at: number;
	/** The mode the Worker is in right now; the console trusts this over health. */
	auth_mode: AuthMode;
}

/** `POST /v1/auth/redeem` — a single-use invite became an account and a session. */
export interface RedeemInfo {
	ok: boolean;
	user: { id: string; email: string; name: string; role: Role };
	expires_at: number;
}

/**
 * `GET /v1/admin/invites` — every invite row, newest first. `role` is typed as
 * a plain string because the column is one: a row written by an older build (or
 * by hand) is shown exactly as stored rather than snapped to a known value.
 */
export interface Invite {
	id: string;
	email: string;
	role: string;
	expires_at: number;
	used_at: number | null;
	created_by: string | null;
	created_at: number;
}

export interface InviteList {
	invites: Invite[];
	/** The gateway's clock at the moment it answered, for the state column. */
	now: number;
}

/**
 * `POST /v1/admin/invites` — the only response that ever carries `token`. The
 * gateway keeps its hash and nothing else, so the console must not hold it
 * past the panel that shows it.
 */
export interface MintedInvite {
	id: string;
	email: string;
	role: string;
	expires_at: number;
	token: string;
}

export type InviteRole = 'owner' | 'admin' | 'member';

/** A `/api/auth/passkey/*` answer before it is decoded. */
export interface PasskeySummary {
	id: string;
	name: string | null;
	createdAt: string;
}

/* ------------------------------------------------------------------- audit */

/** One `audit_log` row, exactly as stored. `detail` is the parsed `detail_json`. */
export interface AuditEvent {
	id: string;
	at: number;
	actor_user: string | null;
	actor_label: string | null;
	action: string;
	subject: string | null;
	ip: string | null;
	user_agent: string | null;
	detail: unknown;
}

export interface AuditResult {
	events: AuditEvent[];
	limit: number;
}
