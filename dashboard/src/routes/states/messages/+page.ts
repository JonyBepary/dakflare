import {
	REVOKED_DEVICE,
	SAMPLE_DEVICES,
	hold,
	installStateStub,
	json,
	offline,
	type WorkbenchScenario
} from './stub';

export type MessagesStateKey =
	| 'loading'
	| 'no-devices'
	| 'empty'
	| 'populated-mixed'
	| 'channels-conversations'
	| 'failed-rule-reply'
	| 'revoked-device'
	| 'member-session'
	| 'compose-open'
	| 'pagination-stalled'
	| 'load-error';

const MESSAGES_KEYS: ReadonlyArray<MessagesStateKey> = [
	'loading',
	'no-devices',
	'empty',
	'populated-mixed',
	'channels-conversations',
	'failed-rule-reply',
	'revoked-device',
	'member-session',
	'compose-open',
	'pagination-stalled',
	'load-error'
];

function isMessagesState(raw: string | null): raw is MessagesStateKey {
	return raw !== null && (MESSAGES_KEYS as readonly string[]).includes(raw);
}

const NOW = Date.now();
const DEV = SAMPLE_DEVICES[0].device_id;

const SAMPLE_RULES = [
	{
		id: 'rule_stop_optout',
		device_id: null,
		name: 'Stop opt-out reply',
		enabled: 1,
		priority: 10,
		matcher_type: 'prefix',
		matcher_value: '+880',
		body_type: 'keyword',
		body_value: 'STOP',
		reply_template: 'You are unsubscribed from DakFlare alerts.',
		cooldown_s: 60,
		max_per_hour: 10,
		sim_slot: 0,
		allow_shortcode: 0,
		updated_at: NOW - 3 * 86_400_000
	}
];

const MIXED_MESSAGES = [
	{
		id: 'msg_out_01',
		device_id: DEV,
		local_id: 'msg_out_01',
		direction: 'out',
		peer: '+8801711420819',
		body: 'Parcel #DF-4082 is out for delivery with rider Rafiq.',
		received_at: NOW - 45_000,
		auto_reply: 0,
		reply_state: 'delivered',
		reply_error: null
	},
	{
		id: 'msg_in_02',
		device_id: DEV,
		local_id: 'loc_in_02',
		direction: 'in',
		peer: '+8801711420819',
		body: 'STOP sending promo messages please',
		received_at: NOW - 3 * 60_000,
		auto_reply: 1,
		reply_source: 'rule',
		reply_ref: 'rule_stop_optout',
		reply_command_id: 'cmd_rule_ok_03'
	},
	{
		id: 'cmd_rule_ok_03',
		device_id: DEV,
		local_id: 'cmd_rule_ok_03',
		direction: 'out',
		peer: '+8801711420819',
		body: 'You are unsubscribed from DakFlare alerts.',
		received_at: NOW - 2 * 60_000 - 50_000,
		auto_reply: 0,
		reply_state: 'sent',
		reply_error: null
	},
	{
		id: 'msg_in_04',
		device_id: DEV,
		local_id: 'loc_in_04',
		direction: 'in',
		peer: '+8801819550312',
		body: 'আপনার অর্ডার #9012 ডেলিভারি নিশ্চিত করতে কনফার্ম লিখুন এবং আজ বিকালের মধ্যে উত্তর দিন। এটি একটি দীর্ঘ ইনবাউন্ড মেসেজ যা বিস্তারিত প্রদর্শনের জন্য ২০০ অক্ষরের বেশি রাখা হয়েছে যাতে এক্সপ্যান্ড বাটন দেখা যায়। ধন্যবাদ।',
		received_at: NOW - 19 * 60_000,
		auto_reply: 0
	}
];

/**
 * Two channels in one device log, with a Telegram thread bound to a conversation
 * and one legacy SMS row written before `channel` existed (no field at all).
 */
const CHANNEL_MESSAGES = [
	{
		id: 'msg_ch_tg_out_03',
		device_id: DEV,
		local_id: 'loc_tg_out_03',
		direction: 'out',
		peer: '@rafiq_delivery',
		body: 'Yes — rider Rafiq has it and will call when he reaches your gate.',
		received_at: NOW - 90_000,
		auto_reply: 0,
		reply_state: 'sent',
		reply_error: null,
		channel: 'telegram',
		conversation_id: 'conv_tg_rafiq'
	},
	{
		id: 'msg_ch_tg_in_02',
		device_id: DEV,
		local_id: 'loc_tg_in_02',
		direction: 'in',
		peer: '@rafiq_delivery',
		body: 'Is parcel DF-4082 still coming today?',
		received_at: NOW - 2 * 60_000,
		auto_reply: 1,
		reply_source: 'rule',
		reply_ref: 'rule_stop_optout',
		reply_command_id: 'msg_ch_tg_out_03',
		channel: 'telegram',
		conversation_id: 'conv_tg_rafiq'
	},
	{
		id: 'msg_ch_sms_out_01',
		device_id: DEV,
		local_id: 'msg_ch_sms_out_01',
		direction: 'out',
		peer: '+8801711420819',
		body: 'Parcel #DF-4082 is out for delivery with rider Rafiq.',
		received_at: NOW - 6 * 60_000,
		auto_reply: 0,
		reply_state: 'delivered',
		reply_error: null,
		channel: 'sms',
		conversation_id: null
	},
	{
		id: 'msg_ch_sms_in_04',
		device_id: DEV,
		local_id: 'loc_sms_in_04',
		direction: 'in',
		peer: '+8801819550312',
		body: 'Confirm delivery for order #9012 before this afternoon.',
		received_at: NOW - 12 * 60_000,
		auto_reply: 0
	}
];

const FAILED_REPLY_MESSAGES = [
	{
		id: 'msg_in_fail_01',
		device_id: DEV,
		local_id: 'loc_in_fail_01',
		direction: 'in',
		peer: '+8801911004455',
		body: 'STOP',
		received_at: NOW - 90_000,
		auto_reply: 1,
		reply_source: 'rule',
		reply_ref: 'rule_stop_optout',
		reply_command_id: 'cmd_rule_fail_02'
	},
	{
		id: 'cmd_rule_fail_02',
		device_id: DEV,
		local_id: 'cmd_rule_fail_02',
		direction: 'out',
		peer: '+8801911004455',
		body: 'You are unsubscribed from DakFlare alerts.',
		received_at: NOW - 88_000,
		auto_reply: 0,
		reply_state: 'failed',
		reply_error: 'RADIO_NO_SERVICE: SIM 1 is not registered on carrier'
	}
];

const STALLED_PAGE = Array.from({ length: 100 }, (_, i) => ({
	id: `msg_page_${i}`,
	device_id: DEV,
	local_id: `loc_page_${i}`,
	direction: i % 3 === 0 ? 'out' : 'in',
	peer: i % 2 === 0 ? '+8801711420819' : '+8801819550312',
	body: `Batch archived message #${i + 1} sharing millisecond cursor.`,
	received_at: NOW - 600_000,
	auto_reply: 0,
	reply_state: i % 3 === 0 ? 'delivered' : null,
	reply_error: null
}));

function scenarioFor(state: MessagesStateKey): WorkbenchScenario {
	return {
		role: state === 'member-session' ? 'member' : 'owner',
		handle: (method, path) => {
			if (path.endsWith('/v1/devices')) {
				if (state === 'loading') return hold();
				if (state === 'no-devices') return json({ devices: [] });
				if (state === 'revoked-device') return json({ devices: [REVOKED_DEVICE] });
				return json({ devices: SAMPLE_DEVICES });
			}
			if (path.endsWith('/v1/admin/rules')) {
				return json({ rules: SAMPLE_RULES });
			}
			if (path.endsWith('/v1/messages')) {
				if (state === 'loading') return hold();
				if (state === 'load-error') return offline();
				if (state === 'empty') return json({ messages: [], limit: 100 });
				if (state === 'failed-rule-reply') {
					return json({ messages: FAILED_REPLY_MESSAGES, limit: 100 });
				}
				if (state === 'channels-conversations') {
					return json({ messages: CHANNEL_MESSAGES, limit: 100 });
				}
				if (state === 'pagination-stalled') {
					return json({ messages: STALLED_PAGE, limit: 100 });
				}
				return json({ messages: MIXED_MESSAGES, limit: 100 });
			}
			if (path.includes('/v1/sms/commands/')) {
				const cmdId = path.split('/').pop() ?? '';
				if (cmdId === 'cmd_rule_fail_02') {
					return json({
						command: {
							command_id: cmdId,
							to: '+8801911004455',
							body: 'You are unsubscribed from DakFlare alerts.',
							priority: 'normal',
							state: 'FAILED',
							error_code: 'no_service',
							error_message: 'SIM 1 is not registered on carrier',
							created_at: NOW - 88_000,
							expires_at: NOW + 60_000
						}
					});
				}
				return json({
					command: {
						command_id: cmdId,
						to: '+8801711420819',
						body: 'Parcel #DF-4082 is out for delivery with rider Rafiq.',
						priority: 'normal',
						state: 'DELIVERED',
						created_at: NOW - 45_000,
						expires_at: NOW + 60_000
					}
				});
			}
			if (method === 'POST' && path.endsWith('/v1/sms/send')) {
				return json({ command_id: 'cmd_composed_01', queued: true });
			}
			return null;
		}
	};
}

export const ssr = false;
export const prerender = true;

export function load({ url }: { url: URL }): { state: MessagesStateKey } {
	const asked = url.searchParams.get('__state');
	const state: MessagesStateKey = isMessagesState(asked) ? asked : 'populated-mixed';
	installStateStub(scenarioFor(state));
	return { state };
}
