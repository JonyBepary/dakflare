<script module lang="ts">
	export interface StateItem {
		key: string;
		label: string;
	}

	export interface StateGroup {
		heading: string;
		states: ReadonlyArray<StateItem>;
	}
</script>

<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		groups,
		current,
		onchange,
		children
	}: {
		groups: ReadonlyArray<StateGroup>;
		current: string;
		onchange: (next: string) => void;
		children: Snippet;
	} = $props();

	let hidden = $state(false);
	let navEl = $state<HTMLElement | null>(null);

	const flatKeys = $derived(groups.flatMap((group) => group.states.map((item) => item.key)));

	function headingId(heading: string): string {
		return `states-${heading.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
	}

	$effect(() => {
		const key = current;
		const btn = navEl?.querySelector<HTMLButtonElement>(`button[data-state="${CSS.escape(key)}"]`);
		btn?.scrollIntoView({ block: 'nearest' });
	});

	function handleKeydown(event: KeyboardEvent): void {
		if (
			event.defaultPrevented ||
			event.ctrlKey ||
			event.metaKey ||
			event.altKey ||
			event.isComposing
		) {
			return;
		}
		const target = event.target instanceof HTMLElement ? event.target : null;
		if (
			target &&
			(target.isContentEditable ||
				target.closest(
					'input, textarea, select, [contenteditable="true"], [contenteditable=""], [role="dialog"], dialog[open]'
				))
		) {
			return;
		}
		if (event.key === 'h' || event.key === 'H') {
			event.preventDefault();
			hidden = !hidden;
			return;
		}
		if (flatKeys.length === 0) return;
		if (
			event.key === 'ArrowDown' ||
			event.key === 'ArrowRight' ||
			event.key === 'ArrowUp' ||
			event.key === 'ArrowLeft'
		) {
			event.preventDefault();
			const delta = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1;
			const index = flatKeys.indexOf(current);
			const nextIndex =
				index === -1
					? delta > 0
						? 0
						: flatKeys.length - 1
					: (index + delta + flatKeys.length) % flatKeys.length;
			onchange(flatKeys[nextIndex]);
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="state-page">
	<div class="state-layout" class:is-hidden={hidden}>
		<nav bind:this={navEl} class="state-switcher" aria-label="States">
			{#each groups as group (group.heading)}
				{@const gid = headingId(group.heading)}
				<div class="state-switcher-group" role="group" aria-labelledby={gid}>
					<span class="state-switcher-heading" id={gid}>
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
							onclick={() => onchange(item.key)}
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
				onchange={(event) => onchange(event.currentTarget.value)}
			>
				{#each groups as group (group.heading)}
					<optgroup label={group.heading}>
						{#each group.states as item (item.key)}
							<option value={item.key}>{item.label}</option>
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
		margin-inline: calc(50% - 50vw);
		padding: 24px;
	}

	.state-layout {
		display: flex;
		flex-direction: column;
		gap: 16px;
		max-width: 398px;
		margin-inline: auto;
	}

	.state-stage {
		min-width: 0;
	}

	.state-stage :global(.gate),
	.state-stage :global(.login) {
		min-height: 0;
		display: block;
		padding: 0;
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
		transition: color 200ms ease-out, font-weight 200ms ease-out;
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

	.state-layout.is-hidden .state-switcher,
	.state-layout.is-hidden .state-switcher-select {
		display: none;
	}

	/* 208px list + 24px gap + 398px component */
	@container state-page (min-width: 630px) {
		.state-layout:not(.is-hidden) {
			display: grid;
			grid-template-columns: 208px 398px;
			justify-content: center;
			gap: 24px;
			align-items: start;
			max-width: none;
		}

		.state-switcher {
			display: flex;
			position: sticky;
			top: 24px;
		}

		.state-switcher-select {
			display: none;
		}
	}
</style>
