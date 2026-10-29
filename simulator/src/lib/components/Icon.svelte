<script lang="ts">
	import type { IconName } from '$lib/icons';

	let { name, size = 24 }: { name: IconName; size?: number } = $props();
</script>

<svg
	width={size}
	height={size}
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width="1.5"
	stroke-linecap="round"
	stroke-linejoin="round"
	aria-hidden="true"
	focusable="false"
>
	{#if name === 'threads'}
		<path d="M21 15a2 2 0 0 1-2 2H8l-4 3V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z" />
		<path d="M8 8h8M8 11.5h5" />
	{:else if name === 'device'}
		<rect x="7" y="2.5" width="10" height="19" rx="2.5" />
		<path d="M10.5 18.5h3" />
	{:else if name === 'flows'}
		<circle cx="6" cy="6" r="2" />
		<circle cx="18" cy="6" r="2" />
		<circle cx="12" cy="18" r="2" />
		<path d="M8 6h8" />
		<path d="M7 7.8 11 16" />
		<path d="M17 7.8 13 16" />
	{:else if name === 'settings'}
		<path d="M4 7h8M17 7h3" />
		<circle cx="14.5" cy="7" r="2" />
		<path d="M4 17h3M12 17h8" />
		<circle cx="9.5" cy="17" r="2" />
	{:else if name === 'refresh'}
		<path d="M20 11.5a8 8 0 1 1-2.2-5.2" />
		<path d="M20 4v5h-5" />
	{:else if name === 'arrow-in'}
		<path d="M12 4v15" />
		<path d="m6.5 13.5 5.5 5.5 5.5-5.5" />
	{:else if name === 'arrow-out'}
		<path d="M12 20V5" />
		<path d="m6.5 10.5 5.5-5.5 5.5 5.5" />
	{:else if name === 'check'}
		<path d="m4.5 12.5 5 5L20 6.5" />
	{:else if name === 'alert'}
		<circle cx="12" cy="12" r="9" />
		<path d="M12 7.5v5.5M12 16.5h.01" />
	{:else if name === 'chevron-left'}
		<path d="m14.5 5-7 7 7 7" />
	{:else if name === 'send'}
		<path d="M21 3 3 10.5l6.8 2.7L12.5 20z" />
		<path d="M21 3 9.8 13.2" />
	{/if}
</svg>
