<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { invoke } from '@tauri-apps/api/core';

	let { children } = $props();
	let schemaVersion = $state<number | null>(null);

	onMount(async () => {
		try {
			schemaVersion = await invoke<number>('schema_version');
		} catch {
			// Running in a plain browser (`vite dev` without Tauri): no backend.
			schemaVersion = null;
		}
	});
</script>

<div class="shell">
	<header class="topbar">
		<div class="brand">
			<strong>DAKFLARE</strong>
			<span>device simulator</span>
		</div>
		<div class="meta">
			{schemaVersion === null ? 'backend unavailable' : `local schema v${schemaVersion}`}
		</div>
	</header>

	<main>
		{@render children()}
	</main>
</div>
