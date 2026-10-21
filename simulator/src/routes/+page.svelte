<script lang="ts">
	import { onMount } from 'svelte';
	import { invoke } from '@tauri-apps/api/core';
	import { AlertDialog } from 'bits-ui';

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

	const configured = $derived(Boolean(target.base_url));

	async function refresh() {
		try {
			devices = await invoke<Device[]>('list_devices');
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

	onMount(async () => {
		await Promise.all([refresh(), loadTarget()]);
	});
</script>

<svelte:head>
	<title>DakFlare Simulator</title>
</svelte:head>

<section class="panel" style="margin-bottom: 16px;">
	<div class="row" style="justify-content: space-between;">
		<h2>Target deployment</h2>
		<span class="pill" style={configured ? 'color: var(--ok)' : ''}>
			{configured ? target.base_url : 'not configured'}
		</span>
	</div>

	<form onsubmit={saveTarget}>
		<div class="grid" style="grid-template-columns: minmax(0,1fr) minmax(0,1fr); margin-top: 10px;">
			<div class="field" style="margin-top: 0;">
				<label for="base-url">Worker URL</label>
				<input
					id="base-url"
					bind:value={baseUrl}
					placeholder="https://dakflare-worker.<account>.workers.dev"
					autocomplete="off"
				/>
			</div>
			<div class="field" style="margin-top: 0;">
				<label for="admin-token">
					Admin token {target.has_admin_token ? '(stored)' : '(needed to pair and clean up)'}
				</label>
				<input
					id="admin-token"
					type="password"
					bind:value={adminToken}
					placeholder={target.has_admin_token ? 'leave blank to keep' : 'ADMIN_TOKEN'}
					autocomplete="off"
				/>
			</div>
		</div>
		<div class="row" style="margin-top: 12px; justify-content: space-between;">
			<small style="color: var(--ink-3)">
				Stored locally in plain text for now; Tauri stronghold comes with the real build.
			</small>
			<button class="primary" type="submit" disabled={savingTarget}>
				{savingTarget ? 'Saving…' : 'Save target'}
			</button>
		</div>
		{#if targetNotice}
			<p style="margin: 8px 0 0; font-size: 12px; color: var(--ink-3);" aria-live="polite">
				{targetNotice}
			</p>
		{/if}
	</form>
</section>

<div class="grid">
	<section class="panel">
		<h2>New simulated device</h2>
		<p style="color: var(--ink-3); font-size: 12px; margin: 6px 0 0;">
			Generates a fresh P-256 keypair. The public half is what pairing registers; the private half stays local.
		</p>

		<form onsubmit={create}>
			<div class="field">
				<label for="label">Label</label>
				<input id="label" bind:value={label} placeholder="Pixel 8 · lab" autocomplete="off" />
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
					{creating ? 'Generating…' : 'Create device'}
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

		{#if loading}
			<p class="empty">Opening the local database…</p>
		{:else if devices.length === 0}
			<p class="empty">
				No devices yet. Create one to get a device id and a signing key, then pair it.
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
							onclick={() =>
								act(device.device_id, 'pair', async () =>
									invoke<string>('pair_device', { deviceId: device.device_id })
								)}
						>
							Pair
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
