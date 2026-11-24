<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { tick, type Snippet } from 'svelte';

	export interface StateOption {
		key: string;
		label: string;
		title?: string;
	}

	export interface StateGroup {
		heading: string;
		states: ReadonlyArray<StateOption>;
	}

	let {
		groups,
		current,
		onchange,
		children
	}: {
		groups: ReadonlyArray<StateGroup>;
		current: string;
		onchange?: (next: string) => void;
		children: Snippet;
	} = $props();

	let hidden = $state(false);
	let navEl = $state<HTMLElement | null>(null);

	const flatKeys = $derived(groups.flatMap((group) => group.states.map((item) => item.key)));

	const groupIds = $derived.by(() => {
		const seen = new Map<string, number>();
		return groups.map((group, idx) => {
			const base =
				group.heading
					.toLowerCase()
					.replace(/[^a-z0-9]+/g, '-')
					.replace(/^-|-$/g, '') || `group-${idx}`;
			const count = seen.get(base) ?? 0;
			seen.set(base, count + 1);
			return count === 0 ? `states-${base}` : `states-${base}-${count}`;
		});
	});

	$effect(() => {
		void current;
		void hidden;
		void tick().then(() => {
			if (!navEl || hidden) return;
			const active = navEl.querySelector<HTMLButtonElement>('button[aria-pressed="true"]');
			active?.scrollIntoView({ block: 'nearest' });
		});
	});

	function select(next: string): void {
		if (onchange) {
			onchange(next);
			return;
		}
		if (next === current) return;
		const url = new URL(page.url.href);
		url.searchParams.set('__state', next);
		void goto(`${url.pathname}?${url.searchParams.toString()}`, {
			reset: false
		});
	}

	function step(delta: number): void {
		if (flatKeys.length === 0) return;
		const idx = flatKeys.indexOf(current);
		const nextIdx = idx === -1 ? 0 : (idx + delta + flatKeys.length) % flatKeys.length;
		const nextKey = flatKeys[nextIdx];
		if (nextKey) select(nextKey);
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (event.defaultPrevented || event.isComposing) return;
		if (event.ctrlKey || event.metaKey || event.altKey) return;

		const target = event.target instanceof HTMLElement ? event.target : null;
		if (
			target &&
			(target.isContentEditable ||
				target.closest('input, textarea, select, [contenteditable], [role="dialog"], dialog[open]'))
		) {
			return;
		}

		if (event.key === 'h' || event.key === 'H') {
			event.preventDefault();
			hidden = !hidden;
			return;
		}

		if (event.shiftKey) return;

		if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
			event.preventDefault();
			step(1);
			return;
		}
		if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
			event.preventDefault();
			step(-1);
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="state-page">
	<div class="state-layout" class:is-hidden={hidden}>
		<nav class="state-switcher" aria-label="States" bind:this={navEl}>
			{#each groups as group, gi (group.heading + gi)}
				{@const headingId = groupIds[gi]}
				<div class="state-switcher-group" role="group" aria-labelledby={headingId}>
					<span class="state-switcher-heading" id={headingId}>
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
						{group.heading}
					</span>
					{#each group.states as item (item.key)}
						<button
							type="button"
							data-state={item.key}
							aria-pressed={current === item.key}
							title={item.title}
							onclick={() => select(item.key)}
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
				onchange={(event) => select(event.currentTarget.value)}
			>
				{#each groups as group, gi (group.heading + gi)}
					<optgroup label={group.heading}>
						{#each group.states as item (item.key)}
							<option value={item.key} selected={item.key === current}>{item.label}</option>
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
			{@render children()}
		</div>
	</div>
</div>

<style>
	.state-page {
		container: state-page / inline-size;
		/* Measured against the console's main column, not the window. The rail
		   already takes 248px of the viewport, so a page that subtracted 50vw
		   from its own half slid under that rail and overflowed the right edge;
		   the state it was meant to show was cut on both sides. */
		margin-inline: 0;
		padding: 24px;
	}

	.state-layout {
		display: flex;
		flex-direction: column;
		gap: 16px;
		max-width: 1136px;
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

	.state-switcher::-webkit-scrollbar {
		display: none;
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

	/* 208px list + 24px gap + a usable stage. The stage takes what is left of the
	   console's column instead of forcing the page wider, so the rail appears
	   where it fits rather than overlapping the console's own rail. The same
	   rule as the ai-settings workbench. */
	@container state-page (min-width: 1180px) {
		.state-layout:not(.is-hidden) {
			display: grid;
			grid-template-columns: 208px minmax(0, 1fr);
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

	.state-layout.is-hidden .state-switcher,
	.state-layout.is-hidden .state-switcher-select {
		display: none;
	}
</style>
