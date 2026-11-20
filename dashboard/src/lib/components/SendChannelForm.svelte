<script lang="ts">
	import { onMount } from 'svelte';
	import { ApiError, describeError, getConnectors, sendChannelMessage } from '$lib/api';
	import { channelMeta, channelSendFailure, channelWord } from '$lib/channels';
	import { ROUTES } from '$lib/paths';
	import type { ChannelConnector, ChannelSendResult } from '$lib/types';
	import Icon from './Icon.svelte';
	import Notice from './Notice.svelte';
	import Spinner from './Spinner.svelte';

	let {
		onSent,
		defaultTo = ''
	}: {
		/** Called after the platform accepts the message, with its own delivery result. */
		onSent?: (result: ChannelSendResult) => void;
		defaultTo?: string;
	} = $props();

	const uid = $props.id();
	const connectorId = `channel-send-connector-${uid}`;
	const toId = `channel-send-to-${uid}`;
	const bodyId = `channel-send-body-${uid}`;
	const templateId = `channel-send-template-${uid}`;
	const commentId = `channel-send-comment-${uid}`;
	const humanTagId = `channel-send-human-${uid}`;

	let connectors = $state<ChannelConnector[]>([]);
	let loading = $state(true);
	let loadError = $state<string | null>(null);

	let selectedId = $state('');
	let to = $state('');
	let body = $state('');
	let template = $state('');
	let useHumanAgentTag = $state(false);
	let comment = $state('');
	let sending = $state(false);
	let failure = $state<string | null>(null);
	let sent = $state<{
		label: string;
		word: string;
		state: ChannelSendResult['state'];
		messageId?: string;
	} | null>(null);

	const enabled = $derived(connectors.filter((item) => item.enabled));
	const active = $derived(enabled.find((item) => item.id === selectedId) ?? null);
	const meta = $derived(channelMeta(active?.channel));
	const word = $derived(channelWord(active?.channel) ?? 'the platform');

	/** What the recipient field calls the address on this platform. */
	const recipient = $derived.by(() => {
		switch (active?.channel) {
			case 'telegram':
				return {
					label: 'Chat id',
					placeholder: 'e.g. 712345678 or @channelname',
					hint: 'The bot can only write to a chat that has written to it first.'
				};
			case 'messenger':
				return {
					label: 'Recipient PSID',
					placeholder: 'Page-scoped id',
					hint: 'Messenger names each person with a page-scoped id, not a phone number.'
				};
			case 'instagram':
				return {
					label: 'Recipient IGSID',
					placeholder: 'Instagram-scoped id',
					hint: 'Instagram names each person with an account-scoped id.'
				};
			default:
				return {
					label: 'Recipient phone',
					placeholder: '+15551234567',
					hint: 'In international form, with the leading +.'
				};
		}
	});

	/**
	 * The primary action is always live: an empty field is a validation problem,
	 * not a reason to grey the button out and make the panel's one action look
	 * unavailable. `required` on the two fields lets the browser stop the submit
	 * and focus what is missing.
	 */
	const canSubmit = $derived(active !== null && !sending);

	/** The delivery result's own code, which arrives in the body of an HTTP error. */
	function payloadCode(error: unknown): string | null {
		if (!(error instanceof ApiError)) return null;
		const payload = error.payload;
		if (!payload || typeof payload !== 'object') return null;
		const value = (payload as Record<string, unknown>).errorCode;
		return typeof value === 'string' ? value : null;
	}

	function failureText(error: unknown): string {
		if (error instanceof ApiError) {
			const known = channelSendFailure(error.code) ?? channelSendFailure(payloadCode(error));
			if (known) return known;
		}
		return describeError(error);
	}

	async function load(): Promise<void> {
		loading = true;
		loadError = null;
		try {
			connectors = await getConnectors();
			const first = connectors.find((item) => item.enabled)?.id ?? '';
			if (!connectors.some((item) => item.id === selectedId && item.enabled)) {
				selectedId = first;
			}
		} catch (error) {
			loadError = describeError(error);
		} finally {
			loading = false;
		}
	}

	async function submit(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		if (!active || !canSubmit) return;
		const target = active;
		const activeMeta = meta;
		sending = true;
		failure = null;
		sent = null;
		try {
			const result = await sendChannelMessage({
				channel: target.channel,
				connectorId: target.id,
				to: to.trim(),
				body: body.trim(),
				...(activeMeta?.supportsTemplates && template.trim() !== ''
					? { template_id: template.trim() }
					: {}),
				...(activeMeta?.supportsHumanAgentTag && useHumanAgentTag
					? { use_human_agent_tag: true }
					: {}),
				...(activeMeta?.supportsCommentReply && comment.trim() !== ''
					? { comment_id: comment.trim() }
					: {})
			});
			if (!result.success) {
				failure =
					channelSendFailure(result.errorCode, result.substate) ??
					`${channelWord(target.channel) ?? 'The platform'} refused this message${
						result.errorCode ? ` (${result.errorCode})` : ''
					}.`;
				return;
			}
			sent = {
				label: target.label,
				word: channelWord(target.channel) ?? 'the platform',
				state: result.state,
				...(result.channelMessageId ? { messageId: result.channelMessageId } : {})
			};
			body = '';
			template = '';
			comment = '';
			useHumanAgentTag = false;
			onSent?.(result);
		} catch (error) {
			failure = failureText(error);
		} finally {
			sending = false;
		}
	}

	onMount(() => {
		// `defaultTo` seeds the field once; after that the operator owns it.
		if (to === '') to = defaultTo;
		void load();
	});
</script>

<div class="channel-send">
	{#if loading}
		<div aria-busy="true" aria-live="polite">
			<span class="sr-only">Loading channel connectors</span>
			<div class="skeleton"></div>
		</div>
	{:else if loadError}
		<div class="load-error">
			<Notice tone="danger" title="Could not load the connectors">{loadError}</Notice>
			<button type="button" class="btn btn-sm" onclick={() => void load()}>
				<Icon name="refresh" size={12} /> Try again
			</button>
		</div>
	{:else if enabled.length === 0}
		<Notice tone="warn" title="No connector is enabled">
			Add a connector on <a href={ROUTES.channels}>Channels</a>, or resume a paused one, to reply
			from an external account.
		</Notice>
	{:else}
		<form
			onsubmit={(event) => {
				void submit(event);
			}}
		>
			<div class="send-grid">
				<div class="field">
					<label class="label" for={connectorId}>Send from</label>
					<select id={connectorId} class="input" bind:value={selectedId} disabled={sending}>
						{#each enabled as item (item.id)}
							<option value={item.id}>{channelWord(item.channel)} · {item.label}</option>
						{/each}
					</select>
				</div>

				<div class="field">
					<label class="label" for={toId}>{recipient.label}</label>
					<input
						id={toId}
						class="input input-mono"
						bind:value={to}
						placeholder={recipient.placeholder}
						autocomplete="off"
						spellcheck="false"
						required
						disabled={sending}
					/>
					<p class="hint">{recipient.hint}</p>
				</div>

				<div class="field span-2">
					<label class="label" for={bodyId}>Message</label>
					<textarea
						id={bodyId}
						class="input body-field"
						bind:value={body}
						rows="3"
						placeholder={`Type the reply ${word} should send…`}
						required
						disabled={sending}
					></textarea>
				</div>

				{#if meta?.supportsTemplates}
					<div class="field">
						<label class="label" for={templateId}>
							Template name <span class="optional">outside the window</span>
						</label>
						<input
							id={templateId}
							class="input input-mono"
							bind:value={template}
							placeholder="e.g. order_update"
							autocomplete="off"
							spellcheck="false"
							disabled={sending}
						/>
						<p class="hint">
							WhatsApp allows a free-form reply for 24 hours after the last message. After that,
							name an approved template here.
						</p>
					</div>
				{/if}

				{#if meta?.supportsHumanAgentTag}
					<div class="check-field span-2">
						<label class="check" for={humanTagId}>
							<input id={humanTagId} type="checkbox" bind:checked={useHumanAgentTag} disabled={sending} />
							<span>Send with the human agent tag</span>
						</label>
						<p class="hint">
							Lets a person answer up to 7 days after the last customer message instead of 24
							hours.
						</p>
					</div>
				{/if}

				{#if meta?.supportsCommentReply}
					<div class="field">
						<label class="label" for={commentId}>
							Comment id <span class="optional">private reply</span>
						</label>
						<input
							id={commentId}
							class="input input-mono"
							bind:value={comment}
							placeholder="Instagram comment id"
							autocomplete="off"
							spellcheck="false"
							disabled={sending}
						/>
						<p class="hint">
							Answers a comment privately within 7 days, which is allowed outside the messaging
							window.
						</p>
					</div>
				{/if}

				<div class="send-foot span-2">
					<button type="submit" class="btn btn-primary" disabled={!canSubmit} aria-busy={sending}>
						{#if sending}<Spinner />{:else}<Icon name="send" size={14} />{/if}
						Send via connector
					</button>
					<p class="hint">
						The platform sends it with this connector's own credential, so it does not pass
						through the phone or appear in its log.
					</p>
				</div>
			</div>
		</form>
	{/if}

	{#if failure}
		<Notice tone="danger" title="Not sent">{failure}</Notice>
	{/if}

	{#if sent}
		<Notice
			tone="info"
			title={sent.state === 'DELIVERED' ? `Delivered by ${sent.word}` : `Accepted by ${sent.word}`}
		>
			{#if sent.state === 'DELIVERED'}
				{sent.label}: the platform reported this message as delivered.
			{:else}
				{sent.label} handed the message to {sent.word}. That is an acceptance, not a delivery:
				the platform confirms delivery later through its own event, not through this response.
			{/if}
			{#if sent.messageId}
				<span class="mono sent-id">{sent.messageId}</span>
			{/if}
		</Notice>
	{/if}
</div>

<style>
	.channel-send {
		display: grid;
		gap: var(--df-p-space-3);
	}

	.load-error {
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

	/* A reply is prose, not a payload: mono would set a Bangla sentence in a
	   fallback face at the wrong size. */
	.body-field {
		font-family: var(--df-p-font-sans);
		font-size: var(--df-p-text-md);
		line-height: 1.5;
	}

	.check-field {
		display: grid;
		gap: var(--df-p-space-1);
	}

	.send-foot {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-3);
		flex-wrap: wrap;
		padding-top: var(--df-p-space-3);
		border-top: 1px solid var(--df-border-hairline);
	}

	.send-foot .hint {
		flex: 1 1 24ch;
		min-width: 0;
	}

	.sent-id {
		display: block;
		margin-top: var(--df-p-space-1);
		font-size: var(--df-p-text-xs);
		overflow-wrap: anywhere;
	}

	@media (max-width: 720px) {
		.check {
			min-height: 44px;
			align-items: center;
		}

		.check input {
			width: var(--df-p-space-4);
			height: var(--df-p-space-4);
			margin-top: 0;
		}

		.field .input {
			min-height: 44px;
		}

		.load-error .btn {
			min-height: 44px;
		}

		.body-field {
			font-size: 16px;
		}
	}

	@media (max-width: 620px) {
		.send-grid {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
