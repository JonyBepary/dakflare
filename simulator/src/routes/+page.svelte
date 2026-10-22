<script lang="ts">
	import { onMount } from 'svelte';
	import { invoke } from '@tauri-apps/api/core';
	import { AlertDialog, Switch } from 'bits-ui';

	type Device = {
		device_id: string;
		public_key_spki: string;
		platform: string;
		platform_id: string | null;
		label: string;
		carrier: string | null;
		sim_slot: number;
		created_at: number;
		updated_at: number;
	};

	type TargetView = { base_url: string | null; has_admin_token: boolean };

	let devices = $state<Device[]>([]);
	let loading = $state(true);
	let error = $state('');

	let label = $state('');
	let platformId = $state('');
	let carrier = $state('');
	let simSlot = $state(0);
	let creating = $state(false);

	let target = $state<TargetView>({ base_url: null, has_admin_token: false });
	let baseUrl = $state('');
	let adminToken = $state('');
	let savingTarget = $state(false);
	let targetNotice = $state('');

	let activity = $state<Record<string, string>>({});
	let busy = $state<Record<string, boolean>>({});

	let codeDeviceId = $state('');
	let codeInput = $state('');
	let pairingByCode = $state(false);
	let pairNotice = $state<{ ok: boolean; text: string } | null>(null);

	const configured = $derived(Boolean(target.base_url));
	const canPairByCode = $derived(
		Boolean(codeDeviceId) && codeInput.trim().length > 0 && !pairingByCode
	);

	type Message = {
		id: string;
		device_id: string;
		direction: 'in' | 'out';
		peer: string;
		body: string;
		state: string;
		local_id: string | null;
		created_at: number;
	};

	let carrierDevice = $state('');
	let offline = $state(false);
	let sender = $state('+15550001111');
	let messageBody = $state('CODE 483920');
	let thread = $state<Message[]>([]);
	let carrierBusy = $state(false);
	let carrierNotice = $state('');


	async function refresh() {
		try {
			devices = await invoke<Device[]>('list_devices');
			if (!devices.some((d) => d.device_id === codeDeviceId)) {
				codeDeviceId = devices[0]?.device_id ?? '';
			}
			error = '';
		} catch (e) {
			error = String(e);
		} finally {
			loading = false;
		}
	}

	async function loadTarget() {
		try {
			target = await invoke<TargetView>('get_target');
			baseUrl = target.base_url ?? '';
		} catch (e) {
			error = String(e);
		}
	}

	async function saveTarget(event: SubmitEvent) {
		event.preventDefault();
		savingTarget = true;
		try {
			await invoke('save_target', {
				baseUrl: baseUrl.trim(),
				adminToken: adminToken.trim() || null
			});
			adminToken = '';
			await loadTarget();
			targetNotice = 'Target saved.';
		} catch (e) {
			targetNotice = String(e);
		} finally {
			savingTarget = false;
		}
	}

	async function create(event: SubmitEvent) {
		event.preventDefault();
		if (!label.trim()) {
			error = 'Give the device a label so you can tell them apart.';
			return;
		}
		creating = true;
		try {
			const device = await invoke<Device>('create_device', {
				label: label.trim(),
				platformId: platformId.trim() || null,
				carrier: carrier.trim() || null,
				simSlot: Number(simSlot) || 0
			});
			devices = [device, ...devices];
			label = '';
			platformId = '';
			error = '';
		} catch (e) {
			error = String(e);
		} finally {
			creating = false;
		}
	}

	async function pairWithCode(event: SubmitEvent) {
		event.preventDefault();
		const input = codeInput.trim();
		if (!codeDeviceId || !input) return;

		pairingByCode = true;
		pairNotice = null;
		try {
			const message = await invoke<string>('pair_with_code', {
				deviceId: codeDeviceId,
				code: input
			});
			pairNotice = { ok: true, text: message };
			// The code is spent; leaving it in the field invites a confusing retry.
			codeInput = '';
			// A link may have set the target, so keep the header in sync.
			await loadTarget();
		} catch (e) {
			pairNotice = { ok: false, text: String(e) };
		} finally {
			pairingByCode = false;
		}
	}

	async function act(deviceId: string, name: string, fn: () => Promise<string>) {
		busy[deviceId] = true;
		try {
			activity[deviceId] = await fn();
			error = '';
		} catch (e) {
			activity[deviceId] = String(e);
		} finally {
			busy[deviceId] = false;
		}
		// `name` is only for readability at the call site.
		void name;
	}

	async function remove(deviceId: string) {
		try {
			await invoke<boolean>('delete_device', { deviceId });
			devices = devices.filter((d) => d.device_id !== deviceId);
			delete activity[deviceId];
			error = '';
		} catch (e) {
			error = String(e);
		}
	}

	function when(ms: number) {
		return new Date(ms).toLocaleString();
	}


	async function loadThread() {
		if (!carrierDevice) {
			thread = [];
			return;
		}
		try {
			thread = await invoke<Message[]>('list_messages', {
				deviceId: carrierDevice,
				limit: 100
			});
			offline = await invoke<boolean>('get_offline', { deviceId: carrierDevice });
		} catch (e) {
			carrierNotice = String(e);
		}
	}

	async function toggleOffline(value: boolean) {
		if (!carrierDevice) return;
		try {
			await invoke('set_offline', { deviceId: carrierDevice, offline: value });
			offline = value;
			carrierNotice = value
				? 'Carrier off: messages stay local and nothing is uploaded.'
				: 'Carrier on: injects upload over the signed endpoint.';
		} catch (e) {
			carrierNotice = String(e);
		}
	}

	async function inject() {
		if (!carrierDevice) return;
		carrierBusy = true;
		try {
			const result = await invoke<{
				uploaded: boolean;
				accepted: number;
				duplicates: number;
			}>('carrier_inject', {
				deviceId: carrierDevice,
				sender: sender.trim(),
				body: messageBody
			});
			carrierNotice = result.uploaded
				? `Uploaded · accepted ${result.accepted}, duplicates ${result.duplicates}`
				: 'Recorded locally (carrier off)';
			await loadThread();
		} catch (e) {
			carrierNotice = String(e);
		} finally {
			carrierBusy = false;
		}
	}

	async function drain() {
		if (!carrierDevice) return;
		carrierBusy = true;
		try {
			const captured = await invoke<Message[]>('carrier_drain', {
				deviceId: carrierDevice
			});
			carrierNotice =
				captured.length === 0
					? 'Poll OK · no queued commands'
					: `Poll OK · captured ${captured.length} outbound message(s)`;
			await loadThread();
		} catch (e) {
			carrierNotice = String(e);
		} finally {
			carrierBusy = false;
		}
	}

	async function clearThread() {
		if (!carrierDevice) return;
		try {
			const deleted = await invoke<number>('clear_messages', {
				deviceId: carrierDevice
			});
			carrierNotice = `Cleared ${deleted} local message(s)`;
			await loadThread();
		} catch (e) {
			carrierNotice = String(e);
		}
	}

	onMount(async () => {
		await Promise.all([refresh(), loadTarget()]);
		if (!carrierDevice && devices.length > 0) {
			carrierDevice = devices[0].device_id;
			await loadThread();
		}
	});
</script>

<svelte:head>
	<title>DakFlare device</title>
</svelte:head>

<section class="panel" style="margin-bottom: 16px;">
	<div class="row" style="justify-content: space-between;">
		<h2>Target deployment</h2>
		<span class="pill" style={configured ? 'color: var(--ok)' : ''}>
			{configured ? target.base_url : 'not configured'}
		</span>
	</div>

	<form onsubmit={saveTarget}>
		<div class="field" style="margin-top: 10px; max-width: 540px;">
			<label for="base-url">Worker URL</label>
			<input
				id="base-url"
				bind:value={baseUrl}
				placeholder="https://dakflare-worker.<account>.workers.dev"
				autocomplete="off"
			/>
		</div>
		<div class="row" style="margin-top: 12px; justify-content: space-between;">
			<small style="color: var(--ink-3)">
				A pairing link sets this for you. Enter it by hand only when you are typing a bare
				code.
			</small>
			<button class="primary" type="submit" disabled={savingTarget}>
				{savingTarget ? 'Saving…' : 'Save target'}
			</button>
		</div>

		<details class="advanced">
			<summary>Admin overrides (lab)</summary>
			<p>
				Not needed to pair. These credentials are only for self-pair, purge and revoke on a
				lab deployment.
			</p>
			<div class="field" style="margin-top: 0;">
				<label for="admin-token">
					Admin token {target.has_admin_token ? '(stored)' : '(not stored)'}
				</label>
				<input
					id="admin-token"
					type="password"
					bind:value={adminToken}
					placeholder={target.has_admin_token ? 'leave blank to keep' : 'ADMIN_TOKEN'}
					autocomplete="off"
				/>
				<small>Stored in this app's local database. It is never sent when pairing with a code.</small>
			</div>
		</details>

		{#if targetNotice}
			<p style="margin: 8px 0 0; font-size: 12px; color: var(--ink-3);" aria-live="polite">
				{targetNotice}
			</p>
		{/if}
	</form>
</section>

<section class="panel" style="margin-bottom: 16px;">
	<h2>Pair with code</h2>
	<p style="color: var(--ink-3); font-size: 12px; margin: 6px 0 0;">
		Real onboarding: the operator mints a one-time code in the dashboard. Paste the code — or the
		whole <code>dakflare://pair?u=…&amp;c=…</code> link, whose worker URL is saved as the target first.
		No admin token is needed.
	</p>

	<form onsubmit={pairWithCode}>
		<div class="grid" style="grid-template-columns: 220px minmax(0,1fr); margin-top: 10px;">
			<div class="field" style="margin-top: 0;">
				<label for="pair-device">Device</label>
				<select id="pair-device" bind:value={codeDeviceId} disabled={devices.length === 0}>
					{#each devices as device (device.device_id)}
						<option value={device.device_id}>{device.label} · {device.device_id}</option>
					{/each}
				</select>
			</div>
			<div class="field" style="margin-top: 0;">
				<label for="pair-code">Code or link</label>
				<input
					id="pair-code"
					bind:value={codeInput}
					placeholder="AB12CD34EF56 or dakflare://pair?u=…&c=…"
					autocomplete="off"
					spellcheck="false"
					disabled={devices.length === 0}
				/>
			</div>
		</div>

		<div class="row" style="margin-top: 12px; justify-content: space-between;">
			<small style="color: var(--ink-3)">
				Single-use and short-lived. If it fails, mint a fresh code and retry.
			</small>
			<button class="primary" type="submit" disabled={!canPairByCode}>
				{pairingByCode ? 'Pairing…' : 'Pair with code'}
			</button>
		</div>
	</form>

	{#if pairNotice}
		<div
			class={pairNotice.ok ? 'notice-ok' : 'error'}
			role={pairNotice.ok ? 'status' : 'alert'}
			aria-live="polite"
		>
			{pairNotice.text}
		</div>
	{/if}
</section>

<div class="grid">
	<section class="panel">
		<h2>Device identity</h2>
		<p style="color: var(--ink-3); font-size: 12px; margin: 6px 0 0;">
			This creates a real P-256 keypair. The public half registers with the deployment at
			pairing; the private half stays on this device and never leaves it.
		</p>
		<p style="color: var(--ink-3); font-size: 12px; margin: 4px 0 0;">
			The carrier is simulated until the native SMS layer ships.
		</p>

		<form onsubmit={create}>
			<div class="field">
				<label for="label">Label</label>
				<input id="label" bind:value={label} placeholder="Pixel 8 · reception" autocomplete="off" />
			</div>

			<div class="field">
				<label for="platform-id">ANDROID_ID <span style="color: var(--ink-3)">(hint, optional)</span></label>
				<input id="platform-id" bind:value={platformId} placeholder="a1b2c3d4e5f6" autocomplete="off" />
				<small>Never used to authenticate — only for duplicate detection and support.</small>
			</div>

			<div class="field">
				<label for="carrier">Carrier <span style="color: var(--ink-3)">(optional)</span></label>
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

			<div style="margin-top: 16px;">
				<button class="primary" type="submit" disabled={creating}>
					{creating ? 'Generating…' : 'Create identity'}
				</button>
			</div>
		</form>

		{#if error}
			<div class="error" role="alert">{error}</div>
		{/if}
	</section>

	<section class="panel">
		<div class="row" style="justify-content: space-between;">
			<h2>Devices {loading ? '' : `· ${devices.length}`}</h2>
			<button onclick={refresh} disabled={loading}>Refresh</button>
		</div>
		<p style="color: var(--ink-3); font-size: 12px; margin: 6px 0 0;">
			Pair a phone with a one-time dashboard code above. <strong>Self-pair (lab)</strong> mints a
			code with the stored admin token instead, for a deployment without a console.
		</p>

		{#if loading}
			<p class="empty">Opening the local database…</p>
		{:else if devices.length === 0}
			<p class="empty">
				No device identity yet. Create one to generate a signing key, then pair it with a code.
			</p>
		{:else}
			{#each devices as device (device.device_id)}
				<article class="device">
					<div class="device-head">
						<div>
							<strong>{device.label}</strong>
							<div class="device-id">{device.device_id}</div>
						</div>
						<span class="pill">{device.platform}</span>
					</div>

					<div class="facts">
						<div class="fact"><b>Carrier</b><span>{device.carrier ?? '—'}</span></div>
						<div class="fact"><b>SIM slot</b><span>{device.sim_slot}</span></div>
						<div class="fact"><b>ANDROID_ID</b><span>{device.platform_id ?? '—'}</span></div>
						<div class="fact">
							<b>Public key</b><span>{device.public_key_spki.slice(0, 14)}…</span>
						</div>
						<div class="fact"><b>Created</b><span>{when(device.created_at)}</span></div>
					</div>

					<div class="row" style="margin-top: 12px;">
						<button
							disabled={!configured || busy[device.device_id]}
							title="Mints a code with the stored admin token. Pair with code is the normal path."
							onclick={() =>
								act(device.device_id, 'pair', async () =>
									invoke<string>('pair_device', { deviceId: device.device_id })
								)}
						>
							Self-pair (lab)
						</button>
						<button
							disabled={!configured || busy[device.device_id]}
							onclick={() =>
								act(device.device_id, 'poll', async () => {
									const commands = await invoke<unknown[]>('poll_device', {
										deviceId: device.device_id
									});
									return `Signed poll OK · ${commands.length} command(s)`;
								})}
						>
							Poll
						</button>
						<button
							disabled={!configured || busy[device.device_id]}
							onclick={() =>
								act(device.device_id, 'purge', async () => {
									const deleted = await invoke<number>('purge_messages', {
										deviceId: device.device_id
									});
									return `Purged ${deleted} message(s)`;
								})}
						>
							Purge log
						</button>
						<button
							class="danger"
							disabled={!configured || busy[device.device_id]}
							onclick={() =>
								act(device.device_id, 'revoke', async () => {
									await invoke('revoke_device', { deviceId: device.device_id });
									return 'Revoked on the deployment';
								})}
						>
							Revoke
						</button>

						<span style="flex: 1"></span>

						<AlertDialog.Root>
							<AlertDialog.Trigger class="danger">Delete</AlertDialog.Trigger>
							<AlertDialog.Portal>
								<AlertDialog.Overlay class="overlay" />
								<AlertDialog.Content class="dialog">
									<h3>Delete {device.label}?</h3>
									<p>
										This removes the local keypair. If the device is paired, revoke it
										first or the deployment will keep trusting the old key.
									</p>
									<div class="row">
										<AlertDialog.Cancel>Cancel</AlertDialog.Cancel>
										<AlertDialog.Action
											class="danger"
											onclick={() => remove(device.device_id)}
										>
											Delete device
										</AlertDialog.Action>
									</div>
								</AlertDialog.Content>
							</AlertDialog.Portal>
						</AlertDialog.Root>
					</div>

					{#if activity[device.device_id]}
						<p class="device-id" style="margin: 8px 0 0;" aria-live="polite">
							{activity[device.device_id]}
						</p>
					{/if}
				</article>
			{/each}
		{/if}
	</section>
</div>

<section class="panel" style="margin-top: 16px;">
	<div class="row" style="justify-content: space-between;">
		<h2>Carrier</h2>
		<span class="pill">{offline ? 'offline' : 'online'}</span>
	</div>

	<p style="color: var(--ink-3); font-size: 12px; margin: 6px 0 0;">
		Inbound messages are injected here and outbound commands are captured from the queue; the
		native SMS layer is not wired up yet.
	</p>

	<div class="grid" style="grid-template-columns: 220px minmax(0,1fr); margin-top: 12px;">
		<div class="field" style="margin-top: 0;">
			<label for="carrier-device">Device</label>
			<select id="carrier-device" bind:value={carrierDevice} onchange={loadThread}>
				{#each devices as device (device.device_id)}
					<option value={device.device_id}>{device.label} · {device.device_id}</option>
				{/each}
			</select>
		</div>

		<div class="field" style="margin-top: 0;">
			<span class="field-label">Carrier state</span>
			<div class="row" style="gap: 10px;">
				<Switch.Root
					checked={offline}
					onCheckedChange={(value: boolean) => void toggleOffline(value)}
					aria-label="Simulate offline carrier"
				>
					<Switch.Thumb />
				</Switch.Root>
				<span style="font-size: 12px; color: var(--ink-3);">
					{offline ? 'Offline — injects are stored locally only' : 'Online — injects upload over the signed endpoint'}
				</span>
			</div>
		</div>
	</div>

	<div class="grid" style="grid-template-columns: minmax(0,1fr) minmax(0,1.4fr); margin-top: 12px;">
		<div class="field" style="margin-top: 0;">
			<label for="carrier-sender">From</label>
			<input id="carrier-sender" bind:value={sender} autocomplete="off" />
		</div>
		<div class="field" style="margin-top: 0;">
			<label for="carrier-body">Message</label>
			<input id="carrier-body" bind:value={messageBody} autocomplete="off" />
		</div>
	</div>

	<div class="row" style="margin-top: 12px;">
		<button class="primary" onclick={inject} disabled={!carrierDevice || carrierBusy}>
			Inject inbound
		</button>
		<button onclick={drain} disabled={!carrierDevice || carrierBusy || offline}>
			Poll outbox
		</button>
		<span style="flex: 1"></span>
		<button onclick={clearThread} disabled={!carrierDevice || carrierBusy}>Clear thread</button>
	</div>

	{#if carrierNotice}
		<p style="margin: 10px 0 0; font-size: 12px; color: var(--ink-3);" aria-live="polite">
			{carrierNotice}
		</p>
	{/if}

	{#if carrierDevice}
		<div style="margin-top: 14px; display: flex; flex-direction: column; gap: 8px;">
			{#if thread.length === 0}
				<p class="empty">No messages for this device yet. Inject one above.</p>
			{:else}
				{#each thread as entry (entry.id)}
					<div
						class="device"
						style="margin-top: 0; display: grid; grid-template-columns: 52px minmax(0,1fr) auto; gap: 10px; align-items: start;"
					>
						<span class="pill" style={entry.direction === 'in' ? '' : 'color: var(--accent)'}>
							{entry.direction === 'in' ? 'IN' : 'OUT'}
						</span>
						<div>
							<div style="font-family: var(--mono); font-size: 12px;">{entry.peer}</div>
							<div style="margin-top: 2px;">{entry.body}</div>
						</div>
						<div style="text-align: right; font-size: 11px; color: var(--ink-3);">
							<div>{entry.state}</div>
							<div>{when(entry.created_at)}</div>
						</div>
					</div>
				{/each}
			{/if}
		</div>
	{/if}
</section>
