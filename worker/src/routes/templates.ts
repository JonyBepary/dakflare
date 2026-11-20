/**
 * Message templates and the audience list.
 *
 * Templates are operator records: a body with `{{name}}` tokens, a channel it is
 * meant for, and (optionally) the matching WhatsApp Cloud template name and
 * language. Rendering and segment accounting are pure and live in
 * `lib/templates.ts`; this file only persists and validates.
 *
 * The audience list is deliberately separate from `contact_identities`: an
 * audience row is a recipient the operator chose to message, not a peer that
 * arrived on a channel.
 *
 * Two guards, matching `routes/channel-connectors.ts`:
 *
 *  - reads (list, preview, contacts) use `assertHuman`, which admits a member
 *    session and the machine credential and refuses an agent token or a webhook
 *    turn;
 *  - writes (create, delete, import) additionally refuse a member, because
 *    changing what the fleet sends is an owner/admin act.
 *
 * Audit detail carries ids, names, channels and counts. It never carries a
 * template body, a peer or a phone number.
 */

import type { Env } from "../index";
import type { AdminActor } from "../audit";
import { writeAudit } from "../audit";
import { assertHuman } from "../lib/authority";
import { err } from "../lib/errors";
import { readBodyBounded, readJsonBoundedResult } from "../lib/body";
import { MAX_BODY_BYTES } from "../lib/config";
import {
  countSmsSegments,
  extractTemplateVariables,
  parseCsvRecords,
  renderTemplate,
} from "../lib/templates";
import {
  InvalidTimezoneError,
  nextAllowedInstant,
  normalisePeer,
} from "../lib/scheduled";

/** An admin create body is configuration, not an upload. */
const MAX_TEMPLATE_BODY_BYTES = 64 * 1024;

const MAX_NAME_CHARS = 64;
const MAX_TEMPLATE_BODY_CHARS = 4096;

const TEMPLATE_CHANNELS = [
  "any",
  "sms",
  "whatsapp",
  "telegram",
  "messenger",
  "instagram",
] as const;
type TemplateChannel = (typeof TEMPLATE_CHANNELS)[number];

const CONTACT_CHANNELS = [
  "sms",
  "whatsapp",
  "telegram",
  "messenger",
  "instagram",
] as const;
type ContactChannel = (typeof CONTACT_CHANNELS)[number];

/** 50 rows per `env.DB.batch()`, well below D1's per-batch statement ceiling. */
const IMPORT_CHUNK_ROWS = 50;

interface TemplateRow {
  id: string;
  name: string;
  channel: string;
  body: string;
  variables_json: string;
  wa_template_name: string | null;
  wa_language: string | null;
  created_at: number;
  updated_at: number;
}

interface ContactRow {
  id: string;
  channel: string;
  peer: string;
  name: string | null;
  attrs_json: string;
  tags_json: string;
  timezone: string;
  opt_out: number;
  created_at: number;
  updated_at: number;
}

/* ───────────────────────────── helpers ───────────────────────────── */

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The read guard: any human session (member included) and the machine actor. */
function readRefusal(actor: AdminActor): Response | null {
  const human = assertHuman(actor);
  return human.ok ? null : human.response;
}

/** The write guard: `assertHuman`, plus the member refusal connector admin uses. */
function writeRefusal(actor: AdminActor): Response | null {
  const human = assertHuman(actor);
  if (!human.ok) return human.response;
  if (actor.role === "member") {
    return Response.json(
      {
        error: "permission",
        message: "templates and the audience list are managed by owners and admins",
      },
      { status: 403 }
    );
  }
  return null;
}

function stringField(body: Record<string, unknown>, name: string): string | null {
  const value = body[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function isTemplateChannel(value: string): value is TemplateChannel {
  return (TEMPLATE_CHANNELS as readonly string[]).includes(value);
}

function isContactChannel(value: string): value is ContactChannel {
  return (CONTACT_CHANNELS as readonly string[]).includes(value);
}

function parseStringArray(text: string): string[] {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === "string");
  } catch {
    return [];
  }
}

function parseObject(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function templateView(row: TemplateRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    channel: row.channel,
    body: row.body,
    variables: parseStringArray(row.variables_json),
    wa_template_name: row.wa_template_name,
    wa_language: row.wa_language,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function contactView(row: ContactRow): Record<string, unknown> {
  return {
    id: row.id,
    channel: row.channel,
    peer: row.peer,
    name: row.name,
    attrs: parseObject(row.attrs_json),
    tags: parseStringArray(row.tags_json),
    timezone: row.timezone,
    opt_out: row.opt_out === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** A bounded positive integer from a query string, clamped to `[min, max]`. */
function queryInteger(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/* ───────────────────────────── templates ───────────────────────────── */

export async function handleTemplateList(env: Env, actor: AdminActor): Promise<Response> {
  const refused = readRefusal(actor);
  if (refused !== null) return refused;

  const rows = await env.DB.prepare(
    `SELECT id, name, channel, body, variables_json, wa_template_name, wa_language,
            created_at, updated_at
       FROM message_templates ORDER BY created_at DESC LIMIT 200`
  ).all<TemplateRow>();

  return json({ templates: (rows.results ?? []).map(templateView) });
}

export async function handleTemplateCreate(
  req: Request,
  env: Env,
  actor: AdminActor
): Promise<Response> {
  const refused = writeRefusal(actor);
  if (refused !== null) return refused;

  const body = await readJsonObject(req);
  if (body === null) return err("bad_request", 400);

  const name = stringField(body, "name") ?? "";
  if (name === "" || name.length > MAX_NAME_CHARS) {
    return json(
      { error: "bad_request", message: `name must be 1..${MAX_NAME_CHARS} characters` },
      400
    );
  }

  const message = typeof body["body"] === "string" ? body["body"] : "";
  if (message === "" || message.length > MAX_TEMPLATE_BODY_CHARS) {
    return json(
      {
        error: "bad_request",
        message: `body must be 1..${MAX_TEMPLATE_BODY_CHARS} characters`,
      },
      400
    );
  }

  const channelRaw = (stringField(body, "channel") ?? "any").toLowerCase();
  if (!isTemplateChannel(channelRaw)) {
    return json(
      { error: "bad_request", message: "channel is not supported" },
      400
    );
  }
  const channel: TemplateChannel = channelRaw;

  const waTemplateName = stringField(body, "wa_template_name");
  const waLanguage = stringField(body, "wa_language") ?? "en_US";
  const variables = extractTemplateVariables(message);

  const now = Date.now();
  const id = randomId("tpl");
  const variablesJson = JSON.stringify(variables);

  try {
    await env.DB.prepare(
      `INSERT INTO message_templates
         (id, name, channel, body, variables_json, wa_template_name, wa_language,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        id,
        name,
        channel,
        message,
        variablesJson,
        waTemplateName,
        waLanguage,
        now,
        now
      )
      .run();
  } catch (error) {
    if (String(error).toUpperCase().includes("UNIQUE")) {
      return json(
        {
          error: "template_name_taken",
          message: "a template with that name already exists",
        },
        409
      );
    }
    throw error;
  }

  await writeAudit(env, {
    action: "template.created",
    actor: { userId: actor.userId, label: actor.label },
    subject: id,
    detail: { id, name, channel },
  });

  const row: TemplateRow = {
    id,
    name,
    channel,
    body: message,
    variables_json: variablesJson,
    wa_template_name: waTemplateName,
    wa_language: waLanguage,
    created_at: now,
    updated_at: now,
  };

  return json({ template: templateView(row), variables }, 201);
}

export async function handleTemplateDelete(
  env: Env,
  actor: AdminActor,
  id: string
): Promise<Response> {
  const refused = writeRefusal(actor);
  if (refused !== null) return refused;

  const row = await env.DB.prepare(
    `SELECT id, name, channel FROM message_templates WHERE id = ?`
  )
    .bind(id)
    .first<Pick<TemplateRow, "id" | "name" | "channel">>();
  if (row === null) return json({ error: "not_found" }, 404);

  await env.DB.prepare(`DELETE FROM message_templates WHERE id = ?`).bind(id).run();

  await writeAudit(env, {
    action: "template.deleted",
    actor: { userId: actor.userId, label: actor.label },
    subject: id,
    detail: { id, name: row.name, channel: row.channel },
  });

  return json({ ok: true, id });
}

export async function handleTemplatePreview(
  req: Request,
  env: Env,
  actor: AdminActor,
  id: string
): Promise<Response> {
  const refused = readRefusal(actor);
  if (refused !== null) return refused;

  const body = await readJsonObject(req);
  if (body === null) return err("bad_request", 400);

  const row = await env.DB.prepare(
    `SELECT body FROM message_templates WHERE id = ?`
  )
    .bind(id)
    .first<Pick<TemplateRow, "body">>();
  if (row === null) return json({ error: "not_found" }, 404);

  const vars: Record<string, string | number> = {};
  const rawVars = body["vars"];
  if (rawVars !== undefined && rawVars !== null) {
    if (!isRecord(rawVars)) {
      return json({ error: "bad_request", message: "vars must be an object" }, 400);
    }
    for (const [key, value] of Object.entries(rawVars)) {
      if (typeof value === "string") vars[key] = value;
      else if (typeof value === "number" && Number.isFinite(value)) vars[key] = value;
    }
  }

  const rendered = renderTemplate(row.body, vars);
  const segments = countSmsSegments(rendered.rendered);

  return json({
    rendered: rendered.rendered,
    missing: rendered.missing,
    used: rendered.used,
    segments,
  });
}

async function readJsonObject(req: Request): Promise<Record<string, unknown> | null> {
  const bounded = await readBodyBounded(req, MAX_TEMPLATE_BODY_BYTES);
  if (!bounded.ok) return null;
  if (bounded.text.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(bounded.text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/* ───────────────────────────── contacts ───────────────────────────── */

export async function handleContactsList(
  env: Env,
  url: URL,
  actor: AdminActor
): Promise<Response> {
  const refused = readRefusal(actor);
  if (refused !== null) return refused;

  const channel = url.searchParams.get("channel");
  const optOutRaw = url.searchParams.get("opt_out");
  const limit = queryInteger(url.searchParams.get("limit"), 100, 1, 200);
  const offset = queryInteger(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);

  const filters: string[] = [];
  const params: unknown[] = [];
  if (channel !== null && channel !== "") {
    filters.push("channel = ?");
    params.push(channel);
  }
  if (optOutRaw === "0" || optOutRaw === "1") {
    filters.push("opt_out = ?");
    params.push(Number(optOutRaw));
  }
  const where = filters.length > 0 ? `WHERE ${filters.join(" AND ")}` : "";

  const list = await env.DB.prepare(
    `SELECT id, channel, peer, name, attrs_json, tags_json, timezone, opt_out,
            created_at, updated_at
       FROM contacts ${where}
      ORDER BY created_at DESC LIMIT ? OFFSET ?`
  )
    .bind(...params, limit, offset)
    .all<ContactRow>();

  // The summary deliberately ignores the opt_out filter so the console can say
  // "N of M opted out" while showing only one side of that split.
  const summaryParams: unknown[] = [];
  let summaryWhere = "";
  if (channel !== null && channel !== "") {
    summaryWhere = "WHERE channel = ?";
    summaryParams.push(channel);
  }
  const summary = await env.DB.prepare(
    `SELECT COUNT(*) AS total, COALESCE(SUM(opt_out), 0) AS opted_out
       FROM contacts ${summaryWhere}`
  )
    .bind(...summaryParams)
    .first<{ total: number; opted_out: number }>();

  return json({
    contacts: (list.results ?? []).map(contactView),
    total: summary?.total ?? 0,
    opted_out: summary?.opted_out ?? 0,
  });
}

interface ImportRecord {
  channel: string;
  peer: string;
  name: string | null;
  timezone: string;
  opt_out: number;
  tags: string[];
  attrs: Record<string, string>;
}

const CONTACT_RESERVED_COLUMNS = new Set([
  "peer",
  "phone",
  "name",
  "timezone",
  "opt_out",
  "tags",
  "channel",
]);

function importString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}

/** `true`/`"1"`/`"true"` is an opt-out; everything else is not. */
function importOptOut(value: unknown): number {
  if (value === true || value === 1) return 1;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "1" || normalized === "true" ? 1 : 0;
  }
  return 0;
}

function importTags(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => importString(item))
      .filter((item): item is string => item !== null && item.trim() !== "")
      .map((item) => item.trim());
  }
  if (typeof value === "string") {
    return value
      .split(/[;,]/)
      .map((item) => item.trim())
      .filter((item) => item !== "");
  }
  return [];
}

function validTimezone(value: string): string {
  try {
    // Equal start and end hours switch the quiet window off, so this only asks
    // whether the runtime knows the zone. An unknown zone throws.
    nextAllowedInstant(Date.now(), {
      timezone: value,
      quietStartHour: 0,
      quietEndHour: 0,
    });
    return value;
  } catch (error) {
    if (error instanceof InvalidTimezoneError) return "UTC";
    return "UTC";
  }
}

/**
 * Fold one CSV or JSON record into an import shape, or null when it has no
 * usable peer. The caller counts a null as `skipped`.
 */
function normalizeImportRecord(record: Record<string, unknown>): ImportRecord | null {
  const channelRaw = importString(record["channel"]);
  const channel = (channelRaw ?? "sms").trim().toLowerCase() || "sms";
  if (!isContactChannel(channel)) return null;

  const peerRaw = importString(record["peer"]) ?? importString(record["phone"]);
  if (peerRaw === null || peerRaw.trim() === "") return null;
  const peer = normalisePeer(channel, peerRaw);
  if (peer === null) return null;

  const nameRaw = importString(record["name"]);
  const name = nameRaw !== null && nameRaw.trim() !== "" ? nameRaw.trim() : null;

  const timezoneRaw = importString(record["timezone"]);
  const timezone = validTimezone(timezoneRaw?.trim() || "UTC");

  const attrs: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    if (CONTACT_RESERVED_COLUMNS.has(key)) continue;
    if (value === null || value === undefined) continue;
    const asString = importString(value);
    if (asString !== null) attrs[key] = asString;
  }

  return {
    channel,
    peer,
    name,
    timezone,
    opt_out: importOptOut(record["opt_out"]),
    tags: importTags(record["tags"]),
    attrs,
  };
}

export async function handleContactsImport(
  req: Request,
  env: Env,
  actor: AdminActor
): Promise<Response> {
  const refused = writeRefusal(actor);
  if (refused !== null) return refused;

  const contentType = (req.headers.get("content-type") ?? "").toLowerCase();
  let rawRecords: Record<string, unknown>[] = [];

  if (contentType.startsWith("text/csv")) {
    const bounded = await readBodyBounded(req, MAX_BODY_BYTES);
    if (!bounded.ok) return err("payload_too_large", 413);
    rawRecords = parseCsvRecords(bounded.text);
  } else {
    const parsed = await readJsonBoundedResult(req, MAX_BODY_BYTES);
    if (!parsed.ok) return err(parsed.reason);
    const contacts = parsed.value["contacts"];
    if (!Array.isArray(contacts)) {
      return json(
        { error: "bad_request", message: "contacts must be an array" },
        400
      );
    }
    rawRecords = contacts.filter(isRecord);
  }

  if (rawRecords.length === 0) {
    return json({ error: "bad_request", message: "no contacts to import" }, 400);
  }

  const now = Date.now();
  const rows: ImportRecord[] = [];
  let skipped = 0;
  for (const raw of rawRecords) {
    const normalized = normalizeImportRecord(raw);
    if (normalized === null) {
      skipped += 1;
      continue;
    }
    rows.push(normalized);
  }

  for (let start = 0; start < rows.length; start += IMPORT_CHUNK_ROWS) {
    const chunk = rows.slice(start, start + IMPORT_CHUNK_ROWS);
    const statements = chunk.map((row) =>
      env.DB.prepare(
        `INSERT INTO contacts
           (id, channel, peer, name, attrs_json, tags_json, timezone, opt_out,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(channel, peer) DO UPDATE SET
           name = COALESCE(excluded.name, contacts.name),
           attrs_json = excluded.attrs_json,
           tags_json = excluded.tags_json,
           timezone = excluded.timezone,
           opt_out = excluded.opt_out,
           updated_at = excluded.updated_at`
      ).bind(
        randomId("ct"),
        row.channel,
        row.peer,
        row.name,
        JSON.stringify(row.attrs),
        JSON.stringify(row.tags),
        row.timezone,
        row.opt_out,
        now,
        now
      )
    );
    await env.DB.batch(statements);
  }

  await writeAudit(env, {
    action: "contacts.imported",
    actor: { userId: actor.userId, label: actor.label },
    detail: { imported: rows.length, skipped },
  });

  return json({ ok: true, imported: rows.length, skipped });
}
