<script lang="ts">
	import { app } from '$lib/stores/app.svelte';

	let { scope }: { scope: string } = $props();
	const notice = $derived(app.notices[scope]);
</script>

{#if notice}
	<div
		class="notice"
		data-tone={notice.tone}
		role={notice.tone === 'error' ? 'alert' : 'status'}
		aria-live={notice.tone === 'error' ? 'assertive' : 'polite'}
		aria-atomic="true"
	>
		{notice.text}
	</div>
{/if}
