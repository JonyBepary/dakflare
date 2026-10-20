<script lang="ts">
	import type { Snippet } from 'svelte';

	let {
		eyebrow,
		title,
		description,
		children
	}: {
		eyebrow: string;
		title: string;
		description?: string;
		children?: Snippet;
	} = $props();
</script>

<header class="page-head">
	<div>
		<p class="eyebrow">{eyebrow}</p>
		<h1>{title}</h1>
		{#if description}<p class="page-sub">{description}</p>{/if}
	</div>
	{#if children}<div class="page-actions">{@render children()}</div>{/if}
</header>
