/**
 * Rules — PROTOCOL_CONTRACT_V5 Rev C §7 (RE2 rule language) and §8.
 * Port of master plan §5.4 with brief fixes #14, #15 and #16.
 *
 *   #14 The linter is now `lib/re2-compat.ts` (§7) instead of three string
 *       regexes; in particular lookahead is rejected, because Rev B let it
 *       through and it then failed to compile in RE2/J on the phone.
 *   #15 `id` is generated server-side when missing/malformed, so a POST can no
 *       longer create an id-less rule (§7.3).
 *   #16 `device_id` scoping: NULL = global rule, otherwise per-device. The
 *       device-authenticated read is bound to the authenticated device, so one
 *       device can never be served another's rules.
 */

import type { Env } from "../index";
import type { AdminActor } from "../audit";
import { writeAudit } from "../audit";
import { err } from "../lib/errors";
import { readJsonBoundedResult } from "../lib/body";
import { MAX_BODY_BYTES, MAX_BODY_CHARS, MAX_PEER_CHARS } from "../lib/config";
import { lintRe2 } from "../lib/re2-compat";
import { RE_DEVICE_ID } from "../auth/canonical";
import { evaluateRules, type RuleRecord } from "../rules/evaluate";

const ALLOWED_MATCHER_TYPES = new Set(["exact", "prefix", "suffix", "glob", "regex"]);
const ALLOWED_BODY_TYPES = new Set(["keyword", "regex"]);

/** §7.1 length caps, measured in BYTES (a UTF-8 pattern can exceed its char count). */
const MAX_PATTERN_BYTES = 512;
const MAX_REPLY_TEMPLATE_BYTES = 1000;

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * `GET /v1/rules` (device-authenticated).
 *
 * §7/#16: a device sees global rules plus its own, never another device's.
 */
export async function handleRulesGet(_req: Request, env: Env, deviceId: string): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT id, name, enabled, priority, matcher_type, matcher_value,
            body_type, body_value, reply_template, cooldown_s, max_per_hour,
            sim_slot, allow_shortcode, device_id, updated_at
       FROM rules
      WHERE enabled = 1 AND (device_id IS NULL OR device_id = ?)
      ORDER BY priority DESC, id ASC`
  )
    .bind(deviceId)
    .all();
  return Response.json({ rules: rows.results ?? [] });
}

/** `POST /v1/rules` (admin) — create or replace a rule. */
export async function handleRulesPost(
  req: Request,
  env: Env,
  actor?: AdminActor
): Promise<Response> {
  const parsed = await readJsonBoundedResult(req, MAX_BODY_BYTES);
  if (!parsed.ok) return err(parsed.reason);
  const input = parsed.value;

  // Accept both the flat and the nested matcher shapes Rev B supported.
  const matcher = (input.matcher ?? null) as Record<string, unknown> | null;
  const bodyMatcher = (input.body_matcher ?? null) as Record<string, unknown> | null;

  const matcherType = String(
    matcher && typeof matcher.type === "string" ? matcher.type : input.matcher_type ?? ""
  );
  const matcherValue =
    matcher && matcher.value !== undefined
      ? String(matcher.value)
      : String(input.matcher_value ?? "");
  const bodyType = String(
    bodyMatcher && typeof bodyMatcher.type === "string" ? bodyMatcher.type : input.body_type ?? ""
  );
  const bodyValue =
    bodyMatcher && bodyMatcher.value !== undefined
      ? String(bodyMatcher.value)
      : String(input.body_value ?? "");
  const replyTemplate = String(input.reply_template ?? "");

  if (!ALLOWED_MATCHER_TYPES.has(matcherType) || !ALLOWED_BODY_TYPES.has(bodyType)) {
    return err("bad_request", 400);
  }
  if (
    utf8Length(matcherValue) > MAX_PATTERN_BYTES ||
    utf8Length(bodyValue) > MAX_PATTERN_BYTES ||
    utf8Length(replyTemplate) > MAX_REPLY_TEMPLATE_BYTES
  ) {
    return err("bad_request", 400);
  }

  // §7.1: reject anything RE2/J cannot compile, before it can reach a device.
  if (matcherType === "regex") {
    const reason = lintRe2(matcherValue);
    if (reason) {
      console.warn(`[rules] matcher regex rejected: ${reason}`);
      return err("rule_rejected", 400);
    }
  }
  if (bodyType === "regex") {
    const reason = lintRe2(bodyValue);
    if (reason) {
      console.warn(`[rules] body regex rejected: ${reason}`);
      return err("rule_rejected", 400);
    }
  }

  // #15 §7.3: an id must be a non-empty string, otherwise generate one. SQLite
  // permits NULL in a non-INTEGER PRIMARY KEY and treats each NULL as distinct,
  // so an id-less POST used to create untargetable duplicate rules.
  const rawId = input.id;
  const id =
    typeof rawId === "string" && rawId.trim() !== "" ? rawId.trim() : crypto.randomUUID();

  // `name` is NOT NULL: validate it when supplied, otherwise derive a stable one
  // so a rule can never be stored nameless.
  const rawName = input.name;
  let name: string;
  if (rawName === undefined || rawName === null) {
    name = `rule-${id}`;
  } else if (typeof rawName === "string" && rawName.trim() !== "") {
    name = rawName;
  } else {
    return err("bad_request", 400);
  }

  // #16: NULL device_id = global rule; a string = per-device rule.
  const rawDeviceId = input.device_id;
  let deviceId: string | null = null;
  if (rawDeviceId !== undefined && rawDeviceId !== null && rawDeviceId !== "") {
    if (typeof rawDeviceId !== "string") return err("bad_request", 400);
    deviceId = rawDeviceId;
  }

  await env.DB.prepare(
    `INSERT OR REPLACE INTO rules
       (id, name, enabled, priority, matcher_type, matcher_value,
        body_type, body_value, reply_template, cooldown_s, max_per_hour,
        sim_slot, allow_shortcode, device_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      id,
      name,
      input.enabled === undefined ? 1 : input.enabled ? 1 : 0,
      readInt(input.priority, 0),
      matcherType,
      matcherValue,
      bodyType,
      bodyValue,
      replyTemplate,
      readInt(input.cooldown_seconds ?? input.cooldown_s, 60),
      readInt(input.max_replies_per_hour ?? input.max_per_hour, 10),
      readInt(input.sim_slot, 0),
      input.allow_shortcode_reply || input.allow_shortcode ? 1 : 0,
      deviceId,
      Date.now()
    )
    .run();

  await writeAudit(env, {
    action: "rule.saved",
    actor: actor === undefined ? null : { userId: actor.userId, label: actor.label },
    subject: id,
    // No matcher value, body or template: those can contain phone numbers.
    detail: { device_id: deviceId, enabled: input.enabled === undefined ? true : Boolean(input.enabled) },
  });

  return Response.json({ ok: true, id });
}

/**
 * `POST /v1/admin/rules/test` — evaluate the matchers without side effects.
 *
 * `dryRun` makes the evaluator ignore cooldown and hit history, so the operator
 * sees "would this pattern match?" rather than "is this rule currently allowed to
 * reply?". The reply path uses the same `evaluateRules`, so the test cannot drift
 * from what production does.
 */
export async function handleRulesTest(req: Request, env: Env): Promise<Response> {
  const parsed = await readJsonBoundedResult(req, MAX_BODY_BYTES);
  if (!parsed.ok) return err(parsed.reason);
  const input = parsed.value;

  const peer = input.peer;
  if (typeof peer !== "string" || peer === "" || peer.length > MAX_PEER_CHARS) {
    return err("bad_request", 400);
  }
  const body = input.body;
  if (typeof body !== "string" || body.length > MAX_BODY_CHARS) {
    return err("bad_request", 400);
  }

  let deviceId: string | null = null;
  const rawDeviceId = input.device_id;
  if (rawDeviceId !== undefined && rawDeviceId !== null && rawDeviceId !== "") {
    if (typeof rawDeviceId !== "string" || !RE_DEVICE_ID.test(rawDeviceId)) {
      return err("bad_request", 400);
    }
    deviceId = rawDeviceId;
  }

  // Every rule, not just the applicable enabled ones: the point of the test is to
  // explain why a rule would not reply, and `disabled` / `device_mismatch` are two
  // of those answers. The reply path still filters to enabled, in-scope rules.
  const rows = await env.DB.prepare(
    `SELECT id, name, enabled, priority, matcher_type, matcher_value,
            body_type, body_value, reply_template, cooldown_s, max_per_hour,
            sim_slot, allow_shortcode, device_id, updated_at
       FROM rules
      ORDER BY priority DESC, id ASC`
  ).all<RuleRecord>();

  const evaluations = evaluateRules(
    rows.results ?? [],
    { peer, body },
    { deviceId: deviceId ?? "", now: Date.now(), dryRun: true, hits: [] }
  );

  return Response.json({
    matches: evaluations.map((evaluation) => ({
      rule_id: evaluation.rule_id,
      name: evaluation.name,
      matched: evaluation.matched,
      reason: evaluation.reason,
    })),
  });
}

function readInt(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.trunc(parsed);
  }
  return fallback;
}
