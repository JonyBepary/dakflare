<script lang="ts">
	import type { Snippet } from 'svelte';
	import Icon, { type IconName } from './Icon.svelte';

	let {
		icon = 'info',
		title,
		description,
		children
	}: {
		icon?: IconName;
		title: string;
		description?: string;
		children?: Snippet;
	} = $props();
</script>

<div class="empty">
	<span class="empty-mark"><Icon name={icon} size={18} /></span>
	<h3>{title}</h3>
	{#if description}<p>{description}</p>{/if}
	{#if children}<div class="empty-actions">{@render children()}</div>{/if}
</div>
