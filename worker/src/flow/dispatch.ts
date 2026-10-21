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
      if (!result.matched || result.outcome !== "delivered") continue;

      for (const action of result.actions) {
        if (action.type !== "send_sms") continue;
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
