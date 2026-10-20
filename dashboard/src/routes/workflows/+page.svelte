<script lang="ts">
	import { onMount } from 'svelte';
	import { deleteWorkflow, describeError, getWorkflows } from '$lib/api';
	import { formatAbsolute } from '$lib/format';
	import { ROUTES } from '$lib/paths';
	import type { WorkflowSummary } from '$lib/types';
	import Badge from '$lib/components/Badge.svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import Notice from '$lib/components/Notice.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import RelativeTime from '$lib/components/RelativeTime.svelte';
	import Spinner from '$lib/components/Spinner.svelte';

	let workflows = $state<WorkflowSummary[]>([]);
	let loading = $state(true);
	let refreshing = $state(false);
	let error = $state<string | null>(null);
	let notice = $state<string | null>(null);

	let deleteTarget = $state<WorkflowSummary | null>(null);
	let deleting = $state(false);
	let deleteError = $state<string | null>(null);

	const totalNodes = $derived(workflows.reduce((sum, workflow) => sum + workflow.node_count, 0));
	const enabledCount = $derived(workflows.filter((workflow) => workflow.enabled).length);

	async function load(initial = false) {
		if (!initial) refreshing = true;
		else loading = true;
		error = null;
		try {
			workflows = await getWorkflows();
		} catch (failure) {
			error = describeError(failure);
		} finally {
			loading = false;
			refreshing = false;
		}
	}

	function openDelete(workflow: WorkflowSummary) {
		deleteError = null;
		deleteTarget = workflow;
	}

	async function confirmDelete() {
		if (!deleteTarget || deleting) return;
		deleting = true;
		deleteError = null;
		const target = deleteTarget;
		try {
			await deleteWorkflow(target.id);
			workflows = workflows.filter((workflow) => workflow.id !== target.id);
			notice = `Deleted “${target.name}”.`;
			deleteTarget = null;
		} catch (failure) {
			deleteError = describeError(failure);
		} finally {
			deleting = false;
		}
	}

	function openHref(workflow: WorkflowSummary): string {
		return `${ROUTES.workflowEdit}?id=${encodeURIComponent(workflow.id)}`;
	}

	onMount(() => {
		void load(true);
	});
</script>

<svelte:head>
	<title>Workflows · DakFlare</title>
</svelte:head>

<div class="page">
	<PageHeader
		eyebrow="Automation"
		title="Workflows"
		description="Multi-step message flows: match an incoming text, pull values out of it, branch, and reply. Build one on the canvas, then preview it without sending anything."
	>
		<button
			type="button"
			class="btn"
			onclick={() => void load()}
			disabled={loading || refreshing}
			aria-busy={refreshing}
		>
			{#if refreshing}<Spinner />{:else}<Icon name="refresh" size={14} />{/if}
			Refresh
		</button>
		<a class="btn btn-primary" href={ROUTES.workflowEdit}>
			<Icon name="plus" size={14} /> New workflow
		</a>
	</PageHeader>

	<div class="stack">
		{#if notice}
			<Notice tone="ok" title="Workflow deleted">{notice}</Notice>
		{/if}

		{#if error}
			<section class="panel">
				<div class="panel-body stack">
					<Notice tone="danger" title="Could not load workflows">{error}</Notice>
					<div class="row">
						<button type="button" class="btn btn-primary" onclick={() => void load()}>
							<Icon name="refresh" size={14} /> Try again
						</button>
					</div>
				</div>
			</section>
		{:else if loading}
			<section class="panel" aria-busy="true" aria-live="polite">
				<span class="sr-only">Loading workflows</span>
				<div class="panel-head"><h2 class="panel-title">Saved flows</h2></div>
				<div class="loading-rows">
					{#each ['a', 'b', 'c'] as key (key)}
						<div class="skeleton" style="height: 46px"></div>
					{/each}
				</div>
			</section>
		{:else if workflows.length === 0}
			<section class="panel">
				<EmptyState
					icon="workflow"
					title="No workflows yet"
					description="A workflow begins when a message arrives. Start with a trigger on the canvas, connect the steps, and save it for later."
				>
					<a class="btn btn-primary" href={ROUTES.workflowEdit}>
						<Icon name="plus" size={14} /> New workflow
					</a>
				</EmptyState>
			</section>
		{:else}
			<section class="panel">
				<div class="panel-head">
					<h2 class="panel-title"><Icon name="workflow" size={14} /> Saved flows</h2>
					<span class="panel-meta">
						{workflows.length} {workflows.length === 1 ? 'flow' : 'flows'} · {enabledCount}
						enabled · {totalNodes}
						{totalNodes === 1 ? 'step' : 'steps'}
					</span>
				</div>

				<div class="table-scroll desktop-only">
					<table class="table flows-table">
						<caption class="sr-only">Saved workflows, their scope and size</caption>
						<thead>
							<tr>
								<th scope="col">Flow</th>
								<th scope="col">Scope</th>
								<th scope="col">Status</th>
								<th scope="col" class="num">Steps</th>
								<th scope="col">Updated</th>
								<th scope="col"><span class="sr-only">Actions</span></th>
							</tr>
						</thead>
						<tbody>
							{#each workflows as workflow (workflow.id)}
								<tr>
									<td>
										<a class="cell-main flow-name" href={openHref(workflow)}>
											{workflow.name}
										</a>
										<span class="cell-sub mono">{workflow.id}</span>
									</td>
									<td>
										{#if workflow.device_id}
											<span class="badge badge-muted">device</span>
											<span class="cell-sub mono">{workflow.device_id}</span>
										{:else}
											<span class="badge badge-muted">global</span>
											<span class="cell-sub">every paired device</span>
										{/if}
									</td>
									<td>
										{#if workflow.enabled}
											<Badge tone="ok" dot>enabled</Badge>
										{:else}
											<Badge tone="muted">paused</Badge>
										{/if}
									</td>
									<td class="num">
										<span class="mono">{workflow.node_count}</span>
									</td>
									<td>
										<span class="cell-main"><RelativeTime value={workflow.updated_at} /></span>
										<span class="cell-sub">{formatAbsolute(workflow.updated_at)}</span>
									</td>
									<td>
										<div class="cell-actions">
											<a class="btn btn-ghost btn-sm" href={openHref(workflow)}>
												<Icon name="external" size={12} /> Open
											</a>
											<button
												type="button"
												class="btn btn-danger btn-sm"
												onclick={() => openDelete(workflow)}
												aria-label={`Delete ${workflow.name}`}
											>
												<Icon name="trash" size={12} /> Delete
											</button>
										</div>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>

				<ul class="flow-cards">
					{#each workflows as workflow (workflow.id)}
						<li class="flow-card">
							<div class="card-top">
								<a class="flow-name" href={openHref(workflow)}>{workflow.name}</a>
								{#if workflow.enabled}
									<Badge tone="ok" dot>enabled</Badge>
								{:else}
									<Badge tone="muted">paused</Badge>
								{/if}
							</div>
							<p class="card-id mono">{workflow.id}</p>
							<dl class="card-kv">
								<div>
									<dt>Scope</dt>
									<dd class="mono">
										{workflow.device_id ?? 'global — every device'}
									</dd>
								</div>
								<div>
									<dt>Steps</dt>
									<dd>{workflow.node_count}</dd>
								</div>
								<div>
									<dt>Updated</dt>
									<dd>
										<RelativeTime value={workflow.updated_at} />
										<span class="muted"> · {formatAbsolute(workflow.updated_at)}</span>
									</dd>
								</div>
							</dl>
							<div class="card-actions">
								<a class="btn btn-sm" href={openHref(workflow)}>
									<Icon name="external" size={12} /> Open
								</a>
								<button
									type="button"
									class="btn btn-danger btn-sm"
									onclick={() => openDelete(workflow)}
									aria-label={`Delete ${workflow.name}`}
								>
									<Icon name="trash" size={12} /> Delete
								</button>
							</div>
						</li>
					{/each}
				</ul>

				<p class="panel-note">
					Workflow graphs are saved and validated, but not executed yet. Open a flow and use
					<strong>Simulate</strong> to preview the path and the messages it would send.
				</p>
			</section>
		{/if}
	</div>
</div>

<ConfirmDialog
	open={deleteTarget !== null}
	title="Delete this workflow?"
	confirmLabel="Delete workflow"
	tone="danger"
	pending={deleting}
	error={deleteError}
	onconfirm={() => void confirmDelete()}
	oncancel={() => {
		if (!deleting) {
			deleteTarget = null;
			deleteError = null;
		}
	}}
>
	{#if deleteTarget}
		<p>
			<strong>{deleteTarget.name}</strong> and its whole graph will be removed from the gateway.
			This cannot be undone.
		</p>
		<p class="hint" style="margin-top: 10px">
			{deleteTarget.node_count} {deleteTarget.node_count === 1 ? 'step' : 'steps'} · scope
			{deleteTarget.device_id ?? 'global'}
		</p>
	{/if}
</ConfirmDialog>

<style>
	.flow-name {
		font-weight: 500;
		color: var(--ink);
		text-decoration: none;
		overflow-wrap: anywhere;
	}

	.flow-name:hover {
		color: var(--accent);
		text-decoration: underline;
		text-underline-offset: 3px;
	}

	.flows-table {
		min-width: 760px;
	}

	.flows-table th:nth-child(1) {
		width: 30%;
	}

	.flows-table th:nth-child(2) {
		width: 24%;
	}

	.flows-table th:nth-child(3) {
		width: 10%;
	}

	.flows-table th:nth-child(4) {
		width: 8%;
	}

	.flows-table th:nth-child(5) {
		width: 16%;
	}

	.flow-cards {
		display: none;
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.flow-card {
		padding: var(--s-4);
		border-bottom: 1px solid var(--line);
	}

	.flow-card:last-child {
		border-bottom: 0;
	}

	.card-top {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--s-2);
	}

	.card-id {
		margin-top: 2px;
		font-size: 10px;
		color: var(--ink-3);
		overflow-wrap: anywhere;
	}

	.card-kv {
		display: grid;
		gap: 3px;
		margin: var(--s-3) 0 0;
		font-size: 11.5px;
	}

	.card-kv > div {
		display: grid;
		grid-template-columns: 58px minmax(0, 1fr);
		gap: var(--s-2);
	}

	.card-kv dt {
		padding-top: 2px;
		font-family: var(--font-mono);
		font-size: 9.5px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--ink-3);
	}

	.card-kv dd {
		margin: 0;
		color: var(--ink-2);
		overflow-wrap: anywhere;
	}

	.card-actions {
		display: flex;
		gap: var(--s-2);
		margin-top: var(--s-3);
		flex-wrap: wrap;
	}

	.loading-rows {
		display: grid;
		gap: var(--s-2);
		padding: var(--s-4);
	}

	.panel-note strong {
		color: var(--ink-2);
		font-weight: 600;
	}

	@media (max-width: 820px) {
		.desktop-only {
			display: none;
		}

		.flow-cards {
			display: block;
		}
	}
</style>
