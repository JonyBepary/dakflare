<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { onDestroy, tick, untrack } from 'svelte';
	import WorkflowEditor from '$lib/components/workflow/WorkflowEditor.svelte';
	import StateSwitcher from './StateSwitcher.svelte';
	import { driveWorkflowEditState } from './drive';
	import {
		isWorkflowEditState,
		scenarioFor,
		syncEditorStorage,
		WORKFLOW_EDIT_GROUPS,
		type WorkflowEditStateKey
	} from './fixtures';
	import { installStub, syncWorkbenchShell } from './stub';

	let { data }: { data: { state: WorkflowEditStateKey } } = $props();
	let activeState = $state<WorkflowEditStateKey | null>(untrack(() => data.state));
	let stageEl = $state<HTMLElement | null>(null);

	$effect(() => {
		activeState = data.state;
	});

	$effect(() => {
		const state = activeState;
		if (state === null) return;
		const expectedRole = scenarioFor(state).role ?? 'owner';
		void syncWorkbenchShell(`workflows-edit:${state}`, expectedRole);
	});

	if (typeof window !== 'undefined') {
		const origShowModal = HTMLDialogElement.prototype.showModal;
		const origShow = HTMLDialogElement.prototype.show;
		const patchedShowModal = function (this: HTMLDialogElement) {
			if (!this.closest('[data-workflows-edit-stage]')) {
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

	async function selectState(next: string): Promise<void> {
		if (!isWorkflowEditState(next) || next === activeState) return;
		syncEditorStorage(next);
		installStub(scenarioFor(next));
		// Unmount WorkflowEditor first so its beforeNavigate dirty guard does not block switching.
		activeState = null;
		await tick();
		const target = `${resolve('/states/workflows-edit')}?__state=${encodeURIComponent(next)}`;
		await goto(target, { replace: true, reset: false });
		if (activeState === null) activeState = data.state;
	}

	$effect(() => {
		const currentState = activeState;
		const el = stageEl;
		if (!currentState || !el) return;
		const controller = new AbortController();
		void driveWorkflowEditState(el, scenarioFor(currentState), controller.signal);
		return () => controller.abort();
	});
</script>

<StateSwitcher
	groups={WORKFLOW_EDIT_GROUPS}
	current={activeState ?? data.state}
	onchange={(next) => void selectState(next)}
>
	<div class="workflow-edit-stage" bind:this={stageEl} data-workflows-edit-stage>
		{#if activeState !== null}
			{#key activeState}
				<WorkflowEditor id={scenarioFor(activeState).id} />
			{/key}
		{/if}
	</div>
</StateSwitcher>

<style>
	.workflow-edit-stage:has(:global(dialog.dialog[open]))::after,
	.workflow-edit-stage:has(:global(dialog.sheet-dialog[open]))::after {
		content: '';
		position: fixed;
		inset: 0;
		z-index: 20;
		background: var(--df-c-dialog-scrim);
		backdrop-filter: blur(2px);
	}

	.workflow-edit-stage :global(dialog.dialog[open]) {
		position: fixed;
		inset: 0;
		margin: auto;
		height: fit-content;
		z-index: 25;
	}

	.workflow-edit-stage :global(dialog.sheet-dialog[open]) {
		position: fixed;
		inset: 0;
		z-index: 25;
	}
</style>
