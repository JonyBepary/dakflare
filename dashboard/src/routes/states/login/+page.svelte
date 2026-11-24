<script lang="ts">
	import { onDestroy } from 'svelte';
	import { beforeNavigate, goto } from '$app/navigation';
	import { page } from '$app/state';
	import LoginPage from '../../login/+page.svelte';
	import StateSwitcher from './StateSwitcher.svelte';
	import {
		DEFAULT_LOGIN_STATE,
		LOGIN_GROUPS,
		LOGIN_ROUTE_PARAM_KEYS,
		LOGIN_SCENARIOS,
		isLoginStateKey,
		type LoginAction,
		type LoginStateKey
	} from './fixtures';
	import { markLoginWorkbenchMounted, restoreLoginGlobals } from './stub';

	markLoginWorkbenchMounted();

	let { data }: { data: { state: LoginStateKey } } = $props();
	const current = $derived(data.state);

	let stageEl = $state<HTMLDivElement | null>(null);

	function paramsMatch(
		searchParams: Pick<URLSearchParams, 'get' | 'has'>,
		expected: Record<string, string>
	): boolean {
		for (const [k, v] of Object.entries(expected)) {
			if (searchParams.get(k) !== v) return false;
		}
		for (const k of LOGIN_ROUTE_PARAM_KEYS) {
			if (!Object.hasOwn(expected, k) && searchParams.has(k)) return false;
		}
		return true;
	}

	const paramsReady = $derived(
		paramsMatch(page.url.searchParams, LOGIN_SCENARIOS[current].routeParams)
	);

	beforeNavigate(({ cancel, to }) => {
		if (to && to.url.pathname !== page.url.pathname) {
			cancel();
		}
	});

	$effect(() => {
		const expected = LOGIN_SCENARIOS[current].routeParams;
		if (!paramsMatch(page.url.searchParams, expected)) {
			const url = new URL(page.url.href);
			for (const k of LOGIN_ROUTE_PARAM_KEYS) url.searchParams.delete(k);
			for (const [k, v] of Object.entries(expected)) url.searchParams.set(k, v);
			void goto(url, { replace: true, reset: false });
		}
	});

	async function waitFor<T>(getter: () => T | null, signal: AbortSignal): Promise<T | null> {
		for (let i = 0; i < 80; i += 1) {
			if (signal.aborted) return null;
			const found = getter();
			if (found !== null) return found;
			await new Promise<void>((resolve) => setTimeout(resolve, 16));
		}
		return null;
	}

	function findButtonByText(root: Element, selector: string, needle: string): HTMLButtonElement | null {
		const buttons = root.querySelectorAll<HTMLButtonElement>(selector);
		for (const btn of buttons) {
			if ((btn.textContent ?? '').includes(needle)) return btn;
		}
		return null;
	}

	async function clickDoor(root: Element, title: string, signal: AbortSignal): Promise<boolean> {
		const btn = await waitFor(
			() => findButtonByText(root, 'button.door', title),
			signal
		);
		if (!btn || signal.aborted) return false;
		btn.click();
		return true;
	}

	function fillInput(el: HTMLInputElement, value: string): void {
		el.value = value;
		el.dispatchEvent(new Event('input', { bubbles: true }));
	}

	async function clickSubmit(root: Element, signal: AbortSignal): Promise<void> {
		const btn = await waitFor(() => {
			const candidate = root.querySelector<HTMLButtonElement>('form button[type="submit"]');
			return candidate && !candidate.disabled ? candidate : null;
		}, signal);
		if (!btn || signal.aborted) return;
		btn.click();
	}

	async function driveLogin(action: LoginAction, signal: AbortSignal): Promise<void> {
		if (action === 'none' || !stageEl) return;
		const root = stageEl;

		if (action === 'click-door-passkey') {
			await clickDoor(root, 'Passkey', signal);
			return;
		}
		if (action === 'click-door-password') {
			await clickDoor(root, 'Password', signal);
			return;
		}
		if (action === 'click-door-magic') {
			await clickDoor(root, 'Email link', signal);
			return;
		}
		if (action === 'click-fallback-password') {
			const btn = await waitFor(
				() => findButtonByText(root, '.login-alt button', 'Use a password instead'),
				signal
			);
			if (!btn || signal.aborted) return;
			btn.click();
			return;
		}
		if (action === 'submit-password') {
			if (!(await clickDoor(root, 'Password', signal))) return;
			const email = await waitFor(() => root.querySelector<HTMLInputElement>('#pw-email'), signal);
			const secret = await waitFor(() => root.querySelector<HTMLInputElement>('#pw-secret'), signal);
			if (!email || !secret || signal.aborted) return;
			fillInput(email, 'jony@example.com');
			fillInput(secret, 'correct-horse-battery-staple');
			await clickSubmit(root, signal);
			return;
		}
		if (action === 'submit-magic') {
			if (!(await clickDoor(root, 'Email link', signal))) return;
			const email = await waitFor(() => root.querySelector<HTMLInputElement>('#ml-email'), signal);
			if (!email || signal.aborted) return;
			fillInput(email, 'jony@example.com');
			await clickSubmit(root, signal);
			return;
		}
		if (action === 'submit-totp' || action === 'open-recovery') {
			if (!(await clickDoor(root, 'Passkey', signal))) return;
			const code = await waitFor(
				() => root.querySelector<HTMLInputElement>('#second-factor'),
				signal
			);
			if (!code || signal.aborted) return;
			if (action === 'open-recovery') {
				const alt = await waitFor(
					() => findButtonByText(root, 'button.login-alternate', 'Use a recovery code instead'),
					signal
				);
				if (!alt || signal.aborted) return;
				alt.click();
				return;
			}
			fillInput(code, '482910');
			await clickSubmit(root, signal);
			return;
		}
		if (action === 'submit-legacy-token') {
			const tokenInput = await waitFor(
				() => root.querySelector<HTMLInputElement>('#admin-token'),
				signal
			);
			if (!tokenInput || signal.aborted) return;
			fillInput(tokenInput, 'dak_tok_demo_9f3c2a1b4e7d8c0a');
			await clickSubmit(root, signal);
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
		void driveLogin(LOGIN_SCENARIOS[key].action, controller.signal);
		return () => {
			controller.abort();
		};
	});

	onDestroy(() => {
		driveController?.abort();
		restoreLoginGlobals();
	});

	function selectState(next: string): void {
		const targetKey = isLoginStateKey(next) ? next : DEFAULT_LOGIN_STATE;
		const expected = LOGIN_SCENARIOS[targetKey].routeParams;
		const url = new URL(page.url.href);
		for (const k of LOGIN_ROUTE_PARAM_KEYS) url.searchParams.delete(k);
		url.searchParams.set('__state', targetKey);
		for (const [k, v] of Object.entries(expected)) url.searchParams.set(k, v);
		void goto(url, { replace: true, reset: false });
	}
</script>

<svelte:head>
	<title>Login · State workbench</title>
</svelte:head>

<StateSwitcher groups={LOGIN_GROUPS} {current} onchange={selectState}>
	<div bind:this={stageEl}>
		{#if paramsReady}
			{#key current}
				<LoginPage />
			{/key}
		{/if}
	</div>
</StateSwitcher>
