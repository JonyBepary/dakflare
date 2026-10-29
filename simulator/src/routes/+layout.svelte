<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import Composer from '$lib/components/Composer.svelte';
	import Dock from '$lib/components/Dock.svelte';
	import Notice from '$lib/components/Notice.svelte';
	import { app } from '$lib/stores/app.svelte';
	import { composer } from '$lib/stores/composer.svelte';

	let { children } = $props();

	// A conversation is a push below Threads, so it swaps the dock for the reply
	// composer: one bottom bar at a time, and the composer sits above the
	// keyboard instead of a dock floating over it. The new-message form is a
	// push too, but its primary send lives in the form, so it needs no bar.
	// Android back pops either push and restores the dock.
	const conversation = $derived(/^\/messages\/[^/]+\/?$/.test(page.url.pathname));
	const composing = $derived(/^\/compose\/?$/.test(page.url.pathname));
	// A thread with no messages has nothing to reply to, so the route closes the
	// bar rather than offering a first message to an unproven number.
	const replyable = $derived(conversation && !app.loading.boot && composer.repliesOpen);

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
		// Boot first, then take a link that launched the app (a SENDTO intent
		// is captured before the webview exists). A link that arrives while the
		// app is running is taken when the Activity regains focus.
		void (async () => {
			await app.boot();
			await app.followSmsIntent();
		})();

		const follow = () => {
			if (document.visibilityState === 'visible') void app.followSmsIntent();
		};
		window.addEventListener('focus', follow);
		document.addEventListener('visibilitychange', follow);
		return () => {
			window.removeEventListener('focus', follow);
			document.removeEventListener('visibilitychange', follow);
		};
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

	{#if replyable}
		<Composer />
	{:else if !conversation && !composing}
		<Dock />
	{/if}
</div>
