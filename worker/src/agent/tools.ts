/**
 * The runtime's tool catalog — pass 3, stages B and C.
 *
 * Read tools call the existing handler functions directly and return their JSON
 * as `output` text. Propose tools reuse `stageAssistantProposal`, which is the
 * same code path the stateless console chat uses. Act tools go through
 * `createActTools` and the same handlers a human's write uses.
 *
 * Nothing here reimplements a validator. If a rule is invalid, `handleRulesPost`
 * says so; if a graph is invalid, `handleWorkflowPut` says so.
 */

import type { Env } from "../index";
import type { AdminActor } from "../audit";
import type { AgentTool, ToolResult } from "./types";
import { createActTools, type ActDispatch } from "./act";
import { handleHealth } from "../routes/health";
import { handleAgentDiagnose, handleAgentTelemetry } from "../routes/agent";
import { handleWorkflowGet, handleWorkflowPut } from "../routes/workflows";
import { handleSend } from "../routes/send";
import {
  acceptCreateRule,
  stageAssistantProposal,
  type ProposalKind,
} from "../routes/assistant";

async function fromResponse(response: Response): Promise<ToolResult> {
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text === "" ? null : JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const body =
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    return {
      ok: false,
      reason: typeof body?.error === "string" ? body.error : `http_${response.status}`,
      message:
        typeof body?.message === "string" ? body.message : text || `HTTP ${response.status}`,
    };
  }
  return { ok: true, output: text, data: parsed };
}

function jsonRequest(path: string, method: string, body: unknown): Request {
  return new Request(`https://agent.invalid${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function stringField(input: Record<string, unknown>, key: string): string {
  return typeof input[key] === "string" ? (input[key] as string) : "";
}

/** Column JSON that must not throw a turn. */
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function numberField(input: Record<string, unknown>, key: string): number | null {
  const value = input[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The three handler calls an act needs, wired to the real routes. */
export function realActDispatch(): ActDispatch {
  return {
    async proposeRule(payload, env, actor) {
      const staged = await stageAssistantProposal(env, actor, {
        kind: "create_rule",
        title:
          typeof payload.name === "string" && payload.name !== ""
            ? String(payload.name)
            : "A rule the agent prepared",
        payload,
      });
      return staged.ok ? { id: staged.proposal.id } : null;
    },
    async createRule(payload, env, actor) {
      const outcome = await acceptCreateRule(env, actor as AdminActor, payload);
      return outcome.ok ? Response.json(outcome.body) : outcome.response;
    },
    async sendSms(body, env, actor) {
      return handleSend(jsonRequest("/v1/sms/send", "POST", body), env, actor as AdminActor);
    },
    async deployFlow(flowId, body, env, actor) {
      return handleWorkflowPut(
        jsonRequest(`/v1/admin/workflows/${encodeURIComponent(flowId)}`, "PUT", body),
        env,
        flowId,
        actor as AdminActor
      );
    },
  };
}

export function buildAgentTools(dispatch: ActDispatch = realActDispatch()): AgentTool[] {
  const reads: AgentTool[] = [
    {
      name: "fleet_health",
      description: "Read the deployment health card: bindings, migration state and fleet counts.",
      kind: "read",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute(_input, ctx) {
        return fromResponse(await handleHealth(ctx.env));
      },
    },
    {
      name: "telemetry",
      description:
        "Run one of the six bounded telemetry plans. The question maps to a fixed plan; there is no raw SQL.",
      kind: "read",
      parameters: {
        type: "object",
        required: ["question"],
        properties: { question: { type: "string" } },
      },
      async execute(input, ctx) {
        const question = stringField(input, "question");
        if (question === "") {
          return { ok: false, reason: "bad_request", message: "question is required" };
        }
        return fromResponse(
          await handleAgentTelemetry(jsonRequest("/v1/agent/telemetry", "POST", { question }), ctx.env)
        );
      },
    },
    {
      name: "search_messages",
      description:
        "Read recent messages from the fleet's delivery record, newest first: direction, peer, a short body preview, when it arrived and its reply/delivery state. Use it to answer questions like 'did any financial SMS go out'. Bodies are truncated to 80 characters and never logged.",
      kind: "read",
      parameters: {
        type: "object",
        properties: {
          contains: { type: "string", description: "Case-insensitive text the body should contain" },
          direction: { type: "string", enum: ["in", "out"] },
          peer: { type: "string", description: "Exact peer number" },
          since_hours: { type: "number", description: "Only messages newer than this many hours" },
          limit: { type: "number", description: "1-20, default 10" },
        },
        additionalProperties: false,
      },
      async execute(input, ctx) {
        const clauses: string[] = [];
        const binds: unknown[] = [];
        const direction = stringField(input, "direction");
        if (direction === "in" || direction === "out") {
          clauses.push("direction = ?");
          binds.push(direction);
        }
        const peer = stringField(input, "peer");
        if (peer !== "") {
          clauses.push("peer = ?");
          binds.push(peer);
        }
        const contains = stringField(input, "contains");
        if (contains !== "") {
          clauses.push("body LIKE ? ESCAPE '\\'");
          binds.push("%" + contains.replace(/[%_\\]/g, (c) => "\\" + c) + "%");
        }
        const hours = numberField(input, "since_hours");
        if (hours !== null && hours > 0) {
          clauses.push("received_at >= ?");
          binds.push(Date.now() - Math.min(24 * 30, hours) * 3_600_000);
        }
        const limitRaw = numberField(input, "limit");
        const limit = Math.max(1, Math.min(20, limitRaw === null ? 10 : Math.trunc(limitRaw)));
        const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;

        const rows = await ctx.env.DB.prepare(
          `SELECT id, direction, peer, body, received_at, reply_state
             FROM messages ${where}
            ORDER BY received_at DESC
            LIMIT ?`
        )
          .bind(...binds, limit)
          .all<{
            id: string;
            direction: string;
            peer: string;
            body: string;
            received_at: number;
            reply_state: string | null;
          }>();

        const messages = (rows.results ?? []).map((row) => ({
          id: row.id,
          direction: row.direction,
          peer: row.peer,
          preview: row.body.length > 80 ? row.body.slice(0, 80) + "…" : row.body,
          at: new Date(Number(row.received_at)).toISOString(),
          state: row.reply_state,
        }));
        return {
          ok: true,
          output: JSON.stringify({ count: messages.length, messages }),
          data: { count: messages.length },
        };
      },
    },
    {
      name: "message_timeline",
      description:
        "Read one conversation with one peer, oldest first, so a thread can be explained from its messages rather than guessed. Returns {peer, count, messages}, where each message has its ISO arrival time, direction, a body preview capped at 120 characters, reply state and channel. Filters by the exact peer and an optional recent-hours window; limit is 1-50 (default 20). Bodies are never logged.",
      kind: "read",
      parameters: {
        type: "object",
        required: ["peer"],
        properties: {
          peer: { type: "string", description: "Exact peer number or handle; required" },
          limit: { type: "number", description: "1-50, default 20; oldest rows in the window" },
          since_hours: {
            type: "number",
            description: "Only messages newer than this many hours (max 720)",
          },
        },
        additionalProperties: false,
      },
      async execute(input, ctx) {
        const peer = stringField(input, "peer");
        if (peer === "") {
          return { ok: false, reason: "bad_request", message: "peer is required" };
        }
        const clauses = ["peer = ?"];
        const binds: unknown[] = [peer];
        const hours = numberField(input, "since_hours");
        if (hours !== null && hours > 0) {
          clauses.push("received_at >= ?");
          binds.push(Date.now() - Math.min(24 * 30, hours) * 3_600_000);
        }
        const limitRaw = numberField(input, "limit");
        const limit = Math.max(1, Math.min(50, limitRaw === null ? 20 : Math.trunc(limitRaw)));

        const rows = await ctx.env.DB.prepare(
          `SELECT peer, direction, body, received_at, reply_state, channel
             FROM messages
            WHERE ${clauses.join(" AND ")}
            ORDER BY received_at ASC
            LIMIT ?`
        )
          .bind(...binds, limit)
          .all<{
            peer: string;
            direction: string;
            body: string;
            received_at: number;
            reply_state: string | null;
            channel: string | null;
          }>();

        const messages = (rows.results ?? []).map((row) => ({
          at: new Date(Number(row.received_at)).toISOString(),
          direction: row.direction,
          preview: row.body.length > 120 ? row.body.slice(0, 120) : row.body,
          state: row.reply_state,
          channel: row.channel,
        }));
        return {
          ok: true,
          output: JSON.stringify({ peer, count: messages.length, messages }),
          data: { peer, count: messages.length },
        };
      },
    },
    {
      name: "read_rules",
      description:
        "Read the auto-reply rules on this deployment: id, name, whether each is enabled, its matcher and body matcher. Use it to answer questions about rules, including how many are enabled. Never returns message bodies.",
      kind: "read",
      parameters: {
        type: "object",
        properties: {
          enabled: { type: "string", enum: ["any", "only", "disabled"] },
          limit: { type: "number", description: "1-50, default 50" },
        },
        additionalProperties: false,
      },
      async execute(input, ctx) {
        const which = stringField(input, "enabled") || "any";
        const limitRaw = numberField(input, "limit");
        const limit = Math.max(1, Math.min(50, limitRaw === null ? 50 : Math.trunc(limitRaw)));
        const where =
          which === "only" ? "WHERE enabled = 1" : which === "disabled" ? "WHERE enabled = 0" : "";
        const rows = await ctx.env.DB.prepare(
          `SELECT id, name, enabled, matcher_type, matcher_value, body_type, body_value,
                  allow_shortcode, device_id
             FROM rules ${where}
            ORDER BY priority DESC, id
            LIMIT ?`
        )
          .bind(limit)
          .all<{
            id: string;
            name: string;
            enabled: number;
            matcher_type: string;
            matcher_value: string;
            body_type: string;
            body_value: string;
            allow_shortcode: number;
            device_id: string | null;
          }>();
        const rules = (rows.results ?? []).map((row) => ({
          id: row.id,
          name: row.name,
          enabled: Number(row.enabled) === 1,
          matcher: { type: row.matcher_type, value: row.matcher_value },
          body_matcher: { type: row.body_type, value: row.body_value },
          allow_shortcode: Number(row.allow_shortcode) === 1,
          device_id: row.device_id,
        }));
        return {
          ok: true,
          output: JSON.stringify({
            count: rules.length,
            enabled: rules.filter((rule) => rule.enabled).length,
            rules,
          }),
          data: { count: rules.length },
        };
      },
    },
    {
      name: "diagnose",
      description:
        "Diagnose one failure into a root-cause card. Accepts a message id; the message body is never echoed.",
      kind: "read",
      parameters: {
        type: "object",
        properties: {
          message_id: { type: "string" },
          flow_run_id: { type: "string" },
          message: { type: "string" },
          pattern: { type: "string" },
        },
      },
      async execute(input, ctx) {
        const body: Record<string, unknown> = {};
        for (const key of ["message_id", "flow_run_id", "message", "pattern"]) {
          if (typeof input[key] === "string") body[key] = input[key];
        }
        if (Object.keys(body).length === 0) {
          return {
            ok: false,
            reason: "bad_request",
            message: "one of message_id, flow_run_id, message or pattern is required",
          };
        }
        return fromResponse(
          await handleAgentDiagnose(jsonRequest("/v1/agent/diagnose", "POST", body), ctx.env)
        );
      },
    },
    {
      name: "flow_ast",
      description: "Read one workflow graph exactly as it is stored, including its version.",
      kind: "read",
      parameters: {
        type: "object",
        required: ["flow_id"],
        properties: { flow_id: { type: "string" } },
      },
      async execute(input, ctx) {
        const flowId = stringField(input, "flow_id");
        if (flowId === "") {
          return { ok: false, reason: "bad_request", message: "flow_id is required" };
        }
        return fromResponse(await handleWorkflowGet(ctx.env, flowId));
      },
    },
    {
      name: "flow_runs",
      description:
        "Read recent workflow runs, newest first, to put history beside diagnose and flow_ast. Returns {count, runs}. This schema has no run-id, status, started_at/finished_at, failed_step or error column: a run is keyed by (device_id, local_id, flow_id, flow_version), its status is `outcome`, and its time is `created_at` (ISO in the result). Optional flow_id and status filters; status matches the `outcome` column. Limit is 1-20 (default 10).",
      kind: "read",
      parameters: {
        type: "object",
        properties: {
          flow_id: { type: "string", description: "Only runs of this workflow" },
          status: { type: "string", description: "Only runs whose outcome equals this value" },
          limit: { type: "number", description: "1-20, default 10" },
        },
        additionalProperties: false,
      },
      async execute(input, ctx) {
        const clauses: string[] = [];
        const binds: unknown[] = [];
        const flowId = stringField(input, "flow_id");
        if (flowId !== "") {
          clauses.push("flow_id = ?");
          binds.push(flowId);
        }
        const status = stringField(input, "status");
        if (status !== "") {
          clauses.push("outcome = ?");
          binds.push(status);
        }
        const limitRaw = numberField(input, "limit");
        const limit = Math.max(1, Math.min(20, limitRaw === null ? 10 : Math.trunc(limitRaw)));
        const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;

        const rows = await ctx.env.DB.prepare(
          `SELECT device_id, local_id, flow_id, flow_version, outcome, created_at
             FROM flow_runs ${where}
            ORDER BY created_at DESC
            LIMIT ?`
        )
          .bind(...binds, limit)
          .all<{
            device_id: string;
            local_id: string;
            flow_id: string;
            flow_version: number;
            outcome: string;
            created_at: number;
          }>();

        const runs = (rows.results ?? []).map((row) => ({
          device_id: row.device_id,
          local_id: row.local_id,
          flow_id: row.flow_id,
          flow_version: Number(row.flow_version),
          outcome: row.outcome,
          created_at: new Date(Number(row.created_at)).toISOString(),
        }));
        return {
          ok: true,
          output: JSON.stringify({ count: runs.length, runs }),
          data: { count: runs.length },
        };
      },
    },
  ];

  const proposes: AgentTool[] = [
    {
      name: "create_rule",
      description:
        "Stage a create_rule proposal for a human to accept. Nothing is written; accepting it runs the rules handler.",
      kind: "propose",
      parameters: {
        type: "object",
        required: ["matcher", "body_matcher", "reply_template"],
        properties: {
          title: { type: "string" },
          summary: { type: "string" },
          payload: { type: "object" },
        },
      },
      async execute(input, ctx) {
        return stage(ctx, "create_rule", input);
      },
    },
    {
      name: "create_template",
      description:
        "Stage a create_template proposal for a human to accept. Nothing is written.",
      kind: "propose",
      parameters: {
        type: "object",
        required: ["body"],
        properties: {
          title: { type: "string" },
          summary: { type: "string" },
          name: { type: "string" },
          body: { type: "string" },
        },
      },
      async execute(input, ctx) {
        const payload =
          input.payload !== undefined && typeof input.payload === "object"
            ? (input.payload as Record<string, unknown>)
            : { name: input.name, body: input.body };
        if (typeof payload.body !== "string" || payload.body.trim() === "") {
          return { ok: false, reason: "bad_request", message: "body is required" };
        }
        return stage(ctx, "create_template", { ...input, payload });
      },
    },
    {
      name: "stage_workflow_patch",
      description:
        "Stage a workflow patch proposal. The server composes the patch from the ops; nothing is written and nothing is deployed.",
      kind: "propose",
      parameters: {
        type: "object",
        required: ["flow_id", "ops"],
        properties: {
          title: { type: "string" },
          summary: { type: "string" },
          flow_id: { type: "string" },
          ops: { type: "array", items: { type: "object" } },
        },
      },
      async execute(input, ctx) {
        return stage(ctx, "stage_workflow_patch", {
          ...input,
          payload: { flow_id: input.flow_id, ops: input.ops },
        });
      },
    },
  ];

  return [...reads, ...proposes, ...createActTools({ dispatch })];
}

type StageContext = {
  env: Env;
  actor: AdminActor;
};

async function stage(
  ctx: StageContext,
  kind: ProposalKind,
  input: Record<string, unknown>
): Promise<ToolResult> {
  let payload: Record<string, unknown>;
  if (input.payload !== undefined && typeof input.payload === "object" && !Array.isArray(input.payload)) {
    payload = { ...(input.payload as Record<string, unknown>) };
  } else {
    payload = { ...input };
    delete payload.title;
    delete payload.summary;
  }
  const title =
    typeof input.title === "string" && input.title.trim() !== ""
      ? input.title.trim()
      : kind;
  const summary = typeof input.summary === "string" ? input.summary : "";

  const staged = await stageAssistantProposal(ctx.env, ctx.actor, {
    kind,
    title,
    summary,
    payload,
  });
  if (!staged.ok) {
    return { ok: false, reason: staged.reason, message: staged.message };
  }
  return {
    ok: true,
    output: JSON.stringify({
      kind: staged.proposal.kind,
      proposal_id: staged.proposal.id,
      title: staged.proposal.title,
      summary: staged.proposal.summary,
      payload: staged.proposal.payload,
    }),
    data: { proposal_id: staged.proposal.id, kind: staged.proposal.kind },
  };
}
