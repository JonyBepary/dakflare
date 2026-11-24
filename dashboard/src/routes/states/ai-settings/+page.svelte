<script lang="ts">
	/**
	 * State workbench for the AI settings route — `/security/ai`.
	 *
	 * Not product UI and not a review: it renders the real page, unchanged, against
	 * the wire shapes it reads, and flips between every state its code can reach
	 * through `?__state=`.
	 *
	 * Every key renders from the stub (`stub.ts` + `scenarios.ts`) and never from
	 * the network: `/admin/states/ai-settings?__state=<key>`.
	 */
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { tick, untrack } from 'svelte';
	import { session } from '$lib/session.svelte';
	import AiSettingsPage from '../../security/ai/+page.svelte';
	import StateSwitcher, { type StateGroup } from './StateSwitcher.svelte';
	import { drive } from './drive';
	import { isStateKey, SCENARIOS, STATE_GROUPS, type StateKey } from './scenarios';

	let { data }: { data: { state: StateKey } } = $props();

	const GROUPS: ReadonlyArray<StateGroup> = STATE_GROUPS.map((group) => ({
		heading: group.label,
		states: group.states.map((entry) => ({
			key: entry.key,
			label: entry.label,
			title: entry.key
		}))
	}));

	const current = $derived(data.state);

	let sessionReady = $state(
		typeof window === 'undefined' ||
			(session.status === 'authed' && session.role === SCENARIOS[untrack(() => data.state)].session)
	);
	let driveVersion = 0;

	$effect(() => {
		const stateKey = current;
		const wantedRole = SCENARIOS[stateKey].session;
		const controller = new AbortController();
		const version = ++driveVersion;

		void (async () => {
			if (session.status !== 'authed' || session.role !== wantedRole) {
				sessionReady = false;
				await session.check();
				if (controller.signal.aborted || version !== driveVersion) return;
			}
			sessionReady = true;
			await tick();
			if (controller.signal.aborted || version !== driveVersion) return;
			await drive(SCENARIOS[stateKey].act, controller.signal);
		})();

		return () => {
			controller.abort();
		};
	});

	function selectState(next: string): void {
		if (!isStateKey(next) || next === current) return;
		const url = new URL(page.url.href);
		url.searchParams.set('__state', next);
		void goto(`${url.pathname}?${url.searchParams.toString()}`, {
			reset: false
		});
	}
</script>

<svelte:head>
	<title>AI settings · State workbench</title>
</svelte:head>

<StateSwitcher groups={GROUPS} {current} onchange={selectState}>
	{#if sessionReady}
		{#key current}
			<AiSettingsPage />
		{/key}
	{/if}
</StateSwitcher>
