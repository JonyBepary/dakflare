/**
 * Admin workflow-graph API.
 *
 * The dashboard's SvelteFlow canvas stores a whole graph document per workflow.
 * These four routes are the only way in or out; there is no execution engine yet,
 * so a save is pure validation plus storage.
 *
 * AUTH
 * Every route is wrapped in `withAdmin` in `index.ts`, exactly like the rules
 * admin routes. The `:id` path segment is NOT decoded at the router: decoding
 * happens here, inside the authenticated handler, so a malformed percent-encoding
 * cannot throw before `withAdmin` has run. (A valid id never needs encoding —
 * `RE_WORKFLOW_ID` is `[A-Za-z0-9_-]` — but the router matches segment-by-segment
 * and the catch is what keeps `/v1/admin/workflows/%zz` a 404 instead of a 500.)
 *
 * Field shapes and every graph rule live in `lib/workflow.ts`; this file only
 * validates the envelope (id, name, device scope, enabled) and persists.
 */

import type { Env } from "../index";
import { err } from "../lib/errors";
import { readJsonBoundedResult } from "../lib/body";
import { MAX_BODY_BYTES } from "../lib/config";
import { RE_DEVICE_ID } from "../auth/canonical";
import {
  MAX_WORKFLOW_NAME_CHARS,
  RE_WORKFLOW_ID,
  validateWorkflowGraph,
  type Graph,
  type WorkflowIssue,
} from "../lib/workflow";

interface WorkflowRow {
  id: string;
  name: string;
  enabled: number;
  device_id: string | null;
  graph: string;
  version: number;
  created_at: number;
  updated_at: number;
}

/** A workflow as the API exposes it (graph included). */
interface WorkflowPayload {
  id: string;
  name: string;
  enabled: boolean;
  device_id: string | null;
  graph: unknown;
  version: number;
  created_at: number;
  updated_at: number;
}

/* ======================================================================== */
/* Helpers                                                                  */
/* ======================================================================== */

/**
 * Decode one path segment, returning `null` for a malformed escape sequence.
 * `decodeURIComponent("%zz")` throws a `URIError`; that must be a not-found, not
 * an unhandled exception inside the Worker.
 */
function decodeSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** Parse a stored graph document. Corrupt JSON only affects the display shape. */
function parseGraph(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** `node_count` for the list view: parse only to count, never to return. */
function countNodes(text: string): number {
  const parsed = parseGraph(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return 0;
  const nodes = (parsed as { nodes?: unknown }).nodes;
  return Array.isArray(nodes) ? nodes.length : 0;
}

function toPayload(row: WorkflowRow): WorkflowPayload {
  return {
    id: row.id,
    name: row.name,
    enabled: Number(row.enabled) === 1,
    device_id: row.device_id,
    graph: parseGraph(row.graph),
    version: Number(row.version),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

function workflowInvalid(issues: WorkflowIssue[]): Response {
  return Response.json({ error: "workflow_invalid", details: issues }, { status: 400 });
}

/** `SELECT` for one workflow, or `null` when the id is absent. */
async function selectWorkflow(env: Env, id: string): Promise<WorkflowRow | null> {
  const row = await env.DB.prepare(
    `SELECT id, name, enabled, device_id, graph, version, created_at, updated_at
       FROM workflows
      WHERE id = ?`
  )
    .bind(id)
    .first<WorkflowRow>();
  return row ?? null;
}

/* ======================================================================== */
/* Handlers                                                                 */
/* ======================================================================== */

/** `GET /v1/admin/workflows` — ids and metadata, newest save first, no graphs. */
export async function handleWorkflowsList(env: Env): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT id, name, enabled, device_id, graph, updated_at
       FROM workflows
      ORDER BY updated_at DESC`
  ).all<Pick<WorkflowRow, "id" | "name" | "enabled" | "device_id" | "graph" | "updated_at">>();

  const workflows = (rows.results ?? []).map((row) => ({
    id: row.id,
    name: row.name,
    enabled: Number(row.enabled) === 1,
    device_id: row.device_id,
    updated_at: Number(row.updated_at),
    node_count: countNodes(row.graph),
  }));

  return Response.json({ workflows });
}

/** `GET /v1/admin/workflows/:id` — the full document. */
export async function handleWorkflowGet(env: Env, rawId: string): Promise<Response> {
  const id = decodeSegment(rawId);
  if (id === null || !RE_WORKFLOW_ID.test(id)) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  const row = await selectWorkflow(env, id);
  if (!row) return Response.json({ error: "not_found" }, { status: 404 });

  return Response.json({ workflow: toPayload(row) });
}

/**
 * `PUT /v1/admin/workflows/:id` — validate and upsert.
 *
 * PUT is a full replace: an absent `enabled` means enabled, and an absent or null
 * `device_id` means fleet-wide. That keeps "the document I sent is the document
 * stored" true, which is what a canvas autosave needs. `created_at` is preserved
 * on update; `version` increments on every save.
 */
export async function handleWorkflowPut(
  req: Request,
  env: Env,
  rawId: string
): Promise<Response> {
  const id = decodeSegment(rawId);
  if (id === null || !RE_WORKFLOW_ID.test(id)) return err("bad_request", 400);

  const parsed = await readJsonBoundedResult(req, MAX_BODY_BYTES);
  if (!parsed.ok) return err(parsed.reason);
  const input = parsed.value;

  const name = input.name;
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > MAX_WORKFLOW_NAME_CHARS
  ) {
    return err("bad_request", 400);
  }

  let enabled = 1;
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean") return err("bad_request", 400);
    enabled = input.enabled ? 1 : 0;
  }

  // NULL = fleet-wide. An empty string is NOT a way to say NULL: it would be a
  // device id that can never authenticate, so it is rejected like any other
  // malformed device id (§1.1 grammar).
  let deviceId: string | null = null;
  if (input.device_id !== undefined && input.device_id !== null) {
    if (typeof input.device_id !== "string" || !RE_DEVICE_ID.test(input.device_id)) {
      return err("bad_request", 400);
    }
    deviceId = input.device_id;
  }

  const validation = validateWorkflowGraph(input.graph);
  if (!validation.ok) return workflowInvalid(validation.issues);

  const graph: Graph = validation.graph;
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO workflows (id, name, enabled, device_id, graph, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       enabled = excluded.enabled,
       device_id = excluded.device_id,
       graph = excluded.graph,
       version = workflows.version + 1,
       updated_at = excluded.updated_at`
  )
    .bind(id, name, enabled, deviceId, JSON.stringify(graph), now, now)
    .run();

  const row = await selectWorkflow(env, id);
  if (!row) {
    // The write succeeded but the read did not see it: a storage failure, not a
    // client error, and one the operator should retry.
    return err("storage_unavailable", 503);
  }

  return Response.json({ workflow: toPayload(row) });
}

/** `DELETE /v1/admin/workflows/:id`. */
export async function handleWorkflowDelete(env: Env, rawId: string): Promise<Response> {
  const id = decodeSegment(rawId);
  if (id === null || !RE_WORKFLOW_ID.test(id)) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  const result = await env.DB.prepare(`DELETE FROM workflows WHERE id = ?`).bind(id).run();
  if (Number(result.meta?.changes ?? 0) === 0) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }

  return Response.json({ ok: true });
}
