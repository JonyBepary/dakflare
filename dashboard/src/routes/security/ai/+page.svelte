<script lang="ts">
	/**
	 * AI settings — which provider answers the assistant, whether this gateway
	 * holds a key, and how much of today's allowance is gone.
	 *
	 * Three things this page refuses to do, because each one would be a lie the
	 * operator cannot see:
	 *
	 *  - It never holds, shows or accepts a key. The gateway reports whether one
	 *    exists (`apiKeyConfigured`) and nothing more; a field here would put a
	 *    secret into a browser history, a log or a screenshot. The missing-key
	 *    state is a `wrangler secret put` command, not an input.
	 *  - It never turns "nobody said" into zero. `used` and `limit` are nullable,
	 *    and an absent number is a dash with a sentence, not `0 / 0`.
	 *  - It never claims the saved document is what was typed. After a save the
	 *    page renders the document the gateway sent back.
	 *
	 * There is no key field anywhere in this file; the PUT body is
	 * `AiSettingsInput`, which has three fields.
	 */
	import { onMount } from 'svelte';
	import {
		failureLine,
		failureTone,
		getAiSettings,
		saveAiSettings,
		testAi,
		type AiProvider,
		type AiSettings,
		type Failure,
		type TestOutcome
	} from '$lib/assistant';
	import { session } from '$lib/session.svelte';
	import { ROUTES } from '$lib/paths';
	import CopyButton from '$lib/components/CopyButton.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import Notice from '$lib/components/Notice.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Spinner from '$lib/components/Spinner.svelte';

	const KEY_COMMAND = 'wrangler secret put AI_CHAT_API_KEY';

	let settings = $state<AiSettings | null>(null);
	let loading = $state(true);
	let loadFailure = $state<Failure | null>(null);

	/** The form's copy of the three writable fields. Nothing else is writable. */
	let provider = $state<AiProvider>('workers-ai');
	let model = $state('');
	let baseUrl = $state('');

	let saving = $state(false);
	let saveFailure = $state<Failure | null>(null);
	let fieldError = $state<string | null>(null);
	let saved = $state(false);

	let testing = $state(false);
	let test = $state<TestOutcome | null>(null);

	const allowed = $derived(session.canViewSecurity);

	/** The document as the gateway holds it, so "unsaved" means something. */
	const dirty = $derived(
		settings !== null &&
			(provider !== settings.provider ||
				model !== settings.model ||
				baseUrl !== settings.baseUrl)
	);

	const busy = $derived(saving || testing);

	const keyConfigured = $derived(settings?.apiKeyConfigured === true);

	/**
	 * Only an external gateway takes a key. Workers AI answers through this
	 * Worker's own binding, so `apiKeyConfigured` is false by definition there and
	 * must not be rendered as something to fix.
	 */
	const needsKey = $derived(settings === null || settings.provider !== 'workers-ai');

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
		const result = await getAiSettings();
		if (result.status === 'ok') applySettings(result.settings);
		else {
			settings = null;
			loadFailure = result.failure;
		}
		loading = false;
	}

	function applySettings(next: AiSettings): void {
		settings = next;
		provider = next.provider;
		model = next.model;
		baseUrl = next.baseUrl;
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

		fieldError = null;
		saveFailure = null;
		saved = false;
		saving = true;
		const result = await saveAiSettings({
			provider,
			model: nextModel,
			baseUrl: provider === 'openai-compatible' ? nextBase : ''
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
</script>

<svelte:head>
	<title>AI assistant · DakFlare</title>
</svelte:head>

<div class="page">
	<PageHeader
		eyebrow="Security"
		title="AI assistant"
		description="Which model answers the assistant, whether this gateway holds its key, and what is left of today's allowance. The key is never shown here, because it is never here: it lives in the Worker as a secret."
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
					Run it in the Worker's directory and paste the key at the prompt. It is stored as a secret and
					is never sent to this page.
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
					<h2 id="model-title" class="card-title">Model</h2>
				</header>
				<p class="card-note">
					What the assistant answers with. A saved change applies to the next question; nothing already
					asked is repeated.
				</p>

				<form class="form-grid ai-form" onsubmit={save} novalidate>
					<div class="field">
						<label class="label" for="ai-provider">Provider</label>
						<select id="ai-provider" class="input" bind:value={provider} disabled={busy}>
							<option value="workers-ai">Workers AI</option>
							<option value="openai-compatible">OpenAI-compatible</option>
						</select>
						<p class="hint">
							{#if provider === 'workers-ai'}
								Runs in the Worker's own account. No base URL, and no key unless the model needs one.
							{:else}
								Any endpoint that speaks the OpenAI chat shape, including a gateway in front of
								several providers.
							{/if}
						</p>
					</div>

					<div class="field">
						<label class="label" for="ai-model">Model</label>
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

					<div class="key-block">
						<div class="key-head">
							<span class="label">Chat key</span>
							{#if needsKey}
								<span class="chip" data-tone={keyConfigured ? 'ok' : 'warn'}>
									{keyConfigured ? 'key configured' : 'not configured'}
								</span>
							{:else}
								<span class="chip" data-tone="muted">not needed</span>
							{/if}
						</div>
						{#if !needsKey}
							<!-- The default provider answers through the Worker's own AI binding.
							     Telling this operator to install a secret they do not need, directly
							     above a gateway hint saying no key is needed, reads as a broken
							     deployment. -->
							<p class="hint">
								Workers AI answers through this Worker's own <span class="mono">AI</span> binding, so
								there is no key to install. Choose OpenAI-compatible above if the model should be
								served by an external gateway.
							</p>
						{:else if keyConfigured}
							<p class="hint">
								The Worker holds a chat key. This page can see that it exists and nothing else: the
								value never leaves the Worker, so there is nothing to copy, replace or reveal here.
							</p>
						{:else}
							<p class="hint">
								The Worker has no chat key, so the assistant answers 503 until one is set. That is a
								deployment step, not a field on this page: a key typed into a browser ends up in a
								history, a log or a screenshot.
							</p>
							<div class="command">
								<code>{KEY_COMMAND}</code>
								<CopyButton value={KEY_COMMAND} iconOnly label="Copy the key command" />
							</div>
							<p class="hint">
								Run it in the Worker's directory, paste the key at the prompt, then
								<span class="mono">Check again</span> above.
							</p>
						{/if}
						{#if settings.hint && (!needsKey || keyConfigured || !settings.hint.includes('AI_CHAT_API_KEY'))}
							<!-- When the key is missing the gateway's hint is that same command,
							     which the block above already prints once. -->
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
							{testing ? 'Testing' : 'Test'}
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
						Test uses the saved model, not the one above: it asks the gateway what it is configured with
						now. Save first to test a change.
					</p>
				{/if}

				{#if test !== null}
					<div class="test-result">
						{#if test.status === 'ok'}
							<p class="sample-label">
								<span class="mono">sample response</span>
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

	@media (max-width: 720px) {
		.budget-value {
			font-size: 26px;
		}
	}
</style>
