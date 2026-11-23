<script lang="ts">
	/**
	 * What the agent is doing, in chips.
	 *
	 * The turn already holds two lists and only one of them was visible: `steps` are
	 * the runs that settled, `queue` is the batch the gateway announced and has not
	 * finished. The plan line counted the queue; nothing named it. These chips name
	 * every call — settled and queued — in the order the gateway announced them, so a
	 * slow telemetry run is a chip that says `queued`, not a counter.
	 *
	 * They are labels, not controls. There is nothing to press: the trace below holds
	 * the rows, the reasons and the stamps, and a chip that opened it would be a
	 * second, worse way to read the same ledger. `title` carries the plain sentence.
	 *
	 * Shown only when there is more than one call to tell apart. A single successful
	 * run is the one-line note `AssistantTrace` draws, and two renderings of the same
	 * fact would be noise.
	 */
	import { agentStepLine, type AgentCall, type AgentStep } from '$lib/agent-socket';

	let { steps, queue = [] }: { steps: AgentStep[]; queue?: AgentCall[] } = $props();

	const show = $derived(queue.length > 0 || steps.length >= 2);

	/** The gateway's verdict token in the operator's word. `ok` is "ran". */
	function word(verdict: AgentStep['verdict']): string {
		return verdict === 'ok' ? 'ran' : verdict;
	}
</script>

{#if show}
	<ul class="tool-chips" aria-label="Tool calls in this turn">
		{#each steps as step (step.seq)}
			<li
				class="tool-chip"
				data-state={step.verdict}
				title={agentStepLine(step.tool, step.verdict)}
			>
				<span class="tool-chip-dot" aria-hidden="true"></span>
				<span class="tool-chip-name mono">{step.tool}</span>
				<span class="tool-chip-word">{word(step.verdict)}</span>
			</li>
		{/each}
		{#each queue as call, index (index)}
			<li
				class="tool-chip"
				data-state="queued"
				title={`${agentStepLine(call.tool)} — queued, not run yet`}
			>
				<span class="tool-chip-dot" aria-hidden="true"></span>
				<span class="tool-chip-name mono">{call.tool}</span>
				<span class="tool-chip-word">queued</span>
			</li>
		{/each}
	</ul>
{/if}

<style>
	.tool-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	/* A chip is a pill on the well with a hairline, the same plate the console's
	   file chips use, at the panel's 22 px step. No shadow: nothing in the panel
	   floats above the prose. */
	.tool-chip {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		min-height: 22px;
		max-width: 100%;
		padding: 0 7px;
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-pill);
		background: var(--df-surface-well);
		color: var(--df-text-primary);
		font-size: var(--df-p-text-xs);
		line-height: 1.3;
	}

	/* Queued is a call the gateway announced and has not settled: dashed edge, meta
	   ink, hollow dot. It is a fact about the queue, not a spinner. */
	.tool-chip[data-state='queued'] {
		border-style: dashed;
		border-color: var(--df-border-control);
		background: transparent;
		color: var(--df-text-secondary);
	}

	.tool-chip-dot {
		flex: none;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--df-state-ok-ink);
	}

	.tool-chip[data-state='refused'] .tool-chip-dot {
		background: var(--df-state-warn-ink);
	}

	.tool-chip[data-state='failed'] .tool-chip-dot {
		background: var(--df-state-danger-ink);
	}

	.tool-chip[data-state='queued'] .tool-chip-dot {
		background: transparent;
		box-shadow: inset 0 0 0 1px var(--df-text-meta);
	}

	.tool-chip-name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: var(--df-p-text-xs);
	}

	/* The word is the verdict, lower-case and quiet: the name already carries the
	   identity, so this is the smallest thing that can still be read. */
	.tool-chip-word {
		flex: none;
		color: var(--df-text-meta);
		font-size: var(--df-p-text-xs);
		letter-spacing: 0.01em;
	}

	.tool-chip[data-state='refused'] .tool-chip-word {
		color: var(--df-state-warn-ink);
	}

	.tool-chip[data-state='failed'] .tool-chip-word {
		color: var(--df-state-danger-ink);
	}
</style>
