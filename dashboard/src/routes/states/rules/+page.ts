import {
	SAMPLE_DEVICES,
	hold,
	installStateStub,
	json,
	type WorkbenchScenario
} from './stub';

export type RulesStateKey =
	| 'loading'
	| 'empty'
	| 'populated-active-and-paused'
	| 'long-reply-clamped'
	| 'member-session'
	| 'editor-new'
	| 'editor-edit'
	| 'test-panel-matched'
	| 'test-panel-blocked'
	| 'load-error';

const RULES_KEYS: ReadonlyArray<RulesStateKey> = [
	'loading',
	'empty',
	'populated-active-and-paused',
	'long-reply-clamped',
	'member-session',
	'editor-new',
	'editor-edit',
	'test-panel-matched',
	'test-panel-blocked',
	'load-error'
];

function isRulesState(raw: string | null): raw is RulesStateKey {
	return raw !== null && (RULES_KEYS as readonly string[]).includes(raw);
}

const NOW = Date.now();

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
		reply_template: 'You are unsubscribed from DakFlare alerts for {{sender}}.',
		cooldown_s: 60,
		max_per_hour: 10,
		sim_slot: 0,
		allow_shortcode: 0,
		updated_at: NOW - 2 * 86_400_000
	},
	{
		id: 'rule_weekend_paused',
		device_id: 'dev_px6a_desk_01',
		name: 'After-hours auto-acknowledgement',
		enabled: 0,
		priority: 25,
		matcher_type: 'regex',
		matcher_value: '^\\+[1-9][0-9]{7,14}$',
		body_type: 'contains',
		body_value: 'help',
		reply_template: 'Thanks for reaching out — our desk opens at 09:00 BST.',
		cooldown_s: 300,
		max_per_hour: 5,
		sim_slot: 1,
		allow_shortcode: 0,
		updated_at: NOW - 6 * 3_600_000
	}
];

const LONG_REPLY_RULE = [
	{
		...SAMPLE_RULES[0],
		id: 'rule_long_disclosure',
		name: 'Detailed order status FAQ',
		reply_template:
			'Your DakFlare shipment is queued with our regional courier in Dhaka. Deliveries normally complete between 10:00 and 19:00 BST; reply TRACK followed by your invoice reference if you need live dispatch support from the operations desk.'
	}
];

function scenarioFor(state: RulesStateKey): WorkbenchScenario {
	return {
		role: state === 'member-session' ? 'member' : 'owner',
		handle: (method, path) => {
			if (path.endsWith('/v1/devices')) {
				return json({ devices: SAMPLE_DEVICES });
			}
			if (path.endsWith('/v1/admin/rules')) {
				if (state === 'loading') return hold();
				if (state === 'load-error') {
					return json({ error: 'internal_error', message: 'Failed to load rules table.' }, 500);
				}
				if (state === 'empty') return json({ rules: [] });
				if (state === 'long-reply-clamped') return json({ rules: LONG_REPLY_RULE });
				return json({ rules: SAMPLE_RULES });
			}
			if (method === 'POST' && path.endsWith('/v1/admin/rules/test')) {
				if (state === 'test-panel-matched') {
					return json({
						matches: [
							{
								rule_id: 'rule_stop_optout',
								name: 'Stop opt-out reply',
								matched: true,
								reason: 'matched',
								matched_text: 'STOP'
							},
							{
								rule_id: 'rule_weekend_paused',
								name: 'After-hours auto-acknowledgement',
								matched: false,
								reason: 'disabled',
								matched_text: null
							}
						]
					});
				}
				return json({
					matches: [
						{
							rule_id: 'rule_stop_optout',
							name: 'Stop opt-out reply',
							matched: false,
							reason: 'shortcode_blocked',
							matched_text: null
						},
						{
							rule_id: 'rule_weekend_paused',
							name: 'After-hours auto-acknowledgement',
							matched: false,
							reason: 'disabled',
							matched_text: null
						}
					]
				});
			}
			if ((method === 'POST' || method === 'PUT') && path.includes('/rules')) {
				return json({ ok: true, id: 'rule_stop_optout' });
			}
			return null;
		}
	};
}

export const ssr = false;
export const prerender = true;

export function load({ url }: { url: URL }): { state: RulesStateKey } {
	const asked = url.searchParams.get('__state');
	const state: RulesStateKey = isRulesState(asked) ? asked : 'populated-active-and-paused';
	installStateStub(scenarioFor(state));
	return { state };
}
