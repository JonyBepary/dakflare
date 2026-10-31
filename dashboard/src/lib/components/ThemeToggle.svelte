<script lang="ts">
	import { onMount } from 'svelte';
	import Icon from './Icon.svelte';

	let dark = $state(false);
	let ready = $state(false);

	onMount(() => {
		const attr = document.documentElement.dataset.theme;
		dark =
			attr === 'dark' || (!attr && window.matchMedia('(prefers-color-scheme: dark)').matches);
		ready = true;
	});

	function toggle() {
		dark = !dark;
		document.documentElement.dataset.theme = dark ? 'dark' : 'light';
		try {
			localStorage.setItem('dakflare-theme', dark ? 'dark' : 'light');
		} catch {
			// A blocked storage API should not break the toggle.
		}
	}
</script>

<button
	type="button"
	class="btn btn-icon btn-sm"
	onclick={toggle}
	aria-label={dark ? 'Use light theme' : 'Use dark theme'}
	title={dark ? 'Use light theme' : 'Use dark theme'}
>
	{#if ready}<Icon name={dark ? 'sun' : 'moon'} size={16} />{/if}
</button>
