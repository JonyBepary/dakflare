<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { tick, untrack } from 'svelte';
	import MessagesPage from '../../messages/+page.svelte';
	import StateSwitcher, { type StateGroup } from './StateSwitcher.svelte';
	import { syncWorkbenchShell } from './stub';
	import type { MessagesStateKey } from './+page';

	let { data }: { data: { state: MessagesStateKey } } = $props();

	const GROUPS: ReadonlyArray<StateGroup> = [
		{
			heading: 'Data',
			states: [
				{ key: 'loading', label: 'Loading fleet & log' },
				{ key: 'no-devices', label: 'No devices paired' },
				{ key: 'empty', label: 'Empty message log' },
				{ key: 'populated-mixed', label: 'Mixed inbound & outbound' },
				{ key: 'channels-conversations', label: 'Two channels & a conversation' },
				{ key: 'pagination-stalled', label: 'Cursor tie (Load older)' },
				{ key: 'load-error', label: 'Log unreachable' }
			]
		},
		{
			heading: 'Replies & Fleet',
			states: [
				{ key: 'failed-rule-reply', label: 'Failed auto-reply link' },
				{ key: 'revoked-device', label: 'Revoked handset history' },
				{ key: 'compose-open', label: 'Compose drawer open' }
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
		// See the overview workbench: tracking the session reads loops the sign-in.
		void untrack(() => syncWorkbenchShell(`messages:${current}`, expectedRole));
	});

	$effect(() => {
		const targetState = current;
		if (targetState !== 'compose-open' && targetState !== 'pagination-stalled') return;
		let cancelled = false;
		let composeClicked = false;
		const blurComposeInput = () => {
			if (cancelled) return;
			const active = document.activeElement;
			if (active instanceof HTMLElement && active.closest('#compose-panel')) {
				active.blur();
			}
		};
		const timer = setInterval(() => {
			if (cancelled || !stageEl) return;
			if (targetState === 'compose-open') {
				const composePanel = stageEl.querySelector('#compose-panel');
				if (composePanel) {
					blurComposeInput();
					clearInterval(timer);
					return;
				}
				if (composeClicked) return;
				const btn = [...stageEl.querySelectorAll<HTMLButtonElement>('button')].find(
					(b) => !b.disabled && b.textContent?.includes('Compose')
				);
				if (btn) {
					composeClicked = true;
					btn.click();
					// `SendSmsForm` focuses `#send-to-*` asynchronously via `tick()`; blur after
					// two ticks so Arrow keys and `H` still drive the workbench switcher.
					void tick()
						.then(() => tick())
						.then(() => {
							blurComposeInput();
							if (stageEl?.querySelector('#compose-panel')) {
								clearInterval(timer);
							}
						});
				}
			} else if (targetState === 'pagination-stalled') {
				const btn = [...stageEl.querySelectorAll<HTMLButtonElement>('button')].find(
					(b) => !b.disabled && b.textContent?.includes('Load older')
				);
				if (btn) {
					btn.click();
					clearInterval(timer);
				}
			}
		}, 60);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
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
	<title>Messages · State workbench</title>
</svelte:head>

<StateSwitcher groups={GROUPS} {current} onchange={selectState}>
	<div bind:this={stageEl}>
		{#key current}
			<MessagesPage />
		{/key}
	</div>
</StateSwitcher>
