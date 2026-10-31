/**
 * Rule compilation and evaluation — PROTOCOL_CONTRACT_V5 §11.11.
 *
 * Rules live in the Worker because they are an online feature: they answer while
 * the batch syncs (and therefore depend on the gateway being reachable), whereas
 * workflows run on the phone first. Keeping the matcher here pure means the same
 * code answers two callers:
 *
 *   - `routes/incoming.ts`, which uses the first `matched` rule to reply;
 *   - `POST /v1/admin/rules/test`, which asks for a reason per rule.
 *
 * Nothing in this module touches D1, the clock or `crypto`. `now`, the device id
 * and the hit history are all injected, so a dry run cannot accidentally write and
 * a test is reproducible.
 *
 * Since the flow interpreter landed, matching itself is not a second engine: a
 * rule row is compiled into the same graph a workflow uses and run through
 * `flow/engine.runFlow`, so the desktop simulator, the phone and the Worker fallback
 * cannot disagree about what a matcher means.
 */

import { lintRe2 } from "./re2-compat";
import {
  validateWorkflowGraph,
  type Graph,
  type WorkflowEdge,
  type WorkflowNode,
} from "./workflow";
import { runFlow } from "../flow/engine";

export interface RuleRecord {
  id: string;
  name: string;
  enabled: number | boolean;
  priority: number;
  matcher_type: string;
  matcher_value: string;
  body_type: string;
  body_value: string;
  reply_template: string;
  cooldown_s: number;
  max_per_hour: number;
  sim_slot?: number;
  allow_shortcode: number | boolean;
  device_id: string | null;
  updated_at?: number;
}

export interface RuleHit {
  rule_id: string;
  device_id: string;
  replied_at: number;
}

export type RuleReason =
  | "disabled"
  | "device_mismatch"
  | "sender_mismatch"
  | "body_mismatch"
  | "shortcode_blocked"
  | "cooldown"
  | "hourly_cap"
  | "matched";

export interface RuleEvaluation {
  rule_id: string;
  name: string;
  matched: boolean;
  reason: RuleReason;
  /** The body text that satisfied the matcher, for `{matched}` substitution. */
  matched_text: string;
  /** The reply the flow engine rendered, or "" when the rule did not match. */
  reply_body: string;
  /** The evaluated rule, so the caller can render its template without a re-lookup. */
  rule: RuleRecord;
}

export interface EvaluateInput {
  peer: string;
  body: string;
}

export interface EvaluateOptions {
  deviceId: string;
  now: number;
  /** Report only: skip cooldown/hourly checks and never write. */
  dryRun?: boolean;
  /** Recent `rule_hits` for this device, used for the two rate limits. */
  hits?: RuleHit[];
}

const HOUR_MS = 3_600_000;

/**
 * "Masked, or at least ten digits anywhere."
 *
 * Today's guard is `!allow_shortcode && !masked && digitCount(peer) < 10`, where
 * `masked` means the sender contains a letter. Its complement is exactly the
 * alternation below, so it is written without a group: `lintRe2` rejects a
 * quantified group that contains a quantifier, and the ten-fold repetition would
 * be exactly that.
 */
const SHORTCODE_PATTERN = "[A-Za-z]|^[^0-9]*" + "[0-9][^0-9]*".repeat(10);

type CompileResult = { ok: true; graph: Graph } | { ok: false; reason: string };

/**
 * Compiled graphs, keyed by the rule row object itself.
 *
 * `routes/incoming.ts` evaluates one rule list against every message in a batch
 * and hands the same objects to each call, so a `WeakMap` turns the compile into
 * once per rule per batch instead of once per rule per message. Object identity
 * is the correctness argument: a row object is never mutated, so a hit cannot be
 * stale. A `WeakMap` also means the entries go away with the rows.
 */
const compiled = new WeakMap<RuleRecord, CompileResult>();

function compileCached(rule: RuleRecord): CompileResult {
  const hit = compiled.get(rule);
  if (hit !== undefined) return hit;
  const result = compileRule(rule);
  compiled.set(rule, result);
  return result;
}

/**
 * Turn one stored rule into a flow graph.
 *
 * The graph is deliberately tiny and travels through the ordinary workflow
 * validator, so a rule that could not be stored as a workflow is rejected here
 * too. Reason strings never contain the matcher value, body or template: those
 * can hold phone numbers.
 */
export function compileRule(rule: RuleRecord): CompileResult {
  const senderPattern = buildSenderPattern(rule.matcher_type, rule.matcher_value);
  if (!senderPattern.ok) return senderPattern;

  const bodyPattern = buildBodyPattern(rule.body_type, rule.body_value);
  if (!bodyPattern.ok) return bodyPattern;

  const nodes: WorkflowNode[] = [];
  const edges: WorkflowEdge[] = [];
  let y = 0;

  const addNode = (
    id: string,
    type: WorkflowNode["type"],
    data: Record<string, unknown>
  ): void => {
    nodes.push({ id, type, position: { x: 0, y }, data });
    y += 120;
  };
  const addEdge = (
    id: string,
    source: string,
    target: string,
    sourceHandle?: "true" | "false"
  ): void => {
    edges.push(sourceHandle === undefined ? { id, source, target } : { id, source, target, sourceHandle });
  };

  addNode("trigger", "trigger", { kind: "incoming" });
  addNode("sender", "condition", {
    left: "{{sender}}",
    op: "matches",
    right: senderPattern.value,
  });
  // An alphanumeric mask ("MyBank", "VERIFY") is never a routable reply target.
  // This reproduces the old evaluator's `maskedSender ||` short-circuit, routing
  // into the same reject node so the reason is still `sender_mismatch`.
  addNode("masked", "condition", {
    left: "{{sender}}",
    op: "matches",
    right: "[A-Za-z]",
  });
  addNode("body", "condition", {
    left: "{{body}}",
    op: "matches",
    right: bodyPattern.value,
  });
  addNode("extract", "extract", {
    source: "body",
    pattern: buildExtractPattern(rule.body_type, rule.body_value),
  });
  addNode("reject_sender", "stop", {});
  addNode("reject_body", "stop", {});

  addEdge("e_trigger_sender", "trigger", "sender");
  addEdge("e_sender_true", "sender", "masked", "true");
  addEdge("e_sender_false", "sender", "reject_sender", "false");
  addEdge("e_masked_true", "masked", "reject_sender", "true");
  addEdge("e_masked_false", "masked", "body", "false");
  addEdge("e_body_true", "body", "extract", "true");
  addEdge("e_body_false", "body", "reject_body", "false");

  // An empty template is documented as "match without sending a reply". The
  // validator rejects an empty `send_sms.body`, so such a rule gets no send node
  // at all and the last stage goes straight to `stop`; the reply path's blank-body
  // skip then does nothing, exactly as before.
  const wantsReply = rule.reply_template.trim() !== "";
  const replyBody = wantsReply ? buildReplyTemplate(rule.reply_template) : "";

  if (rule.allow_shortcode) {
    addNode("stop", "stop", {});
    if (wantsReply) {
      addNode("send", "send_sms", { to: "{{sender}}", body: replyBody });
      addEdge("e_extract_send", "extract", "send");
      addEdge("e_send_stop", "send", "stop");
    } else {
      addEdge("e_extract_stop", "extract", "stop");
    }
  } else {
    addNode("shortcode", "condition", {
      left: "{{sender}}",
      op: "matches",
      right: SHORTCODE_PATTERN,
    });
    addNode("reject_shortcode", "stop", {});
    addNode("stop", "stop", {});
    addEdge("e_extract_shortcode", "extract", "shortcode");
    addEdge("e_shortcode_false", "shortcode", "reject_shortcode", "false");
    if (wantsReply) {
      addNode("send", "send_sms", { to: "{{sender}}", body: replyBody });
      addEdge("e_shortcode_true", "shortcode", "send", "true");
      addEdge("e_send_stop", "send", "stop");
    } else {
      addEdge("e_shortcode_true", "shortcode", "stop", "true");
    }
  }

  const validation = validateWorkflowGraph({ nodes, edges });
  if (!validation.ok) {
    // Only the issue path, never its message: messages can quote a template or a
    // capture-group name, and reasons must not carry rule values.
    return { ok: false, reason: `invalid_graph: ${validation.issues[0]?.path ?? ""}` };
  }

  return { ok: true, graph: validation.graph };
}

function buildSenderPattern(
  type: string,
  value: string
): { ok: true; value: string } | { ok: false; reason: string } {
  switch (type) {
    case "exact":
      return { ok: true, value: "^" + escapeRegExp(value) + "$" };
    case "prefix":
      return { ok: true, value: "^" + escapeRegExp(value) };
    case "suffix":
      return { ok: true, value: escapeRegExp(value) + "$" };
    case "glob":
      return { ok: true, value: globToPattern(value) };
    case "regex": {
      // The engine is unanchored, exactly like `new RegExp(value).test(peer)`.
      const reason = lintRe2(value);
      if (reason !== null) return { ok: false, reason: `invalid_matcher_regex: ${reason}` };
      return { ok: true, value };
    }
    default:
      return { ok: false, reason: "unknown_matcher_type" };
  }
}

function buildBodyPattern(
  type: string,
  value: string
): { ok: true; value: string } | { ok: false; reason: string } {
  switch (type) {
    case "keyword":
      return { ok: true, value: "(?i:" + escapeRegExp(value) + ")" };
    case "regex": {
      // The scope is what makes it case-insensitive like `new RegExp(value, "i")`,
      // including across alternation.
      const reason = lintRe2(value);
      if (reason !== null) return { ok: false, reason: `invalid_body_regex: ${reason}` };
      return { ok: true, value: "(?i:" + value + ")" };
    }
    default:
      return { ok: false, reason: "unknown_body_type" };
  }
}

/**
 * One named group so the engine stores the matched text in `variables.matched`,
 * preserving the original case even though the body matcher is case-insensitive.
 *
 * `(?<name>...)` rather than `(?P<name>...)`: the graph validator rejects the Go
 * spelling because the browser runtime cannot compile it, even though the Rust
 * interpreter accepts both.
 */
function buildExtractPattern(type: string, value: string): string {
  const inner = type === "keyword" ? escapeRegExp(value) : value;
  return "(?<matched>(?i:" + inner + "))";
}

/**
 * `{sender}` -> `{{sender}}` etc. in one pass, so a replacement's output is never
 * rescanned (today's `renderReplyTemplate` used `split/join` for the same reason).
 * Only called for a non-blank template: an empty one has no send node at all.
 */
function buildReplyTemplate(template: string): string {
  return template.replace(/\{(sender|body|matched)\}/g, (_, name: string) => `{{${name}}}`);
}

/**
 * `*` -> `.*`, `?` -> `.`, everything else escaped, anchored so a glob describes
 * the whole sender rather than any substring.
 */
function globToPattern(glob: string): string {
  let pattern = "^";
  for (const char of glob) {
    if (char === "*") pattern += ".*";
    else if (char === "?") pattern += ".";
    else pattern += escapeRegExp(char);
  }
  return pattern + "$";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Evaluate every rule in the order given (the caller sorts `priority DESC, id`).
 *
 * All rules are evaluated rather than stopping at the first match because the test
 * endpoint must explain every rule. For the reply path the caller simply takes the
 * first `matched` entry, which is the same precedence.
 *
 * Compilation and execution happen one rule at a time: `runFlow` shares a single
 * WASM memory per isolate, so the calls must not overlap.
 */
export async function evaluateRules(
  rules: RuleRecord[],
  input: EvaluateInput,
  opts: EvaluateOptions
): Promise<RuleEvaluation[]> {
  const hits = opts.dryRun ? [] : opts.hits ?? [];
  const stats = summarizeHits(hits, opts.deviceId, opts.now);
  const evaluations: RuleEvaluation[] = [];

  for (const rule of rules) {
    if (!rule.enabled) {
      evaluations.push(evaluation(rule, false, "disabled", "", ""));
      continue;
    }

    if (rule.device_id !== null && rule.device_id !== opts.deviceId) {
      evaluations.push(evaluation(rule, false, "device_mismatch", "", ""));
      continue;
    }

    const built = compileCached(rule);
    if (!built.ok) {
      // Unreachable for rows saved after this change (save compiles them), but one
      // bad legacy row must not 500 an entire inbound batch.
      console.error(`[rules] rule ${rule.id} cannot compile: ${built.reason}`);
      evaluations.push(evaluation(rule, false, "sender_mismatch", "", ""));
      continue;
    }

    const result = await runFlow(built.graph, {
      sender: input.peer,
      body: input.body,
      received_at: opts.now,
    });

    if (result.outcome === "error") {
      console.error(`[rules] rule ${rule.id} flow error: ${String(result.error)}`);
      evaluations.push(evaluation(rule, false, "body_mismatch", "", ""));
      continue;
    }

    const matchedText = result.variables.matched ?? "";
    const rejected = result.steps.find((step) =>
      step.node_id === "reject_sender" ||
      step.node_id === "reject_body" ||
      step.node_id === "reject_shortcode"
    );

    if (rejected !== undefined) {
      const reason: RuleReason =
        rejected.node_id === "reject_sender"
          ? "sender_mismatch"
          : rejected.node_id === "reject_body"
            ? "body_mismatch"
            : "shortcode_blocked";
      evaluations.push(evaluation(rule, false, reason, matchedText, ""));
      continue;
    }

    if (!opts.dryRun) {
      const ruleStats = stats.get(rule.id);

      if (
        rule.cooldown_s > 0 &&
        ruleStats !== undefined &&
        opts.now - ruleStats.lastHit < rule.cooldown_s * 1000
      ) {
        evaluations.push(evaluation(rule, false, "cooldown", matchedText, ""));
        continue;
      }

      // No hits is a count of zero: `max_per_hour = 0` must block even the first
      // reply, not just later ones.
      const hitsLastHour = ruleStats?.hitsLastHour ?? 0;
      if (hitsLastHour >= Math.max(0, rule.max_per_hour)) {
        evaluations.push(evaluation(rule, false, "hourly_cap", matchedText, ""));
        continue;
      }
    }

    evaluations.push(
      evaluation(rule, true, "matched", matchedText, result.actions[0]?.body ?? "")
    );
  }

  return evaluations;
}

function evaluation(
  rule: RuleRecord,
  matched: boolean,
  reason: RuleReason,
  matchedText: string,
  replyBody: string
): RuleEvaluation {
  return {
    rule_id: rule.id,
    name: rule.name,
    matched,
    reason,
    matched_text: matchedText,
    reply_body: replyBody,
    rule,
  };
}

interface HitStats {
  lastHit: number;
  hitsLastHour: number;
}

/** One pass over the history, then O(1) per rule regardless of message count. */
function summarizeHits(
  hits: RuleHit[],
  deviceId: string,
  now: number
): Map<string, HitStats> {
  const stats = new Map<string, HitStats>();
  for (const hit of hits) {
    if (hit.device_id !== deviceId) continue;
    const current = stats.get(hit.rule_id) ?? { lastHit: 0, hitsLastHour: 0 };
    current.lastHit = Math.max(current.lastHit, hit.replied_at);
    if (now - hit.replied_at < HOUR_MS) current.hitsLastHour += 1;
    stats.set(hit.rule_id, current);
  }
  return stats;
}
