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
			<span class="badge badge-accent">Nothing is sent</span>
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
							{result.visitedNodes.length} steps visited · {result.sms.length}
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
										<span class="mono">to {message.to || '(no recipient)'}</span>
										<span class="mono muted">{message.body.length} chars</span>
									</div>
									<p class="sms-body">{message.body || '(empty message)'}</p>
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
									<dd class="mono">{value === '' ? '(empty)' : value}</dd>
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
		border-color: color-mix(in srgb, var(--accent) 28%, var(--line));
		min-width: 0;
	}

	.sim-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--s-2);
		padding: 9px 12px;
		border-bottom: 1px solid var(--line);
		background: color-mix(in srgb, var(--accent) 4%, var(--surface));
		border-radius: var(--r) var(--r) 0 0;
	}

	.sim-title {
		display: flex;
		align-items: center;
		gap: 7px;
		min-width: 0;
		color: var(--ink-2);
	}

	.sim-title h2 {
		font-size: var(--text-base);
		color: var(--ink);
		white-space: nowrap;
	}

	.sim-title .badge {
		margin-left: 2px;
	}

	.sim-help {
		padding: 9px 12px 0;
		font-size: 11.5px;
		line-height: 1.45;
		color: var(--ink-3);
	}

	.sim-form {
		display: grid;
		grid-template-columns: minmax(0, 190px) minmax(0, 1fr);
		gap: 10px;
		padding: 12px;
	}

	.sim-form .field:nth-child(2) {
		min-width: 0;
	}

	.sim-actions {
		grid-column: 1 / -1;
		display: flex;
		align-items: center;
		gap: var(--s-2);
		flex-wrap: wrap;
	}

	.sim-output {
		border-top: 1px solid var(--line);
	}

	.sim-idle {
		display: flex;
		align-items: center;
		gap: 7px;
		padding: 12px;
		font-size: 11.5px;
		color: var(--ink-3);
	}

	.sim-result {
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 12px;
		animation: sim-in 220ms ease both;
	}

	@keyframes sim-in {
		from {
			opacity: 0;
			transform: translateY(-3px);
		}
		to {
			opacity: 1;
			transform: none;
		}
	}

	.sim-verdict {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		padding: 9px 10px;
		border: 1px solid var(--line);
		border-left-width: 2px;
		border-radius: var(--r-sm);
		background: var(--surface-2);
	}

	.sim-verdict.ok {
		border-left-color: var(--ok);
		background: color-mix(in srgb, var(--ok) 6%, var(--surface));
	}

	.sim-verdict.warn {
		border-left-color: var(--warn);
		background: color-mix(in srgb, var(--warn) 7%, var(--surface));
	}

	.sim-verdict.danger {
		border-left-color: var(--danger);
		background: color-mix(in srgb, var(--danger) 6%, var(--surface));
	}

	.verdict-dot {
		width: 6px;
		height: 6px;
		margin-top: 5px;
		border-radius: 50%;
		background: var(--ink-3);
		flex: none;
	}

	.sim-verdict.ok .verdict-dot {
		background: var(--ok);
	}

	.sim-verdict.warn .verdict-dot {
		background: var(--warn);
	}

	.sim-verdict.danger .verdict-dot {
		background: var(--danger);
	}

	.sim-verdict strong {
		display: block;
		font-size: 11.5px;
		font-weight: 600;
		line-height: 1.4;
		color: var(--ink);
	}

	.sim-verdict span {
		display: block;
		margin-top: 2px;
		font-family: var(--font-mono);
		font-size: 9.5px;
		color: var(--ink-3);
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
		padding: 8px 9px;
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		background: var(--surface);
	}

	.sms-meta {
		display: flex;
		justify-content: space-between;
		gap: var(--s-2);
		font-size: 10px;
		color: var(--ink-2);
	}

	.sms-meta .mono {
		font-size: 10px;
	}

	.sms-body {
		margin-top: 4px;
		font-size: 11.5px;
		line-height: 1.5;
		color: var(--ink);
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
		gap: var(--s-3);
		padding: 3px 0;
		border-bottom: 1px dotted var(--line);
	}

	.var-table > div:last-child {
		border-bottom: 0;
	}

	.var-table dt {
		font-size: 10px;
		color: var(--ink-3);
		overflow-wrap: anywhere;
	}

	.var-table dd {
		margin: 0;
		font-size: 10.5px;
		color: var(--ink-2);
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
		border: 1px solid var(--line);
		border-radius: 3px;
		font-size: 8.5px;
		color: var(--ink-3);
		background: var(--surface-2);
	}

	.trace li.ok .trace-index {
		border-color: color-mix(in srgb, var(--ok) 32%, var(--line));
		color: var(--ok);
	}

	.trace li.danger .trace-index {
		border-color: color-mix(in srgb, var(--danger) 32%, var(--line));
		color: var(--danger);
	}

	.trace-node {
		display: block;
		font-family: var(--font-mono);
		font-size: 8.5px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--ink-3);
	}

	.trace-text {
		display: block;
		font-size: 11px;
		color: var(--ink-2);
		overflow-wrap: anywhere;
	}

	.sim-warnings {
		padding: 8px 9px;
		border: 1px dashed color-mix(in srgb, var(--warn) 40%, var(--line));
		border-radius: var(--r-sm);
		background: color-mix(in srgb, var(--warn) 5%, var(--surface));
	}

	.sim-warnings ul {
		margin: 4px 0 0;
		padding-left: 16px;
		font-size: 11px;
		line-height: 1.45;
		color: var(--ink-2);
	}

	@media (max-width: 620px) {
		.sim-form {
			grid-template-columns: minmax(0, 1fr);
		}

		.sim-title {
			flex-wrap: wrap;
		}
	}
</style>
