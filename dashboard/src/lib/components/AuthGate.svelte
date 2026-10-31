<script lang="ts">
	import type { Snippet } from 'svelte';
	import { ROUTES } from '$lib/paths';
	import Brand from './Brand.svelte';

	/**
	 * The pre-session frame: brand, one card, one foot line. Shared by `/invite`
	 * and `/enrol` so the three account screens (login included) sit on the same
	 * 398px column without copying its geometry a third time.
	 */
	let { children }: { children: Snippet } = $props();
</script>

<div class="gate">
	<div class="gate-inner">
		<Brand href={ROUTES.login} />

		<div class="gate-card">
			<div class="gate-accent"></div>
			<div class="gate-body">
				{@render children()}
			</div>
		</div>

		<p class="gate-foot">
			<span class="mono">DAKFLARE</span> · self-hosted SMS gateway console
		</p>
	</div>
</div>

<style>
	.gate {
		min-height: 100vh;
		display: grid;
		place-items: center;
		padding: var(--s-6) var(--s-4);
	}

	.gate-inner {
		width: min(398px, 100%);
	}

	.gate-inner :global(.brand) {
		padding-left: 0;
	}

	.gate-card {
		margin-top: var(--s-5);
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: var(--r-lg);
		box-shadow: var(--shadow);
		overflow: hidden;
	}

	.gate-accent {
		height: 2px;
		background: linear-gradient(90deg, var(--accent), color-mix(in srgb, var(--accent) 25%, transparent));
	}

	.gate-body {
		padding: var(--s-5);
	}

	.gate-body :global(h1) {
		margin-top: 6px;
		font-size: 1.375rem;
		letter-spacing: -0.02em;
	}

	.gate-body :global(.lede) {
		margin-top: var(--s-2);
		margin-bottom: var(--s-5);
		color: var(--ink-3);
		font-size: var(--text-base);
		line-height: 1.55;
	}

	.gate-foot {
		margin-top: var(--s-4);
		text-align: center;
		color: var(--ink-3);
		font-size: 11px;
		letter-spacing: 0.02em;
	}

	.gate-foot .mono {
		letter-spacing: 0.14em;
		font-size: 10px;
	}
</style>
