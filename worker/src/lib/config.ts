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
}

export const DEFAULT_TIMINGS: Readonly<TimingConfig> = {
  ackTimeoutMs: 8_000,
  offlineAlertMs: 900_000,
  staleSocketMs: 120_000,
  nonceWindowMs: 300_000,
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
