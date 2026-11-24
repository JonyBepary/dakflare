/**
 * Wire fixtures for the assistant workbench.
 *
 * Every entry is one state the REAL `Assistant.svelte` / `AssistantProposalCard.svelte`
 * can reach, described by the bytes the gateway would send at the boundary the
 * component uses. Nothing here is read by the console; `npm run build` never
 * executes a driver, and `+page.ts` installs the stub only in a browser.
 *
 * The shapes follow the real Worker (`worker/src/routes/assistant.ts`):
 *   chat   200 { answer, proposals: [{ id, kind, title, summary, payload }] }
 *   chat   429 { error: "budget_exhausted", used, limit }        (real Worker: no day)
 *   chat   503 { error: "ai_unavailable", message, reason }
 *   accept 200 { kind, result, patch? }
 *   accept 403/400 { error, message }
 */

/** One stub answer: a real body, plain text, a hold, or a network failure. */
export type MockReply =
	| { kind: 'json'; status: number; body: unknown }
	| { kind: 'text'; status: number; body: string }
	/** The request is accepted and never answered; the state stays on screen. */
	| { kind: 'hold' }
	/** The request never reaches the gateway. */
	| { kind: 'throw' };

/**
 * What the fake WebSocket does once the panel constructs one.
 *
 * A timeline rather than a queue: `live-streaming` is a link that sent two tokens
 * and then said nothing, which is only expressible as "nothing more" rather than
 * as "the next frame". `closeAt` is measured from the open (or, for `refuse`, from
 * construction), so a state that ends in a closed socket stays closed.
 */
export interface SocketPlan {
	/** Send `{type:"ready", name}` on open. Default true. */
	ready?: boolean;
	/** Frames, and how long after open each one arrives. */
	frames?: Array<{ at: number; frame: unknown }>;
	/** Close this many ms after open. */
	closeAt?: number;
	closeCode?: number;
	closeReason?: string;
	/** Never open: the upgrade is refused, as a browser reports one. */
	refuse?: boolean;
	/**
	 * Hold `frames` until the client sends `resume`, then start their clock.
	 * This is what a resumed turn looks like: nothing arrives until it is asked for.
	 */
	awaitResume?: boolean;
	/**
	 * The plan for the connections after this one, in order; the last entry repeats.
	 * A reconnect is a different socket with a different story — it is the one that
	 * either replays the turn or refuses to.
	 */
	next?: SocketPlan[];
}

/**
 * What the fake stream endpoint answers.
 *
 * The real route is `text/event-stream`, one frame per `data:` line with its
 * sequence in `id:`, and a named end event. `events` is that, in time order.
 */
export interface SsePlan {
	/** Frames, and how long after the response each one arrives. */
	events?: Array<{ at: number; seq?: number; frame?: unknown }>;
	/** The named event the stream ends on. Default `done`. */
	end?: 'done' | 'timeout';
	/** Milliseconds between the last frame and that event. */
	endAt?: number;
	/** Answer 404 `{error:"stream_not_found"}` instead of a stream. */
	missing?: boolean;
}

export interface MockSet {
	chat?: MockReply;
	accept?: MockReply;
	/** `GET /v1/admin/agent/runtime`. Absent means "the runtime is off". */
	runtime?: MockReply;
	/** `POST /v1/admin/agent/ticket`. Absent means a 201 with a fresh ticket. */
	ticket?: MockReply;
	/** The ticket answer for the second and later requests, when a state needs to hold them. */
	ticketAfter?: MockReply;
	socket?: SocketPlan;
	/** `GET /agents/assistant/assistant/streams/:id` when the socket will not come back. */
	sse?: SsePlan;
	/** `GET /v1/admin/agent/conversation`. Absent means an empty conversation. */
	conversation?: MockReply;
	/** `DELETE /v1/admin/agent/conversation`. Absent means it cleared. */
	clear?: MockReply;
	/** `GET /v1/admin/agent/attachments`. Absent means no kept files. */
	attachments?: MockReply;
	/** `POST /v1/admin/agent/attachments`. */
	upload?: MockReply;
	/** `DELETE /v1/admin/agent/attachments/:id`. Absent means it was removed. */
	remove?: MockReply;
	/** `POST /v1/admin/agent/say`. Absent falls back to `chat`. */
	say?: MockReply;
	/** The say answer for the second and later requests, for a retry. */
	sayAfter?: MockReply;
}

/** What the editor's registered sink answers when the patch is handed over. */
export type SinkVerdict = 'ok' | 'fail' | 'throw';

export type GroupKey =
	| 'panel'
	| 'fullscreen'
	| 'session'
	| 'files'
	| 'answer'
	| 'failure'
	| 'live'
	| 'proposal';

export interface StateConfig {
	group: GroupKey;
	/** What the operator sees, in the product's own words. */
	note: string;
	/** What the stub answers, in one line. Scaffolding, deliberately technical. */
	wire: string;
	chat?: MockReply;
	accept?: MockReply;
	runtime?: MockReply;
	ticket?: MockReply;
	ticketAfter?: MockReply;
	socket?: SocketPlan;
	sse?: SsePlan;
	conversation?: MockReply;
	clear?: MockReply;
	attachments?: MockReply;
	upload?: MockReply;
	remove?: MockReply;
	say?: MockReply;
	sayAfter?: MockReply;
	/** Register the real `registerWorkflowPatchSink` seam while this state runs. */
	sink?: SinkVerdict;
	/** Open the panel in its expanded presentation instead of the floating one. */
	presentation?: 'fullscreen';
	/** Drive: click the launcher, then type / submit / click a card action. */
	open: boolean;
	question?: string;
	submit?: boolean;
	/** A button in the panel, by the start of its visible text. */
	click?: 'Accept' | 'Stage the patch' | 'Try again';
	/** A selector inside the panel to click, for controls whose text is a summary. */
	clickSelector?: string;
	/** Wait for this selector before clicking: the state the click belongs to. */
	clickWhen?: string;
	/** Choose this file through the real file control before the assertions. */
	file?: { name: string; bytes: number; type?: string };
	/** Click Clear, then confirm the inline deletion. */
	clearThen?: boolean;
	/** The panel must contain this before the state counts as reached. */
	expect: string;
	expectGone?: string;
	/** An exact number of matches: one answer, never two after a replay. */
	expectCount?: { selector: string; count: number };
	/** Copy that must be on screen: the proof the mock data rendered. */
	expectText: string | string[];
}

/* ------------------------------------------------------------------ wire */

function json(status: number, body: unknown): MockReply {
	return { kind: 'json', status, body };
}

function text(body: string, status = 200): MockReply {
	return { kind: 'text', status, body };
}

const RULE_REPLY = 'Thanks — payment noted. Reply STATUS and we will send the order it belongs to.';

const RULE_PROPOSAL = {
	id: 'ap_7d3f0a1c9b8e42d6f5a0c311',
	kind: 'create_rule',
	title: 'Reply to a bKash receipt',
	summary:
		'When a bKash payment text arrives, answer the sender with the order it pays for. The rule matches the sender exactly and the receipt wording in the body.',
	payload: {
		name: 'Reply to a bKash receipt',
		matcher: { type: 'exact', value: 'bKash' },
		body_matcher: { type: 'keyword', value: 'You have received' },
		reply_template: RULE_REPLY
	}
};

const TEMPLATE_BODY =
	'Thanks — we have your bKash payment of BDT {{amount}}. Order {{order_id}} is confirmed.';

const TEMPLATE_PROPOSAL = {
	id: 'ap_1e5b9c40f7a24d8e6b3c0192',
	kind: 'create_template',
	title: 'bKash receipt acknowledgement',
	summary: 'A reply that confirms the amount and points at the order it pays for.',
	payload: {
		name: 'bKash receipt acknowledgement',
		body: TEMPLATE_BODY
	}
};

const PATCH_PROPOSAL = {
	id: 'ap_9a2c6f81e4d70b35c8f1426d',
	kind: 'stage_workflow_patch',
	title: 'Add a reply step to the bKash receipt flow',
	summary:
		'Adds a send step after the receipt trigger so the flow answers with the order status instead of stopping.',
	payload: {
		flow_id: 'wf_7c1e9a4b2d50',
		patch: {
			nodes: [
				{
					id: 'n_4f21c8a0d3',
					type: 'trigger',
					position: { x: 40, y: 120 },
					data: {
						kind: 'incoming',
						sender: { mode: 'exact', value: 'bKash' },
						body: { mode: 'keyword', value: 'You have received' }
					}
				},
				{
					id: 'n_9a02e7b416',
					type: 'send_sms',
					position: { x: 360, y: 120 },
					data: { to: '{{sender}}', body: RULE_REPLY }
				}
			],
			edges: [{ id: 'e_18c2f0a95b', source: 'n_4f21c8a0d3', target: 'n_9a02e7b416' }]
		}
	}
};

/**
 * The same rule, prepared by the act path rather than chosen by the model.
 *
 * `worker/src/agent/act.ts` stages this when `create_rule_now` is refused for
 * authority, and puts `origin: "act_refused"` in the open payload. The states
 * differ in that one member, which is exactly what the card must say.
 */
const ACT_REFUSED_PROPOSAL = {
	...RULE_PROPOSAL,
	id: 'ap_4c81e0b7d29f635a1c0e8b74',
	payload: { ...RULE_PROPOSAL.payload, origin: 'act_refused' }
};

const ANSWER_TEXT =
	'Two ways to answer a bKash receipt are below: a rule for the plain text message, and a step for the receipt flow. Neither exists yet — accept a draft, or stage the patch in the editor.';

const ANSWER_PLAIN =
	'A receipt gets no reply when no rule matches it, when the rule is paused, or when the handset has not synced its rules since the last change. This page cannot tell which without the device status.';

const ANSWER_EMPTY =
	'No rule on this gateway matches a bKash receipt. The rules on the Automation page are the place to look.';

/**
 * A full answer: the one state where the reading view exists.
 *
 * It is deliberately longer than the sheet can hold at either width, in the shape
 * a real answer takes — paragraphs, a short list, a command to copy — so the state
 * proves the transcript scrolls under a composer that does not move.
 */
const ANSWER_LONG = [
	'**The handset is fine. A paused rule is not.** The Mi A3 answered a telemetry read at 09:38, holds 42 rules, and its last sync was four minutes ago, so nothing about the radio explains the missing reply.',
	'',
	'The receipt fell through for the same reason the three before it did: the exact-sender rule `rule_1c8e40d2` is paused. It is the only rule on this gateway whose sender matcher is exactly the word bKash, and a paused rule never runs, so the message reached the keyword rule underneath it.',
	'',
	'That rule is active, but two things make it inconclusive rather than innocent:',
	'',
	'- The keyword rule is scoped to the device `dev_9f2c41ab`, and the receipt arrived on `dev_a71c0e58`, which this gateway has not heard from since 07:12.',
	'- Its body matcher is case-sensitive and looks for "You have received". The forwarded copy says "YOU HAVE RECEIVED", so a match was never likely.',
	'',
	'What I did not do is change anything. Neither rule was edited, no message was sent, and the handset was not asked to sync. What is on the next page is a description of the state this gateway is in, not of a change it made.',
	'',
	'To see the paused rule and confirm the second half yourself, run this against the same gateway:',
	'',
	'```',
	'dakflare rules list --device dev_9f2c41ab --state paused --json',
	'```',
	'',
	'The reply template behind the keyword rule keeps a `*` where the order id is unknown, so a receipt that names no order still gets an answer instead of a guess.',
	'',
	'If you want the old behaviour back, un-pausing the exact-sender rule is the smaller change: it restores the reply that worked before, without touching the rule that is currently catching everything. If you would rather leave it paused, the honest fix is a second keyword rule scoped to `dev_a71c0e58` with a lower-case matcher, and that is a change worth making in the editor rather than from this panel.'
].join('\n');

/**
 * A real answer in the model's own Markdown.
 *
 * It carries every shape the panel renders — bold, an id in backticks, a list, a
 * fenced command — and one lone asterisk, which must stay an asterisk because the
 * panel does not do italics.
 */
const ANSWER_MARKDOWN = [
	'**Mi A3 Grameenphone** is paired and online, so the handset is not the problem.',
	'',
	'The paused rule is `rule_1c8e40d2`: it never ran for the last receipt, which is why the reply did not go out. Two ways to fix it:',
	'',
	'- **Un-pause** the exact-sender rule on Automation.',
	'- Or leave it paused and let `rule_9f2c41ab` answer every bKash receipt.',
	'',
	'Check what the handset holds before you change anything:',
	'',
	'```',
	'dakflare rules list --device dev_9f2c41ab --state paused --json',
	'```',
	'',
	'The reply template keeps a * where the order id is unknown, so nothing is guessed.'
].join('\n');

const ACCEPT_RULE = json(200, { kind: 'create_rule', result: { rule_id: 'rule_9f2c41ab' } });

/* ------------------------------------------------------------ the live wire */

/** `GET /v1/admin/agent/runtime`, the two answers that decide which panel this is. */
const RUNTIME_ON = json(200, {
	enabled: true,
	schemaVersion: 1,
	sessions: 1,
	pinnedName: 'assistant'
});
const RUNTIME_OFF = json(200, {
	enabled: false,
	schemaVersion: 1,
	sessions: 0,
	pinnedName: 'assistant'
});

/** `POST /v1/admin/agent/ticket`, the 201 shape. */
const TICKET_OK = json(201, {
	ticket: 'tk_4b91c0f7a62d8e53',
	expires_at: Date.now() + 60_000
});

/** Held open: the link never gets as far as a socket. */
const TICKET_HELD: MockReply = { kind: 'hold' };

/** A ticket bound to a session that is not this one. */
const TICKET_WRONG_SESSION = json(401, { error: 'agent_ticket_wrong_session' });

/** The upgrade gate's origin refusal, which the ticket POST is where a browser can read. */
const TICKET_BAD_ORIGIN = json(403, {
	error: 'agent_origin_untrusted',
	message: 'the Origin header is not in AUTH_TRUSTED_ORIGINS'
});

/** The model's own words, arriving in pieces. */
const LIVE_TEXT =
	'Two rules match a bKash receipt on this deployment. The exact-sender rule is paused, which is why the last receipt got no reply; the keyword rule that is active only answers when the body says "You have received". I can un-pause the sender rule, or change the keyword rule to match the receipt wording.';
const LIVE_FIRST = 'Two rules match a bKash receipt on this deployment. ';
const LIVE_SECOND =
	'**The exact-sender rule is paused**, so `rule_1c8e40d2` never ran, which is why the last receipt got no answer. ';

/** A tool frame's payload: the client drops `output` on purpose, so it is here to prove that. */
const TOOL_READ_OUTPUT =
	'{"rules":[{"id":"rule_9f2c41ab","state":"paused"},{"id":"rule_1c8e40d2","state":"active"}]}';

const ANSWER_LIVE =
	'The paused rule is the one that answered a bKash receipt before it was paused. Un-pausing it would restore the old behaviour without editing the active rule.';

const LIVE_PROPOSAL = RULE_PROPOSAL;

/**
 * The turn's first frame: the one that makes the rest resumable.
 *
 * A real id is namespaced by the idempotency key (`turn:<key>`), which is why it
 * is URL-encoded on the stream path.
 */
const TURN = {
	streamId: 'turn:5b0f0c1e-6a2d-4d6f-9c33-71a5e8b2c401',
	idempotencyKey: 'ask_workbench_5b0f0c1e',
	conversationId: 'conversation:owner@example.com'
};

/** The announcement on its own, for states that start a turn and then go quiet. */
const TURN_FRAME = { type: 'turn', ...TURN };

/**
 * Frames for the complete turn, slow enough to photograph in three parts.
 *
 * None of these carries a stamp: a turn the gateway did not stamp must render
 * without elapsed times, which is what this state also checks.
 */
const TURN_FRAMES = [
	{ at: 60, frame: TURN_FRAME },
	{ at: 140, frame: { type: 'token', text: LIVE_FIRST } },
	{ at: 520, frame: { type: 'token', text: LIVE_SECOND } },
	{ at: 1_400, frame: { type: 'calls', calls: [call('read_rules')] } },
	{
		at: 1_600,
		frame: { type: 'tool', tool: 'read_rules', ok: true, result: { ok: true, output: TOOL_READ_OUTPUT } }
	},
	{
		at: 2_400,
		frame: { type: 'answer', text: ANSWER_LIVE, calls: 1, proposals: [LIVE_PROPOSAL] }
	}
];

/** The same turn, read over HTTP after the socket refused to come back. */
const RESUME_SSE = {
	events: [
		{ at: 120, seq: 2, frame: { type: 'calls', calls: [call('read_rules')] } },
		{
			at: 200,
			seq: 3,
			frame: { type: 'tool', tool: 'read_rules', ok: true, result: { ok: true, output: TOOL_READ_OUTPUT } }
		},
		{ at: 240, seq: 4, frame: { type: 'status', phase: 'answering' } },
		{
			at: 460,
			seq: 5,
			frame: { type: 'answer', text: ANSWER_LIVE, calls: 1, proposals: [LIVE_PROPOSAL] }
		}
	],
	endAt: 80
} satisfies SsePlan;


/**
 * The turn's own clock and stream numbering.
 *
 * `at(ms)` is the gateway's instant for a frame (epoch ms), stamped inside the
 * frame: the timeline shows the gaps between steps from that stamp and from
 * nothing else, so a fixture without stamps must render without gaps. `seq` is
 * the frame's position in the durable stream, and it is what a replay is
 * deduplicated on — a replayed frame carries the same one.
 */
const CLOCK = Date.parse('2026-11-16T09:41:00.000Z');
const at = (ms: number): number => CLOCK + ms;

/** One frame on the wire, numbered and stamped the way a durable stream carries it. */
function wire(seq: number, atMs: number, body: Record<string, unknown>): Record<string, unknown> {
	return { seq, at: at(atMs), ...body };
}

/** One call the gateway is about to run: the `calls` frame's own shape. */
function call(
	tool: string,
	input: Record<string, unknown> = {}
): { tool: string; input: Record<string, unknown> } {
	return { tool, input };
}

/** The batch announcement, `delay` ms after the socket opened. */
function batch(
	delay: number,
	seq: number,
	atMs: number,
	calls: Array<{ tool: string; input: Record<string, unknown> }>
): { at: number; frame: unknown } {
	return { at: delay, frame: wire(seq, atMs, { type: 'calls', calls }) };
}

/** A settled run. `output` is here to prove the panel never renders it. */
function ran(
	delay: number,
	seq: number,
	atMs: number,
	tool: string,
	output: string = TOOL_READ_OUTPUT
): { at: number; frame: unknown } {
	return {
		at: delay,
		frame: wire(seq, atMs, { type: 'tool', tool, ok: true, result: { ok: true, output } })
	};
}

/** A run that did not settle: the gateway's own token and its own sentence. */
function failedStep(
	delay: number,
	seq: number,
	atMs: number,
	tool: string,
	reason: string,
	message: string
): { at: number; frame: unknown } {
	return {
		at: delay,
		frame: wire(seq, atMs, { type: 'tool', tool, ok: false, result: { ok: false, reason, message } })
	};
}

/** A progress phase, in the server's own words. */
function phase(
	delay: number,
	seq: number,
	atMs: number,
	value: string
): { at: number; frame: unknown } {
	return { at: delay, frame: wire(seq, atMs, { type: 'status', phase: value }) };
}

/** The last frame of a turn. */
function answer(
	delay: number,
	seq: number,
	atMs: number,
	text: string,
	calls: number,
	proposals: unknown[] = []
): { at: number; frame: unknown } {
	return { at: delay, frame: wire(seq, atMs, { type: 'answer', text, calls, proposals }) };
}

const ANSWER_FIVE =
	'I read the rules and the delivery record, created a rule for bKash receipts, then checked the fleet and the recent flow runs. The paused sender rule is why the last receipt got no reply; the new rule answers it from now on.';

const ANSWER_TWO =
	'The paused rule is the one that answered a bKash receipt before it was paused. Un-pausing it would restore the old behaviour without editing the active rule.';

const ANSWER_REFUSED =
	'I could not send that message: no grant covers this recipient. The rule is drafted below — an operator can open a window and accept it, and the send will work then.';

const ANSWER_RECOVERED =
	'The device check could not reach the handset, so I read the flow directly instead. The flow itself is intact; the receipt rule is still missing a reply step.';

/**
 * Five steps in two batches, stamped: the state the timeline exists for.
 *
 * The stamps are the point of this one — 0.9 s, 1.3 s, 6.4 s and 1.3 s apart —
 * so the row meta shows the work's real pace rather than five identical rows.
 */
const FIVE_STEP_FRAMES = [
	{ at: 60, frame: wire(0, 0, TURN_FRAME) },
	{ at: 140, frame: wire(1, 120, { type: 'token', text: LIVE_FIRST }) },
	batch(300, 2, 400, [
		call('read_rules', { state: 'all' }),
		call('search_messages', { query: 'bKash' }),
		call('create_rule_now', { matcher: 'bKash' })
	]),
	phase(520, 3, 700, 'tool:read_rules'),
	ran(560, 4, 1_200, 'read_rules'),
	phase(700, 5, 1_300, 'tool:search_messages'),
	ran(760, 6, 2_100, 'search_messages'),
	phase(880, 7, 2_200, 'tool:create_rule_now'),
	ran(940, 8, 3_400, 'create_rule_now'),
	{ at: 1_000, frame: wire(9, 3_600, { type: 'token', text: LIVE_SECOND }) },
	phase(1_100, 10, 3_700, 'thinking'),
	batch(1_200, 11, 3_700, [call('telemetry'), call('flow_runs', { limit: 5 })]),
	phase(1_300, 12, 3_800, 'tool:telemetry'),
	ran(1_360, 13, 9_800, 'telemetry'),
	phase(1_500, 14, 9_900, 'tool:flow_runs'),
	ran(1_560, 15, 11_100, 'flow_runs'),
	phase(1_700, 16, 11_200, 'answering'),
	answer(1_900, 17, 11_300, ANSWER_FIVE, 5)
];

/** Two steps, one batch: the smallest turn that is still a timeline. */
const TWO_STEP_FRAMES = [
	{ at: 60, frame: wire(0, 0, TURN_FRAME) },
	{ at: 140, frame: wire(1, 120, { type: 'token', text: LIVE_FIRST }) },
	batch(300, 2, 400, [call('read_rules'), call('search_messages', { query: 'bKash' })]),
	phase(520, 3, 700, 'tool:read_rules'),
	ran(560, 4, 900, 'read_rules'),
	phase(700, 5, 1_000, 'tool:search_messages'),
	ran(760, 6, 2_400, 'search_messages'),
	answer(940, 7, 2_500, ANSWER_TWO, 2)
];

/**
 * The turn stopped on a refusal, and the model's words stayed.
 *
 * `send_sms` is the act the gate can refuse on its own, and `no_grant` is the
 * gate's own token for it. The answer after it is the answer an operator would
 * get if the step had succeeded: that is the rule the row must not break.
 */
const REFUSED_STEP_FRAMES = [
	{ at: 60, frame: wire(0, 0, TURN_FRAME) },
	{
		at: 140,
		frame: wire(1, 120, {
			type: 'token',
			text: 'Texting the receipt back needs an open window. '
		})
	},
	batch(300, 2, 400, [
		call('read_rules'),
		call('send_sms', { to: '+8801711000111', body: RULE_REPLY })
	]),
	phase(520, 3, 700, 'tool:read_rules'),
	ran(560, 4, 900, 'read_rules'),
	phase(700, 5, 1_200, 'tool:send_sms'),
	failedStep(760, 6, 1_500, 'send_sms', 'no_grant', 'no grant covers a recipient on this device'),
	phase(900, 7, 1_600, 'answering'),
	answer(1_100, 8, 1_800, ANSWER_REFUSED, 2, [LIVE_PROPOSAL])
];

/** A step that broke, then two that did not: the row keeps its place. */
const RECOVERED_FRAMES = [
	{ at: 60, frame: wire(0, 0, TURN_FRAME) },
	{ at: 140, frame: wire(1, 120, { type: 'token', text: 'Checking the handset first. ' }) },
	batch(300, 2, 400, [
		call('diagnose', { device_id: 'dev_9f2c' }),
		call('flow_ast', { flow_id: 'wf_7c1e9a4b2d50' })
	]),
	phase(520, 3, 700, 'tool:diagnose'),
	failedStep(560, 4, 1_100, 'diagnose', 'tool_failed', 'the tool threw: TypeError: fetch failed'),
	phase(700, 5, 1_200, 'tool:flow_ast'),
	ran(760, 6, 2_000, 'flow_ast'),
	phase(800, 7, 2_100, 'thinking'),
	batch(900, 8, 2_200, [call('search_messages', { query: 'You have received' })]),
	phase(950, 9, 2_300, 'tool:search_messages'),
	ran(1_000, 10, 3_300, 'search_messages'),
	phase(1_100, 11, 3_400, 'answering'),
	answer(1_300, 12, 3_600, ANSWER_RECOVERED, 3)
];

/**
 * A turn cut off after two steps, then resumed from a sequence earlier than the
 * one the panel reached.
 *
 * The second connection replays seq 4–6, which the panel already applied, before
 * it sends 7 onward. A server that replays more than it was asked for must not
 * put a row on screen twice, and this state is the proof: four steps, not six.
 */
const RESUME_TIMELINE = {
	frames: [
		{ at: 60, frame: wire(0, 0, TURN_FRAME) },
		{ at: 120, frame: wire(1, 120, { type: 'token', text: LIVE_FIRST }) },
		batch(180, 2, 400, [call('read_rules'), call('search_messages'), call('create_rule_now')]),
		phase(240, 3, 700, 'tool:read_rules'),
		ran(300, 4, 800, 'read_rules'),
		phase(400, 5, 1_000, 'tool:search_messages'),
		ran(440, 6, 1_900, 'search_messages')
	],
	closeAt: 600,
	closeCode: 1006,
	next: [
		{
			awaitResume: true,
			frames: [
				// Already applied, and replayed anyway: `tool read_rules` (seq 4).
				ran(80, 4, 800, 'read_rules'),
				// Also already applied: the phase that named the second step (seq 5).
				phase(100, 5, 1_000, 'tool:search_messages'),
				// And the settled second step (seq 6), replayed once.
				ran(120, 6, 1_900, 'search_messages'),
				phase(160, 7, 2_000, 'tool:create_rule_now'),
				ran(220, 8, 3_200, 'create_rule_now'),
				batch(280, 9, 3_600, [call('flow_runs', { limit: 5 })]),
				phase(320, 10, 3_700, 'tool:flow_runs'),
				ran(360, 11, 4_400, 'flow_runs'),
				phase(420, 12, 4_500, 'answering'),
				answer(520, 13, 4_600, ANSWER_FIVE, 4)
			]
		}
	]
};

/**
 * Mid-turn, one step settled and two still queued: the plan line's own state.
 *
 * The second call is the fleet read, so the line reads exactly the way the brief
 * describes it: the verb, then the position in the batch the gateway announced.
 */
const PLAN_FRAMES = [
	{ at: 60, frame: wire(0, 0, TURN_FRAME) },
	{ at: 140, frame: wire(1, 120, { type: 'token', text: LIVE_FIRST }) },
	batch(300, 2, 400, [
		call('read_rules'),
		call('fleet_health'),
		call('create_rule_now', { matcher: 'bKash' })
	]),
	phase(520, 3, 700, 'tool:read_rules'),
	ran(560, 4, 900, 'read_rules'),
	phase(700, 5, 1_000, 'tool:fleet_health')
];

/* ---------------------------------------------------- the durable session */

/**
 * The operator's saved conversation, as `GET /v1/admin/agent/conversation` sends
 * it: oldest first, the operator's turn followed by the agent's, and `truncated`
 * when the gateway held more than it sent.
 */
const SAVED_CONVERSATION = {
	conversation: 'conversation:owner@example.com',
	messages: [
		{
			id: 'msg_c1a4',
			role: 'user',
			text: 'Why did the last bKash receipt get no reply?',
			at: '2026-11-18T16:02:00.000Z'
		},
		{
			id: 'msg_c1b7',
			role: 'assistant',
			text: '**The exact-sender rule is paused.** The keyword rule on `rule_1c8e40d2` is active, but it only answers when the body says "You have received".',
			at: '2026-11-18T16:02:09.000Z'
		},
		{
			id: 'msg_c2d2',
			role: 'user',
			text: 'Could the paused rule be why the earlier test did not answer?',
			at: '2026-11-18T16:04:31.000Z'
		},
		{
			id: 'msg_c2e9',
			role: 'assistant',
			text: 'Yes. A paused rule never runs, so that message fell through to `rule_1c8e40d2` and did not match. It can be un-paused from **Automation → Rules**.',
			at: '2026-11-18T16:04:40.000Z'
		}
	],
	truncated: false
};

const TRUNCATED_CONVERSATION = { ...SAVED_CONVERSATION, truncated: true };

const EMPTY_CONVERSATION = {
	conversation: 'conversation:owner@example.com',
	messages: [],
	truncated: false
};

/* ----------------------------------------------------------- the files */

const HOUR_MS = 3_600_000;

const TEXT_ATTACHMENT = {
	id: 'att_2f7c91d0b4',
	name: 'receipts.txt',
	bytes: 2_460,
	kind: 'text',
	expires_at: new Date(Date.now() + 22 * HOUR_MS).toISOString()
};

const IMAGE_ATTACHMENT = {
	id: 'att_8a1e40c65f',
	name: 'receipt-photo.jpg',
	bytes: 88_473,
	kind: 'image',
	expires_at: new Date(Date.now() + 21 * HOUR_MS).toISOString()
};

/** Kept, and past its own expiry: the chip says so and the send leaves it out. */
const EXPIRED_ATTACHMENT = {
	id: 'att_3b9d0e71a2',
	name: 'carrier-export.csv',
	bytes: 18_432,
	kind: 'text',
	expires_at: new Date(Date.now() - 2 * HOUR_MS).toISOString()
};




export const STATES = {
	closed: {
		group: 'panel',
		note: 'The launcher alone: one button in the bottom corner, no panel.',
		wire: 'no request',
		open: false,
		expect: 'button.launcher[aria-expanded="false"]',
		expectGone: 'section.panel',
		expectText: 'Ask'
	},
	idle: {
		group: 'panel',
		note: 'Open, with nothing asked yet: one line says what the panel does, and Ask is disabled.',
		wire: 'no request',
		open: true,
		expect: '.state.quiet',
		expectText: 'No earlier turns yet. Ask about this page; your questions and answers are kept'
	},
	'idle-typed': {
		group: 'panel',
		note: 'Open, a question typed, Ask ready.',
		wire: 'no request',
		open: true,
		question: 'Which rule answers a bKash receipt?',
		expect: 'button.ask-send:not([disabled])',
		expectText: 'No earlier turns yet.'
	},
	'prompt-mentions': {
		group: 'panel',
		note: 'At-sign opens what this page already holds: the page itself, the flow on screen and any attached file. Choosing one writes its name into the question; nothing is sent or uploaded.',
		wire: 'no request · the field holds "@"',
		open: true,
		question: '@',
		expect: 'form.ask [role="listbox"]',
		expectText: ['Mention', 'this page', 'Names something already here. Nothing is sent.']
	},
	'prompt-commands': {
		group: 'panel',
		note: 'Slash starts from a question about a page of this console: the row says which page, and the note says the choice adds words rather than running anything.',
		wire: 'no request · the field holds "/"',
		open: true,
		question: '/',
		expect: 'form.ask [role="listbox"]',
		expectText: [
			'Ask about',
			'Automation · rules',
			'Adds a question. Nothing runs until you press Ask.'
		]
	},
	asking: {
		group: 'panel',
		note: 'The question is sent and the answer is still coming: the field is locked and the panel says it is asking.',
		wire: 'say: held open',
		chat: { kind: 'hold' },
		open: true,
		question: 'Why did the last bKash receipt get no reply?',
		submit: true,
		expect: '.state.waiting',
		expectText: 'Asking the assistant…'
	},

	'fullscreen-long': {
		group: 'fullscreen',
		note: 'The panel expanded: the same header, transcript and composer on the whole screen, with a full answer in it. The answer runs past the bottom and the transcript scrolls under the composer, which stays where it is.',
		wire: 'say: 200 · a long answer · expanded',
		chat: json(200, { answer: ANSWER_LONG, proposals: [] }),
		presentation: 'fullscreen',
		open: true,
		question: 'Why did the last bKash receipt get no reply?',
		submit: true,
		expect: 'section.panel[data-presentation="fullscreen"]',
		expectText: [
			'The handset is fine. A paused rule is not.',
			'dakflare rules list --device dev_9f2c41ab'
		]
	},
	'fullscreen-streaming': {
		group: 'fullscreen',
		note: 'Expanded, mid-turn: the words that have arrived, the one step that settled, the step the agent is on, and a caret where the next word goes. Nothing has finished, so nothing says it has.',
		wire: 'socket: turn · token · calls ×3 · 1 tool · status tool:fleet_health · silence · expanded',
		runtime: RUNTIME_ON,
		ticket: TICKET_OK,
		socket: { frames: PLAN_FRAMES },
		presentation: 'fullscreen',
		open: true,
		question: 'Why did the last bKash receipt get no reply?',
		submit: true,
		expect: 'section.panel[data-presentation="fullscreen"] .answer .caret',
		expectText: ['Reading the fleet', 'step 2 of 3', 'Read the rules']
	},
	'fullscreen-proposals': {
		group: 'fullscreen',
		note: 'Expanded on a phone with three drafts under the answer: a rule, a template and a patch, each with its own action, and the composer still at the bottom of the screen.',
		wire: 'say: 200 · 3 proposals · expanded',
		chat: json(200, {
			answer: ANSWER_TEXT,
			proposals: [RULE_PROPOSAL, TEMPLATE_PROPOSAL, PATCH_PROPOSAL]
		}),
		presentation: 'fullscreen',
		open: true,
		question: 'Why did the last bKash receipt get no reply?',
		submit: true,
		expect: 'section.panel[data-presentation="fullscreen"]',
		expectCount: { selector: 'li.proposal', count: 3 },
		expectText: ['Reply to a bKash receipt', 'The editor is not open on this page']
	},

	'history-loaded': {
		group: 'session',
		note: 'The saved conversation is read on open: two past turns, the operator’s words and the agent’s, newest last, with a rule and a heading where this turn begins.',
		wire: 'conversation: 200 · 4 messages · newest last',
		conversation: json(200, SAVED_CONVERSATION),
		open: true,
		expect: 'ol.messages li.message',
		expectCount: { selector: 'ol.messages li.message', count: 4 },
		expectText: [
			'Earlier turns',
			'4 messages',
			'Why did the last bKash receipt get no reply?',
			'This turn',
			'Ask a question about this page to continue.'
		]
	},
	'history-empty': {
		group: 'session',
		note: 'There is a conversation and it holds nothing yet: one quiet line says the first question starts it, and nothing pretends to be history.',
		wire: 'conversation: 200 · 0 messages',
		conversation: json(200, EMPTY_CONVERSATION),
		open: true,
		expect: '.state.quiet',
		expectGone: 'ol.messages',
		expectText: 'No earlier turns yet.'
	},
	'history-truncated': {
		group: 'session',
		note: 'The gateway held more than it sent: the transcript says it is showing the last messages and that earlier ones are not loaded.',
		wire: 'conversation: 200 · truncated true',
		conversation: json(200, TRUNCATED_CONVERSATION),
		open: true,
		expect: '.history-note',
		expectText: ['Showing the last 4 messages; earlier ones are not loaded.', 'Earlier turns']
	},
	'history-unreadable': {
		group: 'session',
		note: 'The transcript read failed, so the panel says so and still answers the question; the answer is never hidden behind an empty conversation.',
		wire: 'conversation: 500 · say: 200 text',
		conversation: json(500, { error: 'internal_error', message: 'the conversation store failed' }),
		chat: text(ANSWER_PLAIN),
		open: true,
		question: 'Why did the last bKash receipt get no reply?',
		submit: true,
		expect: '.answer',
		expectGone: 'ol.messages',
		expectText: [
			'The saved conversation could not be read',
			'no rule matches it'
		]
	},
	'clearing-conversation': {
		group: 'session',
		note: 'Clear asks inline before it deletes: a sentence, two buttons, and while the gateway is answering the line says it is deleting. No dialog.',
		wire: 'conversation: 200 · DELETE held',
		conversation: json(200, SAVED_CONVERSATION),
		clear: { kind: 'hold' },
		open: true,
		clearThen: true,
		expect: '.clear-confirm',
		expectText: ['Deleting the saved transcript…', 'Keep']
	},
	replayed: {
		group: 'session',
		note: 'The first attempt did not answer, Try again reuses its key, and the gateway says it had already answered: one line says nothing ran twice, and one answer is on screen.',
		wire: 'say #1: network error · say #2: 200 replayed true',
		say: { kind: 'throw' },
		sayAfter: json(200, { answer: ANSWER_PLAIN, proposals: [], replayed: true }),
		open: true,
		question: 'Why did the last bKash receipt get no reply?',
		submit: true,
		click: 'Try again',
		expect: '.state.replay',
		expectCount: { selector: '.answer', count: 1 },
		expectText: [
			'Answered earlier from the same request — nothing ran twice.',
			'no rule matches it'
		]
	},
	'attachment-text': {
		group: 'files',
		note: 'A text file attached through the real control: the chip carries its name, size and kind, and the next question sends its id.',
		wire: 'attachments: POST 201 · kind text',
		upload: json(201, TEXT_ATTACHMENT),
		file: { name: 'receipts.txt', bytes: 2_460, type: 'text/plain' },
		open: true,
		expect: 'li.file-chip[data-kind="text"]',
		expectText: ['receipts.txt', '2.4 KiB', 'text']
	},
	'attachment-image': {
		group: 'files',
		note: 'An image is named, not described: the chip says the model cannot see it, because this deployment’s chat model has no vision.',
		wire: 'attachments: POST 201 · kind image',
		upload: json(201, IMAGE_ATTACHMENT),
		file: { name: 'receipt-photo.jpg', bytes: 88_473, type: 'image/jpeg' },
		open: true,
		expect: 'li.file-chip[data-kind="image"]',
		expectText: [
			'receipt-photo.jpg',
			'86 KiB',
			'Named only — this model cannot see images.'
		]
	},
	'attachment-too-big': {
		group: 'files',
		note: 'A file over the limit is refused before it is uploaded: one line names the file, its size and the limit. Nothing is sent.',
		wire: 'no request · the file is 1.5 MiB',
		file: { name: 'invoice-scan.pdf', bytes: 1_572_864, type: 'application/pdf' },
		open: true,
		expect: '.state[data-tone="danger"]',
		expectGone: 'li.file-chip',
		expectText: 'invoice-scan.pdf is 1.5 MiB. The limit is 1 MiB per file.'
	},
	'attachment-expired': {
		group: 'files',
		note: 'A kept file whose 24 hours ran out: the chip is marked expired, says how long files are kept, and the question will leave it out.',
		wire: 'attachments: 200 · expires_at in the past',
		attachments: json(200, { attachments: [EXPIRED_ATTACHMENT] }),
		open: true,
		expect: 'li.file-chip[data-expired="true"]',
		expectText: [
			'carrier-export.csv',
			'Expired — files are kept 24 hours; attach it again.'
		]
	},

	'plain-answer': {
		group: 'answer',
		note: 'The gateway answered in plain text, so the panel prints that text and offers no cards.',
		wire: 'chat: 200 text/plain',
		chat: text(ANSWER_PLAIN),
		open: true,
		question: 'Why did the last bKash receipt get no reply?',
		submit: true,
		expect: '.answer',
		expectText: 'no rule matches it'
	},
	'answer-markdown': {
		group: 'answer',
		note: 'The model answered in Markdown: bold reads as bold, an id reads as an id, a list as a list and a command as a block, and a lone asterisk stays a character.',
		wire: 'chat: 200 { answer: markdown, proposals: [] }',
		chat: json(200, { answer: ANSWER_MARKDOWN, proposals: [] }),
		open: true,
		question: 'Why did the last bKash receipt get no reply?',
		submit: true,
		expect: 'pre code.mono',
		expectCount: { selector: '.answer strong', count: 2 },
		expectText: [
			'Mi A3 Grameenphone',
			'rule_1c8e40d2',
			'dakflare rules list --device dev_9f2c41ab --state paused --json',
			'keeps a * where the order id is unknown'
		]
	},
	'answer-empty': {
		group: 'answer',
		note: 'An answer with no proposals: the text, and no cards.',
		wire: 'chat: 200 { answer, proposals: [] }',
		chat: json(200, { answer: ANSWER_EMPTY, proposals: [] }),
		open: true,
		question: 'Why did the last bKash receipt get no reply?',
		submit: true,
		expect: '.answer',
		expectGone: 'li.proposal',
		expectText: 'No rule on this gateway matches a bKash receipt.'
	},
	'answer-proposals': {
		group: 'answer',
		note: 'An answer with three drafts: a rule to accept, a template to accept, and a patch with no editor on this page.',
		wire: 'chat: 200 · 3 proposals',
		chat: json(200, {
			answer: ANSWER_TEXT,
			proposals: [RULE_PROPOSAL, TEMPLATE_PROPOSAL, PATCH_PROPOSAL]
		}),
		open: true,
		question: 'Why did the last bKash receipt get no reply?',
		submit: true,
		expect: 'li.proposal',
		expectText: 'The editor is not open on this page'
	},

	unavailable: {
		group: 'failure',
		note: "This deployment has no chat provider: the gateway's own reason, then where an owner sets the key.",
		wire: 'chat: 503 ai_unavailable · missing_key',
		chat: json(503, {
			error: 'ai_unavailable',
			reason: 'missing_key',
			message:
				'AI_CHAT_API_KEY is not set; add it with `cf workers secrets update AI_CHAT_API_KEY --worker dakflare-worker --type secret_text` (it is never stored in D1)'
		}),
		open: true,
		question: 'Why did the last bKash receipt get no reply?',
		submit: true,
		expect: '.detail.mono',
		expectText: ['The assistant is not available on this gateway.', 'AI_CHAT_API_KEY is not set']
	},
	'unavailable-bare': {
		group: 'failure',
		note: 'The same refusal with no detail: one line and the way to AI settings.',
		wire: 'chat: 503 ai_unavailable (no message)',
		chat: json(503, { error: 'ai_unavailable', reason: 'missing_binding' }),
		open: true,
		question: 'Why did the last bKash receipt get no reply?',
		submit: true,
		expect: '.state[data-tone="warn"]',
		expectText: 'The assistant is not available on this gateway.'
	},
	exhausted: {
		group: 'failure',
		note: "Today's allowance is spent, with the numbers and the day the count belongs to.",
		wire: 'chat: 429 budget_exhausted · 12 / 20000 · day 2026-11-15',
		chat: json(429, {
			error: 'budget_exhausted',
			used: 12,
			limit: 20000,
			day: '2026-11-15'
		}),
		open: true,
		question: 'Why did the last bKash receipt get no reply?',
		submit: true,
		expect: '.detail.mono',
		expectText: ["Today's allowance is spent: 12 / 20000.", 'day 2026-11-15']
	},
	'exhausted-bare': {
		group: 'failure',
		note: 'Allowance spent, with no numbers from the gateway: it does not print a zero it was not told.',
		wire: 'chat: 429 budget_exhausted (no counts)',
		chat: json(429, { error: 'budget_exhausted' }),
		open: true,
		question: 'Why did the last bKash receipt get no reply?',
		submit: true,
		expect: '.state[data-tone="warn"]',
		expectText: "Today's allowance is spent."
	},
	'rate-limited': {
		group: 'failure',
		note: 'The gateway is limiting these calls: wait, then ask again.',
		wire: 'chat: 429 rate_limited',
		chat: json(429, { error: 'rate_limited' }),
		open: true,
		question: 'Why did the last bKash receipt get no reply?',
		submit: true,
		expect: '.state[data-tone="warn"]',
		expectText: 'The gateway is limiting these calls.'
	},
	refused: {
		group: 'failure',
		note: 'This account may not use the assistant. The gateway sentence is the one shown.',
		wire: 'chat: 403 forbidden',
		chat: json(403, {
			error: 'forbidden',
			message: 'Only an owner may use the assistant on this deployment.'
		}),
		open: true,
		question: 'Why did the last bKash receipt get no reply?',
		submit: true,
		expect: '.state[data-tone="danger"]',
		expectText: 'Only an owner may use the assistant on this deployment.'
	},
	offline: {
		group: 'failure',
		note: 'No answer at all: the request never reached the gateway.',
		wire: 'chat: network error',
		chat: { kind: 'throw' },
		open: true,
		question: 'Why did the last bKash receipt get no reply?',
		submit: true,
		expect: '.state[data-tone="danger"]',
		expectText: 'The gateway did not answer. Nothing was sent.'
	},
	unreadable: {
		group: 'failure',
		note: 'A 200 whose JSON is not the chat contract: it never falls back to printing the body.',
		wire: 'chat: 200 { ok, reply }',
		chat: json(200, { ok: true, reply: 'check the rules page' }),
		open: true,
		question: 'Why did the last bKash receipt get no reply?',
		submit: true,
		expect: '.state[data-tone="warn"]',
		expectText: 'The gateway answered with something this console cannot read.'
	},
	error: {
		group: 'failure',
		note: 'The gateway answered HTTP 500. Nothing changed.',
		wire: 'chat: 500 internal_error',
		chat: json(500, { error: 'internal_error', message: 'the provider call failed' }),
		open: true,
		question: 'Why did the last bKash receipt get no reply?',
		submit: true,
		expect: '.state[data-tone="warn"]',
		expectText: 'The gateway answered HTTP 500.'
	},

	'live-off': {
		group: 'live',
		note: 'The runtime is off on this deployment, so the panel asked over HTTP exactly as it always has: no link, no marker, nothing said about a live agent.',
		wire: 'runtime: enabled false · chat: 200 text',
		chat: text(ANSWER_PLAIN),
		runtime: RUNTIME_OFF,
		open: true,
		question: 'Why did the last bKash receipt get no reply?',
		submit: true,
		expect: '.answer',
		expectGone: '.link-chip',
		expectText: 'no rule matches it'
	},
	'live-connecting': {
		group: 'live',
		note: 'The runtime is on and the ticket has not been answered yet: the panel says what it is waiting for and holds the question rather than dropping it.',
		wire: 'runtime: enabled true · ticket: held',
		runtime: RUNTIME_ON,
		ticket: TICKET_HELD,
		open: true,
		question: 'Why did the last bKash receipt get no reply?',
		submit: true,
		expect: '.state.waiting',
		expectText: 'Connecting to the agent'
	},
	'live-streaming': {
		group: 'live',
		note: 'The answer is arriving token by token and the turn is not finished: the text so far, a caret, and no error line while it is still coming.',
		wire: 'socket: turn · 2 tokens, then silence',
		runtime: RUNTIME_ON,
		ticket: TICKET_OK,
		socket: {
			frames: [
				{ at: 60, frame: TURN_FRAME },
				{ at: 120, frame: { type: 'token', text: LIVE_FIRST } },
				{ at: 460, frame: { type: 'token', text: LIVE_SECOND } }
			]
		},
		open: true,
		question: 'Why did the last bKash receipt get no reply?',
		submit: true,
		expect: '.answer .caret',
		expectText: ['Two rules match a bKash receipt', 'The exact-sender rule is paused']
	},
	'live-tool-ok': {
		group: 'live',
		note: 'One tool ran: a single quiet line — the tool, its sentence, no rail and no chip — the answer below it, and none of the tool output the gateway also sent.',
		wire: 'socket: turn · token · calls [read_rules] · tool read_rules ok · answer',
		runtime: RUNTIME_ON,
		ticket: TICKET_OK,
		socket: {
			frames: [
				{ at: 60, frame: TURN_FRAME },
				{ at: 100, frame: { type: 'token', text: LIVE_FIRST } },
				{ at: 240, frame: { type: 'calls', calls: [call('read_rules')] } },
				{
					at: 280,
					frame: { type: 'tool', tool: 'read_rules', ok: true, result: { ok: true, output: TOOL_READ_OUTPUT } }
				},
				{
					at: 420,
					frame: { type: 'answer', text: LIVE_TEXT, calls: 1, proposals: [] }
				}
			]
		},
		open: true,
		question: 'Why did the last bKash receipt get no reply?',
		submit: true,
		expect: 'p.step-one',
		expectGone: 'ol.steps',
		expectText: ['read_rules', 'Read the rules', 'Two rules match a bKash receipt']
	},
	'live-tool-refused': {
		group: 'live',
		note: 'One tool was refused, which is enough to earn the rail: the row keeps its place, the chip says refused, the gateway’s token and sentence sit on the row, and the answer it produced is still there.',
		wire: 'socket: turn · token · calls [read_rules, send_sms] · tool send_sms refused no_grant · answer',
		runtime: RUNTIME_ON,
		ticket: TICKET_OK,
		socket: {
			frames: [
				{ at: 60, frame: TURN_FRAME },
				{ at: 100, frame: { type: 'token', text: LIVE_FIRST } },
				{ at: 200, frame: { type: 'calls', calls: [call('read_rules'), call('send_sms')] } },
				{
					at: 240,
					frame: { type: 'tool', tool: 'read_rules', ok: true, result: { ok: true, output: TOOL_READ_OUTPUT } }
				},
				{
					at: 300,
					frame: {
						type: 'tool',
						tool: 'send_sms',
						ok: false,
						result: {
							ok: false,
							reason: 'no_grant',
							message: 'no grant covers a recipient on this device'
						}
					}
				},
				{
					at: 460,
					frame: {
						type: 'answer',
						text: 'I cannot send that message while no window is open. The rule is drafted below, and an operator can accept it.',
						calls: 2,
						proposals: [LIVE_PROPOSAL]
					}
				}
			]
		},
		open: true,
		question: 'Text the last bKash receipt back its order status.',
		submit: true,
		expect: 'li.step[data-verdict="refused"]',
		expectText: [
			'send_sms',
			'refused',
			'no_grant',
			'no grant covers a recipient on this device',
			'I cannot send that message'
		]
	},
	'live-answer-proposals': {
		group: 'live',
		note: 'A finished live turn: the tool line, the answer, and the same proposal card the stateless path draws.',
		wire: 'socket: turn · token · tool · answer with 1 proposal',
		runtime: RUNTIME_ON,
		ticket: TICKET_OK,
		socket: {
			frames: [
				{ at: 60, frame: TURN_FRAME },
				{ at: 100, frame: { type: 'token', text: LIVE_FIRST } },
				{ at: 200, frame: { type: 'calls', calls: [call('read_rules')] } },
				{
					at: 220,
					frame: { type: 'tool', tool: 'read_rules', ok: true, result: { ok: true, output: TOOL_READ_OUTPUT } }
				},
				{
					at: 300,
					frame: { type: 'answer', text: ANSWER_LIVE, calls: 1, proposals: [LIVE_PROPOSAL] }
				}
			]
		},
		open: true,
		question: 'Why did the last bKash receipt get no reply?',
		submit: true,
		expect: 'li.proposal',
		expectText: ['Reply to a bKash receipt', 'The paused rule is the one']
	},
	'live-closed': {
		group: 'live',
		note: 'The link closes before the turn was announced, so there is no stream to ask for: the part that arrived stays, one line says the rest never came with the close code under it, and Try again asks for the same turn rather than a new one.',
		wire: 'socket: 2 tokens, then close 1006, no turn frame · every later ticket held',
		runtime: RUNTIME_ON,
		ticket: TICKET_OK,
		ticketAfter: TICKET_HELD,
		socket: {
			frames: [
				{ at: 120, frame: { type: 'token', text: LIVE_FIRST } },
				{ at: 300, frame: { type: 'token', text: LIVE_SECOND } }
			],
			closeAt: 700,
			closeCode: 1006
		},
		open: true,
		question: 'Why did the last bKash receipt get no reply?',
		submit: true,
		expect: '.state[data-tone="warn"]',
		expectText: ['The link closed before the answer finished', 'link closed (1006)', 'Try again']
	},
	'live-grant-expired': {
		group: 'live',
		note: 'The window closed mid-turn: the model’s words stay on screen and one line says the acting stopped, with the gateway’s own message under it.',
		wire: 'socket: turn · token · tool · error grant_expired',
		runtime: RUNTIME_ON,
		ticket: TICKET_OK,
		socket: {
			frames: [
				{ at: 60, frame: TURN_FRAME },
				{ at: 100, frame: { type: 'token', text: LIVE_FIRST } },
				{ at: 180, frame: { type: 'calls', calls: [call('read_rules')] } },
				{
					at: 200,
					frame: { type: 'tool', tool: 'read_rules', ok: true, result: { ok: true, output: TOOL_READ_OUTPUT } }
				},
				{
					at: 340,
					frame: {
						type: 'error',
						reason: 'grant_expired',
						message: 'the grant expired at 2026-11-16T09:41:00Z; the agent is proposing again'
					}
				}
			]
		},
		open: true,
		question: 'Turn the paused rule back on.',
		submit: true,
		expect: '.state[data-tone="warn"]',
		expectText: [
			'Two rules match a bKash receipt',
			'The grant that lets the agent act has expired',
			'the grant expired at'
		]
	},
	'live-cap-reached': {
		group: 'live',
		note: 'A cap on the window ran out mid-turn: same shape as the expired grant, in the gateway’s words, and the answer so far is not replaced.',
		wire: 'socket: turn · token · error cap_reached',
		runtime: RUNTIME_ON,
		ticket: TICKET_OK,
		socket: {
			frames: [
				{ at: 60, frame: TURN_FRAME },
				{ at: 100, frame: { type: 'token', text: LIVE_FIRST } },
				{
					at: 320,
					frame: {
						type: 'error',
						reason: 'cap_reached',
						message: 'the write cap for this window is spent'
					}
				}
			]
		},
		open: true,
		question: 'Turn the paused rule back on.',
		submit: true,
		expect: '.state[data-tone="warn"]',
		expectText: ['A cap on this window was reached', 'the write cap for this window is spent']
	},
	'live-ticket-refused': {
		group: 'live',
		note: 'The ticket POST refuses because the ticket belonged to another session: the panel says which refusal it was, and Try again is the way back.',
		wire: 'runtime: enabled true · ticket: 401 wrong session',
		runtime: RUNTIME_ON,
		ticket: TICKET_WRONG_SESSION,
		open: true,
		question: 'Why did the last bKash receipt get no reply?',
		submit: true,
		expect: '.state[data-tone="danger"]',
		expectText: ['minted for another session', 'Try again']
	},
	'live-origin-refused': {
		group: 'live',
		note: 'The gateway does not trust this page’s origin: the one refusal a browser could not see from a socket, which is why it is decided at the ticket.',
		wire: 'runtime: enabled true · ticket: 403 agent_origin_untrusted',
		runtime: RUNTIME_ON,
		ticket: TICKET_BAD_ORIGIN,
		open: true,
		question: 'Why did the last bKash receipt get no reply?',
		submit: true,
		expect: '.state[data-tone="danger"]',
		expectText: ['does not trust', 'not in AUTH_TRUSTED_ORIGINS']
	},
	'live-turn': {
		group: 'live',
		note: 'One live turn, start to finish, slow enough to watch: tokens, then a tool line, then the answer and its proposal card.',
		wire: 'socket: turn at 0.06 s · tokens at 0.14/0.52 s · tool at 1.5 s · answer at 2.4 s',
		runtime: RUNTIME_ON,
		ticket: TICKET_OK,
		socket: { frames: TURN_FRAMES },
		open: true,
		question: 'Why did the last bKash receipt get no reply?',
		submit: true,
		expect: 'li.proposal',
		expectText: ['read_rules', 'The paused rule is the one', 'Reply to a bKash receipt']
	},

	'multi-step-two': {
		group: 'live',
		note: 'Two steps: the timeline appears. One row per step in the order they ran, the verdict as a chip, and the gap between them from the frames’ own stamps.',
		wire: 'socket: turn · token · calls [read_rules, search_messages] · 2 tools stamped at +0.9 s and +2.4 s · answer',
		runtime: RUNTIME_ON,
		ticket: TICKET_OK,
		socket: { frames: TWO_STEP_FRAMES },
		open: true,
		question: 'Why did the last bKash receipt get no reply?',
		submit: true,
		expect: 'ol.steps li.step',
		expectCount: { selector: 'ol.steps li.step', count: 2 },
		expectText: ['Read the rules', 'Searched the delivery record', '1.5 s', 'The paused rule is the one']
	},
	'multi-step-five': {
		group: 'live',
		note: 'Five steps in two batches: the whole turn reads as work in order, with the gap each stamp proves (0.9 s, 1.3 s, 6.4 s, 1.3 s) and the answer above it undisturbed.',
		wire: 'socket: turn · tokens · 2 batches · 5 tools stamped · answer',
		runtime: RUNTIME_ON,
		ticket: TICKET_OK,
		socket: { frames: FIVE_STEP_FRAMES },
		open: true,
		question: 'Why did the last bKash receipt get no reply?',
		submit: true,
		expect: 'ol.steps li.step[data-verdict="ok"]',
		expectCount: { selector: 'ol.steps li.step', count: 5 },
		expectText: ['Read the rules', 'Searched the delivery record', 'Created a rule', 'Ran telemetry', 'Read the flow runs', 'The paused sender rule is why']
	},
	'multi-step-plan': {
		group: 'live',
		note: 'Mid-turn: one step settled and two still queued, so the plan line says where the work is — the verb, then the position in the batch the gateway announced.',
		wire: 'socket: turn · token · calls [read_rules, fleet_health, create_rule_now] · 1 tool · status tool:fleet_health · silence',
		runtime: RUNTIME_ON,
		ticket: TICKET_OK,
		socket: { frames: PLAN_FRAMES },
		open: true,
		question: 'Why did the last bKash receipt get no reply?',
		submit: true,
		expect: 'li.tool-chip[data-state=ok]',
		expectCount: { selector: 'li.tool-chip', count: 3 },
		expectText: ['Reading the fleet', 'step 2 of 3', 'read_rules']
	},
	'tool-chips-queued': {
		group: 'live',
		note: 'Mid-turn, every call is a chip: the one that ran, and the two the gateway announced and has not settled — dashed, hollow, and named. The plan line still says where the batch is.',
		wire: 'socket: turn · token · calls [read_rules, fleet_health, create_rule_now] · 1 tool · status tool:fleet_health · silence',
		runtime: RUNTIME_ON,
		ticket: TICKET_OK,
		socket: { frames: PLAN_FRAMES },
		open: true,
		question: 'Why did the last bKash receipt get no reply?',
		submit: true,
		expect: 'li.tool-chip[data-state=ok]',
		expectCount: { selector: 'li.tool-chip', count: 3 },
		expectText: ['fleet_health', 'create_rule_now', 'queued', 'ran']
	},
	'trace-folded': {
		group: 'live',
		note: 'A clean five-step turn, finished: the work folds to one summary line — how many steps, how long the gateway took — and the answer keeps the room. The rows are still in the page, one disclosure away.',
		wire: 'socket: turn · 2 batches · 5 tools stamped · answer · settled',
		runtime: RUNTIME_ON,
		ticket: TICKET_OK,
		socket: { frames: FIVE_STEP_FRAMES },
		open: true,
		question: 'Why did the last bKash receipt get no reply?',
		submit: true,
		expect: 'button.trace-toggle[aria-expanded="false"]',
		expectCount: { selector: 'ol.steps li.step', count: 5 },
		expectText: ['Worked through 5 steps', 'The paused sender rule is why']
	},
	'trace-open': {
		group: 'live',
		note: 'The same finished turn with the trace opened by hand: five rows, the verdict on each, the gap each stamp proves, and the summary still saying what the whole thing was.',
		wire: 'socket: turn · 2 batches · 5 tools stamped · answer · settled · disclosure clicked',
		runtime: RUNTIME_ON,
		ticket: TICKET_OK,
		socket: { frames: FIVE_STEP_FRAMES },
		open: true,
		question: 'Why did the last bKash receipt get no reply?',
		submit: true,
		clickSelector: 'button.trace-toggle',
		clickWhen: 'button.trace-toggle[aria-expanded="false"]',
		expect: 'button.trace-toggle[aria-expanded="true"]',
		expectCount: { selector: 'li.tool-chip', count: 0 },
		expectText: ['Worked through 5 steps', 'Read the rules', 'Created a rule', '1.3 s']
	},
	'step-refused': {
		group: 'live',
		note: 'A step refused mid-turn: it keeps its place, the chip says refused, the gateway’s token and sentence sit on the row verbatim, and the model’s answer below stays readable.',
		wire: 'socket: turn · token · calls [read_rules, send_sms] · tool send_sms refused no_grant · answer + proposal',
		runtime: RUNTIME_ON,
		ticket: TICKET_OK,
		socket: { frames: REFUSED_STEP_FRAMES },
		open: true,
		question: 'Text the last bKash receipt back its order status.',
		submit: true,
		expect: 'li.step[data-verdict="refused"] .step-reason',
		expectCount: { selector: 'ol.steps li.step', count: 2 },
		expectText: [
			'Send a message',
			'no_grant',
			'no grant covers a recipient on this device',
			'I could not send that message',
			'Reply to a bKash receipt'
		]
	},
	'step-failed-then-recovered': {
		group: 'live',
		note: 'The first step failed and the turn went on: the failed row keeps its place with the gateway’s reason, the two that followed are rows of their own, and the answer says how it recovered.',
		wire: 'socket: turn · token · calls [diagnose, flow_ast, search_messages] · diagnose failed tool_failed · 2 ok · answer',
		runtime: RUNTIME_ON,
		ticket: TICKET_OK,
		socket: { frames: RECOVERED_FRAMES },
		open: true,
		question: 'Is the receipt flow still healthy?',
		submit: true,
		expect: 'li.step[data-verdict="failed"] .step-reason',
		expectCount: { selector: 'ol.steps li.step', count: 3 },
		expectText: [
			'Check the device',
			'tool_failed',
			'the tool threw: TypeError: fetch failed',
			'Read the flow',
			'Searched the delivery record',
			'so I read the flow directly instead'
		]
	},
	'timeline-after-resume': {
		group: 'live',
		note: 'The link drops after two steps, the panel resumes, and the server replays three frames it had already sent: the timeline is the same four rows, once each, with no duplicate from the replay.',
		wire: 'socket: 2 tools · close 1006 · resume replies seq 4–6 again, then 7–13',
		runtime: RUNTIME_ON,
		ticket: TICKET_OK,
		socket: RESUME_TIMELINE,
		open: true,
		question: 'Why did the last bKash receipt get no reply?',
		submit: true,
		expect: '.answer',
		expectGone: '.state.waiting',
		expectCount: { selector: 'ol.steps li.step', count: 4 },
		expectText: [
			'Read the rules',
			'Searched the delivery record',
			'Created a rule',
			'Read the flow runs',
			'The paused sender rule is why'
		]
	},
	'turn-announced': {
		group: 'live',
		note: 'The turn is announced and nothing has been said since: the panel knows the stream and says the agent has the question, which is what a long silent turn looks like instead of a blank box.',
		wire: 'socket: turn, then silence for the length of the state',
		runtime: RUNTIME_ON,
		ticket: TICKET_OK,
		socket: { frames: [{ at: 80, frame: TURN_FRAME }] },
		open: true,
		question: 'Why did the last bKash receipt get no reply?',
		submit: true,
		expect: '.state.waiting',
		expectGone: '.state.phase',
		expectText: 'The agent has the question and is working on it'
	},
	'status-thinking': {
		group: 'live',
		note: 'The server says it is thinking: one quiet line in the operator’s words, no invented tokens, and the panel is visibly alive.',
		wire: 'socket: turn · status thinking',
		runtime: RUNTIME_ON,
		ticket: TICKET_OK,
		socket: {
			frames: [
				{ at: 60, frame: TURN_FRAME },
				{ at: 240, frame: { type: 'status', phase: 'thinking' } }
			]
		},
		open: true,
		question: 'Why did the last bKash receipt get no reply?',
		submit: true,
		expect: '.state.phase',
		expectGone: '.answer',
		expectText: 'Reading this deployment'
	},
	'status-tool': {
		group: 'live',
		note: 'A tool is running: the same one line names it in plain words, so a long telemetry run is not a frozen panel.',
		wire: 'socket: turn · status tool:telemetry',
		runtime: RUNTIME_ON,
		ticket: TICKET_OK,
		socket: {
			frames: [
				{ at: 60, frame: TURN_FRAME },
				{ at: 240, frame: { type: 'status', phase: 'tool:telemetry' } }
			]
		},
		open: true,
		question: 'Why did the last bKash receipt get no reply?',
		submit: true,
		expect: '.state.phase',
		expectText: 'Running telemetry'
	},
	'resumed-mid-turn': {
		group: 'live',
		note: 'The link drops after the turn is announced, the panel reconnects with a fresh ticket and resumes from the sequence it stopped at: the tool line, the phase and the answer arrive, and exactly one answer is on screen.',
		wire: 'socket: turn · status thinking · close 1006 · reconnect resumes from seq 2',
		runtime: RUNTIME_ON,
		ticket: TICKET_OK,
		socket: {
			frames: [
				{ at: 60, frame: TURN_FRAME },
				{ at: 120, frame: { type: 'calls', calls: [call('read_rules')] } },
				{ at: 160, frame: { type: 'status', phase: 'thinking' } }
			],
			closeAt: 520,
			closeCode: 1006,
			next: [
				{
					awaitResume: true,
					frames: [
						{
							at: 80,
							frame: { type: 'tool', tool: 'read_rules', ok: true, result: { ok: true, output: TOOL_READ_OUTPUT } }
						},
						{ at: 180, frame: { type: 'status', phase: 'answering' } },
						{
							at: 380,
							frame: { type: 'answer', text: ANSWER_LIVE, calls: 1, proposals: [LIVE_PROPOSAL] }
						}
					]
				}
			]
		},
		open: true,
		question: 'Why did the last bKash receipt get no reply?',
		submit: true,
		expect: 'li.proposal',
		expectGone: '.state.waiting',
		expectCount: { selector: '.answer', count: 1 },
		expectText: ['read_rules', 'The paused rule is the one', 'Reply to a bKash receipt']
	},
	'resume-via-sse': {
		group: 'live',
		note: 'The socket will not come back at all, so the panel reads the same turn from the stream endpoint: the rest of the turn arrives over HTTP and the answer is still rendered once.',
		wire: 'socket: turn · status · close 1006 · every socket refused · stream replays seq 2-5',
		runtime: RUNTIME_ON,
		ticket: TICKET_OK,
		socket: {
			frames: [
				{ at: 60, frame: TURN_FRAME },
				{ at: 160, frame: { type: 'status', phase: 'thinking' } }
			],
			closeAt: 460,
			closeCode: 1006,
			next: [{ refuse: true, closeCode: 1006 }]
		},
		sse: RESUME_SSE,
		open: true,
		question: 'Why did the last bKash receipt get no reply?',
		submit: true,
		expect: 'li.proposal',
		expectGone: '.state.waiting',
		expectCount: { selector: '.answer', count: 1 },
		expectText: ['read_rules', 'The paused rule is the one']
	},
	'resume-failed': {
		group: 'live',
		note: 'The socket will not come back and the stream is not there either: only now does the panel say the turn was lost, with the close code under it and Try again on the same key.',
		wire: 'socket: turn · close 1006 · every socket refused · stream 404 stream_not_found',
		runtime: RUNTIME_ON,
		ticket: TICKET_OK,
		socket: {
			frames: [
				{ at: 60, frame: TURN_FRAME },
				{ at: 160, frame: { type: 'status', phase: 'thinking' } }
			],
			closeAt: 460,
			closeCode: 1006,
			next: [{ refuse: true, closeCode: 1006 }]
		},
		sse: { missing: true },
		open: true,
		question: 'Why did the last bKash receipt get no reply?',
		submit: true,
		expect: '.state[data-tone="warn"]',
		expectGone: '.state.waiting',
		expectText: [
			'The link closed and the answer could not be picked up again',
			'link closed (1006)',
			'Try again'
		]
	},
	'close-code': {
		group: 'live',
		note: 'The close carries a code and a reason: both are printed under the line while the panel is still reconnecting, so the drop is diagnosable and the gateway is not blamed for it.',
		wire: 'socket: turn · status tool:telemetry · close 1011 agent_worker_restarted · ticket held',
		runtime: RUNTIME_ON,
		ticket: TICKET_OK,
		ticketAfter: TICKET_HELD,
		socket: {
			frames: [
				{ at: 60, frame: TURN_FRAME },
				{ at: 180, frame: { type: 'status', phase: 'tool:telemetry' } }
			],
			closeAt: 460,
			closeCode: 1011,
			closeReason: 'agent_worker_restarted'
		},
		open: true,
		question: 'Why did the last bKash receipt get no reply?',
		submit: true,
		expect: '.detail.mono',
		expectText: ['link closed (1011) · agent_worker_restarted', 'The link dropped']
	},
	'answer-replayed': {
		group: 'live',
		note: 'The same answer arrives twice, as a replay delivers it: the panel keeps one. The terminal frame is folded in on the turn’s state, not on a sequence number, so a replay can neither drop it nor double it.',
		wire: 'socket: turn · status · answer · the identical answer again',
		runtime: RUNTIME_ON,
		ticket: TICKET_OK,
		socket: {
			frames: [
				{ at: 60, frame: TURN_FRAME },
				{ at: 140, frame: { type: 'status', phase: 'answering' } },
				{ at: 300, frame: { type: 'answer', text: ANSWER_LIVE, calls: 0, proposals: [] } },
				{ at: 420, frame: { type: 'answer', text: ANSWER_LIVE, calls: 0, proposals: [] } }
			]
		},
		open: true,
		question: 'Why did the last bKash receipt get no reply?',
		submit: true,
		expect: '.answer',
		expectGone: '.state.phase',
		expectCount: { selector: '.answer', count: 1 },
		expectText: 'The paused rule is the one'
	},

	'proposal-act-refused': {
		group: 'proposal',
		note: 'The agent tried to create the rule itself, was refused for authority, and prepared it instead: one quiet line under the action says why the card exists, without reading as an error.',
		wire: 'chat: 200 · 1 proposal · payload.origin "act_refused"',
		chat: json(200, { answer: ANSWER_TEXT, proposals: [ACT_REFUSED_PROPOSAL] }),
		open: true,
		question: 'Create a rule that answers a bKash receipt.',
		submit: true,
		expect: 'li.proposal .cause',
		expectText: [
			'Reply to a bKash receipt',
			`Prepared because the agent's own attempt was refused`,
			'no autonomy window covers it',
			'is you applying the change by hand'
		]
	},
	'proposal-chosen': {
		group: 'proposal',
		note: 'The model chose to propose this rule: the same card, and no line about a refusal.',
		wire: 'chat: 200 · 1 proposal · no origin in the payload',
		chat: json(200, { answer: ANSWER_TEXT, proposals: [RULE_PROPOSAL] }),
		open: true,
		question: 'Draft a rule that answers a bKash receipt.',
		submit: true,
		expect: 'li.proposal',
		expectGone: 'li.proposal .cause',
		expectText: 'Reply to a bKash receipt'
	},

	'accept-rule': {
		group: 'proposal',
		note: 'Accept on a rule: the gateway created it and the card names the rule id.',
		wire: 'accept: 200 create_rule · rule_9f2c41ab',
		chat: json(200, { answer: ANSWER_TEXT, proposals: [RULE_PROPOSAL] }),
		accept: ACCEPT_RULE,
		open: true,
		question: 'Why did the last bKash receipt get no reply?',
		submit: true,
		click: 'Accept',
		expect: '.result[data-tone="ok"]',
		expectText: ['The rule was created.', 'rule_9f2c41ab']
	},
	'accept-rule-unnamed': {
		group: 'proposal',
		note: 'The gateway accepted the rule but named no id, and the card says exactly that.',
		wire: 'accept: 200 create_rule · no rule_id',
		chat: json(200, { answer: ANSWER_TEXT, proposals: [RULE_PROPOSAL] }),
		accept: json(200, { kind: 'create_rule', result: {} }),
		open: true,
		question: 'Why did the last bKash receipt get no reply?',
		submit: true,
		click: 'Accept',
		expect: '.result[data-tone="ok"]',
		expectText: 'The gateway accepted the rule but did not name it.'
	},
	'accept-template': {
		group: 'proposal',
		note: 'Accept on a template: the draft comes back with its body in a block the operator can keep.',
		wire: 'accept: 200 create_template',
		chat: json(200, { answer: ANSWER_TEXT, proposals: [TEMPLATE_PROPOSAL] }),
		accept: json(200, {
			kind: 'create_template',
			result: { name: 'bKash receipt acknowledgement', body: TEMPLATE_BODY }
		}),
		open: true,
		question: 'Why did the last bKash receipt get no reply?',
		submit: true,
		click: 'Accept',
		expect: '.draft',
		expectText: [
			'bKash receipt acknowledgement',
			'Nothing was saved; it is yours to keep.',
			'BDT {{amount}}'
		]
	},
	'accept-noname': {
		group: 'proposal',
		note: 'A template accepted without a name: one sentence says the draft is ready and nothing was saved.',
		wire: 'accept: 200 create_template · no name',
		chat: json(200, {
			answer: ANSWER_TEXT,
			proposals: [
				{
					id: 'ap_5c0e71b2a94f38d6e7b24a08',
					kind: 'create_template',
					title: 'Receipt reply, wording only',
					summary: 'A body to paste into the send step of the receipt flow.',
					payload: { body: TEMPLATE_BODY }
				}
			]
		}),
		accept: json(200, { kind: 'create_template', result: { body: TEMPLATE_BODY } }),
		open: true,
		question: 'Why did the last bKash receipt get no reply?',
		submit: true,
		click: 'Accept',
		expect: '.draft',
		expectText: ['The template draft is ready. Nothing was saved.', 'BDT {{amount}}']
	},
	'accept-refused': {
		group: 'proposal',
		note: 'The gateway refuses the draft and its sentence is what the card shows.',
		wire: 'accept: 403 forbidden',
		chat: json(200, { answer: ANSWER_TEXT, proposals: [RULE_PROPOSAL] }),
		accept: json(403, {
			error: 'forbidden',
			message: 'Only an owner may accept a proposal on this deployment.'
		}),
		open: true,
		question: 'Why did the last bKash receipt get no reply?',
		submit: true,
		click: 'Accept',
		expect: '.result[data-tone="danger"]',
		expectText: 'Only an owner may accept a proposal on this deployment.'
	},
	accepting: {
		group: 'proposal',
		note: 'Accept clicked and the gateway is still answering: the button locks and shows it is working.',
		wire: 'accept: held open',
		chat: json(200, { answer: ANSWER_TEXT, proposals: [RULE_PROPOSAL] }),
		accept: { kind: 'hold' },
		open: true,
		question: 'Why did the last bKash receipt get no reply?',
		submit: true,
		click: 'Accept',
		expect: 'li.proposal button[aria-busy="true"]',
		expectText: 'Accepting'
	},
	'stage-ready': {
		group: 'proposal',
		note: 'An editor is mounted on the page, so the patch can be staged from the card.',
		wire: 'sink registered',
		chat: json(200, { answer: ANSWER_TEXT, proposals: [PATCH_PROPOSAL] }),
		sink: 'ok',
		open: true,
		question: 'Why did the last bKash receipt get no reply?',
		submit: true,
		expect: 'li.proposal .actions button',
		expectText: ['Stages in the editor.', 'Stage the patch']
	},
	'stage-missing': {
		group: 'proposal',
		note: 'No editor on this page: the card says so and links to the flow, which is why it is never accepted here.',
		wire: 'no sink',
		chat: json(200, { answer: ANSWER_TEXT, proposals: [PATCH_PROPOSAL] }),
		open: true,
		question: 'Why did the last bKash receipt get no reply?',
		submit: true,
		expect: '.why a[href*="workflows/edit"]',
		expectText: ['The editor is not open on this page', 'open the workflow']
	},
	'staged-ok': {
		group: 'proposal',
		note: 'The editor took the patch and is showing it as a preview; its own accept still stands between the preview and the flow.',
		wire: 'sink → staged',
		chat: json(200, { answer: ANSWER_TEXT, proposals: [PATCH_PROPOSAL] }),
		sink: 'ok',
		open: true,
		question: 'Why did the last bKash receipt get no reply?',
		submit: true,
		click: 'Stage the patch',
		expect: '.result[data-tone="ok"]',
		expectText: 'Staged for review'
	},
	'staged-failed': {
		group: 'proposal',
		note: 'The editor refuses the patch because it does not fit the open flow, and the card prints that reason.',
		wire: 'sink → refused',
		chat: json(200, { answer: ANSWER_TEXT, proposals: [PATCH_PROPOSAL] }),
		sink: 'fail',
		open: true,
		question: 'Why did the last bKash receipt get no reply?',
		submit: true,
		click: 'Stage the patch',
		expect: '.result[data-tone="danger"]',
		expectText: 'The patch leaves the flow with two triggers.'
	},
	'staged-threw': {
		group: 'proposal',
		note: 'The handover threw: the panel prints the editor error rather than claiming success.',
		wire: 'sink → threw',
		chat: json(200, { answer: ANSWER_TEXT, proposals: [PATCH_PROPOSAL] }),
		sink: 'throw',
		open: true,
		question: 'Why did the last bKash receipt get no reply?',
		submit: true,
		click: 'Stage the patch',
		expect: '.result[data-tone="danger"]',
		expectText: 'The editor is still loading the flow.'
	},
	'unknown-kind': {
		group: 'proposal',
		note: 'A kind this console has no path for, and no summary to print: it names the kind and says nothing was changed.',
		wire: 'chat: 200 · kind create_campaign',
		chat: json(200, {
			answer: 'I can only draft rules, templates and workflow patches here.',
			proposals: [
				{
					id: 'ap_2b6d90e1f3c84a75b0d6921e',
					kind: 'create_campaign',
					title: 'Send a reminder to unpaid orders',
					summary: '',
					payload: { audience: 'unpaid', delay_hours: 24 }
				}
			]
		}),
		open: true,
		question: 'Can you nudge everyone with an unpaid order?',
		submit: true,
		expect: '.why .mono',
		expectText: 'This console has no path for a create_campaign proposal'
	}
} satisfies Record<string, StateConfig>;

export type StateKey = keyof typeof STATES;

/** Widened to the contract so the driver can read optional fields. */
export const STATE_TABLE: Record<StateKey, StateConfig> = STATES;

/** In the order the switcher shows them. */
export const STATE_KEYS = Object.keys(STATES) as StateKey[];

export const GROUPS: Array<{ key: GroupKey; label: string; keys: StateKey[] }> = [
	{ key: 'panel', label: 'The panel', keys: [] },
	{ key: 'fullscreen', label: 'The panel, on the full screen', keys: [] },
	{ key: 'session', label: 'The saved conversation', keys: [] },
	{ key: 'files', label: 'Files for a question', keys: [] },
	{ key: 'answer', label: 'An answer', keys: [] },
	{ key: 'live', label: 'The live agent (socket)', keys: [] },
	{ key: 'failure', label: 'When the gateway could not answer', keys: [] },
	{ key: 'proposal', label: "A proposal's outcome", keys: [] }
];

for (const key of STATE_KEYS) {
	const group = GROUPS.find((entry) => entry.key === STATES[key].group);
	group?.keys.push(key);
}
