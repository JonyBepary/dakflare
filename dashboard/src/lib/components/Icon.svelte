<script module lang="ts">
	export type IconName =
		| 'activity'
		| 'smartphone'
		| 'message'
		| 'filter'
		| 'logout'
		| 'refresh'
		| 'copy'
		| 'check'
		| 'plus'
		| 'x'
		| 'chevron-down'
		| 'chevron-up'
		| 'arrow-up-right'
		| 'arrow-down-left'
		| 'alert'
		| 'info'
		| 'key'
		| 'moon'
		| 'sun'
		| 'trash'
		| 'clock'
		| 'external'
		| 'shield'
		| 'send'
		| 'workflow'
		| 'zap'
		| 'branch'
		| 'braces'
		| 'stop'
		| 'grip'
		| 'fingerprint'
		| 'history'
		| 'mail'
		| 'archive'
		| 'unarchive';
</script>

<script lang="ts">
	let {
		name,
		size = 16,
		strokeWidth = 1.5
	}: { name: IconName; size?: number; strokeWidth?: number } = $props();
</script>

<svg
	width={size}
	height={size}
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width={strokeWidth}
	stroke-linecap="round"
	stroke-linejoin="round"
	aria-hidden="true"
	focusable="false"
>
	{#if name === 'activity'}
		<path d="M3 12h4l2.5-6 4 12 2.5-6H21" />
	{:else if name === 'smartphone'}
		<rect x="6" y="2.5" width="12" height="19" rx="2.5" />
		<path d="M10.5 18.5h3" />
	{:else if name === 'message'}
		<path d="M4 5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-5 4V5Z" />
		<path d="M8 8h8M8 11h5" />
	{:else if name === 'filter'}
		<path d="M3.5 5h17l-6.5 7.5V20l-4-2v-5.5L3.5 5Z" />
	{:else if name === 'logout'}
		<path d="M10 4H5.5A1.5 1.5 0 0 0 4 5.5v13A1.5 1.5 0 0 0 5.5 20H10" />
		<path d="m15 8 4 4-4 4" />
		<path d="M19 12H9" />
	{:else if name === 'refresh'}
		<path d="M20 11a8 8 0 1 0-2.34 5.66" />
		<path d="M20 5v6h-6" />
	{:else if name === 'copy'}
		<rect x="9" y="9" width="11" height="11" rx="2" />
		<path d="M5 15h-.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5" />
	{:else if name === 'check'}
		<path d="m5 12.5 4.5 4.5L19 7.5" />
	{:else if name === 'plus'}
		<path d="M12 5v14M5 12h14" />
	{:else if name === 'x'}
		<path d="M6 6l12 12M18 6 6 18" />
	{:else if name === 'chevron-down'}
		<path d="m6 9.5 6 6 6-6" />
	{:else if name === 'chevron-up'}
		<path d="m6 14.5 6-6 6 6" />
	{:else if name === 'arrow-up-right'}
		<path d="M7 17 17 7" />
		<path d="M9 7h8v8" />
	{:else if name === 'arrow-down-left'}
		<path d="M17 7 7 17" />
		<path d="M15 17H7V9" />
	{:else if name === 'alert'}
		<path d="M10.3 3.9 2.6 17.2A2 2 0 0 0 4.3 20h15.4a2 2 0 0 0 1.7-2.8L13.7 3.9a2 2 0 0 0-3.4 0Z" />
		<path d="M12 9v4" />
		<path d="M12 16.5h.01" />
	{:else if name === 'info'}
		<circle cx="12" cy="12" r="9" />
		<path d="M12 11v5" />
		<path d="M12 8h.01" />
	{:else if name === 'key'}
		<circle cx="8" cy="8" r="4" />
		<path d="m10.9 10.9 8.1 8.1" />
		<path d="m16.5 16.5 2-2 2 2-2 2" />
	{:else if name === 'moon'}
		<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
	{:else if name === 'sun'}
		<circle cx="12" cy="12" r="4" />
		<path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
	{:else if name === 'trash'}
		<path d="M4 7h16" />
		<path d="M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7" />
		<path d="m6.5 7 .8 12.1A2 2 0 0 0 9.3 21h5.4a2 2 0 0 0 2-1.9L17.5 7" />
	{:else if name === 'clock'}
		<circle cx="12" cy="12" r="9" />
		<path d="M12 7.5V12l3 2" />
	{:else if name === 'external'}
		<path d="M14 4h6v6" />
		<path d="M20 4 11 13" />
		<path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
	{:else if name === 'shield'}
		<path d="M12 3l7 3v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6l7-3Z" />
		<path d="m9 12 2 2 4-4" />
	{:else if name === 'send'}
		<path d="m21 3-9.5 9.5" />
		<path d="M21 3 14.5 21l-3-7.5L4 10.5 21 3Z" />
	{:else if name === 'workflow'}
		<rect x="3" y="3.5" width="6" height="5" rx="1" />
		<rect x="15" y="15.5" width="6" height="5" rx="1" />
		<rect x="3" y="15.5" width="6" height="5" rx="1" />
		<path d="M9 6h3a3 3 0 0 1 3 3v9" />
		<path d="M6 8.5V15.5" />
	{:else if name === 'zap'}
		<path d="M13.5 2.5 5 13.5h6l-.5 8L19 10.5h-6l.5-8Z" />
	{:else if name === 'branch'}
		<circle cx="5.5" cy="6" r="2.2" />
		<circle cx="18.5" cy="6" r="2.2" />
		<circle cx="12" cy="18.5" r="2.2" />
		<path d="M5.5 8.2v2.3a3 3 0 0 0 3 3h1.3M18.5 8.2v2.3a3 3 0 0 1-3 3h-1.3" />
		<path d="M12 13.5v2.8" />
	{:else if name === 'braces'}
		<path d="M9 3.5H8A1.5 1.5 0 0 0 6.5 5v4.2A2.3 2.3 0 0 1 4.2 11.5a2.3 2.3 0 0 1 2.3 2.3V18A1.5 1.5 0 0 0 8 19.5h1" />
		<path d="M15 3.5h1A1.5 1.5 0 0 1 17.5 5v4.2a2.3 2.3 0 0 0 2.3 2.3 2.3 2.3 0 0 0-2.3 2.3V18a1.5 1.5 0 0 1-1.5 1.5h-1" />
	{:else if name === 'stop'}
		<rect x="4.5" y="4.5" width="15" height="15" rx="4" />
		<rect x="9" y="9" width="6" height="6" rx="1" />
	{:else if name === 'grip'}
		<path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01" stroke-width="2.4" />
	{:else if name === 'fingerprint'}
		<path d="M12 4.5a7.5 7.5 0 0 1 7.5 7.5" />
		<path d="M4.5 12A7.5 7.5 0 0 1 12 4.5" />
		<path d="M7.5 20.2A10 10 0 0 0 9 15.5V12a3 3 0 0 1 6 0v2" />
		<path d="M4.6 16.5A7.5 7.5 0 0 1 4.5 15V12" />
		<path d="M19.5 12v1.5a14 14 0 0 1-1.4 6.2" />
		<path d="M12 12v4a10 10 0 0 0 .8 4" />
	{:else if name === 'history'}
		<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1" />
		<path d="M4 4v5h5" />
		<path d="M12 8v4.5l3 1.8" />
	{:else if name === 'mail'}
		<rect x="3" y="5" width="18" height="14" rx="2.5" />
		<path d="m4.5 7.5 6.6 4.9a1.5 1.5 0 0 0 1.8 0l6.6-4.9" />
	{:else if name === 'archive'}
		<rect x="3" y="3.5" width="18" height="5" rx="1.2" />
		<path d="M4.75 8.5v10A1.5 1.5 0 0 0 6.25 20h11.5a1.5 1.5 0 0 0 1.5-1.5v-10" />
		<path d="M12 11.5v4.5" />
		<path d="m9.75 13.75 2.25 2.25 2.25-2.25" />
	{:else if name === 'unarchive'}
		<rect x="3" y="3.5" width="18" height="5" rx="1.2" />
		<path d="M4.75 8.5v10A1.5 1.5 0 0 0 6.25 20h11.5a1.5 1.5 0 0 0 1.5-1.5v-10" />
		<path d="M12 16v-4.5" />
		<path d="m9.75 13.75 2.25-2.25 2.25 2.25" />
	{/if}
</svg>
