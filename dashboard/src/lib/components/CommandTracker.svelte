<script lang="ts">
	import { describeError, getCommand } from '$lib/api';
	import {
		COMMAND_STEPS,
		commandStateNote,
		commandStateTone,
		commandStepIndex,
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
	const failedNote = $derived(
		commandState === 'EXPIRED'
			? 'The original expired before the phone collected it.'
			: 'The phone reported a failure.'
	);
	const shortId = $derived(
		commandId.length > 14 ? `${commandId.slice(0, 8)}…${commandId.slice(-4)}` : commandId
	);

	const announcement = $derived.by(() => {
		if (command === undefined && !error) return 'Checking command status.';
		if (error && command === undefined) return `Command status unavailable. ${error}`;
		if (command === null) return 'The gateway does not know this command id.';
		if (!command) return '';
		return `Command state ${command.state}. ${commandStateNote(command.state)}`;
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
				// FAILED can only follow ACKED_BY_DEVICE or SENT. When the first
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
			? 'The gateway has no record of this command id.'
			: (error ?? undefined)}
	>
		{#if command === undefined && !error}
			<span class="checking mono"><Spinner /> checking</span>
		{:else if command === null}
			<Badge tone="muted">untracked</Badge>
		{:else if !command}
			<Badge tone="warn">unreachable</Badge>
		{:else}
			<Badge tone={commandStateTone(command.state)} dot={!finished}>{command.state}</Badge>
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
	<div class="tracker">
		<div class="tracker-head">
			<span class="eyebrow">Delivery</span>
			{#if command === undefined && !error}
				<span class="checking mono"><Spinner /> checking</span>
			{:else if command === null}
				<Badge tone="muted">unknown</Badge>
			{:else if !command}
				<Badge tone="warn">unreachable</Badge>
			{:else}
				<Badge tone={commandStateTone(command.state)} dot={!finished}>{command.state}</Badge>
			{/if}
			<span class="spacer"></span>
			<span class="cmd-id mono" title={commandId}>{shortId}</span>
			<CopyButton value={commandId} label="Copy command id" iconOnly />
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

		<ol class="timeline" class:failed aria-label="Command state timeline">
			{#each COMMAND_STEPS as step, index (step)}
				{@const reached = command !== undefined && command !== null && index <= furthest}
				{@const current = command !== undefined && command !== null && index === furthest}
				<li class:reached class:current class:bad={failed && index === furthest}>
					<span class="step-mark" aria-hidden="true">
						{#if index < furthest || (current && finished && !failed)}
							<Icon name="check" size={10} />
						{/if}
					</span>
					<span class="step-name">{step}</span>
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
					The gateway returned <code>command: null</code> for this id. It may have expired out
					of the device's store, or the id was never a command.
				</span>
			</div>
		{:else if command}
			<div class="state-line">
				<p class="hint">
					{canResend ? failedNote : commandStateNote(command.state)}
				</p>
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
				<span class="hint">Stopped checking after 30 seconds.</span>
				<span class="spacer"></span>
				<button type="button" class="btn btn-sm" onclick={restart}>
					<Icon name="refresh" size={12} /> Check again
				</button>
			</div>
		{:else if finished && command === null}
			<p class="hint">Polling stopped — nothing to track.</p>
		{:else if finished && !failed}
			<p class="hint">Polling stopped — this is a final state.</p>
		{:else if !finished && command !== undefined && !error}
			<span class="tracker-foot hint mono">live · every 2s</span>
		{/if}

		{#if error && command !== undefined}
			<p class="field-error">
				Last check failed: {error}.{finished ? ' Polling stopped.' : ' Retrying…'}
			</p>
		{/if}

		<span class="sr-only" aria-live="polite">{announcement}</span>
	</div>
{/if}

<style>
	.tracker {
		display: grid;
		gap: var(--s-3);
		padding: var(--s-3) var(--s-4);
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		background: color-mix(in srgb, var(--surface-2) 38%, var(--surface));
	}

	.tracker-head {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		flex-wrap: wrap;
	}

	.cmd-id {
		font-size: 10.5px;
		color: var(--ink-3);
	}

	.checking {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-size: 10px;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--ink-3);
	}

	.timeline {
		position: relative;
		display: grid;
		gap: 0;
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.tracker-meta {
		display: flex;
		flex-wrap: wrap;
		gap: 3px var(--s-5);
		margin: 0;
		padding: 0 0 var(--s-3);
		border-bottom: 1px solid var(--line);
	}

	.tracker-meta > div {
		display: flex;
		align-items: baseline;
		gap: 6px;
		min-width: 0;
	}

	.tracker-meta dt {
		font-family: var(--font-mono);
		font-size: 9px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--ink-3);
	}

	.tracker-meta dd {
		margin: 0;
		font-size: 10.5px;
		color: var(--ink-2);
		overflow-wrap: anywhere;
	}

	.timeline li {
		position: relative;
		display: flex;
		align-items: center;
		gap: 9px;
		min-height: 26px;
		padding-left: 1px;
	}

	.timeline li:not(:last-child)::before {
		content: '';
		position: absolute;
		left: 7px;
		top: 19px;
		bottom: -7px;
		width: 1px;
		background: var(--line-strong);
	}

	.timeline li.reached:not(:last-child)::before {
		background: color-mix(in srgb, var(--accent) 55%, var(--line));
	}

	.timeline.failed li.bad:not(:last-child)::before {
		background: color-mix(in srgb, var(--danger) 55%, var(--line));
	}

	.step-mark {
		position: relative;
		z-index: 1;
		display: grid;
		place-items: center;
		width: 15px;
		height: 15px;
		flex: none;
		border: 1px solid var(--line-strong);
		border-radius: 50%;
		background: var(--surface);
		color: var(--accent-ink);
	}

	.reached .step-mark {
		border-color: var(--accent);
		background: var(--accent);
	}

	.current .step-mark {
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 16%, transparent);
	}

	.bad .step-mark {
		border-color: var(--danger);
		background: var(--danger);
		color: var(--danger-ink);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--danger) 15%, transparent);
	}

	.step-name {
		font-family: var(--font-mono);
		font-size: 10.5px;
		letter-spacing: 0.06em;
		color: var(--ink-3);
	}

	.reached .step-name {
		color: var(--ink-2);
	}

	.current .step-name {
		color: var(--ink);
		font-weight: 600;
	}

	.bad .step-name {
		color: var(--danger);
	}

	.step-live {
		width: 4px;
		height: 4px;
		border-radius: 50%;
		background: var(--accent);
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
		gap: 7px;
		padding: 8px 10px;
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		background: var(--surface);
		color: var(--ink-3);
		font-size: 11.5px;
		line-height: 1.5;
	}

	.tracker-note code {
		font-family: var(--font-mono);
		font-size: 10.5px;
	}

	.tracker-foot {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		flex-wrap: wrap;
	}

	.state-line {
		display: flex;
		align-items: center;
		gap: var(--s-3);
		flex-wrap: wrap;
	}

	.state-line .hint {
		flex: 1;
		min-width: 180px;
	}

	.compact {
		display: inline-flex;
		align-items: center;
		gap: 7px;
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
		background: var(--line-strong);
	}

	.mini-seg.on {
		background: var(--accent);
	}

	.mini-seg.bad {
		background: var(--danger);
	}
</style>
