<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import DevicesPage from '../../devices/+page.svelte';
	import StateSwitcher, { type StateGroup } from './StateSwitcher.svelte';
	import { syncWorkbenchShell } from './stub';
	import type { DevicesStateKey } from './+page';

	let { data }: { data: { state: DevicesStateKey } } = $props();

	const GROUPS: ReadonlyArray<StateGroup> = [
		{
			heading: 'Fleet',
			states: [
				{ key: 'loading', label: 'Loading fleet' },
				{ key: 'empty', label: 'No devices paired' },
				{ key: 'fleet-healthy', label: 'Live & synced fleet' },
				{ key: 'fleet-degraded-offline', label: 'Stale & never contacted' },
				{ key: 'with-archived-and-revoked', label: 'Archived & revoked rows' },
				{ key: 'load-error', label: 'Fleet offline error' }
			]
		},
		{
			heading: 'Pairing',
			states: [
				{ key: 'mint-open-enroll', label: 'Mint form open' },
				{ key: 'mint-waiting-qr', label: 'Waiting with QR code' },
				{ key: 'mint-paired', label: 'Pairing complete' },
				{ key: 'mint-expired', label: 'Code expired' }
			]
		},
		{
			heading: 'Session',
			states: [{ key: 'member-session', label: 'Member session (read-only)' }]
		}
	];

	const current = $derived(data.state);
	let stageEl = $state<HTMLDivElement | null>(null);

	$effect(() => {
		const expectedRole = current === 'member-session' ? 'member' : 'owner';
		void syncWorkbenchShell(`devices:${current}`, expectedRole);
	});

	$effect(() => {
		const targetState = current;
		const needsClick =
			targetState === 'with-archived-and-revoked' ||
			targetState === 'mint-open-enroll' ||
			targetState === 'mint-waiting-qr' ||
			targetState === 'mint-paired' ||
			targetState === 'mint-expired';
		if (!needsClick) return;

		let submittedMint = false;
		let checkedPair = false;
		let showedArchived = false;

		const timer = setInterval(() => {
			if (!stageEl) return;

			if (targetState === 'with-archived-and-revoked') {
				if (showedArchived) {
					clearInterval(timer);
					return;
				}
				const toggle = stageEl.querySelector<HTMLInputElement>('input[type="checkbox"]');
				if (toggle) {
					if (!toggle.checked) toggle.click();
					showedArchived = true;
					clearInterval(timer);
				}
				return;
			}

			const mintPanel = stageEl.querySelector('#mint-panel');
			if (!mintPanel) {
				const openBtn = [...stageEl.querySelectorAll<HTMLButtonElement>('button')].find(
					(b) => b.textContent?.includes('Mint') && b.textContent?.includes('code')
				);
				openBtn?.click();
				return;
			}

			if (targetState === 'mint-open-enroll') {
				clearInterval(timer);
				return;
			}

			if (!submittedMint) {
				const submitBtn = mintPanel.querySelector<HTMLButtonElement>('button[type="submit"]');
				if (submitBtn && !submitBtn.disabled) {
					submittedMint = true;
					submitBtn.click();
					if (targetState === 'mint-waiting-qr' || targetState === 'mint-expired') {
						clearInterval(timer);
					}
				}
				return;
			}

			if (targetState === 'mint-paired') {
				if (stageEl.querySelector('.pair-state-ok')) {
					clearInterval(timer);
					return;
				}
				if (!checkedPair) {
					const checkBtn = [...mintPanel.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
						b.textContent?.includes('Check now')
					);
					if (checkBtn) {
						checkedPair = true;
						checkBtn.click();
						clearInterval(timer);
					}
				}
			}
		}, 60);

		return () => clearInterval(timer);
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
	<title>Devices · State workbench</title>
</svelte:head>

<StateSwitcher groups={GROUPS} {current} onchange={selectState}>
	<div bind:this={stageEl}>
		{#key current}
			<DevicesPage />
		{/key}
	</div>
</StateSwitcher>
