<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { page } from '$app/state';
	import {
		archiveDevice,
		describeError,
		getDevices,
		getDeviceStatus,
		mintPairingCode,
		revokeDevice,
		unarchiveDevice
	} from '$lib/api';
	import type { Device, DeviceStatus, PairingCode } from '$lib/types';
	import {
		deviceLabel,
		deviceOptionLabel,
		devicePresence,
		devicePrimary,
		wakeMode
	} from '$lib/presence';
	import { isArchived } from '$lib/device-archive';
	import {
		formatAbsolute,
		formatClock,
		formatDate,
		formatDuration,
		RELATIVE_MAX_MS
	} from '$lib/format';
	import { ROUTES } from '$lib/paths';
	import Badge from '$lib/components/Badge.svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import CopyButton from '$lib/components/CopyButton.svelte';
	import DeviceDetail from '$lib/components/DeviceDetail.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import Mascot from '$lib/components/Mascot.svelte';
	import Notice from '$lib/components/Notice.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import PresenceChip from '$lib/components/PresenceChip.svelte';
	import QrCode from '$lib/components/QrCode.svelte';
	import RelativeTime from '$lib/components/RelativeTime.svelte';
	import Spinner from '$lib/components/Spinner.svelte';

	const TTL_OPTIONS = [
		{ value: 300_000, label: '5 minutes' },
		{ value: 900_000, label: '15 minutes' },
		{ value: 3_600_000, label: '1 hour' },
		{ value: 86_400_000, label: '24 hours' }
	];

	const DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

	let devices = $state<Device[]>([]);
	let statuses = $state<Record<string, DeviceStatus | null>>({});
	let loading = $state(true);
	let refreshing = $state(false);
	let statusesLoading = $state(false);
	let error = $state<string | null>(null);
	let refreshError = $state<string | null>(null);
	let lastRefreshedAt = $state<number | null>(null);
	/** The fleet read in flight, so a toggle flip can wait for it instead of racing it. */
	let fleetInFlight: Promise<void> | null = null;
	let fleetAttempted = false;

	const REFRESH_MS = 30_000;

	let mintOpen = $state(false);
	let purpose = $state<'enroll' | 'rotate'>('enroll');
	let ttl = $state(900_000);
	let scope = $state('');
	let minting = $state(false);
	let mintError = $state<string | null>(null);
	let minted = $state<PairingCode | null>(null);
	let origin = $state('');

	/* Pairing watch: minting is only half the action. Snapshot the fleet before
	   the request, then look for the redeemed device until it appears, the code
	   expires, or ten minutes pass. */
	type PairWait = 'idle' | 'waiting' | 'paired' | 'expired' | 'timed-out';
	interface WatchContext {
		code: PairingCode;
		snapshot: Map<string, number>;
	}

	let waitState = $state<PairWait>('idle');
	let waitNow = $state(Date.now());
	let waitBusy = $state(false);
	let paired = $state<Device | null>(null);
	let watchContext: WatchContext | null = null;
	let watchTimer: ReturnType<typeof setInterval> | null = null;
	let watchGeneration = 0;
	let polling = false;
	let lastPoll = 0;
	let waitStartedAt = 0;

	const PAIR_POLL_MS = 2_000;
	const PAIR_WATCH_MAX_MS = 10 * 60_000;

	let revokeTarget = $state<Device | null>(null);
	let revoking = $state(false);
	let revokeError = $state<string | null>(null);
	let revokedNotice = $state<string | null>(null);

	/* Archive is the reversible half of revoke: the row leaves the list, nothing
	   is destroyed, and the gateway brings it back when the phone polls again. */
	let showArchived = $state(false);
	/** How many archived devices exist while the toggle is off (the list omits them). */
	let archivedCount = $state(0);
	let archivedProbed = false;
	let archiveTarget = $state<Device | null>(null);
	let archiving = $state(false);
	let archiveError = $state<string | null>(null);
	let archiveNotice = $state<{ tone: 'ok' | 'danger'; title: string; text: string } | null>(null);

	let detailOpen = $state(false);
	let detailId = $state('');

	const detailDevice = $derived(
		devices.find((device) => device.device_id === detailId) ?? null
	);

	// One state per row, computed once so the summary and the chips cannot disagree.
	const fleetStates = $derived(
		devices.map((device) =>
			devicePresence(device, statuses[device.device_id]?.ws_connected === true)
		)
	);

	/**
	 * The rows as they are drawn: active devices first, archived ones after them
	 * when the toggle is on. Archiving is not a state of the phone, it is a state
	 * of the list, so the two groups never interleave.
	 */
	const fleet = $derived.by(() => {
		const rows = devices.map((device, index) => ({
			device,
			archived: isArchived(device),
			presence: fleetStates[index]
		}));
		if (!showArchived) return rows;
		return [...rows.filter((row) => !row.archived), ...rows.filter((row) => row.archived)];
	});

	const activeCount = $derived(fleet.filter((row) => !row.archived).length);
	const answering = $derived(
		fleet.filter(
			(row) => !row.archived && (row.presence === 'live' || row.presence === 'synced')
		).length
	);
	const archivedTotal = $derived(
		showArchived ? fleet.filter((row) => row.archived).length : archivedCount
	);
	/** A toggle with nothing behind it is noise; it appears with the first archive. */
	const archiveToggleVisible = $derived(archivedTotal > 0 || showArchived);

	/** Labels for the drawer, so "copied from" can name a device that is still listed. */
	const deviceLabels = $derived.by(() => {
		const labels: Record<string, string> = {};
		for (const device of devices) {
			const label = deviceLabel(device);
			if (label) labels[device.device_id] = label;
		}
		return labels;
	});

	const scopeError = $derived.by(() => {
		if (purpose === 'rotate' && !scope) return 'Choose the device whose key will be rotated.';
		if (scope && !DEVICE_ID_RE.test(scope)) {
			return 'Device ids are 8–64 characters: letters, digits, underscore or hyphen.';
		}
		return null;
	});

	const deepLink = $derived(
		minted ? `dakflare://pair?u=${origin}&c=${minted.pairing_code}` : ''
	);

	const remainingMs = $derived(minted ? Math.max(0, minted.expires_at - waitNow) : 0);
	const waitCountdown = $derived(formatCountdown(remainingMs));
	const pairedHref = $derived(
		paired ? `${ROUTES.devices}?device=${encodeURIComponent(paired.device_id)}` : ROUTES.devices
	);

	function formatCountdown(ms: number): string {
		const total = Math.max(0, Math.ceil(ms / 1000));
		const hours = Math.floor(total / 3600);
		const minutes = Math.floor((total % 3600) / 60);
		const seconds = total % 60;
		if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
		return `${minutes}:${String(seconds).padStart(2, '0')}`;
	}

	/**
	 * The last-seen cell. Recent contact is a live relative label with the exact
	 * stamp underneath; past a week the relative label *is* the exact stamp, which
	 * is wider than the column and would repeat itself on the line below — so an
	 * old contact reads as a date over a clock, the same shape as "Paired".
	 */
	function seenParts(value: number | null): { main: string | null; sub: string | null } {
		if (!value) return { main: null, sub: null };
		if (Date.now() - value > RELATIVE_MAX_MS) {
			return { main: formatDate(value), sub: formatClock(value) };
		}
		return { main: null, sub: formatAbsolute(value) };
	}

	// The rotate picker borrows the shared scope error, and gains a hint only when
	// there is nothing to pick. Build the reference list so neither goes dangling.
	const scopeSelectDescribedBy = $derived(
		[devices.length === 0 ? 'scope-select-hint' : null, scopeError ? 'scope-error' : null]
			.filter(Boolean)
			.join(' ') || undefined
	);

	/**
	 * One fleet read. The mode is captured before the request so a toggle flip
	 * mid-flight cannot land the other mode's rows on screen.
	 */
	function load(background = false): Promise<void> {
		if (fleetInFlight) return fleetInFlight;
		const run = readFleet(background).finally(() => {
			fleetInFlight = null;
		});
		fleetInFlight = run;
		return run;
	}

	async function readFleet(background: boolean): Promise<void> {
		const includeArchived = showArchived;
		if (!fleetAttempted) loading = true;
		else if (!background) refreshing = true;
		try {
			const list = await getDevices(includeArchived);
			// The operator flipped the toggle while this read was in flight; that
			// flip owns the next answer, and this one describes the other list.
			if (includeArchived !== showArchived) return;
			devices = list;
			if (showArchived) archivedCount = list.filter(isArchived).length;
			await loadStatuses(list.filter((device) => !isArchived(device)), background);
			lastRefreshedAt = Date.now();
			refreshError = null;
			error = null;
		} catch (failure) {
			if (fleetAttempted) {
				// Keep the rows that are on screen; only the freshness note changes.
				refreshError = describeError(failure);
			} else {
				error = describeError(failure);
			}
		} finally {
			loading = false;
			refreshing = false;
			fleetAttempted = true;
		}
	}

	/**
	 * The archived count while the toggle is off. The list endpoint omits those
	 * rows unless asked, so the count costs one extra read — once per page load,
	 * not once per refresh. A failure only hides the count; it never blocks the
	 * fleet.
	 */
	async function probeArchivedCount(): Promise<void> {
		if (archivedProbed) return;
		archivedProbed = true;
		try {
			const all = await getDevices(true);
			archivedCount = all.filter(isArchived).length;
		} catch {
			archivedCount = 0;
		}
	}

	/** The toggle is a request, not a filter: it changes what the gateway is asked. */
	async function setShowArchived(next: boolean): Promise<void> {
		if (showArchived === next) return;
		// Turning the archived rows off, the count they carried is the only place
		// it still exists: the next read omits them.
		if (!next) archivedCount = devices.filter(isArchived).length;
		showArchived = next;
		// A read already in flight answers for the old mode; let it finish first.
		if (fleetInFlight) await fleetInFlight;
		await load();
	}

	async function loadStatuses(list: Device[], quiet = false) {
		if (list.length === 0) {
			statuses = {};
			if (!quiet) statusesLoading = false;
			return;
		}
		if (!quiet) statusesLoading = true;
		const results = await Promise.all(
			list.map(async (device) => {
				try {
					const status = await getDeviceStatus(device.device_id);
					return [device.device_id, status] as const;
				} catch {
					return [device.device_id, null] as const;
				}
			})
		);
		statuses = Object.fromEntries(results);
		if (!quiet) statusesLoading = false;
	}

	async function openMint(
		nextPurpose: 'enroll' | 'rotate' = 'enroll',
		deviceId = '',
		scroll = true
	) {
		stopWatching();
		waitState = 'idle';
		paired = null;
		watchContext = null;
		mintOpen = true;
		purpose = nextPurpose;
		scope = deviceId;
		mintError = null;
		minted = null;
		if (scroll) {
			await tick();
			// An instant jump: the motion set has no scroll animation.
			document.getElementById('mint-panel')?.scrollIntoView({ block: 'start', behavior: 'auto' });
		}
	}

	function closeMint() {
		stopWatching();
		waitState = 'idle';
		paired = null;
		watchContext = null;
		minted = null;
		mintOpen = false;
	}

	function stopWatching() {
		watchGeneration += 1;
		if (watchTimer !== null) {
			clearInterval(watchTimer);
			watchTimer = null;
		}
		polling = false;
	}

	/** Fleet ids and their last contact at the moment the code was minted. */
	function fleetSnapshot(): Map<string, number> {
		return new Map(devices.map((device) => [device.device_id, device.last_seen ?? 0]));
	}

	function startWatching(code: PairingCode, snapshot: Map<string, number>) {
		stopWatching();
		const generation = watchGeneration;
		watchContext = { code, snapshot };
		paired = null;
		waitState = 'waiting';
		waitNow = Date.now();
		waitStartedAt = Date.now();
		lastPoll = 0;
		watchTimer = setInterval(() => {
			if (generation !== watchGeneration) return;
			waitNow = Date.now();
			if (waitNow >= code.expires_at) {
				waitState = 'expired';
				stopWatching();
				return;
			}
			if (waitNow - waitStartedAt >= PAIR_WATCH_MAX_MS) {
				waitState = 'timed-out';
				stopWatching();
				return;
			}
			if (document.hidden) return;
			if (waitNow - lastPoll < PAIR_POLL_MS) return;
			void checkForPair(generation);
		}, 1_000);
	}

	/**
	 * One fleet read. A scoped code is redeemed by its expected device id (the
	 * same row for a rotation, whose `last_seen` advances); an unscoped code is
	 * redeemed by any id that was not in the snapshot.
	 */
	async function checkForPair(generation: number): Promise<void> {
		const context = watchContext;
		if (!context || polling) return;
		polling = true;
		lastPoll = Date.now();
		try {
			const list = await getDevices(showArchived);
			if (generation !== watchGeneration) return;
			const expected = context.code.device_id;
			const match = expected
				? list.find(
						(device) =>
							device.device_id === expected &&
							(!context.snapshot.has(expected) ||
								(device.last_seen ?? 0) !== context.snapshot.get(expected))
					)
				: list.find((device) => !context.snapshot.has(device.device_id));
			if (!match) return;
			devices = list;
			if (showArchived) archivedCount = list.filter(isArchived).length;
			void loadStatuses(list.filter((device) => !isArchived(device)));
			paired = match;
			waitState = 'paired';
			stopWatching();
		} catch {
			// A transient read failure is not a pairing failure; the next tick retries.
		} finally {
			polling = false;
		}
	}

	async function checkNow() {
		if (waitBusy) return;
		waitBusy = true;
		waitNow = Date.now();
		try {
			await checkForPair(watchGeneration);
		} finally {
			waitBusy = false;
		}
	}

	async function startRotate(device: Device) {
		await openMint('rotate', device.device_id);
	}

	function syncDetailUrl(id: string | null): void {
		const url = new URL(window.location.href);
		if (id) url.searchParams.set('device', id);
		else url.searchParams.delete('device');
		history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
	}

	function openDetail(id: string): void {
		detailId = id;
		detailOpen = true;
		syncDetailUrl(id);
	}

	function closeDetail(): void {
		detailOpen = false;
		syncDetailUrl(null);
	}

	async function mintForDevice(id: string): Promise<void> {
		closeDetail();
		await openMint('enroll', id);
	}

	function handleRevoked(id: string): void {
		const revoked = devices.find((device) => device.device_id === id);
		devices = devices.filter((device) => device.device_id !== id);
		const name = revoked ? devicePrimary(revoked) : id;
		const alsoId = revoked && deviceLabel(revoked) ? ` (${id})` : '';
		revokedNotice = `Revoked ${name}${alsoId}. Its key no longer authenticates.`;
		detailOpen = false;
		syncDetailUrl(null);
	}

	async function mint() {
		if (minting || scopeError) return;
		const snapshot = fleetSnapshot();
		stopWatching();
		waitState = 'idle';
		paired = null;
		watchContext = null;
		minting = true;
		mintError = null;
		minted = null;
		try {
			const result = await mintPairingCode({
				ttl_ms: ttl,
				purpose,
				device_id: scope ? scope : null
			});
			minted = result;
			startWatching(result, snapshot);
		} catch (failure) {
			mintError = describeError(failure);
		} finally {
			minting = false;
		}
	}

	async function confirmRevoke() {
		if (!revokeTarget || revoking) return;
		revoking = true;
		revokeError = null;
		const target = revokeTarget;
		try {
			await revokeDevice(target.device_id);
			devices = devices.filter((device) => device.device_id !== target.device_id);
			const name = devicePrimary(target);
			const alsoId = deviceLabel(target) ? ` (${target.device_id})` : '';
			revokedNotice = `Revoked ${name}${alsoId}. Its key no longer authenticates.`;
			revokeTarget = null;
		} catch (failure) {
			revokeError = describeError(failure);
		} finally {
			revoking = false;
		}
	}

	function archiveCopy(device: Device): string {
		const alsoId = deviceLabel(device) ? ` (${device.device_id})` : '';
		return `${devicePrimary(device)}${alsoId}`;
	}

	/**
	 * The drawer archived the device it was showing. With the toggle off the row
	 * leaves the list, so the drawer has nothing left to describe and closes.
	 */
	function handleArchived(id: string): void {
		const target = devices.find((device) => device.device_id === id) ?? null;
		applyArchived(id, Date.now());
		archiveNotice = {
			tone: 'ok',
			title: 'Device archived',
			text: target
				? `Archived ${archiveCopy(target)}. It left the fleet list; its message history stays.`
				: `Archived ${id}. It left the fleet list; its message history stays.`
		};
		detailOpen = false;
		syncDetailUrl(null);
	}

	function handleUnarchived(id: string): void {
		const target = devices.find((device) => device.device_id === id) ?? null;
		applyArchived(id, null);
		archiveNotice = {
			tone: 'ok',
			title: 'Device unarchived',
			text: target
				? `Unarchived ${archiveCopy(target)}. It is back in the fleet list.`
				: `Unarchived ${id}. It is back in the fleet list.`
		};
	}

	/** Keep the row's archive stamp in step with the gateway, without a re-read. */
	function applyArchived(id: string, at: number | null): void {
		if (showArchived) {
			devices = devices.map((device) =>
				device.device_id === id ? { ...device, archived_at: at } : device
			);
			archivedCount = devices.filter(isArchived).length;
			return;
		}
		// Archived rows are not in this list; an archived device leaves it.
		if (at !== null) {
			devices = devices.filter((device) => device.device_id !== id);
			statuses = Object.fromEntries(
				Object.entries(statuses).filter(([key]) => key !== id)
			);
			archivedCount += 1;
		}
	}

	async function confirmArchive() {
		if (!archiveTarget || archiving) return;
		archiving = true;
		archiveError = null;
		const target = archiveTarget;
		try {
			await archiveDevice(target.device_id);
			archiveTarget = null;
			handleArchived(target.device_id);
		} catch (failure) {
			archiveError = describeError(failure);
		} finally {
			archiving = false;
		}
	}

	async function unarchiveFromRow(device: Device): Promise<void> {
		try {
			await unarchiveDevice(device.device_id);
			handleUnarchived(device.device_id);
		} catch (failure) {
			archiveNotice = {
				tone: 'danger',
				title: 'Could not unarchive',
				text: describeError(failure)
			};
		}
	}

	onMount(() => {
		origin = window.location.origin;
		const requestedPurpose = page.url.searchParams.get('mint');
		const requestedDevice = page.url.searchParams.get('device') ?? '';
		void (async () => {
			await load();
			// The archived count is not in the fleet answer; one extra read names it.
			void probeArchivedCount();
			if (requestedPurpose === 'rotate' || requestedPurpose === 'enroll') {
				await openMint(requestedPurpose, requestedDevice, false);
			} else if (
				requestedDevice &&
				devices.some((device) => device.device_id === requestedDevice)
			) {
				// `?device=` is the static SPA's stand-in for a detail route: no
				// dynamic segment, no extra HTML shell, and the drawer is shareable.
				openDetail(requestedDevice);
			}
		})();

		const timer = setInterval(() => {
			if (document.visibilityState === 'visible') void load(true);
		}, REFRESH_MS);
		const onVisible = () => {
			if (document.visibilityState === 'visible') void load(true);
		};
		document.addEventListener('visibilitychange', onVisible);

		return () => {
			stopWatching();
			clearInterval(timer);
			document.removeEventListener('visibilitychange', onVisible);
		};
	});
</script>

<svelte:head>
	<title>Devices · DakFlare</title>
</svelte:head>

<div class="page">
	<PageHeader
		eyebrow="Fleet"
		title="Paired devices"
		description="Every phone registered with this gateway. Presence comes from the live link and the last authenticated contact; wake capability is listed separately."
	>
		<button
			type="button"
			class="btn"
			onclick={() => void load()}
			disabled={loading || refreshing}
			aria-busy={refreshing}
		>
			{#if refreshing}<Spinner />{:else}<Icon name="refresh" size={14} />{/if}
			Refresh
		</button>
		<button type="button" class="btn btn-primary" onclick={() => void openMint('enroll')}>
			<Icon name="key" size={14} /> Mint pairing code
		</button>
	</PageHeader>

	{#if refreshError && lastRefreshedAt}
		<p class="refresh-note" role="status" title={refreshError}>
			last refreshed <RelativeTime value={lastRefreshedAt} /> · refresh failed
		</p>
	{/if}

	<div class="stack">
		{#if revokedNotice}
			<Notice tone="ok" title="Device revoked">{revokedNotice}</Notice>
		{/if}

		{#if archiveNotice}
			<Notice tone={archiveNotice.tone} title={archiveNotice.title}>
				{archiveNotice.text}
			</Notice>
		{/if}

		{#if mintOpen}
			<section class="card mint-panel" id="mint-panel" aria-labelledby="mint-heading">
				<div class="card-head">
					<h2 id="mint-heading" class="card-title">
						<Icon name="key" size={14} /> Mint pairing code
					</h2>
					<span class="spacer"></span>
					<button
						type="button"
						class="btn btn-ghost btn-icon btn-sm"
						onclick={closeMint}
						aria-label="Close pairing form"
					>
						<Icon name="x" size={14} />
					</button>
				</div>
				<form
					class="form-grid"
					onsubmit={(event) => {
						event.preventDefault();
						void mint();
					}}
				>
					<div class="field span-1">
						<span class="label" id="purpose-label">Purpose</span>
						<div class="seg" role="group" aria-labelledby="purpose-label">
							<label class="seg-item">
								<input type="radio" name="purpose" value="enroll" bind:group={purpose} />
								<span>Enroll new</span>
							</label>
							<label class="seg-item">
								<input type="radio" name="purpose" value="rotate" bind:group={purpose} />
								<span>Rotate key</span>
							</label>
						</div>
						{#if purpose === 'rotate'}
							<p class="rotate-note">
								Rotation replaces the key this phone authenticates with. The old key stops
								working immediately, and the phone must pair again with the new code.
							</p>
						{/if}
					</div>

					<div class="field">
						<label class="label" for="ttl">Valid for</label>
						<select id="ttl" class="input" bind:value={ttl}>
							{#each TTL_OPTIONS as option (option.value)}
								<option value={option.value}>{option.label}</option>
							{/each}
						</select>
					</div>

					<div class="field">
						{#if purpose === 'rotate'}
							<label class="label" for="scope-select">Device to rotate</label>
							<select
								id="scope-select"
								class="input input-mono"
								bind:value={scope}
								aria-invalid={scopeError ? 'true' : undefined}
								aria-describedby={scopeSelectDescribedBy}
							>
								<option value="">Select a device…</option>
								{#each devices as device (device.device_id)}
									<option value={device.device_id}>{deviceOptionLabel(device)}</option>
								{/each}
							</select>
							{#if devices.length === 0}
								<p class="hint" id="scope-select-hint">No paired devices to rotate yet.</p>
							{/if}
						{:else}
							<label class="label" for="scope-input">
								Device id <span class="optional">optional</span>
							</label>
							<input
								id="scope-input"
								class="input input-mono"
								bind:value={scope}
								placeholder="Any device"
								autocomplete="off"
								spellcheck="false"
								aria-invalid={scope && DEVICE_ID_RE.test(scope) === false ? 'true' : undefined}
								aria-describedby={scopeError ? 'scope-hint scope-error' : 'scope-hint'}
							/>
							<p class="hint" id="scope-hint">
								Scope the code to one id, or leave blank to enroll any device.
							</p>
						{/if}
					</div>

					{#if scopeError}
						<p class="field-error span-3" id="scope-error" role="alert">{scopeError}</p>
					{/if}

					{#if purpose !== 'rotate'}
						<p class="hint span-3">
							An enrollment code registers a device that is not yet paired. It cannot take over
							an existing device id.
						</p>
					{/if}

					<div class="form-foot">
						<button
							type="submit"
							class="btn btn-primary"
							disabled={minting || Boolean(scopeError)}
							aria-busy={minting}
						>
							{#if minting}<Spinner />{:else}<Icon name="key" size={14} />{/if}
							{ttl === 86_400_000 ? 'Mint 24-hour code' : `Mint ${formatDuration(ttl)} code`}
						</button>
						<span class="spacer"></span>
						<button type="button" class="btn btn-ghost" onclick={closeMint}>Close</button>
					</div>
				</form>

				{#if mintError}
					<div class="mint-feedback" aria-live="assertive">
						<Notice tone="danger" title="Could not mint a code">{mintError}</Notice>
					</div>
				{/if}

				{#if minted}
					<div class="mint-feedback">
						{#if waitState === 'paired' && paired}
							{@const matched = paired}
							<div class="pair-state pair-state-ok" aria-live="polite">
								<span class="pair-state-mascot"><Mascot size={64} /></span>
								<div class="pair-state-body">
									<p class="eyebrow">
										{minted.purpose === 'rotate' ? 'Key rotated' : 'Pairing complete'}
									</p>
									<h3>
										{minted.purpose === 'rotate' ? 'Key rotated for' : 'Paired as'}
										{deviceLabel(matched) ?? matched.device_id}
									</h3>
									{#if deviceLabel(matched)}
										<p class="mono pair-id">{matched.device_id}</p>
									{/if}
									<p class="hint">
										The phone is in the fleet. This code was single-use and can no longer be
										redeemed.
									</p>
									<div class="row">
										<a
											class="btn btn-primary btn-sm"
											href={pairedHref}
											onclick={(event) => {
												if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
												event.preventDefault();
												openDetail(matched.device_id);
											}}
										>
											<Icon name="smartphone" size={12} /> Open device
										</a>
										<button type="button" class="btn btn-sm" onclick={closeMint}>Done</button>
									</div>
								</div>
							</div>
						{:else if waitState === 'expired'}
							<div class="pair-state pair-state-expired" aria-live="polite">
								<span class="pair-state-mark"><Icon name="clock" size={16} /></span>
								<div class="pair-state-body">
									<p class="eyebrow">Pairing code</p>
									<h3>Code expired — mint a new one</h3>
									<p class="hint">
										This code can no longer register a phone. A fresh code replaces it; the old
										one is not left looking valid.
									</p>
									<div class="row">
										<button
											type="button"
											class="btn btn-primary btn-sm"
											onclick={() => void mint()}
											disabled={minting}
											aria-busy={minting}
										>
											{#if minting}<Spinner />{:else}<Icon name="key" size={12} />{/if}
											Mint a new code
										</button>
										<button type="button" class="btn btn-sm" onclick={closeMint}>Close</button>
									</div>
								</div>
							</div>
						{:else}
							<div class="mint-result">
								<div class="mint-result-head">
									<span class="eyebrow">
										{minted.purpose === 'rotate' ? 'Rotation code' : 'Enrollment code'}
									</span>
									<span class="mono mint-expiry">
										expires <RelativeTime value={minted.expires_at} className="mono" /> ·{' '}
										{formatClock(minted.expires_at)}
									</span>
								</div>
								<div class="mint-result-body">
									<div class="mint-credential">
										<div class="code-line">
											<code class="pair-code">{minted.pairing_code}</code>
											<CopyButton value={minted.pairing_code} label="Copy code" />
										</div>
										<div class="field deep-link">
											<label class="label" for="deep-link">Deep link</label>
											<div class="input-row">
												<input
													id="deep-link"
													class="input input-mono"
													readonly
													value={deepLink}
													aria-describedby="deep-link-hint"
												/>
												<CopyButton value={deepLink} label="Copy link" />
											</div>
										</div>
										<p class="hint" id="deep-link-hint">
											{minted.device_id
												? `Bound to ${minted.device_id}. Open the link on that device.`
												: 'Unscoped: the first device to redeem it is registered.'}
											Single-use; it disappears after one successful pairing.
										</p>
									</div>
									<div class="mint-qr">
										<QrCode
											value={deepLink}
											size={184}
											label={`Pairing QR code for ${minted.pairing_code}`}
											caption="Scan to pair"
										/>
									</div>
								</div>
							</div>

							{#if waitState === 'waiting'}
								<div class="pair-watch">
									<Spinner />
									<div class="pair-watch-copy">
										<strong>Waiting for the phone…</strong>
										<span class="hint">
											Checked every 2 seconds while this tab is visible.
											<span class="mono">{waitCountdown}</span> left.
										</span>
									</div>
									<span class="spacer"></span>
									<button
										type="button"
										class="btn btn-sm"
										onclick={() => void checkNow()}
										disabled={waitBusy}
										aria-busy={waitBusy}
									>
										{#if waitBusy}<Spinner />{:else}<Icon name="refresh" size={12} />{/if}
										Check now
									</button>
								</div>
							{:else if waitState === 'timed-out'}
								<div class="pair-watch pair-watch-stopped">
									<Icon name="clock" size={15} />
									<div class="pair-watch-copy">
										<strong>Still waiting for the phone</strong>
										<span class="hint">
											Automatic checks stopped after 10 minutes. The code is valid for another
											<span class="mono">{waitCountdown}</span> if it was not redeemed.
										</span>
									</div>
									<span class="spacer"></span>
									<button
										type="button"
										class="btn btn-sm"
										onclick={() => void checkNow()}
										disabled={waitBusy}
										aria-busy={waitBusy}
									>
										{#if waitBusy}<Spinner />{:else}<Icon name="refresh" size={12} />{/if}
										Check now
									</button>
								</div>
							{/if}
						{/if}
					</div>
				{/if}
			</section>
		{/if}

		{#if error}
			<section class="card">
				<Notice tone="danger" title="Could not load devices">{error}</Notice>
				<div class="row" style="margin-top: 16px">
					<button type="button" class="btn btn-primary" onclick={() => void load()}>
						<Icon name="refresh" size={14} /> Try again
					</button>
				</div>
			</section>
		{:else if loading}
			<section class="card fleet-card" aria-busy="true" aria-live="polite">
				<span class="sr-only">Loading devices</span>
				<div class="fleet-card-head">
					<h2 class="card-title">Fleet</h2>
				</div>
				<div class="fleet-skeletons">
					{#each ['a', 'b', 'c'] as key (key)}
						<div class="skeleton" style="height: 46px"></div>
					{/each}
				</div>
			</section>
		{:else if devices.length === 0 && archivedTotal === 0}
			<section class="card">
				<EmptyState
					icon="smartphone"
					title="No devices paired yet"
					description="Mint a single-use code and open the link on the phone you want to answer. Until one is paired, nothing can reply."
				>
					<button type="button" class="btn btn-primary" onclick={() => void openMint('enroll')}>
						<Icon name="key" size={14} /> Mint a pairing code
					</button>
				</EmptyState>
			</section>
		{:else}
			<section class="card fleet-card" aria-labelledby="fleet-heading">
				<div class="fleet-card-head">
					<h2 id="fleet-heading" class="card-title">Fleet</h2>
					<span class="fleet-count mono">
						{activeCount} paired · {answering} answering{#if showArchived && archivedTotal > 0}{' · '}{archivedTotal} archived{/if}
					</span>
					{#if statusesLoading}
						<span class="fleet-checking"><Spinner /> checking links</span>
					{/if}
					{#if archiveToggleVisible}
						<label
							class="archived-toggle"
							title={showArchived
								? 'Hide archived devices from this list'
								: 'Include archived devices in this list'}
						>
							<input
								type="checkbox"
								role="switch"
								checked={showArchived}
								onchange={(event) => void setShowArchived(event.currentTarget.checked)}
							/>
							<span class="toggle-track" aria-hidden="true">
								<span class="toggle-thumb"></span>
							</span>
							<span class="toggle-text">Show archived</span>
							{#if archivedTotal > 0}
								<span class="toggle-count mono">{archivedTotal}</span>
							{/if}
						</label>
					{/if}
				</div>

				{#if devices.length === 0}
					<p class="fleet-none">
						No active devices. <span class="mono">{archivedTotal}</span>
						{archivedTotal === 1 ? 'archived device is' : 'archived devices are'} hidden — turn on
						<strong>Show archived</strong> to see {archivedTotal === 1 ? 'it' : 'them'}.
					</p>
				{:else}
					<!-- One list, two layouts: a dense table-like grid above 860px, a stacked
					     row below it. The fleet is never rendered twice. -->
					<div class="fleet">
						<div class="fleet-head" aria-hidden="true">
							<span>Device</span>
							<span>State</span>
							<span>Last seen</span>
							<span>Paired</span>
							<span>Wake</span>
							<span></span>
						</div>
						<ul class="fleet-rows">
							{#each fleet as row (row.device.device_id)}
								{@const device = row.device}
								{@const archived = row.archived}
								{@const status = statuses[device.device_id]}
								{@const presence = row.presence}
								{@const seen = seenParts(device.last_seen)}
								<li class="fleet-row" class:is-archived={archived}>
									<div class="cell-device">
										<span class="sr-only">Device</span>
										<button
											type="button"
											class="device-open"
											onclick={() => openDetail(device.device_id)}
											aria-label={`Open details for ${devicePrimary(device)}`}
											title="Open device details"
										>
											<span class="device-label">
												{#if deviceLabel(device)}
													<span class="device-name">{deviceLabel(device)}</span>
												{/if}
												<span class="mono device-id">
													{device.device_id}<span class="device-go" aria-hidden="true">›</span>
												</span>
											</span>
										</button>
										<CopyButton value={device.device_id} label="Copy device id" iconOnly />
									</div>

									<div class="cell-state">
										<span class="sr-only">State </span>
										{#if archived}
											<span
												class="archived-mark"
												title={`Archived ${formatAbsolute(device.archived_at)}`}
											>
												<Badge tone="muted">
													archived <RelativeTime
														value={device.archived_at}
														className="mono"
														fallback="recently"
													/>
												</Badge>
											</span>
										{:else}
											<PresenceChip {presence} queue={status?.queue_depth ?? null} />
											{#if status === null && !statusesLoading}
												<span class="cell-note">socket state unavailable</span>
											{/if}
										{/if}
									</div>

									<div class="cell-seen">
										<span class="cell-key">last seen</span>
										{#if seen.main === null}
											<span class="cell-main mono">
												<RelativeTime value={device.last_seen} fallback="never" />
											</span>
										{:else}
											<span class="cell-main">{seen.main}</span>
										{/if}
										{#if seen.sub}
											<span class="cell-sub">{seen.sub}</span>
										{/if}
									</div>

									<div class="cell-paired">
										<span class="cell-key">paired</span>
										<span class="cell-main">{formatDate(device.paired_at)}</span>
										<span class="cell-sub">{formatClock(device.paired_at)}</span>
									</div>

									<div class="cell-wake">
										<span class="sr-only">Wake </span>
										<Badge tone={device.fcm_token ? 'accent' : 'muted'}>{wakeMode(device)}</Badge>
									</div>

									<div class="cell-actions">
										<button
											type="button"
											class="btn btn-ghost btn-sm"
											onclick={() => void startRotate(device)}
											aria-label={`Rotate key for ${devicePrimary(device)}`}
										>
											<Icon name="key" size={12} /> Rotate
										</button>
										{#if archived}
											<button
												type="button"
												class="btn btn-sm"
												onclick={() => void unarchiveFromRow(device)}
												aria-label={`Unarchive ${devicePrimary(device)}`}
											>
												<Icon name="unarchive" size={12} /> Unarchive
											</button>
										{:else}
											<button
												type="button"
												class="btn btn-ghost btn-sm"
												onclick={() => {
													archiveError = null;
													archiveTarget = device;
												}}
												aria-label={`Archive ${devicePrimary(device)}`}
											>
												<Icon name="archive" size={12} /> Archive
											</button>
										{/if}
										<button
											type="button"
											class="btn btn-danger btn-sm"
											onclick={() => {
												revokeError = null;
												revokeTarget = device;
											}}
											aria-label={`Revoke ${devicePrimary(device)}`}
										>
											<Icon name="trash" size={12} /> Revoke
										</button>
									</div>
								</li>
							{/each}
						</ul>
					</div>

					<p class="fleet-note">
						<strong>live</strong> — connected now · <strong>synced</strong> — in contact within 15
						minutes · <strong>stale</strong> — within 24 hours · <strong>offline</strong> — over 24
						hours · <strong>unknown</strong> — no contact recorded. Wake is
						<span class="mono">push</span> when the phone holds a push token, otherwise
						<span class="mono">poll-only</span>.
					</p>
				{/if}
			</section>
		{/if}
	</div>
</div>

<ConfirmDialog
	open={archiveTarget !== null}
	title="Archive this device?"
	confirmLabel="Archive device"
	tone="primary"
	pending={archiving}
	error={archiveError}
	onconfirm={() => void confirmArchive()}
	oncancel={() => {
		if (!archiving) {
			archiveTarget = null;
			archiveError = null;
		}
	}}
>
	{#if archiveTarget}
		<p>
			<strong>{devicePrimary(archiveTarget)}</strong>
			{#if deviceLabel(archiveTarget)}(<span class="mono">{archiveTarget.device_id}</span>){/if}
			leaves the fleet list. Its message history stays on the gateway, and it comes back by
			itself if the phone polls again.
		</p>
		<p class="hint" style="margin-top: 10px">
			Archiving keeps the key. Use Revoke when the phone should stop authenticating.
		</p>
	{/if}
</ConfirmDialog>

<ConfirmDialog
	open={revokeTarget !== null}
	title="Revoke this device?"
	confirmLabel="Revoke device"
	tone="danger"
	pending={revoking}
	error={revokeError}
	onconfirm={() => void confirmRevoke()}
	oncancel={() => {
		if (!revoking) {
			revokeTarget = null;
			revokeError = null;
		}
	}}
>
	{#if revokeTarget}
		<p>
			<strong>{devicePrimary(revokeTarget)}</strong>
			{#if deviceLabel(revokeTarget)}(<span class="mono">{revokeTarget.device_id}</span>){/if}
			stops authenticating now. Its key is destroyed on the gateway and any queued message is
			dropped.
		</p>
		<p class="hint" style="margin-top: 10px">
			Pair it again with a new code to bring it back.
		</p>
	{/if}
</ConfirmDialog>

<DeviceDetail
	open={detailOpen}
	deviceId={detailId}
	device={detailDevice}
	deviceLabels={deviceLabels}
	onclose={closeDetail}
	onrevoked={handleRevoked}
	onarchived={handleArchived}
	onunarchived={handleUnarchived}
	onmint={(id) => void mintForDevice(id)}
/>

<style>
	.refresh-note {
		margin: calc(-1 * var(--df-p-space-2)) 0 var(--df-p-space-4);
		font-family: var(--df-p-font-mono);
		font-size: var(--df-p-text-xs);
		line-height: 1.45;
		color: var(--df-text-meta);
	}

	.mint-panel {
		border-color: color-mix(in srgb, var(--df-accent-text) 26%, var(--df-border-hairline));
		scroll-margin-top: calc(var(--df-c-shell-header) + var(--df-p-space-4));
	}

	.mint-panel .card-head {
		margin-bottom: var(--df-p-space-4);
	}

	.rotate-note {
		margin-top: var(--df-p-space-2);
		padding: var(--df-p-space-2) var(--df-p-space-3);
		border: 1px solid var(--df-c-tint-edge-warn);
		border-left: 2px solid var(--df-state-warn-ink);
		border-radius: 0 var(--df-p-radius-sm) var(--df-p-radius-sm) 0;
		background: var(--df-state-warn-bg);
		color: var(--df-text-secondary);
		font-size: var(--df-p-text-xs);
		line-height: 1.45;
	}

	.mint-feedback {
		margin-top: var(--df-p-space-4);
	}

	.pair-watch {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-3);
		flex-wrap: wrap;
		margin-top: var(--df-p-space-3);
		padding: var(--df-p-space-2) var(--df-p-space-3);
		border: 1px solid color-mix(in srgb, var(--df-accent-text) 24%, var(--df-border-hairline));
		border-radius: var(--df-p-radius-sm);
		background: var(--df-accent-soft);
	}

	.pair-watch-stopped {
		border-color: var(--df-state-warn-ink);
		background: var(--df-state-warn-bg);
	}

	.pair-watch-copy {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.pair-watch-copy strong {
		font-size: var(--df-p-text-base);
		font-weight: 600;
	}

	.pair-state {
		display: flex;
		align-items: flex-start;
		gap: var(--df-p-space-3);
		padding: var(--df-p-space-4);
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-md);
	}

	.pair-state-ok {
		border-color: var(--df-c-tint-edge-ok);
		background: var(--df-state-ok-bg);
	}

	.pair-state-expired {
		border-color: var(--df-c-tint-edge-warn);
		background: var(--df-state-warn-bg);
	}

	.pair-state-mark {
		display: grid;
		place-items: center;
		width: 30px;
		height: 30px;
		flex: none;
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-sm);
		background: var(--df-surface-card);
		color: var(--df-state-ok-ink);
	}

	.pair-state-mascot {
		flex: none;
		align-self: center;
		margin: calc(var(--df-p-space-1) * -1) 0;
	}

	.pair-state-expired .pair-state-mark {
		color: var(--df-state-warn-ink);
	}

	.pair-state-body {
		display: flex;
		flex-direction: column;
		gap: var(--df-p-space-2);
		min-width: 0;
	}

	.pair-state-body h3 {
		font-family: var(--df-font-display);
		font-size: var(--df-p-text-md);
		font-weight: 700;
		overflow-wrap: anywhere;
	}

	.pair-id {
		font-size: var(--df-p-text-xs);
		color: var(--df-text-meta);
		overflow-wrap: anywhere;
	}

	.mint-result {
		margin-top: var(--df-p-space-4);
		padding: var(--df-p-space-4);
		border: 1px solid color-mix(in srgb, var(--df-accent-text) 30%, var(--df-border-hairline));
		border-radius: var(--df-p-radius-md);
		background: var(--df-surface-well);
	}

	.mint-result-head {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: var(--df-p-space-3);
		flex-wrap: wrap;
	}

	.mint-expiry {
		font-size: var(--df-p-text-xs);
		color: var(--df-text-meta);
	}

	.mint-result-body {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: var(--df-p-space-5);
		align-items: start;
		margin-top: var(--df-p-space-3);
	}

	.mint-credential {
		display: flex;
		flex-direction: column;
		gap: var(--df-p-space-3);
		min-width: 0;
	}

	.mint-qr {
		display: flex;
		justify-content: center;
	}

	.code-line {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-3);
		flex-wrap: wrap;
	}

	.pair-code {
		flex: 1;
		min-width: 0;
		padding: var(--df-p-space-2) var(--df-p-space-3);
		border: 1px solid var(--df-border-control);
		border-radius: var(--df-p-radius-sm);
		background: var(--df-surface-card);
		font-family: var(--df-p-font-mono);
		font-size: var(--df-p-text-xl);
		font-weight: 500;
		letter-spacing: 0.16em;
		line-height: 1.3;
		overflow-wrap: anywhere;
		user-select: all;
	}

	.deep-link {
		margin-bottom: var(--df-p-space-3);
	}

	/* ---------- fleet ---------- */

	.fleet-card {
		padding: 0;
	}

	.fleet-card-head {
		display: flex;
		align-items: baseline;
		gap: var(--df-p-space-3);
		flex-wrap: wrap;
		padding: var(--df-p-space-4) var(--df-p-space-5);
	}

	.fleet-count {
		font-size: var(--df-p-text-xs);
		color: var(--df-text-meta);
	}

	.fleet-checking {
		display: inline-flex;
		align-items: center;
		gap: var(--df-p-space-1);
		font-size: var(--df-p-text-xs);
		color: var(--df-text-meta);
	}

	/* ---------- show archived ---------- */

	/* A view switch, not a filter chip: it changes what the gateway is asked for.
	   The 1px input stays in the tab order; the label is the target. */
	.archived-toggle {
		display: inline-flex;
		align-items: center;
		gap: var(--df-p-space-2);
		margin-left: auto;
		min-height: 32px;
		padding: 0 var(--df-p-space-1);
		border-radius: var(--df-p-radius-sm);
		color: var(--df-text-secondary);
		font-size: var(--df-p-text-sm);
		line-height: 1;
		cursor: pointer;
		user-select: none;
	}

	.archived-toggle input {
		position: absolute;
		width: 1px;
		height: 1px;
		margin: 0;
		padding: 0;
		opacity: 0;
		pointer-events: none;
	}

	.archived-toggle:has(input:focus-visible) {
		outline: 2px solid var(--df-accent-text);
		outline-offset: 2px;
	}

	.toggle-track {
		position: relative;
		display: inline-block;
		width: 34px;
		height: 20px;
		flex: none;
		border: 1px solid var(--df-border-control);
		border-radius: var(--df-p-radius-pill);
		background: var(--df-surface-well);
		transition:
			background-color var(--df-p-dur-lift) ease,
			border-color var(--df-p-dur-lift) ease;
	}

	.toggle-thumb {
		position: absolute;
		top: 2px;
		left: 2px;
		width: 14px;
		height: 14px;
		border-radius: 50%;
		background: var(--df-text-meta);
		transition:
			transform var(--df-p-dur-lift) ease,
			background-color var(--df-p-dur-lift) ease;
	}

	.archived-toggle:hover .toggle-track {
		border-color: var(--df-text-meta);
	}

	.archived-toggle input:checked + .toggle-track {
		background: var(--df-accent-fill);
		border-color: transparent;
	}

	.archived-toggle input:checked + .toggle-track .toggle-thumb {
		background: var(--df-text-on-accent);
		transform: translateX(14px);
	}

	.archived-toggle input:checked ~ .toggle-text {
		color: var(--df-text-primary);
	}

	.toggle-text {
		white-space: nowrap;
	}

	.toggle-count {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 18px;
		height: 18px;
		padding: 0 5px;
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-pill);
		background: var(--df-surface-well);
		color: var(--df-text-meta);
		font-size: var(--df-p-text-2xs);
		line-height: 1;
	}

	.fleet-none {
		padding: var(--df-p-space-5);
		font-size: var(--df-p-text-sm);
		line-height: 1.6;
		color: var(--df-text-secondary);
	}

	.fleet-none strong {
		font-weight: 600;
		color: var(--df-text-primary);
	}

	.fleet {
		--fleet-cols:
			minmax(0, 2.2fr) minmax(118px, 0.9fr) minmax(116px, 1fr) minmax(104px, 0.8fr)
			84px minmax(150px, auto);
	}

	.fleet-head,
	.fleet-row {
		display: grid;
		grid-template-columns: var(--fleet-cols);
		gap: var(--df-p-space-3);
		align-items: center;
	}

	/* Sticky below the shell header: two sticky siblings at top: 0 would overlap. */
	.fleet-head {
		position: sticky;
		top: var(--df-c-shell-header);
		z-index: 2;
		padding: var(--df-p-space-2) var(--df-p-space-5);
		background: var(--df-surface-well);
		border-top: 1px solid var(--df-border-hairline);
		border-bottom: 1px solid var(--df-border-hairline);
		font-family: var(--df-p-font-mono);
		font-size: var(--df-p-text-2xs);
		font-weight: 500;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--df-text-meta);
	}

	.fleet-rows {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.fleet-row {
		padding: var(--df-p-space-3) var(--df-p-space-5);
		border-bottom: 1px solid var(--df-border-hairline);
		transition: background-color var(--df-p-dur-lift) ease;
	}

	.fleet-rows .fleet-row:last-child {
		border-bottom: 0;
	}

	.fleet-row:hover {
		background: var(--df-surface-hover);
	}

	/* Quieter, not disabled: the row still opens, still rotates, still revokes.
	   Only the name loses its ink, and the chip says why. */
	.fleet-row.is-archived {
		background: color-mix(in srgb, var(--df-surface-well) 50%, transparent);
	}

	.fleet-row.is-archived .device-name {
		color: var(--df-text-secondary);
		font-weight: 500;
	}

	.archived-mark {
		display: inline-flex;
		min-width: 0;
	}

	.cell-device {
		display: flex;
		align-items: flex-end;
		gap: var(--df-p-space-1);
		min-width: 0;
	}

	.device-open {
		display: inline-flex;
		flex: 0 1 auto;
		align-items: center;
		gap: var(--df-p-space-1);
		min-width: 0;
		max-width: 100%;
		padding: 0;
		border: 0;
		border-radius: var(--df-p-radius-xs);
		background: none;
		color: var(--df-text-primary);
		text-align: left;
	}

	.device-go {
		margin-left: 3px;
		font-family: var(--df-p-font-mono);
		color: var(--df-text-meta);
		transition: transform var(--df-p-dur-lift) ease;
	}

	.device-open:hover .device-go {
		transform: translateX(1px);
	}

	.device-open:hover .device-id {
		color: var(--df-accent-text);
		text-decoration: underline;
		text-underline-offset: 3px;
	}

	.device-label {
		display: flex;
		flex-direction: column;
		gap: 1px;
		min-width: 0;
	}

	.device-name {
		font-size: var(--df-p-text-md);
		font-weight: 600;
		line-height: 1.3;
		overflow-wrap: anywhere;
	}

	.device-id {
		font-size: var(--df-p-text-xs);
		color: var(--df-text-meta);
		overflow-wrap: anywhere;
	}

	.cell-state {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.cell-note {
		font-size: var(--df-p-text-2xs);
		color: var(--df-state-warn-ink);
	}

	.cell-seen,
	.cell-paired {
		display: flex;
		flex-direction: column;
		gap: 1px;
		min-width: 0;
	}

	.cell-main {
		font-size: var(--df-p-text-base);
		font-weight: 500;
		color: var(--df-text-primary);
		white-space: nowrap;
	}

	.cell-sub {
		font-size: var(--df-p-text-2xs);
		color: var(--df-text-meta);
		white-space: nowrap;
	}

	/* The column head is the label on a wide screen, but it is aria-hidden so a
	   row still reads on its own. The same key is clipped here and shown below
	   860px, where the head is gone. */
	.cell-key {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
		font-family: var(--df-p-font-mono);
		font-size: var(--df-p-text-2xs);
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--df-text-meta);
	}

	.cell-wake {
		display: flex;
		align-items: center;
		min-width: 0;
	}

	.cell-actions {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-1);
		justify-content: flex-end;
		flex-wrap: wrap;
	}

	.fleet-note {
		padding: var(--df-p-space-3) var(--df-p-space-5);
		border-top: 1px solid var(--df-border-hairline);
		background: var(--df-surface-well);
		border-radius: 0 0 var(--df-c-card-radius) var(--df-c-card-radius);
		font-size: var(--df-p-text-xs);
		line-height: 1.6;
		color: var(--df-text-meta);
	}

	.fleet-note strong {
		font-weight: 600;
		color: var(--df-text-secondary);
	}

	.fleet-skeletons {
		display: grid;
		gap: var(--df-p-space-2);
		padding: 0 var(--df-p-space-5) var(--df-p-space-5);
	}

	@media (max-width: 1100px) {
		.fleet-card-head,
		.fleet-head,
		.fleet-row,
		.fleet-note,
		.fleet-skeletons {
			padding-inline: var(--df-p-space-4);
		}
	}

	@media (max-width: 860px) {
		.fleet-head {
			display: none;
		}

		.fleet-row {
			grid-template-columns: minmax(0, 1fr) auto;
			grid-template-areas:
				'device device'
				'state wake'
				'seen seen'
				'paired paired'
				'actions actions';
			row-gap: var(--df-p-space-2);
			padding-block: var(--df-p-space-3);
		}

		.cell-device {
			grid-area: device;
		}

		/* The row opens the detail; the name is the target, so it meets the
		   44px touch floor rather than being a 15px line. */
		.device-open {
			min-height: 44px;
			align-items: center;
		}

		.cell-state {
			grid-area: state;
			align-items: flex-start;
		}

		.cell-seen {
			grid-area: seen;
		}

		.cell-paired {
			grid-area: paired;
		}

		.cell-wake {
			grid-area: wake;
			justify-content: flex-end;
			align-self: start;
		}

		.cell-actions {
			grid-area: actions;
			justify-content: flex-start;
			padding-top: var(--df-p-space-1);
		}

		.cell-key {
			position: static;
			width: auto;
			height: auto;
			padding: 0;
			margin: 0;
			overflow: visible;
			clip: auto;
			min-width: 68px;
		}

		/* The head is gone, so the two dated cells become labelled lines rather
		   than three-line stacks. */
		.cell-seen,
		.cell-paired {
			flex-direction: row;
			align-items: baseline;
			gap: var(--df-p-space-1);
			flex-wrap: wrap;
		}

		.cell-seen .cell-main,
		.cell-paired .cell-main {
			font-size: var(--df-p-text-sm);
		}
	}

	@media (max-width: 720px) {
		.fleet-card-head {
			padding-block: var(--df-p-space-3);
		}

		/* The switch takes its own line under the title rather than squeezing it. */
		.archived-toggle {
			flex-basis: 100%;
			margin-left: 0;
		}
	}

	/* 48dp of target on a touch screen; the desktop row keeps its 32px density. */
	@media (pointer: coarse), (max-width: 720px) {
		.archived-toggle {
			min-height: 48px;
		}

		/* Every row action grows together, so one 48px button cannot sit beside a
		   36px one and read as the odd one out. */
		.cell-actions .btn {
			min-height: 48px;
		}
	}

	@media (max-width: 760px) {
		.mint-result-body {
			grid-template-columns: minmax(0, 1fr);
			gap: var(--df-p-space-4);
		}

		.mint-qr {
			justify-content: flex-start;
			padding-top: 2px;
		}
	}

	.span-1 {
		min-width: 0;
	}

	@media (prefers-reduced-motion: reduce) {
		.fleet-row,
		.device-go {
			transition: none;
		}

		.device-open:hover .device-go {
			transform: none;
		}

		.toggle-track,
		.toggle-thumb {
			transition: none;
		}
	}
</style>
