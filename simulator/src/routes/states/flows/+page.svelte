<script lang="ts">
	import { tick } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { app } from '$lib/stores/app.svelte';
	import FlowsPage from '../../flows/+page.svelte';
	import { ALL_KEYS, currentEpoch, currentRun, STATE_GROUPS } from './stub';

	let { data } = $props();

	let hidden = $state(false);
	let navEl = $state<HTMLElement | null>(null);
	let drivenRun = '';
	const current = $derived(data.state);

	$effect(() => {
		void current;
		void tick().then(() => {
			navEl
				?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')
				?.scrollIntoView({ block: 'nearest' });
		});
	});

	$effect(() => {
		const state = current;
		const ready = app.flowsLoaded && !app.loading.flows;
		const run = currentRun();
		const runId = `${run.state}:${run.epoch}`;
		if (!ready || run.state !== state || drivenRun === runId) return;
		const myEpoch = run.epoch;
		if (
			state !== 'syncing' &&
			state !== 'synced' &&
			state !== 'sync-failed-stale' &&
			state !== 'injecting' &&
			state !== 'injected' &&
			state !== 'polling' &&
			state !== 'cleared'
		) {
			return;
		}
		drivenRun = runId;
		void (async () => {
			await tick();
			if (myEpoch !== currentEpoch()) return;
			const stage = document.querySelector('.state-stage');
			if (!stage) return;
			const buttons = [...stage.querySelectorAll<HTMLButtonElement>('button')];
			if (state === 'syncing' || state === 'synced' || state === 'sync-failed-stale') {
				buttons.find((b) => b.textContent?.trim() === 'Sync now')?.click();
			} else if (state === 'injecting' || state === 'injected') {
				stage.querySelector<HTMLButtonElement>('button[type="submit"]')?.click();
			} else if (state === 'polling') {
				buttons.find((b) => b.textContent?.trim() === 'Poll outbox')?.click();
			} else if (state === 'cleared') {
				buttons.find((b) => b.textContent?.trim() === 'Clear thread')?.click();
			}
		})();
	});

	function selectState(next: string) {
		if (next === current) return;
		const nextUrl = new URL(page.url);
		nextUrl.searchParams.set('__state', next);
		void goto(`${nextUrl.pathname}?${nextUrl.searchParams.toString()}`, {
			replaceState: false,
			noScroll: true,
			keepFocus: true
		});
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.defaultPrevented) return;
		if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
		const target = event.target as HTMLElement | null;
		if (target && (target.closest('input, textarea, select') || target.isContentEditable)) {
			return;
		}

		if (event.key === 'h' || event.key === 'H') {
			event.preventDefault();
			hidden = !hidden;
			return;
		}

		let step = 0;
		if (event.key === 'ArrowDown' || event.key === 'ArrowRight') step = 1;
		else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') step = -1;
		else return;

		event.preventDefault();
		const idx = ALL_KEYS.indexOf(current);
		const nextIdx = (idx + step + ALL_KEYS.length) % ALL_KEYS.length;
		selectState(ALL_KEYS[nextIdx]);
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="state-page">
	<div class="state-layout" class:is-hidden={hidden}>
		<nav bind:this={navEl} class="state-switcher" aria-label="States">
			{#each STATE_GROUPS as group (group.id)}
				<div class="state-switcher-group" role="group" aria-labelledby={group.id}>
					<span class="state-switcher-heading" id={group.id}>
						<svg
							aria-hidden="true"
							viewBox="0 0 16 16"
							width="12"
							height="12"
							fill="none"
							stroke="currentColor"
							stroke-width="1.5"
							stroke-linecap="round"
							stroke-linejoin="round"
						>
							<path d="M3 3v4a3 3 0 0 0 3 3h7" />
							<path d="m10 7 3 3-3 3" />
						</svg>
						{group.label}
					</span>
					{#each group.items as item (item.key)}
						<button
							type="button"
							data-state={item.key}
							aria-pressed={current === item.key}
							onclick={() => selectState(item.key)}
						>
							{item.label}
						</button>
					{/each}
				</div>
			{/each}
		</nav>

		<div class="state-switcher-select">
			<select
				aria-label="State"
				value={current}
				onchange={(event) => selectState(event.currentTarget.value)}
			>
				{#each STATE_GROUPS as group (group.id)}
					<optgroup label={group.label}>
						{#each group.items as item (item.key)}
							<option value={item.key} selected={current === item.key}>{item.label}</option>
						{/each}
					</optgroup>
				{/each}
			</select>
			<svg
				aria-hidden="true"
				viewBox="0 0 16 16"
				width="12"
				height="12"
				fill="none"
				stroke="currentColor"
				stroke-width="1.5"
				stroke-linecap="round"
				stroke-linejoin="round"
			>
				<path d="m4 6 4 4 4-4" />
			</svg>
		</div>

		<div class="state-stage">
			{#key current}
				<FlowsPage />
			{/key}
		</div>
	</div>
</div>

<style>
	.state-page {
		container: state-page / inline-size;
		margin-inline: calc(50% - 50vw);
		padding: 24px;
	}

	.state-layout {
		display: flex;
		flex-direction: column;
		gap: 16px;
		max-width: 560px;
		margin-inline: auto;
	}

	.state-stage {
		min-width: 0;
	}

	.state-switcher {
		all: unset;
		display: none;
		flex-direction: column;
		gap: 16px;
		max-height: calc(100dvh - 48px);
		overflow-y: auto;
		scrollbar-width: none;
		padding: 6px;
		border-radius: 14px;
		background: rgb(20 20 20 / 0.92);
		box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.1);
		font: 13px/1 system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
		user-select: none;
	}

	.state-switcher-group {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.state-switcher-heading {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 4px 10px 6px;
		font-size: 11px;
		font-weight: 500;
		color: rgb(255 255 255 / 0.45);
	}

	.state-switcher button {
		all: unset;
		flex: none;
		padding: 8px 10px;
		border-radius: 8px;
		font: inherit;
		color: rgb(255 255 255 / 0.6);
		cursor: pointer;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		transition:
			color 200ms ease-out,
			font-weight 200ms ease-out;
	}

	.state-switcher button:hover {
		color: rgb(255 255 255 / 0.85);
	}

	.state-switcher button[aria-pressed='true'] {
		background: rgb(255 255 255 / 0.14);
		color: rgb(255 255 255);
		font-weight: 500;
	}

	.state-switcher button:focus-visible {
		outline: 2px solid rgb(255 255 255 / 0.7);
		outline-offset: 2px;
	}

	.state-switcher-select {
		position: relative;
		align-self: flex-start;
		max-width: 100%;
		color: rgb(255 255 255);
	}

	.state-switcher-select select {
		all: unset;
		box-sizing: border-box;
		max-width: 100%;
		padding: 10px 36px 10px 16px;
		border-radius: 999px;
		background: rgb(20 20 20 / 0.92);
		box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.1);
		font: 500 13px/1 system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
		color-scheme: dark;
		cursor: pointer;
	}

	.state-switcher-select select:focus-visible {
		outline: 2px solid rgb(255 255 255 / 0.7);
		outline-offset: 2px;
	}

	.state-switcher-select svg {
		position: absolute;
		top: 50%;
		right: 14px;
		translate: 0 -50%;
		pointer-events: none;
		color: rgb(255 255 255 / 0.6);
	}

	.state-layout.is-hidden .state-switcher,
	.state-layout.is-hidden .state-switcher-select {
		display: none;
	}

	/* 208px list + 24px gap + 560px component */
	@container state-page (min-width: 792px) {
		.state-layout:not(.is-hidden) {
			display: grid;
			grid-template-columns: 208px 560px;
			justify-content: center;
			gap: 24px;
			align-items: start;
			max-width: none;
		}

		.state-layout:not(.is-hidden) .state-switcher {
			display: flex;
			position: sticky;
			top: 24px;
		}

		.state-layout:not(.is-hidden) .state-switcher-select {
			display: none;
		}
	}
</style>
