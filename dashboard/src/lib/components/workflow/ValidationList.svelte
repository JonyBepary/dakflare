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
			class="badge {issues.length > 0 ? 'badge-danger' : 'badge-ok'}"
			role="status"
			aria-live="polite"
			aria-label={`${issues.length} ${issues.length === 1 ? 'problem' : 'problems'}`}
		>
			{issues.length === 0 ? 'clear' : `${issues.length} to fix`}
		</span>
	</div>

	{#if issues.length === 0}
		<div class="checks-empty">
			<Icon name="check" size={15} />
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
	}

	.checks-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--s-2);
		padding: 9px 12px;
		border-bottom: 1px solid var(--line);
		background: color-mix(in srgb, var(--surface-2) 55%, var(--surface));
		border-radius: var(--r) var(--r) 0 0;
	}

	.checks-empty {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		padding: 12px;
		color: var(--ok);
	}

	.checks-empty :global(svg) {
		margin-top: 1px;
	}

	.checks-ok {
		font-size: 11.5px;
		font-weight: 500;
		color: var(--ink);
	}

	.checks-empty .hint {
		margin-top: 2px;
	}

	.checks-summary {
		display: flex;
		gap: 5px;
		padding: 7px 12px;
		font-family: var(--font-mono);
		font-size: 9.5px;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--ink-3);
		border-bottom: 1px solid var(--line);
	}

	.issue-list {
		display: flex;
		flex-direction: column;
		margin: 0;
		padding: 4px;
		list-style: none;
		max-height: 232px;
		overflow-y: auto;
		overscroll-behavior: contain;
	}

	.issue {
		display: flex;
		align-items: flex-start;
		gap: 6px;
		width: 100%;
		padding: 6px;
		border: 0;
		border-radius: 3px;
		background: transparent;
		text-align: left;
		color: var(--ink-2);
	}

	.issue:hover:not(.is-static) {
		background: var(--surface-2);
	}

	.issue.is-static {
		cursor: default;
	}

	.issue :global(svg) {
		margin-top: 3px;
		flex: none;
		color: var(--ink-3);
	}

	.issue-mark {
		margin-top: 1px;
		padding: 0 4px;
		border: 1px solid color-mix(in srgb, var(--danger) 30%, var(--line));
		border-radius: 3px;
		background: color-mix(in srgb, var(--danger) 6%, var(--surface));
		color: var(--danger);
		font-family: var(--font-mono);
		font-size: 8px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		line-height: 1.6;
		flex: none;
	}

	.issue-mark.field {
		color: var(--ink-3);
		border-color: var(--line);
		background: var(--surface-2);
	}

	.issue-text {
		display: flex;
		flex-direction: column;
		gap: 1px;
		min-width: 0;
		font-size: 11px;
		line-height: 1.4;
	}

	.issue-path {
		font-size: 9px;
		color: var(--ink-3);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.more {
		margin: 0 12px 8px;
		font-size: 10.5px;
	}

	.checks-note {
		padding: 8px 12px;
		border-top: 1px solid var(--line);
		background: color-mix(in srgb, var(--surface-2) 40%, var(--surface));
		border-radius: 0 0 var(--r) var(--r);
		font-size: 10px;
		line-height: 1.5;
		color: var(--ink-3);
	}
</style>
