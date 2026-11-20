<script lang="ts">
	import { onMount, tick } from 'svelte';
	import {
		createConnector,
		deleteConnector,
		describeError,
		getConnectors,
		registerTelegramWebhook,
		updateConnector
	} from '$lib/api';
	import { announce } from '$lib/announce.svelte';
	import {
		channelWord,
		INSTAGRAM_AUTH_MODES,
		OFFICIAL_CHANNELS,
		type OfficialChannelId
	} from '$lib/channels';
	import { session } from '$lib/session.svelte';
	import type {
		ChannelConnector,
		ConnectorInput,
		ConnectorSecret,
		InstagramAuthMode
	} from '$lib/types';
	import Badge from '$lib/components/Badge.svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import CopyButton from '$lib/components/CopyButton.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import Notice from '$lib/components/Notice.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import RelativeTime from '$lib/components/RelativeTime.svelte';
	import Spinner from '$lib/components/Spinner.svelte';

	const uid = $props.id();
	const labelId = `connector-label-${uid}`;
	const accountId = `connector-account-${uid}`;
	const authModeId = `connector-auth-${uid}`;
	const accessTokenId = `connector-access-${uid}`;
	const appSecretId = `connector-secret-${uid}`;
	const verifyTokenId = `connector-verify-${uid}`;
	const botTokenId = `connector-bot-${uid}`;
	const secretTokenId = `connector-hook-secret-${uid}`;

	let connectors = $state<ChannelConnector[]>([]);
	let loading = $state(true);
	let loadError = $state<string | null>(null);
	let flash = $state<string | null>(null);

	let formOpen = $state(false);
	let saving = $state(false);
	let formError = $state<string | null>(null);
	let addButton = $state<HTMLButtonElement | null>(null);

	/** The form's own state. Credentials live here only until the POST resolves. */
	let platform = $state<OfficialChannelId>('whatsapp');
	let name = $state('');
	let account = $state('');
	let authMode = $state<InstagramAuthMode>('unified_login');
	let accessToken = $state('');
	let appSecret = $state('');
	let verifyToken = $state('');
	let botToken = $state('');
	let secretToken = $state('');

	let busyId = $state<string | null>(null);
	/** The row whose `setWebhook` call is in flight; separate from pause/resume. */
	let registeringId = $state<string | null>(null);
	/** A refused register call, shown beside the flash a success would use. */
	let actionError = $state<string | null>(null);
	let pendingDelete = $state<ChannelConnector | null>(null);
	let deleting = $state(false);
	let deleteError = $state<string | null>(null);

	const canManage = $derived(session.canWrite);
	const meta = $derived(
		OFFICIAL_CHANNELS.find((option) => option.id === platform) ?? OFFICIAL_CHANNELS[0]
	);
	const enabledCount = $derived(connectors.filter((item) => item.enabled).length);

	/**
	 * The first thing the form is still missing, in the order the fields appear.
	 * A sentence rather than a boolean: a disabled Create button with no reason
	 * is the one dead end this form must not have.
	 */
	const formProblem = $derived.by(() => {
		if (name.trim() === '') return 'Give this connector a name.';
		if (account.trim() === '') return `Enter the ${meta.accountIdLabel.toLowerCase()}.`;
		if (platform === 'telegram') {
			if (botToken.trim() === '') return 'Paste the bot token from BotFather.';
			return null;
		}
		if (accessToken.trim() === '') {
			return platform === 'messenger'
				? 'Paste the Page access token.'
				: 'Paste the access token.';
		}
		if (appSecret.trim() === '') return 'Paste the app secret from the Meta app dashboard.';
		if (verifyToken.trim() === '') return 'Choose a verify token and enter it here and at Meta.';
		return null;
	});

	/** The public ingress for this connector's events, built from the route it answers. */
	function webhookUrl(item: ChannelConnector): string {
		const origin = typeof window === 'undefined' ? '' : window.location.origin;
		return `${origin}/v1/channels/${item.channel}/${item.id}/webhook`;
	}

	async function refresh(): Promise<void> {
		loading = true;
		loadError = null;
		try {
			connectors = await getConnectors();
		} catch (failure) {
			loadError = describeError(failure);
		} finally {
			loading = false;
		}
	}

	function openForm(): void {
		formError = null;
		flash = null;
		formOpen = true;
	}

	function closeForm(): void {
		formOpen = false;
		formError = null;
		void tick().then(() => addButton?.focus());
	}

	/** Clear every credential as soon as the request no longer needs it. */
	function resetForm(): void {
		name = '';
		account = '';
		authMode = 'unified_login';
		accessToken = '';
		appSecret = '';
		verifyToken = '';
		botToken = '';
		secretToken = '';
	}

	async function submitCreate(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (saving || formProblem !== null) return;
		saving = true;
		formError = null;
		flash = null;

		const secret: ConnectorSecret =
			platform === 'telegram'
				? {
						botToken: botToken.trim(),
						...(secretToken.trim() === '' ? {} : { secretToken: secretToken.trim() })
					}
				: {
						appSecret: appSecret.trim(),
						verifyToken: verifyToken.trim(),
						accessToken: accessToken.trim()
					};

		const input: ConnectorInput = {
			channel: platform,
			account_id: account.trim(),
			label: name.trim(),
			secret,
			...(platform === 'instagram' ? { auth_mode: authMode } : {})
		};

		try {
			const created = await createConnector(input);
			connectors = [created, ...connectors];
			flash = `${created.label} is connected. Copy its webhook URL into the platform dashboard so events reach this account.`;
			// The row exists now, so the credential has no reason to stay in memory.
			resetForm();
			closeForm();
		} catch (failure) {
			// Nothing was saved, so the typed values stay for a second attempt.
			formError = describeError(failure);
		} finally {
			saving = false;
		}
	}

	async function toggleEnabled(item: ChannelConnector): Promise<void> {
		if (busyId !== null) return;
		busyId = item.id;
		loadError = null;
		try {
			const next = await updateConnector(item.id, { enabled: !item.enabled });
			connectors = connectors.map((row) => (row.id === next.id ? next : row));
			announce(`${next.label} ${next.enabled ? 'resumed' : 'paused'}.`);
		} catch (failure) {
			loadError = describeError(failure);
		} finally {
			busyId = null;
		}
	}

	/**
	 * Telegram's one-click `setWebhook`, asked for from the row.
	 *
	 * The bot token never crosses this screen: the Worker unseals it and calls
	 * Telegram itself, and answers with the public URL Telegram will post to.
	 * That URL is the only thing the row says back.
	 */
	async function registerWebhook(item: ChannelConnector): Promise<void> {
		if (registeringId !== null) return;
		registeringId = item.id;
		actionError = null;
		flash = null;
		try {
			const result = await registerTelegramWebhook(item.id);
			flash = `Telegram now posts to ${result.webhook_url}.`;
		} catch (failure) {
			actionError = describeError(failure);
		} finally {
			registeringId = null;
		}
	}

	function askDelete(item: ChannelConnector): void {
		deleteError = null;
		pendingDelete = item;
	}

	function cancelDelete(): void {
		if (deleting) return;
		pendingDelete = null;
		deleteError = null;
	}

	async function confirmDelete(): Promise<void> {
		const target = pendingDelete;
		if (!target || deleting) return;
		deleting = true;
		deleteError = null;
		try {
			await deleteConnector(target.id);
			connectors = connectors.filter((row) => row.id !== target.id);
			flash = `${target.label} was removed. Its webhook URL no longer answers.`;
			pendingDelete = null;
		} catch (failure) {
			deleteError = describeError(failure);
		} finally {
			deleting = false;
		}
	}

	onMount(() => {
		if (!canManage) {
			loading = false;
			return;
		}
		void refresh();
	});
</script>

<svelte:head>
	<title>Channels · DakFlare</title>
</svelte:head>

<div class="page">
	<PageHeader
		eyebrow="Delivery"
		title="Channels"
		description="One connector per external account. Each holds its own credential, receives that account's events on its own webhook, and can reply from Messages."
	>
		{#if canManage}
			<button
				type="button"
				class="btn header-action"
				onclick={() => void refresh()}
				disabled={loading}
				aria-busy={loading}
			>
				{#if loading}<Spinner />{:else}<Icon name="refresh" size={14} />{/if}
				Refresh
			</button>
			{#if connectors.length > 0 || formOpen}
				<button
					type="button"
					class="btn header-action {formOpen ? '' : 'btn-primary'}"
					bind:this={addButton}
					onclick={() => (formOpen ? closeForm() : openForm())}
					aria-expanded={formOpen}
					aria-controls={formOpen ? 'connector-form' : undefined}
				>
					<Icon name={formOpen ? 'x' : 'plus'} size={14} />
					{formOpen ? 'Close form' : 'Add connector'}
				</button>
			{/if}
		{/if}
	</PageHeader>

	{#if loadError}
		<div class="banner">
			<Notice tone="danger" title="Could not load the connectors">{loadError}</Notice>
			<button type="button" class="btn btn-sm" onclick={() => void refresh()}>
				<Icon name="refresh" size={13} /> Try again
			</button>
		</div>
	{/if}

	{#if flash}
		<div class="banner">
			<Notice tone="ok">{flash}</Notice>
		</div>
	{/if}

	{#if actionError}
		<div class="banner">
			<Notice tone="danger" title="The webhook was not registered">{actionError}</Notice>
		</div>
	{/if}

	{#if formOpen && canManage}
		<section class="card editor settle" id="connector-form" aria-labelledby="connector-form-heading">
			<div class="editor-head">
				<div>
					<h2 class="editor-title" id="connector-form-heading">New {meta.label} connector</h2>
					<p class="editor-note">
						One account's credential and webhook. Add a separate connector for every account you
						reply from.
					</p>
				</div>
			</div>

			<form onsubmit={(event) => void submitCreate(event)} novalidate>
				<div class="platform">
					<p class="platform-label" id={`platform-${uid}`}>Platform</p>
					<div class="seg platform-seg" role="group" aria-labelledby={`platform-${uid}`}>
						{#each OFFICIAL_CHANNELS as option (option.id)}
							<label class="seg-item">
								<input type="radio" name="platform" value={option.id} bind:group={platform} />
								<span>{option.word}</span>
							</label>
						{/each}
					</div>
				</div>

				<div class="form-grid">
					<div class="field">
						<label class="label" for={labelId}>Name</label>
						<input
							id={labelId}
							class="input"
							bind:value={name}
							maxlength="64"
							placeholder="e.g. Support line"
							autocomplete="off"
							disabled={saving}
						/>
					</div>

					<div class="field">
						<label class="label" for={accountId}>{meta.accountIdLabel}</label>
						<input
							id={accountId}
							class="input input-mono"
							bind:value={account}
							maxlength="200"
							placeholder={meta.accountIdPlaceholder}
							autocomplete="off"
							spellcheck="false"
							disabled={saving}
						/>
					</div>

					{#if meta.supportsAuthModes}
						<div class="field">
							<label class="label" for={authModeId}>Login</label>
							<select id={authModeId} class="input" bind:value={authMode} disabled={saving}>
								{#each INSTAGRAM_AUTH_MODES as option (option.value)}
									<option value={option.value}>{option.label}</option>
								{/each}
							</select>
							<p class="hint">
								One of three logins: Unified Login (the usual choice), Instagram Login, or
								Facebook Login. Pick the one that issued this account's token.
							</p>
						</div>
					{/if}

					{#if platform === 'telegram'}
						<div class="field">
							<label class="label" for={botTokenId}>Bot token</label>
							<input
								id={botTokenId}
								class="input input-mono"
								type="password"
								bind:value={botToken}
								placeholder="123456:ABC-DEF…"
								autocomplete="off"
								spellcheck="false"
								disabled={saving}
							/>
						</div>
						<div class="field">
							<label class="label" for={secretTokenId}>
								Webhook secret <span class="optional">optional</span>
							</label>
							<input
								id={secretTokenId}
								class="input input-mono"
								type="password"
								bind:value={secretToken}
								placeholder="X-Telegram-Bot-Api-Secret-Token"
								autocomplete="off"
								spellcheck="false"
								disabled={saving}
							/>
							<p class="hint">Telegram echoes this value back on every webhook call.</p>
						</div>
					{:else}
						<div class="field">
							<label class="label" for={accessTokenId}>
								{platform === 'messenger' ? 'Page access token' : 'Access token'}
							</label>
							<input
								id={accessTokenId}
								class="input input-mono"
								type="password"
								bind:value={accessToken}
								placeholder={platform === 'whatsapp' ? 'EAAG…' : 'IGAA…'}
								autocomplete="off"
								spellcheck="false"
								disabled={saving}
							/>
						</div>
						<div class="field">
							<label class="label" for={appSecretId}>App secret</label>
							<input
								id={appSecretId}
								class="input input-mono"
								type="password"
								bind:value={appSecret}
								placeholder="32 character hex app secret"
								autocomplete="off"
								spellcheck="false"
								disabled={saving}
							/>
							<p class="hint">Verifies the signature on every webhook call.</p>
						</div>
						<div class="field">
							<label class="label" for={verifyTokenId}>Verify token</label>
							<input
								id={verifyTokenId}
								class="input input-mono"
								bind:value={verifyToken}
								placeholder="The string you also enter at Meta"
								autocomplete="off"
								spellcheck="false"
								disabled={saving}
							/>
							<p class="hint">Meta echoes this value when it verifies the webhook.</p>
						</div>
					{/if}

					<p class="hint form-note">
						Credentials are sealed at rest. After saving, the gateway shows only that a secret is
						set and when it last changed, never the value.
					</p>

					<div class="form-foot">
						<button type="submit" class="btn btn-primary" disabled={saving || formProblem !== null} aria-busy={saving}>
							{#if saving}<Spinner />{:else}<Icon name="plus" size={14} />{/if}
							Create connector
						</button>
						<button type="button" class="btn" onclick={closeForm} disabled={saving}>
							Cancel
						</button>
						{#if !saving && formProblem}
							<p class="form-hint hint">{formProblem}</p>
						{/if}
					</div>

					{#if formError}
						<div class="form-error">
							<Notice tone="danger" title="The connector was not created">{formError}</Notice>
						</div>
					{/if}
				</div>
			</form>
		</section>
	{/if}

	{#if loading && canManage}
		<div class="loading-card card" aria-busy="true" aria-live="polite">
			<span class="sr-only">Loading channel connectors</span>
			<div class="skeleton"></div>
			<div class="skeleton"></div>
		</div>
	{:else if !canManage}
		<section class="card">
			<EmptyState
				icon="shield"
				title="Connectors are hidden for a member account"
				description="Connector credentials are managed by owners and admins, so a member account does not see them. The connectors this gateway has are hidden from you, not absent. Ask an owner if one needs to be added, paused or retired."
			/>
		</section>
	{:else if !loadError && connectors.length === 0}
		<section class="card">
			<EmptyState
				icon="send"
				title="No connectors yet"
				description="Add WhatsApp, Telegram, Messenger or Instagram to receive that account's events and answer from Messages. Each connector gets its own webhook URL."
			>
				{#if !formOpen}
					<button
						type="button"
						class="btn btn-primary"
						bind:this={addButton}
						onclick={openForm}
					>
						<Icon name="plus" size={14} /> Add the first connector
					</button>
				{/if}
			</EmptyState>
		</section>
	{:else if connectors.length > 0}
		<p class="list-note">
			<span class="mono">{connectors.length}</span>
			{connectors.length === 1 ? 'connector' : 'connectors'}
			<span aria-hidden="true">·</span>
			<span class="mono">{enabledCount}</span>
			enabled
		</p>
		<ul class="connector-list">
			{#each connectors as item, index (item.id)}
				<li class="card settle connector" style={`--i: ${index}`}>
					<div class="connector-head">
						<div class="connector-id">
							<p class="channel-line">
								<span class="channel-word">{channelWord(item.channel)}</span>
								{#if item.auth_mode}
									<span class="auth-mode mono">{item.auth_mode}</span>
								{/if}
							</p>
							<h3 class="connector-label">{item.label}</h3>
						</div>
						<div class="connector-actions">
							<Badge tone={item.enabled ? 'ok' : 'muted'} dot>
								{item.enabled ? 'Active' : 'Paused'}
							</Badge>
							{#if !item.secret_set}
								<Badge tone="warn">No secret</Badge>
							{/if}
							{#if canManage}
								<button
									type="button"
									class="btn btn-sm"
									onclick={() => void toggleEnabled(item)}
									disabled={busyId !== null}
									aria-busy={busyId === item.id}
								>
									{#if busyId === item.id}
										<Spinner />
									{:else}
										<Icon name={item.enabled ? 'pause' : 'play'} size={12} />
									{/if}
									{item.enabled ? 'Pause' : 'Resume'}
								</button>
								{#if item.channel === 'telegram'}
									<button
										type="button"
										class="btn btn-sm register-action"
										onclick={() => void registerWebhook(item)}
										disabled={registeringId !== null || busyId !== null}
										aria-busy={registeringId === item.id}
									>
										{#if registeringId === item.id}
											<Spinner />
										{:else}
											<Icon name="send" size={12} />
										{/if}
										Register webhook
									</button>
								{/if}
								<button
									type="button"
									class="btn btn-sm delete-action"
									onclick={() => askDelete(item)}
									disabled={busyId !== null || deleting}
								>
									<Icon name="trash" size={12} /> Delete
								</button>
							{/if}
						</div>
					</div>

					<dl class="facts">
						<div class="fact">
							<dt>Account</dt>
							<dd class="mono account-value">{item.account_id}</dd>
						</div>
						<div class="fact">
							<dt>Secret</dt>
							<dd>
								{#if item.secret_set}
									set <RelativeTime value={item.secret_updated_at} fallback="just now" />
								{:else}
									not set
								{/if}
							</dd>
						</div>
						<div class="fact">
							<dt>Last event</dt>
							<dd><RelativeTime value={item.last_event_at} fallback="none yet" /></dd>
						</div>
						<div class="fact">
							<dt>Webhook</dt>
							<dd><RelativeTime value={item.last_webhook_at} fallback="none yet" /></dd>
						</div>
					</dl>

					{#if item.last_error}
						<p class="connector-error">
							<Badge tone="warn">Last delivery failed</Badge>
							<span>{item.last_error}</span>
						</p>
					{/if}

					<div class="webhook">
						<div class="webhook-copy">
							<p class="webhook-label">Webhook URL</p>
							<code class="webhook-url">{webhookUrl(item)}</code>
						</div>
						<CopyButton value={webhookUrl(item)} label="Copy URL" />
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</div>

<ConfirmDialog
	open={pendingDelete !== null}
	title={pendingDelete ? `Delete ${pendingDelete.label}?` : 'Delete connector'}
	confirmLabel="Delete connector"
	pending={deleting}
	error={deleteError}
	onconfirm={() => void confirmDelete()}
	oncancel={cancelDelete}
>
	<p class="confirm-copy">
		{pendingDelete ? `${channelWord(pendingDelete.channel)} events` : 'Events'} for this account
		are rejected from the moment it is deleted, and the webhook URL above stops answering. Messages
		already stored stay where they are.
	</p>
</ConfirmDialog>

<style>
	.banner {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-3);
		margin-bottom: var(--df-p-space-4);
	}

	.banner :global(.callout),
	.banner :global(.notice) {
		flex: 1;
		min-width: 0;
	}

	/* ---------- the create panel ---------- */

	.editor {
		margin-bottom: var(--df-p-space-4);
		border-color: color-mix(in srgb, var(--df-accent-text) 24%, var(--df-border-hairline));
	}

	.editor-head {
		margin-bottom: var(--df-p-space-4);
	}

	.editor-title {
		font-family: var(--df-font-display);
		font-size: var(--df-p-text-md);
		font-weight: 700;
	}

	.editor-note {
		margin-top: var(--df-p-space-1);
		max-width: 62ch;
		font-size: var(--df-p-text-sm);
		line-height: 1.5;
		color: var(--df-text-meta);
	}

	.platform {
		display: grid;
		gap: var(--df-p-space-2);
		margin-bottom: var(--df-p-space-4);
	}

	.platform-label {
		font-family: var(--df-p-font-mono);
		font-size: var(--df-p-text-2xs);
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--df-text-meta);
	}

	/* The four platforms are one decision, so they read as one control rather
	   than a select that hides three of them. */
	.platform-seg {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		width: 100%;
	}

	.platform-seg .seg-item {
		display: flex;
		min-width: 0;
	}

	.platform-seg .seg-item span {
		flex: 1;
		height: auto;
		min-height: 32px;
	}

	.form-note {
		grid-column: 1 / -1;
		max-width: 70ch;
	}

	.form-hint {
		margin: 0;
	}

	.form-error {
		grid-column: 1 / -1;
	}

	.confirm-copy {
		font-size: var(--df-p-text-base);
		line-height: 1.55;
		color: var(--df-text-secondary);
	}

	/* ---------- the list ---------- */

	.list-note {
		display: flex;
		align-items: baseline;
		gap: var(--df-p-space-2);
		margin-bottom: var(--df-p-space-2);
		font-size: var(--df-p-text-sm);
		color: var(--df-text-meta);
	}

	.loading-card {
		display: grid;
		gap: var(--df-p-space-3);
	}

	.loading-card .skeleton {
		height: var(--df-p-space-7);
	}

	.connector-list {
		display: grid;
		gap: var(--df-p-space-3);
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.connector {
		display: grid;
		gap: var(--df-p-space-3);
		padding: var(--df-p-space-4);
		min-width: 0;
	}

	.connector-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--df-p-space-3);
		flex-wrap: wrap;
		min-width: 0;
	}

	.connector-id {
		display: grid;
		gap: var(--df-p-space-1);
		min-width: 0;
	}

	.channel-line {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-2);
		flex-wrap: wrap;
	}

	.channel-word {
		font-family: var(--df-p-font-mono);
		font-size: var(--df-p-text-2xs);
		font-weight: 600;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--df-accent-text);
	}

	.auth-mode {
		font-size: var(--df-p-text-2xs);
		color: var(--df-text-meta);
	}

	.connector-label {
		font-family: var(--df-font-display);
		font-size: var(--df-p-text-lg);
		font-weight: 700;
		line-height: 1.2;
		letter-spacing: -0.01em;
		color: var(--df-text-primary);
		overflow-wrap: anywhere;
	}

	.connector-actions {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-2);
		flex-wrap: wrap;
		margin-left: auto;
	}

	/* Delete is the quietest control in the row: at rest it is neutral meta
	   ink, so the name and the state lead, and it only turns danger while the
	   pointer or the keyboard is on it. The 44px target is the row's shared
	   mobile rule below. */
	.delete-action {
		color: var(--df-text-secondary);
		background: transparent;
		border-color: transparent;
		font-weight: 500;
	}

	.delete-action :global(svg) {
		opacity: 0.7;
	}

	.delete-action:disabled {
		color: var(--df-text-meta);
		background: transparent;
		border-color: transparent;
	}

	.delete-action:focus-visible {
		color: var(--df-state-danger-ink);
		background: var(--df-state-danger-bg);
		border-color: var(--df-state-danger-ink);
	}

	@media (hover: hover) and (pointer: fine) {
		.delete-action:hover:not(:disabled) {
			color: var(--df-state-danger-ink);
			background: var(--df-state-danger-bg);
			border-color: color-mix(
				in srgb,
				var(--df-state-danger-ink) 34%,
				var(--df-border-hairline)
			);
		}
	}

	.facts {
		display: flex;
		flex-wrap: wrap;
		gap: var(--df-p-space-2) var(--df-p-space-5);
		margin: 0;
		min-width: 0;
	}

	.fact {
		display: grid;
		gap: var(--df-p-space-1);
		min-width: 0;
	}

	.fact dt {
		font-family: var(--df-p-font-mono);
		font-size: var(--df-p-text-2xs);
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--df-text-meta);
	}

	.fact dd {
		margin: 0;
		font-size: var(--df-p-text-sm);
		color: var(--df-text-secondary);
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.account-value {
		font-size: var(--df-p-text-xs);
		color: var(--df-text-primary);
	}

	/* The Worker's own sentence about the last refused delivery. It sits between
	   the facts and the URL because it explains both: nothing arrived, and the
	   address the platform posts to is the thing to check. */
	.connector-error {
		display: flex;
		align-items: baseline;
		flex-wrap: wrap;
		gap: var(--df-p-space-1) var(--df-p-space-2);
		margin: 0;
		padding: var(--df-p-space-2) var(--df-p-space-3);
		border: 1px solid color-mix(in srgb, var(--df-state-warn-ink) 26%, var(--df-border-hairline));
		border-radius: var(--df-p-radius-sm);
		background: var(--df-state-warn-bg);
		color: var(--df-state-warn-ink);
		font-size: var(--df-p-text-sm);
		line-height: 1.5;
	}

	.connector-error span {
		min-width: 0;
		overflow-wrap: anywhere;
	}

	/* Registering is the row's one useful repair when a webhook was never set:
	   at rest it reads as a plain control, not as the primary action, because
	   most rows already answer. */
	.register-action {
		color: var(--df-text-secondary);
		background: transparent;
		border-color: var(--df-border-hairline);
	}

	.register-action:focus-visible {
		color: var(--df-accent-text);
		border-color: var(--df-border-focus);
	}

	@media (hover: hover) and (pointer: fine) {
		.register-action:hover:not(:disabled) {
			color: var(--df-accent-text);
			border-color: color-mix(in srgb, var(--df-accent-text) 34%, var(--df-border-hairline));
		}
	}

	.webhook {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-2);
		flex-wrap: wrap;
		padding: var(--df-p-space-2) var(--df-p-space-3);
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-sm);
		background: var(--df-surface-well);
	}

	.webhook-copy {
		flex: 1 1 22ch;
		min-width: 0;
		display: grid;
		gap: var(--df-p-space-1);
	}

	.webhook-label {
		font-family: var(--df-p-font-mono);
		font-size: var(--df-p-text-2xs);
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--df-text-meta);
	}

	.webhook-url {
		font-family: var(--df-p-font-mono);
		font-size: var(--df-p-text-xs);
		line-height: 1.45;
		color: var(--df-text-primary);
		overflow-wrap: anywhere;
	}

	@media (max-width: 720px) {
		.platform-seg {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}

		.platform-seg .seg-item span {
			min-height: 44px;
			padding-inline: var(--df-p-space-2);
		}

		.editor .input {
			min-height: 44px;
		}
		.connector-actions {
			width: 100%;
			margin-left: 0;
		}

		.connector-actions .btn {
			min-height: 44px;
		}

		.header-action {
			min-height: 44px;
		}

		.form-foot .btn {
			min-height: 44px;
		}

		.banner .btn {
			min-height: 44px;
		}

		.webhook :global(.btn) {
			min-height: 44px;
		}

		.banner {
			align-items: stretch;
			flex-direction: column;
		}
	}
</style>
