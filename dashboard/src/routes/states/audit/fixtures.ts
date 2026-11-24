import type { AuditEvent } from '$lib/types';
import type { StateGroup } from './StateSwitcher.svelte';

export type AuditStateKey =
	| 'loading'
	| 'empty'
	| 'one-entry'
	| 'populated'
	| 'paginated'
	| 'loading-more'
	| 'pagination-stalled'
	| 'load-error'
	| 'detail-expanded'
	| 'filtered-results'
	| 'filtered-empty'
	| 'member-no-access';

export const AUDIT_GROUPS: ReadonlyArray<StateGroup> = [
	{
		heading: 'Data',
		states: [
			{ key: 'loading', label: 'Loading' },
			{ key: 'empty', label: 'Empty log' },
			{ key: 'one-entry', label: 'Single entry' },
			{ key: 'populated', label: 'Activity log' },
			{ key: 'paginated', label: 'Paginated (100 rows)' },
			{ key: 'loading-more', label: 'Loading older page' },
			{ key: 'pagination-stalled', label: 'Cursor tie (stalled)' },
			{ key: 'load-error', label: 'Load failed' }
		]
	},
	{
		heading: 'Inspection & Filters',
		states: [
			{ key: 'detail-expanded', label: 'Detail expanded' },
			{ key: 'filtered-results', label: 'Filtered results' },
			{ key: 'filtered-empty', label: 'No filter matches' }
		]
	},
	{
		heading: 'Access',
		states: [{ key: 'member-no-access', label: 'Member (no access)' }]
	}
];

export const DEFAULT_AUDIT_STATE: AuditStateKey = 'populated';

const VALID_KEYS = new Set<string>(
	AUDIT_GROUPS.flatMap((group) => group.states.map((item) => item.key))
);

export function isAuditState(value: string | null): value is AuditStateKey {
	return value !== null && VALID_KEYS.has(value);
}

const NOW = Date.now();

export const SINGLE_EVENT: AuditEvent = {
	id: 'aud_01JCXQ9M2K7',
	at: NOW - 4 * 60_000,
	actor_user: 'usr_jony_01',
	actor_label: 'jony@example.com',
	action: 'workflow.save',
	subject: 'wf_bkash_order_01',
	ip: '103.84.210.42',
	user_agent: 'Mozilla/5.0 (X11; Linux x86_64) DakFlareConsole/6.1',
	detail: {
		version: 4,
		node_count: 8,
		enabled: true,
		device_id: 'dev_px6a_desk_01'
	}
};

export const POPULATED_EVENTS: AuditEvent[] = [
	{
		id: 'aud_01JCXQ9M2K7',
		at: NOW - 3 * 60_000,
		actor_user: 'usr_jony_01',
		actor_label: 'jony@example.com',
		action: 'workflow.save',
		subject: 'wf_bkash_order_01',
		ip: '103.84.210.42',
		user_agent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/131.0',
		detail: {
			version: 4,
			node_count: 8,
			enabled: true,
			device_id: 'dev_px6a_desk_01'
		}
	},
	{
		id: 'aud_01JCXQ7G9R1',
		at: NOW - 11 * 60_000,
		actor_user: null,
		actor_label: null,
		action: 'sign_in.failure',
		subject: 'nadia.karim@example.com',
		ip: '198.51.100.77',
		user_agent: 'curl/8.10.1',
		detail: null
	},
	{
		id: 'aud_01JCXQ4B3V9',
		at: NOW - 24 * 60_000,
		actor_user: 'usr_nadia_03',
		actor_label: null,
		action: 'authority.grant',
		subject: 'grant_9981_sms',
		ip: '103.84.210.18',
		user_agent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) Safari/605.1',
		detail: {
			scope: 'sms.send',
			ttl_s: 1800,
			device_id: 'dev_px6a_desk_01',
			recipients: ['+8801712345678']
		}
	},
	{
		id: 'aud_01JCXQ0Z8T4',
		at: NOW - 48 * 60_000,
		actor_user: 'usr_jony_01',
		actor_label: 'jony@example.com',
		action: 'device.pair',
		subject: 'dev_ga54_field_02',
		ip: null,
		user_agent: null,
		detail: null
	},
	{
		id: 'aud_01JCXPX16H2',
		at: NOW - 2 * 3_600_000,
		actor_user: 'usr_nadia_03',
		actor_label: 'nadia@example.com',
		action: 'password.verify_failed',
		subject: 'usr_nadia_03',
		ip: '203.0.113.14',
		user_agent: 'Mozilla/5.0 (Linux; Android 14; Pixel 6a)',
		detail: {
			mode: 'client-derived',
			reason: 'digest_mismatch'
		}
	},
	{
		id: 'aud_01JCXPT52W8',
		at: NOW - 5 * 3_600_000,
		actor_user: 'usr_jony_01',
		actor_label: 'jony@example.com',
		action: 'agent_token.mint',
		subject: 'tok_ops_triage_07',
		ip: '103.84.210.42',
		user_agent: 'dakflare-cli/6.1.0',
		detail: {
			name: 'ops-triage-agent',
			scopes: ['messages.read', 'flows.propose']
		}
	},
	{
		id: 'aud_01JCXPN04D5',
		at: NOW - 9 * 3_600_000,
		actor_user: 'usr_jony_01',
		actor_label: 'jony@example.com',
		action: 'rule.create',
		subject: 'rule_otp_block_02',
		ip: '103.84.210.42',
		user_agent: null,
		detail: {
			matcher_type: 'prefix',
			matcher_value: 'bKash'
		}
	},
	{
		id: 'aud_01JCXPG89P0',
		at: NOW - 16 * 3_600_000,
		actor_user: 'usr_jony_01',
		actor_label: 'jony@example.com',
		action: 'totp.enroll',
		subject: null,
		ip: '103.84.210.42',
		user_agent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/131.0',
		detail: null
	},
	{
		id: 'aud_01JCXP9A1M6',
		at: NOW - 26 * 3_600_000,
		actor_user: 'usr_jony_01',
		actor_label: 'jony@example.com',
		action: 'invite.create',
		subject: 'rae.molina@example.com',
		ip: '103.84.210.42',
		user_agent: 'dakflare-cli/6.1.0',
		detail: {
			role: 'member',
			expires_in_s: 604800
		}
	},
	{
		id: 'aud_01JCXP2F7L3',
		at: NOW - 41 * 3_600_000,
		actor_user: 'usr_jony_01',
		actor_label: 'jony@example.com',
		action: 'device.revoke',
		subject: 'dev_lost_handset_04',
		ip: '103.84.210.42',
		user_agent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/131.0',
		detail: {
			reason: 'handset_retired',
			commands_dropped: 1
		}
	}
];

const ACTIONS = [
	'sign_in.success',
	'sms.send',
	'workflow.save',
	'authority.grant',
	'device.pair',
	'rule.create',
	'sign_in.failure',
	'agent_token.mint'
];

export function buildPaginatedEvents(count: number, identicalTimestamp = false): AuditEvent[] {
	const tiedAt = NOW - 15 * 60_000;
	const list: AuditEvent[] = [];
	for (let i = 0; i < count; i += 1) {
		const action = ACTIONS[i % ACTIONS.length];
		list.push({
			id: `aud_page_${String(i + 1).padStart(3, '0')}`,
			at: identicalTimestamp ? tiedAt : NOW - (i + 1) * 90_000,
			actor_user: action === 'sign_in.failure' ? null : i % 3 === 0 ? 'usr_nadia_03' : 'usr_jony_01',
			actor_label:
				action === 'sign_in.failure'
					? null
					: i % 3 === 0
						? 'nadia@example.com'
						: 'jony@example.com',
			action,
			subject: i % 2 === 0 ? `dev_px6a_desk_01` : `msg_01JC_${String(i + 10)}`,
			ip: i % 5 === 0 ? null : `103.84.210.${10 + (i % 40)}`,
			user_agent: i % 4 === 0 ? 'Mozilla/5.0 (X11; Linux x86_64) Chrome/131.0' : null,
			detail: i % 3 === 0 ? { seq: i + 1, channel: 'sms' } : null
		});
	}
	return list;
}
