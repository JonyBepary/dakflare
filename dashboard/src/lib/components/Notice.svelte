<script lang="ts">
	import { onMount } from 'svelte';
	import type { Snippet } from 'svelte';
	import { announce } from '$lib/announce.svelte';
	import Icon from './Icon.svelte';

	type Tone = 'info' | 'ok' | 'warn' | 'danger';

	let {
		tone = 'info',
		title,
		children
	}: { tone?: Tone; title?: string; children?: Snippet } = $props();

	const icons: Record<Tone, 'info' | 'check' | 'alert'> = {
		info: 'info',
		ok: 'check',
		warn: 'alert',
		danger: 'alert'
	};

	let root = $state<HTMLDivElement | null>(null);

	// Danger carries role="alert" and is announced on insertion. Every other
	// tone writes into the layout's always-present polite region instead, once
	// per mount. A Notice with no text announces nothing.
	onMount(() => {
		if (tone === 'danger') return;
		const text = root?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
		if (text !== '') announce(text);
	});
</script>

<div
	bind:this={root}
	class="callout"
	data-tone={tone}
	role={tone === 'danger' ? 'alert' : undefined}
>
	<Icon name={icons[tone]} size={15} />
	<div>
		{#if title}<strong>{title}</strong>{/if}
		{#if children}{@render children()}{/if}
	</div>
</div>
