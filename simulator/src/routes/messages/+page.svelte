<script lang="ts">
	import { onMount } from 'svelte';
	import Icon from '$lib/components/Icon.svelte';
	import Highlight from '$lib/components/Highlight.svelte';
	import DeviceSelect from '$lib/components/DeviceSelect.svelte';
	import { app, type Message } from '$lib/stores/app.svelte';
	import { formatWhen } from '$lib/device-state';
	import { sendStateTone, sendStateWord } from '$lib/message-state';

	type Thread = {
		peer: string;
		body: string;
		createdAt: number;
		direction: 'in' | 'out';
		state: string;
	};

	/** The store's own floor and cap, so the field never promises what it cannot. */
	const MIN_CHARS = 2;
	const MAX_HITS = 100;

	let query = $state('');
	let input = $state<HTMLInputElement | null>(null);
	let hits = $state<Message[]>([]);
	let truncated = $state(false);
	let searching = $state(false);
	let searchError = $state<string | null>(null);
	let debounce: ReturnType<typeof setTimeout> | null = null;
	/** Ignores a slow answer that a newer keystroke has already replaced. */
	let ticket = 0;

	const trimmed = $derived(query.trim());
	const active = $derived(trimmed.length >= MIN_CHARS);
	const tooShort = $derived(trimmed.length > 0 && !active);

	// Messages arrive newest first, so the first row for a peer is that thread's
	// last message; Map insertion order keeps the threads newest first.
	const threads = $derived.by(() => {
		const seen = new Map<string, Thread>();
		for (const message of app.messages) {
			if (seen.has(message.peer)) continue;
			seen.set(message.peer, {
				peer: message.peer,
				body: message.body,
				createdAt: message.created_at,
				direction: message.direction,
				state: message.state
			});
		}
		return [...seen.values()];
	});

	const countLabel = $derived(
		`${threads.length} ${threads.length === 1 ? 'thread' : 'threads'}${
			app.messagesHasMore ? ' so far' : ''
		}`
	);

	const matchLabel = $derived(
		`${hits.length}${truncated ? '+' : ''} ${hits.length === 1 && !truncated ? 'match' : 'matches'}`
	);

	const meta = $derived(
		app.selected
			? active
				? app.selected.label
				: `${app.selected.label} · ${countLabel}`
			: app.backendAvailable
				? 'no device identity'
				: 'local database'
	);

	// Search as the operator types, but not once per keystroke on a phone that
	// has a decade of history. 220 ms is short enough to feel immediate. The
	// device is a dependency: a switch re-reads the other phone's log.
	$effect(() => {
		const device = app.selectedId;
		const term = trimmed;

		if (debounce) clearTimeout(debounce);
		if (!active || !device) {
			ticket += 1;
			searching = false;
			searchError = null;
			hits = [];
			truncated = false;
			return;
		}

		searching = true;
		// A new term must not show the previous term's rows under it.
		hits = [];
		truncated = false;
		const mine = ++ticket;
		debounce = setTimeout(async () => {
			try {
				const result = await app.searchMessages(term, MAX_HITS);
				if (mine !== ticket) return;
				hits = result.messages;
				truncated = result.truncated;
				searchError = null;
			} catch (error) {
				if (mine !== ticket) return;
				hits = [];
				truncated = false;
				searchError = String(error);
			} finally {
				if (mine === ticket) searching = false;
			}
		}, 220);

		return () => {
			if (debounce) clearTimeout(debounce);
		};
	});

	// The rule may have run on the gateway tick while this page was in the
	// background. Re-read the newest page on return instead of keeping rows the
	// database no longer has.
	onMount(() => {
		const refresh = () => {
			if (document.visibilityState === 'visible' && app.backendAvailable) {
				void app.refreshSelected();
			}
		};
		document.addEventListener('visibilitychange', refresh);
		return () => document.removeEventListener('visibilitychange', refresh);
	});

	function clearSearch() {
		query = '';
		hits = [];
		truncated = false;
		searchError = null;
	}

	function onKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			clearSearch();
			input?.blur();
		}
	}

	/* ------------------------------------------------------------- snippets */

	/** A window around the first match; a long body is not printed whole. */
	function snippet(body: string, term: string, radius = 52): string {
		const at = body.toLowerCase().indexOf(term.toLowerCase());
		if (at < 0) return body.length > 96 ? `${body.slice(0, 96).trimEnd()}…` : body;
		const start = Math.max(0, at - radius);
		const end = Math.min(body.length, at + term.length + radius);
		return `${start > 0 ? '…' : ''}${body.slice(start, end)}${end < body.length ? '…' : ''}`;
	}
</script>

<svelte:head>
	<title>Threads · DakFlare</title>
</svelte:head>

<section class="screen">
	<header class="screen-head">
		<div>
			<p class="eyebrow">Inbox</p>
			<h1>Threads</h1>
			<p class="screen-meta">{meta}</p>
		</div>
		<div class="screen-actions">
			<button
				class="icon-btn"
				type="button"
				aria-label="Refresh threads"
				title="Reload the newest page from the local database"
				onclick={() => app.refreshSelected()}
				disabled={!app.backendAvailable || app.loading.messages}
			>
				<Icon name="refresh" size={20} />
			</button>
			<a
				class="icon-btn compose-open"
				href="/compose"
				aria-label="New message"
				title="Write to a number"
			>
				<Icon name="compose" size={20} />
			</a>
		</div>
	</header>

	{#if app.devices.length > 1}
		<DeviceSelect id="thread-device" label="Phone" compact />
	{/if}

	{#if app.backendAvailable && app.selected}
		<div class="search-field">
			<span class="search-icon" aria-hidden="true"><Icon name="search" size={18} /></span>
			<label class="sr-only" for="thread-search">Search messages by number or text</label>
			<input
				id="thread-search"
				bind:this={input}
				bind:value={query}
				type="search"
				placeholder="Search number or text"
				autocomplete="off"
				spellcheck="false"
				enterkeyhint="search"
				onkeydown={onKeydown}
			/>
			{#if query.length > 0}
				<button
					class="search-clear"
					type="button"
					aria-label="Clear search"
					title="Clear search"
					onclick={clearSearch}
				>
					<Icon name="close" size={16} />
				</button>
			{/if}
		</div>
	{/if}

	{#if app.loading.boot}
		<p class="quiet-state">Opening the local database…</p>
	{:else if !app.backendAvailable}
		<section class="empty-state" aria-labelledby="no-backend">
			<span class="empty-icon"><Icon name="alert" size={26} /></span>
			<h2 id="no-backend">The local database is not reachable</h2>
			<p>
				This window has no Tauri backend, so there is no phone database to read. Open the
				Android build, or the desktop shell, to see the thread.
			</p>
		</section>
	{:else if !app.selected}
		<section class="empty-state" aria-labelledby="no-device">
			<span class="empty-icon"><Icon name="threads" size={26} /></span>
			<h2 id="no-device">No device identity yet</h2>
			<p>This phone has no keypair, so nothing has been received under its own identity.</p>
			<a class="text-link" href="/settings">Create an identity in Settings</a>
		</section>
	{:else if active}
		<div class="search-status" aria-live="polite">
			{#if searching}
				<span class="search-count mono">Searching…</span>
			{:else if searchError}
				<span class="search-count">Search is not available.</span>
				<span class="search-hint">{searchError}</span>
			{:else if hits.length === 0}
				<span class="search-count">No matches for “{trimmed}”.</span>
				<span class="search-hint">
					Search reads the number and the text of every message this phone still holds.
				</span>
				<button class="btn quiet small" type="button" onclick={clearSearch}>Clear search</button>
			{:else}
				<span class="search-count mono">{matchLabel}</span>
				<button class="btn quiet small end" type="button" onclick={clearSearch}>Clear</button>
				<span class="search-hint">
					{truncated ? 'Newest 100 shown. Narrow the search to see more.' : 'Newest first.'}
				</span>
			{/if}
		</div>

		{#if hits.length > 0}
			<ol class="hits" aria-label={`${matchLabel} for ${trimmed}`}>
				{#each hits as message (message.id)}
					<li>
						<a
							class="hit"
							href={`/messages/${encodeURIComponent(message.peer)}?at=${encodeURIComponent(
								message.id
							)}`}
						>
							<span class="hit-top">
								<span class="hit-peer mono">
									<Highlight text={message.peer} term={trimmed} />
								</span>
								<time class="hit-time" datetime={new Date(message.created_at).toISOString()}>
									{formatWhen(message.created_at)}
								</time>
							</span>
							<span class="hit-body">
								<Highlight text={snippet(message.body, trimmed)} term={trimmed} />
							</span>
							<span class="hit-foot">
								<span>{message.direction === 'in' ? 'Inbound' : 'Outbound'}</span>
								{#if message.direction === 'out'}
									<span class="state-chip" data-tone={sendStateTone(message.state)}>
										{sendStateWord(message.state)}
									</span>
								{/if}
							</span>
						</a>
					</li>
				{/each}
			</ol>
		{/if}
	{:else if tooShort}
		<p class="quiet-state">Type at least {MIN_CHARS} characters to search.</p>
	{:else if !app.messagesLoaded && app.loading.messages}
		<p class="quiet-state">Reading the local thread…</p>
	{:else if threads.length === 0}
		<section class="empty-state" aria-labelledby="no-thread">
			<span class="empty-icon"><Icon name="threads" size={26} /></span>
			<h2 id="no-thread">No messages yet</h2>
			<p>Messages to this SIM show up here. Replies go out in the same thread.</p>
			<a class="text-link" href="/flows">Inject a test message from Flows</a>
		</section>
	{:else}
		<ol class="threads" aria-label="Threads, newest first">
			{#each threads as thread (thread.peer)}
				<li>
					<a class="thread-row" href={`/messages/${encodeURIComponent(thread.peer)}`}>
						<span class="thread-mark" data-dir={thread.direction} aria-hidden="true">
							<Icon name={thread.direction === 'in' ? 'arrow-in' : 'arrow-out'} size={18} />
						</span>
						<span class="thread-main">
							<span class="thread-top">
								<span class="thread-peer mono">{thread.peer}</span>
								<time
									class="thread-time"
									datetime={new Date(thread.createdAt).toISOString()}
								>
									{formatWhen(thread.createdAt)}
								</time>
							</span>
							<span class="thread-preview">{thread.body}</span>
							<span class="thread-foot">
								<span class="thread-dir">
									{thread.direction === 'in' ? 'Inbound' : 'Outbound'}
								</span>
								{#if thread.direction === 'out'}
									<span class="state-chip" data-tone={sendStateTone(thread.state)}>
										{sendStateWord(thread.state)}
									</span>
								{/if}
							</span>
						</span>
					</a>
				</li>
			{/each}
		</ol>

		{#if app.messagesHasMore}
			<button
				class="btn quiet load-more"
				type="button"
				onclick={() => app.loadOlderMessages()}
				disabled={app.loading.messages}
			>
				{app.loading.messages ? 'Loading older messages…' : 'Load older messages'}
			</button>
		{/if}
	{/if}
</section>

<style>
	/* The one control on this screen that is not a navigation row. It sits on
	   the page surface rather than in a card, so the thread list keeps the
	   card and the search reads as a tool over it. */
	.search-field {
		display: grid;
		grid-template-columns: 20px minmax(0, 1fr) 48px;
		align-items: center;
		gap: 8px;
		margin-top: 12px;
		padding: 0 2px 0 12px;
		min-height: 52px;
		border: 1px solid var(--df-border-input);
		border-radius: 12px;
		background: var(--surface);
		transition: border-color 140ms ease-out;
	}

	/* The input has no ring of its own inside this pill, so the pill carries it;
	   a 1px border tint alone was the only cue before. */
	.search-field:focus-within {
		border-color: var(--df-border-focus);
		outline: 2px solid var(--df-border-focus);
		outline-offset: 2px;
	}

	.search-icon {
		display: grid;
		place-items: center;
		color: var(--ink-3);
	}

	.search-field input {
		min-height: 50px;
		padding: 0;
		border: 0;
		border-radius: 0;
		background: transparent;
		font-size: 14px;
	}

	.search-field input:focus {
		outline: none;
	}

	.search-field input::-webkit-search-cancel-button,
	.search-field input::-webkit-search-decoration {
		display: none;
	}

	.search-clear {
		display: grid;
		place-items: center;
		width: 48px;
		height: 48px;
		padding: 0;
		border: 0;
		border-radius: 999px;
		background: transparent;
		color: var(--ink-2);
		cursor: pointer;
	}

	.search-clear:active {
		background: var(--df-surface-press);
	}

	.search-status {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 4px 10px;
		margin-top: 14px;
	}

	.search-count {
		font-size: 12px;
		font-weight: 700;
		color: var(--ink);
		overflow-wrap: anywhere;
	}

	.search-count.mono {
		font-size: 12px;
	}

	.search-hint {
		flex: 1 1 100%;
		font-size: 11px;
		line-height: 1.45;
		color: var(--ink-3);
	}

	.search-status .btn {
		margin-left: 0;
		min-height: 36px;
	}

	.search-status .btn.end {
		margin-left: auto;
	}

	.hits {
		list-style: none;
		margin: 10px 0 0;
		padding: 0;
		border-top: 1px solid var(--line);
	}

	.hits > li {
		content-visibility: auto;
		contain-intrinsic-size: auto 84px;
	}

	.hit {
		display: block;
		padding: 10px 0 11px;
		border-bottom: 1px solid var(--line);
		color: inherit;
		text-decoration: none;
		-webkit-tap-highlight-color: transparent;
		transition: background-color 120ms ease-out;
	}

	.hit:hover {
		background: var(--df-surface-well);
	}

	.hit-top {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 8px;
	}

	.hit-peer {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 12.5px;
		font-weight: 600;
		color: var(--ink);
	}

	.hit-time {
		flex: none;
		font-family: var(--mono);
		font-size: 10px;
		color: var(--ink-3);
	}

	.hit-body {
		display: block;
		margin-top: 3px;
		font-size: 13px;
		line-height: 1.45;
		color: var(--ink-2);
		overflow-wrap: anywhere;
	}

	.hit-foot {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 4px;
		font-size: 10px;
		letter-spacing: 0.05em;
		text-transform: uppercase;
		color: var(--ink-3);
	}
</style>
