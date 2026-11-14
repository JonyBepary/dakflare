<script lang="ts">
	import { describeError, getCommand, getTrace } from '$lib/api';
	import {
		COMMAND_STEPS,
		commandFailureReason,
		commandStateLabel,
		commandStateNote,
		commandStateTone,
		commandStepIndex,
		commandStepLabel,
		isTerminalCommand
	} from '$lib/commands';
	import type { CommandInfo, TraceResult } from '$lib/types';
	import { formatAbsolute, formatClock } from '$lib/format';
	import {
		traceAuditRows,
		traceKindNoun,
		traceLineage,
		verdictLabel,
		verdictNote,
		verdictTone
	} from '$lib/trace';
	import Badge from './Badge.svelte';
	import CopyButton from './CopyButton.svelte';
	import Icon from './Icon.svelte';
	import Spinner from './Spinner.svelte';

	let {
		deviceId,
		commandId,
		onResend
	}: {
		deviceId: string;
		commandId: string;
		onResend?: (to: string, body: string) => void | Promise<void>;
	} = $props();

	const POLL_INTERVAL_MS = 2_000;
	const POLL_WINDOW_MS = 30_000;

	const uid = $props.id();
	const tracePanelId = `trace-${uid}`;

	let command = $state<CommandInfo | null | undefined>(undefined);
	let error = $state<string | null>(null);
	let finished = $state(false);
	let timedOut = $state(false);
	let furthest = $state(0);
	let run = $state(0);
	let resending = $state(false);
	let resendError = $state<string | null>(null);

	/**
	 * The trace is fetched, not assumed. It is the only place the reason for a
	 * failure and the records behind it are joined (`reply-fate-trace.ts`), so the
	 * panel loads on first open and stays until the command it describes changes.
	 */
	let traceOpen = $state(false);
	let trace = $state<TraceResult | null>(null);
	let traceError = $state<string | null>(null);
	let traceLoading = $state(false);
	let traceRun = 0;

	const commandState = $derived(command?.state ?? null);
	const failed = $derived(commandState === 'FAILED' || commandState === 'EXPIRED');
	const failureReason = $derived(commandFailureReason(command));
	const canResend = $derived(
		Boolean(
			command &&
				failed &&
				onResend &&
				command.to.trim() !== '' &&
				command.body.trim() !== ''
		)
	);
	const shortId = $derived(
		commandId.length > 14 ? `${commandId.slice(0, 8)}…${commandId.slice(-4)}` : commandId
	);
	/**
	 * Which command this tracker follows, as one value.
	 *
	 * A parent that re-reads its list hands over the same ids again, and reading
	 * the props one by one let that restart the poll and close the trace. A
	 * derived string compares by value, so only a genuinely different command (or
	 * "Check again") restarts anything.
	 */
	const trackerKey = $derived(`${deviceId}\u0000${commandId}\u0000${run}`);
	const lineage = $derived(trace === null ? [] : traceLineage(trace));
	const auditRows = $derived(trace === null ? [] : traceAuditRows(trace));

	const announcement = $derived.by(() => {
		if (command === undefined && !error) return 'Checking the message state.';
		if (error && command === undefined) return `Message state unavailable. ${error}`;
		if (command === null) return 'The gateway has no record of this message.';
		if (!command) return '';
		const reason = failed && failureReason ? ` ${failureReason}` : '';
		return `Message state: ${commandStateLabel(command.state)}. ${commandStateNote(command.state)}${reason}`;
	});

	/**
	 * Poll every two seconds for thirty seconds, or until the command reaches a
	 * terminal state. `trackerKey` carries `run`, so "Check again" starts a fresh
	 * window. The cleanup clears the pending timer on unmount and on a new command.
	 */
	$effect(() => {
		const [device, id] = trackerKey.split('\u0000');
		if (!device || !id) return;
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const started = Date.now();

		command = undefined;
		error = null;
		finished = false;
		timedOut = false;
		furthest = 0;
		resending = false;
		resendError = null;
		// A trace belongs to the command it was read for, so a new command drops it
		// and invalidates any answer still in flight.
		traceOpen = false;
		trace = null;
		traceError = null;
		traceLoading = false;
		traceRun += 1;

		async function poll() {
			try {
				const next = await getCommand(device, id);
				if (cancelled) return;
				command = next;
				error = null;
				const index = commandStepIndex(next?.state);
				// FAILED can only follow DISPATCHED or SENT. When the first
				// response already says FAILED, mark the earliest possible failure
				// stage rather than pretending PENDING failed.
				const reached = next?.state === 'FAILED' ? Math.max(index, 2) : index;
				if (reached > furthest) furthest = reached;
				if (next === null || isTerminalCommand(next.state)) {
					finished = true;
					return;
				}
			} catch (failure) {
				if (cancelled) return;
				error = describeError(failure);
			}

			if (Date.now() - started >= POLL_WINDOW_MS) {
				finished = true;
				timedOut = true;
				return;
			}
			timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
		}

		void poll();

		return () => {
			cancelled = true;
			if (timer) clearTimeout(timer);
		};
	});

	function restart() {
		run += 1;
	}

	async function resend(): Promise<void> {
		if (!command || !onResend || !canResend || resending) return;
		const recipient = command.to;
		const message = command.body;
		resending = true;
		resendError = null;
		try {
			await onResend(recipient, message);
		} catch (failure) {
			resendError = describeError(failure);
		} finally {
			resending = false;
		}
	}

	async function loadTrace(): Promise<void> {
		const current = ++traceRun;
		traceLoading = true;
		traceError = null;
		try {
			const next = await getTrace(commandId, deviceId);
			if (current !== traceRun) return;
			trace = next;
		} catch (failure) {
			if (current !== traceRun) return;
			traceError = describeError(failure);
		} finally {
			if (current === traceRun) traceLoading = false;
		}
	}

	function toggleTrace(): void {
		traceOpen = !traceOpen;
		if (traceOpen && trace === null && !traceLoading) void loadTrace();
	}
</script>

<div class="tracker" data-state={commandState ?? 'checking'}>
	<div class="tracker-head">
		<span class="eyebrow">Delivery</span>
		{#if command === undefined && !error}
			<span class="checking mono"><Spinner /> checking</span>
		{:else if command === null}
			<Badge tone="muted">No record</Badge>
		{:else if !command}
			<Badge tone="warn">Unreachable</Badge>
		{:else}
			<span title={command.state}>
				<Badge tone={commandStateTone(command.state)}>
					{commandStateLabel(command.state)}
				</Badge>
			</span>
		{/if}
		<span class="spacer"></span>
		<span class="cmd-id mono" title={commandId}>{shortId}</span>
		<CopyButton value={commandId} label="Copy message id" iconOnly />
	</div>

	{#if command}
		<dl class="tracker-meta">
			<div>
				<dt>To</dt>
				<dd class="mono">{command.to}</dd>
			</div>
			<div>
				<dt>Queued</dt>
				<dd class="mono" title={formatAbsolute(command.created_at)}>
					{formatClock(command.created_at)}
				</dd>
			</div>
			<div>
				<dt>Expires</dt>
				<dd class="mono" title={formatAbsolute(command.expires_at)}>
					{formatClock(command.expires_at)}
				</dd>
			</div>
		</dl>
	{/if}

	<ol class="timeline" class:failed aria-label="Message state">
		{#each COMMAND_STEPS as step, index (step)}
			{@const reached = command !== undefined && command !== null && index <= furthest}
			{@const current = command !== undefined && command !== null && index === furthest}
			<li class:reached class:current class:bad={failed && index === furthest}>
				<span class="step-mark" aria-hidden="true">
					{#if index < furthest || (current && finished && !failed)}
						<Icon name="check" size={9} />
					{/if}
				</span>
				<span class="step-name">{commandStepLabel(step)}</span>
				{#if current && !failed && !finished}
					<span class="step-live" aria-hidden="true"></span>
				{/if}
			</li>
		{/each}
	</ol>

	{#if command === null}
		<div class="tracker-note">
			<Icon name="info" size={13} />
			<span>
				No record of this message. It either expired before the phone collected it, or it
				was never a message.
			</span>
		</div>
	{:else if command}
		{#if failed && failureReason}
			<div class="failure" data-tone={commandState === 'EXPIRED' ? 'warn' : 'danger'}>
				<Icon name="alert" size={13} />
				<div class="failure-body">
					<span class="failure-label mono">
						{commandState === 'EXPIRED' ? 'Why' : 'Reason'}
					</span>
					<p>{failureReason}</p>
				</div>
			</div>
		{/if}

		<div class="state-line">
			{#if failed}
				<span class="spacer"></span>
			{:else}
				<p class="note">{commandStateNote(command.state)}</p>
			{/if}
			{#if canResend}
				<button
					type="button"
					class="btn btn-sm"
					onclick={() => void resend()}
					disabled={resending}
					aria-busy={resending}
				>
					{#if resending}<Spinner />{:else}<Icon name="refresh" size={12} />{/if}
					Send again
				</button>
			{/if}
		</div>
		{#if resendError}
			<p class="field-error" role="alert">{resendError}</p>
		{/if}

		{#if failed}
			<div class="trace-block">
				<button
					type="button"
					class="btn btn-ghost btn-sm trace-toggle"
					onclick={toggleTrace}
					aria-expanded={traceOpen}
					aria-controls={traceOpen ? tracePanelId : undefined}
				>
					<Icon name={traceOpen ? 'chevron-up' : 'chevron-down'} size={13} />
					{traceOpen ? 'Hide trace' : 'Trace'}
				</button>

				{#if traceOpen}
					<div
						class="trace"
						id={tracePanelId}
						aria-busy={traceLoading}
						aria-live="polite"
					>
						{#if traceLoading && trace === null}
							<p class="trace-reading mono" aria-busy="true">
								<Spinner /> reading the trace
							</p>
						{:else if trace === null && traceError}
							<div class="trace-failed" role="alert">
								<p class="field-error">{traceError}</p>
								<button type="button" class="btn btn-sm" onclick={() => void loadTrace()}>
									<Icon name="refresh" size={12} /> Try again
								</button>
							</div>
						{:else if trace}
							<div class="trace-head">
								<Badge tone={verdictTone(trace.verdict)}>
									{verdictLabel(trace.verdict)}
								</Badge>
								<span class="trace-kind">This id is {traceKindNoun(trace.kind)}.</span>
							</div>

							{#if verdictNote(trace.verdict)}
								<p class="trace-line">{verdictNote(trace.verdict)}</p>
							{/if}

							{#if trace.why.length > 0}
								<div class="trace-part">
									<span class="trace-label mono">Why</span>
									<ul class="trace-why">
										{#each trace.why as line, index (index)}
											<li>{line}</li>
										{/each}
									</ul>
								</div>
							{/if}

							{#if lineage.length > 0}
								<div class="trace-part">
									<span class="trace-label mono">Lineage</span>
									<dl class="trace-lineage">
										{#each lineage as row (`${row.label}-${row.value}`)}
											<div class="trace-row">
												<dt>{row.label}</dt>
												<dd>
													<span class="trace-value mono">{row.value}</span>
													{#if row.note}
														<span class="trace-note">{row.note}</span>
													{/if}
												</dd>
											</div>
										{/each}
									</dl>
								</div>
							{/if}

							{#if auditRows.length > 0}
								<div class="trace-part">
									<span class="trace-label mono">Audit</span>
									<ul class="trace-audit">
										{#each auditRows as row, index (index)}
											<li>
												<span class="trace-value mono">{row.value}</span>
												{#if row.note}<span class="trace-note">{row.note}</span>{/if}
											</li>
										{/each}
									</ul>
								</div>
							{/if}

							{#if trace.warnings.length > 0}
								<div class="trace-part">
									<span class="trace-label mono">Gaps</span>
									<ul class="trace-why">
										{#each trace.warnings as line, index (index)}
											<li>{line}</li>
										{/each}
									</ul>
								</div>
							{/if}

							<div class="trace-foot">
								<button
									type="button"
									class="btn btn-sm"
									onclick={() => void loadTrace()}
									disabled={traceLoading}
									aria-busy={traceLoading}
								>
									{#if traceLoading}<Spinner />{:else}<Icon name="refresh" size={12} />{/if}
									Refresh trace
								</button>
								{#if traceError}
									<p class="field-error">The last read failed: {traceError}</p>
								{/if}
							</div>
						{/if}
					</div>
				{/if}
			</div>
		{/if}
	{:else if error}
		<p class="field-error">{error}</p>
	{/if}

	{#if timedOut}
		<div class="tracker-foot">
			<span class="hint">No change after 30 seconds. The phone has not reported back.</span>
			<span class="spacer"></span>
			<button type="button" class="btn btn-sm" onclick={restart}>
				<Icon name="refresh" size={12} /> Check again
			</button>
		</div>
	{:else if !finished && command !== undefined && !error}
		<span class="tracker-foot hint">Waiting for the phone…</span>
	{/if}

	{#if error && command !== undefined}
		<p class="field-error">
			<!-- The error already ends in a full stop when it comes from the gateway,
			     so appending one rendered "try again.. Retrying…". -->
			Last check failed: {error.replace(/\.$/, '')}.{finished ? ' Checks stopped.' : ' Retrying…'}
		</p>
	{/if}

	<span class="sr-only" aria-live="polite">{announcement}</span>
</div>

<style>
	.tracker {
		display: grid;
		gap: var(--df-p-space-3);
		padding: var(--df-p-space-3) var(--df-p-space-4);
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-md);
		background: var(--df-surface-well);
	}

	.tracker-head {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-2);
		flex-wrap: wrap;
	}

	.cmd-id {
		font-size: var(--df-p-text-xs);
		color: var(--df-text-meta);
	}

	.checking {
		display: inline-flex;
		align-items: center;
		gap: var(--df-p-space-1);
		font-size: var(--df-p-text-xs);
		letter-spacing: 0.04em;
		color: var(--df-text-meta);
	}

	.tracker-meta {
		display: flex;
		flex-wrap: wrap;
		gap: var(--df-p-space-1) var(--df-p-space-5);
		margin: 0;
		padding-bottom: var(--df-p-space-3);
		border-bottom: 1px solid var(--df-border-hairline);
	}

	.tracker-meta > div {
		display: flex;
		align-items: baseline;
		gap: var(--df-p-space-1);
		min-width: 0;
	}

	.tracker-meta dt {
		font-family: var(--df-p-font-mono);
		font-size: var(--df-p-text-2xs);
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--df-text-meta);
	}

	.tracker-meta dd {
		margin: 0;
		font-size: var(--df-p-text-xs);
		color: var(--df-text-secondary);
		overflow-wrap: anywhere;
	}

	.timeline {
		position: relative;
		display: grid;
		gap: 0;
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.timeline li {
		position: relative;
		display: flex;
		align-items: center;
		gap: var(--df-p-space-2);
		min-height: 24px;
	}

	.timeline li:not(:last-child)::before {
		content: '';
		position: absolute;
		left: 6px;
		top: 17px;
		bottom: -5px;
		width: 1px;
		background: var(--df-border-control);
	}

	.timeline li.reached:not(:last-child)::before {
		background: var(--df-accent-fill);
	}

	.timeline.failed li.bad:not(:last-child)::before {
		background: var(--df-state-danger-fill);
	}

	.step-mark {
		position: relative;
		z-index: 1;
		display: grid;
		place-items: center;
		width: 13px;
		height: 13px;
		flex: none;
		border: 1px solid var(--df-border-control);
		border-radius: 50%;
		background: var(--df-surface-card);
		color: var(--df-text-on-accent);
	}

	.reached .step-mark {
		border-color: var(--df-accent-fill);
		background: var(--df-accent-fill);
	}

	.current .step-mark {
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--df-accent-fill) 18%, transparent);
	}

	.bad .step-mark {
		border-color: var(--df-state-danger-fill);
		background: var(--df-state-danger-fill);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--df-state-danger-fill) 16%, transparent);
	}

	.step-name {
		font-family: var(--df-p-font-sans);
		font-size: var(--df-p-text-sm);
		color: var(--df-text-meta);
	}

	.reached .step-name {
		color: var(--df-text-secondary);
	}

	.current .step-name {
		color: var(--df-text-primary);
		font-weight: 600;
	}

	.bad .step-name {
		color: var(--df-state-danger-ink);
		font-weight: 600;
	}

	.step-live {
		width: 4px;
		height: 4px;
		border-radius: 50%;
		background: var(--df-accent-fill);
		animation: live-pulse 1.8s ease-in-out infinite;
	}

	@keyframes live-pulse {
		0%,
		100% {
			opacity: 0.3;
		}
		50% {
			opacity: 1;
		}
	}

	.tracker-note {
		display: flex;
		align-items: flex-start;
		gap: var(--df-p-space-2);
		padding: var(--df-p-space-2) var(--df-p-space-3);
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-sm);
		background: var(--df-surface-card);
		color: var(--df-text-meta);
		font-size: var(--df-p-text-sm);
		line-height: 1.5;
	}

	.tracker-foot {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-2);
		flex-wrap: wrap;
	}

	.state-line {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-3);
		flex-wrap: wrap;
	}

	.state-line .note {
		flex: 1;
		min-width: 180px;
		font-size: var(--df-p-text-sm);
		line-height: 1.5;
		color: var(--df-text-secondary);
	}

	.failure {
		display: flex;
		align-items: flex-start;
		gap: var(--df-p-space-2);
		padding: 9px 11px;
		border: 1px solid var(--df-c-tint-edge-danger);
		border-left-width: 2px;
		border-radius: var(--df-p-radius-sm);
		background: var(--df-state-danger-bg);
		color: var(--df-state-danger-ink);
		font-size: var(--df-p-text-sm);
		line-height: 1.5;
	}

	.failure[data-tone='warn'] {
		border-color: var(--df-c-tint-edge-warn);
		background: var(--df-state-warn-bg);
		color: var(--df-state-warn-ink);
	}

	.failure :global(svg) {
		flex: none;
		margin-top: 2px;
	}

	.failure-body {
		min-width: 0;
	}

	.failure-label {
		display: block;
		font-size: var(--df-p-text-2xs);
		letter-spacing: 0.08em;
		text-transform: uppercase;
		opacity: 0.8;
	}

	.failure-body p {
		margin: 2px 0 0;
		overflow-wrap: anywhere;
	}

	.trace-block {
		display: grid;
		gap: var(--df-p-space-2);
		justify-items: start;
		padding-top: var(--df-p-space-1);
		border-top: 1px solid var(--df-border-hairline);
	}

	.trace-toggle {
		color: var(--df-text-secondary);
	}

	.trace {
		display: grid;
		gap: var(--df-p-space-3);
		justify-self: stretch;
		width: 100%;
		min-width: 0;
		padding: var(--df-p-space-3);
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-sm);
		background: var(--df-surface-card);
	}

	.trace-reading {
		display: inline-flex;
		align-items: center;
		gap: var(--df-p-space-1);
		font-size: var(--df-p-text-xs);
		letter-spacing: 0.04em;
		color: var(--df-text-meta);
	}

	.trace-failed {
		display: grid;
		gap: var(--df-p-space-2);
		justify-items: start;
	}

	.trace-head {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-2);
		flex-wrap: wrap;
		min-width: 0;
	}

	.trace-kind {
		font-size: var(--df-p-text-xs);
		color: var(--df-text-meta);
	}

	.trace-line {
		margin: 0;
		font-size: var(--df-p-text-sm);
		line-height: 1.5;
		color: var(--df-text-secondary);
	}

	.trace-part {
		display: grid;
		gap: 5px;
		min-width: 0;
	}

	.trace-label {
		font-size: var(--df-p-text-2xs);
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--df-text-meta);
	}

	.trace-why,
	.trace-audit {
		display: grid;
		gap: 4px;
		margin: 0;
		padding: 0;
		list-style: none;
		min-width: 0;
	}

	.trace-why li {
		position: relative;
		padding-left: 13px;
		font-size: var(--df-p-text-sm);
		line-height: 1.5;
		color: var(--df-text-secondary);
		overflow-wrap: anywhere;
	}

	.trace-why li::before {
		content: '';
		position: absolute;
		left: 2px;
		top: 0.62em;
		width: 4px;
		height: 4px;
		border-radius: 50%;
		background: var(--df-border-control);
	}

	.trace-lineage {
		display: grid;
		gap: 4px;
		margin: 0;
		min-width: 0;
	}

	.trace-row,
	.trace-audit li {
		display: flex;
		align-items: baseline;
		gap: var(--df-p-space-3);
		min-width: 0;
	}

	.trace-row dt {
		flex: none;
		width: 88px;
		font-family: var(--df-p-font-mono);
		font-size: var(--df-p-text-2xs);
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--df-text-meta);
	}

	.trace-row dd {
		margin: 0;
		min-width: 0;
		display: flex;
		align-items: baseline;
		gap: var(--df-p-space-2);
		flex-wrap: wrap;
	}

	/* The note is a second fact, not part of the id: a dot keeps the mono value
	   from running into it. */
	.trace-row dd .trace-note::before {
		content: '·';
		margin-right: 6px;
		color: var(--df-text-meta);
	}

	.trace-value {
		font-size: var(--df-p-text-xs);
		color: var(--df-text-primary);
		overflow-wrap: anywhere;
	}

	.trace-note {
		font-size: var(--df-p-text-xs);
		color: var(--df-text-meta);
		overflow-wrap: anywhere;
	}

	.trace-foot {
		display: grid;
		gap: var(--df-p-space-2);
		justify-items: start;
		padding-top: var(--df-p-space-2);
		border-top: 1px solid var(--df-border-hairline);
	}

	@media (max-width: 560px) {
		.trace-row,
		.trace-audit li {
			flex-direction: column;
			align-items: flex-start;
			gap: 1px;
		}

		.trace-row dt {
			width: auto;
		}

		/* A wrapped note would start a line with a separator, which reads as a
		   stray bullet; the gap is enough once the label sits above. */
		.trace-row dd .trace-note::before {
			content: none;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.step-live {
			animation: none;
			opacity: 1;
		}
	}
</style>
