<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import ConversationFooter from '$lib/components/ConversationFooter.svelte';
	import Dock from '$lib/components/Dock.svelte';
	import Notice from '$lib/components/Notice.svelte';
	import { app } from '$lib/stores/app.svelte';

	let { children } = $props();

	// A conversation is a push below Threads, so it swaps the dock for the plain
	// read-only footer; Android back pops the push and restores the dock.
	const conversation = $derived(/^\/messages\/[^/]+\/?$/.test(page.url.pathname));

	const status = $derived(
		app.loading.boot
			? 'opening local db'
			: !app.backendAvailable
				? 'browser preview'
				: app.schemaVersion === null
					? 'backend ready'
					: `schema v${app.schemaVersion}`
	);

	onMount(() => {
		void app.boot();
	});
</script>

<div class="app">
	<header class="topbar">
		<span class="wordmark">DAKFLARE</span>
		<span class="topbar-meta" data-offline={!app.backendAvailable && !app.loading.boot}>
			{status}
		</span>
	</header>

	<main class="app-main">
		<Notice scope="boot" />
		<Notice scope="data" />
		{@render children()}
	</main>

	{#if conversation}
		<ConversationFooter />
	{:else}
		<Dock />
	{/if}
</div>
