<script lang="ts">
	import { page } from '$app/state';
	import Icon from '$lib/components/Icon.svelte';
	import type { IconName } from '$lib/icons';

	type Item = { href: string; label: string; icon: IconName };

	const items: Item[] = [
		{ href: '/messages', label: 'Threads', icon: 'threads' },
		{ href: '/device', label: 'Device', icon: 'device' },
		{ href: '/flows', label: 'Flows', icon: 'flows' },
		{ href: '/settings', label: 'Settings', icon: 'settings' }
	];

	const path = $derived(page.url.pathname);
	// Threads is the history root. A tab switch away from it pushes one entry;
	// a tab switch between subroutes replaces that entry, so Android's built-in
	// webview back always lands on /messages, and back on /messages exits.
	// Tauri's AppPlugin does the goBack/exit decision; no extra dependency.
	const replaceOnNavigate = $derived(path !== '/messages');
</script>

<nav class="dock" aria-label="Sections">
	{#each items as item (item.href)}
		{@const active = path === item.href || (item.href === '/messages' && path === '/')}
		<a
			href={item.href}
			aria-current={active ? 'page' : undefined}
			data-sveltekit-replacestate={replaceOnNavigate && !active ? '' : undefined}
		>
			<span class="dock-mark" aria-hidden="true">
				<Icon name={item.icon} size={24} />
			</span>
			<span class="dock-label">{item.label}</span>
		</a>
	{/each}
</nav>
