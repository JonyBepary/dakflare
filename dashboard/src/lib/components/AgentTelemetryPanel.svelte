<script lang="ts">
	/**
	 * "Ask the fleet" — one question, one bounded read, on the Overview page.
	 *
	 * The panel is deliberately not a chat: there is no transcript, no avatar and
	 * no stream. It asks `POST /v1/agent/telemetry`, which resolves ONE plan, and
	 * it prints that plan, how long it took, how many rows came back and the rows
	 * themselves. Every state is drawn here — idle, waiting, unavailable and
	 * refused — because a read-only tool that goes blank on a refusal teaches the
	 * operator nothing about what it can answer.
	 *
	 * Access follows the Worker, not this component: the route is gated on the
	 * `read` permission (`worker/src/index.ts`), which is every signed-in role
	 * (`worker/src/auth/guard.ts` → `PERMISSION_ROLES.read`). The console has no
	 * narrower helper for it, so the panel reuses that same rule and renders
	 * nothing at all for a session that is not signed in or reports a role this
	 * console does not know. It does not guess a broader gate.
	 */
	import {
		askFleet,
		planExample,
		telemetryCell,
		telemetryTable,
		TELEMETRY_PLANS,
		type TelemetryOutcome,
		type UnavailableReason
	} from '$lib/agent-telemetry';
	import { announce } from '$lib/announce.svelte';
	import { formatCount } from '$lib/format';
	import { session } from '$lib/session.svelte';
	import Icon from './Icon.svelte';
	import Notice from './Notice.svelte';
	import Spinner from './Spinner.svelte';

	const uid = $props.id();
	const titleId = `ask-fleet-${uid}`;
	const inputId = `ask-fleet-question-${uid}`;
	const hintId = `ask-fleet-hint-${uid}`;

	/** Roles that hold the Worker's `read` permission. Everything else is not this panel's reader. */
	const READ_ROLES: ReadonlySet<string> = new Set(['owner', 'admin', 'member']);

	const mayRead = $derived(
		session.status === 'authed' && (session.role === null || READ_ROLES.has(session.role))
	);

	let question = $state('');
	/** The question the current answer belongs to, so Retry repeats the right one. */
	let asked = $state('');
	let phase = $state<'idle' | 'waiting' | 'done'>('idle');
	let outcome = $state<TelemetryOutcome | null>(null);
	let sequence = 0;
	let field = $state<HTMLInputElement | null>(null);

	const answered = $derived(outcome?.kind === 'answered' ? outcome.answer : null);
	const refused = $derived(outcome?.kind === 'refused' ? outcome : null);
	const unavailable = $derived(outcome?.kind === 'unavailable' ? outcome : null);

	const canAsk = $derived(phase !== 'waiting' && question.trim() !== '');

	const refusal = $derived.by(() => {
		if (refused === null) return null;
		return {
			message:
				refused.message ??
				'The gateway did not recognise that question, and did not say why.',
			plans: refused.plans
		};
	});

	const failure = $derived.by(() => {
		if (unavailable === null) return null;
		return { ...unavailableCopy(unavailable.reason, unavailable.status), detail: unavailable.detail };
	});

	/** One sentence per failure, naming what to do next rather than the wire. */
	function unavailableCopy(
		reason: UnavailableReason,
		status: number
	): { tone: 'danger' | 'warn'; title: string; body: string } {
		switch (reason) {
			case 'signed-out':
				return {
					tone: 'danger',
					title: 'Not signed in',
					body: 'The gateway did not accept this session, so nothing was read. Sign in again, then ask once more.'
				};
			case 'forbidden':
				return {
					tone: 'danger',
					title: 'This session cannot read the fleet',
					body: 'Asking about fleet state needs the read permission on this deployment. Ask an owner for a role that carries it.'
				};
			case 'plan-unavailable':
				return {
					tone: 'warn',
					title: 'No answer right now',
					body: 'The gateway could not resolve a plan for that question. Ask again: a question that names the area — outbox, SIMs, flows, grants, drift — can still be routed without the model.'
				};
			case 'rate-limited':
				return {
					tone: 'warn',
					title: 'Asking too often',
					body: 'The gateway is rate limiting these reads. Wait a moment, then ask once more.'
				};
			case 'network':
				return {
					tone: 'danger',
					title: 'The gateway did not answer',
					body: 'Nothing was read. Check the connection, then ask again.'
				};
			default:
				return {
					tone: 'warn',
					title: 'The read failed',
					body: `The gateway answered HTTP ${status}. The question was not run.`
				};
		}
	}

	async function ask(text: string): Promise<void> {
		const next = text.trim();
		if (next === '' || phase === 'waiting') return;

		question = next;
		asked = next;
		phase = 'waiting';
		outcome = null;
		announce('Reading the fleet');

		const id = ++sequence;
		const result = await askFleet(next);
		if (id !== sequence) return;

		outcome = result;
		phase = 'done';
		if (result.kind === 'answered') {
			const count = result.answer.rows.length;
			announce(
				`Plan ${result.answer.plan ?? 'unknown'}, ${count} ${count === 1 ? 'row' : 'rows'}.`
			);
		}
	}

	function submit(event: SubmitEvent): void {
		event.preventDefault();
		void ask(question);
	}

	/** A plan chip fills the box; it does not spend a read the operator did not ask for. */
	function fillWith(plan: string): void {
		question = planExample(plan);
		outcome = null;
		phase = 'idle';
		field?.focus();
	}

	function retry(): void {
		void ask(asked);
	}

	/**
	 * An answer belongs to the question that produced it. Editing the box drops
	 * the table rather than leaving rows on screen that answer something else.
	 */
	$effect(() => {
		if (phase !== 'done') return;
		if (question.trim() === asked.trim()) return;
		outcome = null;
		phase = 'idle';
	});
</script>

{#if mayRead}
	<section class="card span-12 ask" aria-labelledby={titleId}>
		<div class="ask-head">
			<h2 id={titleId} class="card-title">Ask the fleet</h2>
			<span class="marker mono">read-only</span>
		</div>

		<p class="ask-intro">
			One question becomes one bounded read of the state below. Nothing here changes a device, a
			message, a flow or a grant.
		</p>

		<form class="ask-form" onsubmit={submit}>
			<label class="label" for={inputId}>Question</label>
			<div class="input-row">
				<input
					id={inputId}
					class="input ask-input mono"
					type="text"
					bind:value={question}
					bind:this={field}
					maxlength="500"
					placeholder="Which outbound messages are stuck?"
					autocomplete="off"
					spellcheck="false"
					enterkeyhint="search"
					disabled={phase === 'waiting'}
					aria-describedby={hintId}
				/>
				<button type="submit" class="btn btn-primary" disabled={!canAsk}>
					{#if phase === 'waiting'}<Spinner />{:else}<Icon name="sparkles" size={14} />{/if}
					Ask
				</button>
			</div>
			<p class="hint" id={hintId}>
				Up to 500 characters. An answer is one plan and at most 50 rows.
			</p>
		</form>

		<div class="result" aria-busy={phase === 'waiting'}>
			{#if phase === 'waiting'}
				<p class="reading"><Spinner /> Reading the fleet…</p>
			{:else if phase === 'idle'}
				<div class="examples">
					<p class="examples-label">Ask one of these</p>
					<ul class="example-list">
						{#each TELEMETRY_PLANS as plan (plan)}
							<li>
								<button
									type="button"
									class="example"
									onclick={() => void ask(planExample(plan))}
									aria-label={`Ask: ${planExample(plan)}`}
								>
									<span class="example-q">{planExample(plan)}</span>
									<span class="example-plan mono">{plan}</span>
								</button>
							</li>
						{/each}
					</ul>
				</div>
			{:else if answered}
				{@const table = telemetryTable(answered.rows)}
				<div class="readout">
					<span class="pair">
						<span class="pair-key">plan</span>
						<span class="pair-value mono">{answered.plan ?? '—'}</span>
					</span>
					<span class="pair">
						<span class="pair-key">took</span>
						<span class="pair-value mono"
							>{answered.tookMs === null ? '—' : `${formatCount(answered.tookMs)} ms`}</span
						>
					</span>
					<span class="pair">
						<span class="pair-key">rows</span>
						<span class="pair-value mono">{formatCount(answered.rows.length)}</span>
					</span>
					{#if answered.truncated === true}
						<span class="cut mono">{formatCount(answered.rows.length)} of more</span>
						<span class="sr-only">The query hit its row cap, so this list is cut short.</span>
					{/if}
				</div>

				{#if answered.rows.length === 0}
					<p class="card-note">The read ran and returned no rows.</p>
				{:else}
					<!-- The rows can be wider than the card. A keyboard user needs to
					     reach the scroll box, and aria-label names what it holds; the
					     linter's rule assumes a non-interactive element with a tab stop
					     has no job there, which is not true of a scroll container. -->
					<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
					<div
						class="table-scroll"
						role="group"
						aria-label="Answer rows"
						tabindex="0"
					>
						<table class="table ask-table">
							<thead>
								<tr>
									{#each table.columns as column (column.key)}
										<th scope="col" title={column.key} style="width: {column.width}%">
											{column.label}
										</th>
									{/each}
								</tr>
							</thead>
							<tbody>
								{#each answered.rows as row, index (index)}
									<tr>
										{#each table.columns as column (column.key)}
											{@const cell = telemetryCell(column.key, row[column.key])}
											<td class:empty={cell.empty} title={cell.title ?? undefined}>
												{cell.text}
											</td>
										{/each}
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
					{#if table.hidden > 0}
						<p class="more-note mono">
							+{table.hidden}
							{table.hidden === 1 ? 'field' : 'fields'} not shown
						</p>
					{/if}
				{/if}
			{:else if refusal}
				<Notice tone="warn" title="That question does not map to a plan">
					{refusal.message}
				</Notice>
				<p class="chips-label">The plans this console can read:</p>
				<ul class="plan-chips">
					{#each refusal.plans as plan (plan)}
						<li>
							<button
								type="button"
								class="plan-chip mono"
								onclick={() => fillWith(plan)}
								title={planExample(plan)}
								aria-label={`Use the question for ${plan}`}
							>
								<span class="plan-chip-plus" aria-hidden="true">+</span>{plan}
							</button>
						</li>
					{/each}
				</ul>
			{:else if failure}
				<Notice tone={failure.tone} title={failure.title}>
					{failure.body}
					{#if failure.detail}
						<span class="detail mono">{failure.detail}</span>
					{/if}
				</Notice>
				<div class="row" style="margin-top: 12px">
					<button type="button" class="btn btn-sm" onclick={retry}>
						<Icon name="refresh" size={13} /> Try again
					</button>
				</div>
			{/if}
		</div>
	</section>
{/if}

<style>
	.ask {
		display: flex;
		flex-direction: column;
		gap: var(--df-p-space-3);
	}

	.ask-head {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-2);
		min-width: 0;
	}

	.marker {
		margin-left: auto;
		padding: 2px 8px;
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-pill);
		background: var(--df-surface-well);
		color: var(--df-text-meta);
		font-size: var(--df-p-text-2xs);
		letter-spacing: 0.08em;
		text-transform: uppercase;
		white-space: nowrap;
	}

	.ask-intro {
		max-width: 72ch;
		color: var(--df-text-secondary);
		font-size: var(--df-p-text-base);
		line-height: 1.5;
	}

	.ask-form {
		display: flex;
		flex-direction: column;
		gap: 6px;
		max-width: 720px;
	}

	.ask-input {
		font-size: var(--df-p-text-base);
	}

	.ask-input:disabled {
		background: var(--df-surface-well);
		color: var(--df-text-secondary);
		cursor: progress;
	}

	.result {
		display: flex;
		flex-direction: column;
		gap: var(--df-p-space-3);
		padding-top: var(--df-p-space-3);
		border-top: 1px solid var(--df-border-hairline);
	}

	.reading {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-2);
		color: var(--df-text-secondary);
		font-size: var(--df-p-text-base);
	}

	/* ---------- idle: the six examples ---------- */

	.examples-label,
	.chips-label {
		margin-bottom: var(--df-p-space-2);
		color: var(--df-text-meta);
		font-family: var(--df-p-font-mono);
		font-size: var(--df-p-text-2xs);
		font-weight: 500;
		letter-spacing: 0.1em;
		text-transform: uppercase;
	}

	.example-list {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--df-p-space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.example {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--df-p-space-3);
		width: 100%;
		padding: 9px var(--df-p-space-3);
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-md);
		background: transparent;
		color: var(--df-text-primary);
		font-size: var(--df-p-text-base);
		text-align: left;
		transition:
			background-color 140ms ease,
			border-color 140ms ease;
	}

	@media (hover: hover) and (pointer: fine) {
		.example:hover {
			background: var(--df-surface-well);
			border-color: var(--df-border-control);
		}
	}

	.example-q {
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.example-plan {
		flex: none;
		color: var(--df-text-meta);
		font-size: var(--df-p-text-2xs);
	}

	/* ---------- answered: the readout strip ---------- */

	.readout {
		display: flex;
		align-items: baseline;
		flex-wrap: wrap;
		gap: var(--df-p-space-2) var(--df-p-space-5);
		padding: var(--df-p-space-2) var(--df-p-space-3);
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-md);
		background: var(--df-surface-well);
	}

	.pair {
		display: inline-flex;
		align-items: baseline;
		gap: 6px;
		min-width: 0;
	}

	.pair-key {
		color: var(--df-text-meta);
		font-family: var(--df-p-font-mono);
		font-size: var(--df-p-text-2xs);
		letter-spacing: 0.1em;
		text-transform: uppercase;
	}

	.pair-value {
		color: var(--df-text-primary);
		font-size: var(--df-p-text-base);
		font-weight: 600;
		overflow-wrap: anywhere;
	}

	.cut {
		margin-left: auto;
		padding: 2px 9px;
		border-radius: var(--df-p-radius-pill);
		background: var(--df-state-warn-bg);
		color: var(--df-text-primary);
		font-size: var(--df-p-text-xs);
		font-weight: 700;
		white-space: nowrap;
	}

	/* ---------- answered: the rows ---------- */

	.table-scroll {
		overflow-x: auto;
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-md);
		background: var(--df-surface-card);
	}

	.ask-table {
		table-layout: fixed;
		min-width: 560px;
	}

	.ask-table th,
	.ask-table td {
		max-width: 0;
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
		font-family: var(--df-p-font-mono);
		font-size: var(--df-p-text-xs);
	}

	.ask-table th {
		position: static;
		/* A header may wrap onto two lines: a field name is short enough to say in
		   full, and the values below are the part that ellipsizes. */
		white-space: normal;
		line-height: 1.25;
		vertical-align: bottom;
	}
	.ask-table td {
		font-variant-numeric: tabular-nums;
	}

	.ask-table td.empty {
		color: var(--df-text-meta);
	}

	.more-note {
		color: var(--df-text-meta);
		font-size: var(--df-p-text-2xs);
		letter-spacing: 0.04em;
	}

	/* ---------- refused: the plan chips ---------- */

	.plan-chips {
		display: flex;
		flex-wrap: wrap;
		gap: var(--df-p-space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.plan-chip {
		padding: 4px 10px;
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-pill);
		background: var(--df-surface-well);
		color: var(--df-text-primary);
		font-size: var(--df-p-text-xs);
		transition:
			background-color 120ms ease,
			border-color 120ms ease;
	}

	/* The plus is the whole affordance: this chip inserts a question, it does not
	   run one. */
	.plan-chip-plus {
		margin-right: 5px;
		color: var(--df-text-meta);
		font-weight: 700;
	}

	@media (hover: hover) and (pointer: fine) {
		.plan-chip:hover {
			background: var(--df-surface-press);
			border-color: var(--df-border-control);
		}
	}

	.detail {
		display: block;
		margin-top: 4px;
		font-size: var(--df-p-text-xs);
		overflow-wrap: anywhere;
	}

	@media (max-width: 720px) {
		.example-list {
			grid-template-columns: minmax(0, 1fr);
		}

		.cut {
			margin-left: 0;
		}
	}
</style>
