<script lang="ts">
	import { onDestroy } from 'svelte';
	import { beforeNavigate, goto } from '$app/navigation';
	import { page } from '$app/state';
	import MagicPage from '../../magic/+page.svelte';
	import StateSwitcher from './StateSwitcher.svelte';
	import {
		DEFAULT_MAGIC_STATE,
		MAGIC_GROUPS,
		MAGIC_ROUTE_PARAM_KEYS,
		MAGIC_SCENARIOS,
		isMagicStateKey,
		type MagicStateKey
	} from './fixtures';
	import { markMagicWorkbenchMounted } from './stub';

	markMagicWorkbenchMounted();

	let { data }: { data: { state: MagicStateKey } } = $props();
	const current = $derived(data.state);

	let stageEl = $state<HTMLDivElement | null>(null);

	function paramsMatch(
		searchParams: Pick<URLSearchParams, 'get' | 'has'>,
		expected: Record<string, string>
	): boolean {
		for (const [k, v] of Object.entries(expected)) {
			if (searchParams.get(k) !== v) return false;
		}
		for (const k of MAGIC_ROUTE_PARAM_KEYS) {
			if (!Object.hasOwn(expected, k) && searchParams.has(k)) return false;
		}
		return true;
	}

	const paramsReady = $derived(
		paramsMatch(page.url.searchParams, MAGIC_SCENARIOS[current].routeParams)
	);

	beforeNavigate(({ cancel, to }) => {
		if (to && to.url.pathname !== page.url.pathname) {
			cancel();
		}
	});

	$effect(() => {
		const expected = MAGIC_SCENARIOS[current].routeParams;
		if (!paramsMatch(page.url.searchParams, expected)) {
			const url = new URL(page.url.href);
			for (const k of MAGIC_ROUTE_PARAM_KEYS) url.searchParams.delete(k);
			for (const [k, v] of Object.entries(expected)) url.searchParams.set(k, v);
			void goto(url, { replace: true, reset: false });
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

	async function driveMagic(clickSignIn: boolean, signal: AbortSignal): Promise<void> {
		if (!clickSignIn || !stageEl) return;
		const btn = await waitForSelector<HTMLButtonElement>(stageEl, 'button.gate-submit', signal);
		if (!btn || signal.aborted) return;
		btn.click();
	}

	let driveController: AbortController | null = null;

	$effect(() => {
		const key = current;
		const ready = paramsReady;
		const root = stageEl;
		driveController?.abort();
		if (!ready || !root) return;
		const controller = new AbortController();
		driveController = controller;
		void driveMagic(MAGIC_SCENARIOS[key].clickSignIn, controller.signal);
		return () => {
			controller.abort();
		};
	});

	onDestroy(() => {
		driveController?.abort();
	});

	function selectState(next: string): void {
		const targetKey = isMagicStateKey(next) ? next : DEFAULT_MAGIC_STATE;
		const expected = MAGIC_SCENARIOS[targetKey].routeParams;
		const url = new URL(page.url.href);
		for (const k of MAGIC_ROUTE_PARAM_KEYS) url.searchParams.delete(k);
		url.searchParams.set('__state', targetKey);
		for (const [k, v] of Object.entries(expected)) url.searchParams.set(k, v);
		void goto(url, { replace: true, reset: false });
	}
</script>

<svelte:head>
	<title>Magic link · State workbench</title>
</svelte:head>

<StateSwitcher groups={MAGIC_GROUPS} {current} onchange={selectState}>
	<div bind:this={stageEl}>
		{#if paramsReady}
			{#key current}
				<MagicPage />
			{/key}
		{/if}
	</div>
</StateSwitcher>
