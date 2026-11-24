<script lang="ts">
	import { onDestroy } from 'svelte';
	import { beforeNavigate, goto } from '$app/navigation';
	import { page } from '$app/state';
	import InvitePage from '../../invite/+page.svelte';
	import StateSwitcher from './StateSwitcher.svelte';
	import {
		DEFAULT_INVITE_STATE,
		INVITE_GROUPS,
		INVITE_ROUTE_PARAM_KEYS,
		INVITE_SCENARIOS,
		SAMPLE_INVITE_TOKEN,
		isInviteStateKey,
		type InviteAction,
		type InviteStateKey
	} from './fixtures';
	import { markInviteWorkbenchMounted } from './stub';

	markInviteWorkbenchMounted();

	let { data }: { data: { state: InviteStateKey } } = $props();
	const current = $derived(data.state);

	let stageEl = $state<HTMLDivElement | null>(null);

	function paramsMatch(
		searchParams: Pick<URLSearchParams, 'get' | 'has'>,
		expected: Record<string, string>
	): boolean {
		for (const [k, v] of Object.entries(expected)) {
			if (searchParams.get(k) !== v) return false;
		}
		for (const k of INVITE_ROUTE_PARAM_KEYS) {
			if (!Object.hasOwn(expected, k) && searchParams.has(k)) return false;
		}
		return true;
	}

	const paramsReady = $derived(
		paramsMatch(page.url.searchParams, INVITE_SCENARIOS[current].routeParams)
	);

	beforeNavigate(({ cancel, to }) => {
		if (to && to.url.pathname !== page.url.pathname) {
			cancel();
		}
	});

	$effect(() => {
		const expected = INVITE_SCENARIOS[current].routeParams;
		if (!paramsMatch(page.url.searchParams, expected)) {
			const url = new URL(page.url.href);
			for (const k of INVITE_ROUTE_PARAM_KEYS) url.searchParams.delete(k);
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

	async function driveInvite(action: InviteAction, signal: AbortSignal): Promise<void> {
		if (action === 'none' || !stageEl) return;
		const input = await waitForSelector<HTMLInputElement>(stageEl, '#invite-code', signal);
		if (!input || signal.aborted) return;
		input.value = SAMPLE_INVITE_TOKEN;
		input.dispatchEvent(new Event('input', { bubbles: true }));
		if (action === 'fill-only' || signal.aborted) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 16));
		if (signal.aborted) return;
		const form = stageEl.querySelector<HTMLFormElement>('form');
		if (!form) return;
		const submitBtn = form.querySelector<HTMLButtonElement>('button[type="submit"]');
		if (submitBtn && !submitBtn.disabled) {
			submitBtn.click();
		}
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
		void driveInvite(INVITE_SCENARIOS[key].action, controller.signal);
		return () => {
			controller.abort();
		};
	});

	onDestroy(() => {
		driveController?.abort();
	});

	function selectState(next: string): void {
		const targetKey = isInviteStateKey(next) ? next : DEFAULT_INVITE_STATE;
		const expected = INVITE_SCENARIOS[targetKey].routeParams;
		const url = new URL(page.url.href);
		for (const k of INVITE_ROUTE_PARAM_KEYS) url.searchParams.delete(k);
		url.searchParams.set('__state', targetKey);
		for (const [k, v] of Object.entries(expected)) url.searchParams.set(k, v);
		void goto(url, { replace: true, reset: false });
	}
</script>

<svelte:head>
	<title>Invite · State workbench</title>
</svelte:head>

<StateSwitcher groups={INVITE_GROUPS} {current} onchange={selectState}>
	<div bind:this={stageEl}>
		{#if paramsReady}
			{#key current}
				<InvitePage />
			{/key}
		{/if}
	</div>
</StateSwitcher>
