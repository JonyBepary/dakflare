/**
 * Scheduled-send routes: create, list and cancel.
 *
 * D1 (`scheduled_messages`) is the queue and the cancellation authority. The
 * route validates the request, snapshots the pacing policy onto the row and then
 * wakes the Scheduler Durable Object. The object owns the clock and the token
 * bucket; nothing here waits for a send.
 *
 * Security mirrors `routes/channel-connectors.ts`: creating or cancelling is a
 * human, non-member operation, and the audit detail contains ids and policy but
 * never a peer or a body.
 */

import type { Env } from "../index";
import type { AdminActor } from "../audit";
import { writeAudit } from "../audit";
import { assertHuman } from "../lib/authority";
import { err } from "../lib/errors";
import { readJsonBoundedResult } from "../lib/body";
import {
  MAX_BODY_CHARS,
  MAX_BODY_BYTES,
  MAX_ID_CHARS,
  MAX_IDEMPOTENCY_KEY_CHARS,
} from "../lib/config";
import {
  DEFAULT_CLOUD_PACING,
  DEFAULT_SMS_PACING,
  type PacingPolicy,
} from "../lib/pacing";
import { whatsappParameterValues } from "../lib/templates";
import {
  InvalidTimezoneError,
  cancelScheduled,
  nextAllowedInstant,
  normalisePeer,
  type ScheduledRow,
  type ScheduledStatus,
} from "../lib/scheduled";
import { SCHEDULER_OBJECT_NAME } from "../scheduler";

const CONNECTOR_CHANNELS = [
  "sms",
  "whatsapp",
  "telegram",
  "messenger",
  "instagram",
] as const;
type ConnectorChannel = (typeof CONNECTOR_CHANNELS)[number];

const VALID_STATUSES = new Set<ScheduledStatus>([
  "scheduled",
  "dispatching",
  "dispatched",
  "sent",
  "delivered",
  "cancelled",
  "skipped_opt_out",
  "skipped_window",
  "failed",
  "unknown",
]);

const MAX_LIST_ROWS = 200;
const MAX_SIM_SLOT = 2;

interface PacingPolicyRow {
  min_interval_ms: number;
  jitter_pct: number;
  max_per_hour: number;
  quiet_start_hour: number;
  quiet_end_hour: number;
  timezone: string;
}

interface PacingPolicyListRow extends PacingPolicyRow {
  id: string;
  target_type: string;
  target_id: string;
  updated_at: number;
}

interface ConnectorTarget {
  account_id: string;
  execution_tier: string;
  enabled: number;
}

interface DeviceTarget {
  device_id: string;
}

interface PolicySnapshotJson {
  max_per_hour: number;
  min_interval_ms: number;
  jitter_pct: number;
  quiet_start_hour: number;
  quiet_end_hour: number;
  timezone: string;
  use_human_agent_tag: boolean;
  comment_id?: string | number;
  template_language?: string;
  template_args?: string[];
}

interface MessageTemplateRow {
  name: string;
  body: string;
  wa_template_name: string | null;
  wa_language: string | null;
}

/* ───────────────────────────── shared helpers ───────────────────────────── */

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** `assertHuman` plus the member refusal the connector admin handlers use. */
function schedulerWriteRefusal(actor: AdminActor): Response | null {
  const human = assertHuman(actor);
  if (!human.ok) return human.response;
  if (actor.role === "member") {
    return Response.json(
      {
        error: "permission",
        message: "scheduled sends are managed by owners and admins",
      },
      { status: 403 }
    );
  }
  return null;
}

function isChannel(value: string): value is ConnectorChannel {
  return (CONNECTOR_CHANNELS as readonly string[]).includes(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** The public shape: raw `vars_json` / `policy_json` become parsed objects. */
function scheduledView(row: ScheduledRow): Record<string, unknown> {
  const { vars_json, policy_json, ...rest } = row;
  return {
    ...rest,
    vars: parseJsonObject(vars_json),
    policy: parseJsonObject(policy_json),
  };
}

/* ───────────────────────────── create ───────────────────────────── */

export async function handleScheduledCreate(
  req: Request,
  env: Env,
  actor: AdminActor
): Promise<Response> {
  const refused = schedulerWriteRefusal(actor);
  if (refused !== null) return refused;

  const parsed = await readJsonBoundedResult(req, MAX_BODY_BYTES);
  if (!parsed.ok) return err(parsed.reason);
  const body = parsed.value;

  const channel = (nonEmptyString(body.channel) ?? "").toLowerCase();
  if (!isChannel(channel)) {
    return json({ error: "bad_channel", message: "channel is not supported" }, 400);
  }

  const targetId = nonEmptyString(body.target_id);
  if (targetId === null || targetId.length > MAX_ID_CHARS) {
    return json(
      { error: "bad_target", message: `target_id must be 1..${MAX_ID_CHARS} characters` },
      400
    );
  }

  const rawPeer = body.to_peer;
  if (typeof rawPeer !== "string") {
    return json({ error: "bad_peer", message: "to_peer is required" }, 400);
  }
  const peer = normalisePeer(channel, rawPeer);
  if (peer === null) {
    return json({ error: "bad_peer", message: "to_peer is not a valid address" }, 400);
  }

  const message = body.body;
  if (typeof message !== "string" || message.trim() === "") {
    return json({ error: "bad_body", message: "body must not be empty" }, 400);
  }
  if (message.length > MAX_BODY_CHARS) {
    return json(
      { error: "bad_body", message: `body is longer than ${MAX_BODY_CHARS} characters` },
      400
    );
  }

  const sendAt = body.send_at;
  const now = Date.now();
  if (typeof sendAt !== "number" || !Number.isFinite(sendAt)) {
    return json({ error: "bad_send_at", message: "send_at must be an epoch millisecond" }, 400);
  }
  if (sendAt < now) {
    return json({ error: "bad_send_at", message: "send_at must be now or in the future" }, 400);
  }

  const templateId = nonEmptyString(body.template_id);
  if (templateId !== null && templateId.length > MAX_ID_CHARS) {
    return json({ error: "bad_template", message: "template_id is too long" }, 400);
  }

  const campaignId = nonEmptyString(body.campaign_id);
  if (campaignId !== null && campaignId.length > MAX_ID_CHARS) {
    return json({ error: "bad_campaign", message: "campaign_id is too long" }, 400);
  }

  const vars = body.vars;
  if (vars !== undefined && !isRecord(vars)) {
    return json({ error: "bad_vars", message: "vars must be an object" }, 400);
  }
  const varsRecord = isRecord(vars) ? vars : {};

  // A template is a WhatsApp platform object, not a local rendering hint. A
  // non-WhatsApp channel cannot address one, so it is refused rather than
  // silently stored as an id every other sender ignores.
  let storedTemplateId: string | null = null;
  let templateLanguage: string | undefined;
  let templateArgs: string[] = [];
  if (templateId !== null) {
    if (channel !== "whatsapp") {
      return json(
        {
          error: "template_channel",
          message: "message templates are supported only on a WhatsApp connector",
        },
        400
      );
    }

    const template = await env.DB.prepare(
      `SELECT name, body, wa_template_name, wa_language
         FROM message_templates WHERE id = ?`
    )
      .bind(templateId)
      .first<MessageTemplateRow>();
    if (template === null) {
      return json(
        { error: "template_not_found", message: "template_id does not name a template" },
        400
      );
    }

    // The platform is addressed by its template name, not by the local row id.
    storedTemplateId = template.wa_template_name || template.name;
    templateLanguage = template.wa_language || "en_US";

    const values: Record<string, string | number | boolean | null | undefined> = {};
    for (const [key, value] of Object.entries(varsRecord)) {
      if (
        value === null ||
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        values[key] = value;
      }
    }
    templateArgs = whatsappParameterValues(template.body, values);
  }

  const simSlotRaw = body.sim_slot;
  let simSlot: number | null = null;
  if (simSlotRaw !== undefined && simSlotRaw !== null) {
    if (
      typeof simSlotRaw !== "number" ||
      !Number.isInteger(simSlotRaw) ||
      simSlotRaw < 0 ||
      simSlotRaw > MAX_SIM_SLOT
    ) {
      return json(
        { error: "bad_sim_slot", message: `sim_slot must be 0..${MAX_SIM_SLOT}` },
        400
      );
    }
    simSlot = simSlotRaw;
  }

  const idempotencyKeyRaw = body.idempotency_key;
  let idempotencyKey: string | null = null;
  if (idempotencyKeyRaw !== undefined && idempotencyKeyRaw !== null) {
    if (typeof idempotencyKeyRaw !== "string" || idempotencyKeyRaw.trim() === "") {
      return json({ error: "bad_idempotency_key", message: "idempotency_key is invalid" }, 400);
    }
    idempotencyKey = idempotencyKeyRaw.trim();
    if (idempotencyKey.length > MAX_IDEMPOTENCY_KEY_CHARS) {
      return json(
        {
          error: "bad_idempotency_key",
          message: `idempotency_key must be at most ${MAX_IDEMPOTENCY_KEY_CHARS} characters`,
        },
        400
      );
    }
  }

  let targetType: "device" | "connector";
  let pacingKey: string;
  let basePolicy: PacingPolicy;

  if (channel === "sms") {
    const device = await env.DB.prepare(
      `SELECT device_id FROM devices WHERE device_id = ? AND revoked_at IS NULL`
    )
      .bind(targetId)
      .first<DeviceTarget>();
    if (device === null) {
      return json(
        { error: "unknown_device", message: "target_id is not a registered device" },
        400
      );
    }
    targetType = "device";
    pacingKey = simSlot === null ? `sms:${targetId}` : `sms:${targetId}:${simSlot}`;
    basePolicy = DEFAULT_SMS_PACING;
  } else {
    const connector = await env.DB.prepare(
      `SELECT account_id, execution_tier, enabled
         FROM channel_connectors WHERE id = ? AND channel = ?`
    )
      .bind(targetId, channel)
      .first<ConnectorTarget>();
    if (connector === null) {
      return json(
        { error: "connector_not_found", message: "target_id is not a connector on this channel" },
        400
      );
    }
    if (connector.enabled !== 1) {
      return json(
        { error: "connector_disabled", message: "the connector is disabled" },
        409
      );
    }
    if (connector.execution_tier === "edge_device") {
      return json(
        {
          error: "connector_edge_device",
          message: "a scheduled connector send cannot run on an edge device tier",
        },
        409
      );
    }
    targetType = "connector";
    pacingKey = `${channel}:${connector.account_id}`;
    basePolicy = DEFAULT_CLOUD_PACING;
  }

  const policyRow = await env.DB.prepare(
    `SELECT min_interval_ms, jitter_pct, max_per_hour, quiet_start_hour,
            quiet_end_hour, timezone
       FROM pacing_policies WHERE target_type = ? AND target_id = ?`
  )
    .bind(targetType, targetId)
    .first<PacingPolicyRow>();

  const base: PacingPolicy =
    policyRow === null
      ? basePolicy
      : {
          minIntervalMs: policyRow.min_interval_ms,
          jitterPct: policyRow.jitter_pct,
          maxPerHour: policyRow.max_per_hour,
          quietStartHour: policyRow.quiet_start_hour,
          quietEndHour: policyRow.quiet_end_hour,
          timezone: policyRow.timezone,
        };

  const overrides = isRecord(body.policy) ? body.policy : {};
  const policy = {
    minIntervalMs: boundedNumber(overrides.min_interval_ms, base.minIntervalMs, 50, 86_400_000),
    jitterPct: boundedNumber(overrides.jitter_pct, base.jitterPct, 0, 50),
    maxPerHour: boundedNumber(overrides.max_per_hour, base.maxPerHour, 0, 100_000),
    quietStartHour: boundedNumber(overrides.quiet_start_hour, base.quietStartHour, 0, 23),
    quietEndHour: boundedNumber(overrides.quiet_end_hour, base.quietEndHour, 0, 23),
    useHumanAgentTag: overrides.use_human_agent_tag === true,
    commentId:
      typeof overrides.comment_id === "string" || typeof overrides.comment_id === "number"
        ? overrides.comment_id
        : undefined,
  };

  // The timezone is resolved before anything is written. A bad zone is a 400,
  // not a silent UTC fallback: quiet hours are the reason the field exists.
  let timezone = nonEmptyString(body.timezone);
  if (timezone === null) {
    const contact = await env.DB.prepare(
      `SELECT timezone FROM contacts WHERE channel = ? AND peer = ?`
    )
      .bind(channel, peer)
      .first<{ timezone: string }>();
    timezone = contact?.timezone ?? "UTC";
  }
  try {
    nextAllowedInstant(now, {
      timezone,
      quietStartHour: policy.quietStartHour,
      quietEndHour: policy.quietEndHour,
    });
  } catch (error) {
    if (error instanceof InvalidTimezoneError) {
      return json({ error: "bad_timezone", message: "timezone is not a known IANA zone" }, 400);
    }
    throw error;
  }

  const scheduledAt = nextAllowedInstant(sendAt, {
    timezone,
    quietStartHour: policy.quietStartHour,
    quietEndHour: policy.quietEndHour,
  });

  const policySnapshot: PolicySnapshotJson = {
    max_per_hour: policy.maxPerHour,
    min_interval_ms: policy.minIntervalMs,
    jitter_pct: policy.jitterPct,
    quiet_start_hour: policy.quietStartHour,
    quiet_end_hour: policy.quietEndHour,
    timezone,
    use_human_agent_tag: policy.useHumanAgentTag,
    ...(policy.commentId === undefined ? {} : { comment_id: policy.commentId }),
    ...(storedTemplateId === null
      ? {}
      : { template_language: templateLanguage, template_args: templateArgs }),
  };

  const id = crypto.randomUUID();
  const inserted = await env.DB.prepare(
    `INSERT INTO scheduled_messages
       (id, campaign_id, channel, target_type, target_id, pacing_key, to_peer, body,
        template_id, vars_json, policy_json, timezone, sim_slot, send_at, expires_at,
        status, idempotency_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'scheduled', ?, ?, ?)
     ON CONFLICT DO NOTHING`
  )
    .bind(
      id,
      campaignId,
      channel,
      targetType,
      targetId,
      pacingKey,
      peer,
      message,
      storedTemplateId,
      JSON.stringify(vars ?? {}),
      JSON.stringify(policySnapshot),
      timezone,
      simSlot,
      scheduledAt,
      idempotencyKey,
      now,
      now
    )
    .run();

  let row: ScheduledRow | null = null;
  let created = (inserted.meta?.changes ?? 0) > 0;

  if (!created) {
    if (idempotencyKey !== null) {
      row = await env.DB.prepare(
        `SELECT * FROM scheduled_messages WHERE idempotency_key = ?`
      )
        .bind(idempotencyKey)
        .first<ScheduledRow>();
    }
    if (row === null) {
      return json(
        { error: "scheduled_exists", message: "a scheduled message already has that idempotency key" },
        409
      );
    }
  } else {
    row = await env.DB.prepare(`SELECT * FROM scheduled_messages WHERE id = ?`)
      .bind(id)
      .first<ScheduledRow>();
  }

  if (row === null) {
    return json({ error: "storage_unavailable", message: "the row could not be read back" }, 500);
  }

  // The row is durable before the wake. A wake failure is a 503 the caller can
  // retry, and the cron trigger will pick the row up within five minutes.
  try {
    await env.SCHEDULER.getByName(SCHEDULER_OBJECT_NAME).wake();
  } catch {
    return json(
      {
        error: "scheduler_unavailable",
        message: "the message is stored; retry to wake the scheduler",
      },
      503
    );
  }

  if (created) {
    await writeAudit(env, {
      action: "scheduled.created",
      actor: { userId: actor.userId, label: actor.label },
      subject: id,
      detail: {
        channel,
        target_type: targetType,
        target_id: targetId,
        send_at: scheduledAt,
        campaign_id: campaignId,
        idempotent: idempotencyKey !== null,
      },
    });
  }

  return json({ scheduled: scheduledView(row) }, created ? 201 : 200);
}

/* ───────────────────────────── list ───────────────────────────── */

export async function handleScheduledList(env: Env, url: URL): Promise<Response> {
  const where: string[] = [];
  const bindings: unknown[] = [];

  const status = url.searchParams.get("status");
  if (status !== null && status !== "") {
    if (!VALID_STATUSES.has(status as ScheduledStatus)) {
      return json({ error: "bad_status", message: "status is not a known state" }, 400);
    }
    where.push("status = ?");
    bindings.push(status);
  }

  const channel = url.searchParams.get("channel");
  if (channel !== null && channel !== "") {
    where.push("channel = ?");
    bindings.push(channel);
  }

  const targetId = url.searchParams.get("target_id");
  if (targetId !== null && targetId !== "") {
    where.push("target_id = ?");
    bindings.push(targetId);
  }

  const sql = `SELECT * FROM scheduled_messages${
    where.length === 0 ? "" : ` WHERE ${where.join(" AND ")}`
  } ORDER BY send_at ASC LIMIT ${MAX_LIST_ROWS}`;

  const rows = await env.DB.prepare(sql).bind(...bindings).all<ScheduledRow>();
  return json({ scheduled: (rows.results ?? []).map(scheduledView) });
}

/* ───────────────────────────── cancel ───────────────────────────── */

export async function handleScheduledCancel(
  _req: Request,
  env: Env,
  actor: AdminActor,
  id: string
): Promise<Response> {
  const refused = schedulerWriteRefusal(actor);
  if (refused !== null) return refused;

  const result = await cancelScheduled(env.DB, id, Date.now());
  if (result.ok) {
    try {
      await env.SCHEDULER.getByName(SCHEDULER_OBJECT_NAME).wake();
    } catch {
      // The cancellation is durable and the cron trigger will re-arm. Do not
      // turn a successful cancel into a failure over a lost wake.
    }
    await writeAudit(env, {
      action: "scheduled.cancelled",
      actor: { userId: actor.userId, label: actor.label },
      subject: id,
    });
    return json({ ok: true, cancelled: true });
  }

  return json(
    {
      error: "not_cancellable",
      status: result.status,
      message: "only a row that is still scheduled can be cancelled",
    },
    409
  );
}

/* ───────────────────────────── pacing policies ───────────────────────────── */

const PACING_TARGET_TYPES = ["device", "connector"] as const;
type PacingTargetType = (typeof PACING_TARGET_TYPES)[number];

const PACING_BOUNDS = {
  minIntervalMs: [1_000, 3_600_000],
  jitterPct: [0, 50],
  maxPerHour: [1, 3_600],
  quietHour: [0, 23],
} as const;

function isPacingTargetType(value: string): value is PacingTargetType {
  return (PACING_TARGET_TYPES as readonly string[]).includes(value);
}

function requiredNumber(
  value: unknown,
  min: number,
  max: number
): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < min || value > max) return null;
  return value;
}

export async function handlePacingList(env: Env): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT id, target_type, target_id, min_interval_ms, jitter_pct, max_per_hour,
            quiet_start_hour, quiet_end_hour, timezone, updated_at
       FROM pacing_policies ORDER BY updated_at DESC LIMIT 200`
  ).all<PacingPolicyListRow>();

  return json({ policies: rows.results ?? [] });
}

export async function handlePacingUpdate(
  req: Request,
  env: Env,
  actor: AdminActor,
  targetTypeRaw: string,
  targetIdRaw: string
): Promise<Response> {
  const refused = schedulerWriteRefusal(actor);
  if (refused !== null) return refused;

  const targetType = targetTypeRaw.toLowerCase();
  if (!isPacingTargetType(targetType)) {
    return json(
      { error: "bad_target_type", message: "target_type must be device or connector" },
      400
    );
  }

  let targetId: string;
  try {
    targetId = decodeURIComponent(targetIdRaw).trim();
  } catch {
    return json({ error: "bad_target", message: "target_id is malformed" }, 400);
  }
  if (targetId === "" || targetId.length > MAX_ID_CHARS) {
    return json(
      { error: "bad_target", message: `target_id must be 1..${MAX_ID_CHARS} characters` },
      400
    );
  }

  const parsed = await readJsonBoundedResult(req, MAX_BODY_BYTES);
  if (!parsed.ok) return err(parsed.reason);
  const body = parsed.value;

  const minIntervalMs = requiredNumber(
    body.min_interval_ms,
    PACING_BOUNDS.minIntervalMs[0],
    PACING_BOUNDS.minIntervalMs[1]
  );
  if (minIntervalMs === null) {
    return json(
      {
        error: "bad_min_interval_ms",
        message: `min_interval_ms must be ${PACING_BOUNDS.minIntervalMs[0]}..${PACING_BOUNDS.minIntervalMs[1]}`,
      },
      400
    );
  }

  const jitterPct = requiredNumber(
    body.jitter_pct,
    PACING_BOUNDS.jitterPct[0],
    PACING_BOUNDS.jitterPct[1]
  );
  if (jitterPct === null) {
    return json(
      { error: "bad_jitter_pct", message: "jitter_pct must be 0..50" },
      400
    );
  }

  const maxPerHour = requiredNumber(
    body.max_per_hour,
    PACING_BOUNDS.maxPerHour[0],
    PACING_BOUNDS.maxPerHour[1]
  );
  if (maxPerHour === null) {
    return json(
      { error: "bad_max_per_hour", message: "max_per_hour must be 1..3600" },
      400
    );
  }

  const quietStartHour = requiredNumber(
    body.quiet_start_hour,
    PACING_BOUNDS.quietHour[0],
    PACING_BOUNDS.quietHour[1]
  );
  const quietEndHour = requiredNumber(
    body.quiet_end_hour,
    PACING_BOUNDS.quietHour[0],
    PACING_BOUNDS.quietHour[1]
  );
  if (quietStartHour === null || quietEndHour === null) {
    return json(
      { error: "bad_quiet_hours", message: "quiet hours must be whole hours 0..23" },
      400
    );
  }

  const timezone = nonEmptyString(body.timezone);
  if (timezone === null) {
    return json({ error: "bad_timezone", message: "timezone is required" }, 400);
  }
  try {
    nextAllowedInstant(Date.now(), {
      timezone,
      quietStartHour,
      quietEndHour,
    });
  } catch (error) {
    if (error instanceof InvalidTimezoneError) {
      return json({ error: "bad_timezone", message: "timezone is not a known IANA zone" }, 400);
    }
    throw error;
  }

  const now = Date.now();
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO pacing_policies
       (id, target_type, target_id, min_interval_ms, jitter_pct, max_per_hour,
        quiet_start_hour, quiet_end_hour, timezone, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(target_id) DO UPDATE SET
       target_type = excluded.target_type,
       min_interval_ms = excluded.min_interval_ms,
       jitter_pct = excluded.jitter_pct,
       max_per_hour = excluded.max_per_hour,
       quiet_start_hour = excluded.quiet_start_hour,
       quiet_end_hour = excluded.quiet_end_hour,
       timezone = excluded.timezone,
       updated_at = excluded.updated_at`
  )
    .bind(
      id,
      targetType,
      targetId,
      minIntervalMs,
      jitterPct,
      maxPerHour,
      quietStartHour,
      quietEndHour,
      timezone,
      now
    )
    .run();

  const policy = await env.DB.prepare(
    `SELECT id, target_type, target_id, min_interval_ms, jitter_pct, max_per_hour,
            quiet_start_hour, quiet_end_hour, timezone, updated_at
       FROM pacing_policies WHERE target_type = ? AND target_id = ?`
  )
    .bind(targetType, targetId)
    .first<PacingPolicyListRow>();
  if (policy === null) {
    return json(
      { error: "storage_unavailable", message: "the policy could not be read back" },
      500
    );
  }

  await writeAudit(env, {
    action: "pacing_policy.updated",
    actor: { userId: actor.userId, label: actor.label },
    subject: `${targetType}:${targetId}`,
    detail: {
      target_type: targetType,
      target_id: targetId,
      min_interval_ms: minIntervalMs,
      jitter_pct: jitterPct,
      max_per_hour: maxPerHour,
      quiet_start_hour: quietStartHour,
      quiet_end_hour: quietEndHour,
      timezone,
    },
  });

  return json({ policy });
}

