import type { AuditEvent, CommandInfo, Device, DeviceCommand, Message, TraceResult } from '$lib/types';
import type { StateGroup } from './StateSwitcher.svelte';

export type DeviceDetailStateKey =
	| 'loading'
	| 'presence-live'
	| 'presence-synced'
	| 'presence-stale'
	| 'presence-offline'
	| 'presence-unknown'
	| 'device-null-fallback'
	| 'archived'
	| 'unarchive-error'
	| 'revoked'
	| 'revoked-empty'
	| 'outbound-loading'
	| 'outbound-empty'
	| 'outbound-all-states'
	| 'outbound-expanded'
	| 'outbound-tracker-live'
	| 'outbound-tracker-failed-trace'
	| 'status-and-commands-error'
	| 'messages-error'
	| 'messages-reply-fates'
	| 'messages-follow-in-slice'
	| 'messages-expanded'
	| 'send-open'
	| 'send-ucs2-bangla'
	| 'send-queued'
	| 'send-error'
	| 'archive-dialog'
	| 'archive-error'
	| 'revoke-dialog'
	| 'revoke-pending'
	| 'revoke-error'
	| 'purge-dialog'
	| 'purge-error'
	| 'purged-notice'
	| 'member-session';

export const DEVICE_DETAIL_GROUPS: ReadonlyArray<StateGroup> = [
	{
		heading: 'Presence & Lifecycle',
		states: [
			{ key: 'loading', label: 'Loading status & messages' },
			{ key: 'presence-live', label: 'Live (WS + copied flows)' },
			{ key: 'presence-synced', label: 'Synced (poll-only, SIM 2)' },
			{ key: 'presence-stale', label: 'Stale (unlabeled, SIM 0)' },
			{ key: 'presence-offline', label: 'Offline (unresolved copy id)' },
			{ key: 'presence-unknown', label: 'Unknown (never contacted)' },
			{ key: 'device-null-fallback', label: 'Unknown device prop (null)' },
			{ key: 'archived', label: 'Archived device' },
			{ key: 'unarchive-error', label: 'Unarchive failed' },
			{ key: 'revoked', label: 'Revoked tombstone (history)' },
			{ key: 'revoked-empty', label: 'Revoked tombstone (empty)' }
		]
	},
	{
		heading: 'Outbound & Messages',
		states: [
			{ key: 'outbound-loading', label: 'Loading outbound queue' },
			{ key: 'outbound-empty', label: 'Empty outbound & messages' },
			{ key: 'outbound-all-states', label: 'All outbound states' },
			{ key: 'outbound-expanded', label: 'Long command expanded' },
			{ key: 'outbound-tracker-live', label: 'Inline tracker (active)' },
			{ key: 'outbound-tracker-failed-trace', label: 'Inline tracker + Trace' },
			{ key: 'status-and-commands-error', label: 'Status & outbound errors' },
			{ key: 'messages-error', label: 'Messages load failed' },
			{ key: 'messages-reply-fates', label: 'Reply fates & sources' },
			{ key: 'messages-follow-in-slice', label: 'Follow failed reply' },
			{ key: 'messages-expanded', label: 'Long message expanded' }
		]
	},
	{
		heading: 'Send SMS',
		states: [
			{ key: 'send-open', label: 'Send SMS panel open' },
			{ key: 'send-ucs2-bangla', label: 'UCS-2 Bangla counter' },
			{ key: 'send-queued', label: 'Send queued + tracker' },
			{ key: 'send-error', label: 'Send SMS refused (429)' }
		]
	},
	{
		heading: 'Confirm Dialogs',
		states: [
			{ key: 'archive-dialog', label: 'Archive confirm dialog' },
			{ key: 'archive-error', label: 'Archive failed' },
			{ key: 'revoke-dialog', label: 'Revoke confirm dialog' },
			{ key: 'revoke-pending', label: 'Revoke in flight' },
			{ key: 'revoke-error', label: 'Revoke failed' },
			{ key: 'purge-dialog', label: 'Purge log confirm dialog' },
			{ key: 'purge-error', label: 'Purge log failed' },
			{ key: 'purged-notice', label: 'Log purged notice' }
		]
	},
	{
		heading: 'Session',
		states: [{ key: 'member-session', label: 'Member session (read-only)' }]
	}
];

export const DEFAULT_DEVICE_DETAIL_STATE: DeviceDetailStateKey = 'presence-live';

const VALID_KEYS = new Set<string>(
	DEVICE_DETAIL_GROUPS.flatMap((group) => group.states.map((item) => item.key))
);

export function isDeviceDetailState(value: string | null): value is DeviceDetailStateKey {
	return value !== null && VALID_KEYS.has(value);
}

const NOW = Date.now();

export const DEVICE_LABELS: Record<string, string> = {
	dev_px6a_desk_01: 'Pixel 6a · Desk',
	dev_mia3_prev_05: 'Xiaomi Mi A3 · Dhaka',
	dev_ga54_field_02: 'Galaxy A54 · Field'
};

export const LIVE_DEVICE: Device = {
	device_id: 'dev_px6a_desk_01',
	label: 'Pixel 6a · Desk',
	fcm_token: 'fcm_live_px6a_token',
	paired_at: NOW - 14 * 86_400_000,
	last_seen: NOW - 18_000,
	sim_slot: 1,
	archived_at: null,
	revoked_at: null
};

export const SYNCED_DEVICE: Device = {
	device_id: 'dev_ga54_field_02',
	label: 'Galaxy A54 · Field',
	fcm_token: null,
	paired_at: NOW - 9 * 86_400_000,
	last_seen: NOW - 4 * 60_000,
	sim_slot: 2,
	archived_at: null,
	revoked_at: null
};

export const STALE_DEVICE: Device = {
	device_id: 'dev_unlabeled_03',
	label: null,
	fcm_token: null,
	paired_at: NOW - 20 * 86_400_000,
	last_seen: NOW - 3 * 3_600_000,
	sim_slot: 0,
	archived_at: null,
	revoked_at: null
};

export const OFFLINE_DEVICE: Device = {
	device_id: 'dev_warehouse_04',
	label: 'Moto G54 · Uttara Hub',
	fcm_token: 'fcm_moto_04',
	paired_at: NOW - 30 * 86_400_000,
	last_seen: NOW - 3 * 86_400_000,
	sim_slot: 1,
	archived_at: null,
	revoked_at: null
};

export const UNKNOWN_DEVICE: Device = {
	device_id: 'dev_fresh_pair_06',
	label: 'Nokia G21 · Bench',
	fcm_token: null,
	paired_at: NOW - 10 * 60_000,
	last_seen: null,
	sim_slot: null,
	archived_at: null,
	revoked_at: null
};

export const ARCHIVED_DEVICE: Device = {
	device_id: 'dev_spare_drawer_07',
	label: 'Pixel 5 · Drawer',
	fcm_token: null,
	paired_at: NOW - 45 * 86_400_000,
	last_seen: NOW - 2 * 86_400_000,
	sim_slot: 1,
	archived_at: NOW - 2 * 86_400_000,
	revoked_at: null
};

export const REVOKED_DEVICE: Device = {
	device_id: 'dev_lost_handset_08',
	label: 'Redmi Note 11 · Retired',
	fcm_token: null,
	paired_at: NOW - 60 * 86_400_000,
	last_seen: NOW - 6 * 86_400_000,
	sim_slot: 1,
	archived_at: null,
	revoked_at: NOW - 5 * 86_400_000
};

export const REVOKED_EMPTY_DEVICE: Device = {
	device_id: 'dev_never_used_09',
	label: null,
	fcm_token: null,
	paired_at: NOW - 10 * 86_400_000,
	last_seen: null,
	sim_slot: null,
	archived_at: null,
	revoked_at: NOW - 5 * 86_400_000
};

export const COPIED_AUDIT_KNOWN: AuditEvent[] = [
	{
		id: 'aud_copy_01',
		at: NOW - 14 * 86_400_000,
		actor_user: 'usr_jony_01',
		actor_label: 'jony@example.com',
		action: 'workflows.copied',
		subject: 'dev_px6a_desk_01',
		ip: '103.84.210.42',
		user_agent: null,
		detail: {
			count: 3,
			from: 'dev_mia3_prev_05'
		}
	}
];

export const COPIED_AUDIT_UNKNOWN_SOURCE: AuditEvent[] = [
	{
		id: 'aud_copy_02',
		at: NOW - 30 * 86_400_000,
		actor_user: 'usr_jony_01',
		actor_label: 'jony@example.com',
		action: 'workflows.copied',
		subject: 'dev_warehouse_04',
		ip: '103.84.210.42',
		user_agent: null,
		detail: {
			count: 1,
			from: 'dev_retired_old_00'
		}
	}
];

export const SAMPLE_COMMANDS: DeviceCommand[] = [
	{
		command_id: 'cmd_dispatched_01',
		to_e164: '+8801712345678',
		body: 'Confirmed: Tk 800.00 received from Dhaka Mart order #DM-4092. Courier pickup scheduled for 16:00.',
		priority: 'high',
		state: 'DISPATCHED',
		sim_slot: 1,
		created_at: NOW - 45_000,
		expires_at: NOW + 5 * 60_000
	},
	{
		command_id: 'cmd_sent_02',
		to_e164: '+8801819223344',
		body: 'Your OTP is 491022. Do not share this code with anyone.',
		priority: 'high',
		state: 'SENT',
		sim_slot: 1,
		created_at: NOW - 2 * 60_000,
		expires_at: NOW + 4 * 60_000
	},
	{
		command_id: 'cmd_delivered_03',
		to_e164: '+8801911556677',
		body: 'Invoice INV-2026-881 settled. Thank you!',
		priority: 'normal',
		state: 'DELIVERED',
		sim_slot: 1,
		created_at: NOW - 9 * 60_000,
		expires_at: NOW + 60_000
	},
	{
		command_id: 'cmd_failed_04',
		to_e164: '+8801540196080',
		body: 'Urgent delivery update: rider arrived at Mirpur DOHS gate #3 and is waiting for confirmation.',
		priority: 'normal',
		state: 'FAILED',
		sim_slot: 1,
		error_code: 'no_service',
		error_message: 'RESULT_ERROR_NO_SERVICE',
		created_at: NOW - 18 * 60_000,
		expires_at: NOW - 13 * 60_000
	},
	{
		command_id: 'cmd_pending_05',
		to_e164: '+8801610998877',
		body: 'Reminder: warehouse inventory audit starts in 30 minutes.',
		priority: 'normal',
		state: 'PENDING',
		created_at: NOW - 25 * 60_000,
		expires_at: NOW + 10 * 60_000
	},
	{
		command_id: 'cmd_leased_06',
		to_e164: '+8801311445566',
		body: 'Shipment #DF-772 cleared customs.',
		priority: 'normal',
		state: 'LEASED',
		created_at: NOW - 35 * 60_000,
		expires_at: NOW + 5 * 60_000
	},
	{
		command_id: 'cmd_expired_07',
		to_e164: '+8801400112233',
		body: 'Flash alert: store closes in 15 minutes.',
		priority: 'low',
		state: 'EXPIRED',
		error_code: 'ttl_elapsed',
		created_at: NOW - 2 * 3_600_000,
		expires_at: NOW - 110 * 60_000
	}
];

/** Only `outbound-expanded` serves this: long enough that the one line clamps. */
export const LONG_COMMAND: DeviceCommand = {
	command_id: 'cmd_long_09',
	to_e164: '+8801766001122',
	body: 'Delivery instruction for order #DM-4092: rider Tariq (+8801700112233) will reach the Mirpur DOHS gate between 16:00 and 16:30. Ask reception to call the number above before signing, check that the parcel seal is intact, and refuse the delivery if the outer box is damaged. Send the six digit code on the slip back to this number once the handover is complete.',
	priority: 'high',
	state: 'PENDING',
	sim_slot: 1,
	created_at: NOW - 6 * 60_000,
	expires_at: NOW + 54 * 60_000
};

export const SAMPLE_COMMANDS_WITH_LONG: DeviceCommand[] = [LONG_COMMAND, ...SAMPLE_COMMANDS];

export const SAMPLE_MESSAGES: Message[] = [
	{
		id: 'msg_in_bkash_01',
		device_id: 'dev_px6a_desk_01',
		local_id: 'loc_101',
		direction: 'in',
		peer: 'bKash',
		body: 'You have received Tk 800.00 from 01712345678. Ref DM4092. Fee Tk 0.00. Balance Tk 14,250.00. TrxID 8G56H7J8K9 at 18/11/2026 07:40.',
		received_at: NOW - 3 * 60_000,
		auto_reply: 1,
		reply_source: 'flow',
		reply_ref: 'wf_bkash_order_01',
		reply_command_id: 'cmd_reply_delivered_01'
	},
	{
		id: 'cmd_reply_delivered_01',
		device_id: 'dev_px6a_desk_01',
		local_id: 'loc_102',
		direction: 'out',
		peer: '+8801712345678',
		body: 'Confirmed: Tk 800.00 received (TrxID 8G56H7J8K9). Thank you for shopping with Dhaka Mart!',
		received_at: NOW - 2 * 60_000,
		auto_reply: 1,
		reply_state: 'delivered',
		reply_error: null
	},
	{
		id: 'msg_in_rule_failed_02',
		device_id: 'dev_px6a_desk_01',
		local_id: 'loc_103',
		direction: 'in',
		peer: '+8801540196080',
		body: 'STATUS ORDER 4092? Need driver phone number as soon as possible please, the parcel was marked out for delivery three hours ago.',
		received_at: NOW - 12 * 60_000,
		auto_reply: 1,
		reply_source: 'rule',
		reply_ref: 'rule_order_status_01',
		reply_command_id: 'cmd_reply_failed_02'
	},
	{
		id: 'cmd_reply_sent_03',
		device_id: 'dev_px6a_desk_01',
		local_id: 'loc_104',
		direction: 'out',
		peer: '+8801819223344',
		body: 'Handed to carrier — awaiting delivery receipt.',
		received_at: NOW - 16 * 60_000,
		auto_reply: 0,
		reply_state: 'sent',
		reply_error: null
	},
	{
		id: 'cmd_reply_queued_04',
		device_id: 'dev_px6a_desk_01',
		local_id: 'loc_105',
		direction: 'out',
		peer: '+8801911556677',
		body: 'Queued for SIM 1 transmission.',
		received_at: NOW - 21 * 60_000,
		auto_reply: 0,
		reply_state: 'queued',
		reply_error: null
	},
	{
		id: 'msg_in_unmatched_03',
		device_id: 'dev_px6a_desk_01',
		local_id: 'loc_106',
		direction: 'in',
		peer: '+8801755001122',
		body: 'Can I change my delivery window to tomorrow morning between 10:00 and 12:30? I will be out of the office in Banani during the afternoon slot and cannot receive the courier.',
		received_at: NOW - 35 * 60_000,
		auto_reply: 0,
		reply_source: null,
		reply_ref: null,
		reply_command_id: null
	},
	{
		id: 'cmd_reply_failed_02',
		device_id: 'dev_px6a_desk_01',
		local_id: 'loc_107',
		direction: 'out',
		peer: '+8801540196080',
		body: 'Order #4092 is out for delivery with rider Tariq (+8801700112233).',
		received_at: NOW - 11 * 60_000,
		auto_reply: 1,
		reply_state: 'failed',
		reply_error: 'no_service'
	}
];

/** Only `messages-expanded` serves this: long enough that the three lines clamp. */
export const LONG_MESSAGE: Message = {
	id: 'msg_in_long_04',
	device_id: 'dev_px6a_desk_01',
	local_id: 'loc_108',
	direction: 'in',
	peer: '+8801755001122',
	body: 'I need to change the delivery for order #DM-4092. Nobody will be at the Banani office after 15:00 today, and the guard cannot accept parcels on our behalf. Could the rider come tomorrow morning between 10:00 and 12:30 instead, or leave it at the collection point on Kemal Ataturk Avenue? If neither works, please hold it at the depot and confirm by SMS so I can send someone with photo ID.',
	received_at: NOW - 95_000,
	auto_reply: 0,
	reply_source: null,
	reply_ref: null,
	reply_command_id: null
};

export const SAMPLE_MESSAGES_WITH_LONG: Message[] = [LONG_MESSAGE, ...SAMPLE_MESSAGES];

export function commandInfoFor(commandId: string): CommandInfo {
	if (commandId === 'cmd_failed_04') {
		return {
			command_id: 'cmd_failed_04',
			to: '+8801540196080',
			body: 'Urgent delivery update: rider arrived at Mirpur DOHS gate #3 and is waiting for confirmation.',
			priority: 'normal',
			state: 'FAILED',
			created_at: NOW - 18 * 60_000,
			expires_at: NOW - 13 * 60_000,
			channel: 'sms',
			error_code: 'no_service',
			error_message: 'RESULT_ERROR_NO_SERVICE'
		};
	}
	if (commandId === 'cmd_new_queued_01') {
		return {
			command_id: 'cmd_new_queued_01',
			to: '+8801712345678',
			body: 'Order A-1042 dispatched via Steadfast.',
			priority: 'normal',
			state: 'DISPATCHED',
			created_at: NOW - 3_000,
			expires_at: NOW + 5 * 60_000,
			channel: 'sms'
		};
	}
	return {
		command_id: commandId,
		to: '+8801712345678',
		body: 'Confirmed: Tk 800.00 received from Dhaka Mart order #DM-4092. Courier pickup scheduled for 16:00.',
		priority: 'high',
		state: 'DISPATCHED',
		created_at: NOW - 45_000,
		expires_at: NOW + 5 * 60_000,
		channel: 'sms'
	};
}

export const FAILED_TRACE: TraceResult = {
	id: 'cmd_failed_04',
	kind: 'command',
	device_id: 'dev_px6a_desk_01',
	verdict: 'failed',
	why: [
		'The phone pulled the command over WebSocket and attempted SIM 1 transmission.',
		'Android SmsManager returned RESULT_ERROR_NO_SERVICE; no carrier handoff occurred.'
	],
	message: { id: 'msg_in_rule_failed_02', peer: '+8801540196080', direction: 'in' },
	command: { command_id: 'cmd_failed_04', state: 'FAILED', error_code: 'no_service' },
	automation: {
		rules: [{ id: 'rule_order_status_01', name: 'Order status lookup', matched: true }],
		flows: []
	},
	approval: null,
	audit: [{ action: 'sms.failed', at: NOW - 17 * 60_000, actor_label: 'dev_px6a_desk_01' }],
	durable_object: { ws_connected: true, queue_depth: 1 },
	warnings: []
};
