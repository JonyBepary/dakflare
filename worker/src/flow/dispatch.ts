/**
 * Worker-side flow fallback.
 *
 * Runs every enabled flow that applies to the device against each *newly
 * accepted* inbound message, then enqueues the resulting SMS as a command. Being
 * limited to accepted rows is the idempotency boundary: a device retrying its
 * batch produces duplicates, and duplicates must not send the reply twice.
 *
 * This is the fallback half of "device primary, Worker fallback". Device-side
 * execution (M4) reports its runs in `flow_runs`; until then the Worker is the
 * only engine, and the dedupe key is already provisioned for the switch.
 */

import type { Env } from "../index";
import { runFlow } from "./engine";

export interface AcceptedMessage {
  localId: string;
  sender: string;
  body: string;
  receivedAt: number;
}


function runKey(localId: string, flowId: string, version: number): string {
  return `${localId}|${flowId}|${version}`;
}

/**
 * Which (message, flow, version) triples this device already executed.
 *
 * Bounded by the accepted-message count (≤500 per batch), so the `IN` list stays
 * well inside SQLite's parameter limit.
 */
async function alreadyRun(
  env: Env,
  deviceId: string,
  messages: AcceptedMessage[]
): Promise<Set<string>> {
  const ids = messages.map((m) => m.localId);
  if (ids.length === 0) return new Set();

  const placeholders = ids.map(() => "?").join(", ");
  try {
    const rows = await env.DB.prepare(
      `SELECT local_id, flow_id, flow_version
         FROM flow_runs
        WHERE device_id = ? AND local_id IN (${placeholders})`
    )
      .bind(deviceId, ...ids)
      .all<{ local_id: string; flow_id: string; flow_version: number }>();

    return new Set(
      (rows.results ?? []).map((row) =>
        runKey(row.local_id, row.flow_id, Number(row.flow_version))
      )
    );
  } catch (error) {
    // A failed lookup means we might run something the device ran. Better a
    // possible duplicate than silently dropping automation.
    console.error(`[flow] could not read device runs: ${String(error)}`);
    return new Set();
  }
}

/**
 * Record one extraction miss, and raise the drift alert at the second in an hour.
 *
 * `field` is the capture group the node declares, resolved from the stored graph:
 * "the amount group stopped matching" is something an operator can act on, "the
 * flow halted" is not.
 *
 * Best effort throughout. A miss is diagnostic; losing one must never cost the
 * message that produced it.
 */
async function recordExtractMiss(
  env: Env,
  input: {
    deviceId: string;
    flowId: string;
    flowVersion: number;
    nodeId: string;
    graph: unknown;
    messageLocalId: string;
    body: string;
  }
): Promise<void> {
  const field = captureGroupOf(input.graph, input.nodeId);
  const now = Date.now();

  try {
    await env.DB.prepare(
      `INSERT INTO extract_misses
         (id, device_id, flow_id, flow_version, node_id, field, message_local_id, body_preview, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        crypto.randomUUID(),
        input.deviceId,
        input.flowId,
        input.flowVersion,
        input.nodeId,
        field,
        input.messageLocalId,
        // A preview, not the message: enough to recognise the template that
        // changed, and bounded so the diagnostic table cannot hold a body copy.
        input.body.slice(0, 160),
        now
      )
      .run();

    const row = await env.DB.prepare(
      `SELECT COUNT(*) AS misses FROM extract_misses
        WHERE device_id = ? AND flow_id = ? AND at >= ?`
    )
      .bind(input.deviceId, input.flowId, now - 3_600_000)
      .first<{ misses: number }>();

    const misses = Number(row?.misses ?? 0);
    if (misses < 2) return;

    // `INSERT OR IGNORE` plus the partial unique index on (device_id, kind) for
    // open rows: a template that breaks every message shouts once, not once per
    // message.
    await env.DB.prepare(
      `INSERT OR IGNORE INTO alerts (id, device_id, kind, raised_at, detail)
       VALUES (?, ?, 'extraction_drift', ?, ?)`
    )
      .bind(
        crypto.randomUUID(),
        input.deviceId,
        now,
        JSON.stringify({
          flow_id: input.flowId,
          flow_version: input.flowVersion,
          node_id: input.nodeId,
          field,
          misses_last_hour: misses,
        })
      )
      .run();
  } catch (error) {
    console.error(`[flow] could not record an extract miss for ${input.flowId}: ${String(error)}`);
  }
}

/** The capture groups an `extract` node declares, from the stored graph. */
function captureGroupOf(graph: unknown, nodeId: string): string | null {
  const nodes = (graph as { nodes?: Array<Record<string, unknown>> } | null)?.nodes;
  if (!Array.isArray(nodes)) return null;
  const node = nodes.find((candidate) => candidate.id === nodeId);
  const pattern = (node?.data as { pattern?: unknown } | undefined)?.pattern;
  if (typeof pattern !== "string") return null;
  const names: string[] = [];
  for (const match of pattern.matchAll(/\(\?<([A-Za-z_][A-Za-z0-9_]*)>/g)) {
    names.push(match[1]);
  }
  return names.length === 0 ? null : names.join(",");
}

const MAX_FLOWS_PER_DEVICE = 20;
const MAX_RUNS_PER_BATCH = 200;
const COMMAND_TTL_MS = 86_400_000;

export async function dispatchFlows(
  env: Env,
  deviceId: string,
  messages: AcceptedMessage[]
): Promise<number> {
  if (messages.length === 0) return 0;

  const rows = await env.DB.prepare(
    `SELECT id, graph, version
       FROM workflows
      WHERE enabled = 1 AND (device_id IS NULL OR device_id = ?)
      ORDER BY updated_at DESC
      LIMIT ${MAX_FLOWS_PER_DEVICE}`
  )
    .bind(deviceId)
    .all<{ id: string; graph: string; version: number }>();

  const workflows = rows.results ?? [];
  if (workflows.length === 0) return 0;

  // Device-first: skip any (message, flow, version) the device already ran.
  const ranByDevice = await alreadyRun(env, deviceId, messages);

  const stub = env.DEVICE.get(env.DEVICE.idFromName(deviceId));
  let runs = 0;
  let enqueued = 0;

  for (const workflow of workflows) {
    let graph: unknown;
    try {
      graph = JSON.parse(workflow.graph) as unknown;
    } catch {
      console.error(`[flow] ${workflow.id}: stored graph is not JSON`);
      continue;
    }

    for (const message of messages) {
      if (ranByDevice.has(runKey(message.localId, workflow.id, Number(workflow.version)))) {
        continue;
      }
      if (runs >= MAX_RUNS_PER_BATCH) {
        console.warn(`[flow] run budget exhausted for this batch`);
        return enqueued;
      }
      runs += 1;

      let result;
      try {
        result = await runFlow(graph, {
          sender: message.sender,
          body: message.body,
          received_at: message.receivedAt,
        });
      } catch (error) {
        console.error(`[flow] ${workflow.id}: interpreter failed: ${String(error)}`);
        continue;
      }

      if (result.error) {
        console.error(`[flow] ${workflow.id}: ${result.error}`);
        continue;
      }

      // An extract that stops matching is the quietest failure in the system: the
      // message was accepted, the flow ran, and it stopped at a step that said
      // nothing. Record it, and let two in an hour raise the alert.
      if (result.matched && result.outcome === "halted") {
        const missed = result.steps.find((step) => step.detail === "pattern did not match");
        if (missed !== undefined) {
          await recordExtractMiss(env, {
            deviceId,
            flowId: workflow.id,
            flowVersion: Number(workflow.version),
            nodeId: missed.node_id,
            graph,
            messageLocalId: message.localId,
            body: message.body,
          });
        }
      }

      if (!result.matched || result.outcome !== "delivered") continue;

      for (const action of result.actions) {
        if (action.type !== "send_sms") {
          // v6.1 kinds the Worker does not perform. Named, not skipped in
          // silence: a flow that waits or posts somewhere is running partially,
          // and the operator has to be able to see that in the log.
          console.warn(
            `[flow] ${workflow.id}: '${action.type}' action skipped (unsupported by the Worker dispatch)`
          );
          continue;
        }
        if (!action.to || !action.body) continue;

        try {
          const response = await stub.fetch("https://do/__enqueue", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              command_id: crypto.randomUUID(),
              to: action.to,
              body: action.body,
              priority: "normal",
              expires_at: Date.now() + COMMAND_TTL_MS,
            }),
          });
          if (response.ok) enqueued += 1;
          else console.error(`[flow] enqueue rejected with ${response.status}`);
        } catch (error) {
          console.error(`[flow] enqueue failed: ${String(error)}`);
        }
      }
    }
  }

  return enqueued;
}
