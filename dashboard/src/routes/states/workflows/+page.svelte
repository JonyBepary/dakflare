<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { onDestroy } from 'svelte';
	import WorkflowsPage from '../../workflows/+page.svelte';
	import StateSwitcher from './StateSwitcher.svelte';
	import { driveWorkflowsState } from './drive';
	import { syncWorkbenchShell } from './stub';
	import { WORKFLOWS_GROUPS, type WorkflowsStateKey } from './fixtures';

	let { data }: { data: { state: WorkflowsStateKey } } = $props();
	let stageEl = $state<HTMLElement | null>(null);

	if (typeof window !== 'undefined') {
		const origShowModal = HTMLDialogElement.prototype.showModal;
		const origShow = HTMLDialogElement.prototype.show;
		const patchedShowModal = function (this: HTMLDialogElement) {
			if (!this.closest('[data-workflows-stage]')) {
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
		const target = `${resolve('/states/workflows')}?__state=${encodeURIComponent(next)}`;
		void goto(target, { replace: true, reset: false });
	}

	$effect(() => {
		const expectedRole = data.state === 'member-session' ? 'member' : 'owner';
		void syncWorkbenchShell(`workflows:${data.state}`, expectedRole);
	});

	$effect(() => {
		const currentState = data.state;
		const el = stageEl;
		if (!el) return;
		const controller = new AbortController();
		void driveWorkflowsState(el, currentState, controller.signal);
		return () => controller.abort();
	});
</script>

<StateSwitcher groups={WORKFLOWS_GROUPS} current={data.state} onchange={selectState}>
	<div class="workflows-stage" bind:this={stageEl} data-workflows-stage>
		{#key data.state}
			<WorkflowsPage />
		{/key}
	</div>
</StateSwitcher>

<style>
	.workflows-stage:has(:global(> dialog.dialog[open]))::after {
		content: '';
		position: fixed;
		inset: 0;
		z-index: 20;
		background: var(--df-c-dialog-scrim);
		backdrop-filter: blur(2px);
	}

	.workflows-stage :global(> dialog.dialog[open]) {
		position: fixed;
		inset: 0;
		margin: auto;
		height: fit-content;
		z-index: 25;
	}
</style>
