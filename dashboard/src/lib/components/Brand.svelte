<script lang="ts">
	import { ROUTES } from '$lib/paths';

	let { href = ROUTES.overview }: { href?: string } = $props();
</script>

<a {href} class="brand" aria-label="DakFlare admin overview">
	<span class="brand-mark">
		<svg width="17" height="17" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
			<rect x="2.5" y="9.5" width="2.6" height="4" rx="0.6" fill="currentColor" />
			<rect x="6.7" y="6.5" width="2.6" height="7" rx="0.6" fill="currentColor" />
			<rect x="10.9" y="2.5" width="2.6" height="11" rx="0.6" fill="currentColor" />
		</svg>
	</span>
	<span>
		<span class="brand-name">DakFlare</span>
		<span class="brand-sub">SMS gateway</span>
	</span>
</a>
