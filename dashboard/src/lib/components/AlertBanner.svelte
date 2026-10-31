<script lang="ts">
	import { onMount } from 'svelte';
	import { acknowledgeAlert, describeError, getAlerts } from '$lib/api';
	import type { Alert } from '$lib/types';
	import { ROUTES } from '$lib/paths';
	import { ALERTS_CHANGED_EVENT } from '$lib/alert-events';
	import Icon from './Icon.svelte';
	import RelativeTime from './RelativeTime.svelte';
	import Spinner from './Spinner.svelte';

	const POLL_MS = 30_000;

	let alerts = $state<Alert[]>([]);
	let error = $state<string | null>(null);
	let ackError = $state<string | null>(null);
	let expanded = $state(false);
	let acking = $state<Set<string>>(new Set());
	let inFlight = false;

	const deviceCount = $derived(alerts.length);
	const deviceWord = $derived(deviceCount === 1 ? 'device' : 'devices');
	const newest = $derived(alerts[0] ?? null);
	const shown = $derived(alerts.slice(0, 5));
	const remaining = $derived(Math.max(0, alerts.length - shown.length));

	function alertName(alert: Alert): string {
		const label = alert.label?.trim();
		return label ? label : alert.device_id;
	}

	function deviceHref(alert: Alert): string {
		return `${ROUTES.devices}?device=${encodeURIComponent(alert.device_id)}`;
	}

	async function load(force = false): Promise<void> {
		if (document.visibilityState !== 'visible' || (inFlight && !force)) return;
		inFlight = true;
		const previous = alerts.length;
		try {
			const next = await getAlerts();
			alerts = next;
			error = null;
			ackError = null;
			if (next.length !== previous) {
				window.dispatchEvent(new Event(ALERTS_CHANGED_EVENT));
			}
		} catch (failure) {
			error = describeError(failure);
		} finally {
			inFlight = false;
		}
	}

	async function acknowledge(alert: Alert): Promise<void> {
		if (acking.has(alert.id)) return;
		const index = alerts.findIndex((item) => item.id === alert.id);
		if (index === -1) return;

		acking = new Set(acking).add(alert.id);
		ackError = null;
		// Optimistic removal: the operator asked for this row to stop shouting.
		alerts = alerts.filter((item) => item.id !== alert.id);
		try {
			await acknowledgeAlert(alert.id);
			window.dispatchEvent(new Event(ALERTS_CHANGED_EVENT));
			void load(true);
		} catch (failure) {
			// Put the row back where it was. A failed ack must never look successful.
			if (!alerts.some((item) => item.id === alert.id)) {
				const restored = [...alerts];
				restored.splice(Math.min(index, restored.length), 0, alert);
				alerts = restored;
			}
			ackError = `Could not acknowledge ${alertName(alert)}. ${describeError(failure)}`;
		} finally {
			const next = new Set(acking);
			next.delete(alert.id);
			acking = next;
		}
	}

	onMount(() => {
		void load();
		const timer = setInterval(() => {
			if (document.visibilityState === 'visible') void load();
		}, POLL_MS);
		const onVisible = () => {
			if (document.visibilityState === 'visible') void load();
		};
		document.addEventListener('visibilitychange', onVisible);
		return () => {
			clearInterval(timer);
			document.removeEventListener('visibilitychange', onVisible);
		};
	});
</script>

{#if alerts.length > 0}
	<section class="alert-banner" aria-labelledby="open-alerts-title">
		<div class="alert-head">
			<span class="alert-mark" aria-hidden="true"><Icon name="alert" size={15} /></span>
			<div class="alert-copy">
				<h2 id="open-alerts-title">
					{#if deviceCount === 1 && newest}
						{alertName(newest)} has not been heard from
					{:else}
						{deviceCount} {deviceWord} {deviceCount === 1 ? 'has' : 'have'} not been heard from
					{/if}
				</h2>
				{#if newest && deviceCount > 1}
					<p class="alert-meta">
						Newest: <a class="alert-device-link" href={deviceHref(newest)}>{alertName(newest)}</a>
						· raised <RelativeTime value={newest.raised_at} />
					</p>
				{/if}
			</div>
			{#if deviceCount > 1}
				<button
					type="button"
					class="btn btn-sm"
					onclick={() => (expanded = !expanded)}
					aria-expanded={expanded}
					aria-controls="open-alert-list"
				>
					{expanded ? 'Hide devices' : `Review ${deviceCount}`}
				</button>
			{/if}
		</div>

		{#if deviceCount === 1 || expanded}
			<ul class="alert-list" id="open-alert-list">
				{#each shown as alert (alert.id)}
					<li class="alert-row">
						<span class="alert-device">
							<a class="alert-device-link" href={deviceHref(alert)}>{alertName(alert)}</a>
							{#if alert.label?.trim()}
								<span class="mono">{alert.device_id}</span>
							{/if}
						</span>
						<span class="alert-age">
							raised <RelativeTime value={alert.raised_at} />
						</span>
						<button
							type="button"
							class="btn btn-sm btn-danger-ghost"
							onclick={() => void acknowledge(alert)}
							disabled={acking.has(alert.id)}
							aria-busy={acking.has(alert.id)}
							aria-label={`Acknowledge alert for ${alertName(alert)}`}
						>
							{#if acking.has(alert.id)}<Spinner />{:else}<Icon name="check" size={12} />{/if}
							Acknowledge
						</button>
					</li>
				{/each}
			</ul>
			{#if remaining > 0}
				<p class="alert-more">and {remaining} more open {remaining === 1 ? 'alert' : 'alerts'}</p>
			{/if}
		{/if}

		{#if ackError}
			<p class="alert-error" role="alert">{ackError}</p>
		{/if}
	</section>
{:else if error}
	<div class="alert-check" role="status">
		<Icon name="info" size={13} />
		<span>The console could not check for alerts. {error}</span>
		<button type="button" class="link-btn" onclick={() => void load()}>Retry</button>
	</div>
{/if}

<style>
	/* Full-bleed band under the header: 04 §4.5. No entrance animation —
	   DESIGN_2026 §2 forbids motion on the alert path. */
	.alert-banner {
		border-bottom: 1px solid color-mix(in srgb, var(--df-state-danger-ink) 22%, transparent);
		background: var(--df-state-danger-bg);
	}

	.alert-head {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		padding: 13px var(--df-c-shell-gutter);
	}

	.alert-mark {
		display: grid;
		place-items: center;
		width: 26px;
		height: 26px;
		flex: none;
		border: 1px solid color-mix(in srgb, var(--df-state-danger-ink) 26%, transparent);
		border-radius: var(--df-p-radius-sm);
		background: var(--df-surface-card);
		color: var(--df-state-danger-ink);
	}

	.alert-copy {
		flex: 1;
		min-width: 0;
	}

	.alert-copy h2 {
		font-family: var(--df-font-display);
		font-size: var(--df-p-text-md);
		font-weight: 700;
		color: var(--df-text-primary);
		line-height: 1.35;
	}

	.alert-meta {
		margin-top: 2px;
		font-size: var(--df-p-text-base);
		line-height: 1.45;
		color: var(--df-text-secondary);
		overflow-wrap: anywhere;
	}

	.alert-device-link {
		color: var(--df-text-primary);
		font-weight: 600;
		text-decoration: underline;
		text-underline-offset: 2px;
	}

	.alert-device-link:hover {
		color: var(--df-accent-text);
	}

	.alert-list {
		list-style: none;
		margin: 0;
		padding: 0;
		border-top: 1px solid color-mix(in srgb, var(--df-state-danger-ink) 18%, transparent);
	}

	.alert-row {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-3);
		flex-wrap: wrap;
		padding: 9px var(--df-c-shell-gutter);
		border-bottom: 1px solid color-mix(in srgb, var(--df-state-danger-ink) 12%, transparent);
	}

	.alert-row:last-child {
		border-bottom: 0;
	}

	.alert-device {
		display: flex;
		flex-direction: column;
		gap: 1px;
		min-width: 0;
	}

	.alert-device .mono {
		font-size: var(--df-p-text-xs);
		color: var(--df-text-secondary);
		overflow-wrap: anywhere;
	}

	.alert-age {
		font-family: var(--df-p-font-mono);
		font-size: var(--df-p-text-xs);
		color: var(--df-text-secondary);
		white-space: nowrap;
	}

	.alert-row .btn {
		margin-left: auto;
	}

	.alert-more,
	.alert-error {
		padding: 8px var(--df-c-shell-gutter);
		font-size: var(--df-p-text-sm);
		line-height: 1.45;
		color: var(--df-text-secondary);
	}

	.alert-more {
		border-top: 1px solid color-mix(in srgb, var(--df-state-danger-ink) 12%, transparent);
	}

	.alert-error {
		border-top: 1px solid color-mix(in srgb, var(--df-state-danger-ink) 18%, transparent);
		color: var(--df-state-danger-ink);
	}

	.alert-check {
		display: flex;
		align-items: center;
		gap: 7px;
		flex-wrap: wrap;
		padding: 8px var(--df-c-shell-gutter);
		border-bottom: 1px solid var(--df-border-hairline);
		background: var(--df-surface-well);
		font-size: var(--df-p-text-sm);
		color: var(--df-text-meta);
	}

	@media (max-width: 620px) {
		.alert-row .btn {
			margin-left: 0;
			width: 100%;
			min-height: 44px;
		}

		.alert-check {
			align-items: flex-start;
		}
	}
</style>
