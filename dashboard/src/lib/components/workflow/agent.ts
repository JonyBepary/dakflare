/**
 * The agent endpoints (v7.1 WS4), and the three answers they can give.
 *
 * Everything here is a read: `triage`, `telemetry`, `diagnose` and `synthesize`
 * never write a message, send an SMS or apply a patch. `synthesize` judges a
 * candidate patch and, when a human should approve it, mints a token for the
 * existing approval route to spend. The console may therefore treat all four as
 * advisory answers, and the editor still owns the only path that changes a flow.
 *
 * Three outcomes, because a network call has three honest ends:
 *
 *   ok           the agent answered with something this console understands
 *   unavailable  there is no agent to ask: endpoint not deployed, provider down,
 *                timeout, offline, or an answer in a shape we do not know
 *   refused      the request itself was rejected (bad body, no session)
 *
 * A 404 is not an error to retry: it means this deployment predates the agent
 * routes, and the caller must fall back to the manual path rather than pretend
 * it got an answer.
 */

/** How long one agent call may take before the console stops waiting. */
const AGENT_TIMEOUT_MS = 15_000;

/** Why there is no answer. The copy for each one is in `unavailableCopy`. */
export type AgentUnavailable =
	| 'not-deployed'
	| 'provider'
	| 'offline'
	| 'timeout'
	| 'aborted'
	| 'malformed';

export type AgentOutcome<T> =
	| { status: 'ok'; data: T }
	| { status: 'unavailable'; reason: AgentUnavailable; detail: string | null }
	| { status: 'refused'; message: string };

/** `POST /v1/agent/triage` */
export interface AgentTriageResult {
	intent: { choice: string; probability: number; confidence: number } | null;
	injection: { probability: number } | null;
	specificity: { score: number | null } | null;
	roles: Array<{ index: number; role: string; probability: number }>;
	invariant: { balanceAtLeastPrincipal: boolean | null };
	source: 'workers-ai' | 'unavailable';
}

/** `POST /v1/agent/synthesize` — the judgement, never the patch. */
export interface AgentJudgement {
	faithful: { score: number | null; probability: number | null; confidence: number } | null;
	approval_required: boolean;
	apply_token: string | null;
}

/** `POST /v1/agent/diagnose` — the RootCauseCard, trimmed to what the UI reads. */
export interface AgentDiagnosis {
	code: string | null;
	summary: string;
	encoding: string;
	segments: number;
}

/** One sentence an operator can act on, per reason. */
export function unavailableCopy(reason: AgentUnavailable): string {
	switch (reason) {
		case 'not-deployed':
			return 'This gateway has no agent endpoints yet. Nothing was proposed, and nothing changed.';
		case 'provider':
			return 'Clef is not answering right now. Nothing was proposed, and nothing changed.';
		case 'offline':
			return 'Could not reach the gateway. Nothing was proposed, and nothing changed.';
		case 'timeout':
			return 'The agent did not answer in time. Nothing was proposed, and nothing changed.';
		case 'aborted':
			return 'Stopped before the agent answered. Nothing changed.';
		case 'malformed':
			return 'The agent answered with something this console cannot read. Nothing changed.';
	}
}

/** A short label for a badge, where a sentence would not fit. */
export function unavailableLabel(reason: AgentUnavailable): string {
	switch (reason) {
		case 'not-deployed':
			return 'agent not deployed';
		case 'provider':
			return 'agent unavailable';
		case 'offline':
			return 'offline';
		case 'timeout':
			return 'no answer';
		case 'aborted':
			return 'stopped';
		case 'malformed':
			return 'unreadable answer';
	}
}

/* ------------------------------------------------------------- transport */

function mergeSignals(outer: AbortSignal | undefined): {
	signal: AbortSignal;
	didTimeOut: () => boolean;
	dispose: () => void;
} {
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, AGENT_TIMEOUT_MS);
	const onAbort = () => controller.abort();
	if (outer) {
		if (outer.aborted) controller.abort();
		else outer.addEventListener('abort', onAbort, { once: true });
	}
	return {
		signal: controller.signal,
		didTimeOut: () => timedOut,
		dispose: () => {
			clearTimeout(timer);
			outer?.removeEventListener('abort', onAbort);
		}
	};
}

function serverMessage(payload: unknown): string | null {
	if (!payload || typeof payload !== 'object') return null;
	const body = payload as Record<string, unknown>;
	if (typeof body.message === 'string' && body.message.trim() !== '') return body.message.trim();
	if (typeof body.detail === 'string' && body.detail.trim() !== '') return body.detail.trim();
	if (typeof body.error === 'string' && body.error.trim() !== '') return body.error.trim();
	return null;
}

async function postAgent<T>(
	path: string,
	body: unknown,
	signal: AbortSignal | undefined,
	read: (payload: unknown) => T | null
): Promise<AgentOutcome<T>> {
	const merged = mergeSignals(signal);
	try {
		let response: Response;
		try {
			response = await fetch(path, {
				method: 'POST',
				headers: {
					Accept: 'application/json',
					'Content-Type': 'application/json',
					// Cookies alone are ambiguous across middleware, and the Worker
					// contract asks for this marker on every admin call.
					'X-Admin-Session': '1'
				},
				body: JSON.stringify(body),
				credentials: 'same-origin',
				signal: merged.signal
			});
		} catch {
			if (merged.didTimeOut()) {
				return { status: 'unavailable', reason: 'timeout', detail: null };
			}
			if (signal?.aborted) {
				return { status: 'unavailable', reason: 'aborted', detail: null };
			}
			return { status: 'unavailable', reason: 'offline', detail: null };
		}

		const text = await response.text();
		let payload: unknown = null;
		if (text) {
			try {
				payload = JSON.parse(text);
			} catch {
				payload = null;
			}
		}

		if (!response.ok) {
			// A route that is not there is a deployment fact, not a failure to retry.
			if (response.status === 404 || response.status === 405 || response.status === 501) {
				return { status: 'unavailable', reason: 'not-deployed', detail: null };
			}
			if (response.status === 503) {
				return {
					status: 'unavailable',
					reason: 'provider',
					detail: serverMessage(payload)
				};
			}
			const message =
				serverMessage(payload) ??
				(response.status === 401
					? 'Your session expired. Sign in again.'
					: `The gateway refused that request (${response.status}).`);
			return { status: 'refused', message };
		}

		const value = read(payload);
		if (value === null) {
			return { status: 'unavailable', reason: 'malformed', detail: null };
		}
		return { status: 'ok', data: value };
	} finally {
		merged.dispose();
	}
}

/* ----------------------------------------------------------------- readers */

function readNumber(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readTriage(payload: unknown): AgentTriageResult | null {
	if (!payload || typeof payload !== 'object') return null;
	const body = payload as Record<string, unknown>;

	const intentRaw = body.intent as Record<string, unknown> | null | undefined;
	const intent =
		intentRaw && typeof intentRaw.choice === 'string'
			? {
					choice: intentRaw.choice,
					probability: readNumber(intentRaw.probability) ?? 0,
					confidence: readNumber(intentRaw.confidence) ?? 0
				}
			: null;

	const injectionRaw = body.injection as Record<string, unknown> | null | undefined;
	const injection =
		injectionRaw && typeof injectionRaw.probability === 'number'
			? { probability: injectionRaw.probability }
			: null;

	const specificityRaw = body.specificity as Record<string, unknown> | null | undefined;
	const specificity = specificityRaw ? { score: readNumber(specificityRaw.score) } : null;

	const roles: AgentTriageResult['roles'] = [];
	if (Array.isArray(body.roles)) {
		for (const entry of body.roles) {
			if (!entry || typeof entry !== 'object') continue;
			const role = entry as Record<string, unknown>;
			const index = readNumber(role.index);
			if (index === null || typeof role.role !== 'string') continue;
			roles.push({ index, role: role.role, probability: readNumber(role.probability) ?? 0 });
		}
	}

	const invariantRaw = body.invariant as Record<string, unknown> | null | undefined;
	const balance = invariantRaw?.balanceAtLeastPrincipal;

	return {
		intent,
		injection,
		specificity,
		roles,
		invariant: { balanceAtLeastPrincipal: typeof balance === 'boolean' ? balance : null },
		source: body.source === 'workers-ai' ? 'workers-ai' : 'unavailable'
	};
}

function readJudgement(payload: unknown): AgentJudgement | null {
	if (!payload || typeof payload !== 'object') return null;
	const body = payload as Record<string, unknown>;
	if (typeof body.approval_required !== 'boolean') return null;
	const faithfulRaw = body.faithful as Record<string, unknown> | null | undefined;
	const faithful = faithfulRaw
		? {
				score: readNumber(faithfulRaw.score),
				probability: readNumber(faithfulRaw.probability),
				confidence: readNumber(faithfulRaw.confidence) ?? 0
			}
		: null;
	return {
		faithful,
		approval_required: body.approval_required,
		apply_token: typeof body.apply_token === 'string' ? body.apply_token : null
	};
}

function readDiagnosis(payload: unknown): AgentDiagnosis | null {
	if (!payload || typeof payload !== 'object') return null;
	const body = payload as Record<string, unknown>;
	if (typeof body.summary !== 'string') return null;
	return {
		code: typeof body.code === 'string' ? body.code : null,
		summary: body.summary,
		encoding: typeof body.encoding === 'string' ? body.encoding : '',
		segments: readNumber(body.segments) ?? 0
	};
}

/* --------------------------------------------------------------- the calls */

/** Classify an inbound message and the spans the operator has highlighted. */
export function triageMessage(
	input: {
		message: string;
		sender: string;
		spans: Array<{ index: number; text: string }>;
	},
	signal?: AbortSignal
): Promise<AgentOutcome<AgentTriageResult>> {
	return postAgent(
		'/v1/agent/triage',
		{ message: input.message, sender: input.sender, spans: input.spans.slice(0, 20) },
		signal,
		readTriage
	);
}

/**
 * Ask the model to judge a candidate patch.
 *
 * The patch itself is not sent: `diff_summary` is the canonical description, and
 * the Worker hashes `flow_id` + `intent` + `diff_summary` to bind any token it
 * mints. The console therefore must not rewrite those three strings between the
 * judgement and the accept, or the token no longer names this patch.
 */
export function synthesizePatch(
	input: {
		intent: string;
		flow_id: string;
		diff_summary: string;
		corpus_report: string;
	},
	signal?: AbortSignal
): Promise<AgentOutcome<AgentJudgement>> {
	return postAgent(
		'/v1/agent/synthesize',
		{
			intent: input.intent.slice(0, 1_000),
			flow_id: input.flow_id.slice(0, 128),
			diff_summary: input.diff_summary.slice(0, 4_000),
			corpus_report: input.corpus_report.slice(0, 1_000)
		},
		signal,
		readJudgement
	);
}

/** Reduce one message (and optionally a pattern) to a single root cause. */
export function diagnoseMessage(
	input: { message: string; pattern?: string },
	signal?: AbortSignal
): Promise<AgentOutcome<AgentDiagnosis>> {
	return postAgent(
		'/v1/agent/diagnose',
		{
			message: input.message.slice(0, 4_096),
			...(input.pattern ? { pattern: input.pattern.slice(0, 512) } : {})
		},
		signal,
		readDiagnosis
	);
}

/** A percentage for a score or probability, or a dash when the model gave none. */
export function percent(value: number | null | undefined): string {
	if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
	return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}
