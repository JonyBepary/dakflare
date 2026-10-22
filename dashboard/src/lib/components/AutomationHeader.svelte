<script lang="ts">
	import { ROUTES } from '$lib/paths';
	import Icon from './Icon.svelte';

	let { active }: { active: 'rules' | 'workflows' } = $props();
</script>

<section class="automation-head" aria-labelledby="automation-heading">
	<h2 class="sr-only" id="automation-heading">Automation</h2>
	<nav class="auto-tabs" aria-label="Automation sections">
		<a
			class="auto-tab"
			class:is-active={active === 'rules'}
			href={ROUTES.rules}
			aria-current={active === 'rules' ? 'page' : undefined}
		>
			<Icon name="filter" size={13} />
			Rules
		</a>
		<a
			class="auto-tab"
			class:is-active={active === 'workflows'}
			href={ROUTES.workflows}
			aria-current={active === 'workflows' ? 'page' : undefined}
		>
			<Icon name="workflow" size={13} />
			Workflows
		</a>
	</nav>
	<p class="auto-copy">
		Gateway rules are checked first and rate-limited. If one replies, the workflow is skipped;
		otherwise the workflow runs on the phone first.
	</p>
</section>

<style>
	.automation-head {
		display: flex;
		align-items: center;
		gap: var(--s-4);
		flex-wrap: wrap;
		margin-bottom: var(--s-4);
		padding: 9px 10px 9px var(--s-4);
		border: 1px solid var(--line);
		border-radius: var(--r);
		background: color-mix(in srgb, var(--surface-2) 55%, var(--surface));
	}

	.auto-tabs {
		display: inline-flex;
		gap: 2px;
		padding: 2px;
		border: 1px solid var(--line-strong);
		border-radius: var(--r-sm);
		background: var(--surface-2);
		flex: none;
	}

	.auto-tab {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		min-height: 30px;
		padding: 0 11px;
		border-radius: 3px;
		color: var(--ink-3);
		font-size: var(--text-sm);
		font-weight: 500;
		text-decoration: none;
		white-space: nowrap;
		transition:
			background-color 140ms ease,
			color 140ms ease;
	}

	.auto-tab:hover {
		color: var(--ink);
		text-decoration: none;
	}

	.auto-tab.is-active {
		background: var(--seg-active);
		color: var(--ink);
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.12);
	}

	.auto-tab.is-active :global(svg) {
		color: var(--accent);
	}

	.auto-copy {
		flex: 1 1 320px;
		min-width: 0;
		font-size: var(--text-base);
		line-height: 1.5;
		color: var(--ink-2);
	}

	@media (max-width: 620px) {
		.automation-head {
			align-items: flex-start;
			padding: var(--s-3);
		}

		.auto-copy {
			flex-basis: 100%;
		}

		.auto-tab {
			min-height: 44px;
			padding: 0 13px;
		}
	}
</style>
