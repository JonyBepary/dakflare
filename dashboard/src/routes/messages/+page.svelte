<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { page } from '$app/state';
	import { describeError, getDevices, getDeviceStatus, getMessages, getRules } from '$lib/api';
	import type { Device, DeviceStatus, Message, Rule } from '$lib/types';
	import {
		deviceOptionLabel,
		devicePresence,
		devicePrimary,
		deviceSecondary,
		wakeMode
	} from '$lib/presence';
	import { formatAbsolute, formatRelative } from '$lib/format';
	import { ROUTES } from '$lib/paths';
	import CommandTracker from '$lib/components/CommandTracker.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import Notice from '$lib/components/Notice.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import PresenceChip from '$lib/components/PresenceChip.svelte';
	import RelativeTime from '$lib/components/RelativeTime.svelte';
	import SendSmsForm from '$lib/components/SendSmsForm.svelte';
	import Spinner from '$lib/components/Spinner.svelte';

	const PAGE_SIZE = 50;
	const LIVE_POLL_MS = 5_000;

	let devices = $state<Device[]>([]);
	let selected = $state('');
	let messages = $state<Message[]>([]);
	let deviceStatus = $state<DeviceStatus | null>(null);

	let loadingDevices = $state(true);
	let loading = $state(false);
	let loadingMore = $state(false);
	let refreshing = $state(false);
	let devicesError = $state<string | null>(null);
	let messagesError = $state<string | null>(null);
	let hasMore = $state(false);
	let expanded = $state<Set<string>>(new Set());

	let rules = $state<Rule[]>([]);
	let newIds = $state<Set<string>>(new Set());
	let direction = $state('all');
	let lastUpdatedAt = $state<number | null>(null);
	let clock = $state(Date.now());
	let trackers = $state<Set<string>>(new Set());
	let liveInFlight = false;
	let lastLivePoll = 0;
	let logVersion = 0;

	let composeOpen = $state(false);
	let composeDevice = $state('');
	let composeButton = $state<HTMLButtonElement | null>(null);

	const selectedDevice = $derived(devices.find((device) => device.device_id === selected) ?? null);
	const selectedPresence = $derived(
		selectedDevice
			? devicePresence(selectedDevice, deviceStatus?.ws_connected === true)
			: 'unknown'
	);
	const shortDevice = $derived.by(() => {
		if (!selectedDevice) return '';
		const name = devicePrimary(selectedDevice);
		return name.length > 26 ? `${name.slice(0, 24)}…` : name;
	});
	const rulesById = $derived(new Map(rules.map((rule) => [rule.id, rule])));
	const visibleMessages = $derived(
		direction === 'all'
			? messages
			: messages.filter((message) => message.direction === direction)
	);

	async function loadDevices(): Promise<void> {
		devicesError = null;
		try {
			devices = await getDevices();
		} catch (failure) {
			devicesError = describeError(failure);
		} finally {
			loadingDevices = false;
		}
	}

	async function loadRuleNames(): Promise<void> {
		try {
			rules = await getRules();
		} catch {
			// Rule names are a label on the row. The reply id remains visible.
			rules = [];
		}
	}

	async function loadMessages(reset: boolean): Promise<void> {
		if (!selected) return;
		const target = selected;
		const version = ++logVersion;
		if (reset) {
			loading = true;
			messagesError = null;
		} else {
			loadingMore = true;
		}

		const before = reset || messages.length === 0 ? undefined : messages[messages.length - 1].received_at + 1;

		try {
			const result = await getMessages(target, PAGE_SIZE, before);
			if (version !== logVersion || target !== selected) return;
			if (reset) {
				messages = result.messages;
				newIds = new Set();
			} else {
				const seen = new Set(messages.map((message) => message.id));
				messages = [...messages, ...result.messages.filter((message) => !seen.has(message.id))];
			}
			hasMore = result.messages.length >= result.limit;
			lastUpdatedAt = Date.now();
			clock = Date.now();
		} catch (failure) {
			if (version === logVersion && target === selected) {
				messagesError = describeError(failure);
			}
		} finally {
			if (version === logVersion) {
				loading = false;
				loadingMore = false;
			}
		}
	}

	/**
	 * Fetch the newest page and merge it into whatever the operator has loaded.
	 * `logVersion` is bumped by every manual load, so a poll that started before
	 * a device switch or a refresh cannot overwrite the newer result.
	 */
	async function pollNewMessages(): Promise<void> {
		if (
			document.visibilityState !== 'visible' ||
			!selected ||
			loading ||
			loadingMore ||
			refreshing ||
			liveInFlight
		) {
			return;
		}
		const target = selected;
		const version = logVersion;
		liveInFlight = true;
		try {
			const result = await getMessages(target, PAGE_SIZE);
			if (version !== logVersion || target !== selected) return;
			const known = new Set(messages.map((message) => message.id));
			const fresh = result.messages.filter((message) => !known.has(message.id));
			const updates = new Map(result.messages.map((message) => [message.id, message]));
			const beforeHeight = document.documentElement.scrollHeight;
			const scrollY = window.scrollY;

			messages = [
				...fresh,
				...messages.map((message) => updates.get(message.id) ?? message)
			];
			newIds = new Set(fresh.map((message) => message.id));
			lastUpdatedAt = Date.now();
			clock = Date.now();

			// Prepending shifts the document. If the operator is reading further
			// down, give the page back the height it just gained instead of moving
			// their place on the screen.
			if (fresh.length > 0 && scrollY > 8) {
				await tick();
				const gained = document.documentElement.scrollHeight - beforeHeight;
				if (gained !== 0) window.scrollTo(0, scrollY + gained);
			}
		} catch {
			// Keep the readable log; the next visible poll retries.
		} finally {
			liveInFlight = false;
		}
	}

	function toggleTracker(messageId: string): void {
		const next = new Set(trackers);
		if (next.has(messageId)) next.delete(messageId);
		else next.add(messageId);
		trackers = next;
	}


	async function loadStatus(): Promise<void> {
		if (!selected) {
			deviceStatus = null;
			return;
		}
		try {
			deviceStatus = await getDeviceStatus(selected);
		} catch {
			deviceStatus = null;
		}
	}

	function syncUrl(): void {
		const url = selected
			? `${ROUTES.messages}?device=${encodeURIComponent(selected)}`
			: ROUTES.messages;
		history.replaceState(history.state, '', url);
	}

	async function chooseDevice(deviceId: string): Promise<void> {
		if (deviceId === selected) return;
		selected = deviceId;
		messages = [];
		expanded = new Set();
		trackers = new Set();
		newIds = new Set();
		lastUpdatedAt = null;
		hasMore = false;
		syncUrl();
		deviceStatus = null;
		await loadMessages(true);
		void loadStatus();
	}

	async function refresh(): Promise<void> {
		refreshing = true;
		await loadDevices();
		if (selected && !devices.some((device) => device.device_id === selected)) {
			selected = devices[0]?.device_id ?? '';
		}
		if (selected) {
			await loadMessages(true);
			void loadStatus();
		}
		refreshing = false;
	}

	function toggleExpanded(id: string): void {
		const next = new Set(expanded);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		expanded = next;
	}

	async function openCompose(): Promise<void> {
		if (devices.length === 0) return;
		if (!composeDevice) composeDevice = selected;
		composeOpen = true;
		await tick();
		const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		document
			.getElementById('compose-panel')
			?.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
	}

	function closeCompose(): void {
		composeOpen = false;
		void tick().then(() => composeButton?.focus());
	}

	/** Keep the log in step with a newly queued command. */
	async function handleQueued(result: { command_id: string; device_id: string }): Promise<void> {
		if (result.device_id === selected) await loadMessages(true);
		else await chooseDevice(result.device_id);
	}

	onMount(() => {
		void loadRuleNames();
		let interval: ReturnType<typeof setInterval> | undefined;

		void (async () => {
			await loadDevices();
			if (devicesError || devices.length === 0) return;
			const requested = page.url.searchParams.get('device');
			selected =
				requested && devices.some((device) => device.device_id === requested)
					? requested
					: devices[0].device_id;
			syncUrl();
			composeDevice = selected;
			if (page.url.searchParams.get('compose') === '1') composeOpen = true;
			await loadMessages(true);
			void loadStatus();
			lastLivePoll = Date.now();

			interval = setInterval(() => {
				if (document.visibilityState !== 'visible') return;
				clock = Date.now();
				if (Date.now() - lastLivePoll < LIVE_POLL_MS) return;
				lastLivePoll = Date.now();
				void pollNewMessages();
			}, 1_000);
		})();

		const onVisible = () => {
			if (document.visibilityState !== 'visible') return;
			clock = Date.now();
			lastLivePoll = 0;
			void pollNewMessages();
		};
		document.addEventListener('visibilitychange', onVisible);

		return () => {
			if (interval) clearInterval(interval);
			document.removeEventListener('visibilitychange', onVisible);
		};
	});
</script>

<svelte:head>
	<title>Messages · DakFlare</title>
</svelte:head>

<div class="page">
	<PageHeader
		eyebrow="Traffic"
		title="Message log"
		description="Newest first, both directions, straight from the D1 ledger. Bodies are retained only for the configured window."
	>
		<button
			type="button"
			class="btn btn-primary"
			bind:this={composeButton}
			onclick={() => void openCompose()}
			disabled={loadingDevices || devices.length === 0}
			aria-expanded={composeOpen}
			aria-controls={composeOpen ? 'compose-panel' : undefined}
		>
			<Icon name="send" size={14} /> Compose
		</button>
		<button
			type="button"
			class="btn"
			onclick={() => void refresh()}
			disabled={loading || refreshing || devices.length === 0}
			aria-busy={refreshing}
		>
			{#if refreshing}<Spinner />{:else}<Icon name="refresh" size={14} />{/if}
			Refresh
		</button>
	</PageHeader>

	{#if devicesError}
		<section class="panel">
			<div class="panel-body stack">
				<Notice tone="danger" title="Could not load the fleet">{devicesError}</Notice>
				<div class="row">
					<button
						type="button"
						class="btn btn-primary"
						onclick={() => {
							loadingDevices = true;
							void loadDevices();
						}}
					>
						<Icon name="refresh" size={14} /> Try again
					</button>
				</div>
			</div>
		</section>
	{:else if loadingDevices}
		<section class="panel" aria-busy="true" aria-live="polite">
			<span class="sr-only">Loading devices</span>
			<div class="skeleton" style="height: 120px; margin: 16px"></div>
		</section>
	{:else if devices.length === 0}
		<section class="panel">
			<EmptyState
				icon="message"
				title="No traffic to show yet"
				description="No devices are paired, so no messages can arrive. Mint a pairing code, open it on the phone, and this log will fill as the device syncs."
			>
				<a class="btn btn-primary" href={`${ROUTES.devices}?mint=enroll`}>
					<Icon name="key" size={14} /> Mint a pairing code
				</a>
			</EmptyState>
		</section>
	{:else}
		{#if composeOpen}
			<section class="panel compose-panel" id="compose-panel" aria-labelledby="compose-heading">
				<div class="panel-head">
					<h2 class="panel-title" id="compose-heading">
						<Icon name="send" size={14} /> Compose message
					</h2>
					<span class="spacer"></span>
					<span class="panel-meta">outbound · queued for the device</span>
					<button
						type="button"
						class="btn btn-ghost btn-icon btn-sm"
						onclick={closeCompose}
						aria-label="Close compose panel"
					>
						<Icon name="x" size={14} />
					</button>
				</div>
				<div class="panel-body">
					<SendSmsForm
						devices={devices}
						bind:deviceId={composeDevice}
						onqueued={(result) => void handleQueued(result)}
						autofocus
					/>
				</div>
			</section>
		{/if}

		<section class="panel">
			<div class="log-toolbar">
				<div class="device-picker">
					<label class="label" for="device-select">Device</label>
					<select
						id="device-select"
						class="input input-mono"
						value={selected}
						title={selected}
						onchange={(event) => void chooseDevice(event.currentTarget.value)}
					>
						{#each devices as device (device.device_id)}
							<option value={device.device_id}>{deviceOptionLabel(device)}</option>
						{/each}
					</select>
				</div>

				<div class="toolbar-meta">
					<div class="seg dir-filter" role="group" aria-label="Filter by direction">
						<label class="seg-item">
							<input type="radio" name="direction" value="all" bind:group={direction} />
							<span>All</span>
						</label>
						<label class="seg-item">
							<input type="radio" name="direction" value="in" bind:group={direction} />
							<span>In</span>
						</label>
						<label class="seg-item">
							<input type="radio" name="direction" value="out" bind:group={direction} />
							<span>Out</span>
						</label>
					</div>
					<span class="toolbar-sep" aria-hidden="true"></span>
					{#if selectedDevice}
						<span class="link-state" title="Socket plus authenticated contact">
							<PresenceChip
								presence={selectedPresence}
								wake={wakeMode(selectedDevice)}
								showWake
								queue={deviceStatus?.queue_depth ?? null}
							/>
						</span>
					{:else}
						<span class="mono muted">link unknown</span>
					{/if}
					<span class="toolbar-sep" aria-hidden="true"></span>
					<span class="mono shown">
						{#if loading}<Spinner />{:else}{visibleMessages.length}{/if}
						{visibleMessages.length === 1 ? 'message' : 'messages'}
					</span>
					<span class="toolbar-sep" aria-hidden="true"></span>
					<span
						class="updated mono"
						title="The log checks for new messages every 5 seconds while this tab is visible."
					>
						{#if lastUpdatedAt}
							updated {formatRelative(lastUpdatedAt, clock)}
						{:else}
							checking…
						{/if}
					</span>
				</div>
			</div>

			<div class="log-body">
				{#if loading}
					<div class="loading-rows" aria-busy="true" aria-live="polite">
						<span class="sr-only">Loading messages for {shortDevice}</span>
						{#each ['a', 'b', 'c', 'd'] as key (key)}
							<div class="skeleton" style="height: 62px"></div>
						{/each}
					</div>
				{:else if messagesError}
					<div class="panel-body stack">
						<Notice tone="danger" title="Could not load messages">{messagesError}</Notice>
						<div class="row">
							<button type="button" class="btn btn-primary" onclick={() => void loadMessages(true)}>
								<Icon name="refresh" size={14} /> Try again
							</button>
						</div>
					</div>
				{:else if messages.length === 0}
					<EmptyState
						icon="message"
						title="No messages for this device"
						description="Inbound SMS appears here after the phone syncs. Outbound sends are recorded when the gateway enqueues them."
					/>
				{:else if visibleMessages.length === 0}
					<EmptyState
						icon="filter"
						title="No {direction === 'in' ? 'inbound' : 'outbound'} messages in this window"
						description="The loaded window has messages in the other direction. Switch to All, or load older messages."
					/>
				{:else}
					<ul class="log">
						{#each visibleMessages as message (message.id)}
							{@const outbound = message.direction === 'out'}
							{@const isLong = message.body.length > 200}
							{@const isExpanded = expanded.has(message.id)}
							{@const isNew = newIds.has(message.id)}
							{@const ruleName =
								message.reply_source === 'rule'
									? (message.reply_ref ? rulesById.get(message.reply_ref)?.name ?? message.reply_ref : 'rule')
									: null}
							<li class="log-row" class:outbound class:is-new={isNew}>
								<div class="dir">
									<span class="dir-icon">
										<Icon
											name={outbound ? 'arrow-up-right' : 'arrow-down-left'}
											size={14}
										/>
									</span>
									<span class="dir-label">{outbound ? 'out' : 'in'}</span>
								</div>
								<div class="msg-main">
									<div class="msg-head">
										{#if isNew}
											<span class="new-chip" title="Arrived since the last check">new</span>
										{/if}
										<span class="peer mono">{message.peer}</span>
										{#if ruleName && !outbound}
											<span
												class="rule-chip"
												title={message.reply_ref ? `Answered by rule ${message.reply_ref}` : 'Answered by a gateway rule'}
											>
												rule · {ruleName}
											</span>
										{/if}
										<span class="spacer"></span>
										<span class="msg-time">
											<RelativeTime value={message.received_at} />
										</span>
									</div>
									<p class="msg-body" class:clamped={isLong && !isExpanded}>
										{message.body || '(empty message)'}
									</p>
									{#if isLong}
										<button
											type="button"
											class="link-btn more"
											onclick={() => toggleExpanded(message.id)}
											aria-expanded={isExpanded}
										>
											{isExpanded ? 'Show less' : 'Show full message'}
										</button>
									{/if}
									{#if message.reply_command_id && !outbound}
										<div class="reply-track">
											<button
												type="button"
												class="link-btn track-btn"
												onclick={() => toggleTracker(message.id)}
												aria-expanded={trackers.has(message.id)}
											>
												<Icon name="activity" size={11} />
												{trackers.has(message.id) ? 'Hide reply tracking' : 'Track reply'}
											</button>
											{#if trackers.has(message.id)}
												<div class="reply-tracker">
													<CommandTracker
														deviceId={message.device_id}
														commandId={message.reply_command_id}
													/>
												</div>
											{/if}
										</div>
									{/if}
								</div>
							</li>
						{/each}
					</ul>

					<div class="log-foot">
						<span class="mono muted">
							{messages.length} loaded{#if direction !== 'all'} · {visibleMessages.length} shown{/if}
						</span>
						<span class="spacer"></span>
						{#if hasMore}
							<button
								type="button"
								class="btn btn-sm"
								onclick={() => void loadMessages(false)}
								disabled={loadingMore}
								aria-busy={loadingMore}
							>
								{#if loadingMore}<Spinner />{:else}<Icon name="chevron-down" size={13} />{/if}
								Load older
							</button>
						{:else}
							<span class="hint">Beginning of this device's history</span>
						{/if}
					</div>
				{/if}
			</div>
		</section>

		{#if selectedDevice}
			<p class="device-foot" title={selectedDevice.device_id}>
				<span class="device-foot-name">{devicePrimary(selectedDevice)}</span>
				{#if deviceSecondary(selectedDevice)}
					<span class="mono"> · {deviceSecondary(selectedDevice)}</span>
				{/if}
				· last seen <RelativeTime value={selectedDevice.last_seen} fallback="never" /> · paired{' '}
				{formatAbsolute(selectedDevice.paired_at)}
			</p>
		{/if}
	{/if}
</div>

<style>
	.compose-panel {
		margin-bottom: var(--s-4);
		border-color: color-mix(in srgb, var(--accent) 24%, var(--line));
		scroll-margin-top: 16px;
	}

	.compose-panel .panel-head {
		border-bottom-color: color-mix(in srgb, var(--accent) 20%, var(--line));
	}

	@media (max-width: 900px) {
		.compose-panel {
			scroll-margin-top: 128px;
		}
	}

	@media (max-width: 520px) {
		.compose-panel .panel-meta {
			display: none;
		}
	}

	.log-toolbar {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: var(--s-4);
		flex-wrap: wrap;
		padding: var(--s-3) var(--s-4);
		border-bottom: 1px solid var(--line);
		background: color-mix(in srgb, var(--surface-2) 55%, var(--surface));
		border-radius: var(--r) var(--r) 0 0;
	}

	.device-picker {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		min-width: 0;
	}

	.device-picker .label {
		white-space: nowrap;
	}

	.device-picker .input {
		width: auto;
		min-width: 240px;
		max-width: 440px;
		height: 30px;
		min-height: 30px;
		padding-top: 4px;
		padding-bottom: 4px;
	}

	.toolbar-meta {
		display: flex;
		align-items: center;
		gap: var(--s-3);
		font-size: 10.5px;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--ink-3);
		flex-wrap: wrap;
	}

	.toolbar-sep {
		width: 1px;
		height: 14px;
		background: var(--line-strong);
	}

	.shown {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 10px;
	}

	.dir-filter {
		flex: none;
	}

	.dir-filter .seg-item span {
		height: 24px;
		padding: 0 8px;
		font-size: 9.5px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}

	.updated {
		font-size: 10px;
		letter-spacing: 0;
		text-transform: none;
		color: var(--ink-3);
	}

	.new-chip {
		flex: none;
		padding: 1px 5px;
		border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--line));
		border-radius: 3px;
		background: var(--accent-soft);
		color: var(--accent);
		font-family: var(--font-mono);
		font-size: 8.5px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		line-height: 1.5;
	}

	.rule-chip {
		min-width: 0;
		max-width: 30ch;
		padding: 2px 6px;
		border: 1px solid color-mix(in srgb, var(--accent) 28%, var(--line));
		border-radius: 3px;
		background: color-mix(in srgb, var(--accent) 7%, var(--surface));
		color: var(--accent);
		font-family: var(--font-mono);
		font-size: 9.5px;
		line-height: 1.4;
		overflow-wrap: anywhere;
	}

	.reply-track {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 6px;
		margin-top: 5px;
	}

	.track-btn {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: 10.5px;
	}

	.reply-tracker {
		width: 100%;
	}

	.log-row.is-new {
		background: color-mix(in srgb, var(--accent) 4%, transparent);
	}

	.link-state {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-family: var(--font-mono);
		font-size: 10px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--ink-2);
	}

	.log {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.log-row {
		display: grid;
		grid-template-columns: 40px minmax(0, 1fr);
		gap: var(--s-3);
		padding: 13px var(--s-4);
		border-bottom: 1px solid var(--line);
		transition: background-color 120ms ease;
	}

	.log-row:last-child {
		border-bottom: 0;
	}

	.log-row:hover {
		background: color-mix(in srgb, var(--surface-2) 45%, transparent);
	}

	.dir {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 4px;
		padding-top: 1px;
	}

	.dir-icon {
		display: grid;
		place-items: center;
		width: 26px;
		height: 26px;
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		background: var(--surface-2);
		color: var(--ink-2);
	}

	.outbound .dir-icon {
		color: var(--accent);
		border-color: color-mix(in srgb, var(--accent) 34%, var(--line));
		background: color-mix(in srgb, var(--accent) 9%, var(--surface));
	}

	.dir-label {
		font-family: var(--font-mono);
		font-size: 9px;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--ink-3);
	}

	.outbound .dir-label {
		color: var(--accent);
	}

	.msg-main {
		min-width: 0;
	}

	.msg-head {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		flex-wrap: wrap;
	}

	.peer {
		font-size: var(--text-base);
		font-weight: 500;
		color: var(--ink);
	}

	.msg-time {
		font-family: var(--font-mono);
		font-size: 10.5px;
		color: var(--ink-3);
		white-space: nowrap;
	}

	.msg-body {
		margin-top: 4px;
		color: var(--ink-2);
		font-size: var(--text-md);
		line-height: 1.55;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.msg-body.clamped {
		display: -webkit-box;
		-webkit-line-clamp: 3;
		line-clamp: 3;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.more {
		margin-top: 5px;
		font-size: 11.5px;
	}

	.log-foot {
		display: flex;
		align-items: center;
		gap: var(--s-3);
		padding: 10px var(--s-4);
		border-top: 1px solid var(--line);
		background: color-mix(in srgb, var(--surface-2) 40%, var(--surface));
		border-radius: 0 0 var(--r) var(--r);
	}

	.log-body {
		min-height: 120px;
	}

	.loading-rows {
		display: grid;
		gap: var(--s-2);
		padding: var(--s-4);
	}

	.device-foot {
		margin-top: var(--s-3);
		font-size: 10.5px;
		color: var(--ink-3);
		overflow-wrap: anywhere;
	}

	.device-foot-name {
		font-weight: 500;
		color: var(--ink-2);
	}

	@media (max-width: 620px) {
		.device-picker {
			width: 100%;
		}

		.device-picker .input {
			flex: 1;
			max-width: none;
			min-width: 0;
		}

		.toolbar-meta {
			width: 100%;
			justify-content: flex-start;
			gap: 8px 10px;
		}

		.toolbar-sep {
			display: none;
		}

		.updated {
			margin-left: auto;
		}

		.log-row {
			grid-template-columns: 32px minmax(0, 1fr);
			padding: 12px;
		}

		.dir-icon {
			width: 24px;
			height: 24px;
		}
	}
</style>
