/**
 * Agent analysis routes (v7.1 WS4/WS6) — triage, telemetry, diagnose, synthesize.
 *
 * Four endpoints, three of them READ-ONLY by construction:
 *
 *   POST /v1/agent/triage      classify an inbound message and its spans
 *   POST /v1/agent/telemetry   map an operator question to ONE bounded query
 *   POST /v1/agent/diagnose    reduce a failure to a RootCauseCard
 *   POST /v1/agent/synthesize  judge a candidate patch and mint an apply token
 *
 * Nothing here writes a message, sends an SMS or applies a patch. `synthesize`
 * mints a target for the EXISTING approval/authority route to spend; it does not
 * spend it. That keeps the "who may actually change production" answer in one
 * place (`lib/authority.ts` + `routes/approvals.ts`) rather than in a new route
 * that happens to have the word agent in its name.
 *
 * Two properties are load-bearing:
 *
 *   1. A model never becomes the source of truth. `triage` falls back to the
 *      deterministic `balance >= principal` invariant and reports
 *      `source:"unavailable"`; `telemetry` validates the model's choice against an
 *      allowlist and answers 400 for anything else; `diagnose` is JS-only.
 *   2. No SQL text is ever built from the request. `telemetry` interpolates the
 *      PLAN NAME into a lookup table, never the question; each statement is a
 *      constant string with bound parameters.
 */

import { z } from "zod";

import type { Env } from "../index";
import { err } from "../lib/errors";
import { readJsonBoundedResult } from "../lib/body";
import { canonicalTargetJson, type GrantTarget } from "../lib/authority";
import {
  ask,
  defaultModel,
  judgeCandidatePatch,
  triageInboundAndSpans,
  type Answer,
  type System1Env,
} from "../lib/system1";

/** 8 KiB: these are questions and one message, not a batch upload. */
const AGENT_BODY_BYTES = 8 * 1024;

/** Rows a telemetry answer may return in total. */
const MAX_TELEMETRY_ROWS = 50;

/** Per-statement cap, so two-statement plans still fit inside the total. */
const PER_QUERY_LIMIT = 25;

/** A `noul` at or above this means a human must approve before apply. */
const APPROVAL_NOUL_MIN = 0.7;

/* ─────────────────────────────── shared ─────────────────────────────── */

/** Structured, body-free log line. Never a message body, token or phone number. */
function logAgent(event: string, fields: Record<string, string | number | boolean | null>): void {
  try {
    console.log(`[agent.${event}] ${JSON.stringify(fields)}`);
  } catch {
    // Logging must never fail the request.
  }
}

type Validated<T> = { ok: true; data: T } | { ok: false; response: Response };

/** Bounded body, then zod. The too-large and malformed cases stay distinct. */
async function readValidated<T>(req: Request, schema: z.ZodType<T>): Promise<Validated<T>> {
  const parsed = await readJsonBoundedResult(req, AGENT_BODY_BYTES);
  if (!parsed.ok) return { ok: false, response: err(parsed.reason) };
  const result = schema.safeParse(parsed.value);
  if (!result.success) {
    return {
      ok: false,
      response: Response.json(
        { error: "bad_request", message: result.error.issues[0]?.message ?? "invalid body" },
        { status: 400 }
      ),
    };
  }
  return { ok: true, data: result.data };
}

/** The System1 binding surface, without leaking `Ai`'s overloads into routes. */
export function system1Env(env: Env): System1Env {
  const {
    SYSTEM1_DEFAULT_MODEL,
    SYSTEM1_PROVIDER,
    TYPESAFE_BASE_URL,
    TYPESAFE_API_KEY,
    TOKENLAB_BASE_URL,
    TOKENLAB_API_KEY,
    TOKENLAB_SYSTEM1_MODEL,
  } = env as {
    SYSTEM1_DEFAULT_MODEL?: string;
    SYSTEM1_PROVIDER?: string;
    TYPESAFE_BASE_URL?: string;
    TYPESAFE_API_KEY?: string;
    TOKENLAB_BASE_URL?: string;
    TOKENLAB_API_KEY?: string;
    TOKENLAB_SYSTEM1_MODEL?: string;
  };
  return {
    AI: env.AI,
    ...(typeof SYSTEM1_DEFAULT_MODEL === "string" ? { SYSTEM1_DEFAULT_MODEL } : {}),
    ...(typeof SYSTEM1_PROVIDER === "string" ? { SYSTEM1_PROVIDER } : {}),
    // Jev is opt-in: both values must be present or ask() reports
    // provider_unavailable rather than falling back to Clef.
    ...(typeof TYPESAFE_BASE_URL === "string" && TYPESAFE_BASE_URL.trim()
      ? { TYPESAFE_BASE_URL }
      : {}),
    ...(typeof TYPESAFE_API_KEY === "string" && TYPESAFE_API_KEY.trim()
      ? { TYPESAFE_API_KEY }
      : {}),
    // Token Lab is selected by SYSTEM1_PROVIDER and needs its own credentials.
    // The base URL is passed even when empty: empty is a configuration gap the
    // adapter reports, not a licence to substitute the documented default.
    ...(typeof TOKENLAB_BASE_URL === "string" ? { TOKENLAB_BASE_URL } : {}),
    ...(typeof TOKENLAB_API_KEY === "string" && TOKENLAB_API_KEY.trim()
      ? { TOKENLAB_API_KEY }
      : {}),
    ...(typeof TOKENLAB_SYSTEM1_MODEL === "string" && TOKENLAB_SYSTEM1_MODEL.trim()
      ? { TOKENLAB_SYSTEM1_MODEL }
      : {}),
  };
}

function describeChoice(answer: Answer | undefined): {
  choice: string;
  probability: number;
  confidence: number;
} | null {
  if (!answer || answer.type !== "choice" || typeof answer.choice !== "string") return null;
  return {
    choice: answer.choice,
    probability: answer.probability,
    confidence: answer.confidence,
  };
}

/* ─────────────────────────────── 1. triage ─────────────────────────────── */

const TriageBody = z.object({
  message: z.string().min(1).max(4_096),
  sender: z.string().min(1).max(64),
  spans: z
    .array(
      z.object({
        index: z.number().int().min(0).max(10_000),
        text: z.string().min(1).max(512),
      })
    )
    .max(20)
    .optional(),
});

/**
 * `POST /v1/agent/triage`
 *
 * One Clef batch: intent (choice), prompt injection (noul), template specificity
 * (score) and one role question per span. The invariant is computed here, never
 * asked of a model, so the anti-spoof answer survives an AI outage.
 */
export async function handleAgentTriage(req: Request, env: Env): Promise<Response> {
  const parsed = await readValidated(req, TriageBody);
  if (!parsed.ok) return parsed.response;
  const { message, sender, spans } = parsed.data;

  const triage = await triageInboundAndSpans(
    system1Env(env),
    message,
    sender,
    spans ?? []
  );

  // `ok` is true only when at least one answer came back. A partial batch keeps
  // the answers it did get; a total failure reports `unavailable` rather than an
  // invented classification.
  const source = triage.ok ? "workers-ai" : "unavailable";

  logAgent("triage", {
    source,
    roles: triage.roles.length,
    reason: triage.reason ?? null,
  });

  return Response.json({
    intent: describeChoice(triage.intent),
    injection:
      triage.injection && triage.injection.type === "noul"
        ? { probability: triage.injection.probability }
        : null,
    specificity:
      triage.specificity && triage.specificity.type === "score"
        ? { score: triage.specificity.score ?? null }
        : null,
    roles: triage.roles.map((role) => ({
      index: role.index,
      role: role.role,
      probability: role.probability,
    })),
    invariant: { balanceAtLeastPrincipal: triage.invariant.balanceAtLeastPrincipal },
    source,
  });
}

/* ────────────────────────────── 2. telemetry ────────────────────────────── */

export const TELEMETRY_PLANS = [
  "fleet_health",
  "stuck_outbox",
  "sim_signal_ranking",
  "workflow_failures",
  "authority_audit",
  "unmatched_drift",
] as const;

export type TelemetryPlan = (typeof TELEMETRY_PLANS)[number];

const PLAN_SET: ReadonlySet<string> = new Set(TELEMETRY_PLANS);

const TelemetryBody = z.object({
  question: z.string().min(1).max(500),
});

/** The criteria the model chooses between. Keys are the plan names, verbatim. */
const PLAN_CRITERIA: Record<TelemetryPlan, string> = {
  fleet_health: "Whether handsets are online, and which alerts are open",
  stuck_outbox: "Outbound messages that have not reached a terminal state",
  sim_signal_ranking: "SIM slots and carriers ranked by radio state or failures",
  workflow_failures: "Flow runs that ended in error or halted",
  authority_audit: "Authority grants and pending approval requests",
  unmatched_drift: "Extraction misses, where a pattern stopped matching",
};

/**
 * Deterministic fallback when no model is available.
 *
 * This is deliberately a SMALL, ordered list: first match wins, and an unmatched
 * question is a 400 rather than a guess. It exists so the endpoint is usable in
 * local dev and during an AI outage, not so it can replace the model.
 */
const PLAN_KEYWORDS: ReadonlyArray<{ plan: TelemetryPlan; pattern: RegExp }> = [
  { plan: "stuck_outbox", pattern: /outbox|backlog|stuck|\bqueue\b|not (?:been )?(?:sent|delivered|acked)/i },
  { plan: "sim_signal_ranking", pattern: /\bsims?\b|signal|carrier|radio|reception|fails?/i },
  { plan: "workflow_failures", pattern: /workflow|flow run|flow.*(?:fail|error|halt)/i },
  { plan: "authority_audit", pattern: /authorit|grants?|approvals?\b/i },
  { plan: "unmatched_drift", pattern: /drift|unmatched|extract[^ ]* miss|pattern.*(?:stop|miss)/i },
  { plan: "fleet_health", pattern: /fleet|devices?.*(?:up|down|online|offline|health)|how many devices/i },
];

/**
 * One batch, bounded statements, no user SQL.
 *
 * `now` is a parameter, not `Date.now()` inside SQL, so the plan is a pure
 * function of its arguments and the answer can be replayed.
 */
const PLAN_QUERIES: Record<
  TelemetryPlan,
  (env: Env, now: number) => Array<{ group: string; stmt: D1PreparedStatement }>
> = {
  fleet_health: (env) => [
    {
      group: "devices",
      stmt: env.DB.prepare(
        `SELECT device_id, label, last_seen, sim_slot FROM devices
          WHERE archived_at IS NULL AND revoked_at IS NULL
          ORDER BY last_seen ASC LIMIT ${PER_QUERY_LIMIT}`
      ),
    },
    {
      group: "alerts",
      stmt: env.DB.prepare(
        `SELECT device_id, kind, raised_at FROM alerts
          WHERE resolved_at IS NULL
          ORDER BY raised_at ASC LIMIT ${PER_QUERY_LIMIT}`
      ),
    },
  ],
  // There is no `outbox` table in this schema. The closest honest analogue is an
  // outbound `messages` row whose reply/command state never became terminal, so
  // that is what this reads, and the group name says so.
  stuck_outbox: (env, now) => [
    {
      group: "outbound_not_terminal",
      stmt: env.DB
        .prepare(
          `SELECT id, device_id, peer, reply_state, reply_command_id, received_at
             FROM messages
            WHERE direction = 'out'
              AND (reply_state IS NULL OR reply_state NOT IN ('DELIVERED', 'FAILED', 'EXPIRED'))
              AND received_at < ?
            ORDER BY received_at ASC LIMIT ${MAX_TELEMETRY_ROWS}`
        )
        .bind(now - 5 * 60_000),
    },
  ],
  sim_signal_ranking: (env) => [
    {
      group: "sims",
      stmt: env.DB.prepare(
        `SELECT device_id, sim_slot, carrier_name, radio_state, consecutive_fails,
                sent_current_hour, max_per_hour, updated_at
           FROM device_sims
          ORDER BY consecutive_fails DESC, sent_current_hour DESC
          LIMIT ${MAX_TELEMETRY_ROWS}`
      ),
    },
  ],
  workflow_failures: (env, now) => [
    {
      group: "failed_runs",
      stmt: env.DB
        .prepare(
          `SELECT device_id, local_id, flow_id, flow_version, outcome, created_at
             FROM flow_runs
            WHERE outcome IN ('error', 'halted') AND created_at > ?
            ORDER BY created_at DESC LIMIT ${MAX_TELEMETRY_ROWS}`
        )
        .bind(now - 24 * 60 * 60_000),
    },
  ],
  authority_audit: (env) => [
    {
      group: "grants",
      stmt: env.DB.prepare(
        `SELECT id, scope, granted_by, granted_at, expires_at, revoked_at, use_count
           FROM authority_grants
          ORDER BY granted_at DESC LIMIT ${PER_QUERY_LIMIT}`
      ),
    },
    {
      group: "pending_approvals",
      stmt: env.DB.prepare(
        `SELECT id, scope, state, requested_at, expires_at
           FROM approval_requests
          WHERE state = 'PENDING'
          ORDER BY requested_at DESC LIMIT ${PER_QUERY_LIMIT}`
      ),
    },
  ],
  unmatched_drift: (env) => [
    {
      group: "extract_misses",
      // `body_preview` is deliberately NOT selected: a telemetry answer is
      // counts-shaped, and a preview is still a piece of someone's message.
      stmt: env.DB.prepare(
        `SELECT id, device_id, flow_id, field, at FROM extract_misses
          ORDER BY at DESC LIMIT ${MAX_TELEMETRY_ROWS}`
      ),
    },
  ],
};

/** Ask the model, then fall back to keywords. `null` means "not a plan". */
async function resolvePlan(env: Env, question: string): Promise<TelemetryPlan | null> {
  const result = await ask(
    system1Env(env),
    { question: question.slice(0, 500) },
    {
      plan: {
        type: "choice",
        instructions:
          "Route this operator question to the one bounded telemetry query that answers it. Choose the single best plan.",
        criteria: PLAN_CRITERIA,
      },
    },
    defaultModel(system1Env(env))
  );

  const choice = result.answers.plan?.choice;
  if (typeof choice === "string" && PLAN_SET.has(choice)) return choice as TelemetryPlan;

  for (const entry of PLAN_KEYWORDS) {
    if (entry.pattern.test(question)) return entry.plan;
  }
  return null;
}

/**
 * `POST /v1/agent/telemetry`
 *
 * The question is DATA. It is never concatenated into SQL: the plan name selects
 * a constant builder, and every value is bound. Rows are capped at 50 and the
 * handler does one D1 batch, so the work is bounded by construction rather than
 * by a timeout this runtime cannot preempt.
 */
export async function handleAgentTelemetry(req: Request, env: Env): Promise<Response> {
  const started = Date.now();
  const parsed = await readValidated(req, TelemetryBody);
  if (!parsed.ok) return parsed.response;

  const plan = await resolvePlan(env, parsed.data.question);
  if (plan === null || !PLAN_SET.has(plan)) {
    logAgent("telemetry.rejected", { reason: "unknown_plan" });
    return Response.json(
      {
        error: "bad_request",
        message: "question does not map to a known telemetry plan",
        plans: [...TELEMETRY_PLANS],
      },
      { status: 400 }
    );
  }

  const now = Date.now();
  const queries = PLAN_QUERIES[plan](env, now);

  let results: D1Result<Record<string, unknown>>[];
  try {
    results = await env.DB.batch<Record<string, unknown>>(queries.map((entry) => entry.stmt));
  } catch (error) {
    console.error(`[agent.telemetry] query failed for ${plan}: ${String(error).slice(0, 200)}`);
    return err("storage_unavailable", 503);
  }

  const rows: Array<Record<string, unknown>> = [];
  let hitCap = false;
  results.forEach((result, position) => {
    const group = queries[position]?.group ?? "rows";
    const page = result.results ?? [];
    if (page.length >= PER_QUERY_LIMIT) hitCap = true;
    for (const row of page) {
      if (rows.length >= MAX_TELEMETRY_ROWS) {
        hitCap = true;
        break;
      }
      rows.push({ group, ...row });
    }
  });

  const tookMs = Date.now() - started;
  logAgent("telemetry", {
    plan,
    rows: rows.length,
    truncated: hitCap,
    took_ms: tookMs,
  });

  return Response.json({
    plan,
    rows,
    truncated: hitCap,
    took_ms: tookMs,
  });
}

/* ─────────────────────────────── 3. diagnose ─────────────────────────────── */

export type RootCauseCode =
  | "ERR_UNICODE_ZERO_WIDTH_UCS2"
  | "ERR_MULTIWORD_REF_MISMATCH"
  | "ERR_AUTHORITY_GUARD_EXPIRED_OR_HASH_MISMATCH"
  | "ERR_APPROVAL_GATE_409_NOT_PENDING"
  | "ERR_FAKE_SMS_SPOOF_QUARANTINE"
  | "ERR_DOWNSTREAM_WEBHOOK_502";

export interface RootCauseCard {
  /** `null` means: every signature was checked and none matched. */
  code: RootCauseCode | null;
  summary: string;
  offset?: { byte: number; char: number };
  highlight?: { before: string; bad: string; after: string };
  encoding: "gsm7" | "ucs2";
  segments: number;
  fix?: { kind: "pattern_patch"; pattern: string };
}

const DiagnoseBody = z
  .object({
    message_id: z.string().min(1).max(128).optional(),
    flow_run_id: z.string().min(1).max(128).optional(),
    message: z.string().min(1).max(4_096).optional(),
    pattern: z.string().min(1).max(512).optional(),
  })
  .refine(
    (value) =>
      value.message !== undefined ||
      value.message_id !== undefined ||
      value.flow_run_id !== undefined,
    { message: "one of message, message_id or flow_run_id is required" }
  );

/**
 * Characters that render as nothing and force UCS-2.
 *
 * Every one of these costs 2 bytes in UCS-2 and is invisible to the operator
 * reading the template. They are the mechanism behind a "160-character" message
 * that bills as three segments.
 */
const INVISIBLE_CODEPOINTS: ReadonlySet<number> = new Set<number>([
  0x00ad, // soft hyphen
  0x061c, // arabic letter mark
  0x180e, // mongolian vowel separator
  0x200b, // zero width space
  0x200c, // zero width non-joiner
  0x200d, // zero width joiner
  0x200e, // left-to-right mark
  0x200f, // right-to-left mark
  0x202a, 0x202b, 0x202c, 0x202d, 0x202e, // bidi embeddings/overrides
  0x2060, 0x2061, 0x2062, 0x2063, 0x2064, // word joiner and invisible operators
  0x2066, 0x2067, 0x2068, 0x2069, // bidi isolates
  0xfeff, // zero width no-break space / BOM
  0xfff9, 0xfffa, 0xfffb, // interlinear annotation
]);

const GSM7_BASIC_CHARS =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM7_BASIC: ReadonlySet<string> = new Set(GSM7_BASIC_CHARS);
const GSM7_EXTENSION: ReadonlySet<string> = new Set([
  "\f",
  "^",
  "{",
  "}",
  "\\",
  "[",
  "~",
  "]",
  "|",
  "€",
]);

/** Septets needed by a GSM-7 message, or `null` if a character is outside it. */
function gsm7Septets(text: string): number | null {
  let count = 0;
  for (const char of text) {
    if (GSM7_BASIC.has(char)) count += 1;
    else if (GSM7_EXTENSION.has(char)) count += 2;
    else return null;
  }
  return count;
}

/** UTF-16 units needed by a UCS-2 message; a non-BMP code point is two. */
function ucs2Units(text: string): number {
  let count = 0;
  for (const char of text) {
    count += (char.codePointAt(0) ?? 0) > 0xffff ? 2 : 1;
  }
  return count;
}

/** Encoding and segment count, using the 160/153 and 70/67 split. */
export function segmentText(text: string): { encoding: "gsm7" | "ucs2"; segments: number } {
  if (text.length === 0) return { encoding: "gsm7", segments: 0 };
  const septets = gsm7Septets(text);
  if (septets !== null) {
    return { encoding: "gsm7", segments: septets <= 160 ? 1 : Math.ceil(septets / 153) };
  }
  const units = ucs2Units(text);
  return { encoding: "ucs2", segments: units <= 70 ? 1 : Math.ceil(units / 67) };
}

/** First invisible character: its UTF-16 index and code point. */
function firstInvisible(text: string): { char: number; codepoint: number } | null {
  let char = 0;
  for (const value of text) {
    const codepoint = value.codePointAt(0) ?? 0;
    if (INVISIBLE_CODEPOINTS.has(codepoint)) return { char, codepoint };
    char += value.length;
  }
  return null;
}

function escapeCodepoint(codepoint: number): string {
  return `<U+${codepoint.toString(16).toUpperCase().padStart(4, "0")}>`;
}

/** Make a fragment safe to show: invisible characters become visible tags. */
function visible(text: string): string {
  let out = "";
  for (const char of text) {
    const codepoint = char.codePointAt(0) ?? 0;
    if (INVISIBLE_CODEPOINTS.has(codepoint)) out += escapeCodepoint(codepoint);
    else if (codepoint < 0x20 || codepoint === 0x7f) {
      out += `\\u${codepoint.toString(16).toUpperCase().padStart(4, "0")}`;
    } else out += char;
  }
  return out;
}

/** A <=40-character window, never the whole body. */
function highlightAround(
  text: string,
  index: number,
  length: number
): { before: string; bad: string; after: string } {
  const badLength = Math.max(1, length);
  const before = text.slice(Math.max(0, index - 16), index);
  const bad = text.slice(index, index + badLength);
  const after = text.slice(index + badLength, index + badLength + 16);
  return { before: visible(before), bad: visible(bad), after: visible(after) };
}

function offsetOf(text: string, index: number): { byte: number; char: number } {
  return {
    byte: new TextEncoder().encode(text.slice(0, index)).length,
    char: index,
  };
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_]/.test(char);
}

/**
 * Walk a compiled `RegExp` and find the first match that is not delimited.
 *
 * A reference number is a whole token: `REF 12A45` matching only `REF` (or only
 * `12A45`) is the multiword-reference bug this code names. The walk is capped at
 * 100 matches so a zero-length or pathological pattern cannot spin.
 */
function walkPattern(
  text: string,
  source: string
): { index: number; length: number; why: string } | null {
  const re = new RegExp(source, "g");
  const anchoredStart = source.startsWith("\\b") || source.startsWith("^");
  const anchoredEnd = source.endsWith("\\b") || source.endsWith("$");

  let match: RegExpExecArray | null;
  let guard = 0;
  while ((match = re.exec(text)) !== null && guard < 100) {
    guard += 1;
    if (match[0].length === 0) {
      re.lastIndex += 1;
      continue;
    }
    const start = match.index;
    const end = start + match[0].length;
    if (!anchoredStart && isWordChar(text[start]) && isWordChar(text[start - 1])) {
      return {
        index: start,
        length: 1,
        why: "the match starts inside a word, so the reference token was cut in half",
      };
    }
    if (!anchoredEnd && isWordChar(text[end - 1]) && isWordChar(text[end])) {
      return {
        index: end - 1,
        length: 1,
        why: "the match ends inside a word, so only the first part of the reference was captured",
      };
    }
  }
  return null;
}

interface MessageRow {
  id: string;
  device_id: string;
  local_id: string;
  direction: string;
  peer: string;
  body: string;
  received_at: number;
}

async function loadMessage(env: Env, id: string): Promise<MessageRow | null> {
  return env.DB.prepare(
    `SELECT id, device_id, local_id, direction, peer, body, received_at
       FROM messages WHERE id = ? LIMIT 1`
  )
    .bind(id)
    .first<MessageRow>();
}

interface ApprovalStateRow {
  state: string;
  expires_at: number;
  decided_by: string | null;
}

async function loadApprovalState(env: Env, id: string): Promise<ApprovalStateRow | null> {
  return env.DB.prepare(
    `SELECT state, expires_at, decided_by FROM approval_requests WHERE id = ? LIMIT 1`
  )
    .bind(id)
    .first<ApprovalStateRow>();
}

/**
 * Resolve the flow ids a `flow_run_id` could name.
 *
 * `flow_runs` has no run-id column (its key is device+local+flow+version), so the
 * supplied value is tried as a `flow_id` first and as a message `local_id`
 * second. That is the only honest mapping the schema supports.
 */
async function resolveFlowIds(
  env: Env,
  runId: string
): Promise<{ flowIds: string[]; outcomes: string[] }> {
  const rows = await env.DB.prepare(
    `SELECT flow_id, outcome FROM flow_runs
      WHERE flow_id = ? OR local_id = ?
      ORDER BY created_at DESC LIMIT 5`
  )
    .bind(runId, runId)
    .all<{ flow_id: string; outcome: string }>();
  const results = rows.results ?? [];
  return {
    flowIds: [...new Set(results.map((row) => row.flow_id))],
    outcomes: results.map((row) => row.outcome),
  };
}

interface GrantRowLite {
  id: string;
  scope: string;
  target_json: string;
  expires_at: number;
  revoked_at: number | null;
}

/**
 * The money invariant, from the ledger when there is a row and from the labels
 * when there is not.
 *
 * `financial_transactions` is authoritative: it already parsed the SMS. The
 * label fallback exists because a spoofed SMS is exactly the one that never got a
 * ledger row, and it is deliberately conservative (both labels must be present).
 */
async function checkMoneyInvariant(
  env: Env,
  messageId: string,
  text: string
): Promise<{ index: number; length: number; principal: number; balance: number } | null> {
  const row = await env.DB.prepare(
    `SELECT amount_minor, balance_after_minor FROM financial_transactions
      WHERE message_id = ? LIMIT 1`
  )
    .bind(messageId)
    .first<{ amount_minor: number; balance_after_minor: number | null }>();

  if (
    row !== null &&
    row.balance_after_minor !== null &&
    Number(row.balance_after_minor) < Number(row.amount_minor)
  ) {
    return {
      index: 0,
      length: 0,
      principal: Number(row.amount_minor),
      balance: Number(row.balance_after_minor),
    };
  }
  if (row !== null) return null;

  const balanceLabel = /balance[^0-9]{0,12}([\d,]+(?:\.\d+)?)/i.exec(text);
  const amountLabel = /(?:tk|bdt|৳|amount|paid|sent|debited)[^0-9]{0,12}([\d,]+(?:\.\d+)?)/i.exec(
    text
  );
  if (balanceLabel === null || amountLabel === null) return null;

  const parse = (value: string): number => Number(value.replace(/,/g, ""));
  const balance = parse(balanceLabel[1]);
  const principal = parse(amountLabel[1]);
  if (!Number.isFinite(balance) || !Number.isFinite(principal)) return null;
  if (balance >= principal) return null;
  return { index: balanceLabel.index, length: balanceLabel[0].length, principal, balance };
}

interface DeliveryRow {
  id: string;
  webhook_id: string;
  last_http_status: number | null;
  state: string;
  attempts: number;
}

async function findDownstreamFailure(env: Env, messageId: string): Promise<DeliveryRow | null> {
  return env.DB.prepare(
    `SELECT id, webhook_id, last_http_status, state, attempts
       FROM integration_deliveries
      WHERE (last_http_status >= 500 OR state = 'DEAD_LETTER')
        AND payload_json LIKE ?
      ORDER BY created_at DESC LIMIT 1`
  )
    .bind(`%${messageId}%`)
    .first<DeliveryRow>();
}

/**
 * `POST /v1/agent/diagnose`
 *
 * Precedence, and why:
 *
 *   1. invisible Unicode — unambiguous, and it changes encoding and billing;
 *   2. pattern boundary    — only when the caller supplied a pattern;
 *   3. approval state      — a 409 is the most common "why did my apply fail";
 *   4. authority grant     — a flow id with no live grant;
 *   5. money invariant     — a spoofed credit;
 *   6. downstream webhook  — a 5xx from the operator's endpoint.
 *
 * The full body is never returned: a highlight is at most 16+8+16 characters and
 * the response carries ids and counts, not text.
 */
export async function handleAgentDiagnose(req: Request, env: Env): Promise<Response> {
  const parsed = await readValidated(req, DiagnoseBody);
  if (!parsed.ok) return parsed.response;
  const input = parsed.data;

  const row = input.message_id === undefined ? null : await loadMessage(env, input.message_id);
  const text = input.message ?? row?.body ?? "";
  const segment = segmentText(text);

  const finish = (
    code: RootCauseCode | null,
    summary: string,
    extra: Partial<RootCauseCard> = {}
  ): Response => {
    const card: RootCauseCard = {
      code,
      summary,
      encoding: segment.encoding,
      segments: segment.segments,
      ...extra,
    };
    logAgent("diagnose", {
      code,
      encoding: segment.encoding,
      segments: segment.segments,
      has_message_id: input.message_id !== undefined,
    });
    return Response.json(card);
  };

  /* 1. invisible Unicode ------------------------------------------------ */
  const invisible = firstInvisible(text);
  if (invisible !== null) {
    return finish(
      "ERR_UNICODE_ZERO_WIDTH_UCS2",
      `${escapeCodepoint(invisible.codepoint)} at character ${invisible.char} is invisible and forces UCS-2, so ${segment.segments} segment(s) and a UCS-2 tariff. Remove it from the template.`,
      {
        offset: offsetOf(text, invisible.char),
        highlight: highlightAround(
          text,
          invisible.char,
          invisible.codepoint > 0xffff ? 2 : 1
        ),
      }
    );
  }

  /* 2. multiword reference boundary ------------------------------------- */
  if (input.pattern !== undefined && text.length > 0) {
    let mismatch: ReturnType<typeof walkPattern>;
    try {
      mismatch = walkPattern(text, input.pattern);
    } catch {
      return Response.json(
        { error: "bad_request", message: "pattern is not a valid regular expression" },
        { status: 400 }
      );
    }
    if (mismatch !== null) {
      return finish(
        "ERR_MULTIWORD_REF_MISMATCH",
        mismatch.why,
        {
          offset: offsetOf(text, mismatch.index),
          highlight: highlightAround(text, mismatch.index, mismatch.length),
          // Anchoring the capture to a word boundary is the minimal repair; the
          // operator still reviews it in the rule editor.
          fix: { kind: "pattern_patch", pattern: `\\b(?:${input.pattern})\\b` },
        }
      );
    }
  }

  /* 3. approval gate ----------------------------------------------------- */
  if (input.message_id !== undefined) {
    const approval = await loadApprovalState(env, input.message_id);
    if (approval !== null) {
      const expired = approval.state === "PENDING" && approval.expires_at <= Date.now();
      if (approval.state !== "PENDING" || expired) {
        const state = expired ? "expired" : approval.state.toLowerCase();
        return finish(
          "ERR_APPROVAL_GATE_409_NOT_PENDING",
          `approval request ${input.message_id} is ${state}${approval.decided_by === null ? "" : ` by ${approval.decided_by}`}; the apply path answers 409 not_pending and a new request must be opened.`
        );
      }
    }
  }

  /* 4. authority grant --------------------------------------------------- */
  if (input.flow_run_id !== undefined) {
    const { flowIds, outcomes } = await resolveFlowIds(env, input.flow_run_id);
    if (flowIds.length > 0) {
      const grants = await env.DB.prepare(
        `SELECT id, scope, target_json, expires_at, revoked_at
           FROM authority_grants
          ORDER BY granted_at DESC LIMIT 100`
      ).all<GrantRowLite>();
      const now = Date.now();
      const relevant = (grants.results ?? []).filter((grant) => {
        try {
          const target = JSON.parse(grant.target_json) as { flow_id?: unknown };
          return typeof target.flow_id === "string" && flowIds.includes(target.flow_id);
        } catch {
          return false;
        }
      });
      const live = relevant.filter(
        (grant) => grant.revoked_at === null && grant.expires_at > now
      );
      const failedOutcome = outcomes.some(
        (outcome) => outcome === "error" || outcome === "halted"
      );
      if (relevant.length > 0 && live.length === 0) {
        return finish(
          "ERR_AUTHORITY_GUARD_EXPIRED_OR_HASH_MISMATCH",
          `every grant naming flow ${flowIds[0]} is expired or revoked; the run had no live authority, and a body_hash mismatch is the other way this presents.`
        );
      }
      if (relevant.length === 0 && failedOutcome) {
        return finish(
          "ERR_AUTHORITY_GUARD_EXPIRED_OR_HASH_MISMATCH",
          `flow ${flowIds[0]} ended in a failed outcome and no authority grant ever named it.`
        );
      }
    }
  }

  /* 5. money invariant --------------------------------------------------- */
  if (input.message_id !== undefined) {
    const money = await checkMoneyInvariant(env, input.message_id, text);
    if (money !== null) {
      return finish(
        "ERR_FAKE_SMS_SPOOF_QUARANTINE",
        `the stated balance (${money.balance}) is below the principal (${money.principal}); a credit that leaves less than it moved is the spoof pattern, so the message is quarantined.`,
        {
          ...(money.index === 0 && money.length === 0
            ? {}
            : {
                offset: offsetOf(text, money.index),
                highlight: highlightAround(text, money.index, money.length),
              }),
        }
      );
    }
  }

  /* 6. downstream webhook ------------------------------------------------ */
  if (input.message_id !== undefined) {
    const delivery = await findDownstreamFailure(env, input.message_id);
    if (delivery !== null) {
      return finish(
        "ERR_DOWNSTREAM_WEBHOOK_502",
        `webhook ${delivery.webhook_id} answered ${delivery.last_http_status ?? "a 5xx"} after ${delivery.attempts} attempt(s) and the delivery is ${delivery.state.toLowerCase()}.`
      );
    }
  }

  return finish(
    null,
    "no known failure signature matched: no invisible Unicode, no pattern boundary mismatch, no dead approval or grant, no spoofed balance and no failed webhook."
  );
}

/* ────────────────────────────── 4. synthesize ────────────────────────────── */

const SynthesizeBody = z.object({
  intent: z.string().min(1).max(1_000),
  flow_id: z.string().min(1).max(128),
  diff_summary: z.string().min(1).max(4_000),
  corpus_report: z.string().max(1_000),
});

function sha256Hex(text: string): Promise<string> {
  return crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(text))
    .then((digest) =>
      [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
    );
}

function base64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/**
 * `POST /v1/agent/synthesize`
 *
 * The model judges; the Worker mints. `body_hash` is the SHA-256 of a canonical
 * diff summary (fixed key order, trimmed text), `max_uses` is 1, and the target
 * names the flow — so a token that leaks cannot be replayed against a different
 * patch, flow or second apply. Nothing is applied here: the existing approval /
 * authority route is still the only spender.
 */
export async function handleAgentSynthesize(req: Request, env: Env): Promise<Response> {
  const parsed = await readValidated(req, SynthesizeBody);
  if (!parsed.ok) return parsed.response;
  const input = parsed.data;

  const judged = await judgeCandidatePatch(
    system1Env(env),
    input.intent,
    input.diff_summary,
    input.corpus_report
  );

  if (!judged.ok) {
    logAgent("synthesize", { applied: false, reason: judged.reason ?? "unavailable" });
    return Response.json(
      {
        error: "ai_unavailable",
        message: "the candidate-patch judge did not answer; nothing was minted",
        reason: judged.reason ?? "provider_unavailable",
      },
      { status: 503 }
    );
  }

  const approvalProbability =
    judged.approval && judged.approval.type === "noul" ? judged.approval.probability : null;
  const approvalRequired = approvalProbability !== null && approvalProbability >= APPROVAL_NOUL_MIN;

  let applyToken: string | null = null;
  if (approvalRequired) {
    // Canonical form: fixed key order and trimmed text, so the same patch always
    // hashes the same bytes. This is the value `body_hash` binds the grant to.
    const canonicalSummary = JSON.stringify({
      flow_id: input.flow_id,
      intent: input.intent.trim(),
      diff_summary: input.diff_summary.trim(),
    });
    const bodyHash = await sha256Hex(canonicalSummary);
    const target: GrantTarget = {
      flow_id: input.flow_id,
      body_hash: bodyHash,
      max_uses: 1,
    };
    applyToken = `ag1_${base64Url(canonicalTargetJson(target))}`;
  }

  logAgent("synthesize", {
    approval_required: approvalRequired,
    faithful_score: judged.faithful?.score ?? null,
    minted: applyToken !== null,
  });

  return Response.json({
    faithful:
      judged.faithful && judged.faithful.type === "score"
        ? {
            score: judged.faithful.score ?? null,
            probability: judged.faithful.probability,
            confidence: judged.faithful.confidence,
          }
        : null,
    approval_required: approvalRequired,
    apply_token: applyToken,
  });
}
