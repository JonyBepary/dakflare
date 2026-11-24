<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import QrCode from '$lib/components/QrCode.svelte';
	import StateSwitcher, { type StateGroup } from './StateSwitcher.svelte';
	import type { QrStateKey } from './+page';

	let { data }: { data: { state: QrStateKey } } = $props();

	const GROUPS: ReadonlyArray<StateGroup> = [
		{
			heading: 'Sizing & payload',
			states: [
				{ key: 'default-200', label: 'Default 200px' },
				{ key: 'large-260', label: 'Large 260px' },
				{ key: 'rotate-long-url', label: 'Key rotation URI' },
				{ key: 'captionless', label: 'No caption' },
				{ key: 'empty-error', label: 'Fallback (empty value)' }
			]
		}
	];

	const current = $derived(data.state);

	function selectState(next: string): void {
		if (next === current) return;
		const url = new URL(page.url.href);
		url.searchParams.set('__state', next);
		void goto(`${url.pathname}?${url.searchParams.toString()}`, {
			reset: false
		});
	}

	const enrollLink = 'dakflare://pair?gateway=https%3A%2F%2Fsms.example.com&token=0f9c1a72b4e5d6f7';
	const rotateLink =
		'dakflare://pair?gateway=https%3A%2F%2Fsms.internal.dakflare.example&purpose=rotate&device_id=dev_px6a_desk_01&token=98ab76cd54ef3210fedcba9876543210';
</script>

<svelte:head>
	<title>QR code · State workbench</title>
</svelte:head>

<StateSwitcher groups={GROUPS} {current} onchange={selectState}>
	{#key current}
		<div class="card qr-cell">
			{#if current === 'default-200'}
				<QrCode value={enrollLink} />
			{:else if current === 'large-260'}
				<QrCode value={enrollLink} size={260} caption="Pairing code at 260px" />
			{:else if current === 'rotate-long-url'}
				<QrCode value={rotateLink} size={220} caption="Rotate key on Pixel 6a · Desk" />
			{:else if current === 'captionless'}
				<QrCode value={enrollLink} size={200} caption="" />
			{:else}
				<QrCode value="" size={200} />
			{/if}
		</div>
	{/key}
</StateSwitcher>

<style>
	.qr-cell {
		display: grid;
		place-items: center;
		padding: var(--df-p-space-5);
	}
</style>
