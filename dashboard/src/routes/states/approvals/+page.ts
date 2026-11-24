import {
	SAMPLE_DEVICES,
	hold,
	installStateStub,
	json,
	type WorkbenchScenario
} from './stub';

export type ApprovalsStateKey =
	| 'loading'
	| 'empty'
	| 'pending-queue'
	| 'pending-capped-and-urgent'
	| 'grants-active'
	| 'grants-error'
	| 'history-decided'
	| 'not-allowed-member'
	| 'load-error';

const APPROVALS_KEYS: ReadonlyArray<ApprovalsStateKey> = [
	'loading',
	'empty',
	'pending-queue',
	'pending-capped-and-urgent',
	'grants-active',
	'grants-error',
	'history-decided',
	'not-allowed-member',
	'load-error'
];

function isApprovalsState(raw: string | null): raw is ApprovalsStateKey {
	return raw !== null && (APPROVALS_KEYS as readonly string[]).includes(raw);
}

const NOW = Date.now();
const DEFAULT_LADDER = [60, 300, 900, 3600, 14400, 86400];

const SAMPLE_APPROVALS = [
	{
		id: 'apr_01jd8za3m0',
		agent_token_id: 'tok_assistant_ops',
		scope: 'sms.send',
		target: {
			device_id: 'dev_px6a_desk_01',
			recipients: ['+8801711420819', '+8801819550312']
		},
		reason: 'Send dispatch confirmation to two delayed order recipients.',
		state: 'PENDING',
		requested_at: NOW - 95_000,
		expires_at: NOW + 12 * 60_000,
		ladder_s: DEFAULT_LADDER,
		max_s: 3600
	},
	{
		id: 'apr_01jd8zb1q9',
		agent_token_id: 'tok_assistant_ops',
		scope: 'workflow.write',
		target: { flow_id: 'wf_order_confirm' },
		reason: 'Update retry branch on Order confirmation workflow.',
		state: 'PENDING',
		requested_at: NOW - 4 * 60_000,
		expires_at: NOW + 20 * 60_000,
		ladder_s: DEFAULT_LADDER,
		max_s: 86400
	}
];

const URGENT_AND_UNGRANTABLE = [
	{
		id: 'apr_01jd8zc8r2',
		agent_token_id: 'tok_triage_cli',
		scope: 'sms.send',
		target: { device_id: 'dev_px6a_desk_01', recipients: ['+8801711420819'] },
		reason: 'Manual customer follow-up for failed webhook delivery.',
		state: 'PENDING',
		requested_at: NOW - 14 * 60_000,
		expires_at: NOW + 42_000,
		ladder_s: DEFAULT_LADDER,
		max_s: 900
	},
	{
		id: 'apr_01jd8zd4w1',
		agent_token_id: 'tok_triage_cli',
		scope: 'rules.write',
		target: null,
		reason: 'No target named and zero grant ceiling on this scope.',
		state: 'PENDING',
		requested_at: NOW - 5 * 60_000,
		expires_at: NOW + 9 * 60_000,
		ladder_s: DEFAULT_LADDER,
		max_s: null
	}
];

const SAMPLE_GRANTS = [
	{
		id: 'gr_01jd8zf7x0',
		agent_token_id: 'tok_assistant_ops',
		scope: 'sms.send',
		target: { device_id: 'dev_px6a_desk_01', recipients: ['+8801711420819'] },
		granted_by: 'jony@example.com',
		granted_at: NOW - 11 * 60_000,
		expires_at: NOW + 49 * 60_000,
		live: true,
		revoked_at: null,
		use_count: 2,
		last_used_at: NOW - 3 * 60_000,
		approval_request_id: 'apr_01jd8z0001'
	},
	{
		id: 'gr_01jd8zg2m4',
		agent_token_id: 'tok_triage_cli',
		scope: 'workflow.write',
		target: { flow_id: 'wf_order_confirm' },
		granted_by: 'jony@example.com',
		granted_at: NOW - 4 * 60_000,
		expires_at: NOW + 11 * 60_000,
		live: true,
		revoked_at: null,
		use_count: 0,
		last_used_at: null,
		approval_request_id: 'apr_01jd8z0002'
	}
];

/* ---- the history state: a queue that has been worked through ---------------- */

const WORKED_PENDING = [
	{
		id: 'apr_01jd8zp9c4',
		agent_token_id: 'tok_assistant_ops',
		scope: 'sms:send:production',
		target: { device_id: 'dev_px6a_desk_01', recipients: ['+8801819550312'] },
		reason: 'Send the delayed-order notice to one recipient.',
		state: 'PENDING',
		requested_at: NOW - 3 * 60_000,
		expires_at: NOW + 12 * 60_000,
		decided_by: null,
		decided_at: null,
		grant_id: null,
		ladder_s: DEFAULT_LADDER,
		max_s: 3600
	}
];

/** Two decisions of different kinds, so "what was decided" has to be read. */
const DECIDED_APPROVALS = [
	{
		id: 'apr_01jd8za7k2',
		agent_token_id: 'tok_assistant_ops',
		scope: 'sms:send:production',
		target: { device_id: 'dev_px6a_desk_01', recipients: ['+8801711420819'] },
		reason: 'Send dispatch confirmation to a delayed order recipient.',
		state: 'APPROVED',
		requested_at: NOW - 26 * 60_000,
		expires_at: NOW - 11 * 60_000,
		decided_by: 'jony@example.com',
		decided_at: NOW - 9 * 60_000,
		grant_id: 'gr_01jd8zr5n8',
		ladder_s: DEFAULT_LADDER,
		max_s: 3600
	},
	{
		id: 'apr_01jd8zb3t7',
		agent_token_id: 'tok_triage_cli',
		scope: 'rules:write',
		target: { flow_id: 'wf_order_confirm' },
		reason: 'Rewrite the retry branch on Order confirmation.',
		state: 'REJECTED',
		requested_at: NOW - 2 * 3_600_000,
		expires_at: NOW - 90 * 60_000,
		decided_by: 'rae.molina@example.com',
		decided_at: NOW - 95 * 60_000,
		grant_id: null,
		ladder_s: DEFAULT_LADDER,
		max_s: 86400
	}
];

/** Still allowed, so the panel above the history has a row of its own. */
const HISTORY_LIVE_GRANT = {
	id: 'gr_01jd8zh4q1',
	agent_token_id: 'tok_assistant_ops',
	scope: 'flows:write',
	target: { flow_id: 'wf_order_confirm' },
	granted_by: 'jony@example.com',
	granted_at: NOW - 40 * 60_000,
	expires_at: NOW + 40 * 60_000,
	live: true,
	revoked_at: null,
	use_count: 2,
	last_used_at: NOW - 12 * 60_000,
	approval_request_id: 'apr_01jd8zy0r3'
};

/** A grant that was withdrawn, which is how a live row leaves the panel. */
const REVOKED_GRANT = {
	id: 'gr_01jd8zr5n8',
	agent_token_id: 'tok_assistant_ops',
	scope: 'sms:send:production',
	target: { device_id: 'dev_px6a_desk_01', recipients: ['+8801711420819'] },
	granted_by: 'jony@example.com',
	granted_at: NOW - 9 * 60_000,
	expires_at: NOW + 6 * 60_000,
	live: false,
	revoked_at: NOW - 4 * 60_000,
	use_count: 1,
	last_used_at: NOW - 6 * 60_000,
	approval_request_id: 'apr_01jd8za7k2'
};

function scenarioFor(state: ApprovalsStateKey): WorkbenchScenario {
	return {
		role: state === 'not-allowed-member' ? 'member' : 'owner',
		handle: (method, path, url) => {
			if (path.endsWith('/v1/admin/approvals')) {
				if (state === 'loading') return hold();
				if (state === 'load-error') {
					return json({ error: 'storage_unavailable', message: 'Approval table unavailable.' }, 503);
				}
				if (state === 'history-decided') {
					// `?state=PENDING` is the queue; no `state` is every row, which is
					// what the history section reads.
					const asked = url.searchParams.get('state');
					return json({
						approvals: asked === 'PENDING' ? WORKED_PENDING : [...WORKED_PENDING, ...DECIDED_APPROVALS]
					});
				}
				if (state === 'pending-queue' || state === 'grants-error') {
					return json({ approvals: SAMPLE_APPROVALS });
				}
				if (state === 'pending-capped-and-urgent') {
					return json({ approvals: URGENT_AND_UNGRANTABLE });
				}
				return json({ approvals: [] });
			}
			if (path.endsWith('/v1/admin/grants')) {
				if (state === 'loading') return hold();
				if (state === 'grants-error') {
					return json({ error: 'internal_error', message: 'Failed to query authority_grants.' }, 500);
				}
				if (state === 'history-decided') {
					// `live=1` drops revoked rows; the history read asks for all of them.
					return json({
						grants:
							url.searchParams.get('live') === '1'
								? [HISTORY_LIVE_GRANT]
								: [HISTORY_LIVE_GRANT, REVOKED_GRANT]
					});
				}
				if (state === 'grants-active' || state === 'pending-queue') {
					return json({ grants: SAMPLE_GRANTS });
				}
				return json({ grants: [] });
			}
			if (path.endsWith('/v1/devices')) {
				return json({ devices: SAMPLE_DEVICES });
			}
			if (method === 'POST' && path.includes('/v1/admin/approvals/')) {
				return json({
					ok: true,
					clamped: false,
					requested_s: 900,
					granted_s: 900,
					max_s: 3600,
					grant: SAMPLE_GRANTS[0]
				});
			}
			if (method === 'DELETE' && path.includes('/v1/admin/grants/')) {
				return json({ ok: true });
			}
			return null;
		}
	};
}

export const ssr = false;
export const prerender = true;

export function load({ url }: { url: URL }): { state: ApprovalsStateKey } {
	const asked = url.searchParams.get('__state');
	const state: ApprovalsStateKey = isApprovalsState(asked) ? asked : 'pending-queue';
	installStateStub(scenarioFor(state));
	return { state };
}
