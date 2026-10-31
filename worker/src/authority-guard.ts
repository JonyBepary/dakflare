/**
 * AuthorityGuard — the single, globally named Durable Object that owns grant
 * expiry timers.
 *
 * Why an object exists here at all, when `expires_at` already makes a grant
 * unusable: the D1 check answers "may I use this", and it is the only check that
 * can ever grant access. The timer answers a different question — "did anyone
 * notice the window close" — and it must fire on time even if no request
 * touches the deployment for a day. That is what lets the console show a grant
 * as closed, writes the `authority.expired` audit row, and is where a push to
 * the console or the handset belongs when one is added.
 *
 * It is deliberately tiny and mirrors `AuthGuard`: one object named by a
 * constant, one table, one alarm. No per-request work, no state that can
 * disagree with D1 — a timer that fires late or not at all changes nothing about
 * what a grant may do, because D1 is authoritative.
 *
 * Schema
 * ------
 *   grant_timers(grant_id TEXT PRIMARY KEY,
 *                run_at   INTEGER NOT NULL,
 *                scope    TEXT NOT NULL,
 *                agent_token_id TEXT NOT NULL)
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";

/** The constant name every isolate uses, so they all address one object. */
export const AUTHORITY_GUARD_OBJECT_NAME = "global";

/** Bounded, like every other table a caller can grow. */
const MAX_TIMERS = 5_000;

interface TimerRow {
  grant_id: string;
  run_at: number;
  scope: string;
  agent_token_id: string;
}

export class AuthorityGuard extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS grant_timers (
          grant_id       TEXT PRIMARY KEY,
          run_at         INTEGER NOT NULL,
          scope          TEXT NOT NULL,
          agent_token_id TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_grant_timers_run_at ON grant_timers(run_at);
      `);
    });
  }

  /**
   * Arm (or re-arm) the timer for one grant.
   *
   * A grant is created already-expired-checked by D1, so the timer only has to
   * be right about WHEN. Re-arming replaces the row, which is what a superseded
   * grant needs: the newest decision owns the deadline.
   */
  schedule(grantId: string, scope: string, agentTokenId: string, expiresAt: number): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO grant_timers (grant_id, run_at, scope, agent_token_id)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(grant_id) DO UPDATE SET
         run_at = excluded.run_at,
         scope = excluded.scope,
         agent_token_id = excluded.agent_token_id`,
      grantId,
      expiresAt,
      scope,
      agentTokenId
    );

    const rows = this.ctx.storage.sql
      .exec(`SELECT COUNT(*) AS n FROM grant_timers`)
      .toArray() as { n: number }[];
    const total = rows[0]?.n ?? 0;
    if (total > MAX_TIMERS) {
      // Evict the soonest-to-expire rows: they are the ones whose firing is
      // least informative, and D1 already refuses them.
      this.ctx.storage.sql.exec(
        `DELETE FROM grant_timers WHERE grant_id IN (
           SELECT grant_id FROM grant_timers ORDER BY run_at ASC LIMIT ?
         )`,
        total - MAX_TIMERS
      );
    }

    this.syncNextAlarm();
  }

  /** Drop the timer for a revoked grant. Revoked before expiry means no event. */
  cancel(grantId: string): void {
    this.ctx.storage.sql.exec(`DELETE FROM grant_timers WHERE grant_id = ?`, grantId);
    this.syncNextAlarm();
  }

  /** How many timers are armed. Used by `doctor` and the conformance suite. */
  count(): number {
    const rows = this.ctx.storage.sql
      .exec(`SELECT COUNT(*) AS n FROM grant_timers`)
      .toArray() as { n: number }[];
    return rows[0]?.n ?? 0;
  }

  override async alarm(): Promise<void> {
    try {
      const now = Date.now();
      const due = this.ctx.storage.sql
        .exec(
          `SELECT grant_id, run_at, scope, agent_token_id
             FROM grant_timers WHERE run_at <= ? ORDER BY run_at ASC LIMIT 100`,
          now
        )
        .toArray() as unknown as TimerRow[];

      for (const timer of due) {
        // Delete first: a failing audit write must not leave a timer that fires
        // every alarm tick forever. The grant is already unusable either way.
        this.ctx.storage.sql.exec(`DELETE FROM grant_timers WHERE grant_id = ?`, timer.grant_id);
        try {
          await this.env.DB.prepare(
            `INSERT INTO audit_log
               (id, at, actor_user, actor_label, action, subject, ip, user_agent, detail_json)
             VALUES (?, ?, NULL, 'authority', 'authority.expired', ?, NULL, NULL, ?)`
          )
            .bind(
              crypto.randomUUID(),
              now,
              timer.agent_token_id,
              JSON.stringify({ grant_id: timer.grant_id, scope: timer.scope })
            )
            .run();
        } catch (error) {
          console.error(`[authority] expiry audit failed: ${String(error)}`);
        }
      }
    } finally {
      this.syncNextAlarm();
    }
  }

  private syncNextAlarm(): void {
    const rows = this.ctx.storage.sql
      .exec(`SELECT MIN(run_at) AS m FROM grant_timers`)
      .toArray() as { m: number | null }[];
    const next = rows[0]?.m;
    if (next === null || next === undefined) {
      this.ctx.storage.deleteAlarm();
      return;
    }
    this.ctx.storage.setAlarm(Number(next));
  }
}
