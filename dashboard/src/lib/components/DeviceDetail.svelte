<script lang="ts">
	import { onDestroy, tick } from 'svelte';
	import {
		describeError,
		getDeviceCommands,
		getDeviceStatus,
		getMessages,
		purgeMessages,
		revokeDevice,
		sendSms
	} from '$lib/api';
	import type { Device, DeviceCommand, DeviceStatus, Message } from '$lib/types';
	import {
		commandStateLabel,
		commandStateNote,
		commandStateTone,
		isTerminalCommand
	} from '$lib/commands';
	import { answerOf, answerPhrase } from '$lib/answers';
	import { replyFatesOf } from '$lib/replies';
	import {
		PRESENCE_META,
		deviceLabel,
		devicePresence,
		devicePrimary,
		wakeMode
	} from '$lib/presence';
	import { formatAbsolute, formatClock, formatDate } from '$lib/format';
	import Badge from './Badge.svelte';
	import CommandTracker from './CommandTracker.svelte';
	import ConfirmDialog from './ConfirmDialog.svelte';
	import CopyButton from './CopyButton.svelte';
	import EmptyState from './EmptyState.svelte';
	import Icon from './Icon.svelte';
	import Notice from './Notice.svelte';
	import RelativeTime from './RelativeTime.svelte';
	import ReplyFate from './ReplyFate.svelte';
	import SendSmsForm from './SendSmsForm.svelte';
	import Spinner from './Spinner.svelte';

	let {
		open = false,
		deviceId,
		device = null,
		onclose,
		onrevoked,
		onmint
	}: {
		open?: boolean;
		deviceId: string;
		device?: Device | null;
		onclose: () => void;
		onrevoked?: (deviceId: string) => void;
		onmint?: (deviceId: string) => void;
	} = $props();

	const uid = $props.id();
	const titleId = `device-detail-title-${uid}`;

	const MESSAGE_LIMIT = 20;
	const COMMAND_LIMIT = 20;
	const COMMAND_POLL_MS = 5_000;

	let dialog = $state<HTMLDialogElement | null>(null);
	let closeButton = $state<HTMLButtonElement | null>(null);

	let status = $state<DeviceStatus | null>(null);
	let statusError = $state<string | null>(null);
	let messages = $state<Message[]>([]);
	let messagesError = $state<string | null>(null);
	let commands = $state<DeviceCommand[]>([]);
	let commandsError = $state<string | null>(null);
	let commandsLoading = $state(false);
	let trackedCommands = $state<Record<string, string>>({});
	let commandVersion = 0;
	let commandInFlight = false;
	let loading = $state(false);
	let loadedFor = $state<string | null>(null);

	let sendOpen = $state(false);
	let purgedNotice = $state<string | null>(null);
	let linked = $state<string | null>(null);
	let linkedTimer: ReturnType<typeof setTimeout> | undefined;

	let revokeOpen = $state(false);
	let revoking = $state(false);
	let revokeError = $state<string | null>(null);

	let purgeOpen = $state(false);
	let purging = $state(false);
	let purgeError = $state<string | null>(null);

	const label = $derived(device?.label?.trim() || 'Unlabeled device');
	const presence = $derived(
		device ? devicePresence(device, status?.ws_connected === true) : 'unknown'
	);
	const stateSentence = $derived.by(() => {
		const meaning = PRESENCE_META[presence].meaning;
		return `${meaning.charAt(0).toUpperCase()}${meaning.slice(1)}.`;
	});
	const wake = $derived(device ? wakeMode(device) : null);
	const simSlot = $derived.by(() => {
		const slot = device?.sim_slot;
		// The phone stores the 1-based tray number (`simSlotIndex + 1`); a stored 0
		// is a pre-fix record and is honestly "not reported".
		return typeof slot === 'number' && slot >= 1 && slot <= 2 ? `SIM ${slot}` : null;
	});

	// The same words as the message log and the tracker. A reply says its own
	// fate; a question inherits it from the reply row, when that row is loaded.
	const fates = $derived(replyFatesOf(messages));

	function messageRowId(id: string): string {
		return `dlog-${uid}-${id}`;
	}

	async function followReply(id: string): Promise<void> {
		linked = id;
		await tick();
		const row = document.getElementById(messageRowId(id));
		if (!row) return;
		const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		// Scroll the drawer's body, never the dialog: scrolling the dialog would
		// carry its header (and the device's name) out of view.
		const body = dialog?.querySelector<HTMLElement>('.drawer-body');
		if (body) {
			const offset = row.getBoundingClientRect().top - body.getBoundingClientRect().top;
			body.scrollBy({
				top: offset - (body.clientHeight - row.offsetHeight) / 2,
				behavior: reduced ? 'auto' : 'smooth'
			});
		} else {
			row.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
		}
		row.focus({ preventScroll: true });
		if (linkedTimer) clearTimeout(linkedTimer);
		linkedTimer = setTimeout(() => {
			linked = null;
		}, 2_400);
	}

	onDestroy(() => {
		if (linkedTimer) clearTimeout(linkedTimer);
	});

	$effect(() => {
		const el = dialog;
		if (!el) return;
		if (open && !el.open) {
			el.showModal();
			void tick().then(() => closeButton?.focus());
		} else if (!open && el.open) {
			el.close();
		}
	});

	$effect(() => {
		if (!open) {
			loadedFor = null;
			return;
		}
		if (!deviceId || loadedFor === deviceId) return;
		loadedFor = deviceId;
		sendOpen = false;
		purgedNotice = null;
		revokeOpen = false;
		purgeOpen = false;
		revokeError = null;
		purgeError = null;
		status = null;
		messages = [];
		commands = [];
		commandsError = null;
		commandsLoading = false;
		trackedCommands = {};
		commandVersion += 1;
		commandInFlight = false;
		void loadAll(deviceId, true);
	});

	$effect(() => {
		if (!open) return;
		const id = deviceId;
		const timer = setInterval(() => {
			if (document.visibilityState === 'visible' && id === deviceId) {
				void loadCommands(id);
			}
		}, COMMAND_POLL_MS);
		return () => clearInterval(timer);
	});

	$effect(() => {
		if (!open) return;
		const previous = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		return () => {
			document.body.style.overflow = previous;
		};
	});

	async function loadAll(id = deviceId, initial = false): Promise<void> {
		if (!id) return;
		loading = true;
		if (initial) {
			statusError = null;
			messagesError = null;
		}
		const [statusResult, messagesResult] = await Promise.allSettled([
			getDeviceStatus(id),
			getMessages(id, MESSAGE_LIMIT)
		]);
		// The operator can switch devices while a slow read is in flight; the
		// late answer belongs to the device that is no longer on screen.
		if (id !== deviceId) return;
		status = statusResult.status === 'fulfilled' ? statusResult.value : null;
		statusError = statusResult.status === 'rejected' ? describeError(statusResult.reason) : null;
		if (messagesResult.status === 'fulfilled') {
			messages = messagesResult.value.messages;
			messagesError = null;
		} else {
			messages = [];
			messagesError = describeError(messagesResult.reason);
		}
		loading = false;
		void loadCommands(id, initial);
	}

	async function loadCommands(id = deviceId, initial = false): Promise<void> {
		if (!id || (commandInFlight && !initial)) return;
		const version = ++commandVersion;
		commandInFlight = true;
		if (initial || commands.length === 0) commandsLoading = true;
		try {
			const list = await getDeviceCommands(id, COMMAND_LIMIT);
			if (version !== commandVersion || id !== deviceId) return;
			commands = list;
			commandsError = null;
		} catch (failure) {
			if (version === commandVersion && id === deviceId) {
				commandsError = describeError(failure);
			}
		} finally {
			if (version === commandVersion) {
				commandsLoading = false;
				commandInFlight = false;
			}
		}
	}

	function toggleCommandTracker(rowId: string, commandId: string): void {
		const next = { ...trackedCommands };
		if (rowId in next) delete next[rowId];
		else next[rowId] = commandId;
		trackedCommands = next;
	}

	async function resendCommand(rowId: string, recipient: string, body: string): Promise<void> {
		if (!deviceId) return;
		const result = await sendSms({ device_id: deviceId, to: recipient, body });
		trackedCommands = { ...trackedCommands, [rowId]: result.command_id };
		void loadCommands(deviceId, true);
	}

	async function confirmRevoke(): Promise<void> {
		if (revoking) return;
		revoking = true;
		revokeError = null;
		try {
			await revokeDevice(deviceId);
			revoking = false;
			revokeOpen = false;
			onrevoked?.(deviceId);
			onclose();
		} catch (failure) {
			revokeError = describeError(failure);
			revoking = false;
		}
	}

	async function confirmPurge(): Promise<void> {
		if (purging) return;
		purging = true;
		purgeError = null;
		try {
			const result = await purgeMessages(deviceId);
			purging = false;
			purgeOpen = false;
			messages = [];
			purgedNotice = `${result.deleted} ${result.deleted === 1 ? 'message' : 'messages'} and ${result.flow_runs_deleted} ${result.flow_runs_deleted === 1 ? 'flow run' : 'flow runs'} removed for this device.`;
		} catch (failure) {
			purgeError = describeError(failure);
			purging = false;
		}
	}

	function onQueued(): void {
		void loadAll();
	}

	function requestClose(): void {
		if (revoking || purging) return;
		onclose();
	}
</script>

<dialog
	bind:this={dialog}
	class="drawer"
	aria-labelledby={titleId}
	onclick={(event) => {
		if (event.target === dialog) requestClose();
	}}
	oncancel={(event) => {
		event.preventDefault();
		requestClose();
	}}
>
	<div class="drawer-shell">
		<header class="drawer-head">
			<div class="drawer-title">
				<p class="eyebrow">Device</p>
				<h2 id={titleId}>{label}</h2>
				<div class="id-line">
					<span class="mono">{deviceId}</span>
					<CopyButton value={deviceId} label="Copy device id" iconOnly />
				</div>
			</div>
			<button
				type="button"
				class="btn btn-ghost btn-icon"
				bind:this={closeButton}
				onclick={requestClose}
				aria-label="Close device details"
				title="Close"
			>
				<Icon name="x" size={16} />
			</button>
		</header>

		<div class="drawer-body">
			<!-- The one tinted container: the state the operator opened this for. -->
			<section
				class="state-block"
				data-presence={presence}
				aria-labelledby={`state-${uid}`}
			>
				<div class="state-lead">
					<p class="state-word" id={`state-${uid}`}>
						<span class="state-glyph" data-presence={presence} aria-hidden="true"></span>
						{presence}
					</p>
					<p class="state-sentence">
						{stateSentence}
						{#if device?.last_seen}
							Last contact <RelativeTime value={device.last_seen} fallback="never" />.
						{:else}
							No authenticated contact has been recorded.
						{/if}
					</p>
				</div>
				<div class="state-queue">
					<span class="fact-k">Queue</span>
					<span class="fact-v mono">{status ? status.queue_depth : '—'}</span>
				</div>
			</section>

			{#if statusError}
				<Notice tone="warn" title="Live status unavailable">{statusError}</Notice>
			{/if}

			<section class="section" aria-labelledby={`facts-${uid}`}>
				<div class="section-head">
					<h3 class="section-title" id={`facts-${uid}`}>Identity</h3>
					<span class="spacer"></span>
					<button
						type="button"
						class="btn btn-ghost btn-sm"
						onclick={() => void loadAll()}
						disabled={loading}
						aria-busy={loading}
					>
						{#if loading}<Spinner />{:else}<Icon name="refresh" size={12} />{/if}
						Refresh
					</button>
				</div>

				<dl class="facts">
					<div class="fact-row">
						<dt>Label</dt>
						<dd>
							{#if device?.label?.trim()}
								{device.label.trim()}
							{:else}
								<span class="muted">Not reported for this device</span>
							{/if}
						</dd>
					</div>

					<div class="fact-row">
						<dt>Paired</dt>
						<dd>
							{#if device}
								<span title={formatAbsolute(device.paired_at)}>
									{formatDate(device.paired_at)} · {formatClock(device.paired_at)}
								</span>
							{:else}
								<span class="muted">—</span>
							{/if}
						</dd>
					</div>

					<div class="fact-row">
						<dt>SIM slot</dt>
						<dd>
							{#if simSlot}
								<span class="mono">{simSlot}</span>
							{:else}
								<span class="muted">Not reported</span>
							{/if}
						</dd>
					</div>

					<div class="fact-row">
						<dt>Wake</dt>
						<dd>
							{#if wake}
								<span class="mono">{wake}</span>
								<span class="muted">
									·
									{wake === 'push'
										? 'the gateway can wake the phone.'
										: 'the phone is reached on its next check-in.'}
								</span>
							{:else}
								<span class="muted">—</span>
							{/if}
						</dd>
					</div>
				</dl>
			</section>

			<div class="action-row">
				<button
					type="button"
					class="btn btn-primary btn-sm"
					onclick={() => {
						onmint?.(deviceId);
						onclose();
					}}
				>
					<Icon name="key" size={13} /> Mint enroll code
				</button>
				<button
					type="button"
					class="btn btn-sm"
					onclick={() => (sendOpen = !sendOpen)}
					aria-expanded={sendOpen}
					aria-controls={sendOpen ? `send-panel-${uid}` : undefined}
				>
					<Icon name="send" size={13} /> Send SMS
				</button>
				<span class="spacer"></span>
				<button
					type="button"
					class="btn btn-danger btn-sm"
					onclick={() => {
						revokeError = null;
						revokeOpen = true;
					}}
				>
					<Icon name="trash" size={13} /> Revoke
				</button>
			</div>

			{#if sendOpen}
				<section class="section send-section" id={`send-panel-${uid}`} aria-labelledby={`send-${uid}`}>
					<div class="section-head">
						<h3 class="section-title" id={`send-${uid}`}>Send SMS from this device</h3>
					</div>
					<SendSmsForm
						devices={device ? [device] : []}
						deviceId={deviceId}
						onqueued={onQueued}
						autofocus
					/>
				</section>
			{/if}

			{#if purgedNotice}
				<div aria-live="polite">
					<Notice tone="ok" title="Message log purged">{purgedNotice}</Notice>
				</div>
			{/if}

			<section class="section" aria-labelledby={`commands-${uid}`}>
				<div class="section-head">
					<h3 class="section-title" id={`commands-${uid}`}>Outbound</h3>
					<span class="section-meta">
						{#if commandsLoading && commands.length === 0}<Spinner />{:else}newest {COMMAND_LIMIT}{/if}
					</span>
				</div>
				{#if commandsError}
					<p class="field-error">Could not refresh this list. {commandsError}</p>
				{/if}
				{#if commandsLoading && commands.length === 0}
					<div class="row-skeletons" aria-busy="true" aria-live="polite">
						<span class="sr-only">Loading outbound messages</span>
						{#each ['a', 'b'] as key (key)}
							<div class="skeleton" style="height: 46px"></div>
						{/each}
					</div>
				{:else if commands.length === 0}
					<p class="section-note">Nothing has been queued for this device.</p>
				{:else}
					<ul class="cmd-list">
						{#each commands as command (command.command_id)}
							<li class="cmd-row">
								<div class="cmd-head">
									<span class="mono cmd-peer">{command.to_e164 || '(no recipient)'}</span>
									<span title={command.state}>
										<Badge tone={commandStateTone(command.state)}>
											{commandStateLabel(command.state)}
										</Badge>
									</span>
									<span class="cmd-time mono">
										<RelativeTime value={command.created_at} />
									</span>
									<span class="spacer"></span>
									<button
										type="button"
										class="link-btn cmd-track-btn"
										onclick={() => toggleCommandTracker(command.command_id, command.command_id)}
										aria-expanded={command.command_id in trackedCommands}
										aria-controls={command.command_id in trackedCommands
											? `cmd-tracker-${command.command_id}`
											: undefined}
										title={commandStateNote(command.state)}
									>
										{command.command_id in trackedCommands ? 'Hide' : 'Track'}
									</button>
								</div>
								<p class="cmd-body">{command.body || '(empty message)'}</p>
								{#if command.command_id in trackedCommands}
									<div class="cmd-tracker" id={`cmd-tracker-${command.command_id}`}>
										<CommandTracker
											deviceId={deviceId}
											commandId={trackedCommands[command.command_id] ?? command.command_id}
											onResend={(to, body) =>
												resendCommand(command.command_id, to, body)}
										/>
									</div>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
			</section>

			<section class="section" aria-labelledby={`messages-${uid}`}>
				<div class="section-head">
					<h3 class="section-title" id={`messages-${uid}`}>Messages</h3>
					<span class="section-meta">
						{#if loading}<Spinner />{:else}newest {MESSAGE_LIMIT}{/if}
					</span>
					<span class="spacer"></span>
					{#if messages.length > 0}
						<button
							type="button"
							class="btn btn-danger-ghost btn-sm"
							onclick={() => {
								purgeError = null;
								purgeOpen = true;
							}}
						>
							<Icon name="trash" size={12} /> Purge log
						</button>
					{/if}
				</div>

				{#if messagesError}
					<Notice tone="danger" title="Could not load messages">{messagesError}</Notice>
					<button type="button" class="btn btn-sm" onclick={() => void loadAll()}>
						<Icon name="refresh" size={12} /> Try again
					</button>
				{:else if loading && messages.length === 0}
					<div class="row-skeletons" aria-busy="true" aria-live="polite">
						<span class="sr-only">Loading messages</span>
						{#each ['a', 'b', 'c'] as key (key)}
							<div class="skeleton" style="height: 52px"></div>
						{/each}
					</div>
				{:else if messages.length === 0}
					<EmptyState
						icon="message"
						title="No messages for this device yet"
						description="Inbound SMS appears after the phone syncs. Anything you queue here appears immediately."
					/>
				{:else}
					<ul class="dlog">
						{#each messages as message (message.id)}
							{@const outbound = message.direction === 'out'}
							{@const answer = answerPhrase(message)}
							{@const answerSource = answerOf(message)}
							{@const fate = fates.get(message.id) ?? null}
							{@const failedReply = !outbound && fate?.state === 'failed'}
							<li
								id={messageRowId(message.id)}
								class="dlog-row"
								class:is-linked={linked === message.id}
								data-dir={outbound ? 'out' : 'in'}
								tabindex="-1"
							>
								<span class="dlog-icon" aria-hidden="true">
									<Icon name={outbound ? 'arrow-up-right' : 'arrow-down-left'} size={13} />
								</span>
								<div class="dlog-main">
									<div class="dlog-head">
										<span class="sr-only">{outbound ? 'Outbound' : 'Inbound'} message</span>
										<span class="mono dlog-peer">{message.peer}</span>
										<span class="spacer"></span>
										<span class="dlog-time">
											<RelativeTime value={message.received_at} />
										</span>
									</div>
									<p class="dlog-body">{message.body || '(empty message)'}</p>
									{#if answer}
										<p class="dlog-answer" data-source={answerSource}>
											{answer}
										</p>
									{/if}
									{#if fate && (outbound || failedReply)}
										<p class="dlog-fate">
											<ReplyFate
												state={fate.state}
												error={fate.error}
												variant={outbound ? 'out' : 'in'}
												href={failedReply
													? `#${messageRowId(message.reply_command_id ?? '')}`
													: null}
												onfollow={failedReply
													? () => void followReply(message.reply_command_id ?? '')
													: null}
											/>
										</p>
									{/if}
								</div>
							</li>
						{/each}
					</ul>
				{/if}
			</section>
		</div>
	</div>
</dialog>

<ConfirmDialog
	open={revokeOpen}
	title="Revoke this device?"
	confirmLabel="Revoke device"
	tone="danger"
	pending={revoking}
	error={revokeError}
	onconfirm={() => void confirmRevoke()}
	oncancel={() => {
		if (!revoking) {
			revokeOpen = false;
			revokeError = null;
		}
	}}
>
	<p>
		<strong>{device ? devicePrimary(device) : deviceId}</strong>
		{#if device && deviceLabel(device)}(<span class="mono">{deviceId}</span>){/if}
		stops authenticating now. Its key is destroyed on the gateway and any queued message is
		dropped.
	</p>
	<p class="hint" style="margin-top: 10px">
		Pair it again with a new code to bring it back.
	</p>
</ConfirmDialog>

<ConfirmDialog
	open={purgeOpen}
	title="Delete this device's messages?"
	confirmLabel="Delete messages"
	tone="danger"
	pending={purging}
	error={purgeError}
	onconfirm={() => void confirmPurge()}
	oncancel={() => {
		if (!purging) {
			purgeOpen = false;
			purgeError = null;
		}
	}}
>
	<p>
		Every message and flow run stored for
		<strong>{device ? devicePrimary(device) : deviceId}</strong>
		{#if device && deviceLabel(device)}(<span class="mono">{deviceId}</span>){/if} is deleted. The
		device stays paired and new messages keep arriving. This cannot be undone.
	</p>
</ConfirmDialog>

<style>
	.drawer {
		position: fixed;
		inset: 0 0 0 auto;
		margin: 0;
		padding: 0;
		width: min(620px, 100vw);
		max-width: 100vw;
		height: 100dvh;
		max-height: 100dvh;
		border: 0;
		border-left: 1px solid var(--df-border-control);
		border-radius: var(--df-p-radius-xl) 0 0 var(--df-p-radius-xl);
		background: var(--df-surface-card);
		color: var(--df-text-primary);
		box-shadow: var(--df-shadow-dialog);
		overflow: hidden;
	}

	/* `settle` is the only entrance in the system: 220ms, 6px, no slide. */
	.drawer[open] {
		animation: settle var(--df-p-dur-settle) var(--df-p-ease-standard) both;
	}

	.drawer::backdrop {
		background: var(--df-c-dialog-scrim);
	}

	@keyframes settle {
		from {
			opacity: 0;
			transform: translateY(6px);
		}
		to {
			opacity: 1;
			transform: none;
		}
	}

	.drawer-shell {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
	}

	.drawer-head {
		display: flex;
		align-items: flex-start;
		gap: var(--df-p-space-3);
		flex: none;
		padding: var(--df-p-space-4) var(--df-p-space-5);
		border-bottom: 1px solid var(--df-border-hairline);
		background: var(--df-surface-card);
	}

	.drawer-title {
		min-width: 0;
		flex: 1;
	}

	.drawer-title h2 {
		margin-top: 2px;
		font-size: var(--df-p-text-xl);
		font-weight: 700;
		letter-spacing: -0.02em;
		overflow-wrap: anywhere;
	}

	.id-line {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-1);
		margin-top: var(--df-p-space-1);
		min-width: 0;
		font-size: var(--df-p-text-xs);
		color: var(--df-text-meta);
	}

	.id-line .mono {
		overflow-wrap: anywhere;
	}

	.drawer-body {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		overscroll-behavior: contain;
		display: flex;
		flex-direction: column;
		gap: var(--df-p-space-5);
		padding: var(--df-p-space-5);
	}

	/* The body scrolls; its children must keep their natural height instead of
	   being squeezed by the flex column. */
	.drawer-body > * {
		flex: none;
	}

	/* ---------- state block ---------- */

	.state-block {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--df-p-space-4);
		padding: var(--df-p-space-4);
		border: 1px solid var(--df-c-tint-edge-neutral);
		border-radius: var(--df-p-radius-lg);
		background: var(--df-state-neutral-bg);
	}

	.state-block[data-presence='live'],
	.state-block[data-presence='synced'] {
		border-color: var(--df-c-tint-edge-ok);
		background: var(--df-state-ok-bg);
	}

	.state-block[data-presence='stale'] {
		border-color: var(--df-c-tint-edge-warn);
		background: var(--df-state-warn-bg);
	}

	.state-block[data-presence='offline'] {
		border-color: var(--df-c-tint-edge-danger);
		background: var(--df-state-danger-bg);
	}

	.state-lead {
		min-width: 0;
	}

	.state-word {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-2);
		font-family: var(--df-font-display);
		font-size: var(--df-p-text-xl);
		font-weight: 700;
		line-height: 1.1;
		letter-spacing: -0.02em;
		color: var(--df-text-primary);
	}

	/* Same five shapes as PresenceChip, so the drawer and the row agree. */
	.state-glyph {
		width: 9px;
		height: 9px;
		flex: none;
		border-radius: 50%;
		background: var(--df-text-primary);
	}

	.state-glyph[data-presence='synced'] {
		background: transparent;
		box-shadow: inset 0 0 0 1.5px var(--df-text-primary);
	}

	.state-glyph[data-presence='stale'] {
		background: transparent;
		border-radius: 1px;
		box-shadow: inset 0 0 0 1.5px var(--df-text-primary);
	}

	.state-glyph[data-presence='offline'] {
		border-radius: 1px;
	}

	.state-glyph[data-presence='unknown'] {
		width: 10px;
		height: 2px;
		border-radius: 1px;
	}

	.state-sentence {
		margin-top: var(--df-p-space-1);
		font-size: var(--df-p-text-base);
		line-height: 1.5;
		color: var(--df-text-secondary);
	}

	.state-queue {
		display: flex;
		flex-direction: column;
		gap: 2px;
		flex: none;
		text-align: right;
	}

	.fact-k {
		font-family: var(--df-p-font-mono);
		font-size: var(--df-p-text-2xs);
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--df-text-meta);
	}

	.fact-v {
		font-size: var(--df-p-text-md);
		font-weight: 600;
		color: var(--df-text-primary);
	}

	/* ---------- sections ---------- */

	.section {
		display: grid;
		gap: var(--df-p-space-3);
		min-width: 0;
	}

	.section-head {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-2);
		padding-bottom: var(--df-p-space-2);
		border-bottom: 1px solid var(--df-border-hairline);
	}

	.section-title {
		font-family: var(--df-font-display);
		font-size: var(--df-p-text-md);
		font-weight: 700;
		letter-spacing: -0.01em;
		color: var(--df-text-primary);
	}

	.section-meta {
		font-family: var(--df-p-font-mono);
		font-size: var(--df-p-text-2xs);
		letter-spacing: 0.04em;
		color: var(--df-text-meta);
	}

	.section-note {
		font-size: var(--df-p-text-sm);
		color: var(--df-text-meta);
	}

	.facts {
		margin: 0;
	}

	.fact-row {
		display: grid;
		grid-template-columns: 92px minmax(0, 1fr);
		gap: var(--df-p-space-2) var(--df-p-space-3);
		padding: var(--df-p-space-2) 0;
		border-bottom: 1px solid var(--df-border-hairline);
		align-items: baseline;
	}

	.fact-row:last-child {
		border-bottom: 0;
	}

	.fact-row dt {
		font-family: var(--df-p-font-sans);
		font-size: var(--df-p-text-2xs);
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--df-text-meta);
	}

	.fact-row dd {
		margin: 0;
		font-size: var(--df-p-text-base);
		color: var(--df-text-primary);
		overflow-wrap: anywhere;
	}

	.action-row {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-2);
		flex-wrap: wrap;
	}

	.send-section {
		padding: var(--df-p-space-4);
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-md);
		background: var(--df-surface-well);
	}

	.send-section .section-head {
		border-bottom-color: var(--df-border-hairline);
	}

	/* ---------- outbound ---------- */

	.cmd-list {
		list-style: none;
		margin: 0;
		padding: 0;
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-md);
		overflow: hidden;
	}

	.cmd-row {
		padding: var(--df-p-space-2) var(--df-p-space-3);
		border-bottom: 1px solid var(--df-border-hairline);
		background: var(--df-surface-card);
	}

	.cmd-row:last-child {
		border-bottom: 0;
	}

	.cmd-head {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-2);
		flex-wrap: wrap;
	}

	.cmd-peer {
		font-size: var(--df-p-text-sm);
		font-weight: 500;
		color: var(--df-text-primary);
	}

	.cmd-time {
		font-size: var(--df-p-text-2xs);
		color: var(--df-text-meta);
	}

	.cmd-body {
		margin-top: var(--df-p-space-1);
		font-size: var(--df-p-text-sm);
		line-height: 1.5;
		color: var(--df-text-secondary);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.cmd-track-btn {
		font-size: var(--df-p-text-xs);
	}

	.cmd-tracker {
		margin-top: var(--df-p-space-2);
	}

	.row-skeletons {
		display: grid;
		gap: var(--df-p-space-2);
	}

	/* ---------- message log ---------- */

	.dlog {
		list-style: none;
		margin: 0;
		padding: 0;
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-md);
		overflow: hidden;
	}

	.dlog-row {
		display: grid;
		grid-template-columns: 24px minmax(0, 1fr);
		gap: var(--df-p-space-2);
		padding: var(--df-p-space-2) var(--df-p-space-3);
		border-bottom: 1px solid var(--df-border-hairline);
		scroll-margin-top: var(--df-p-space-6);
		transition: background-color var(--df-p-dur-lift) ease;
	}

	.dlog-row:focus-visible {
		outline-offset: -2px;
	}

	.dlog-row.is-linked {
		background: var(--df-accent-soft);
	}

	.dlog-row:last-child {
		border-bottom: 0;
	}

	.dlog-icon {
		display: grid;
		place-items: center;
		width: 22px;
		height: 22px;
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-sm);
		background: var(--df-surface-well);
		color: var(--df-text-meta);
	}

	.dlog-row[data-dir='out'] .dlog-icon {
		color: var(--df-accent-text);
		border-color: var(--df-accent-soft);
		background: var(--df-accent-soft);
	}

	.dlog-main {
		min-width: 0;
	}

	.dlog-head {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-2);
		flex-wrap: wrap;
	}

	.dlog-peer {
		font-size: var(--df-p-text-sm);
		font-weight: 500;
		color: var(--df-text-primary);
		overflow-wrap: anywhere;
	}

	.dlog-time {
		font-size: var(--df-p-text-2xs);
		color: var(--df-text-meta);
		white-space: nowrap;
	}

	.dlog-body {
		margin-top: 2px;
		font-size: var(--df-p-text-sm);
		line-height: 1.5;
		color: var(--df-text-secondary);
		overflow-wrap: anywhere;
		display: -webkit-box;
		-webkit-line-clamp: 3;
		line-clamp: 3;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.dlog-answer {
		margin-top: 2px;
		font-size: var(--df-p-text-2xs);
		color: var(--df-text-meta);
	}

	.dlog-answer[data-source='none'] {
		color: var(--df-state-warn-ink);
	}

	.dlog-answer[data-source='unknown'] {
		color: var(--df-text-meta);
	}

	.dlog-fate {
		margin-top: 2px;
		font-size: var(--df-p-text-2xs);
	}

	@media (max-width: 620px) {
		.drawer {
			border-radius: 0;
			border-left: 0;
		}

		.drawer-head {
			padding: var(--df-p-space-4);
		}

		.drawer-body {
			padding: var(--df-p-space-4);
			gap: var(--df-p-space-4);
		}

		.state-block {
			flex-direction: column;
			gap: var(--df-p-space-2);
		}

		.state-queue {
			text-align: left;
		}

		.fact-row {
			grid-template-columns: 80px minmax(0, 1fr);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.drawer[open] {
			animation: none;
		}

		.dlog-row {
			transition: none;
		}
	}
</style>
