<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { page } from '$app/state';
	import {
		describeError,
		getDevices,
		getDeviceStatus,
		getMessages,
		getRules,
		sendSms
	} from '$lib/api';
	import { consoleCounts } from '$lib/console-counts.svelte';
	import { formatAbsolute, formatCount, formatRelative } from '$lib/format';
	import { currentTime, subscribeClock } from '$lib/live-clock.svelte';
	import { isRevoked, type Device, type DeviceStatus, type Message, type Rule } from '$lib/types';
	import {
		deviceOptionLabel,
		devicePresence,
		devicePrimary,
		deviceSecondary,
		wakeMode
	} from '$lib/presence';
	import { answerOf, answerPhrase } from '$lib/answers';
	import { channelHasSessionState, channelWord } from '$lib/channels';
	import { replyFatesOf } from '$lib/replies';
	import { ROUTES } from '$lib/paths';
	import { session } from '$lib/session.svelte';
	import Badge from '$lib/components/Badge.svelte';
	import CommandTracker from '$lib/components/CommandTracker.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import Notice from '$lib/components/Notice.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import PresenceChip from '$lib/components/PresenceChip.svelte';
	import RelativeTime from '$lib/components/RelativeTime.svelte';
	import ReplyFate from '$lib/components/ReplyFate.svelte';
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
	let pageError = $state<string | null>(null);
	let hasMore = $state(false);
	/* Set when a full page adds nothing: every row in it shares the cursor
	   millisecond, and `/v1/messages` has no id tiebreaker to page past that. */
	let stalled = $state(false);
	let expanded = $state<Set<string>>(new Set());

	let rules = $state<Rule[]>([]);
	let newIds = $state<Set<string>>(new Set());
	let direction = $state('all');
	/** Rows whose conversation context panel is open, by message id. */
	let contextOpen = $state<Set<string>>(new Set());
	/** When set, the log shows only rows from this conversation. */
	let conversationFilter = $state<string | null>(null);
	let lastUpdatedAt = $state<number | null>(null);
	const clock = $derived(currentTime());
	let trackers = $state<Set<string>>(new Set());
	let trackedCommands = $state<Record<string, string>>({});
	let linked = $state<string | null>(null);
	let followNote = $state<string | null>(null);
	let linkedTimer: ReturnType<typeof setTimeout> | undefined;
	let liveInFlight = false;
	let lastLivePoll = 0;
	let logVersion = 0;

	let composeOpen = $state(false);
	let composeDevice = $state('');
	let composeButton = $state<HTMLButtonElement | null>(null);

	/**
	 * Sending is a `write` on the Worker; reading the ledger is not. A member can
	 * read every row here and cannot queue a message, so the two sending
	 * controls say that instead of failing when pressed.
	 */
	const canWrite = $derived(session.canWrite);
	const sendRefusal = $derived('Members can read the message log but cannot send SMS.');

	const selectedDevice = $derived(devices.find((device) => device.device_id === selected) ?? null);
	const hasActiveDevice = $derived(devices.some((device) => !isRevoked(device)));
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

	/**
	 * What the loaded window knows about each conversation: how much of the
	 * back-and-forth is here, both directions, and where it starts and ends.
	 *
	 * This is deliberately the loaded page, not the whole table: `/v1/messages`
	 * has no conversation filter and no total, so a count here means "in this
	 * window" and the panel says so.
	 */
	const conversations = $derived.by(() => {
		const map = new Map<
			string,
			{
				channel: string | null;
				peer: string;
				count: number;
				inbound: number;
				outbound: number;
				first: number;
				last: number;
			}
		>();
		for (const message of messages) {
			const id = message.conversation_id;
			if (typeof id !== 'string' || id === '') continue;
			const existing = map.get(id);
			if (existing === undefined) {
				map.set(id, {
					channel: message.channel ?? null,
					peer: message.peer,
					count: 1,
					inbound: message.direction === 'in' ? 1 : 0,
					outbound: message.direction === 'out' ? 1 : 0,
					first: message.received_at,
					last: message.received_at
				});
			} else {
				existing.count += 1;
				if (message.direction === 'in') existing.inbound += 1;
				else existing.outbound += 1;
				existing.first = Math.min(existing.first, message.received_at);
				existing.last = Math.max(existing.last, message.received_at);
			}
		}
		return map;
	});

	const filteredConversation = $derived(
		conversationFilter === null ? null : (conversations.get(conversationFilter) ?? null)
	);

	const visibleMessages = $derived(
		messages.filter(
			(message) =>
				(direction === 'all' || message.direction === direction) &&
				(conversationFilter === null || message.conversation_id === conversationFilter)
		)
	);

	/** One fate per row: a reply says its own, a question inherits its reply's. */
	const fates = $derived(replyFatesOf(messages));

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
			pageError = null;
			followNote = null;
		} else {
			loadingMore = true;
			pageError = null;
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
		} catch (failure) {
			if (version === logVersion && target === selected) {
				if (reset) {
					messagesError = describeError(failure);
				} else {
					pageError = describeError(failure);
				}
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

	function toggleContext(messageId: string): void {
		const next = new Set(contextOpen);
		if (next.has(messageId)) next.delete(messageId);
		else next.add(messageId);
		contextOpen = next;
	}

	/**
	 * Narrow the log to one conversation. The direction filter is reset with it:
	 * "only this conversation" means the whole back-and-forth, not the half the
	 * current filter happens to show.
	 */
	function toggleConversationFilter(id: string): void {
		if (conversationFilter === id) {
			conversationFilter = null;
			return;
		}
		conversationFilter = id;
		direction = 'all';
	}

	/**
	 * What may be said about this conversation, from the state the gateway now
	 * joins onto the row. Null is "not reported", never "open": a channel with no
	 * session state must not read as permission.
	 */
	function sessionNote(message: Message): string {
		const state = message.session_state;
		const until =
			typeof message.window_expires_at === 'number' && message.window_expires_at > 0
				? new Date(message.window_expires_at).toLocaleTimeString([], {
						hour: '2-digit',
						minute: '2-digit'
					})
				: null;
		switch (state) {
			case 'WINDOW_OPEN':
				return until === null
					? 'The window is open: a free-form reply is allowed.'
					: `The window is open until ${until}, so a free-form reply is allowed.`;
			case 'TEMPLATE_ONLY':
				return 'Free-form replies are closed; only an approved template may be sent.';
			case 'OPTED_OUT':
				return 'This contact opted out. Nothing may be sent on this conversation.';
			case 'NO_SESSION':
				return 'No session is open. Reaching this contact needs an approved template.';
			default:
				return channelWord(message.channel) === 'WhatsApp'
					? 'WhatsApp allows a free-form reply only inside its 24-hour window; the gateway does not report a state for this conversation, so a reply may need a template.'
					: 'The gateway reports no session state for this conversation, so nothing here says whether a free-form reply is allowed.';
		}
	}

	async function loadStatus(): Promise<void> {
		const target = devices.find((device) => device.device_id === selected);
		if (!selected || (target && isRevoked(target))) {
			deviceStatus = null;
			return;
		}
		try {
			deviceStatus = await getDeviceStatus(selected);
		} catch {
			deviceStatus = null;
		}
	}

	async function resendMessage(rowId: string, to: string, body: string): Promise<void> {
		const targetDevice = messages.find((message) => message.id === rowId)?.device_id ?? selected;
		if (!targetDevice) return;
		const result = await sendSms({ device_id: targetDevice, to, body });
		trackedCommands = { ...trackedCommands, [rowId]: result.command_id };
		void loadMessages(true);
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
		contextOpen = new Set();
		conversationFilter = null;
		trackedCommands = {};
		newIds = new Set();
		followNote = null;
		lastUpdatedAt = null;
		hasMore = false;
		stalled = false;
		pageError = null;
		syncUrl();
		deviceStatus = null;
		await loadMessages(true);
		void loadStatus();
	}

	async function refresh(): Promise<void> {
		refreshing = true;
		await loadDevices();
		if (selected && !devices.some((device) => device.device_id === selected)) {
			selected = devices.find((device) => !isRevoked(device))?.device_id ?? devices[0]?.device_id ?? '';
			contextOpen = new Set();
			conversationFilter = null;
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

	/**
	 * Take the operator from a failed reply's question to the reply row itself.
	 * The direction filter can hide the row, so widen it first rather than
	 * linking to nothing. The mark fades on its own; it is not a selection.
	 */
	async function followReply(messageId: string): Promise<void> {
		followNote = null;
		if (direction === 'in') direction = 'all';
		await tick();
		if (linkedTimer) clearTimeout(linkedTimer);
		const row = document.getElementById(`msg-${messageId}`);
		if (!row) {
			linked = null;
			followNote = hasMore
				? 'That reply is older than the messages loaded so far.'
				: 'That reply is not in the loaded history.';
			return;
		}
		linked = messageId;
		const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
		row.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
		row.focus({ preventScroll: true });
		linkedTimer = setTimeout(() => {
			linked = null;
		}, 2_400);
	}

	async function openCompose(): Promise<void> {
		// `?compose=1` reaches this too: the panel is the write, not the URL.
		if (!canWrite || !hasActiveDevice) return;
		if (!composeDevice || !devices.some((device) => device.device_id === composeDevice && !isRevoked(device))) {
			composeDevice = devices.find((device) => !isRevoked(device))?.device_id ?? '';
		}
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
		const stopClock = subscribeClock();
		void loadRuleNames();
		let interval: ReturnType<typeof setInterval> | undefined;
		let mounted = true;

		void (async () => {
			await loadDevices();
			if (!mounted || devicesError || devices.length === 0) return;
			const requested = page.url.searchParams.get('device');
			const fallbackActive = devices.find((device) => !isRevoked(device)) ?? devices[0];
			selected =
				requested && devices.some((device) => device.device_id === requested)
					? requested
					: fallbackActive.device_id;
			syncUrl();
			composeDevice = (selectedDevice && !isRevoked(selectedDevice) ? selected : fallbackActive.device_id);
			if (page.url.searchParams.get('compose') === '1' && hasActiveDevice) {
				composeOpen = canWrite;
			}
			await loadMessages(true);
			if (!mounted) return;
			void loadStatus();
			lastLivePoll = Date.now();

			interval = setInterval(() => {
				if (document.visibilityState !== 'visible') return;
				if (Date.now() - lastLivePoll < LIVE_POLL_MS) return;
				lastLivePoll = Date.now();
				void pollNewMessages();
			}, LIVE_POLL_MS);
		})();

		const onVisible = () => {
			if (document.visibilityState !== 'visible') return;
			lastLivePoll = 0;
			void pollNewMessages();
		};
		document.addEventListener('visibilitychange', onVisible);

		return () => {
			mounted = false;
			stopClock();
			if (interval) clearInterval(interval);
			if (linkedTimer) clearTimeout(linkedTimer);
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
			class="btn {canWrite && !composeOpen ? 'btn-primary' : ''}"
			bind:this={composeButton}
			onclick={() => void openCompose()}
			disabled={loadingDevices || !hasActiveDevice || !canWrite}
			title={canWrite ? undefined : sendRefusal}
			aria-describedby={canWrite ? undefined : 'messages-read-only'}
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

	{#if !canWrite}
		<p class="read-only" id="messages-read-only">
			<Icon name="shield" size={14} />
			<span>
				<strong>Read-only.</strong> {sendRefusal} You can still read every message, follow a
				reply's delivery and open its trace.
			</span>
		</p>
	{/if}

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
				description={canWrite
					? 'Mint a single-use code and open the link on the phone you want to answer. Until one is paired, nothing can reply.'
					: 'No phone is paired with this gateway yet, so there is no log to read. An owner or admin pairs one with a single-use code.'}
			>
				{#if canWrite}
					<a class="btn btn-primary" href={`${ROUTES.devices}?mint=enroll`}>
						<Icon name="key" size={14} /> Mint a pairing code
					</a>
				{/if}
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
					{#if selectedDevice && isRevoked(selectedDevice)}
						<span class="link-state" title="This device was revoked; historical messages remain readable.">
							<Badge tone="muted">Revoked</Badge>
						</span>
					{:else if selectedDevice}
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
				{:else if visibleMessages.length === 0 && conversationFilter !== null}
					<div class="log-message conv-empty">
						<p class="conv-empty-title">No messages match these filters</p>
						<p class="conv-empty-note">
							The loaded window holds no message from this conversation in this direction. Load
							older messages, or show every conversation.
						</p>
						<div class="row" style="margin-top: 12px">
							<button type="button" class="btn btn-sm" onclick={() => (conversationFilter = null)}>
								<Icon name="filter" size={13} /> Show every conversation
							</button>
						</div>
					</div>
				{:else if visibleMessages.length === 0}
					<EmptyState
						icon="filter"
						title="No {direction === 'in' ? 'inbound' : 'outbound'} messages in this window"
						description="The loaded window has messages in the other direction. Switch to All, or load older messages."
					/>
				{:else}
					{#if followNote}
						<div class="follow-note">
							<Notice tone="info">
								<div class="row" style="gap: 10px; align-items: center; flex-wrap: wrap;">
									<span>{followNote}</span>
									{#if hasMore}
										<button
											type="button"
											class="btn btn-sm"
											onclick={() => void loadMessages(false)}
											disabled={loadingMore}
										>
											{#if loadingMore}<Spinner />{:else}<Icon name="chevron-down" size={12} />{/if}
											Load older
										</button>
									{/if}
									<button
										type="button"
										class="btn btn-ghost btn-sm"
										onclick={() => (followNote = null)}
									>
										Dismiss
									</button>
								</div>
							</Notice>
						</div>
					{/if}
					{#if conversationFilter !== null}
						<div class="conv-filter-bar">
							<Icon name="filter" size={12} />
							<span>
								Only
								{filteredConversation === null
									? 'this'
									: (channelWord(filteredConversation.channel) ?? 'this')}
								conversation{filteredConversation === null
									? ''
									: ` with ${filteredConversation.peer}`}
							</span>
							<span class="spacer"></span>
							<button
								type="button"
								class="link-btn"
								onclick={() => (conversationFilter = null)}
							>
								Show every conversation
							</button>
						</div>
					{/if}
					<ul class="log">
						{#each visibleMessages as message (message.id)}
							{@const outbound = message.direction === 'out'}
							{@const trackerCommandId =
								trackedCommands[message.id] ?? (outbound ? message.id : (message.reply_command_id ?? null))}
							{@const canTrackDelivery = Boolean(trackerCommandId)}
							{@const rowDevice = devices.find((device) => device.device_id === message.device_id)}
							{@const resendHandler =
								canWrite && rowDevice && !isRevoked(rowDevice)
									? (to: string, body: string) => resendMessage(message.id, to, body)
									: undefined}
							{@const isLong = message.body.length > 200}
							{@const isExpanded = expanded.has(message.id)}
							{@const isNew = newIds.has(message.id)}
							{@const ruleName =
								message.reply_source === 'rule' && message.reply_ref
									? (rulesById.get(message.reply_ref)?.name ?? null)
									: null}
							{@const answer = answerPhrase(message, ruleName)}
							{@const answerSource = answerOf(message)}
							{@const fate = fates.get(message.id) ?? null}
							{@const failedReply = !outbound && fate?.state === 'failed'}
							{@const channelLabel = channelWord(message.channel)}
							{@const conversationId =
								typeof message.conversation_id === 'string' && message.conversation_id !== ''
									? message.conversation_id
									: null}
							{@const contextExpanded = contextOpen.has(message.id)}
							{@const context =
								conversationId !== null ? (conversations.get(conversationId) ?? null) : null}
							<li
								id={`msg-${message.id}`}
								class="log-row"
								class:is-new={isNew}
								class:is-linked={linked === message.id}
								data-dir={outbound ? 'out' : 'in'}
								tabindex="-1"
							>
								<span class="dir" aria-hidden="true">
									<Icon name={outbound ? 'arrow-up-right' : 'arrow-down-left'} size={14} />
								</span>
								<div class="msg-main">
									<p class="msg-head">
										<span class="msg-head-main">
											<span class="dir-word">
												<span aria-hidden="true">{outbound ? 'out' : 'in'}</span>
												<span class="sr-only">{outbound ? 'Outbound' : 'Inbound'}</span>
											</span>
											<span class="peer mono">{message.peer}</span>
											{#if channelLabel}
												{#if conversationId}
													<button
														type="button"
														class="channel channel-button"
														aria-expanded={contextExpanded}
														aria-controls={contextExpanded ? `ctx-${message.id}` : undefined}
														aria-label={`${contextExpanded ? 'Hide' : 'Show'} the ${channelLabel} conversation with ${message.peer}, ${formatAbsolute(message.received_at)}`}
														title="Conversation context"
														onclick={() => toggleContext(message.id)}
													>
														{channelLabel}
														<span class="channel-chevron" aria-hidden="true">
															<Icon name="chevron-down" size={10} />
														</span>
													</button>
												{:else}
													<span class="channel">{channelLabel}</span>
												{/if}
											{/if}
											{#if isNew}<span class="new-word">new</span>{/if}
										</span>
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
									{#if answer || (fate && (outbound || failedReply)) || !outbound || canTrackDelivery}
										<div class="msg-meta">
											{#if answer}
												<span class="answer" data-source={answerSource}>{answer}</span>
											{/if}
											{#if fate && (outbound || failedReply)}
												<span class="fate-slot">
													<ReplyFate
														state={fate.state}
														error={fate.error}
														variant={outbound ? 'out' : 'in'}
														href={failedReply
															? `#msg-${message.reply_command_id}`
															: null}
														onfollow={failedReply
															? () => void followReply(message.reply_command_id ?? '')
															: null}
													/>
												</span>
											{/if}
											{#if !outbound || canTrackDelivery}
												<span class="spacer"></span>
												{#if !outbound && canWrite}
													<a
														class="link-btn track-btn rule-test-link"
														href={`${ROUTES.rules}?test_sender=${encodeURIComponent(message.peer)}&test_body=${encodeURIComponent(message.body)}&device=${encodeURIComponent(message.device_id)}`}
													>
														<Icon name="filter" size={11} /> Test in Rules
													</a>
												{/if}
												{#if canTrackDelivery}
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
											{/if}
										</div>
									{/if}
									{#if conversationId && contextExpanded}
										<div class="conv-context" id={`ctx-${message.id}`}>
											<p class="conv-title">{channelLabel ?? 'Conversation'} conversation</p>
											<p class="conv-facts">
												{#if context}
													{context.peer} ·
													{formatCount(context.count)}
													{context.count === 1 ? 'message' : 'messages'} loaded · {formatCount(
														context.inbound
													)} in, {formatCount(context.outbound)} out ·
													<RelativeTime value={context.first} /> to
													<RelativeTime value={context.last} />
												{:else}
													No other row from this conversation is loaded yet.
												{/if}
											</p>
											{#if channelHasSessionState(message.channel)}
												<p class="conv-note">{sessionNote(message)}</p>
											{/if}
											<button
												type="button"
												class="link-btn conv-filter-btn"
												onclick={() => toggleConversationFilter(conversationId)}
											>
												{conversationFilter === conversationId
													? 'Show every conversation'
													: 'Only this conversation'}
											</button>
										</div>
									{/if}
									{#if trackers.has(message.id) && trackerCommandId}
										<div class="reply-tracker" id={`tracker-${message.id}`}>
											<CommandTracker
												deviceId={message.device_id}
												commandId={trackerCommandId}
												onResend={resendHandler}
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

					{#if pageError}
						<div style="margin: 12px 16px 0 16px;">
							<Notice tone="danger" title="Could not load older messages">
								<div class="row" style="gap: 12px; align-items: center;">
									<span>{pageError}</span>
									<button
										type="button"
										class="btn btn-sm btn-primary"
										onclick={() => void loadMessages(false)}
									>
										<Icon name="refresh" size={13} /> Try again
									</button>
								</div>
							</Notice>
						</div>
					{/if}
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
	/* Why a member sees the log without Compose: said once, on the page. */
	.read-only {
		display: flex;
		align-items: flex-start;
		gap: var(--df-p-space-2);
		margin: 0 0 var(--df-p-space-4);
		padding: var(--df-p-space-2) var(--df-p-space-3);
		border: 1px solid var(--df-border-hairline);
		border-left: 2px solid var(--df-text-meta);
		border-radius: 0 var(--df-p-radius-sm) var(--df-p-radius-sm) 0;
		background: var(--df-surface-well);
		font-size: var(--df-p-text-sm);
		line-height: 1.5;
		color: var(--df-text-secondary);
	}

	.read-only :global(svg) {
		flex: none;
		margin-top: 2px;
		color: var(--df-text-meta);
	}

	.read-only strong {
		font-weight: 600;
		color: var(--df-text-primary);
	}

	.compose-panel {
		margin-bottom: var(--df-p-space-4);
		border-color: color-mix(in srgb, var(--df-accent-text) 24%, var(--df-border-hairline));
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
		border-radius: calc(var(--df-c-card-radius) - 1px) calc(var(--df-c-card-radius) - 1px) 0 0;
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

	@media (hover: hover) and (pointer: fine) {
		.log-row:hover {
			background: var(--df-surface-hover);
		}
	}

	.log-row:focus-visible {
		outline-offset: -2px;
	}

	/* The reply a failed question points at. A wash, not a second alarm. */
	.log-row.is-linked {
		background: var(--df-accent-soft);
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
		justify-content: space-between;
		gap: var(--df-p-space-2);
	}

	/* Direction, peer, channel and the new mark share the left cluster; the time
	   keeps the right edge whether a channel word is there or not, so an older
	   row and a Telegram row still line up. */
	.msg-head-main {
		display: flex;
		align-items: baseline;
		gap: var(--df-p-space-2);
		flex-wrap: wrap;
		min-width: 0;
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

	/* A channel word, not a chip: same quiet mono as the direction, so an SMS row
	   reads as it always did and a row with no channel at all (one written before
	   the column) simply has no word. */
	.channel {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		font-family: var(--df-p-font-mono);
		font-size: var(--df-p-text-2xs);
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--df-text-meta);
		white-space: nowrap;
	}

	/* The channel names its conversation. A chevron, not a second control: the
	   word already belongs to the row, and one target per line is enough. */
	.channel-button {
		min-height: 24px;
		padding: 0 var(--df-p-space-1) 0 0;
		border: 0;
		border-radius: var(--df-p-radius-xs);
		background: none;
		cursor: pointer;
	}

	.channel-button:focus-visible {
		outline: 2px solid var(--df-border-focus);
		outline-offset: 2px;
	}

	@media (hover: hover) and (pointer: fine) {
		.channel-button:hover {
			color: var(--df-accent-text);
		}
	}

	.channel-chevron {
		display: grid;
		place-items: center;
		transition: transform var(--df-p-dur-lift) ease;
	}

	.channel-button[aria-expanded='true'] .channel-chevron {
		transform: rotate(180deg);
	}

	.conv-context {
		display: grid;
		gap: 2px;
		margin-top: var(--df-p-space-2);
		padding: var(--df-p-space-2) var(--df-p-space-3);
		border: 1px solid var(--df-border-hairline);
		border-left: 2px solid var(--df-border-control);
		border-radius: 0 var(--df-p-radius-sm) var(--df-p-radius-sm) 0;
		background: var(--df-surface-well);
	}

	.conv-title {
		font-size: var(--df-p-text-xs);
		font-weight: 600;
		color: var(--df-text-primary);
	}

	.conv-facts,
	.conv-note {
		font-size: var(--df-p-text-xs);
		line-height: 1.5;
		color: var(--df-text-secondary);
		overflow-wrap: anywhere;
	}

	.conv-note {
		color: var(--df-text-meta);
	}

	.conv-filter-btn {
		justify-self: start;
		min-height: 24px;
		font-size: var(--df-p-text-xs);
	}

	.conv-filter-bar {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-2);
		flex-wrap: wrap;
		padding: var(--df-p-space-2) var(--df-p-space-4);
		border-bottom: 1px solid var(--df-border-hairline);
		background: var(--df-surface-well);
		font-size: var(--df-p-text-xs);
		color: var(--df-text-secondary);
	}

	.conv-filter-bar :global(svg) {
		flex: none;
		color: var(--df-text-meta);
	}

	.conv-filter-bar .link-btn {
		font-size: var(--df-p-text-xs);
	}

	.conv-empty-title {
		font-size: var(--df-p-text-md);
		font-weight: 600;
		color: var(--df-text-primary);
	}

	.conv-empty-note {
		margin-top: var(--df-p-space-1);
		font-size: var(--df-p-text-base);
		line-height: 1.5;
		color: var(--df-text-meta);
	}

	.new-word {
		font-family: var(--df-p-font-mono);
		font-size: var(--df-p-text-2xs);
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--df-accent-text);
	}

	.msg-time {
		flex: none;
		margin-left: auto;
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

	.follow-note {
		padding: var(--df-p-space-3) var(--df-p-space-4) 0;
	}

	@media (max-width: 720px) {
		.device-picker .input {
			height: 44px;
			min-height: 44px;
		}

		.dir-filter .seg-item span {
			min-height: 44px;
			height: auto;
			padding-inline: var(--df-p-space-3);
		}

		.track-btn {
			min-height: 44px;
		}
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

		/* Answer and Delivery share the first line; the failure gets its own
		   line underneath instead of pushing Delivery onto a third. */
		.msg-meta {
			display: grid;
			grid-template-columns: minmax(0, 1fr) auto;
			align-items: baseline;
			gap: 2px var(--df-p-space-3);
		}

		.msg-meta .spacer {
			display: none;
		}

		/* Two actions (Test in Rules, Delivery) used to share row 1 of column 2
		   and overlap. The column stays, the row is auto: the first sits beside
		   the answer, the second directly under it. */
		.msg-meta .track-btn {
			grid-column: 2;
			justify-self: end;
		}

		.msg-meta .fate-slot {
			grid-column: 1 / -1;
			min-width: 0;
		}

		.compose-meta {
			display: none;
		}

		.channel-button {
			min-height: 32px;
		}

		.conv-filter-btn,
		.conv-filter-bar .link-btn {
			min-height: 44px;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.log-row {
			transition: none;
		}

		.channel-chevron {
			transition: none;
		}
	}
</style>
