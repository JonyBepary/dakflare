/**
 * Runtime-tunable timings (amendment to the port of master plan §5.1–§5.5).
 *
 * Every value is Number-parsed and clamped, so a hand-edited var can never turn
 * into NaN inside SQL or into "never fires" / "fires constantly". Defaults
 * reproduce the frozen contract: PROTOCOL_CONTRACT_V5 §3.2 step 4 and §5.1 both
 * fix the acceptance/replay window at 300_000 ms, and the conformance suite is
 * expected to SHORTEN these through `.dev.vars` so a test does not have to wait
 * eight seconds for an `ack_timeout` or fifteen minutes for an offline alert.
 */

export interface TimingConfig {
  /** §6.1 `DISPATCHED -> PENDING` after this long without a device ack. */
  ackTimeoutMs: number;
  /** Emit `[offline_alert]` after this long with no sign of life from the device. */
  offlineAlertMs: number;
  /** Consider a WebSocket dead if the freshest liveness evidence is older than this. */
  staleSocketMs: number;
  /** §3.2 step 4 acceptance window and §5.1 replay retention (`W`). */
  nonceWindowMs: number;
  /** Days to keep message bodies and phone numbers (D1 and DO `commands`). */
  retentionDays: number;
}

export const DEFAULT_TIMINGS: Readonly<TimingConfig> = {
  ackTimeoutMs: 8_000,
  offlineAlertMs: 900_000,
  staleSocketMs: 120_000,
  nonceWindowMs: 300_000,
  retentionDays: 90,
};

/** Coerce one env var to an integer, falling back to `fallback` for anything unusable. */
export function readIntEnv(
  value: unknown,
  fallback: number,
  min: number,
  max: number
): number {
  let parsed: number;
  if (typeof value === "number") {
    parsed = value;
  } else if (typeof value === "string" && value.trim() !== "") {
    parsed = Number(value);
  } else {
    return fallback;
  }
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

/**
 * Read the timing set from the Worker/DO environment.
 *
 * Note the clamp floors: a suite "shrinking" a value cannot shrink it below the
 * floor (100 ms / 500 ms / 1000 ms), which exists so that a zero or negative
 * value cannot make an alarm spin or a socket look permanently stale.
 */
export function timingConfig(env: Record<string, unknown> | undefined): TimingConfig {
  const source = env ?? {};
  return {
    ackTimeoutMs: readIntEnv(source.ACK_TIMEOUT_MS, DEFAULT_TIMINGS.ackTimeoutMs, 100, 3_600_000),
    offlineAlertMs: readIntEnv(
      source.OFFLINE_ALERT_MS,
      DEFAULT_TIMINGS.offlineAlertMs,
      1_000,
      86_400_000
    ),
    staleSocketMs: readIntEnv(source.STALE_SOCKET_MS, DEFAULT_TIMINGS.staleSocketMs, 500, 86_400_000),
    nonceWindowMs: readIntEnv(source.NONCE_WINDOW_MS, DEFAULT_TIMINGS.nonceWindowMs, 1_000, 3_600_000),
    retentionDays: readIntEnv(
      source.MESSAGE_RETENTION_DAYS,
      DEFAULT_TIMINGS.retentionDays,
      7,
      3_650
    ),
  };
}

/**
 * Clamp an admin-supplied `expires_in_s`.
 *
 * §12 of the port brief: accept only a finite number, clamp to [1, 86400], and
 * fall back to 600 for anything non-numeric — a NaN must never reach SQL, where
 * it would silently become NULL and break `expires_at` comparisons.
 */
export function clampExpiresInS(value: unknown): number {
  return readIntEnv(value, 600, 1, 86_400);
}

/** Clamp an admin-supplied pairing-code `ttl_ms`: finite, [1000, 86400000], default 600000. */
export function clampTtlMs(value: unknown): number {
  return readIntEnv(value, 600_000, 1_000, 86_400_000);
}

/* ======================================================================== */
/* Input bounds (hardening S2)                                              */
/* ======================================================================== */

/**
 * Per-request caps. These exist because every unit of work in this Worker is
 * billed or quota'd — Workers requests, Durable Object requests, D1 rows read
 * and written, and DO SQLite rows — so an unbounded array is an unbounded bill
 * and an unbounded way to exhaust the Workers Free daily allowance.
 *
 * The numbers: 500 messages is 2.5x the 200-row batch measured comfortable in
 * the burst probe, and still a ~100 KiB JSON body, well inside the 256 KiB
 * request cap below.
 */
export const MAX_INCOMING_MESSAGES = 500;
export const MAX_OUTBOUND_COMMANDS = 200;
export const MAX_STATUS_UPDATES = 500;
export const MAX_ACK_IDS = 200;

/**
 * Request-body ceiling, enforced by reading the stream (never by trusting
 * `Content-Length`, which a chunked request omits entirely).
 *
 * 256 KiB: a 500-message batch is ~100 KiB, so this is real headroom while
 * keeping the unauthenticated worst case cheap. Workers Free gives 10 ms of CPU
 * per invocation, so the body is digested with native `crypto.subtle.digest`
 * rather than in JS — see `auth/canonical.ts`.
 */
export const MAX_BODY_BYTES = 262_144;

/** Per-field ceilings. A single SMS body cannot legally be 900 KB. */
export const MAX_BODY_CHARS = 4_096;
export const MAX_PEER_CHARS = 32;
/** Operator-facing device label. Optional, trimmed, and never a routing key. */
export const MAX_LABEL_CHARS = 64;
export const MAX_ID_CHARS = 128;
/**
 * Caller-supplied idempotency key. Long enough for a UUID or a hash, short
 * enough that a key cannot be used as a storage channel.
 */
export const MAX_IDEMPOTENCY_KEY_CHARS = 128;
export const MAX_FCM_TOKEN_CHARS = 512;
export const MAX_RULE_VALUE_CHARS = 512;
export const MAX_REPLY_TEMPLATE_CHARS = 1_000;

/**
 * Workflow-graph ceilings.
 *
 * A canvas graph is stored whole, so these bound what one save can cost: 50 nodes
 * is far more than a readable canvas holds, 100 edges is twice the maximum a fully
 * connected 50-node DAG would need in practice, and 64 KiB keeps the document
 * comfortably inside the 256 KiB request cap while still leaving room for node
 * labels and templates. `lib/workflow.ts` enforces all three.
 */
export const MAX_WORKFLOW_NODES = 50;
export const MAX_WORKFLOW_EDGES = 100;
export const MAX_WORKFLOW_GRAPH_BYTES = 65_536;

/**
 * Which authentication backs the admin routes.
 *
 * `AUTH_MODE` is read from `env` on every request, never cached at module scope:
 * a deployment flips it by changing a `[vars]` entry and redeploying, and the
 * default is `legacy` so a half-finished rollout cannot lock the owner out. Only
 * the exact value `new` (trimmed, case-insensitive) enables Better Auth; every
 * other value, including a typo, stays on ADMIN_TOKEN.
 */
export type AuthMode = "legacy" | "new";

export function authMode(env: { AUTH_MODE?: string }): AuthMode {
  const raw = env.AUTH_MODE;
  if (typeof raw !== "string") return "legacy";
  return raw.trim().toLowerCase() === "new" ? "new" : "legacy";
}

/**
 * Which side runs the password KDF — AUTH_PLAN §2.
 *
 *   off             no password factor at all (the default)
 *   client-derived  the browser runs PBKDF2; the Worker only peppers + compares
 *   server-kdf      the Worker runs PBKDF2 (60–150 ms; paid plan / 30 s limit)
 *
 * Read per request, never cached: a deployment changes it with a `[vars]` entry.
 * An unknown value falls back to `off`, the safe side — a typo disables the
 * factor instead of silently running a KDF somewhere the operator did not pick.
 *
 * This is the deployment's capability, NOT the row's provenance. A row records
 * its own `m=` (who derived the material) so mode changes never rewrite rows;
 * `server-kdf` therefore accepts both request shapes, which is what keeps an
 * account created on the free tier usable after an upgrade.
 */
export type PasswordMode = "off" | "client-derived" | "server-kdf";

export function passwordMode(env: { AUTH_PASSWORD_MODE?: string }): PasswordMode {
  const raw = env.AUTH_PASSWORD_MODE;
  if (typeof raw !== "string") return "off";
  const value = raw.trim().toLowerCase();
  if (value === "client-derived" || value === "server-kdf") return value;
  return "off";
}

/* ======================================================================== */
/* Magic links (AUTH_PLAN §1, factor 2)                                     */
/* ======================================================================== */

/** The contract's 15 minutes. Exposed so `/v1/auth/mode` can tell the console. */
export const DEFAULT_MAGIC_LINK_TTL_SECONDS = 15 * 60;

/**
 * Token lifetime. Read per request and clamped to [1 s, 1 h]: the default is
 * the contract's 15 minutes, while the conformance harness shortens it to
 * exercise expiry without waiting a quarter of an hour. The lower bound is 1
 * second rather than 60 so a test deployment can make a link expire promptly;
 * production operators should leave the default alone.
 */
export function magicLinkTtlSeconds(env: { MAGIC_LINK_TTL_SECONDS?: string }): number {
  return readIntEnv(
    env.MAGIC_LINK_TTL_SECONDS,
    DEFAULT_MAGIC_LINK_TTL_SECONDS,
    1,
    60 * 60
  );
}

/** Where a magic link lands in the console. The SvelteKit base is `/admin`. */
export const MAGIC_LINK_PATH = "/admin/magic";

/**
 * Sanitise the `next` a link carries.
 *
 * Only a same-origin console path is accepted: it must start with `/admin` and
 * must not be a protocol-relative `//host` or contain a backslash (browsers
 * normalise `\` to `/`, so `/\evil.example` would become `//evil.example`).
 * Anything else falls back to the console's overview. This is the one place a
 * URL from a request body reaches a link, so it fails closed.
 */
export function sanitizeAdminNext(value: unknown): string {
  if (typeof value !== "string") return "/admin";
  const next = value.trim();
  if (next.length === 0 || next.length > 512) return "/admin";
  if (!next.startsWith("/admin")) return "/admin";
  if (next.startsWith("//") || next.includes("\\")) return "/admin";
  // `/administrator` is not the console. Require the base itself or a child.
  if (next.length > "/admin".length && next.charAt("/admin".length) !== "/" && next.charAt("/admin".length) !== "?") {
    return "/admin";
  }
  return next;
}
