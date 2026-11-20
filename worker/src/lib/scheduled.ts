/**
 * Scheduled-send policy and D1 access.
 *
 * Everything except the five `*Scheduled` helpers is pure: the route validates
 * a request and the Scheduler Durable Object arms an alarm with the same
 * arithmetic, so both agree without a shared clock. All SQL for the lifecycle
 * lives here so a guard cannot drift between the route, the DO and a test.
 *
 * Pacing policy comes from `./pacing`; this file does not restate it.
 */

/* ------------------------------------------------------------------------- *
 * Status
 * ------------------------------------------------------------------------- */

export type ScheduledStatus =
  | "scheduled"
  | "dispatching"
  | "dispatched"
  | "sent"
  | "delivered"
  | "cancelled"
  | "skipped_opt_out"
  | "skipped_window"
  | "failed"
  | "unknown";

/**
 * Forward ranks. Terminal outcomes carry `-1`: they are not a stage a message
 * progresses through, they are a place it stops.
 */
export const STATUS_RANK: Record<ScheduledStatus, number> = {
  scheduled: 0,
  dispatching: 1,
  dispatched: 2,
  sent: 3,
  delivered: 4,
  cancelled: -1,
  skipped_opt_out: -1,
  skipped_window: -1,
  failed: -1,
  unknown: -1
};

/**
 * Whether writing `to` over `from` is progress.
 *
 * A forward stage wins only against an earlier stage, so a late `sent` receipt
 * cannot erase `delivered`. A terminal outcome may replace any pre-delivery
 * state — a carrier can report failure after `sent` — but never a message that
 * already reached `delivered`.
 */
export function statusAdvances(from: ScheduledStatus, to: ScheduledStatus): boolean {
  const fromRank = STATUS_RANK[from];
  const toRank = STATUS_RANK[to];
  if (toRank >= 0) return fromRank >= 0 && toRank > fromRank;
  return fromRank >= 0 && fromRank < STATUS_RANK.delivered;
}

/* ------------------------------------------------------------------------- *
 * Carrier receipt mirror
 * ------------------------------------------------------------------------- */

/** One entry of the Durable Object's `applied_updates` list. */
export interface AppliedUpdate {
  command_id: string;
  status: string;
  error_code?: string;
  error_message?: string;
}

/**
 * The reason stored on a failed scheduled row.
 *
 * The handset reports `error_code` and `error_message` separately; the contract
 * already caps the message at 280 characters, and this column is
 * operator-facing prose, so the join is capped at 200. `EXPIRED` has no carrier
 * reason of its own, so it gets a literal one.
 */
function deliveryError(update: AppliedUpdate): string {
  if (update.status === "EXPIRED") return "expired";
  const combined = [update.error_code, update.error_message].filter(Boolean).join(": ");
  return combined === "" ? "failed" : combined.slice(0, 200);
}

/**
 * One statement that applies a transport outcome to a scheduled row.
 *
 * A scheduled row is keyed by `(channel, dispatch_ref)`: for SMS the Scheduler
 * stores the command id (the row's UUID); for a connector it stores the
 * platform's message id (`result.channelMessageId`). The `status IN
 * ('sent','dispatched')` guard is the whole decision: a cancellation, a skip, a
 * failure or a delivery that is already recorded is never rewritten, so a late
 * `sent` or a duplicate receipt cannot walk a row backwards.
 *
 * Exported so the SMS receipt route and the multi-channel ingest consumer apply
 * the same rule rather than two copies that can drift.
 */
export function mirrorScheduledStatus(
  db: D1Database,
  channel: string,
  dispatchRef: string,
  outcome: "sent" | "delivered" | "failed",
  now = Date.now(),
  error?: string | null
): D1PreparedStatement {
  if (outcome === "delivered") {
    return db
      .prepare(
        `UPDATE scheduled_messages
            SET status = 'delivered',
                delivered_at = ?,
                sent_at = COALESCE(sent_at, ?),
                updated_at = ?
          WHERE channel = ?
            AND dispatch_ref = ?
            AND status IN ('sent', 'dispatched')`
      )
      .bind(now, now, now, channel, dispatchRef);
  }

  if (outcome === "sent") {
    return db
      .prepare(
        `UPDATE scheduled_messages
            SET status = 'sent',
                sent_at = COALESCE(sent_at, ?),
                updated_at = ?
          WHERE channel = ?
            AND dispatch_ref = ?
            AND status IN ('sent', 'dispatched')`
      )
      .bind(now, now, channel, dispatchRef);
  }

  const reason = error === undefined || error === null || error.trim() === ""
    ? "failed"
    : error.slice(0, 200);
  return db
    .prepare(
      `UPDATE scheduled_messages
          SET status = 'failed',
              last_error = ?,
              updated_at = ?
        WHERE channel = ?
          AND dispatch_ref = ?
          AND status IN ('sent', 'dispatched')`
    )
    .bind(reason, now, channel, dispatchRef);
}

/**
 * Statements that copy SMS carrier receipts onto the scheduled row.
 *
 * The `messages` mirror records what the console shows per message; this is the
 * scheduled lifecycle's own outcome. The row is found by `dispatch_ref`, which
 * the Scheduler sets to the command id for an SMS send (the row's UUID), and
 * the caller adds these to the same `env.DB.batch()` as the message mirror so
 * one receipt updates both surfaces together.
 */
export function mirrorScheduledDelivery(
  db: D1Database,
  _deviceId: string,
  updates: AppliedUpdate[],
  now = Date.now()
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];

  for (const update of updates) {
    if (update.status === "DELIVERED") {
      statements.push(mirrorScheduledStatus(db, "sms", update.command_id, "delivered", now));
      continue;
    }

    if (update.status === "FAILED" || update.status === "EXPIRED") {
      statements.push(
        mirrorScheduledStatus(db, "sms", update.command_id, "failed", now, deliveryError(update))
      );
    }
  }

  return statements;
}

/* ------------------------------------------------------------------------- *
 * Peers
 * ------------------------------------------------------------------------- */

const SMS_CLEAN_RE = /[\s\-()]/g;
const SMS_PLUS_RE = /^\+\d{8,15}$/;
const SMS_BARE_RE = /^\d{8,15}$/;

/**
 * Normalise an address for the channel it will be sent on.
 *
 * SMS is E.164 once it reaches the handset: spaces, dashes and parentheses are
 * cosmetic and a bare national-looking number is given the `+` the carrier
 * expects. Anything that is not 8-15 digits is rejected rather than guessed at.
 * Other channels use opaque ids (a WhatsApp wa_id, a Telegram chat id, a Meta
 * PSID/IGSID) and are only trimmed and length-checked.
 */
export function normalisePeer(channel: string, peer: string): string | null {
  if (typeof peer !== "string") return null;
  if (channel === "sms") {
    const cleaned = peer.trim().replace(SMS_CLEAN_RE, "");
    if (SMS_PLUS_RE.test(cleaned)) return cleaned;
    if (SMS_BARE_RE.test(cleaned)) return `+${cleaned}`;
    return null;
  }
  const trimmed = peer.trim();
  if (trimmed.length < 1 || trimmed.length > 256) return null;
  return trimmed;
}

/* ------------------------------------------------------------------------- *
 * Opt-out keywords
 * ------------------------------------------------------------------------- */

export type OptOutAction = "stop" | "start";

/**
 * The carrier keyword set, interpreted per the CTIA conventions.
 *
 * The match is the whole trimmed body, case-insensitive, and nothing else: a
 * sentence that happens to contain "stop" is a message, not a subscription
 * command. `UNSUBSCRIBE`, `CANCEL`, `END` and `QUIT` are the other standard
 * opt-out words, and `UNSTOP` is the standard resubscribe companion to STOP.
 */
const STOP_KEYWORDS: ReadonlySet<string> = new Set([
  "STOP",
  "UNSUBSCRIBE",
  "CANCEL",
  "END",
  "QUIT",
]);
const START_KEYWORDS: ReadonlySet<string> = new Set(["START", "UNSTOP"]);

export function smsOptOutAction(body: string): OptOutAction | null {
  const normalized = body.trim().toUpperCase();
  if (STOP_KEYWORDS.has(normalized)) return "stop";
  if (START_KEYWORDS.has(normalized)) return "start";
  return null;
}

/** Whether the audience row for `(channel, peer)` is opted out. */
export async function isPeerOptedOut(
  db: D1Database,
  channel: string,
  peer: string
): Promise<boolean> {
  const row = await db
    .prepare(`SELECT opt_out FROM contacts WHERE channel = ? AND peer = ?`)
    .bind(channel, peer)
    .first<{ opt_out: number }>();
  return row !== null && row.opt_out === 1;
}

/**
 * The contacts upsert a STOP/START keyword performs.
 *
 * An audience row may not exist yet: the recipient texted us, so they are a
 * peer the operator can message. The insert creates that row, and the
 * `ON CONFLICT` arm only touches the flag and its timestamp, preserving tags,
 * attrs and the operator's chosen timezone. Exported so the incoming route and
 * its tests share one statement.
 */
export function optOutContactStatement(
  db: D1Database,
  peer: string,
  action: OptOutAction,
  now: number
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO contacts
         (id, channel, peer, name, attrs_json, tags_json, timezone, opt_out, created_at, updated_at)
       VALUES (?, 'sms', ?, NULL, '{}', '[]', 'UTC', ?, ?, ?)
       ON CONFLICT(channel, peer) DO UPDATE SET
         opt_out = excluded.opt_out, updated_at = excluded.updated_at`
    )
    .bind(crypto.randomUUID(), peer, action === "stop" ? 1 : 0, now, now);
}

/* ------------------------------------------------------------------------- *
 * Submission spacing
 * ------------------------------------------------------------------------- */

/**
 * A stable per-message gap in `8000..15000` milliseconds.
 *
 * This is the spacing between two submissions to the handset, so a SIM is not
 * handed a burst of PDU writes. It is *not* a radio governor and does not claim
 * to model the carrier: the `max_per_hour` token bucket is the rate ceiling and
 * this is the minimum gap between individual sends. Deriving it from the id
 * means a retry of the same row waits the same amount, which is what makes a
 * re-dispatch after a lease look like the first attempt rather than a new
 * pattern.
 *
 * FNV-1a over the UTF-16 code units, 32-bit, mapped onto a 7001-value window.
 */
export function deterministicJitterMs(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return 8000 + ((hash >>> 0) % 7001);
}

/* ------------------------------------------------------------------------- *
 * Quiet hours
 * ------------------------------------------------------------------------- */

export interface QuietHoursPolicy {
  timezone: string;
  quietStartHour: number;
  quietEndHour: number;
}

/**
 * A timezone the runtime does not know. The route answers `bad_timezone`; this
 * is thrown rather than falling back to UTC because a silent fallback sends at
 * 03:00 in a place the operator explicitly asked not to.
 */
export class InvalidTimezoneError extends Error {
  readonly code = "bad_timezone" as const;

  constructor(readonly timezone: string) {
    super(`unknown IANA timezone: ${timezone}`);
    this.name = "InvalidTimezoneError";
  }
}

function formatterFor(timezone: string): Intl.DateTimeFormat {
  if (typeof timezone !== "string" || timezone.trim() === "") {
    throw new InvalidTimezoneError(timezone);
  }
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit"
    });
  } catch {
    throw new InvalidTimezoneError(timezone);
  }
}

function localHourMinute(epochMs: number, timezone: string): { hour: number; minute: number } {
  const parts = formatterFor(timezone).formatToParts(new Date(epochMs));
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0") % 24;
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  return { hour, minute };
}

function hourOf(hour: number): number {
  return ((hour % 24) + 24) % 24;
}

/** Equal start and end means the quiet window is switched off. */
function inQuietWindow(hour: number, start: number, end: number): boolean {
  const from = hourOf(start);
  const to = hourOf(end);
  if (from === to) return false;
  return from > to ? hour >= from || hour < to : hour >= from && hour < to;
}

/**
 * Whether `epochMs` falls inside the policy's quiet window, read on the wall
 * clock of `policy.timezone`. Throws `InvalidTimezoneError` for a bad zone.
 */
export function isWithinQuietHours(epochMs: number, policy: QuietHoursPolicy): boolean {
  const { hour } = localHourMinute(epochMs, policy.timezone);
  return inQuietWindow(hour, policy.quietStartHour, policy.quietEndHour);
}

/** Drop the sub-minute part: every modern zone offset is a whole minute. */
function startOfMinute(epochMs: number): number {
  return epochMs - (((epochMs % 60_000) + 60_000) % 60_000);
}

/**
 * The earliest instant at or after `now` that is outside quiet hours.
 *
 * Inside the window this is the next `quietEndHour:00` on that zone's wall
 * clock, plus up to five minutes of wake jitter so a fleet of devices does not
 * all wake on the same second. The wall clock is authoritative: a fixed UTC
 * delta would be wrong on either side of a DST change, so the candidate is
 * re-read through `Intl` and corrected until its local time is the end hour.
 * That also handles zones whose offset changes by 30 minutes.
 *
 * Equal start and end hours disable the window. A bad zone throws
 * `InvalidTimezoneError` instead of silently using UTC.
 */
export function nextAllowedInstant(
  now: number,
  policy: QuietHoursPolicy,
  rand: () => number = Math.random
): number {
  const { hour, minute } = localHourMinute(now, policy.timezone);
  if (!inQuietWindow(hour, policy.quietStartHour, policy.quietEndHour)) return now;

  const endHour = hourOf(policy.quietEndHour);
  const minuteStart = startOfMinute(now);
  // Hours until the end hour in a 24-hour view, then back off the minutes
  // already spent in this one.
  let target = minuteStart + ((((endHour - hour + 24) % 24) * 60 - minute) * 60_000);

  // Re-read the candidate's local time; a DST jump makes the naive arithmetic
  // off by the offset delta. Three passes is far more than any real zone needs.
  for (let pass = 0; pass < 3; pass += 1) {
    const local = localHourMinute(target, policy.timezone);
    const correctionMinutes = (endHour - local.hour) * 60 - local.minute;
    if (correctionMinutes === 0) break;
    target += correctionMinutes * 60_000;
  }

  const wakeJitterMs = Math.round(rand() * 5 * 60_000);
  return target + wakeJitterMs;
}

/* ------------------------------------------------------------------------- *
 * Token bucket (per pacing_key)
 * ------------------------------------------------------------------------- */

export interface TokenBucketState {
  tokens: number;
  refilledAt: number;
}

export type TakeTokenResult =
  | { ok: true; state: TokenBucketState }
  | { ok: false; nextAt: number };

/** `capacity` per rolling hour, expressed as tokens per second. */
function refillPerSecond(capacity: number): number {
  return Math.max(0, capacity) / 3600;
}

function refilled(state: TokenBucketState, capacity: number, now: number): number {
  const cap = Math.max(0, capacity);
  const elapsedSeconds = Math.max(0, now - state.refilledAt) / 1000;
  return Math.min(cap, Math.max(0, state.tokens) + elapsedSeconds * refillPerSecond(capacity));
}

function instantForOneToken(tokens: number, capacity: number, now: number): number {
  const rate = refillPerSecond(capacity);
  if (rate <= 0) return Number.POSITIVE_INFINITY;
  return now + Math.ceil(((1 - tokens) / rate) * 1000);
}

/**
 * Spend one send from a bucket. A capacity of 40 is 40 sends per rolling hour;
 * the 8-15 s gap between submissions is `deterministicJitterMs`, not this.
 *
 * A deferral never calls this: a message moved to a later `send_at` has not
 * been submitted, so it must not consume capacity.
 */
export function takeToken(
  state: TokenBucketState,
  capacity: number,
  now: number
): TakeTokenResult {
  const tokens = refilled(state, capacity, now);
  if (tokens >= 1) {
    return { ok: true, state: { tokens: tokens - 1, refilledAt: now } };
  }
  return { ok: false, nextAt: instantForOneToken(tokens, capacity, now) };
}

/** When a bucket will next have a token, for re-arming an alarm. */
export function nextTokenAt(state: TokenBucketState, capacity: number, now: number): number {
  const tokens = refilled(state, capacity, now);
  return tokens >= 1 ? now : instantForOneToken(tokens, capacity, now);
}

/* ------------------------------------------------------------------------- *
 * D1 rows and helpers
 * ------------------------------------------------------------------------- */

export interface ScheduledRow {
  id: string;
  campaign_id: string | null;
  channel: string;
  target_type: "device" | "connector";
  target_id: string;
  pacing_key: string;
  to_peer: string;
  body: string;
  template_id: string | null;
  vars_json: string;
  policy_json: string;
  timezone: string;
  sim_slot: number | null;
  send_at: number;
  expires_at: number | null;
  status: ScheduledStatus;
  attempts: number;
  shift_count: number;
  last_shift_reason: string | null;
  claim_token: string | null;
  claimed_at: number | null;
  dispatched_at: number | null;
  sent_at: number | null;
  delivered_at: number | null;
  dispatch_ref: string | null;
  idempotency_key: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * Atomically take ownership of a due row.
 *
 * One conditional UPDATE is the claim: due, unexpired, still `scheduled`. The
 * attempt counter is incremented here so a crash after this point is visible as
 * an attempt, and the caller gets the row it now owns. `RETURNING *` is used
 * through `.first()`; the tests exercise it against the D1 shim.
 */
export async function claimScheduled(
  db: D1Database,
  id: string,
  token: string,
  now: number
): Promise<ScheduledRow | null> {
  const row = await db
    .prepare(
      `UPDATE scheduled_messages
          SET status = 'dispatching',
              claim_token = ?,
              claimed_at = ?,
              attempts = attempts + 1,
              updated_at = ?
        WHERE id = ?
          AND status = 'scheduled'
          AND send_at <= ?
          AND (expires_at IS NULL OR expires_at > ?)
       RETURNING *`
    )
    .bind(token, now, now, id, now, now)
    .first<ScheduledRow>();
  return row ?? null;
}

export interface CancelResult {
  ok: boolean;
  /** The row's status after the attempt; null when no such row exists. */
  status: ScheduledStatus | null;
}

/**
 * Cancel a row that has not been dispatched.
 *
 * The UPDATE is the whole decision: a row already `dispatching` is no longer
 * cancellable and changes zero rows. The route maps any non-null status other
 * than `cancelled` to 409 `not_cancellable`.
 */
export async function cancelScheduled(
  db: D1Database,
  id: string,
  now: number
): Promise<CancelResult> {
  const result = await db
    .prepare(
      `UPDATE scheduled_messages
          SET status = 'cancelled', updated_at = ?
        WHERE id = ? AND status = 'scheduled'`
    )
    .bind(now, id)
    .run();
  if ((result.meta?.changes ?? 0) > 0) return { ok: true, status: "cancelled" };

  const row = await db
    .prepare(`SELECT status FROM scheduled_messages WHERE id = ?`)
    .bind(id)
    .first<{ status: ScheduledStatus }>();
  return { ok: false, status: row?.status ?? null };
}

/** The statuses a dispatcher may report; anything earlier is not a report. */
export type FinalizeStatus = "dispatched" | "sent" | "delivered" | "failed" | "unknown";

export interface FinalizePatch {
  dispatchRef?: string | null;
  error?: string | null;
}

/**
 * Record a dispatch outcome while holding the claim.
 *
 * Fenced by `status = 'dispatching' AND claim_token = ?`, so a stale dispatcher
 * cannot write after a lease recovery or a second finalize. `statusAdvances`
 * rejects a target that is not ahead of `dispatching`; in practice the fence has
 * already established the starting point, and this keeps a future caller from
 * routing `scheduled` through it. Timestamps are filled in only when the row
 * reaches that stage, so a `delivered` report also completes `sent` and
 * `dispatched` if the intermediate receipts were lost.
 */
export async function finalizeScheduled(
  db: D1Database,
  id: string,
  token: string,
  status: FinalizeStatus,
  patch: FinalizePatch,
  now: number
): Promise<ScheduledRow | null> {
  if (!statusAdvances("dispatching", status)) return null;

  const row = await db
    .prepare(
      `UPDATE scheduled_messages
          SET status = ?,
              dispatch_ref = COALESCE(?, dispatch_ref),
              last_error = COALESCE(?, last_error),
              dispatched_at = CASE
                WHEN ? IN ('dispatched', 'sent', 'delivered') AND dispatched_at IS NULL
                THEN ? ELSE dispatched_at END,
              sent_at = CASE
                WHEN ? IN ('sent', 'delivered') AND sent_at IS NULL
                THEN ? ELSE sent_at END,
              delivered_at = CASE
                WHEN ? = 'delivered' AND delivered_at IS NULL
                THEN ? ELSE delivered_at END,
              updated_at = ?
        WHERE id = ? AND status = 'dispatching' AND claim_token = ?
       RETURNING *`
    )
    .bind(
      status,
      patch.dispatchRef ?? null,
      patch.error ?? null,
      status,
      now,
      status,
      now,
      status,
      now,
      now,
      id,
      token
    )
    .first<ScheduledRow>();
  return row ?? null;
}

/** A terminal skip that is decided before or after a claim, never an attempt. */
export type SkipStatus = "skipped_window" | "skipped_opt_out";

/**
 * Mark a row skipped without pretending it was dispatched.
 *
 * Two callers exist and they sit on opposite sides of the claim:
 *
 *   - the Scheduler's pre-claim checks (deadline passed, contact opted out)
 *     change a row that is still `scheduled`;
 *   - a connector send learns about a closed window or an opt-out only after
 *     the row is `dispatching`, so the claim token fences that write.
 *
 * Neither path is a send, so `attempts` is untouched. The conditional WHERE is
 * the decision: a row another dispatcher already moved is not overwritten.
 */
export async function skipScheduled(
  db: D1Database,
  id: string,
  status: SkipStatus,
  reason: string,
  now: number,
  claimToken?: string
): Promise<boolean> {
  const result =
    claimToken === undefined
      ? await db
          .prepare(
            `UPDATE scheduled_messages
                SET status = ?, last_error = ?, updated_at = ?
              WHERE id = ? AND status = 'scheduled'`
          )
          .bind(status, reason, now, id)
          .run()
      : await db
          .prepare(
            `UPDATE scheduled_messages
                SET status = ?, last_error = ?, updated_at = ?
              WHERE id = ? AND status = 'dispatching' AND claim_token = ?`
          )
          .bind(status, reason, now, id, claimToken)
          .run();
  return (result.meta?.changes ?? 0) > 0;
}

/**
 * Push a not-yet-dispatched row to a later instant.
 *
 * Only `scheduled` rows move: once a dispatcher owns the row, changing `send_at`
 * would race the alarm. A deferral is not an attempt — `attempts` is untouched
 * so a window shift cannot exhaust a retry budget — but it is counted and its
 * reason kept for the operator.
 */
export async function deferScheduled(
  db: D1Database,
  id: string,
  sendAt: number,
  reason: string,
  now: number
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE scheduled_messages
          SET send_at = ?,
              shift_count = shift_count + 1,
              last_shift_reason = ?,
              updated_at = ?
        WHERE id = ? AND status = 'scheduled'`
    )
    .bind(sendAt, reason, now, id)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

export interface RecoverResult {
  requeued: number;
  unknown: number;
}

/**
 * Resolve rows abandoned mid-dispatch.
 *
 * A device send is keyed by a UUID command id, so re-queueing it is safe: the
 * handset accepts the same command once and the second attempt is a no-op. A
 * connector send has an external effect we cannot observe, so marking it
 * `unknown` is the only honest outcome — it is neither retried blindly nor
 * reported as delivered.
 */
export async function recoverStale(
  db: D1Database,
  leaseMs: number,
  now: number
): Promise<RecoverResult> {
  const staleBefore = now - Math.max(0, leaseMs);

  const requeued = await db
    .prepare(
      `UPDATE scheduled_messages
          SET status = 'scheduled',
              claim_token = NULL,
              claimed_at = NULL,
              updated_at = ?
        WHERE status = 'dispatching'
          AND target_type = 'device'
          AND COALESCE(claimed_at, updated_at) <= ?`
    )
    .bind(now, staleBefore)
    .run();

  const unknown = await db
    .prepare(
      `UPDATE scheduled_messages
          SET status = 'unknown',
              last_error = 'outcome unknown after a dispatch lease',
              claim_token = NULL,
              claimed_at = NULL,
              updated_at = ?
        WHERE status = 'dispatching'
          AND target_type = 'connector'
          AND COALESCE(claimed_at, updated_at) <= ?`
    )
    .bind(now, staleBefore)
    .run();

  return {
    requeued: requeued.meta?.changes ?? 0,
    unknown: unknown.meta?.changes ?? 0
  };
}
