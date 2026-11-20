/**
 * Inbound STOP/START handling and the dispatch-time opt-out guard.
 *
 * The keyword is an audience flag, not a conversation state: a recipient who
 * texts STOP must stop receiving scheduled sends even if they never existed in
 * `contacts` before. The route writes the flag in the same D1 batch as the
 * messages, and the Scheduler re-checks it immediately before a send.
 */

import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { handleIncomingBatch } from "../src/routes/incoming";
import {
  isPeerOptedOut,
  normalisePeer,
  optOutContactStatement,
  smsOptOutAction,
  type OptOutAction
} from "../src/lib/scheduled";
import type { Env } from "../src/index";

/* ------------------------------------------------------------------------- *
 * Keyword parsing
 * ------------------------------------------------------------------------- */

describe("smsOptOutAction", () => {
  it("recognises every opt-out keyword regardless of case or padding", () => {
    for (const keyword of ["STOP", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]) {
      expect(smsOptOutAction(keyword)).toBe("stop");
      expect(smsOptOutAction(`  ${keyword.toLowerCase()} \n`)).toBe("stop");
    }
  });

  it("recognises the resubscribe keywords", () => {
    expect(smsOptOutAction("START")).toBe("start");
    expect(smsOptOutAction("unstop")).toBe("start");
  });

  it("requires the whole trimmed body to be the keyword", () => {
    expect(smsOptOutAction("please stop sending")).toBeNull();
    expect(smsOptOutAction("STOP please")).toBeNull();
    expect(smsOptOutAction("STOPPED")).toBeNull();
    expect(smsOptOutAction("")).toBeNull();
    expect(smsOptOutAction("hello")).toBeNull();
  });
});

/* ------------------------------------------------------------------------- *
 * Statement-level behaviour
 * ------------------------------------------------------------------------- */

interface ContactRow {
  peer: string;
  opt_out: number;
  created_at: number;
  updated_at: number;
  name: string | null;
  tags_json: string;
  timezone: string;
}

async function contact(peer: string): Promise<ContactRow | null> {
  const normalized = normalisePeer("sms", peer);
  if (normalized === null) throw new Error(`bad test peer: ${peer}`);
  const row = await env.DB.prepare(
    `SELECT peer, opt_out, created_at, updated_at, name, tags_json, timezone
       FROM contacts WHERE channel = 'sms' AND peer = ?`
  )
    .bind(normalized)
    .first<ContactRow>();
  return row ?? null;
}

async function applyKeyword(peer: string, action: OptOutAction, now: number): Promise<void> {
  const normalized = normalisePeer("sms", peer);
  if (normalized === null) throw new Error(`bad test peer: ${peer}`);
  await env.DB.batch([optOutContactStatement(env.DB, normalized, action, now)]);
}

describe("opt-out contact statement", () => {
  it("inserts a new opted-out audience row", async () => {
    const peer = "+15551000001";
    const now = Date.now();

    await applyKeyword(peer, "stop", now);

    const row = await contact(peer);
    expect(row?.opt_out).toBe(1);
    expect(row?.updated_at).toBe(now);
    expect(row?.created_at).toBe(now);
    expect(row?.timezone).toBe("UTC");
  });

  it("START re-enables an existing opted-out row and keeps its details", async () => {
    const peer = "+15551000002";
    const now = Date.now();
    await applyKeyword(peer, "stop", now);
    await env.DB.prepare(
      `UPDATE contacts SET name = 'Ada', tags_json = '["vip"]', timezone = 'Europe/Paris'
        WHERE channel = 'sms' AND peer = ?`
    )
      .bind(peer)
      .run();

    await applyKeyword(peer, "start", now + 1000);

    const row = await contact(peer);
    expect(row?.opt_out).toBe(0);
    expect(row?.updated_at).toBe(now + 1000);
    expect(row?.name).toBe("Ada");
    expect(row?.tags_json).toBe("[\"vip\"]");
    expect(row?.timezone).toBe("Europe/Paris");
  });

  it("isPeerOptedOut reports the flag and ignores a missing row", async () => {
    const peer = "+15551000003";
    expect(await isPeerOptedOut(env.DB, "sms", peer)).toBe(false);
    await applyKeyword(peer, "stop", Date.now());
    expect(await isPeerOptedOut(env.DB, "sms", peer)).toBe(true);
  });
});

/* ------------------------------------------------------------------------- *
 * Route level: the batch, dedupe and direction rules
 * ------------------------------------------------------------------------- */

function fakeEnv(): Env {
  return {
    ...env,
    DEVICE: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (input: RequestInfo | URL): Promise<Response> => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          if (url.includes("__reserve")) return Response.json({ ok: true });
          if (url.includes("__pending")) return Response.json([]);
          return Response.json({ ok: true });
        }
      })
    }
  } as unknown as Env;
}

let localIdCounter = 0;
function localId(): string {
  localIdCounter += 1;
  return `optout-${localIdCounter}-${crypto.randomUUID().slice(0, 8)}`;
}

async function upload(
  rows: Array<Record<string, unknown>>
): Promise<{ accepted: number; duplicates: number }> {
  const response = await handleIncomingBatch(
    new Request("https://example.test/v1/messages"),
    fakeEnv(),
    "device_test",
    JSON.stringify({ messages: rows })
  );
  if (response.status !== 200) throw new Error(`upload failed: ${response.status}`);
  return (await response.json()) as { accepted: number; duplicates: number };
}

function inbound(peer: string, body: string, id = localId()): Record<string, unknown> {
  return {
    local_id: id,
    sender_e164: peer,
    body,
    received_at: Date.now()
  };
}

describe("incoming route STOP/START", () => {
  it("writes every stop keyword for an inbound row", async () => {
    const keywords = ["STOP", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"];
    for (let i = 0; i < keywords.length; i += 1) {
      const peer = `+1555200${String(i).padStart(4, "0")}`;
      const body = keywords[i];
      const result = await upload([inbound(peer, `${body.toLowerCase()} `)]);
      expect(result.accepted).toBe(1);
      expect((await contact(peer))?.opt_out).toBe(1);
      expect((await contact(peer))?.updated_at).toBeGreaterThan(0);
    }
  });

  it("writes START and UNSTOP as opt_in", async () => {
    for (const [index, body] of ["START", "UNSTOP"].entries()) {
      const peer = `+1555201${String(index).padStart(4, "0")}`;
      await applyKeyword(peer, "stop", Date.now());
      const result = await upload([inbound(peer, body)]);
      expect(result.accepted).toBe(1);
      expect((await contact(peer))?.opt_out).toBe(0);
    }
  });

  it("leaves an unrelated body and the contact list unchanged", async () => {
    const peer = "+15552020000";
    const result = await upload([inbound(peer, "see you at noon")]);
    expect(result.accepted).toBe(1);
    expect(await contact(peer)).toBeNull();
  });

  it("does not opt out from an outbound row whose body says STOP", async () => {
    const peer = "+15552030000";
    const result = await upload([
      {
        local_id: localId(),
        direction: "out",
        sender_e164: peer,
        body: "STOP",
        received_at: Date.now()
      }
    ]);
    expect(result.accepted).toBe(1);
    expect(await contact(peer)).toBeNull();
  });

  it("repairs the flag on a replayed upload even though the message is deduped", async () => {
    const peer = "+15552040000";
    const id = localId();
    expect((await upload([inbound(peer, "STOP", id)])).accepted).toBe(1);
    expect((await contact(peer))?.opt_out).toBe(1);

    // Simulate a lost or overwritten flag, then replay the same (device, local_id).
    await env.DB.prepare(`UPDATE contacts SET opt_out = 0 WHERE channel = 'sms' AND peer = ?`)
      .bind(peer)
      .run();

    const replay = await upload([inbound(peer, "STOP", id)]);
    expect(replay.accepted).toBe(0);
    expect(replay.duplicates).toBe(1);
    expect((await contact(peer))?.opt_out).toBe(1);
  });
});

/* ------------------------------------------------------------------------- *
 * Scheduler alarm: the guard runs before the claim
 * ------------------------------------------------------------------------- */

async function seedDueRow(peer: string, policyJson = "{}"): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO scheduled_messages
       (id, channel, target_type, target_id, pacing_key, to_peer, body, timezone,
        send_at, status, policy_json, created_at, updated_at)
     VALUES (?, 'sms', 'device', 'device_test', 'sms:device_test', ?, 'reminder',
             'UTC', ?, 'scheduled', ?, ?, ?)`
  )
    .bind(id, peer, now - 1000, policyJson, now, now)
    .run();
  return id;
}

describe("Scheduler opt-out guard", () => {
  it("skips a due row for an opted-out peer without dispatching", async () => {
    const peer = "+15553000001";
    const id = await seedDueRow(peer);
    await applyKeyword(peer, "stop", Date.now());

    const scheduler = env.SCHEDULER.getByName("scheduler");
    await runInDurableObject(scheduler, async (instance) => {
      await instance.alarm();
    });

    const row = await env.DB.prepare(
      `SELECT status, last_error FROM scheduled_messages WHERE id = ?`
    )
      .bind(id)
      .first<{ status: string; last_error: string | null }>();
    expect(row?.status).toBe("skipped_opt_out");
    expect(row?.last_error).toBe("recipient opted out");

    const messages = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM messages WHERE device_id = 'device_test' AND id = ?`
    )
      .bind(id)
      .first<{ count: number }>();
    expect(messages?.count).toBe(0);

    const commands = await runInDurableObject(
      env.DEVICE.get(env.DEVICE.idFromName("device_test")),
      (_instance, ctx) =>
        ctx.storage.sql.exec<{ command_id: string }>(`SELECT command_id FROM commands`).toArray()
    );
    expect(commands).toEqual([]);
  });

  it("still dispatches when the contact is not opted out", async () => {
    const peer = "+15553000002";
    // Quiet hours would otherwise defer the row: the test is about the opt-out
    // guard, not the clock.
    const id = await seedDueRow(peer, '{"quiet_start_hour":0,"quiet_end_hour":0}');

    const scheduler = env.SCHEDULER.getByName("scheduler");
    await runInDurableObject(scheduler, async (instance) => {
      await instance.alarm();
    });

    const row = await env.DB.prepare(
      `SELECT status, dispatch_ref FROM scheduled_messages WHERE id = ?`
    )
      .bind(id)
      .first<{ status: string; dispatch_ref: string | null }>();
    expect(row?.status).toBe("sent");
    expect(row?.dispatch_ref).toBe(id);
  });
});
