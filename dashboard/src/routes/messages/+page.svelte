<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { page } from '$app/state';
	import { describeError, getDevices, getDeviceStatus, getMessages, getRules } from '$lib/api';
	import { consoleCounts } from '$lib/console-counts.svelte';
	import { formatCount } from '$lib/format';
	import type { Device, DeviceStatus, Message, Rule } from '$lib/types';
	import {
		deviceOptionLabel,
		devicePresence,
		devicePrimary,
		deviceSecondary,
		wakeMode
	} from '$lib/presence';
	import { answerOf, answerPhrase } from '$lib/answers';
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

	/* One request is one page. The Worker clamps at 500 and has no total, so the
	   log never implies it holds the whole history: it says how many rows are
	   loaded and how many the gateway keeps. */
	const PAGE_SIZE = 100;
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
	/* Set when a full page adds nothing: every row in it shares the cursor
	   millisecond, and `/v1/messages` has no id tiebreaker to page past that. */
	let stalled = $state(false);
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
	// Fleet-wide total from the shell's health read; null until it answers, so the
	// log says "100 shown" rather than inventing a total it does not have.
	const totalMessages = $derived(consoleCounts.messages);
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
			// Rule names are a label on the row. "Answered by a rule" remains true.
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
			let added = result.messages.length;
			if (reset) {
				messages = result.messages;
				newIds = new Set();
			} else {
				const seen = new Set(messages.map((message) => message.id));
				const fresh = result.messages.filter((message) => !seen.has(message.id));
				added = fresh.length;
				messages = [...messages, ...fresh];
			}
			// `before` is a millisecond cursor, so a page can return rows already
			// shown when more than a page shares one received_at. Do not offer a
			// control that cannot move: stop at the tie rather than loop.
			hasMore = result.messages.length >= result.limit && added > 0;
			stalled = !reset && result.messages.length >= result.limit && added === 0;
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
		stalled = false;
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
		// An instant jump: the motion set has no scroll animation.
		document.getElementById('compose-panel')?.scrollIntoView({ block: 'start', behavior: 'auto' });
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
		<section class="card">
			<Notice tone="danger" title="Could not load the fleet">{devicesError}</Notice>
			<div class="row" style="margin-top: 16px">
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
		</section>
	{:else if loadingDevices}
		<section class="card" aria-busy="true" aria-live="polite">
			<span class="sr-only">Loading devices</span>
			<div class="skeleton" style="height: 120px"></div>
		</section>
	{:else if devices.length === 0}
		<section class="card">
			<EmptyState
				icon="message"
				title="No devices paired yet"
				description="Mint a single-use code and open the link on the phone you want to answer. Until one is paired, nothing can reply."
			>
				<a class="btn btn-primary" href={`${ROUTES.devices}?mint=enroll`}>
					<Icon name="key" size={14} /> Mint a pairing code
				</a>
			</EmptyState>
		</section>
	{:else}
		{#if composeOpen}
			<section class="card compose-panel" id="compose-panel" aria-labelledby="compose-heading">
				<div class="card-head">
					<h2 class="card-title" id="compose-heading">
						<Icon name="send" size={14} /> Compose message
					</h2>
					<span class="spacer"></span>
					<span class="compose-meta">outbound · queued for the device</span>
					<button
						type="button"
						class="btn btn-ghost btn-icon btn-sm"
						onclick={closeCompose}
						aria-label="Close compose panel"
					>
						<Icon name="x" size={14} />
					</button>
				</div>
				<SendSmsForm
					devices={devices}
					bind:deviceId={composeDevice}
					onqueued={(result) => void handleQueued(result)}
					autofocus
				/>
			</section>
		{/if}

		<section class="card log-card">
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
					<span
						class="mono shown"
						title={totalMessages === null
							? 'Rows loaded in this device’s log'
							: `${formatCount(totalMessages)} is every message kept in the gateway; this window has ${formatCount(visibleMessages.length)} loaded`}
					>
						{#if loading}
							<Spinner />
						{:else if messagesError}
							<span title="The log did not load">—</span>
						{:else if totalMessages !== null}
							{formatCount(totalMessages)} messages · showing {formatCount(visibleMessages.length)}
						{:else}
							showing {formatCount(visibleMessages.length)}
						{/if}
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
					<div class="log-message">
						<Notice tone="danger" title="Could not load messages">{messagesError}</Notice>
						<div class="row" style="margin-top: 12px">
							<button type="button" class="btn btn-primary" onclick={() => void loadMessages(true)}>
								<Icon name="refresh" size={14} /> Try again
							</button>
						</div>
					</div>
				{:else if messages.length === 0}
					<EmptyState
						icon="message"
						title="No messages for this device yet"
						description="Inbound SMS appears after the phone syncs. Anything you queue here appears immediately."
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
								message.reply_source === 'rule' && message.reply_ref
									? (rulesById.get(message.reply_ref)?.name ?? null)
									: null}
							{@const answer = answerPhrase(message, ruleName)}
							{@const answerSource = answerOf(message)}
							<li class="log-row" data-dir={outbound ? 'out' : 'in'} class:is-new={isNew}>
								<span class="dir" aria-hidden="true">
									<Icon name={outbound ? 'arrow-up-right' : 'arrow-down-left'} size={14} />
								</span>
								<div class="msg-main">
									<p class="msg-head">
										<span class="dir-word">
											<span aria-hidden="true">{outbound ? 'out' : 'in'}</span>
											<span class="sr-only">{outbound ? 'Outbound' : 'Inbound'}</span>
										</span>
										<span class="peer mono">{message.peer}</span>
										{#if isNew}<span class="new-word">new</span>{/if}
										<span class="spacer"></span>
										<span class="msg-time">
											<RelativeTime value={message.received_at} />
										</span>
									</p>
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
									{#if answer || (message.reply_command_id && !outbound)}
										<div class="msg-meta">
											{#if answer}
												<span class="answer" data-source={answerSource}>{answer}</span>
											{/if}
											{#if message.reply_command_id && !outbound}
												<span class="spacer"></span>
												<button
													type="button"
													class="link-btn track-btn"
													onclick={() => toggleTracker(message.id)}
													aria-expanded={trackers.has(message.id)}
													aria-controls={trackers.has(message.id)
														? `tracker-${message.id}`
														: undefined}
												>
													<Icon name="activity" size={11} />
													{trackers.has(message.id) ? 'Hide delivery' : 'Delivery'}
												</button>
											{/if}
										</div>
									{/if}
									{#if trackers.has(message.id) && message.reply_command_id}
										<div class="reply-tracker" id={`tracker-${message.id}`}>
											<CommandTracker
												deviceId={message.device_id}
												commandId={message.reply_command_id}
											/>
										</div>
									{/if}
								</div>
							</li>
						{/each}
					</ul>

					<div class="log-foot">
						<span class="mono muted">
							{#if hasMore || stalled}
								newest {formatCount(messages.length)} loaded{#if direction !== 'all'}
									· {formatCount(visibleMessages.length)} shown{/if}
							{:else}
								all {formatCount(messages.length)} loaded{#if direction !== 'all'}
									· {formatCount(visibleMessages.length)} shown{/if}
							{/if}
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
						{:else if stalled}
							<span class="hint">
								Older rows share a timestamp; this log cannot page past them yet.
							</span>
						{:else}
							<span class="hint">Beginning of this device’s history</span>
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
		margin-bottom: var(--df-p-space-4);
		border-color: color-mix(in srgb, var(--df-accent-text) 24%, var(--df-border-hairline));
		scroll-margin-top: calc(var(--df-c-shell-header) + var(--df-p-space-4));
	}

	.compose-meta {
		font-family: var(--df-p-font-mono);
		font-size: var(--df-p-text-2xs);
		letter-spacing: 0.04em;
		color: var(--df-text-meta);
		white-space: nowrap;
	}

	.log-card {
		padding: 0;
	}

	.log-toolbar {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: var(--df-p-space-4);
		flex-wrap: wrap;
		padding: var(--df-p-space-3) var(--df-p-space-4);
		border-bottom: 1px solid var(--df-border-hairline);
		background: var(--df-surface-well);
		border-radius: var(--df-c-card-radius) var(--df-c-card-radius) 0 0;
	}

	.device-picker {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-2);
		min-width: 0;
	}

	.device-picker .label {
		white-space: nowrap;
	}

	.device-picker .input {
		width: auto;
		min-width: 240px;
		max-width: 440px;
		height: 32px;
		min-height: 32px;
		padding-block: var(--df-p-space-1);
	}

	.toolbar-meta {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-3);
		font-size: var(--df-p-text-2xs);
		letter-spacing: 0.04em;
		color: var(--df-text-meta);
		flex-wrap: wrap;
	}

	.toolbar-sep {
		width: 1px;
		height: 14px;
		background: var(--df-border-control);
	}

	.shown {
		display: inline-flex;
		align-items: center;
		gap: var(--df-p-space-1);
		font-size: var(--df-p-text-2xs);
	}

	.dir-filter {
		flex: none;
	}

	.dir-filter .seg-item span {
		height: 24px;
		padding: 0 var(--df-p-space-2);
		font-size: var(--df-p-text-2xs);
		letter-spacing: 0.05em;
		text-transform: uppercase;
	}

	.updated {
		font-size: var(--df-p-text-2xs);
		letter-spacing: 0;
		color: var(--df-text-meta);
	}

	.link-state {
		display: inline-flex;
		align-items: center;
		gap: var(--df-p-space-1);
		color: var(--df-text-secondary);
	}

	/* ---------- the list ---------- */

	.log {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.log-row {
		position: relative;
		display: grid;
		grid-template-columns: 28px minmax(0, 1fr);
		gap: var(--df-p-space-3);
		padding: var(--df-p-space-3) var(--df-p-space-4);
		border-bottom: 1px solid var(--df-border-hairline);
		transition: background-color var(--df-p-dur-lift) ease;
	}

	.log-row:last-child {
		border-bottom: 0;
	}

	.log-row:hover {
		background: var(--df-surface-hover);
	}

	/* New since the last check: a coral edge and a word, never a badge. */
	.log-row.is-new::before {
		content: '';
		position: absolute;
		inset: 0 auto 0 0;
		width: 3px;
		background: var(--df-accent-fill);
	}

	.dir {
		display: grid;
		place-items: center;
		align-self: start;
		width: 24px;
		height: 24px;
		margin-top: 1px;
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-sm);
		background: var(--df-surface-well);
		color: var(--df-text-meta);
	}

	.log-row[data-dir='out'] .dir {
		color: var(--df-accent-text);
		border-color: transparent;
		background: var(--df-accent-soft);
	}

	.msg-main {
		min-width: 0;
	}

	.msg-head {
		display: flex;
		align-items: baseline;
		gap: var(--df-p-space-2);
		flex-wrap: wrap;
	}

	.dir-word {
		font-family: var(--df-p-font-mono);
		font-size: var(--df-p-text-2xs);
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--df-text-meta);
	}

	.log-row[data-dir='out'] .dir-word {
		color: var(--df-accent-text);
	}

	.peer {
		font-size: var(--df-p-text-base);
		font-weight: 600;
		color: var(--df-text-primary);
		overflow-wrap: anywhere;
	}

	.new-word {
		font-family: var(--df-p-font-mono);
		font-size: var(--df-p-text-2xs);
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--df-accent-text);
	}

	.msg-time {
		font-size: var(--df-p-text-2xs);
		color: var(--df-text-meta);
		white-space: nowrap;
	}

	.msg-body {
		margin-top: 2px;
		font-size: var(--df-p-text-md);
		line-height: 1.5;
		color: var(--df-text-secondary);
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
		margin-top: var(--df-p-space-1);
		font-size: var(--df-p-text-xs);
	}

	.msg-meta {
		display: flex;
		align-items: baseline;
		gap: var(--df-p-space-3);
		flex-wrap: wrap;
		margin-top: var(--df-p-space-1);
	}

	.answer {
		font-size: var(--df-p-text-xs);
		color: var(--df-text-secondary);
	}

	.answer[data-source='none'] {
		color: var(--df-text-meta);
	}

	.track-btn {
		display: inline-flex;
		align-items: center;
		gap: var(--df-p-space-1);
		font-size: var(--df-p-text-xs);
	}

	.reply-tracker {
		margin-top: var(--df-p-space-2);
	}

	.log-foot {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-3);
		padding: var(--df-p-space-2) var(--df-p-space-4);
		border-top: 1px solid var(--df-border-hairline);
		background: var(--df-surface-well);
		border-radius: 0 0 var(--df-c-card-radius) var(--df-c-card-radius);
	}

	.log-body {
		min-height: 120px;
	}

	.log-message {
		padding: var(--df-p-space-4);
	}

	.loading-rows {
		display: grid;
		gap: var(--df-p-space-2);
		padding: var(--df-p-space-4);
	}

	.device-foot {
		margin-top: var(--df-p-space-3);
		font-size: var(--df-p-text-xs);
		color: var(--df-text-meta);
		overflow-wrap: anywhere;
	}

	.device-foot-name {
		font-weight: 500;
		color: var(--df-text-secondary);
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
			gap: var(--df-p-space-2);
		}

		.toolbar-sep {
			display: none;
		}

		.updated {
			margin-left: auto;
		}

		.log-row {
			grid-template-columns: 24px minmax(0, 1fr);
			gap: var(--df-p-space-2);
			padding: var(--df-p-space-3);
		}

		.compose-meta {
			display: none;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.log-row {
			transition: none;
		}
	}
</style>
