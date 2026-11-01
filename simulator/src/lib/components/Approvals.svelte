<script lang="ts">
	import { onMount } from 'svelte';
	import Notice from '$lib/components/Notice.svelte';
	import { app } from '$lib/stores/app.svelte';
	import { countdown, durationWords, rungBlocked, scopePhrase, targetWords } from '$lib/approvals';

	let now = $state(Date.now());
	/** The rung currently being sent, per request, so only that control says so. */
	let sending = $state<Record<string, number>>({});

	async function approve(approvalId: string, rung: number) {
		sending[approvalId] = rung;
		try {
			await app.approve(approvalId, rung);
		} finally {
			delete sending[approvalId];
		}
	}

	onMount(() => {
		const clock = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(clock);
	});

	// Selecting another identity must not leave the previous phone's requests
	// on screen, so the list follows `selectedId` and is re-read from the
	// deployment rather than filtered locally.
	$effect(() => {
		void app.loadApprovals(app.selectedId);
	});
</script>

<section class="sheet approvals" aria-labelledby="approvals-title">
	<div class="sheet-head">
		<h2 class="sheet-title" id="approvals-title">Approvals</h2>
		<span class="pill" data-state={app.approvals.length > 0 ? 'live' : 'unknown'}>
			{app.approvals.length > 0
				? `${app.approvals.length} waiting`
				: app.approvalsLoaded
					? 'nothing waiting'
					: 'reading'}
		</span>
	</div>

	<Notice scope="approvals" />

	{#if app.approvalsError && app.approvals.length > 0}
		<p class="note" role="alert">Refresh failed: {app.approvalsError}</p>
	{/if}

	{#if !app.approvalsLoaded && app.loading.approvals}
		<p class="quiet-state">Reading pending requests…</p>
	{:else if app.approvalsError && app.approvals.length === 0}
		<div class="empty-inline">
			<p><strong>The list could not be read.</strong></p>
			<p>{app.approvalsError}</p>
			<button class="btn wide" type="button" onclick={() => app.loadApprovals()}>
				Refresh the list
			</button>
		</div>
	{:else if app.approvals.length === 0}
		<div class="empty-inline">
			<p><strong>No requests waiting.</strong></p>
			<p>
				When an agent asks this phone to send SMS, the request appears here with a list of
				durations to choose from.
			</p>
		</div>
	{:else}
		{#each app.approvals as approval (approval.id)}
			{@const expired = approval.expires_at <= now}
			{@const busy = app.approvalBusy[approval.id] ?? false}
			{@const sendingRung = sending[approval.id]}
			{@const blocked = approval.ladder_s.filter((rung) => rungBlocked(rung, approval.max_s))}
			<article class="approval" aria-labelledby={`approval-${approval.id}`}>
				<p class="eyebrow">Request</p>
				<h3 id={`approval-${approval.id}`}>
					Agent asks to {scopePhrase(approval.scope)}
					<span class="approval-target">{targetWords(approval.target)}</span>
				</h3>
				<p class="approval-meta">
					<span class="mono">Requested {new Date(approval.requested_at).toLocaleTimeString()}</span>
					<span class="approval-countdown" data-expired={expired}>
						{expired ? 'Expired' : `Expires in ${countdown(approval.expires_at, now)}`}
					</span>
				</p>

				{#if approval.reason}
					<p class="approval-reason">{approval.reason}</p>
				{/if}

				{#if expired}
					<p class="note">
						This request has expired. Refresh the list to see whether the agent asked again.
					</p>
				{:else}
					<p class="approval-prompt">How long should it be allowed?</p>
					<div class="ladder">
						{#each approval.ladder_s as rung (rung)}
							<button
								class="btn ladder-rung"
								type="button"
								disabled={busy || rungBlocked(rung, approval.max_s)}
								aria-describedby={rungBlocked(rung, approval.max_s)
									? `ceiling-${approval.id}`
									: undefined}
								onclick={() => approve(approval.id, rung)}
							>
								{sendingRung === rung ? 'Approving…' : durationWords(rung)}
							</button>
						{/each}
					</div>
					{#if blocked.length > 0}
						<p class="note" id={`ceiling-${approval.id}`}>
							This scope allows at most {durationWords(approval.max_s)}. The longer
							options are shown so the ceiling is visible, but they cannot be granted.
						</p>
					{/if}
					<div class="approval-actions">
						<button
							class="btn quiet wide"
							type="button"
							disabled={busy}
							onclick={() => app.rejectApproval(approval.id)}
						>
							Reject request
						</button>
					</div>
				{/if}
			</article>
		{/each}

		<button
			class="btn quiet wide refresh-approvals"
			type="button"
			disabled={app.loading.approvals}
			onclick={() => app.loadApprovals()}
		>
			{app.loading.approvals ? 'Refreshing…' : 'Refresh the list'}
		</button>
	{/if}
</section>
