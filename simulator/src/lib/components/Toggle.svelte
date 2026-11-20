<script lang="ts">
	/**
	 * One label, one state, one target.
	 *
	 * The whole row is the button, so a thumb never has to be hit exactly and the
	 * row clears 48px on a phone. `role="switch"` with `aria-checked` is what a
	 * screen reader announces; the thumb's travel, not only its colour, is what
	 * says which side is on.
	 */
	let {
		label,
		hint,
		checked,
		disabled = false,
		busy = false,
		onchange
	}: {
		label: string;
		hint?: string;
		checked: boolean;
		disabled?: boolean;
		busy?: boolean;
		onchange: (next: boolean) => void;
	} = $props();
</script>

<button
	type="button"
	class="toggle"
	role="switch"
	aria-checked={checked}
	aria-busy={busy}
	{disabled}
	onclick={() => onchange(!checked)}
>
	<span class="copy">
		<span class="label">{label}</span>
		{#if hint}<span class="hint">{hint}</span>{/if}
	</span>
	<span class="track" aria-hidden="true">
		<span class="thumb"></span>
	</span>
</button>

<style>
	.toggle {
		display: flex;
		align-items: center;
		gap: 12px;
		width: 100%;
		min-height: 56px;
		padding: 8px 0;
		border: 0;
		background: transparent;
		color: var(--ink);
		text-align: left;
		cursor: pointer;
		-webkit-tap-highlight-color: transparent;
	}

	.toggle:disabled {
		cursor: not-allowed;
	}

	.copy {
		display: flex;
		flex: 1 1 auto;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.label {
		font-size: 13.5px;
		font-weight: 600;
		line-height: 1.35;
		color: var(--ink);
	}

	.hint {
		font-size: 11.5px;
		line-height: 1.4;
		color: var(--ink-3);
		text-wrap: pretty;
	}

	/* The track is a shape before it is a colour: inset ring off, filled on. */
	.track {
		position: relative;
		flex: none;
		width: 44px;
		height: 26px;
		border-radius: var(--df-p-radius-pill);
		background: var(--df-surface-well);
		box-shadow: inset 0 0 0 1px var(--df-border-control);
		transition:
			background-color var(--df-p-dur-lift) var(--df-p-ease-standard),
			box-shadow var(--df-p-dur-lift) var(--df-p-ease-standard);
	}

	.thumb {
		position: absolute;
		top: 3px;
		left: 3px;
		width: 20px;
		height: 20px;
		border-radius: 50%;
		background: var(--surface);
		box-shadow: var(--df-p-shadow-1);
		transition: transform var(--df-p-dur-lift) var(--df-p-ease-standard);
	}

	.toggle[aria-checked='true'] .track {
		background: var(--df-accent-fill);
		box-shadow: inset 0 0 0 1px var(--df-accent-fill);
	}

	.toggle[aria-checked='true'] .thumb {
		transform: translateX(18px);
		background: var(--df-text-on-accent);
	}

	/* A disabled row still reads: the label keeps its ink and the track loses its
	   accent, rather than both fading out. */
	.toggle:disabled .track {
		background: var(--df-surface-press);
		box-shadow: inset 0 0 0 1px var(--df-border-hairline);
	}

	.toggle:disabled .thumb {
		background: var(--df-surface-well);
	}

	.toggle:disabled .label {
		color: var(--ink-3);
	}
</style>
