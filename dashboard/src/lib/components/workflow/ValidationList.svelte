<script lang="ts">
	/**
	 * Checks, as the list behind the count.
	 *
	 * The red number in the header used to be a `<span>`: it told an operator that
	 * something was wrong and left them to find it. This is what the number opens.
	 * Every row names the step it is about and takes you to that step's first
	 * field, so a problem is two clicks from being fixed.
	 */
	import Icon from '$lib/components/Icon.svelte';
	import { metaFor, type EditorIssue, type FlowNode } from '$lib/workflow/graph';

	let {
		issues,
		nodes,
		onreveal,
		onclose
	}: {
		issues: EditorIssue[];
		nodes: FlowNode[];
		/** Selects the step and focuses its first field. */
		onreveal: (nodeId: string) => void;
		onclose: () => void;
	} = $props();

	let panelEl = $state<HTMLDivElement | null>(null);
	let expanded = $state(false);

	const visible = $derived(expanded ? issues : issues.slice(0, 6));
	const hiddenCount = $derived(Math.max(issues.length - visible.length, 0));
	const structureCount = $derived(issues.filter((issue) => issue.kind === 'structure').length);
	const fieldCount = $derived(issues.length - structureCount);
	const byId = $derived(new Map(nodes.map((node) => [node.id, node])));

	function stepName(issue: EditorIssue): string {
		if (!issue.nodeId) return 'Flow';
		const node = byId.get(issue.nodeId);
		return node ? metaFor(node.type).title : 'Removed step';
	}

	function onkeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			event.stopPropagation();
			onclose();
		}
	}
</script>

<svelte:window
	onpointerdown={(event) => {
		const target = event.target as Node | null;
		const inside =
			Boolean(target && panelEl?.contains(target)) ||
			(target instanceof Element && Boolean(target.closest('.checks-anchor')));
		if (!inside) onclose();
	}}
/>

<div
	class="checks-pop"
	bind:this={panelEl}
	role="dialog"
	tabindex="-1"
	aria-label="Checks"
	onkeydown={onkeydown}
>
	<div class="checks-head">
		<h2 class="checks-title">
			<Icon name={issues.length > 0 ? 'alert' : 'shield'} size={16} />
			Checks
		</h2>
		<span class="chip" data-tone={issues.length > 0 ? 'danger' : 'ok'}>
			{issues.length === 0 ? 'clear' : `${issues.length} to fix`}
		</span>
		<button type="button" class="btn btn-ghost btn-icon btn-sm close" onclick={onclose} aria-label="Close checks">
			<Icon name="x" size={16} />
		</button>
	</div>

	{#if issues.length === 0}
		<div class="checks-empty">
			<span class="ok-mark" aria-hidden="true"><Icon name="check" size={16} /></span>
			<div>
				<p class="checks-ok">This flow is ready to save.</p>
				<p class="hint">The gateway runs the same checks again when you save.</p>
			</div>
		</div>
	{:else}
		<p class="checks-summary">
			{#if structureCount > 0}
				<span>{structureCount} structural</span>
			{/if}
			{#if structureCount > 0 && fieldCount > 0}
				<span class="sep" aria-hidden="true">·</span>
			{/if}
			{#if fieldCount > 0}
				<span>{fieldCount} field {fieldCount === 1 ? 'problem' : 'problems'}</span>
			{/if}
		</p>

		<ul class="issue-list">
			{#each visible as issue, position (issue.path + issue.message + position)}
				<li>
					{#if issue.nodeId}
						<button
							type="button"
							class="issue"
							onclick={() => onreveal(issue.nodeId as string)}
							title="Go to this step"
						>
							<span class="issue-mark" class:field={issue.kind === 'field'}>{stepName(issue)}</span>
							<span class="issue-text">{issue.message}</span>
							<Icon name="arrow-up-right" size={16} />
						</button>
					{:else}
						<div class="issue is-static">
							<span class="issue-mark">Flow</span>
							<span class="issue-text">{issue.message}</span>
						</div>
					{/if}
				</li>
			{/each}
		</ul>

		{#if hiddenCount > 0 || expanded}
			<button type="button" class="link-btn more" onclick={() => (expanded = !expanded)}>
				{expanded ? 'Show fewer' : `Show ${hiddenCount} more`}
			</button>
		{/if}
	{/if}

	<p class="checks-note">
		Save stays locked while there are problems. Connections run one way, every condition needs both
		branches, and every step must be reachable from the trigger.
	</p>
</div>

<style>
	.checks-pop {
		position: absolute;
		top: calc(100% + 6px);
		right: 0;
		z-index: 60;
		width: min(420px, calc(100vw - 32px));
		border: 1px solid var(--df-border-control);
		border-radius: var(--df-p-radius-md);
		background: var(--df-surface-card);
		box-shadow: var(--df-shadow-dialog);
		overflow: hidden;
		text-align: left;
	}

	.checks-head {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-2);
		padding: var(--df-p-space-2) var(--df-p-space-2) var(--df-p-space-2) var(--df-p-space-3);
		border-bottom: 1px solid var(--df-border-hairline);
		background: var(--df-surface-well);
	}

	.checks-title {
		display: flex;
		align-items: center;
		gap: 6px;
		font-size: var(--df-p-text-base);
		font-weight: 600;
	}

	.checks-head .chip {
		margin-left: auto;
	}

	.close {
		flex: none;
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
		padding: 6px var(--df-p-space-3);
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
		gap: 1px;
		margin: 0;
		padding: var(--df-p-space-1);
		list-style: none;
		max-height: 326px;
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
		outline-offset: -2px;
	}

	.issue.is-static {
		cursor: default;
	}

	.issue :global(svg) {
		margin-top: 2px;
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
		letter-spacing: 0.02em;
		line-height: 1.7;
		flex: none;
		white-space: nowrap;
	}

	.issue-mark.field {
		color: var(--df-text-secondary);
		background: var(--df-surface-well);
	}

	.issue-text {
		min-width: 0;
		font-size: var(--df-p-text-sm);
		line-height: 1.45;
	}

	.more {
		margin: 0 var(--df-p-space-3) var(--df-p-space-2);
		font-size: var(--df-p-text-sm);
	}

	.checks-note {
		padding: var(--df-p-space-2) var(--df-p-space-3);
		border-top: 1px solid var(--df-border-hairline);
		background: var(--df-surface-well);
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
