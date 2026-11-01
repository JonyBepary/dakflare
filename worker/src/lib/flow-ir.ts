/**
 * Canonical Flow IR v2 — the Worker's copy of `simulator/flow/src/ir.rs`.
 *
 * Two implementations of one schema, on purpose: the Worker cannot await a WASM
 * instantiation inside a synchronous route validator, and the handset must
 * validate without the edge. They are kept honest by
 * `test-support/flow-ir-vectors.json`, which both are tested against, so "they
 * agree" is evidence rather than a hope.
 *
 * Read `ir.rs` for the prose. This file deliberately mirrors its structure, in
 * the same order, so a change to one is obvious in the other.
 */

import { lintRe2 } from "./re2-compat";

export const IR_SCHEMA = "dakflare.flow/v2";
export const LAYOUT_ALGORITHM = "rank-v1";

export const MAX_NODES = 200;
export const MAX_EDGES = 400;
export const MAX_ISSUES = 50;
export const MAX_SMS_BODY_CHARS = 4_096;
export const MAX_SMS_TO_CHARS = 32;
export const MAX_DELAY_SECONDS = 300;
export const MAX_TEMPLATE_CHARS = 2_048;

const COL_GAP = 280;
const ROW_GAP = 160;

/** The nine kinds, in the order the palette shows them. */
export const NODE_KINDS = [
  "trigger",
  "extract",
  "set_var",
  "condition",
  "switch",
  "delay",
  "webhook",
  "send_sms",
  "stop",
] as const;

export type NodeKind = (typeof NODE_KINDS)[number];

export const BUILTIN_VARIABLES = ["sender", "body", "received_at"] as const;

export interface Position {
  x: number;
  y: number;
}

export interface IrNode {
  id: string;
  type: NodeKind;
  data: Record<string, unknown>;
}

export interface IrEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string;
  label?: string;
}

export interface UiLayout {
  algorithm: string;
  positions: Record<string, Position>;
}

export interface IrGraph {
  schema: string;
  nodes: IrNode[];
  edges: IrEdge[];
  ui_layout?: UiLayout;
}

export interface IrIssue {
  path: string;
  message: string;
}

export type IrValidation =
  | { ok: true; graph: IrGraph }
  | { ok: false; issues: IrIssue[] };

/* --------------------------------------------------------------- grammar */

export const RE_IR_ID = /^[A-Za-z0-9_-]{1,64}$/;
const RE_VARIABLE = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;

export function isValidVariableName(value: string): boolean {
  return value.length <= 32 && RE_VARIABLE.test(value);
}

/**
 * Named capture groups, scanned so `\(?<x>` and `[(?<x>)]` are inert text.
 * Mirrors `named_groups` in `ir.rs` and `namedGroupNames` in `workflow.ts`.
 */
export function namedGroups(pattern: string): string[] {
  const out: string[] = [];
  let index = 0;
  let inClass = false;

  while (index < pattern.length) {
    const char = pattern[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "[") {
      inClass = true;
      index += 1;
      continue;
    }
    if (char === "]") {
      inClass = false;
      index += 1;
      continue;
    }
    if (char === "(" && !inClass) {
      if (
        pattern[index + 1] === "?" &&
        pattern[index + 2] === "<" &&
        pattern[index + 3] !== "=" &&
        pattern[index + 3] !== "!"
      ) {
        const start = index + 3;
        const end = pattern.indexOf(">", start);
        if (end !== -1) {
          out.push(pattern.slice(start, end));
          index = end;
        }
      }
      index += 1;
      continue;
    }
    index += 1;
  }
  return out;
}

/** `{{ name }}` references, with `vars.` accepted as an alias. */
export function templateNames(template: string): string[] {
  const names: string[] = [];
  let rest = template;
  for (;;) {
    const open = rest.indexOf("{{");
    if (open === -1) break;
    const after = rest.slice(open + 2);
    const close = after.indexOf("}}");
    if (close === -1) break;
    const raw = after.slice(0, close).trim();
    const name = raw.startsWith("vars.") ? raw.slice(5) : raw;
    if (name !== "") names.push(name);
    rest = after.slice(close + 2);
  }
  return names;
}

/* ------------------------------------------------------------- collector */

class Collector {
  readonly issues: IrIssue[] = [];
  add(path: string, message: string): void {
    if (this.issues.length < MAX_ISSUES) this.issues.push({ path, message });
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/* ------------------------------------------------------------- validation */

/** Validate a document and return its canonical form. Never throws. */
export function validateIr(raw: unknown): IrValidation {
  const collector = new Collector();

  if (!isPlainObject(raw)) {
    collector.add("", "graph must be an object");
    return { ok: false, issues: collector.issues };
  }

  const nodesRaw = raw.nodes;
  const edgesRaw = raw.edges;
  if (!Array.isArray(nodesRaw)) {
    collector.add("nodes", "must be an array");
    return { ok: false, issues: collector.issues };
  }
  if (!Array.isArray(edgesRaw)) {
    collector.add("edges", "must be an array");
    return { ok: false, issues: collector.issues };
  }

  if (nodesRaw.length > MAX_NODES) {
    collector.add("nodes", `must contain at most ${MAX_NODES} nodes`);
  }
  if (edgesRaw.length > MAX_EDGES) {
    collector.add("edges", `must contain at most ${MAX_EDGES} edges`);
  }

  /* ---- nodes -------------------------------------------------------- */
  const nodes: IrNode[] = [];
  const kinds = new Map<string, NodeKind>();
  const seenNodes = new Map<string, number>();
  const groupOwner = new Map<string, number>();
  const boundNames = new Map<string, number>();
  const templates: Array<{ name: string; index: number }> = [];
  const legacyPositions = new Map<string, Position>();

  nodesRaw.forEach((value, index) => {
    const path = `nodes[${index}]`;
    if (!isPlainObject(value)) {
      collector.add(path, "must be an object");
      return;
    }

    const rawId = value.id;
    let id = "";
    if (typeof rawId !== "string" || !RE_IR_ID.test(rawId)) {
      collector.add(`${path}.id`, "must match ^[A-Za-z0-9_-]{1,64}$");
    } else {
      const previous = seenNodes.get(rawId);
      if (previous !== undefined) {
        collector.add(
          `${path}.id`,
          `duplicate node id '${rawId}' (also used by nodes[${previous}])`
        );
      } else {
        seenNodes.set(rawId, index);
        id = rawId;
      }
    }

    const rawType = value.type;
    if (typeof rawType !== "string" || !(NODE_KINDS as readonly string[]).includes(rawType)) {
      collector.add(`${path}.type`, `must be one of ${NODE_KINDS.join(", ")}`);
      return;
    }
    const kind = rawType as NodeKind;
    const data = isPlainObject(value.data) ? value.data : {};

    validateNodeData(kind, data, path, index, templates, groupOwner, boundNames, collector);

    if (isPlainObject(value.position)) {
      const x = value.position.x;
      const y = value.position.y;
      if (typeof x === "number" && Number.isFinite(x) && typeof y === "number" && Number.isFinite(y)) {
        legacyPositions.set(id, { x: Math.round(x), y: Math.round(y) });
      }
    }

    if (id !== "" && seenNodes.get(id) === index) kinds.set(id, kind);
    nodes.push({ id, type: kind, data });
  });

  /* ---- edges -------------------------------------------------------- */
  const edges: IrEdge[] = [];
  const seenEdges = new Map<string, number>();

  edgesRaw.forEach((value, index) => {
    const path = `edges[${index}]`;
    if (!isPlainObject(value)) {
      collector.add(path, "must be an object");
      return;
    }

    const rawId = value.id;
    let id = "";
    if (typeof rawId !== "string" || !RE_IR_ID.test(rawId)) {
      collector.add(`${path}.id`, "must match ^[A-Za-z0-9_-]{1,64}$");
    } else {
      const previous = seenEdges.get(rawId);
      if (previous !== undefined) {
        collector.add(
          `${path}.id`,
          `duplicate edge id '${rawId}' (also used by edges[${previous}])`
        );
      } else {
        seenEdges.set(rawId, index);
        id = rawId;
      }
    }

    const source = asString(value.source);
    const target = asString(value.target);
    if (source === "") collector.add(`${path}.source`, "must be a non-empty string");
    else if (!kinds.has(source)) collector.add(`${path}.source`, `references unknown node '${source}'`);
    if (target === "") collector.add(`${path}.target`, "must be a non-empty string");
    else if (!kinds.has(target)) collector.add(`${path}.target`, `references unknown node '${target}'`);
    if (source !== "" && source === target) {
      collector.add(`${path}.target`, "self-loop: source and target are the same node");
    }

    const handle = typeof value.sourceHandle === "string" ? value.sourceHandle : undefined;
    const sourceKind = kinds.get(source);
    if (sourceKind === "condition") {
      if (handle === undefined) {
        collector.add(`${path}.sourceHandle`, "is required when the source is a condition");
      } else if (handle !== "true" && handle !== "false") {
        collector.add(`${path}.sourceHandle`, "must be 'true' or 'false'");
      }
    } else if (sourceKind === "switch") {
      if (handle === undefined) {
        collector.add(`${path}.sourceHandle`, "is required when the source is a switch");
      } else if (!(handle === "default" || /^case:\d+$/.test(handle))) {
        collector.add(`${path}.sourceHandle`, "must be 'case:<index>' or 'default'");
      }
    } else if (sourceKind !== undefined && handle !== undefined) {
      collector.add(
        `${path}.sourceHandle`,
        `is only allowed when the source branches (source is '${sourceKind}')`
      );
    }

    edges.push({
      id,
      source,
      target,
      ...(handle === undefined ? {} : { sourceHandle: handle }),
      ...(typeof value.label === "string" ? { label: value.label } : {}),
    });
  });

  if (collector.issues.length > 0) return { ok: false, issues: collector.issues };

  const graph: IrGraph = { schema: IR_SCHEMA, nodes, edges };
  checkStructure(graph, collector);
  if (collector.issues.length === 0) checkBindings(graph, templates, collector);
  if (collector.issues.length > 0) return { ok: false, issues: collector.issues };

  const computed = layoutIr(graph);
  // A legacy document's own positions win over the computed ones, so re-saving
  // does not shuffle a canvas somebody arranged by hand.
  if (legacyPositions.size === nodes.length && nodes.length > 0) {
    computed.positions = Object.fromEntries(legacyPositions);
  }
  graph.ui_layout = computed;
  return { ok: true, graph };
}

type TemplateSink = Array<{ name: string; index: number }>;

function validateNodeData(
  kind: NodeKind,
  data: Record<string, unknown>,
  path: string,
  index: number,
  templates: TemplateSink,
  groupOwner: Map<string, number>,
  boundNames: Map<string, number>,
  collector: Collector
): void {
  const base = `${path}.data`;

  const template = (value: unknown, at: string): string => {
    if (typeof value !== "string") {
      collector.add(at, "is required and must be a string");
      return "";
    }
    if (value.length > MAX_TEMPLATE_CHARS) {
      collector.add(at, `must be at most ${MAX_TEMPLATE_CHARS} characters`);
      return value;
    }
    for (const name of templateNames(value)) {
      if (!isValidVariableName(name)) {
        collector.add(at, `'{{${name}}}' is not a valid variable name`);
        continue;
      }
      templates.push({ name, index });
    }
    return value;
  };

  switch (kind) {
    case "trigger": {
      if (data.kind !== "incoming") collector.add(`${base}.kind`, "must be 'incoming'");
      for (const [key, modes] of [
        ["sender", ["any", "exact", "prefix", "regex"]],
        ["body", ["any", "keyword", "regex"]],
      ] as const) {
        const filter = data[key];
        if (filter === undefined) continue;
        if (!isPlainObject(filter)) {
          collector.add(`${base}.${key}`, "must be an object");
          continue;
        }
        const mode = typeof filter.mode === "string" ? filter.mode : "any";
        if (!(modes as readonly string[]).includes(mode)) {
          collector.add(`${base}.${key}.mode`, `must be one of ${modes.join(", ")}`);
        }
        if (mode !== "any" && (typeof filter.value !== "string" || filter.value === "")) {
          collector.add(`${base}.${key}.value`, "is required for this mode");
        }
        if (mode === "regex" && typeof filter.value === "string") {
          const reason = lintRe2(filter.value);
          if (reason !== null) collector.add(`${base}.${key}.value`, `regex rejected: ${reason}`);
        }
      }
      return;
    }
    case "extract": {
      const source = data.source ?? "body";
      if (source !== "body" && source !== "sender") {
        collector.add(`${base}.source`, "must be 'body' or 'sender'");
      }
      const flags = data.flags;
      if (flags !== undefined && flags !== "" && flags !== "i") {
        collector.add(`${base}.flags`, "must be '' or 'i'");
      }
      const pattern = data.pattern;
      if (typeof pattern !== "string" || pattern === "") {
        collector.add(`${base}.pattern`, "must be a string");
        return;
      }
      const reason = lintRe2(pattern);
      if (reason !== null) collector.add(`${base}.pattern`, `regex rejected: ${reason}`);
      if (pattern.includes("(?P<")) {
        collector.add(
          `${base}.pattern`,
          "use (?<name>...); (?P<name>...) is not supported"
        );
      }
      const names = namedGroups(pattern);
      if (names.length === 0) {
        collector.add(
          `${base}.pattern`,
          "must declare at least one named group, e.g. (?<order>[0-9]+)"
        );
        return;
      }
      const local = new Set<string>();
      for (const name of names) {
        if (!isValidVariableName(name)) {
          collector.add(`${base}.pattern`, `invalid capture group name '${name}'`);
          continue;
        }
        if ((BUILTIN_VARIABLES as readonly string[]).includes(name)) {
          collector.add(`${base}.pattern`, `capture group '${name}' is reserved`);
          continue;
        }
        if (local.has(name)) {
          collector.add(`${base}.pattern`, `duplicate capture group '${name}' within one pattern`);
          continue;
        }
        local.add(name);
        const owner = groupOwner.get(name);
        if (owner !== undefined) {
          collector.add(
            `${base}.pattern`,
            `duplicate capture group '${name}' (already declared at nodes[${owner}].data.pattern)`
          );
          continue;
        }
        groupOwner.set(name, index);
        boundNames.set(name, index);
      }
      return;
    }
    case "set_var": {
      const name = data.name;
      if (typeof name !== "string" || !isValidVariableName(name)) {
        collector.add(`${base}.name`, "must match ^[A-Za-z_][A-Za-z0-9_]{0,31}$");
      } else if ((BUILTIN_VARIABLES as readonly string[]).includes(name)) {
        collector.add(`${base}.name`, `'${name}' is reserved`);
      } else if (boundNames.has(name)) {
        collector.add(
          `${base}.name`,
          `'${name}' is already bound at nodes[${boundNames.get(name)}]`
        );
      } else {
        boundNames.set(name, index);
      }
      template(data.value, `${base}.value`);
      return;
    }
    case "condition": {
      template(data.left, `${base}.left`);
      const op = data.op;
      if (!["equals", "not_equals", "contains", "matches", "exists"].includes(String(op))) {
        collector.add(
          `${base}.op`,
          "must be one of equals, not_equals, contains, matches, exists"
        );
        return;
      }
      if (op === "exists") return;
      const right = template(data.right, `${base}.right`);
      if (op === "matches" && right !== "") {
        const reason = lintRe2(right);
        if (reason !== null) collector.add(`${base}.right`, `regex rejected: ${reason}`);
      }
      return;
    }
    case "switch": {
      template(data.value, `${base}.value`);
      const cases = data.cases;
      if (!Array.isArray(cases) || cases.length === 0) {
        collector.add(`${base}.cases`, "must list at least one case");
        return;
      }
      if (cases.length > 8) collector.add(`${base}.cases`, "must have at most 8 cases");
      cases.forEach((value, caseIndex) => {
        if (typeof value !== "string" || value === "") {
          collector.add(`${base}.cases[${caseIndex}]`, "must not be empty");
        }
      });
      return;
    }
    case "delay": {
      const seconds = data.seconds;
      if (
        typeof seconds !== "number" ||
        !Number.isInteger(seconds) ||
        seconds < 1 ||
        seconds > MAX_DELAY_SECONDS
      ) {
        collector.add(`${base}.seconds`, `must be an integer between 1 and ${MAX_DELAY_SECONDS}`);
      }
      return;
    }
    case "webhook": {
      const url = template(data.url, `${base}.url`);
      if (url !== "" && !(url.startsWith("https://") || url.startsWith("http://127.0.0.1"))) {
        collector.add(`${base}.url`, "must be an https:// URL");
      }
      template(data.body, `${base}.body`);
      return;
    }
    case "send_sms": {
      const to = template(data.to, `${base}.to`);
      if (to === "") collector.add(`${base}.to`, "is required and must not be empty");
      if (to.length > MAX_SMS_TO_CHARS) {
        collector.add(`${base}.to`, `must be at most ${MAX_SMS_TO_CHARS} characters`);
      }
      const body = template(data.body, `${base}.body`);
      if (body === "") collector.add(`${base}.body`, "is required and must not be empty");
      if (body.length > MAX_SMS_BODY_CHARS) {
        collector.add(`${base}.body`, `must be at most ${MAX_SMS_BODY_CHARS} characters`);
      }
      return;
    }
    case "stop":
      return;
  }
}

/* ------------------------------------------------------------- structure */

function outgoingOf(graph: IrGraph, id: string): IrEdge[] {
  return graph.edges.filter((edge) => edge.source === id);
}

function checkStructure(graph: IrGraph, collector: Collector): void {
  const triggers = graph.nodes.filter((node) => node.type === "trigger");
  if (triggers.length !== 1) {
    collector.add(
      "nodes",
      `graph must contain exactly one trigger node (found ${triggers.length})`
    );
  }

  graph.nodes.forEach((node, index) => {
    const path = `nodes[${index}]`;
    const outs = outgoingOf(graph, node.id);
    const ins = graph.edges.filter((edge) => edge.target === node.id);

    switch (node.type) {
      case "trigger": {
        for (const edge of ins) {
          collector.add(
            `edges[${graph.edges.indexOf(edge)}].target`,
            "the trigger node must not have incoming edges"
          );
        }
        if (outs.length !== 1) {
          collector.add(path, `trigger node must have exactly 1 outgoing edge (found ${outs.length})`);
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
        const handles = new Set(outs.map((edge) => edge.sourceHandle ?? ""));
        if (handles.size !== 2 || !handles.has("true") || !handles.has("false")) {
          collector.add(path, "condition node needs one 'true' and one 'false' outgoing edge");
        }
        break;
      }
      case "switch": {
        const cases = Array.isArray(node.data.cases) ? node.data.cases : [];
        const expected = cases.length + 1;
        if (outs.length !== expected) {
          collector.add(
            path,
            `switch node with ${cases.length} case(s) must have ${expected} outgoing edges (one per case plus default), found ${outs.length}`
          );
        }
        const seen = new Set<string>();
        for (const edge of outs) {
          const handle = edge.sourceHandle ?? "";
          if (seen.has(handle)) collector.add(path, `duplicate branch handle '${handle}'`);
          seen.add(handle);
          const match = /^case:(\d+)$/.exec(handle);
          if (match) {
            if (Number(match[1]) >= cases.length) {
              collector.add(path, `branch handle '${handle}' names a case that does not exist`);
            }
          } else if (handle !== "default") {
            collector.add(path, `unknown branch handle '${handle}'`);
          }
        }
        if (!seen.has("default")) collector.add(path, "switch node needs a 'default' outgoing edge");
        break;
      }
      case "stop": {
        if (outs.length !== 0) {
          collector.add(path, `stop node must not have outgoing edges (found ${outs.length})`);
        }
        break;
      }
      default: {
        if (outs.length !== 1) {
          collector.add(
            path,
            `${node.type} node must have exactly 1 outgoing edge (found ${outs.length})`
          );
        }
      }
    }
  });

  if (triggers.length === 1) {
    checkAcyclic(graph, collector);
    checkReachability(graph, collector);
  }
}

/** Iterative DFS; reports the edge that closes the cycle and the node it hits. */
function checkAcyclic(graph: IrGraph, collector: Collector): void {
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const colour = new Map<string, number>();

  for (const node of graph.nodes) {
    if ((colour.get(node.id) ?? WHITE) !== WHITE) continue;
    colour.set(node.id, GREY);
    const stack: Array<{ id: string; next: number }> = [{ id: node.id, next: 0 }];

    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const outs = outgoingOf(graph, top.id);
      if (top.next >= outs.length) {
        colour.set(top.id, BLACK);
        stack.pop();
        continue;
      }
      const edge = outs[top.next];
      top.next += 1;
      if (edge.source === edge.target) continue;

      const state = colour.get(edge.target) ?? WHITE;
      if (state === GREY) {
        collector.add(
          `edges[${graph.edges.indexOf(edge)}]`,
          `cycle detected: this edge returns to '${edge.target}', which is already on the path`
        );
        return;
      }
      if (state === WHITE) {
        colour.set(edge.target, GREY);
        stack.push({ id: edge.target, next: 0 });
      }
    }
  }
}

function checkReachability(graph: IrGraph, collector: Collector): void {
  const root = graph.nodes.find((node) => node.type === "trigger");
  if (root === undefined) return;

  const reached = new Set<string>([root.id]);
  const queue: string[] = [root.id];
  // `while`, not a captured length: `queue` grows during the walk.
  for (let head = 0; head < queue.length; head += 1) {
    for (const edge of outgoingOf(graph, queue[head])) {
      if (edge.source === edge.target) continue;
      if (reached.has(edge.target)) continue;
      reached.add(edge.target);
      queue.push(edge.target);
    }
  }

  graph.nodes.forEach((node, index) => {
    if (!reached.has(node.id)) {
      collector.add(`nodes[${index}]`, `node '${node.id}' is not reachable from the trigger`);
    }
  });
}

/* -------------------------------------------------------------- bindings */

function builtins(): Set<string> {
  return new Set(BUILTIN_VARIABLES);
}

function bindsOf(node: IrNode): Set<string> {
  const out = new Set<string>();
  if (node.type === "extract") {
    const pattern = typeof node.data.pattern === "string" ? node.data.pattern : "";
    for (const name of namedGroups(pattern)) out.add(name);
  } else if (node.type === "set_var") {
    const name = node.data.name;
    if (typeof name === "string" && isValidVariableName(name)) out.add(name);
  }
  return out;
}

/**
 * Forward dataflow: the variables DEFINITELY bound at a node are the intersection
 * of what every predecessor path guarantees (`out(p) = in(p) plus what p binds`).
 *
 * This is what refuses `{{amount}}` on a branch that never extracts it: the
 * failure an agent-authored graph makes most often.
 */
function checkBindings(graph: IrGraph, templates: TemplateSink, collector: Collector): void {
  if (templates.length === 0) return;

  const remaining = new Map<string, number>();
  for (const node of graph.nodes) {
    remaining.set(
      node.id,
      graph.edges.filter((edge) => edge.target === node.id && edge.source !== edge.target).length
    );
  }

  const ready = graph.nodes.filter((node) => remaining.get(node.id) === 0).map((node) => node.id);
  ready.sort();
  const inbound = new Map<string, Set<string>>();

  for (let head = 0; head < ready.length; head += 1) {
    const id = ready[head];

    let available = builtins();
    let first = true;
    for (const edge of graph.edges.filter((candidate) => candidate.target === id)) {
      const from = new Set(inbound.get(edge.source) ?? builtins());
      const source = graph.nodes.find((node) => node.id === edge.source);
      if (source !== undefined) for (const name of bindsOf(source)) from.add(name);
      if (first) {
        available = from;
        first = false;
      } else {
        available = new Set([...available].filter((name) => from.has(name)));
      }
    }
    inbound.set(id, available);

    for (const edge of outgoingOf(graph, id)) {
      const count = remaining.get(edge.target);
      if (count === undefined) continue;
      remaining.set(edge.target, Math.max(0, count - 1));
      if (count - 1 === 0) ready.push(edge.target);
    }
  }

  for (const { name, index } of templates) {
    const nodeId = graph.nodes[index]?.id ?? "";
    const available = inbound.get(nodeId) ?? builtins();
    if (available.has(name)) continue;
    const boundElsewhere = graph.nodes.some((node) => bindsOf(node).has(name));
    collector.add(
      `nodes[${index}].data`,
      boundElsewhere
        ? `'{{${name}}}' is not bound on every path to this node: a branch reaches it without an extract or set_var that produces '${name}'`
        : `'{{${name}}}' is never bound: no extract group or set_var produces '${name}'`
    );
  }
}

/* ---------------------------------------------------------------- layout */

/**
 * Deterministic layout: rank by longest path from the entry, then place from the
 * rank and the sibling order. The numbers are the same as `ir.rs` (`COL_GAP`
 * 280, `ROW_GAP` 160), so a graph laid out here does not jump when the handset
 * lays it out again.
 */
export function layoutIr(graph: IrGraph): UiLayout {
  const root = graph.nodes.find((node) => node.type === "trigger");
  if (root === undefined) return { algorithm: LAYOUT_ALGORITHM, positions: {} };

  const rank = new Map<string, number>([[root.id, 0]]);
  const indegree = new Map<string, number>();
  for (const node of graph.nodes) {
    indegree.set(
      node.id,
      graph.edges.filter((edge) => edge.target === node.id && edge.source !== edge.target).length
    );
  }

  const queue: string[] = [root.id];
  for (let head = 0; head < queue.length; head += 1) {
    const id = queue[head];
    const current = rank.get(id) ?? 0;
    for (const edge of outgoingOf(graph, id)) {
      if (edge.source === edge.target) continue;
      rank.set(edge.target, Math.max(rank.get(edge.target) ?? 0, current + 1));
      const count = indegree.get(edge.target) ?? 0;
      indegree.set(edge.target, Math.max(0, count - 1));
      if (count - 1 === 0) queue.push(edge.target);
    }
  }

  const buckets = new Map<number, IrNode[]>();
  for (const node of graph.nodes) {
    const value = rank.get(node.id) ?? 0;
    const bucket = buckets.get(value);
    if (bucket === undefined) buckets.set(value, [node]);
    else bucket.push(node);
  }

  const positions: Record<string, Position> = {};
  const previousOrder = new Map<string, number>();
  const ranks = [...buckets.keys()].sort((left, right) => left - right);

  ranks.forEach((rankIndex, column) => {
    const bucket = buckets.get(rankIndex) ?? [];
    bucket.sort((left, right) => {
      const seedOf = (node: IrNode): number => {
        const seeds = graph.edges
          .filter((edge) => edge.target === node.id)
          .map((edge) => previousOrder.get(edge.source))
          .filter((value): value is number => value !== undefined);
        return seeds.length === 0 ? Number.MAX_SAFE_INTEGER : Math.min(...seeds);
      };
      const delta = seedOf(left) - seedOf(right);
      if (delta !== 0) return delta;
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });

    bucket.forEach((node, row) => {
      previousOrder.set(node.id, row);
      positions[node.id] = { x: column * COL_GAP, y: row * ROW_GAP };
    });
  });

  return { algorithm: LAYOUT_ALGORITHM, positions };
}
