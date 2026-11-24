<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import ApprovalsPage from '../../approvals/+page.svelte';
	import StateSwitcher, { type StateGroup } from './StateSwitcher.svelte';
	import { syncWorkbenchShell } from './stub';
	import type { ApprovalsStateKey } from './+page';

	let { data }: { data: { state: ApprovalsStateKey } } = $props();

	const GROUPS: ReadonlyArray<StateGroup> = [
		{
			heading: 'Queue',
			states: [
				{ key: 'loading', label: 'Loading queue & grants' },
				{ key: 'empty', label: 'Nothing waiting' },
				{ key: 'pending-queue', label: 'Pending + live grants' },
				{ key: 'pending-capped-and-urgent', label: 'Expiring & blocked ceiling' },
				{ key: 'load-error', label: 'Queue load failed' }
			]
		},
		{
			heading: 'Grants & Access',
			states: [
				{ key: 'grants-active', label: 'Live grants only' },
				{ key: 'grants-error', label: 'Grants read failed' },
				{ key: 'not-allowed-member', label: 'Member session (locked)' }
			]
		},
		{
			heading: 'History',
			states: [
				{ key: 'history-decided', label: 'Two decisions & a revoked grant' }
			]
		}
	];

	const current = $derived(data.state);

	$effect(() => {
		const expectedRole = current === 'not-allowed-member' ? 'member' : 'owner';
		void syncWorkbenchShell(`approvals:${current}`, expectedRole);
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
	<title>Approvals · State workbench</title>
</svelte:head>

<StateSwitcher groups={GROUPS} {current} onchange={selectState}>
	{#key current}
		<ApprovalsPage />
	{/key}
</StateSwitcher>
