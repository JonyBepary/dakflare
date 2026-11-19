<script lang="ts">
	import { onMount } from 'svelte';
	import { acknowledgeAlert, describeError, getAlerts } from '$lib/api';
	import {
		alertKind,
		alertName,
		alertsHeadline,
		alertsSeverity,
		type AlertSeverity
	} from '$lib/alerts';
	import { session } from '$lib/session.svelte';
	import type { Alert } from '$lib/types';
	import { ROUTES } from '$lib/paths';
	import { ALERTS_CHANGED_EVENT } from '$lib/alert-events';
	import Badge from './Badge.svelte';
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

	const alertCount = $derived(alerts.length);
	const newest = $derived(alerts[0] ?? null);
	const shown = $derived(alerts.slice(0, 5));
	const remaining = $derived(Math.max(0, alerts.length - shown.length));
	/** The band's tone: the loudest kind present, never a fixed red. */
	const severity = $derived<AlertSeverity>(alertsSeverity(alerts));
	/** Acknowledging is a `write`; a member reads the alert and is told who can. */
	const canWrite = $derived(session.canWrite);

	function alertTone(value: AlertSeverity): 'danger' | 'warn' | 'neutral' {
		if (value === 'danger') return 'danger';
		if (value === 'warn') return 'warn';
		return 'neutral';
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
	<section class="alert-banner" data-severity={severity} aria-labelledby="open-alerts-title">
		<div class="alert-head">
			<span class="alert-mark" aria-hidden="true"><Icon name="alert" size={15} /></span>
			<div class="alert-copy">
				<h2 id="open-alerts-title">{alertsHeadline(alerts)}</h2>
				{#if newest && alertCount > 1}
					<p class="alert-meta">
						Newest: <a class="alert-device-link" href={deviceHref(newest)}>{alertName(newest)}</a>
						· raised <RelativeTime value={newest.raised_at} />
					</p>
				{/if}
			</div>
			{#if alertCount > 1}
				<button
					type="button"
					class="btn btn-sm"
					onclick={() => (expanded = !expanded)}
					aria-expanded={expanded}
					aria-controls="open-alert-list"
				>
					{expanded ? 'Hide alerts' : `Review ${alertCount}`}
				</button>
			{/if}
		</div>

		{#if alertCount === 1 || expanded}
			<ul class="alert-list" id="open-alert-list">
				{#each shown as alert (alert.id)}
					{@const meta = alertKind(alert.kind)}
					{@const lines = meta.detail(alert.detail)}
					<li class="alert-row" data-severity={meta.severity}>
						<div class="alert-row-head">
							<Badge tone={alertTone(meta.severity)}>{meta.label}</Badge>
							<span class="alert-device">
								<a
									class="alert-device-link"
									href={deviceHref(alert)}
									aria-label={`${alertName(alert)} — ${meta.known ? meta.label : alert.kind} alert`}
								>{alertName(alert)}</a>
								{#if alert.label?.trim()}
									<span class="mono">{alert.device_id}</span>
								{/if}
							</span>
							<span class="spacer"></span>
							<span class="alert-age">
								raised <RelativeTime value={alert.raised_at} />
							</span>
						</div>

						{#if lines.length > 0 || !meta.known}
							<div class="alert-detail">
								{#each lines as line, index (index)}
									<p>{line}</p>
								{/each}
								{#if !meta.known}
									<p class="alert-kind-raw">
										No wording for this kind yet — the detail above is the gateway's own.
									</p>
								{/if}
							</div>
						{/if}

						{#if canWrite}
							<button
								type="button"
								class="btn btn-sm alert-ack"
								onclick={() => void acknowledge(alert)}
								disabled={acking.has(alert.id)}
								aria-busy={acking.has(alert.id)}
								aria-label={`Acknowledge the ${meta.known ? meta.label.toLowerCase() : alert.kind} alert for ${alertName(alert)}`}
							>
								{#if acking.has(alert.id)}<Spinner />{:else}<Icon name="check" size={12} />{/if}
								Acknowledge
							</button>
						{/if}
					</li>
				{/each}
			</ul>
			{#if remaining > 0}
				<p class="alert-more">and {remaining} more open {remaining === 1 ? 'alert' : 'alerts'}</p>
			{/if}
			{#if !canWrite}
				<p class="alert-note">
					<Icon name="shield" size={13} />
					<span>Members can read alerts; an owner or admin acknowledges one.</span>
				</p>
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
	   DESIGN_2026 §2 forbids motion on the alert path.

	   Tone follows the loudest kind in the band, not the band itself: a phone that
	   went silent is an outage and reads red; a drifting extraction is a warning
	   and reads amber; a kind this console does not know reads neutral. One local
	   pair of custom properties is the whole palette, so every edge below follows
	   the severity with it. */
	.alert-banner {
		--alert-ink: var(--df-state-danger-ink);
		--alert-bg: var(--df-state-danger-bg);
		--alert-edge: color-mix(in srgb, var(--df-state-danger-ink) 22%, transparent);
		--alert-rule: color-mix(in srgb, var(--df-state-danger-ink) 12%, transparent);
		border-bottom: 1px solid var(--alert-edge);
		background: var(--alert-bg);
	}

	.alert-banner[data-severity='warn'] {
		--alert-ink: var(--df-state-warn-ink);
		--alert-bg: var(--df-state-warn-bg);
		--alert-edge: var(--df-c-tint-edge-warn);
		--alert-rule: color-mix(in srgb, var(--df-state-warn-ink) 14%, transparent);
	}

	.alert-banner[data-severity='info'] {
		--alert-ink: var(--df-text-secondary);
		--alert-bg: var(--df-surface-well);
		--alert-edge: var(--df-border-hairline);
		--alert-rule: var(--df-border-hairline);
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
		border: 1px solid var(--alert-edge);
		border-radius: var(--df-p-radius-sm);
		background: var(--df-surface-card);
		color: var(--alert-ink);
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

	@media (hover: hover) and (pointer: fine) {
		.alert-device-link:hover {
			color: var(--df-accent-text);
		}
	}

	.alert-list {
		list-style: none;
		margin: 0;
		padding: 0;
		border-top: 1px solid var(--alert-edge);
	}

	/* Kind, device and age share the first line; the detail and the one control
	   share the second, so a row is two lines at any width that fits. */
	.alert-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: 6px var(--df-p-space-3);
		padding: 9px var(--df-c-shell-gutter);
		border-bottom: 1px solid var(--alert-rule);
	}

	.alert-row:last-child {
		border-bottom: 0;
	}

	.alert-row-head {
		grid-column: 1 / -1;
		display: flex;
		align-items: center;
		gap: var(--df-p-space-2);
		flex-wrap: wrap;
		min-width: 0;
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

	/* The row's device name is a standalone control, not a link inside a
	   sentence: it carries a 24px hit height like every other small target. */
	.alert-row .alert-device-link {
		display: inline-flex;
		align-items: center;
		min-height: 24px;
	}

	.alert-detail {
		display: grid;
		gap: 2px;
		min-width: 0;
		padding-left: 2px;
	}

	.alert-detail p {
		font-size: var(--df-p-text-base);
		line-height: 1.5;
		color: var(--df-text-secondary);
		overflow-wrap: anywhere;
	}

	.alert-kind-raw {
		font-size: var(--df-p-text-xs);
		color: var(--df-text-meta);
	}

	.alert-age {
		font-family: var(--df-p-font-mono);
		font-size: var(--df-p-text-xs);
		color: var(--df-text-secondary);
		white-space: nowrap;
	}

	.alert-ack {
		justify-self: end;
	}

	.alert-more,
	.alert-error,
	.alert-note {
		display: flex;
		align-items: flex-start;
		gap: 6px;
		padding: 8px var(--df-c-shell-gutter);
		font-size: var(--df-p-text-sm);
		line-height: 1.45;
		color: var(--df-text-secondary);
	}

	.alert-more {
		border-top: 1px solid var(--alert-rule);
	}

	.alert-note {
		border-top: 1px solid var(--alert-rule);
		color: var(--df-text-meta);
	}

	.alert-note :global(svg) {
		flex: none;
		margin-top: 2px;
	}

	.alert-error {
		border-top: 1px solid var(--alert-edge);
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
		.alert-row {
			grid-template-columns: minmax(0, 1fr);
		}

		.alert-row-head {
			grid-column: 1;
		}

		.alert-ack {
			width: 100%;
			min-height: 44px;
			justify-content: center;
		}

		.alert-check {
			align-items: flex-start;
		}
	}
</style>
