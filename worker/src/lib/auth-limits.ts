/**
 * Failed-auth lockout — one global account window, one global IP window.
 *
 * The lane this closes: a wrong TOTP code on `disable`/`regenerate`, a wrong
 * password on `/v1/auth/sign-in/password`, and a wrong code on
 * `/api/auth/two-factor/verify-totp` during sign-in used to be counted by
 * nothing (or, for password sign-in, only by an IP/email request throttle that
 * never turned into a lockout). An attacker with a password could therefore
 * re-request a TOTP challenge and keep guessing forever.
 *
 * Why the counter is not in D1
 * ----------------------------
 * A guess is exactly the request an attacker can repeat without limit. Every
 * counter row, audit row or challenge write on that path spends the free tier's
 * 100,000-row daily budget (AUTH_PLAN §6) and, worse, makes the *defence* the
 * resource that runs out first. The authoritative 15-minute window therefore
 * lives in one Durable Object (`AuthGuard`, SQLite-backed) addressed by a
 * constant name, and this module keeps an isolate-local copy in front of it for
 * the hot path. A request refused here returns before the plugin, the audit
 * writer or D1 is touched.
 *
 * The 15-minute window and the Rate Limiting API
 * ----------------------------------------------
 * The Rate Limiting binding only accepts `period = 10` or `period = 60`
 * (wrangler config schema, and the runtime docs). It cannot express "5 failures
 * in 15 minutes", and its outcome is only `{ success }` — no count, no reset.
 * The bindings are therefore a *fallback* used only while the Durable Object is
 * unreachable: they back the threshold across isolates/colos (5/60 for an
 * account, 20/60 for an IP), while the object holds the 15-minute window and the
 * fixed lockout expiry. When the object is healthy it is strictly stronger, so
 * the bindings are not consulted on the normal path.
 *
 * Isolate cache
 * -------------
 * `accounts`/`ips` mirror the object's decision. A check is served from memory
 * unless the entry has never been synchronised or is older than 30 seconds; a
 * failure always goes to the object. The cache can be wrong in exactly two
 * ways, both bounded:
 *   - it can miss a lockout another location set less than 30 seconds ago, so
 *     one request at this isolate may still reach the password/TOTP check; and
 *   - it can hold a lock that another location cleared less than 30 seconds
 *     ago, so a correct sign-in can still receive 429 for at most 30 seconds.
 * Neither case lets an attacker exceed the global budget: the object still
 * records every failure, and the next revalidation sees it.
 *
 * DoS bound
 * ---------
 * A lockout is a fixed 15 minutes from the failure that tripped it and is never
 * extended while it is active: `checkAuthLockout` refuses before any attempt is
 * recorded, and the object returns an active row unchanged. The window is also
 * capped at one hour even if the deployment overrides it, because an unbounded
 * lockout is a denial-of-service primitive aimed at the account owner.
 */

import type { Env } from "../index";
import type { AuthGuard, AuthGuardRecord, AuthGuardRequest } from "../auth-guard";
import { AUTH_GUARD_OBJECT_NAME } from "../auth-guard";
import { requestMeta, writeAudit } from "../audit";

/** The bindings this module adds. Optional so an older deployment still runs. */
type LimitEnv = Env & {
  AUTH_GUARD?: DurableObjectNamespace<AuthGuard>;
  AUTH_ACCOUNT_LIMITER?: RateLimit;
  AUTH_IP_LIMITER?: RateLimit;
  AUTH_LOCKOUT_WINDOW_SECONDS?: string;
};

export const ACCOUNT_FAILURE_LIMIT = 5;
export const IP_FAILURE_LIMIT = 20;

const DEFAULT_WINDOW_SECONDS = 15 * 60;
const MIN_WINDOW_SECONDS = 1;
const MAX_WINDOW_SECONDS = 60 * 60;

/**
 * The binding's own window is 60 s. A success clears the account window here,
 * but the binding cannot be cleared; for one binding period after a success a
 * residual binding count must not re-lock the account. This is used only on the
 * fallback path, where the bindings are still consulted.
 */
const BINDING_PERIOD_MS = 60_000;

/** How long an isolate may trust its copy before asking the object again. */
const CACHE_TTL_MS = 30_000;

/** After a Durable Object error, skip it briefly instead of retrying per guess. */
const GUARD_RETRY_MS = 10_000;

/**
 * A Durable Object RPC that hangs is as unreachable as one that throws. Bound it
 * so a broken object cannot hold a sign-in open; the caller then takes the same
 * isolate-plus-bindings fallback as an error.
 */
const GUARD_TIMEOUT_MS = 2_000;

/** Bounded memory: an attacker can invent addresses, but not unbounded ones. */
const MAX_TRACKED = 10_000;

interface FailureWindow {
  /**
   * Local fallback history: ascending millisecond timestamps of failures this
   * isolate recorded. While the object is healthy the array is a synthetic copy
   * of its count, used only if the object later becomes unreachable.
   */
  hits: number[];
  /** 0 when unlocked; otherwise the instant the fixed lockout ends. */
  lockedUntil: number;
  /** When a success last cleared this account (binding grace period). */
  clearedAt: number;
  /** Last successful read from the Durable Object; 0 means never. */
  syncedAt: number;
}

export interface LockoutState {
  locked: boolean;
  /** Whole seconds until the lockout ends; 0 when not locked. */
  retryAfter: number;
  scope: "account" | "ip" | null;
  windowSeconds: number;
}

const accounts = new Map<string, FailureWindow>();
const ips = new Map<string, FailureWindow>();

/** Set when the object errors; no attempt is made again until this instant. */
let guardDownUntil = 0;
let guardMissingLogged = false;

function windowSeconds(env: Env): number {
  const raw = (env as LimitEnv).AUTH_LOCKOUT_WINDOW_SECONDS;
  const parsed = raw === undefined ? NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_WINDOW_SECONDS;
  return Math.min(MAX_WINDOW_SECONDS, Math.max(MIN_WINDOW_SECONDS, parsed));
}

/** The deployment's lockout window, exposed so the challenge can outlive it. */
export function authLockoutWindowSeconds(env: Env): number {
  return windowSeconds(env);
}

export function clientIp(req: Request): string | null {
  const ip = req.headers.get("CF-Connecting-IP");
  return ip !== null && ip !== "" ? ip : null;
}

function accountKey(email: string): string {
  return `acct:${email.trim().toLowerCase()}`;
}

function ipKey(ip: string): string {
  return `ip:${ip}`;
}

/* ───────────────────────── Durable Object plumbing ───────────────────────── */

function guardStub(env: Env): DurableObjectStub<AuthGuard> | null {
  if (Date.now() < guardDownUntil) return null;
  const namespace = (env as LimitEnv).AUTH_GUARD;
  if (namespace === undefined) {
    if (!guardMissingLogged) {
      guardMissingLogged = true;
      console.warn("[auth-limits] AUTH_GUARD binding is missing; using isolate counters only");
    }
    return null;
  }
  return namespace.get(namespace.idFromName(AUTH_GUARD_OBJECT_NAME));
}

function withGuardTimeout<T>(promise: Promise<T>, operation: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${operation} timed out after ${GUARD_TIMEOUT_MS} ms`)),
      GUARD_TIMEOUT_MS
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function guardReachable(): void {
  guardDownUntil = 0;
}

function guardUnreachable(error: unknown): void {
  const now = Date.now();
  // One line per outage, not one per guess. The 10-second cooldown also keeps a
  // broken object from adding a round trip to every request while it is down.
  if (now >= guardDownUntil) {
    console.error(
      `[auth-limits] AuthGuard unreachable; falling back to isolate counters: ${String(error)}`
    );
  }
  guardDownUntil = now + GUARD_RETRY_MS;
}

async function guardStateMany(
  env: Env,
  requests: AuthGuardRequest[]
): Promise<Array<AuthGuardRecord | null> | null> {
  const stub = guardStub(env);
  if (stub === null) return null;
  try {
    const result = await withGuardTimeout(stub.stateMany(requests), "AuthGuard.stateMany");
    guardReachable();
    return result;
  } catch (error) {
    guardUnreachable(error);
    return null;
  }
}

async function guardHitMany(
  env: Env,
  requests: AuthGuardRequest[]
): Promise<AuthGuardRecord[] | null> {
  const stub = guardStub(env);
  if (stub === null) return null;
  try {
    const result = await withGuardTimeout(stub.hitMany(requests), "AuthGuard.hitMany");
    guardReachable();
    return result;
  } catch (error) {
    guardUnreachable(error);
    return null;
  }
}

async function guardClear(env: Env, key: string): Promise<void> {
  const stub = guardStub(env);
  if (stub === null) return;
  try {
    await withGuardTimeout(stub.clear(key), "AuthGuard.clear");
    guardReachable();
  } catch (error) {
    // A successful sign-in must not become a 500 because the counter store is
    // down. The local cache is still cleared; the object's row will be seen and
    // can only keep the account locked (fail closed, not open).
    guardUnreachable(error);
  }
}

/* ─────────────────────────────── cache helpers ───────────────────────────── */

function prune(state: FailureWindow, now: number, windowMs: number): void {
  const cutoff = now - windowMs;
  while (state.hits.length > 0 && state.hits[0] <= cutoff) state.hits.shift();
  if (state.lockedUntil <= now) state.lockedUntil = 0;
}

/** Drop expired entries when the map reaches its cap; never grow without bound. */
function makeRoom(map: Map<string, FailureWindow>, now: number, windowMs: number): void {
  if (map.size < MAX_TRACKED) return;
  for (const [key, state] of map) {
    prune(state, now, windowMs);
    if (
      state.lockedUntil === 0 &&
      state.hits.length === 0 &&
      now - state.clearedAt > BINDING_PERIOD_MS &&
      now - state.syncedAt > CACHE_TTL_MS
    ) {
      map.delete(key);
    }
  }
  // Still full: drop the oldest insertion. A lockout can be evicted under
  // memory pressure, which is a deliberate trade for a bounded process.
  while (map.size >= MAX_TRACKED) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function stateFor(
  map: Map<string, FailureWindow>,
  key: string,
  now: number,
  windowMs: number
): FailureWindow {
  let state = map.get(key);
  if (state === undefined) {
    makeRoom(map, now, windowMs);
    state = { hits: [], lockedUntil: 0, clearedAt: 0, syncedAt: 0 };
    map.set(key, state);
  }
  return state;
}

/**
 * Copy the object's decision into the isolate. The hit timestamps are synthetic
 * (all at `window_start`) because the object stores a count, not per-guess rows;
 * they are only a fallback history and never override the object while it is
 * reachable.
 */
function adoptRemote(
  state: FailureWindow,
  remote: AuthGuardRecord | null,
  now: number
): void {
  state.syncedAt = now;
  if (remote === null) {
    state.hits = [];
    state.lockedUntil = 0;
    state.clearedAt = now;
    return;
  }
  state.lockedUntil = remote.locked_until;
  state.hits =
    remote.count > 0 ? new Array(remote.count).fill(remote.window_start) : [];
  if (remote.count === 0) state.clearedAt = now;
}

function retryAfter(state: FailureWindow, now: number): number {
  return Math.max(1, Math.ceil((state.lockedUntil - now) / 1000));
}

function lockoutFrom(
  account: FailureWindow | undefined,
  ip: FailureWindow | undefined,
  now: number,
  window: number
): LockoutState {
  if (account !== undefined && account.lockedUntil > now) {
    return { locked: true, retryAfter: retryAfter(account, now), scope: "account", windowSeconds: window };
  }
  if (ip !== undefined && ip.lockedUntil > now) {
    return { locked: true, retryAfter: retryAfter(ip, now), scope: "ip", windowSeconds: window };
  }
  return { locked: false, retryAfter: 0, scope: null, windowSeconds: window };
}

/**
 * True when the fallback binding refuses this key. A missing binding (older
 * deployment, local config) or a runtime error degrades to the isolate window
 * rather than failing the auth path open *or* closed: the memory window is still
 * enforced.
 */
async function bindingTripped(limiter: RateLimit | undefined, key: string): Promise<boolean> {
  if (limiter === undefined) return false;
  try {
    const { success } = await limiter.limit({ key });
    return !success;
  } catch (error) {
    console.error(`[auth-limits] rate-limit binding failed: ${String(error)}`);
    return false;
  }
}

/**
 * Read-only: is this account or IP already locked? Call this BEFORE verifying a
 * secret. It never records a hit and never extends an active lockout.
 *
 * The first check for a key, and any check after 30 seconds, asks the Durable
 * Object. A warm cache answers from memory, so a legitimate sign-in does not pay
 * a round trip on every request.
 */
export async function checkAuthLockout(
  env: Env,
  input: { email: string | null; ip: string | null }
): Promise<LockoutState> {
  const now = Date.now();
  const window = windowSeconds(env);
  const windowMs = window * 1000;

  let account: FailureWindow | undefined;
  let accountCacheKey: string | null = null;
  if (input.email !== null) {
    accountCacheKey = accountKey(input.email);
    account = stateFor(accounts, accountCacheKey, now, windowMs);
  }

  let ip: FailureWindow | undefined;
  let ipCacheKey: string | null = null;
  if (input.ip !== null) {
    ipCacheKey = ipKey(input.ip);
    ip = stateFor(ips, ipCacheKey, now, windowMs);
  }

  const stale: Array<{ state: FailureWindow; request: AuthGuardRequest }> = [];
  if (account !== undefined && accountCacheKey !== null && now - account.syncedAt >= CACHE_TTL_MS) {
    stale.push({
      state: account,
      request: { key: accountCacheKey, windowMs, limit: ACCOUNT_FAILURE_LIMIT },
    });
  }
  if (ip !== undefined && ipCacheKey !== null && now - ip.syncedAt >= CACHE_TTL_MS) {
    stale.push({
      state: ip,
      request: { key: ipCacheKey, windowMs, limit: IP_FAILURE_LIMIT },
    });
  }

  if (stale.length > 0) {
    const remote = await guardStateMany(env, stale.map((entry) => entry.request));
    if (remote !== null) {
      for (let i = 0; i < stale.length; i += 1) {
        adoptRemote(stale[i].state, remote[i] ?? null, now);
      }
    }
  }

  if (account !== undefined) {
    prune(account, now, windowMs);
    // A window that has reached the threshold but lost its marker (the object
    // sets it on write; keep the invariant explicit for a cache copy).
    if (account.lockedUntil === 0 && account.hits.length >= ACCOUNT_FAILURE_LIMIT) {
      account.lockedUntil = now + windowMs;
    }
  }

  if (ip !== undefined) {
    prune(ip, now, windowMs);
    if (ip.lockedUntil === 0 && ip.hits.length >= IP_FAILURE_LIMIT) {
      ip.lockedUntil = now + windowMs;
    }
  }

  return lockoutFrom(account, ip, now, window);
}

/** One isolate-local failure, used only while the Durable Object is unreachable. */
async function recordLocalFailure(
  env: Env,
  state: FailureWindow,
  now: number,
  windowMs: number,
  limit: number,
  limiter: RateLimit | undefined,
  bindingKey: string,
  bindingGrace: boolean
): Promise<void> {
  prune(state, now, windowMs);
  if (state.lockedUntil > 0) return;

  state.hits.push(now);
  if (state.hits.length >= limit) {
    state.lockedUntil = now + windowMs;
    return;
  }
  if (bindingGrace && now - state.clearedAt < BINDING_PERIOD_MS) return;
  if (await bindingTripped(limiter, bindingKey)) {
    state.lockedUntil = now + windowMs;
  }
}

/**
 * Count one failure and return the resulting state. The fifth account failure
 * (or twentieth IP failure) comes back `locked: true`, so the caller can answer
 * that request with 429 rather than 401 — the lockout starts at the threshold,
 * not one guess later.
 *
 * While a lockout is active this is never called (the caller checks first), but
 * if it is, the object returns the row unchanged: a failure inside a lockout
 * must not extend the sentence.
 */
export async function recordAuthFailure(
  env: Env,
  input: { email: string | null; ip: string | null }
): Promise<LockoutState> {
  const now = Date.now();
  const window = windowSeconds(env);
  const windowMs = window * 1000;

  let account: FailureWindow | undefined;
  let accountCacheKey: string | null = null;
  if (input.email !== null) {
    accountCacheKey = accountKey(input.email);
    account = stateFor(accounts, accountCacheKey, now, windowMs);
  }

  let ip: FailureWindow | undefined;
  let ipCacheKey: string | null = null;
  if (input.ip !== null) {
    ipCacheKey = ipKey(input.ip);
    ip = stateFor(ips, ipCacheKey, now, windowMs);
  }

  const requests: AuthGuardRequest[] = [];
  if (account !== undefined && accountCacheKey !== null) {
    requests.push({
      key: accountCacheKey,
      windowMs,
      limit: ACCOUNT_FAILURE_LIMIT,
    });
  }
  if (ip !== undefined && ipCacheKey !== null) {
    requests.push({ key: ipCacheKey, windowMs, limit: IP_FAILURE_LIMIT });
  }

  const remote = requests.length === 0 ? null : await guardHitMany(env, requests);

  if (remote !== null) {
    let index = 0;
    if (account !== undefined) adoptRemote(account, remote[index++] ?? null, now);
    if (ip !== undefined) adoptRemote(ip, remote[index++] ?? null, now);
  } else {
    // The object is unreachable or this deployment has no binding. The isolate
    // window and the Rate Limiting bindings are the fallback: never unlimited.
    if (account !== undefined && accountCacheKey !== null) {
      await recordLocalFailure(
        env,
        account,
        now,
        windowMs,
        ACCOUNT_FAILURE_LIMIT,
        (env as LimitEnv).AUTH_ACCOUNT_LIMITER,
        `auth-account:${accountCacheKey}`,
        true
      );
    }
    if (ip !== undefined && ipCacheKey !== null) {
      await recordLocalFailure(
        env,
        ip,
        now,
        windowMs,
        IP_FAILURE_LIMIT,
        (env as LimitEnv).AUTH_IP_LIMITER,
        `auth-ip:${input.ip}`,
        false
      );
    }
  }

  return lockoutFrom(account, ip, now, window);
}

/**
 * A successful authentication clears the account window, locally and in the
 * object. The IP window is not cleared: one shared address should not be able to
 * launder a spray by having a single valid account on it.
 *
 * A failure to reach the object is swallowed: a correct password must not become
 * a 500 because the counter store is down. It also cannot open the door — the
 * stale object row can only keep the account locked.
 */
export async function clearAuthFailures(env: Env, email: string): Promise<void> {
  const key = accountKey(email);
  const now = Date.now();
  const state = accounts.get(key);
  if (state !== undefined) {
    state.hits = [];
    state.lockedUntil = 0;
    state.clearedAt = now;
    state.syncedAt = now;
  }
  await guardClear(env, key);
}

/**
 * The 429 shape every auth limiter returns: header and body carry the same
 * seconds, and the body has a sentence a console can print without translating
 * a code.
 */
export function rateLimitedResponse(retryAfter: number, message: string): Response {
  const retry = Math.max(1, Math.ceil(retryAfter));
  return Response.json(
    { error: "rate_limited", retry_after: retry, message },
    {
      status: 429,
      headers: {
        "Retry-After": String(retry),
        "Cache-Control": "no-store",
      },
    }
  );
}

export function lockoutResponse(lockout: LockoutState): Response {
  const subject = lockout.scope === "ip" ? "this network" : "this account";
  return rateLimitedResponse(
    lockout.retryAfter,
    `Too many failed authentication attempts for ${subject}. Try again in ${lockout.retryAfter} seconds.`
  );
}

/**
 * One audit row per lockout *event*, not per guess: the point of the limiter is
 * that spraying must not spend rows. A repeated request while locked is refused
 * before this is reached.
 */
export async function auditLockout(
  env: Env,
  req: Request,
  input: { email: string | null; factor: string; lockout: LockoutState }
): Promise<void> {
  await writeAudit(env, {
    action: "auth.lockout",
    actor: { userId: null, label: input.factor },
    detail: {
      factor: input.factor,
      scope: input.lockout.scope,
      retry_after: input.lockout.retryAfter,
      window_seconds: input.lockout.windowSeconds,
      ...(input.email === null ? {} : { email: input.email.slice(0, 254) }),
    },
    ...requestMeta(req),
  });
}
