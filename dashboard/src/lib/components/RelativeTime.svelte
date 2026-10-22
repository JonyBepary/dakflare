<script lang="ts">
	import { onMount } from 'svelte';
	import { formatAbsolute, formatRelative } from '$lib/format';
	import { currentTime, refreshClock, subscribeClock } from '$lib/live-clock.svelte';

	let {
		value,
		fallback = 'never',
		className = ''
	}: { value: number | null | undefined; fallback?: string; className?: string } = $props();

	const now = $derived(currentTime());
	const label = $derived(value ? formatRelative(value, now) : fallback);
	const absolute = $derived(value ? formatAbsolute(value) : undefined);

	$effect(() => {
		// A new command or a refreshed row must not be labelled against a clock
		// that is up to 30 seconds old.
		void value;
		refreshClock();
	});

	onMount(() => subscribeClock());
</script>

<time class={className} datetime={value ? new Date(value).toISOString() : undefined} title={absolute}>
	{label}
</time>
