/**
 * The assistant, and the deployment's AI settings.
 *
 * Four endpoints, and the console reads every one of them the same way: assume
 * nothing, and answer with the plainest true sentence when the endpoint does not
 * answer the question that was asked.
 *
 *   GET  /v1/admin/ai/settings                     provider, both roles, key names, budget
 *   PUT  /v1/admin/ai/settings                     the same document, written back
 *   GET  /v1/admin/ai/models                       the models the saved provider lists
 *   POST /v1/admin/ai/test                         one sample answer from the provider
 *   POST /v1/admin/ai/system1/test                 one fixed routing decision, in three answers
 *   POST /v1/admin/assistant/chat                  one answer, and proposals
 *   POST /v1/admin/agent/say                       one answer, kept in the operator's conversation
 *   POST /v1/admin/assistant/proposals/:id/accept  the only write a proposal makes
 *
 * One provider answers both roles: chat, and System One (the routing decision
 * that runs before a reply). They are two *selections* and two *secrets*: the
 * settings document carries System One's effective model and base, and
 * `keySource` names the secret each role read. This module keeps the names and
 * nothing else — there is still no key value in this browser.
 *
 * Three things this module is strict about, because they are the ones that cost
 * an operator real time when they are fudged:
 *
 *  1. The key never exists in this browser. There is no field for it, no state
 *     for it and no parameter for it; `cf workers secrets update` on the Worker
 *     is a deployment step the settings screen explains rather than imitates.
 *  2. `used` and `limit` are `number | null`, not `number`. A zero the gateway
 *     never sent would read as "you have used none of today's allowance", which
 *     is a different and safer-sounding fact than "nobody said".
 *  3. A 200 whose body is not JSON is an answer, not an error: the gateway
 *     answered in plain text, so the panel shows that text and no proposal cards.
 *     JSON that cannot be read is its own state, and it never falls back to text.
 *
 * `stage_workflow_patch` is the one proposal kind this module does not send
 * anywhere. The editor owns staging (its own ghost banner, its own accept), so
 * the patch is handed over through `registerWorkflowPatchSink` and nothing here
 * calls the accept endpoint for it.
 */

/** How long one call may take before the console stops waiting. */
const ASSISTANT_TIMEOUT_MS = 20_000;

/** The Worker contract's routing marker; it is not a secret. */
const ADMIN_HEADER = 'X-Admin-Session';

/* ------------------------------------------------------------------ types */

export type AiProvider = 'workers-ai' | 'openai-compatible';

/** The two roles a key can answer. They may resolve to different secrets. */
export type AiRole = 'chat' | 'system1';

/**
 * The name of the secret that answered a role. `AI_PROVIDER_API_KEY`,
 * `AI_CHAT_API_KEY` and `TOKENLAB_API_KEY` are the three this deployment reads;
 * a name added later still arrives here as a name, and is printed as one.
 *
 * `none` is the gateway's word for "this role has no key". No value of any kind
 * is ever part of this document.
 */
export type KeySource = string;

export interface AiKeySource {
	chat: KeySource;
	system1: KeySource;
}

/**
 * System One's *effective* selection: the gateway resolves the row's fallback
 * before it answers, so `model` and `baseUrl` are already what a routing call
 * would use, whether or not the row set its own.
 *
 * `baseUrl` is `null` for Workers AI, which has no origin at all.
 */
export interface AiSystem1 {
	model: string;
	provider: AiProvider;
	baseUrl: string | null;
	/**
	 * Whether the base above is the chat origin because the row stores none.
	 * The gateway reports it: two equal URLs cannot tell an inherited base from
	 * an explicit override, and guessing drops the override on the next save.
	 * Absent from an older Worker, where the page falls back to comparing.
	 */
	inheritsBase?: boolean;
}

/**
 * Today's allowance as the gateway reports it. `null` is "not said", and the
 * settings page prints a dash rather than a zero.
 */
export interface AiBudget {
	/** The day the count belongs to. Never guessed from the browser's clock. */
	day: string | null;
	used: number | null;
	limit: number | null;
}

export interface AiSettings {
	provider: AiProvider;
	model: string;
	baseUrl: string;
	/**
	 * `null` when the gateway sent no System One block. That is a gateway from
	 * before the two roles were split, and the honest reading is the one the page
	 * prints: System One answers with the chat model, because there is nothing
	 * else it could answer with.
	 */
	system1: AiSystem1 | null;
	apiKeyConfigured: boolean;
	/**
	 * `null` when the gateway did not say. The page then reports the absence
	 * rather than guessing a secret name it was not given.
	 */
	keySource: AiKeySource | null;
	/** The gateway's own suggestion, if it sent one. Rendered when present. */
	hint: string | null;
	budget: AiBudget;
}

/**
 * What `PUT` accepts. There is no key field: the type says so out loud.
 *
 * A member of `system1` that is absent is a *replacement*: the Worker clears the
 * stored column, which reads back as "use the chat value". That is why the page
 * sends `system1: {}` for a role that inherits everything — an omitted object
 * would leave an older own model in place.
 */
export interface AiSystem1Input {
	/** The decision model. It never inherits the chat model. */
	model?: string;
	/** Omit to inherit the chat base URL. Refused by Workers AI, which has none. */
	baseUrl?: string;
}

export interface AiSettingsInput {
	provider: AiProvider;
	model: string;
	/** Empty for Workers AI: it has no base URL, and one is refused. */
	baseUrl: string;
	system1: AiSystem1Input;
}

/** Why a request did not produce the thing that was asked for. */
export type Failure =
	| { kind: 'unavailable'; detail: string | null }
	| { kind: 'exhausted'; used: number | null; limit: number | null; day: string | null }
	| { kind: 'rate-limited' }
	| { kind: 'refused'; message: string }
	| { kind: 'offline' }
	| { kind: 'unreadable' }
	| { kind: 'error'; status: number };

export type FailureKind = Failure['kind'];

export interface AiSettingsOutcomeOk {
	status: 'ok';
	settings: AiSettings;
}

export type AiSettingsOutcome = AiSettingsOutcomeOk | { status: 'failed'; failure: Failure };

/** One thing the assistant suggests. `payload` is whatever the endpoint sent. */
export interface Proposal {
	id: string;
	kind: string;
	title: string;
	summary: string;
	payload: unknown;
}

export type ChatOutcome =
	/**
	 * `withheld` is the gateway refusing its own model: a proposal it dropped
	 * (an impossible operation, an oversized payload) is reported here rather
	 * than vanishing, so the operator is never left wondering why a card is
	 * missing from an answer that mentions one.
	 */
	| { status: 'ok'; answer: string; proposals: Proposal[]; withheld: string[] }
	| { status: 'plain'; text: string }
	| { status: 'failed'; failure: Failure };

export type TestOutcome =
	| { status: 'ok'; sample: string; model: string | null }
	| { status: 'failed'; failure: Failure };

/**
 * Where a catalogue came from. `static` is the Workers AI binding, which has no
 * catalog endpoint: the gateway sent a short list of its own and says so, and a
 * page that printed it as a published catalogue would be putting words in the
 * provider's mouth.
 */
export type ModelSource = 'provider' | 'static';

/** One model, in the provider's own name. `owned_by` is printed, never interpreted. */
export interface AiModel {
	id: string;
	ownedBy: string | null;
}

/**
 * The `reason` a 503 from `/v1/admin/ai/models` carries. `bad_base_url` is the
 * one the Worker refuses before it ever asks the provider; the rest are answers
 * the provider gave the Worker. A reason this console does not know reads as
 * `null` and keeps the gateway's own message, rather than being guessed at.
 */
export type ModelsFailureReason =
	| 'missing_key'
	| 'missing_base_url'
	| 'bad_base_url'
	| 'provider_auth'
	| 'provider_rate_limited'
	| 'provider_unavailable'
	| 'unparseable';

export type ModelsOutcome =
	| {
			status: 'ok';
			provider: AiProvider;
			source: ModelSource;
			/** The gateway's sentence about where the list came from, if it sent one. */
			note: string | null;
			models: AiModel[];
	  }
	| {
			status: 'failed';
			failure: Failure;
			/** The 503's machine-readable reason; `null` when there was no 503 to read. */
			reason: ModelsFailureReason | null;
			/** The provider's own `Retry-After`, as it arrived, for a rate-limited list. */
			retryAfter: string | null;
	  };

export type AcceptOutcome =
	| { status: 'ok'; message: string; ids: string[]; detail: string | null }
	| { status: 'failed'; failure: Failure };

/** What the panel tells the endpoint about where the operator is standing. */
export interface AssistantContext {
	route?: string;
	flowId?: string;
}

/* --------------------------------------------------------------- reading */

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
	return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function readFinite(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readProvider(value: unknown): AiProvider | null {
	if (value === 'workers-ai' || value === 'openai-compatible') return value;
	return null;
}

/** `day` is a label, not arithmetic: a number or a date string both print fine. */
function readDay(value: unknown): string | null {
	if (typeof value === 'string' && value.trim() !== '') return value;
	if (typeof value === 'number' && Number.isFinite(value)) return String(value);
	return null;
}

/**
 * One role's secret name, as the Worker resolved it.
 *
 * Any non-empty string is a name and is printed as it arrived: a console that
 * recognised only the three it knows would have to either hide a name it does
 * not recognise or silently call it "no key", and the second one would send an
 * operator looking for a deployment step that is not needed.
 */
function readKeySource(value: unknown): KeySource | null {
	return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function readKeySources(value: unknown): AiKeySource | null {
	if (!isRecord(value)) return null;
	const chat = readKeySource(value.chat);
	const system1 = readKeySource(value.system1);
	// Both or neither: half a document is not one this console can print.
	if (chat === null || system1 === null) return null;
	return { chat, system1 };
}

/**
 * System One's effective block. `model` is what decides whether the group shows
 * an own model or an inheritance, so a block without one is not readable.
 */
function readSystem1(value: unknown): AiSystem1 | null {
	if (!isRecord(value)) return null;
	const provider = readProvider(value.provider);
	if (provider === null || typeof value.model !== 'string') return null;
	return {
		model: value.model,
		provider,
		baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl : null,
		// Keep the gateway's own answer. Dropping it forced the page to compare
		// two URLs, which cannot tell an inherited origin from an override that
		// happens to equal the chat one.
		...(typeof value.inheritsBase === 'boolean' ? { inheritsBase: value.inheritsBase } : {})
	};
}

/**
 * Whether the System One origin is the operator's own rather than the chat one.
 *
 * The gateway reports it. Only when an older Worker does not is the comparison
 * used, and then it is direct: equal URLs mean inherited, differing ones mean an
 * override. The previous expression negated the comparison twice, so an equal
 * base read as "own" and a differing one as "inherited" — and saving in that
 * state cleared a stored origin.
 */
export function system1BaseIsOwn(
	system1: { inheritsBase?: boolean; baseUrl: string | null } | null,
	chatBase: string | null
): boolean {
	if (system1 === null) return false;
	if (typeof system1.inheritsBase === 'boolean') return system1.inheritsBase === false;
	// No stored origin is the inherit case, whatever the chat base is.
	const stored = system1.baseUrl ?? '';
	if (stored === '') return false;
	return stored !== (chatBase ?? '');
}

function readSettings(value: unknown): AiSettings | null {
	if (!isRecord(value)) return null;
	const provider = readProvider(value.provider);
	// A model is what the provider is called with; without one there is nothing
	// to show and nothing to save, so the page says it could not read the answer.
	const model = typeof value.model === 'string' ? value.model : null;
	if (provider === null || model === null) return null;
	const budget = isRecord(value.budget) ? value.budget : {};
	return {
		provider,
		model,
		baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl : '',
		system1: readSystem1(value.system1),
		apiKeyConfigured: value.apiKeyConfigured === true,
		keySource: readKeySources(value.keySource),
		hint: readString(value.hint),
		budget: {
			day: readDay(budget.day),
			used: readFinite(budget.used),
			limit: readFinite(budget.limit)
		}
	};
}

function readBudget(value: unknown): Pick<Extract<Failure, { kind: 'exhausted' }>, 'used' | 'limit' | 'day'> {
	const source = isRecord(value) ? (isRecord(value.budget) ? value.budget : value) : {};
	return { used: readFinite(source.used), limit: readFinite(source.limit), day: readDay(source.day) };
}

/**
 * The reasons the gateway withheld a proposal. Server-authored text, printed as
 * it arrived: nothing here is rewritten into a friendlier sentence.
 */
function readWithheld(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const reasons: string[] = [];
	for (const entry of value) {
		if (!isRecord(entry)) continue;
		const reason = readString(entry.reason);
		if (reason === null || reason === '') continue;
		const kind = readString(entry.kind);
		reasons.push(kind === null ? reason : `${kind}: ${reason}`);
	}
	return reasons;
}

function readProposals(value: unknown): Proposal[] {
	if (!Array.isArray(value)) return [];
	const proposals: Proposal[] = [];
	for (const entry of value) {
		if (!isRecord(entry)) continue;
		const id = readString(entry.id);
		const kind = readString(entry.kind);
		const title = readString(entry.title);
		if (id === null || kind === null || title === null) continue;
		proposals.push({
			id,
			kind,
			title,
			summary: typeof entry.summary === 'string' ? entry.summary : '',
			payload: entry.payload
		});
	}
	return proposals;
}

/** The endpoint's own sentences, in the order they are worth trusting. */
function serverMessage(value: unknown): string | null {
	if (!isRecord(value)) return null;
	return (
		readString(value.message) ??
		readString(value.detail) ??
		readString(value.hint) ??
		readString(value.error)
	);
}

/* ------------------------------------------------------------- transport */

interface Raw {
	status: number;
	ok: boolean;
	json: unknown;
	text: string;
	timedOut: boolean;
}

async function call(path: string, init: RequestInit = {}): Promise<Raw> {
	const headers = new Headers(init.headers);
	headers.set('Accept', 'application/json');
	headers.set(ADMIN_HEADER, '1');
	if (init.body !== undefined && init.body !== null && !headers.has('Content-Type')) {
		headers.set('Content-Type', 'application/json');
	}

	let response: Response;
	try {
		response = await fetch(path, {
			...init,
			headers,
			credentials: 'same-origin',
			signal: init.signal ?? AbortSignal.timeout(ASSISTANT_TIMEOUT_MS)
		});
	} catch (error) {
		const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
		return { status: 0, ok: false, json: null, text: '', timedOut };
	}

	const text = await response.text();
	let json: unknown = null;
	if (text) {
		try {
			json = JSON.parse(text);
		} catch {
			// Kept as text: the caller decides whether text is an answer (a chat
			// reply) or unreadable (a settings document).
			json = null;
		}
	}
	return { status: response.status, ok: response.ok, json, text, timedOut: false };
}

/** Every non-answer collapses into one of six honest states. */
function failureFrom(raw: Raw): Failure {
	return failureFromAnswer(raw.status, raw.json);
}

/**
 * The same collapse, from a status and a parsed body.
 *
 * Exported so the agent runtime's routes (`agent-socket.ts`) answer a refusal the
 * way the assistant's routes do. One mapping, one set of sentences: a console
 * where two modules disagree about what a 403 means is a console that can only be
 * debugged by reading both.
 */
export function failureFromAnswer(status: number, json: unknown): Failure {
	if (status === 0) return { kind: 'offline' };
	if (status === 401) {
		return { kind: 'refused', message: 'Your session expired. Sign in again, then ask once more.' };
	}
	if (status === 403) {
		return {
			kind: 'refused',
			message: serverMessage(json) ?? 'This account may not use the assistant.'
		};
	}
	if (status === 429) {
		// Two different 429s come out of this Worker: a spent daily allowance
		// (`budget_exhausted`, with the numbers) and the admin rate limiter in
		// front of the test call. They need different sentences.
		const code = isRecord(json) && typeof json.error === 'string' ? json.error : null;
		if (code === 'rate_limited') return { kind: 'rate-limited' };
		return { kind: 'exhausted', ...readBudget(json) };
	}
	if (status === 404 || status === 405 || status === 501) {
		return { kind: 'unavailable', detail: serverMessage(json) };
	}
	if (status === 503) return { kind: 'unavailable', detail: serverMessage(json) };
	if (status >= 500) return { kind: 'error', status };
	const message = serverMessage(json);
	return {
		kind: 'refused',
		message: message ?? `The gateway refused that request (${status}).`
	};
}

/** One sentence per state, and none of them claim anything the gateway did not. */
export function failureLine(failure: Failure): string {
	switch (failure.kind) {
		case 'unavailable':
			return 'The assistant is not available on this gateway.';
		case 'exhausted': {
			if (failure.used !== null && failure.limit !== null) {
				return `Today's allowance is spent: ${failure.used} / ${failure.limit}.`;
			}
			return "Today's allowance is spent.";
		}
		case 'rate-limited':
			return 'The gateway is limiting these calls. Wait a moment, then try again.';
		case 'refused':
			return failure.message;
		case 'offline':
			return 'The gateway did not answer. Nothing was sent.';
		case 'unreadable':
			return 'The gateway answered with something this console cannot read.';
		case 'error':
			return `The gateway answered HTTP ${failure.status}. Nothing changed.`;
	}
}

/** Tone for the line above: a refusal is the operator's problem, a budget is not. */
export function failureTone(failure: Failure): 'warn' | 'danger' {
	return failure.kind === 'refused' || failure.kind === 'offline' ? 'danger' : 'warn';
}

/* --------------------------------------------------------------- settings */

/** `GET /v1/admin/ai/settings`. */
export async function getAiSettings(): Promise<AiSettingsOutcome> {
	const raw = await call('/v1/admin/ai/settings');
	if (!raw.ok) return { status: 'failed', failure: failureFrom(raw) };
	const settings = readSettings(raw.json);
	if (settings === null) return { status: 'failed', failure: { kind: 'unreadable' } };
	return { status: 'ok', settings };
}

/**
 * `PUT /v1/admin/ai/settings`. The document comes back so the page shows what the
 * gateway now holds rather than what was typed; when it does not come back, one
 * read is cheaper than a page that guesses.
 */
export async function saveAiSettings(input: AiSettingsInput): Promise<AiSettingsOutcome> {
	const raw = await call('/v1/admin/ai/settings', {
		method: 'PUT',
		body: JSON.stringify(input)
	});
	if (!raw.ok) return { status: 'failed', failure: failureFrom(raw) };
	const settings = readSettings(raw.json);
	if (settings !== null) return { status: 'ok', settings };
	return getAiSettings();
}

/** `POST /v1/admin/ai/test` — one sample, from the provider the gateway holds. */
export async function testAi(): Promise<TestOutcome> {
	const raw = await call('/v1/admin/ai/test', { method: 'POST', body: '{}' });
	if (!raw.ok) return { status: 'failed', failure: failureFrom(raw) };

	if (isRecord(raw.json)) {
		const sample =
			readString(raw.json.sample) ??
			readString(raw.json.answer) ??
			readString(raw.json.text) ??
			readString(raw.json.output) ??
			readString(raw.json.reply);
		if (sample !== null) return { status: 'ok', sample, model: readString(raw.json.model) };
		return { status: 'failed', failure: { kind: 'unreadable' } };
	}

	// A provider that answers in plain text is answering: it is a sample, not a
	// malformed settings document.
	const text = raw.text.trim();
	if (text !== '') return { status: 'ok', sample: text, model: null };
	return { status: 'failed', failure: { kind: 'unreadable' } };
}

/* ------------------------------------------------------- system one probe */

/** The three local aliases the probe accepts. The wire model is never one of them. */
export type System1ProbeModel = 'clef' | 'clef-flash' | 'clef-omni';

/**
 * One typed answer from the probe, with only the fields a compact row prints.
 *
 * `probability` is the number the provider gave for the thing that was chosen —
 * the option's probability, the noul probability, or a score's top probability.
 * `null` is "not sent", and the page then prints no number at all: a `0` here
 * would be an invented one.
 */
export interface System1ChoiceAnswer {
	kind: 'choice';
	id: string;
	choice: string | null;
	probability: number | null;
}

export interface System1NoulAnswer {
	kind: 'noul';
	id: string;
	probability: number | null;
}

export interface System1ScoreAnswer {
	kind: 'score';
	id: string;
	/** The 0-based level the provider weighted. */
	score: number | null;
	/** The provider's own labels for those levels; `legend[score]` is the name. */
	legend: string[] | null;
	probability: number | null;
}

export type System1Answer = System1ChoiceAnswer | System1NoulAnswer | System1ScoreAnswer;

/**
 * The probe's two outcomes. A failure keeps the gateway's `reason` verbatim
 * (`reason: null` for a status that carries none, such as the 429 limiter), so
 * the page names a reason it was given and never one it guessed.
 */
export type System1TestOutcome =
	| {
			status: 'ok';
			/** The backend that answered: `workers-ai`, `openai-compatible`, or `none`. */
			provider: string | null;
			/** The probe label the answer came back under. */
			model: string | null;
			tookMs: number | null;
			answers: System1Answer[];
			/** Ids of answers whose kind this console does not render. */
			unknown: string[];
	  }
	| {
			status: 'failed';
			failure: Failure;
			reason: string | null;
			/** The provider's own `Retry-After`, as it arrived. */
			retryAfter: string | null;
	  };

/**
 * The alias a probe asks as.
 *
 * The row holds a provider's model name, and the probe accepts only its three
 * local labels; the closest one is sent and the page prints the label the
 * gateway reports back, so nothing here claims the stored name and the probed
 * one are the same string.
 */
export function system1ProbeModel(effectiveModel: string): System1ProbeModel {
	const name = effectiveModel.toLowerCase();
	if (name.includes('omni')) return 'clef-omni';
	if (name.includes('flash')) return 'clef-flash';
	return 'clef';
}

/** One row per answer the gateway sent, in the order it sent them. */
function readAnswers(value: unknown): { answers: System1Answer[]; unknown: string[] } | null {
	if (!isRecord(value)) return null;
	const answers: System1Answer[] = [];
	const unknown: string[] = [];

	for (const [key, entry] of Object.entries(value)) {
		if (!isRecord(entry)) {
			unknown.push(key);
			continue;
		}
		const id = readString(entry.id) ?? key;
		const probability = readFinite(entry.probability);

		if (entry.type === 'choice') {
			answers.push({ kind: 'choice', id, choice: readString(entry.choice), probability });
		} else if (entry.type === 'noul') {
			answers.push({ kind: 'noul', id, probability });
		} else if (entry.type === 'score') {
			const legend = Array.isArray(entry.legend)
				? entry.legend.filter((label): label is string => typeof label === 'string')
				: null;
			answers.push({
				kind: 'score',
				id,
				score: readFinite(entry.score),
				legend: legend !== null && legend.length > 0 ? legend : null,
				probability
			});
		} else {
			// A kind this console has no row for. Its id is reported, and no value
			// is invented out of fields whose meaning is unknown here.
			unknown.push(id);
		}
	}

	return { answers, unknown };
}

/**
 * `POST /v1/admin/ai/system1/test` — one fixed routing decision, in three answers.
 *
 * The probe asks about a ticket the Worker fixes in code, so two runs are
 * comparable; it is the same selection path production uses, which is what makes
 * its reported `provider` worth printing.
 */
export async function testSystem1(model: System1ProbeModel): Promise<System1TestOutcome> {
	const raw = await call('/v1/admin/ai/system1/test', {
		method: 'POST',
		body: JSON.stringify({ model })
	});

	if (!raw.ok) {
		const body = isRecord(raw.json) ? raw.json : {};
		return {
			status: 'failed',
			failure: failureFrom(raw),
			// Only a 503 carries a provider reason. A 403 or a 429 from the
			// limiter is this gateway's own answer, and has none to report.
			reason: raw.status === 503 ? readString(body.reason) : null,
			retryAfter: raw.status === 503 ? readRetryAfter(body.retry_after) : null
		};
	}

	const body = isRecord(raw.json) ? raw.json : null;
	if (body === null) return { status: 'failed', failure: { kind: 'unreadable' }, reason: null, retryAfter: null };

	const parsed = readAnswers(body.answers);
	// An answer with no rows in it is not a sample of anything; say so rather
	// than show an empty list that looks like a rendering bug.
	if (parsed === null || (parsed.answers.length === 0 && parsed.unknown.length === 0)) {
		return { status: 'failed', failure: { kind: 'unreadable' }, reason: null, retryAfter: null };
	}

	return {
		status: 'ok',
		provider: readString(body.provider),
		model: readString(body.model),
		tookMs: readFinite(body.took_ms),
		answers: parsed.answers,
		unknown: parsed.unknown
	};
}

/**
 * The `reason` a 503 from the probe carries, in the operator's words.
 *
 * The reasons are not interchangeable: a key that was refused is replaced, a
 * gateway with no key is given one, a rate limit is waited out, and an answer
 * the gateway could not read is a provider problem that is not the operator's
 * key. A reason this console does not know keeps the gateway's own sentence on
 * screen and is not renamed.
 */
export function system1ReasonLine(reason: string | null): string {
	switch (reason) {
		case 'missing_key':
			return 'The gateway holds no System One key, so it asked the provider nothing.';
		case 'provider_auth':
			return 'The provider refused the System One key.';
		case 'provider_rate_limited':
			return 'The provider is limiting this key.';
		case 'provider_unavailable':
			return 'The System One provider could not be reached.';
		case 'unparseable':
			return 'The provider answered, but not with the three answers this probe asks for.';
		default:
			// `null` (no 503 to read) and a reason added later both land here, and
			// the page prints the token beside it when there is one.
			return 'The gateway refused the System One probe.';
	}
}

/* ----------------------------------------------------------------- models */

const MODELS_REASONS: readonly string[] = [
	'missing_key',
	'missing_base_url',
	'bad_base_url',
	'provider_auth',
	'provider_rate_limited',
	'provider_unavailable',
	'unparseable'
];

/** A reason this console knows, or `null`: an unknown one is not renamed. */
function readModelsReason(value: unknown): ModelsFailureReason | null {
	if (typeof value !== 'string' || !MODELS_REASONS.includes(value)) return null;
	return value as ModelsFailureReason;
}

/** `Retry-After` as the Worker copied it: seconds or a date, printed verbatim. */
function readRetryAfter(value: unknown): string | null {
	if (typeof value === 'string' && value.trim() !== '') return value.trim();
	if (typeof value === 'number' && Number.isFinite(value)) return String(value);
	return null;
}

/** `{provider, source, note, models}`, or `null` when the answer is not that document. */
function readCatalogue(value: unknown): Extract<ModelsOutcome, { status: 'ok' }> | null {
	if (!isRecord(value)) return null;
	const provider = readProvider(value.provider);
	const source: ModelSource | null =
		value.source === 'provider' || value.source === 'static' ? value.source : null;
	// A list with no array is a document this console cannot read; an empty array
	// is an answer, and says the provider listed nothing.
	if (provider === null || source === null || !Array.isArray(value.models)) return null;

	const models: AiModel[] = [];
	const seen = new Set<string>();
	for (const entry of value.models) {
		const id = typeof entry === 'string' ? entry : isRecord(entry) ? readString(entry.id) : null;
		if (id === null || seen.has(id)) continue;
		seen.add(id);
		models.push({ id, ownedBy: isRecord(entry) ? readString(entry.owned_by) : null });
	}
	return { status: 'ok', provider, source, note: readString(value.note), models };
}

/**
 * `GET /v1/admin/ai/models` — the models the saved provider offers right now.
 *
 * The catalogue is a read: it changes nothing, and picking an id out of it is
 * the operator's next decision, not this call's. `source` travels all the way to
 * the page because the two are not the same promise: one is the provider's own
 * endpoint, the other is the gateway's short static list for an AI binding that
 * publishes nothing.
 */
export async function listModels(): Promise<ModelsOutcome> {
	const raw = await call('/v1/admin/ai/models');
	if (!raw.ok) {
		const body = isRecord(raw.json) ? raw.json : {};
		return {
			status: 'failed',
			failure: failureFrom(raw),
			// Only a 503 carries these: a 403 is this console's own permission
			// problem, and has no provider reason to report.
			reason: raw.status === 503 ? readModelsReason(body.reason) : null,
			retryAfter: raw.status === 503 ? readRetryAfter(body.retry_after) : null
		};
	}
	const catalogue = readCatalogue(raw.json);
	if (catalogue === null) {
		return { status: 'failed', failure: { kind: 'unreadable' }, reason: null, retryAfter: null };
	}
	return catalogue;
}

/* ------------------------------------------------------------------- chat */

/**
 * One chat answer, read the same way from either route.
 *
 * The two routes that carry a question (`/v1/admin/agent/say` and the older
 * `/v1/admin/assistant/chat`) answer with the same document, so the reader
 * exists once: a console where two modules disagree about what a 200 contains
 * is a console that can only be debugged by reading both.
 */
function readChat(raw: Raw): ChatOutcome {
	if (!raw.ok) return { status: 'failed', failure: failureFrom(raw) };

	if (raw.json === null) {
		const text = raw.text.trim();
		if (text === '') return { status: 'failed', failure: { kind: 'unreadable' } };
		return { status: 'plain', text };
	}

	if (!isRecord(raw.json)) return { status: 'failed', failure: { kind: 'unreadable' } };
	const answer = typeof raw.json.answer === 'string' ? raw.json.answer : null;
	if (answer === null) return { status: 'failed', failure: { kind: 'unreadable' } };
	const proposals = readProposals(raw.json.proposals);
	// An empty answer with no proposals is not an answer; say so rather than
	// leaving an empty panel that looks like a rendering bug.
	if (answer.trim() === '' && proposals.length === 0) {
		return { status: 'failed', failure: { kind: 'unreadable' } };
	}
	return { status: 'ok', answer, proposals, withheld: readWithheld(raw.json.withheld) };
}

/**
 * `POST /v1/admin/assistant/chat` — one question in, one answer and proposals out.
 *
 * This is the route every deployment has. The panel asks it only when the agent
 * route below is not there at all, because this one keeps no conversation and
 * accepts no files.
 */
export async function askAssistant(input: {
	message: string;
	context?: AssistantContext;
	signal?: AbortSignal;
}): Promise<ChatOutcome> {
	const raw = await call('/v1/admin/assistant/chat', {
		method: 'POST',
		body: JSON.stringify({ message: input.message, context: input.context ?? {} }),
		signal: input.signal
	});
	return readChat(raw);
}

/* ------------------------------------------------------- the agent session */

/**
 * One question, on the route that keeps a conversation.
 *
 * The wire:
 *
 *   POST /v1/admin/agent/say
 *     { message, context?, attachmentIds?, idempotencyKey? }
 *     → { answer, proposals?, withheld?, replayed? }
 *
 * `idempotencyKey` is minted by this browser, never by the model. A retry sends
 * the same one, and the gateway answers `replayed: true` when it had already
 * answered that key: the same sentence, no second turn. `attachmentIds` are the
 * stored files the operator chose for this question, and an answer that used
 * them is the model's own sentence — nothing here claims otherwise.
 *
 * A deployment with the runtime off refuses this route with `agent_runtime_off`,
 * and one older than it answers 404/405/501; both fall back to the stateless
 * route. That path is honest: it answers, it just keeps nothing.
 */
export interface SayInput {
	message: string;
	context?: AssistantContext;
	attachmentIds?: string[];
	idempotencyKey?: string;
	signal?: AbortSignal;
}

/** Which route answered. Both are real; only one keeps a transcript. */
export type SayRoute = 'agent' | 'assistant';

export type SayOutcome = ChatOutcome & {
	/** True when the gateway had already answered this key. */
	replayed: boolean;
	via: SayRoute;
};

export async function sayAgent(input: SayInput): Promise<SayOutcome> {
	const payload: Record<string, unknown> = {
		message: input.message,
		context: input.context ?? {}
	};
	if (input.attachmentIds !== undefined && input.attachmentIds.length > 0) {
		payload.attachmentIds = input.attachmentIds;
	}
	if (input.idempotencyKey !== undefined && input.idempotencyKey !== '') {
		payload.idempotencyKey = input.idempotencyKey;
	}

	const raw = await call('/v1/admin/agent/say', {
		method: 'POST',
		body: JSON.stringify(payload),
		signal: input.signal
	});

	// The runtime is off on this deployment: this route exists but refuses, and
	// the stateless route is the one that answers. A missing route is the same
	// story. Both keep the operator's question and lose only the transcript.
	const runtimeOff =
		raw.status === 503 &&
		isRecord(raw.json) &&
		(raw.json.error === 'agent_runtime_off' || raw.json.reason === 'agent_runtime_off');

	if (raw.status === 404 || raw.status === 405 || raw.status === 501 || runtimeOff) {
		const legacy = await askAssistant({
			message: input.message,
			context: input.context,
			signal: input.signal
		});
		return { ...legacy, replayed: false, via: 'assistant' };
	}

	const replayed = isRecord(raw.json) && raw.json.replayed === true;
	return { ...readChat(raw), replayed, via: 'agent' };
}

/** The ids the accept answer named, in the order they are worth showing. */
function collectIds(value: unknown): string[] {
	if (!isRecord(value)) return [];
	const keys = ['id', 'rule_id', 'template_id', 'created_id', 'workflow_id', 'flow_id'];
	const ids: string[] = [];
	for (const key of keys) {
		const id = readString(value[key]);
		if (id !== null && !ids.includes(id)) ids.push(id);
	}
	return ids;
}

/**
 * The accept answer, in the operator's words.
 *
 * Each kind answers with `{ kind, result: { … } }`, and the three are not the
 * same promise: `create_rule` writes a rule, `create_template` hands back a
 * draft that was never stored, and `stage_workflow_patch` returns a patch for
 * the editor. Saying "created" for all three would be wrong twice.
 */
function readAccept(value: unknown): { message: string; ids: string[]; detail: string | null } {
	const body = isRecord(value) ? value : null;
	const kind = body !== null && typeof body.kind === 'string' ? body.kind : null;
	const result = body !== null && isRecord(body.result) ? body.result : {};
	const ids = collectIds(result);
	const serverLine = body !== null ? readString(body.message) : null;
	const detail = typeof result.body === 'string' && result.body !== '' ? result.body : null;

	switch (kind) {
		case 'create_rule':
			if (ids.length > 0) return { message: 'The rule was created.', ids, detail: null };
			return {
				message: 'The gateway accepted the rule but did not name it.',
				ids,
				detail: null
			};
		case 'create_template': {
			const name = typeof result.name === 'string' && result.name !== '' ? result.name : null;
			return {
				message:
					name === null
						? 'The template draft is ready. Nothing was saved.'
						: `The template draft "${name}" is ready. Nothing was saved; it is yours to keep.`,
				ids,
				detail
			};
		}
		case 'stage_workflow_patch':
			return { message: 'The gateway accepted the patch.', ids, detail: null };
		default:
			return { message: serverLine ?? 'The gateway accepted the proposal.', ids, detail };
	}
}

/** `POST /v1/admin/assistant/proposals/:id/accept` — the one write a proposal makes. */
export async function acceptProposal(id: string): Promise<AcceptOutcome> {
	const raw = await call(`/v1/admin/assistant/proposals/${encodeURIComponent(id)}/accept`, {
		method: 'POST',
		body: '{}'
	});
	if (!raw.ok) return { status: 'failed', failure: failureFrom(raw) };
	return { status: 'ok', ...readAccept(raw.json) };
}

/* ------------------------------------------------- the editor's ghost staging */

/**
 * A patch handed to the editor, which draws it as a ghost and keeps the accept.
 *
 * The editor already has exactly one staging path (`stageExternalPatch`, reached
 * by its WebMCP tool and by the proposal banner). This module does not own a
 * second one: it holds a function the editor registers while it is mounted, so
 * "the editor is not open" is a fact the assistant can state instead of a POST
 * that creates nothing.
 *
 * Wiring, one line each, outside this pass's file scope: in
 * `$lib/components/workflow/WorkflowEditor.svelte`, `onMount` returns the cleanup
 * from `registerWorkflowTools({ … })`; register this sink beside it with
 * `registerWorkflowPatchSink((input) => stageExternalPatch(input))`.
 */
export interface WorkflowPatchHandoff {
	intent: string;
	patch: unknown;
	/**
	 * The flow the proposal named, when it named one. The editor compares this
	 * with the flow it has open: `patchFitsFlow` is a structural check, and a
	 * patch written for one flow can fit another well enough to be staged there.
	 */
	flowId?: string | null;
}

export interface PatchSinkResult {
	ok: boolean;
	message: string;
}

export type WorkflowPatchSink = (input: WorkflowPatchHandoff) => PatchSinkResult;

let patchSink: WorkflowPatchSink | null = null;

/** Called by the editor on mount. Returns the teardown it should keep. */
export function registerWorkflowPatchSink(sink: WorkflowPatchSink): () => void {
	patchSink = sink;
	return () => {
		if (patchSink === sink) patchSink = null;
	};
}

/** True only while a workflow editor is mounted on this page. */
export function workflowPatchSinkReady(): boolean {
	return patchSink !== null;
}

/** Hand one patch over. Refuses plainly when there is no editor to stage it in. */
export function handPatchToEditor(input: WorkflowPatchHandoff): PatchSinkResult {
	if (patchSink === null) {
		return { ok: false, message: 'No workflow editor is open, so there is nothing to stage.' };
	}
	try {
		return patchSink(input);
	} catch (error) {
		return {
			ok: false,
			message: error instanceof Error ? error.message : 'The editor refused the patch.'
		};
	}
}

/* ------------------------------------------------------------------ labels */

/** A kind in the operator's words. An unknown kind stays as the endpoint sent it. */
export function proposalKindLabel(kind: string): string {
	switch (kind) {
		case 'create_rule':
			return 'rule';
		case 'create_template':
			return 'template';
		case 'stage_workflow_patch':
			return 'workflow patch';
		default:
			return kind.replace(/_/g, ' ');
	}
}

/** The two kinds that accept through the endpoint. */
export function proposalAcceptsRemotely(kind: string): boolean {
	return kind === 'create_rule' || kind === 'create_template';
}

/** The one kind that stages in the editor instead. */
export function proposalStagesInEditor(kind: string): boolean {
	return kind === 'stage_workflow_patch';
}

/** `provider` in the operator's words, for a chip. */
export function providerLabel(provider: AiProvider): string {
	return provider === 'workers-ai' ? 'Workers AI' : 'OpenAI-compatible';
}
