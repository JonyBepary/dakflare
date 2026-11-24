<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import CommandTracker from '$lib/components/CommandTracker.svelte';
	import StateSwitcher, { type StateGroup } from './StateSwitcher.svelte';
	import type { TrackerStateKey } from './+page';

	let { data }: { data: { state: TrackerStateKey } } = $props();

	const GROUPS: ReadonlyArray<StateGroup> = [
		{
			heading: 'In flight',
			states: [
				{ key: 'loading', label: 'Loading' },
				{ key: 'queued', label: 'Queued (PENDING)' },
				{ key: 'leased', label: 'Leased to phone' },
				{ key: 'dispatched', label: 'Dispatched to radio' }
			]
		},
		{
			heading: 'Terminal',
			states: [
				{ key: 'sent', label: 'Sent by radio' },
				{ key: 'delivered', label: 'Delivered receipt' },
				{ key: 'failed-pre-phone', label: 'Failed before phone' },
				{ key: 'failed-radio-no-service', label: 'Failed (no service)' },
				{ key: 'failed-resendable', label: 'Failed with Resend' },
				{ key: 'expired', label: 'Expired before pickup' }
			]
		},
		{
			heading: 'Edge',
			states: [
				{ key: 'not-found', label: 'Command not found' },
				{ key: 'load-error', label: 'Poll failed (offline)' }
			]
		}
	];

	const current = $derived(data.state);
	let cmdOverride = $state<string | null>(null);
	$effect(() => {
		void current;
		cmdOverride = null;
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
	<title>Command tracker · State workbench</title>
</svelte:head>

<StateSwitcher groups={GROUPS} {current} onchange={selectState}>
	{#key current}
		<div class="card">
			<CommandTracker
				deviceId="dev_px6a_desk_01"
				commandId={cmdOverride ?? 'cmd_01jd8z9p2w4k7m3x8r5t'}
				onResend={current === 'failed-resendable'
					? async () => {
							cmdOverride = 'cmd_resend_new_02';
						}
					: undefined}
			/>
		</div>
	{/key}
</StateSwitcher>
