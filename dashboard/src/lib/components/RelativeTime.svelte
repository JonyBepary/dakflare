<script lang="ts">
	import { formatAbsolute, formatRelative } from '$lib/format';

	let {
		value,
		fallback = 'never',
		className = ''
	}: { value: number | null | undefined; fallback?: string; className?: string } = $props();

	const label = $derived(value ? formatRelative(value) : fallback);
	const absolute = $derived(value ? formatAbsolute(value) : undefined);
</script>

<time class={className} datetime={value ? new Date(value).toISOString() : undefined} title={absolute}>
	{label}
</time>
