/**
 * Pure rule evaluation — PROTOCOL_CONTRACT_V5 §11.11.
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
 */

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
 * Evaluate every rule in the order given (the caller sorts `priority DESC, id`).
 *
 * All rules are evaluated rather than stopping at the first match because the test
 * endpoint must explain every rule. For the reply path the caller simply takes the
 * first `matched` entry, which is the same precedence.
 */
export function evaluateRules(
  rules: RuleRecord[],
  input: EvaluateInput,
  opts: EvaluateOptions
): RuleEvaluation[] {
  const hits = opts.dryRun ? [] : opts.hits ?? [];
  const stats = summarizeHits(hits, opts.deviceId, opts.now);
  const digitCount = countDigits(input.peer);
  // An alphanumeric mask ("MyBank", "VERIFY") is never a routable reply target.
  const maskedSender = /[A-Za-z]/.test(input.peer);

  return rules.map((rule) => {
    if (!rule.enabled) return evaluation(rule, false, "disabled", "");

    if (rule.device_id !== null && rule.device_id !== opts.deviceId) {
      return evaluation(rule, false, "device_mismatch", "");
    }

    if (maskedSender || !matchSender(rule.matcher_type, rule.matcher_value, input.peer)) {
      return evaluation(rule, false, "sender_mismatch", "");
    }

    const matchedText = matchBody(rule.body_type, rule.body_value, input.body);
    if (matchedText === null) {
      return evaluation(rule, false, "body_mismatch", "");
    }

    // A digits-only sender shorter than a full number is a shortcode. Replying to
    // one can be billable, so it is opt-in per rule.
    if (!rule.allow_shortcode && !maskedSender && digitCount < 10) {
      return evaluation(rule, false, "shortcode_blocked", matchedText);
    }

    if (!opts.dryRun) {
      const ruleStats = stats.get(rule.id);

      if (
        rule.cooldown_s > 0 &&
        ruleStats !== undefined &&
        opts.now - ruleStats.lastHit < rule.cooldown_s * 1000
      ) {
        return evaluation(rule, false, "cooldown", matchedText);
      }

      // No hits is a count of zero: `max_per_hour = 0` must block even the first
      // reply, not just later ones.
      const hitsLastHour = ruleStats?.hitsLastHour ?? 0;
      if (hitsLastHour >= Math.max(0, rule.max_per_hour)) {
        return evaluation(rule, false, "hourly_cap", matchedText);
      }
    }

    return evaluation(rule, true, "matched", matchedText);
  });
}

function evaluation(
  rule: RuleRecord,
  matched: boolean,
  reason: RuleReason,
  matchedText: string
): RuleEvaluation {
  return {
    rule_id: rule.id,
    name: rule.name,
    matched,
    reason,
    matched_text: matchedText,
    rule,
  };
}

function countDigits(value: string): number {
  const digits = value.match(/\d/g);
  return digits === null ? 0 : digits.length;
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

function matchSender(type: string, value: string, peer: string): boolean {
  switch (type) {
    case "exact":
      return peer === value;
    case "prefix":
      return peer.startsWith(value);
    case "suffix":
      return peer.endsWith(value);
    case "glob":
      return safeTest(() => globToRegExp(value), peer);
    case "regex":
      return safeTest(() => new RegExp(value), peer);
    default:
      return false;
  }
}

/**
 * `*` -> `.*`, `?` -> `.`, everything else escaped, anchored so a glob describes
 * the whole sender rather than any substring.
 */
function globToRegExp(glob: string): RegExp {
  let pattern = "^";
  for (const char of glob) {
    if (char === "*") pattern += ".*";
    else if (char === "?") pattern += ".";
    else pattern += escapeRegExp(char);
  }
  return new RegExp(pattern + "$");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Returns the text that matched, or `null` when the matcher does not match.
 * Body matchers are case-insensitive by contract; sender matchers are not.
 */
function matchBody(type: string, value: string, body: string): string | null {
  switch (type) {
    case "keyword": {
      const index = body.toLowerCase().indexOf(value.toLowerCase());
      return index === -1 ? null : body.slice(index, index + value.length);
    }
    case "regex": {
      const match = safeExec(() => new RegExp(value, "i"), body);
      return match === null ? null : match[0];
    }
    default:
      return null;
  }
}

/**
 * Compile-and-run in one try/catch. The constructor itself can throw for a
 * pattern that slipped past the RE2 linter (or was written before it existed),
 * and that must be a no-match rather than a 500 on an inbound batch.
 */
function safeTest(compile: () => RegExp, value: string): boolean {
  try {
    return compile().test(value);
  } catch {
    return false;
  }
}

function safeExec(compile: () => RegExp, value: string): RegExpExecArray | null {
  try {
    return compile().exec(value);
  } catch {
    return null;
  }
}

/**
 * Render a rule's reply template. Substitution uses split/join (not `replace`)
 * so a `$` in a message body or a sender cannot be read as a replacement pattern.
 */
export function renderReplyTemplate(
  template: string,
  values: { sender: string; body: string; matched: string }
): string {
  return template
    .split("{sender}")
    .join(values.sender)
    .split("{body}")
    .join(values.body)
    .split("{matched}")
    .join(values.matched);
}
