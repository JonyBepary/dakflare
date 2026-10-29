<script lang="ts">
	import { Switch } from 'bits-ui';
	import DeviceSelect from '$lib/components/DeviceSelect.svelte';
	import Notice from '$lib/components/Notice.svelte';
	import { app, type CachedFlow, type FlowRun } from '$lib/stores/app.svelte';
	import { formatWhen } from '$lib/device-state';
	import { runTone, runWord } from '$lib/flow-state';

	let sender = $state('+15550001111');
	let messageBody = $state('CODE 483920');

	const flowCount = $derived(app.cachedFlows.length);
	const runCount = $derived(app.flowRuns.length);
	// The run command is a flat page, capped at 100. When it comes back full,
	// an absent match means "none in this page", not "never ran".
	const runsSaturated = $derived(runCount >= 100);
	const meta = $derived(
		!app.backendAvailable
			? 'local database'
			: !app.selected
				? 'no device'
				: app.loading.flows && !app.flowsLoaded
					? 'reading the cache'
					: app.flowsError && !app.flowsLoaded
						? 'cache not readable'
						: `${flowCount} ${flowCount === 1 ? 'flow' : 'flows'} cached · ${runCount} ${
								runsSaturated ? 'latest runs' : runCount === 1 ? 'run' : 'runs'
							}`
	);

	// Runs are newest first; the first row for a flow id and version is its latest.
	const latestRuns = $derived.by(() => {
		const seen = new Map<string, FlowRun>();
		for (const run of app.flowRuns) {
			const key = `${run.flow_id}@${run.flow_version}`;
			if (!seen.has(key)) seen.set(key, run);
		}
		return seen;
	});

	function latestRun(flow: CachedFlow): FlowRun | null {
		return latestRuns.get(`${flow.id}@${flow.version}`) ?? null;
	}

	$effect(() => {
		if (app.loading.boot || !app.backendAvailable) return;
		void app.loadFlows(app.selectedId);
	});

	function submitInject(event: SubmitEvent) {
		event.preventDefault();
		if (!app.selectedId) return;
		void app.inject(sender, messageBody);
	}
</script>

<svelte:head>
	<title>Flows · DakFlare</title>
</svelte:head>

<section class="screen">
	<header class="screen-head">
		<div>
			<p class="eyebrow">Automation</p>
			<h1>Flows</h1>
			<p class="screen-meta">{meta}</p>
		</div>
		<span class="pill">{app.selected ? (app.selected.sim_slot === 0 ? 'sim 0' : `sim ${app.selected.sim_slot}`) : 'no device'}</span>
	</header>

	<section class="statement" aria-label="How flows answer">
		<p>
			<strong>Flows answer on this phone.</strong> Rules run on the gateway; the phone executes
			only the flows it has cached, and one reply leaves per message.
		</p>
	</section>

	<section class="sheet" aria-labelledby="cached-flows-title">
		<div class="sheet-head">
			<h2 class="sheet-title" id="cached-flows-title">Cached flows</h2>
			<span class="pill">
				{app.flowsLoaded
					? flowCount === 0
						? 'none'
						: `${flowCount} on this phone`
					: 'reading'}
			</span>
		</div>

		{#if !app.backendAvailable}
			<p class="quiet-state">The local database is not reachable in this window.</p>
		{:else if !app.flowsLoaded && app.loading.flows}
			<p class="quiet-state">Reading the cached flows…</p>
		{:else if app.flowsError && !app.flowsLoaded}
			<div class="empty-inline">
				<p><strong>The cached flows could not be read.</strong></p>
				<p class="mono note">{app.flowsError}</p>
			</div>
		{:else if app.cachedFlows.length === 0}
			<div class="empty-inline">
				<p><strong>No flows cached yet.</strong></p>
				<p>
					Flows arrive with an inbound message that syncs with the gateway. This phone runs
					only the ones it has cached.
				</p>
				{#if app.flowsError}
					<p class="note">{app.flowsError}</p>
				{/if}
				<p class="mono note">flows · cache empty</p>
			</div>
		{:else}
			<ul class="flow-list" aria-label="Cached flows, with their latest run">
				{#each app.cachedFlows as flow (flow.id + '@' + flow.version)}
					{@const run = latestRun(flow)}
					<li class="flow-row">
						<div class="flow-head">
							<span class="flow-id mono">{flow.id}</span>
							<span class="pill">v{flow.version}</span>
						</div>
						<p class="flow-meta mono">
							{#if flow.node_count === null}
								graph unreadable
							{:else}
								{flow.node_count}
								{flow.node_count === 1 ? 'node' : 'nodes'}
							{/if}
							· fetched {formatWhen(flow.fetched_at)}
						</p>
						<p class="flow-run">
							<span class="flow-run-label">last run</span>
							{#if !app.selected}
								<span class="muted">runs need a device identity</span>
							{:else if run}
								<span class="state-chip" data-tone={runTone(run.outcome)}>{runWord(run.outcome)}</span>
								<time class="mono muted" datetime={new Date(run.created_at).toISOString()}>
									{formatWhen(run.created_at)}
								</time>
							{:else if runsSaturated}
								<span class="muted">no run in the last 100</span>
							{:else}
								<span class="muted">never ran</span>
							{/if}
						</p>
					</li>
				{/each}
			</ul>
			{#if app.flowsError}
				<p class="note">The latest read failed; these rows are the last cache the phone showed. {app.flowsError}</p>
			{/if}
		{/if}

		<button
			class="btn wide"
			type="button"
			onclick={() => app.syncFlows()}
			disabled={!app.backendAvailable ||
				!app.selectedId ||
				!app.configured ||
				app.offline ||
				app.busy.sync ||
				app.busy.drain}
		>
			{app.busy.sync || app.busy.drain ? 'Syncing…' : 'Sync now'}
		</button>
		<p class="note">Sync now refreshes the cached flows and checks for queued replies.</p>
	</section>

	<Notice scope="flows" />

	<section class="sheet" aria-labelledby="carrier-title">
		<div class="sheet-head">
			<h2 class="sheet-title" id="carrier-title">Carrier simulator</h2>
			<span class="pill" data-state={app.offline ? 'offline' : 'live'}>
				{app.offline ? 'offline' : 'online'}
			</span>
		</div>

		<p class="note">
			Inbound messages are injected here and outbound commands are captured from the queue; the
			native SMS layer is not wired up yet.
		</p>

		<DeviceSelect id="carrier-device" label="Device" compact />

		<div class="switch-row">
			<div>
				<span class="label">Offline mode</span>
				<p class="switch-copy">
					{app.offline
						? 'Offline — injects are stored locally only.'
						: 'Online — injects upload over the signed endpoint.'}
				</p>
			</div>
			<Switch.Root
				checked={app.offline}
				onCheckedChange={(value: boolean) => void app.setOffline(value)}
				aria-label="Simulate offline carrier"
				disabled={!app.selectedId || app.busy.offline}
			>
				<Switch.Thumb />
			</Switch.Root>
		</div>

		<form onsubmit={submitInject}>
			<div class="field">
				<label for="carrier-sender">From</label>
				<input
					id="carrier-sender"
					bind:value={sender}
					autocomplete="off"
					spellcheck="false"
					placeholder="+15550001111"
				/>
			</div>
			<div class="field">
				<label for="carrier-body">Message</label>
				<input
					id="carrier-body"
					bind:value={messageBody}
					autocomplete="off"
					placeholder="CODE 483920"
				/>
			</div>

			<div class="form-actions">
				<button
					class="btn primary"
					type="submit"
					disabled={!app.selectedId || app.busy.inject || app.busy.offline}
				>
					{app.busy.inject ? 'Injecting…' : 'Inject inbound'}
				</button>
				<button
					class="btn"
					type="button"
					onclick={() => app.drain('flows')}
					disabled={!app.selectedId || !app.configured || app.offline || app.busy.drain}
				>
					{app.busy.drain ? 'Polling…' : 'Poll outbox'}
				</button>
				<button
					class="btn quiet"
					type="button"
					onclick={() => app.clearThread()}
					disabled={!app.selectedId || app.busy.clear}
				>
					Clear thread
				</button>
			</div>
		</form>

		<p class="note">
			The thread itself lives in <a class="inline-link" href="/messages" data-sveltekit-replacestate>Threads</a>. Clearing
			here removes local rows only.
		</p>
	</section>
</section>
