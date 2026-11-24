/**
 * The wire, as this gateway answers it, for every state the AI settings page can
 * reach — one entry per switcher key.
 *
 * Shapes follow what the page actually reads: `assistant.ts` (`readSettings`,
 * `readSystem1`, `readKeySources`, `readCatalogue`, `readAnswers`,
 * `failureFromAnswer`) and `agent-socket.ts` (`readAgentRuntime`,
 * `parseAutonomy`). Only fields those readers consume are present, and no value
 * is a placeholder: this deployment is OpenAI-compatible through Token Lab,
 * chats as `Gemma-4-31B-IT`, routes as `Clef`, and its day is 2026-11-16.
 *
 * Facts about the wire shape that matter for the fixtures:
 *
 *  - `readSystem1` keeps the gateway's `inheritsBase` when the Worker sends one,
 *    and `system1BaseIsOwn()` is the one rule that decides the row: the flag wins;
 *    without it an empty or equal `system1.baseUrl` means inherited, a differing
 *    one means the operator's own. Three fixtures cover the three paths:
 *    `tokenlab` (no flag, equal base → inherited), `system1OwnBase` (no flag,
 *    differing base → own) and `system1OwnEqualBase` (flag `false`, equal base →
 *    own, which only the flag can say).
 *  - A document with no System One block at all (`system1NotReported`) is an older
 *    Worker: the page shows a placeholder model and compares against an empty
 *    default, so it arrives clean.
 *  - A `null` `keySource`, or a half one (`{chat}` without `system1`), reads as
 *    "not reported": `readKeySources` wants both members or neither.
 *
 * `HOLD` is the one value no gateway sends: a request that is made and never
 * answered. It is how "reading", "saving", "testing", "opening" and "revoking"
 * hold still until the switcher moves. No timer in this workbench resolves.
 */

export type WirePlan =
	| { kind: 'json'; status: number; body: unknown }
	| { kind: 'text'; status: number; text: string }
	/** The request is made and never answered. */
	| { kind: 'hold' }
	/** The request never reaches the gateway: `fetch` rejects, as a dead network does. */
	| { kind: 'offline' };

/** What the workbench does to the real page after it mounts. */
export type Act =
	| { do: 'provider'; value: 'workers-ai' | 'openai-compatible' }
	| { do: 'model'; value: string }
	| { do: 'base'; value: string }
	/** Type System One's model: a free-text input, or one of the three aliases on Workers AI. */
	| { do: 's1model'; value: string }
	/** Tick (true) or untick (false) System One's "Use the chat base URL". */
	| { do: 'inheritbase'; value: boolean }
	| { do: 's1base'; value: string }
	| { do: 'save' }
	| { do: 'test' }
	/** Press "Test System One". */
	| { do: 's1test' }
	/** Press the model field's own "Load models" button. */
	| { do: 'models' }
	/** Click one id out of the catalogue the page just rendered. */
	| { do: 'pick'; value: string }
	/** Tick the autonomy acknowledgement: step two of opening a window. */
	| { do: 'ack' }
	/** Type one of the two autonomy caps. */
	| { do: 'cap'; field: 'sms' | 'writes'; value: string }
	/** Press "Open a … window". */
	| { do: 'open-window' }
	/** Press "Revoke the window". */
	| { do: 'revoke' };

export interface Scenario {
	/** `owner` is the admin session the console boots with; `member` cannot see security. */
	session: 'owner' | 'member';
	/** `GET /v1/admin/ai/settings`. */
	settings: WirePlan;
	/** `PUT /v1/admin/ai/settings`. */
	save?: WirePlan;
	/** `POST /v1/admin/ai/test`. */
	test?: WirePlan;
	/** `POST /v1/admin/ai/system1/test`. */
	system1Test?: WirePlan;
	/** `GET /v1/admin/ai/models`. */
	models?: WirePlan;
	/** `GET /v1/admin/agent/runtime`. Absent means off, the deployment default. */
	runtime?: WirePlan;
	/** `GET /v1/admin/agent/autonomy`. */
	autonomy?: WirePlan;
	/** `POST /v1/admin/agent/autonomy`. */
	autonomyPost?: WirePlan;
	/** `DELETE /v1/admin/agent/autonomy`. */
	autonomyDelete?: WirePlan;
	act?: Act[];
}

/** The document `GET /v1/admin/ai/settings` sends back. */
interface AiSettingsWire {
	provider: 'workers-ai' | 'openai-compatible';
	model: string;
	baseUrl: string | null;
	/** System One's *effective* values, or `null` from a Worker before the split. */
	system1: {
		provider: 'workers-ai' | 'openai-compatible';
		model: string;
		baseUrl: string | null;
		/** The gateway's own answer; absent from a Worker that predates it. */
		inheritsBase?: boolean;
	} | null;
	apiKeyConfigured: boolean;
	keySource: { chat: string; system1: string } | null;
	hint: string | null;
	budget: { day: string | null; used: number | null; limit: number | null };
}

const DAY = '2026-11-16';
const CHAT_MODEL = 'Gemma-4-31B-IT';
const CHAT_BASE = 'https://api.tokenlab.amd.com/v1';
const S1_MODEL = 'Clef';
/** Token Lab serves the decision model under its own host. */
const S1_BASE = 'https://clef.tokenlab.amd.com/v1';
const WORKERS_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

const HOLD: WirePlan = { kind: 'hold' };

const ok = (body: unknown): WirePlan => ({ kind: 'json', status: 200, body });

/** `aiUnavailable` in the Worker: the one 503 body the AI routes send. */
const unavailable = (reason: string, message: string, retryAfter?: string): WirePlan => ({
	kind: 'json',
	status: 503,
	body: {
		error: 'ai_unavailable',
		reason,
		message,
		...(retryAfter === undefined ? {} : { retry_after: retryAfter })
	}
});

/* --------------------------------------------------------------- documents */

/**
 * The deployment as it is: OpenAI-compatible, one secret answering both roles,
 * System One on its own model and the chat origin.
 */
const tokenlab: AiSettingsWire = {
	provider: 'openai-compatible',
	model: CHAT_MODEL,
	baseUrl: CHAT_BASE,
	system1: { provider: 'openai-compatible', model: S1_MODEL, baseUrl: CHAT_BASE },
	apiKeyConfigured: true,
	keySource: { chat: 'AI_PROVIDER_API_KEY', system1: 'AI_PROVIDER_API_KEY' },
	hint: `Requests go to ${CHAT_BASE}; System One to ${CHAT_BASE}.`,
	budget: { day: DAY, used: 12, limit: 20000 }
};

/** One secret per role: the chat key answers chat, and only TOKENLAB_API_KEY answers the route. */
const splitKeys: AiSettingsWire = {
	...tokenlab,
	keySource: { chat: 'AI_CHAT_API_KEY', system1: 'TOKENLAB_API_KEY' },
	hint: `Requests go to ${CHAT_BASE}; System One to ${CHAT_BASE}. Chat reads AI_CHAT_API_KEY, System One TOKENLAB_API_KEY.`
};

/** An external gateway with no chat key; its hint is the same command the rows print. */
const chatKeyMissing: AiSettingsWire = {
	...tokenlab,
	apiKeyConfigured: false,
	keySource: { chat: 'none', system1: 'TOKENLAB_API_KEY' },
	hint: 'Set a key with `cf workers secrets update AI_CHAT_API_KEY --worker dakflare-worker --type secret_text`.'
};

const system1KeyMissing: AiSettingsWire = {
	...tokenlab,
	keySource: { chat: 'AI_CHAT_API_KEY', system1: 'none' },
	hint: 'Set a key with `cf workers secrets update TOKENLAB_API_KEY --worker dakflare-worker --type secret_text`.'
};

const bothKeysMissing: AiSettingsWire = {
	...tokenlab,
	apiKeyConfigured: false,
	keySource: { chat: 'none', system1: 'none' },
	hint: 'Set a key with `cf workers secrets update AI_PROVIDER_API_KEY --worker dakflare-worker --type secret_text`.'
};

/** An older Worker: it answered the document, and said nothing about the secrets. */
const keySourceUnreported: AiSettingsWire = { ...tokenlab, keySource: null };

/** Workers AI: both roles answer through the Worker's own binding, no key anywhere. */
const workers: AiSettingsWire = {
	provider: 'workers-ai',
	model: WORKERS_MODEL,
	baseUrl: null,
	system1: { provider: 'workers-ai', model: 'clef', baseUrl: null },
	apiKeyConfigured: true,
	keySource: { chat: 'none', system1: 'none' },
	hint: "Uses the Worker's AI binding; no API key is needed.",
	budget: { day: DAY, used: 12, limit: 20000 }
};

/** System One on its own host: the row stores an origin, and the box is unticked. */
const system1OwnBase: AiSettingsWire = {
	...tokenlab,
	system1: { provider: 'openai-compatible', model: S1_MODEL, baseUrl: S1_BASE }
};

/**
 * An override that happens to equal the chat origin. Only the gateway's flag can
 * tell it from an inheritance, and the flag says the operator set it.
 */
const system1OwnEqualBase: AiSettingsWire = {
	...tokenlab,
	system1: {
		provider: 'openai-compatible',
		model: S1_MODEL,
		baseUrl: CHAT_BASE,
		inheritsBase: false
	}
};

/**
 * The document after a save that moved only the chat model. The Worker re-resolves
 * System One's effective base, which is why each echo keeps the row's own answer.
 */
const savedInherited: AiSettingsWire = { ...tokenlab, model: 'DeepSeek-V4.1-Flash' };
const savedOwn: AiSettingsWire = { ...system1OwnBase, model: 'DeepSeek-V4.1-Flash' };
const savedOwnEqual: AiSettingsWire = { ...system1OwnEqualBase, model: 'DeepSeek-V4.1-Flash' };

/** A Worker from before the two roles were split: no System One block at all. */
const system1NotReported: AiSettingsWire = { ...tokenlab, system1: null };

/** A document that names a provider for System One alone. */
const system1OtherProvider: AiSettingsWire = {
	...tokenlab,
	system1: { provider: 'workers-ai', model: 'clef', baseUrl: null }
};

/** The gateway wrote the document back: the chat model moved, System One did not. */
const savedDocument: AiSettingsWire = {
	...tokenlab,
	model: 'DeepSeek-V4.1-Flash',
	system1: { provider: 'openai-compatible', model: S1_MODEL, baseUrl: CHAT_BASE }
};

const spentBudget: AiSettingsWire = {
	...tokenlab,
	budget: { day: DAY, used: 20014, limit: 20000 }
};

/* ------------------------------------------------------------- catalogues */

/** Token Lab's own list, ten ids, no `owned_by` in the answer. */
const providerCatalogue = {
	provider: 'openai-compatible',
	source: 'provider',
	models: [
		{ id: 'Clef' },
		{ id: 'd3' },
		{ id: 'd3-flash' },
		{ id: 'DeepSeek-V4.1-Flash' },
		{ id: 'DeepSeek-V4-Flash' },
		{ id: 'Gemma-4-31B-IT' },
		{ id: 'MiniCPM5-2B' },
		{ id: 'MiniCPM-V-4.7-1B' },
		{ id: 'MiniCPM-V-4.7-35B-A3B' },
		{ id: 'Qwen3.8-27B' }
	]
};

/** Workers AI publishes no catalogue endpoint, so the gateway sends its own short list. */
const staticCatalogue = {
	provider: 'workers-ai',
	source: 'static',
	note: 'The AI binding has no catalog endpoint; these are the text models this gateway recommends.',
	models: [
		{ id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' },
		{ id: '@cf/meta/llama-3.1-8b-instruct' },
		{ id: '@cf/meta/llama-3.1-8b-instruct-fast' },
		{ id: '@cf/qwen/qwen2.5-coder-32b-instruct' }
	]
};

/* ------------------------------------------------------------ the probes */

/** One chat sample, from the provider the gateway holds. */
const chatSample = {
	ok: true,
	provider: 'openai-compatible',
	model: CHAT_MODEL,
	took_ms: 486,
	sample:
		'The gateway is up. One handset is paired, 246 messages are kept, and the last delivery was 4 minutes ago.'
};

/**
 * `handleSystem1Test`'s body: the Worker's fixed ticket, three typed questions,
 * and the numbers Token Lab returned for them, printed as they arrived.
 */
const system1Probe = {
	ok: true,
	provider: 'openai-compatible',
	model: 'clef',
	took_ms: 812,
	answers: {
		team: {
			id: 'team',
			type: 'choice',
			choice: 'Networking',
			probability: 0.83,
			confidence: 0.9,
			probabilities: { Accounts: 0.06, Billing: 0.11, Networking: 0.83, other: 0 }
		},
		urgent: { id: 'urgent', type: 'noul', probability: 0.12, confidence: 0.12 },
		severity: {
			id: 'severity',
			type: 'score',
			score: 2,
			probability: 0.71,
			confidence: 0.71,
			legend: ['Low', 'Medium', 'High'],
			probabilities: { '0': 0.05, '1': 0.24, '2': 0.71 }
		}
	}
};

/** The three known answers, plus one kind this console draws no row for. */
const system1ProbeUnknown = {
	...system1Probe,
	answers: {
		...system1Probe.answers,
		sentiment: { id: 'sentiment', type: 'sentiment', label: 'frustrated', probability: 0.62 }
	}
};

/* ----------------------------------------------------------- the agent runtime */

/** `GET /v1/admin/agent/runtime`, with the runtime on. */
const RUNTIME_ON = { enabled: true, schemaVersion: 1, sessions: 1, pinnedName: 'assistant' };
const RUNTIME_OFF = { enabled: false, schemaVersion: 1, sessions: 0, pinnedName: 'assistant' };

/**
 * `GET /v1/admin/agent/autonomy`. Caps and the day's usage are reported in both
 * states, so "off" and "open" differ in one fact, not in the shape of the card.
 */
const AUTONOMY_OFF = {
	enabled: false,
	expiresAt: null,
	caps: { sms: 3, writes: 3 },
	daily_sms_cap: 20,
	usage: { day: DAY, tokens: 12, writes: 0, sms: 0 }
};

/** A window this session opened, with both caps untouched. */
const AUTONOMY_MINE = {
	enabled: true,
	expiresAt: Date.now() + 43 * 60_000,
	actor: 'jony@example.com',
	mine: true,
	caps: { sms: 3, writes: 3 },
	daily_sms_cap: 20,
	usage: { day: DAY, tokens: 12, writes: 0, sms: 0 }
};

/** The same window, opened by the other operator on this deployment. */
const AUTONOMY_NOT_MINE = {
	...AUTONOMY_MINE,
	actor: 'rae.molina@example.com',
	mine: false
};

/**
 * What a deployment answers when the state under test is not about the agent:
 * runtime on, no window open, both caps untouched. The stub falls back to these,
 * so the autonomy card reads like the product in every other state.
 */
export const PRODUCT_RUNTIME = RUNTIME_ON;
export const PRODUCT_AUTONOMY = AUTONOMY_OFF;

const scenarios = {
	/* ------------------------------------------------------------------ data */
	loading: { session: 'owner', settings: HOLD },
	'load-failed-unreadable': {
		session: 'owner',
		// A 200 that is not a settings document: no provider, no model.
		settings: ok({ budget: { day: DAY, used: 12, limit: 20000 } })
	},
	'load-failed-unavailable': {
		session: 'owner',
		settings: unavailable(
			'missing_key',
			'AI_CHAT_API_KEY is not set, so the assistant has no provider to answer with'
		)
	},
	'load-failed-error': {
		session: 'owner',
		settings: { kind: 'json', status: 502, body: { error: 'internal_error' } }
	},
	'load-failed-refused': {
		session: 'owner',
		settings: {
			kind: 'json',
			status: 403,
			body: { error: 'forbidden', message: 'This account may not use the assistant.' }
		}
	},
	'load-failed-offline': { session: 'owner', settings: { kind: 'offline' } },
	'not-allowed': { session: 'member', settings: HOLD },

	/* -------------------------------------------------------------- provider */
	'workers-ai': { session: 'owner', settings: ok(workers) },
	'openai-compatible': { session: 'owner', settings: ok(tokenlab) },

	/* ------------------------------------------------------------------ keys */
	'keys-shared': { session: 'owner', settings: ok(tokenlab) },
	'keys-split': { session: 'owner', settings: ok(splitKeys) },
	'key-chat-missing': { session: 'owner', settings: ok(chatKeyMissing) },
	'key-system1-missing': { session: 'owner', settings: ok(system1KeyMissing) },
	'keys-both-missing': { session: 'owner', settings: ok(bothKeysMissing) },
	'keys-unreported': { session: 'owner', settings: ok(keySourceUnreported) },
	'key-gateway-hint': { session: 'owner', settings: ok(tokenlab) },

	/* ----------------------------------------------------------- system one */
	// No flag and a base equal to the chat one: the direct comparison says inherited,
	// so the row shows no base field and Save sends no `baseUrl`.
	'system1-inherits': {
		session: 'owner',
		settings: ok(tokenlab),
		save: ok(savedInherited)
	},
	// The gateway says the row stores its own origin, and that origin equals the
	// chat one: only the flag can tell this from an inheritance.
	'system1-own-equal-base': {
		session: 'owner',
		settings: ok(system1OwnEqualBase),
		save: ok(savedOwnEqual)
	},
	// No flag and a differing base: the comparison says the operator's own, so the
	// field is there, prefilled, and Save sends it.
	'system1-own-base': {
		session: 'owner',
		settings: ok(system1OwnBase),
		save: ok(savedOwn)
	},
	'system1-not-reported': {
		session: 'owner',
		settings: ok(system1NotReported),
		// The Worker answers the save with the block the row now stores.
		save: ok(tokenlab)
	},
	'system1-workers-ai': { session: 'owner', settings: ok(workers) },
	'system1-other-provider': { session: 'owner', settings: ok(system1OtherProvider) },
	// The row stores a base the gateway refuses before it asks anyone.
	'system1-base-refused': {
		session: 'owner',
		settings: ok(system1OwnBase),
		save: {
			kind: 'json',
			status: 400,
			body: { error: 'bad_request', message: 'system1_base_url is invalid' }
		},
		act: [{ do: 's1base', value: 'http://clef.tokenlab.amd.com/v1' }, { do: 'save' }]
	},

	/* ------------------------------------------------------------- catalogue */
	'catalogue-idle': { session: 'owner', settings: ok(tokenlab) },
	'models-loading': { session: 'owner', settings: ok(tokenlab), models: HOLD, act: [{ do: 'models' }] },
	'models-loaded': {
		session: 'owner',
		settings: ok(tokenlab),
		models: ok(providerCatalogue),
		act: [{ do: 'models' }]
	},
	'models-static': {
		session: 'owner',
		settings: ok(workers),
		models: ok(staticCatalogue),
		act: [{ do: 'models' }]
	},
	'models-empty': {
		session: 'owner',
		settings: ok(tokenlab),
		models: ok({ provider: 'openai-compatible', source: 'provider', models: [] }),
		act: [{ do: 'models' }]
	},
	'models-picked': {
		session: 'owner',
		settings: ok(tokenlab),
		models: ok(providerCatalogue),
		act: [{ do: 'models' }, { do: 'pick', value: 'MiniCPM-V-4.7-35B-A3B' }]
	},
	'models-provider-changed': {
		session: 'owner',
		settings: ok(tokenlab),
		models: ok(providerCatalogue),
		// Loaded for the saved provider, then the select moved: the list is the
		// other provider's, and the page says so rather than pretending.
		act: [{ do: 'models' }, { do: 'provider', value: 'workers-ai' }]
	},
	'models-auth-failed': {
		session: 'owner',
		settings: ok(tokenlab),
		models: unavailable('provider_auth', 'the provider refused the key while listing models'),
		act: [{ do: 'models' }]
	},
	'models-rate-limited': {
		session: 'owner',
		settings: ok(tokenlab),
		models: unavailable('provider_rate_limited', 'the provider is rate limiting this key', '30'),
		act: [{ do: 'models' }]
	},
	'models-missing-key': {
		session: 'owner',
		settings: ok(chatKeyMissing),
		models: unavailable(
			'missing_key',
			'AI_CHAT_API_KEY is not set; add it with `cf workers secrets update AI_CHAT_API_KEY --worker dakflare-worker --type secret_text`'
		),
		act: [{ do: 'models' }]
	},
	'models-missing-base': {
		session: 'owner',
		// No origin stored at all: the row has nothing to ask, and System One
		// inherits the same absence rather than a stale URL.
		settings: ok({
			...tokenlab,
			baseUrl: null,
			system1: { provider: 'openai-compatible', model: S1_MODEL, baseUrl: null }
		}),
		models: unavailable('missing_base_url', 'openai-compatible needs a baseUrl before it has models'),
		act: [{ do: 'models' }]
	},
	'models-bad-base': {
		session: 'owner',
		settings: ok({ ...tokenlab, baseUrl: 'ftp://api.tokenlab.amd.com/v1' }),
		models: unavailable('bad_base_url', 'baseUrl must be https, or http on localhost'),
		act: [{ do: 'models' }]
	},
	'models-unavailable': {
		session: 'owner',
		settings: ok(tokenlab),
		models: unavailable('provider_unavailable', 'the provider could not be reached: TypeError: fetch failed'),
		act: [{ do: 'models' }]
	},
	'models-unparseable': {
		session: 'owner',
		settings: ok(tokenlab),
		models: unavailable('unparseable', 'the provider sent no data[] in its model list'),
		act: [{ do: 'models' }]
	},
	'models-refused': {
		session: 'owner',
		settings: ok(tokenlab),
		models: {
			kind: 'json',
			status: 403,
			body: { error: 'forbidden', message: 'This account may not use the assistant.' }
		},
		act: [{ do: 'models' }]
	},
	'models-offline': { session: 'owner', settings: ok(tokenlab), models: { kind: 'offline' }, act: [{ do: 'models' }] },

	/* ------------------------------------------------------------- allowance */
	'budget-counted': { session: 'owner', settings: ok(tokenlab) },
	'budget-spent': { session: 'owner', settings: ok(spentBudget) },
	'budget-unreported': {
		session: 'owner',
		settings: ok({ ...tokenlab, budget: { day: null, used: null, limit: null } })
	},
	'budget-no-ceiling': {
		session: 'owner',
		settings: ok({ ...tokenlab, budget: { day: DAY, used: 0, limit: 0 } })
	},

	/* ------------------------------------------------------------------ save */
	dirty: {
		session: 'owner',
		settings: ok(tokenlab),
		act: [{ do: 'model', value: 'DeepSeek-V4.1-Flash' }]
	},
	'field-error-model': {
		session: 'owner',
		settings: ok(tokenlab),
		act: [{ do: 'model', value: '' }, { do: 'save' }]
	},
	'field-error-base': {
		session: 'owner',
		settings: ok(workers),
		act: [{ do: 'provider', value: 'openai-compatible' }, { do: 'save' }]
	},
	'field-error-base-scheme': {
		session: 'owner',
		settings: ok(workers),
		act: [
			{ do: 'provider', value: 'openai-compatible' },
			{ do: 'model', value: CHAT_MODEL },
			{ do: 'base', value: 'api.tokenlab.amd.com/v1' },
			{ do: 'save' }
		]
	},
	'field-error-system1-model': {
		session: 'owner',
		settings: ok(tokenlab),
		act: [{ do: 's1model', value: '' }, { do: 'save' }]
	},
	// The operator's own path to an empty own origin: start inherited, untick the box,
	// type nothing. The document here must be the *inheriting* one; an own-base
	// document would already hold an origin and Save would send that instead.
	'field-error-system1-base': {
		session: 'owner',
		settings: ok(tokenlab),
		act: [{ do: 'inheritbase', value: false }, { do: 'save' }]
	},
	'field-error-system1-base-scheme': {
		session: 'owner',
		settings: ok(tokenlab),
		act: [
			{ do: 'inheritbase', value: false },
			{ do: 's1base', value: 'clef.tokenlab.amd.com/v1' },
			{ do: 'save' }
		]
	},
	saving: {
		session: 'owner',
		settings: ok(tokenlab),
		save: HOLD,
		act: [{ do: 'model', value: 'DeepSeek-V4.1-Flash' }, { do: 'save' }]
	},
	saved: {
		session: 'owner',
		settings: ok(tokenlab),
		save: ok(savedDocument),
		act: [{ do: 'model', value: 'DeepSeek-V4.1-Flash' }, { do: 'save' }]
	},
	'save-refused': {
		session: 'owner',
		settings: ok(tokenlab),
		save: {
			kind: 'json',
			status: 400,
			body: { error: 'bad_request', message: 'baseUrl must be https, or http on localhost' }
		},
		act: [{ do: 'base', value: 'http://api.tokenlab.amd.com/v1' }, { do: 'save' }]
	},

	/* ------------------------------------------------------------- chat test */
	testing: { session: 'owner', settings: ok(tokenlab), test: HOLD, act: [{ do: 'test' }] },
	'test-ok': { session: 'owner', settings: ok(tokenlab), test: ok(chatSample), act: [{ do: 'test' }] },
	'test-unavailable': {
		session: 'owner',
		settings: ok(tokenlab),
		test: unavailable('provider_unavailable', 'the provider could not be reached: TypeError: fetch failed'),
		act: [{ do: 'test' }]
	},
	'test-exhausted': {
		session: 'owner',
		settings: ok(spentBudget),
		test: { kind: 'json', status: 429, body: { error: 'budget_exhausted', used: 20014, limit: 20000 } },
		act: [{ do: 'test' }]
	},
	'test-rate-limited': {
		session: 'owner',
		settings: ok(tokenlab),
		test: { kind: 'json', status: 429, body: { error: 'rate_limited' } },
		act: [{ do: 'test' }]
	},
	'test-unreadable': {
		session: 'owner',
		settings: ok(tokenlab),
		// A 200 with no sample in it: read as "cannot read", never as a sample.
		test: ok({ ok: true, provider: 'openai-compatible', took_ms: 300 }),
		act: [{ do: 'test' }]
	},
	'test-refused': {
		session: 'owner',
		settings: ok(tokenlab),
		test: {
			kind: 'json',
			status: 403,
			body: { error: 'forbidden', message: 'This account may not use the assistant.' }
		},
		act: [{ do: 'test' }]
	},

	/* -------------------------------------------------------- system one test */
	'system1-testing': {
		session: 'owner',
		settings: ok(tokenlab),
		system1Test: HOLD,
		act: [{ do: 's1test' }]
	},
	'system1-test-ok': {
		session: 'owner',
		settings: ok(tokenlab),
		system1Test: ok(system1Probe),
		act: [{ do: 's1test' }]
	},
	'system1-test-unknown': {
		session: 'owner',
		settings: ok(tokenlab),
		system1Test: ok(system1ProbeUnknown),
		act: [{ do: 's1test' }]
	},
	'system1-test-refused': {
		session: 'owner',
		settings: ok(tokenlab),
		system1Test: unavailable('provider_auth', 'the provider refused the System One key'),
		act: [{ do: 's1test' }]
	},
	'system1-test-rate-limited': {
		session: 'owner',
		settings: ok(tokenlab),
		system1Test: unavailable('provider_rate_limited', 'the provider is rate limiting this key', '30'),
		act: [{ do: 's1test' }]
	},
	'system1-test-refused-account': {
		session: 'owner',
		settings: ok(tokenlab),
		system1Test: {
			kind: 'json',
			status: 403,
			body: { error: 'forbidden', message: 'This account may not use the assistant.' }
		},
		act: [{ do: 's1test' }]
	},
	'system1-test-unreadable': {
		session: 'owner',
		settings: ok(tokenlab),
		// 200, and no answers in it: not a sample of anything.
		system1Test: ok({ ok: true, provider: 'openai-compatible', took_ms: 240, answers: {} }),
		act: [{ do: 's1test' }]
	},

	/* ------------------------------------------------------------- autonomy */
	// The settings answered, and the two agent reads have not: the card is honest
	// about reading rather than guessing "off".
	'autonomy-reading': {
		session: 'owner',
		settings: ok(tokenlab),
		runtime: HOLD,
		autonomy: HOLD
	},
	'autonomy-off': {
		session: 'owner',
		settings: ok(tokenlab),
		runtime: ok(RUNTIME_ON),
		autonomy: ok(AUTONOMY_OFF)
	},
	// The deployment's own ceiling, saved as 60 rather than the Worker's default
	// 20: the field must show what the gateway sent, not a number this page made up.
	'autonomy-daily-cap': {
		session: 'owner',
		settings: ok(tokenlab),
		runtime: ok(RUNTIME_ON),
		autonomy: ok({ ...AUTONOMY_OFF, daily_sms_cap: 60 })
	},
	'autonomy-armed': {
		session: 'owner',
		settings: ok(tokenlab),
		runtime: ok(RUNTIME_ON),
		autonomy: ok(AUTONOMY_OFF),
		act: [{ do: 'ack' }]
	},
	'autonomy-open': {
		session: 'owner',
		settings: ok(tokenlab),
		runtime: ok(RUNTIME_ON),
		autonomy: ok(AUTONOMY_MINE)
	},
	'autonomy-open-not-mine': {
		session: 'owner',
		settings: ok(tokenlab),
		runtime: ok(RUNTIME_ON),
		autonomy: ok(AUTONOMY_NOT_MINE)
	},
	'autonomy-cap-spent': {
		session: 'owner',
		settings: ok(tokenlab),
		runtime: ok(RUNTIME_ON),
		autonomy: ok({
			...AUTONOMY_MINE,
			usage: { day: DAY, tokens: 26915, writes: 3, sms: 3 }
		})
	},
	'autonomy-sms-cap-spent': {
		session: 'owner',
		settings: ok(tokenlab),
		runtime: ok(RUNTIME_ON),
		autonomy: ok({
			...AUTONOMY_MINE,
			usage: { day: DAY, tokens: 8124, writes: 1, sms: 3 }
		})
	},
	'autonomy-opening': {
		session: 'owner',
		settings: ok(tokenlab),
		runtime: ok(RUNTIME_ON),
		autonomy: ok(AUTONOMY_OFF),
		autonomyPost: HOLD,
		act: [{ do: 'ack' }, { do: 'open-window' }]
	},
	'autonomy-revoking': {
		session: 'owner',
		settings: ok(tokenlab),
		runtime: ok(RUNTIME_ON),
		autonomy: ok(AUTONOMY_MINE),
		autonomyDelete: HOLD,
		act: [{ do: 'revoke' }]
	},
	'autonomy-runtime-off': {
		session: 'owner',
		settings: ok(tokenlab),
		runtime: ok(RUNTIME_OFF),
		autonomy: ok(AUTONOMY_OFF)
	},
	'autonomy-runtime-unavailable': {
		session: 'owner',
		settings: ok(tokenlab),
		runtime: unavailable('agent_runtime_off', 'the agent runtime is not enabled on this deployment'),
		autonomy: ok(AUTONOMY_OFF)
	},
	'autonomy-runtime-unreadable': {
		session: 'owner',
		settings: ok(tokenlab),
		runtime: ok({ enabled: 'yes' }),
		autonomy: ok(AUTONOMY_OFF)
	},
	'autonomy-unreadable': {
		session: 'owner',
		settings: ok(tokenlab),
		runtime: ok(RUNTIME_ON),
		autonomy: ok({ enabled: 'yes' })
	},
	'autonomy-refused': {
		session: 'owner',
		settings: ok(tokenlab),
		runtime: ok(RUNTIME_ON),
		autonomy: {
			kind: 'json',
			status: 403,
			body: { error: 'forbidden', message: 'Only an owner may change autonomy on this deployment.' }
		}
	},
	'autonomy-offline': {
		session: 'owner',
		settings: ok(tokenlab),
		runtime: ok(RUNTIME_ON),
		autonomy: { kind: 'offline' }
	},
	// No agent routes at all: an older Worker, said plainly and without alarm.
	'autonomy-missing': {
		session: 'owner',
		settings: ok(tokenlab),
		runtime: { kind: 'json', status: 404, body: { error: 'not_found' } },
		autonomy: { kind: 'json', status: 404, body: { error: 'not_found' } }
	},
	'autonomy-open-refused': {
		session: 'owner',
		settings: ok(tokenlab),
		runtime: ok(RUNTIME_ON),
		autonomy: ok(AUTONOMY_OFF),
		autonomyPost: {
			kind: 'json',
			status: 403,
			body: { error: 'forbidden', message: 'Only an owner may change autonomy on this deployment.' }
		},
		act: [{ do: 'ack' }, { do: 'open-window' }]
	}
} satisfies Record<string, Scenario>;

/** The keys stay literal; each value is `Scenario`, so `act` is the optional field it is. */
export type StateKey = keyof typeof scenarios;

export const SCENARIOS: Record<StateKey, Scenario> = scenarios;

export const DEFAULT_STATE: StateKey = 'openai-compatible';

export function isStateKey(value: string): value is StateKey {
	return Object.prototype.hasOwnProperty.call(SCENARIOS, value);
}

/** The switcher, in the order the page reads: what it fetched, then what it can do. */
export const STATE_GROUPS: ReadonlyArray<{
	label: string;
	states: ReadonlyArray<{ key: StateKey; label: string }>;
}> = [
	{
		label: 'Data',
		states: [
			{ key: 'loading', label: 'Reading the settings' },
			{ key: 'load-failed-unreadable', label: 'Answer is not a document' },
			{ key: 'load-failed-unavailable', label: 'No provider (503) + key command' },
			{ key: 'load-failed-error', label: 'Gateway error (502) + key command' },
			{ key: 'load-failed-refused', label: 'Account refused (403)' },
			{ key: 'load-failed-offline', label: 'Gateway did not answer' },
			{ key: 'not-allowed', label: 'A member signed in' }
		]
	},
	{
		label: 'Provider',
		states: [
			{ key: 'workers-ai', label: 'Workers AI: no base URL, no key' },
			{ key: 'openai-compatible', label: 'OpenAI-compatible: base URL and key' }
		]
	},
	{
		label: 'Keys',
		states: [
			{ key: 'keys-shared', label: 'One secret answers both roles' },
			{ key: 'keys-split', label: 'A secret per role' },
			{ key: 'key-chat-missing', label: 'Chat has no key' },
			{ key: 'key-system1-missing', label: 'System One has no key' },
			{ key: 'keys-both-missing', label: 'Neither role has a key' },
			{ key: 'keys-unreported', label: 'Older Worker names no secret' },
			{ key: 'key-gateway-hint', label: "The gateway's own hint" }
		]
	},
	{
		label: 'System One',
		states: [
			{ key: 'system1-inherits', label: 'Base inherited (equal URL, no flag)' },
			{ key: 'system1-own-equal-base', label: 'Own base that equals the chat URL' },
			{ key: 'system1-own-base', label: 'Own base on its own host' },
			{ key: 'system1-not-reported', label: 'No block: placeholder, clean' },
			{ key: 'system1-workers-ai', label: 'Workers AI: the three aliases' },
			{ key: 'system1-other-provider', label: 'Runs on another provider' },
			{ key: 'system1-base-refused', label: 'Stored base refused (400)' }
		]
	},
	{
		label: 'Catalogue',
		states: [
			{ key: 'catalogue-idle', label: 'Not asked for yet' },
			{ key: 'models-loading', label: 'Loading, holds still' },
			{ key: 'models-loaded', label: "The provider's ten ids" },
			{ key: 'models-static', label: 'Workers AI: static list + note' },
			{ key: 'models-empty', label: 'The provider listed none' },
			{ key: 'models-picked', label: 'One id picked, unsaved' },
			{ key: 'models-provider-changed', label: 'List from another provider' },
			{ key: 'models-auth-failed', label: 'Key refused (503)' },
			{ key: 'models-rate-limited', label: 'Rate limited + retry after' },
			{ key: 'models-missing-key', label: 'No key to ask with' },
			{ key: 'models-missing-base', label: 'No base URL saved' },
			{ key: 'models-bad-base', label: 'Base URL refused first' },
			{ key: 'models-unavailable', label: 'Provider unreachable' },
			{ key: 'models-unparseable', label: 'No data[] to read' },
			{ key: 'models-refused', label: 'Account refused (403)' },
			{ key: 'models-offline', label: 'Gateway did not answer' }
		]
	},
	{
		label: 'Allowance',
		states: [
			{ key: 'budget-counted', label: 'Counted, 12 / 20000' },
			{ key: 'budget-spent', label: 'Spent, past the ceiling' },
			{ key: 'budget-unreported', label: 'Not reported, dashes' },
			{ key: 'budget-no-ceiling', label: 'Reported as 0 / 0' }
		]
	},
	{
		label: 'Save',
		states: [
			{ key: 'dirty', label: 'Unsaved change' },
			{ key: 'field-error-model', label: 'Model left empty' },
			{ key: 'field-error-base', label: 'Base URL left empty' },
			{ key: 'field-error-base-scheme', label: 'Base URL without a scheme' },
			{ key: 'field-error-system1-model', label: 'System One model left empty' },
			{ key: 'field-error-system1-base', label: 'Own base left empty' },
			{ key: 'field-error-system1-base-scheme', label: 'Own base without a scheme' },
			{ key: 'saving', label: 'Saving, holds still' },
			{ key: 'saved', label: 'Saved, document came back' },
			{ key: 'save-refused', label: 'Refused (400)' }
		]
	},
	{
		label: 'Chat test',
		states: [
			{ key: 'testing', label: 'Testing, holds still' },
			{ key: 'test-ok', label: 'One sample answer' },
			{ key: 'test-unavailable', label: 'Provider unavailable (503)' },
			{ key: 'test-exhausted', label: 'Allowance spent (429)' },
			{ key: 'test-rate-limited', label: 'Rate limited (429)' },
			{ key: 'test-unreadable', label: 'No sample in the answer' },
			{ key: 'test-refused', label: 'Account refused (403)' }
		]
	},
	{
		label: 'System One test',
		states: [
			{ key: 'system1-testing', label: 'Asking, holds still' },
			{ key: 'system1-test-ok', label: 'Choice, noul, score' },
			{ key: 'system1-test-unknown', label: 'One answer this page cannot draw' },
			{ key: 'system1-test-refused', label: 'Key refused (503)' },
			{ key: 'system1-test-rate-limited', label: 'Rate limited + retry after' },
			{ key: 'system1-test-refused-account', label: 'Account refused (403)' },
			{ key: 'system1-test-unreadable', label: 'No answers in the body' }
		]
	},
	{
		label: 'Autonomy',
		states: [
			{ key: 'autonomy-reading', label: 'Reading the window' },
			{ key: 'autonomy-off', label: 'Off, runtime on, form inert' },
			{ key: 'autonomy-daily-cap', label: 'Daily SMS cap saved (60)' },
			{ key: 'autonomy-armed', label: 'Acknowledged, button live' },
			{ key: 'autonomy-open', label: 'Open for this session' },
			{ key: 'autonomy-open-not-mine', label: 'Open, another operator' },
			{ key: 'autonomy-cap-spent', label: 'Open, both caps spent' },
			{ key: 'autonomy-sms-cap-spent', label: 'Open, SMS cap spent' },
			{ key: 'autonomy-opening', label: 'Opening, holds still' },
			{ key: 'autonomy-revoking', label: 'Revoking, holds still' },
			{ key: 'autonomy-runtime-off', label: 'Runtime off' },
			{ key: 'autonomy-runtime-unavailable', label: 'No runtime route (503)' },
			{ key: 'autonomy-runtime-unreadable', label: 'Runtime unreadable' },
			{ key: 'autonomy-unreadable', label: 'Window unreadable' },
			{ key: 'autonomy-refused', label: 'Window refused (403)' },
			{ key: 'autonomy-offline', label: 'Gateway did not answer' },
			{ key: 'autonomy-missing', label: 'No agent routes (404)' },
			{ key: 'autonomy-open-refused', label: 'Open refused (403)' }
		]
	}
];
