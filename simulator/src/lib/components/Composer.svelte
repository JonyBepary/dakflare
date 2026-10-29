<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import Icon from '$lib/components/Icon.svelte';
	import SegmentMeter from '$lib/components/SegmentMeter.svelte';
	import { watchKeyboard } from '$lib/keyboard';
	import { decodePeer, replyBlock } from '$lib/reply-target';
	import { app } from '$lib/stores/app.svelte';
	import { composer } from '$lib/stores/composer.svelte';
	import { bodyWords, checkBody } from '$lib/sms-text';

	const rawPeer = $derived(page.params.peer ?? '');
	const peer = $derived(decodePeer(rawPeer));

	const blocked = $derived(
		replyBlock({ peer, device: app.selected, facts: app.facts, offline: app.offline })
	);
	const typed = $derived(composer.draft.length > 0);
	/** The hard cap, checked before send so the radio never sees an oversize body. */
	const message = $derived(checkBody(composer.draft));
	const overCap = $derived(!message.ok && message.code === 'long' ? message : null);
	const canSend = $derived(!blocked && !composer.sending && message.ok);

	let field = $state<HTMLTextAreaElement | null>(null);

	/** Grow with the text, stop at five whole lines, scroll inside after that. */
	function autosize() {
		const node = field;
		const wrap = node?.closest<HTMLElement>('.composer-field');
		if (!node || !wrap) return;
		node.style.height = 'auto';

		const input = getComputedStyle(node);
		const box = getComputedStyle(wrap);
		const line = Number.parseFloat(input.lineHeight) || 21;
		const paddingTop = Number.parseFloat(input.paddingTop);
		// A textarea clips at its padding box, so the box's bottom padding is
		// still visible area: whole lines have to be counted inside it, or a
		// sliver of the next line paints over the padding and reads as clipped.
		const room =
			Number.parseFloat(box.maxHeight) -
			Number.parseFloat(box.paddingBottom) -
			Number.parseFloat(box.borderTopWidth) -
			Number.parseFloat(box.borderBottomWidth);
		const lines = Math.max(1, Math.floor((room - paddingTop) / line));
		node.style.height = `${Math.min(node.scrollHeight, paddingTop + lines * line)}px`;
	}

	async function submit() {
		if (!canSend) return;
		await composer.send(peer);
		// A failed send puts the text back; the field must grow to fit it.
		autosize();
	}

	function onKeydown(event: KeyboardEvent) {
		// A phone keyboard's return key is a newline: an SMS may hold them.
		// The desktop shell gets the editor convention.
		if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			void submit();
		}
	}

	$effect(() => {
		// Track the draft and the node: both change the height.
		void composer.draft;
		void field;
		autosize();
	});

	// The shell keeps one composer for every conversation, so a draft must not
	// follow the operator into a different thread.
	let currentPeer = '';
	$effect(() => {
		if (peer === currentPeer) return;
		currentPeer = peer;
		composer.start();
	});

	onMount(() => watchKeyboard());
</script>

<footer
	class="composer"
	aria-label="Reply"
	data-blocked={blocked ? 'true' : 'false'}
	data-sending={composer.sending ? 'true' : 'false'}
	aria-busy={composer.sending}
>
	{#if composer.failure}
		<div class="composer-failure" role="alert">
			<p>The phone did not send it.</p>
			<p class="composer-failure-reason mono">{composer.failure}</p>
			<p>The text is back in the composer. Nothing left this phone.</p>
		</div>
	{/if}

	<div class="composer-row">
		{#if blocked}
			<!-- A disabled field looks like a field with nothing in it. The bar
			     says the reason once, in the place the text would go. -->
			<p class="composer-blocked" id="composer-status">
				{#if blocked.code === 'permission' || blocked.code === 'carrier-off'}
					<span class="composer-mark" aria-hidden="true"><Icon name="alert" size={16} /></span>
				{/if}
				{blocked.reason}
			</p>
		{:else}
			<div class="composer-field">
				<textarea
					bind:this={field}
					class="composer-input"
					bind:value={composer.draft}
					rows="1"
					aria-label={`Reply to ${peer}`}
					aria-describedby="composer-status"
					placeholder={`Reply to ${peer}`}
					readonly={composer.sending}
					autocapitalize="sentences"
					autocomplete="off"
					spellcheck="true"
					oninput={autosize}
					onkeydown={onKeydown}
				></textarea>
			</div>
		{/if}

		<button
			class="composer-send"
			type="button"
			aria-label={composer.sending ? `Sending to ${peer}` : `Send to ${peer}`}
			title={blocked
				? blocked.reason
				: composer.sending
					? 'Sending'
					: overCap
						? bodyWords(overCap)
						: 'Send'}
			disabled={!canSend}
			onclick={() => void submit()}
		>
			<Icon name="send" size={20} />
		</button>
	</div>

	{#if !blocked}
		<div class="composer-meta">
			<p
				class="composer-status"
				id="composer-status"
				aria-live="polite"
				data-tone={overCap ? 'error' : undefined}
			>
				{#if overCap}
					{overCap.reason} <span class="mono">{overCap.count}</span>
				{:else if composer.sending}
					Sending…
				{:else if !typed}
					Replying from {app.selected?.label ?? 'this phone'}
				{/if}
			</p>

			{#if typed}
				<SegmentMeter body={composer.draft} />
			{/if}
		</div>
	{/if}
</footer>
