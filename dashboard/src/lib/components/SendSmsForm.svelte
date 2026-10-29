<script lang="ts">
	import { tick } from 'svelte';
	import { describeError, getDevices, sendSms } from '$lib/api';
	import type { Device } from '$lib/types';
	import { deviceOptionLabel } from '$lib/presence';
	import { encodingHint, encodingLabel, measureSms, smsCapacity } from '$lib/sms';
	import CommandTracker from './CommandTracker.svelte';
	import Icon from './Icon.svelte';
	import Notice from './Notice.svelte';
	import Spinner from './Spinner.svelte';

	let {
		devices: providedDevices,
		deviceId = $bindable(''),
		onqueued,
		autofocus = false
	}: {
		/** Pass the fleet in when the page already has it; otherwise the form fetches it. */
		devices?: Device[];
		deviceId?: string;
		onqueued?: (result: { command_id: string; device_id: string }) => void;
		autofocus?: boolean;
	} = $props();

	const uid = $props.id();
	const deviceFieldId = `send-device-${uid}`;
	const toFieldId = `send-to-${uid}`;
	const bodyFieldId = `send-body-${uid}`;
	const toErrorId = `send-to-error-${uid}`;
	const countId = `send-count-${uid}`;
	const encodingId = `send-encoding-${uid}`;

	const MAX_PEER = 32;
	const MAX_BODY = 4096;

	let fleet = $state<Device[]>([]);
	let fleetLoading = $state(true);
	let fleetError = $state<string | null>(null);
	let fetched = false;

	let to = $state('');
	let body = $state('');
	let sending = $state(false);
	let error = $state<string | null>(null);
	let queued = $state<{ command_id: string; device_id: string } | null>(null);

	let toInput = $state<HTMLInputElement | null>(null);

	const options = $derived(providedDevices ?? fleet);
	const awaitingFleet = $derived(fleetLoading && providedDevices === undefined);
	const recipient = $derived(to.trim());
	// Measured the way the carrier measures it: a Bangla body is 70 per message,
	// not 160. The denominator moves to 67 per part once the text splits.
	const measure = $derived(measureSms(body));

	async function resendQueued(recipientValue: string, bodyValue: string): Promise<void> {
		if (!queued) return;
		const target = queued.device_id;
		const result = await sendSms({ device_id: target, to: recipientValue, body: bodyValue });
		queued = { command_id: result.command_id, device_id: target };
		onqueued?.(queued);
	}

	const toError = $derived(
		recipient.length > MAX_PEER
			? `Recipients are at most ${MAX_PEER} characters on this gateway.`
			: null
	);
	const bodyError = $derived(
		body.length > MAX_BODY
			? `Messages are at most ${MAX_BODY.toLocaleString()} characters.`
			: null
	);
	const canSend = $derived(
		Boolean(deviceId) &&
			recipient.length > 0 &&
			body.trim().length > 0 &&
			!toError &&
			!bodyError &&
			!sending
	);

	$effect(() => {
		if (fetched) return;
		fetched = true;
		if (providedDevices !== undefined) {
			fleetLoading = false;
			return;
		}
		void loadFleet();
	});

	$effect(() => {
		if (options.length === 0) return;
		if (!deviceId || !options.some((device) => device.device_id === deviceId)) {
			deviceId = options[0].device_id;
		}
	});

	$effect(() => {
		if (!autofocus) return;
		void tick().then(() => toInput?.focus());
	});

	async function loadFleet(): Promise<void> {
		fleetLoading = true;
		fleetError = null;
		try {
			fleet = await getDevices();
		} catch (failure) {
			fleetError = describeError(failure);
		} finally {
			fleetLoading = false;
		}
	}

	async function submit(): Promise<void> {
		if (!canSend) return;
		sending = true;
		error = null;
		queued = null;
		const target = deviceId;
		const recipientValue = recipient;
		const bodyValue = body;
		try {
			const result = await sendSms({
				device_id: target,
				to: recipientValue,
				body: bodyValue
			});
			queued = { command_id: result.command_id, device_id: target };
			body = '';
			onqueued?.(queued);
		} catch (failure) {
			error = describeError(failure);
		} finally {
			sending = false;
		}
	}
</script>

<div class="send">
	{#if fleetError}
		<div class="fleet-error">
			<Notice tone="danger" title="Could not load the fleet">{fleetError}</Notice>
			{#if providedDevices === undefined}
				<button type="button" class="btn btn-sm" onclick={() => void loadFleet()}>
					<Icon name="refresh" size={12} /> Try again
				</button>
			{/if}
		</div>
	{:else if awaitingFleet}
		<div aria-busy="true" aria-live="polite">
			<span class="sr-only">Loading devices</span>
			<div class="skeleton" style="height: 96px"></div>
		</div>
	{:else if options.length === 0}
		<Notice tone="warn" title="No device paired yet">
			Pair a phone before sending. Mint a code on Devices, then come back.
		</Notice>
	{:else}
		<form
			onsubmit={(event) => {
				event.preventDefault();
				void submit();
			}}
		>
			<div class="send-grid">
				<div class="field">
					<label class="label" for={deviceFieldId}>Send from</label>
					<select
						id={deviceFieldId}
						class="input input-mono"
						bind:value={deviceId}
						disabled={awaitingFleet || sending}
					>
						{#each options as device (device.device_id)}
							<option value={device.device_id}>{deviceOptionLabel(device)}</option>
						{/each}
					</select>
				</div>

				<div class="field">
					<label class="label" for={toFieldId}>
						Recipient <span class="optional">number or shortcode</span>
					</label>
					<input
						id={toFieldId}
						class="input input-mono"
						bind:this={toInput}
						bind:value={to}
						maxlength={MAX_PEER}
						placeholder="+15551234567"
						autocomplete="tel"
						inputmode="tel"
						spellcheck="false"
						aria-invalid={toError ? 'true' : undefined}
						aria-describedby={toError ? toErrorId : undefined}
						disabled={sending}
					/>
					{#if toError}
						<p class="field-error" id={toErrorId}>{toError}</p>
					{/if}
				</div>

				<div class="field span-2">
					<label class="label" for={bodyFieldId}>Message</label>
					<textarea
						id={bodyFieldId}
						class="input body-field"
						bind:value={body}
						rows="3"
						maxlength={MAX_BODY}
						placeholder="Type the message the phone should send…"
						aria-describedby={`${countId} ${encodingId}`}
						aria-invalid={bodyError ? 'true' : undefined}
						disabled={sending}
					></textarea>
					<div class="body-meta">
						<span class="hint" id={encodingId}>{encodingHint(measure)}</span>
						<span class="count" id={countId}>
							<span class="count-encoding">{encodingLabel(measure)}</span>
							<span class="mono">{measure.units}/{smsCapacity(measure)}</span>
							{#if measure.segments > 0}
								<span class="count-parts mono">{measure.segments} SMS</span>
							{/if}
						</span>
					</div>
					{#if bodyError}
						<p class="field-error">{bodyError}</p>
					{/if}
				</div>

				<div class="send-foot span-2">
					<button
						type="submit"
						class="btn btn-primary"
						disabled={!canSend}
						aria-busy={sending}
					>
						{#if sending}<Spinner />{:else}<Icon name="send" size={14} />{/if}
						Send SMS
					</button>
				</div>
			</div>
		</form>
	{/if}

	{#if error}
		<div class="send-feedback">
			<Notice tone="danger" title="Could not queue the message">{error}</Notice>
		</div>
	{/if}

	{#if queued}
		<div class="send-feedback" aria-live="polite">
			<Notice tone="ok" title="Message queued">
				The phone collects it when it next checks in. Its state below follows it until the
				phone reports a result.
			</Notice>
			<div class="queued-tracker">
				<CommandTracker
					deviceId={queued.device_id}
					commandId={queued.command_id}
					onResend={resendQueued}
				/>
			</div>
		</div>
	{/if}
</div>

<style>
	.send {
		display: grid;
		gap: var(--df-p-space-3);
	}

	.fleet-error {
		display: grid;
		justify-items: start;
		gap: var(--df-p-space-2);
	}

	.send-grid {
		display: grid;
		grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr);
		gap: var(--df-p-space-3) var(--df-p-space-4);
	}

	.send-grid > .span-2 {
		grid-column: 1 / -1;
	}

	/* A message body is prose, not a payload: mono would make a Bangla sentence
	   render in a fallback face at the wrong size. */
	.body-field {
		font-family: var(--df-p-font-sans);
		font-size: var(--df-p-text-md);
		line-height: 1.5;
	}

	.body-meta {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--df-p-space-3);
		flex-wrap: wrap;
	}

	.count {
		display: inline-flex;
		align-items: baseline;
		gap: var(--df-p-space-2);
		font-size: var(--df-p-text-xs);
		color: var(--df-text-meta);
		white-space: nowrap;
	}

	.count-encoding {
		font-family: var(--df-p-font-mono);
		font-size: var(--df-p-text-2xs);
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}

	.count-parts {
		color: var(--df-text-secondary);
	}

	.send-foot {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-3);
		flex-wrap: wrap;
		padding-top: var(--df-p-space-3);
		border-top: 1px solid var(--df-border-hairline);
	}

	.send-feedback {
		display: grid;
		gap: var(--df-p-space-3);
	}

	.queued-tracker {
		max-width: 100%;
	}

	@media (max-width: 620px) {
		.send-grid {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
