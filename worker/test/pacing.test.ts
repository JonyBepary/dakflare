import { describe, expect, it } from "vitest";
import {
  DEFAULT_SMS_PACING,
  computePacedDelayMs,
  isWithinQuietHours,
  shiftOutOfQuietHours,
  type PacingPolicy
} from "../src/lib/pacing";

const policy: PacingPolicy = { ...DEFAULT_SMS_PACING, timezone: "UTC" };

function utc(year: number, month: number, day: number, hour: number, minute = 0): number {
  return Date.UTC(year, month - 1, day, hour, minute);
}

describe("computePacedDelayMs", () => {
  it("returns the base interval at the centre of the jitter", () => {
    expect(computePacedDelayMs(policy, 0.5)).toBe(10_000);
  });

  it("stays inside plus or minus the jitter percentage", () => {
    expect(computePacedDelayMs(policy, 0)).toBe(7_500);
    expect(computePacedDelayMs(policy, 1)).toBe(12_500);
  });

  it("clamps jitter to 50 percent and the base to 50 ms", () => {
    const wild: PacingPolicy = { ...policy, minIntervalMs: -5, jitterPct: 400 };
    expect(computePacedDelayMs(wild, 0)).toBe(25);
    expect(computePacedDelayMs(wild, 1)).toBe(75);
  });
});

describe("quiet hours", () => {
  it("detects an overnight window in UTC", () => {
    expect(isWithinQuietHours(utc(2026, 1, 15, 22, 30), policy)).toBe(true);
    expect(isWithinQuietHours(utc(2026, 1, 15, 7, 59), policy)).toBe(true);
    expect(isWithinQuietHours(utc(2026, 1, 15, 8, 0), policy)).toBe(false);
    expect(isWithinQuietHours(utc(2026, 1, 15, 12, 0), policy)).toBe(false);
  });

  it("shifts to the quiet end plus up to five minutes of wake jitter", () => {
    const at2230 = utc(2026, 1, 15, 22, 30);
    expect(shiftOutOfQuietHours(at2230, policy, 0)).toBe(utc(2026, 1, 16, 8, 0));
    expect(shiftOutOfQuietHours(at2230, policy, 1)).toBe(utc(2026, 1, 16, 8, 5));
  });

  it("leaves a daytime message untouched", () => {
    const noon = utc(2026, 1, 15, 12, 0);
    expect(shiftOutOfQuietHours(noon, policy, 0)).toBe(noon);
  });

  it("reads the window in the policy's timezone", () => {
    const dhaka: PacingPolicy = { ...policy, timezone: "Asia/Dhaka" };
    // 22:00 in Dhaka is 16:00 UTC, inside 21:00-08:00.
    const at2200Dhaka = utc(2026, 1, 15, 16, 0);
    expect(isWithinQuietHours(at2200Dhaka, dhaka)).toBe(true);
    // 08:00 Dhaka is 02:00 UTC the same day.
    expect(shiftOutOfQuietHours(at2200Dhaka, dhaka, 0)).toBe(utc(2026, 1, 16, 2, 0));
  });

  it("treats equal quiet hours as disabled", () => {
    const none: PacingPolicy = { ...policy, quietStartHour: 0, quietEndHour: 0 };
    const night = utc(2026, 1, 15, 23, 0);
    expect(isWithinQuietHours(night, none)).toBe(false);
    expect(shiftOutOfQuietHours(night, none)).toBe(night);
  });

  it("falls back to UTC instead of throwing on an unknown zone", () => {
    const broken: PacingPolicy = { ...policy, timezone: "Not/AZone" };
    const at2230 = utc(2026, 1, 15, 22, 30);
    expect(isWithinQuietHours(at2230, broken)).toBe(true);
    expect(shiftOutOfQuietHours(at2230, broken, 0)).toBe(utc(2026, 1, 16, 8, 0));
  });
});
