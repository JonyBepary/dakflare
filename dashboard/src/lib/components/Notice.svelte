<script lang="ts">
	import type { Snippet } from 'svelte';
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
</script>

<div class="notice notice-{tone}" role={tone === 'danger' ? 'alert' : 'status'}>
	<Icon name={icons[tone]} size={15} />
	<div>
		{#if title}<strong>{title}</strong>{/if}
		{#if children}{@render children()}{/if}
	</div>
</div>
