<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import type { EditorIssue } from '$lib/workflow/graph';

	let {
		issues,
		onselect
	}: {
		issues: EditorIssue[];
		onselect: (nodeId: string) => void;
	} = $props();

	let expanded = $state(false);
	const visible = $derived(expanded ? issues : issues.slice(0, 4));
	const hiddenCount = $derived(Math.max(issues.length - visible.length, 0));

	const structureCount = $derived(issues.filter((issue) => issue.kind === 'structure').length);
	const fieldCount = $derived(issues.length - structureCount);
</script>

<section class="panel checks" aria-labelledby="checks-title">
	<div class="checks-head">
		<h2 class="panel-title" id="checks-title">
			<Icon name={issues.length > 0 ? 'alert' : 'shield'} size={14} />
			Checks
		</h2>
		<span
			class="chip"
			data-tone={issues.length > 0 ? 'danger' : 'ok'}
			role="status"
			aria-live="polite"
			aria-label={`${issues.length} ${issues.length === 1 ? 'problem' : 'problems'}`}
		>
			{issues.length === 0 ? 'clear' : `${issues.length} to fix`}
		</span>
	</div>

	{#if issues.length === 0}
		<div class="checks-empty">
			<span class="ok-mark" aria-hidden="true"><Icon name="check" size={13} /></span>
			<div>
				<p class="checks-ok">This flow is ready to save.</p>
				<p class="hint">The gateway runs the same checks again when you save.</p>
			</div>
		</div>
	{:else}
		<div class="checks-summary">
			{#if structureCount > 0}
				<span>{structureCount} structural</span>
			{/if}
			{#if structureCount > 0 && fieldCount > 0}
				<span class="sep" aria-hidden="true">·</span>
			{/if}
			{#if fieldCount > 0}
				<span>{fieldCount} field {fieldCount === 1 ? 'problem' : 'problems'}</span>
			{/if}
		</div>

		<ul class="issue-list">
			{#each visible as issue, position (issue.path + issue.message + position)}
				<li>
					{#if issue.nodeId}
						<button
							type="button"
							class="issue"
							onclick={() => onselect(issue.nodeId as string)}
							title="Select the step this is about"
						>
							<span class="issue-mark" class:field={issue.kind === 'field'}>
								{issue.kind === 'structure' ? 'flow' : 'field'}
							</span>
							<span class="issue-text">
								{issue.message}
								<span class="issue-path mono">{issue.path}</span>
							</span>
							<Icon name="arrow-up-right" size={11} />
						</button>
					{:else}
						<div class="issue is-static">
							<span class="issue-mark">{issue.kind === 'structure' ? 'flow' : 'field'}</span>
							<span class="issue-text">
								{issue.message}
								<span class="issue-path mono">{issue.path || 'graph'}</span>
							</span>
						</div>
					{/if}
				</li>
			{/each}
		</ul>

		{#if hiddenCount > 0 || expanded}
			<button type="button" class="link-btn more" onclick={() => (expanded = !expanded)}>
				{#if expanded}
					Show fewer
				{:else}
					Show {hiddenCount} more
				{/if}
			</button>
		{/if}
	{/if}

	<p class="checks-note">
		Save stays locked while there are problems. Connections must run one way, every condition needs
		both branches, and every step must be reachable from the trigger.
	</p>
</section>

<style>
	.checks {
		min-width: 0;
		border-radius: var(--df-p-radius-lg);
	}

	.checks-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--df-p-space-2);
		padding: var(--df-p-space-2) var(--df-p-space-3);
		border-bottom: 1px solid var(--df-border-hairline);
		background: var(--df-surface-well);
		border-radius: var(--df-p-radius-lg) var(--df-p-radius-lg) 0 0;
	}

	.checks-empty {
		display: flex;
		align-items: flex-start;
		gap: var(--df-p-space-2);
		padding: var(--df-p-space-3);
	}

	.ok-mark {
		display: grid;
		place-items: center;
		width: 20px;
		height: 20px;
		flex: none;
		border-radius: var(--df-p-radius-pill);
		background: var(--df-state-ok-bg);
		color: var(--df-state-ok-ink);
	}

	.checks-ok {
		font-size: var(--df-p-text-base);
		font-weight: 600;
		color: var(--df-text-primary);
	}

	.checks-empty .hint {
		margin-top: 2px;
	}

	.checks-summary {
		display: flex;
		gap: 5px;
		padding: var(--df-p-space-2) var(--df-p-space-3);
		font-family: var(--df-p-font-mono);
		font-size: var(--df-p-text-2xs);
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--df-text-meta);
		border-bottom: 1px solid var(--df-border-hairline);
	}

	.issue-list {
		display: flex;
		flex-direction: column;
		gap: 2px;
		margin: 0;
		padding: var(--df-p-space-1);
		list-style: none;
		max-height: 232px;
		overflow-y: auto;
		overscroll-behavior: contain;
	}

	.issue {
		display: flex;
		align-items: flex-start;
		gap: var(--df-p-space-2);
		width: 100%;
		padding: 6px;
		border: 0;
		border-radius: var(--df-p-radius-xs);
		background: transparent;
		text-align: left;
		color: var(--df-text-secondary);
		transition: background-color 120ms ease;
	}

	.issue:hover:not(.is-static) {
		background: var(--df-surface-well);
	}

	.issue:focus-visible {
		outline: 2px solid var(--df-accent-text);
		outline-offset: 1px;
	}

	.issue.is-static {
		cursor: default;
	}

	.issue :global(svg) {
		margin-top: 3px;
		flex: none;
		color: var(--df-text-meta);
	}

	.issue-mark {
		margin-top: 1px;
		padding: 0 5px;
		border-radius: var(--df-p-radius-xs);
		background: var(--df-state-danger-bg);
		color: var(--df-state-danger-ink);
		font-family: var(--df-p-font-mono);
		font-size: var(--df-p-text-2xs);
		letter-spacing: 0.04em;
		line-height: 1.6;
		flex: none;
	}

	.issue-mark.field {
		color: var(--df-text-meta);
		background: var(--df-surface-well);
	}

	.issue-text {
		display: flex;
		flex-direction: column;
		gap: 1px;
		min-width: 0;
		font-size: var(--df-p-text-sm);
		line-height: 1.4;
	}

	.issue-path {
		font-size: var(--df-p-text-2xs);
		color: var(--df-text-meta);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.more {
		margin: 0 var(--df-p-space-3) var(--df-p-space-2);
		font-size: var(--df-p-text-sm);
	}

	.checks-note {
		padding: var(--df-p-space-2) var(--df-p-space-3);
		border-top: 1px solid var(--df-border-hairline);
		background: var(--df-surface-well);
		border-radius: 0 0 var(--df-p-radius-lg) var(--df-p-radius-lg);
		font-size: var(--df-p-text-2xs);
		line-height: 1.5;
		color: var(--df-text-meta);
	}

	@media (prefers-reduced-motion: reduce) {
		.issue {
			transition: none;
		}
	}
</style>
