<script lang="ts">
	import DeviceSelect from '$lib/components/DeviceSelect.svelte';
	import Notice from '$lib/components/Notice.svelte';
	import { app, type DevicePermissions } from '$lib/stores/app.svelte';
	import { deviceState, relativeTime, STATE_LABEL, stateSentence } from '$lib/device-state';

	let now: number = $state(Date.now());
	$effect(() => {
		const clock = setInterval(() => (now = Date.now()), 60_000);
		return () => clearInterval(clock);
	});

	const device = $derived(app.selected);
	const contact = $derived(device ? (app.contactAt[device.device_id] ?? null) : null);
	const deviceStatus = $derived(deviceState(app.offline, contact, now));
	const pairing = $derived.by(() => {
		if (!device) return '—';
		if (app.pairedAt[device.device_id]) return 'paired this session';
		if (app.contactAt[device.device_id]) return 'paired · signed contact answered';
		return 'not recorded in this build';
	});

	const facts = $derived(app.facts);
	const permissionRecord = $derived(
		facts?.permissions && typeof facts.permissions === 'object'
			? (facts.permissions as Record<string, unknown>)
			: null
	);
	const selfNumber = $derived(facts?.self_number?.trim() || null);
	const defaultSmsRaw = $derived(facts?.default_sms_app?.trim() || null);
	// Android writes the literal "none" when the role is unset. That is a fact,
	// not a missing value, so it gets its own honest row.
	const noDefaultSms = $derived(defaultSmsRaw === 'none');
	const defaultSms = $derived(noDefaultSms ? null : defaultSmsRaw);
	const isDefaultSms = $derived(defaultSmsRaw === 'dev.dakflare.simulator');
	const hasAnyFact = $derived(
		Boolean(
			selfNumber ||
				(facts?.sim_slot !== null && facts?.sim_slot !== undefined) ||
				facts?.sim_carrier ||
				permissionRecord ||
				(facts?.battery_optimized !== null && facts?.battery_optimized !== undefined) ||
				defaultSmsRaw
		)
	);
	const factsPending = $derived(!app.factsLoaded && app.backendAvailable);

	type PermissionKey = keyof DevicePermissions;
	type PermissionState = 'granted' | 'denied' | 'missing';

	const permissions: { key: PermissionKey; label: string; constant: string }[] = [
		{ key: 'sms', label: 'Receive SMS', constant: 'RECEIVE_SMS' },
		{ key: 'send', label: 'Send SMS', constant: 'SEND_SMS' },
		{ key: 'phone_numbers', label: 'Read phone number', constant: 'READ_PHONE_NUMBERS' }
	];

	function permissionState(key: PermissionKey): PermissionState {
		if (!permissionRecord) return 'missing';
		const value = permissionRecord[key];
		if (value === true) return 'granted';
		if (value === false) return 'denied';
		return 'missing';
	}

	function missingReason(): string {
		if (app.factsError) return 'The handset facts could not be read.';
		if (!facts) return 'Android has not written any handset facts yet.';
		return 'Android did not write this fact.';
	}

	function permissionReason(key: PermissionKey): string {
		const state = permissionState(key);
		const constant = permissions.find((permission) => permission.key === key)?.constant ?? key;
		if (state === 'denied') return `${constant} is not granted.`;
		if (state === 'missing') {
			if (!facts) return missingReason();
			return permissionRecord
				? `Android did not include ${constant} in its report.`
				: 'Android has not written its permission report.';
		}
		return '';
	}

	function numberReason(): string {
		if (!facts) return missingReason();
		const state = permissionState('phone_numbers');
		if (state === 'denied') return 'READ_PHONE_NUMBERS is not granted.';
		if (state === 'missing') return 'The phone-number permission was not reported.';
		return 'READ_PHONE_NUMBERS is granted, but Android returned no number.';
	}

	function subscriptionReason(): string {
		if (!facts) return missingReason();
		return 'Android did not report an active subscription.';
	}

	function batteryReason(): string {
		if (!facts) return missingReason();
		return 'The battery check has not run.';
	}

	function defaultSmsReason(): string {
		if (!facts) return missingReason();
		return 'Android did not report the default SMS app.';
	}
</script>

<svelte:head>
	<title>Device · DakFlare</title>
</svelte:head>

<section class="screen">
	<header class="screen-head">
		<div>
			<p class="eyebrow">Gateway</p>
			<h1>Device</h1>
			<p class="screen-meta">{device ? device.label : app.backendAvailable ? 'no identity' : 'local database'}</p>
		</div>
		<span class="state-pill" data-state={deviceStatus}>{STATE_LABEL[deviceStatus]}</span>
	</header>

	{#if app.devices.length > 1}
		<DeviceSelect id="device-page-select" label="Selected" compact />
	{/if}

	{#if app.loading.boot}
		<p class="quiet-state">Opening the local database…</p>
	{:else if !app.backendAvailable}
		<section class="empty-state" aria-labelledby="device-no-backend">
			<h2 id="device-no-backend">No local database in this window</h2>
			<p>The device identity lives in the Tauri shell. This browser preview cannot read it.</p>
		</section>
	{:else if !device}
		<section class="empty-state" aria-labelledby="device-empty">
			<h2 id="device-empty">No device identity yet</h2>
			<p>A phone needs its own P-256 keypair before it can be paired or polled.</p>
			<a class="text-link" href="/settings" data-sveltekit-replacestate>Create an identity in Settings</a>
		</section>
	{:else}
		<section class="state-block" data-state={deviceStatus} aria-labelledby="device-state">
			<div class="state-line">
				<h2 id="device-state">{STATE_LABEL[deviceStatus]}</h2>
				<span class="beacon" aria-hidden="true"></span>
			</div>
			<p class="state-sentence">{stateSentence(deviceStatus, contact)}</p>
			<p class="state-last mono">
				{contact ? `last signed contact · ${relativeTime(contact, now)}` : 'no signed contact this session'}
			</p>
		</section>

		<section class="sheet" aria-labelledby="handset-title">
			<div class="sheet-head">
				<h2 class="sheet-title" id="handset-title">Handset</h2>
				<span class="pill">
					{!app.factsLoaded ? 'reading' : hasAnyFact ? 'reported by Android' : 'nothing reported'}
				</span>
			</div>

			{#if factsPending}
				<p class="quiet-state">Reading Android's report…</p>
			{:else}
				<div class="rows">
					<div class="rowline">
						<span class="label">Phone number</span>
						<span class="value fact-value">
							{#if selfNumber}
								<span class="mono">{selfNumber}</span>
							{:else}
								<span class="fact-missing">not reported by Android</span>
								<span class="fact-reason">{numberReason()}</span>
							{/if}
						</span>
					</div>

					<div class="rowline">
						<span class="label">SIM slot</span>
						<span class="value fact-value">
							{#if facts?.sim_slot !== null && facts?.sim_slot !== undefined}
								<span class="mono">SIM {facts.sim_slot}</span>
							{:else}
								<span class="fact-missing">not reported by Android</span>
								<span class="fact-reason">{subscriptionReason()}</span>
							{/if}
						</span>
					</div>

					<div class="rowline">
						<span class="label">Carrier</span>
						<span class="value fact-value">
							{#if facts?.sim_carrier}
								<span>{facts.sim_carrier}</span>
							{:else}
								<span class="fact-missing">not reported by Android</span>
								<span class="fact-reason">{subscriptionReason()}</span>
							{/if}
						</span>
					</div>

					{#each permissions as permission (permission.key)}
						{@const state = permissionState(permission.key)}
						<div class="rowline">
							<span class="label">{permission.label}</span>
							<span class="value fact-value">
								{#if state === 'granted'}
									<span class="state-chip" data-tone="ok">granted</span>
								{:else if state === 'denied'}
									<span class="state-chip" data-tone="danger">not granted</span>
									<span class="fact-reason">{permissionReason(permission.key)}</span>
								{:else}
									<span class="fact-missing">not reported by Android</span>
									<span class="fact-reason">{permissionReason(permission.key)}</span>
								{/if}
							</span>
						</div>
					{/each}

					<div class="rowline">
						<span class="label">Battery optimisation</span>
						<span class="value fact-value">
							{#if facts?.battery_optimized === true}
								<span class="state-chip" data-tone="ok">not optimised</span>
								<span class="fact-reason">Android will not pause this app for battery.</span>
							{:else if facts?.battery_optimized === false}
								<span class="state-chip" data-tone="warn">optimised</span>
								<span class="fact-reason">Android may pause this app in the background.</span>
							{:else}
								<span class="fact-missing">not reported by Android</span>
								<span class="fact-reason">{batteryReason()}</span>
							{/if}
						</span>
					</div>

					<div class="rowline">
						<span class="label">Default SMS app</span>
						<span class="value fact-value">
							{#if noDefaultSms}
								<span>no default SMS app</span>
								<span class="fact-reason">Android reports that no app holds the role.</span>
							{:else if defaultSms}
								<span class="mono" title={defaultSms}>
									{isDefaultSms ? 'DakFlare' : defaultSms}
								</span>
								<span class="fact-reason">
									{isDefaultSms
										? 'This app is the default SMS app.'
										: 'Another app handles SMS on this phone.'}
								</span>
							{:else}
								<span class="fact-missing">not reported by Android</span>
								<span class="fact-reason">{defaultSmsReason()}</span>
							{/if}
						</span>
					</div>
				</div>

				<p class="note">
					These are the handset's own facts, shared by every identity in this build. A fact
					Android did not report keeps the reason beside it rather than a blank row.
				</p>
				{#if app.factsError}
					<p class="note">Android's report could not be read. {app.factsError}</p>
				{/if}
			{/if}
		</section>

		<section class="sheet" aria-labelledby="identity-title">
			<h2 class="sheet-title" id="identity-title">Identity</h2>
			<div class="rows">
				<div class="rowline">
					<span class="label">Label</span>
					<span class="value">{device.label}</span>
				</div>
				<div class="rowline">
					<span class="label">Device id</span>
					<span class="value mono id-value">{device.device_id}</span>
				</div>
				<div class="rowline">
					<span class="label">Pairing</span>
					<span class="value">{pairing}</span>
				</div>
				<div class="rowline">
					<span class="label">Public key</span>
					<span class="value mono">{device.public_key_spki.slice(0, 18)}…</span>
				</div>
				<div class="rowline">
					<span class="label">Created</span>
					<span class="value mono">{new Date(device.created_at).toLocaleDateString()}</span>
				</div>
			</div>
			<p class="note">
				The carrier and SIM slot you chose when creating this identity are listed in
				<a class="inline-link" href="/settings">Settings</a>. The rows above are what Android
				reports for the handset.
			</p>
		</section>

		<section class="sheet" aria-labelledby="actions-title">
			<h2 class="sheet-title" id="actions-title">Actions</h2>
			<div class="stack">
				<button
					class="btn wide"
					type="button"
					onclick={() => app.poll(device.device_id)}
					disabled={!app.configured || app.busy.poll || app.busy.revoke}
				>
					{app.busy.poll ? 'Polling…' : 'Poll now'}
				</button>
				<button
					class="btn wide danger-ghost"
					type="button"
					onclick={() => app.revoke(device.device_id)}
					disabled={!app.configured || app.busy.poll || app.busy.revoke}
				>
					Revoke on the deployment
				</button>
			</div>
			{#if !app.configured}
				<p class="note">Set the target deployment in Settings before polling or revoking.</p>
			{/if}
			<Notice scope={`device:${device.device_id}`} />
		</section>

		<p class="wake-note">
			Wake mode is poll-only in this build. The phone answers on its next signed poll, and
			Android may stop background work until the app is opened again.
		</p>
	{/if}
</section>
