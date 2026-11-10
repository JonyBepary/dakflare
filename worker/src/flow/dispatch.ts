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
import { enqueueOutboundCommand } from "../lib/commands";
import { isBlockedWebhookHost } from "../lib/flow-ir";

export interface AcceptedMessage {
  localId: string;
  sender: string;
  body: string;
  receivedAt: number;
}

export interface DeviceRunState {
  completed: Set<string>;
  partial: Set<string>;
}

function runKey(localId: string, flowId: string, version: number): string {
  return `${localId}|${flowId}|${version}`;
}

/**
 * Which (message, flow, version) triples this device already executed.
 * Distinguishes fully-completed runs from partial runs (which completed local SMS
 * but need Worker-side webhook or delay completion).
 *
 * Bounded by the accepted-message count (≤500 per batch), so the `IN` list stays
 * well inside SQLite's parameter limit.
 */
async function alreadyRun(
  env: Env,
  deviceId: string,
  messages: AcceptedMessage[]
): Promise<DeviceRunState> {
  const ids = messages.map((m) => m.localId);
  if (ids.length === 0) return { completed: new Set(), partial: new Set() };

  const placeholders = ids.map(() => "?").join(", ");
  try {
    const rows = await env.DB.prepare(
      `SELECT local_id, flow_id, flow_version, outcome
         FROM flow_runs
        WHERE device_id = ? AND local_id IN (${placeholders})`
    )
      .bind(deviceId, ...ids)
      .all<{ local_id: string; flow_id: string; flow_version: number; outcome: string }>();

    const completed = new Set<string>();
    const partial = new Set<string>();

    for (const row of rows.results ?? []) {
      const key = runKey(row.local_id, row.flow_id, Number(row.flow_version));
      if (row.outcome === "partial") {
        partial.add(key);
      } else {
        completed.add(key);
      }
    }

    return { completed, partial };
  } catch (error) {
    // A failed lookup means we might run something the device ran. Better a
    // possible duplicate than silently dropping automation.
    console.error(`[flow] could not read device runs: ${String(error)}`);
    return { completed: new Set(), partial: new Set() };
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

    // One open drift alert per device, because that is the partial unique index the
    // alerts table has on (device_id, kind). Rather than let a second drifting flow
    // be swallowed by the first, the alert's detail is a LIST: every flow currently
    // drifting, refreshed on each miss. An operator acknowledges it when they have
    // dealt with all of them, and until then nothing is hidden.
    const entry = {
      flow_id: input.flowId,
      flow_version: input.flowVersion,
      node_id: input.nodeId,
      field,
      misses_last_hour: misses,
      last_miss_at: now,
    };

    const open = await env.DB.prepare(
      `SELECT id, detail FROM alerts
        WHERE device_id = ? AND kind = 'extraction_drift'
          AND acknowledged_at IS NULL AND resolved_at IS NULL
        LIMIT 1`
    )
      .bind(input.deviceId)
      .first<{ id: string; detail: string | null }>();

    if (open === null) {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO alerts (id, device_id, kind, raised_at, detail)
         VALUES (?, ?, 'extraction_drift', ?, ?)`
      )
        .bind(
          crypto.randomUUID(),
          input.deviceId,
          now,
          JSON.stringify({ drifts: [entry] })
        )
        .run();
      return;
    }

    let drifts: unknown[] = [];
    try {
      const parsed = JSON.parse(open.detail ?? "{}") as { drifts?: unknown[] };
      if (Array.isArray(parsed.drifts)) drifts = parsed.drifts;
    } catch {
      // A detail this code cannot read is replaced rather than merged: a stale
      // shape must not stop the current drift from being recorded.
    }
    const merged = drifts.filter(
      (candidate) => (candidate as { flow_id?: unknown })?.flow_id !== input.flowId
    );
    merged.push(entry);

    await env.DB.prepare(`UPDATE alerts SET detail = ? WHERE id = ?`)
      .bind(JSON.stringify({ drifts: merged }), open.id)
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

/**
 * Require webhook URLs to either match an enabled origin in the webhooks table
 * or have an active human authority grant covering the target URL or webhooks:write.
 */
export async function isAuthorizedWebhookUrl(
  env: Env,
  urlStr: string,
  flowId?: string
): Promise<boolean> {
  if (isBlockedWebhookHost(urlStr)) return false;
  try {
    const targetUrl = new URL(urlStr);
    const webhookRows = await env.DB.prepare(
      `SELECT target_url FROM webhooks WHERE enabled = 1`
    ).all<{ target_url: string }>();
    if (webhookRows.results && webhookRows.results.length > 0) {
      for (const row of webhookRows.results) {
        try {
          const registered = new URL(row.target_url);
          if (registered.origin === targetUrl.origin) return true;
        } catch {}
      }
    }

    const now = Date.now();
    const grantRows = await env.DB.prepare(
      `SELECT scope, target_json FROM authority_grants
        WHERE (scope = 'webhooks:write' OR scope = 'flow_deploy_prod')
          AND expires_at > ? AND revoked_at IS NULL`
    )
      .bind(now)
      .all<{ scope: string; target_json: string }>();

    if (grantRows.results && grantRows.results.length > 0) {
      for (const row of grantRows.results) {
        try {
          const target = JSON.parse(row.target_json) as {
            url?: string;
            allowed_origins?: string[];
            flow_id?: string;
          };
          if (target.url && (target.url === urlStr || new URL(target.url).origin === targetUrl.origin)) {
            return true;
          }
          if (Array.isArray(target.allowed_origins) && target.allowed_origins.includes(targetUrl.origin)) {
            return true;
          }
          // Only an unscoped webhooks:write grant (never a flow_deploy_prod grant) acts as a broad webhook permit
          if (row.scope === "webhooks:write" && !target.url && !target.allowed_origins) {
            return true;
          }
        } catch {}
      }
    }
  } catch {
    return false;
  }
  return false;
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

  // Device-first: skip any (message, flow, version) the device already ran to completion.
  const ranByDevice = await alreadyRun(env, deviceId, messages);

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
      const key = runKey(message.localId, workflow.id, Number(workflow.version));
      if (ranByDevice.completed.has(key)) {
        continue;
      }
      const isPartial = ranByDevice.partial.has(key);

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

      if (!result.matched || (result.outcome !== "delivered" && result.outcome !== "partial")) continue;

      let executedWebhookOrDelay = false;
      for (const action of result.actions) {
        if (action.type === "send_sms") {
          // If the handset already executed partially, it sent the SMS locally.
          // Never send a duplicate SMS.
          if (isPartial) {
            continue;
          }
          if (!action.to || !action.body) continue;

          const commandId = crypto.randomUUID();
          const queued = await enqueueOutboundCommand(env, {
            deviceId,
            commandId,
            to: action.to,
            body: action.body,
            priority: "normal",
            expiresAt: Date.now() + COMMAND_TTL_MS,
          });
          if (queued.ok) {
            enqueued += 1;
            try {
              await env.DB.prepare(
                `UPDATE messages
                    SET auto_reply = 1, reply_source = 'flow',
                        reply_ref = ?, reply_command_id = ?
                  WHERE device_id = ? AND local_id = ?`
              )
                .bind(workflow.id, queued.commandId, deviceId, message.localId)
                .run();
            } catch (err) {
              console.error(
                `[flow] could not record reply for ${message.localId}: ${String(err)}`
              );
            }
          }
        } else if (action.type === "webhook") {
          if (!action.url) continue;
          if (isBlockedWebhookHost(action.url)) {
            console.warn(`[flow] ${workflow.id}: webhook to '${action.url}' blocked (private / SSRF destination)`);
            continue;
          }
          const authorized = await isAuthorizedWebhookUrl(env, action.url, workflow.id);
          if (!authorized) {
            console.warn(`[flow] ${workflow.id}: webhook to '${action.url}' refused (not authorized in webhooks table or grants)`);
            continue;
          }
          if (env.WEBHOOK_QUEUE) {
            await env.WEBHOOK_QUEUE.send({
              url: action.url,
              headers: {
                "User-Agent": "DakFlare-Worker/7.0",
                "X-Dakflare-Device": deviceId,
                "X-Dakflare-Flow": workflow.id,
              },
              body: action.body || "{}",
            });
            executedWebhookOrDelay = true;
          } else {
            try {
              await fetch(action.url, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "User-Agent": "DakFlare-Worker/7.0",
                  "X-Dakflare-Device": deviceId,
                  "X-Dakflare-Flow": workflow.id,
                },
                body: action.body || "{}",
                signal: AbortSignal.timeout(10_000),
              });
              executedWebhookOrDelay = true;
            } catch (err) {
              console.error(`[flow] ${workflow.id}: webhook delivery to ${action.url} failed: ${String(err)}`);
            }
          }
        } else if (action.type === "delay") {
          if (action.seconds > 0 && action.seconds <= 5) {
            await new Promise((resolve) => setTimeout(resolve, action.seconds * 1000));
            executedWebhookOrDelay = true;
          } else if (env.FLOW_WORKFLOW && action.seconds > 5) {
            try {
              await env.FLOW_WORKFLOW.create({
                id: `wf_${workflow.id}_${message.localId}`,
                params: {
                  flowId: workflow.id,
                  flowVersion: workflow.version,
                  localId: message.localId,
                  sender: message.sender,
                  body: message.body,
                  pendingSteps: [
                    {
                      nodeId: "delay_node",
                      type: "delay",
                      data: { seconds: action.seconds },
                    },
                  ],
                },
              });
              executedWebhookOrDelay = true;
            } catch (err) {
              console.warn(`[flow] ${workflow.id}: workflow step creation failed: ${String(err)}`);
            }
          } else {
            console.warn(`[flow] ${workflow.id}: delay action (${action.seconds}s) logged in edge dispatch`);
          }
        }
      }

      if (isPartial && executedWebhookOrDelay) {
        try {
          await env.DB.prepare(
            `UPDATE flow_runs
                SET outcome = 'delivered'
              WHERE device_id = ? AND local_id = ? AND flow_id = ? AND flow_version = ?`
          )
            .bind(deviceId, message.localId, workflow.id, Number(workflow.version))
            .run();
        } catch (err) {
          console.error(`[flow] could not update partial flow run: ${String(err)}`);
        }
      }
    }
  }

  return enqueued;
}
