<script lang="ts">
	import { page } from '$app/state';
	import StateSwitcher, { type StateGroup } from './StateSwitcher.svelte';
	import type { AlertsStateKey } from './+page';

	let { data }: { data: { state: AlertsStateKey } } = $props();

	const GROUPS: ReadonlyArray<StateGroup> = [
		{
			heading: 'Alert kinds',
			states: [
				{ key: 'extraction-drift', label: 'Extraction drift (warn)' },
				{ key: 'device-offline', label: 'Device silent (danger)' },
				{ key: 'unrecognised-kind', label: 'Kind this build does not know' },
				{ key: 'mixed-kinds', label: 'All three at once' }
			]
		}
	];

	const current = $derived(data.state);

	const NOTE: Record<AlertsStateKey, string> = {
		'extraction-drift':
			'A flow stopped capturing the field its extract node declares. The band is amber, the heading names the flow problem, and the detail line says which field on which step missed how many messages.',
		'device-offline':
			'The one alert that is a real outage: red band, the original "has not been heard from" heading, and a detail that counts the silence in minutes.',
		'unrecognised-kind':
			'A kind newer than this console build. The band is neutral, the heading says the alert is unrecognised, and the raw kind is printed beside the gateway\u2019s own detail \u2014 it must never read as silence.',
		'mixed-kinds':
			'Three kinds in one band. The heading counts alerts instead of borrowing one kind\u2019s sentence, and each row keeps its own tone, so the drift row is amber inside a red band.'
	};

	/**
	 * The banner belongs to the shell, so switching kinds is a full load: the
	 * point of this workbench is the band above, and a client-side swap would
	 * leave the old alert on screen until the next 30 s poll.
	 */
	function selectState(next: string): void {
		if (next === current) return;
		const url = new URL(page.url.href);
		url.searchParams.set('__state', next);
		window.location.assign(url.toString());
	}
</script>

<svelte:head>
	<title>Alerts · State workbench</title>
</svelte:head>

<StateSwitcher groups={GROUPS} {current} onchange={selectState}>
	<section class="card note">
		<p class="eyebrow">Shell</p>
		<h1 id="note-title">The alert band above this page</h1>
		<p class="hint">
			The banner under the header is the console&rsquo;s own <code>AlertBanner</code>, drawn by the
			shell on every screen. This workbench only decides what the gateway reports, then shows the
			same component the operator sees.
		</p>
		<p id="note-state">{NOTE[current]}</p>
		<p class="hint">
			Acknowledging is a write on the Worker: an owner sees the button, a member sees the sentence
			that says who can dismiss it.
		</p>
	</section>
</StateSwitcher>

<style>
	.note {
		display: grid;
		gap: 10px;
		max-width: 78ch;
	}

	.note h1 {
		font-family: var(--df-font-display);
		font-size: var(--df-p-text-xl);
		font-weight: 700;
		line-height: 1.25;
		letter-spacing: -0.015em;
	}

	.note p {
		font-size: var(--df-p-text-sm);
		line-height: 1.6;
		color: var(--df-text-secondary);
	}

	.note code {
		font-family: var(--df-p-font-mono);
		font-size: var(--df-p-text-xs);
	}
</style>
