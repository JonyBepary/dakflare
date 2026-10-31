<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { NODE_META, type FlowNode } from '$lib/workflow/graph';
	import type { SimulationInput, SimulationResult } from '$lib/workflow/simulate';

	let {
		result,
		nodes,
		onrun,
		onclose,
		onclear
	}: {
		result: SimulationResult | null;
		nodes: FlowNode[];
		onrun: (input: SimulationInput) => void;
		onclose: () => void;
		onclear: () => void;
	} = $props();

	let sender = $state('+15551234567');
	let body = $state('ORDER A-1042');
	let running = $state(false);

	const nodeMap = $derived(new Map(nodes.map((node) => [node.id, node])));
	const captured = $derived(
		result
			? Object.entries(result.variables).filter(
					([name]) => name !== 'sender' && name !== 'body' && name !== 'received_at'
				)
			: []
	);

	const tone = $derived(
		!result
			? 'muted'
			: result.outcome === 'delivered'
				? 'ok'
				: result.outcome === 'error'
					? 'danger'
					: 'warn'
	);

	async function run() {
		if (running) return;
		running = true;
		// A short beat so the button state is visible; the interpreter itself is synchronous.
		await Promise.resolve();
		onrun({ sender, body });
		running = false;
	}

	function labelFor(nodeId: string): string {
		const node = nodeMap.get(nodeId);
		return node ? NODE_META[node.type].title : 'Step';
	}
</script>

<section class="panel simulation" aria-labelledby="simulation-title">
	<div class="sim-head">
		<div class="sim-title">
			<Icon name="activity" size={14} />
			<h2 id="simulation-title">Preview run</h2>
			<span class="chip" data-tone="info">Nothing is sent</span>
		</div>
		<button type="button" class="btn btn-ghost btn-icon btn-sm" onclick={onclose} aria-label="Close preview">
			<Icon name="x" size={14} />
		</button>
	</div>

	<p class="sim-help">
		Run the flow in your browser with a sample message. The canvas highlights the path; no SMS
		leaves the gateway.
	</p>

	<form
		class="sim-form"
		onsubmit={(event) => {
			event.preventDefault();
			void run();
		}}
	>
		<div class="field">
			<label class="label" for="sim-sender">Sample sender</label>
			<input
				id="sim-sender"
				class="input input-mono"
				bind:value={sender}
				aria-label="Sample sender"
				placeholder="+15551234567"
				autocomplete="off"
				spellcheck="false"
			/>
		</div>
		<div class="field">
			<label class="label" for="sim-body">Sample message</label>
			<textarea
				id="sim-body"
				class="input"
				rows="2"
				bind:value={body}
				aria-label="Sample message"
				placeholder="ORDER A-1042"
				spellcheck="false"
			></textarea>
		</div>
		<div class="sim-actions">
			<button type="submit" class="btn btn-primary btn-sm" disabled={running} aria-busy={running}>
				<Icon name="activity" size={12} />
				Run preview
			</button>
			{#if result}
				<button type="button" class="btn btn-ghost btn-sm" onclick={onclear}>Clear result</button>
			{/if}
			<span class="spacer"></span>
			<span class="hint">Runs against the draft, not the saved copy.</span>
		</div>
	</form>

	<div class="sim-output" aria-live="polite" aria-atomic="false">
		{#if !result}
			<p class="sim-idle">
				<Icon name="info" size={13} />
				No preview yet. Enter a message and run it to see where the flow goes.
			</p>
		{:else}
			<div class="sim-result">
				<div class="sim-verdict {tone}">
					<span class="verdict-dot" aria-hidden="true"></span>
					<div>
						<strong>{result.summary}</strong>
						<span>
							{result.visitedNodes.length}
							{result.visitedNodes.length === 1 ? 'step' : 'steps'} visited · {result.sms.length}
							{result.sms.length === 1 ? 'message' : 'messages'} prepared
						</span>
					</div>
				</div>

				{#if result.sms.length > 0}
					<div class="sim-block">
						<p class="eyebrow">Would send</p>
						<ul class="sms-list">
							{#each result.sms as message, index (message.nodeId + index)}
								<li class="sms-card">
									<div class="sms-meta">
										<span class="mono">to {message.to || 'no recipient'}</span>
										<span class="mono muted">{message.body.length} chars</span>
									</div>
									<p class="sms-body">{message.body || 'empty message'}</p>
								</li>
							{/each}
						</ul>
					</div>
				{/if}

				<div class="sim-block">
					<p class="eyebrow">Captured variables</p>
					{#if captured.length > 0}
						<dl class="var-table">
							{#each captured as [name, value] (name)}
								<div>
									<dt class="mono">{name}</dt>
									<dd class="mono">{value === '' ? 'empty' : value}</dd>
								</div>
							{/each}
						</dl>
					{:else}
						<p class="hint">No capture groups ran on this path.</p>
					{/if}
				</div>

				<div class="sim-block">
					<p class="eyebrow">Trace</p>
					<ol class="trace">
						{#each result.steps as step, index (step.nodeId + step.text + index)}
							<li class={step.tone}>
								<span class="trace-index mono">{index + 1}</span>
								<div>
									<span class="trace-node">{labelFor(step.nodeId)}</span>
									<span class="trace-text">{step.text}</span>
								</div>
							</li>
						{/each}
					</ol>
				</div>

				{#if result.warnings.length > 0}
					<div class="sim-warnings">
						<p class="eyebrow">Worth knowing</p>
						<ul>
							{#each result.warnings as warning (warning)}
								<li>{warning}</li>
							{/each}
						</ul>
					</div>
				{/if}
			</div>
		{/if}
	</div>
</section>

<style>
	.simulation {
		min-width: 0;
		border-radius: var(--df-p-radius-lg);
		overflow: hidden;
	}

	.sim-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--df-p-space-2);
		padding: var(--df-p-space-2) var(--df-p-space-3);
		border-bottom: 1px solid var(--df-border-hairline);
		background: var(--df-surface-well);
		border-radius: var(--df-p-radius-lg) var(--df-p-radius-lg) 0 0;
	}

	.sim-title {
		display: flex;
		align-items: center;
		gap: 7px;
		min-width: 0;
		color: var(--df-text-secondary);
	}

	.sim-title h2 {
		font-size: var(--df-p-text-base);
		color: var(--df-text-primary);
		white-space: nowrap;
	}

	.sim-title .chip {
		margin-left: 2px;
	}

	.sim-help {
		padding: var(--df-p-space-2) var(--df-p-space-3) 0;
		font-size: var(--df-p-text-sm);
		line-height: 1.45;
		color: var(--df-text-meta);
	}

	.sim-form {
		display: grid;
		grid-template-columns: minmax(0, 190px) minmax(0, 1fr);
		gap: var(--df-p-space-3);
		padding: var(--df-p-space-3);
	}

	.sim-form .field:nth-child(2) {
		min-width: 0;
	}

	.sim-actions {
		grid-column: 1 / -1;
		display: flex;
		align-items: center;
		gap: var(--df-p-space-2);
		flex-wrap: wrap;
	}

	.sim-output {
		border-top: 1px solid var(--df-border-hairline);
	}

	.sim-idle {
		display: flex;
		align-items: center;
		gap: 7px;
		padding: var(--df-p-space-3);
		font-size: var(--df-p-text-sm);
		color: var(--df-text-meta);
	}

	.sim-result {
		display: flex;
		flex-direction: column;
		gap: var(--df-p-space-3);
		padding: var(--df-p-space-3);
		/* The motion set, not a local keyframe: settle, final state under reduced motion. */
		animation: settle var(--df-p-dur-settle) var(--df-p-ease-standard) both;
	}

	.sim-verdict {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		padding: var(--df-p-space-2) var(--df-p-space-3);
		border: 1px solid transparent;
		border-radius: var(--df-p-radius-sm);
		background: var(--df-surface-well);
		box-shadow: inset 3px 0 0 var(--df-text-meta);
	}

	.sim-verdict.ok {
		border-color: var(--df-c-tint-edge-ok);
		background: var(--df-state-ok-bg);
		box-shadow: inset 3px 0 0 var(--df-state-ok-ink);
	}

	.sim-verdict.warn {
		border-color: var(--df-c-tint-edge-warn);
		background: var(--df-state-warn-bg);
		box-shadow: inset 3px 0 0 var(--df-state-warn-ink);
	}

	.sim-verdict.danger {
		border-color: var(--df-c-tint-edge-danger);
		background: var(--df-state-danger-bg);
		box-shadow: inset 3px 0 0 var(--df-state-danger-ink);
	}

	.verdict-dot {
		width: 6px;
		height: 6px;
		margin-top: 5px;
		border-radius: 50%;
		background: var(--df-text-meta);
		flex: none;
	}

	.sim-verdict.ok .verdict-dot {
		background: var(--df-state-ok-ink);
	}

	.sim-verdict.warn .verdict-dot {
		background: var(--df-state-warn-ink);
	}

	.sim-verdict.danger .verdict-dot {
		background: var(--df-state-danger-ink);
	}

	.sim-verdict strong {
		display: block;
		font-size: 11.5px;
		font-weight: 600;
		line-height: 1.4;
		color: var(--df-text-primary);
	}

	.sim-verdict span {
		display: block;
		margin-top: 2px;
		font-family: var(--df-p-font-mono);
		font-size: 9.5px;
		color: var(--df-text-meta);
	}

	.sim-block {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.sms-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.sms-card {
		padding: var(--df-p-space-2) var(--df-p-space-3);
		border-radius: var(--df-p-radius-sm);
		background: var(--df-surface-well);
	}

	.sms-meta {
		display: flex;
		justify-content: space-between;
		gap: var(--df-p-space-2);
		font-size: 10px;
		color: var(--df-text-secondary);
	}

	.sms-meta .mono {
		font-size: 10px;
	}

	.sms-body {
		margin-top: 4px;
		font-size: 11.5px;
		line-height: 1.5;
		color: var(--df-text-primary);
		overflow-wrap: anywhere;
	}

	.var-table {
		display: grid;
		gap: 2px;
		margin: 0;
	}

	.var-table > div {
		display: grid;
		grid-template-columns: minmax(70px, auto) minmax(0, 1fr);
		gap: var(--df-p-space-3);
		padding: 3px 0;
		border-bottom: 1px dotted var(--df-border-hairline);
	}

	.var-table > div:last-child {
		border-bottom: 0;
	}

	.var-table dt {
		font-size: 10px;
		color: var(--df-text-meta);
		overflow-wrap: anywhere;
	}

	.var-table dd {
		margin: 0;
		font-size: 10.5px;
		color: var(--df-text-secondary);
		overflow-wrap: anywhere;
	}

	.trace {
		display: flex;
		flex-direction: column;
		gap: 5px;
		margin: 0;
		padding: 0;
		list-style: none;
		max-height: 210px;
		overflow-y: auto;
		overscroll-behavior: contain;
	}

	.trace li {
		display: flex;
		align-items: flex-start;
		gap: 7px;
		line-height: 1.4;
	}

	.trace-index {
		display: grid;
		place-items: center;
		width: 16px;
		height: 16px;
		flex: none;
		margin-top: 1px;
		border: 1px solid var(--df-border-hairline);
		border-radius: 3px;
		font-size: 8.5px;
		color: var(--df-text-meta);
		background: var(--df-surface-well);
	}

	.trace li.ok .trace-index {
		border-color: color-mix(in srgb, var(--df-state-ok-ink) 32%, var(--df-border-hairline));
		color: var(--df-state-ok-ink);
	}

	.trace li.danger .trace-index {
		border-color: color-mix(in srgb, var(--df-state-danger-ink) 32%, var(--df-border-hairline));
		color: var(--df-state-danger-ink);
	}

	.trace-node {
		display: block;
		font-family: var(--df-p-font-mono);
		font-size: 8.5px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--df-text-meta);
	}

	.trace-text {
		display: block;
		font-size: 11px;
		color: var(--df-text-secondary);
		overflow-wrap: anywhere;
	}

	.sim-warnings {
		padding: var(--df-p-space-2) var(--df-p-space-3);
		border: 1px solid var(--df-c-tint-edge-warn);
		border-radius: var(--df-p-radius-sm);
		background: var(--df-state-warn-bg);
	}

	.sim-warnings ul {
		margin: 4px 0 0;
		padding-left: 16px;
		font-size: 11px;
		line-height: 1.45;
		color: var(--df-text-secondary);
	}

	@media (max-width: 620px) {
		.sim-form {
			grid-template-columns: minmax(0, 1fr);
		}

		.sim-title {
			flex-wrap: wrap;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.sim-result {
			animation: none;
		}
	}
</style>
