<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { describeError, getAudit } from '$lib/api';
	import { formatAbsolute, formatCount, formatRelative } from '$lib/format';
	import { ROUTES } from '$lib/paths';
	import { session } from '$lib/session.svelte';
	import type { AuditEvent } from '$lib/types';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import Notice from '$lib/components/Notice.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import Spinner from '$lib/components/Spinner.svelte';

	/*
	 * `GET /v1/admin/audit` (AUTH_PLAN §5). Read-only, newest first, 100 rows a
	 * page. The Worker's only cursor is `before` — a millisecond stamp with a
	 * strict `<` — so rows sharing that millisecond cannot be paged past; the foot
	 * says so rather than pretending the log ended (same rule as the message log).
	 */
	const PAGE_SIZE = 100;

	let events = $state<AuditEvent[]>([]);
	let loading = $state(true);
	let loadingMore = $state(false);
	let refreshing = $state(false);
	let error = $state<string | null>(null);
	let hasMore = $state(false);
	let stalled = $state(false);
	let expanded = $state<Set<string>>(new Set());

	/** Applied filters; the drafts are what the inputs hold until Apply. */
	let actor = $state('');
	let action = $state('');
	let actorDraft = $state('');
	let actionDraft = $state('');
	let lastUpdatedAt = $state<number | null>(null);
	let clock = $state(Date.now());

	let version = 0;

	const filtered = $derived(actor !== '' || action !== '');
	const allowed = $derived(session.canViewSecurity);

	/** Action names already in hand, offered as a hint. Never invented. */
	const knownActions = $derived(
		Array.from(new Set(events.map((event) => event.action))).sort((a, b) => a.localeCompare(b))
	);

	function isFailure(actionName: string): boolean {
		return actionName.includes('failure') || actionName.includes('failed');
	}

	async function load(reset: boolean): Promise<void> {
		const current = ++version;
		const before = reset ? undefined : events.at(-1)?.at;
		if (!reset && before === undefined) return;

		if (reset) {
			loading = true;
			error = null;
		} else {
			loadingMore = true;
		}

		try {
			const result = await getAudit({
				limit: PAGE_SIZE,
				...(before === undefined ? {} : { before }),
				...(actor === '' ? {} : { actor }),
				...(action === '' ? {} : { action })
			});
			if (current !== version) return;

			if (reset) {
				events = result.events;
				hasMore = result.events.length >= result.limit;
			} else {
				const seen = new Set(events.map((event) => event.id));
				const fresh = result.events.filter((event) => !seen.has(event.id));
				events = [...events, ...fresh];
				hasMore = result.events.length >= result.limit && fresh.length > 0;
				stalled = result.events.length >= result.limit && fresh.length === 0;
			}
			lastUpdatedAt = Date.now();
			clock = Date.now();
		} catch (failure) {
			if (current === version) error = describeError(failure);
		} finally {
			if (current === version) {
				loading = false;
				loadingMore = false;
			}
		}
	}

	async function refresh(): Promise<void> {
		refreshing = true;
		await load(true);
		refreshing = false;
	}

	async function applyFilters(): Promise<void> {
		actor = actorDraft.trim();
		action = actionDraft.trim();
		expanded = new Set();
		syncUrl();
		await load(true);
	}

	async function clearFilters(): Promise<void> {
		actorDraft = '';
		actionDraft = '';
		await applyFilters();
	}

	function syncUrl(): void {
		const params = new URLSearchParams();
		if (actor !== '') params.set('actor', actor);
		if (action !== '') params.set('action', action);
		const query = params.toString();
		history.replaceState(history.state, '', query === '' ? ROUTES.audit : `${ROUTES.audit}?${query}`);
	}

	function toggleDetail(id: string): void {
		const next = new Set(expanded);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		expanded = next;
	}

	function describeDetail(value: unknown): string {
		if (value === null || value === undefined) return '';
		try {
			return JSON.stringify(value, null, 2);
		} catch {
			return '';
		}
	}

	function actorName(event: AuditEvent): string {
		if (event.actor_label !== null && event.actor_label !== '') return event.actor_label;
		if (event.actor_user !== null && event.actor_user !== '') return event.actor_user;
		return 'anonymous';
	}

	onMount(() => {
		const params = page.url.searchParams;
		actorDraft = params.get('actor') ?? '';
		actionDraft = params.get('action') ?? '';
		actor = actorDraft.trim();
		action = actionDraft.trim();
		void load(true);

		const interval = setInterval(() => {
			if (document.visibilityState === 'visible') clock = Date.now();
		}, 1_000);
		return () => clearInterval(interval);
	});
</script>

<svelte:head>
	<title>Audit log · DakFlare</title>
</svelte:head>

<div class="page">
	<PageHeader
		eyebrow="Security"
		title="Audit log"
		description="Sign-in attempts, invites, device changes and saved automation, newest first. The gateway writes these rows; this page only reads them."
	>
		<button
			type="button"
			class="btn"
			onclick={() => void refresh()}
			disabled={loading || refreshing || !allowed}
			aria-busy={refreshing}
		>
			{#if refreshing}<Spinner />{:else}<Icon name="refresh" size={14} />{/if}
			Refresh
		</button>
	</PageHeader>

	{#if !allowed}
		<section class="card">
			<EmptyState
				icon="shield"
				title="The audit log is for owners and admins"
				description="Your account is a member. Ask an owner if you need to read it."
			>
				<a class="btn btn-primary" href={ROUTES.overview}>Back to overview</a>
			</EmptyState>
		</section>
	{:else}
		<section class="card audit-card">
			<div class="audit-toolbar">
				<form
					class="filters"
					onsubmit={(event) => {
						event.preventDefault();
						void applyFilters();
					}}
				>
					<div class="filter">
						<label class="label" for="filter-actor">Actor</label>
						<input
							id="filter-actor"
							class="input input-mono"
							bind:value={actorDraft}
							placeholder="email or label"
							autocomplete="off"
							spellcheck="false"
						/>
					</div>
					<div class="filter">
						<label class="label" for="filter-action">Action</label>
						<input
							id="filter-action"
							class="input input-mono"
							bind:value={actionDraft}
							list="known-actions"
							placeholder="sign_in.success"
							autocomplete="off"
							spellcheck="false"
						/>
						<datalist id="known-actions">
							{#each knownActions as name (name)}
								<option value={name}></option>
							{/each}
						</datalist>
					</div>
					<div class="filter-actions">
						<button type="submit" class="btn btn-primary btn-sm" disabled={loading}>
							{#if loading}<Spinner />{:else}<Icon name="filter" size={13} />{/if}
							Apply
						</button>
						{#if filtered}
							<button type="button" class="btn btn-ghost btn-sm" onclick={() => void clearFilters()}>
								Clear
							</button>
						{/if}
					</div>
				</form>

				<div class="audit-meta">
					<span class="mono">
						{#if loading}
							<Spinner />
						{:else if error}
							<span title="The log did not load">—</span>
						{:else}
							{formatCount(events.length)} {events.length === 1 ? 'entry' : 'entries'}
						{/if}
					</span>
					<span class="toolbar-sep" aria-hidden="true"></span>
					<span class="mono updated" title="Rows are loaded on demand; Refresh asks for the newest page.">
						{#if lastUpdatedAt}
							updated {formatRelative(lastUpdatedAt, clock)}
						{:else}
							not loaded
						{/if}
					</span>
				</div>
			</div>

			{#if loading}
				<div class="loading-rows" aria-busy="true" aria-live="polite">
					<span class="sr-only">Loading the audit log</span>
					{#each ['a', 'b', 'c', 'd', 'e'] as key (key)}
						<div class="skeleton" style="height: 46px"></div>
					{/each}
				</div>
			{:else if error}
				<div class="audit-message">
					<Notice tone="danger" title="The audit log did not load">
						{error}
					</Notice>
					<div class="row" style="margin-top: 12px">
						<button type="button" class="btn btn-primary" onclick={() => void load(true)}>
							<Icon name="refresh" size={14} /> Try again
						</button>
					</div>
				</div>
			{:else if events.length === 0 && filtered}
				<EmptyState
					icon="filter"
					title="No entries match these filters"
					description="The log answered, and nothing in it matches both filters. Clear them to see everything recorded."
				>
					<button type="button" class="btn btn-primary" onclick={() => void clearFilters()}>
						Clear filters
					</button>
				</EmptyState>
			{:else if events.length === 0}
				<EmptyState
					icon="history"
					title="Nothing recorded yet"
					description="The gateway answered, and the log is empty. The first sign-in, invite or device change appears here as it happens."
				/>
			{:else}
				<div class="table-wrap">
					<table class="table audit-table">
						<thead>
							<tr>
								<th scope="col" class="col-at">When</th>
								<th scope="col" class="col-actor">Actor</th>
								<th scope="col" class="col-action">Action</th>
								<th scope="col" class="col-subject">Subject</th>
								<th scope="col" class="col-ip">Address</th>
							</tr>
						</thead>
						<tbody>
							{#each events as event (event.id)}
								{@const detail = describeDetail(event.detail)}
								{@const open = expanded.has(event.id)}
								<tr class="audit-row" class:is-open={open}>
									<td>
										<time class="cell-main mono" datetime={new Date(event.at).toISOString()}>
											{formatAbsolute(event.at)}
										</time>
										<span class="cell-sub mono">{formatRelative(event.at, clock)}</span>
									</td>
									<td>
										<span class="cell-main actor">{actorName(event)}</span>
										{#if event.actor_user}
											<span class="cell-sub mono id">{event.actor_user}</span>
										{:else}
											<span class="cell-sub">no user row</span>
										{/if}
									</td>
									<td>
										<span class="action-cell">
											{#if isFailure(event.action)}
												<span class="dot dot-danger" aria-hidden="true"></span>
												<span class="sr-only">Failed:</span>
											{/if}
											<span class="mono">{event.action}</span>
										</span>
										{#if detail !== '' || event.user_agent}
											<button
												type="button"
												class="link-btn detail-toggle"
												onclick={() => toggleDetail(event.id)}
												aria-expanded={open}
												aria-controls={`detail-${event.id}`}
											>
												{open ? 'Hide detail' : 'Detail'}
											</button>
										{/if}
									</td>
									<td>
										{#if event.subject}
											<span class="cell-main mono subject">{event.subject}</span>
										{:else}
											<span class="cell-sub">—</span>
										{/if}
									</td>
									<td>
										{#if event.ip}
											<span class="mono">{event.ip}</span>
										{:else}
											<span class="cell-sub">not recorded</span>
										{/if}
									</td>
								</tr>
								{#if open}
									<tr class="detail-row" id={`detail-${event.id}`}>
										<td colspan="5">
											<div class="detail-body">
												{#if detail !== ''}
													<pre class="detail-json mono">{detail}</pre>
												{:else}
													<p class="hint">No extra detail was stored for this entry.</p>
												{/if}
												{#if event.user_agent}
													<p class="detail-ua mono">{event.user_agent}</p>
												{/if}
											</div>
										</td>
									</tr>
								{/if}
							{/each}
						</tbody>
					</table>
				</div>

				<div class="audit-foot">
					<span class="mono muted">
						{formatCount(events.length)} loaded · newest first
					</span>
					<span class="spacer"></span>
					{#if hasMore}
						<button
							type="button"
							class="btn btn-sm"
							onclick={() => void load(false)}
							disabled={loadingMore}
							aria-busy={loadingMore}
						>
							{#if loadingMore}<Spinner />{:else}<Icon name="chevron-down" size={13} />{/if}
							Load older
						</button>
					{:else if stalled}
						<span class="hint">
							Older entries share a timestamp; this log cannot page past them yet.
						</span>
					{:else}
						<span class="hint">Beginning of the log</span>
					{/if}
				</div>
			{/if}
		</section>
	{/if}
</div>

<style>
	.audit-card {
		padding: 0;
	}

	.audit-toolbar {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: var(--df-p-space-4);
		flex-wrap: wrap;
		padding: var(--df-p-space-3) var(--df-p-space-4);
		border-bottom: 1px solid var(--df-border-hairline);
		background: var(--df-surface-well);
		border-radius: var(--df-c-card-radius) var(--df-c-card-radius) 0 0;
	}

	.filters {
		display: flex;
		align-items: flex-end;
		gap: var(--df-p-space-3);
		flex-wrap: wrap;
		min-width: 0;
	}

	.filter {
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-width: 0;
	}

	.filter .input {
		width: 190px;
		height: 32px;
		min-height: 32px;
		padding-block: var(--df-p-space-1);
	}

	.filter-actions {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-2);
		padding-bottom: 1px;
	}

	.audit-meta {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-3);
		color: var(--df-text-meta);
		font-size: var(--df-p-text-2xs);
		letter-spacing: 0.04em;
		white-space: nowrap;
	}

	.toolbar-sep {
		width: 1px;
		height: 14px;
		background: var(--df-border-control);
	}

	.updated {
		letter-spacing: 0;
	}

	.loading-rows {
		display: flex;
		flex-direction: column;
		gap: var(--df-p-space-2);
		padding: var(--df-p-space-4);
	}

	.audit-message {
		padding: var(--df-p-space-4);
	}

	.table-wrap {
		overflow-x: auto;
	}

	.audit-table {
		min-width: 760px;
	}

	.col-at {
		width: 168px;
	}

	.col-actor {
		width: 22%;
	}

	.col-action {
		width: 22%;
	}

	.col-ip {
		width: 132px;
	}

	.audit-row td {
		vertical-align: top;
	}

	.audit-row.is-open td {
		border-bottom-color: transparent;
	}

	.actor {
		overflow-wrap: anywhere;
	}

	.id {
		font-size: 10.5px;
		overflow-wrap: anywhere;
	}

	.subject {
		overflow-wrap: anywhere;
	}

	.action-cell {
		display: inline-flex;
		align-items: center;
		gap: 6px;
	}

	/* A control, not a caption: it gets a row of its own inside the cell and a
	   real hit area, without turning the row into a button bar. */
	.detail-toggle {
		display: inline-flex;
		align-items: center;
		min-height: 32px;
		margin: 2px 0 0 -6px;
		padding: 0 6px;
		border-radius: var(--df-p-radius-sm);
		font-size: 11px;
		color: var(--df-text-meta);
	}

	.detail-toggle:hover {
		background: var(--df-surface-well);
		color: var(--df-text-primary);
	}

	.detail-row td {
		padding-top: 0;
		background: color-mix(in srgb, var(--df-surface-well) 60%, var(--df-surface-card));
	}

	.detail-body {
		display: flex;
		flex-direction: column;
		gap: var(--df-p-space-2);
		padding: var(--df-p-space-2) 0 var(--df-p-space-3);
	}

	.detail-json {
		margin: 0;
		padding: var(--df-p-space-3);
		max-height: 260px;
		overflow: auto;
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-sm);
		background: var(--df-surface-card);
		font-size: 11.5px;
		line-height: 1.5;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.detail-ua {
		font-size: 10.5px;
		color: var(--df-text-meta);
		overflow-wrap: anywhere;
	}

	.audit-foot {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-3);
		flex-wrap: wrap;
		padding: var(--df-p-space-3) var(--df-p-space-4);
		border-top: 1px solid var(--df-border-hairline);
		font-size: var(--df-p-text-2xs);
	}

	@media (max-width: 720px) {
		.filters {
			width: 100%;
		}

		/* The toolbar's compact 32px is a pointer target; a thumb needs 44. */
		.filter .input {
			height: 44px;
			min-height: 44px;
		}

		.detail-toggle {
			min-height: 40px;
			margin-top: 0;
		}

		.filter {
			flex: 1 1 140px;
		}

		.filter .input {
			width: 100%;
		}

		.audit-meta {
			width: 100%;
			justify-content: flex-start;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.audit-row td {
			transition: none;
		}
	}
</style>
