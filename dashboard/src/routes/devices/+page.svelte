<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { page } from '$app/state';
	import { describeError, getDevices, getDeviceStatus, mintPairingCode, revokeDevice } from '$lib/api';
	import type { Device, DeviceStatus, PairingCode } from '$lib/types';
	import { formatAbsolute, formatClock, formatDate, formatDuration } from '$lib/format';
	import Badge from '$lib/components/Badge.svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import CopyButton from '$lib/components/CopyButton.svelte';
	import DeviceDetail from '$lib/components/DeviceDetail.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import Notice from '$lib/components/Notice.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
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

	let mintOpen = $state(false);
	let purpose = $state<'enroll' | 'rotate'>('enroll');
	let ttl = $state(900_000);
	let scope = $state('');
	let minting = $state(false);
	let mintError = $state<string | null>(null);
	let minted = $state<PairingCode | null>(null);
	let origin = $state('');

	let revokeTarget = $state<Device | null>(null);
	let revoking = $state(false);
	let revokeError = $state<string | null>(null);
	let revokedNotice = $state<string | null>(null);

	let detailOpen = $state(false);
	let detailId = $state('');

	const detailDevice = $derived(
		devices.find((device) => device.device_id === detailId) ?? null
	);

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

	const selectedScope = $derived(devices.find((device) => device.device_id === scope) ?? null);

	// The rotate picker borrows the shared scope error, and gains a hint only when
	// there is nothing to pick. Build the reference list so neither goes dangling.
	const scopeSelectDescribedBy = $derived(
		[devices.length === 0 ? 'scope-select-hint' : null, scopeError ? 'scope-error' : null]
			.filter(Boolean)
			.join(' ') || undefined
	);

	async function load() {
		if (devices.length > 0) refreshing = true;
		else loading = true;
		error = null;
		try {
			devices = await getDevices();
			void loadStatuses(devices);
		} catch (failure) {
			error = describeError(failure);
		} finally {
			loading = false;
			refreshing = false;
		}
	}

	async function loadStatuses(list: Device[]) {
		if (list.length === 0) {
			statuses = {};
			return;
		}
		statusesLoading = true;
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
		statusesLoading = false;
	}

	async function openMint(
		nextPurpose: 'enroll' | 'rotate' = 'enroll',
		deviceId = '',
		scroll = true
	) {
		mintOpen = true;
		purpose = nextPurpose;
		scope = deviceId;
		mintError = null;
		minted = null;
		if (scroll) {
			await tick();
			const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
			document
				.getElementById('mint-panel')
				?.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
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
		devices = devices.filter((device) => device.device_id !== id);
		revokedNotice = `Revoked ${id}. Its key no longer authenticates.`;
		detailOpen = false;
		syncDetailUrl(null);
	}

	async function mint() {
		if (minting || scopeError) return;
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
			revokedNotice = `Revoked ${target.device_id}. Its key no longer authenticates.`;
			revokeTarget = null;
		} catch (failure) {
			revokeError = describeError(failure);
		} finally {
			revoking = false;
		}
	}

	onMount(() => {
		origin = window.location.origin;
		const requestedPurpose = page.url.searchParams.get('mint');
		const requestedDevice = page.url.searchParams.get('device') ?? '';
		void (async () => {
			await load();
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
	});
</script>

<svelte:head>
	<title>Devices · DakFlare</title>
</svelte:head>

<div class="page">
	<PageHeader
		eyebrow="Fleet"
		title="Paired devices"
		description="Every phone registered with this gateway, its live link state, and whether it holds a push token."
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

	<div class="stack">
		{#if revokedNotice}
			<div aria-live="polite">
				<Notice tone="ok" title="Device revoked">{revokedNotice}</Notice>
			</div>
		{/if}

		{#if mintOpen}
			<section class="panel mint-panel" id="mint-panel" aria-labelledby="mint-heading">
				<div class="panel-head">
					<h2 id="mint-heading" class="panel-title"><Icon name="key" size={14} /> Mint pairing code</h2>
					<button
						type="button"
						class="btn btn-ghost btn-icon btn-sm"
						onclick={() => (mintOpen = false)}
						aria-label="Close pairing form"
					>
						<Icon name="x" size={14} />
					</button>
				</div>
				<div class="panel-body">
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
										<option value={device.device_id}>{device.device_id}</option>
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

						<p class="hint span-3">
							{#if purpose === 'rotate'}
								Rotation replaces the key of an existing device and evicts the previous holder
								immediately. The old phone stops authenticating.
							{:else}
								An enrollment code registers a device that is not yet paired. It cannot take over an
								existing device id.
							{/if}
						</p>

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
							<button type="button" class="btn btn-ghost" onclick={() => (mintOpen = false)}>
								Close
							</button>
						</div>
					</form>

					{#if mintError}
						<div class="mint-feedback" aria-live="assertive">
							<Notice tone="danger" title="Could not mint a code">{mintError}</Notice>
						</div>
					{/if}

					{#if minted}
						<div class="mint-feedback" aria-live="polite">
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
						</div>
					{/if}
				</div>
			</section>
		{/if}

		{#if error}
			<section class="panel">
				<div class="panel-body stack">
					<Notice tone="danger" title="Could not load devices">{error}</Notice>
					<div class="row">
						<button type="button" class="btn btn-primary" onclick={() => void load()}>
							<Icon name="refresh" size={14} /> Try again
						</button>
					</div>
				</div>
			</section>
		{:else if loading}
			<section class="panel" aria-busy="true" aria-live="polite">
				<span class="sr-only">Loading devices</span>
				<div class="panel-head"><h2 class="panel-title">Fleet</h2></div>
				<div class="loading-rows">
					{#each ['a', 'b', 'c'] as key (key)}
						<div class="skeleton" style="height: 46px"></div>
					{/each}
				</div>
			</section>
		{:else if devices.length === 0}
			<section class="panel">
				<EmptyState
					icon="smartphone"
					title="No devices paired yet"
					description="Mint a single-use pairing code and open it on the phone. The first device that redeems it joins the fleet."
				>
					<button type="button" class="btn btn-primary" onclick={() => void openMint('enroll')}>
						<Icon name="key" size={14} /> Mint a pairing code
					</button>
				</EmptyState>
			</section>
		{:else}
			<section class="panel">
				<div class="panel-head">
					<h2 class="panel-title"><Icon name="smartphone" size={14} /> Fleet</h2>
					<span class="panel-meta">
						{devices.length} device{devices.length === 1 ? '' : 's'}
						{#if statusesLoading}<span class="status-loading"> · checking links</span>{/if}
					</span>
				</div>
				<div class="table-scroll desktop-only">
					<table class="table fleet-table">
						<caption class="sr-only">Paired devices and their link state</caption>
						<thead>
							<tr>
								<th scope="col">Device</th>
								<th scope="col">Link</th>
								<th scope="col">Last seen</th>
								<th scope="col">Paired</th>
								<th scope="col">FCM</th>
								<th scope="col"><span class="sr-only">Actions</span></th>
							</tr>
						</thead>
						<tbody>
							{#each devices as device (device.device_id)}
								{@const status = statuses[device.device_id]}
								{@const known = device.device_id in statuses}
								<tr>
									<td>
										<div class="device-cell">
											<button
												type="button"
												class="device-open"
												onclick={() => openDetail(device.device_id)}
												aria-label={`Open details for ${device.device_id}`}
												title="Open device details"
											>
												<span class="mono device-id">{device.device_id}</span>
											</button>
											<CopyButton value={device.device_id} label="Copy device id" iconOnly />
										</div>
									</td>
									<td>
										{#if !known}
											<span class="muted mono">—</span>
										{:else if status}
											<span class="link-state">
												<span
													class="dot {status.ws_connected ? 'dot-ok dot-pulse' : ''}"
													aria-hidden="true"
												></span>
												{status.ws_connected ? 'live' : 'idle'}
											</span>
											<span class="cell-sub mono">queue {status.queue_depth}</span>
										{:else}
											<span class="link-state"><span class="dot" aria-hidden="true"></span>unknown</span>
											<span class="cell-sub">status unavailable</span>
										{/if}
									</td>
									<td>
										<span class="cell-main"><RelativeTime value={device.last_seen} /></span>
										<span class="cell-sub">{formatAbsolute(device.last_seen)}</span>
									</td>
									<td>
										<span class="cell-main">{formatDate(device.paired_at)}</span>
										<span class="cell-sub">{formatClock(device.paired_at)}</span>
									</td>
									<td>
										{#if device.fcm_token}
											<Badge tone="ok" dot>token</Badge>
										{:else}
											<Badge tone="muted">none</Badge>
										{/if}
									</td>
									<td>
										<div class="cell-actions">
											<button
												type="button"
												class="btn btn-ghost btn-sm"
												onclick={() => void startRotate(device)}
												aria-label={`Rotate key for ${device.device_id}`}
											>
												<Icon name="key" size={12} /> Rotate
											</button>
											<button
												type="button"
												class="btn btn-danger btn-sm"
												onclick={() => {
													revokeError = null;
													revokeTarget = device;
												}}
												aria-label={`Revoke ${device.device_id}`}
											>
												<Icon name="trash" size={12} /> Revoke
											</button>
										</div>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>

				<ul class="device-cards">
					{#each devices as device (device.device_id)}
						{@const status = statuses[device.device_id]}
						{@const known = device.device_id in statuses}
						<li class="device-card">
							<div class="card-head">
								<button
									type="button"
									class="device-open"
									onclick={() => openDetail(device.device_id)}
									aria-label={`Open details for ${device.device_id}`}
									title="Open device details"
								>
									<span class="mono device-id">{device.device_id}</span>
								</button>
								<CopyButton value={device.device_id} label="Copy device id" iconOnly />
							</div>
							<div class="card-status">
								{#if !known}
									<span class="mono muted">status unknown</span>
								{:else if status}
									<span class="link-state">
										<span
											class="dot {status.ws_connected ? 'dot-ok dot-pulse' : ''}"
											aria-hidden="true"
										></span>
										{status.ws_connected ? 'live' : 'idle'}
									</span>
									<span class="mono muted">queue {status.queue_depth}</span>
								{:else}
									<span class="link-state"><span class="dot" aria-hidden="true"></span>unknown</span>
								{/if}
								<span class="spacer"></span>
								{#if device.fcm_token}
									<Badge tone="ok" dot>push token</Badge>
								{:else}
									<Badge tone="muted">no push token</Badge>
								{/if}
							</div>
							<dl class="card-kv">
								<div>
									<dt>Last seen</dt>
									<dd>
										<RelativeTime value={device.last_seen} />
										<span class="muted"> · {formatAbsolute(device.last_seen)}</span>
									</dd>
								</div>
								<div>
									<dt>Paired</dt>
									<dd>{formatDate(device.paired_at)} · {formatClock(device.paired_at)}</dd>
								</div>
							</dl>
							<div class="card-actions">
								<button
									type="button"
									class="btn btn-sm"
									onclick={() => openDetail(device.device_id)}
									aria-label={`Open details for ${device.device_id}`}
								>
									<Icon name="info" size={12} /> Details
								</button>
								<button
									type="button"
									class="btn btn-sm"
									onclick={() => void startRotate(device)}
									aria-label={`Rotate key for ${device.device_id}`}
								>
									<Icon name="key" size={12} /> Rotate key
								</button>
								<button
									type="button"
									class="btn btn-danger btn-sm"
									onclick={() => {
										revokeError = null;
										revokeTarget = device;
									}}
									aria-label={`Revoke ${device.device_id}`}
								>
									<Icon name="trash" size={12} /> Revoke
								</button>
							</div>
						</li>
					{/each}
				</ul>
				<p class="panel-note">
					Select a device id to open its detail panel. Revocation destroys the device's stored
					public key in its Durable Object and removes it from D1; a revoked device must be
					enrolled again.
				</p>
			</section>
		{/if}
	</div>
</div>

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
			<span class="mono">{revokeTarget.device_id}</span> will stop authenticating immediately. Its
			public key is destroyed in both stores and any queued command is abandoned.
		</p>
		<p class="hint" style="margin-top: 10px">
			To restore it, enroll the phone again with a new pairing code.
		</p>
	{/if}
</ConfirmDialog>

<DeviceDetail
	open={detailOpen}
	deviceId={detailId}
	device={detailDevice}
	onclose={closeDetail}
	onrevoked={handleRevoked}
	onmint={(id) => void mintForDevice(id)}
/>

<style>
	.mint-panel {
		border-color: color-mix(in srgb, var(--accent) 30%, var(--line));
		scroll-margin-top: 16px;
	}

	@media (max-width: 900px) {
		.mint-panel {
			scroll-margin-top: 128px;
		}
	}

	.mint-feedback {
		margin-top: var(--s-4);
	}

	.mint-result {
		margin-top: var(--s-4);
		padding: var(--s-4);
		border: 1px dashed color-mix(in srgb, var(--accent) 38%, var(--line));
		border-radius: var(--r-sm);
		background: color-mix(in srgb, var(--accent) 5%, var(--surface));
	}

	.mint-result-head {
		display: flex;
		justify-content: space-between;
		align-items: baseline;
		gap: var(--s-3);
		flex-wrap: wrap;
	}

	.mint-expiry {
		font-size: 10.5px;
		color: var(--ink-3);
	}

	.mint-result-body {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: var(--s-5);
		align-items: start;
		margin-top: var(--s-3);
	}

	.mint-credential {
		display: flex;
		flex-direction: column;
		gap: var(--s-3);
		min-width: 0;
	}

	.mint-credential .code-line {
		margin-top: 0;
	}

	.mint-credential .deep-link {
		margin-bottom: 0;
	}

	.mint-qr {
		display: flex;
		justify-content: center;
	}

	@media (max-width: 760px) {
		.mint-result-body {
			grid-template-columns: minmax(0, 1fr);
			gap: var(--s-4);
		}

		.mint-qr {
			justify-content: flex-start;
			padding-top: 2px;
		}
	}

	.code-line {
		display: flex;
		align-items: center;
		gap: var(--s-3);
		flex-wrap: wrap;
		margin: var(--s-3) 0;
	}

	.pair-code {
		flex: 1;
		min-width: 0;
		padding: 8px 12px;
		border: 1px solid var(--line);
		border-radius: var(--r-sm);
		background: var(--surface);
		font-family: var(--font-mono);
		font-size: 1.5rem;
		font-weight: 500;
		letter-spacing: 0.16em;
		line-height: 1.3;
		overflow-wrap: anywhere;
		user-select: all;
	}

	.deep-link {
		margin-bottom: var(--s-3);
	}

	.device-cell {
		display: flex;
		align-items: center;
		gap: 4px;
	}

	.device-open {
		display: inline-flex;
		flex: 1;
		align-items: center;
		gap: 5px;
		min-width: 0;
		padding: 0;
		border: 0;
		background: none;
		color: var(--ink);
		text-align: left;
		border-radius: 2px;
	}

	.device-open::after {
		content: '›';
		font-family: var(--font-mono);
		font-size: 13px;
		line-height: 1;
		color: var(--ink-3);
		opacity: 0.55;
		transition:
			color 140ms ease,
			transform 140ms ease,
			opacity 140ms ease;
	}

	.device-open:hover::after {
		color: var(--accent);
		opacity: 1;
		transform: translateX(1px);
	}

	.device-open:hover .device-id {
		color: var(--accent);
		text-decoration: underline;
		text-underline-offset: 3px;
	}

	.device-id {
		font-size: var(--text-sm);
		overflow-wrap: anywhere;
	}

	.link-state {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		font-family: var(--font-mono);
		font-size: 10.5px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--ink-2);
	}

	.status-loading {
		color: var(--ink-3);
	}

	.loading-rows {
		display: grid;
		gap: var(--s-2);
		padding: var(--s-4);
	}

	.fleet-table {
		min-width: 860px;
		table-layout: fixed;
	}

	.fleet-table th:nth-child(1) {
		width: 27%;
	}

	.fleet-table th:nth-child(2) {
		width: 10%;
	}

	.fleet-table th:nth-child(3) {
		width: 20%;
	}

	.fleet-table th:nth-child(4) {
		width: 16%;
	}

	.fleet-table th:nth-child(5) {
		width: 9%;
	}

	.fleet-table th:nth-child(6) {
		width: 18%;
	}

	.device-cards {
		display: none;
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.device-card {
		padding: var(--s-4);
		border-bottom: 1px solid var(--line);
	}

	.device-card:last-child {
		border-bottom: 0;
	}

	.card-head {
		display: flex;
		align-items: flex-start;
		gap: 4px;
	}

	.card-status {
		display: flex;
		align-items: center;
		gap: var(--s-3);
		flex-wrap: wrap;
		margin-top: var(--s-2);
	}

	.card-kv {
		display: grid;
		gap: 3px;
		margin: var(--s-3) 0 0;
		font-size: 11.5px;
	}

	.card-kv > div {
		display: grid;
		grid-template-columns: 66px minmax(0, 1fr);
		gap: var(--s-2);
	}

	.card-kv dt {
		font-family: var(--font-mono);
		font-size: 9.5px;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--ink-3);
		padding-top: 2px;
	}

	.card-kv dd {
		margin: 0;
		color: var(--ink-2);
	}

	.card-actions {
		display: flex;
		gap: var(--s-2);
		margin-top: var(--s-3);
		flex-wrap: wrap;
	}

	@media (max-width: 820px) {
		.desktop-only {
			display: none;
		}

		.device-cards {
			display: block;
		}
	}

	.span-1 {
		min-width: 0;
	}
</style>
