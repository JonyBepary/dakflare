<script lang="ts">
	import { onMount } from 'svelte';
	import { deleteWorkflow, describeError, getDevices, getWorkflows } from '$lib/api';
	import { formatAbsolute } from '$lib/format';
	import { ROUTES } from '$lib/paths';
	import type { Device, WorkflowSummary } from '$lib/types';
	import { devicePrimary } from '$lib/presence';
	import AutomationHeader from '$lib/components/AutomationHeader.svelte';
	import Badge from '$lib/components/Badge.svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import Notice from '$lib/components/Notice.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import RelativeTime from '$lib/components/RelativeTime.svelte';
	import Spinner from '$lib/components/Spinner.svelte';

	let workflows = $state<WorkflowSummary[]>([]);
	let devices = $state<Device[]>([]);
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

	async function loadDevices() {
		try {
			devices = await getDevices();
		} catch {
			// Labels are a convenience; the scope id is still shown without them.
			devices = [];
		}
	}

	function findDevice(id: string | null): Device | null {
		if (!id) return null;
		return devices.find((device) => device.device_id === id) ?? null;
	}

	function scopeName(id: string | null): string {
		if (!id) return 'every device';
		const device = findDevice(id);
		return device ? devicePrimary(device) : id;
	}

	onMount(() => {
		void load(true);
		void loadDevices();
	});
</script>

<svelte:head>
	<title>Workflows · DakFlare</title>
</svelte:head>

<div class="page">
	<PageHeader
		eyebrow="Automation"
		title="Workflows"
		description="Multi-step replies that run on the phone, so they answer while the gateway is unreachable."
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

	<AutomationHeader active="workflows" />

	<div class="grid-stack">
		{#if notice}
			<div class="flash" aria-live="polite">
				<Notice tone="ok" title="Workflow deleted">{notice}</Notice>
			</div>
		{/if}

		{#if error}
			<div class="bento settle" style="--i: 0">
				<section class="card span-12">
					<Notice tone="danger" title="Could not load workflows">{error}</Notice>
					<div class="row" style="margin-top: 16px">
						<button type="button" class="btn btn-primary" onclick={() => void load()}>
							<Icon name="refresh" size={14} /> Try again
						</button>
					</div>
				</section>
			</div>
		{:else if loading}
			<div class="bento settle" style="--i: 0">
				<section class="card span-12" aria-busy="true" aria-live="polite">
					<span class="sr-only">Loading workflows</span>
					<div class="skeleton" style="height: 16px; width: 110px"></div>
					<div class="loading-rows">
						{#each ['a', 'b', 'c'] as key (key)}
							<div class="skeleton" style="height: 68px"></div>
						{/each}
					</div>
				</section>
			</div>
		{:else if workflows.length === 0}
			<div class="bento settle" style="--i: 0">
				<section class="card span-12">
					<EmptyState
						icon="workflow"
						title="No workflows yet"
						description="A workflow begins when a message arrives. Add a trigger, connect the steps and save it; paired phones receive it on their next flow sync."
					>
						<a class="btn btn-primary" href={ROUTES.workflowEdit}>
							<Icon name="plus" size={14} /> New workflow
						</a>
					</EmptyState>
				</section>
			</div>
		{:else}
			<div class="bento settle" style="--i: 0">
				<section class="card list-card span-12" aria-labelledby="flows-heading">
					<div class="panel-heading">
						<div>
							<h2 id="flows-heading" class="section-title">Saved flows</h2>
							<p class="section-note">
								{workflows.length}
								{workflows.length === 1 ? 'flow' : 'flows'} · {enabledCount} enabled · {totalNodes}
								{totalNodes === 1 ? 'step' : 'steps'} in all
							</p>
						</div>
					</div>

					<!--
						The list endpoint returns id, name, enabled, device_id, updated_at and
						node_count — no version, no cache flag and no last run. Those facts live on
						the detail read, so the row says nothing about them rather than inventing
						a zero.
					-->
					<ul class="flow-list">
						{#each workflows as workflow (workflow.id)}
							<li class="flow-row">
								<div class="flow-main">
									<div class="flow-head">
										<a class="flow-name" href={openHref(workflow)}>{workflow.name}</a>
										{#if workflow.enabled}
											<Badge tone="ok" dot>enabled</Badge>
										{:else}
											<Badge tone="muted">paused</Badge>
										{/if}
									</div>
									<p class="flow-meta">
										<span class="mono meta-item">{workflow.id}</span>
										<span class="meta-item">
											{workflow.node_count}
											{workflow.node_count === 1 ? 'step' : 'steps'}
										</span>
										<span class="meta-item">{scopeName(workflow.device_id)}</span>
										<span class="meta-item" title={formatAbsolute(workflow.updated_at)}>
											saved <RelativeTime value={workflow.updated_at} />
										</span>
									</p>
								</div>

								<div class="flow-actions">
									<a
										class="btn btn-ghost btn-sm"
										href={openHref(workflow)}
										aria-label={`Open ${workflow.name}`}
									>
										Open
									</a>
									<button
										type="button"
										class="btn btn-danger-ghost btn-sm"
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
						Saved flows are delivered to paired phones and run there when a message matches. The
						Worker runs one only when the phone did not report a run; <strong>Simulate</strong>
						previews the path without sending anything.
					</p>
				</section>
			</div>
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
			{deleteTarget.node_count}
			{deleteTarget.node_count === 1 ? 'step' : 'steps'} · scope
			{scopeName(deleteTarget.device_id)}
		</p>
	{/if}
</ConfirmDialog>

<style>
	.list-card {
		padding: 0;
		overflow: hidden;
	}

	.flash :global(.callout) {
		background: var(--df-state-ok-bg);
	}

	.panel-heading {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--df-p-space-3);
		flex-wrap: wrap;
		padding: var(--df-p-space-4) var(--df-p-space-5) var(--df-p-space-3);
	}

	.section-title {
		font-size: var(--df-p-text-lg);
		font-weight: 700;
		letter-spacing: -0.01em;
	}

	.section-note {
		margin-top: 2px;
		font-size: var(--df-p-text-base);
		color: var(--df-text-meta);
	}

	.flow-list {
		margin: 0;
		padding: 0 var(--df-p-space-5);
		list-style: none;
	}

	.flow-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: var(--df-p-space-4);
		padding: var(--df-p-space-4) 0;
		border-top: 1px solid var(--df-border-hairline);
	}

	.flow-row:first-child {
		border-top: 0;
	}

	.flow-main {
		min-width: 0;
	}

	.flow-head {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-2);
		flex-wrap: wrap;
	}

	.flow-name {
		font-size: var(--df-p-text-md);
		font-weight: 600;
		line-height: 1.3;
		color: var(--df-text-primary);
		overflow-wrap: anywhere;
	}

	.flow-name:hover {
		color: var(--df-accent-text);
		text-decoration: underline;
		text-underline-offset: 3px;
	}

	.flow-name:focus-visible {
		outline: 2px solid var(--df-accent-text);
		outline-offset: 2px;
		border-radius: var(--df-p-radius-xs);
	}

	.flow-meta {
		display: flex;
		align-items: baseline;
		column-gap: var(--df-p-space-2);
		row-gap: 2px;
		flex-wrap: wrap;
		margin-top: var(--df-p-space-2);
		font-size: var(--df-p-text-xs);
		color: var(--df-text-meta);
	}

	.flow-meta .mono {
		font-size: var(--df-p-text-xs);
		color: var(--df-text-secondary);
	}

	.meta-item + .meta-item::before {
		content: '·';
		margin-right: var(--df-p-space-2);
		/* A separator is punctuation, not a hairline: in dark the control border
		   is 1.6:1 on the card and the dots vanish between the facts. */
	color: light-dark(
		var(--df-border-control),
		color-mix(in srgb, var(--df-text-meta) 65%, transparent)
	);
	}

	.flow-actions {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-2);
		flex-wrap: wrap;
		justify-content: flex-end;
	}

	.loading-rows {
		display: grid;
		gap: var(--df-p-space-2);
		margin-top: var(--df-p-space-4);
	}

	.panel-note strong {
		color: var(--df-text-secondary);
		font-weight: 600;
	}

	@media (max-width: 820px) {
		.flow-row {
			grid-template-columns: minmax(0, 1fr);
			align-items: start;
		}

		.flow-actions {
			justify-content: flex-start;
		}
	}

	@media (max-width: 720px) {
		.panel-heading,
		.flow-list {
			padding-inline: var(--df-p-space-4);
		}
	}
</style>
