<script lang="ts">
	import { onMount } from 'svelte';
	import {
		describeError,
		getDeviceStatus,
		getDevices,
		getHealth
	} from '$lib/api';
	import type { Device, DeviceStatus, Health } from '$lib/types';
	import { devicePresence, presenceCounts, type DevicePresence } from '$lib/presence';
	import { ALERTS_CHANGED_EVENT } from '$lib/alert-events';
	import { formatAbsolute, formatClock, formatCount } from '$lib/format';
	import { ROUTES } from '$lib/paths';
	import Badge from '$lib/components/Badge.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import Notice from '$lib/components/Notice.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import RelativeTime from '$lib/components/RelativeTime.svelte';
	import Spinner from '$lib/components/Spinner.svelte';

	const BINDING_LABELS: Record<string, string> = {
		DB: 'D1 database',
		KV: 'KV namespace',
		DEVICE: 'Durable Objects',
		PAIR_LIMITER: 'Pairing limiter · per IP',
		PAIR_GLOBAL_LIMITER: 'Pairing limiter · global',
		ADMIN_LIMITER: 'Admin limiter',
		DEVICE_LIMITER: 'Device limiter',
		AUTH_FAIL_LIMITER: 'Auth-failure limiter',
		FCM_SERVICE_ACCOUNT: 'FCM service account'
	};

	/** FCM is absent in a perfectly healthy local or polling-only deployment. */
	const OPTIONAL_BINDINGS = new Set(['FCM_SERVICE_ACCOUNT']);

	let health = $state<Health | null>(null);
	let loading = $state(true);
	let refreshing = $state(false);
	let error = $state<string | null>(null);
	let checkedAt = $state<number | null>(null);

	let devices = $state<Device[]>([]);
	let fleetStatuses = $state<Record<string, DeviceStatus | null>>({});
	let fleetLoading = $state(true);
	let fleetError = $state<string | null>(null);

	const fleetStates = $derived(
		devices.map((device) =>
			devicePresence(device, fleetStatuses[device.device_id]?.ws_connected === true)
		)
	);
	const fleetCounts = $derived(presenceCounts(fleetStates));
	const answering = $derived(fleetCounts.live + fleetCounts.synced);

	const fleetTone = $derived.by<'ok' | 'warn' | 'danger' | 'muted'>(() => {
		if (fleetLoading) return 'muted';
		if (fleetError) return 'warn';
		if (devices.length === 0) return 'muted';
		if (answering === 0) return 'danger';
		if (answering < devices.length) return 'warn';
		return 'ok';
	});

	const fleetSummary = $derived.by(() => {
		if (fleetLoading) return 'Checking fleet reachability…';
		if (fleetError) return 'Fleet state unavailable';
		if (devices.length === 0) return 'No devices paired yet';
		return `${answering} of ${devices.length} ${devices.length === 1 ? 'device' : 'devices'} answering`;
	});

	const fleetBreakdown = $derived.by(() => {
		if (fleetError || fleetLoading || devices.length === 0) return '';
		const order: DevicePresence[] = ['live', 'synced', 'stale', 'offline', 'unknown'];
		return order
			.filter((state) => fleetCounts[state] > 0)
			.map((state) => `${fleetCounts[state]} ${state}`)
			.join(' · ');
	});

	const openAlerts = $derived(health?.open_alerts ?? health?.counts?.open_alerts ?? 0);

	const missingCapabilities = $derived(
		(health?.missing_bindings ?? []).filter((key) => !OPTIONAL_BINDINGS.has(key))
	);

	const statusTone = $derived.by(() => {
		if (!health) return 'warn' as const;
		if (health.db_error || ['DB', 'KV', 'DEVICE'].some((k) => health?.missing_bindings.includes(k))) {
			return 'danger' as const;
		}
		if (missingCapabilities.length > 0) return 'warn' as const;
		return health.ok ? ('ok' as const) : ('warn' as const);
	});

	const headline = $derived.by(() => {
		if (!health) return 'Unknown';
		if (health.db_error) return 'Database unreachable';
		if (!health.schema_ready) return 'Schema not ready';
		if (missingCapabilities.length > 0) return 'Reduced configuration';
		return health.ok ? 'Deployment nominal' : 'Degraded';
	});

	const subline = $derived.by(() => {
		if (!health) return '';
		if (health.db_error) return 'Counts and schema state could not be read from D1.';
		if (!health.schema_ready) return 'No migrations are recorded — apply the schema before pairing devices.';
		if (missingCapabilities.length > 0) {
			return `${missingCapabilities.length} ${missingCapabilities.length === 1 ? 'capability is' : 'capabilities are'} not attached. Core routing still works; the affected safeguards are skipped.`;
		}
		if (!health.ok) return 'The gateway answered, but its own readiness check did not pass.';
		const count = health.counts?.devices ?? 0;
		return count === 0
			? 'The gateway, schema and bindings are healthy; no device is paired yet.'
			: 'The gateway, schema and bindings are healthy. Fleet reachability is reported separately below.';
	});

	type BindingRow = {
		key: string;
		label: string;
		present: boolean;
		optional: boolean;
		order: number;
	};

	const bindingRows: BindingRow[] = $derived.by(() => {
		const entries = Object.entries(health?.bindings ?? {});
		return entries
			.map(([key, present], order) => ({
				key,
				label: BINDING_LABELS[key] ?? key,
				present,
				optional: OPTIONAL_BINDINGS.has(key),
				order
			}))
			.sort((a, b) => {
				const rank = (row: BindingRow) =>
					!row.present && !row.optional ? 0 : !row.present ? 1 : 2;
				return rank(a) - rank(b) || a.order - b.order;
			});
	});

	async function load() {
		if (health) refreshing = true;
		else loading = true;
		error = null;
		try {
			const result = await getHealth();
			health = result.health;
			checkedAt = result.health.checked_at ?? Date.now();
		} catch (failure) {
			error = describeError(failure);
		} finally {
			loading = false;
			refreshing = false;
		}
	}

	/**
	 * Fleet reachability is a separate read from deployment health. A health
	 * failure must not hide a dead fleet, and a healthy Worker must not imply a
	 * reachable phone.
	 */
	async function loadFleet() {
		fleetLoading = true;
		fleetError = null;
		try {
			const list = await getDevices();
			const pairs = await Promise.all(
				list.map(async (device) => {
					try {
						return [device.device_id, await getDeviceStatus(device.device_id)] as const;
					} catch {
						return [device.device_id, null] as const;
					}
				})
			);
			devices = list;
			fleetStatuses = Object.fromEntries(pairs);
		} catch (failure) {
			devices = [];
			fleetStatuses = {};
			fleetError = describeError(failure);
		} finally {
			fleetLoading = false;
		}
	}

	function refreshAll() {
		void load();
		void loadFleet();
	}

	onMount(() => {
		void load();
		void loadFleet();
		const onAlertsChanged = () => {
			void load();
		};
		window.addEventListener(ALERTS_CHANGED_EVENT, onAlertsChanged);
		return () => window.removeEventListener(ALERTS_CHANGED_EVENT, onAlertsChanged);
	});
</script>

<svelte:head>
	<title>Overview · DakFlare</title>
</svelte:head>

<div class="page">
	<PageHeader
		eyebrow="Overview"
		title="Gateway status"
		description="Live health, schema and capability state for this deployment."
	>
		{#if checkedAt}
			<span class="checked mono" title={formatAbsolute(checkedAt)}>
				checked {formatClock(checkedAt)}
			</span>
		{/if}
		<button
			type="button"
			class="btn"
			onclick={refreshAll}
			disabled={loading || refreshing}
			aria-busy={refreshing}
		>
			{#if refreshing}<Spinner />{:else}<Icon name="refresh" size={14} />{/if}
			Refresh
		</button>
	</PageHeader>

	{#if error}
		<div class="panel">
			<div class="panel-body stack">
				<Notice tone="danger" title="Health check failed">{error}</Notice>
				<div class="row">
					<button type="button" class="btn btn-primary" onclick={() => void load()}>
						<Icon name="refresh" size={14} /> Try again
					</button>
				</div>
			</div>
		</div>
	{:else if loading}
		<div class="stack" aria-busy="true" aria-live="polite">
			<span class="sr-only">Loading gateway health</span>
			<div class="skeleton" style="height: 104px"></div>
			<div class="stat-grid">
				{#each ['a', 'b', 'c', 'd'] as key (key)}
					<div class="stat">
						<div class="skeleton" style="height: 10px; width: 60%"></div>
						<div class="skeleton" style="height: 28px; width: 40%; margin-top: 14px"></div>
					</div>
				{/each}
			</div>
			<div class="cols">
				<div class="skeleton" style="height: 260px"></div>
				<div class="skeleton" style="height: 260px"></div>
			</div>
		</div>
	{:else if health}
		<div class="stack">
			<section class="panel status-panel" aria-labelledby="status-heading">
				<div class="status-main">
					<span class="beacon beacon-{statusTone}" aria-hidden="true"></span>
					<div>
						<p class="eyebrow">Deployment</p>
						<h2 id="status-heading">{headline}</h2>
						<p class="status-sub">{subline}</p>
					</div>
				</div>
				<div class="status-side">
					<div class="status-metric">
						<span class="eyebrow">Version</span>
						<span class="mono">{health.version}</span>
					</div>
					<div class="status-metric">
						<span class="eyebrow">Schema</span>
						{#if health.schema_ready}
							<span class="badge badge-ok">ready</span>
						{:else}
							<span class="badge badge-warn">not ready</span>
						{/if}
					</div>
					<div class="status-metric">
						<span class="eyebrow">Open alerts</span>
						{#if openAlerts > 0}
							<span class="badge badge-danger">{openAlerts} open</span>
						{:else}
							<span class="mono">0</span>
						{/if}
					</div>
				</div>
				<div class="fleet-line fleet-{fleetTone}">
					<span
						class="dot"
						class:dot-ok={fleetTone === 'ok'}
						class:dot-warn={fleetTone === 'warn'}
						class:dot-danger={fleetTone === 'danger'}
						aria-hidden="true"
					></span>
					<span class="eyebrow">Fleet</span>
					<span class="fleet-summary">{fleetSummary}</span>
					{#if fleetBreakdown}
						<span class="fleet-breakdown mono">{fleetBreakdown}</span>
					{/if}
					<span class="spacer"></span>
					<a class="fleet-link" href={ROUTES.devices}>View devices</a>
				</div>
			</section>

			{#if health.db_error}
				<Notice tone="danger" title="D1 error">
					<span class="mono break">{health.db_error}</span>
				</Notice>
			{/if}

			{#if !health.schema_ready && !health.db_error}
				<Notice tone="warn" title="Schema not ready">
					No migrations are recorded. Run the migration before pairing a device — pairing writes to
					tables that may not exist yet.
				</Notice>
			{/if}

			{#if missingCapabilities.length > 0}
				<Notice tone="warn" title="Missing bindings">
					The gateway keeps serving, but the calls that depend on these bindings are skipped:
					<span class="mono">{missingCapabilities.join(', ')}</span>
				</Notice>
			{/if}

			<div class="stat-grid">
				<div class="stat">
					<div class="stat-label">
						<span>Devices</span>
						<Icon name="smartphone" size={14} />
					</div>
					<div class="stat-value" class:empty={!health.counts}>
						{formatCount(health.counts?.devices)}
					</div>
					<p class="stat-foot">paired fleet</p>
				</div>
				<div class="stat">
					<div class="stat-label">
						<span>Messages</span>
						<Icon name="message" size={14} />
					</div>
					<div class="stat-value" class:empty={!health.counts}>
						{formatCount(health.counts?.messages)}
					</div>
					<p class="stat-foot">
						{#if health.last_message_at}
							last <RelativeTime value={health.last_message_at} /> ·{' '}
							{health.retention_days ?? 90}d retention
						{:else}
							no traffic yet
						{/if}
					</p>
				</div>
				<div class="stat">
					<div class="stat-label">
						<span>Rules</span>
						<Icon name="filter" size={14} />
					</div>
					<div class="stat-value" class:empty={!health.counts}>
						{formatCount(health.counts?.rules)}
					</div>
					<p class="stat-foot">global and per-device</p>
				</div>
				<div class="stat">
					<div class="stat-label">
						<span>Pairing codes</span>
						<Icon name="key" size={14} />
					</div>
					<div class="stat-value" class:empty={!health.counts}>
						{formatCount(health.counts?.pairing_codes)}
					</div>
					<p class="stat-foot">single-use, unexpired</p>
				</div>
			</div>

			<div class="cols">
				<div class="stack">
					<section class="panel">
						<div class="panel-head">
							<h2 class="panel-title"><Icon name="shield" size={14} /> Schema</h2>
							<span class="panel-meta"
								>{health.migrations.length} migration{health.migrations.length === 1 ? '' : 's'}</span
							>
						</div>
						{#if health.migrations.length > 0}
							<ul class="mig-list">
								{#each health.migrations as migration, index (migration)}
									<li>
										<span class="mig-index mono">{String(index + 1).padStart(2, '0')}</span>
										<span class="mono mig-name">{migration}</span>
									</li>
								{/each}
							</ul>
						{:else}
							<EmptyState
								icon="alert"
								title="No migrations recorded"
								description="The migration table is empty or missing. Apply the schema before pairing."
							/>
						{/if}
					</section>

					<section class="panel">
						<div class="panel-head">
							<h2 class="panel-title"><Icon name="activity" size={14} /> Bindings</h2>
							<span class="panel-meta">
								{bindingRows.filter((row) => row.present).length}/{bindingRows.length} attached
							</span>
						</div>
						<ul class="bind-list">
							{#each bindingRows as row (row.key)}
								<li class="bind-row" class:is-missing={!row.present && !row.optional}>
									<span class="bind-mark" aria-hidden="true">
										{#if row.present}
											<Icon name="check" size={13} />
										{:else}
											<span class="bind-dash"></span>
										{/if}
									</span>
									<span class="bind-text">
										<span class="bind-label">{row.label}</span>
										<span class="mono bind-key">{row.key}</span>
									</span>
									<span class="bind-state">
										{#if row.present}
											<span class="mono bound">bound</span>
										{:else if row.optional}
											<Badge tone="muted">optional</Badge>
										{:else}
											<Badge tone="danger">missing</Badge>
										{/if}
									</span>
								</li>
							{/each}
						</ul>
						<p class="panel-note">
							FCM is expected to be absent in local and polling-only deployments. Without it the
							gateway cannot send wake-up pushes; the phone still reaches the gateway on its next
							poll or socket connection.
						</p>
					</section>
				</div>

				<div class="stack">
					<section class="panel">
						<div class="panel-head">
							<h2 class="panel-title"><Icon name="key" size={14} /> Quick actions</h2>
						</div>
						<div class="panel-body flush">
							<a class="quick" href={`${ROUTES.devices}?mint=enroll`}>
								<span class="quick-icon"><Icon name="key" size={15} /></span>
								<span class="quick-text">
									<strong>Mint a pairing code</strong>
									<small>Enroll a phone or rotate a device key</small>
								</span>
								<span class="quick-arrow"><Icon name="arrow-up-right" size={14} /></span>
							</a>
							<a class="quick" href={ROUTES.messages}>
								<span class="quick-icon"><Icon name="message" size={15} /></span>
								<span class="quick-text">
									<strong>Open the message log</strong>
									<small>Inspect inbound and outbound traffic</small>
								</span>
								<span class="quick-arrow"><Icon name="arrow-up-right" size={14} /></span>
							</a>
							<a class="quick" href={ROUTES.rules}>
								<span class="quick-icon"><Icon name="filter" size={15} /></span>
								<span class="quick-text">
									<strong>Review auto-reply rules</strong>
									<small>Matchers, reply templates and limits</small>
								</span>
								<span class="quick-arrow"><Icon name="arrow-up-right" size={14} /></span>
							</a>
						</div>
					</section>

					<section class="panel">
						<div class="panel-head">
							<h2 class="panel-title"><Icon name="info" size={14} /> Deployment</h2>
						</div>
						<div class="panel-body">
							<dl class="kv">
								<dt>Version</dt>
								<dd class="mono">{health.version}</dd>
								<dt>Retention</dt>
								<dd>{health.retention_days ?? 90} days</dd>
								<dt>Last inbound</dt>
								<dd>
									{#if health.last_message_at}
										<RelativeTime value={health.last_message_at} />
									{:else}
										<span class="muted">none</span>
									{/if}
								</dd>
								<dt>Open alerts</dt>
								<dd>
									{#if openAlerts > 0}
										<Badge tone="danger">{openAlerts} open</Badge>
									{:else}
										<span class="muted">none</span>
									{/if}
								</dd>
								<dt>Auto-replies</dt>
								<dd><a href={ROUTES.messages}>See rule replies in the message log</a></dd>
								<dt>Checked</dt>
								<dd>{formatClock(checkedAt)}</dd>
								<dt>Database</dt>
								<dd>
									{#if health.db_error}
										<Badge tone="danger">error</Badge>
									{:else}
										<Badge tone="ok">reachable</Badge>
									{/if}
								</dd>
							</dl>
						</div>
					</section>
				</div>
			</div>
		</div>
	{/if}
</div>

<style>
	.checked {
		font-size: var(--text-xs);
		color: var(--ink-3);
		letter-spacing: 0.03em;
	}

	.status-panel {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--s-5);
		flex-wrap: wrap;
		padding: var(--s-5);
		background:
			linear-gradient(120deg, color-mix(in srgb, var(--accent) 5%, transparent), transparent 55%),
			var(--surface);
	}

	.status-main {
		display: flex;
		align-items: flex-start;
		gap: var(--s-4);
		min-width: 0;
	}

	.beacon {
		position: relative;
		width: 9px;
		height: 9px;
		margin-top: 6px;
		border-radius: 50%;
		flex: none;
	}

	.beacon-ok {
		background: var(--ok);
		box-shadow: 0 0 0 4px color-mix(in srgb, var(--ok) 15%, transparent);
	}

	.beacon-ok::after {
		content: '';
		position: absolute;
		inset: -4px;
		border-radius: 50%;
		border: 1px solid var(--ok);
		opacity: 0;
		animation: beacon 3s ease-out infinite;
	}

	@keyframes beacon {
		0% {
			opacity: 0.5;
			transform: scale(0.8);
		}
		70%,
		100% {
			opacity: 0;
			transform: scale(1.6);
		}
	}

	.beacon-warn {
		background: var(--warn);
		box-shadow: 0 0 0 4px color-mix(in srgb, var(--warn) 15%, transparent);
	}

	.beacon-danger {
		background: var(--danger);
		box-shadow: 0 0 0 4px color-mix(in srgb, var(--danger) 15%, transparent);
	}

	.status-panel h2 {
		margin-top: 5px;
		font-size: var(--text-xl);
		letter-spacing: -0.02em;
	}

	.status-sub {
		margin-top: 5px;
		max-width: 58ch;
		color: var(--ink-3);
		font-size: var(--text-base);
	}

	.status-side {
		display: flex;
		gap: var(--s-6);
		padding-left: var(--s-5);
		border-left: 1px solid var(--line);
	}

	.status-metric {
		display: flex;
		flex-direction: column;
		gap: 5px;
	}

	.status-metric > .mono {
		font-size: var(--text-sm);
	}

	.fleet-line {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		flex-basis: 100%;
		flex-wrap: wrap;
		margin-top: var(--s-4);
		padding-top: var(--s-3);
		border-top: 1px solid var(--line);
		font-size: var(--text-base);
	}

	.fleet-summary {
		font-weight: 600;
		color: var(--ink);
	}

	.fleet-ok .fleet-summary {
		color: var(--ok);
	}

	.fleet-warn .fleet-summary {
		color: var(--warn);
	}

	.fleet-danger .fleet-summary {
		color: var(--danger);
	}

	.fleet-muted .fleet-summary {
		color: var(--ink-3);
		font-weight: 500;
	}

	.fleet-breakdown {
		font-size: 10px;
		color: var(--ink-3);
	}

	.fleet-link {
		font-size: var(--text-sm);
		white-space: nowrap;
	}

	.cols {
		display: grid;
		grid-template-columns: minmax(0, 1.55fr) minmax(0, 1fr);
		gap: var(--s-4);
		align-items: start;
	}

	/* schema */
	.mig-list {
		margin: 0;
		padding: 0;
		list-style: none;
		max-height: 232px;
		overflow-y: auto;
	}

	.mig-list li {
		display: flex;
		align-items: baseline;
		gap: var(--s-3);
		padding: 7px var(--s-4);
		border-bottom: 1px solid var(--line);
	}

	.mig-list li:last-child {
		border-bottom: 0;
	}

	.mig-index {
		font-size: 10px;
		color: var(--ink-3);
		width: 18px;
		flex: none;
	}

	.mig-name {
		font-size: var(--text-sm);
		overflow-wrap: anywhere;
	}

	/* bindings */
	.bind-list {
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.bind-row {
		display: grid;
		grid-template-columns: 18px minmax(0, 1fr) auto;
		align-items: center;
		gap: var(--s-3);
		padding: 8px var(--s-4);
		border-bottom: 1px solid var(--line);
	}

	.bind-row:last-child {
		border-bottom: 0;
	}

	.bind-row.is-missing {
		background: color-mix(in srgb, var(--danger) 4%, transparent);
	}

	.bind-mark {
		display: grid;
		place-items: center;
		width: 18px;
		height: 18px;
		border-radius: 3px;
		color: var(--ok);
	}

	.bind-row.is-missing .bind-mark {
		color: var(--ink-3);
	}

	.bind-dash {
		width: 7px;
		height: 1px;
		background: var(--ink-3);
	}

	.bind-text {
		min-width: 0;
	}

	.bind-label {
		display: block;
		font-size: var(--text-base);
	}

	.bind-key {
		display: block;
		font-size: 9.5px;
		color: var(--ink-3);
		letter-spacing: 0.04em;
		margin-top: 1px;
	}

	.bound {
		font-size: 9.5px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--ink-3);
	}

	/* quick actions */
	.quick {
		display: flex;
		align-items: center;
		gap: var(--s-3);
		padding: 12px var(--s-4);
		border-bottom: 1px solid var(--line);
		color: var(--ink);
		text-decoration: none;
		transition: background-color 120ms ease;
	}

	.quick:last-child {
		border-bottom: 0;
	}

	.quick:hover {
		background: var(--surface-2);
		text-decoration: none;
	}

	.quick-arrow {
		display: inline-flex;
		color: var(--ink-3);
		opacity: 0;
		transform: translateX(-3px);
		transition:
			opacity 140ms ease,
			transform 140ms ease;
	}

	.quick:hover .quick-arrow {
		opacity: 1;
		transform: none;
	}

	.quick-icon {
		display: grid;
		place-items: center;
		width: 28px;
		height: 28px;
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		background: var(--surface-2);
		color: var(--ink-2);
		flex: none;
	}

	.quick:first-child .quick-icon {
		color: var(--accent);
		border-color: color-mix(in srgb, var(--accent) 30%, var(--line));
		background: color-mix(in srgb, var(--accent) 8%, var(--surface));
	}

	.quick-text {
		flex: 1;
		min-width: 0;
	}

	.quick-text strong {
		display: block;
		font-size: var(--text-base);
		font-weight: 500;
	}

	.quick-text small {
		display: block;
		margin-top: 1px;
		font-size: 11px;
		color: var(--ink-3);
	}

	.break {
		overflow-wrap: anywhere;
	}

	@media (max-width: 980px) {
		.cols {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	@media (max-width: 620px) {
		.status-panel {
			padding: var(--s-4);
		}

		.status-side {
			width: 100%;
			padding-left: 0;
			padding-top: var(--s-3);
			border-left: 0;
			border-top: 1px solid var(--line);
			gap: var(--s-5);
		}
	}
</style>
