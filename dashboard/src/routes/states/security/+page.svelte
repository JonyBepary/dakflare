<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { onDestroy } from 'svelte';
	import SecurityPage from '../../security/+page.svelte';
	import StateSwitcher from './StateSwitcher.svelte';
	import { driveSecurityState } from './drive';
	import { SECURITY_GROUPS, type SecurityStateKey } from './fixtures';

	let { data }: { data: { state: SecurityStateKey } } = $props();
	let stageEl = $state<HTMLElement | null>(null);

	if (typeof window !== 'undefined') {
		const origShowModal = HTMLDialogElement.prototype.showModal;
		const origShow = HTMLDialogElement.prototype.show;
		const patchedShowModal = function (this: HTMLDialogElement) {
			if (!this.closest('[data-security-stage]')) {
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
		const target = `${resolve('/states/security')}?__state=${encodeURIComponent(next)}`;
		void goto(target, { replace: true, reset: false });
	}

	$effect(() => {
		const currentState = data.state;
		const el = stageEl;
		if (!el) return;
		const controller = new AbortController();
		void driveSecurityState(el, currentState, controller.signal);
		return () => controller.abort();
	});
</script>

<StateSwitcher groups={SECURITY_GROUPS} current={data.state} onchange={selectState}>
	<div class="security-stage" bind:this={stageEl} data-security-stage>
		{#key data.state}
			<SecurityPage />
		{/key}
	</div>
</StateSwitcher>

<style>
	.security-stage:has(:global(> dialog.dialog[open]))::after {
		content: '';
		position: fixed;
		inset: 0;
		z-index: 20;
		background: var(--df-c-dialog-scrim);
		backdrop-filter: blur(2px);
	}

	.security-stage :global(> dialog.dialog[open]) {
		position: fixed;
		inset: 0;
		margin: auto;
		height: fit-content;
		z-index: 25;
	}
</style>
