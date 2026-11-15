/**
 * The assistant, and the deployment's AI settings.
 *
 * Four endpoints, and the console reads every one of them the same way: assume
 * nothing, and answer with the plainest true sentence when the endpoint does not
 * answer the question that was asked.
 *
 *   GET  /v1/admin/ai/settings                     provider, model, key state, budget
 *   PUT  /v1/admin/ai/settings                     the same document, written back
 *   POST /v1/admin/ai/test                         one sample answer from the provider
 *   POST /v1/admin/assistant/chat                  one answer, and proposals
 *   POST /v1/admin/assistant/proposals/:id/accept  the only write a proposal makes
 *
 * Three things this module is strict about, because they are the ones that cost
 * an operator real time when they are fudged:
 *
 *  1. The key never exists in this browser. There is no field for it, no state
 *     for it and no parameter for it; `wrangler secret put AI_CHAT_API_KEY` is a
 *     deployment step the settings screen explains rather than imitates.
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
	apiKeyConfigured: boolean;
	/** The gateway's own suggestion, if it sent one. Rendered when present. */
	hint: string | null;
	budget: AiBudget;
}

/** What `PUT` accepts. There is no key field: the type says so out loud. */
export interface AiSettingsInput {
	provider: AiProvider;
	model: string;
	baseUrl: string;
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
	| { status: 'ok'; answer: string; proposals: Proposal[] }
	| { status: 'plain'; text: string }
	| { status: 'failed'; failure: Failure };

export type TestOutcome =
	| { status: 'ok'; sample: string; model: string | null }
	| { status: 'failed'; failure: Failure };

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
		apiKeyConfigured: value.apiKeyConfigured === true,
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
	if (raw.status === 0) return { kind: 'offline' };
	if (raw.status === 401) {
		return { kind: 'refused', message: 'Your session expired. Sign in again, then ask once more.' };
	}
	if (raw.status === 403) {
		return {
			kind: 'refused',
			message: serverMessage(raw.json) ?? 'This account may not use the assistant.'
		};
	}
	if (raw.status === 429) {
		// Two different 429s come out of this Worker: a spent daily allowance
		// (`budget_exhausted`, with the numbers) and the admin rate limiter in
		// front of the test call. They need different sentences.
		const code = isRecord(raw.json) && typeof raw.json.error === 'string' ? raw.json.error : null;
		if (code === 'rate_limited') return { kind: 'rate-limited' };
		return { kind: 'exhausted', ...readBudget(raw.json) };
	}
	if (raw.status === 404 || raw.status === 405 || raw.status === 501) {
		return { kind: 'unavailable', detail: serverMessage(raw.json) };
	}
	if (raw.status === 503) return { kind: 'unavailable', detail: serverMessage(raw.json) };
	if (raw.status >= 500) return { kind: 'error', status: raw.status };
	const message = serverMessage(raw.json);
	return {
		kind: 'refused',
		message: message ?? `The gateway refused that request (${raw.status}).`
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

/* ------------------------------------------------------------------- chat */

/** `POST /v1/admin/assistant/chat` — one question in, one answer and proposals out. */
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
	return { status: 'ok', answer, proposals };
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
