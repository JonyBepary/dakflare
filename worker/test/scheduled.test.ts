/**
 * Scheduling policy and the D1 lifecycle helpers.
 *
 * The pure tests pin quiet hours and the token bucket without a clock. The D1
 * tests prove the SQL that the Scheduler Durable Object will depend on — in
 * particular that a claim is one atomic `UPDATE ... RETURNING` and that a late
 * receipt cannot walk a delivered row backwards.
 */

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  STATUS_RANK,
  claimScheduled,
  cancelScheduled,
  deferScheduled,
  deterministicJitterMs,
  finalizeScheduled,
  isWithinQuietHours,
  nextAllowedInstant,
  nextTokenAt,
  normalisePeer,
  recoverStale,
  statusAdvances,
  takeToken,
  type ScheduledStatus
} from "../src/lib/scheduled";

/* ------------------------------------------------------------------------- *
 * Peers
 * ------------------------------------------------------------------------- */

describe("normalisePeer", () => {
  it("cleans cosmetic characters and keeps the plus", () => {
    expect(normalisePeer("sms", "  +880 1712-345-678 ")).toBe("+8801712345678");
    expect(normalisePeer("sms", "+1 (555) 000-1111")).toBe("+15550001111");
  });

  it("gives a bare 8-15 digit number the plus", () => {
    expect(normalisePeer("sms", "8801712345678")).toBe("+8801712345678");
    expect(normalisePeer("sms", "12345678")).toBe("+12345678");
  });

  it("rejects numbers that are too short or too long", () => {
    expect(normalisePeer("sms", "+1234567")).toBeNull();
    expect(normalisePeer("sms", "+1234567890123456")).toBeNull();
    expect(normalisePeer("sms", "not a number")).toBeNull();
    expect(normalisePeer("sms", "")).toBeNull();
  });

  it("trims an opaque non-SMS peer and bounds its length", () => {
    expect(normalisePeer("telegram", "  5551234  ")).toBe("5551234");
    expect(normalisePeer("messenger", "psid-42")).toBe("psid-42");
    expect(normalisePeer("telegram", "   ")).toBeNull();
    expect(normalisePeer("telegram", "x".repeat(257))).toBeNull();
  });
});

/* ------------------------------------------------------------------------- *
 * Submission spacing
 * ------------------------------------------------------------------------- */

describe("deterministicJitterMs", () => {
  it("stays inside the 8-15 second window", () => {
    for (let i = 0; i < 500; i += 1) {
      const jitter = deterministicJitterMs(`row-${i}`);
      expect(jitter).toBeGreaterThanOrEqual(8000);
      expect(jitter).toBeLessThanOrEqual(15000);
    }
  });

  it("is stable for one id and differs across ids", () => {
    expect(deterministicJitterMs("6ba7b810-9dad-11d1-80b4-00c04fd430c8")).toBe(
      deterministicJitterMs("6ba7b810-9dad-11d1-80b4-00c04fd430c8")
    );
    const values = new Set(
      Array.from({ length: 50 }, (_, index) => deterministicJitterMs(`id-${index}`))
    );
    expect(values.size).toBeGreaterThan(40);
  });
});

/* ------------------------------------------------------------------------- *
 * Quiet hours
 * ------------------------------------------------------------------------- */

function localHour(epochMs: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit"
  }).formatToParts(new Date(epochMs));
  return Number(parts.find((part) => part.type === "hour")?.value ?? "0") % 24;
}

function utc(year: number, month: number, day: number, hour: number, minute = 0): number {
  return Date.UTC(year, month - 1, day, hour, minute);
}

const q = (timezone: string) => ({ timezone, quietStartHour: 21, quietEndHour: 8 });

describe("nextAllowedInstant", () => {
  it("moves 22:00 in Dhaka to 08:00 the next morning", () => {
    const now = utc(2026, 1, 15, 16, 0); // 22:00 Asia/Dhaka
    expect(isWithinQuietHours(now, q("Asia/Dhaka"))).toBe(true);

    const next = nextAllowedInstant(now, q("Asia/Dhaka"), () => 0);
    expect(next).toBe(utc(2026, 1, 16, 2, 0));
    expect(localHour(next, "Asia/Dhaka")).toBe(8);
  });

  it("reads the wall clock across the 2026 New York DST start", () => {
    // 23:00 EST on 7 March 2026; 08:00 the next morning is EDT, not a
    // nine-hour UTC delta (which would land at 13:00 UTC / 09:00 local).
    const now = utc(2026, 3, 8, 4, 0);
    expect(localHour(now, "America/New_York")).toBe(23);

    const next = nextAllowedInstant(now, q("America/New_York"), () => 0);
    expect(next).toBe(utc(2026, 3, 8, 12, 0));
    expect(localHour(next, "America/New_York")).toBe(8);
    expect(next - now).not.toBe(9 * 60 * 60_000);
  });

  it("handles Lord Howe's 30-minute DST shift", () => {
    // 22:30 standard time on 3 October 2026; DST starts at 02:00 that night.
    const now = utc(2026, 10, 3, 12, 0);
    expect(localHour(now, "Australia/Lord_Howe")).toBe(22);

    const next = nextAllowedInstant(now, q("Australia/Lord_Howe"), () => 0);
    expect(next).toBe(utc(2026, 10, 3, 21, 0));
    expect(localHour(next, "Australia/Lord_Howe")).toBe(8);
  });

  it("returns now when the window is disabled (equal hours)", () => {
    const daytime = utc(2026, 1, 15, 12, 0);
    const off = { timezone: "UTC", quietStartHour: 0, quietEndHour: 0 };
    expect(isWithinQuietHours(daytime, off)).toBe(false);
    expect(nextAllowedInstant(daytime, off)).toBe(daytime);
    // Even 23:00 is untouched when the window is off.
    expect(nextAllowedInstant(utc(2026, 1, 15, 23, 0), off)).toBe(utc(2026, 1, 15, 23, 0));
  });

  it("returns now outside quiet hours and adds at most five minutes of jitter", () => {
    const noon = utc(2026, 1, 15, 12, 30);
    expect(nextAllowedInstant(noon, q("UTC"), () => 0.9)).toBe(noon);

    const at2200 = utc(2026, 1, 15, 22, 0);
    expect(nextAllowedInstant(at2200, q("UTC"), () => 1)).toBe(utc(2026, 1, 16, 8, 5));
  });

  it("throws a typed error for an unknown zone instead of falling back to UTC", () => {
    const policy = q("Not/AZone");
    const at = utc(2026, 1, 15, 22, 0);

    let caught: unknown;
    try {
      nextAllowedInstant(at, policy);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { code?: string }).code).toBe("bad_timezone");
    expect(() => isWithinQuietHours(at, policy)).toThrow(/unknown IANA timezone/);
  });
});

/* ------------------------------------------------------------------------- *
 * Token bucket
 * ------------------------------------------------------------------------- */

describe("token bucket", () => {
  const now = utc(2026, 1, 15, 12, 0);

  it("allows exactly the capacity and re-arms the next token ~90 s later", () => {
    let state = { tokens: 40, refilledAt: now };
    for (let i = 0; i < 40; i += 1) {
      const result = takeToken(state, 40, now);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("bucket denied before capacity");
      state = result.state;
    }
    expect(state.tokens).toBe(0);

    const denied = takeToken(state, 40, now);
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("bucket over-spent");
    // 40/hour is one token every 90 seconds.
    expect(denied.nextAt - now).toBe(90_000);
    expect(nextTokenAt(state, 40, now)).toBe(denied.nextAt);
  });

  it("refills to capacity after an hour", () => {
    const result = takeToken({ tokens: 0, refilledAt: now }, 40, now + 3_600_000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.tokens).toBe(39);
    expect(nextTokenAt({ tokens: 0, refilledAt: now }, 40, now + 3_600_000)).toBe(
      now + 3_600_000
    );
  });

  it("never refills past capacity", () => {
    const result = takeToken({ tokens: 0, refilledAt: now - 86_400_000 }, 40, now);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.tokens).toBe(39);
  });

  it("does not consume a token for a deferral", async () => {
    const id = await seedRow({ sendAt: now - 1000 });
    let state = { tokens: 40, refilledAt: now };
    for (let i = 0; i < 40; i += 1) {
      const result = takeToken(state, 40, now);
      if (!result.ok) throw new Error("bucket denied before capacity");
      state = result.state;
    }

    const before = takeToken(state, 40, now + 1000);
    expect(before.ok).toBe(false);

    expect(await deferScheduled(env.DB, id, now + 3_600_000, "quiet_hours", now + 1000)).toBe(true);

    const after = takeToken(state, 40, now + 1000);
    expect(after).toEqual(before);
  });
});

/* ------------------------------------------------------------------------- *
 * Status ordering
 * ------------------------------------------------------------------------- */

describe("statusAdvance", () => {
  it("ranks the forward stages and does not move backwards", () => {
    expect(STATUS_RANK.scheduled).toBeLessThan(STATUS_RANK.dispatching);
    expect(STATUS_RANK.dispatching).toBeLessThan(STATUS_RANK.dispatched);
    expect(STATUS_RANK.dispatched).toBeLessThan(STATUS_RANK.sent);
    expect(STATUS_RANK.sent).toBeLessThan(STATUS_RANK.delivered);

    expect(statusAdvances("delivered", "sent")).toBe(false);
    expect(statusAdvances("sent", "delivered")).toBe(true);
    expect(statusAdvances("dispatched", "sent")).toBe(true);
    expect(statusAdvances("dispatching", "scheduled")).toBe(false);
    expect(statusAdvances("cancelled", "sent")).toBe(false);
    expect(statusAdvances("delivered", "failed")).toBe(false);
    expect(statusAdvances("sent", "failed")).toBe(true);
  });
});

/* ------------------------------------------------------------------------- *
 * D1 lifecycle
 * ------------------------------------------------------------------------- */

interface SeedOptions {
  status?: ScheduledStatus;
  targetType?: "device" | "connector";
  sendAt?: number;
  expiresAt?: number | null;
  claimedAt?: number | null;
  updatedAt?: number;
  idempotencyKey?: string | null;
}

async function seedRow(options: SeedOptions = {}): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO scheduled_messages
       (id, channel, target_type, target_id, pacing_key, to_peer, body, timezone,
        send_at, expires_at, status, claim_token, claimed_at, idempotency_key,
        created_at, updated_at)
     VALUES (?, 'sms', ?, 'device_test', 'sms:device_test', '+15550001111', 'hello',
             'UTC', ?, ?, ?, NULL, ?, ?, ?, ?)`
  )
    .bind(
      id,
      options.targetType ?? "device",
      options.sendAt ?? now - 1000,
      options.expiresAt ?? null,
      options.status ?? "scheduled",
      options.claimedAt ?? null,
      options.idempotencyKey ?? null,
      now,
      options.updatedAt ?? now
    )
    .run();
  return id;
}

async function statusOf(id: string): Promise<ScheduledStatus | null | undefined> {
  const row = await env.DB.prepare(`SELECT status FROM scheduled_messages WHERE id = ?`)
    .bind(id)
    .first<{ status: ScheduledStatus }>();
  return row?.status;
}

describe("claimScheduled", () => {
  it("claims one due row atomically through UPDATE ... RETURNING", async () => {
    const now = Date.now();
    const id = await seedRow({ sendAt: now - 1000 });

    const claimed = await claimScheduled(env.DB, id, "token-1", now);
    expect(claimed).not.toBeNull();
    expect(claimed?.id).toBe(id);
    expect(claimed?.status).toBe("dispatching");
    expect(claimed?.claim_token).toBe("token-1");
    expect(claimed?.attempts).toBe(1);
    expect(claimed?.claimed_at).toBe(now);

    // A second claim loses: the row is no longer `scheduled`.
    expect(await claimScheduled(env.DB, id, "token-2", now)).toBeNull();
  });

  it("refuses a row that is not yet due, is expired, or is not scheduled", async () => {
    const now = Date.now();
    const future = await seedRow({ sendAt: now + 60_000 });
    expect(await claimScheduled(env.DB, future, "t", now)).toBeNull();

    const expired = await seedRow({ sendAt: now - 1000, expiresAt: now - 1 });
    expect(await claimScheduled(env.DB, expired, "t", now)).toBeNull();

    const cancelled = await seedRow({ status: "cancelled" });
    expect(await claimScheduled(env.DB, cancelled, "t", now)).toBeNull();
  });
});

describe("cancelScheduled", () => {
  it("cancels a scheduled row once and reports the current status after", async () => {
    const id = await seedRow();
    expect(await cancelScheduled(env.DB, id, Date.now())).toEqual({
      ok: true,
      status: "cancelled"
    });
    expect(await cancelScheduled(env.DB, id, Date.now())).toEqual({
      ok: false,
      status: "cancelled"
    });
  });

  it("refuses a dispatching row and names why", async () => {
    const id = await seedRow({ status: "dispatching", claimedAt: Date.now() });
    const result = await cancelScheduled(env.DB, id, Date.now());
    expect(result.ok).toBe(false);
    expect(result.status).toBe("dispatching");
  });

  it("reports null for a row that does not exist", async () => {
    expect(await cancelScheduled(env.DB, crypto.randomUUID(), Date.now())).toEqual({
      ok: false,
      status: null
    });
  });
});

describe("finalizeScheduled", () => {
  it("writes the outcome only for the claim holder and fills forward timestamps", async () => {
    const now = Date.now();
    const id = await seedRow({ sendAt: now - 1000 });
    const claimed = await claimScheduled(env.DB, id, "token-1", now);
    expect(claimed?.status).toBe("dispatching");

    // A different token cannot finalize.
    expect(
      await finalizeScheduled(env.DB, id, "token-2", "sent", { dispatchRef: "ref-1" }, now + 10)
    ).toBeNull();

    const delivered = await finalizeScheduled(
      env.DB,
      id,
      "token-1",
      "delivered",
      { dispatchRef: "ref-1" },
      now + 20
    );
    expect(delivered?.status).toBe("delivered");
    expect(delivered?.dispatch_ref).toBe("ref-1");
    expect(delivered?.dispatched_at).toBe(now + 20);
    expect(delivered?.sent_at).toBe(now + 20);
    expect(delivered?.delivered_at).toBe(now + 20);

    // The fence is gone: a late `sent` cannot walk the row backwards.
    expect(
      await finalizeScheduled(env.DB, id, "token-1", "sent", {}, now + 30)
    ).toBeNull();
    expect(await statusOf(id)).toBe("delivered");
  });

  it("records a failure with its error", async () => {
    const now = Date.now();
    const id = await seedRow({ sendAt: now - 1000 });
    await claimScheduled(env.DB, id, "token-f", now);

    const failed = await finalizeScheduled(
      env.DB,
      id,
      "token-f",
      "failed",
      { error: "carrier_rejected" },
      now + 5
    );
    expect(failed?.status).toBe("failed");
    expect(failed?.last_error).toBe("carrier_rejected");
    expect(failed?.dispatched_at).toBeNull();
  });
});

describe("deferScheduled", () => {
  it("shifts a scheduled row without spending an attempt", async () => {
    const now = Date.now();
    const id = await seedRow();

    expect(await deferScheduled(env.DB, id, now + 60_000, "quiet_hours", now)).toBe(true);
    const row = await env.DB.prepare(
      `SELECT send_at, shift_count, last_shift_reason, attempts FROM scheduled_messages WHERE id = ?`
    )
      .bind(id)
      .first<{
        send_at: number;
        shift_count: number;
        last_shift_reason: string;
        attempts: number;
      }>();
    expect(row?.send_at).toBe(now + 60_000);
    expect(row?.shift_count).toBe(1);
    expect(row?.last_shift_reason).toBe("quiet_hours");
    expect(row?.attempts).toBe(0);
  });

  it("does not move a row a dispatcher already owns", async () => {
    const now = Date.now();
    const id = await seedRow({ status: "dispatching", claimedAt: now });
    expect(await deferScheduled(env.DB, id, now + 60_000, "quiet_hours", now)).toBe(false);
  });
});

describe("recoverStale", () => {
  it("re-queues a stale device dispatch and marks a stale connector unknown", async () => {
    const now = Date.now();
    const stale = now - 10 * 60_000;

    const device = await seedRow({
      status: "dispatching",
      claimedAt: stale,
      updatedAt: stale
    });
    const connector = await seedRow({
      status: "dispatching",
      targetType: "connector",
      claimedAt: stale,
      updatedAt: stale
    });
    const fresh = await seedRow({ status: "dispatching", claimedAt: now });

    const result = await recoverStale(env.DB, 5 * 60_000, now);
    expect(result).toEqual({ requeued: 1, unknown: 1 });

    expect(await statusOf(device)).toBe("scheduled");
    expect(await statusOf(connector)).toBe("unknown");
    expect(await statusOf(fresh)).toBe("dispatching");

    const connectorRow = await env.DB.prepare(
      `SELECT last_error, claim_token, claimed_at FROM scheduled_messages WHERE id = ?`
    )
      .bind(connector)
      .first<{ last_error: string; claim_token: string | null; claimed_at: number | null }>();
    expect(connectorRow?.last_error).toBe("outcome unknown after a dispatch lease");
    expect(connectorRow?.claim_token).toBeNull();
    expect(connectorRow?.claimed_at).toBeNull();
  });

  it("leaves rows inside the lease alone", async () => {
    const now = Date.now();
    const id = await seedRow({ status: "dispatching", claimedAt: now - 1000 });
    const result = await recoverStale(env.DB, 5 * 60_000, now);
    expect(result.requeued).toBe(0);
    expect(result.unknown).toBe(0);
    expect(await statusOf(id)).toBe("dispatching");
  });
});

/* ------------------------------------------------------------------------- *
 * Idempotency and column shape
 * ------------------------------------------------------------------------- */

describe("scheduled_messages schema", () => {
  it("has a partial unique idempotency index that tolerates many nulls", async () => {
    await seedRow();
    await seedRow();
    const key = `idem-${crypto.randomUUID()}`;
    await seedRow({ idempotencyKey: key });

    await expect(seedRow({ idempotencyKey: key })).rejects.toThrow();
  });

  it("stores every agreed column", async () => {
    const id = await seedRow();
    const row = await env.DB.prepare(`SELECT * FROM scheduled_messages WHERE id = ?`)
      .bind(id)
      .first<Record<string, unknown>>();
    const expected = [
      "id",
      "campaign_id",
      "channel",
      "target_type",
      "target_id",
      "pacing_key",
      "to_peer",
      "body",
      "template_id",
      "vars_json",
      "policy_json",
      "timezone",
      "sim_slot",
      "send_at",
      "expires_at",
      "status",
      "attempts",
      "shift_count",
      "last_shift_reason",
      "claim_token",
      "claimed_at",
      "dispatched_at",
      "sent_at",
      "delivered_at",
      "dispatch_ref",
      "idempotency_key",
      "last_error",
      "created_at",
      "updated_at"
    ];
    expect(Object.keys(row ?? {}).sort()).toEqual([...expected].sort());
  });
});
