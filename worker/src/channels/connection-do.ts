/**
 * `ChannelConnection` — one Durable Object per external channel account.
 *
 * Addressed as `env.CHANNEL_CONN.getByName(`${channel}:${account_id}`)`, so three WhatsApp numbers,
 * two Instagram accounts and three Telegram bots are eight isolated objects rather than one hot one.
 * Each is a single-threaded SQLite database that can sustain its own request budget.
 *
 * The rules this file keeps, from Cloudflare's Durable Objects guidance:
 *
 *  1. `blockConcurrencyWhile()` appears exactly once, in the constructor, for schema creation. It is
 *     never held across `fetch`, D1, KV or Queue calls — doing that caps the object at roughly
 *     `1 / duration` requests per second and is the most common way a DO becomes a bottleneck.
 *  2. Dedupe, the 24-hour window and the token buckets live here, in colocated SQLite. A retried
 *     Meta delivery is answered from this database with zero D1 writes.
 *  3. Fresh events leave asynchronously through `INGEST_QUEUE`; the consumer writes them in one D1
 *     batch. The object never writes D1 itself.
 *  4. `revokeAndDestroy()` clears the alarm and the storage, so a deleted connector stops billing.
 *
 * Two deviations from the scaffold this was ported from, both deliberate:
 *
 *  - The dedupe check is an `INSERT … ON CONFLICT DO NOTHING` inside the transaction rather than a
 *    `SELECT` followed by an `INSERT`. The transaction already made it atomic; the insert-or-ignore
 *    makes the intent legible and saves a statement per event.
 *  - `alarm()` prunes `peer_windows` rows whose window closed more than a week ago as well as the
 *    dedupe ledger. Without that the window table is the thing that grows forever.
 */

import { DurableObject } from "cloudflare:workers";

export interface NormalizedChannelEvent {
  connectorId: string;
  channel: string;
  accountId: string;
  eventKind: "inbound_message" | "status_update";
  /** wamid, mid, telegram update_id or a device-local id. Unique per connection. */
  eventId: string;
  peerId: string;
  body?: string;
  status?: string;
  errorCode?: string;
  timestamp: number;
  rawJson?: string;
}

export interface IngestResult {
  accepted: number;
  deduplicated: number;
}

export interface WindowCheckResult {
  open: boolean;
  optedOut: boolean;
  expiresAt: number | null;
}

/** Meta retries for up to 36 hours; a week of ledger is margin, not speculation. */
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Only what this object needs from the environment; the Worker's `Env` is wider. */
export interface ChannelConnectionEnv {
  INGEST_QUEUE: Queue<NormalizedChannelEvent>;
}

export class ChannelConnection extends DurableObject<ChannelConnectionEnv> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: ChannelConnectionEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    // The only permissible use of blockConcurrencyWhile: local schema, before any event is handled.
    ctx.blockConcurrencyWhile(async () => {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS seen_events (
          event_id    TEXT PRIMARY KEY NOT NULL,
          received_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_seen_events_age ON seen_events (received_at);

        CREATE TABLE IF NOT EXISTS peer_windows (
          peer_id           TEXT PRIMARY KEY NOT NULL,
          last_inbound_at   INTEGER NOT NULL,
          window_expires_at INTEGER NOT NULL,
          opted_out         INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS rate_state (
          bucket      TEXT PRIMARY KEY NOT NULL,
          tokens      REAL NOT NULL,
          refilled_at INTEGER NOT NULL
        );
      `);
    });
  }

  /**
   * Dedupe and window update in synchronous SQLite, then hand the fresh events to the queue.
   *
   * Synchronous on purpose: no `await` inside `transactionSync`, so the read-check-write cannot
   * interleave with another request. The queue push happens after the transaction commits.
   */
  async ingestEvents(events: NormalizedChannelEvent[]): Promise<IngestResult> {
    const now = Date.now();
    const fresh: NormalizedChannelEvent[] = [];
    let deduplicated = 0;

    this.ctx.storage.transactionSync(() => {
      for (const event of events) {
        // Insert-or-ignore is the dedupe. `changes()` is asked rather than the cursor's
        // `rowsWritten`: an `ON CONFLICT DO NOTHING` that changed nothing still reports a written
        // row on this API, so trusting it made every retry look fresh — the benchmark caught it
        // as 600 stored rows for 430 unique events. `changes()` is SQLite's own count for the
        // statement just executed, and it is 0 exactly when the row already existed.
        this.sql.exec(
          "INSERT INTO seen_events (event_id, received_at) VALUES (?, ?) ON CONFLICT(event_id) DO NOTHING",
          event.eventId,
          now
        );
        const inserted = this.sql.exec<{ c: number }>("SELECT changes() AS c").toArray()[0]?.c ?? 0;
        if (inserted === 0) {
          deduplicated += 1;
          continue;
        }

        if (event.eventKind === "inbound_message" && event.peerId !== "") {
          const text = (event.body ?? "").trim().toUpperCase();
          const isStop = text === "STOP" || text === "UNSUBSCRIBE";
          const isStart = text === "START" || text === "SUBSCRIBE";
          this.sql.exec(
            `INSERT INTO peer_windows (peer_id, last_inbound_at, window_expires_at, opted_out)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(peer_id) DO UPDATE SET
               last_inbound_at   = excluded.last_inbound_at,
               window_expires_at = excluded.window_expires_at,
               opted_out = CASE
                 WHEN ? = 1 THEN 1
                 WHEN ? = 1 THEN 0
                 ELSE peer_windows.opted_out
               END`,
            event.peerId,
            event.timestamp,
            event.timestamp + TWENTY_FOUR_HOURS_MS,
            isStop ? 1 : 0,
            isStop ? 1 : 0,
            isStart ? 1 : 0
          );
        }

        fresh.push(event);
      }
    });

    // Arm the pruner once; an existing alarm is left alone so a busy connection does not reset it.
    if ((await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(now + PRUNE_INTERVAL_MS);
    }

    if (fresh.length > 0) {
      await this.env.INGEST_QUEUE.sendBatch(fresh.map((body) => ({ body })));
    }

    return { accepted: fresh.length, deduplicated };
  }

  /** The 24-hour window and opt-out state, from local storage: zero D1 reads per outbound check. */
  async checkWindow(peerId: string): Promise<WindowCheckResult> {
    const now = Date.now();
    const row = this.sql
      .exec<{ window_expires_at: number; opted_out: number }>(
        "SELECT window_expires_at, opted_out FROM peer_windows WHERE peer_id = ?",
        peerId
      )
      .toArray()[0];
    if (row === undefined) return { open: false, optedOut: false, expiresAt: null };
    return {
      open: row.opted_out === 0 && row.window_expires_at > now,
      optedOut: row.opted_out === 1,
      expiresAt: row.window_expires_at,
    };
  }

  /** One token bucket per account, so one number's ceiling cannot starve another's. */
  async takeRateToken(bucket: string, capacity: number, refillPerSec: number): Promise<boolean> {
    const now = Date.now();
    let allowed = false;
    this.ctx.storage.transactionSync(() => {
      const row = this.sql
        .exec<{ tokens: number; refilled_at: number }>(
          "SELECT tokens, refilled_at FROM rate_state WHERE bucket = ?",
          bucket
        )
        .toArray()[0];
      const previousTokens = row === undefined ? capacity : row.tokens;
      const previousAt = row === undefined ? now : row.refilled_at;
      const elapsedSeconds = Math.max(0, (now - previousAt) / 1000);
      const tokens = Math.min(capacity, previousTokens + elapsedSeconds * refillPerSec);
      if (tokens < 1) return;
      allowed = true;
      this.sql.exec(
        `INSERT INTO rate_state (bucket, tokens, refilled_at) VALUES (?, ?, ?)
         ON CONFLICT(bucket) DO UPDATE SET tokens = excluded.tokens, refilled_at = excluded.refilled_at`,
        bucket,
        tokens - 1,
        now
      );
    });
    return allowed;
  }

  /** Prune the dedupe ledger and closed windows, then re-arm while anything is left. */
  override async alarm(): Promise<void> {
    const now = Date.now();
    this.sql.exec("DELETE FROM seen_events WHERE received_at < ?", now - SEVEN_DAYS_MS);
    this.sql.exec("DELETE FROM peer_windows WHERE window_expires_at < ?", now - SEVEN_DAYS_MS);
    const remaining =
      this.sql.exec<{ c: number }>("SELECT COUNT(*) AS c FROM seen_events").toArray()[0]?.c ?? 0;
    if (remaining > 0) {
      await this.ctx.storage.setAlarm(now + PRUNE_INTERVAL_MS);
    }
  }

  /** Connector revoked or deleted: stop the timer and release the storage this object bills for. */
  async revokeAndDestroy(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}
