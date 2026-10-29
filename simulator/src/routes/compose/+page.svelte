<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import DeviceSelect from '$lib/components/DeviceSelect.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import SegmentMeter from '$lib/components/SegmentMeter.svelte';
	import { watchKeyboard } from '$lib/keyboard';
	import { checkRecipient, recipientWords } from '$lib/recipient';
	import { sendBlock } from '$lib/reply-target';
	import { bodyWords, checkBody } from '$lib/sms-text';
	import { app } from '$lib/stores/app.svelte';
	import { composer } from '$lib/stores/composer.svelte';

	const recipient = $derived(checkRecipient(composer.newMessage.to));
	/** The same cap the reply bar uses, checked before the radio is asked. */
	const message = $derived(checkBody(composer.newMessage.body));
	const overCap = $derived(!message.ok && message.code === 'long' ? message : null);
	const blocked = $derived(
		sendBlock({ device: app.selected, facts: app.facts, offline: app.offline })
	);
	const canSend = $derived(!blocked && recipient.ok && message.ok && !composer.sending);

	/** The backend's exact words, kept here rather than in the reply bar. */
	let failure = $state<string | null>(null);
	let bodyField = $state<HTMLTextAreaElement | null>(null);

	/** One sentence for the button's tooltip. */
	function sendTitle(): string {
		if (blocked) return blocked.reason;
		if (!recipient.ok) return recipientWords(recipient);
		if (composer.sending) return `Sending to ${recipient.to}`;
		if (!message.ok) {
			// An empty body keeps the screen's own prompt; the cap uses the
			// backend's sentence, count included, so both name the same limit.
			return message.code === 'empty' ? 'Type the message first' : bodyWords(message);
		}
		return `Send to ${recipient.to}`;
	}

	/**
	 * The accessible name starts with the visible word, so voice control and
	 * screen readers can still say "Send" when the reason is in the tooltip.
	 */
	function sendLabel(): string {
		if (composer.sending) return 'Sending';
		if (!blocked && recipient.ok) return `Send to ${recipient.to}`;
		return 'Send';
	}

	function goBack() {
		// Replace this entry rather than push another: Threads stays the history
		// root, so Android's back on it exits. The form itself is kept in the
		// store, so coming back to compose brings the text with it.
		void goto('/messages', { replaceState: true });
	}

	async function submit() {
		if (!canSend || !recipient.ok) return;
		failure = null;
		const result = await composer.sendTo(recipient.to, composer.newMessage.body);
		if (!result.ok) {
			// The text stays exactly where it is; nothing left this phone.
			failure = result.reason;
			return;
		}
		composer.clearNewMessage();
		// Land in the thread the send just created. Replacing keeps Threads as
		// the one entry behind the conversation.
		await goto(`/messages/${encodeURIComponent(result.peer)}`, { replaceState: true });
	}

	function onRecipientKeydown(event: KeyboardEvent) {
		// The numeric keypad's return key moves on to the message; it never
		// sends a half-filled form.
		if (event.key !== 'Enter') return;
		event.preventDefault();
		bodyField?.focus();
	}

	function onBodyKeydown(event: KeyboardEvent) {
		// A phone keyboard's return key is a newline: an SMS may hold them. The
		// desktop shell gets the editor convention.
		if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			void submit();
		}
	}

	onMount(() => watchKeyboard());
</script>

<svelte:head>
	<title>New message · DakFlare</title>
</svelte:head>

<section class="screen compose-screen">
	<header class="conv-head compose-head">
		<button
			class="icon-btn conv-back"
			type="button"
			aria-label="Back to Threads"
			title="Back to Threads"
			onclick={goBack}
		>
			<Icon name="chevron-left" size={20} />
		</button>
		<div class="conv-who">
			<h1>New message</h1>
			<p class="conv-sub">as this phone</p>
		</div>
	</header>

	{#if app.loading.boot}
		<p class="quiet-state">Opening the local database…</p>
	{:else if !app.backendAvailable}
		<section class="empty-state" aria-labelledby="compose-no-backend">
			<span class="empty-icon"><Icon name="alert" size={26} /></span>
			<h2 id="compose-no-backend">The local database is not reachable</h2>
			<p>
				This window has no Tauri backend, so there is no phone to send from. Open the
				Android build, or the desktop shell, to write a message.
			</p>
			<a class="text-link" href="/messages">Back to Threads</a>
		</section>
	{:else}
		{#if app.devices.length > 1}
			<DeviceSelect id="compose-device" label="From" compact />
		{/if}

		<div class="compose-form" aria-busy={composer.sending}>
			<div class="compose-field">
				<label class="compose-label" for="compose-to">To</label>
				<input
					id="compose-to"
					class="compose-to"
					type="tel"
					inputmode="tel"
					autocomplete="tel"
					enterkeyhint="next"
					autocapitalize="off"
					spellcheck="false"
					aria-describedby="compose-to-hint"
					aria-invalid={!recipient.ok && recipient.code !== 'empty' ? 'true' : undefined}
					readonly={composer.sending}
					bind:value={composer.newMessage.to}
					onkeydown={onRecipientKeydown}
				/>
				<p
					class="compose-hint"
					id="compose-to-hint"
					data-tone={!recipient.ok && recipient.code !== 'empty' ? 'error' : undefined}
				>
					{#if recipient.ok}
						Dials <span class="compose-dialled mono">{recipient.to}</span>
					{:else if recipient.code === 'empty'}
						Digits and a leading +. At least 7 digits.
					{:else}
						{recipient.reason}{#if recipient.count !== undefined}{' '}
							<span class="mono">{recipient.count}</span>{/if}
					{/if}
				</p>
			</div>

			<div class="compose-field">
				<label class="compose-label" for="compose-body">Message</label>
				<textarea
					bind:this={bodyField}
					id="compose-body"
					class="compose-body"
					rows="4"
					placeholder="Type the message"
					autocapitalize="sentences"
					autocomplete="off"
					spellcheck="true"
					aria-describedby={composer.newMessage.body.length > 0 ? 'compose-count' : undefined}
					readonly={composer.sending}
					bind:value={composer.newMessage.body}
					onkeydown={onBodyKeydown}
				></textarea>
				{#if composer.newMessage.body.length > 0}
					<div class="compose-meta" id="compose-count">
						{#if overCap}
							<p class="composer-cap" role="status">
								{overCap.reason} <span class="mono">{overCap.count}</span>
							</p>
						{/if}
						<SegmentMeter body={composer.newMessage.body} />
					</div>
				{/if}
			</div>

			<div class="compose-actions">
				{#if failure}
					<div class="composer-failure" role="alert">
						<p>The phone did not send it.</p>
						<p class="composer-failure-reason mono">{failure}</p>
						<p>Your text is still here. Nothing left this phone.</p>
					</div>
				{/if}

				{#if blocked}
					<p class="compose-blocked" id="compose-blocked">
						{#if blocked.code === 'permission' || blocked.code === 'carrier-off'}
							<span class="composer-mark" aria-hidden="true">
								<Icon name="alert" size={16} />
							</span>
						{/if}
						<span>{blocked.reason}.</span>
					</p>
					{#if blocked.code === 'no-device'}
						<a class="text-link compose-settings" href="/settings">
							Create an identity in Settings
						</a>
					{/if}
				{/if}

				<button
					class="btn primary wide compose-send"
					type="button"
					aria-label={sendLabel()}
					title={sendTitle()}
					disabled={!canSend}
					onclick={() => void submit()}
				>
					{composer.sending ? 'Sending…' : 'Send'}
				</button>
			</div>
		</div>
	{/if}
</section>
