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
	// A future timestamp is an expiry or a scheduled moment, and `formatRelative`
	// already says "in 11h" for it. Forcing now = value here made every expiry
	// read "just now", which is how a 30-day session looked already gone.
	const label = $derived(value ? formatRelative(value, now) : fallback);
	const absolute = $derived(value ? formatAbsolute(value) : undefined);

	onMount(() => subscribeClock());
</script>

<time class={className} datetime={value ? new Date(value).toISOString() : undefined} title={absolute ?? fallback}>
	{label}
</time>
