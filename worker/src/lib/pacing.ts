/**
 * Scheduling and carrier-safe pacing helpers.
 *
 * These are pure functions on purpose: the Durable Object alarms and the Worker
 * routes both need the same arithmetic, and a unit test can pin the quiet-hours
 * boundary without a clock or a timezone database.
 */

export interface PacingPolicy {
  minIntervalMs: number;
  jitterPct: number;
  maxPerHour: number;
  quietStartHour: number;
  quietEndHour: number;
  timezone: string;
}

export const DEFAULT_SMS_PACING: PacingPolicy = {
  minIntervalMs: 10_000,
  jitterPct: 25,
  maxPerHour: 40,
  quietStartHour: 21,
  quietEndHour: 8,
  timezone: "UTC"
};

/**
 * Cloud APIs do not have a SIM or a carrier queue: the platform's own rate
 * limits are the constraint. A small gap between calls is enough, and quiet
 * hours are disabled because the platform holds the message.
 */
export const DEFAULT_CLOUD_PACING: PacingPolicy = {
  minIntervalMs: 100,
  jitterPct: 10,
  maxPerHour: 3_600,
  quietStartHour: 0,
  quietEndHour: 0,
  timezone: "UTC"
};

/**
 * A delay around `minIntervalMs`, with `jitterPct` spread either side.
 *
 * Jitter is clamped to 50 percent: a policy cannot ask for a negative interval,
 * and the base is at least 50 ms so a misconfigured row cannot turn an alarm
 * into a spin.
 */
export function computePacedDelayMs(policy: PacingPolicy, rand = Math.random()): number {
  const base = Math.max(50, policy.minIntervalMs);
  const spread = Math.min(50, Math.max(0, policy.jitterPct)) / 100;
  const factor = 1 + (rand * 2 - 1) * spread;
  return Math.round(base * factor);
}

function localHourMinute(epochMs: number, timezone: string): { hour: number; minute: number } {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone || "UTC",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit"
  });
  const parts = formatter.formatToParts(new Date(epochMs));
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0") % 24;
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  return { hour, minute };
}

function quietHourShape(policy: PacingPolicy): boolean {
  return policy.quietStartHour !== policy.quietEndHour;
}

export function isWithinQuietHours(epochMs: number, policy: PacingPolicy): boolean {
  if (!quietHourShape(policy)) return false;
  let hour: number;
  try {
    hour = localHourMinute(epochMs, policy.timezone).hour;
  } catch {
    // An unknown IANA zone must not take the scheduler down; UTC is the
    // documented fallback for a contact with a bad timezone.
    hour = localHourMinute(epochMs, "UTC").hour;
  }
  return policy.quietStartHour > policy.quietEndHour
    ? hour >= policy.quietStartHour || hour < policy.quietEndHour
    : hour >= policy.quietStartHour && hour < policy.quietEndHour;
}

/**
 * If `epochMs` is inside quiet hours in `policy.timezone`, return the epoch for
 * the next `quietEndHour:00` plus 0 to 5 minutes of wake jitter. Otherwise
 * return it unchanged.
 */
export function shiftOutOfQuietHours(
  epochMs: number,
  policy: PacingPolicy,
  rand = Math.random()
): number {
  if (!quietHourShape(policy)) return epochMs;

  let hour: number;
  let minute: number;
  try {
    ({ hour, minute } = localHourMinute(epochMs, policy.timezone));
  } catch {
    ({ hour, minute } = localHourMinute(epochMs, "UTC"));
  }

  const inQuiet =
    policy.quietStartHour > policy.quietEndHour
      ? hour >= policy.quietStartHour || hour < policy.quietEndHour
      : hour >= policy.quietStartHour && hour < policy.quietEndHour;

  if (!inQuiet) return epochMs;

  let hoursUntilEnd = policy.quietEndHour - hour;
  if (hoursUntilEnd <= 0) hoursUntilEnd += 24;
  const msUntilEnd = (hoursUntilEnd * 60 - minute) * 60_000;
  const wakeJitterMs = Math.round(rand * 5 * 60_000);
  return epochMs + msUntilEnd + wakeJitterMs;
}
