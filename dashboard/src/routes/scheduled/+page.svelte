<script lang="ts">
	/**
	 * The paced queue.
	 *
	 * A row here is a promise to send later, not a delivery: `scheduled` waits for
	 * its alarm, `dispatching` means the Scheduler claimed the row, `dispatched`
	 * means it was handed to the transport and the outcome is not confirmed yet,
	 * and only the transport's answer moves it on. The queue and its target labels
	 * are the primary read; the pacing policy is a second read that the screen can
	 * live without.
	 */
	import { onMount } from 'svelte';
	import {
		cancelScheduled,
		describeError,
		getConnectors,
		getDevices,
		getPacingPolicies,
		getScheduled,
		setPacingPolicy
	} from '$lib/api';
	import { channelWord } from '$lib/channels';
	import { formatCount, formatRelative } from '$lib/format';
	import { currentTime, subscribeClock } from '$lib/live-clock.svelte';
	import { ROUTES } from '$lib/paths';
	import { session } from '$lib/session.svelte';
	import type {
		ChannelConnector,
		Device,
		PacingPolicyRow,
		ScheduledMessage,
		ScheduledStatus
	} from '$lib/types';
	import Badge from '$lib/components/Badge.svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import Notice from '$lib/components/Notice.svelte';
	import PageHeader from '$lib/components/PageHeader.svelte';
	import RelativeTime from '$lib/components/RelativeTime.svelte';
	import Spinner from '$lib/components/Spinner.svelte';

	/* ------------------------------------------------------------------ ids */

	const uid = $props.id();
	const targetId = `pacing-target-${uid}`;
	const gapId = `pacing-gap-${uid}`;
	const jitterId = `pacing-jitter-${uid}`;
	const perHourId = `pacing-per-hour-${uid}`;
	const quietStartId = `pacing-quiet-start-${uid}`;
	const quietEndId = `pacing-quiet-end-${uid}`;
	const timezoneId = `pacing-timezone-${uid}`;
	const zoneListId = `pacing-zones-${uid}`;

	/* ---------------------------------------------------------------- types */

	type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'accent' | 'muted';
	type TargetType = 'device' | 'connector';

	interface StatusMeta {
		label: string;
		tone: Tone;
	}

	interface When {
		clock: string;
		date: string;
		zone: string;
		full: string;
	}

	interface PolicyValues {
		min_interval_ms: number;
		jitter_pct: number;
		max_per_hour: number;
		quiet_start_hour: number;
		quiet_end_hour: number;
		timezone: string;
	}

	/* -------------------------------------------------------------- constants */

	const DEFAULT_POLICY: Record<TargetType, PolicyValues> = {
		device: {
			min_interval_ms: 10_000,
			jitter_pct: 25,
			max_per_hour: 40,
			quiet_start_hour: 21,
			quiet_end_hour: 8,
			timezone: 'UTC'
		},
		connector: {
			min_interval_ms: 100,
			jitter_pct: 10,
			max_per_hour: 3_600,
			quiet_start_hour: 0,
			quiet_end_hour: 0,
			timezone: 'UTC'
		}
	};

	const KNOWN_ZONES = [
		'UTC',
		'Africa/Nairobi',
		'America/New_York',
		'Asia/Dhaka',
		'Asia/Kolkata',
		'Asia/Singapore',
		'Europe/Berlin',
		'Europe/London',
		'Australia/Sydney'
	];

	/**
	 * `sent` and `delivered` are different claims, so they never share a colour.
	 * `delivered` is the mint `ok` pair; `sent` is the neutral wire pair, which
	 * says "the transport took it" without implying delivery. `scheduled` keeps
	 * the accent chip because Badge has no `info` tone and a neutral one would
	 * read as `sent`. The rest follow the same rule: uncertainty is warn, a stop
	 * is muted, a closed window is warn because it needs a reschedule, and a
	 * refusal is danger.
	 */
	const STATUS: Record<ScheduledStatus, StatusMeta> = {
		scheduled: { label: 'Scheduled', tone: 'accent' },
		dispatching: { label: 'Dispatching', tone: 'warn' },
		dispatched: { label: 'Dispatched', tone: 'warn' },
		sent: { label: 'Sent', tone: 'neutral' },
		delivered: { label: 'Delivered', tone: 'ok' },
		cancelled: { label: 'Cancelled', tone: 'muted' },
		skipped_opt_out: { label: 'Skipped, opted out', tone: 'muted' },
		skipped_window: { label: 'Window closed', tone: 'warn' },
		failed: { label: 'Failed', tone: 'danger' },
		unknown: { label: 'Unknown', tone: 'warn' }
	};

	const LEGEND: Array<{ status: ScheduledStatus; meaning: string }> = [
		{
			status: 'scheduled',
			meaning: 'Waiting for its alarm. Cancel works until the Scheduler claims it.'
		},
		{
			status: 'dispatching',
			meaning: 'The Scheduler claimed the row and is handing it to the transport.'
		},
		{
			status: 'dispatched',
			meaning: 'Handed off; the outcome is not confirmed yet.'
		},
		{
			status: 'sent',
			meaning: 'Handed to the transport, the handset queue or the platform. That is not proof of delivery.'
		},
		{
			status: 'delivered',
			meaning: 'A platform receipt confirmed delivery. Reserved: the Scheduler does not write this yet, so a scheduled row normally stops at Sent.'
		},
		{
			status: 'failed',
			meaning: 'Refused or rejected, with the reason kept on the row.'
		},
		{
			status: 'cancelled',
			meaning: 'Stopped by an operator before the alarm fired.'
		},
		{
			status: 'skipped_opt_out',
			meaning: 'Held back because the recipient opted out of this channel.'
		},
		{
			status: 'skipped_window',
			meaning:
				'The 24-hour customer-service window or the campaign deadline passed. The row is terminal; reschedule inside the window.'
		},
		{
			status: 'unknown',
			meaning: 'The gateway could not classify the last answer; the row keeps its reason.'
		}
	];

	/* ---------------------------------------------------------------- state */

	let rows = $state<ScheduledMessage[]>([]);
	let devices = $state<Device[]>([]);
	let connectors = $state<ChannelConnector[]>([]);
	let policies = $state<PacingPolicyRow[]>([]);

	let loading = $state(true);
	let loaded = $state(false);
	let refreshing = $state(false);
	let error = $state<string | null>(null);
	let supportWarning = $state<string | null>(null);
	let flash = $state<string | null>(null);

	let pendingCancel = $state<ScheduledMessage | null>(null);
	let cancelling = $state(false);
	let cancelError = $state<string | null>(null);

	let selected = $state('');
	let minSeconds = $state(10);
	let jitter = $state(25);
	let maxPerHour = $state(40);
	let quietStart = $state(21);
	let quietEnd = $state(8);
	let timezone = $state('UTC');
	let savedAt = $state<number | null>(null);
	let saving = $state(false);
	let paceError = $state<string | null>(null);
	let paceFlash = $state<string | null>(null);

	/** The form was prefilled once; a refresh must not discard unsaved edits. */
	let supportLoaded = false;

	const canWrite = $derived(session.canWrite);
	const now = $derived(currentTime());

	/* ---------------------------------------------------------------- reads */

	function whenFor(epochMs: number, zone: string | undefined): When {
		const wanted = zone?.trim() ? zone.trim() : null;
		let usable = wanted;
		if (wanted !== null) {
			try {
				new Intl.DateTimeFormat('en-US', { timeZone: wanted });
			} catch {
				usable = null;
			}
		}
		const options = usable ? { timeZone: usable } : {};
		const clock = new Intl.DateTimeFormat(undefined, {
			hour: '2-digit',
			minute: '2-digit',
			...options
		}).format(new Date(epochMs));
		const date = new Intl.DateTimeFormat(undefined, {
			weekday: 'short',
			day: '2-digit',
			month: 'short',
			...options
		}).format(new Date(epochMs));
		const full = new Intl.DateTimeFormat(undefined, {
			dateStyle: 'medium',
			timeStyle: 'short',
			...options
		}).format(new Date(epochMs));
		const label = wanted === null || usable === null ? 'your time' : wanted;
		return { clock, date, zone: label, full };
	}

	const queue = $derived(rows.map((row) => ({ ...row, when: whenFor(row.send_at, row.timezone) })));

	const counts = $derived({
		scheduled: rows.filter((row) => row.status === 'scheduled').length,
		dispatched: rows.filter((row) => row.status === 'dispatched').length,
		sent: rows.filter((row) => row.status === 'sent').length,
		delivered: rows.filter((row) => row.status === 'delivered').length,
		failed: rows.filter((row) => row.status === 'failed').length
	});

	const nextRow = $derived(
		[...rows].filter((row) => row.status === 'scheduled').sort((a, b) => a.send_at - b.send_at)[0] ??
			null
	);

	interface TargetOption {
		value: string;
		label: string;
		group: 'Devices' | 'Connectors';
	}

	const targets = $derived.by((): TargetOption[] => {
		const deviceTargets = devices.map((device) => ({
			value: `device:${device.device_id}`,
			label: device.label?.trim() ? device.label : device.device_id,
			group: 'Devices' as const
		}));
		const connectorTargets = connectors.map((connector) => ({
			value: `connector:${connector.id}`,
			label: `${connector.label} · ${channelWord(connector.channel) ?? connector.channel}`,
			group: 'Connectors' as const
		}));
		return [...deviceTargets, ...connectorTargets];
	});

	const selectedTarget = $derived(targets.find((target) => target.value === selected) ?? null);
	const selectedType = $derived(parseTarget(selected)?.type ?? 'device');
	const policyRow = $derived.by(() => {
		const parsed = parseTarget(selected);
		if (!parsed) return null;
		return (
			policies.find(
				(row) => row.target_type === parsed.type && row.target_id === parsed.id
			) ?? null
		);
	});

	function parseTarget(value: string): { type: TargetType; id: string } | null {
		const index = value.indexOf(':');
		if (index < 1) return null;
		const type = value.slice(0, index);
		const id = value.slice(index + 1);
		if ((type !== 'device' && type !== 'connector') || id === '') return null;
		return { type, id };
	}

	async function load(silent = false): Promise<void> {
		if (silent) refreshing = true;
		else loading = true;
		error = null;
		if (!silent) supportWarning = null;
		try {
			rows = await getScheduled();
			loaded = true;
			await loadSupport();
		} catch (failure) {
			error = describeError(failure);
		} finally {
			loading = false;
			refreshing = false;
		}
	}

	/**
	 * Labels and policies are a second read: a queue that renders without them is
	 * still useful, so a refusal here is a note rather than the page's error.
	 * Members never see connector or policy rows, so neither is asked for.
	 */
	async function loadSupport(): Promise<void> {
		const reads = await Promise.allSettled([
			getDevices(),
			canWrite ? getConnectors() : Promise.resolve([] as ChannelConnector[]),
			canWrite ? getPacingPolicies() : Promise.resolve([] as PacingPolicyRow[])
		]);

		const [deviceRead, connectorRead, policyRead] = reads;
		if (deviceRead.status === 'fulfilled') devices = deviceRead.value;
		if (connectorRead.status === 'fulfilled') connectors = connectorRead.value;
		if (policyRead.status === 'fulfilled') policies = policyRead.value;

		const failed = reads.some((read) => read.status === 'rejected');
		supportWarning = failed
			? 'Some target names and pacing rows could not be read, so an id is shown instead.'
			: null;

		if (targets.length > 0) {
			if (!parseTarget(selected) || !targets.some((target) => target.value === selected)) {
				selected = targets[0].value;
				applyPolicy(selected);
			} else if (!supportLoaded) {
				applyPolicy(selected);
			}
		} else {
			selected = '';
		}
		supportLoaded = true;
	}

	/* ---------------------------------------------------------------- pacing */

	function applyPolicy(value: string): void {
		const parsed = parseTarget(value);
		if (!parsed) return;
		const found =
			policies.find(
				(row) => row.target_type === parsed.type && row.target_id === parsed.id
			) ?? null;
		const source = found ?? DEFAULT_POLICY[parsed.type];
		minSeconds = source.min_interval_ms / 1_000;
		jitter = source.jitter_pct;
		maxPerHour = source.max_per_hour;
		quietStart = source.quiet_start_hour;
		quietEnd = source.quiet_end_hour;
		timezone = source.timezone;
		savedAt = found?.updated_at ?? null;
		paceError = null;
		paceFlash = null;
	}

	function chooseTarget(): void {
		applyPolicy(selected);
	}

	function useDefaults(): void {
		const parsed = parseTarget(selected);
		if (!parsed || !canWrite) return;
		const source = DEFAULT_POLICY[parsed.type];
		minSeconds = source.min_interval_ms / 1_000;
		jitter = source.jitter_pct;
		maxPerHour = source.max_per_hour;
		quietStart = source.quiet_start_hour;
		quietEnd = source.quiet_end_hour;
		timezone = source.timezone;
		savedAt = null;
		paceError = null;
		paceFlash = null;
	}

	const timezoneProblem = $derived.by(() => {
		const name = timezone.trim();
		if (name === '') return 'Name a timezone, or use UTC.';
		try {
			new Intl.DateTimeFormat('en-US', { timeZone: name });
			return null;
		} catch {
			return 'That timezone is not one this browser knows. Use a name like Europe/London.';
		}
	});

	const paceProblem = $derived.by(() => {
		if (!selectedTarget) return 'Choose a target first.';
		if (!Number.isFinite(minSeconds) || minSeconds < 0.05) {
			return 'The gap must be at least 0.05 seconds.';
		}
		if (minSeconds > 3_600) return 'The gap must be an hour or less.';
		if (!Number.isInteger(jitter) || jitter < 0 || jitter > 50) {
			return 'Jitter runs from 0 to 50 whole percent.';
		}
		if (!Number.isInteger(maxPerHour) || maxPerHour < 1) {
			return 'Allow at least one send an hour.';
		}
		if (!Number.isInteger(quietStart) || !Number.isInteger(quietEnd)) {
			return 'Choose whole hours for the quiet window.';
		}
		return timezoneProblem;
	});

	const currentValues = $derived<PolicyValues>({
		min_interval_ms: Math.round(minSeconds * 1_000),
		jitter_pct: jitter,
		max_per_hour: maxPerHour,
		quiet_start_hour: quietStart,
		quiet_end_hour: quietEnd,
		timezone: timezone.trim()
	});

	const baselineValues = $derived<PolicyValues>(
		policyRow ?? DEFAULT_POLICY[selectedType]
	);

	const dirty = $derived(
		currentValues.min_interval_ms !== baselineValues.min_interval_ms ||
			currentValues.jitter_pct !== baselineValues.jitter_pct ||
			currentValues.max_per_hour !== baselineValues.max_per_hour ||
			currentValues.quiet_start_hour !== baselineValues.quiet_start_hour ||
			currentValues.quiet_end_hour !== baselineValues.quiet_end_hour ||
			currentValues.timezone !== baselineValues.timezone
	);

	const quietSummary = $derived.by(() => {
		if (quietStart === quietEnd) return 'Quiet hours are off.';
		return `Quiet from ${hourWord(quietStart)} to ${hourWord(quietEnd)} in ${timezone.trim() || 'UTC'}.`;
	});

	function hourWord(hour: number): string {
		return `${String(Number(hour)).padStart(2, '0')}:00`;
	}

	async function savePolicy(): Promise<void> {
		const parsed = parseTarget(selected);
		if (!parsed || !canWrite || saving || paceProblem !== null) return;
		saving = true;
		paceError = null;
		paceFlash = null;
		try {
			const result = await setPacingPolicy(parsed.type, parsed.id, {
				min_interval_ms: currentValues.min_interval_ms,
				jitter_pct: currentValues.jitter_pct,
				max_per_hour: currentValues.max_per_hour,
				quiet_start_hour: currentValues.quiet_start_hour,
				quiet_end_hour: currentValues.quiet_end_hour,
				timezone: currentValues.timezone
			});
			policies = [
				result.policy,
				...policies.filter(
					(row) =>
						!(
							row.target_type === result.policy.target_type &&
							row.target_id === result.policy.target_id
						)
				)
			];
			savedAt = result.policy.updated_at;
			paceFlash = `Pacing saved for ${selectedTarget?.label ?? parsed.id}.`;
		} catch (failure) {
			paceError = describeError(failure);
		} finally {
			saving = false;
		}
	}

	/* -------------------------------------------------------------- cancelling */

	function askCancel(row: ScheduledMessage): void {
		pendingCancel = row;
		cancelError = null;
		flash = null;
	}

	function dismissCancel(): void {
		if (cancelling) return;
		pendingCancel = null;
		cancelError = null;
	}

	async function confirmCancel(): Promise<void> {
		const row = pendingCancel;
		if (!row || cancelling) return;
		cancelling = true;
		cancelError = null;
		try {
			await cancelScheduled(row.id);
			flash = `Cancelled the send to ${row.to_peer}. It will not leave the queue.`;
			pendingCancel = null;
			await load(true);
		} catch (failure) {
			cancelError = describeError(failure);
		} finally {
			cancelling = false;
		}
	}

	/* ------------------------------------------------------------------ labels */

	function statusOf(status: string): StatusMeta {
		return STATUS[status as ScheduledStatus] ?? { label: status, tone: 'muted' };
	}

	function targetLabel(row: ScheduledMessage): string {
		if (row.target_type === 'device') {
			const device = devices.find((item) => item.device_id === row.target_id);
			return device?.label?.trim() ? device.label : row.target_id;
		}
		const connector = connectors.find((item) => item.id === row.target_id);
		return connector?.label ?? row.target_id;
	}

	function bodyPreview(body: string): string {
		return body.replace(/\s+/g, ' ').trim();
	}

	/** The reason a row moved, in the console's words rather than the column's. */
	function shiftNote(row: ScheduledMessage): string | null {
		if (row.shift_count < 1) return null;
		const reason =
			row.last_shift_reason === 'quiet_hours'
				? 'held for quiet hours'
				: (row.last_shift_reason?.replace(/_/g, ' ') ?? 'rescheduled');
		return row.shift_count > 1 ? `${reason}, ${row.shift_count} times` : reason;
	}

	/**
	 * A queued send is in the future, and `RelativeTime` answers a future value
	 * with "just now" (it compares against the value itself). The queue needs
	 * "in 12m", so it formats against the shared clock directly. Past reads, such
	 * as a policy's last save, still use RelativeTime.
	 */
	function sendIn(epochMs: number): string {
		return formatRelative(epochMs, now);
	}

	onMount(() => {
		const unsubscribe = subscribeClock();
		void load();
		return unsubscribe;
	});
</script>

<PageHeader
	eyebrow="Delivery"
	title="Scheduled"
	description="One queue, one alarm. A send waits for its time, then the target's pacing sets the gap before the next one."
>
	<button
		type="button"
		class="btn"
		onclick={() => void load(true)}
		disabled={refreshing || loading}
		aria-busy={refreshing}
	>
		{#if refreshing}<Spinner />{:else}<Icon name="refresh" size={14} />{/if}
		Refresh
	</button>
</PageHeader>

{#if !canWrite}
	<p class="read-only">
		<Icon name="shield" size={15} />
		Your account can read the queue but cannot cancel a send or change pacing. Ask an owner or admin
		to make a change.
	</p>
{/if}

{#if flash}
	<div class="flash">
		<Notice tone="ok" title="Done">{flash}</Notice>
	</div>
{/if}

{#if error && loaded}
	<div class="flash">
		<Notice tone="warn" title="The queue may be out of date">
			{error} The rows below are the last answer from the gateway.
		</Notice>
	</div>
{/if}

{#if loading && !loaded}
	<div class="card loading-card" aria-busy="true" aria-live="polite">
		<span class="sr-only">Loading the scheduled queue and pacing policies</span>
		<div class="skeleton"></div>
		<div class="skeleton"></div>
		<div class="skeleton"></div>
	</div>
{:else if error && !loaded}
	<div class="card loading-card">
		<Notice tone="danger" title="The scheduled queue did not load">{error}</Notice>
		<button type="button" class="btn retry" onclick={() => void load()}>
			<Icon name="refresh" size={13} /> Try again
		</button>
	</div>
{:else}
	<dl class="ledger" aria-label="Queue at a glance">
		<div class="ledger-cell">
			<dt>Scheduled</dt>
			<dd>{formatCount(counts.scheduled)}</dd>
			<span class="ledger-note">waiting for an alarm</span>
		</div>
		<div class="ledger-cell">
			<dt>Dispatched</dt>
			<dd>{formatCount(counts.dispatched)}</dd>
			<span class="ledger-note">outcome unknown</span>
		</div>
		<div class="ledger-cell">
			<dt>Sent</dt>
			<dd>{formatCount(counts.sent)}</dd>
			<span class="ledger-note">handed to the transport</span>
		</div>
		<div class="ledger-cell">
			<dt>Delivered</dt>
			<dd>{formatCount(counts.delivered)}</dd>
			<span class="ledger-note">confirmed delivery</span>
		</div>
		<div class="ledger-cell" data-tone={counts.failed > 0 ? 'danger' : undefined}>
			<dt>Failed</dt>
			<dd>{formatCount(counts.failed)}</dd>
			<span class="ledger-note">with a reason</span>
		</div>
	</dl>

	<section class="panel queue-panel" aria-labelledby="queue-title">
		<div class="panel-head">
			<h2 class="panel-title" id="queue-title">
				<Icon name="clock" size={15} /> Queue
			</h2>
			<p class="panel-meta">
				{#if nextRow}
					{nextRow.send_at < now ? 'Overdue' : 'Next'}
					{whenFor(nextRow.send_at, nextRow.timezone).clock}
					<span aria-hidden="true">·</span>
					{sendIn(nextRow.send_at)}
				{:else}
					No alarm armed
				{/if}
			</p>
		</div>

		{#if rows.length === 0}
			<div class="panel-body">
				<EmptyState
					icon="clock"
					title="Nothing is waiting"
					description="A send appears here when a flow or an operator queues one for later. It leaves when its time comes, and the pacing policy below sets the gap before the next one."
				>
					<a class="quiet-link" href={ROUTES.messages}>Open Messages</a>
				</EmptyState>
			</div>
		{:else}
			<table class="table queue-table">
				<thead>
					<tr>
						<th scope="col">Send time</th>
						<th scope="col">Channel</th>
						<th scope="col">Target</th>
						<th scope="col">Recipient</th>
						<th scope="col">Message</th>
						<th scope="col">Status</th>
						<th scope="col"><span class="sr-only">Actions</span></th>
					</tr>
				</thead>
				<tbody>
					{#each queue as row, index (row.id)}
						<tr class="settle" style={`--i: ${Math.min(index, 5)}`}>
							<td data-label="Send time">
								<span class="cell-main mono when-clock" title={row.when.full}>{row.when.clock}</span>
								<span class="cell-sub">{row.when.date} · {row.when.zone}</span>
								<span class="cell-sub">{sendIn(row.send_at)}</span>
								{#if shiftNote(row)}
									<span class="cell-sub shift-note">{shiftNote(row)}</span>
								{/if}
							</td>
							<td data-label="Channel">
								<span class="channel-tag">
									{channelWord(row.channel) ?? row.channel}
								</span>
							</td>
							<td data-label="Target">
								<span class="cell-main">{targetLabel(row)}</span>
								<span class="cell-sub mono">{row.target_type}</span>
							</td>
							<td data-label="Recipient">
								<span class="cell-main mono peer">{row.to_peer}</span>
							</td>
							<td data-label="Message">
								<span class="body-preview" title={row.body}>{bodyPreview(row.body)}</span>
								{#if row.last_error}
									<span class="row-error">
										<Icon name="alert" size={12} /> {row.last_error}
									</span>
								{/if}
							</td>
							<td data-label="Status">
								<Badge tone={statusOf(row.status).tone} dot>{statusOf(row.status).label}</Badge>
								{#if row.attempts > 1}
									<span class="cell-sub">{row.attempts} attempts</span>
								{/if}
							</td>
							<td class="row-actions">
								{#if row.status === 'scheduled' && canWrite}
									<button
										type="button"
										class="btn btn-sm btn-danger-ghost"
										onclick={() => askCancel(row)}
										aria-label={`Cancel the send to ${row.to_peer}`}
									>
										<Icon name="x" size={12} /> Cancel
									</button>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>

			<div class="legend">
				<h3 class="legend-title">What each state means</h3>
				<dl class="legend-list">
					{#each LEGEND as item (item.status)}
						<div class="legend-row">
							<dt><Badge tone={STATUS[item.status].tone} dot>{STATUS[item.status].label}</Badge></dt>
							<dd>{item.meaning}</dd>
						</div>
					{/each}
				</dl>
				<p class="legend-quiet">
					<Icon name="clock" size={13} />
					Quiet hours are not a status: the row stays Scheduled, the send time moves to the end of
					the window plus up to five minutes of jitter, and it is never dropped.
				</p>
				{#if supportWarning}
					<p class="hint legend-note">{supportWarning}</p>
				{/if}
			</div>
		{/if}
	</section>

	<section class="panel pacing-panel" aria-labelledby="pacing-title">
		<div class="panel-head">
			<h2 class="panel-title" id="pacing-title">
				<Icon name="sliders" size={15} /> Pacing
			</h2>
			<p class="panel-meta">
				{formatCount(targets.length)}
				{targets.length === 1 ? 'target' : 'targets'}
			</p>
		</div>

		{#if !canWrite}
			<div class="panel-body">
				<p class="pace-read-only">
					Pacing belongs to owners and admins. This deployment still applies a policy to every
					send; ask an owner to change the gap, the hourly cap or the quiet window.
				</p>
			</div>
		{:else if targets.length === 0}
			<div class="panel-body">
				<EmptyState
					icon="sliders"
					title="No target to pace yet"
					description="Pacing is stored per device and per connector. Pair a phone or add a channel connector, then come back to set its gap and quiet hours."
				>
					<a class="quiet-link" href={ROUTES.channels}>Open Channels</a>
				</EmptyState>
			</div>
		{:else}
			<div class="panel-body pace-body">
				<div class="pace-grid">
					<div class="field pace-target">
						<label class="label" for={targetId}>Target</label>
						<select id={targetId} class="input" bind:value={selected} onchange={chooseTarget}>
							{#if devices.length > 0}
								<optgroup label="Devices">
									{#each targets.filter((target) => target.group === 'Devices') as target (target.value)}
										<option value={target.value}>{target.label}</option>
									{/each}
								</optgroup>
							{/if}
							{#if connectors.length > 0}
								<optgroup label="Connectors">
									{#each targets.filter((target) => target.group === 'Connectors') as target (target.value)}
										<option value={target.value}>{target.label}</option>
									{/each}
								</optgroup>
							{/if}
						</select>
						<p class="hint">
							{#if policyRow}
								Saved <RelativeTime value={policyRow.updated_at} fallback="just now" />.
							{:else}
								No policy row yet, so the documented defaults for a
								{selectedType === 'device' ? 'phone number' : 'cloud account'} apply.
							{/if}
						</p>
					</div>

					<div class="field">
						<label class="label" for={gapId}>Minimum gap <span class="optional">seconds</span></label>
						<input
							id={gapId}
							class="input"
							type="number"
							min="0.05"
							max="3600"
							step="0.1"
							bind:value={minSeconds}
						/>
						<p class="hint">The wait between two sends to this target.</p>
					</div>

					<div class="field">
						<label class="label" for={jitterId}>Jitter <span class="optional">percent</span></label>
						<input
							id={jitterId}
							class="input"
							type="number"
							min="0"
							max="50"
							step="1"
							bind:value={jitter}
						/>
						<p class="hint">Spread either side of the gap, up to 50 percent.</p>
					</div>

					<div class="field">
						<label class="label" for={perHourId}>Maximum <span class="optional">per hour</span></label>
						<input
							id={perHourId}
							class="input"
							type="number"
							min="1"
							step="1"
							bind:value={maxPerHour}
						/>
						<p class="hint">A hard ceiling for this target.</p>
					</div>

					<div class="field">
						<label class="label" for={quietStartId}>Quiet from</label>
						<select id={quietStartId} class="input" bind:value={quietStart}>
							{#each Array(24) as _, hour (hour)}
								<option value={hour}>{hourWord(hour)}</option>
							{/each}
						</select>
					</div>

					<div class="field">
						<label class="label" for={quietEndId}>Quiet until</label>
						<select id={quietEndId} class="input" bind:value={quietEnd}>
							{#each Array(24) as _, hour (hour)}
								<option value={hour}>{hourWord(hour)}</option>
							{/each}
						</select>
					</div>

					<div class="field pace-zone">
						<label class="label" for={timezoneId}>Timezone</label>
						<input
							id={timezoneId}
							class="input input-mono"
							bind:value={timezone}
							placeholder="UTC"
							list={zoneListId}
							autocomplete="off"
							spellcheck="false"
						/>
						<datalist id={zoneListId}>
							{#each KNOWN_ZONES as zone (zone)}
								<option value={zone}></option>
							{/each}
						</datalist>
						<p class="hint">The clock the quiet hours are read on.</p>
					</div>

					<p class="pace-summary">{quietSummary}</p>

					<p class="hint pace-note">
						Quiet hours hold a send until the window ends, then add up to five minutes of wake
						jitter. A message is never dropped for falling inside the window. Set the two hours
						equal to switch quiet hours off.
					</p>
				</div>

				<div class="pace-foot">
					<button
						type="button"
						class="btn btn-primary"
						onclick={() => void savePolicy()}
						disabled={saving || paceProblem !== null}
						aria-busy={saving}
					>
						{#if saving}<Spinner />{:else}<Icon name="check" size={14} />{/if}
						Save pacing
					</button>
					<button type="button" class="btn" onclick={useDefaults} disabled={saving}>
						<Icon name="undo" size={13} /> Use defaults
					</button>
					{#if dirty}
						<Badge tone="warn">Unsaved changes</Badge>
					{:else if policyRow}
						<Badge tone="ok" dot>Saved</Badge>
					{:else}
						<Badge tone="muted">Using defaults</Badge>
					{/if}
					{#if !saving && paceProblem}
						<p class="hint pace-problem">{paceProblem}</p>
					{/if}
				</div>

				{#if paceFlash}
					<div class="pace-flash"><Notice tone="ok" title="Pacing saved">{paceFlash}</Notice></div>
				{/if}
				{#if paceError}
					<div class="pace-flash">
						<Notice tone="danger" title="The policy was not saved">{paceError}</Notice>
					</div>
				{/if}
			</div>
		{/if}
	</section>
{/if}

<ConfirmDialog
	open={pendingCancel !== null}
	title="Cancel this send?"
	confirmLabel="Cancel send"
	tone="danger"
	pending={cancelling}
	error={cancelError}
	onconfirm={() => void confirmCancel()}
	oncancel={dismissCancel}
>
	<p class="confirm-copy">
		{#if pendingCancel}
			The message to <span class="mono">{pendingCancel.to_peer}</span> on
			{channelWord(pendingCancel.channel) ?? pendingCancel.channel} will not leave. The row stays in
			the queue marked cancelled. A send the Scheduler has already claimed cannot be recalled here.
		{/if}
	</p>
</ConfirmDialog>

<style>
	.read-only {
		display: flex;
		align-items: flex-start;
		gap: var(--df-p-space-2);
		margin-bottom: var(--df-p-space-4);
		padding: var(--df-p-space-2) var(--df-p-space-3);
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-md);
		background: var(--df-surface-well);
		color: var(--df-text-secondary);
		font-size: var(--df-p-text-base);
		line-height: 1.5;
	}

	.read-only :global(svg) {
		margin-top: 2px;
		color: var(--df-text-meta);
	}

	.flash {
		margin-bottom: var(--df-p-space-4);
	}

	.loading-card {
		display: grid;
		gap: var(--df-p-space-3);
	}

	.loading-card .skeleton {
		height: var(--df-p-space-7);
	}

	.retry {
		margin-top: var(--df-p-space-3);
		justify-self: start;
	}

	/* ---------- ledger ---------- */

	.ledger {
		display: grid;
		grid-template-columns: repeat(5, minmax(0, 1fr));
		margin-bottom: var(--df-p-space-5);
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-md);
		background: var(--df-surface-card);
		box-shadow: var(--df-shadow-card);
		overflow: hidden;
	}

	.ledger-cell {
		display: grid;
		gap: 2px;
		padding: var(--df-p-space-3) var(--df-p-space-4);
		border-left: 1px solid var(--df-border-hairline);
		min-width: 0;
	}

	.ledger-cell:first-child {
		border-left: 0;
	}

	.ledger-cell dt {
		font-family: var(--df-p-font-mono);
		font-size: var(--df-p-text-2xs);
		font-weight: 500;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--df-text-meta);
	}

	.ledger-cell dd {
		font-family: var(--df-font-display);
		font-size: var(--df-p-text-2xl);
		font-weight: 800;
		line-height: 1.05;
		letter-spacing: -0.03em;
		font-variant-numeric: tabular-nums;
		color: var(--df-text-primary);
	}

	.ledger-cell[data-tone='danger'] dd {
		color: var(--df-state-danger-ink);
	}

	.ledger-note {
		font-size: var(--df-p-text-2xs);
		color: var(--df-text-meta);
		line-height: 1.35;
	}

	/* ---------- queue ---------- */

	.panel-meta {
		font-family: var(--df-p-font-mono);
		font-size: var(--df-p-text-2xs);
		letter-spacing: 0.06em;
		color: var(--df-text-meta);
		text-align: right;
	}

	.when-clock {
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}

	.shift-note {
		color: var(--df-state-warn-ink);
		font-size: var(--df-p-text-2xs);
	}

	.channel-tag {
		display: inline-flex;
		align-items: center;
		height: var(--df-c-chip-height);
		padding: 0 var(--df-c-chip-padding-inline);
		border-radius: var(--df-c-chip-radius);
		background: var(--df-state-filter-bg);
		color: var(--df-state-filter-ink);
		font-size: var(--df-c-chip-font-size);
		font-weight: 600;
		letter-spacing: 0.02em;
		white-space: nowrap;
	}

	.peer {
		font-size: var(--df-p-text-sm);
		overflow-wrap: anywhere;
	}

	.body-preview {
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
		max-width: 44ch;
		color: var(--df-text-secondary);
		font-size: var(--df-p-text-sm);
		line-height: 1.5;
		overflow-wrap: anywhere;
	}

	.row-error {
		display: flex;
		align-items: flex-start;
		gap: 5px;
		margin-top: var(--df-p-space-1);
		color: var(--df-state-danger-ink);
		font-size: var(--df-p-text-2xs);
		line-height: 1.4;
		overflow-wrap: anywhere;
	}

	.row-error :global(svg) {
		margin-top: 1px;
	}

	/* Keep the cell a table cell so vertical-align can centre the one button
	   against a row whose message wrapped to three lines. */
	.row-actions {
		text-align: right;
		vertical-align: middle;
	}

	.legend {
		padding: var(--df-p-space-4);
		border-top: 1px solid var(--df-border-hairline);
		background: var(--df-surface-well);
	}

	.legend-title {
		font-family: var(--df-p-font-mono);
		font-size: var(--df-p-text-2xs);
		font-weight: 600;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--df-text-meta);
	}

	.legend-list {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--df-p-space-2) var(--df-p-space-5);
		margin-top: var(--df-p-space-3);
	}

	.legend-row {
		display: grid;
		grid-template-columns: 10.5rem minmax(0, 1fr);
		align-items: baseline;
		gap: var(--df-p-space-2);
	}

	.legend-row dt {
		justify-self: start;
	}

	.legend-row dd {
		font-size: var(--df-p-text-sm);
		line-height: 1.45;
		color: var(--df-text-secondary);
	}

	.legend-note {
		margin-top: var(--df-p-space-3);
	}

	.legend-quiet {
		display: flex;
		align-items: flex-start;
		gap: 6px;
		max-width: 84ch;
		margin-top: var(--df-p-space-3);
		padding-top: var(--df-p-space-3);
		border-top: 1px dashed var(--df-border-hairline);
		font-size: var(--df-p-text-sm);
		line-height: 1.5;
		color: var(--df-text-secondary);
	}

	.legend-quiet :global(svg) {
		margin-top: 2px;
		color: var(--df-text-meta);
	}

	.quiet-link {
		display: inline-flex;
		align-items: center;
		min-height: 44px;
		color: var(--df-accent-text);
		font-weight: 600;
		text-decoration: underline;
		text-underline-offset: 3px;
	}

	/* ---------- pacing ---------- */

	.pacing-panel {
		margin-top: var(--df-p-space-5);
	}

	.pace-body {
		display: grid;
		gap: var(--df-p-space-4);
	}

	.pace-grid {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: var(--df-p-space-4);
	}

	.pace-target {
		grid-column: span 2;
	}

	.pace-zone {
		min-width: 0;
	}

	.pace-summary {
		grid-column: 1 / -1;
		padding: var(--df-p-space-2) var(--df-p-space-3);
		border: 1px solid var(--df-border-hairline);
		border-radius: var(--df-p-radius-sm);
		background: var(--df-surface-well);
		font-family: var(--df-p-font-mono);
		font-size: var(--df-p-text-xs);
		color: var(--df-text-secondary);
	}

	.pace-note {
		grid-column: 1 / -1;
		max-width: 78ch;
	}

	.pace-foot {
		display: flex;
		align-items: center;
		gap: var(--df-p-space-2);
		flex-wrap: wrap;
		padding-top: var(--df-p-space-4);
		border-top: 1px solid var(--df-border-hairline);
	}

	.pace-problem {
		margin: 0;
		flex-basis: 100%;
	}

	.pace-flash {
		max-width: 70ch;
	}

	.pace-read-only {
		max-width: 72ch;
		font-size: var(--df-p-text-base);
		line-height: 1.55;
		color: var(--df-text-secondary);
	}

	.confirm-copy {
		font-size: var(--df-p-text-base);
		line-height: 1.55;
		color: var(--df-text-secondary);
	}

	.confirm-copy .mono {
		color: var(--df-text-primary);
	}

	/* ---------- narrow ---------- */

	@media (max-width: 1100px) {
		.pace-grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}

		.legend-list {
			grid-template-columns: minmax(0, 1fr);
		}
	}

	@media (max-width: 760px) {
		.ledger {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}

		/* The 2x2 ledger needs its outer edges drawn once, not per cell. */
		.ledger-cell {
			border-left: 1px solid var(--df-border-hairline);
			border-top: 1px solid var(--df-border-hairline);
		}

		.ledger-cell:nth-child(odd) {
			border-left: 0;
		}

		.ledger-cell:nth-child(-n + 2) {
			border-top: 0;
		}

		.ledger-cell:last-child {
			grid-column: 1 / -1;
			border-left: 0;
		}

		.body-preview {
			-webkit-line-clamp: 3;
			line-clamp: 3;
			max-width: none;
		}

		.legend-row {
			grid-template-columns: minmax(0, 1fr);
			gap: var(--df-p-space-1);
		}

		.pace-grid {
			grid-template-columns: minmax(0, 1fr);
		}

		.pace-target {
			grid-column: auto;
		}

		/* The queue becomes a stack of labelled facts. The label sits above its
		   own value, so a multi-line target or a message error stays inside this
		   fact instead of starting at another label's edge. */
		.queue-table thead {
			display: none;
		}

		.queue-table,
		.queue-table tbody {
			display: block;
			width: 100%;
		}

		.queue-table tr {
			display: grid;
			grid-template-columns: minmax(0, 1fr) auto;
			gap: 0 var(--df-p-space-2);
			padding: var(--df-p-space-4);
			border-bottom: 1px solid var(--df-border-hairline);
		}

		.queue-table tr:last-child {
			border-bottom: 0;
		}

		.queue-table td {
			display: grid;
			grid-template-columns: minmax(0, 1fr);
			grid-column: 1 / -1;
			align-items: start;
			gap: var(--df-p-space-1);
			padding: var(--df-p-space-2) 0;
			border-bottom: 0;
			justify-items: stretch;
			min-width: 0;
		}

		.queue-table .channel-tag {
			justify-self: start;
		}

		.queue-table .cell-main {
			overflow-wrap: anywhere;
		}

		.queue-table td:first-child {
			padding-left: 0;
			padding-bottom: var(--df-p-space-2);
		}

		.queue-table td:last-child {
			padding-right: 0;
		}

		.queue-table td::before {
			content: attr(data-label);
			font-family: var(--df-p-font-mono);
			font-size: var(--df-p-text-2xs);
			letter-spacing: 0.08em;
			text-transform: uppercase;
			color: var(--df-text-meta);
		}

		.queue-table td[data-label='Send time'] {
			grid-template-columns: minmax(0, 1fr);
			grid-column: 1;
			grid-row: 1;
		}

		.queue-table td[data-label='Send time']::before {
			display: none;
		}

		/* The state is the second thing a queue row has to say, so it sits on
		   the first line opposite the time instead of after five fact rows. */
		.queue-table td[data-label='Status'] {
			display: flex;
			flex-direction: column;
			align-items: flex-end;
			gap: 2px;
			grid-column: 2;
			grid-row: 1;
			justify-self: end;
			align-self: start;
			padding: 0;
		}

		.queue-table td[data-label='Status']::before {
			display: none;
		}

		.queue-table .when-clock {
			font-size: var(--df-p-text-md);
		}

		.queue-table .row-actions {
			display: flex;
			grid-column: 1 / -1;
			justify-content: flex-end;
			padding-top: var(--df-p-space-2);
		}

		.queue-table .row-actions::before {
			display: none;
		}

		.queue-table .row-actions :global(.btn) {
			min-height: 44px;
		}

		/* Every control clears the 44px touch target, including the compact
		   global button sizes and the row action. */
		.btn,
		.btn-sm {
			min-height: 44px;
		}

		.input {
			min-height: 44px;
		}

		.pace-foot .btn {
			flex: 1 1 12rem;
		}

		/* ConfirmDialog is a child component, so its buttons carry the global
		   classes without this page's scope. Raise them here, where the dialog is
		   opened at this width. */
		:global(.dialog .btn) {
			min-height: 44px;
		}

		:global(.dialog .btn-icon) {
			width: 44px;
			height: 44px;
		}
	}

	@media (hover: hover) and (pointer: fine) {
		.queue-table tbody tr:hover {
			background: var(--df-c-table-row-bg-hover);
		}
	}
</style>
