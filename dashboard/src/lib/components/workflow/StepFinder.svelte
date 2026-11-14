<script lang="ts">
	/**
	 * One palette, two ways to reach a step.
	 *
	 * The left half is the finder it always was: type, the rows filter as you type,
	 * Enter reveals the step. That path never touches the network, so it stays
	 * under a frame whatever the gateway is doing.
	 *
	 * The right half is the agent. Typing `>` — or pressing Tab on a query that
	 * matches nothing, or picking the "Ask the agent" row — turns the same field
	 * into an intent. On Enter the console reads the words into one candidate
	 * patch (`agent-patch.ts`), the gateway judges that patch
	 * (`/v1/agent/synthesize`), and the patch is checked against this flow before
	 * anything is offered. The three phases are those three real milestones; none
	 * of them is a timer, and a phase that did not happen says so.
	 *
	 * Nothing here applies a change. The proposal goes up to the editor, which
	 * stages it as a ghost the operator accepts or reverts.
	 */
	import { tick } from 'svelte';
	import Icon from '$lib/components/Icon.svelte';
	import Spinner from '$lib/components/Spinner.svelte';
	import { metaFor, nodeSummary, type FlowEdge, type FlowNode } from '$lib/workflow/graph';
	import {
		percent,
		synthesizePatch,
		unavailableCopy,
		unavailableLabel,
		type AgentJudgement,
		type AgentUnavailable
	} from './agent';
	import {
		composeInsert,
		verifyPatch,
		type ComposedPatch,
		type PatchProblems
	} from './agent-patch';
	import { toolForm, toolParam } from './webmcp-attributes';

	/** What the editor receives when a patch is ready to be staged. */
	export interface AgentProposal {
		intent: string;
		judgement: AgentJudgement;
		patch: ComposedPatch;
		problems: PatchProblems;
	}

	let {
		open,
		nodes,
		edges,
		selectedId = null,
		flowId = '',
		corpusReport = '',
		startMode = 'steps',
		onpick,
		onpropose,
		onclose
	}: {
		open: boolean;
		nodes: FlowNode[];
		edges: FlowEdge[];
		selectedId?: string | null;
		flowId?: string;
		corpusReport?: string;
		/** `Ctrl+J` opens straight into the agent half. */
		startMode?: 'steps' | 'agent';
		onpick: (nodeId: string) => void;
		onpropose: (proposal: AgentProposal) => void;
		onclose: () => void;
	} = $props();

	let query = $state('');
	let cursor = $state(0);
	let inputEl = $state<HTMLInputElement | null>(null);
	let finderEl = $state<HTMLDivElement | null>(null);

	/** `<` is the local finder; `>` is the agent. The character is the mode. */
	const agentMode = $derived(/^\s*>/.test(query));
	const intent = $derived(query.replace(/^\s*>\s*/, ''));

	interface Found {
		node: FlowNode;
		title: string;
		summary: string;
	}

	const matches = $derived.by(() => {
		const needle = query.trim().toLowerCase();
		// In agent mode the field is a sentence, not a search: the list is hidden.
		if (agentMode) return [] as Found[];
		const found: Found[] = [];
		nodes.forEach((node, index) => {
			const title = metaFor(node.type).title;
			const summary = nodeSummary(node);
			const haystack = `${title} ${summary} ${node.type} ${index + 1}`.toLowerCase();
			if (needle && !haystack.includes(needle)) return;
			found.push({ node, title, summary });
		});
		return found;
	});

	/* --------------------------------------------------------------- phases */

	type PhaseId = 'understand' | 'propose' | 'verify';
	type PhaseState = 'idle' | 'active' | 'done' | 'failed';

	interface Phase {
		id: PhaseId;
		label: string;
		detail: string;
		state: PhaseState;
	}

	let phases = $state<Record<PhaseId, PhaseState>>({
		understand: 'idle',
		propose: 'idle',
		verify: 'idle'
	});

	const busy = $derived(Object.values(phases).some((state) => state === 'active'));

	const phaseList = $derived<Phase[]>([
		{
			id: 'understand',
			label: 'Understand',
			detail: 'read your words against this flow',
			state: phases.understand
		},
		{
			id: 'propose',
			label: 'Propose',
			detail: 'the gateway judges the candidate patch',
			state: phases.propose
		},
		{
			id: 'verify',
			label: 'Verify',
			detail: 'check the patch against this flow',
			state: phases.verify
		}
	]);

	let judgement = $state<AgentJudgement | null>(null);
	let composed = $state<ComposedPatch | null>(null);
	let problems = $state<PatchProblems | null>(null);
	let failure = $state<null | { kind: 'unavailable' | 'refused'; reason: AgentUnavailable | null; message: string }>(
		null
	);

	let controller: AbortController | null = null;

	function resetPhases() {
		phases = { understand: 'idle', propose: 'idle', verify: 'idle' };
	}

	function resetAgent() {
		controller?.abort();
		controller = null;
		judgement = null;
		composed = null;
		problems = null;
		failure = null;
		resetPhases();
	}

	$effect(() => {
		if (open) {
			query = startMode === 'agent' ? '> ' : '';
			cursor = 0;
			resetAgent();
			// The dialog renders on the tick after `open` flips.
			void tick().then(() => inputEl?.focus());
		} else {
			controller?.abort();
			controller = null;
		}
	});

	/* ------------------------------------------------------------- picking */

	function pick(index: number) {
		const hit = matches[index];
		if (!hit) return;
		onpick(hit.node.id);
	}

	/** Turn the field into a sentence, keeping whatever was already typed. */
	function enterAgent(withQuery = true) {
		resetAgent();
		query = `> ${withQuery ? query.trim() : ''}`;
		cursor = 0;
		void tick().then(() => inputEl?.focus());
	}

	function leaveAgent() {
		controller?.abort();
		controller = null;
		resetAgent();
		query = intent;
		cursor = 0;
	}

	/* ----------------------------------------------------------------- ask */

	async function ask() {
		const words = intent.trim();
		if (!words || busy) return;
		resetAgent();
		phases = { understand: 'active', propose: 'idle', verify: 'idle' };
		// Let the first phase paint before the synchronous reading finishes.
		await tick();

		const read = composeInsert(words, nodes, edges, { selectedId });
		if (!read.ok) {
			phases = { understand: 'failed', propose: 'idle', verify: 'idle' };
			failure = { kind: 'refused', reason: null, message: read.reason };
			return;
		}
		phases = { understand: 'done', propose: 'active', verify: 'idle' };
		await tick();

		controller = new AbortController();
		const answer = await synthesizePatch(
			{
				intent: words,
				flow_id: flowId || 'draft',
				diff_summary: read.value.summary,
				corpus_report: corpusReport
			},
			controller.signal
		);
		controller = null;

		if (answer.status === 'unavailable') {
			phases = { understand: 'done', propose: 'failed', verify: 'idle' };
			failure = {
				kind: 'unavailable',
				reason: answer.reason,
				message: unavailableCopy(answer.reason)
			};
			return;
		}
		if (answer.status === 'refused') {
			phases = { understand: 'done', propose: 'failed', verify: 'idle' };
			failure = { kind: 'refused', reason: null, message: answer.message };
			return;
		}

		phases = { understand: 'done', propose: 'done', verify: 'active' };
		await tick();
		const checked = verifyPatch(read.value.patch, { nodes, edges });
		problems = checked;
		composed = read.value;
		judgement = answer.data;
		phases = {
			understand: 'done',
			propose: 'done',
			verify: checked.blocking.length > 0 ? 'failed' : 'done'
		};
	}

	function stage() {
		if (!composed || !judgement || !problems) return;
		if (problems.blocking.length > 0) return;
		onpropose({ intent: intent.trim(), judgement, patch: composed, problems });
	}

	/** Stop waiting: the request aborts and the phase list says so. */
	function stopRequest() {
		controller?.abort();
		controller = null;
	}

	/* ------------------------------------------------------------ keyboard */

	function onkeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			event.stopPropagation();
			if (busy) {
				// Aborting is enough: the pending call reports its own failure, and
				// the phase list stops on "Propose" rather than pretending it finished.
				stopRequest();
				return;
			}
			// Escape backs out of the agent half first, then closes the palette.
			if (agentMode) {
				leaveAgent();
				return;
			}
			onclose();
			return;
		}

		if (event.key === 'ArrowDown' && !agentMode) {
			event.preventDefault();
			// The last row is always "ask the agent".
			const total = matches.length + 1;
			cursor = (cursor + 1) % total;
			return;
		}
		if (event.key === 'ArrowUp' && !agentMode) {
			event.preventDefault();
			const total = matches.length + 1;
			cursor = cursor <= 0 ? total - 1 : cursor - 1;
			return;
		}
		if (event.key === 'Enter') {
			event.preventDefault();
			if (agentMode) {
				void ask();
				return;
			}
			if (cursor >= matches.length) enterAgent();
			else pick(cursor);
			return;
		}

		if (event.key === 'Tab') {
			// Tab on a query that finds nothing is the second way into the agent:
			// the words were never a step name, so they are a sentence.
			if (!agentMode && query.trim() !== '' && matches.length === 0) {
				event.preventDefault();
				enterAgent();
				return;
			}
			if (finderEl && !event.shiftKey) {
				// Otherwise the palette keeps Tab inside itself and cycles its field
				// and rows, so focus never escapes behind the scrim.
				const items = [
					...finderEl.querySelectorAll<HTMLElement>(
						'input, button:not([disabled]), textarea, [tabindex]:not([tabindex="-1"])'
					)
				].filter((el) => el.offsetParent !== null);
				if (items.length === 0) return;
				const first = items[0];
				const last = items[items.length - 1];
				if (document.activeElement === last) {
					event.preventDefault();
					first.focus();
					return;
				}
				return;
			}
			if (finderEl && event.shiftKey) {
				const items = [
					...finderEl.querySelectorAll<HTMLElement>(
						'input, button:not([disabled]), textarea, [tabindex]:not([tabindex="-1"])'
					)
				].filter((el) => el.offsetParent !== null);
				if (items.length > 0 && document.activeElement === items[0]) {
					event.preventDefault();
					items[items.length - 1].focus();
				}
			}
		}
	}

	function oninput() {
		cursor = 0;
		if (agentMode && (judgement || failure || busy)) resetAgent();
	}

	const blockedReason = $derived.by(() => {
		if (problems && problems.blocking.length > 0) return problems.blocking[0].message;
		if (failure) return failure.message;
		if (!judgement) return 'The agent has not answered yet.';
		return 'Stage this patch for review (Enter)';
	});

	const stageDisabled = $derived(!judgement || !composed || busy || (problems?.blocking.length ?? 1) > 0);
</script>

{#if open}
	<div class="finder-scrim" role="presentation" onclick={onclose}></div>
	<div
		class="finder"
		class:is-agent={agentMode}
		bind:this={finderEl}
		role="dialog"
		tabindex="-1"
		aria-modal="true"
		aria-label={agentMode ? 'Ask the agent for a change' : 'Find a step'}
		onkeydown={onkeydown}
	>
		<!-- The field is the tool an agent fills in: one intent, nothing to submit
		     on its own, and no auto-submit because staging changes the editor. -->
		<form
			class="finder-field"
			{...toolForm(
				'dakflare_ask_agent',
				'Asks the DakFlare agent to propose one change to the flow open in the editor. The patch is staged for review; nothing is applied or saved.'
			)}
			onsubmit={(event) => {
				event.preventDefault();
				if (agentMode) void ask();
				else if (cursor >= matches.length) enterAgent();
				else pick(cursor);
			}}
		>
			{#if agentMode}
				<span class="mode-mark" aria-hidden="true"><Icon name="sparkles" size={16} /></span>
			{:else}
				<span class="mode-mark" aria-hidden="true"><Icon name="filter" size={16} /></span>
			{/if}
			<input
				bind:this={inputEl}
				class="finder-input"
				name="intent"
				{...toolParam(
					agentMode ? 'Intent' : 'Step name',
					agentMode
						? 'The change the operator wants, in their own words. Name the kind of step and where it goes, for example "add a delay after 2".'
						: 'A step name, a summary word, or a kind.'
				)}
				bind:value={query}
				{oninput}
				placeholder={agentMode
					? 'Say what to change, for example: add a delay after 2'
					: 'Find a step, or type > to ask the agent'}
				aria-label={agentMode ? 'Ask the agent for a change' : 'Find a step'}
				aria-describedby={agentMode ? 'finder-agent-state' : 'finder-results'}
				aria-controls={agentMode ? 'finder-agent' : 'finder-results'}
				aria-activedescendant={!agentMode && matches[cursor]
					? `finder-${matches[cursor].node.id}`
					: undefined}
				autocomplete="off"
				spellcheck="false"
			/>
			{#if agentMode}
				<span class="mode-chip">agent</span>
				<button
					type="button"
					class="mode-exit"
					onclick={leaveAgent}
					title="Back to searching the steps"
				>
					<Icon name="x" size={13} />
					<span class="sr-only">Leave agent mode</span>
				</button>
			{:else}
				<kbd>Esc</kbd>
			{/if}
		</form>

		{#if agentMode}
			<div class="agent" id="finder-agent">
				<div class="agent-head">
					<p class="agent-intent">
						<span class="eyebrow">Intent</span>
						<span class="agent-words">{intent.trim() || 'Say what to change'}</span>
					</p>
					{#if busy}
						<button type="button" class="btn btn-sm btn-ghost" onclick={stopRequest}>
							Stop
						</button>
					{/if}
				</div>

				<ol class="phases" aria-label="What happens next">
					{#each phaseList as phase (phase.id)}
						<li class="phase" data-state={phase.state}>
							<span class="phase-mark" aria-hidden="true">
								{#if phase.state === 'active'}
									<Spinner />
								{:else if phase.state === 'done'}
									<Icon name="check" size={13} />
								{:else if phase.state === 'failed'}
									<Icon name="x" size={13} />
								{:else}
									<span class="phase-dot"></span>
								{/if}
							</span>
							<span class="phase-text">
								<strong>{phase.label}</strong>
								<small>{phase.detail}</small>
							</span>
							<span class="phase-word">
								{phase.state === 'active'
									? 'working'
									: phase.state === 'done'
										? 'done'
										: phase.state === 'failed'
											? 'stopped'
											: 'waiting'}
							</span>
						</li>
					{/each}
				</ol>

				<div id="finder-agent-state" aria-live="polite" class="agent-state">
					{#if failure}
						<div class="agent-note" data-tone={failure.kind === 'unavailable' ? 'warn' : 'danger'}>
							<Icon name={failure.kind === 'unavailable' ? 'info' : 'alert'} size={15} />
							<div>
								<strong>
									{failure.kind === 'unavailable'
										? unavailableLabel(failure.reason ?? 'provider')
										: 'Not read'}
								</strong>
								<p>{failure.message}</p>
								{#if failure.kind === 'unavailable'}
									<p class="agent-fallback">
										The steps are still searchable: press <kbd>Esc</kbd> or the × above, then
										type a step name.
									</p>
								{/if}
							</div>
						</div>
						{#if failure.kind === 'refused'}
							<p class="agent-hint">
								Try naming the kind of step and the step it goes after, for example
								<code>add a delay after 2</code>.
							</p>
						{/if}
					{:else if judgement && composed}
						<div class="judgement">
							<p class="judgement-summary">{composed.summary}</p>
							<div class="judgement-chips">
								<span class="chip" data-tone={(judgement.faithful?.score ?? 0) >= 0.6 ? 'ok' : 'warn'}>
									Faithful {percent(judgement.faithful?.score)}
								</span>
								{#if judgement.approval_required}
									<span class="chip" data-tone="warn">Needs approval</span>
								{:else}
									<span class="chip" data-tone="muted">No approval needed</span>
								{/if}
								<span class="chip" data-tone="muted">
									+{composed.addedIds.length} step{composed.addedIds.length === 1 ? '' : 's'}
								</span>
								{#if composed.modifiedIds.length > 0}
									<span class="chip" data-tone="muted">
										{composed.modifiedIds.length} connection{composed.modifiedIds.length === 1 ? '' : 's'} moved
									</span>
								{/if}
							</div>

							{#if judgement.apply_token}
								<div class="agent-token">
									<span class="token-label">Approval token</span>
									<span class="token-value mono" title={judgement.apply_token}>
										{judgement.apply_token}
									</span>
								</div>
								<p class="agent-hint">
									It names this exact patch, so accepting the ghost is the only thing it can be
									spent on.
								</p>
							{:else if judgement.approval_required}
								<p class="agent-hint" data-tone="warn">
									The gateway asked for approval but minted no token, so this patch cannot be
									accepted yet.
								</p>
							{/if}

							{#if problems && problems.all.length > 0}
								<ul class="agent-problems">
									{#each problems.all as problem (problem.path + problem.message)}
										<li data-blocking={problem.kind === 'structure'}>
											<span class="problem-kind">{problem.kind}</span>
											{problem.message}
										</li>
									{/each}
								</ul>
							{/if}

							<div class="agent-actions">
								<button
									type="button"
									class="btn btn-primary btn-sm"
									disabled={stageDisabled}
									title={blockedReason}
									onclick={stage}
								>
									<Icon name="workflow" size={15} /> Stage for review
								</button>
								<span class="agent-hint">
									Staging only draws the change. Accept or revert it in the editor.
								</span>
							</div>
						</div>
					{:else if busy}
						<p class="agent-hint">
							The gateway is judging the candidate patch. Nothing has changed on the flow.
						</p>
					{:else}
						<p class="agent-hint">
							Name the kind of step and where it goes. The console reads the words, the gateway
							judges the patch, and you accept or revert the result.
						</p>
						<ul class="agent-examples">
							<li><code>add a delay after 2</code></li>
							<li><code>add a send sms at the end</code></li>
							<li><code>add a webhook before step 3</code></li>
						</ul>
					{/if}
				</div>
			</div>

			<p class="finder-foot">
				<span class="foot-key"><kbd>Enter</kbd> ask</span>
				<span class="foot-key"><kbd>Esc</kbd> {busy ? 'stop' : agentMode ? 'back' : 'close'}</span>
				<span class="foot-note">The agent proposes; this editor still applies.</span>
			</p>
		{:else}
			<ul class="finder-list" id="finder-results" role="listbox" aria-label="Steps">
				{#each matches as hit, index (hit.node.id)}
					<li>
						<button
							type="button"
							id={`finder-${hit.node.id}`}
							class="finder-row"
							class:is-cursor={index === cursor}
							class:is-selected={hit.node.id === selectedId}
							role="option"
							aria-selected={index === cursor}
							onmouseenter={() => (cursor = index)}
							onclick={() => pick(index)}
						>
							<span class="finder-index mono">{index + 1}</span>
							<span class="finder-text">
								<strong>{hit.title}</strong>
								<small>{hit.summary}</small>
							</span>
							{#if hit.node.id === selectedId}
								<span class="finder-flag">editing</span>
							{/if}
						</button>
					</li>
				{/each}

				<li class="ask-row-wrap">
					<button
						type="button"
						id="finder-agent-row"
						class="finder-row is-ask"
						class:is-cursor={cursor >= matches.length}
						role="option"
						aria-selected={cursor >= matches.length}
						onmouseenter={() => (cursor = matches.length)}
						onclick={() => enterAgent()}
					>
						<span class="finder-index is-ask" aria-hidden="true">
							<Icon name="sparkles" size={13} />
						</span>
						<span class="finder-text">
							<strong>
								Ask the agent
								{#if query.trim()}
									<q>{query.trim()}</q>
								{/if}
							</strong>
							<small>
								{query.trim()
									? 'Turn these words into a staged patch'
									: 'Describe a change in words; Tab also works'}
							</small>
						</span>
						<span class="finder-key">Tab</span>
					</button>
				</li>

				{#if matches.length === 0 && query.trim()}
					<li class="finder-empty">No step matches “{query.trim()}”.</li>
				{/if}
			</ul>

			<p class="finder-foot">
				<span class="foot-key"><kbd>Enter</kbd> reveal</span>
				<span class="foot-key"><kbd>Tab</kbd> ask</span>
				<span class="foot-key"><kbd>Esc</kbd> close</span>
				<span class="foot-note">Names, summaries and kinds are searched locally.</span>
			</p>
		{/if}
	</div>
{/if}

<style>
	.finder-scrim {
		position: fixed;
		inset: 0;
		z-index: 70;
		background: var(--df-c-dialog-scrim);
		backdrop-filter: blur(2px);
	}

	.finder {
		position: fixed;
		top: 96px;
		left: 50%;
		z-index: 71;
		transform: translateX(-50%);
		width: min(560px, calc(100vw - 32px));
		border: 1px solid var(--df-border-control);
		border-radius: var(--df-p-radius-md);
		background: var(--df-surface-card);
		box-shadow: var(--df-shadow-dialog);
		overflow: hidden;
	}

	/* Agent mode is the same palette wearing a different hat: one hairline of
	   colour at the top says which half you are in without a second dialog. */
	.finder.is-agent {
		border-color: color-mix(in srgb, var(--df-state-info-ink) 45%, var(--df-border-control));
		box-shadow:
			var(--df-shadow-dialog),
			0 0 0 1px color-mix(in srgb, var(--df-state-info-ink) 18%, transparent);
	}

	.finder-field {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-2);
		margin: 0;
		padding: var(--df-p-space-2) var(--df-p-space-3);
		border-bottom: 1px solid var(--df-border-hairline);
		color: var(--df-text-meta);
	}

	.finder.is-agent .finder-field {
		border-bottom-color: color-mix(in srgb, var(--df-state-info-ink) 26%, var(--df-border-hairline));
		background: color-mix(in srgb, var(--df-state-info-bg) 34%, var(--df-surface-card));
	}

	.mode-mark {
		display: grid;
		place-items: center;
		color: var(--df-text-meta);
	}

	.finder.is-agent .mode-mark {
		color: var(--df-state-info-ink);
	}

	.finder-input {
		flex: 1;
		min-width: 0;
		border: 0;
		background: transparent;
		color: var(--df-text-primary);
		font-size: var(--df-p-text-md);
		padding: 6px 0;
	}

	.finder-input:focus-visible {
		outline: none;
	}

	.mode-chip {
		flex: none;
		padding: 1px 7px;
		border-radius: var(--df-p-radius-pill);
		background: var(--df-state-info-bg);
		color: var(--df-state-info-ink);
		font-family: var(--df-p-font-mono);
		font-size: 9.5px;
		letter-spacing: 0.05em;
		text-transform: uppercase;
	}

	.mode-exit {
		display: grid;
		place-items: center;
		width: 20px;
		height: 20px;
		flex: none;
		padding: 0;
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-xs);
		background: var(--df-surface-card);
		color: var(--df-text-meta);
	}

	.mode-exit:hover {
		color: var(--df-text-primary);
		border-color: var(--df-border-control);
	}

	.finder-field kbd,
	.finder-foot kbd,
	.agent-hint kbd {
		padding: 1px 5px;
		border: 1px solid var(--df-border-hairline);
		border-radius: 3px;
		background: var(--df-surface-well);
		font-family: var(--df-p-font-mono);
		font-size: 9.5px;
		color: var(--df-text-meta);
	}

	/* ---------------------------------------------------------- local list */

	.finder-list {
		max-height: 320px;
		margin: 0;
		padding: var(--df-p-space-1);
		list-style: none;
		overflow-y: auto;
		overscroll-behavior: contain;
	}

	.finder-row {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-2);
		width: 100%;
		padding: 6px var(--df-p-space-2);
		border: 0;
		border-radius: var(--df-p-radius-xs);
		background: transparent;
		color: var(--df-text-primary);
		text-align: left;
	}

	.finder-row.is-cursor {
		background: var(--df-surface-well);
	}

	.finder-row.is-selected {
		box-shadow: inset 2px 0 0 var(--df-accent-text);
	}

	.finder-row.is-ask {
		color: var(--df-text-secondary);
	}

	.finder-row.is-ask strong {
		font-weight: 600;
		display: flex;
		gap: 5px;
		align-items: baseline;
		min-width: 0;
	}

	.finder-row.is-ask q {
		font-weight: 500;
		color: var(--df-text-primary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.ask-row-wrap {
		margin-top: 2px;
		border-top: 1px solid var(--df-border-hairline);
		padding-top: 2px;
	}

	.finder-index {
		display: grid;
		place-items: center;
		width: 20px;
		height: 20px;
		flex: none;
		border-radius: var(--df-p-radius-xs);
		background: var(--df-surface-well);
		font-size: var(--df-p-text-2xs);
		color: var(--df-text-meta);
	}

	.finder-index.is-ask {
		color: var(--df-state-info-ink);
		background: var(--df-state-info-bg);
	}

	.finder-text {
		display: flex;
		flex-direction: column;
		gap: 1px;
		min-width: 0;
		flex: 1;
	}

	.finder-text strong {
		font-size: var(--df-p-text-base);
		font-weight: 600;
	}

	.finder-text small {
		font-size: var(--df-p-text-xs);
		color: var(--df-text-meta);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.finder-flag {
		margin-left: auto;
		padding: 1px 6px;
		border-radius: var(--df-p-radius-pill);
		background: var(--df-accent-soft);
		color: var(--df-accent-text);
		font-size: var(--df-p-text-2xs);
		white-space: nowrap;
	}

	.finder-key {
		margin-left: auto;
		flex: none;
		font-family: var(--df-p-font-mono);
		font-size: 9.5px;
		color: var(--df-text-meta);
	}

	.finder-empty {
		padding: var(--df-p-space-2) var(--df-p-space-3);
		font-size: var(--df-p-text-base);
		color: var(--df-text-meta);
	}

	.finder-foot {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-3);
		flex-wrap: wrap;
		margin: 0;
		padding: var(--df-p-space-2) var(--df-p-space-3);
		border-top: 1px solid var(--df-border-hairline);
		background: var(--df-surface-well);
		font-size: var(--df-p-text-2xs);
		color: var(--df-text-meta);
	}

	.foot-key {
		display: inline-flex;
		align-items: center;
		gap: 4px;
	}

	.foot-note {
		margin-left: auto;
	}

	/* ---------------------------------------------------------- agent half */

	.agent {
		max-height: 380px;
		overflow-y: auto;
		overscroll-behavior: contain;
		padding: var(--df-p-space-3);
		display: flex;
		flex-direction: column;
		gap: var(--df-p-space-3);
	}

	.agent-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--df-p-space-2);
	}

	.agent-intent {
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.eyebrow {
		font-family: var(--df-p-font-mono);
		font-size: 9.5px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--df-text-meta);
	}

	.agent-words {
		font-size: var(--df-p-text-md);
		color: var(--df-text-primary);
		font-weight: 600;
		overflow-wrap: anywhere;
	}

	.phases {
		margin: 0;
		padding: 0;
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.phase {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-2);
		padding: 5px var(--df-p-space-2);
		border-radius: var(--df-p-radius-xs);
	}

	.phase[data-state='active'] {
		background: color-mix(in srgb, var(--df-state-info-bg) 45%, transparent);
	}

	.phase[data-state='idle'] {
		opacity: 0.55;
	}

	.phase-mark {
		display: grid;
		place-items: center;
		width: 18px;
		height: 18px;
		flex: none;
		border-radius: 50%;
		border: 1px solid var(--df-border-hairline);
		color: var(--df-text-meta);
	}

	.phase[data-state='active'] .phase-mark {
		border-color: var(--df-state-info-ink);
		color: var(--df-state-info-ink);
	}

	.phase[data-state='done'] .phase-mark {
		border-color: color-mix(in srgb, var(--df-state-ok-ink) 45%, var(--df-border-hairline));
		color: var(--df-state-ok-ink);
	}

	.phase[data-state='failed'] .phase-mark {
		border-color: color-mix(in srgb, var(--df-state-danger-ink) 45%, var(--df-border-hairline));
		color: var(--df-state-danger-ink);
	}

	.phase-dot {
		width: 4px;
		height: 4px;
		border-radius: 50%;
		background: var(--df-border-control);
	}

	.phase-text {
		display: flex;
		flex-direction: column;
		min-width: 0;
		flex: 1;
	}

	.phase-text strong {
		font-size: var(--df-p-text-base);
		font-weight: 600;
	}

	.phase-text small {
		font-size: var(--df-p-text-xs);
		color: var(--df-text-meta);
	}

	.phase-word {
		font-family: var(--df-p-font-mono);
		font-size: 9.5px;
		color: var(--df-text-meta);
	}

	.agent-state {
		display: flex;
		flex-direction: column;
		gap: var(--df-p-space-2);
		border-top: 1px solid var(--df-border-hairline);
		padding-top: var(--df-p-space-2);
	}

	.agent-note {
		display: flex;
		gap: var(--df-p-space-2);
		padding: var(--df-p-space-2);
		border-radius: var(--df-p-radius-sm);
		border: 1px solid var(--df-border-hairline);
		background: var(--df-surface-well);
		color: var(--df-text-secondary);
	}

	.agent-note[data-tone='warn'] {
		border-color: color-mix(in srgb, var(--df-state-warn-ink) 38%, var(--df-border-hairline));
		background: var(--df-state-warn-bg);
		color: var(--df-text-primary);
	}

	.agent-note[data-tone='danger'] {
		border-color: color-mix(in srgb, var(--df-state-danger-ink) 38%, var(--df-border-hairline));
		background: var(--df-state-danger-bg);
		color: var(--df-text-primary);
	}

	.agent-note strong {
		display: block;
		font-size: var(--df-p-text-base);
		font-weight: 600;
	}

	.agent-note p {
		margin: 2px 0 0;
		font-size: var(--df-p-text-sm);
	}

	.agent-fallback {
		color: var(--df-text-secondary);
	}

	.judgement {
		display: flex;
		flex-direction: column;
		gap: var(--df-p-space-2);
	}

	.judgement-summary {
		margin: 0;
		font-size: var(--df-p-text-md);
		color: var(--df-text-primary);
	}

	.judgement-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 5px;
	}

	.agent-hint {
		margin: 0;
		font-size: var(--df-p-text-xs);
		color: var(--df-text-meta);
	}

	.agent-hint[data-tone='warn'] {
		color: var(--df-state-warn-ink);
	}

	.agent-examples {
		margin: 0;
		padding: 0 0 0 var(--df-p-space-3);
		display: flex;
		flex-direction: column;
		gap: 3px;
		font-size: var(--df-p-text-xs);
		color: var(--df-text-meta);
	}

	.agent-examples code,
	.agent-hint code {
		font-family: var(--df-p-font-mono);
		font-size: 11px;
		color: var(--df-text-secondary);
	}

	.agent-token {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
	}

	.token-label {
		flex: none;
		font-family: var(--df-p-font-mono);
		font-size: 9px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--df-text-meta);
	}

	.token-value {
		font-size: 10.5px;
		color: var(--df-text-secondary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.agent-problems {
		margin: 0;
		padding: 0;
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 3px;
	}

	.agent-problems li {
		display: flex;
		gap: 6px;
		font-size: var(--df-p-text-xs);
		color: var(--df-text-secondary);
	}

	.agent-problems li[data-blocking='true'] {
		color: var(--df-state-danger-ink);
	}

	.problem-kind {
		flex: none;
		font-family: var(--df-p-font-mono);
		font-size: 9.5px;
		text-transform: uppercase;
		color: var(--df-text-meta);
	}

	.agent-actions {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-2);
		flex-wrap: wrap;
	}

	@media (prefers-reduced-motion: reduce) {
		.phase {
			transition: none;
		}
	}
</style>
