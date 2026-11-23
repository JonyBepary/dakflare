<script lang="ts">
	/**
	 * The work behind an answer, as one foldable trace.
	 *
	 * The panel already knew what ran; this is the same ledger, with a summary that
	 * says how much of it there is and a disclosure that gives the panel back to the
	 * prose. Nothing here is invented: a row exists because a `tool` frame settled
	 * it, the gap is the difference between two gateway stamps, and a sentence with
	 * no stamp prints no time.
	 *
	 * Three shapes, unchanged from the inline version it replaces:
	 *
	 *  - one successful step is a note, not a trace (`p.step-one`, no rail, no
	 *    summary) — a lone read does not earn a disclosure;
	 *  - two steps, or any step that did not succeed, is the rail;
	 *  - while a turn is still running the trace stays open, because work in flight
	 *    is the only thing on screen that changes.
	 *
	 * A clean turn that finishes with more than two steps folds to its summary. That
	 * is the one moment content leaves the screen, so it only happens when the
	 * operator has not opened the trace by hand, and the rows stay in the document
	 * (`hidden`, not removed) so a selector, a test and a re-open all still find them.
	 */
	import { agentStepElapsed, agentStepLine, type AgentCall, type AgentStep } from '$lib/agent-socket';
	import AssistantToolChips from './AssistantToolChips.svelte';
	import Icon from '../Icon.svelte';

	let {
		steps,
		queue = [],
		streaming = false
	}: { steps: AgentStep[]; queue?: AgentCall[]; streaming?: boolean } = $props();

	const uid = $props.id();
	const bodyId = `assistant-trace-${uid}`;

	/** The operator's own choice; `null` means the turn is still deciding. */
	let manual = $state<boolean | null>(null);
	let auto = $state(true);

	const failed = $derived(steps.filter((step) => step.verdict !== 'ok').length);
	const timeline = $derived(steps.length >= 2 || failed > 0);
	const open = $derived(manual ?? auto);

	/**
	 * Which calls the chips name.
	 *
	 * A chip never repeats a row the operator can see: expanded, the rows are the
	 * record and the chips carry only the queue. Folded, the chips are the record.
	 * And a lone settled step beside a queue is named by its chip rather than by a
	 * note of its own — one fact, one form.
	 */
	const chipsFor = $derived(
		queue.length > 0 && steps.length === 1 ? steps : open ? [] : steps
	);
	/** The note is the single-step turn's only rendering; it stands down for chips. */
	const noteAlone = $derived(steps.length === 1 && !timeline && queue.length === 0);

	$effect(() => {
		if (steps.length === 0) {
			manual = null;
			auto = true;
			return;
		}
		if (manual !== null) return;
		// Open while the work is happening and whenever something did not run;
		// fold only a finished, clean, longer-than-two turn.
		auto = streaming || failed > 0 || steps.length <= 2;
	});

	const summary = $derived.by(() => {
		const count = steps.length;
		const steps_word = count === 1 ? 'step' : 'steps';
		if (streaming) return `Working through ${count} ${steps_word}`;
		if (failed > 0) return `${count} ${steps_word}, ${failed} did not run`;
		return `Worked through ${count} ${steps_word}`;
	});

	/**
	 * The turn's own pace: the distance between the first and last stamp the
	 * gateway sent. `null` when fewer than two frames carried one, so an unstamped
	 * turn shows no time rather than this browser's clock.
	 */
	const elapsed = $derived.by(() => {
		const stamps = steps
			.map((step) => step.settledAt)
			.filter((at): at is number => at !== null && at !== undefined);
		if (stamps.length < 2) return null;
		const last = stamps[stamps.length - 1];
		if (last < stamps[0]) return null;
		return agentStepElapsed(last - stamps[0]);
	});

	/** The time between the step before this one and this one, from stamps alone. */
	function gapBefore(index: number): string | null {
		if (index === 0) return null;
		const before = steps[index - 1]?.settledAt;
		const at = steps[index]?.settledAt;
		if (before === null || before === undefined || at === null || at === undefined) return null;
		if (at < before) return null;
		return agentStepElapsed(at - before);
	}

	function toggle(): void {
		manual = !open;
	}
</script>

{#if steps.length > 0 || queue.length > 0}
	<div class="work">
		<!-- Chips carry what the rows are not already showing: every call still in
		     flight, and — when the trace is folded — the settled ones it stands in
		     for. Expanded, the rows say it better and the chips step aside. -->
		<AssistantToolChips steps={chipsFor} {queue} />

		{#if noteAlone}
			<!-- One read is a note, not a timeline: no rail, no chip, no summary. -->
			<p class="step-one">
				<span class="mono step-tool">{steps[0].tool}</span>
				<span>{agentStepLine(steps[0].tool)}</span>
			</p>
		{:else if timeline}
			<section class="trace" data-open={open}>
		<button
			type="button"
			class="trace-toggle"
			aria-expanded={open}
			aria-controls={bodyId}
			onclick={toggle}
		>
			<span class="trace-mark" data-trouble={failed > 0} aria-hidden="true"></span>
			<span class="trace-say">{summary}</span>
			{#if elapsed !== null}
				<span class="trace-time mono">{elapsed}</span>
			{/if}
			<span class="trace-cue" aria-hidden="true">
				<Icon name={open ? 'chevron-up' : 'chevron-down'} size={13} />
			</span>
			<span class="sr-only">{open ? 'Hide the work' : 'Show the work'}</span>
		</button>

		<div class="trace-body" id={bodyId} hidden={!open}>
			<!-- One row per settled step, in the order the gateway ran them, with the
			     reason on the row rather than behind a tooltip: a refusal is the row an
			     operator came here to read. -->
			<ol class="steps" aria-label="What the agent did">
				{#each steps as step, index (step.seq)}
					{@const gap = gapBefore(index)}
					<li class="step" data-verdict={step.verdict}>
						<span class="step-mark" aria-hidden="true"></span>
						<span class="step-main">
							<span class="step-head">
								<span class="step-say">{agentStepLine(step.tool, step.verdict)}</span>
								{#if gap !== null}
									<span class="step-gap mono">+{gap}</span>
								{/if}
								<span class="step-chip" data-verdict={step.verdict}>{step.verdict}</span>
							</span>
							<span class="step-tool mono">{step.tool}</span>
							{#if step.reason !== null && step.reason !== ''}
								<!-- The gateway's own words, verbatim. A step with no reason
								     prints none rather than a sentence this console wrote. -->
								<span class="step-reason">
									{#if step.code !== null && step.code !== ''}<span class="mono step-code"
											>{step.code}</span
										><span class="step-sep">{' · '}</span>{/if}{step.reason}
								</span>
							{/if}
						</span>
					</li>
				{/each}
			</ol>
			</div>
		</section>
		{/if}
	</div>
{/if}

<style>
	/* A lone successful read is a note, not a timeline. */
	.step-one {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 6px;
		margin: 0;
		color: var(--df-text-secondary);
		font-size: var(--df-p-text-xs);
		line-height: 1.45;
	}

	.step-one .step-tool {
		color: var(--df-text-meta);
	}

	.work {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.trace {
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	/* The summary is the whole affordance: a full-width row, quiet ink, and one
	   chevron. It is a disclosure, not an action, so it never takes coral. */
	.trace-toggle {
		display: flex;
		align-items: center;
		gap: 7px;
		width: 100%;
		min-height: 28px;
		padding: 2px 6px 2px 4px;
		border: 1px solid transparent;
		border-radius: var(--df-p-radius-xs);
		background: transparent;
		color: var(--df-text-secondary);
		font-size: var(--df-p-text-xs);
		line-height: 1.4;
		text-align: left;
		transition:
			background-color 140ms ease,
			color 140ms ease,
			transform var(--df-p-dur-press) ease-out;
	}

	.trace-toggle:active {
		transform: scale(0.97);
	}

	@media (hover: hover) and (pointer: fine) {
		.trace-toggle:hover {
			background: var(--df-surface-well);
			color: var(--df-text-primary);
		}
	}

	.trace-mark {
		flex: none;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--df-state-ok-ink);
	}

	.trace-mark[data-trouble='true'] {
		background: var(--df-state-warn-ink);
	}

	.trace-say {
		font-weight: 600;
		min-width: 0;
	}

	.trace-time {
		flex: none;
		color: var(--df-text-meta);
		letter-spacing: 0.02em;
	}

	.trace-cue {
		display: grid;
		place-items: center;
		flex: none;
		margin-left: auto;
		color: var(--df-text-meta);
	}

	/* Rows keep their place in the document when folded, so a re-open costs no
	   request and no layout surprise. `hidden` needs the display rule restated:
	   the rail below is a flex box and would outrank the UA default. */
	.trace-body[hidden] {
		display: none;
	}

	.steps {
		display: flex;
		flex-direction: column;
		margin: 0;
		padding: 0 0 0 12px;
		list-style: none;
		border-left: 1px solid var(--df-border-control);
	}

	.step {
		position: relative;
		padding: 6px 0;
	}

	.step + .step {
		border-top: 1px solid var(--df-border-hairline);
	}

	.step-mark {
		position: absolute;
		left: -16px;
		top: 10px;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--df-state-ok-ink);
	}

	.step[data-verdict='refused'] .step-mark {
		background: var(--df-state-warn-ink);
	}

	.step[data-verdict='failed'] .step-mark {
		background: var(--df-state-danger-ink);
	}

	.step[data-verdict='refused'],
	.step[data-verdict='failed'] {
		margin-left: -8px;
		padding-left: 6px;
		padding-right: 6px;
		border-left: 2px solid;
		border-radius: var(--df-p-radius-xs);
	}

	.step[data-verdict='refused'] {
		background: color-mix(in srgb, var(--df-state-warn-bg) 70%, transparent);
		border-left-color: var(--df-state-warn-ink);
	}

	.step[data-verdict='failed'] {
		background: color-mix(in srgb, var(--df-state-danger-bg) 70%, transparent);
		border-left-color: var(--df-state-danger-ink);
	}

	.step-main {
		display: flex;
		flex-direction: column;
		gap: 1px;
		min-width: 0;
	}

	.step-head {
		display: flex;
		align-items: baseline;
		gap: 6px;
		flex-wrap: wrap;
		min-width: 0;
	}

	.step-say {
		flex: 1 1 auto;
		min-width: 0;
		color: var(--df-text-primary);
		font-size: var(--df-p-text-sm);
		line-height: 1.35;
		overflow-wrap: anywhere;
	}

	.step-chip {
		flex: none;
		padding: 0 4px;
		border: 1px solid color-mix(in srgb, currentColor 40%, transparent);
		border-radius: var(--df-p-radius-xs);
		font-family: var(--df-font-mono);
		font-size: var(--df-p-text-xs);
		letter-spacing: 0.01em;
		line-height: 1.5;
		color: var(--df-state-ok-ink);
	}

	.step-chip[data-verdict='refused'] {
		color: var(--df-state-warn-ink);
	}

	.step-chip[data-verdict='failed'] {
		color: var(--df-state-danger-ink);
	}

	.step-gap {
		flex: none;
		margin-left: auto;
		color: var(--df-text-meta);
		font-size: var(--df-p-text-xs);
		letter-spacing: 0.02em;
	}

	.step-tool {
		color: var(--df-text-meta);
		font-size: var(--df-p-text-xs);
		line-height: 1.4;
		overflow-wrap: anywhere;
	}

	.step-reason {
		margin-top: 2px;
		color: var(--df-text-primary);
		font-size: var(--df-p-text-xs);
		line-height: 1.45;
		overflow-wrap: anywhere;
		white-space: pre-wrap;
	}

	.step-code {
		color: var(--df-text-secondary);
		/* `.mono` scales to 0.94em of its parent; this is the one place that would
		   land under 11px, so the size is restated. */
		font-size: var(--df-p-text-xs);
	}

	.step-sep {
		color: var(--df-text-meta);
	}

	@media (prefers-reduced-motion: reduce) {
		.trace-toggle {
			transition: none;
		}

		.trace-toggle:active {
			transform: none;
		}
	}

	/* The panel's own floor: a disclosure row is a control, so on touch it takes
	   the console's 44 px minimum like every other control in the sheet. */
	@media (max-width: 720px), (pointer: coarse) {
		.trace-toggle {
			min-height: 44px;
		}
	}
</style>
