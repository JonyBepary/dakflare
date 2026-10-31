<script lang="ts">
	import Badge from './Badge.svelte';
	import { PRESENCE_META, type DevicePresence, type WakeMode } from '$lib/presence';

	let {
		presence,
		wake = null,
		queue = null,
		showWake = false
	}: {
		presence: DevicePresence;
		wake?: WakeMode | null;
		queue?: number | null;
		showWake?: boolean;
	} = $props();

	const meta = $derived(PRESENCE_META[presence]);
</script>

<!-- The word is the state; the shape is the second cue, so the five states still
     read in greyscale and on a pastel-blind screen. Colour is the third. -->
<span class="presence" data-presence={presence} title={meta.meaning}>
	<Badge tone={meta.tone}>
		<span class="glyph" data-presence={presence} aria-hidden="true"></span>
		{meta.label}
	</Badge>
	{#if showWake && wake}
		<Badge tone={wake === 'push' ? 'accent' : 'muted'}>{wake}</Badge>
	{/if}
	{#if queue !== null && queue !== undefined}
		<span class="queue mono" class:has-queue={queue > 0}>queue {queue}</span>
	{/if}
</span>

<style>
	.presence {
		display: inline-flex;
		align-items: center;
		gap: var(--df-p-space-1);
		flex-wrap: wrap;
	}

	/* Five shapes, one per state: filled circle, ring, hollow square, filled
	   square, dash. Never colour alone. */
	.glyph {
		width: 7px;
		height: 7px;
		flex: none;
		border-radius: 50%;
		background: currentColor;
	}

	.glyph[data-presence='synced'] {
		background: transparent;
		box-shadow: inset 0 0 0 1.5px currentColor;
	}

	.glyph[data-presence='stale'] {
		background: transparent;
		border-radius: 1px;
		box-shadow: inset 0 0 0 1.5px currentColor;
	}

	.glyph[data-presence='offline'] {
		border-radius: 1px;
	}

	.glyph[data-presence='unknown'] {
		width: 8px;
		height: 2px;
		border-radius: 1px;
	}

	.queue {
		font-size: var(--df-p-text-xs);
		letter-spacing: 0.02em;
		color: var(--df-text-meta);
	}

	/* A queue that is not draining is the failure this product exists to show. */
	.queue.has-queue {
		color: var(--df-state-warn-ink);
		font-weight: 600;
	}
</style>
