<script lang="ts">
	import type { Snippet } from 'svelte';

	type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'accent' | 'muted';

	let {
		tone = 'neutral',
		dot = false,
		children
	}: { tone?: Tone; dot?: boolean; children?: Snippet } = $props();
</script>

<span class="badge badge-{tone}">
	{#if dot}<span class="badge-dot"></span>{/if}
	{#if children}{@render children()}{/if}
</span>
