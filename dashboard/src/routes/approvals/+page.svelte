<script lang="ts">
	import { onMount } from 'svelte';
	import {
		ApiError,
		approveApproval,
		describeError,
		getApprovals,
		getDevices,
		rejectApproval
	} from '$lib/api';
	import {
		countdownLabel,
		durationWords,
		listWords,
		rungLabel,
		scopeCapNote,
		scopeTitle
	} from '$lib/approvals';
	import { consoleCounts } from '$lib/console-counts.svelte';
	import { formatAbsolute, formatClock } from '$lib/format';
	import { ROUTES } from '$lib/paths';
	import { session } from '$lib/session.svelte';
	import type { ApprovalDecision, ApprovalRequest, Device } from '$lib/types';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import Notice from '$lib/components/Notice.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import RelativeTime from '$lib/components/RelativeTime.svelte';
	import Spinner from '$lib/components/Spinner.svelte';

	/*
	 * `GET /v1/admin/approvals?state=PENDING` is the queue; the two POSTs answer
	 * one row. Nothing here trusts its own copy of a request: the list is polled,
	 * every action refreshes it, and a row that was answered elsewhere shows up
	 * as a stale-decision error rather than a success.
	 *
	 * The ladder and the ceiling come from each row. A rung above `max_s` stays
	 * on screen and says why it is unavailable, so the operator learns the policy
	 * instead of wondering where the menu went.
	 */

	const POLL_MS = 15_000;
	/** A countdown needs seconds; the list itself does not. */
	const TICK_MS = 1_000;
	/** After an expiry, ask the list to catch up at most this often. */
	const SWEEP_MS = 10_000;

	interface TargetRow {
		kind: string;
		value: string;
		mono: boolean;
		note: string | null;
	}

	interface Outcome {
		key: number;
		tone: 'ok' | 'info' | 'warn';
		title: string;
		body: string;
	}

	interface Deciding {
		id: string;
		choice: 'approve' | 'reject';
		durationS?: number;
	}

	let approvals = $state<ApprovalRequest[]>([]);
	let devicesById = $state<Map<string, Device>>(new Map());
	let loading = $state(true);
	let loaded = $state(false);
	let refreshing = $state(false);
	let error = $state<string | null>(null);
	let listUpdatedAt = $state<number | null>(null);
	let now = $state(Date.now());
	let deciding = $state<Deciding | null>(null);
	let cardErrors = $state<Record<string, string>>({});
	let outcome = $state<Outcome | null>(null);

	let version = 0;
	let outcomeKey = 0;
	let lastSweep = 0;

	const allowed = $derived(session.canViewSecurity);

	async function load(soft = false): Promise<void> {
		const current = ++version;
		if (soft) refreshing = true;
		else if (!loaded) loading = true;

		try {
			const pending = await getApprovals('PENDING');
			if (current !== version) return;
			approvals = pending;
			loaded = true;
			error = null;
			listUpdatedAt = Date.now();
			consoleCounts.noteApprovals(pending.length);
		} catch (failure) {
			if (current !== version) return;
			error = describeError(failure);
		} finally {
			if (current === version) {
				loading = false;
				refreshing = false;
			}
		}
	}

	async function loadDevices(): Promise<void> {
		try {
			const fleet = await getDevices();
			devicesById = new Map(fleet.map((device) => [device.device_id, device]));
		} catch {
			// A friendly handset name is a convenience; the id is still shown.
		}
	}

	function removeApproval(id: string): void {
		approvals = approvals.filter((approval) => approval.id !== id);
		consoleCounts.noteApprovals(approvals.length);
	}

	function setCardError(id: string, message: string): void {
		cardErrors = { ...cardErrors, [id]: message };
	}

	function clearCardError(id: string): void {
		if (!(id in cardErrors)) return;
		const next = { ...cardErrors };
		delete next[id];
		cardErrors = next;
	}

	function isStaleDecision(failure: unknown): boolean {
		if (!(failure instanceof ApiError)) return false;
		return (
			failure.status === 404 ||
			failure.status === 409 ||
			failure.code === 'expired' ||
			failure.code === 'not_pending'
		);
	}

	function decisionError(failure: unknown): string {
		if (failure instanceof ApiError && failure.status === 403) {
			return 'This account can read the queue but cannot answer it. Ask an owner to decide.';
		}
		const message = describeError(failure);
		if (failure instanceof ApiError) {
			// These already end with the step that clears them, and retrying is not it.
			const settled = ['not_pending', 'expired', 'not_grantable', 'bad_target', 'not_found'];
			if (failure.status === 0 || settled.includes(failure.code ?? '')) return message;
		}
		return `${message} Try again, or answer from the CLI if this keeps failing.`;
	}

	function targetRows(approval: ApprovalRequest): TargetRow[] {
		const target = approval.target;
		if (!target) return [];
		const rows: TargetRow[] = [];

		if (target.recipients && target.recipients.length > 0) {
			rows.push({
				kind: target.recipients.length === 1 ? 'Number' : 'Numbers',
				value: target.recipients.join(', '),
				mono: true,
				note: null
			});
		}
		if (target.device_id) {
			const device = devicesById.get(target.device_id);
			const label = device?.label?.trim() ?? '';
			rows.push({
				kind: 'Handset',
				value: label === '' ? target.device_id : label,
				mono: label === '',
				note: label === '' ? null : target.device_id
			});
		}
		if (target.flow_id) {
			rows.push({ kind: 'Flow', value: target.flow_id, mono: true, note: null });
		}
		if (target.rule_id) {
			rows.push({ kind: 'Rule', value: target.rule_id, mono: true, note: null });
		}
		return rows;
	}

	function blockedRungs(approval: ApprovalRequest): number[] {
		const max = approval.max_s;
		if (max === null) return [...approval.ladder_s];
		return approval.ladder_s.filter((rung) => rung > max);
	}

	function rungUnavailable(approval: ApprovalRequest, rung: number): boolean {
		const max = approval.max_s;
		return max === null || rung > max || approval.expires_at <= now;
	}

	function capText(approval: ApprovalRequest): string | null {
		if (approval.max_s === null) {
			return 'This gateway has no grant ceiling for this permission, so it cannot be approved. Reject the request and ask the agent to request a permission the gateway can grant.';
		}
		const blocked = blockedRungs(approval);
		if (blocked.length === 0) return null;
		const cap = scopeCapNote(approval.scope, approval.max_s);
		const names = listWords(blocked.map(rungLabel));
		const verb = blocked.length === 1 ? 'is' : 'are';
		return `${cap ?? ''} ${names} ${verb} unavailable.`.trim();
	}

	function approvedOutcome(result: ApprovalDecision, approval: ApprovalRequest): Outcome {
		const grantedWords =
			result.granted_s === null ? 'the requested period' : durationWords(result.granted_s);
		const expiresAt = result.grant?.expires_at;
		const expires = expiresAt ? `The grant expires ${formatAbsolute(expiresAt)}.` : '';

		if (result.clamped) {
			const asked =
				result.requested_s === null
					? null
					: `You asked for ${durationWords(result.requested_s)}.`;
			const granted = `The gateway granted ${grantedWords}.`;
			const cap = scopeCapNote(approval.scope, result.max_s);
			return {
				key: ++outcomeKey,
				tone: 'warn',
				title: 'Approval granted for less time',
				body: [asked ?? '', granted, cap ?? '', expires].filter(Boolean).join(' ')
			};
		}

		return {
			key: ++outcomeKey,
			tone: 'ok',
			title: 'Approval granted',
			body: `${scopeTitle(approval.scope)}: approved for ${grantedWords}. ${expires}`.trim()
		};
	}

	function rejectedOutcome(approval: ApprovalRequest): Outcome {
		return {
			key: ++outcomeKey,
			tone: 'info',
			title: 'Request rejected',
			body: `${scopeTitle(approval.scope)}: rejected. No permission was granted, and the request is closed.`
		};
	}

	async function decide(
		approval: ApprovalRequest,
		choice: 'approve' | 'reject',
		rung?: number
	): Promise<void> {
		if (deciding !== null) return;
		if (choice === 'approve') {
			if (rung === undefined || rungUnavailable(approval, rung)) return;
		}

		deciding = { id: approval.id, choice, ...(rung === undefined ? {} : { durationS: rung }) };
		clearCardError(approval.id);

		try {
			if (choice === 'approve' && rung !== undefined) {
				const result = await approveApproval(approval.id, rung);
				if (result.ok !== true) {
					throw new Error(
						'The gateway did not confirm the approval. Refresh the queue before telling the agent it can proceed.'
					);
				}
				if (result.grant === null) {
					setCardError(
						approval.id,
						'The gateway accepted the answer but returned no grant, so nothing is allowed yet. Refresh the queue and check again.'
					);
					void load(true);
					return;
				}
				removeApproval(approval.id);
				outcome = approvedOutcome(result, approval);
			} else {
				const result = await rejectApproval(approval.id);
				if (result.ok !== true) {
					throw new Error(
						'The gateway did not confirm the rejection. Refresh the queue before assuming the request is closed.'
					);
				}
				removeApproval(approval.id);
				outcome = rejectedOutcome(approval);
			}
			void load(true);
		} catch (failure) {
			setCardError(approval.id, decisionError(failure));
			if (isStaleDecision(failure)) {
				// The card may disappear with the refresh, so the explanation cannot
				// live on it alone. This notice survives the row it was about.
				const expired = failure instanceof ApiError && failure.code === 'expired';
				outcome = {
					key: ++outcomeKey,
					tone: 'warn',
					title: 'Nothing was granted',
					body: expired
						? 'The request expired before this action reached the gateway. The queue now shows the current state.'
						: 'Another answer reached the gateway first. The queue now shows the current state.'
				};
				void load(true);
			}
		} finally {
			deciding = null;
		}
	}

	async function refresh(): Promise<void> {
		now = Date.now();
		await load(true);
	}

	onMount(() => {
		void load();
		void loadDevices();

		const clockTimer = setInterval(() => {
			if (document.visibilityState !== 'visible') return;
			now = Date.now();
			const hasExpired = approvals.some((approval) => approval.expires_at <= now);
			if (!hasExpired || loading || refreshing) return;
			if (Date.now() - lastSweep < SWEEP_MS) return;
			lastSweep = Date.now();
			void load(true);
		}, TICK_MS);

		const pollTimer = setInterval(() => {
			if (
				document.visibilityState === 'visible' &&
				deciding === null &&
				!loading &&
				!refreshing
			) {
				void load(true);
			}
		}, POLL_MS);

		const onVisible = () => {
			if (document.visibilityState !== 'visible') return;
			now = Date.now();
			if (!loading && !refreshing) void load(true);
		};

		document.addEventListener('visibilitychange', onVisible);

		return () => {
			clearInterval(clockTimer);
			clearInterval(pollTimer);
			document.removeEventListener('visibilitychange', onVisible);
		};
	});
</script>

<svelte:head>
	<title>Approvals · DakFlare</title>
</svelte:head>

<div class="page">
	<PageHeader
		eyebrow="Security"
		title="Approvals"
		description="Agent requests that need a human answer. Approving opens the permission for the duration you pick. Rejecting closes the request without granting anything."
	>
		<button
			type="button"
			class="btn"
			onclick={() => void refresh()}
			disabled={loading || refreshing || deciding !== null || !allowed}
			aria-busy={refreshing}
		>
			{#if refreshing}<Spinner />{:else}<Icon name="refresh" size={14} />{/if}
			Refresh
		</button>
	</PageHeader>

	{#if !allowed}
		<section class="card">
			<EmptyState
				icon="shield"
				title="The approval queue is for owners and admins"
				description="Your account is a member. Ask an owner to approve or reject the agent's request."
			>
				<a class="btn btn-primary" href={ROUTES.overview}>Back to overview</a>
			</EmptyState>
		</section>
	{:else}
		<div class="grid-stack">
			{#if outcome}
				{#key outcome.key}
					<Notice tone={outcome.tone} title={outcome.title}>{outcome.body}</Notice>
				{/key}
			{/if}

			{#if loading && !loaded}
				<section class="card loading-card" aria-busy="true" aria-live="polite">
					<span class="sr-only">Loading approval requests</span>
					{#each ['a', 'b', 'c'] as key (key)}
						<div class="skeleton-row">
							<div class="skeleton" style="height: 12px; width: 88px"></div>
							<div class="skeleton" style="height: 22px; width: min(280px, 70%)"></div>
							<div class="skeleton" style="height: 52px; width: 100%"></div>
							<div class="skeleton" style="height: 34px; width: 320px; max-width: 100%"></div>
						</div>
					{/each}
				</section>
			{:else if !loaded}
				<section class="card">
					<Notice tone="danger" title="The approval queue did not load">
						{error ?? 'The gateway did not answer. Check the connection and try again.'}
					</Notice>
					<div class="row" style="margin-top: 16px">
						<button type="button" class="btn btn-primary" onclick={() => void load()}>
							<Icon name="refresh" size={14} /> Try again
						</button>
					</div>
					<p class="hint" style="margin-top: 12px">
						Until the gateway answers, requests can still be answered from the CLI:
						<code>dakflare auth approve &lt;id&gt; --for 15m</code>.
					</p>
				</section>
			{:else if error && approvals.length === 0}
				<section class="card">
					<Notice tone="warn" title="Could not refresh the queue">
						{error} The last successful read found no requests waiting, and this read failed, so
						the queue may have changed.
					</Notice>
					<div class="row" style="margin-top: 16px">
						<button type="button" class="btn btn-primary" onclick={() => void load(true)}>
							<Icon name="refresh" size={14} /> Try again
						</button>
					</div>
				</section>
			{:else if approvals.length === 0}
				<section class="card">
					<EmptyState
						icon="key"
						title="No requests are waiting"
						description="Agent requests to spend money or change production appear here, waiting for you to approve one for a set time or reject it."
					/>
				</section>
			{:else}
				{#if error}
					<Notice tone="warn" title="Could not refresh the queue">
						{error} The cards below are the last answer from the gateway, so an action may still
						fail. Refresh before you decide.
					</Notice>
				{/if}

				<div class="queue-head">
					<p class="queue-count">
						<strong>{approvals.length}</strong>
						{approvals.length === 1 ? 'request' : 'requests'} waiting
					</p>
					<p class="queue-updated mono">
						checked
						{#if listUpdatedAt}
							<RelativeTime value={listUpdatedAt} />
						{:else}
							not yet
						{/if}
					</p>
				</div>

				{#each approvals as approval (approval.id)}
					{@const title = scopeTitle(approval.scope)}
					{@const targets = targetRows(approval)}
					{@const remaining = approval.expires_at - now}
					{@const expired = remaining <= 0}
					{@const cap = capText(approval)}
					{@const busyApprove = deciding?.id === approval.id && deciding.choice === 'approve'}
					{@const busyReject = deciding?.id === approval.id && deciding.choice === 'reject'}
					{@const cardError = cardErrors[approval.id]}

					<article class="card approval" aria-labelledby={`approval-${approval.id}`}>
						<div class="approval-head">
							<div class="approval-main">
								<p class="eyebrow">Agent request</p>
								<h2 id={`approval-${approval.id}`}>{title}</h2>
							</div>

							<div
								class="expiry"
								class:soon={!expired && remaining < 5 * 60_000}
								class:urgent={!expired && remaining < 60_000}
								class:expired
							>
								<span class="expiry-label">Expires in</span>
								{#if expired}
									<span class="expiry-count">Expired</span>
								{:else}
									<time
										class="expiry-count mono"
										datetime={new Date(approval.expires_at).toISOString()}
										title={formatAbsolute(approval.expires_at)}
									>
										{countdownLabel(remaining)}
									</time>
								{/if}
								<span class="expiry-at mono">{formatClock(approval.expires_at)}</span>
							</div>
						</div>

						{#if targets.length > 0}
							<dl class="targets">
								{#each targets as row (`${row.kind}-${row.value}`)}
									<div class="target-row">
										<dt>{row.kind}</dt>
										<dd>
											<span class="target-value" class:mono={row.mono}>{row.value}</span>
											{#if row.note}
												<span class="target-note mono">{row.note}</span>
											{/if}
										</dd>
									</div>
								{/each}
							</dl>
						{:else}
							<div class="callout targets-missing" data-tone="warn">
								<Icon name="alert" size={15} />
								<div>No recipient, handset, flow or rule is named in this request.</div>
							</div>
						{/if}

						<p class="facts">
							<span class="fact">
								<span class="fact-label">Permission</span>
								<code>{approval.scope}</code>
							</span>
							<span class="fact-sep" aria-hidden="true">·</span>
							<span class="fact">
								<span class="fact-label">Agent token</span>
								<code>{approval.agent_token_id}</code>
							</span>
							<span class="fact-sep" aria-hidden="true">·</span>
							<span class="fact">
								<span class="fact-label">Asked</span>
								<RelativeTime value={approval.requested_at} />
							</span>
						</p>

						{#if approval.reason}
							<div class="reason">
								<span class="fact-label">Reason from the agent</span>
								<p>{approval.reason}</p>
							</div>
						{/if}

						{#if cardError}
							<p class="card-error" role="alert">
								<Icon name="alert" size={14} />
								<span>{cardError}</span>
							</p>
						{/if}

						<div class="decision">
							<div class="ladder-block">
								<span class="label" id={`ladder-${approval.id}`}>Approve for</span>
								<div class="ladder" role="group" aria-labelledby={`ladder-${approval.id}`}>
									{#each approval.ladder_s as rung (rung)}
										{@const overCap = approval.max_s === null || rung > approval.max_s}
										{@const unavailable = overCap || expired}
										{@const working = busyApprove && deciding?.durationS === rung}
										<button
											type="button"
											class="rung"
											class:working
											aria-disabled={unavailable ? 'true' : undefined}
											aria-describedby={overCap && cap !== null
												? `cap-${approval.id}`
												: undefined}
											aria-busy={working}
											aria-label={
												expired ? 'The request has expired' : `Approve for ${durationWords(rung)}`
											}
											title={expired
												? 'The request has expired'
												: `Approve for ${durationWords(rung)}`}
											onclick={() => void decide(approval, 'approve', rung)}
											disabled={deciding !== null}
										>
											{#if working}<Spinner />{:else}{rungLabel(rung)}{/if}
										</button>
									{/each}
								</div>
								{#if cap}
									<p class="cap-note" class:blocked={approval.max_s === null} id={`cap-${approval.id}`}>
										{cap}
									</p>
								{/if}
							</div>

							<button
								type="button"
								class="btn btn-danger-ghost btn-sm reject"
								onclick={() => void decide(approval, 'reject')}
								disabled={deciding !== null || expired}
								aria-busy={busyReject}
								aria-label={`Reject the ${title} request`}
							>
								{#if busyReject}<Spinner />{:else}<Icon name="x" size={13} />{/if}
								Reject
							</button>
						</div>
					</article>
				{/each}
			{/if}
		</div>
	{/if}
</div>

<style>
	.loading-card {
		display: flex;
		flex-direction: column;
		gap: var(--df-p-space-4);
	}

	.skeleton-row {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding-top: var(--df-p-space-4);
		border-top: 1px solid var(--df-border-hairline);
	}

	.skeleton-row:first-of-type {
		padding-top: 0;
		border-top: 0;
	}

	.queue-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--df-p-space-3);
		flex-wrap: wrap;
	}

	.queue-count {
		font-size: var(--df-p-text-base);
		color: var(--df-text-secondary);
	}

	.queue-count strong {
		margin-right: 2px;
		font-family: var(--df-font-display);
		font-size: var(--df-p-text-lg);
		color: var(--df-text-primary);
	}

	.queue-updated {
		font-size: 11px;
		color: var(--df-text-meta);
	}

	.approval {
		padding: 0;
		overflow: hidden;
	}

	.approval-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--df-p-space-4);
		padding: var(--df-p-space-5) var(--df-p-space-5) var(--df-p-space-3);
	}

	.approval-main {
		min-width: 0;
	}

	.approval h2 {
		margin-top: 4px;
		font-family: var(--df-font-display);
		font-size: var(--df-p-text-xl);
		font-weight: 700;
		line-height: 1.22;
		letter-spacing: -0.015em;
		overflow-wrap: anywhere;
	}

	.expiry {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 2px;
		flex: none;
		padding: 7px 11px;
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-sm);
		background: var(--df-surface-well);
	}

	.expiry-label {
		font-family: var(--df-p-font-mono);
		font-size: 10px;
		letter-spacing: 0.07em;
		text-transform: uppercase;
		color: var(--df-text-meta);
	}

	.expiry-count {
		font-size: var(--df-p-text-lg);
		font-weight: 700;
		line-height: 1.1;
		letter-spacing: -0.01em;
		color: var(--df-text-primary);
	}

	.expiry.soon .expiry-count {
		color: var(--df-state-warn-ink);
	}

	.expiry.urgent .expiry-count {
		color: var(--df-state-danger-ink);
	}

	.expiry.expired .expiry-count {
		color: var(--df-text-meta);
		font-size: var(--df-p-text-md);
	}

	.expiry-at {
		font-size: 10.5px;
		color: var(--df-text-meta);
	}

	.targets {
		display: grid;
		gap: 5px;
		margin: 0 var(--df-p-space-5);
		padding: var(--df-p-space-3);
		border-radius: var(--df-p-radius-md);
		background: var(--df-surface-well);
	}

	.target-row {
		display: flex;
		align-items: baseline;
		gap: var(--df-p-space-3);
		min-width: 0;
	}

	.target-row dt {
		flex: none;
		width: 62px;
		font-family: var(--df-p-font-mono);
		font-size: 10px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--df-text-meta);
	}

	.target-row dd {
		margin: 0;
		min-width: 0;
		font-size: var(--df-p-text-base);
		overflow-wrap: anywhere;
	}

	.target-value {
		font-weight: 600;
	}

	.target-note {
		margin-left: 6px;
		font-size: 10.5px;
		color: var(--df-text-meta);
	}

	.targets-missing {
		margin: 0 var(--df-p-space-5);
	}

	.facts {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: 3px 10px;
		margin: var(--df-p-space-3) var(--df-p-space-5) 0;
		font-size: 11.5px;
		color: var(--df-text-secondary);
	}

	.fact {
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.fact-label {
		margin-right: 4px;
		font-family: var(--df-p-font-mono);
		font-size: 10px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--df-text-meta);
	}

	.facts code {
		font-family: var(--df-p-font-mono);
		font-size: 11px;
	}

	.fact-sep {
		color: var(--df-border-control);
	}

	.reason {
		margin: var(--df-p-space-3) var(--df-p-space-5) 0;
		padding: 10px 12px;
		border-left: 2px solid var(--df-border-control);
		border-radius: 0 var(--df-p-radius-xs) var(--df-p-radius-xs) 0;
		background: var(--df-surface-well);
	}

	.reason p {
		margin-top: 3px;
		font-size: var(--df-p-text-base);
		line-height: 1.5;
		color: var(--df-text-secondary);
		overflow-wrap: anywhere;
	}

	.card-error {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		margin: var(--df-p-space-3) var(--df-p-space-5) 0;
		padding: 10px 12px;
		border: 1px solid var(--df-c-tint-edge-danger);
		border-radius: var(--df-p-radius-sm);
		background: var(--df-state-danger-bg);
		color: var(--df-state-danger-ink);
		font-size: 12px;
		line-height: 1.45;
	}

	.card-error :global(svg) {
		flex: none;
		margin-top: 1px;
	}

	.decision {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: var(--df-p-space-3);
		flex-wrap: wrap;
		margin-top: var(--df-p-space-4);
		padding: var(--df-p-space-3) var(--df-p-space-5) var(--df-p-space-4);
		border-top: 1px solid var(--df-border-hairline);
		background: var(--df-surface-well);
	}

	.ladder-block {
		display: flex;
		flex-direction: column;
		gap: 6px;
		min-width: 0;
	}

	.ladder {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
	}

	.rung {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 46px;
		height: 34px;
		padding: 0 9px;
		border: 1px solid var(--df-border-control);
		border-radius: var(--df-p-radius-sm);
		background: var(--df-surface-card);
		color: var(--df-text-primary);
		font-family: var(--df-p-font-mono);
		font-size: 12px;
		font-weight: 600;
		line-height: 1;
		transition:
			background-color 140ms ease,
			border-color 140ms ease,
			color 140ms ease,
			transform var(--df-p-dur-press) ease-out;
	}

	.rung:hover:not([aria-disabled='true']):not(:disabled),
	.rung:focus-visible:not([aria-disabled='true']):not(:disabled) {
		background: var(--df-accent-fill);
		border-color: transparent;
		color: var(--df-text-on-accent);
	}

	.rung:active:not([aria-disabled='true']):not(:disabled) {
		transform: scale(0.97);
	}

	.rung[aria-disabled='true'] {
		border-style: dashed;
		background: transparent;
		color: var(--df-text-meta);
		cursor: not-allowed;
	}

	.rung.working {
		border-color: var(--df-accent-text);
		border-style: solid;
		color: var(--df-accent-text);
	}

	.cap-note {
		max-width: 64ch;
		font-size: 11.5px;
		line-height: 1.45;
		color: var(--df-state-warn-ink);
	}

	.cap-note.blocked {
		color: var(--df-state-danger-ink);
	}

	.reject {
		margin-left: auto;
	}

	@media (max-width: 640px) {
		.approval-head {
			flex-direction: column;
			padding: var(--df-p-space-4) var(--df-p-space-4) var(--df-p-space-3);
		}

		.expiry {
			align-items: flex-start;
			width: 100%;
		}

		.targets,
		.facts,
		.reason,
		.card-error,
		.targets-missing {
			margin-inline: var(--df-p-space-4);
		}

		/* Wrapped lines leave a separator dangling at the edge; the gap is enough. */
		.fact-sep {
			display: none;
		}

		.decision {
			padding-inline: var(--df-p-space-4);
		}

		/* A compact pointer target is 32px; a thumb needs 44. */
		.rung,
		.reject {
			min-height: 44px;
		}

		.reject {
			width: 100%;
			justify-content: center;
			margin-left: 0;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.rung {
			transition: none;
		}
	}
</style>
