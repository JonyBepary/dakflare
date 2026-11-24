import {
	hold,
	installStateStub,
	json,
	offline,
	type WorkbenchScenario
} from './stub';

export type TrackerStateKey =
	| 'loading'
	| 'queued'
	| 'leased'
	| 'dispatched'
	| 'sent'
	| 'delivered'
	| 'failed-pre-phone'
	| 'failed-radio-no-service'
	| 'failed-resendable'
	| 'expired'
	| 'not-found'
	| 'load-error';

const TRACKER_KEYS: ReadonlyArray<TrackerStateKey> = [
	'loading',
	'queued',
	'leased',
	'dispatched',
	'sent',
	'delivered',
	'failed-pre-phone',
	'failed-radio-no-service',
	'failed-resendable',
	'expired',
	'not-found',
	'load-error'
];

function isTrackerState(raw: string | null): raw is TrackerStateKey {
	return raw !== null && (TRACKER_KEYS as readonly string[]).includes(raw);
}

const NOW = Date.now();
const DEVICE_ID = 'dev_px6a_desk_01';
const CMD_ID = 'cmd_01jd8z9p2w4k7m3x8r5t';

function makeCommand(overrides: Record<string, unknown>) {
	return {
		command_id: CMD_ID,
		to: '+8801711420819',
		body: 'Your DakFlare parcel #DF-4082 is out for delivery today.',
		priority: 'normal',
		state: 'PENDING',
		created_at: NOW - 45_000,
		expires_at: NOW + 15 * 60_000,
		channel: 'sms',
		error_code: null,
		error_message: null,
		...overrides
	};
}

function makeTrace(verdict: string, commandOverrides: Record<string, unknown>, why: string[]) {
	const cmd = makeCommand(commandOverrides);
	return {
		id: CMD_ID,
		kind: 'command',
		device_id: DEVICE_ID,
		verdict,
		why,
		message: {
			id: 'msg_01jd8z9m0k',
			peer: cmd.to,
			direction: 'out'
		},
		command: {
			id: CMD_ID,
			state: cmd.state,
			to_e164: cmd.to,
			created_at: cmd.created_at,
			error_code: cmd.error_code,
			error_message: cmd.error_message
		},
		automation: { rules: [], flows: [] },
		approval: null,
		audit: [
			{
				at: cmd.created_at,
				action: 'sms.send',
				actor_label: 'jony@example.com'
			}
		],
		durable_object: {
			command: {
				command_id: CMD_ID,
				state: cmd.state,
				created_at: cmd.created_at,
				leased_at: cmd.state === 'PENDING' ? null : cmd.created_at + 1_200,
				dispatched_at: ['DISPATCHED', 'SENT', 'DELIVERED'].includes(String(cmd.state))
					? cmd.created_at + 2_100
					: null,
				error_code: cmd.error_code,
				error_message: cmd.error_message
			}
		},
		warnings: []
	};
}

function scenarioFor(state: TrackerStateKey): WorkbenchScenario {
	const traceMap: Record<string, ReturnType<typeof makeTrace>> = {
		queued: makeTrace('queued', { state: 'PENDING' }, ['Waiting for the phone to poll or answer push.']),
		leased: makeTrace('queued', { state: 'LEASED' }, ['Push wake held a lease while the phone wakes.']),
		dispatched: makeTrace('queued', { state: 'DISPATCHED' }, ['Handset acknowledged the job into SmsManager.']),
		sent: makeTrace('replied', { state: 'SENT' }, ['Radio accepted the message; carrier delivery receipt not yet returned.']),
		delivered: makeTrace('delivered', { state: 'DELIVERED' }, ['Carrier delivery receipt confirmed.']),
		'failed-pre-phone': makeTrace(
			'failed',
			{
				state: 'FAILED',
				error_code: 'no_paired_handset',
				error_message: null
			},
			['No handset is paired, so there was nothing to send it with.']
		),
		'failed-radio-no-service': makeTrace(
			'failed',
			{
				state: 'FAILED',
				error_code: 'no_service',
				error_message: 'SIM 1 reported RADIO_OFF / no cellular service'
			},
			['Handset radio reported RADIO_NO_SERVICE after send attempt.']
		),
		'failed-resendable': makeTrace(
			'failed',
			{
				state: 'FAILED',
				error_code: 'GENERIC_FAILURE',
				error_message: 'Modem timed out waiting for SMSC ACK'
			},
			['Transient modem timeout waiting for SMSC ACK.']
		),
		expired: makeTrace('expired', { state: 'EXPIRED' }, ['Lease expired before a live phone collected the command.'])
	};

	return {
		handle: (method, path) => {
			if (path.includes('/v1/sms/commands/')) {
				if (path.endsWith('/cmd_resend_new_02')) {
					return json({
						command: makeCommand({
							command_id: 'cmd_resend_new_02',
							state: 'PENDING'
						})
					});
				}
				if (state === 'loading') return hold();
				if (state === 'load-error') return offline();
				if (state === 'not-found') return json({ command: null });
				const cmdStateMap: Record<string, Record<string, unknown>> = {
					queued: { state: 'PENDING' },
					leased: { state: 'LEASED' },
					dispatched: { state: 'DISPATCHED' },
					sent: { state: 'SENT' },
					delivered: { state: 'DELIVERED' },
					'failed-pre-phone': {
						state: 'FAILED',
						error_code: 'no_paired_handset',
						error_message: null
					},
					'failed-radio-no-service': {
						state: 'FAILED',
						error_code: 'no_service',
						error_message: 'SIM 1 reported RADIO_OFF / no cellular service'
					},
					'failed-resendable': {
						state: 'FAILED',
						error_code: 'GENERIC_FAILURE',
						error_message: 'Modem timed out waiting for SMSC ACK'
					},
					expired: { state: 'EXPIRED' }
				};
				return json({ command: makeCommand(cmdStateMap[state] ?? {}) });
			}
			if (path.includes('/v1/admin/trace/')) {
				if (path.endsWith('/cmd_resend_new_02')) {
					return json(
						makeTrace('queued', { command_id: 'cmd_resend_new_02', state: 'PENDING' }, [
							'Waiting for the phone to poll or answer push.'
						])
					);
				}
				const trace = traceMap[state];
				if (!trace) return json({ error: 'not_found' }, 404);
				return json(trace);
			}
			if (method === 'POST' && path.endsWith('/v1/sms/send')) {
				return json({ command_id: 'cmd_resend_new_02', queued: true });
			}
			return null;
		}
	};
}

export const ssr = false;
export const prerender = true;

export function load({ url }: { url: URL }): { state: TrackerStateKey } {
	const asked = url.searchParams.get('__state');
	const state: TrackerStateKey = isTrackerState(asked) ? asked : 'queued';
	installStateStub(scenarioFor(state));
	return { state };
}
