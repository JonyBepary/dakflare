<script lang="ts">
	/**
	 * AI settings — which provider answers the assistant, which model routes for
	 * it, which secret answers each of those two roles, how much of today's
	 * allowance is gone, and whether the agent may act without an Accept.
	 *
	 * One provider, two roles: chat (the reply) and System One (the routing
	 * decision made before a reply exists). Both are configured here, and both
	 * are deliberately quiet about secrets.
	 *
	 * The Autonomy card is the one control here that can end with an SMS leaving
	 * the handset without a human pressing Accept. It is off by default, it states
	 * the consequence in one sentence in both states, and opening a window takes
	 * two deliberate steps: an acknowledgement, then a button that names the window
	 * and the caps it would open. Revoking says what it stops.
	 *
	 * Three things this page refuses to do, because each one would be a lie the
	 * operator cannot see:
	 *
	 *  - It never holds, shows or accepts a key. The gateway names the secret
	 *    that answered each role (`keySource`) and nothing more; a field here
	 *    would put a secret into a browser history, a log or a screenshot. The
	 *    missing-key state is a `cf workers secrets update` command, not an input.
	 *  - It never turns "nobody said" into zero. `used` and `limit` are nullable,
	 *    and an absent number is a dash with a sentence, not `0 / 0`. The same
	 *    holds for a secret the gateway did not name.
	 *  - It never claims the saved document is what was typed. After a save the
	 *    page renders the document the gateway sent back.
	 *
	 * There is no key field anywhere in this file; the PUT body is
	 * `AiSettingsInput`, which has no key member either.
	 */
	import { onMount } from 'svelte';
	import {
		failureLine,
		failureTone,
		getAiSettings,
		listModels,
		providerLabel,
		saveAiSettings,
		system1ProbeModel,
		system1ReasonLine,
		testAi,
		testSystem1,
		type AiProvider,
		type AiRole,
		type AiSettings,
		type AiSystem1Input,
		type Failure,
		type KeySource,
		type ModelsOutcome,
		type System1Answer,
		type System1TestOutcome,
		type TestOutcome
	} from '$lib/assistant';
	import { session } from '$lib/session.svelte';
	import { ROUTES } from '$lib/paths';
	import {
		AUTONOMY_WINDOWS,
		openAutonomy,
		readAgentRuntime,
		readAutonomy,
		revokeAutonomy,
		windowLabel,
		type AgentAutonomy,
		type AgentRuntime
	} from '$lib/agent-socket';
	import { announce } from '$lib/announce.svelte';
	import { formatCount } from '$lib/format';
	import CopyButton from '$lib/components/CopyButton.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import Notice from '$lib/components/Notice.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import RelativeTime from '$lib/components/RelativeTime.svelte';
	import Spinner from '$lib/components/Spinner.svelte';

	const CHAT_KEY_COMMAND =
		'cf workers secrets update AI_CHAT_API_KEY --worker dakflare-worker --type secret_text';
	const SYSTEM1_KEY_COMMAND =
		'cf workers secrets update TOKENLAB_API_KEY --worker dakflare-worker --type secret_text';
	/**
	 * The chat key: the one a failed settings read or a refused catalogue is
	 * about. `AI_PROVIDER_API_KEY` answers both roles and is named in the note
	 * under the two rows, but no third command is printed for it: a command per
	 * role is what the rows are for.
	 */
	const KEY_COMMAND = CHAT_KEY_COMMAND;

	/** One role's key state, as the rows under the form print it. */
	interface KeyRow {
		role: AiRole;
		label: string;
		/** A secret answered · none does · Workers AI needs none · the gateway did not say. */
		state: 'key' | 'missing' | 'binding' | 'unreported';
		/** The secret's name when one answered. Never a value. */
		source: KeySource | null;
		/** The command that sets this role's own secret, when it has none. */
		command: string | null;
	}

	/** One failed catalogue, said once, in the shape the block under the form needs. */
	interface CatalogueFailure {
		line: string;
		tone: 'warn' | 'danger';
		/** The gateway's own words, printed as they arrived. */
		detail: string | null;
		/** The remediation the page already prints elsewhere, when it is that one. */
		fix: 'key' | 'base' | null;
		retry: boolean;
	}

	let settings = $state<AiSettings | null>(null);
	let loading = $state(true);
	let loadFailure = $state<Failure | null>(null);

	/** The form's copy of the chat fields. Nothing else is writable. */
	let provider = $state<AiProvider>('workers-ai');
	let model = $state('');
	let baseUrl = $state('');

	/**
	 * System One's own values. `''` means "inherit the chat value", and is what
	 * the PUT omits: an empty string would be refused by the Worker, and would
	 * read as a broken deployment rather than as an inheritance.
	 */
	let s1Model = $state('');
	let s1BaseUrl = $state('');

	/**
	 * The two inheritance controls. Checked means the field beside it is not the
	 * operator's to set, and is not sent: the checkbox is the choice, so nobody
	 * has to guess what an empty field means.
	 */
	let s1InheritBase = $state(true);

	let saving = $state(false);
	let saveFailure = $state<Failure | null>(null);
	let fieldError = $state<string | null>(null);
	let saved = $state(false);

	let testing = $state(false);
	let test = $state<TestOutcome | null>(null);

	let testingS1 = $state(false);
	let s1Test = $state<System1TestOutcome | null>(null);

	/**
	 * The provider's catalogue, as the last load answered it. `picked` is the id
	 * the operator clicked out of it, kept only while the field still holds it:
	 * the row is a choice, never a save.
	 */
	let models = $state<ModelsOutcome | null>(null);
	let modelsLoading = $state(false);
	let picked = $state<string | null>(null);

	/* ------------------------------------------------------------- autonomy */

	/**
	 * The runtime and the window are two reads, and they answer two different
	 * questions: whether an agent exists on this deployment, and whether it may act
	 * right now. Neither is inferred from the other, which is why the block can say
	 * "off" (a window is closed) and "off" (there is no runtime) in different words.
	 */
	let runtime = $state<AgentRuntime | null>(null);
	let runtimeFailure = $state<Failure | null>(null);
	let autonomy = $state<AgentAutonomy | null>(null);
	let autonomyFailure = $state<Failure | null>(null);
	let autonomyLoading = $state(true);
	let autonomyBusy = $state<'opening' | 'revoking' | null>(null);
	let autonomyError = $state<string | null>(null);

	/** The deliberate second step: nothing is minted until this is ticked. */
	let autonomyAck = $state(false);
	let autonomyMinutes = $state(60);
	/** Caps as typed. Strings, so an empty field is an empty field and not a zero. */
	let autonomySms = $state('25');
	let autonomyWrites = $state('5');

	const allowed = $derived(session.canViewSecurity);

	const runtimeOn = $derived(runtime?.enabled === true);
	const autonomyOpen = $derived(autonomy?.enabled === true);

	/**
	 * Why the form is inert. `null` when it is not.
	 *
	 * A gateway with no runtime route and a gateway whose runtime is off both mean
	 * "a window would do nothing", and they are said in different words: the first
	 * is an older deployment, the second is a decision an operator made.
	 */
	const autonomyBlocked = $derived.by((): string | null => {
		if (runtime === null) {
			return runtimeFailure?.kind === 'unavailable'
				? 'This gateway reports no agent runtime, so a window would have nothing to act with.'
				: 'This page could not read the agent runtime, so it will not open a window it cannot describe.';
		}
		if (!runtimeOn) return 'The agent runtime is off, so a window would have nothing to act with.';
		return null;
	});

	/** A window is a spend, not a setting: it needs the runtime and both caps. */
	const autonomyCapsValid = $derived.by(() => {
		const sms = autonomySms.trim();
		const writes = autonomyWrites.trim();
		return /^\d+$/.test(sms) && /^\d+$/.test(writes);
	});

	const canOpenWindow = $derived(
		autonomy !== null && !autonomy.enabled && autonomyBlocked === null && autonomyBusy === null
	);

	/** A cap that is already spent is a fact worth saying before the next act fails. */
	const smsCapSpent = $derived(
		autonomyOpen &&
			autonomy !== null &&
			autonomy.caps.sms !== null &&
			autonomy.usage.sms !== null &&
			autonomy.usage.sms >= autonomy.caps.sms
	);
	const writeCapSpent = $derived(
		autonomyOpen &&
			autonomy !== null &&
			autonomy.caps.writes !== null &&
			autonomy.usage.writes !== null &&
			autonomy.usage.writes >= autonomy.caps.writes
	);

	/** The chat values as the form would send them, which an inherited field shows. */
	const chatModel = $derived(model.trim());
	const chatBase = $derived(baseUrl.trim());

	/** System One as the form would send it, resolved the way the gateway resolves it. */
	const s1EffectiveModel = $derived(s1Model.trim());
	const s1EffectiveBase = $derived(
		s1InheritBase || provider !== 'openai-compatible' ? chatBase : s1BaseUrl.trim()
	);

	/**
	 * The document as the gateway holds it, so "unsaved" means something.
	 *
	 * System One is compared by *effect*: the document carries no "inherited"
	 * flag, so an own value equal to the chat value describes the same routing as
	 * inheriting, and ticking the box back on changes nothing that is sent.
	 */
	const savedSystem1Model = $derived(
		settings === null ? '' : (settings.system1?.model ?? settings.model)
	);
	const savedSystem1Base = $derived(
		settings === null ? '' : ((settings.system1?.baseUrl ?? settings.baseUrl) ?? '')
	);
	const dirty = $derived(
		settings !== null &&
			(provider !== settings.provider ||
				model !== settings.model ||
				baseUrl !== settings.baseUrl ||
				s1EffectiveModel !== savedSystem1Model ||
				(provider === 'openai-compatible' && s1EffectiveBase !== savedSystem1Base))
	);

	const busy = $derived(saving || testing || testingS1);

	const keySource = $derived(settings?.keySource ?? null);

	/**
	 * Only an external gateway takes a key. Workers AI answers both roles through
	 * this Worker's own binding, so no secret is missing there and none must be
	 * suggested.
	 */
	const needsKey = $derived(settings === null || settings.provider !== 'workers-ai');

	/**
	 * The two roles, in the order an operator reads them: what answers the reply,
	 * then what decides the route before it. A row names the secret that
	 * answered, or the command that sets one — never a value, and never a name
	 * the gateway did not send.
	 */
	const keyRows = $derived.by((): KeyRow[] => {
		if (settings === null) return [];
		const roles: ReadonlyArray<{ role: AiRole; label: string; command: string }> = [
			{ role: 'chat', label: 'Chat', command: CHAT_KEY_COMMAND },
			{ role: 'system1', label: 'System One', command: SYSTEM1_KEY_COMMAND }
		];
		return roles.map(({ role, label, command }) => {
			if (!needsKey) return { role, label, state: 'binding', source: null, command: null };
			const source = keySource === null ? null : keySource[role];
			if (source === null) return { role, label, state: 'unreported', source: null, command: null };
			if (source === 'none') return { role, label, state: 'missing', source: null, command };
			return { role, label, state: 'key', source, command: null };
		});
	});

	const missingKeys = $derived(keyRows.filter((row) => row.state === 'missing').length);

	/** Both roles answered, by different secrets: the state a shared key hides. */
	const keysSplit = $derived(
		keyRows.length === 2 &&
			keyRows.every((row) => row.state === 'key') &&
			keyRows[0].source !== keyRows[1].source
	);

	/** True when the chat role has a secret (Workers AI always does: the binding). */
	const chatKeyPresent = $derived(
		keySource === null ? false : settings?.provider === 'workers-ai' || keySource.chat !== 'none'
	);

	/** One sentence under the rows, per state. It states a fact, not a policy. */
	const keyNote = $derived.by((): string => {
		if (settings === null) return '';
		if (!needsKey)
			return "Workers AI answers both roles through this Worker's own AI binding, so there is no key to install.";
		if (keySource === null)
			return 'This gateway did not say which secret answers each role, so this page will not name one.';
		if (missingKeys === 0) {
			return keysSplit
				? 'Chat and System One read different secrets: a key that answers one does not answer the other.'
				: 'One secret answers both roles. This page can see that it exists and nothing else.';
		}
		if (missingKeys === 2)
			return 'Neither role has a key, so both answer 503 until one is set. AI_PROVIDER_API_KEY would answer both; the commands above set each role its own.';
		return 'A role with no key answers 503 until one is set: a key typed into a browser ends up in a history, a log or a screenshot.';
	});

	/** True when the gateway's hint is a command the rows already print. */
	const hintIsCommand = $derived(settings?.hint?.includes('cf workers secrets update') === true);

	const spent = $derived(
		settings !== null &&
			settings.budget.used !== null &&
			settings.budget.limit !== null &&
			settings.budget.limit > 0 &&
			settings.budget.used >= settings.budget.limit
	);

	const budgetReported = $derived(
		settings !== null && settings.budget.used !== null && settings.budget.limit !== null
	);

	/** Width for the allowance bar, clamped: a full bar is the whole story. */
	const budgetPercent = $derived.by(() => {
		if (settings === null) return 0;
		const { used, limit } = settings.budget;
		if (used === null || limit === null || limit <= 0) return 0;
		return Math.min(100, Math.max(0, (used / limit) * 100));
	});

	const modelPlaceholder = $derived(
		provider === 'workers-ai' ? '@cf/meta/llama-3.1-8b-instruct' : 'gpt-4o-mini'
	);

	/** The catalogue, when the last answer was one. */
	const catalogue = $derived.by(() =>
		models !== null && models.status === 'ok' ? models : null
	);

	/**
	 * A failed catalogue in the operator's words, per reason.
	 *
	 * The reasons are not interchangeable: a key the provider refused is fixed by
	 * replacing the key, a gateway with no key is fixed by installing one, and a
	 * 403 is neither — it is this account, and nothing was asked of the provider.
	 */
	const catalogueFailure = $derived.by((): CatalogueFailure | null => {
		if (models === null || models.status !== 'failed') return null;
		const { failure, reason, retryAfter } = models;

		if (failure.kind === 'refused') {
			return {
				line: `${failureLine(failure)} Nothing was asked of the provider.`,
				tone: 'danger',
				detail: null,
				fix: null,
				retry: false
			};
		}
		if (failure.kind === 'unreadable') {
			return {
				line: 'The gateway answered, but not with a model list this console can read.',
				tone: 'warn',
				detail: null,
				fix: null,
				retry: true
			};
		}
		// A 429, an offline fetch and a 5xx have their own sentences already.
		if (failure.kind !== 'unavailable') {
			return {
				line: failureLine(failure),
				tone: failureTone(failure),
				detail: null,
				fix: null,
				retry: true
			};
		}

		switch (reason) {
			case 'provider_auth':
				return {
					line: 'The provider refused the key while listing its models.',
					tone: 'danger',
					detail: failure.detail,
					fix: 'key',
					retry: true
				};
			case 'provider_rate_limited':
				return {
					line: 'The provider is limiting this key. Wait, then load the list again.',
					tone: 'warn',
					detail: retryAfter === null ? failure.detail : `retry after ${retryAfter}`,
					fix: null,
					retry: true
				};
			case 'missing_key':
				return {
					line: 'The gateway holds no chat key, so it has no list to ask the provider for.',
					tone: 'warn',
					detail: failure.detail,
					fix: 'key',
					retry: false
				};
			case 'missing_base_url':
				return {
					line: 'The saved provider has no base URL, so there is nowhere to ask for its models.',
					tone: 'warn',
					detail: failure.detail,
					fix: 'base',
					retry: false
				};
			case 'bad_base_url':
				return {
					line: 'The gateway refused the saved base URL before it asked the provider.',
					tone: 'warn',
					detail: failure.detail,
					fix: 'base',
					retry: false
				};
			case 'provider_unavailable':
				return {
					line: 'The provider could not be reached for its model list.',
					tone: 'warn',
					detail: failure.detail,
					fix: null,
					retry: true
				};
			case 'unparseable':
				return {
					line: 'The provider answered, but not with a model list this console can read.',
					tone: 'warn',
					detail: failure.detail,
					fix: null,
					retry: true
				};
			default:
				// A reason this console does not know: the gateway's own sentence,
				// with no invented name for it.
				return {
					line: 'The gateway could not produce a model list.',
					tone: 'warn',
					detail: failure.detail,
					fix: null,
					retry: true
				};
		}
	});

	onMount(() => {
		if (allowed) void load();
		else loading = false;
	});

	async function load(): Promise<void> {
		loading = true;
		loadFailure = null;
		saveFailure = null;
		fieldError = null;
		saved = false;
		test = null;
		s1Test = null;
		// A catalogue belongs to a document; a fresh read may name another provider.
		models = null;
		picked = null;
		const result = await getAiSettings();
		if (result.status === 'ok') applySettings(result.settings);
		else {
			settings = null;
			loadFailure = result.failure;
		}
		loading = false;
		// The window is a different document from the model settings, so it is read
		// by its own call and fails on its own terms.
		void loadAgent();
	}

	/**
	 * `GET /v1/admin/agent/runtime` and `GET /v1/admin/agent/autonomy`, together.
	 *
	 * Two independent reads: one says whether an agent exists here, the other says
	 * whether it may act. A failure in either is reported as itself, never as "off",
	 * because "off" is a fact only the gateway can state.
	 */
	async function loadAgent(): Promise<void> {
		autonomyLoading = true;
		autonomyError = null;
		const [runtimeRead, autonomyRead] = await Promise.all([readAgentRuntime(), readAutonomy()]);

		if (runtimeRead.status === 'ok') {
			runtime = runtimeRead.runtime;
			runtimeFailure = null;
		} else {
			runtime = null;
			runtimeFailure = runtimeRead.failure;
		}

		if (autonomyRead.status === 'ok') {
			autonomy = autonomyRead.autonomy;
			autonomyFailure = null;
		} else {
			autonomy = null;
			autonomyFailure = autonomyRead.failure;
		}
		autonomyLoading = false;
	}

	/**
	 * Open a window. Two deliberate steps stand in front of this: the checkbox, and
	 * a button whose label names the length of the window it opens.
	 */
	async function openWindow(): Promise<void> {
		if (autonomyBusy !== null || !autonomyAck || !canOpenWindow) return;

		const sms = Number(autonomySms.trim());
		const writes = Number(autonomyWrites.trim());
		if (!Number.isInteger(sms) || sms < 0 || !Number.isInteger(writes) || writes < 0) {
			autonomyError = 'Both caps are whole numbers, zero or more. A window with no cap is not a cap.';
			return;
		}

		autonomyError = null;
		autonomyBusy = 'opening';
		const result = await openAutonomy({
			smsCap: sms,
			writeCap: writes,
			minutes: autonomyMinutes
		});
		autonomyBusy = null;

		if (result.status === 'failed') {
			autonomyFailure = result.failure;
			return;
		}
		autonomyFailure = null;
		autonomyAck = false;
		// The route may answer with the window or with nothing; a read is cheaper
		// than a page that shows a window it guessed.
		if (result.autonomy !== null) autonomy = result.autonomy;
		else await loadAgent();
		announce('An autonomy window is open. The assistant can act without an Accept until it closes.');
	}

	/** Revoke, and say what that stops. */
	async function revoke(): Promise<void> {
		if (autonomyBusy !== null) return;
		autonomyBusy = 'revoking';
		const result = await revokeAutonomy();
		autonomyBusy = null;

		if (result.status === 'failed') {
			autonomyFailure = result.failure;
			return;
		}
		autonomyFailure = null;
		if (result.autonomy !== null) autonomy = result.autonomy;
		else await loadAgent();
		announce('The autonomy window is revoked. Any agent session it opened is stopped.');
	}

	function applySettings(next: AiSettings): void {
		// The list was the old provider's answer, and picking out of it is over.
		if (models !== null && models.status === 'ok' && models.provider !== next.provider) {
			models = null;
		}
		picked = null;
		settings = next;
		provider = next.provider;
		model = next.model;
		baseUrl = next.baseUrl;

		// The System One model is its own field, never the chat model: a gateway
		// decides with a different model than it chats with (Token Lab decides
		// with Clef and chats as DeepSeek), so the document's effective value is
		// what this field shows and what Save writes back.
		const stored = next.system1;
		s1Model = stored !== null ? stored.model : '';

		// The gateway says whether the row stores an origin. Comparing two URLs
		// cannot tell an inherited base from an override that happens to match,
		// and the comparison silently dropped such an override on the next save.
		const ownBase =
			next.provider === 'openai-compatible' &&
			stored !== null &&
			(stored.inheritsBase ?? (stored.baseUrl ?? '') !== next.baseUrl) === false;
		s1InheritBase = !ownBase;
		s1BaseUrl = stored !== null && ownBase ? (stored.baseUrl ?? '') : '';
	}

	/**
	 * Ask the gateway what the saved provider offers. A read: nothing is written,
	 * and the ids are only ever put into the field by the operator's next click.
	 */
	async function loadModels(): Promise<void> {
		if (modelsLoading) return;
		modelsLoading = true;
		picked = null;
		models = null;
		models = await listModels();
		modelsLoading = false;
	}

	/**
	 * The provider select is the one field whose value decides which other fields
	 * exist, so it is read from the event rather than bound: switching to Workers
	 * AI has to drop a System One base URL the new provider would refuse.
	 */
	function chooseProvider(event: Event): void {
		provider = (event.currentTarget as HTMLSelectElement).value as AiProvider;
		if (provider === 'workers-ai') {
			s1InheritBase = true;
			s1BaseUrl = '';
		}
	}

	/** Put one id in the field. It is a choice, not a save: Save still has to be pressed. */
	function pick(id: string): void {
		model = id;
		picked = id;
	}

	async function save(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (saving || settings === null) return;

		const nextModel = model.trim();
		if (nextModel === '') {
			fieldError = "Give the model the provider should answer with. It is the provider's own name.";
			return;
		}
		const nextBase = baseUrl.trim();
		if (provider === 'openai-compatible' && nextBase === '') {
			fieldError = 'An OpenAI-compatible deployment needs its base URL.';
			return;
		}
		if (provider === 'openai-compatible' && !/^https?:\/\//i.test(nextBase)) {
			fieldError = 'The base URL starts with http:// or https://.';
			return;
		}

		// System One, same rule: an own value has to be a value, and an inherited
		// one is not sent at all — the Worker reads an omitted member as "clear
		// this column", which is exactly what inheriting means.
		const nextS1Model = s1Model.trim();
		if (nextS1Model === '') {
			fieldError = 'Give System One the model its provider decides with.';
			return;
		}
		const ownBase = provider === 'openai-compatible' && !s1InheritBase;
		const nextS1Base = s1BaseUrl.trim();
		if (ownBase && nextS1Base === '') {
			fieldError = "System One's own base URL is empty. Give it one, or tick Use the chat base URL.";
			return;
		}
		if (ownBase && !/^https?:\/\//i.test(nextS1Base)) {
			fieldError = "System One's base URL starts with http:// or https://.";
			return;
		}

		const system1: AiSystem1Input = { model: nextS1Model };
		if (ownBase) system1.baseUrl = nextS1Base;

		fieldError = null;
		saveFailure = null;
		saved = false;
		saving = true;
		const result = await saveAiSettings({
			provider,
			model: nextModel,
			baseUrl: provider === 'openai-compatible' ? nextBase : '',
			// Always sent, even empty: the PUT is a replacement, so an omitted
			// object would leave an own model the operator just turned off.
			system1
		});
		if (result.status === 'ok') {
			applySettings(result.settings);
			saved = true;
		} else {
			saveFailure = result.failure;
		}
		saving = false;
	}

	async function runTest(): Promise<void> {
		if (testing) return;
		testing = true;
		saveFailure = null;
		test = null;
		test = await testAi();
		testing = false;
	}

	/**
	 * Probe System One. It reads the *saved* document, like the chat test: the
	 * provider, the origin and the model all come from the row, so a change on
	 * screen would make the probe describe something nobody is running.
	 */
	async function runSystem1Test(): Promise<void> {
		if (busy || settings === null) return;
		testingS1 = true;
		s1Test = null;
		s1Test = await testSystem1(system1ProbeModel(settings.system1?.model ?? settings.model));
		testingS1 = false;
	}

	/** One answer's readable value, in the words and numbers the gateway sent. */
	function answerValue(answer: System1Answer): string {
		if (answer.kind === 'choice') {
			return withProbability(answer.choice ?? '—', answer.probability);
		}
		if (answer.kind === 'noul') {
			// The noul probability *is* the answer: no option was chosen.
			return answer.probability === null ? '—' : String(answer.probability);
		}
		if (answer.score === null) {
			return withProbability('—', answer.probability);
		}
		// The provider's own label for that level, when it sent one: the score is
		// a 0-based index, and `level 2` alone makes the operator count.
		const label = answer.legend?.[answer.score] ?? null;
		const level = label === null ? `level ${answer.score}` : `${label} (${answer.score})`;
		return withProbability(level, answer.probability);
	}

	/** No rounding: the number is printed as it arrived. */
	function withProbability(label: string, probability: number | null): string {
		return probability === null ? label : `${label} · ${probability}`;
	}

	/**
	 * The gateway's own words under a failed probe: the reason token it sent, the
	 * `Retry-After` it copied, and its message. Joined here rather than in the
	 * markup, so a missing member cannot leave a stray separator on screen.
	 */
	function reasonDetail(outcome: Extract<System1TestOutcome, { status: 'failed' }>): string {
		const parts: string[] = [];
		if (outcome.reason !== null) parts.push(`reason ${outcome.reason}`);
		if (outcome.retryAfter !== null) parts.push(`retry after ${outcome.retryAfter}`);
		if (outcome.failure.kind === 'unavailable' && outcome.failure.detail !== null) {
			parts.push(outcome.failure.detail);
		}
		return parts.join(' · ');
	}
</script>

<svelte:head>
	<title>AI assistant · DakFlare</title>
</svelte:head>

<div class="page">
	<PageHeader
		eyebrow="Security"
		title="AI assistant"
		description="Which model answers the assistant, which one decides the route before it answers, which secret answers each role, what is left of today's allowance, and whether the agent may act on its own. No key is shown here, because none is here: they live in the Worker as secrets."
	>
		{#if allowed && !loading}
			<button type="button" class="btn" onclick={() => void load()} disabled={busy}>
				<Icon name="refresh" size={14} /> Check again
			</button>
		{/if}
	</PageHeader>

	{#if !allowed}
		<section class="card">
			<EmptyState
				icon="shield"
				title="AI settings are for owners and admins"
				description="The model and the key belong to the deployment, not to an account. Ask an owner if the assistant needs to change."
			>
				<a class="btn btn-primary" href={ROUTES.security}>Back to sign-in</a>
			</EmptyState>
		</section>
	{:else if loading}
		<div class="bento" aria-busy="true" aria-live="polite">
			<span class="sr-only">Reading the assistant's settings</span>
			<section class="card span-8">
				<div class="skeleton" style="height: 18px; width: 34%"></div>
				<div class="skeleton" style="height: 38px; margin-top: 16px"></div>
				<div class="skeleton" style="height: 38px; margin-top: 12px"></div>
				<div class="skeleton" style="height: 38px; width: 62%; margin-top: 12px"></div>
			</section>
			<section class="card span-4">
				<div class="skeleton" style="height: 18px; width: 50%"></div>
				<div class="skeleton" style="height: 42px; margin-top: 16px"></div>
			</section>
		</div>
	{:else if settings === null}
		<section class="card">
			{#if loadFailure}
				<Notice tone={failureTone(loadFailure)} title="The assistant's settings did not load">
					{failureLine(loadFailure)}
					{#if loadFailure.kind === 'unavailable'}
						The gateway answers the assistant's routes with 503 until it has a chat key, or reports it
						unavailable while the provider is down. The settings page is the only place that says
						which; this one could not read it.
					{/if}
				</Notice>
			{:else}
				<Notice tone="warn" title="The settings could not be read">
					The gateway answered, but not with a document this console understands. Nothing was changed.
				</Notice>
			{/if}

			{#if loadFailure?.kind === 'unavailable' || loadFailure?.kind === 'error'}
				<div class="command">
					<code>{KEY_COMMAND}</code>
					<CopyButton value={KEY_COMMAND} iconOnly label="Copy the key command" />
				</div>
				<p class="hint">
					Run it against this deployment and paste the key at the prompt: the command asks for the value,
					so the key never reaches argv or a shell history, and it is never sent to this page.
				</p>
			{/if}

			<button type="button" class="btn btn-sm" style="margin-top: 12px" onclick={() => void load()}>
				<Icon name="refresh" size={13} /> Try again
			</button>
		</section>
	{:else}
		<div class="bento">
			<section class="card span-8" aria-labelledby="model-title">
				<header class="card-head">
					<h2 id="model-title" class="card-title">Models</h2>
				</header>
				<p class="card-note">
					What the assistant answers with, and what sorts a message before it answers. A saved change
					applies to the next question; nothing already asked is repeated.
				</p>

				<form class="form-grid ai-form" onsubmit={save} novalidate>
					<div class="field">
						<label class="label" for="ai-provider">Provider</label>
						<select
							id="ai-provider"
							class="input"
							value={provider}
							onchange={chooseProvider}
							disabled={busy}
						>
							<option value="workers-ai">Workers AI</option>
							<option value="openai-compatible">OpenAI-compatible</option>
						</select>
						<p class="hint">
							{#if provider === 'workers-ai'}
								Runs in the Worker's own account. No base URL, and no key unless the model needs one.
								Both roles use it.
							{:else}
								Any endpoint that speaks the OpenAI chat shape, including a gateway in front of
								several providers. Both roles use it.
							{/if}
						</p>
					</div>

					<div class="field">
						<div class="model-head">
							<label class="label" for="ai-model">Model</label>
							<!-- The page's one coral action is Save. This is a read, and says so. -->
							<button
								id="ai-load-models"
								type="button"
								class="btn btn-sm"
								onclick={() => void loadModels()}
								disabled={busy || modelsLoading}
								aria-busy={modelsLoading}
							>
								{#if modelsLoading}<Spinner />{/if}
								{modelsLoading ? 'Loading' : 'Load models'}
							</button>
						</div>
						<input
							id="ai-model"
							class="input input-mono"
							bind:value={model}
							placeholder={modelPlaceholder}
							autocomplete="off"
							autocapitalize="off"
							spellcheck="false"
							disabled={busy}
							aria-describedby="ai-model-hint"
						/>
						<p class="hint" id="ai-model-hint">
							The provider's own model name, exactly as it is called and billed.
						</p>
					</div>

					{#if provider === 'openai-compatible'}
						<div class="field">
							<label class="label" for="ai-base">Base URL</label>
							<input
								id="ai-base"
								class="input input-mono"
								bind:value={baseUrl}
								placeholder="https://api.openai.com/v1"
								autocomplete="off"
								autocapitalize="off"
								spellcheck="false"
								disabled={busy}
								aria-describedby="ai-base-hint"
							/>
							<p class="hint" id="ai-base-hint">
								Required for this provider: the address up to the version, with no model path after
								it. https, or http on localhost. No credentials in the URL.
							</p>
						</div>
					{/if}

					<!-- System One: the routing decision taken before a reply exists. A second
					     selection under the same provider and the same Save, drawn quieter
					     than the chat fields because it is usually left inherited. -->
					<fieldset class="s1" disabled={busy}>
						<legend class="s1-title">System One · routing decisions</legend>

						<div class="s1-head">
							<p class="s1-note">
								The model that sorts a message before the chat model answers it. Inheriting a chat
								value is a choice, not an empty field.
								{#if settings.system1 !== null && settings.system1.provider !== settings.provider}
									<!-- Only when a future document selects a provider for this role
									     alone; today it is always the same one. -->
									It runs on <span class="mono">{providerLabel(settings.system1.provider)}</span>,
									not on the provider above.
								{/if}
							</p>
							<button
								id="ai-test-s1"
								type="button"
								class="btn btn-sm"
								onclick={() => void runSystem1Test()}
								disabled={busy || dirty}
								aria-busy={testingS1}
								aria-describedby="ai-s1-test-hint"
							>
								{#if testingS1}<Spinner />{:else}<Icon name="zap" size={13} />{/if}
								{testingS1 ? 'Testing' : 'Test System One'}
							</button>
							<!-- The probe's shape, for a screen reader wherever the button is: one
							     fixed ticket, three typed questions, the same path routing uses. -->
							<span class="sr-only" id="ai-s1-test-hint">
								Asks one fixed ticket three typed questions, through the selection path routing
								uses. It reads the saved document.
							</span>
						</div>

						<div class="s1-grid">
							<div class="field">
								<label class="label" for="ai-s1-model">Model</label>
								{#if provider === 'workers-ai'}
									<!-- Three aliases exist and nothing else. A free-text typo would be
									     mapped to clef at ask time and answered silently. -->
									<select id="ai-s1-model" class="input" bind:value={s1Model} aria-describedby="ai-s1-model-hint">
										<option value="clef">clef</option>
										<option value="clef-flash">clef-flash</option>
										<option value="clef-omni">clef-omni</option>
									</select>
								{:else}
									<input
										id="ai-s1-model"
										class="input input-mono"
										bind:value={s1Model}
										placeholder="Clef"
										autocomplete="off"
										autocapitalize="off"
										spellcheck="false"
										aria-describedby="ai-s1-model-hint"
									/>
								{/if}
								<p class="hint" id="ai-s1-model-hint">
									The model the provider decides with. It does not follow the chat model: a gateway
									usually serves its decision model under a different name than the one it chats with.
								</p>
							</div>

							{#if provider === 'openai-compatible'}
								<div class="field">
									<label class="check s1-check" for="ai-s1-inherit-base">
										<input
											id="ai-s1-inherit-base"
											type="checkbox"
											bind:checked={s1InheritBase}
											aria-describedby="ai-s1-base-hint"
										/>
										<span>Use the chat base URL</span>
									</label>
									{#if s1InheritBase}
										<!-- No field at all while the base is the chat base: a second input
										     holding the same URL is a place to introduce a difference by
										     accident. -->
										<p class="hint s1-inherited" id="ai-s1-base-hint">
											Inherited from the base URL above:
											<span class="mono">{chatBase || 'not set yet'}</span>.
										</p>
									{:else}
										<label class="label" for="ai-s1-base">Base URL</label>
										<input
											id="ai-s1-base"
											class="input input-mono"
											bind:value={s1BaseUrl}
											placeholder="https://api.example.com/v1"
											autocomplete="off"
											autocapitalize="off"
											spellcheck="false"
											aria-describedby="ai-s1-base-hint"
										/>
										<p class="hint" id="ai-s1-base-hint">
											System One's own origin. The same rule as above: https, or http on
											localhost, and no credentials in the URL.
										</p>
									{/if}
								</div>
							{/if}
						</div>

						{#if dirty}
							<p class="hint">The probe reads the saved document, so save this change first.</p>
						{/if}

						<!-- The live region exists before the probe is pressed, so the "asking"
						     line and the result are both announced rather than dropped into a
						     region that was not there yet. -->
						<div class="s1-result" aria-live="polite">
							{#if testingS1}
								<p class="state-line" data-tone="muted">Asking the System One provider.</p>
							{:else if s1Test !== null}
								<div class="s1-result-body">
									{#if s1Test.status === 'ok'}
										<p class="s1-result-head">
											<span class="mono">probe {s1Test.model ?? '—'}</span>
											{#if s1Test.provider}<span class="mono">{s1Test.provider}</span>{/if}
											<span class="mono">{s1Test.tookMs ?? '—'} ms</span>
											<span class="mono">
												{s1Test.answers.length}
												{s1Test.answers.length === 1 ? 'answer' : 'answers'}
											</span>
										</p>
										<ul class="answer-list">
											{#each s1Test.answers as answer (answer.id)}
												<li>
													<span class="mono answer-id">{answer.id}</span>
													<span class="answer-kind">{answer.kind}</span>
													<span class="mono answer-value">{answerValue(answer)}</span>
												</li>
											{/each}
										</ul>
										{#if s1Test.unknown.length > 0}
											<p class="hint">
												The gateway also answered
												<span class="mono">{s1Test.unknown.join(', ')}</span>, which is a kind this
												page does not draw.
											</p>
										{/if}
									{:else}
										<p
											class="state-line"
											data-tone={s1Test.reason === 'provider_auth'
												? 'danger'
												: failureTone(s1Test.failure)}
										>
											{s1Test.reason === null
												? failureLine(s1Test.failure)
												: system1ReasonLine(s1Test.reason)}
										</p>
										{#if reasonDetail(s1Test) !== ''}
											<p class="hint mono s1-result-detail">{reasonDetail(s1Test)}</p>
										{/if}
									{/if}
								</div>
							{/if}
						</div>
					</fieldset>

					<div class="key-block">
						<div class="key-head">
							<span class="label">Keys</span>
						</div>
						<ul class="key-roles">
							{#each keyRows as row (row.role)}
								<li class="key-role" data-state={row.state}>
									<div class="key-role-head">
										<span class="key-role-name">{row.label}</span>
										{#if row.state === 'key'}
											<span class="mono key-source">{row.source}</span>
										{:else if row.state === 'binding'}
											<span class="key-source">not needed — the binding answers</span>
										{:else if row.state === 'missing'}
											<span class="key-source" data-tone="missing">not configured</span>
										{:else}
											<span class="key-source" data-tone="unreported">not reported</span>
										{/if}
									</div>
									{#if row.command}
										<div class="command">
											<code>{row.command}</code>
											<CopyButton
												value={row.command}
												iconOnly
												label={`Copy the command that sets ${row.label}'s key`}
											/>
										</div>
									{/if}
								</li>
							{/each}
						</ul>
						<p class="hint">{keyNote}</p>
						{#if provider !== settings.provider}
							<p class="hint">
								These rows describe the provider the gateway holds. Saving the change above reads
								them again.
							</p>
						{/if}
						{#if settings.hint && !hintIsCommand}
							<!-- When the key is missing the gateway's hint is that same command,
							     which the rows above already print once. -->
							<p class="hint gateway-hint">
								<span class="mono">gateway</span> {settings.hint}
							</p>
						{/if}
					</div>

					{#if fieldError}
						<div class="field-note">
							<Notice tone="danger">{fieldError}</Notice>
						</div>
					{/if}
					{#if saveFailure}
						<div class="field-note">
							<Notice tone={failureTone(saveFailure)} title="The settings were not saved">
								{failureLine(saveFailure)}
							</Notice>
						</div>
					{/if}
					{#if saved}
						<p class="saved-line" role="status">
							<Icon name="check" size={13} /> Saved. This page is showing the document the gateway
							sent back.
						</p>
					{/if}

					<div class="form-foot">
						<button
							type="submit"
							class="btn btn-primary"
							disabled={busy || !dirty}
							aria-busy={saving}
						>
							{#if saving}<Spinner />{:else}<Icon name="check" size={14} />{/if}
							{saving ? 'Saving' : 'Save'}
						</button>
						<button type="button" class="btn" onclick={() => void runTest()} disabled={busy || dirty}>
							{#if testing}<Spinner />{:else}<Icon name="zap" size={14} />{/if}
							{testing ? 'Testing' : 'Test chat'}
						</button>
						{#if dirty}
							<span class="mono dirty-note">unsaved changes</span>
						{:else if settings.model !== ''}
							<span class="mono dirty-note">model <span class="mono-ink">{settings.model}</span></span>
						{/if}
					</div>
				</form>

				{#if dirty}
					<p class="hint">
						Both tests use the saved document, not what is above: they ask the gateway what it is
						configured with now. Save first to test a change.
					</p>
				{/if}

				<!-- The catalogue sits under the form foot, so loading, failing and
				     filling it never moves Save. -->
				{#if modelsLoading || models !== null}
					<div class="models-block">
						{#if modelsLoading}
							<p class="state-line" data-tone="muted" role="status">
								Asking {providerLabel(provider)} for its models.
							</p>
						{:else if catalogue !== null}
							<p class="models-head" role="status">
								<span class="mono models-kicker">catalogue</span>
								<span class="models-count">
									{catalogue.models.length}
									{catalogue.models.length === 1 ? 'model' : 'models'}
								</span>
								<span class="models-dot" aria-hidden="true">·</span>
								<span>
									{catalogue.source === 'static'
										? 'a static list, from the gateway'
										: "the provider's own list"}
								</span>
							</p>

							{#if catalogue.note}
								<!-- Workers AI publishes no catalogue endpoint. The gateway
								     says so in its own words, and this page repeats them. -->
								<p class="hint">
									<span class="mono">gateway</span> {catalogue.note}
								</p>
							{/if}

							{#if catalogue.provider !== provider}
								<p class="hint">
									This list is for {providerLabel(catalogue.provider)}, the provider the gateway
									holds. Save the change above, then load the list again.
								</p>
							{/if}

							{#if catalogue.models.length === 0}
								<p class="hint">
									The provider listed no models. That is its answer, not a failure: the field above
									still takes a name.
								</p>
							{:else}
								<ul class="model-list">
									{#each catalogue.models as entry (entry.id)}
										<li>
											<button
												type="button"
												class="model-option"
												onclick={() => pick(entry.id)}
												aria-current={model === entry.id ? 'true' : undefined}
											>
												<span class="model-mark" aria-hidden="true">
													{#if model === entry.id}<Icon name="check" size={12} />{/if}
												</span>
												<span class="model-id">{entry.id}</span>
												{#if entry.ownedBy}
													<span class="model-owner">{entry.ownedBy}</span>
												{/if}
											</button>
										</li>
									{/each}
								</ul>
								{#if picked !== null && picked === model && dirty}
									<p class="hint" role="status">
										<span class="mono">{picked}</span> is in the model field. Nothing is saved until
										you press Save.
									</p>
								{/if}
							{/if}
						{:else if catalogueFailure !== null}
							<p class="state-line" data-tone={catalogueFailure.tone} role="status">
								{catalogueFailure.line}
							</p>
							{#if catalogueFailure.detail}
								<p class="hint mono detail">{catalogueFailure.detail}</p>
							{/if}
							{#if catalogueFailure.fix === 'key'}
								{#if chatKeyPresent}
									<!-- The Keys block above says a key exists and shows no command,
									     so this is the place the replacement is spelled out. -->
									<div class="command">
										<code>{KEY_COMMAND}</code>
										<CopyButton value={KEY_COMMAND} iconOnly label="Copy the key command" />
									</div>
									<p class="hint">
										Run it against this deployment and paste a key the provider accepts: the command
										asks for the value, so it never reaches argv or a shell history. Then load the
										list again.
									</p>
								{:else}
									<!-- The Keys block above already prints this command once. -->
									<p class="hint">
										Set the chat key with the command the Keys block above prints, then load the
										list again.
									</p>
								{/if}
							{:else if catalogueFailure.fix === 'base'}
								<p class="hint">
									Give the provider its base URL above and save it, then load the list again.
								</p>
							{/if}
							{#if catalogueFailure.retry}
								<div>
									<button
										type="button"
										class="btn btn-sm"
										onclick={() => void loadModels()}
										disabled={busy}
									>
										<Icon name="refresh" size={13} /> Try again
									</button>
								</div>
							{/if}
						{/if}
					</div>
				{/if}

				{#if test !== null}
					<div class="test-result">
						{#if test.status === 'ok'}
							<p class="sample-label">
								<span class="mono">chat · sample response</span>
								{#if test.model}<span class="mono sample-model">{test.model}</span>{/if}
							</p>
							<p class="sample-text">{test.sample}</p>
						{:else}
							<p class="state-line" data-tone={failureTone(test.failure)}>
								{failureLine(test.failure)}
								{#if test.failure.kind === 'unavailable' && test.failure.detail}
									<span class="mono detail">{test.failure.detail}</span>
								{/if}
							</p>
						{/if}
					</div>
				{/if}
			</section>

			<section class="card span-4" aria-labelledby="budget-title">
				<header class="card-head">
					<h2 id="budget-title" class="card-title">Today's allowance</h2>
					{#if spent}
						<span class="chip" data-tone="warn">spent</span>
					{:else if budgetReported}
						<span class="chip" data-tone="muted">counted</span>
					{:else}
						<span class="chip" data-tone="muted">not reported</span>
					{/if}
				</header>

				<p class="budget-value">
					<span class="mono">{settings.budget.used ?? '—'}</span>
					<span class="budget-slash" aria-hidden="true">/</span>
					<span class="mono">{settings.budget.limit ?? '—'}</span>
					<span class="budget-unit">tokens</span>
				</p>

				<div class="budget-bar" aria-hidden="true">
					<span
						class="budget-fill"
						data-tone={spent ? 'spent' : 'ok'}
						style="width: {budgetPercent}%"
					></span>
				</div>

				<p class="hint">
					{#if budgetReported}
						The gateway counts the tokens it spends and refuses with 429 once the limit is reached.
						{#if spent}The next request is refused until the count is below the limit.{/if}
					{:else}
						The gateway did not report both numbers, so this page will not invent them. The count it
						enforces is still in force.
					{/if}
				</p>

				{#if settings.budget.day}
					<p class="budget-day">
						<span class="mono">day {settings.budget.day}</span>
					</p>
				{/if}
			</section>

			<!-- Autonomy: the one control here that can end with something happening
			     without a human pressing Accept. It says that in full, it is off by
			     default, and opening a window takes two deliberate steps. -->
			<section class="card span-12" aria-labelledby="autonomy-title">
				<header class="card-head autonomy-head">
					<h2 id="autonomy-title" class="card-title">Autonomy</h2>
					{#if autonomy === null}
						<span class="chip" data-tone="muted">{autonomyLoading ? 'reading' : 'not reported'}</span>
					{:else if autonomy.enabled}
						<span class="chip" data-tone="warn">open</span>
					{:else}
						<span class="chip" data-tone="muted">off</span>
					{/if}
					<span class="autonomy-runtime mono">
						runtime {runtimeOn ? 'on' : runtime === null ? '—' : 'off'}{#if runtime !== null && runtime.pinnedName !== null}· {runtime.pinnedName}{/if}{#if runtime !== null && runtime.schemaVersion !== null}· schema {runtime.schemaVersion}{/if}
					</span>
				</header>

				{#if autonomy === null}
					{#if autonomyLoading}
						<p class="state-line" data-tone="muted" role="status">Reading the autonomy window.</p>
					{:else}
						<p
							class="state-line"
							data-tone={autonomyFailure === null || autonomyFailure.kind === 'unavailable'
								? 'muted'
								: failureTone(autonomyFailure)}
						>
							{#if autonomyFailure === null}
								The gateway did not report an autonomy window, so this page will not describe one.
							{:else if autonomyFailure.kind === 'unavailable'}
								This gateway has no autonomy route, so no window can be opened or read here. The
								assistant still proposes, and every write still waits for an Accept.
							{:else}
								{failureLine(autonomyFailure)}
							{/if}
						</p>
						<p class="hint autonomy-gap">
							Nothing is opened from an unknown window: its caps and its end time are the server's to
							state, and a page that guessed them would be describing a promise nobody made.
						</p>
						<button type="button" class="btn btn-sm autonomy-again" onclick={() => void loadAgent()}>
							<Icon name="refresh" size={13} /> Read it again
						</button>
					{/if}
				{:else}
					<!-- The consequence, in one sentence, in both states. Off is not
					     described as safe: it is described as what it is. -->
					<p class="autonomy-consequence" data-state={autonomy.enabled ? 'open' : 'off'}>
						{#if autonomy.enabled}
							Open. The assistant can act without an Accept: it may send SMS and write to this
							deployment on its own until the window closes or a cap is reached.
						{:else}
							Off. Opening a window lets the assistant act without an Accept: it may send SMS and
							write to this deployment on its own until the window closes or a cap is reached.
						{/if}
					</p>

					<dl class="autonomy-facts">
						<div class="autonomy-fact">
							<dt>Closes</dt>
							<dd>
								{#if autonomy.enabled}
									<RelativeTime value={autonomy.expiresAt} fallback="no end time reported" />
								{:else}
									closed
								{/if}
							</dd>
						</div>
						<div class="autonomy-fact">
							<dt>SMS today</dt>
							<dd class="mono">
								{autonomy.usage.sms ?? '—'}{#if autonomy.enabled && autonomy.caps.sms !== null}
									/ {autonomy.caps.sms}{/if}
							</dd>
						</div>
						<div class="autonomy-fact">
							<dt>Writes today</dt>
							<dd class="mono">
								{autonomy.usage.writes ?? '—'}{#if autonomy.enabled && autonomy.caps.writes !== null}
									/ {autonomy.caps.writes}{/if}
							</dd>
						</div>
						<div class="autonomy-fact">
							<dt>Tokens today</dt>
							<dd class="mono">{formatCount(autonomy.usage.tokens)}</dd>
						</div>
						<div class="autonomy-fact">
							<dt>Day</dt>
							<dd class="mono">{autonomy.usage.day ?? 'not reported'}</dd>
						</div>
					</dl>

					{#if smsCapSpent || writeCapSpent}
						<p class="state-line autonomy-gap" data-tone="warn">
							{#if smsCapSpent && writeCapSpent}
								Both caps are spent. The assistant is back to proposing until the window closes.
							{:else if smsCapSpent}
								The SMS cap is spent. The assistant cannot send again until the window closes.
							{:else}
								The write cap is spent. The assistant cannot write again until the window closes.
							{/if}
						</p>
					{/if}

					{#if !autonomy.enabled}
						<form
							class="autonomy-form"
							onsubmit={(event) => {
								event.preventDefault();
								void openWindow();
							}}
							novalidate
						>
							<div class="autonomy-fields">
								<div class="field">
									<label class="label" for="autonomy-window">Window</label>
									<select
										id="autonomy-window"
										class="input"
										bind:value={autonomyMinutes}
										disabled={!canOpenWindow}
									>
										{#each AUTONOMY_WINDOWS as entry (entry.minutes)}
											<option value={entry.minutes}>{entry.label}</option>
										{/each}
									</select>
									<p class="hint">
										It starts when you press the button and closes on its own. Nothing renews it.
									</p>
								</div>

								<div class="field">
									<label class="label" for="autonomy-sms">SMS cap</label>
									<input
										id="autonomy-sms"
										class="input input-mono"
										inputmode="numeric"
										autocomplete="off"
										bind:value={autonomySms}
										disabled={!canOpenWindow}
										aria-describedby="autonomy-sms-hint"
									/>
									<p class="hint" id="autonomy-sms-hint">
										Messages the agent may send in this window.
									</p>
								</div>

								<div class="field">
									<label class="label" for="autonomy-writes">Write cap</label>
									<input
										id="autonomy-writes"
										class="input input-mono"
										inputmode="numeric"
										autocomplete="off"
										bind:value={autonomyWrites}
										disabled={!canOpenWindow}
										aria-describedby="autonomy-writes-hint"
									/>
									<p class="hint" id="autonomy-writes-hint">
										Rules and other writes it may make in this window.
									</p>
								</div>
							</div>

							<!-- The second step. The first is this box; the button below does
							     nothing until it is ticked. -->
							<label class="check autonomy-ack" for="autonomy-ack">
								<input
									id="autonomy-ack"
									type="checkbox"
									bind:checked={autonomyAck}
									disabled={!canOpenWindow}
								/>
								<span>
									I understand that while this window is open the assistant acts on its own: it can
									send SMS and write to this deployment without an Accept from me.
								</span>
							</label>

							{#if autonomyBlocked !== null}
								<p class="hint autonomy-blocked">{autonomyBlocked}</p>
							{/if}
							{#if autonomyError !== null}
								<p class="field-error" role="alert">{autonomyError}</p>
							{/if}
							{#if autonomyFailure !== null}
								<p class="state-line" data-tone={failureTone(autonomyFailure)}>
									{failureLine(autonomyFailure)}
								</p>
							{/if}

							<div class="autonomy-actions">
								<!-- Not the page's coral action: Save above is. A control that mints
								     a grant should not be the loudest thing on the page. -->
								<button
									type="submit"
									class="btn"
									disabled={!autonomyAck || !canOpenWindow || !autonomyCapsValid}
									aria-busy={autonomyBusy === 'opening'}
								>
									{#if autonomyBusy === 'opening'}<Spinner />{:else}<Icon name="zap" size={14} />{/if}
									{autonomyBusy === 'opening'
										? 'Opening'
										: `Open a ${windowLabel(autonomyMinutes)} window`}
								</button>
								<p class="hint" aria-live="polite">
									{#if !autonomyCapsValid}
										Both caps are needed: they are what bounds the window.
									{:else}
										This opens a {windowLabel(autonomyMinutes)} window allowing
										<span class="mono">{autonomySms.trim()}</span> SMS and
										<span class="mono">{autonomyWrites.trim()}</span> writes, with no Accept in between.
									{/if}
								</p>
							</div>
						</form>
					{:else}
						<div class="autonomy-actions autonomy-revoke">
							<button
								type="button"
								class="btn btn-danger btn-sm"
								onclick={() => void revoke()}
								disabled={autonomyBusy !== null}
								aria-busy={autonomyBusy === 'revoking'}
							>
								{#if autonomyBusy === 'revoking'}<Spinner />{:else}<Icon name="stop" size={13} />{/if}
								{autonomyBusy === 'revoking' ? 'Revoking' : 'Revoke the window'}
							</button>
							<p class="hint">
								Revoke stops the window now and closes any agent session it opened. What the agent
								already did stays done; nothing is undone.
							</p>
						</div>
						{#if autonomyFailure !== null}
							<p class="state-line" data-tone={failureTone(autonomyFailure)}>
								{failureLine(autonomyFailure)}
							</p>
						{/if}
					{/if}
				{/if}
			</section>
		</div>
	{/if}
</div>

<style>
	/* The two cards keep their own height: the allowance is a short readout and
	   should not stretch to the model form's foot. */
	.bento {
		align-items: start;
	}

	.ai-form {
		margin-top: var(--df-p-space-4);
		gap: var(--df-p-space-4) var(--df-p-space-4);
	}

	/* The key state spans the form: it is a fact about the deployment, not a
	   third field beside provider and model. */
	.key-block {
		grid-column: 1 / -1;
		display: flex;
		flex-direction: column;
		gap: var(--df-p-space-2);
		padding-top: var(--df-p-space-3);
		border-top: 1px solid var(--df-border-hairline);
	}

	.key-head {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-2);
		flex-wrap: wrap;
	}

	/* Two rows, one per role. A row is a name and an answer: the secret that
	   answered it, or the sentence that says it needs none. */
	.key-roles {
		display: flex;
		flex-direction: column;
		margin: 0;
		padding: 0;
		list-style: none;
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-xs);
	}

	.key-role {
		display: flex;
		flex-direction: column;
		gap: 6px;
		min-width: 0;
		padding: 8px 10px;
	}

	.key-role + .key-role {
		border-top: 1px solid var(--df-border-hairline);
	}

	.key-role-head {
		display: flex;
		align-items: baseline;
		gap: 10px;
		flex-wrap: wrap;
	}

	/* A shared column, so the two answers line up and the eye compares names
	   instead of reading two sentences. */
	.key-role-name {
		flex: none;
		min-width: 84px;
		color: var(--df-text-secondary);
		font-size: var(--df-p-text-sm);
	}

	.key-source {
		min-width: 0;
		color: var(--df-text-primary);
		font-size: var(--df-p-text-sm);
		overflow-wrap: anywhere;
	}

	/* Workers AI: a fact about the binding, not something to fix, so it keeps
	   the secondary ink rather than a warning colour. */
	.key-role[data-state='binding'] .key-source {
		color: var(--df-text-secondary);
	}

	.key-source[data-tone='missing'] {
		color: var(--df-state-warn-ink);
	}

	.key-source[data-tone='unreported'] {
		color: var(--df-text-meta);
		font-style: italic;
	}

	.gateway-hint {
		display: flex;
		gap: 8px;
		align-items: baseline;
		flex-wrap: wrap;
	}

	.command {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-2);
		padding: 8px 10px;
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-sm);
		background: var(--df-surface-well);
		min-width: 0;
	}

	.command code {
		font-family: var(--df-p-font-mono);
		font-size: var(--df-p-text-sm);
		color: var(--df-text-primary);
		overflow-wrap: anywhere;
	}

	.field-note {
		grid-column: 1 / -1;
	}

	/* ---------- System One ---------- */

	/* The quieter group: a hairline box with its name on the rule, no fill, no
	   shadow. It is inside the form and is saved by the same Save. */
	.s1 {
		grid-column: 1 / -1;
		min-width: 0;
		margin: 0;
		padding: var(--df-p-space-2) var(--df-p-space-3) var(--df-p-space-3);
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-xs);
	}

	.s1-title {
		padding: 0 6px;
		color: var(--df-text-secondary);
		font-family: var(--df-p-font-mono);
		font-size: var(--df-p-text-2xs);
		letter-spacing: 0.1em;
		text-transform: uppercase;
	}

	.s1-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--df-p-space-2);
		flex-wrap: wrap;
	}

	.s1-note {
		max-width: 56ch;
		color: var(--df-text-meta);
		font-size: 11.5px;
		line-height: 1.45;
	}

	.s1-head .btn {
		flex: none;
	}

	/* Two fields when both are there, one when the provider has no base URL:
	   `auto-fit` fills the box instead of leaving a dead half. */
	.s1-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
		gap: var(--df-p-space-3) var(--df-p-space-4);
		margin-top: var(--df-p-space-3);
	}

	.s1-grid .field {
		gap: 4px;
	}

	.s1-check {
		margin-bottom: 2px;
		font-size: var(--df-p-text-sm);
	}

	
	/* While a save or a probe is in flight the group is disabled; a field that
	   still looks editable invites a click that does nothing. */
	.s1 .input:disabled {
		color: var(--df-text-meta);
	}

	.s1-inherited {
		padding-top: 2px;
	}

	.s1-result {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	/* The rule belongs to the block that has something in it: the wrapper stays
	   mounted (it is the live region) and must not draw a line while it is empty. */
	.s1-result-body {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin-top: var(--df-p-space-3);
		padding-top: var(--df-p-space-3);
		border-top: 1px solid var(--df-border-hairline);
	}

	/* The held state is one line, and it needs the same rule above it. */
	.s1-result > .state-line {
		margin-top: var(--df-p-space-3);
		padding-top: var(--df-p-space-3);
		border-top: 1px solid var(--df-border-hairline);
	}

	.s1-result-head {
		display: flex;
		align-items: baseline;
		gap: 10px;
		flex-wrap: wrap;
		color: var(--df-text-meta);
		font-size: var(--df-p-text-xs);
	}

	.s1-result-detail {
		overflow-wrap: anywhere;
	}

	/* One row per answer: the id, the kind, and the value the provider gave. */
	.answer-list {
		display: flex;
		flex-direction: column;
		margin: 0;
		padding: 0;
		list-style: none;
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-xs);
	}

	.answer-list li {
		display: flex;
		align-items: baseline;
		gap: 10px;
		flex-wrap: wrap;
		min-width: 0;
		padding: 5px 10px;
		font-size: var(--df-p-text-sm);
	}

	.answer-list li + li {
		border-top: 1px solid var(--df-border-hairline);
	}

	.answer-id {
		flex: none;
		min-width: 72px;
		color: var(--df-text-secondary);
	}

	/* The kind is a wire token (`choice`, `noul`, `score`), so it keeps the code
	   face and its own spelling rather than being shouted as a heading. */
	.answer-kind {
		flex: none;
		min-width: 46px;
		color: var(--df-text-meta);
		font-family: var(--df-p-font-mono);
		font-size: var(--df-p-text-2xs);
	}

	.answer-value {
		flex: 1 1 auto;
		min-width: 0;
		color: var(--df-text-primary);
		overflow-wrap: anywhere;
	}

	/* A confirmation is a line of text, not a second pastel card under the form. */
	.saved-line {
		grid-column: 1 / -1;
		display: flex;
		align-items: center;
		gap: 6px;
		color: var(--df-state-ok-ink);
		font-size: var(--df-p-text-sm);
	}

	.dirty-note {
		margin-left: auto;
		color: var(--df-text-meta);
		font-size: var(--df-p-text-2xs);
		letter-spacing: 0.04em;
	}

	.mono-ink {
		color: var(--df-text-primary);
	}

	.test-result {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin-top: var(--df-p-space-4);
		padding-top: var(--df-p-space-3);
		border-top: 1px solid var(--df-border-hairline);
	}

	/* ---------- the catalogue ---------- */

	/* A field head that holds an action is 32px tall. Every labelled field in the
	   form takes the same height, so the action moves no input off its line. */
	.ai-form .field > .label {
		align-items: center;
		min-height: 32px;
	}

	.model-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--df-p-space-2);
		flex-wrap: wrap;
		min-height: 32px;
	}

	.model-head .btn {
		flex: none;
	}

	.models-block {
		display: flex;
		flex-direction: column;
		gap: var(--df-p-space-2);
		margin-top: var(--df-p-space-4);
		padding-top: var(--df-p-space-3);
		border-top: 1px solid var(--df-border-hairline);
	}

	.models-head {
		display: flex;
		align-items: baseline;
		gap: 8px;
		flex-wrap: wrap;
		color: var(--df-text-meta);
		font-size: var(--df-p-text-xs);
		line-height: 1.5;
	}

	.models-kicker {
		letter-spacing: 0.1em;
		text-transform: uppercase;
	}

	.models-count {
		color: var(--df-text-primary);
	}

	.models-dot {
		color: var(--df-border-control);
	}

	/* One column of ids: a model name is the row's whole content, and a grid of
	   them would break the longest names into two lines. */
	.model-list {
		margin: 0;
		padding: 0;
		list-style: none;
		/* Ten rows, which is what a provider usually lists: a longer catalogue
		   scrolls here rather than stretching the card to the end of the page. */
		max-height: 340px;
		overflow-y: auto;
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-xs);
		background: var(--df-surface-card);
	}

	.model-list li + li {
		border-top: 1px solid var(--df-border-hairline);
	}

	.model-option {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-2);
		width: 100%;
		min-height: 30px;
		padding: 5px 10px;
		border: 0;
		border-radius: var(--df-p-radius-xs);
		background: transparent;
		color: var(--df-text-primary);
		font: inherit;
		text-align: left;
		cursor: pointer;
		transition: background-color 140ms ease;
	}

	.model-option:hover {
		background: var(--df-surface-well);
	}

	.model-option:focus-visible {
		outline: 2px solid var(--df-accent-text);
		outline-offset: -2px;
	}

	/* The id the field holds. The check is there so the state is not colour alone. */
	.model-option[aria-current='true'] {
		background: var(--df-accent-soft);
	}

	.model-mark {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 12px;
		flex: none;
		color: var(--df-accent-text);
	}

	.model-id {
		font-family: var(--df-p-font-mono);
		font-size: var(--df-p-text-sm);
		letter-spacing: -0.01em;
		overflow-wrap: anywhere;
	}

	.model-owner {
		margin-left: auto;
		font-family: var(--df-p-font-mono);
		font-size: var(--df-p-text-2xs);
		color: var(--df-text-meta);
		white-space: nowrap;
	}

	.state-line[data-tone='muted'] {
		color: var(--df-text-meta);
	}

	.sample-label {
		display: flex;
		align-items: baseline;
		gap: 8px;
		flex-wrap: wrap;
		color: var(--df-text-meta);
		font-size: var(--df-p-text-xs);
		letter-spacing: 0.1em;
		text-transform: uppercase;
	}

	.sample-model {
		color: var(--df-text-secondary);
		letter-spacing: 0.01em;
		text-transform: none;
		overflow-wrap: anywhere;
	}

	/* The provider's words, not the console's: pre-wrap and no quotes, so a
	   sample that was shaped like a reply stays shaped like one. */
	.sample-text {
		padding: 10px 12px;
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-sm);
		background: var(--df-surface-well);
		color: var(--df-text-primary);
		font-size: var(--df-p-text-sm);
		line-height: 1.55;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.state-line {
		font-size: var(--df-p-text-sm);
		line-height: 1.5;
	}

	.state-line[data-tone='danger'] {
		color: var(--df-state-danger-ink);
	}

	.state-line[data-tone='warn'] {
		color: var(--df-state-warn-ink);
	}

	.detail {
		display: block;
		margin-top: 4px;
		color: var(--df-text-meta);
	}

	/* ---------- the allowance ---------- */

	.budget-value {
		display: flex;
		align-items: baseline;
		gap: 6px;
		margin-top: var(--df-p-space-2);
		color: var(--df-text-primary);
		font-size: 30px;
		font-weight: 600;
		letter-spacing: -0.02em;
	}

	.budget-slash {
		color: var(--df-text-meta);
		font-weight: 400;
	}

	.budget-unit {
		margin-left: 4px;
		color: var(--df-text-meta);
		font-size: var(--df-p-text-sm);
		font-weight: 500;
		letter-spacing: 0.02em;
	}

	.budget-bar {
		height: 6px;
		margin: var(--df-p-space-2) 0 var(--df-p-space-3);
		border-radius: var(--df-p-radius-pill);
		background: var(--df-surface-well);
		overflow: hidden;
	}

	.budget-fill {
		display: block;
		height: 100%;
		border-radius: inherit;
		background: var(--df-state-info-ink);
	}

	.budget-fill[data-tone='spent'] {
		background: var(--df-state-warn-ink);
	}

	.budget-day {
		margin-top: var(--df-p-space-2);
		color: var(--df-text-meta);
		font-size: var(--df-p-text-xs);
	}

	/* ---------- autonomy ---------- */

	/* The runtime's state is a fact about the deployment, so it sits on the card's
	   own head, quiet, and wraps under the title on a phone. */
	.autonomy-head {
		flex-wrap: wrap;
	}

	.autonomy-runtime {
		margin-left: auto;
		color: var(--df-text-meta);
		font-size: var(--df-p-text-2xs);
		letter-spacing: 0.02em;
		overflow-wrap: anywhere;
	}

	/* The sentence that must never be softened: what an open window means. */
	.autonomy-consequence {
		max-width: 74ch;
		color: var(--df-text-secondary);
		font-size: var(--df-p-text-base);
		line-height: 1.55;
	}

	.autonomy-consequence[data-state='open'] {
		color: var(--df-state-warn-ink);
	}

	/* The window, the caps and today's count, as rows: a readout, not a form. */
	.autonomy-facts {
		display: flex;
		flex-direction: column;
		max-width: 620px;
		margin: var(--df-p-space-3) 0 0;
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-xs);
	}

	.autonomy-fact {
		display: flex;
		align-items: baseline;
		gap: 10px;
		min-width: 0;
		padding: 6px 10px;
	}

	.autonomy-fact + .autonomy-fact {
		border-top: 1px solid var(--df-border-hairline);
	}

	.autonomy-fact dt {
		flex: none;
		min-width: 92px;
		color: var(--df-text-meta);
		font-size: var(--df-p-text-xs);
	}

	.autonomy-fact dd {
		min-width: 0;
		margin: 0;
		color: var(--df-text-primary);
		font-size: var(--df-p-text-sm);
		overflow-wrap: anywhere;
	}

	.autonomy-form {
		display: flex;
		flex-direction: column;
		gap: var(--df-p-space-3);
		max-width: 620px;
		margin-top: var(--df-p-space-4);
		padding-top: var(--df-p-space-3);
		border-top: 1px solid var(--df-border-hairline);
	}

	.autonomy-fields {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
		gap: var(--df-p-space-3) var(--df-p-space-4);
	}

	/* The deliberate step reads as one sentence in a box, not as a checkbox with a
	   label: it is the thing being agreed to. */
	.autonomy-ack {
		max-width: 72ch;
		padding: 9px 11px;
		border: 1px solid var(--df-border-control);
		border-radius: var(--df-p-radius-xs);
		background: var(--df-surface-well);
		color: var(--df-text-primary);
		font-size: var(--df-p-text-sm);
		line-height: 1.5;
	}

	.autonomy-blocked {
		color: var(--df-state-warn-ink);
	}

	.autonomy-actions {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 6px;
	}

	.autonomy-actions .hint {
		max-width: 70ch;
	}

	.autonomy-revoke {
		margin-top: var(--df-p-space-4);
		padding-top: var(--df-p-space-3);
		border-top: 1px solid var(--df-border-hairline);
	}

	.autonomy-gap {
		margin-top: var(--df-p-space-3);
		max-width: 74ch;
	}

	.autonomy-again {
		margin-top: var(--df-p-space-3);
	}

	@media (max-width: 720px) {
		.budget-value {
			font-size: 26px;
		}

		.autonomy-runtime {
			margin-left: 0;
			flex-basis: 100%;
		}
	}
</style>
