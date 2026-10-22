/** Shapes returned by the Worker admin API. Field names mirror worker/src/routes/. */

export interface HealthCounts {
	devices: number;
	messages: number;
	rules: number;
	pairing_codes: number;
	open_alerts: number;
}

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
}

export interface DeviceStatus {
	ws_connected: boolean;
	queue_depth: number;
}

/* ---------------------------------------------------------------- commands */

export type CommandState =
	| 'PENDING'
	| 'DISPATCHED'
	| 'ACKED_BY_DEVICE'
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
	/** The ordinary outbound command created for the rule reply. */
	reply_command_id?: string | null;
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
