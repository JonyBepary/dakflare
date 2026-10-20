/** Shapes returned by the Worker admin API. Field names mirror worker/src/routes/. */

export interface HealthCounts {
	devices: number;
	messages: number;
	rules: number;
	pairing_codes: number;
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
	paired_at: number;
	last_seen: number;
}

export interface DeviceStatus {
	ws_connected: boolean;
	queue_depth: number;
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
}

export interface MessagesResult {
	messages: Message[];
	limit: number;
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
