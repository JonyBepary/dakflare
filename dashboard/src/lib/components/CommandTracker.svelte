<script lang="ts">
	import { describeError, getCommand } from '$lib/api';
	import {
		COMMAND_STEPS,
		commandStateLabel,
		commandStateNote,
		commandStateTone,
		commandStepIndex,
		commandStepLabel,
		isTerminalCommand
	} from '$lib/commands';
	import type { CommandInfo } from '$lib/types';
	import { formatAbsolute, formatClock } from '$lib/format';
	import Badge from './Badge.svelte';
	import CopyButton from './CopyButton.svelte';
	import Icon from './Icon.svelte';
	import Spinner from './Spinner.svelte';

	let {
		deviceId,
		commandId,
		compact = false,
		onResend
	}: {
		deviceId: string;
		commandId: string;
		compact?: boolean;
		onResend?: (to: string, body: string) => void | Promise<void>;
	} = $props();

	const POLL_INTERVAL_MS = 2_000;
	const POLL_WINDOW_MS = 30_000;

	let command = $state<CommandInfo | null | undefined>(undefined);
	let error = $state<string | null>(null);
	let finished = $state(false);
	let timedOut = $state(false);
	let furthest = $state(0);
	let run = $state(0);
	let resending = $state(false);
	let resendError = $state<string | null>(null);

	const commandState = $derived(command?.state ?? null);
	const failed = $derived(commandState === 'FAILED' || commandState === 'EXPIRED');
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

	const announcement = $derived.by(() => {
		if (command === undefined && !error) return 'Checking the message state.';
		if (error && command === undefined) return `Message state unavailable. ${error}`;
		if (command === null) return 'The gateway has no record of this message.';
		if (!command) return '';
		return `Message state: ${commandStateLabel(command.state)}. ${commandStateNote(command.state)}`;
	});

	/**
	 * Poll every two seconds for thirty seconds, or until the command reaches a
	 * terminal state. `run` lets the operator start a fresh window on demand.
	 * The cleanup clears the pending timer on unmount and on a new command.
	 */
	$effect(() => {
		const device = deviceId;
		const id = commandId;
		if (!device || !id) return;

		// Reading `run` is what makes "Check again" restart this effect.
		void run;
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
</script>

{#if compact}
	<span
		class="compact"
		title={command === null
			? 'The gateway has no record of this message.'
			: (error ?? undefined)}
	>
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
			<span class="mini" aria-hidden="true">
				{#each COMMAND_STEPS as step, index (step)}
					<span
						class="mini-seg"
						class:on={index <= furthest}
						class:bad={failed && index === furthest}
					></span>
				{/each}
			</span>
		{/if}
		<span class="sr-only" aria-live="polite">{announcement}</span>
	</span>
{:else}
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
			<div class="state-line">
				<p class="note">{commandStateNote(command.state)}</p>
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
				Last check failed: {error}.{finished ? ' Checks stopped.' : ' Retrying…'}
			</p>
		{/if}

		<span class="sr-only" aria-live="polite">{announcement}</span>
	</div>
{/if}

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

	.compact {
		display: inline-flex;
		align-items: center;
		gap: var(--df-p-space-1);
		white-space: nowrap;
	}

	.mini {
		display: inline-flex;
		gap: 2px;
	}

	.mini-seg {
		width: 7px;
		height: 3px;
		border-radius: 1px;
		background: var(--df-border-control);
	}

	.mini-seg.on {
		background: var(--df-accent-fill);
	}

	.mini-seg.bad {
		background: var(--df-state-danger-fill);
	}

	@media (prefers-reduced-motion: reduce) {
		.step-live {
			animation: none;
			opacity: 1;
		}
	}
</style>
