<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import Icon from '$lib/components/Icon.svelte';
	import { app, type Message } from '$lib/stores/app.svelte';
	import { formatClock, formatDay } from '$lib/device-state';
	import { sendStateTone, sendStateWord } from '$lib/message-state';

	const rawPeer = $derived(page.params.peer ?? '');
	const peer = $derived(decodePeer(rawPeer));
	const hasDevice = $derived(Boolean(app.selected));
	const canRead = $derived(app.backendAvailable && hasDevice);

	let messages = $state<Message[]>([]); // newest first while paging
	let hasMore = $state(false);
	let loading = $state(true);
	let loadingOlder = $state(false);
	let ready = $state(false);
	let started = $state(false);
	let error = $state<string | null>(null);
	let scroller: HTMLElement | null = null;

	type Row = { kind: 'day'; key: string; label: string } | { kind: 'message'; message: Message };

	const rows = $derived.by(() => {
		const out: Row[] = [];
		let lastDay = '';
		for (const message of messages.slice().reverse()) {
			const date = new Date(message.created_at);
			const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
			if (key !== lastDay) {
				out.push({ kind: 'day', key, label: formatDay(message.created_at) });
				lastDay = key;
			}
			out.push({ kind: 'message', message });
		}
		return out;
	});

	const PAGE = 50;
	// Each page is the whole device thread, so a quiet peer can need several pages
	// before one of its messages appears. The cap keeps one tap bounded; the
	// button stays available when the cap was the reason we stopped.
	const MAX_PAGES = 40;

	function decodePeer(value: string): string {
		try {
			return decodeURIComponent(value);
		} catch {
			return value;
		}
	}

	async function fetchPeerPages(start: Message | null, stopAtFirst: boolean) {
		const collected: Message[] = [];
		let cursor = start;
		let more = hasMore;
		let pages = 0;

		while (pages < MAX_PAGES) {
			const result = await app.pageMessages(cursor, PAGE);
			pages += 1;
			if (result.messages.length === 0) {
				more = result.has_more;
				break;
			}
			cursor = result.messages[result.messages.length - 1];
			for (const message of result.messages) {
				if (message.peer === peer) collected.push(message);
			}
			more = result.has_more;
			if (!more) break;
			if (stopAtFirst && collected.length > 0) break;
			if (!stopAtFirst && collected.length >= PAGE) break;
		}

		return { collected, cursor, more };
	}

	async function scrollToNewest() {
		scroller ??= document.querySelector<HTMLElement>('.app-main');
		if (!scroller) return;
		scroller.scrollTop = scroller.scrollHeight;
		ready = true;
	}

	async function loadInitial() {
		loading = true;
		error = null;
		try {
			const result = await fetchPeerPages(null, false);
			messages = result.collected;
			hasMore = result.more;
			await tick();
			await scrollToNewest();
		} catch (failure) {
			error = String(failure);
		} finally {
			loading = false;
		}
	}

	async function loadOlder() {
		if (loadingOlder || !hasMore) return;
		loadingOlder = true;
		error = null;
		const before = scroller?.scrollHeight ?? 0;
		try {
			const cursor = messages[messages.length - 1] ?? null;
			const result = await fetchPeerPages(cursor, true);
			messages = [...messages, ...result.collected];
			hasMore = result.more;
			await tick();
			if (scroller) scroller.scrollTop += scroller.scrollHeight - before;
		} catch (failure) {
			error = String(failure);
		} finally {
			loadingOlder = false;
		}
	}

	function onScroll() {
		if (!ready || loading || loadingOlder || !hasMore || !scroller) return;
		if (scroller.scrollTop > 8) return;
		// A conversation shorter than the viewport has no scroll gesture; the
		// button at the top of the thread remains the control.
		if (scroller.scrollHeight <= scroller.clientHeight + 8) return;
		void loadOlder();
	}

	function goBack() {
		// Replace the conversation entry rather than pushing another one: the
		// dock stays on Threads and Android's own back then exits the app.
		void goto('/messages', { replaceState: true });
	}

	$effect(() => {
		if (started) return;
		if (app.loading.boot || !canRead) return;
		started = true;
		void loadInitial();
	});

	onMount(() => {
		scroller = document.querySelector<HTMLElement>('.app-main');
		scroller?.addEventListener('scroll', onScroll, { passive: true });
		return () => scroller?.removeEventListener('scroll', onScroll);
	});
</script>

<svelte:head>
	<title>{peer} · DakFlare</title>
</svelte:head>

<section class="screen conversation-screen">
	<header class="conv-head">
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
			<h1 class="mono">{peer}</h1>
			<p class="conv-sub">as this phone</p>
		</div>
	</header>

	{#if !app.backendAvailable}
		<section class="empty-state" aria-labelledby="conv-no-backend">
			<span class="empty-icon"><Icon name="alert" size={26} /></span>
			<h2 id="conv-no-backend">The local database is not reachable</h2>
			<p>
				This window has no Tauri backend, so there is no phone database to read. Open the
				Android build, or the desktop shell, to see the conversation.
			</p>
		</section>
	{:else if !hasDevice}
		<section class="empty-state" aria-labelledby="conv-no-device">
			<span class="empty-icon"><Icon name="threads" size={26} /></span>
			<h2 id="conv-no-device">No device identity yet</h2>
			<p>This phone has no keypair, so nothing has been received under its own identity.</p>
			<a class="text-link" href="/settings">Create an identity in Settings</a>
		</section>
	{:else if loading}
		<p class="quiet-state">Opening the conversation…</p>
	{:else if error && messages.length === 0}
		<div class="notice" data-tone="error" role="alert">{error}</div>
		<button class="btn wide" type="button" onclick={() => void loadInitial()}>
			Try again
		</button>
	{:else if rows.length === 0}
		<section class="empty-state" aria-labelledby="conv-empty">
			<span class="empty-icon"><Icon name="threads" size={26} /></span>
			<h2 id="conv-empty">No messages yet</h2>
			<p>Messages to this SIM show up here. Replies go out in the same thread.</p>
			<a class="text-link" href="/messages">Back to Threads</a>
		</section>
	{:else}
		<div class="chat-wrap">
			<div class="chat-tools">
				{#if hasMore}
					<button
						class="btn quiet load-older"
						type="button"
						onclick={() => void loadOlder()}
						disabled={loadingOlder}
					>
						{loadingOlder ? 'Loading older messages…' : 'Load older messages'}
					</button>
				{:else}
					<p class="oldest-note">Oldest message in the local record.</p>
				{/if}
			</div>

			{#if error}
				<div class="notice" data-tone="error" role="alert">{error}</div>
			{/if}

			<ol class="chat" aria-label={`Messages with ${peer}, oldest first`}>
				{#each rows as row (row.kind === 'day' ? row.key : row.message.id)}
					{#if row.kind === 'day'}
						<li class="day-divider">{row.label}</li>
					{:else}
						<li class="bubble-row" data-dir={row.message.direction}>
							<div class="bubble">
								<p class="bubble-body">{row.message.body}</p>
								<p class="bubble-meta mono">
									{#if row.message.direction === 'out'}
										<span
											class="bubble-state"
											data-tone={sendStateTone(row.message.state)}
										>
											{sendStateWord(row.message.state)}
										</span>
									{/if}
									<time datetime={new Date(row.message.created_at).toISOString()}>
										{formatClock(row.message.created_at)}
									</time>
								</p>
							</div>
						</li>
					{/if}
				{/each}
			</ol>
		</div>
	{/if}
</section>
