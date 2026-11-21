/**
 * Elicitation for mutating tools — a human answer in the middle of an MCP call.
 *
 * A read tool runs on the token alone. A tool that spends money or changes a
 * production flow does not: before it executes, the client is asked for three
 * things in one `elicitation/create` round trip:
 *
 *   `confirm_deployment`  a boolean, so "accept" is not the only yes
 *   `totp_code`           the same six-digit code the auth routes check
 *   `max_uses`            how many times the minted grant may be spent
 *
 * The answer is correlated by id in `transport.ts`'s bounded registry. Decline,
 * cancel and a 60-second timeout all abort with a JSON-RPC error; none of them
 * falls through to the tool.
 *
 * ## What is checked, in what order
 *
 *   1. The action is `accept` and `confirm_deployment` is true.
 *   2. The payload hash in `state` matches the arguments about to run. This is
 *      the body binding: a client cannot get a human to confirm one SMS body and
 *      then execute another. (The hash is not put in the GRANT target for
 *      `send_sms`, because the send gate compares `{recipients, device_id}` and
 *      an extra constraint would make the grant match nothing.)
 *   3. The TOTP is verified with the plugin's own primitives (decrypt with
 *      `symmetricDecrypt`, verify with `createOTP` at 6 digits / 30 seconds),
 *      exactly as `auth/challenge.ts` does. There is no second TOTP
 *      implementation here.
 *   4. `createGrant` mints the authority target from `canonicalTargetJson`, with
 *      `max_uses` from the answer and a 15-minute ceiling from the scope ladder.
 *
 * If no owner/admin account has TOTP enabled, step 3 fails closed: an
 * unattended agent cannot approve itself.
 */


import type { Env } from "../index";
import type { AdminActor } from "../audit";
import { writeAudit } from "../audit";
import { canonicalTargetJson, clampGrantDuration, createGrant, type GrantTarget } from "../lib/authority";
import { TOTP_DIGITS } from "../auth/settings";
import { verifyDeploymentTotp } from "../lib/totp";
import {
  ElicitationFailure,
  JSON_RPC,
  type ElicitationAnswer,
  type ElicitationDriver,
  type ElicitationRequestSpec,
} from "./transport";

/** What a mutating tool needs before it runs. */
interface MutationRule {
  /** The scope whose grant is minted after the human confirms. */
  scope: string;
  /** Longest grant this rule will mint, passed through the scope ladder. */
  durationS: number;
  /** Human-readable subject for the message: "SMS to +880…". */
  describe: (args: Record<string, unknown>) => string;
}

/**
 * The mutation surface, by the names `tools.ts` publishes.
 *
 * `dispatch_message` / `patch_flow` are accepted as aliases so a client built
 * against the plan's names reaches the same guard as the deployed `send_sms`
 * tool. An unknown tool never reaches this table, and therefore never gets a
 * silent pass: `request()` returns null only for tools absent from it, and
 * those are read-only.
 */
const MUTATIONS: Record<string, MutationRule> = {
  send_sms: {
    scope: "sms:send:production",
    durationS: 900,
    describe: (args) =>
      `SMS to ${typeof args.to === "string" ? args.to : "the recipient"} on ${typeof args.device_id === "string" ? args.device_id : "a handset"}`,
  },
  dispatch_message: {
    scope: "sms:send:production",
    durationS: 900,
    describe: (args) =>
      `SMS to ${typeof args.to === "string" ? args.to : "the recipient"} on ${typeof args.device_id === "string" ? args.device_id : "a handset"}`,
  },
  dakflare_dispatch_message: {
    scope: "sms:send:production",
    durationS: 900,
    describe: (args) =>
      `SMS to ${typeof args.to === "string" ? args.to : "the recipient"} on ${typeof args.device_id === "string" ? args.device_id : "a handset"}`,
  },
  patch_flow: {
    scope: "flow_deploy_prod",
    durationS: 900,
    describe: (args) =>
      `flow ${typeof args.flow_id === "string" ? args.flow_id : typeof args.id === "string" ? args.id : "unknown"}`,
  },
  dakflare_patch_flow: {
    scope: "flow_deploy_prod",
    durationS: 900,
    describe: (args) =>
      `flow ${typeof args.flow_id === "string" ? args.flow_id : typeof args.id === "string" ? args.id : "unknown"}`,
  },
};

/** Exported so the route lane can document exactly what asks for a human. */
export const MUTATING_TOOL_NAMES = Object.keys(MUTATIONS);

/** The schema every mutating call shows the client. */
export const ELICITATION_REQUESTED_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    confirm_deployment: {
      type: "boolean",
      title: "Confirm this change",
      description: "Must be true. False declines the call.",
    },
    totp_code: {
      type: "string",
      title: "Authenticator code",
      description: "The six-digit code from the account's authenticator app.",
      pattern: "^[0-9]{6}$",
      minLength: TOTP_DIGITS,
      maxLength: TOTP_DIGITS,
    },
    max_uses: {
      type: "integer",
      title: "Maximum uses",
      description: "How many times the minted authority grant may be spent.",
      minimum: 1,
    },
  },
  required: ["confirm_deployment", "totp_code", "max_uses"],
  additionalProperties: false,
};

export interface ElicitationContent {
  confirm_deployment: boolean;
  totp_code: string;
  max_uses: number;
}

/** Validate the `content` object. Returns the named field that was wrong. */
export function validateElicitationContent(content: Record<string, unknown> | undefined): ElicitationContent {
  if (content === undefined) {
    throw new ElicitationFailure(JSON_RPC.INVALID_PARAMS, "Elicitation accepted without content");
  }
  if (content.confirm_deployment !== true) {
    throw new ElicitationFailure(
      JSON_RPC.ELICITATION_DECLINED,
      "confirm_deployment was not true; the tool call was not executed."
    );
  }
  const code = content.totp_code;
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) {
    throw new ElicitationFailure(JSON_RPC.INVALID_PARAMS, "totp_code must be exactly six digits");
  }
  const maxUses = content.max_uses;
  if (typeof maxUses !== "number" || !Number.isInteger(maxUses) || maxUses < 1) {
    throw new ElicitationFailure(JSON_RPC.INVALID_PARAMS, "max_uses must be an integer of at least 1");
  }
  return { confirm_deployment: true, totp_code: code, max_uses: maxUses };
}

/* ─────────────────────────────── hashing ─────────────────────────────── */

/** Stable JSON: object keys sorted, so the same request hashes the same way. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(row[key])}`).join(",")}}`;
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 of the canonical command/flow payload, as lowercase hex. */
export async function payloadHash(toolName: string, args: Record<string, unknown>): Promise<string> {
  const command =
    toolName === "send_sms" || toolName === "dispatch_message" || toolName === "dakflare_dispatch_message"
      ? {
          kind: "sms",
          device_id: args.device_id ?? null,
          to: args.to ?? null,
          body: args.body ?? null,
          idempotency_key: args.idempotency_key ?? null,
        }
      : {
          kind: "flow",
          flow_id: args.flow_id ?? args.id ?? null,
          graph: args.graph ?? args.flow ?? args.nodes ?? null,
        };
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(command)));
  return toHex(digest);
}

/* ─────────────────────────────── driver ─────────────────────────────── */

/**
 * Build the driver the transport calls around every tool.
 *
 * The driver is bound to one request's actor, exactly like the tool list: the
 * grant it mints belongs to the token that asked, so one request's approval
 * cannot be replayed by another credential.
 */
export function createElicitationDriver(env: Env, actor: AdminActor): ElicitationDriver {
  return {
    async request(toolName, args): Promise<ElicitationRequestSpec | null> {
      const rule = MUTATIONS[toolName];
      if (rule === undefined) return null;

      const hash = await payloadHash(toolName, args);
      return {
        message:
          `Confirm ${rule.describe(args)}. This asks for your authenticator code ` +
          `and mints an authority grant for at most ${Math.round(rule.durationS / 60)} minutes. ` +
          `Payload ${hash.slice(0, 16)}.`,
        requestedSchema: ELICITATION_REQUESTED_SCHEMA,
        state: { toolName, hash },
      };
    },

    async complete(toolName, args, answer: ElicitationAnswer, state): Promise<void> {
      const rule = MUTATIONS[toolName];
      if (rule === undefined) return; // read-only: nothing to authorise

      if (answer.action !== "accept") {
        throw new ElicitationFailure(
          JSON_RPC.ELICITATION_DECLINED,
          "Elicitation was not accepted; the tool call was not executed."
        );
      }

      const content = validateElicitationContent(answer.content);

      const expectedHash =
        state !== null && typeof state === "object" && typeof (state as Record<string, unknown>).hash === "string"
          ? ((state as Record<string, unknown>).hash as string)
          : null;
      const actualHash = await payloadHash(toolName, args);
      if (expectedHash !== null && expectedHash !== actualHash) {
        throw new ElicitationFailure(
          JSON_RPC.INVALID_PARAMS,
          "The payload changed after it was confirmed; the tool call was not executed."
        );
      }

      const verified = await verifyDeploymentTotp(env, actor, content.totp_code);
      if (!verified) {
        throw new ElicitationFailure(
          JSON_RPC.ELICITATION_REJECTED,
          "The authenticator code was not accepted; the tool call was not executed."
        );
      }

      // A human actor already holds the permission; only an agent token needs a
      // grant minted from the answer.
      if (actor.agentTokenId === undefined) return;

      const clamped = clampGrantDuration(rule.scope, rule.durationS);
      if (clamped === null) {
        throw new ElicitationFailure(
          JSON_RPC.INTERNAL_ERROR,
          `Internal error: ${rule.scope} has no grant ceiling`
        );
      }

      const target = authorityTarget(toolName, args, actualHash, content.max_uses);
      const created = await createGrant(env, {
        agentTokenId: actor.agentTokenId,
        scope: rule.scope,
        target,
        grantedBy: actor.label,
        // The TOTP just proved a person answered this call. `role: "machine"`
        // is the "admin token" side of `assertHuman`, which exists to refuse an
        // agent approving itself without that proof.
        actor:
          actor.userId !== null
            ? actor
            : { userId: null, label: actor.label, role: "machine", canGrantOwner: false },
        durationS: clamped.seconds,
      });
      if (!created.ok) {
        throw new ElicitationFailure(JSON_RPC.INTERNAL_ERROR, `Internal error: ${created.message}`);
      }

      await writeAudit(env, {
        action: "mcp.elicited_grant",
        actor,
        subject: created.grant.id,
        detail: {
          tool: toolName,
          scope: rule.scope,
          target_json: canonicalTargetJson(target),
          body_hash: actualHash,
          max_uses: content.max_uses,
          expires_at: created.grant.expires_at,
        },
      });
    },
  };
}

/**
 * The target a grant is minted over.
 *
 * `send_sms` must match the send gate's request exactly (`recipients` +
 * `device_id`), so the body hash stays out of the grant and is enforced by the
 * hash comparison above instead. A flow deployment has no such gate, so its
 * target carries `flow_id` and `body_hash` directly.
 */
function authorityTarget(
  toolName: string,
  args: Record<string, unknown>,
  hash: string,
  maxUses: number
): GrantTarget {
  if (toolName === "send_sms" || toolName === "dispatch_message" || toolName === "dakflare_dispatch_message") {
    return {
      recipients: [String(args.to ?? "")].filter((value) => value !== ""),
      device_id: typeof args.device_id === "string" ? args.device_id : undefined,
      max_uses: maxUses,
    };
  }
  return {
    flow_id:
      typeof args.flow_id === "string"
        ? args.flow_id
        : typeof args.id === "string"
          ? args.id
          : undefined,
    body_hash: hash,
    max_uses: maxUses,
  };
}
