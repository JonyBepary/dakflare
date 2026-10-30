/**
 * AuthGuard — the single, globally named Durable Object that owns the
 * failed-authentication counters.
 *
 * Before this class the 15-minute account/IP windows lived in isolate memory
 * (`lib/auth-limits.ts`). An attacker who rotated across Cloudflare locations
 * got a fresh budget at every isolate, and the Rate Limiting bindings could not
 * express a 15-minute window (they accept only 10 s or 60 s and return no
 * count). One object named by a constant reaches every request in every
 * location, so the threshold, the fixed non-extending lockout and the
 * `Retry-After` value are now the same everywhere.
 *
 * The object is deliberately tiny: one row per key, no per-guess rows, no audit
 * writes. A guess is exactly the request an attacker can repeat, so the
 * counter must not become the resource that runs out first (AUTH_PLAN §6).
 *
 * Schema
 * ------
 *   auth_windows(key TEXT PRIMARY KEY,
 *                window_start INTEGER NOT NULL,
 *                count INTEGER NOT NULL,
 *                locked_until INTEGER NOT NULL)
 *
 * `window_start` anchors the current window at the first counted failure.
 * `locked_until` is the fixed end of the lockout that `count` tripped; it is
 * never moved while the lockout is active. Rows whose window has run out and
 * whose lockout has expired are deleted on the next write, so the table cannot
 * grow without bound. A hard cap evicts the oldest rows under a spray of
 * invented addresses, exactly as the isolate map did.
 *
 * The policy constants stay in `lib/auth-limits.ts`; the caller passes `limit`
 * and `windowMs` to `hit`/`state` so this object has no second copy of them.
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "./index";

/**
 * The constant name every isolate uses. `idFromName` maps a name to a stable id,
 * so all locations address the same object. Changing this string would silently
 * start a new, empty counter.
 */
export const AUTH_GUARD_OBJECT_NAME = "global";

/** Same bound as the old isolate map: a spray of invented keys is bounded. */
const MAX_ROWS = 10_000;

export interface AuthGuardRecord {
  /** Failures inside the current window, including the one just recorded. */
  count: number;
  /** Start of the anchored window, in epoch milliseconds. */
  window_start: number;
  /** 0 when unlocked, otherwise the fixed instant the lockout ends. */
  locked_until: number;
}

export interface AuthGuardRequest {
  key: string;
  windowMs: number;
  /** ACCOUNT_FAILURE_LIMIT or IP_FAILURE_LIMIT, owned by the caller. */
  limit: number;
}

interface AuthWindowRow {
  key: string;
  window_start: number;
  count: number;
  locked_until: number;
}

export class AuthGuard extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS auth_windows (
          key          TEXT PRIMARY KEY,
          window_start INTEGER NOT NULL,
          count        INTEGER NOT NULL,
          locked_until INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_auth_windows_expiry
          ON auth_windows(locked_until, window_start);
      `);
    });
  }

  /**
   * Delete rows that can no longer affect a decision: the window has run out and
   * any lockout has expired. This runs before every read/write, so a read does
   * not resurrect an expired row and a write keeps the table small.
   */
  private prune(now: number, windowMs: number): void {
    this.ctx.storage.sql.exec(
      `DELETE FROM auth_windows
        WHERE locked_until <= ? AND window_start <= ?`,
      now,
      now - windowMs
    );
  }

  /** Keep the table bounded even when every key is invented and still live. */
  private cap(): void {
    const rows = this.ctx.storage.sql
      .exec(`SELECT COUNT(*) AS n FROM auth_windows`)
      .toArray() as { n: number }[];
    const total = rows[0]?.n ?? 0;
    if (total <= MAX_ROWS) return;
    this.ctx.storage.sql.exec(
      `DELETE FROM auth_windows WHERE key IN (
         SELECT key FROM auth_windows ORDER BY window_start ASC LIMIT ?
       )`,
      total - MAX_ROWS
    );
  }

  private read(key: string): AuthWindowRow | null {
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT key, window_start, count, locked_until
           FROM auth_windows WHERE key = ?`,
        key
      )
      .toArray() as unknown as AuthWindowRow[];
    return rows[0] ?? null;
  }

  /**
   * Count one failure. While a lockout is active the row is returned unchanged:
   * a failure inside a lockout must never extend it. The fifth account failure
   * (or twentieth IP failure) sets `locked_until` on this same call, so the
   * caller can answer that request with 429 rather than 401.
   */
  private record(request: AuthGuardRequest, now: number): AuthGuardRecord {
    this.prune(now, request.windowMs);
    let row = this.read(request.key);

    // An active lockout outlives the window that produced it: the threshold
    // failure can land late in the window, so `window_start + windowMs` may be
    // earlier than `locked_until`. Check the lock BEFORE deciding the window has
    // rolled over, or a late lock would be silently dropped.
    if (row !== null && row.locked_until > now) {
      return {
        count: row.count,
        window_start: row.window_start,
        locked_until: row.locked_until,
      };
    }

    if (row !== null && row.locked_until <= now) row.locked_until = 0;

    if (row === null || now - row.window_start >= request.windowMs) {
      row = {
        key: request.key,
        window_start: now,
        count: 0,
        locked_until: 0,
      };
    }

    row.count += 1;
    if (row.count >= request.limit && row.locked_until === 0) {
      row.locked_until = now + request.windowMs;
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO auth_windows (key, window_start, count, locked_until)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         window_start = excluded.window_start,
         count        = excluded.count,
         locked_until = excluded.locked_until`,
      row.key,
      row.window_start,
      row.count,
      row.locked_until
    );
    this.cap();

    return {
      count: row.count,
      window_start: row.window_start,
      locked_until: row.locked_until,
    };
  }

  private readState(request: AuthGuardRequest, now: number): AuthGuardRecord | null {
    this.prune(now, request.windowMs);
    const row = this.read(request.key);
    if (row === null) return null;

    // An active lockout is authoritative even when the anchored window has
    // already run out: the threshold failure may have happened near the end of
    // the window, and its fixed 15 minutes must still be served.
    if (row.locked_until > now) {
      return {
        count: row.count,
        window_start: row.window_start,
        locked_until: row.locked_until,
      };
    }

    if (row.locked_until > 0) row.locked_until = 0; // expired lock
    if (now - row.window_start >= request.windowMs) return null;
    // Keep the threshold invariant explicit even if a row was written by an
    // older policy: a count at the limit is a lockout.
    if (row.locked_until === 0 && row.count >= request.limit) {
      row.locked_until = now + request.windowMs;
      this.ctx.storage.sql.exec(
        `UPDATE auth_windows SET locked_until = ? WHERE key = ?`,
        row.locked_until,
        row.key
      );
    }
    return {
      count: row.count,
      window_start: row.window_start,
      locked_until: row.locked_until,
    };
  }

  /** RPC: count one failure for `key`. */
  hit(key: string, windowMs: number, limit: number): AuthGuardRecord {
    return this.record({ key, windowMs, limit }, Date.now());
  }

  /** RPC: read the live counter for `key` without recording a hit. */
  state(key: string, windowMs: number, limit: number): AuthGuardRecord | null {
    return this.readState({ key, windowMs, limit }, Date.now());
  }

  /** RPC: clear the account window after a success. */
  clear(key: string): void {
    this.ctx.storage.sql.exec(`DELETE FROM auth_windows WHERE key = ?`, key);
  }

  /**
   * RPC batch helpers: the two keys a failure touches (account and IP) travel in
   * one Durable Object request instead of two. The public single-key methods
   * above remain the documented surface; these only save a round trip.
   */
  hitMany(requests: AuthGuardRequest[]): AuthGuardRecord[] {
    const now = Date.now();
    return requests.map((request) => this.record(request, now));
  }

  stateMany(requests: AuthGuardRequest[]): Array<AuthGuardRecord | null> {
    const now = Date.now();
    return requests.map((request) => this.readState(request, now));
  }
}
