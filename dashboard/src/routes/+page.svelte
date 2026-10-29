<script lang="ts">
	import { onMount } from 'svelte';
	import { describeError, getDeviceStatus, getDevices, getHealth } from '$lib/api';
	import type { Device, DeviceStatus, Health } from '$lib/types';
	import {
		devicePresence,
		devicePrimary,
		deviceSecondary,
		presenceCounts,
		type DevicePresence
	} from '$lib/presence';
	import { ALERTS_CHANGED_EVENT } from '$lib/alert-events';
	import { consoleCounts } from '$lib/console-counts.svelte';
	import { formatAbsolute, formatCount, plural } from '$lib/format';
	import { ROUTES } from '$lib/paths';
	import Badge from '$lib/components/Badge.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import Mascot from '$lib/components/Mascot.svelte';
	import Notice from '$lib/components/Notice.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import PresenceChip from '$lib/components/PresenceChip.svelte';
	import RelativeTime from '$lib/components/RelativeTime.svelte';
	import Spinner from '$lib/components/Spinner.svelte';

	/** FCM is absent in a perfectly healthy local or polling-only deployment. */
	const OPTIONAL_BINDINGS = new Set(['FCM_SERVICE_ACCOUNT']);
	const DEVICE_ROWS = 4;

	let health = $state<Health | null>(null);
	let loading = $state(true);
	let refreshing = $state(false);
	let error = $state<string | null>(null);
	let checkedAt = $state<number | null>(null);

	let devices = $state<Device[]>([]);
	let fleetStatuses = $state<Record<string, DeviceStatus | null>>({});
	let fleetLoading = $state(true);
	let fleetError = $state<string | null>(null);
	let healthRefreshError = $state<string | null>(null);
	let fleetRefreshError = $state<string | null>(null);
	let healthInFlight = false;
	let fleetInFlight = false;
	let fleetAttempted = false;

	const REFRESH_MS = 30_000;

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

	const fleetBreakdown = $derived.by(() => {
		if (fleetError || fleetLoading || devices.length === 0) return '';
		const order: DevicePresence[] = ['live', 'synced', 'stale', 'offline', 'unknown'];
		return order
			.filter((state) => fleetCounts[state] > 0)
			.map((state) => `${fleetCounts[state]} ${state}`)
			.join(' · ');
	});

	const visibleDevices = $derived(devices.slice(0, DEVICE_ROWS));
	const remainingDevices = $derived(Math.max(0, devices.length - visibleDevices.length));

	const openAlerts = $derived(health?.open_alerts ?? health?.counts?.open_alerts ?? 0);
	// `open_alerts` collapses to 0 when the count query failed. Do not print that
	// zero as "quiet": an unreadable database is an unknown, not an empty list.
	const alertsKnown = $derived(health !== null && !health.db_error && health.counts !== null);

	const refreshNote = $derived.by(() => {
		if (healthRefreshError && fleetRefreshError) return 'health and fleet refresh failed';
		if (healthRefreshError) return 'health refresh failed';
		if (fleetRefreshError) return 'fleet refresh failed';
		return null;
	});

	const missingCapabilities = $derived(
		(health?.missing_bindings ?? []).filter((key) => !OPTIONAL_BINDINGS.has(key))
	);

	const statusTone = $derived.by<'ok' | 'warn' | 'danger'>(() => {
		if (!health) return 'warn';
		if (
			health.db_error ||
			['DB', 'KV', 'DEVICE'].some((key) => health?.missing_bindings.includes(key))
		) {
			return 'danger';
		}
		if (missingCapabilities.length > 0) return 'warn';
		return health.ok ? 'ok' : 'warn';
	});

	const headline = $derived.by(() => {
		if (!health) return 'Unknown';
		if (health.db_error) return 'Database unreachable';
		if (!health.schema_ready) return 'Schema not ready';
		if (missingCapabilities.length > 0) return 'Reduced configuration';
		return health.ok ? 'Gateway running' : 'Gateway degraded';
	});

	const subline = $derived.by(() => {
		if (!health) return '';
		if (health.db_error) {
			return 'The database did not answer, so counts and schema state are unknown.';
		}
		if (!health.schema_ready) {
			return 'No migrations are recorded. Apply the schema before pairing a device.';
		}
		if (missingCapabilities.length > 0) {
			return `${missingCapabilities.length} ${
				missingCapabilities.length === 1 ? 'binding is' : 'bindings are'
			} not attached. The gateway keeps serving; the safeguards that depend on them are skipped.`;
		}
		if (!health.ok) return 'The gateway answered, but its readiness check did not pass.';
		const count = health.counts?.devices ?? 0;
		return count === 0
			? 'The gateway, schema and bindings are healthy. No device is paired yet.'
			: 'The gateway, schema and bindings are healthy. Fleet reachability is below.';
	});

	const bindingTotal = $derived(Object.keys(health?.bindings ?? {}).length);
	const attachedBindings = $derived(
		Object.values(health?.bindings ?? {}).filter((present) => present).length
	);

	async function loadHealth(): Promise<void> {
		if (healthInFlight) return;
		healthInFlight = true;
		const hadHealth = health !== null;
		if (!hadHealth) loading = true;
		try {
			const result = await getHealth();
			health = result.health;
			checkedAt = result.health.checked_at ?? Date.now();
			error = null;
			healthRefreshError = null;
			// The rail's pill counts come from the same read.
			consoleCounts.note(result.health);
		} catch (failure) {
			// A refresh must never blank a page that already has values; the
			// initial failure still gets the full error panel.
			if (hadHealth) healthRefreshError = describeError(failure);
			else error = describeError(failure);
		} finally {
			healthInFlight = false;
			loading = false;
		}
	}

	/**
	 * Fleet reachability is a separate read from deployment health. A health
	 * failure must not hide a dead fleet, and a healthy Worker must not imply a
	 * reachable phone. Background failures keep the last known fleet.
	 */
	async function loadFleet(): Promise<void> {
		if (fleetInFlight) return;
		fleetInFlight = true;
		if (!fleetAttempted) fleetLoading = true;
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
			fleetError = null;
			fleetRefreshError = null;
		} catch (failure) {
			if (fleetAttempted) {
				fleetRefreshError = describeError(failure);
			} else {
				devices = [];
				fleetStatuses = {};
				fleetError = describeError(failure);
			}
		} finally {
			fleetLoading = false;
			fleetInFlight = false;
			fleetAttempted = true;
		}
	}

	async function refreshAll(manual = false): Promise<void> {
		if (healthInFlight || fleetInFlight) return;
		if (manual) refreshing = true;
		try {
			await Promise.all([loadHealth(), loadFleet()]);
		} finally {
			if (manual) refreshing = false;
		}
	}

	onMount(() => {
		void refreshAll();

		const timer = setInterval(() => {
			if (document.visibilityState === 'visible') void refreshAll();
		}, REFRESH_MS);
		const onVisible = () => {
			if (document.visibilityState === 'visible') void refreshAll();
		};
		document.addEventListener('visibilitychange', onVisible);

		const onAlertsChanged = () => {
			void loadHealth();
		};
		window.addEventListener(ALERTS_CHANGED_EVENT, onAlertsChanged);

		return () => {
			clearInterval(timer);
			document.removeEventListener('visibilitychange', onVisible);
			window.removeEventListener(ALERTS_CHANGED_EVENT, onAlertsChanged);
		};
	});
</script>

<svelte:head>
	<title>Overview · DakFlare</title>
</svelte:head>

<div class="page">
	<PageHeader
		eyebrow="Deployment"
		title="Gateway status"
		description="Deployment health, fleet reachability and what answers a stranger."
	>
		{#if checkedAt}
			<span
				class="checked mono"
				class:has-error={refreshNote}
				title={refreshNote ?? formatAbsolute(checkedAt)}
			>
				last refreshed <RelativeTime value={checkedAt} />
				{#if refreshNote}<span class="refresh-failure"> · {refreshNote}</span>{/if}
			</span>
		{/if}
		<button
			type="button"
			class="btn"
			onclick={() => void refreshAll(true)}
			disabled={loading || refreshing}
			aria-busy={refreshing}
		>
			{#if refreshing}<Spinner />{:else}<Icon name="refresh" size={14} />{/if}
			Refresh
		</button>
	</PageHeader>

	{#if error}
		<div class="card">
			<Notice tone="danger" title="The gateway is not answering">{error}</Notice>
			<p class="card-note" style="margin-top: 12px">
				The console could not read deployment health. It tries again on the next refresh.
			</p>
			<div class="row" style="margin-top: 16px">
				<button type="button" class="btn btn-primary" onclick={() => void refreshAll()}>
					<Icon name="refresh" size={14} /> Try again
				</button>
			</div>
		</div>
	{:else if loading}
		<div class="grid-stack" aria-busy="true" aria-live="polite">
			<span class="sr-only">Checking the gateway and the fleet</span>
			<p class="loading-line"><Spinner /> Checking the gateway and the fleet</p>

			<div class="bento">
				<div class="card span-12">
					<div class="skeleton" style="height: 12px; width: 90px"></div>
					<div class="skeleton" style="height: 26px; width: 280px; margin-top: 12px"></div>
					<div class="skeleton" style="height: 12px; width: 60%; margin-top: 12px"></div>
				</div>
			</div>

			<div class="bento">
				<div class="card span-6">
					<div class="skeleton" style="height: 10px; width: 90px"></div>
					<div class="skeleton" style="height: 34px; width: 120px; margin-top: 18px"></div>
					<div class="skeleton" style="height: 10px; width: 70%; margin-top: 18px"></div>
				</div>
				{#each ['messages', 'rules'] as key (key)}
					<div class="card span-3">
						<div class="skeleton" style="height: 10px; width: 70px"></div>
						<div class="skeleton" style="height: 26px; width: 60px; margin-top: 18px"></div>
						<div class="skeleton" style="height: 10px; width: 80%; margin-top: 18px"></div>
					</div>
				{/each}
			</div>

			<div class="bento">
				<div class="card span-8">
					<div class="skeleton" style="height: 14px; width: 120px"></div>
					{#each ['a', 'b', 'c'] as key (key)}
						<div class="skeleton" style="height: 48px; margin-top: 12px"></div>
					{/each}
				</div>
				<div class="card span-4">
					<div class="skeleton" style="height: 14px; width: 100px"></div>
					<div class="skeleton" style="height: 96px; margin-top: 16px"></div>
					<div class="skeleton" style="height: 10px; width: 80%; margin-top: 16px"></div>
				</div>
			</div>

			<div class="bento">
				<div class="card span-12">
					<div class="skeleton" style="height: 14px; width: 140px"></div>
					<div class="skeleton" style="height: 56px; margin-top: 16px"></div>
					<div class="skeleton" style="height: 96px; margin-top: 12px"></div>
				</div>
			</div>
		</div>
	{:else if health}
		<div class="grid-stack">
			<!-- 12 — deployment status. The one band that can carry a state fill. -->
			<div class="bento" class:settle={!refreshNote} style="--i: 0">
				<section
					class="card span-12 status"
					data-tone={statusTone}
					aria-labelledby="status-heading"
				>
					<span class="beacon" data-tone={statusTone} aria-hidden="true"></span>
					<div class="status-main">
						<p class="eyebrow">Deployment</p>
						<h2 id="status-heading">{headline}</h2>
						<p class="status-sub">{subline}</p>
					</div>
					<dl class="status-facts">
						<div class="fact">
							<dt>Version</dt>
							<dd class="mono">{health.version}</dd>
						</div>
						<div class="fact">
							<dt>Schema</dt>
							<dd>
								{#if health.db_error}
									<span class="muted">unknown</span>
								{:else if health.schema_ready}
									<Badge tone="ok" dot>ready</Badge>
								{:else}
									<Badge tone="warn" dot>not ready</Badge>
								{/if}
							</dd>
						</div>
						<div class="fact">
							<dt>Bindings</dt>
							<dd class="mono">{attachedBindings}/{bindingTotal}</dd>
						</div>
						<div class="fact">
							<dt>Open alerts</dt>
							<dd>
								{#if openAlerts > 0}
									<Badge tone="danger" dot>{openAlerts} open</Badge>
								{:else if alertsKnown}
									<span class="mono">0</span>
								{:else}
									<span class="muted" title="Not reported">—</span>
								{/if}
							</dd>
						</div>
					</dl>
				</section>
			</div>

			{#if health.db_error}
				<Notice tone="danger" title="The database did not answer">
					<span class="mono break">{health.db_error}</span>
				</Notice>
			{/if}

			{#if !health.schema_ready && !health.db_error}
				<Notice tone="warn" title="Schema not ready">
					No migrations are recorded. Run the migration before pairing a device: pairing
					writes to tables that may not exist yet.
				</Notice>
			{/if}

			{#if missingCapabilities.length > 0}
				<Notice tone="warn" title="Bindings not attached">
					The gateway keeps serving, but the calls that depend on these bindings are skipped:
					<span class="mono">{missingCapabilities.join(', ')}</span>.
				</Notice>
			{/if}

			<!-- 6 + 3 + 3 — one hero figure, two supporting counts. -->
			<div class="bento" class:settle={!refreshNote} style="--i: 1">
				<section
					class="card span-6 metric"
					class:tint-mint={fleetTone === 'ok'}
					class:tint-butter={fleetTone === 'warn'}
					class:tint-peach={fleetTone === 'danger'}
					class:lift={!fleetError}
					aria-label="Phones answering"
				>
					<p class="eyebrow">Phones answering</p>
					<p class="metric-figure hero">
						{#if fleetLoading}
							<span class="metric-quiet">…</span>
						{:else if fleetError}
							<span class="metric-quiet">—</span>
						{:else if devices.length > 0}
							{formatCount(answering)}<span class="metric-total"
								>/ {formatCount(devices.length)}</span
							>
						{:else}
							{formatCount(answering)}
						{/if}
					</p>
					<p class="metric-note">
						{#if fleetLoading}
							Checking reachability…
						{:else if fleetError}
							Fleet state not reported.
							<button type="button" class="link-btn" onclick={() => void loadFleet()}>
								Try again
							</button>
						{:else if devices.length === 0}
							No device is paired yet.
						{:else}
							{fleetBreakdown}
						{/if}
					</p>
				</section>

				<section class="card span-3 metric lift" aria-label="Messages">
					<p class="eyebrow">Messages</p>
					<p class="metric-figure" class:empty={!health.counts}>
						{formatCount(health.counts?.messages)}
					</p>
					<p class="metric-note">
						{#if !health.counts}
							Not reported.
						{:else if health.last_message_at}
							Last <RelativeTime value={health.last_message_at} /> · kept
							{health.retention_days ?? 90} days
						{:else}
							No traffic yet.
						{/if}
					</p>
				</section>

				<section class="card span-3 metric lift" aria-label="Rules">
					<p class="eyebrow">Rules</p>
					<p class="metric-figure" class:empty={!health.counts}>
						{formatCount(health.counts?.rules)}
					</p>
					<p class="metric-note">
						{#if !health.counts}
							Not reported.
						{:else if health.counts.rules > 0}
							Matched in priority order, on the gateway.
						{:else}
							Nothing answers automatically yet.
						{/if}
					</p>
				</section>
			</div>

			<!-- 8 + 4 — the fleet, and the quiet (or alert) state beside it. -->
			<div class="bento" class:settle={!refreshNote} style="--i: 2">
				<section class="card span-8" aria-labelledby="devices-heading">
					<div class="card-head">
						<h2 id="devices-heading" class="card-title">Devices</h2>
						{#if !fleetLoading && !fleetError && devices.length > 0}
							<Badge tone="muted">{formatCount(devices.length)} paired</Badge>
						{/if}
						<a class="card-link" href={ROUTES.devices}>All devices</a>
					</div>

					{#if fleetLoading}
						<div aria-busy="true">
							<span class="sr-only">Loading devices</span>
							{#each ['a', 'b', 'c'] as key (key)}
								<div class="skeleton" style="height: 48px; margin-top: 12px"></div>
							{/each}
						</div>
					{:else if fleetError}
						<Notice tone="danger" title="Fleet state not reported">{fleetError}</Notice>
						<div class="row" style="margin-top: 12px">
							<button type="button" class="btn btn-sm" onclick={() => void loadFleet()}>
								<Icon name="refresh" size={13} /> Try again
							</button>
						</div>
					{:else if devices.length === 0}
						<EmptyState
							icon="smartphone"
							title="No devices paired yet"
							description="Mint a single-use code and open the link on the phone you want to answer. Until one is paired, nothing can reply."
						>
							<a class="btn btn-primary" href={`${ROUTES.devices}?mint=enroll`}>
								<Icon name="key" size={14} /> Mint a pairing code
							</a>
						</EmptyState>
					{:else}
						<ul class="dev-rows">
							{#each visibleDevices as device, index (device.device_id)}
								{@const state = fleetStates[index]}
								{@const secondary = deviceSecondary(device)}
								<li>
									<a
										class="devrow"
										href={`${ROUTES.devices}?device=${encodeURIComponent(device.device_id)}`}
									>
										<span class="dev-glyph" aria-hidden="true">
											<Icon name="smartphone" size={18} />
										</span>
										<span class="dev-copy">
											<span class="dev-name" class:mono={!secondary}>{devicePrimary(device)}</span>
											<span class="dev-meta mono">
												{#if secondary}{secondary} · {/if}
												{#if device.sim_slot !== null && device.sim_slot !== undefined}
													sim {device.sim_slot} ·
												{/if}
												{#if device.last_seen}
													seen <RelativeTime value={device.last_seen} />
												{:else}
													never synced
												{/if}
											</span>
										</span>
										<PresenceChip presence={state} />
									</a>
								</li>
							{/each}
						</ul>
						{#if remainingDevices > 0}
							<a class="dev-more" href={ROUTES.devices}>
								and {formatCount(remainingDevices)}
								{remainingDevices === 1 ? 'more device' : 'more devices'}
							</a>
						{/if}
					{/if}
				</section>

				<section
					class="card span-4 quiet-card"
					aria-labelledby="alerts-heading"
				>
					{#if openAlerts > 0}
						<div class="card-head">
							<h2 id="alerts-heading" class="card-title">Open alerts</h2>
							<Badge tone="danger" dot>{formatCount(openAlerts)}</Badge>
						</div>
						<p class="card-note">
							{formatCount(openAlerts)}
							{plural(openAlerts, 'device')}
							{openAlerts === 1 ? 'has' : 'have'} not been heard from.
							{openAlerts === 1
								? 'It stays open until you acknowledge it in the banner above.'
								: 'Acknowledge them in the banner above; they leave the open list.'}
						</p>
						<a class="card-link alerts-link" href={ROUTES.devices}>Open devices</a>
					{:else if !alertsKnown}
						<h2 id="alerts-heading" class="card-title">Alert state not reported</h2>
						<p class="card-note">
							The database did not answer, so open alerts cannot be counted. The status above
							says which check failed.
						</p>
					{:else}
						<h2 id="alerts-heading" class="card-title">The console is quiet</h2>
						<div class="quiet">
							<Mascot size={72} idle />
							<p class="quiet-title">No open alerts</p>
							<p class="card-note">
								Last checked <RelativeTime value={checkedAt} />. Alerts land here, not in your
								sleep.
							</p>
						</div>
					{/if}
				</section>
			</div>

			<!-- 12 — what answers a stranger. -->
			<div class="bento" class:settle={!refreshNote} style="--i: 3">
				<section class="card span-12" aria-labelledby="automation-heading">
					<div class="card-head">
						<h2 id="automation-heading" class="card-title">Automation</h2>
						{#if health.counts}
							<Badge tone="accent">
								{formatCount(health.counts.rules)}
								{plural(health.counts.rules, 'rule')}
							</Badge>
						{/if}
						<a class="card-link" href={ROUTES.rules}>Review automation</a>
					</div>

					<p class="pipeline">
						<span>
							Rules answer first on the gateway. When no rule matches, the phone runs its own
							flows. One reply per message, whichever answered.
						</span>
					</p>

					<div class="board">
						<div class="lane">
							<div class="lane-head">
								<span>Rules</span>
								{#if health.counts}
									<span class="lane-count mono">{formatCount(health.counts.rules)}</span>
								{/if}
							</div>
							{#if !health.counts}
								<p class="lane-note">Count not reported.</p>
							{:else if health.counts.rules === 0}
								<p class="lane-title">No rules yet</p>
								<p class="lane-note">Nothing answers automatically until a rule matches.</p>
								<a class="lane-link" href={ROUTES.rules}>Create a rule</a>
							{:else}
								<p class="lane-title">Authored on the gateway</p>
								<p class="lane-note">Rules run before flows, in priority order.</p>
								<a class="lane-link" href={ROUTES.rules}>Review rules</a>
							{/if}
						</div>

						<div class="lane">
							<div class="lane-head">
								<span>Flows</span>
							</div>
							<p class="lane-title">Run on the phone</p>
							<p class="lane-note">Synced graphs answer when no rule matched.</p>
							<a class="lane-link" href={ROUTES.workflows}>Open workflows</a>
						</div>

						<div class="lane">
							<div class="lane-head">
								<span>Reach</span>
							</div>
							{#if fleetLoading}
								<p class="lane-title">Checking…</p>
								<p class="lane-note">Waiting for device reachability.</p>
							{:else if fleetError}
								<p class="lane-title">Not reported</p>
								<p class="lane-note">A phone in contact is the only one that can run its flows.</p>
							{:else if devices.length === 0}
								<p class="lane-title">No phone paired</p>
								<p class="lane-note">A phone in contact is the only one that can run its flows.</p>
							{:else}
								<p class="lane-title">
									<span class="mono">{formatCount(answering)}</span>
									{answering === 1 ? 'phone answering' : 'phones answering'}
								</p>
								<p class="lane-note">A phone in contact is the only one that can run its flows.</p>
							{/if}
							<a class="lane-link" href={ROUTES.devices}>Open devices</a>
						</div>
					</div>
				</section>
			</div>
		</div>
	{/if}
</div>

<style>
	.checked {
		font-size: var(--df-p-text-xs);
		color: var(--df-text-meta);
		letter-spacing: 0.03em;
	}

	.checked.has-error {
		color: var(--df-state-danger-ink);
	}

	.break {
		overflow-wrap: anywhere;
	}

	.loading-line {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-2);
		color: var(--df-text-meta);
		font-size: var(--df-p-text-base);
	}

	/* ---------- status banner ---------- */

	.status {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		align-items: start;
		gap: var(--df-p-space-4);
	}

	.status[data-tone='warn'] {
		background: var(--df-state-warn-bg);
		border-color: var(--df-c-tint-edge-warn);
	}

	.status[data-tone='danger'] {
		background: var(--df-state-danger-bg);
		border-color: var(--df-c-tint-edge-danger);
	}

	.beacon {
		width: 10px;
		height: 10px;
		margin-top: 5px;
		border-radius: 50%;
		background: var(--df-text-meta);
		flex: none;
	}

	.beacon[data-tone='ok'] {
		background: var(--df-state-ok-ink);
		box-shadow: 0 0 0 4px color-mix(in srgb, var(--df-state-ok-ink) 16%, transparent);
		/* DESIGN_2026 §2: pulse is allowed on the deployment beacon, never on a row. */
		animation: pulse 2.4s ease-in-out infinite;
	}

	.beacon[data-tone='warn'] {
		background: var(--df-state-warn-ink);
		box-shadow: 0 0 0 4px color-mix(in srgb, var(--df-state-warn-ink) 16%, transparent);
	}

	.beacon[data-tone='danger'] {
		background: var(--df-state-danger-ink);
		box-shadow: 0 0 0 4px color-mix(in srgb, var(--df-state-danger-ink) 16%, transparent);
	}

	.status-main {
		min-width: 0;
	}

	.status h2 {
		margin-top: 4px;
		font-size: var(--df-p-text-xl);
		letter-spacing: -0.02em;
	}

	.status-sub {
		margin-top: 4px;
		max-width: 62ch;
		color: var(--df-text-secondary);
		font-size: var(--df-p-text-base);
		line-height: 1.5;
	}

	.status-facts {
		display: flex;
		align-items: flex-start;
		gap: var(--df-p-space-5);
		margin: 0;
		padding-left: var(--df-p-space-5);
		border-left: 1px solid var(--df-border-hairline);
	}

	.fact dt {
		font-family: var(--df-p-font-sans);
		font-size: var(--df-p-text-xs);
		font-weight: 600;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--df-text-meta);
	}

	.fact dd {
		margin: 4px 0 0;
		font-size: var(--df-p-text-base);
		color: var(--df-text-primary);
		white-space: nowrap;
	}

	/* ---------- metric cards ---------- */

	.metric {
		display: flex;
		flex-direction: column;
		gap: var(--df-p-space-2);
	}

	.metric-figure {
		margin-top: 2px;
		font-family: var(--df-p-font-mono);
		font-size: var(--df-p-text-2xl);
		font-weight: 600;
		line-height: 0.95;
		letter-spacing: -0.03em;
		font-variant-numeric: tabular-nums;
		color: var(--df-text-primary);
	}

	.metric-figure.hero {
		font-size: var(--df-p-text-3xl);
	}

	.metric-figure.empty,
	.metric-quiet {
		color: var(--df-text-meta);
	}

	.metric-total {
		margin-left: 6px;
		font-size: var(--df-p-text-xl);
		font-weight: 500;
		color: var(--df-text-meta);
	}

	.metric-note {
		margin-top: auto;
		font-size: var(--df-p-text-base);
		line-height: 1.45;
		color: var(--df-text-secondary);
	}

	.metric .link-btn {
		font-size: inherit;
	}

	/* ---------- device rows ---------- */

	.dev-rows {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.devrow {
		display: grid;
		grid-template-columns: 22px minmax(0, 1fr) auto;
		align-items: center;
		gap: var(--df-p-space-3);
		padding: 11px var(--df-p-space-2);
		border-top: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-md);
		color: var(--df-text-primary);
		text-decoration: none;
		transition: background-color 140ms ease;
	}

	.dev-rows li:first-child .devrow {
		border-top: 0;
	}

	.devrow:hover {
		background: var(--df-surface-well);
		text-decoration: none;
	}

	.dev-glyph {
		display: grid;
		place-items: center;
		color: var(--df-text-meta);
	}

	.dev-copy {
		min-width: 0;
	}

	.dev-name {
		display: block;
		font-size: var(--df-p-text-md);
		font-weight: 600;
		line-height: 1.3;
		overflow-wrap: anywhere;
	}

	.dev-meta {
		display: block;
		margin-top: 2px;
		font-size: var(--df-p-text-xs);
		color: var(--df-text-meta);
		overflow-wrap: anywhere;
	}

	.dev-more {
		display: inline-block;
		margin-top: var(--df-p-space-3);
		font-size: var(--df-p-text-sm);
		font-weight: 600;
	}

	/* ---------- quiet / alerts ---------- */

	.quiet-card {
		display: flex;
		flex-direction: column;
		gap: var(--df-p-space-2);
	}

	.quiet {
		flex: 1;
		display: grid;
		place-items: center;
		align-content: center;
		text-align: center;
		gap: var(--df-p-space-1);
		padding: var(--df-p-space-3) 0 0;
	}

	.quiet-title {
		font-family: var(--df-font-display);
		font-size: var(--df-p-text-md);
		font-weight: 700;
		color: var(--df-text-primary);
	}

	.alerts-link {
		margin-left: 0;
		margin-top: var(--df-p-space-2);
		align-self: flex-start;
	}

	/* ---------- automation board ---------- */

	.pipeline {
		margin-bottom: var(--df-p-space-3);
		padding: var(--df-p-space-3) var(--df-p-space-4);
		border-radius: var(--df-p-radius-md);
		background: var(--df-surface-well);
		color: var(--df-text-secondary);
		font-size: var(--df-p-text-base);
		line-height: 1.5;
	}

	.pipeline span {
		display: block;
		max-width: 78ch;
	}

	.board {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: var(--df-p-space-3);
	}

	.lane {
		display: flex;
		flex-direction: column;
		gap: var(--df-p-space-1);
		padding: var(--df-p-space-3);
		border-radius: var(--df-p-radius-md);
		background: var(--df-surface-well);
		min-width: 0;
	}

	.lane-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--df-p-space-2);
		padding-bottom: var(--df-p-space-1);
		font-size: var(--df-p-text-xs);
		font-weight: 600;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--df-text-meta);
	}

	.lane-count {
		font-size: var(--df-p-text-xs);
		letter-spacing: 0;
		color: var(--df-text-secondary);
	}

	.lane-title {
		font-size: var(--df-p-text-base);
		font-weight: 600;
		color: var(--df-text-primary);
	}

	.lane-note {
		font-size: var(--df-p-text-sm);
		line-height: 1.45;
		color: var(--df-text-meta);
	}

	.lane-link {
		margin-top: auto;
		padding-top: var(--df-p-space-2);
		font-size: var(--df-p-text-sm);
		font-weight: 600;
	}

	@media (max-width: 1100px) {
		.status {
			grid-template-columns: auto minmax(0, 1fr);
		}

		.status-facts {
			grid-column: 1 / -1;
			padding-left: 0;
			padding-top: var(--df-p-space-3);
			border-left: 0;
			border-top: 1px solid var(--df-border-hairline);
		}
	}

	@media (max-width: 720px) {
		.status {
			grid-template-columns: auto minmax(0, 1fr);
			gap: var(--df-p-space-3);
		}

		.status-facts {
			flex-wrap: wrap;
			gap: var(--df-p-space-4);
		}

		.board {
			grid-template-columns: minmax(0, 1fr);
		}

		.devrow {
			grid-template-columns: 20px minmax(0, 1fr);
			row-gap: 6px;
		}

		.devrow :global(.presence) {
			grid-column: 2;
		}
	}
</style>
