<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import RulesPage from '../../rules/+page.svelte';
	import StateSwitcher, { type StateGroup } from './StateSwitcher.svelte';
	import { syncWorkbenchShell } from './stub';
	import type { RulesStateKey } from './+page';

	let { data }: { data: { state: RulesStateKey } } = $props();

	const GROUPS: ReadonlyArray<StateGroup> = [
		{
			heading: 'Data',
			states: [
				{ key: 'loading', label: 'Loading rules' },
				{ key: 'empty', label: 'No rules yet' },
				{ key: 'populated-active-and-paused', label: 'Active & paused rules' },
				{ key: 'long-reply-clamped', label: 'Long reply toggle' },
				{ key: 'load-error', label: 'Rules read failed' }
			]
		},
		{
			heading: 'Authoring & Test',
			states: [
				{ key: 'editor-new', label: 'New rule editor' },
				{ key: 'editor-edit', label: 'Edit existing rule' },
				{ key: 'test-panel-matched', label: 'Dry-run matched reply' },
				{ key: 'test-panel-blocked', label: 'Dry-run blocked/shortcode' }
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
		void syncWorkbenchShell(`rules:${current}`, expectedRole);
	});

	function setInput(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
		el.value = value;
		el.dispatchEvent(new Event('input', { bubbles: true }));
	}

	$effect(() => {
		const targetState = current;
		if (
			targetState !== 'editor-new' &&
			targetState !== 'editor-edit' &&
			targetState !== 'test-panel-matched' &&
			targetState !== 'test-panel-blocked'
		) {
			return;
		}
		let acted = false;
		const timer = setInterval(() => {
			if (!stageEl) return;
			if (targetState === 'editor-new') {
				if (stageEl.querySelector('#rule-form')) {
					clearInterval(timer);
					return;
				}
				const btn = [...stageEl.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
					b.textContent?.includes('New rule')
				);
				if (btn) {
					btn.click();
					clearInterval(timer);
				}
			} else if (targetState === 'editor-edit') {
				if (stageEl.querySelector('#rule-form')) {
					clearInterval(timer);
					return;
				}
				const btn = stageEl.querySelector<HTMLButtonElement>('button[aria-label^="Edit rule"]');
				if (btn) {
					btn.click();
					clearInterval(timer);
				}
			} else {
				const panel = stageEl.querySelector('#rule-test-panel');
				if (!panel) {
					const btn = stageEl.querySelector<HTMLButtonElement>('button[aria-label^="Test rule"]');
					if (btn) btn.click();
					return;
				}
				if (!acted) {
					const peerInput = panel.querySelector<HTMLInputElement>('input[id^="test-peer-"]');
					const bodyInput = panel.querySelector<HTMLTextAreaElement>('textarea[id^="test-body-"]');
					const runBtn = [...panel.querySelectorAll<HTMLButtonElement>('button[type="submit"]')][0];
					if (peerInput && bodyInput && runBtn) {
						setInput(peerInput, targetState === 'test-panel-matched' ? '+8801711420819' : '22001');
						setInput(bodyInput, targetState === 'test-panel-matched' ? 'STOP' : 'hello');
						acted = true;
						runBtn.click();
						clearInterval(timer);
					}
				}
			}
		}, 60);
		return () => clearInterval(timer);
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
	<title>Rules · State workbench</title>
</svelte:head>

<StateSwitcher groups={GROUPS} {current} onchange={selectState}>
	<div bind:this={stageEl}>
		{#key current}
			<RulesPage />
		{/key}
	</div>
</StateSwitcher>
