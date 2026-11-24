<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { onDestroy } from 'svelte';
	import DeviceDetail from '$lib/components/DeviceDetail.svelte';
	import type { Device } from '$lib/types';
	import StateSwitcher from './StateSwitcher.svelte';
	import { syncWorkbenchShell } from './stub';
	import { driveDeviceDetailState } from './drive';
	import { DEVICE_DETAIL_GROUPS, type DeviceDetailStateKey } from './fixtures';

	let {
		data
	}: {
		data: {
			state: DeviceDetailStateKey;
			role: 'owner' | 'member';
			deviceId: string;
			device: Device | null;
			deviceLabels: Record<string, string>;
		};
	} = $props();

	let stageEl = $state<HTMLElement | null>(null);

	if (typeof window !== 'undefined') {
		const origShowModal = HTMLDialogElement.prototype.showModal;
		const origShow = HTMLDialogElement.prototype.show;
		const patchedShowModal = function (this: HTMLDialogElement) {
			if (!this.closest('[data-device-detail-stage]')) {
				return origShowModal.call(this);
			}
			return origShow.call(this);
		};
		HTMLDialogElement.prototype.showModal = patchedShowModal;
		onDestroy(() => {
			if (HTMLDialogElement.prototype.showModal === patchedShowModal) {
				HTMLDialogElement.prototype.showModal = origShowModal;
			}
		});
	}

	function selectState(next: string): void {
		const target = `${resolve('/states/device-detail')}?__state=${encodeURIComponent(next)}`;
		void goto(target, { replace: true, reset: false });
	}

	$effect(() => {
		void syncWorkbenchShell(`device-detail:${data.state}`, data.role);
	});

	$effect(() => {
		const currentState = data.state;
		const el = stageEl;
		if (!el) return;
		const controller = new AbortController();
		void driveDeviceDetailState(el, currentState, controller.signal);
		return () => controller.abort();
	});
</script>

<StateSwitcher groups={DEVICE_DETAIL_GROUPS} current={data.state} onchange={selectState}>
	<div class="drawer-frame" bind:this={stageEl} data-device-detail-stage>
		{#key data.state}
			<DeviceDetail
				open={true}
				deviceId={data.deviceId}
				device={data.device}
				deviceLabels={data.deviceLabels}
				canWrite={data.role === 'owner'}
				onclose={() => {}}
				onmint={() => {}}
			/>
		{/key}
	</div>
</StateSwitcher>

<style>
	:global(body:has([data-device-detail-stage])) {
		overflow: auto !important;
	}

	.drawer-frame {
		position: relative;
		width: 100%;
		height: min(820px, calc(100dvh - 48px));
		overflow: hidden;
		border-radius: var(--df-p-radius-xl) 0 0 var(--df-p-radius-xl);
		box-shadow: var(--df-shadow-dialog);
	}

	.drawer-frame :global(> dialog.drawer) {
		position: relative;
		inset: auto;
		width: 100%;
		max-width: 100%;
		height: 100%;
		max-height: 100%;
		opacity: 1;
		translate: 0 0;
	}

	.drawer-frame:has(:global(> dialog.dialog[open]))::after {
		content: '';
		position: absolute;
		inset: 0;
		z-index: 15;
		background: var(--df-c-dialog-scrim);
		backdrop-filter: blur(2px);
	}

	.drawer-frame :global(> dialog.dialog[open]) {
		position: absolute;
		inset: 0;
		margin: auto;
		height: fit-content;
		max-width: calc(100% - 32px);
		z-index: 20;
	}

	@media (max-width: 620px) {
		.drawer-frame {
			border-radius: 0;
			height: min(760px, calc(100dvh - 112px));
		}
	}
</style>
