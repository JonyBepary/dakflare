<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import Icon from '$lib/components/Icon.svelte';
	import { app, type Message } from '$lib/stores/app.svelte';
	import { composer } from '$lib/stores/composer.svelte';
	import { formatClock, formatDay } from '$lib/device-state';
	import { sendStateTone, sendStateWord } from '$lib/message-state';
	import { decodePeer } from '$lib/reply-target';

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
	let pinned = true;

	/** A real row, or one the composer wrote and the database has not returned yet. */
	type Bubble = Message & { pending?: boolean };
	type Row = { kind: 'day'; key: string; label: string } | { kind: 'message'; message: Bubble };

	// Optimistic rows for this peer. One is dropped as soon as the thread holds
	// the same body from an outbound row, so a re-read never paints a duplicate.
	const optimistic = $derived.by<Bubble[]>(() => {
		return composer
			.pendingFor(peer)
			.filter(
				(row) =>
					!messages.some(
						(message) =>
							message.direction === 'out' &&
							message.body === row.body &&
							message.created_at >= row.created_at - 60_000
					)
			)
			.map((row) => ({
				id: row.key,
				device_id: app.selectedId,
				direction: 'out' as const,
				peer: row.peer,
				body: row.body,
				state: 'queued',
				local_id: null,
				created_at: row.created_at,
				pending: true
			}));
	});

	const rows = $derived.by(() => {
		const out: Row[] = [];
		let lastDay = '';
		for (const message of [...messages.slice().reverse(), ...optimistic]) {
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
		// Rows carry `content-visibility: auto`, so a row's real height lands on
		// the first paint rather than at scroll time. One more frame puts the
		// newest row flush against the composer instead of 24px short.
		requestAnimationFrame(() => {
			const node = scroller;
			if (!node) return;
			if (node.scrollHeight - node.scrollTop - node.clientHeight < 160) {
				node.scrollTop = node.scrollHeight;
			}
		});
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

	/**
	 * Re-read the newest page without blanking the thread: rows we already have
	 * are replaced in place (a queued row becomes sent, a failed one fails), and
	 * rows we do not have are prepended. This is what turns the composer's
	 * optimistic row into the database's real one.
	 */
	async function refreshNewest() {
		const atBottom = scroller
			? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48
			: true;
		const result = await fetchPeerPages(null, true);
		const known = new Set(messages.map((message) => message.id));
		const incoming = new Map(result.collected.map((message) => [message.id, message]));
		const updated = messages.map((message) => incoming.get(message.id) ?? message);
		const fresh = result.collected.filter((message) => !known.has(message.id));
		messages = [...fresh, ...updated];
		await tick();
		if (atBottom) await scrollToNewest();
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
		if (scroller) {
			// Stay pinned to the newest message while the bar or the keyboard
			// changes the height of the thread, until the user scrolls away.
			pinned = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48;
		}
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

	// The composer lives in the shell; the route lends it the thread it writes to.
	$effect(() => composer.bind(refreshNewest));

	$effect(() => {
		composer.repliesOpen = loading || rows.length > 0;
	});

	// A row the user just wrote must be visible, even when the thread was longer
	// than the viewport before the tap.
	let pendingSeen = 0;
	$effect(() => {
		const count = composer.pendingFor(peer).length;
		if (count === pendingSeen) return;
		pendingSeen = count;
		if (count === 0) return;
		void (async () => {
			await tick();
			await scrollToNewest();
		})();
	});

	onMount(() => {
		scroller = document.querySelector<HTMLElement>('.app-main');
		scroller?.addEventListener('scroll', onScroll, { passive: true });
		// A taller composer or an open keyboard shrinks the thread; a reader
		// sitting at the newest message should keep seeing it. The content is
		// watched separately because rows carry `content-visibility`, so their
		// real heights arrive after the scroll, not during it.
		const observer = new ResizeObserver(() => {
			if (pinned) void scrollToNewest();
		});
		if (scroller) observer.observe(scroller);
		const content = scroller?.querySelector('.screen');
		if (content) observer.observe(content);
		return () => {
			observer.disconnect();
			scroller?.removeEventListener('scroll', onScroll);
		};
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
						<li
							class="bubble-row"
							data-dir={row.message.direction}
							data-pending={row.message.pending ? 'true' : undefined}
						>
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
