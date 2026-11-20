/**
 * Scheduler: one globally named Durable Object owning the clock, the token
 * buckets and the minimum submission gap for scheduled sends.
 *
 * D1 is the only queue and the only cancellation authority: this object never
 * holds a message, it reads the earliest due row from `scheduled_messages` on
 * each alarm. That keeps a cancel or a new insert immediate (the route calls
 * `wake()`), survives eviction without replay state, and means a stale object
 * cannot resurrect a row D1 already cancelled.
 *
 * What lives here is only the pacing state D1 would have to serialise per send:
 *
 *   pacing_state(bucket, tokens, refilled_at, next_at)
 *
 * The row's `policy_json` snapshot is authoritative for quiet hours, the rate
 * ceiling and the minimum interval, so the route and this object use the same
 * arithmetic without sharing a clock. The alarm dispatches at most one message
 * per firing, which is what turns `next_at` into real spacing.
 *
 * Transport stays Worker-level: an SMS goes through `enqueueOutboundCommand`
 * and a connector through `sendConnectorOutbound`. This object never asks
 * `DeviceGateway` or `ChannelConnection` to own a scheduler.
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";
import { enqueueOutboundCommand } from "./lib/commands";
import { sendConnectorOutbound } from "./routes/channel-connectors";
import type { OutboundMessageParams } from "./plugins/types";
import {
  DEFAULT_CLOUD_PACING,
  DEFAULT_SMS_PACING,
  type PacingPolicy,
} from "./lib/pacing";
import {
  claimScheduled,
  deferScheduled,
  deterministicJitterMs,
  finalizeScheduled,
  nextAllowedInstant,
  recoverStale,
  skipScheduled,
  takeToken,
  type ScheduledRow,
  type TokenBucketState,
} from "./lib/scheduled";

/** The name every isolate uses, so they all address one object. */
export const SCHEDULER_OBJECT_NAME = "scheduler";

/**
 * A row claimed by a dispatcher that never reported is recovered after this.
 * Five minutes is longer than any device enqueue or connector HTTP call.
 */
export const DISPATCH_LEASE_MS = 5 * 60_000;

/** Bounded work per alarm: enough for a backlog, small enough to stay under a CPU limit. */
const MAX_DISPATCH_ITERATIONS = 50;

/** The policy snapshot stored on the row by the create route. */
interface PolicySnapshot {
  max_per_hour?: number;
  min_interval_ms?: number;
  jitter_pct?: number;
  quiet_start_hour?: number;
  quiet_end_hour?: number;
  timezone?: string;
  use_human_agent_tag?: boolean;
  comment_id?: string | number | null;
  /** WhatsApp platform template language and ordered body parameters. */
  template_language?: string;
  template_args?: string[];
}

interface PacingStateRow {
  bucket: string;
  tokens: number;
  refilled_at: number;
  next_at: number;
}

interface EarliestRow {
  next: number | null;
}

function parsePolicy(json: string, fallback: PacingPolicy): PolicySnapshot {
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as PolicySnapshot;
    }
  } catch {
    // A malformed snapshot cannot be repaired here; the safe fallback is the
    // deployment default for the target type, which quiet hours and pacing both
    // understand.
  }
  return {
    max_per_hour: fallback.maxPerHour,
    min_interval_ms: fallback.minIntervalMs,
    jitter_pct: fallback.jitterPct,
    quiet_start_hour: fallback.quietStartHour,
    quiet_end_hour: fallback.quietEndHour,
    timezone: fallback.timezone,
  };
}

export class Scheduler extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Schema only: `blockConcurrencyWhile` makes the table exist before any
    // request or alarm can read it. Pacing state is the only local state.
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS pacing_state (
          bucket      TEXT PRIMARY KEY,
          tokens      REAL NOT NULL,
          refilled_at INTEGER NOT NULL,
          next_at     INTEGER NOT NULL
        );
      `);
    });
  }

  /**
   * Make sure an alarm is armed for now. Called by the route after an insert or
   * a cancel: if an alarm is absent or later than now, pull it forward. An
   * alarm already in the past is left alone, because it is already about to run.
   */
  async wake(): Promise<void> {
    const now = Date.now();
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > now) {
      await this.ctx.storage.setAlarm(now);
    }
  }

  /**
   * Dispatch due rows, then always leave the queue with an alarm.
   *
   * The loop is bounded and stops as soon as the earliest row is in the future.
   * A quiet-hours deferral consumes no token and no attempt: the row has not
   * been submitted, so it must not pay for a send it did not make.
   */
  override async alarm(): Promise<void> {
    const now = Date.now();
    let armed = false;
    const arm = async (at: number): Promise<void> => {
      await this.ctx.storage.setAlarm(at);
      armed = true;
    };

    try {
      const recovered = await recoverStale(this.env.DB, DISPATCH_LEASE_MS, now);
      if (recovered.requeued > 0 || recovered.unknown > 0) {
        // Counts only: a peer or a body has no business in an operational log.
        console.log(
          `[scheduler] recovered stale leases: requeued=${recovered.requeued} unknown=${recovered.unknown}`
        );
      }

      for (let iteration = 0; iteration < MAX_DISPATCH_ITERATIONS; iteration += 1) {
        const row = await this.env.DB.prepare(
          `SELECT * FROM scheduled_messages
            WHERE status = 'scheduled'
            ORDER BY send_at ASC
            LIMIT 1`
        ).first<ScheduledRow>();

        if (row === null) return;
        if (row.send_at > now) {
          await arm(row.send_at);
          return;
        }

        const fallback = row.target_type === "device" ? DEFAULT_SMS_PACING : DEFAULT_CLOUD_PACING;
        const snapshot = parsePolicy(row.policy_json, fallback);
        const quietStartHour = numberOr(snapshot.quiet_start_hour, fallback.quietStartHour);
        const quietEndHour = numberOr(snapshot.quiet_end_hour, fallback.quietEndHour);
        const capacity = Math.max(0, numberOr(snapshot.max_per_hour, fallback.maxPerHour));

        // A campaign deadline that passed while the row waited is terminal. It
        // is still `scheduled`, so the unfenced form is correct here.
        if (row.expires_at !== null && row.expires_at <= now) {
          await skipScheduled(
            this.env.DB,
            row.id,
            "skipped_window",
            "campaign deadline passed",
            now
          );
          continue;
        }

        const contact = await this.env.DB.prepare(
          `SELECT opt_out FROM contacts WHERE channel = ? AND peer = ?`
        )
          .bind(row.channel, row.to_peer)
          .first<{ opt_out: number }>();
        if (contact !== null && contact.opt_out === 1) {
          await skipScheduled(this.env.DB, row.id, "skipped_opt_out", "recipient opted out", now);
          continue;
        }

        const shifted = nextAllowedInstant(now, {
          timezone: row.timezone,
          quietStartHour,
          quietEndHour,
        });
        if (shifted !== now) {
          await deferScheduled(this.env.DB, row.id, shifted, "quiet_hours", now);
          // No token, no attempt: loop again so another channel's row can move.
          continue;
        }

        const bucket = row.pacing_key;
        const states = this.ctx.storage.sql
          .exec(
            `SELECT bucket, tokens, refilled_at, next_at
               FROM pacing_state WHERE bucket = ?`,
            bucket
          )
          .toArray() as unknown as PacingStateRow[];
        const stateRow = states[0];

        const state: TokenBucketState = {
          tokens: stateRow?.tokens ?? capacity,
          refilledAt: stateRow?.refilled_at ?? now,
        };
        const take = takeToken(state, capacity, now);
        if (!take.ok) {
          // Capacity of zero reports an infinite instant; alarm arithmetic
          // cannot represent it, so wait an hour and re-evaluate the policy.
          const next = Number.isFinite(take.nextAt) ? take.nextAt : now + 3_600_000;
          await arm(Math.max(next, now + 1));
          return;
        }

        // The minimum gap is checked before anything is persisted, so a refusal
        // here does not silently spend the token `takeToken` computed.
        if (stateRow !== undefined && now < stateRow.next_at) {
          await arm(Math.max(stateRow.next_at, now + 1));
          return;
        }

        const claimToken = crypto.randomUUID();
        const claimed = await claimScheduled(this.env.DB, row.id, claimToken, now);
        if (claimed === null) {
          // Cancelled, or another dispatcher won the claim. Neither is ours.
          continue;
        }

        await this.dispatch(claimed, snapshot, now);

        // One send per alarm keeps the spacing. The token `takeToken` spent is
        // committed with the new gap only after the claim, so a row that lost
        // the claim never pays for a send it did not make.
        const nextAt = now + deterministicJitterMs(claimed.id);
        this.ctx.storage.sql.exec(
          `INSERT INTO pacing_state (bucket, tokens, refilled_at, next_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(bucket) DO UPDATE SET
             tokens = excluded.tokens,
             refilled_at = excluded.refilled_at,
             next_at = excluded.next_at`,
          bucket,
          take.state.tokens,
          take.state.refilledAt,
          nextAt
        );

        const earliest = await this.earliestSendAt();
        await arm(earliest === null ? nextAt : Math.min(earliest, nextAt));
        return;
      }
    } finally {
      // Never leave a live queue without an alarm. `armed` is set by every
      // deliberate early arm above; otherwise the earliest remaining row wins.
      if (!armed) {
        const earliest = await this.earliestSendAt();
        if (earliest === null) {
          await this.ctx.storage.deleteAlarm();
        } else {
          await this.ctx.storage.setAlarm(earliest);
        }
      }
    }
  }

  private async dispatch(
    row: ScheduledRow,
    snapshot: PolicySnapshot,
    now: number
  ): Promise<void> {
    const token = row.claim_token ?? "";

    if (row.target_type === "device") {
      const expiresAt = Math.min(
        row.expires_at ?? now + 86_400_000,
        now + 86_400_000
      );
      const outcome = await enqueueOutboundCommand(this.env, {
        deviceId: row.target_id,
        commandId: row.id,
        to: row.to_peer,
        body: row.body,
        priority: "normal",
        expiresAt,
        idempotencyKey: `sched:${row.id}`,
        simSlot: row.sim_slot ?? 0,
      });
      if (outcome.ok) {
        // `sent` means the transport accepted the command, not that the phone
        // delivered it. Delivery is a later receipt and never written here.
        await finalizeScheduled(
          this.env.DB,
          row.id,
          token,
          "sent",
          { dispatchRef: outcome.commandId },
          Date.now()
        );
      } else {
        await finalizeScheduled(
          this.env.DB,
          row.id,
          token,
          "failed",
          { error: "device enqueue rejected" },
          Date.now()
        );
      }
      return;
    }

    const params = {
      to: row.to_peer,
      body: row.body,
      ...(row.template_id === null ? {} : { templateId: row.template_id }),
      ...(typeof snapshot.template_language === "string"
        ? { templateLanguage: snapshot.template_language }
        : {}),
      ...(Array.isArray(snapshot.template_args)
        ? { templateArgs: snapshot.template_args.map(String) }
        : {}),
      ...(snapshot.use_human_agent_tag === true ? { useHumanAgentTag: true } : {}),
      ...(snapshot.comment_id === undefined || snapshot.comment_id === null
        ? {}
        : { commentId: String(snapshot.comment_id) }),
    } as OutboundMessageParams & { useHumanAgentTag?: boolean; commentId?: string };

    const result = await sendConnectorOutbound(
      this.env,
      row.channel,
      row.target_id,
      params
    );
    const finishedAt = Date.now();

    if (result.success) {
      await finalizeScheduled(
        this.env.DB,
        row.id,
        token,
        "sent",
        { dispatchRef: result.channelMessageId ?? null },
        finishedAt
      );
      return;
    }

    if (result.errorCode === "window_expired") {
      await skipScheduled(
        this.env.DB,
        row.id,
        "skipped_window",
        "customer service window expired",
        finishedAt,
        token
      );
      return;
    }
    if (result.errorCode === "opted_out") {
      await skipScheduled(
        this.env.DB,
        row.id,
        "skipped_opt_out",
        "recipient opted out",
        finishedAt,
        token
      );
      return;
    }

    await finalizeScheduled(
      this.env.DB,
      row.id,
      token,
      "failed",
      { error: result.errorCode ?? "connector send failed" },
      finishedAt
    );
  }

  private async earliestSendAt(): Promise<number | null> {
    const row = await this.env.DB.prepare(
      `SELECT MIN(send_at) AS next FROM scheduled_messages WHERE status = 'scheduled'`
    ).first<EarliestRow>();
    const next = row?.next;
    return next === null || next === undefined ? null : Number(next);
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
