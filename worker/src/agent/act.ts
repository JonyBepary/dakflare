/**
 * The three act tools — pass 3, stage C.
 *
 * Each one follows the same order, and the order is the contract:
 *
 *   1. journal the call (a replay returns the recorded result and spends
 *      nothing, because it never reaches authorisation);
 *   2. `authorizeAct` re-reads the live grant and the daily cap at call time;
 *   3. execute through the same handler a human's console write uses;
 *   4. record the result, and refund the authorisation if the effect failed.
 *
 * The dispatch table is injected so `__checks__/agent-act.mjs` can stub the
 * handlers and assert exactly what would be written, without D1 or Workers.
 */

import type { Env } from "../index";
import type { AdminActor } from "../audit";
import type { AgentTool, ToolContext, ToolResult } from "./types";
import { canonicalJson } from "./journal";
import { authorizeAct, refundAct, type ActDecision, type ActEffect } from "./grants";

/** The handlers an act ultimately calls. Real wiring lives in `tools.ts`. */
export interface ActDispatch {
  /**
   * Stage the same intent as a proposal. Returns null when the intent cannot be
   * expressed as one, in which case the original refusal stands.
   */
  proposeRule(
    payload: Record<string, unknown>,
    env: Env,
    actor: AdminActor
  ): Promise<{ id: string } | null>;
  createRule(
    payload: Record<string, unknown>,
    env: Env,
    actor: AdminActor
  ): Promise<Response>;
  sendSms(body: Record<string, unknown>, env: Env, actor: AdminActor): Promise<Response>;
  deployFlow(
    flowId: string,
    body: Record<string, unknown>,
    env: Env,
    actor: AdminActor
  ): Promise<Response>;
}

export interface ActToolDeps {
  dispatch: ActDispatch;
  /** Injected for the checks; the default is the D1-backed gate. */
  authorize?: (
    env: Env,
    actor: AdminActor | null | undefined,
    effect: ActEffect,
    now?: number
  ) => Promise<ActDecision>;
  /** Injected for the checks; the default refunds through D1. */
  refund?: (
    env: Env,
    grantId: string | null,
    effect: ActEffect,
    now?: number
  ) => Promise<void>;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

async function fromResponse(response: Response): Promise<ToolResult> {
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text === "" ? null : JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    const body = asObject(parsed);
    return {
      ok: false,
      reason: typeof body?.error === "string" ? body.error : `http_${response.status}`,
      message: typeof body?.message === "string" ? body.message : text || `HTTP ${response.status}`,
    };
  }
  return { ok: true, output: text, data: parsed };
}

/** A replayed result keeps its body but says it was a replay. */
export function markReplay(result: ToolResult): ToolResult {
  if (result.ok) {
    const data = asObject(result.data);
    return { ...result, data: { ...(data ?? {}), replayed: true } };
  }
  return { ...result, reason: result.reason, message: result.message };
}

interface CallPlan {
  tool: string;
  effect: ActEffect;
  run: () => Promise<ToolResult>;
  /**
   * Offered when the authority gate refuses. The same intent becomes a proposal
   * the operator accepts, which is the "plan once, ask once" path: without it the
   * model has to be refused act by act with autonomy off.
   */
  proposeOnRefusal?: (refusal: ToolResult, args: Record<string, unknown>) => Promise<ToolResult>;
}

/**
 * The shared execution skeleton for every act.
 *
 * `replayed: true` is added to a replayed result so a caller can tell the two
 * apart. A replay spends no grant use and no quota: it does not authorise at
 * all, which is stronger than authorising and refunding.
 */
async function executeAct(ctx: ToolContext, plan: CallPlan, args: Record<string, unknown>): Promise<ToolResult> {
  const reserved = await ctx.journal.reserve({
    callId: ctx.callId,
    tool: plan.tool,
    args,
  });
  if (reserved.replay) return markReplay(reserved.result);

  const authorize = (ctx as ToolContext & { __actAuthorize?: typeof authorizeAct }).__actAuthorize;
  const decision = await (authorize ?? authorizeAct)(ctx.env, ctx.actor, plan.effect);
  if (!decision.ok) {
    const refusal: ToolResult = { ok: false, reason: decision.reason, message: decision.message };
    const authority =
      decision.reason === "autonomy_off" ||
      decision.reason === "autonomy_other_session" ||
      decision.reason === "autonomy_expired" ||
      decision.reason === "no_grant" ||
      decision.reason === "grant_expired";
    if (authority && plan.proposeOnRefusal !== undefined) {
      const offered = await plan.proposeOnRefusal(refusal, args);
      // A proposal is not an effect: nothing was spent, so nothing is failed.
      ctx.journal.fail(ctx.callId, offered);
      return offered;
    }
    ctx.journal.fail(ctx.callId, refusal);
    return refusal;
  }

  let result: ToolResult;
  try {
    result = await plan.run();
  } catch (error) {
    const failure: ToolResult = {
      ok: false,
      reason: "act_failed",
      message: `the effect failed: ${String(error).slice(0, 200)}`,
    };
    ctx.journal.fail(ctx.callId, failure);
    const refund = (ctx as ToolContext & { __actRefund?: typeof refundAct }).__actRefund;
    await (refund ?? refundAct)(ctx.env, decision.grantId, plan.effect);
    return failure;
  }

  if (!result.ok) {
    ctx.journal.fail(ctx.callId, result);
    const refund = (ctx as ToolContext & { __actRefund?: typeof refundAct }).__actRefund;
    await (refund ?? refundAct)(ctx.env, decision.grantId, plan.effect);
    return result;
  }

  ctx.journal.complete(ctx.callId, result);
  return result;
}

/** The projections a model-created rule is allowed to use, forced here too. */
export const RULE_MODEL_REJECTION =
  "a model may not author a regex matcher; use exact, prefix, suffix or glob for the field matcher and keyword for the body matcher";

function ruleEffect(input: Record<string, unknown>): { payload: Record<string, unknown> } | ToolResult {
  const matcher = asObject(input.matcher);
  const bodyMatcher = asObject(input.body_matcher);
  const matcherType = String(
    matcher !== null && typeof matcher.type === "string" ? matcher.type : input.matcher_type ?? ""
  );
  const bodyType = String(
    bodyMatcher !== null && typeof bodyMatcher.type === "string"
      ? bodyMatcher.type
      : input.body_type ?? ""
  );
  if (matcherType === "regex" || bodyType === "regex") {
    return { ok: false, reason: "rule_rejected", message: RULE_MODEL_REJECTION };
  }
  return {
    payload: {
      ...input,
      allow_shortcode: false,
      allow_shortcode_reply: false,
      device_id: null,
    },
  };
}

export function createActTools(deps: ActToolDeps): AgentTool[] {
  const authorize = deps.authorize ?? authorizeAct;
  const refund = deps.refund ?? refundAct;

  const withDeps = (ctx: ToolContext): ToolContext => {
    (ctx as ToolContext & { __actAuthorize?: typeof authorizeAct }).__actAuthorize = authorize;
    (ctx as ToolContext & { __actRefund?: typeof refundAct }).__actRefund = refund;
    return ctx;
  };

  return [
    {
      name: "create_rule_now",
      description:
        "Create or replace one auto-reply rule immediately, through the same handler the rules editor uses. Regex matchers are refused; the rule never replies to shortcodes and is never device-scoped.",
      kind: "act",
      parameters: {
        type: "object",
        required: ["matcher", "body_matcher", "reply_template"],
        properties: {
          id: { type: "string", description: "Stable rule id; derived from the call when omitted" },
          name: { type: "string" },
          matcher: {
            type: "object",
            required: ["type", "value"],
            properties: {
              type: { enum: ["exact", "prefix", "suffix", "glob"] },
              value: { type: "string" },
            },
          },
          body_matcher: {
            type: "object",
            required: ["type", "value"],
            properties: { type: { const: "keyword" }, value: { type: "string" } },
          },
          reply_template: { type: "string" },
          priority: { type: "number" },
          cooldown_s: { type: "number" },
          max_per_hour: { type: "number" },
          reason: { type: "string" },
        },
      },
      async execute(input, ctx) {
        const prepared = ruleEffect(input);
        if (!("payload" in prepared)) return prepared;

        const payload = prepared.payload;
        const id =
          typeof payload.id === "string" && payload.id !== ""
            ? payload.id
            : `r_${(await sha256Hex(canonicalJson(payload))).slice(0, 16)}`;
        payload.id = id;
        const bodyHash = await sha256Hex(
          canonicalJson({
            matcher: payload.matcher ?? payload.matcher_type,
            body_matcher: payload.body_matcher ?? payload.body_type,
            reply_template: payload.reply_template,
          })
        );

        return executeAct(
          withDeps(ctx),
          {
            tool: "create_rule_now",
            effect: {
              kind: "write",
              scope: "rules:write",
              target: { rule_id: id, body_hash: bodyHash },
            },
            run: async () => fromResponse(await deps.dispatch.createRule(payload, ctx.env, ctx.actor)),
            proposeOnRefusal: async (refusal) => {
              const staged = await deps.dispatch.proposeRule(payload, ctx.env, ctx.actor);
              if (staged === null) return refusal;
              return {
                ok: true,
                output:
                  "No autonomy window covers this, so the rule was prepared as a proposal instead of created. " +
                  "It is waiting for the operator to accept it in the panel.",
                data: { proposal_id: staged.id, kind: "create_rule" },
              };
            },
          },
          input
        );
      },
    },
    {
      name: "send_sms",
      description:
        "Send one SMS now through the existing outbound-send handler. The idempotency key is derived from the call id, never supplied by the model.",
      kind: "act",
      parameters: {
        type: "object",
        required: ["device_id", "to", "body"],
        properties: {
          device_id: { type: "string" },
          to: { type: "string", description: "E.164 recipient" },
          body: { type: "string" },
          reason: { type: "string" },
          expires_in_s: { type: "number" },
        },
      },
      async execute(input, ctx) {
        const deviceId = typeof input.device_id === "string" ? input.device_id : "";
        const to = typeof input.to === "string" ? input.to : "";
        const body = typeof input.body === "string" ? input.body : "";
        if (deviceId === "" || to === "" || body === "") {
          return { ok: false, reason: "bad_request", message: "device_id, to and body are required" };
        }

        const requestBody: Record<string, unknown> = {
          device_id: deviceId,
          to,
          body,
          idempotency_key: ctx.journal.deriveKey(ctx.callId),
        };
        if (typeof input.reason === "string") requestBody.reason = input.reason.slice(0, 200);
        if (typeof input.expires_in_s === "number") requestBody.expires_in_s = input.expires_in_s;

        return executeAct(
          withDeps(ctx),
          {
            tool: "send_sms",
            effect: { kind: "sms", scope: "sms:send:production", target: { recipients: [to] } },
            run: async () => fromResponse(await deps.dispatch.sendSms(requestBody, ctx.env, ctx.actor)),
          },
          input
        );
      },
    },
    {
      name: "deploy_flow",
      description:
        "Save and deploy one workflow graph now, through the existing workflow PUT, with optimistic concurrency and a grant that names the flow and the graph hash.",
      kind: "act",
      parameters: {
        type: "object",
        required: ["flow_id", "graph"],
        properties: {
          flow_id: { type: "string" },
          name: { type: "string" },
          graph: { type: "object" },
          expected_previous_version: { type: "number" },
          enabled: { type: "boolean" },
          device_id: { type: ["string", "null"] },
          reason: { type: "string" },
        },
      },
      async execute(input, ctx) {
        const flowId = typeof input.flow_id === "string" ? input.flow_id : "";
        const graph = asObject(input.graph);
        if (flowId === "" || graph === null) {
          return { ok: false, reason: "bad_request", message: "flow_id and graph are required" };
        }

        const graphHash = await sha256Hex(canonicalJson(graph));
        const body: Record<string, unknown> = {
          graph,
          expected_previous_version: input.expected_previous_version,
        };
        if (typeof input.name === "string") body.name = input.name;
        if (typeof input.enabled === "boolean") body.enabled = input.enabled;
        if (input.device_id !== undefined) body.device_id = input.device_id;
        if (typeof input.reason === "string") body.reason = input.reason.slice(0, 200);

        return executeAct(
          withDeps(ctx),
          {
            tool: "deploy_flow",
            effect: {
              kind: "write",
              scope: "flow_deploy_prod",
              target: { flow_id: flowId, body_hash: graphHash },
            },
            run: async () =>
              fromResponse(await deps.dispatch.deployFlow(flowId, body, ctx.env, ctx.actor)),
          },
          input
        );
      },
    },
  ];
}
