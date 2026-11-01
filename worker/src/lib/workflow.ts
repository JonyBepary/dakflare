/**
 * Workflow graph validation — now a thin adapter over the canonical IR.
 *
 * The rules used to live here, ~800 lines of them, and a second copy lived in
 * `simulator/flow`. They drifted. The rules now live in `lib/flow-ir.ts` (the
 * Worker's copy of `simulator/flow/src/ir.rs`), and this module keeps the names
 * the rest of the code already imports: `validateWorkflowGraph`, `Graph`,
 * `WorkflowNode`, `RE_WORKFLOW_ID`, `MAX_WORKFLOW_NAME_CHARS`.
 *
 * ## One transitional mirror, deliberately
 *
 * The IR keeps positions in `ui_layout`, because they are a property of the
 * drawing rather than of the flow, and because a graph authored by an agent has
 * no coordinates at all. `validateWorkflowGraph` copies the computed position
 * onto each node as well, so the canvas and the handset keep reading what they
 * have always read until they are migrated. `ui_layout` is authoritative; the
 * per-node copy is a convenience with a lifetime, and the comment says so at the
 * place that would otherwise become permanent by accident.
 */

import {
  IR_SCHEMA,
  MAX_NODES,
  RE_IR_ID,
  validateIr,
  type IrEdge,
  type IrGraph,
  type IrIssue,
  type IrNode,
  type NodeKind,
  type UiLayout,
} from "./flow-ir";

/** `nodes[2].data.pattern`. The root is `""`. */
export type WorkflowIssue = IrIssue;

/** The nine kinds. Widened in v6.1; the canvas palette follows `NODE_KINDS`. */
export type WorkflowNodeType = NodeKind;

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  /**
   * Transitional mirror of `ui_layout.positions[id]`. Always present on a value
   * that came from `validateWorkflowGraph`, so v6.0 readers keep working.
   */
  position: { x: number; y: number };
  data: Record<string, unknown>;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  /** `true`/`false` for a condition, `case:<n>`/`default` for a switch. */
  sourceHandle?: string;
  label?: string;
}

export interface Graph {
  schema: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  ui_layout?: UiLayout;
}

export type ValidationResult =
  | { ok: true; graph: Graph }
  | { ok: false; issues: WorkflowIssue[] };

/** Node/edge id grammar, shared with the IR and the route layer. */
export const RE_WORKFLOW_ID = RE_IR_ID;

/** `name` bound, shared with the route layer so both agree on one number. */
export const MAX_WORKFLOW_NAME_CHARS = 120;

/** Re-exported so a caller can check a graph against the same ceiling. */
export { IR_SCHEMA, MAX_NODES };

function toNode(node: IrNode, layout: UiLayout | undefined): WorkflowNode {
  const position = layout?.positions[node.id] ?? { x: 0, y: 0 };
  return { id: node.id, type: node.type, position, data: node.data };
}

function toEdge(edge: IrEdge): WorkflowEdge {
  const out: WorkflowEdge = { id: edge.id, source: edge.source, target: edge.target };
  if (edge.sourceHandle !== undefined) out.sourceHandle = edge.sourceHandle;
  if (edge.label !== undefined) out.label = edge.label;
  return out;
}

/**
 * Validate and normalise a workflow graph.
 *
 * Returns either `{ ok: true, graph }` with a fresh, contract-shaped copy, or
 * `{ ok: false, issues }` with at most 50 paths. It never throws.
 */
export function validateWorkflowGraph(raw: unknown): ValidationResult {
  const result = validateIr(raw);
  if (!result.ok) return { ok: false, issues: result.issues };

  const canonical: IrGraph = result.graph;
  const graph: Graph = {
    schema: canonical.schema ?? IR_SCHEMA,
    nodes: canonical.nodes.map((node) => toNode(node, canonical.ui_layout)),
    edges: canonical.edges.map(toEdge),
    ...(canonical.ui_layout === undefined ? {} : { ui_layout: canonical.ui_layout }),
  };
  return { ok: true, graph };
}
