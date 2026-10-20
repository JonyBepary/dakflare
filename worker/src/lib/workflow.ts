/**
 * Workflow graph contract — validation only.
 *
 * WHY THIS MODULE EXISTS
 * The dashboard is getting a canvas (SvelteFlow) for multi-step message
 * processing. `rules` is a flat matcher -> reply, so it cannot represent a graph.
 * `workflows.graph` stores the canvas document as JSON, and this module is the
 * single definition of what a storable graph is.
 *
 * It is deliberately a PURE function with no I/O: the route layer stores whatever
 * this returns and unit tests can call it directly without D1, a Worker or a
 * Request. It NEVER throws — untrusted input produces issues, not exceptions —
 * and issues carry a JSON-path-ish `path` (`nodes[2].data.pattern`) so the canvas
 * can highlight the offending field.
 *
 * There is no execution engine in this change. A valid graph is stored and
 * returned; nothing interprets it yet.
 *
 * REGEX SAFETY
 * `lintRe2` (lib/re2-compat.ts) is the only linter, and this module never builds a
 * `RegExp` from an untrusted pattern. `(?<name>...)` group names are found with a
 * small hand-written scanner that understands escapes and character classes, so
 * `\(?<x>` and `[(?<x>)]` are inert text rather than captures.
 */

import {
  MAX_WORKFLOW_EDGES,
  MAX_WORKFLOW_GRAPH_BYTES,
  MAX_WORKFLOW_NODES,
} from "./config";
import { lintRe2 } from "./re2-compat";

/** The `path` of an issue, e.g. `nodes[2].data.pattern`. The root is `""`. */
export interface WorkflowIssue {
  path: string;
  message: string;
}

export type WorkflowNodeType = "trigger" | "extract" | "condition" | "send_sms" | "stop";

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  position: { x: number; y: number };
  data: Record<string, unknown>;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: "true" | "false";
  label?: string;
}

export interface Graph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export type ValidationResult =
  | { ok: true; graph: Graph }
  | { ok: false; issues: WorkflowIssue[] };

/* ======================================================================== */
/* Limits and shared patterns                                               */
/* ======================================================================== */

/**
 * Node/edge id grammar. The same rule bounds a workflow's own id in the route
 * layer, so a graph is always addressable by exactly the id its document uses.
 */
export const RE_WORKFLOW_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Capture-group names: a Java identifier, but capped at 32 characters total. */
const RE_GROUP_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;

/**
 * Names a template may always use. `extract` nodes add their capture groups on
 * top of these; declaring a group with one of these names is therefore rejected.
 */
const BUILTIN_TEMPLATE_NAMES = ["sender", "body", "received_at"] as const;
const RESERVED_GROUP_NAMES = new Set<string>(BUILTIN_TEMPLATE_NAMES);

const NODE_TYPES = new Set<string>(["trigger", "extract", "condition", "send_sms", "stop"]);
const TRIGGER_KINDS = new Set<string>(["incoming"]);
const SENDER_MODES = ["any", "exact", "prefix", "regex"] as const;
const BODY_MODES = ["any", "keyword", "regex"] as const;
const CONDITION_OPS = new Set<string>(["equals", "not_equals", "contains", "matches", "exists"]);
const EXTRACT_SOURCES = new Set<string>(["body", "sender"]);
const EXTRACT_FLAGS = new Set<string>(["", "i"]);

/** `name` bound, shared with the route layer so both agree on one number. */
export const MAX_WORKFLOW_NAME_CHARS = 120;
const MAX_SMS_TO_CHARS = 32;
const MAX_SMS_BODY_CHARS = 4_096;

/**
 * How many issues are reported per call. A canvas that is off by a whole rewrite
 * would otherwise return a megabyte of diagnostics; the first 50 are plenty to
 * show what is wrong, and the cap keeps the response cheap.
 */
const MAX_ISSUES = 50;

/* ======================================================================== */
/* Small helpers                                                            */
/* ======================================================================== */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  // Objects from JSON.parse have Object.prototype (or null when created with
  // Object.create(null)). A class instance, Date, Map, etc. is not a graph part.
  return proto === Object.prototype || proto === null;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * `JSON.stringify` that cannot throw. Unreachable through the route (the body is
 * already JSON.parse'd), but this module is a public pure function and a caller
 * with a cyclic object or a BigInt must still get issues, not an exception.
 */
function safeStringify(value: unknown): string | null {
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

interface IssueCollector {
  issues: WorkflowIssue[];
  add(path: string, message: string): void;
}

function createCollector(): IssueCollector {
  const issues: WorkflowIssue[] = [];
  return {
    issues,
    add(path, message) {
      if (issues.length >= MAX_ISSUES) return;
      issues.push({ path, message });
    },
  };
}

function fail(collector: IssueCollector): { ok: false; issues: WorkflowIssue[] } {
  return { ok: false, issues: collector.issues };
}

/* ======================================================================== */
/* Named capture groups and templates                                       */
/* ======================================================================== */

/**
 * Capture-group names declared by a pattern, written by hand so no `RegExp` is
 * ever built from the pattern.
 *
 * Understands the two forms `lintRe2` accepts — `(?<name>` and `(?P<name>` — and
 * skips escaped characters and bracketed character classes, so `\(?<x>` is not a
 * group and `[(?<x>)]` is a class of punctuation, not a capture. Names are
 * returned verbatim; validity is checked by the caller.
 */
function namedGroupNames(pattern: string): string[] {
  const names: string[] = [];
  let i = 0;

  while (i < pattern.length) {
    const ch = pattern[i];

    if (ch === "\\") {
      i += 2;
      continue;
    }

    if (ch === "[") {
      let j = i + 1;
      if (pattern[j] === "^") j++;
      if (pattern[j] === "]") j++;
      while (j < pattern.length) {
        if (pattern[j] === "\\") {
          j += 2;
          continue;
        }
        if (pattern[j] === "]") {
          j++;
          break;
        }
        j++;
      }
      i = j;
      continue;
    }

    if (ch === "(" && pattern[i + 1] === "?") {
      let p = i + 2;
      if (pattern[p] === "P") p++;
      if (pattern[p] === "<" && pattern[p + 1] !== "=" && pattern[p + 1] !== "!") {
        p++;
        const start = p;
        while (p < pattern.length && pattern[p] !== ">") p++;
        if (pattern[p] === ">") names.push(pattern.slice(start, p));
      }
    }

    i++;
  }

  return names;
}

/**
 * Every `{{name}}` in a template must name a builtin or a declared capture group.
 *
 * Whitespace inside the braces is tolerated (`{{ sender }}`) because that is a
 * formatting choice, not a different template language; the name itself is
 * matched exactly. An opening `{{` with no `}}` is also an error: silently
 * shipping it would send the literal braces to a phone.
 */
function checkTemplate(
  value: string,
  path: string,
  allowed: Set<string>,
  collector: IssueCollector
): void {
  let from = 0;
  for (;;) {
    const open = value.indexOf("{{", from);
    if (open === -1) return;
    const close = value.indexOf("}}", open + 2);
    if (close === -1) {
      collector.add(path, "unterminated '{{' template");
      return;
    }
    const name = value.slice(open + 2, close).trim();
    if (!allowed.has(name)) {
      collector.add(path, `unknown template name '{{${name}}}'`);
    }
    from = close + 2;
  }
}

/* ======================================================================== */
/* Node data validation                                                     */
/* ======================================================================== */

interface MatcherModeConfig {
  path: string;
  modes: readonly string[];
}

/** Validate a `{ mode, value? }` matcher object (`sender` / `body`). */
function validateModeSpec(
  value: unknown,
  config: MatcherModeConfig,
  collector: IssueCollector
): void {
  const { path } = config;
  if (!isPlainObject(value)) {
    collector.add(path, "must be an object");
    return;
  }

  const mode = value.mode;
  if (typeof mode !== "string" || !config.modes.includes(mode)) {
    collector.add(`${path}.mode`, `must be one of ${config.modes.join(", ")}`);
    return;
  }

  // `any` needs no value. Every other mode needs a non-empty one.
  if (mode === "any") return;

  const raw = value.value;
  if (typeof raw !== "string" || raw.length === 0) {
    collector.add(`${path}.value`, "is required and must be a non-empty string");
    return;
  }

  // Every regex-valued field goes through the one RE2 linter. There is no second
  // regex implementation here and no `new RegExp(pattern)` anywhere.
  if (mode === "regex") {
    const reason = lintRe2(raw);
    if (reason !== null) collector.add(`${path}.value`, `regex rejected: ${reason}`);
  }
}

interface NodeScanContext {
  /** Capture-group name -> index of the extract node that first declared it. */
  groupOwners: Map<string, number>;
  /** Strings whose `{{...}}` templates must be checked after every node is seen. */
  templates: Array<{ path: string; value: string }>;
}

/** Validate one node's `data` for its declared type; returns the normalized data. */
function validateNodeData(
  type: WorkflowNodeType,
  raw: unknown,
  index: number,
  context: NodeScanContext,
  collector: IssueCollector
): Record<string, unknown> {
  const base = `nodes[${index}].data`;

  if (!isPlainObject(raw)) {
    collector.add(base, "must be an object");
    return {};
  }

  switch (type) {
    case "trigger":
      validateTriggerData(raw, base, collector);
      break;
    case "extract":
      validateExtractData(raw, base, index, context, collector);
      break;
    case "condition":
      validateConditionData(raw, base, context, collector);
      break;
    case "send_sms":
      validateSendSmsData(raw, base, context, collector);
      break;
    case "stop":
      if (raw.reason !== undefined && typeof raw.reason !== "string") {
        collector.add(`${base}.reason`, "must be a string");
      }
      break;
  }

  return raw;
}

function validateTriggerData(
  data: Record<string, unknown>,
  base: string,
  collector: IssueCollector
): void {
  if (typeof data.kind !== "string" || !TRIGGER_KINDS.has(data.kind)) {
    collector.add(`${base}.kind`, "must be 'incoming'");
  }

  if (data.sender !== undefined) {
    validateModeSpec(data.sender, { path: `${base}.sender`, modes: SENDER_MODES }, collector);
  }

  if (data.body !== undefined) {
    validateModeSpec(data.body, { path: `${base}.body`, modes: BODY_MODES }, collector);
  }
}

function validateExtractData(
  data: Record<string, unknown>,
  base: string,
  index: number,
  context: NodeScanContext,
  collector: IssueCollector
): void {
  const source = data.source;
  if (typeof source !== "string" || !EXTRACT_SOURCES.has(source)) {
    collector.add(`${base}.source`, "must be 'body' or 'sender'");
  }

  if (data.flags !== undefined) {
    if (typeof data.flags !== "string" || !EXTRACT_FLAGS.has(data.flags)) {
      collector.add(`${base}.flags`, "must be '' or 'i'");
    }
  }

  const pattern = data.pattern;
  if (typeof pattern !== "string") {
    collector.add(`${base}.pattern`, "must be a string");
    return;
  }

  const reason = lintRe2(pattern);
  if (reason !== null) collector.add(`${base}.pattern`, `regex rejected: ${reason}`);

  // RE2 also spells a named group `(?P<name>...)`, but the runtime that evaluates
  // these graphs is JavaScript, whose `RegExp` does not. Accepting the Go/RE2
  // spelling would store a pattern that validates here and throws at execution
  // time, so reject it now with a message that names the fix.
  if (/\(\?P</.test(pattern)) {
    collector.add(
      `${base}.pattern`,
      "use JavaScript named-group syntax (?<name>...); (?P<name>...) is not supported"
    );
  }

  const names = namedGroupNames(pattern);
  if (names.length === 0) {
    collector.add(`${base}.pattern`, "must declare at least one named group, e.g. (?<order>[0-9]+)");
    return;
  }

  const seenInPattern = new Set<string>();
  for (const name of names) {
    if (!RE_GROUP_NAME.test(name)) {
      collector.add(
        `${base}.pattern`,
        `invalid capture group name '${name}' (must match ^[A-Za-z_][A-Za-z0-9_]{0,31}$)`
      );
      continue;
    }

    if (RESERVED_GROUP_NAMES.has(name)) {
      collector.add(`${base}.pattern`, `capture group '${name}' is reserved`);
      continue;
    }

    if (seenInPattern.has(name)) {
      collector.add(`${base}.pattern`, `duplicate capture group '${name}' within one pattern`);
      continue;
    }
    seenInPattern.add(name);

    const owner = context.groupOwners.get(name);
    if (owner !== undefined) {
      collector.add(
        `${base}.pattern`,
        `duplicate capture group '${name}' (already declared at nodes[${owner}].data.pattern)`
      );
      continue;
    }
    context.groupOwners.set(name, index);
  }
}

function validateConditionData(
  data: Record<string, unknown>,
  base: string,
  context: NodeScanContext,
  collector: IssueCollector
): void {
  if (typeof data.left !== "string") {
    collector.add(`${base}.left`, "is required and must be a string");
  } else {
    context.templates.push({ path: `${base}.left`, value: data.left });
  }

  const op = data.op;
  if (typeof op !== "string" || !CONDITION_OPS.has(op)) {
    collector.add(`${base}.op`, "must be one of equals, not_equals, contains, matches, exists");
    return;
  }

  if (op === "exists") return;

  if (typeof data.right !== "string") {
    collector.add(`${base}.right`, `is required for op '${op}' and must be a string`);
    return;
  }

  context.templates.push({ path: `${base}.right`, value: data.right });

  if (op === "matches") {
    const reason = lintRe2(data.right);
    if (reason !== null) collector.add(`${base}.right`, `regex rejected: ${reason}`);
  }
}

function validateSendSmsData(
  data: Record<string, unknown>,
  base: string,
  context: NodeScanContext,
  collector: IssueCollector
): void {
  const to = data.to;
  if (typeof to !== "string") {
    collector.add(`${base}.to`, "is required and must be a string");
  } else {
    if (to.length === 0) collector.add(`${base}.to`, "must not be empty");
    if (to.length > MAX_SMS_TO_CHARS) {
      collector.add(`${base}.to`, `must be at most ${MAX_SMS_TO_CHARS} characters`);
    }
    context.templates.push({ path: `${base}.to`, value: to });
  }

  const body = data.body;
  if (typeof body !== "string") {
    collector.add(`${base}.body`, "is required and must be a string");
  } else {
    if (body.length === 0) collector.add(`${base}.body`, "must not be empty");
    if (body.length > MAX_SMS_BODY_CHARS) {
      collector.add(`${base}.body`, `must be at most ${MAX_SMS_BODY_CHARS} characters`);
    }
    context.templates.push({ path: `${base}.body`, value: body });
  }
}

/* ======================================================================== */
/* Edge validation                                                          */
/* ======================================================================== */

interface ParsedEdge {
  index: number;
  edge: WorkflowEdge;
  /** True when source/target both resolved to a node in the graph. */
  resolves: boolean;
}

/**
 * Validate edge shape, ids and endpoint references.
 *
 * `knownNodes` maps a valid node id to its type so the sourceHandle rule can be
 * enforced here: a handle is meaningful only on a condition's outgoing edge.
 */
function validateEdges(
  raw: unknown,
  knownNodes: Map<string, WorkflowNodeType>,
  collector: IssueCollector
): ParsedEdge[] {
  if (!Array.isArray(raw)) {
    collector.add("edges", "must be an array");
    return [];
  }

  if (raw.length > MAX_WORKFLOW_EDGES) {
    collector.add("edges", `must contain at most ${MAX_WORKFLOW_EDGES} edges`);
  }

  const parsed: ParsedEdge[] = [];
  const seenIds = new Map<string, number>();

  raw.forEach((value, index) => {
    const path = `edges[${index}]`;
    if (!isPlainObject(value)) {
      collector.add(path, "must be an object");
      return;
    }

    const id = value.id;
    if (typeof id !== "string" || !RE_WORKFLOW_ID.test(id)) {
      collector.add(`${path}.id`, "must match ^[A-Za-z0-9_-]{1,64}$");
    } else {
      const previous = seenIds.get(id);
      if (previous !== undefined) {
        collector.add(`${path}.id`, `duplicate edge id '${id}' (also used by edges[${previous}])`);
      } else {
        seenIds.set(id, index);
      }
    }

    const source = value.source;
    const target = value.target;
    if (typeof source !== "string" || source.length === 0) {
      collector.add(`${path}.source`, "must be a non-empty string");
    }
    if (typeof target !== "string" || target.length === 0) {
      collector.add(`${path}.target`, "must be a non-empty string");
    }

    // `sourceHandle` is required iff the source is a condition, and then only
    // "true"/"false". Because that is exactly two values, the wrong value and the
    // wrong node type are the same failure and both point at the handle.
    const handle = value.sourceHandle;
    const sourceType = typeof source === "string" ? knownNodes.get(source) : undefined;
    if (handle !== undefined) {
      if (handle !== "true" && handle !== "false") {
        collector.add(`${path}.sourceHandle`, "must be 'true' or 'false'");
      }
      if (sourceType !== undefined && sourceType !== "condition") {
        collector.add(
          `${path}.sourceHandle`,
          `is only allowed when the source is a condition (source is '${sourceType}')`
        );
      }
    } else if (sourceType === "condition") {
      collector.add(`${path}.sourceHandle`, "is required when the source is a condition");
    }

    const label = value.label;
    if (label !== undefined && typeof label !== "string") {
      collector.add(`${path}.label`, "must be a string");
    }

    const sourceKnown = typeof source === "string" && knownNodes.has(source);
    const targetKnown = typeof target === "string" && knownNodes.has(target);

    if (typeof source === "string" && source !== "" && !sourceKnown) {
      collector.add(`${path}.source`, `references unknown node '${source}'`);
    }
    if (typeof target === "string" && target !== "" && !targetKnown) {
      collector.add(`${path}.target`, `references unknown node '${target}'`);
    }
    if (typeof source === "string" && source === target) {
      collector.add(`${path}.target`, "self-loop: source and target are the same node");
    }

    const edge: WorkflowEdge = {
      id: typeof id === "string" ? id : "",
      source: typeof source === "string" ? source : "",
      target: typeof target === "string" ? target : "",
    };
    if (handle === "true" || handle === "false") edge.sourceHandle = handle;
    if (typeof label === "string") edge.label = label;

    parsed.push({ index, edge, resolves: sourceKnown && targetKnown });
  });

  return parsed;
}

/* ======================================================================== */
/* Structural checks                                                        */
/* ======================================================================== */

function checkStructure(
  nodes: Array<{ index: number; id: string; type: WorkflowNodeType }>,
  edges: ParsedEdge[],
  collector: IssueCollector
): void {
  const outgoing = new Map<string, ParsedEdge[]>();
  const incoming = new Map<string, ParsedEdge[]>();
  for (const edge of edges) {
    if (!edge.resolves) continue;
    const sourceList = outgoing.get(edge.edge.source);
    if (sourceList) sourceList.push(edge);
    else outgoing.set(edge.edge.source, [edge]);

    const targetList = incoming.get(edge.edge.target);
    if (targetList) targetList.push(edge);
    else incoming.set(edge.edge.target, [edge]);
  }

  const triggers = nodes.filter((node) => node.type === "trigger");
  if (triggers.length !== 1) {
    collector.add(
      "nodes",
      `graph must contain exactly one trigger node (found ${triggers.length})`
    );
  }

  for (const node of nodes) {
    const path = `nodes[${node.index}]`;
    const outs = outgoing.get(node.id) ?? [];

    switch (node.type) {
      case "trigger": {
        const ins = incoming.get(node.id) ?? [];
        for (const edge of ins) {
          collector.add(
            `edges[${edge.index}].target`,
            "the trigger node must not have incoming edges"
          );
        }
        if (outs.length !== 1) {
          collector.add(path, `trigger node must have exactly 1 outgoing edge (found ${outs.length})`);
        }
        break;
      }
      case "extract":
      case "send_sms": {
        if (outs.length !== 1) {
          collector.add(
            path,
            `${node.type} node must have exactly 1 outgoing edge (found ${outs.length})`
          );
        }
        break;
      }
      case "condition": {
        if (outs.length !== 2) {
          collector.add(
            path,
            `condition node must have exactly 2 outgoing edges (found ${outs.length})`
          );
        }
        const handles = new Set(outs.map((edge) => edge.edge.sourceHandle));
        if (!(handles.size === 2 && handles.has("true") && handles.has("false"))) {
          collector.add(path, "condition node needs one 'true' and one 'false' outgoing edge");
        }
        break;
      }
      case "stop": {
        if (outs.length !== 0) {
          collector.add(path, `stop node must not have outgoing edges (found ${outs.length})`);
        }
        break;
      }
    }
  }

  checkAcyclic(nodes, outgoing, collector);
  checkReachability(nodes, triggers, outgoing, collector);
}

/**
 * Depth-first cycle detection over valid edges.
 *
 * Iterative rather than recursive so the walk depth is bounded by heap, not by
 * the host's stack, even for a pathologically large (over-limit) node list. Only
 * the first back edge is reported: one cycle is enough to reject the graph, and a
 * second message would just be noise.
 */
function checkAcyclic(
  nodes: Array<{ index: number; id: string; type: WorkflowNodeType }>,
  outgoing: Map<string, ParsedEdge[]>,
  collector: IssueCollector
): void {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  let reported = false;

  for (const node of nodes) {
    if (reported) return;
    if ((color.get(node.id) ?? WHITE) !== WHITE) continue;

    color.set(node.id, GRAY);
    const stack: Array<{ id: string; next: number }> = [{ id: node.id, next: 0 }];

    while (stack.length > 0 && !reported) {
      const top = stack[stack.length - 1];
      const outs = outgoing.get(top.id) ?? [];

      if (top.next >= outs.length) {
        color.set(top.id, BLACK);
        stack.pop();
        continue;
      }

      const edge = outs[top.next];
      top.next += 1;

      // Self-loops are already reported as their own error; treating one as a
      // cycle here would double-report the same edge.
      if (edge.edge.source === edge.edge.target) continue;

      const state = color.get(edge.edge.target) ?? WHITE;
      if (state === GRAY) {
        collector.add(`edges[${edge.index}]`, "cycle detected in workflow graph");
        reported = true;
        break;
      }
      if (state === WHITE) {
        color.set(edge.edge.target, GRAY);
        stack.push({ id: edge.edge.target, next: 0 });
      }
    }
  }
}

/**
 * Every node must be reachable from the trigger, otherwise it can never run.
 *
 * Skipped when there is not exactly one trigger: `checkStructure` already
 * reported that, and picking an arbitrary root would add misleading
 * "unreachable" noise on a graph that is broken for a different reason.
 */
function checkReachability(
  nodes: Array<{ index: number; id: string; type: WorkflowNodeType }>,
  triggers: Array<{ index: number; id: string; type: WorkflowNodeType }>,
  outgoing: Map<string, ParsedEdge[]>,
  collector: IssueCollector
): void {
  if (triggers.length !== 1) return;

  const root = triggers[0].id;
  const reached = new Set<string>([root]);
  const queue: string[] = [root];

  // Index cursor instead of `shift()`: a 50-node graph is small, but this function
  // also runs on an over-limit graph (where the count issue is already reported),
  // and `shift()` would make that walk quadratic for no reason.
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head];
    for (const edge of outgoing.get(id) ?? []) {
      if (edge.edge.source === edge.edge.target) continue;
      if (reached.has(edge.edge.target)) continue;
      reached.add(edge.edge.target);
      queue.push(edge.edge.target);
    }
  }

  for (const node of nodes) {
    if (!reached.has(node.id)) {
      collector.add(`nodes[${node.index}]`, "node is not reachable from the trigger");
    }
  }
}

/* ======================================================================== */
/* Entry point                                                             */
/* ======================================================================== */

/**
 * Validate and normalise a workflow graph.
 *
 * Returns either `{ ok: true, graph }` with a fresh, contract-shaped copy — extra
 * keys on nodes/edges (SvelteFlow adds `measured`, `selected`, `dragging`, …) are
 * dropped from the envelope but its `data` object is preserved — or
 * `{ ok: false, issues }` with at most 50 paths. It never throws.
 */
export function validateWorkflowGraph(raw: unknown): ValidationResult {
  const collector = createCollector();

  if (!isPlainObject(raw)) {
    collector.add("", "graph must be an object");
    return fail(collector);
  }

  // Size is measured on the document as submitted, not on the normalised copy:
  // the cap exists to bound what a client can send and what D1 must store.
  const serialized = safeStringify(raw);
  if (serialized === null) {
    collector.add("", "graph must be JSON-serializable");
  } else {
    const bytes = utf8Bytes(serialized);
    if (bytes > MAX_WORKFLOW_GRAPH_BYTES) {
      collector.add("", `graph must be at most ${MAX_WORKFLOW_GRAPH_BYTES} bytes (got ${bytes})`);
    }
  }

  const context: NodeScanContext = { groupOwners: new Map(), templates: [] };
  const normalizedNodes: WorkflowNode[] = [];
  const structureNodes: Array<{ index: number; id: string; type: WorkflowNodeType }> = [];
  const knownNodes = new Map<string, WorkflowNodeType>();
  const seenNodeIds = new Map<string, number>();

  const rawNodes = raw.nodes;
  if (!Array.isArray(rawNodes)) {
    collector.add("nodes", "must be an array");
  } else {
    if (rawNodes.length > MAX_WORKFLOW_NODES) {
      collector.add("nodes", `must contain at most ${MAX_WORKFLOW_NODES} nodes`);
    }

    rawNodes.forEach((value, index) => {
      const path = `nodes[${index}]`;
      if (!isPlainObject(value)) {
        collector.add(path, "must be an object");
        return;
      }

      const rawId = value.id;
      let id = "";
      if (typeof rawId !== "string" || !RE_WORKFLOW_ID.test(rawId)) {
        collector.add(`${path}.id`, "must match ^[A-Za-z0-9_-]{1,64}$");
      } else {
        const previous = seenNodeIds.get(rawId);
        if (previous !== undefined) {
          collector.add(`${path}.id`, `duplicate node id '${rawId}' (also used by nodes[${previous}])`);
        } else {
          seenNodeIds.set(rawId, index);
          id = rawId;
        }
      }

      const rawType = value.type;
      let type: WorkflowNodeType | null = null;
      if (typeof rawType !== "string" || !NODE_TYPES.has(rawType)) {
        collector.add(`${path}.type`, "must be one of trigger, extract, condition, send_sms, stop");
      } else {
        type = rawType as WorkflowNodeType;
      }

      const rawPosition = value.position;
      let x = 0;
      let y = 0;
      if (!isPlainObject(rawPosition)) {
        collector.add(`${path}.position`, "must be an object with finite x and y");
      } else {
        if (typeof rawPosition.x !== "number" || !Number.isFinite(rawPosition.x)) {
          collector.add(`${path}.position.x`, "must be a finite number");
        } else {
          x = rawPosition.x;
        }
        if (typeof rawPosition.y !== "number" || !Number.isFinite(rawPosition.y)) {
          collector.add(`${path}.position.y`, "must be a finite number");
        } else {
          y = rawPosition.y;
        }
      }

      const data = type
        ? validateNodeData(type, value.data, index, context, collector)
        : isPlainObject(value.data)
          ? value.data
          : {};

      if (type) {
        normalizedNodes.push({ id, type, position: { x, y }, data });
        // Structural checks need a unique id; a duplicate would give two nodes the
        // same adjacency key, so it is left out and the duplicate is the error.
        if (id !== "" && seenNodeIds.get(id) === index) {
          structureNodes.push({ index, id, type });
          knownNodes.set(id, type);
        }
      }
    });
  }

  // Templates depend on the capture groups of EVERY extract node, so they are
  // checked only after the whole node list has been scanned.
  if (context.templates.length > 0) {
    const allowed = new Set<string>(BUILTIN_TEMPLATE_NAMES);
    for (const name of context.groupOwners.keys()) allowed.add(name);
    for (const template of context.templates) {
      checkTemplate(template.value, template.path, allowed, collector);
    }
  }

  const parsedEdges = validateEdges(raw.edges, knownNodes, collector);

  if (Array.isArray(rawNodes)) {
    checkStructure(structureNodes, parsedEdges, collector);
  }

  if (collector.issues.length > 0) return fail(collector);

  return {
    ok: true,
    graph: {
      nodes: normalizedNodes,
      edges: parsedEdges.map((entry) => entry.edge),
    },
  };
}
