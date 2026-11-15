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

/** The three handler calls an act needs, wired to the real routes. */
export function realActDispatch(): ActDispatch {
  return {
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
