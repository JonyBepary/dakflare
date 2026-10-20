/**
 * RE2 compatibility linter — PROTOCOL_CONTRACT_V5 Rev C §7.
 *
 * §7.1: the rule language is RE2 semantics on BOTH sides. Rules are compiled on
 * the device by `com.google.re2j.Pattern`, which is linear-time and therefore
 * immune to backtracking ReDoS by construction. The server linter's job is
 * therefore COMPATIBILITY, not ReDoS defence: it must reject everything RE2/J
 * cannot compile so that the phone is never the first place a rule is validated.
 *
 * Rev B shipped three string regexes (`/\\[1-9]/`, `/\(\?<[=!]/`,
 * `/\([^()]*[*+][^()]*\)[*+{]/`) and was wrong in three ways:
 *   1. it let lookahead, lookbehind-behind negation, possessive quantifiers and
 *      atomic groups through;
 *   2. its nested-quantifier pattern could not cross a nested paren, so
 *      `((a+))+` was accepted — the exact case the check exists for;
 *   3. it never looked at overlapping alternation at all.
 *
 * This module does a real single-pass scan with a group stack, so "at any
 * nesting depth" means any nesting depth.
 */

/** A counted quantifier: `{n}`, `{n,}` or `{n,m}`. */
const RE_COUNTED_QUANTIFIER = /^\{\d+(,\d*)?\}/;

/** Java-style inline flag setter with no body, e.g. `(?i)` — a zero-width atom. */
const RE_FLAG_SETTER = /^\(\?[aiLmsux-]*\)/;

/** Inline flag scope `(?i:...)` — opens a group. */
const RE_FLAG_SCOPE = /^\(\?[aiLmsux-]*:/;

/** Named group `(?<name>...)` / `(?P<name>...)` — supported by RE2, opens a group. */
const RE_NAMED_GROUP = /^\(\?P?<[A-Za-z_][A-Za-z0-9_]*>/;

interface GroupFrame {
  /** Index of the opening `(`. */
  start: number;
  /** Index of the first character of the group body. */
  bodyStart: number;
  /** Index of the closing `)`, filled in when the frame is popped. */
  end: number;
  /** Positions of top-level `|` within this group. */
  pipes: number[];
  /** True when this group's body contains a quantifier at any depth. */
  containsQuantifier: boolean;
  /** Nested group frames, so a quantified group can be asked about descendants. */
  children: GroupFrame[];
}

function collectDescendants(frame: GroupFrame, out: GroupFrame[]): void {
  for (const child of frame.children) {
    out.push(child);
    collectDescendants(child, out);
  }
}

/** The group's top-level alternatives, in source order. */
function branchesOf(source: string, frame: GroupFrame): string[] {
  const cuts = [...frame.pipes, frame.end];
  const parts: string[] = [];
  let from = frame.bodyStart;
  for (const cut of cuts) {
    parts.push(source.slice(from, cut));
    from = cut + 1;
  }
  return parts;
}

/**
 * §7.1: "overlapping alternation under a quantifier — `(a|a)+`, `(a|aa)+`".
 * Two branches overlap when one is a prefix of the other: a single input can then
 * be matched by more than one branch, which makes the engine's branch choice
 * observable and hands a backtracking engine an exponential path.
 */
function hasOverlappingAlternation(branches: string[]): boolean {
  if (branches.length < 2) return false;
  const normalized = branches.map((b) => b.trim());
  for (let i = 0; i < normalized.length; i++) {
    for (let j = 0; j < normalized.length; j++) {
      if (i === j) continue;
      const a = normalized[i];
      const b = normalized[j];
      if (a.length === 0) continue;
      if (b.startsWith(a)) return true;
    }
  }
  return false;
}

/**
 * Lint one pattern for RE2 compatibility.
 *
 * This is the module's single public entry point — `src/routes/rules.ts` calls
 * it and treats any truthy return as a rejection reason.
 *
 * §7.1: this is a pure syntax check. Length caps are enforced at the route
 * layer, not here.
 *
 * @returns `null` when the pattern is acceptable, otherwise a reason string.
 */
export function lintRe2(pattern: string | null | undefined): string | null {
  return scan(pattern);
}

function scan(pattern: string | null | undefined): string | null {
  if (pattern == null) return null;
  if (typeof pattern !== "string") return "pattern must be a string";
  if (pattern.length === 0) return null;

  const source = pattern;
  const stack: GroupFrame[] = [];
  let i = 0;
  let lastWasGroupClose = false;
  let lastClosedGroup: GroupFrame | null = null;

  while (i < source.length) {
    const ch = source[i];

    /* --- escape sequences ---------------------------------------------- */
    if (ch === "\\") {
      const next = source[i + 1];
      if (next === undefined) return "dangling_backslash";
      if (next >= "1" && next <= "9") return "backreference";
      if (next === "k" && (source[i + 2] === "<" || source[i + 2] === "'")) {
        return "backreference";
      }
      if (next === "Q" || next === "E") {
        // Java/PCRE literal quoting; RE2 and RE2/J do not implement it.
        return "unsupported_escape_q_e";
      }
      i += 2;
      lastWasGroupClose = false;
      lastClosedGroup = null;
      continue;
    }

    /* --- character classes: `+` inside is a literal --------------------- */
    if (ch === "[") {
      let j = i + 1;
      if (source[j] === "^") j++;
      if (source[j] === "]") j++;
      let closed = false;
      while (j < source.length) {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === "]") {
          closed = true;
          break;
        }
        j++;
      }
      i = closed ? j + 1 : source.length;
      lastWasGroupClose = false;
      lastClosedGroup = null;
      continue;
    }

    /* --- group open ----------------------------------------------------- */
    if (ch === "(") {
      const rest = source.slice(i);

      // §7.1 explicit rejections. Checked first so `(?<=` is never mistaken
      // for a named group and `(?=` is never treated as a flag setter.
      if (rest.startsWith("(?=") || rest.startsWith("(?!")) return "lookahead";
      if (rest.startsWith("(?<=") || rest.startsWith("(?<!")) return "lookbehind";
      if (rest.startsWith("(?>")) return "atomic_group";
      if (rest.startsWith("(?(")) return "conditional";
      if (rest.startsWith("(?#")) return "comment_group_unsupported";
      if (rest.startsWith("(?R")) return "recursion_unsupported";
      if (rest.startsWith("(?P=") || rest.startsWith("(?P>")) return "backreference";

      const flagSetter = RE_FLAG_SETTER.exec(rest);
      if (flagSetter) {
        i += flagSetter[0].length;
        lastWasGroupClose = false;
        lastClosedGroup = null;
        continue;
      }

      // A plain capturing group `(` has a one-character prefix; the other
      // forms (`(?:`, `(?i:`, `(?<name>`) override bodyStart below.
      let bodyStart = i + 1;
      const named = RE_NAMED_GROUP.exec(rest);
      const flagScope = RE_FLAG_SCOPE.exec(rest);
      if (named) bodyStart = i + named[0].length;
      else if (flagScope) bodyStart = i + flagScope[0].length;
      else if (rest.startsWith("(?:")) bodyStart = i + 3;

      const frame: GroupFrame = {
        start: i,
        bodyStart,
        end: -1,
        pipes: [],
        containsQuantifier: false,
        children: [],
      };
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(frame);
      stack.push(frame);
      i = bodyStart;
      lastWasGroupClose = false;
      lastClosedGroup = null;
      continue;
    }

    /* --- group close ---------------------------------------------------- */
    if (ch === ")") {
      const frame = stack.pop();
      if (frame) {
        frame.end = i;
        if (frame.containsQuantifier) {
          const parent = stack[stack.length - 1];
          if (parent) parent.containsQuantifier = true;
        }
      }
      i++;
      lastWasGroupClose = true;
      lastClosedGroup = frame ?? null;
      continue;
    }

    /* --- alternation ---------------------------------------------------- */
    if (ch === "|") {
      const top = stack[stack.length - 1];
      if (top) top.pipes.push(i);
      i++;
      lastWasGroupClose = false;
      lastClosedGroup = null;
      continue;
    }

    /* --- one-shot quantifiers ------------------------------------------- */
    if (ch === "*" || ch === "+" || ch === "?") {
      if (source[i + 1] === "+") return "possessive_quantifier";
      const problem = onQuantifier(stack, lastWasGroupClose, lastClosedGroup, source);
      if (problem) return problem;
      i += 1;
      lastWasGroupClose = false;
      lastClosedGroup = null;
      continue;
    }

    /* --- counted quantifiers `{n,m}` ------------------------------------ */
    if (ch === "{") {
      const counted = RE_COUNTED_QUANTIFIER.exec(source.slice(i));
      if (!counted) {
        i++;
        lastWasGroupClose = false;
        lastClosedGroup = null;
        continue;
      }
      const end = i + counted[0].length;
      if (source[end] === "+") return "possessive_quantifier";
      const problem = onQuantifier(stack, lastWasGroupClose, lastClosedGroup, source);
      if (problem) return problem;
      i = end;
      lastWasGroupClose = false;
      lastClosedGroup = null;
      continue;
    }

    /* --- ordinary atom --------------------------------------------------- */
    i++;
    lastWasGroupClose = false;
    lastClosedGroup = null;
  }

  if (stack.length > 0) return "unbalanced_group";
  return null;
}

/**
 * Record that a quantifier was applied.
 *
 * Every group still open on the stack now "contains a quantifier" — that single
 * rule is what makes the nested-quantifier check depth-independent, because a
 * quantifier anywhere inside a group marks every enclosing group, however deep.
 *
 * When the quantifier is applied directly to a group, that group (and every
 * group nested inside it) is additionally checked for §7.1's nested quantifier
 * and overlapping alternation.
 */
function onQuantifier(
  stack: GroupFrame[],
  quantifiedGroup: boolean,
  group: GroupFrame | null,
  source: string
): string | null {
  for (const frame of stack) frame.containsQuantifier = true;
  if (!quantifiedGroup || !group) return null;

  if (group.containsQuantifier) return "nested_quantifier";

  const descendants: GroupFrame[] = [];
  collectDescendants(group, descendants);
  for (const candidate of [group, ...descendants]) {
    if (hasOverlappingAlternation(branchesOf(source, candidate))) {
      return "ambiguous_alternation";
    }
  }
  return null;
}
