<script lang="ts">
	import { ROUTES } from '$lib/paths';
	import Icon from './Icon.svelte';

	let { active }: { active: 'rules' | 'workflows' } = $props();

	// CONSOLE_UX §1: one pipeline, two authored forms. The page says which form is
	// being edited and links across to the other; it never implies a third surface.
	const other = $derived(
		active === 'rules'
			? { href: ROUTES.workflows, label: 'How flows fit' }
			: { href: ROUTES.rules, label: 'How rules fit' }
	);
</script>

<section class="band" aria-labelledby="automation-heading">
	<h2 class="sr-only" id="automation-heading">Automation</h2>

	<nav class="tabs" aria-label="Automation sections">
		<a
			class="tab"
			class:is-active={active === 'rules'}
			href={ROUTES.rules}
			aria-current={active === 'rules' ? 'page' : undefined}
		>
			<Icon name="filter" size={14} />
			Rules
		</a>
		<a
			class="tab"
			class:is-active={active === 'workflows'}
			href={ROUTES.workflows}
			aria-current={active === 'workflows' ? 'page' : undefined}
		>
			<Icon name="workflow" size={14} />
			Workflows
		</a>
	</nav>

	<p class="sentence">
		Rules answer first on the gateway; when none matches, flows run on the phone.
	</p>

	<a class="cross" href={other.href}>
		{other.label}
		<Icon name="arrow-up-right" size={12} />
	</a>
</section>

<style>
	.band {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-4);
		flex-wrap: wrap;
		margin-bottom: var(--df-p-space-5);
		padding: var(--df-p-space-2);
		border-radius: var(--df-p-radius-md);
		background: var(--df-surface-well);
	}

	.tabs {
		display: inline-flex;
		gap: 2px;
		flex: none;
	}

	.tab {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		min-height: 32px;
		padding: 0 12px;
		border-radius: var(--df-p-radius-sm);
		color: var(--df-text-meta);
		font-size: var(--df-p-text-base);
		font-weight: 600;
		text-decoration: none;
		white-space: nowrap;
		transition:
			background-color 140ms ease,
			color 140ms ease;
	}

	.tab:hover {
		background: color-mix(in srgb, var(--df-surface-card) 60%, transparent);
		color: var(--df-text-primary);
		text-decoration: none;
	}

	.tab:focus-visible {
		outline: 2px solid var(--df-accent-text);
		outline-offset: 2px;
	}

	.tab.is-active {
		background: var(--df-surface-card);
		color: var(--df-text-primary);
		box-shadow: var(--df-shadow-card);
	}

	.tab.is-active :global(svg) {
		color: var(--df-accent-text);
	}

	.sentence {
		flex: 1 1 320px;
		min-width: 0;
		font-size: var(--df-p-text-base);
		line-height: 1.5;
		color: var(--df-text-secondary);
	}

	.cross {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		min-height: 32px;
		padding: 0 var(--df-p-space-2);
		border-radius: var(--df-p-radius-sm);
		color: var(--df-accent-text);
		font-size: var(--df-p-text-base);
		font-weight: 600;
		white-space: nowrap;
	}

	.cross:focus-visible {
		outline: 2px solid var(--df-accent-text);
		outline-offset: 2px;
	}

	@media (max-width: 720px) {
		.band {
			align-items: flex-start;
			gap: var(--df-p-space-3);
			padding: var(--df-p-space-3);
		}

		.sentence {
			flex-basis: 100%;
			order: 3;
		}

		.cross {
			margin-left: auto;
			order: 2;
		}

		.tab {
			min-height: 44px;
			padding: 0 14px;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.tab {
			transition: none;
		}
	}
</style>
