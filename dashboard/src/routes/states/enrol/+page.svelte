<script lang="ts">
	import { onDestroy } from 'svelte';
	import { beforeNavigate, goto } from '$app/navigation';
	import { page } from '$app/state';
	import EnrolPage from '../../enrol/+page.svelte';
	import StateSwitcher from './StateSwitcher.svelte';
	import {
		DEFAULT_ENROL_STATE,
		ENROL_GROUPS,
		ENROL_SCENARIOS,
		isEnrolStateKey,
		type EnrolStateKey
	} from './fixtures';
	import { restoreEnrolGlobals } from './stub';

	let { data }: { data: { state: EnrolStateKey } } = $props();
	const current = $derived(data.state);

	let stageEl = $state<HTMLDivElement | null>(null);

	beforeNavigate(({ cancel, to }) => {
		if (to && to.url.pathname !== page.url.pathname) {
			cancel();
		}
	});

	async function waitForSelector<T extends Element>(
		root: Element,
		selector: string,
		signal: AbortSignal
	): Promise<T | null> {
		for (let i = 0; i < 60; i += 1) {
			if (signal.aborted) return null;
			const found = root.querySelector<T>(selector);
			if (found) return found;
			await new Promise<void>((resolve) => setTimeout(resolve, 16));
		}
		return null;
	}

	async function driveEnrol(submitCreate: boolean, signal: AbortSignal): Promise<void> {
		if (!submitCreate || !stageEl) return;
		const submitBtn = await waitForSelector<HTMLButtonElement>(
			stageEl,
			'form button[type="submit"]',
			signal
		);
		if (!submitBtn || signal.aborted) return;
		submitBtn.click();
	}

	let driveController: AbortController | null = null;

	$effect(() => {
		const key = current;
		const root = stageEl;
		driveController?.abort();
		if (!root) return;
		const controller = new AbortController();
		driveController = controller;
		void driveEnrol(ENROL_SCENARIOS[key].submitCreate, controller.signal);
		return () => {
			controller.abort();
		};
	});

	onDestroy(() => {
		driveController?.abort();
		restoreEnrolGlobals();
	});

	function selectState(next: string): void {
		const targetKey = isEnrolStateKey(next) ? next : DEFAULT_ENROL_STATE;
		const url = new URL(page.url.href);
		url.searchParams.set('__state', targetKey);
		void goto(url, { replace: true, reset: false });
	}
</script>

<svelte:head>
	<title>Enrol · State workbench</title>
</svelte:head>

<StateSwitcher groups={ENROL_GROUPS} {current} onchange={selectState}>
	<div bind:this={stageEl}>
		{#key current}
			<EnrolPage />
		{/key}
	</div>
</StateSwitcher>
