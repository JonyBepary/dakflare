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

<span class="presence" title={meta.meaning}>
	<Badge tone={meta.tone} dot={presence === 'live'}>{meta.label}</Badge>
	{#if showWake && wake}
		<Badge tone={wake === 'push' ? 'accent' : 'muted'}>{wake}</Badge>
	{/if}
	{#if queue !== null && queue !== undefined}
		<span class="queue mono">queue {queue}</span>
	{/if}
</span>

<style>
	.presence {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		flex-wrap: wrap;
	}

	.queue {
		font-size: 10px;
		letter-spacing: 0.03em;
		color: var(--ink-3);
	}
</style>
