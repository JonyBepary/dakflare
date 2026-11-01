/**
 * The seven MCP tools, as thin adapters over the routes that already exist.
 *
 * The rule that makes this honest: a tool does NOT re-implement anything. It
 * builds the same request the HTTP surface would receive and calls the same
 * handler with the same resolved actor. So "the tool and the HTTP route agree" is
 * true by construction rather than by a test that has to keep two copies in step.
 *
 * The one place a tool does more is `send_sms`: when the authority gate answers
 * `202 approval_required`, the tool turns that into an MRTR `input_required`
 * result carrying the request id, the scope, the target and the ladder. The
 * human answers in the console or on the handset, the client retries, and the
 * retry either finds a live grant or asks again.
 */

import { z } from "zod";
import { inputRequired, type InputRequiredResult } from "@modelcontextprotocol/server";

import type { Env } from "../index";
import type { AdminActor } from "../audit";
import { handleSend } from "../routes/send";
import { handleCommandStatus } from "../routes/status";
import { handleMessagesList } from "../routes/incoming";
import { handleDevicesList } from "../routes/pair";
import { handleWorkflowGet, handleWorkflowsList } from "../routes/workflows";
import { traceMessage } from "../lib/reply-fate-trace";
import { GRANT_LADDER_S, SCOPE_CAPS } from "../lib/agent-scopes";

/** What a tool returns: structured content plus the one line a model reads. */
export interface ToolAnswer {
  text: string;
  structured: Record<string, unknown>;
}

/** Run an existing route handler as if the HTTP surface had called it. */
async function callRoute(
  handle: (request: Request) => Promise<Response>,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; data: Record<string, unknown> }> {
  const request = new Request(`https://mcp.internal${path}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const response = await handle(request);
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, data };
}

const deviceId = z
  .string()
  .describe("The handset this applies to, e.g. dev63f3953f417d587f.");

export interface ToolDefinition {
  name: string;
  /**
   * The token scope that grants this tool.
   *
   * The register step filters on it, so `tools/list` IS the permission surface:
   * an unregistered tool is `-32601 method not found`, which is a truthful answer
   * rather than a refusal that leaks the name of something the caller may not
   * use. The tool handlers call route handlers directly, so this check is also
   * the one that keeps a read-only token from reaching `send_sms`.
   */
  requiredScope: string;
  title: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  outputSchema: z.ZodTypeAny;
  /** JSON Schema annotations copied into the published contract. */
  annotations?: Record<string, unknown>;
  run: (
    args: Record<string, unknown>,
    env: Env,
    actor: AdminActor
  ) => Promise<ToolAnswer | InputRequiredResult>;
}

/** The refusal a tool returns when the HTTP surface answered with an error. */
function refusal(status: number, data: Record<string, unknown>): ToolAnswer {
  const code = typeof data.error === "string" ? data.error : `HTTP ${status}`;
  const message = typeof data.message === "string" ? data.message : code;
  return {
    // `isError` is set by the caller from `status`; the text is what a model
    // reads, so it says what happened rather than repeating a status code.
    text: `${code}: ${message}`,
    structured: { error: code, message, status },
  };
}

export function toolDefinitions(env: Env): ToolDefinition[] {
  return [
    {
      name: "list_devices",
      requiredScope: "devices:read",
      title: "List devices",
      description:
        "List the paired handsets with their labels, SIM slots, last contact and FCM state. Start here if you do not know a device id.",
      inputSchema: z.object({
        archived: z.boolean().optional().describe("Include archived handsets."),
      }),
      outputSchema: z.object({
        devices: z.array(
          z.object({
            device_id: z.string(),
            label: z.string().nullable().optional(),
            last_seen: z.number().nullable().optional(),
            fcm: z.boolean().optional(),
          })
        ),
      }),
      run: async (args, environment, actor) => {
        const query = args.archived === true ? "?archived=1" : "";
        const { status, data } = await callRoute(
          (request) => handleDevicesList(environment, new URL(request.url)),
          "GET",
          `/v1/devices${query}`
        );
        if (status !== 200) return refusal(status, data);
        const devices = (data.devices ?? []) as Array<Record<string, unknown>>;
        return {
          text:
            devices.length === 0
              ? "No handsets are paired."
              : devices.map((row) => `${row.device_id}${row.label ? ` (${row.label})` : ""}`).join("\n"),
          structured: { devices },
        };
      },
    },

    {
      name: "read_messages",
      requiredScope: "messages:read",
      title: "Read messages",
      description:
        "Newest-first message log for one handset, with the reply fate of each row. Use it to see what actually arrived and what automation did about it.",
      inputSchema: z.object({
        device_id: deviceId.meta({ "x-mcp-header": "Device-Id" }),
        limit: z.int().min(1).max(200).optional().describe("Rows, default 50."),
      }),
      outputSchema: z.object({
        messages: z.array(
          z.object({
            id: z.string(),
            local_id: z.string(),
            direction: z.string(),
            peer: z.string(),
            body: z.string(),
            received_at: z.number(),
            reply_verdict: z.string().nullable().optional(),
          })
        ),
        limit: z.int(),
      }),
      run: async (args, environment) => {
        const url = new URL("https://mcp.internal/v1/messages");
        url.searchParams.set("device_id", String(args.device_id));
        if (args.limit !== undefined) url.searchParams.set("limit", String(args.limit));
        const { status, data } = await callRoute(
          (request) => handleMessagesList(environment, new URL(request.url)),
          "GET",
          `${url.pathname}${url.search}`
        );
        if (status !== 200) return refusal(status, data);
        const messages = (data.messages ?? []) as Array<Record<string, unknown>>;
        return {
          text: `${messages.length} message${messages.length === 1 ? "" : "s"}, newest first.`,
          structured: { messages, limit: Number(data.limit ?? 0) },
        };
      },
    },

    {
      name: "command_status",
      requiredScope: "messages:read",
      title: "Command status",
      description:
        "The delivery state of one outbound command: PENDING, LEASED, DISPATCHED, SENT, DELIVERED, FAILED or EXPIRED. SENT means the radio accepted it, not that it was delivered.",
      inputSchema: z.object({
        command_id: z.string().describe("The command id a send returned."),
        device_id: deviceId,
      }),
      outputSchema: z.object({
        command: z
          .object({
            command_id: z.string(),
            state: z.string(),
            to: z.string().optional(),
          })
          .nullable(),
      }),
      run: async (args, environment) => {
        const { status, data } = await callRoute(
          (request) => {
            const url = new URL(request.url);
            return handleCommandStatus(
              environment,
              url.searchParams.get("device_id") ?? "",
              url.pathname.split("/").pop() ?? ""
            );
          },
          "GET",
          `/v1/sms/commands/${encodeURIComponent(String(args.command_id))}?device_id=${encodeURIComponent(String(args.device_id))}`
        );
        if (status !== 200) return refusal(status, data);
        const command = (data.command ?? null) as Record<string, unknown> | null;
        return {
          text:
            command === null
              ? "No such command on that handset."
              : `${command.command_id} is ${command.state}.`,
          structured: { command },
        };
      },
    },

    {
      name: "list_flows",
      requiredScope: "flows:read",
      title: "List flows",
      description: "Every workflow on this deployment, with its node count and version.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        workflows: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            enabled: z.boolean(),
            node_count: z.int().optional(),
          })
        ),
      }),
      run: async (_args, environment) => {
        const { status, data } = await callRoute(
          () => handleWorkflowsList(environment),
          "GET",
          "/v1/admin/workflows"
        );
        if (status !== 200) return refusal(status, data);
        const workflows = (data.workflows ?? []) as Array<Record<string, unknown>>;
        return {
          text: `${workflows.length} flow${workflows.length === 1 ? "" : "s"}.`,
          structured: { workflows },
        };
      },
    },

    {
      name: "get_flow",
      requiredScope: "flows:read",
      title: "Get flow",
      description:
        "One workflow as the canonical IR: nodes, typed edges and the computed layout. Read it before changing anything.",
      inputSchema: z.object({ id: z.string().describe("The workflow id.") }),
      outputSchema: z.object({
        workflow: z
          .object({
            id: z.string(),
            name: z.string(),
            version: z.int(),
            graph: z.record(z.string(), z.unknown()),
          })
          .nullable(),
      }),
      run: async (args, environment) => {
        const { status, data } = await callRoute(
          () => handleWorkflowGet(environment, String(args.id)),
          "GET",
          `/v1/admin/workflows/${encodeURIComponent(String(args.id))}`
        );
        if (status !== 200) return refusal(status, data);
        const workflow = (data.workflow ?? null) as Record<string, unknown> | null;
        return {
          text: workflow === null ? "No such flow." : `Flow ${workflow.id} v${workflow.version}.`,
          structured: { workflow },
        };
      },
    },

    {
      name: "trace",
      requiredScope: "messages:read",
      title: "Trace one id",
      description:
        "Explain one message, command or approval request: the verdict, why, the automation that ran, and the device object's timers and sockets.",
      inputSchema: z.object({
        id: z.string().describe("A message id, local id, command id or approval request id."),
        device_id: deviceId.optional(),
      }),
      outputSchema: z.object({
        verdict: z.string(),
        kind: z.string(),
        why: z.array(z.string()),
      }),
      run: async (args, environment) => {
        const trace = await traceMessage(environment, {
          id: String(args.id),
          ...(typeof args.device_id === "string" ? { deviceId: args.device_id } : {}),
        });
        return {
          text: `${trace.verdict}: ${trace.why.join("; ")}`,
          structured: {
            verdict: trace.verdict,
            kind: trace.kind,
            why: trace.why,
            device_id: trace.device_id,
            message: trace.message,
            command: trace.command,
            automation: trace.automation,
            approval: trace.approval,
          },
        };
      },
    },

    {
      name: "send_sms",
      requiredScope: "sms:send",
      title: "Send SMS",
      description:
        "Queue one outbound SMS. An agent token needs a time-boxed authority grant covering the recipient; without one this returns an input-required result naming the approval to obtain, and sends nothing.",
      inputSchema: z.object({
        device_id: deviceId,
        to: z.string().describe("E.164 recipient, e.g. +8801540196080."),
        body: z.string().max(4_096).describe("Message text."),
        idempotency_key: z
          .string()
          .max(128)
          .optional()
          .describe("A retry with the same key returns the same command instead of a second SMS."),
      }),
      outputSchema: z.object({
        command_id: z.string().optional(),
        sent: z.boolean(),
        approval_request_id: z.string().nullable().optional(),
      }),
      run: async (args, environment, actor) => {
        const { status, data } = await callRoute(
          (request) => handleSend(request, environment, actor),
          "POST",
          "/v1/sms/send",
          {
            device_id: args.device_id,
            to: args.to,
            body: args.body,
            ...(args.idempotency_key === undefined
              ? {}
              : { idempotency_key: args.idempotency_key }),
          }
        );

        if (status === 202) {
          const approval = (data.approval_request ?? {}) as Record<string, unknown>;
          const scope = String(approval.scope ?? "sms:send:production");
          const cap = SCOPE_CAPS[scope];
          const target = (approval.target ?? {}) as Record<string, unknown>;
          const recipients = Array.isArray(target.recipients)
            ? target.recipients.join(", ")
            : String(target.device_id ?? "the target");

          // MRTR. The retry re-runs this whole tool, which re-reads the authority
          // store: a grant is the only thing that can let it through, so nothing
          // the client says in `inputResponses` can widen the permission. That is
          // also why the round is stateless on our side.
          return inputRequired({
            inputRequests: {
              approval: inputRequired.elicit({
                message:
                  `Sending to ${recipients} needs a human: approve request ${String(approval.id)} ` +
                  `for at most ${Math.round((cap?.max_ttl_s ?? 3_600) / 60)} minutes ` +
                  `(dakflare auth approve ${String(approval.id)} --for 15m), then call this tool again.`,
                requestedSchema: z.object({
                  decision: z
                    .enum(["retry", "cancel"])
                    .describe("retry once a human has approved; cancel to give up."),
                }),
              }),
            },
            requestState: JSON.stringify({ approval_request_id: approval.id ?? null }),
          });
        }

        if (status !== 200) return refusal(status, data);
        return {
          text: `Queued ${String(data.command_id)}${data.replayed === true ? " (replayed)" : ""}.`,
          structured: {
            command_id: String(data.command_id ?? ""),
            sent: true,
            approval_request_id: null,
          },
        };
      },
    },
  ];
}

/** The ladder, exported for the contract and the tool description. */
export const GRANT_LADDER_SECONDS = GRANT_LADDER_S;
