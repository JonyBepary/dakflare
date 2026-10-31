<script lang="ts">
	/**
	 * Daki — the console's one doodle.
	 *
	 * Geometry is the drawing DESIGN_2026 section 3 and
	 * docs/design-review/06-banner-design.md 5.1 specify: a phone slab, a mint
	 * badge with a check, two eyes, a smile and two broadcast arcs on the same
	 * 120x96 grid, one 2.2px ink weight, round caps, one pastel fill, no
	 * gradient and no shadow. It moved here from the Overview's quiet card so the
	 * same character can stand in the two places the design allows: a completed
	 * pairing, and the console being quiet. Never beside an error, a destructive
	 * dialog, a message body, or "no messages yet".
	 *
	 * One correction to the review's numbers, made after rendering at 72: the
	 * badge moves 6px left and 4px down (x20,y38 instead of x26,y34) and the check
	 * re-centres by 4. In the earlier placement the badge's top-right corner met
	 * the left eye exactly, so at 72px the eye read as part of the badge corner and
	 * the face crowded the badge. Nothing else changed: same slab, eyes, smile and
	 * broadcast arcs, same 2.2 weight.
	 */
	let { size = 120, idle = false }: { size?: number; idle?: boolean } = $props();

	const height = $derived(Math.round(((size * 96) / 120) * 100) / 100);
</script>

<svg
	class="mascot"
	class:idle
	width={size}
	height={height}
	viewBox="0 0 120 96"
	fill="none"
	aria-hidden="true"
	focusable="false"
>
	<!-- The phone. -->
	<rect x="34" y="10" width="52" height="76" rx="14" stroke="currentColor" stroke-width="2.2" />
	<!-- The one pastel fill: the check that is true in this state and nowhere else. -->
	<rect
		x="20"
		y="38"
		width="26"
		height="34"
		rx="8"
		fill="var(--df-state-ok-bg)"
		stroke="currentColor"
		stroke-width="2.2"
	/>
	<path
		d="M28 53l4 4 8-9"
		stroke="var(--df-state-ok-ink)"
		stroke-width="2.6"
		stroke-linecap="round"
		stroke-linejoin="round"
	/>
	<!-- Face. -->
	<circle cx="52" cy="34" r="2.6" fill="currentColor" />
	<circle cx="68" cy="34" r="2.6" fill="currentColor" />
	<path d="M52 44c3.4 4 12.6 4 16 0" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" />
	<!-- Broadcast. -->
	<path d="M86 26c6 0 10 4 10 10" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
	<path d="M96 44c3 0 5 2 5 5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
</svg>

<style>
	.mascot {
		display: block;
		color: var(--df-text-primary);
		overflow: visible;
	}

	/* DESIGN_2026 section 2: mascot-idle, empty state only, one instance per page,
	   and off entirely when the operator asked for less motion. */
	.idle {
		animation: mascot-idle 4s ease-in-out infinite alternate;
	}

	@keyframes mascot-idle {
		from {
			transform: translateY(0);
		}
		to {
			transform: translateY(-3px);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.idle {
			animation: none;
		}
	}
</style>
