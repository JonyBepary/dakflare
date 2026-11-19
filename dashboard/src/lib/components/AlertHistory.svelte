<script lang="ts">
	import { onMount } from 'svelte';
	import { describeError, getAlerts } from '$lib/api';
	import { alertKind, alertName } from '$lib/alerts';
	import { ALERTS_CHANGED_EVENT } from '$lib/alert-events';
	import type { Alert } from '$lib/types';
	import Badge from './Badge.svelte';
	import Icon from './Icon.svelte';
	import RelativeTime from './RelativeTime.svelte';
	import Spinner from './Spinner.svelte';

	/*
	 * The banner shows what needs an operator now. This is the other half: the
	 * alerts that were acknowledged or resolved and therefore left it. It is a
	 * disclosure rather than a panel of its own, and it fetches nothing until it
	 * is opened, so the Overview still answers "nothing needs you" at a glance.
	 *
	 * A member reads it; nothing here writes, because an acknowledged alert has
	 * no second act.
	 */

	let open = $state(false);
	let alerts = $state<Alert[] | null>(null);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let inFlight = false;

	function resolvedAt(alert: Alert): number | null {
		const at = alert.resolved_at;
		return typeof at === 'number' && Number.isFinite(at) && at > 0 ? at : null;
	}

	function closedAt(alert: Alert): number | null {
		return resolvedAt(alert) ?? alert.acknowledged_at;
	}

	/** Acknowledged and resolved rows, newest first. Open rows stay in the banner. */
	const closed = $derived(
		(alerts ?? [])
			.filter((alert) => closedAt(alert) !== null)
			.slice()
			.sort((left, right) => right.raised_at - left.raised_at)
	);

	async function load(): Promise<void> {
		if (inFlight) return;
		inFlight = true;
		loading = true;
		error = null;
		try {
			alerts = await getAlerts(true);
		} catch (failure) {
			error = describeError(failure);
		} finally {
			loading = false;
			inFlight = false;
		}
	}

	function handleToggle(event: Event): void {
		const element = event.currentTarget as HTMLDetailsElement | null;
		// Every open is a fresh read: an acknowledgement in the banner is the
		// thing that moves a row here, and a cached list would miss it.
		if (element?.open === true && !loading) void load();
	}

	onMount(() => {
		// An acknowledgement in the banner is what moves a row here. Reload an
		// open history; forget a closed one so its next open is current.
		const onAlertsChanged = () => {
			if (open) void load();
			else alerts = null;
		};
		window.addEventListener(ALERTS_CHANGED_EVENT, onAlertsChanged);
		return () => window.removeEventListener(ALERTS_CHANGED_EVENT, onAlertsChanged);
	});
</script>

<details class="alert-history" bind:open ontoggle={handleToggle}>
	<summary>
		<span class="summary-mark" aria-hidden="true"><Icon name="history" size={13} /></span>
		<span class="summary-label">Alert history</span>
		<span class="spacer"></span>
		<span class="summary-chevron" aria-hidden="true"><Icon name="chevron-down" size={13} /></span>
	</summary>

	<div class="history-body">
		{#if loading && alerts === null}
			<p class="history-state" role="status"><Spinner /> Reading the alert history…</p>
		{:else if error}
			<p class="history-error" role="alert">
				<span>The history could not be read. {error}</span>
				<button type="button" class="link-btn" onclick={() => void load()}>Retry</button>
			</p>
		{:else if alerts !== null && closed.length === 0}
			<p class="history-state">Nothing has been acknowledged or resolved yet.</p>
		{:else if closed.length > 0}
			<p class="history-lede">
				{alerts?.length === closed.length
					? 'Every alert on this gateway is closed'
					: `${closed.length} closed ${closed.length === 1 ? 'alert' : 'alerts'}`}, newest first.
			</p>

			<ul class="history-list">
				{#each closed as alert (alert.id)}
					{@const meta = alertKind(alert.kind)}
					{@const lines = meta.detail(alert.detail)}
					{@const resolved = resolvedAt(alert) !== null}
					{@const endedAt = closedAt(alert)}
					<li class="history-row" data-state={resolved ? 'resolved' : 'acknowledged'}>
						<div class="history-head">
							<Badge tone="neutral">{meta.label}</Badge>
							<span class="history-device">{alertName(alert)}</span>
							<span class="spacer"></span>
							<span class="history-ended">
								<span class="history-state-word">{resolved ? 'Resolved' : 'Acknowledged'}</span>
								<RelativeTime value={endedAt} />
							</span>
						</div>

						<p class="history-when">Raised <RelativeTime value={alert.raised_at} /></p>

						{#if lines.length > 0}
							<p class="history-detail">{lines.join(' ')}</p>
						{:else}
							<p class="history-detail">The gateway recorded no detail for this alert.</p>
						{/if}

						{#if alert.acknowledged_by}
							<p class="history-when">Acknowledged by {alert.acknowledged_by}</p>
						{/if}

						{#if !meta.known}
							<p class="history-raw">Kind as the gateway sent it: <span class="mono">{alert.kind}</span></p>
						{/if}
					</li>
				{/each}
			</ul>

			<p class="history-foot">
				Rows written before the gateway recorded an account show only the time.
			</p>
		{/if}
	</div>
</details>

<style>
	/* A footer line of the alert card, not a second card. The top rule separates
	   history from the state above it; the summary itself carries no background
	   so a quiet Overview still reads as quiet. */
	.alert-history {
		margin-top: var(--df-p-space-3);
		border-top: 1px solid var(--df-border-hairline);
	}

	summary {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-2);
		min-height: 44px;
		padding: var(--df-p-space-1) 0;
		border-radius: var(--df-p-radius-sm);
		list-style: none;
		cursor: pointer;
		color: var(--df-text-secondary);
		font-size: var(--df-p-text-sm);
		font-weight: 600;
	}

	summary::-webkit-details-marker {
		display: none;
	}

	summary:focus-visible {
		outline: 2px solid var(--df-border-focus);
		outline-offset: 2px;
	}

	@media (hover: hover) and (pointer: fine) {
		summary:hover {
			color: var(--df-text-primary);
		}
	}

	.summary-mark {
		display: grid;
		place-items: center;
		width: 24px;
		height: 24px;
		flex: none;
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-sm);
		background: var(--df-surface-well);
		color: var(--df-text-meta);
	}

	.summary-label {
		white-space: nowrap;
	}

	.summary-chevron {
		display: grid;
		place-items: center;
		flex: none;
		color: var(--df-text-meta);
		transition: transform var(--df-p-dur-lift) ease;
	}

	.alert-history[open] .summary-chevron {
		transform: rotate(180deg);
	}

	.history-body {
		display: grid;
		gap: var(--df-p-space-2);
		padding: 0;
	}

	.history-lede,
	.history-state,
	.history-error {
		font-size: var(--df-p-text-xs);
		line-height: 1.5;
		color: var(--df-text-meta);
	}

	.history-state {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-2);
	}

	.history-error {
		display: flex;
		align-items: baseline;
		gap: var(--df-p-space-2);
		flex-wrap: wrap;
		color: var(--df-state-danger-ink);
	}

	.history-error .link-btn {
		min-height: 24px;
	}

	.history-list {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.history-row {
		display: grid;
		gap: 2px;
		padding: var(--df-p-space-2) 0;
	}

	.history-row + .history-row {
		border-top: 1px solid var(--df-border-hairline);
	}

	.history-head {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-2);
		flex-wrap: wrap;
		min-width: 0;
	}

	.history-device {
		font-size: var(--df-p-text-base);
		font-weight: 600;
		color: var(--df-text-primary);
		overflow-wrap: anywhere;
	}

	.history-ended {
		display: inline-flex;
		align-items: baseline;
		gap: var(--df-p-space-1);
		font-family: var(--df-p-font-mono);
		font-size: var(--df-p-text-2xs);
		color: var(--df-text-meta);
		white-space: nowrap;
	}

	.history-state-word {
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}

	.history-row[data-state='acknowledged'] .history-state-word {
		color: var(--df-text-secondary);
	}

	.history-when,
	.history-detail,
	.history-raw {
		font-size: var(--df-p-text-xs);
		line-height: 1.5;
		overflow-wrap: anywhere;
	}

	.history-when {
		color: var(--df-text-meta);
	}

	.history-detail {
		color: var(--df-text-secondary);
	}

	.history-raw {
		color: var(--df-text-meta);
	}

	.history-foot {
		padding: var(--df-p-space-1) 0 var(--df-p-space-1);
		font-size: var(--df-p-text-2xs);
		line-height: 1.5;
		color: var(--df-text-meta);
	}

	@media (max-width: 620px) {
		.history-ended {
			width: 100%;
			justify-content: flex-start;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.summary-chevron {
			transition: none;
		}
	}
</style>
