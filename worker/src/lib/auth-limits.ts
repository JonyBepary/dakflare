/**
 * Failed-auth lockout — one account window, one IP window, no D1 writes.
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
 * resource that runs out first. So the authoritative 15-minute window is a
 * fixed, small array in isolate memory, and the two Rate Limiting bindings are
 * the cross-instance backstop. A request refused here returns before the plugin,
 * the audit writer or D1 is touched.
 *
 * The 15-minute window and the Rate Limiting API
 * ----------------------------------------------
 * The Rate Limiting binding only accepts `period = 10` or `period = 60`
 * (wrangler config schema, and the runtime docs). It cannot express "5 failures
 * in 15 minutes", and its outcome is only `{ success }` — no count, no reset.
 * The binding therefore backs the *threshold* across isolates/colos (5/60 for an
 * account, 20/60 for an IP), while this module holds the 15-minute sliding
 * window and the fixed lockout expiry. That split is stated in the report rather
 * than hidden: a deployment that needs one strict global window must move this
 * state into a Durable Object.
 *
 * DoS bound
 * ---------
 * A lockout is a fixed 15 minutes from the failure that tripped it and is never
 * extended while it is active: `checkAuthLockout` refuses before any attempt is
 * recorded, so an unauthenticated caller cannot pin an owner out indefinitely by
 * spraying their address. The window is also capped at one hour even if the
 * deployment overrides it, because an unbounded lockout is a denial-of-service
 * primitive aimed at the account owner.
 */

import type { Env } from "../index";
import { requestMeta, writeAudit } from "../audit";

/** The two bindings this module adds. Optional so an older deployment still runs. */
type LimitEnv = Env & {
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
 * residual binding count must not re-lock the account. This is the only place
 * that uses the binding's `success` to *set* a lockout, so the grace period is
 * enough to keep a legitimate sign-in from immediately re-locking itself.
 */
const BINDING_PERIOD_MS = 60_000;

/** Bounded memory: an attacker can invent addresses, but not unbounded ones. */
const MAX_TRACKED = 10_000;

interface FailureWindow {
  /** Ascending millisecond timestamps of failures inside the current window. */
  hits: number[];
  /** 0 when unlocked; otherwise the instant the fixed lockout ends. */
  lockedUntil: number;
  /** When a success last cleared this account (binding grace period). */
  clearedAt: number;
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
    if (state.lockedUntil === 0 && state.hits.length === 0 && now - state.clearedAt > BINDING_PERIOD_MS) {
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
    state = { hits: [], lockedUntil: 0, clearedAt: 0 };
    map.set(key, state);
  }
  return state;
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
 * True when the limiter refuses this key. A missing binding (older deployment,
 * local config) or a runtime error degrades to the in-memory window rather than
 * failing the auth path open *or* closed: the memory window is still enforced.
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
 */
export function checkAuthLockout(
  env: Env,
  input: { email: string | null; ip: string | null }
): LockoutState {
  const now = Date.now();
  const window = windowSeconds(env);
  const windowMs = window * 1000;

  let account: FailureWindow | undefined;
  if (input.email !== null) {
    account = accounts.get(accountKey(input.email));
    if (account !== undefined) {
      prune(account, now, windowMs);
      // A window that has reached the threshold but lost its marker (process
      // restart is impossible for this Map, but keep the invariant explicit).
      if (account.lockedUntil === 0 && account.hits.length >= ACCOUNT_FAILURE_LIMIT) {
        account.lockedUntil = now + windowMs;
      }
    }
  }

  let ip: FailureWindow | undefined;
  if (input.ip !== null) {
    ip = ips.get(ipKey(input.ip));
    if (ip !== undefined) {
      prune(ip, now, windowMs);
      if (ip.lockedUntil === 0 && ip.hits.length >= IP_FAILURE_LIMIT) {
        ip.lockedUntil = now + windowMs;
      }
    }
  }

  return lockoutFrom(account, ip, now, window);
}

/**
 * Count one failure and return the resulting state. The fifth account failure
 * (or twentieth IP failure) comes back `locked: true`, so the caller can answer
 * that request with 429 rather than 401 — the lockout starts at the threshold,
 * not one guess later.
 *
 * While a lockout is active this is never called (the caller checks first), but
 * if it is, the expiry is not moved: a failure inside a lockout must not extend
 * the sentence.
 */
export async function recordAuthFailure(
  env: Env,
  input: { email: string | null; ip: string | null }
): Promise<LockoutState> {
  const now = Date.now();
  const window = windowSeconds(env);
  const windowMs = window * 1000;

  let account: FailureWindow | undefined;
  if (input.email !== null) {
    account = stateFor(accounts, accountKey(input.email), now, windowMs);
    prune(account, now, windowMs);
    if (account.lockedUntil === 0) {
      account.hits.push(now);
      if (account.hits.length >= ACCOUNT_FAILURE_LIMIT) {
        account.lockedUntil = now + windowMs;
      } else if (now - account.clearedAt >= BINDING_PERIOD_MS) {
        // Cross-isolate backstop. The binding's window is only 60 s, so it can
        // catch a burst spread over isolates but cannot hold the 15-minute
        // window by itself.
        if (await bindingTripped((env as LimitEnv).AUTH_ACCOUNT_LIMITER, `auth-account:${accountKey(input.email)}`)) {
          account.lockedUntil = now + windowMs;
        }
      }
    }
  }

  let ip: FailureWindow | undefined;
  if (input.ip !== null) {
    ip = stateFor(ips, ipKey(input.ip), now, windowMs);
    prune(ip, now, windowMs);
    if (ip.lockedUntil === 0) {
      ip.hits.push(now);
      if (ip.hits.length >= IP_FAILURE_LIMIT) {
        ip.lockedUntil = now + windowMs;
      } else if (
        await bindingTripped((env as LimitEnv).AUTH_IP_LIMITER, `auth-ip:${input.ip}`)
      ) {
        ip.lockedUntil = now + windowMs;
      }
    }
  }

  return lockoutFrom(account, ip, now, window);
}

/**
 * A successful authentication clears the account window. The IP window is not
 * cleared: one shared address should not be able to launder a spray by having a
 * single valid account on it.
 */
export function clearAuthFailures(email: string): void {
  const key = accountKey(email);
  const state = accounts.get(key);
  if (state === undefined) return;
  state.hits = [];
  state.lockedUntil = 0;
  state.clearedAt = Date.now();
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
