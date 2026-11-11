<script lang="ts">
	/**
	 * Find a step by name: Ctrl+K, type, Enter.
	 *
	 * A map of forty steps is only usable if a named step can be reached without
	 * hunting for it, and the outline of the same forty is only usable if a name
	 * jumps to its row. Both go through here.
	 */
	import { tick } from 'svelte';
	import Icon from '$lib/components/Icon.svelte';
	import { metaFor, nodeSummary, type FlowNode } from '$lib/workflow/graph';

	let {
		open,
		nodes,
		selectedId = null,
		onpick,
		onclose
	}: {
		open: boolean;
		nodes: FlowNode[];
		selectedId?: string | null;
		onpick: (nodeId: string) => void;
		onclose: () => void;
	} = $props();

	let query = $state('');
	let cursor = $state(0);
	let inputEl = $state<HTMLInputElement | null>(null);
	let finderEl = $state<HTMLDivElement | null>(null);

	interface Found {
		node: FlowNode;
		title: string;
		summary: string;
	}

	const matches = $derived.by(() => {
		const needle = query.trim().toLowerCase();
		const found: Found[] = [];
		nodes.forEach((node, index) => {
			const title = metaFor(node.type).title;
			const summary = nodeSummary(node);
			const haystack = `${title} ${summary} ${node.type} ${index + 1}`.toLowerCase();
			if (needle && !haystack.includes(needle)) return;
			found.push({ node, title, summary });
		});
		return found;
	});

	$effect(() => {
		if (open) {
			query = '';
			cursor = 0;
			// The dialog renders on the tick after `open` flips.
			void tick().then(() => inputEl?.focus());
		}
	});

	function pick(index: number) {
		const hit = matches[index];
		if (!hit) return;
		onpick(hit.node.id);
	}

	function onkeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			event.stopPropagation();
			onclose();
			return;
		}
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			cursor = matches.length === 0 ? 0 : (cursor + 1) % matches.length;
			return;
		}
		if (event.key === 'ArrowUp') {
			event.preventDefault();
			cursor = matches.length === 0 ? 0 : (cursor <= 0 ? matches.length : cursor) - 1;
			return;
		}
		if (event.key === 'Enter') {
			event.preventDefault();
			pick(cursor);
			return;
		}
		if (event.key === 'Tab' && finderEl) {
			// The finder is a command palette: Tab cycles its own field and results.
			const items = [
				...finderEl.querySelectorAll<HTMLElement>(
					'input, button:not([disabled]), [tabindex]:not([tabindex="-1"])'
				)
			].filter((el) => el.offsetParent !== null);
			if (items.length === 0) return;
			const first = items[0];
			const last = items[items.length - 1];
			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first.focus();
			}
		}
	}
</script>

{#if open}
	<div class="finder-scrim" role="presentation" onclick={onclose}></div>
	<div
		class="finder"
		bind:this={finderEl}
		role="dialog"
		tabindex="-1"
		aria-modal="true"
		aria-label="Find a step"
		onkeydown={onkeydown}
	>
		<div class="finder-field">
			<Icon name="workflow" size={16} />
			<input
				bind:this={inputEl}
				class="finder-input"
				bind:value={query}
				oninput={() => (cursor = 0)}
				placeholder="Find a step by name or summary"
				aria-label="Find a step"
				aria-controls="finder-results"
				aria-activedescendant={matches[cursor] ? `finder-${matches[cursor].node.id}` : undefined}
				autocomplete="off"
				spellcheck="false"
			/>
			<kbd>Esc</kbd>
		</div>

		<ul class="finder-list" id="finder-results" role="listbox" aria-label="Steps">
			{#each matches as hit, index (hit.node.id)}
				<li>
					<button
						type="button"
						id={`finder-${hit.node.id}`}
						class="finder-row"
						class:is-cursor={index === cursor}
						class:is-selected={hit.node.id === selectedId}
						role="option"
						aria-selected={index === cursor}
						onmouseenter={() => (cursor = index)}
						onclick={() => pick(index)}
					>
						<span class="finder-index mono">{index + 1}</span>
						<span class="finder-text">
							<strong>{hit.title}</strong>
							<small>{hit.summary}</small>
						</span>
						{#if hit.node.id === selectedId}
							<span class="finder-flag">editing</span>
						{/if}
					</button>
				</li>
			{:else}
				<li class="finder-empty">No step matches “{query}”.</li>
			{/each}
		</ul>

		<p class="finder-foot">Enter reveals the step. Names, summaries and kinds are searched.</p>
	</div>
{/if}

<style>
	.finder-scrim {
		position: fixed;
		inset: 0;
		z-index: 70;
		background: var(--df-c-dialog-scrim);
		backdrop-filter: blur(2px);
	}

	.finder {
		position: fixed;
		top: 96px;
		left: 50%;
		z-index: 71;
		transform: translateX(-50%);
		width: min(520px, calc(100vw - 32px));
		border: 1px solid var(--df-border-control);
		border-radius: var(--df-p-radius-md);
		background: var(--df-surface-card);
		box-shadow: var(--df-shadow-dialog);
		overflow: hidden;
	}

	.finder-field {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-2);
		padding: var(--df-p-space-2) var(--df-p-space-3);
		border-bottom: 1px solid var(--df-border-hairline);
		color: var(--df-text-meta);
	}

	.finder-input {
		flex: 1;
		min-width: 0;
		border: 0;
		background: transparent;
		color: var(--df-text-primary);
		font-size: var(--df-p-text-md);
		padding: 6px 0;
	}

	.finder-input:focus-visible {
		outline: none;
	}

	.finder-field kbd {
		padding: 1px 5px;
		border: 1px solid var(--df-border-hairline);
		border-radius: 3px;
		background: var(--df-surface-well);
		font-family: var(--df-p-font-mono);
		font-size: 9.5px;
	}

	.finder-list {
		max-height: 320px;
		margin: 0;
		padding: var(--df-p-space-1);
		list-style: none;
		overflow-y: auto;
		overscroll-behavior: contain;
	}

	.finder-row {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-2);
		width: 100%;
		padding: 6px var(--df-p-space-2);
		border: 0;
		border-radius: var(--df-p-radius-xs);
		background: transparent;
		color: var(--df-text-primary);
		text-align: left;
	}

	.finder-row.is-cursor {
		background: var(--df-surface-well);
	}

	.finder-row.is-selected {
		box-shadow: inset 2px 0 0 var(--df-accent-text);
	}

	.finder-index {
		display: grid;
		place-items: center;
		width: 20px;
		height: 20px;
		flex: none;
		border-radius: var(--df-p-radius-xs);
		background: var(--df-surface-well);
		font-size: var(--df-p-text-2xs);
		color: var(--df-text-meta);
	}

	.finder-text {
		display: flex;
		flex-direction: column;
		gap: 1px;
		min-width: 0;
	}

	.finder-text strong {
		font-size: var(--df-p-text-base);
		font-weight: 600;
	}

	.finder-text small {
		font-size: var(--df-p-text-xs);
		color: var(--df-text-meta);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.finder-flag {
		margin-left: auto;
		padding: 1px 6px;
		border-radius: var(--df-p-radius-pill);
		background: var(--df-accent-soft);
		color: var(--df-accent-text);
		font-size: var(--df-p-text-2xs);
		white-space: nowrap;
	}

	.finder-empty {
		padding: var(--df-p-space-3);
		font-size: var(--df-p-text-base);
		color: var(--df-text-meta);
	}

	.finder-foot {
		padding: var(--df-p-space-2) var(--df-p-space-3);
		border-top: 1px solid var(--df-border-hairline);
		background: var(--df-surface-well);
		font-size: var(--df-p-text-2xs);
		color: var(--df-text-meta);
	}
</style>
