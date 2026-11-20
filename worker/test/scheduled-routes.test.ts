/**
 * Scheduled-send routes.
 *
 * These are handler-level tests against the real D1 schema and the real
 * `Scheduler` binding. The alarm loop itself is not exercised here: W1 pins the
 * claim/finalize primitives, and an end-to-end alarm would need a controllable
 * clock. What these prove is the contract the console depends on: validation,
 * the row shape, the wake failure being a retryable 503, cancellation state and
 * the parsed list view.
 */

import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/index";
import type { AdminActor } from "../src/audit";
import {
  handlePacingList,
  handlePacingUpdate,
  handleScheduledCancel,
  handleScheduledCreate,
  handleScheduledList,
} from "../src/routes/scheduled";

const testEnv = env as unknown as Env;

const owner: AdminActor = {
  userId: null,
  label: "test-owner",
  role: "owner",
  canGrantOwner: true,
};

const member: AdminActor = {
  userId: "usr_member",
  label: "member@example.test",
  role: "member",
  canGrantOwner: false,
};

function unique(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function createRequest(body: unknown): Request {
  return new Request("https://example.com/v1/scheduled", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function insertDevice(): Promise<string> {
  const id = unique("dev");
  const now = Date.now();
  await testEnv.DB.prepare(
    `INSERT INTO devices (device_id, public_key, paired_at, last_seen)
     VALUES (?, ?, ?, ?)`
  )
    .bind(id, "test-public-key", now, now)
    .run();
  return id;
}

async function insertConnector(
  options: {
    channel?: string;
    tier?: "worker_do" | "edge_device";
    enabled?: number;
  } = {}
): Promise<{ id: string; accountId: string }> {
  const id = unique("conn");
  const accountId = unique("acct");
  const channel = options.channel ?? "telegram";
  const now = Date.now();
  await testEnv.DB.prepare(
    `INSERT INTO channel_connectors
       (id, channel, account_id, execution_tier, label, enabled, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'Test bot', ?, 'test', ?, ?)`
  )
    .bind(
      id,
      channel,
      accountId,
      options.tier ?? "worker_do",
      options.enabled ?? 1,
      now,
      now
    )
    .run();
  return { id, accountId };
}

async function insertTemplate(options: {
  name: string;
  body: string;
  waName: string | null;
  waLanguage: string | null;
}): Promise<string> {
  const id = unique("tpl");
  const now = Date.now();
  await testEnv.DB.prepare(
    `INSERT INTO message_templates
       (id, name, channel, body, variables_json, wa_template_name, wa_language,
        created_at, updated_at)
     VALUES (?, ?, 'whatsapp', ?, '[]', ?, ?, ?, ?)`
  )
    .bind(id, options.name, options.body, options.waName, options.waLanguage, now, now)
    .run();
  return id;
}

const QUIET_OFF = { quiet_start_hour: 0, quiet_end_hour: 0 };

describe("handleScheduledCreate", () => {
  it("refuses an admin member before reading the body", async () => {
    const response = await handleScheduledCreate(
      createRequest({ channel: "sms" }),
      testEnv,
      member
    );
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: string }).error).toBe("permission");
  });

  it("rejects an unknown device", async () => {
    const response = await handleScheduledCreate(
      createRequest({
        channel: "sms",
        target_id: unique("missing"),
        to_peer: "+8801712345678",
        body: "hello",
        send_at: Date.now() + 60_000,
      }),
      testEnv,
      owner
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe("unknown_device");
  });

  it("rejects a bad peer", async () => {
    const deviceId = await insertDevice();
    const response = await handleScheduledCreate(
      createRequest({
        channel: "sms",
        target_id: deviceId,
        to_peer: "not a phone number",
        body: "hello",
        send_at: Date.now() + 60_000,
      }),
      testEnv,
      owner
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe("bad_peer");
  });

  it("rejects a bad timezone instead of falling back to UTC", async () => {
    const deviceId = await insertDevice();
    const response = await handleScheduledCreate(
      createRequest({
        channel: "sms",
        target_id: deviceId,
        to_peer: "+8801712345678",
        body: "hello",
        send_at: Date.now() + 60_000,
        timezone: "Not/AZone",
        policy: QUIET_OFF,
      }),
      testEnv,
      owner
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe("bad_timezone");
  });

  it("rejects an edge-device connector", async () => {
    const connector = await insertConnector({ tier: "edge_device" });
    const response = await handleScheduledCreate(
      createRequest({
        channel: "telegram",
        target_id: connector.id,
        to_peer: "5551234",
        body: "hello",
        send_at: Date.now() + 60_000,
      }),
      testEnv,
      owner
    );
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe("connector_edge_device");
  });

  it("rejects a disabled connector", async () => {
    const connector = await insertConnector({ enabled: 0 });
    const response = await handleScheduledCreate(
      createRequest({
        channel: "telegram",
        target_id: connector.id,
        to_peer: "5551234",
        body: "hello",
        send_at: Date.now() + 60_000,
      }),
      testEnv,
      owner
    );
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe("connector_disabled");
  });

  it("inserts one UUID row with a pacing key and a policy snapshot", async () => {
    const deviceId = await insertDevice();
    const sendAt = Date.now() + 60_000;
    const response = await handleScheduledCreate(
      createRequest({
        channel: "sms",
        target_id: deviceId,
        to_peer: "  +880 1712-345-678 ",
        body: "hello",
        send_at: sendAt,
        sim_slot: 1,
        vars: { name: "Rafi" },
        policy: {
          ...QUIET_OFF,
          max_per_hour: 12,
          min_interval_ms: 5000,
          jitter_pct: 10,
        },
      }),
      testEnv,
      owner
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      scheduled: {
        id: string;
        status: string;
        pacing_key: string;
        to_peer: string;
        policy: Record<string, unknown>;
        vars: Record<string, unknown>;
      };
    };
    expect(body.scheduled.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(body.scheduled.pacing_key).toBe(`sms:${deviceId}:1`);
    expect(body.scheduled.to_peer).toBe("+8801712345678");
    expect(body.scheduled.status).toBe("scheduled");
    expect(body.scheduled.vars).toEqual({ name: "Rafi" });
    expect(body.scheduled.policy.max_per_hour).toBe(12);
    expect(body.scheduled.policy.quiet_start_hour).toBe(0);
    expect(body.scheduled.policy.quiet_end_hour).toBe(0);

    const row = await testEnv.DB.prepare(
      `SELECT id, status, send_at, pacing_key, policy_json FROM scheduled_messages WHERE id = ?`
    )
      .bind(body.scheduled.id)
      .first<{
        id: string;
        status: string;
        send_at: number;
        pacing_key: string;
        policy_json: string;
      }>();
    expect(row?.status).toBe("scheduled");
    expect(row?.send_at).toBe(sendAt);
    expect(row?.pacing_key).toBe(`sms:${deviceId}:1`);
    expect(JSON.parse(row?.policy_json ?? "{}").max_per_hour).toBe(12);
  });

  it("returns the stored row and 503 when the scheduler cannot be woken", async () => {
    const deviceId = await insertDevice();
    const broken = new Proxy(testEnv, {
      get(target, prop, receiver) {
        if (prop === "SCHEDULER") {
          return {
            getByName: () => {
              throw new Error("object unavailable");
            },
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });

    const response = await handleScheduledCreate(
      createRequest({
        channel: "sms",
        target_id: deviceId,
        to_peer: "+8801712345678",
        body: "retry me",
        send_at: Date.now() + 60_000,
        policy: QUIET_OFF,
      }),
      broken,
      owner
    );
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: string }).error).toBe("scheduler_unavailable");

    const row = await testEnv.DB.prepare(
      `SELECT status FROM scheduled_messages WHERE to_peer = ? ORDER BY created_at DESC LIMIT 1`
    )
      .bind("+8801712345678")
      .first<{ status: string }>();
    expect(row?.status).toBe("scheduled");
  });

  it("returns the existing row for a repeated idempotency key", async () => {
    const deviceId = await insertDevice();
    const key = unique("idem");
    const body = {
      channel: "sms",
      target_id: deviceId,
      to_peer: "+8801712345678",
      body: "once",
      send_at: Date.now() + 60_000,
      idempotency_key: key,
      policy: QUIET_OFF,
    };

    const first = await handleScheduledCreate(createRequest(body), testEnv, owner);
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { scheduled: { id: string } };

    const second = await handleScheduledCreate(createRequest(body), testEnv, owner);
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { scheduled: { id: string } };
    expect(secondBody.scheduled.id).toBe(firstBody.scheduled.id);
  });
});

describe("scheduled templates", () => {
  it("resolves a local template id to the WhatsApp platform name and ordered args", async () => {
    const connector = await insertConnector({ channel: "whatsapp" });
    const templateId = await insertTemplate({
      name: "Order update",
      body: "Hi {{1}}, your code is {{2}}",
      waName: "order_update_platform",
      waLanguage: "es_ES",
    });

    const response = await handleScheduledCreate(
      createRequest({
        channel: "whatsapp",
        target_id: connector.id,
        to_peer: "15551234567",
        body: "Hi {{1}}, your code is {{2}}",
        send_at: Date.now() + 60_000,
        template_id: templateId,
        vars: { "1": "one", "2": "two" },
      }),
      testEnv,
      owner
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      scheduled: {
        template_id: string;
        body: string;
        policy: Record<string, unknown>;
      };
    };
    expect(body.scheduled.template_id).toBe("order_update_platform");
    // The operator preview stays the row body; the platform name is the id.
    expect(body.scheduled.body).toBe("Hi {{1}}, your code is {{2}}");
    expect(body.scheduled.policy.template_language).toBe("es_ES");
    expect(body.scheduled.policy.template_args).toEqual(["one", "two"]);

    const row = await testEnv.DB.prepare(
      `SELECT template_id, policy_json FROM scheduled_messages WHERE to_peer = ?`
    )
      .bind("15551234567")
      .first<{ template_id: string; policy_json: string }>();
    expect(row?.template_id).toBe("order_update_platform");
    const snapshot = JSON.parse(row?.policy_json ?? "{}") as Record<string, unknown>;
    expect(snapshot.template_language).toBe("es_ES");
    expect(snapshot.template_args).toEqual(["one", "two"]);
  });

  it("falls back to the local template name and en_US when the row has no platform values", async () => {
    const connector = await insertConnector({ channel: "whatsapp" });
    const templateId = await insertTemplate({
      name: "plain_name",
      body: "No variables",
      waName: null,
      waLanguage: null,
    });

    const response = await handleScheduledCreate(
      createRequest({
        channel: "whatsapp",
        target_id: connector.id,
        to_peer: "15550001111",
        body: "No variables",
        send_at: Date.now() + 60_000,
        template_id: templateId,
      }),
      testEnv,
      owner
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      scheduled: { template_id: string; policy: Record<string, unknown> };
    };
    expect(body.scheduled.template_id).toBe("plain_name");
    expect(body.scheduled.policy.template_language).toBe("en_US");
    expect(body.scheduled.policy.template_args).toEqual([]);
  });

  it("rejects an unknown template and a template on a non-WhatsApp connector", async () => {
    const whatsapp = await insertConnector({ channel: "whatsapp" });
    const missing = await handleScheduledCreate(
      createRequest({
        channel: "whatsapp",
        target_id: whatsapp.id,
        to_peer: "15551234567",
        body: "hello",
        send_at: Date.now() + 60_000,
        template_id: unique("missing"),
      }),
      testEnv,
      owner
    );
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { error: string }).error).toBe("template_not_found");

    const telegram = await insertConnector({ channel: "telegram" });
    const wrongChannel = await handleScheduledCreate(
      createRequest({
        channel: "telegram",
        target_id: telegram.id,
        to_peer: "5551234",
        body: "hello",
        send_at: Date.now() + 60_000,
        template_id: unique("tpl"),
      }),
      testEnv,
      owner
    );
    expect(wrongChannel.status).toBe(400);
    expect(((await wrongChannel.json()) as { error: string }).error).toBe("template_channel");
  });
});

describe("handleScheduledCancel", () => {
  it("cancels a row that is still scheduled", async () => {
    const deviceId = await insertDevice();
    const created = await handleScheduledCreate(
      createRequest({
        channel: "sms",
        target_id: deviceId,
        to_peer: "+8801712345678",
        body: "cancel me",
        send_at: Date.now() + 60_000,
        policy: QUIET_OFF,
      }),
      testEnv,
      owner
    );
    const { scheduled } = (await created.json()) as { scheduled: { id: string } };

    const response = await handleScheduledCancel(
      new Request(`https://example.com/v1/scheduled/${scheduled.id}`, { method: "DELETE" }),
      testEnv,
      owner,
      scheduled.id
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, cancelled: true });
  });

  it("refuses a row that is already dispatching", async () => {
    const deviceId = await insertDevice();
    const created = await handleScheduledCreate(
      createRequest({
        channel: "sms",
        target_id: deviceId,
        to_peer: "+8801712345678",
        body: "too late",
        send_at: Date.now() + 60_000,
        policy: QUIET_OFF,
      }),
      testEnv,
      owner
    );
    const { scheduled } = (await created.json()) as { scheduled: { id: string } };
    await testEnv.DB.prepare(
      `UPDATE scheduled_messages SET status = 'dispatching', claim_token = 't' WHERE id = ?`
    )
      .bind(scheduled.id)
      .run();

    const response = await handleScheduledCancel(
      new Request(`https://example.com/v1/scheduled/${scheduled.id}`, { method: "DELETE" }),
      testEnv,
      owner,
      scheduled.id
    );
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string; status: string };
    expect(body.error).toBe("not_cancellable");
    expect(body.status).toBe("dispatching");
  });

  it("returns 409 for an unknown row", async () => {
    const response = await handleScheduledCancel(
      new Request("https://example.com/v1/scheduled/nope", { method: "DELETE" }),
      testEnv,
      owner,
      "nope"
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "not_cancellable", status: null });
  });
});

describe("handleScheduledList", () => {
  it("parses vars_json and policy_json and applies filters", async () => {
    const deviceId = await insertDevice();
    const created = await handleScheduledCreate(
      createRequest({
        channel: "sms",
        target_id: deviceId,
        to_peer: "+8801712345678",
        body: "list me",
        send_at: Date.now() + 60_000,
        vars: { name: "Nadia" },
        policy: QUIET_OFF,
      }),
      testEnv,
      owner
    );
    expect(created.status).toBe(201);

    const response = await handleScheduledList(
      testEnv,
      new URL(
        `https://example.com/v1/scheduled?status=scheduled&channel=sms&target_id=${encodeURIComponent(deviceId)}`
      )
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      scheduled: Array<Record<string, unknown>>;
    };
    expect(body.scheduled).toHaveLength(1);
    const row = body.scheduled[0];
    expect(row.vars).toEqual({ name: "Nadia" });
    expect(row.policy).toMatchObject({ quiet_start_hour: 0, quiet_end_hour: 0 });
    expect(row).not.toHaveProperty("vars_json");
    expect(row).not.toHaveProperty("policy_json");
  });

  it("rejects an unknown status filter", async () => {
    const response = await handleScheduledList(
      testEnv,
      new URL("https://example.com/v1/scheduled?status=bogus")
    );
    expect(response.status).toBe(400);
  });
});

const PACING_BODY = {
  min_interval_ms: 15_000,
  jitter_pct: 20,
  max_per_hour: 25,
  quiet_start_hour: 0,
  quiet_end_hour: 0,
  timezone: "UTC",
};

function pacingRequest(body: unknown): Request {
  return new Request("https://example.com/v1/admin/pacing/device/target", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("pacing policies", () => {
  it("upserts a policy and lists it", async () => {
    const targetId = unique("device");
    const first = await handlePacingUpdate(
      pacingRequest(PACING_BODY),
      testEnv,
      owner,
      "device",
      targetId
    );
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      policy: { id: string; target_type: string; target_id: string; updated_at: number };
    };
    expect(firstBody.policy.target_type).toBe("device");
    expect(firstBody.policy.target_id).toBe(targetId);

    const second = await handlePacingUpdate(
      pacingRequest({ ...PACING_BODY, max_per_hour: 12 }),
      testEnv,
      owner,
      "device",
      targetId
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      policy: { id: string; max_per_hour: number };
    };
    expect(secondBody.policy.id).toBe(firstBody.policy.id);
    expect(secondBody.policy.max_per_hour).toBe(12);

    const count = await testEnv.DB.prepare(
      `SELECT COUNT(*) AS n FROM pacing_policies WHERE target_type = 'device' AND target_id = ?`
    )
      .bind(targetId)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);

    const list = await handlePacingList(testEnv);
    expect(list.status).toBe(200);
    const listed = (await list.json()) as {
      policies: Array<Record<string, unknown>>;
    };
    const row = listed.policies.find((policy) => policy.target_id === targetId);
    expect(row).toMatchObject({
      target_type: "device",
      min_interval_ms: 15_000,
      jitter_pct: 20,
      max_per_hour: 12,
      quiet_start_hour: 0,
      quiet_end_hour: 0,
      timezone: "UTC",
    });
    expect(typeof row?.updated_at).toBe("number");
  });

  it("rejects an invalid target type, bounds and timezone", async () => {
    const badType = await handlePacingUpdate(
      pacingRequest(PACING_BODY),
      testEnv,
      owner,
      "phone",
      unique("target")
    );
    expect(badType.status).toBe(400);

    const badInterval = await handlePacingUpdate(
      pacingRequest({ ...PACING_BODY, min_interval_ms: 10 }),
      testEnv,
      owner,
      "device",
      unique("target")
    );
    expect(badInterval.status).toBe(400);

    const badTimezone = await handlePacingUpdate(
      pacingRequest({ ...PACING_BODY, timezone: "Not/AZone" }),
      testEnv,
      owner,
      "device",
      unique("target")
    );
    expect(badTimezone.status).toBe(400);
    expect(((await badTimezone.json()) as { error: string }).error).toBe("bad_timezone");
  });

  it("refuses a member before writing", async () => {
    const response = await handlePacingUpdate(
      pacingRequest(PACING_BODY),
      testEnv,
      member,
      "device",
      unique("target")
    );
    expect(response.status).toBe(403);
  });

  it("is read by scheduled create and snapshotted into policy_json", async () => {
    const deviceId = await insertDevice();
    const put = await handlePacingUpdate(
      pacingRequest({
        ...PACING_BODY,
        min_interval_ms: 30_000,
        max_per_hour: 7,
        jitter_pct: 5,
      }),
      testEnv,
      owner,
      "device",
      deviceId
    );
    expect(put.status).toBe(200);

    const created = await handleScheduledCreate(
      createRequest({
        channel: "sms",
        target_id: deviceId,
        to_peer: "+8801712345678",
        body: "policy snapshot",
        send_at: Date.now() + 60_000,
      }),
      testEnv,
      owner
    );
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      scheduled: { policy: Record<string, unknown> };
    };
    expect(body.scheduled.policy).toMatchObject({
      min_interval_ms: 30_000,
      jitter_pct: 5,
      max_per_hour: 7,
      quiet_start_hour: 0,
      quiet_end_hour: 0,
    });
  });
});
