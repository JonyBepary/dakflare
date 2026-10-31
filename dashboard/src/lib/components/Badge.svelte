<script lang="ts">
	import type { Snippet } from 'svelte';

	type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'accent' | 'muted';

	let {
		tone = 'neutral',
		dot = false,
		children
	}: { tone?: Tone; dot?: boolean; children?: Snippet } = $props();
</script>

<span class="chip" data-tone={tone}>
	{#if dot}<span class="chip-dot"></span>{/if}
	{#if children}{@render children()}{/if}
</span>
