<script lang="ts">
	import { AlertDialog } from 'bits-ui';
	import Notice from '$lib/components/Notice.svelte';
	import { app } from '$lib/stores/app.svelte';
	import { relativeTime } from '$lib/device-state';

	let baseUrl = $state('');
	let adminToken = $state('');

	let label = $state('');
	let platformId = $state('');
	let carrier = $state('');
	let simSlot = $state(0);

	let codeDeviceId = $state('');
	let codeInput = $state('');

	// The stored target may arrive after boot; keep the field in step without
	// overwriting what the operator is typing.
	$effect(() => {
		baseUrl = app.target.base_url ?? '';
	});

	$effect(() => {
		if (!app.devices.some((device) => device.device_id === codeDeviceId)) {
			codeDeviceId = app.selectedId || app.devices[0]?.device_id || '';
		}
	});

	const canPair = $derived(
		Boolean(codeDeviceId) && codeInput.trim().length > 0 && !app.busy.pair
	);

	async function saveTarget(event: SubmitEvent) {
		event.preventDefault();
		const saved = await app.saveTarget(baseUrl, adminToken);
		if (saved) adminToken = '';
	}

	async function pairWithCode(event: SubmitEvent) {
		event.preventDefault();
		const paired = await app.pairWithCode(codeDeviceId, codeInput);
		// The code is spent; leaving it in the field invites a confusing retry.
		if (paired) codeInput = '';
	}

	async function createIdentity(event: SubmitEvent) {
		event.preventDefault();
		const created = await app.createDevice({ label, platformId, carrier, simSlot });
		if (created) {
			label = '';
			platformId = '';
		}
	}

</script>

<svelte:head>
	<title>Settings · DakFlare</title>
</svelte:head>

<section class="screen">
	<header class="screen-head">
		<div>
			<p class="eyebrow">Configuration</p>
			<h1>Settings</h1>
			<p class="screen-meta">
				{app.schemaVersion === null ? 'local schema' : `local schema v${app.schemaVersion}`}
			</p>
		</div>
		<span class="pill" data-state={app.configured ? 'live' : 'unknown'}>
			{app.configured ? 'target set' : 'no target'}
		</span>
	</header>

	<section class="sheet" aria-labelledby="target-title">
		<div class="sheet-head">
			<h2 class="sheet-title" id="target-title">Target deployment</h2>
			<span class="pill" data-state={app.configured ? 'live' : 'unknown'}>
				{app.configured ? app.target.base_url : 'not configured'}
			</span>
		</div>

		<form onsubmit={saveTarget}>
			<div class="field">
				<label for="base-url">Worker URL</label>
				<input
					id="base-url"
					bind:value={baseUrl}
					placeholder="https://dakflare-worker.<account>.workers.dev"
					autocomplete="off"
					spellcheck="false"
					disabled={!app.backendAvailable}
				/>
			</div>
			<p class="note">
				A pairing link sets this for you. Enter it by hand only when you are typing a bare code.
			</p>

			<details class="advanced">
				<summary>Admin overrides (lab)</summary>
				<p>
					Not needed to pair. These credentials are only for self-pair, purge and revoke on a
					lab deployment.
				</p>
				<div class="field">
					<label for="admin-token">
						Admin token {app.target.has_admin_token ? '(stored)' : '(not stored)'}
					</label>
					<input
						id="admin-token"
						type="password"
						bind:value={adminToken}
						placeholder={app.target.has_admin_token ? 'leave blank to keep' : 'ADMIN_TOKEN'}
						autocomplete="off"
						disabled={!app.backendAvailable}
					/>
					<small>Stored in this app's local database. It is never sent when pairing with a code.</small>
				</div>
			</details>

			<div class="form-actions">
				<button class="btn" type="submit" disabled={!app.backendAvailable || app.busy.target}>
					{app.busy.target ? 'Saving…' : 'Save target'}
				</button>
			</div>
			<Notice scope="target" />
		</form>
	</section>

	<section class="sheet" aria-labelledby="pair-title">
		<h2 class="sheet-title" id="pair-title">Pair with code</h2>
		<p class="note">
			The operator mints a one-time code in the dashboard. Paste the code — or the whole
			<code>dakflare://pair?u=…&amp;c=…</code> link, whose worker URL is saved as the target first.
			No admin token is needed.
		</p>

		<form onsubmit={pairWithCode}>
			<div class="field">
				<label for="pair-device">Device</label>
				<select id="pair-device" bind:value={codeDeviceId} disabled={app.devices.length === 0}>
					{#if app.devices.length === 0}
						<option value="">No device identity</option>
					{/if}
					{#each app.devices as device (device.device_id)}
						<option value={device.device_id}>{device.label} · {device.device_id}</option>
					{/each}
				</select>
			</div>
			<div class="field">
				<label for="pair-code">Code or link</label>
				<input
					id="pair-code"
					bind:value={codeInput}
					placeholder="AB12CD34EF56 or dakflare://pair?u=…&c=…"
					autocomplete="off"
					spellcheck="false"
					disabled={!app.backendAvailable || app.devices.length === 0}
				/>
			</div>
			<p class="note">
				Single-use and short-lived. If it fails, mint a fresh code and retry.
			</p>
			<div class="form-actions">
				<button class="btn primary" type="submit" disabled={!app.backendAvailable || !canPair}>
					{app.busy.pair ? 'Pairing…' : 'Pair with code'}
				</button>
			</div>
			<Notice scope="pair" />
		</form>
	</section>

	<section class="sheet" aria-labelledby="identity-title">
		<h2 class="sheet-title" id="identity-title">Device identity</h2>
		<p class="note">
			This creates a real P-256 keypair. The public half registers with the deployment at
			pairing; the private half stays on this device and never leaves it. The carrier and SIM
			slot here belong to the identity; Android's own report is on
			<a class="inline-link" href="/device" data-sveltekit-replacestate>Device</a>.
		</p>

		<form onsubmit={createIdentity}>
			<div class="field">
				<label for="label">Label</label>
				<input id="label" bind:value={label} placeholder="Pixel 8 · reception" autocomplete="off" />
			</div>
			<div class="field">
				<label for="platform-id">
					ANDROID_ID <span class="muted">(hint, optional)</span>
				</label>
				<input id="platform-id" bind:value={platformId} placeholder="a1b2c3d4e5f6" autocomplete="off" />
				<small>Never used to authenticate — only for duplicate detection and support.</small>
			</div>
			<div class="field">
				<label for="carrier">Carrier <span class="muted">(optional)</span></label>
				<input id="carrier" bind:value={carrier} placeholder="Grameenphone" autocomplete="off" />
			</div>
			<div class="field">
				<label for="sim-slot">SIM slot</label>
				<select id="sim-slot" bind:value={simSlot}>
					<option value={0}>0 — default</option>
					<option value={1}>1 — SIM 1</option>
					<option value={2}>2 — SIM 2</option>
				</select>
			</div>
			<div class="form-actions">
				<button class="btn" type="submit" disabled={!app.backendAvailable || app.busy.create}>
					{app.busy.create ? 'Generating…' : 'Create identity'}
				</button>
			</div>
			<Notice scope="identity" />
		</form>
	</section>

	<section class="sheet" aria-labelledby="devices-title">
		<div class="sheet-head">
			<h2 class="sheet-title" id="devices-title">Devices · {app.devices.length}</h2>
			<button
				class="btn small"
				type="button"
				onclick={() => app.reloadDevices()}
				disabled={!app.backendAvailable || app.busy.devices}
			>
				{app.busy.devices ? 'Refreshing…' : 'Refresh'}
			</button>
		</div>

		{#if app.loading.boot}
			<p class="quiet-state">Opening the local database…</p>
		{:else if !app.backendAvailable}
			<p class="quiet-state">The local database is not reachable in this window.</p>
		{:else if app.devices.length === 0}
			<p class="quiet-state">No device identity yet. Create one above, then pair it with a code.</p>
		{:else}
			{#each app.devices as device (device.device_id)}
				<article class="device">
					<div class="device-head">
						<div>
							<strong>{device.label}</strong>
							<div class="device-id" title={device.device_id}>{device.device_id.slice(0, 18)}…</div>
						</div>
						<span class="pill">{device.platform}</span>
					</div>

					<div class="facts">
						<div class="fact"><b>Carrier</b><span>{device.carrier ?? '—'}</span></div>
						<div class="fact"><b>SIM slot</b><span>{device.sim_slot}</span></div>
						<div class="fact"><b>ANDROID_ID</b><span>{device.platform_id ?? '—'}</span></div>
						<div class="fact">
							<b>Pairing</b>
							<span>
								{app.pairedAt[device.device_id]
									? `paired ${relativeTime(app.pairedAt[device.device_id])}`
									: app.contactAt[device.device_id]
										? 'signed contact answered'
										: 'not recorded'}
							</span>
						</div>
						<div class="fact"><b>Created</b><span>{new Date(device.created_at).toLocaleDateString()}</span></div>
					</div>

					<div class="device-actions">
						<button
							class="btn small"
							type="button"
							disabled={!app.configured || app.busy.selfPair}
							title="Mints a code with the stored admin token. Pair with code is the normal path."
							onclick={() => app.selfPair(device.device_id)}
						>
							Self-pair (lab)
						</button>
						<button
							class="btn small"
							type="button"
							disabled={!app.configured || app.busy.purge}
							title="Removes this device's message log on the deployment, not the local thread."
							onclick={() => app.purge(device.device_id)}
						>
							Purge log
						</button>

						<AlertDialog.Root>
							<AlertDialog.Trigger class="btn small danger-ghost">Delete</AlertDialog.Trigger>
							<AlertDialog.Portal>
								<AlertDialog.Overlay class="overlay" />
								<AlertDialog.Content class="dialog" aria-labelledby={`delete-${device.device_id}`}>
									<h3 id={`delete-${device.device_id}`}>Delete {device.label}?</h3>
									<p>
										This removes the local keypair. If the device is paired, revoke it
										first or the deployment will keep trusting the old key.
									</p>
									<div class="row">
										<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
										<AlertDialog.Action
											class="danger"
											onclick={() => app.deleteDevice(device.device_id)}
										>
											Delete device
										</AlertDialog.Action>
									</div>
								</AlertDialog.Content>
							</AlertDialog.Portal>
						</AlertDialog.Root>
					</div>

					<Notice scope={`settings:${device.device_id}`} />
				</article>
			{/each}
			<p class="note">
				Purge log clears the deployment copy only. The local thread is cleared from the
				carrier panel in Flows.
			</p>
		{/if}
		<Notice scope="devices" />
	</section>

	<section class="sheet" aria-labelledby="build-title">
		<h2 class="sheet-title" id="build-title">This build</h2>
		<div class="rows">
			<div class="rowline">
				<span class="label">Local schema</span>
				<span class="value mono">{app.schemaVersion === null ? 'unavailable' : `v${app.schemaVersion}`}</span>
			</div>
			<div class="rowline">
				<span class="label">Backend</span>
				<span class="value mono">{app.backendAvailable ? 'local database' : 'browser preview'}</span>
			</div>
			<div class="rowline">
				<span class="label">Composer</span>
				<span class="value mono muted">next phase</span>
			</div>
		</div>
	</section>
</section>
