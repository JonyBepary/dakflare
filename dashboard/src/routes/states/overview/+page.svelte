<script lang="ts">
	import { goto } from '$app/navigation';
	import { untrack } from 'svelte';
	import { page } from '$app/state';
	import OverviewPage from '../../+page.svelte';
	import StateSwitcher, { type StateGroup } from './StateSwitcher.svelte';
	import { syncWorkbenchShell } from './stub';
	import type { OverviewStateKey } from './+page';

	let { data }: { data: { state: OverviewStateKey } } = $props();

	const GROUPS: ReadonlyArray<StateGroup> = [
		{
			heading: 'Fleet & Health',
			states: [
				{ key: 'loading', label: 'Loading' },
				{ key: 'first-run-no-devices', label: 'First run (no device)' },
				{ key: 'healthy-fleet', label: 'Healthy fleet' },
				{ key: 'active-alerts', label: 'Open offline alerts' },
				{ key: 'alert-history', label: 'Quiet, with closed history' },
				{ key: 'degraded-storage', label: 'Degraded bindings & DB' },
				{ key: 'load-error', label: 'Health error' }
			]
		},
		{
			heading: 'Session & Agent',
			states: [
				{ key: 'member-session', label: 'Member session' },
				{ key: 'alert-history-member', label: 'Member reads history' },
				{ key: 'active-alerts-member', label: 'Member, open alerts' },
				{ key: 'autonomy-open', label: 'Autonomy window open' }
			]
		}
	];

	const current = $derived(data.state);

	$effect(() => {
		const expectedRole =
			current === 'member-session' || current === 'alert-history-member' ? 'member' : 'owner';
		// `syncWorkbenchShell` reads and writes the session store; tracking those
		// reads here re-runs this effect on its own write and loops the sign-in.
		void untrack(() => syncWorkbenchShell(`overview:${current}`, expectedRole));
	});

	function selectState(next: string): void {
		if (next === current) return;
		const url = new URL(page.url.href);
		url.searchParams.set('__state', next);
		void goto(`${url.pathname}?${url.searchParams.toString()}`, {
			reset: false
		});
	}
</script>

<svelte:head>
	<title>Overview · State workbench</title>
</svelte:head>

<StateSwitcher groups={GROUPS} {current} onchange={selectState}>
	{#key current}
		<OverviewPage />
	{/key}
</StateSwitcher>
