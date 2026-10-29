<script lang="ts">
	import { ROUTES } from '$lib/paths';

	let { href = ROUTES.overview }: { href?: string } = $props();
</script>

<!--
	The brand plate is the app icon at 34px: the same drawing as
	dashboard/src/lib/assets/favicon.svg and as the Android adaptive icon's
	foreground, seen through the 72dp window (viewBox 18 18 72 72). No second
	mark; the three-bar glyph this replaced agreed with nothing.

	Two variants and no third, per docs/design-review/06-banner-design.md 3.1:
	on cream chrome the ink field (cream slab, coral arc), on dark chrome the
	launcher's cream field (ink slab, coral arc). Both are the same drawing with
	the two fills swapped.
-->
<a {href} class="brand" aria-label="DakFlare admin overview">
	<span class="brand-mark">
		<svg width="27" height="27" viewBox="18 18 72 72" aria-hidden="true" focusable="false">
			<rect class="slab" x="41" y="40" width="26" height="42" rx="9" />
			<path class="arc" d="M46.5 34a7.5 7.5 0 0 1 15 0" stroke-width="5.5" stroke-linecap="round" />
		</svg>
	</span>
	<span>
		<span class="brand-name">DakFlare</span>
		<span class="brand-sub">SMS gateway</span>
	</span>
</a>

<style>
	.brand-mark {
		--mark-field: var(--df-p-umber-900);
		--mark-slab: var(--df-p-cream-100);
		background: var(--mark-field);
	}

	.brand-mark .slab {
		fill: var(--mark-slab);
	}

	.brand-mark .arc {
		fill: none;
		stroke: var(--df-p-coral-500);
	}

	/* Dark chrome: the launcher variant, so a dark sidebar is not a dark tile on
	   a dark page. The `prefers-color-scheme` and `data-theme` copies exist
	   because app.css ships both; edit them together. */
	@media (prefers-color-scheme: dark) {
		:global(:root:not([data-theme='light'])) .brand-mark {
			--mark-field: var(--df-p-cream-100);
			--mark-slab: var(--df-p-umber-900);
		}
	}

	:global(:root[data-theme='dark']) .brand-mark {
		--mark-field: var(--df-p-cream-100);
		--mark-slab: var(--df-p-umber-900);
	}
</style>
