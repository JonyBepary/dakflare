<script lang="ts">
	import { onMount } from 'svelte';
	import { formatAbsolute, formatRelative } from '$lib/format';
	import { currentTime, subscribeClock } from '$lib/live-clock.svelte';

	let {
		value,
		fallback = 'never',
		className = ''
	}: { value: number | null | undefined; fallback?: string; className?: string } = $props();

	const now = $derived(currentTime());
	const effectiveNow = $derived(value && value > now ? value : now);
	const label = $derived(value ? formatRelative(value, effectiveNow) : fallback);
	const absolute = $derived(value ? formatAbsolute(value) : undefined);

	onMount(() => subscribeClock());
</script>

<time class={className} datetime={value ? new Date(value).toISOString() : undefined} title={absolute ?? fallback}>
	{label}
</time>
