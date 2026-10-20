<script lang="ts">
	import Icon from './Icon.svelte';

	let {
		value,
		label = 'Copy',
		iconOnly = false,
		size = 'sm'
	}: { value: string; label?: string; iconOnly?: boolean; size?: 'sm' | 'md' } = $props();

	let state = $state<'idle' | 'copied' | 'failed'>('idle');
	let timer: ReturnType<typeof setTimeout> | undefined;

	$effect(() => () => {
		if (timer) clearTimeout(timer);
	});

	async function copy() {
		if (!value) return;
		let ok = false;
		try {
			await navigator.clipboard.writeText(value);
			ok = true;
		} catch {
			ok = legacyCopy(value);
		}
		state = ok ? 'copied' : 'failed';
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => (state = 'idle'), 1800);
	}

	function legacyCopy(text: string): boolean {
		try {
			const area = document.createElement('textarea');
			area.value = text;
			area.setAttribute('readonly', '');
			area.style.position = 'fixed';
			area.style.top = '-1000px';
			area.style.opacity = '0';
			document.body.appendChild(area);
			area.select();
			const ok = document.execCommand('copy');
			document.body.removeChild(area);
			return ok;
		} catch {
			return false;
		}
	}

	const text = $derived(state === 'copied' ? 'Copied' : state === 'failed' ? 'Failed' : label);
	const announcement = $derived(
		state === 'copied' ? 'Copied to clipboard' : state === 'failed' ? 'Copy failed' : ''
	);
</script>

<button
	type="button"
	class="btn btn-ghost {size === 'sm' ? 'btn-sm' : ''} {iconOnly ? 'btn-icon' : ''}"
	onclick={copy}
	disabled={!value}
	aria-label={iconOnly ? label : undefined}
	title={iconOnly ? label : undefined}
>
	<Icon name={state === 'copied' ? 'check' : 'copy'} size={13} />
	{#if !iconOnly}{text}{/if}
</button>
<span class="sr-only" aria-live="polite">{announcement}</span>
