<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import DeviceSelect from '$lib/components/DeviceSelect.svelte';
	import { app } from '$lib/stores/app.svelte';
	import { formatWhen } from '$lib/device-state';
	import { sendStateTone, sendStateWord } from '$lib/message-state';

	type Thread = {
		peer: string;
		body: string;
		createdAt: number;
		direction: 'in' | 'out';
		state: string;
	};

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

	const meta = $derived(
		app.selected
			? `${app.selected.label} · ${countLabel}`
			: app.backendAvailable
				? 'no device identity'
				: 'local database'
	);
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
