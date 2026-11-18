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
import { compileRule, evaluateRules, type RuleRecord } from "../lib/rule-graph";
import { consumeGrantUse, findLiveGrant, requestApproval } from "../lib/authority";
import { approvalResponse } from "../lib/agent-send";
import { canonicalJson, sha256Hex } from "../agent/journal";

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

async function authorizeAgentRuleWrite(
  env: Env,
  actor: AdminActor | undefined,
  ruleId: string,
  bodyHash: string,
  allowShortcode: number,
  reason: string
): Promise<Response | null> {
  if (actor?.role !== "agent" || !actor.agentTokenId) return null;

  if (allowShortcode === 1) {
    const shortcodeGrant = await findLiveGrant(env, actor.agentTokenId, "enable_shortcode", {
      rule_id: ruleId,
    });
    if (shortcodeGrant === null || !(await consumeGrantUse(env, shortcodeGrant.id))) {
      const approval = await requestApproval(env, {
        agentTokenId: actor.agentTokenId,
        scope: "enable_shortcode",
        target: { rule_id: ruleId },
        reason,
      });
      return approvalResponse(approval);
    }
  }

  const scoped = await findLiveGrant(env, actor.agentTokenId, "rules:write", {
    rule_id: ruleId,
    body_hash: bodyHash,
  });
  const live = scoped ?? (await findLiveGrant(env, actor.agentTokenId, "rules:write", {}));
  if (live === null || !(await consumeGrantUse(env, live.id))) {
    const approval = await requestApproval(env, {
      agentTokenId: actor.agentTokenId,
      scope: "rules:write",
      target: { rule_id: ruleId, body_hash: bodyHash },
      reason,
    });
    return approvalResponse(approval);
  }

  return null;
}

type RuleParseResult =
  | { ok: true; record: RuleRecord; bodyHash: string }
  | { ok: false; response: Response };

async function buildValidatedRule(
  input: Record<string, unknown>,
  id: string,
  existing: RuleRecord | null
): Promise<RuleParseResult> {
  const matcher = (input.matcher ?? null) as Record<string, unknown> | null;
  const bodyMatcher = (input.body_matcher ?? null) as Record<string, unknown> | null;

  const matcherType =
    matcher && typeof matcher.type === "string"
      ? matcher.type
      : input.matcher_type !== undefined
        ? String(input.matcher_type)
        : existing?.matcher_type ?? "";
  const matcherValue =
    matcher && matcher.value !== undefined
      ? String(matcher.value)
      : input.matcher_value !== undefined
        ? String(input.matcher_value)
        : existing?.matcher_value ?? "";
  const bodyType =
    bodyMatcher && typeof bodyMatcher.type === "string"
      ? bodyMatcher.type
      : input.body_type !== undefined
        ? String(input.body_type)
        : existing?.body_type ?? "";
  const bodyValue =
    bodyMatcher && bodyMatcher.value !== undefined
      ? String(bodyMatcher.value)
      : input.body_value !== undefined
        ? String(input.body_value)
        : existing?.body_value ?? "";
  const replyTemplate =
    input.reply_template !== undefined
      ? String(input.reply_template)
      : existing?.reply_template ?? "";

  if (!ALLOWED_MATCHER_TYPES.has(matcherType) || !ALLOWED_BODY_TYPES.has(bodyType)) {
    return { ok: false, response: err("bad_request", 400) };
  }
  if (
    utf8Length(matcherValue) > MAX_PATTERN_BYTES ||
    utf8Length(bodyValue) > MAX_PATTERN_BYTES ||
    utf8Length(replyTemplate) > MAX_REPLY_TEMPLATE_BYTES
  ) {
    return { ok: false, response: err("bad_request", 400) };
  }

  if (matcherType === "regex") {
    const reason = lintRe2(matcherValue);
    if (reason) {
      console.warn(`[rules] matcher regex rejected: ${reason}`);
      return { ok: false, response: err("rule_rejected", 400) };
    }
  }
  if (bodyType === "regex") {
    const reason = lintRe2(bodyValue);
    if (reason) {
      console.warn(`[rules] body regex rejected: ${reason}`);
      return { ok: false, response: err("rule_rejected", 400) };
    }
  }

  const rawName = input.name;
  let name: string;
  if (rawName === undefined || rawName === null) {
    name = existing?.name ?? `rule-${id}`;
  } else if (typeof rawName === "string" && rawName.trim() !== "") {
    name = rawName;
  } else {
    return { ok: false, response: err("bad_request", 400) };
  }

  let deviceId: string | null = existing?.device_id ?? null;
  if ("device_id" in input) {
    const rawDeviceId = input.device_id;
    if (rawDeviceId === undefined || rawDeviceId === null || rawDeviceId === "") {
      deviceId = null;
    } else if (typeof rawDeviceId === "string" && RE_DEVICE_ID.test(rawDeviceId)) {
      deviceId = rawDeviceId;
    } else {
      return { ok: false, response: err("bad_request", 400) };
    }
  }

  const enabled =
    input.enabled === undefined ? (existing ? existing.enabled : 1) : input.enabled ? 1 : 0;
  const allowShortcode =
    input.allow_shortcode_reply !== undefined || input.allow_shortcode !== undefined
      ? input.allow_shortcode_reply || input.allow_shortcode
        ? 1
        : 0
      : existing && existing.allow_shortcode
        ? 1
        : 0;

  const stored: RuleRecord = {
    id,
    name,
    enabled,
    priority: readInt(input.priority, existing?.priority ?? 0),
    matcher_type: matcherType,
    matcher_value: matcherValue,
    body_type: bodyType,
    body_value: bodyValue,
    reply_template: replyTemplate,
    cooldown_s: readInt(input.cooldown_seconds ?? input.cooldown_s, existing?.cooldown_s ?? 60),
    max_per_hour: readInt(
      input.max_replies_per_hour ?? input.max_per_hour,
      existing?.max_per_hour ?? 10
    ),
    sim_slot: readInt(input.sim_slot, existing?.sim_slot ?? 0),
    allow_shortcode: allowShortcode,
    device_id: deviceId,
    updated_at: Date.now(),
  };

  const compiled = compileRule(stored);
  if (!compiled.ok) {
    console.warn(`[rules] rule ${id} rejected: ${compiled.reason}`);
    return { ok: false, response: err("rule_rejected", 400) };
  }

  const bodyHash = await sha256Hex(
    canonicalJson({
      matcher: stored.matcher_type,
      body_matcher: stored.body_type,
      reply_template: stored.reply_template,
    })
  );

  return { ok: true, record: stored, bodyHash };
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

  const rawId = input.id;
  const id =
    typeof rawId === "string" && rawId.trim() !== "" ? rawId.trim() : crypto.randomUUID();

  const built = await buildValidatedRule(input, id, null);
  if (!built.ok) return built.response;
  const stored = built.record;

  const reason = typeof input.reason === "string" ? input.reason.slice(0, 200) : "Save rule";
  const refusal = await authorizeAgentRuleWrite(
    env,
    actor,
    id,
    built.bodyHash,
    stored.allow_shortcode ? 1 : 0,
    reason
  );
  if (refusal !== null) return refusal;

  await env.DB.prepare(
    `INSERT OR REPLACE INTO rules
       (id, name, enabled, priority, matcher_type, matcher_value,
        body_type, body_value, reply_template, cooldown_s, max_per_hour,
        sim_slot, allow_shortcode, device_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      stored.id,
      stored.name,
      stored.enabled,
      stored.priority,
      stored.matcher_type,
      stored.matcher_value,
      stored.body_type,
      stored.body_value,
      stored.reply_template,
      stored.cooldown_s,
      stored.max_per_hour,
      stored.sim_slot,
      stored.allow_shortcode,
      stored.device_id,
      stored.updated_at
    )
    .run();

  await writeAudit(env, {
    action: "rule.saved",
    actor: actor === undefined ? null : { userId: actor.userId, label: actor.label },
    subject: id,
    // No matcher value, body or template: those can contain phone numbers.
    detail: { device_id: stored.device_id, enabled: stored.enabled === 1 },
  });

  return Response.json({ ok: true, id });
}

/** `PUT /v1/rules/:id` & `PUT /v1/admin/rules/:id` — partial update or pause/resume. */
export async function handleRulePut(
  req: Request,
  env: Env,
  rawId: string,
  actor?: AdminActor
): Promise<Response> {
  let id: string;
  try {
    id = decodeURIComponent(rawId).trim();
  } catch {
    return err("bad_request", 400);
  }
  if (id === "") return err("bad_request", 400);

  const existing = await env.DB.prepare(
    `SELECT id, name, enabled, priority, matcher_type, matcher_value,
            body_type, body_value, reply_template, cooldown_s, max_per_hour,
            sim_slot, allow_shortcode, device_id, updated_at
       FROM rules WHERE id = ?`
  )
    .bind(id)
    .first<RuleRecord>();
  if (!existing) return Response.json({ error: "not_found" }, { status: 404 });

  const parsed = await readJsonBoundedResult(req, MAX_BODY_BYTES);
  if (!parsed.ok) return err(parsed.reason);
  const input = parsed.value;

  const built = await buildValidatedRule(input, id, existing);
  if (!built.ok) return built.response;
  const stored = built.record;

  const newlyEnablesShortcode = stored.allow_shortcode && !existing.allow_shortcode ? 1 : 0;
  const reason = typeof input.reason === "string" ? input.reason.slice(0, 200) : "Update rule";
  const refusal = await authorizeAgentRuleWrite(
    env,
    actor,
    id,
    built.bodyHash,
    newlyEnablesShortcode,
    reason
  );
  if (refusal !== null) return refusal;

  await env.DB.prepare(
    `UPDATE rules
        SET name = ?, enabled = ?, priority = ?, matcher_type = ?, matcher_value = ?,
            body_type = ?, body_value = ?, reply_template = ?, cooldown_s = ?,
            max_per_hour = ?, sim_slot = ?, allow_shortcode = ?, device_id = ?,
            updated_at = ?
      WHERE id = ?`
  )
    .bind(
      stored.name,
      stored.enabled,
      stored.priority,
      stored.matcher_type,
      stored.matcher_value,
      stored.body_type,
      stored.body_value,
      stored.reply_template,
      stored.cooldown_s,
      stored.max_per_hour,
      stored.sim_slot,
      stored.allow_shortcode,
      stored.device_id,
      stored.updated_at,
      id
    )
    .run();

  await writeAudit(env, {
    action: "rule.updated",
    actor: actor === undefined ? null : { userId: actor.userId, label: actor.label },
    subject: id,
    detail: { device_id: stored.device_id, enabled: stored.enabled === 1 },
  });

  return Response.json({ ok: true, id, rule: stored });
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

  const evaluations = await evaluateRules(
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
