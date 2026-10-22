<script lang="ts">
	import CopyButton from '$lib/components/CopyButton.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import { formatAbsolute, plural } from '$lib/format';
	import { NAME_LIMIT } from '$lib/workflow/graph';

	let {
		name,
		enabled,
		deviceId,
		workflowId,
		version,
		createdAt,
		updatedAt,
		nodeCount,
		edgeCount,
		hasSaved,
		errors,
		showErrors = false,
		onchange
	}: {
		name: string;
		enabled: boolean;
		deviceId: string;
		workflowId: string;
		version: number | null;
		createdAt: number | null;
		updatedAt: number | null;
		nodeCount: number;
		edgeCount: number;
		hasSaved: boolean;
		errors: Record<string, string>;
		showErrors?: boolean;
		onchange: (patch: { name?: string; enabled?: boolean; deviceId?: string }) => void;
	} = $props();

	const nameError = $derived(showErrors ? (errors.name ?? null) : null);
	const scopeError = $derived(showErrors ? (errors.device_id ?? null) : null);
</script>

<section class="panel settings" aria-labelledby="settings-title">
	<div class="settings-head">
		<span class="settings-icon"><Icon name="workflow" size={15} /></span>
		<div>
			<p class="eyebrow">Canvas</p>
			<h2 id="settings-title">Flow settings</h2>
		</div>
	</div>

	<p class="settings-help">
		Select a step to edit it, or change how this whole flow is stored and scoped.
	</p>

	<div class="settings-body">
		<div class="field">
			<label class="label" for="wf-name">Name</label>
			<input
				id="wf-name"
				class="input"
				placeholder="e.g. Order confirmations"
				value={name}
				oninput={(event) => onchange({ name: event.currentTarget.value })}
				aria-invalid={nameError ? 'true' : undefined}
				aria-describedby={nameError ? 'wf-name-error' : 'wf-name-hint'}
				autocomplete="off"
			/>
			{#if nameError}
				<p class="field-error" id="wf-name-error">{nameError}</p>
			{/if}
			<div class="field-foot">
				<span class="hint" id="wf-name-hint">Shown in the workflow list.</span>
				<span class="hint">{name.length} / {NAME_LIMIT}</span>
			</div>
		</div>

		<div class="field">
			<label class="label" for="wf-scope">
				Device scope <span class="optional">optional</span>
			</label>
			<input
				id="wf-scope"
				class="input input-mono"
				placeholder="Fleet-wide"
				value={deviceId}
				oninput={(event) => onchange({ deviceId: event.currentTarget.value })}
				aria-invalid={scopeError ? 'true' : undefined}
				aria-describedby={scopeError ? 'wf-scope-error' : 'wf-scope-hint'}
				spellcheck="false"
				autocomplete="off"
			/>
			{#if scopeError}
				<p class="field-error" id="wf-scope-error">{scopeError}</p>
			{:else}
				<p class="hint" id="wf-scope-hint">
					{deviceId
						? `Only messages on ${deviceId} can start this flow.`
						: 'Leave blank to apply to every paired device.'}
				</p>
			{/if}
		</div>

		<label class="check">
			<input
				type="checkbox"
				checked={enabled}
				onchange={(event) => onchange({ enabled: event.currentTarget.checked })}
			/>
			<span>
				<strong>Enabled</strong>
				<span class="hint" style="display: block">
					Paused flows are kept but are not delivered on the next sync.
				</span>
			</span>
		</label>

		<dl class="meta">
			<div>
				<dt>Flow id</dt>
				<dd class="id-line">
					<span class="mono">{workflowId}</span>
					<CopyButton value={workflowId} label="Copy workflow id" iconOnly />
				</dd>
			</div>
			<div>
				<dt>Version</dt>
				<dd class="mono">{hasSaved ? `v${version ?? 1}` : 'draft'}</dd>
			</div>
			<div>
				<dt>Size</dt>
				<dd class="mono">
					{nodeCount} {plural(nodeCount, 'step')} · {edgeCount}
					{plural(edgeCount, 'connection')}
				</dd>
			</div>
			<div>
				<dt>Updated</dt>
				<dd>{hasSaved ? formatAbsolute(updatedAt) : 'not saved yet'}</dd>
			</div>
			{#if hasSaved && createdAt}
				<div>
					<dt>Created</dt>
					<dd>{formatAbsolute(createdAt)}</dd>
				</div>
			{/if}
		</dl>
	</div>

	<p class="settings-note">
		Saved workflows are delivered to the phone. The phone runs the flow when a message arrives;
		if it did not report a run, the Worker runs the flow instead. Simulate previews a path without
		sending anything.
	</p>
</section>

<style>
	.settings {
		min-width: 0;
	}

	.settings-head {
		display: flex;
		align-items: center;
		gap: 9px;
		padding: 11px 12px 9px;
		border-bottom: 1px solid var(--line);
	}

	.settings-icon {
		display: grid;
		place-items: center;
		width: 28px;
		height: 28px;
		flex: none;
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		background: var(--surface-2);
		color: var(--ink-2);
	}

	.settings-head h2 {
		margin-top: 1px;
		font-size: var(--text-md);
	}

	.settings-help {
		padding: 9px 12px 0;
		font-size: 11.5px;
		line-height: 1.45;
		color: var(--ink-3);
	}

	.settings-body {
		display: flex;
		flex-direction: column;
		gap: 13px;
		padding: 12px;
	}

	.field-foot {
		display: flex;
		justify-content: space-between;
		gap: var(--s-2);
	}

	.id-line {
		display: flex;
		align-items: center;
		gap: 3px;
		min-width: 0;
	}

	.id-line .mono {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 10.5px;
	}

	.meta {
		display: grid;
		gap: 6px;
		margin: 0;
		padding-top: 11px;
		border-top: 1px solid var(--line);
		font-size: 11px;
	}

	.meta > div {
		display: grid;
		grid-template-columns: 58px minmax(0, 1fr);
		gap: var(--s-2);
		align-items: baseline;
	}

	.meta dt {
		font-family: var(--font-mono);
		font-size: 9px;
		letter-spacing: 0.07em;
		text-transform: uppercase;
		color: var(--ink-3);
	}

	.meta dd {
		margin: 0;
		min-width: 0;
		color: var(--ink-2);
		overflow-wrap: anywhere;
	}

	.settings-note {
		padding: 9px 12px;
		border-top: 1px solid var(--line);
		background: color-mix(in srgb, var(--surface-2) 40%, var(--surface));
		border-radius: 0 0 var(--r) var(--r);
		font-size: 10.5px;
		line-height: 1.45;
		color: var(--ink-3);
	}

	.check strong {
		color: var(--ink);
		font-weight: 600;
		font-size: 12px;
	}

	.check .hint {
		margin-top: 2px;
	}
</style>
