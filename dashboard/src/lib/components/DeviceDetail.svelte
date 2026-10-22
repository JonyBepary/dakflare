<script lang="ts">
	import { tick } from 'svelte';
	import {
		describeError,
		getDeviceCommands,
		getDeviceStatus,
		getMessages,
		purgeMessages,
		revokeDevice
	} from '$lib/api';
	import type { Device, DeviceCommand, DeviceStatus, Message } from '$lib/types';
	import { commandStateNote, commandStateTone, isTerminalCommand } from '$lib/commands';
	import { deviceLabel, devicePresence, devicePrimary, wakeMode } from '$lib/presence';
	import { formatAbsolute, formatClock, formatDate } from '$lib/format';
	import Badge from './Badge.svelte';
	import CommandTracker from './CommandTracker.svelte';
	import ConfirmDialog from './ConfirmDialog.svelte';
	import CopyButton from './CopyButton.svelte';
	import EmptyState from './EmptyState.svelte';
	import Icon from './Icon.svelte';
	import Notice from './Notice.svelte';
	import PresenceChip from './PresenceChip.svelte';
	import RelativeTime from './RelativeTime.svelte';
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
	let trackedCommands = $state<Set<string>>(new Set());
	let commandVersion = 0;
	let commandInFlight = false;
	let loading = $state(false);
	let loadedFor = $state<string | null>(null);

	let sendOpen = $state(false);
	let purgedNotice = $state<string | null>(null);

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
	const wake = $derived(device ? wakeMode(device) : null);
	const simSlot = $derived.by(() => {
		const slot = device?.sim_slot;
		return typeof slot === 'number' && slot >= 0 && slot <= 2 ? `SIM ${slot + 1}` : null;
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
		trackedCommands = new Set();
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

	function toggleCommandTracker(commandId: string): void {
		const next = new Set(trackedCommands);
		if (next.has(commandId)) next.delete(commandId);
		else next.add(commandId);
		trackedCommands = next;
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
			purgedNotice = `${result.deleted} message${result.deleted === 1 ? '' : 's'} and ${result.flow_runs_deleted} flow run${result.flow_runs_deleted === 1 ? '' : 's'} removed for this device.`;
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

			<div class="status-strip" aria-busy={loading && !statusError}>
				<div class="status-cell">
					<span class="status-k">Link</span>
					<span class="status-v">
						{#if device}
							<PresenceChip {presence} />
						{:else if statusError}
							<span class="muted">unavailable</span>
						{:else}
							<span class="muted">checking…</span>
						{/if}
					</span>
				</div>
				<div class="status-cell">
					<span class="status-k">Queue</span>
					<span class="status-v mono">{status ? status.queue_depth : '—'}</span>
				</div>
				<div class="status-cell">
					<span class="status-k">Last contact</span>
					<span class="status-v">
						{#if device}
							<RelativeTime value={device.last_seen} fallback="never" />
						{:else}
							<span class="muted">—</span>
						{/if}
					</span>
				</div>
				<div class="status-cell">
					<span class="status-k">Wake</span>
					<span class="status-v">
						{#if wake}
							<Badge tone={wake === 'push' ? 'accent' : 'muted'}>{wake}</Badge>
						{:else}
							<span class="muted">—</span>
						{/if}
					</span>
				</div>
			</div>

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

				<dl class="kv facts">
					<dt>Label</dt>
					<dd>
						{#if device?.label?.trim()}
							{device.label.trim()}
						{:else}
							<span class="muted">Unlabeled</span>
							<span class="hint"> · not reported for this device</span>
						{/if}
					</dd>

					<dt>Paired</dt>
					<dd>
						{#if device}
							{formatDate(device.paired_at)} · {formatClock(device.paired_at)}
							<span class="hint"> · {formatAbsolute(device.paired_at)}</span>
						{:else}
							<span class="muted">—</span>
						{/if}
					</dd>

					<dt>Last contact</dt>
					<dd>
						{#if device}
							<RelativeTime value={device.last_seen} fallback="never" />
							<span class="hint"> · {formatAbsolute(device.last_seen)}</span>
							<span class="hint"> · authenticated contact, not pairing time</span>
						{:else}
							<span class="muted">—</span>
						{/if}
					</dd>

					<dt>Wake</dt>
					<dd>
						{#if wake}
							<Badge tone={wake === 'push' ? 'accent' : 'muted'}>{wake}</Badge>
							<span class="hint">
								·
								{wake === 'push'
									? 'FCM token present; the gateway can wake the phone.'
									: 'no push token; the phone is reached on its next poll.'}
							</span>
						{:else}
							<span class="muted">—</span>
						{/if}
					</dd>

					<dt>SIM slot</dt>
					<dd>
						{#if simSlot}
							<span class="mono">{simSlot}</span>
						{:else}
							<span class="muted">Not reported</span>
							<span class="hint"> · the device record carries no slot</span>
						{/if}
					</dd>
				</dl>

				<p class="hint">
					Queued commands are drained over the device's WebSocket, or on its next poll if the
					device is not connected.
				</p>
			</section>

			{#if sendOpen}
				<section class="section send-section" id={`send-panel-${uid}`} aria-labelledby={`send-${uid}`}>
					<div class="section-head">
						<h3 class="section-title" id={`send-${uid}`}>Send SMS from this device</h3>
					</div>
					<SendSmsForm devices={device ? [device] : []} deviceId={deviceId} onqueued={onQueued} autofocus />
				</section>
			{/if}

			{#if purgedNotice}
				<div aria-live="polite">
					<Notice tone="ok" title="Message log purged">{purgedNotice}</Notice>
				</div>
			{/if}

			<section class="section" aria-labelledby={`commands-${uid}`}>
				<div class="section-head">
					<h3 class="section-title" id={`commands-${uid}`}>Commands</h3>
					<span class="panel-meta">
						{#if commandsLoading && commands.length === 0}<Spinner />{:else}newest · last {COMMAND_LIMIT}{/if}
					</span>
				</div>
				{#if commandsError}
					<p class="field-error">
						Could not refresh commands. {commandsError}
					</p>
				{/if}
				{#if commandsLoading && commands.length === 0}
					<div class="cmd-skeletons" aria-busy="true" aria-live="polite">
						<span class="sr-only">Loading commands</span>
						{#each ['a', 'b'] as key (key)}
							<div class="skeleton" style="height: 46px"></div>
						{/each}
					</div>
				{:else if commands.length === 0}
					<p class="hint">No commands recorded for this device.</p>
				{:else}
					<ul class="cmd-list">
						{#each commands as command (command.command_id)}
							<li class="cmd-row">
								<div class="cmd-head">
									<span class="mono cmd-peer">{command.to_e164 || '(no recipient)'}</span>
									<span title={commandStateNote(command.state)}>
										<Badge
											tone={commandStateTone(command.state)}
											dot={!isTerminalCommand(command.state)}
										>
											{command.state}
										</Badge>
									</span>
									<span class="hint">· <RelativeTime value={command.created_at} /></span>
									<span class="spacer"></span>
									<button
										type="button"
										class="link-btn cmd-track-btn"
										onclick={() => toggleCommandTracker(command.command_id)}
										aria-expanded={trackedCommands.has(command.command_id)}
									>
										{trackedCommands.has(command.command_id) ? 'Hide' : 'Track'}
									</button>
								</div>
								<p class="cmd-body">{command.body || '(empty message)'}</p>
								{#if trackedCommands.has(command.command_id)}
									<div class="cmd-tracker">
										<CommandTracker compact deviceId={deviceId} commandId={command.command_id} />
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
					<span class="panel-meta">
						{#if loading}<Spinner />{:else}last {MESSAGE_LIMIT}{/if}
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
					<div class="dlog-skeletons" aria-busy="true" aria-live="polite">
						<span class="sr-only">Loading messages</span>
						{#each ['a', 'b', 'c'] as key (key)}
							<div class="skeleton" style="height: 52px"></div>
						{/each}
					</div>
				{:else if messages.length === 0}
					<EmptyState
						icon="message"
						title="No messages yet"
						description="Inbound SMS appears after the phone syncs. Messages queued here appear immediately."
					/>
				{:else}
					<ul class="dlog">
						{#each messages as message (message.id)}
							{@const outbound = message.direction === 'out'}
							<li class="dlog-row" class:outbound>
								<span class="dlog-icon" aria-hidden="true">
									<Icon name={outbound ? 'arrow-up-right' : 'arrow-down-left'} size={13} />
								</span>
								<div class="dlog-main">
									<div class="dlog-head">
										<span class="mono dlog-peer">{message.peer}</span>
										{#if message.auto_reply && !outbound}
											<Badge tone="accent">auto-reply</Badge>
										{/if}
										<span class="spacer"></span>
										<span class="dlog-time">
											<RelativeTime value={message.received_at} />
										</span>
									</div>
									<p class="dlog-body">{message.body || '(empty message)'}</p>
								</div>
							</li>
						{/each}
					</ul>
					<p class="hint">Newest {messages.length} messages, both directions.</p>
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
		will stop authenticating immediately. Its public key is destroyed in both stores and any
		queued command is abandoned.
	</p>
	<p class="hint" style="margin-top: 10px">
		To restore it, enroll the phone again with a new pairing code.
	</p>
</ConfirmDialog>

<ConfirmDialog
	open={purgeOpen}
	title="Purge the message log?"
	confirmLabel="Purge messages"
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
		Every stored message and flow run for
		<strong>{device ? devicePrimary(device) : deviceId}</strong>
		{#if device && deviceLabel(device)}(<span class="mono">{deviceId}</span>){/if} is deleted. This
		cannot be undone.
	</p>
	<p class="hint" style="margin-top: 10px">
		The device stays paired; only the log is erased. New messages will arrive normally.
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
		border-left: 1px solid var(--line-strong);
		background: var(--surface);
		color: var(--ink);
		box-shadow: var(--shadow-dialog);
		overflow: hidden;
	}

	.drawer[open] {
		animation: drawer-in 220ms cubic-bezier(0.2, 0.7, 0.2, 1) both;
	}

	.drawer::backdrop {
		background: rgba(10, 12, 10, 0.42);
		backdrop-filter: blur(2px);
	}

	.drawer[open]::backdrop {
		animation: backdrop-in 200ms ease both;
	}

	@keyframes drawer-in {
		from {
			transform: translateX(22px);
			opacity: 0.55;
		}
		to {
			transform: none;
			opacity: 1;
		}
	}

	@keyframes backdrop-in {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
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
		gap: var(--s-3);
		flex: none;
		padding: var(--s-4) var(--s-5);
		border-bottom: 1px solid var(--line);
		background: color-mix(in srgb, var(--surface-2) 55%, var(--surface));
	}

	.drawer-title {
		min-width: 0;
		flex: 1;
	}

	.drawer-title h2 {
		margin-top: 3px;
		font-size: var(--text-xl);
		letter-spacing: -0.02em;
		overflow-wrap: anywhere;
	}

	.id-line {
		display: flex;
		align-items: center;
		gap: 3px;
		margin-top: 5px;
		min-width: 0;
		font-size: 10.5px;
		color: var(--ink-3);
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
		gap: var(--s-5);
		padding: var(--s-5);
	}

	/* The body scrolls; its children must keep their natural height instead of
	   being squeezed by the flex column (the status strip would clip to 2px). */
	.drawer-body > * {
		flex: none;
	}

	.action-row {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		flex-wrap: wrap;
	}

	.status-strip {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		background: color-mix(in srgb, var(--surface-2) 45%, var(--surface));
		overflow: hidden;
	}

	.status-cell {
		display: flex;
		flex-direction: column;
		gap: 5px;
		padding: 10px 12px;
		border-right: 1px solid var(--line);
		min-width: 0;
	}

	.status-cell:last-child {
		border-right: 0;
	}

	.status-k {
		font-family: var(--font-mono);
		font-size: 9.5px;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--ink-3);
	}

	.status-v {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-family: var(--font-mono);
		font-size: 11px;
		letter-spacing: 0.04em;
		color: var(--ink-2);
	}

	.section {
		display: grid;
		gap: var(--s-3);
		min-width: 0;
	}

	.section-head {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		padding-bottom: 8px;
		border-bottom: 1px solid var(--line);
	}

	.section-title {
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 500;
		letter-spacing: 0.11em;
		text-transform: uppercase;
		color: var(--ink-3);
	}

	.facts {
		grid-template-columns: 78px minmax(0, 1fr);
		gap: 8px var(--s-3);
	}

	.facts dd {
		color: var(--ink-2);
	}

	.send-section {
		padding: var(--s-4);
		border: 1px solid color-mix(in srgb, var(--accent) 26%, var(--line));
		border-radius: var(--r-sm);
		background: color-mix(in srgb, var(--accent) 4%, var(--surface));
	}

	.send-section .section-head {
		border-bottom-color: color-mix(in srgb, var(--accent) 20%, var(--line));
	}

	.cmd-list {
		list-style: none;
		margin: 0;
		padding: 0;
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		overflow: hidden;
	}

	.cmd-row {
		padding: 9px 12px;
		border-bottom: 1px solid var(--line);
		background: color-mix(in srgb, var(--surface-2) 30%, var(--surface));
	}

	.cmd-row:last-child {
		border-bottom: 0;
	}

	.cmd-head {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-wrap: wrap;
	}

	.cmd-peer {
		font-size: 11.5px;
		font-weight: 500;
		color: var(--ink);
	}

	.cmd-body {
		margin-top: 3px;
		font-size: 11.5px;
		line-height: 1.5;
		color: var(--ink-3);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.cmd-track-btn {
		font-size: 10.5px;
	}

	.cmd-tracker {
		margin-top: 6px;
	}

	.cmd-skeletons {
		display: grid;
		gap: var(--s-2);
	}

	.dlog-skeletons {
		display: grid;
		gap: var(--s-2);
	}

	.dlog {
		list-style: none;
		margin: 0;
		padding: 0;
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		overflow: hidden;
	}

	.dlog-row {
		display: grid;
		grid-template-columns: 24px minmax(0, 1fr);
		gap: 9px;
		padding: 10px 12px;
		border-bottom: 1px solid var(--line);
	}

	.dlog-row:last-child {
		border-bottom: 0;
	}

	.dlog-row.outbound {
		background: color-mix(in srgb, var(--accent) 4%, var(--surface));
	}

	.dlog-icon {
		display: grid;
		place-items: center;
		width: 22px;
		height: 22px;
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		background: var(--surface-2);
		color: var(--ink-3);
	}

	.outbound .dlog-icon {
		color: var(--accent);
		border-color: color-mix(in srgb, var(--accent) 30%, var(--line));
		background: color-mix(in srgb, var(--accent) 8%, var(--surface));
	}

	.dlog-main {
		min-width: 0;
	}

	.dlog-head {
		display: flex;
		align-items: center;
		gap: 6px;
		flex-wrap: wrap;
	}

	.dlog-peer {
		font-size: 11.5px;
		font-weight: 500;
		color: var(--ink);
	}

	.dlog-time {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--ink-3);
		white-space: nowrap;
	}

	.dlog-body {
		margin-top: 2px;
		font-size: 11.5px;
		line-height: 1.5;
		color: var(--ink-2);
		overflow-wrap: anywhere;
		display: -webkit-box;
		-webkit-line-clamp: 3;
		line-clamp: 3;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	@media (max-width: 620px) {
		.drawer-head {
			padding: var(--s-4);
		}

		.drawer-body {
			padding: var(--s-4);
			gap: var(--s-4);
		}

		.status-strip {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}

		.status-cell {
			padding: 9px 10px;
		}

		.status-cell:nth-child(2) {
			border-right: 0;
		}

		.status-cell:nth-child(3),
		.status-cell:nth-child(4) {
			border-top: 1px solid var(--line);
		}

		.status-v {
			font-size: 10.5px;
		}
	}
</style>
