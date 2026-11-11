<script lang="ts">
	/**
	 * The flow as JSON: a 720px sheet, read-only until the switch says otherwise.
	 *
	 * This replaced a whole "Code" mode. A mode is a place you go and can get
	 * stuck in; a sheet is a thing you open, read and close, and while it is open
	 * nothing underneath it edits the same document.
	 */
	import { tick } from 'svelte';
	import Icon from '$lib/components/Icon.svelte';

	export interface ApplyResult {
		ok: boolean;
		/** "6 steps become 7", or why the text was not applied. */
		note?: string;
		error?: string;
		errorLine?: number | null;
	}

	let {
		open,
		json,
		stepCount,
		onapply,
		onclose
	}: {
		open: boolean;
		json: string;
		stepCount: number;
		onapply: (text: string) => ApplyResult;
		onclose: () => void;
	} = $props();

	let draft = $state('');
	let editing = $state(false);
	let error = $state<string | null>(null);
	let errorLine = $state<number | null>(null);
	let note = $state<string | null>(null);
	let area = $state<HTMLTextAreaElement | null>(null);
	let sheetEl = $state<HTMLDivElement | null>(null);
	let gutter = $state<HTMLDivElement | null>(null);
	let closeButton = $state<HTMLButtonElement | null>(null);
	let wasOpen = false;

	const lines = $derived(
		Array.from({ length: draft.split('\n').length }, (_, index) => index + 1)
	);

	$effect(() => {
		if (open && !wasOpen) {
			wasOpen = true;
			draft = json;
			editing = false;
			error = null;
			errorLine = null;
			note = null;
			void tick().then(() => closeButton?.focus());
		} else if (!open && wasOpen) {
			wasOpen = false;
		}
	});

	function syncScroll() {
		if (gutter && area) gutter.scrollTop = area.scrollTop;
	}

	function lineOf(message: string): number | null {
		const position = /position (\d+)/.exec(message);
		if (!position) return null;
		const at = Number(position[1]);
		return draft.slice(0, at).split('\n').length;
	}

	function apply() {
		const result = onapply(draft);
		if (result.ok) {
			error = null;
			errorLine = null;
			note = result.note ?? 'Applied.';
			draft = json;
		} else {
			error = result.error ?? 'That text could not be read.';
			errorLine = result.errorLine ?? lineOf(error);
			note = null;
		}
	}

	/** A modal sheet keeps Tab inside itself. */
	function trapTab(event: KeyboardEvent) {
		if (event.key !== 'Tab' || !sheetEl) return;
		const items = [
			...sheetEl.querySelectorAll<HTMLElement>(
				'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'
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

	function onkeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			event.stopPropagation();
			onclose();
			return;
		}
		trapTab(event);
	}
</script>

{#if open}
	<div class="sheet-scrim" role="presentation" onclick={onclose}></div>
	<div
		class="source-sheet"
		bind:this={sheetEl}
		role="dialog"
		tabindex="-1"
		aria-modal="true"
		aria-label="Workflow source"
		onkeydown={onkeydown}
	>
		<header class="sheet-head">
			<div>
				<p class="eyebrow">Source</p>
				<h2>dakflare.flow/v2</h2>
			</div>
			<div class="sheet-head-actions">
				<label class="switch" title="Allow edits to the document">
					<input type="checkbox" bind:checked={editing} />
					<span class="switch-track" aria-hidden="true"><span></span></span>
					<span class="switch-label">Edit as JSON</span>
				</label>
				<button
					type="button"
					class="btn btn-ghost btn-icon btn-sm"
					bind:this={closeButton}
					onclick={onclose}
					aria-label="Close source"
				>
					<Icon name="x" size={16} />
				</button>
			</div>
		</header>

		<p class="sheet-help">
			{editing
				? 'Edit the document, then apply it. Nothing changes until you apply.'
				: 'The flow exactly as it is stored. Switch on editing to change it here.'}
			<span class="mono"> {stepCount} {stepCount === 1 ? 'step' : 'steps'}</span>
		</p>

		<div class="code-editor">
			<div class="gutter mono" bind:this={gutter} aria-hidden="true">
				{#each lines as line (line)}
					<span class:is-error={errorLine === line}>{line}</span>
				{/each}
			</div>
			<textarea
				class="code-textarea mono"
				class:is-readonly={!editing}
				bind:this={area}
				bind:value={draft}
				readonly={!editing}
				onscroll={syncScroll}
				spellcheck="false"
				aria-label="Workflow JSON"
				placeholder="Paste a dakflare.flow/v2 document here."
			></textarea>
		</div>

		{#if error}
			<p class="sheet-error" role="alert">
				<Icon name="alert" size={16} />
				<span>{errorLine ? `Line ${errorLine}: ` : ''}{error}</span>
			</p>
		{:else if note}
			<p class="sheet-note" role="status">
				<Icon name="check" size={16} />
				<span>{note}</span>
			</p>
		{/if}

		<footer class="sheet-foot">
			{#if editing}
				<button type="button" class="btn btn-sm" onclick={() => (draft = json)}>
					<Icon name="undo" size={16} /> Reset
				</button>
				<button type="button" class="btn btn-primary btn-sm" onclick={apply}>
					<Icon name="check" size={16} /> Apply
				</button>
			{:else}
				<span class="hint">Apply is only offered while editing.</span>
			{/if}
			<span class="spacer"></span>
			<button type="button" class="btn btn-sm" onclick={onclose}>Close</button>
		</footer>
	</div>
{/if}

<style>
	.sheet-scrim {
		position: fixed;
		inset: 0;
		z-index: 80;
		background: var(--df-c-dialog-scrim);
		backdrop-filter: blur(2px);
	}

	.source-sheet {
		position: fixed;
		top: 0;
		right: 0;
		bottom: 0;
		z-index: 81;
		display: flex;
		flex-direction: column;
		width: min(720px, 100vw);
		border-left: 1px solid var(--df-border-control);
		background: var(--df-surface-card);
		box-shadow: var(--df-shadow-dialog);
		animation: sheet-in var(--df-p-dur-settle) var(--df-p-ease-standard) both;
	}

	@keyframes sheet-in {
		from {
			opacity: 0;
			transform: translateX(12px);
		}
	}

	.sheet-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--df-p-space-3);
		padding: var(--df-p-space-4) var(--df-p-space-4) var(--df-p-space-3);
		border-bottom: 1px solid var(--df-border-hairline);
		background: var(--df-surface-well);
	}

	.sheet-head h2 {
		margin-top: 2px;
		font-family: var(--df-p-font-mono);
		font-size: var(--df-p-text-md);
		letter-spacing: -0.01em;
	}

	.sheet-head-actions {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-3);
	}

	.sheet-help {
		padding: var(--df-p-space-2) var(--df-p-space-4);
		font-size: var(--df-p-text-sm);
		line-height: 1.45;
		color: var(--df-text-meta);
	}

	.sheet-help .mono {
		color: var(--df-text-secondary);
	}

	.code-editor {
		display: flex;
		flex: 1;
		min-height: 0;
		margin: 0 var(--df-p-space-4);
		border: 1px solid var(--df-border-control);
		border-radius: var(--df-p-radius-sm);
		background: var(--df-surface-well);
		overflow: hidden;
	}

	.gutter {
		display: flex;
		flex-direction: column;
		flex: none;
		width: 44px;
		padding: 10px 6px;
		overflow: hidden;
		border-right: 1px solid var(--df-border-hairline);
		color: var(--df-text-meta);
		font-size: 11px;
		line-height: 1.55;
		text-align: right;
		user-select: none;
	}

	.gutter span {
		display: block;
		height: 1.55em;
	}

	.gutter span.is-error {
		color: var(--df-state-danger-ink);
		font-weight: 700;
	}

	.code-textarea {
		flex: 1;
		min-width: 0;
		margin: 0;
		padding: 10px 12px;
		border: 0;
		background: transparent;
		color: var(--df-text-primary);
		font-size: 12px;
		line-height: 1.55;
		tab-size: 2;
		resize: none;
		overflow: auto;
	}

	.code-textarea:focus-visible {
		outline: 2px solid var(--df-accent-text);
		outline-offset: -2px;
	}

	.code-textarea.is-readonly {
		cursor: text;
	}

	.sheet-error,
	.sheet-note {
		display: flex;
		align-items: flex-start;
		gap: 6px;
		margin: var(--df-p-space-2) var(--df-p-space-4) 0;
		padding: var(--df-p-space-2) var(--df-p-space-3);
		border-radius: var(--df-p-radius-xs);
		font-size: var(--df-p-text-sm);
		line-height: 1.45;
	}

	.sheet-error {
		border: 1px solid var(--df-c-tint-edge-danger);
		background: var(--df-state-danger-bg);
		color: var(--df-state-danger-ink);
	}

	.sheet-note {
		border: 1px solid var(--df-c-tint-edge-ok);
		background: var(--df-state-ok-bg);
		color: var(--df-state-ok-ink);
	}

	.sheet-error :global(svg),
	.sheet-note :global(svg) {
		margin-top: 1px;
		flex: none;
	}

	.sheet-foot {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-2);
		padding: var(--df-p-space-3) var(--df-p-space-4);
		margin-top: var(--df-p-space-3);
		border-top: 1px solid var(--df-border-hairline);
		background: var(--df-surface-well);
		flex-wrap: wrap;
	}

	/* one switch, same geometry as everywhere else in the console */
	.switch {
		position: relative;
		display: inline-flex;
		align-items: center;
		gap: 7px;
		cursor: pointer;
		font-size: var(--df-p-text-xs);
		color: var(--df-text-secondary);
		white-space: nowrap;
	}

	.switch input {
		position: absolute;
		opacity: 0;
		width: 1px;
		height: 1px;
	}

	.switch-track {
		position: relative;
		width: 34px;
		height: 20px;
		flex: none;
		border: 1px solid var(--df-border-control);
		border-radius: var(--df-p-radius-pill);
		background: var(--df-surface-well);
		transition:
			background-color 140ms ease,
			border-color 140ms ease;
	}

	.switch-track > span {
		position: absolute;
		top: 2px;
		left: 2px;
		width: 14px;
		height: 14px;
		border-radius: 50%;
		background: var(--df-text-meta);
		transition:
			transform 140ms ease,
			background-color 140ms ease;
	}

	.switch input:checked + .switch-track {
		background: var(--df-accent-fill);
		border-color: var(--df-accent-fill);
	}

	.switch input:checked + .switch-track > span {
		transform: translateX(14px);
		background: var(--df-text-on-accent, #fff);
	}

	.switch input:focus-visible + .switch-track {
		outline: 2px solid var(--df-accent-text);
		outline-offset: 2px;
	}

	@media (prefers-reduced-motion: reduce) {
		.source-sheet {
			animation: none;
		}
	}
</style>
