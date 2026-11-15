/**
 * Autonomy grants and the act gate — pass 3, stage C.
 *
 * Two facts hold the whole thing together:
 *
 *   1. A grant names the EFFECT. Autonomy is not "the agent may send SMS for an
 *      hour"; it is "the agent may send to these recipients, at most N times,
 *      until this instant". A flow grant carries the flow id and the hash of
 *      the graph that was approved, so a deploy of different content is a
 *      different effect.
 *   2. The runtime's identity is not authorisation. `authorizeAct` is called at
 *      the moment of the act, re-reads the live grant and the day's counters,
 *      and spends one use. A socket that authenticated an hour ago cannot act
 *      on that fact alone.
 *
 * Autonomy grants are minted under a dedicated, non-token id
 * (`AUTONOMY_TOKEN_ID`). `createGrant` supersedes by (token, scope, target), so
 * a hand-approved grant for the same effect and a scheduled autonomy grant can
 * never silently revoke each other.
 */

import type { Env } from "../index";
import type { AdminActor } from "../audit";
import {
  canonicalTargetJson,
  clampGrantDuration,
  consumeGrantUse,
  createGrant,
  findLiveGrant,
  rollbackGrantUse,
  revokeGrant,
  type GrantRecord,
  type GrantTarget,
} from "../lib/authority";

/** The token id autonomy grants are minted under; never a real `dkf_agt_` id. */
export const AUTONOMY_TOKEN_ID = "autonomy:agent";

export interface AutonomyRow {
  enabled: number;
  sms_cap: number;
  write_cap: number;
  expires_at: number;
  updated_by: string;
  /**
   * The operator's explicit "any rule" consent. An untargeted `rules:write`
   * grant only matches an unscoped request by design, and a rule act always
   * carries the id it just minted, so without this flag the grant could never
   * cover a rule. Bounded by the write cap and the window.
   */
  allow_rules?: number;
  /**
   * The operator this window belongs to. A window is a per-session grant: an act
   * from a different actor is refused with `autonomy_other_session` even while
   * the row is enabled, because "somebody enabled autonomy" must never mean
   * "this operator may act".
   */
  actor?: string | null;
}

export interface UsageRow {
  tokens: number;
  writes: number;
  sms: number;
}

export interface ActEffect {
  kind: "sms" | "write";
  scope: string;
  target: GrantTarget;
  count?: number;
}

export type ActDecision =
  | { ok: true; grantId: string }
  | { ok: false; reason: string; message: string };

export type UsageCharge = "ok" | "sms_cap" | "write_cap";

/** The storage seam `authorizeAct` needs, small enough to fake in a check. */
export interface AutonomyStore {
  readAutonomy(now: number): Promise<AutonomyRow | null>;
  readUsage(day: string): Promise<UsageRow>;
  chargeUsage(
    day: string,
    kind: ActEffect["kind"],
    count: number,
    autonomy: AutonomyRow
  ): Promise<UsageCharge>;
  refundUsage(day: string, kind: ActEffect["kind"], count: number): Promise<void>;
  findGrant(scope: string, target: GrantTarget, now: number): Promise<GrantRecord | null>;
  consumeGrant(grantId: string, count: number, now: number): Promise<boolean>;
  refundGrant(grantId: string, count: number): Promise<void>;
}

/** UTC day key, matching `ai_usage`'s convention. */
export function utcDay(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function d1AutonomyStore(env: Env): AutonomyStore {
  return {
    async readAutonomy() {
      const row = await env.DB.prepare(
        `SELECT enabled, sms_cap, write_cap, expires_at, updated_by, allow_rules, actor
           FROM agent_autonomy WHERE id = 1`
      ).first<AutonomyRow>();
      return row ?? null;
    },
    async readUsage(day) {
      const row = await env.DB.prepare(
        `SELECT tokens, writes, sms FROM agent_usage WHERE day = ?`
      )
        .bind(day)
        .first<UsageRow>();
      return {
        tokens: Number(row?.tokens ?? 0),
        writes: Number(row?.writes ?? 0),
        sms: Number(row?.sms ?? 0),
      };
    },
    async chargeUsage(day, kind, count, autonomy) {
      const column = kind === "sms" ? "sms" : "writes";
      const cap = kind === "sms" ? autonomy.sms_cap : autonomy.write_cap;
      const result = await env.DB.prepare(
        `INSERT INTO agent_usage (day, tokens, writes, sms)
         VALUES (?, 0, ?, ?)
         ON CONFLICT(day) DO UPDATE SET ${column} = ${column} + excluded.${column}
           WHERE ${column} + excluded.${column} <= ?`
      )
        .bind(
          day,
          kind === "write" ? count : 0,
          kind === "sms" ? count : 0,
          cap
        )
        .run();
      if (Number(result.meta?.changes ?? 0) === 0) {
        return kind === "sms" ? "sms_cap" : "write_cap";
      }
      return "ok";
    },
    async refundUsage(day, kind, count) {
      const column = kind === "sms" ? "sms" : "writes";
      await env.DB.prepare(
        `UPDATE agent_usage SET ${column} = MAX(0, ${column} - ?) WHERE day = ?`
      )
        .bind(count, day)
        .run();
    },
    async findGrant(scope, target, now) {
      return findLiveGrant(env, AUTONOMY_TOKEN_ID, scope, target, { now });
    },
    async consumeGrant(grantId, count, now) {
      return consumeGrantUse(env, grantId, now, count);
    },
    async refundGrant(grantId, count) {
      await rollbackGrantUse(env, grantId, count);
    },
  };
}

/**
 * Spend one act against the live grant, the day's counters and the row.
 *
 * Order is deliberate: the cheap, human-visible refusals (off, expired, cap)
 * come before a grant is touched, and a grant use is only spent when the
 * counter update succeeds. If the counter update loses a race, the grant use is
 * refunded so a refused act never costs authority.
 */
export async function authorizeActWithStore(
  store: AutonomyStore,
  _actor: AdminActor | null | undefined,
  effect: ActEffect,
  now: number = Date.now()
): Promise<ActDecision> {
  const count = Math.max(1, Math.trunc(effect.count ?? 1));
  const autonomy = await store.readAutonomy(now);
  if (autonomy === null || Number(autonomy.enabled) !== 1) {
    return { ok: false, reason: "autonomy_off", message: "agent autonomy is off" };
  }
  // A window is opened by one operator for one session. Someone else holding a
  // live socket does not inherit it.
  const owner = typeof autonomy.actor === "string" ? autonomy.actor : "";
  if (owner !== "" && owner !== (_actor?.label ?? "")) {
    return {
      ok: false,
      reason: "autonomy_other_session",
      message: `the autonomy window was opened by ${owner}, not by ${_actor?.label ?? "this session"}`,
    };
  }
  if (Number(autonomy.expires_at) <= now) {
    return {
      ok: false,
      reason: "autonomy_expired",
      message: `agent autonomy expired at ${new Date(Number(autonomy.expires_at)).toISOString()}`,
    };
  }

  const day = utcDay(now);
  const usage = await store.readUsage(day);
  if (effect.kind === "sms" && usage.sms + count > Number(autonomy.sms_cap)) {
    return {
      ok: false,
      reason: "sms_cap",
      message: `agent daily SMS cap reached (${Number(autonomy.sms_cap)}/day)`,
    };
  }
  if (effect.kind === "write" && usage.writes + count > Number(autonomy.write_cap)) {
    return {
      ok: false,
      reason: "write_cap",
      message: `agent daily write cap reached (${Number(autonomy.write_cap)}/day)`,
    };
  }

  let grant = await store.findGrant(effect.scope, effect.target, now);
  if (grant === null && effect.scope === "rules:write" && Number(autonomy.allow_rules) === 1) {
    // The operator enabled "any rule" for this window. The rule's id is minted
    // by the act, so no targeted grant could ever name it.
    grant = await store.findGrant(effect.scope, {}, now);
  }
  if (grant === null) {
    return {
      ok: false,
      reason: "no_grant",
      message:
        `no live autonomy grant covers ${effect.scope} ` +
        canonicalTargetJson(effect.target),
    };
  }

  const consumed = await store.consumeGrant(grant.id, count, now);
  if (!consumed) {
    return {
      ok: false,
      reason: "grant_expired",
      message: `the autonomy grant for ${effect.scope} is expired, revoked or out of uses`,
    };
  }

  const charged = await store.chargeUsage(day, effect.kind, count, autonomy);
  if (charged !== "ok") {
    await store.refundGrant(grant.id, count);
    return {
      ok: false,
      reason: charged,
      message:
        charged === "sms_cap"
          ? `agent daily SMS cap reached (${Number(autonomy.sms_cap)}/day)`
          : `agent daily write cap reached (${Number(autonomy.write_cap)}/day)`,
    };
  }

  return { ok: true, grantId: grant.id };
}

/** The D1-backed form used by the tools. */
export async function authorizeAct(
  env: Env,
  actor: AdminActor | null | undefined,
  effect: ActEffect,
  now: number = Date.now()
): Promise<ActDecision> {
  return authorizeActWithStore(d1AutonomyStore(env), actor, effect, now);
}

/**
 * Refund an act whose effect failed after authorisation. A replay does NOT
 * refund the original call (the original effect happened); it simply never
 * authorises, so it spends nothing.
 */
export async function refundAct(
  env: Env,
  grantId: string | null,
  effect: ActEffect,
  now: number = Date.now()
): Promise<void> {
  if (grantId !== null) await rollbackGrantUse(env, grantId, Math.max(1, effect.count ?? 1));
  const store = d1AutonomyStore(env);
  await store.refundUsage(utcDay(now), effect.kind, Math.max(1, effect.count ?? 1));
}

/** Charge the agent's own token counter, never the console chat budget. */
export async function chargeAgentTokens(
  env: Pick<Env, "DB">,
  tokens: number,
  now: number = Date.now()
): Promise<void> {
  const amount = Number.isFinite(tokens) ? Math.max(0, Math.trunc(tokens)) : 0;
  if (amount === 0) return;
  await env.DB.prepare(
    `INSERT INTO agent_usage (day, tokens, writes, sms) VALUES (?, ?, 0, 0)
     ON CONFLICT(day) DO UPDATE SET tokens = tokens + excluded.tokens`
  )
    .bind(utcDay(now), amount)
    .run();
}

export interface AutonomyPlan {
  /** Window in seconds; clamped per scope by `createGrant`'s caller. */
  ttl_s?: number;
  sms_cap?: number;
  write_cap?: number;
  recipients?: string[];
  sms_max_uses?: number;
  flows?: Array<{ flow_id: string; graph_hash?: string }>;
  rules?: Array<{ rule_id?: string; body_hash?: string }>;
  /**
   * Grant `rules:write` with no target, which matches any rule.
   *
   * This is the widest grant the authority model can express, and it exists
   * because a rule's id is minted by the effect: nothing can name it in advance.
   * It is bounded by the daily write cap and the window, and every use is
   * audited. SMS and flow deploys still require explicit targets — a recipient
   * and a flow id — because those are knowable before the act.
   */
  allow_rules?: boolean;
  write_max_uses?: number;
}

export interface MintedAutonomy {
  grants: GrantRecord[];
  refusals: Array<{ scope: string; message: string }>;
}

/**
 * Mint the effect-shaped grants an autonomy window is worth.
 *
 * Nothing here widens a target: SMS needs explicit recipients, a flow needs its
 * id and graph hash, a rule its id and body hash. A plan naming none of them
 * mints nothing, which is the correct outcome — autonomy without an effect is
 * not authority.
 */
export async function mintAutonomyGrants(
  env: Env,
  actor: AdminActor,
  plan: AutonomyPlan
): Promise<MintedAutonomy> {
  const grants: GrantRecord[] = [];
  const refusals: Array<{ scope: string; message: string }> = [];
  const ttl = Math.max(60, Math.trunc(plan.ttl_s ?? 3_600));
  const smsMaxUses = Math.max(1, Math.trunc(plan.sms_max_uses ?? plan.sms_cap ?? 10));
  const writeMaxUses = Math.max(1, Math.trunc(plan.write_max_uses ?? plan.write_cap ?? 50));

  // `authority_grants.agent_token_id` is a foreign key. The synthetic row is
  // not a credential (its hash can never resolve through `dkf_agt_`), but it
  // must exist before the first grant can reference it. Migration 0012 creates
  // it; this keeps an older database that applied an earlier 0012 working.
  await env.DB.prepare(
    `INSERT INTO agent_tokens
       (id, name, token_hash, scopes_json, max_per_hour, sent_current_hour,
        hour_window_start, created_at, created_by)
     VALUES ('autonomy:agent', 'agent autonomy (runtime)', 'autonomy-not-a-credential',
             '["sms:send:production","rules:write","flow_deploy_prod"]', 0, 0, 0, ?, 'migration:0012')
     ON CONFLICT(id) DO NOTHING`
  )
    .bind(Date.now())
    .run();

  const mint = async (scope: string, target: GrantTarget, maxUses: number) => {
    const clamped = clampGrantDuration(scope, ttl);
    if (clamped === null) {
      refusals.push({ scope, message: `${scope} cannot be granted` });
      return;
    }
    const created = await createGrant(env, {
      agentTokenId: AUTONOMY_TOKEN_ID,
      scope,
      target: { ...target, max_uses: maxUses },
      grantedBy: actor.label,
      actor,
      durationS: clamped.seconds,
    });
    if (created.ok) grants.push(created.grant);
    else refusals.push({ scope, message: created.message });
  };

  const recipients = [...new Set((plan.recipients ?? []).filter((to) => typeof to === "string" && to !== ""))];
  if (recipients.length > 0) {
    await mint("sms:send:production", { recipients }, smsMaxUses);
  }
  for (const flow of plan.flows ?? []) {
    if (typeof flow?.flow_id !== "string" || flow.flow_id === "") continue;
    await mint(
      "flow_deploy_prod",
      {
        flow_id: flow.flow_id,
        ...(typeof flow.graph_hash === "string" && flow.graph_hash !== ""
          ? { body_hash: flow.graph_hash }
          : {}),
      },
      writeMaxUses
    );
  }
  if (plan.allow_rules === true && (plan.rules ?? []).length === 0) {
    // An untargeted rules:write grant: `targetMatches({}, {})` is true, so this
    // covers any rule. Documented at the field above.
    await mint("rules:write", {}, writeMaxUses);
  }
  for (const rule of plan.rules ?? []) {
    const target: GrantTarget = {};
    if (typeof rule?.rule_id === "string" && rule.rule_id !== "") target.rule_id = rule.rule_id;
    if (typeof rule?.body_hash === "string" && rule.body_hash !== "") {
      target.body_hash = rule.body_hash;
    }
    if (Object.keys(target).length === 0) continue;
    await mint("rules:write", target, writeMaxUses);
  }

  return { grants, refusals };
}

export interface EnableAutonomyInput extends AutonomyPlan {
  updated_by: string;
  /** The operator the window belongs to; defaults to `updated_by`. */
  actor?: string;
}

/** Write the singleton row: the window and the two daily caps. */
export async function enableAutonomy(
  env: Pick<Env, "DB">,
  input: EnableAutonomyInput,
  now: number = Date.now()
): Promise<AutonomyRow> {
  const ttl = Math.max(60, Math.min(3_600, Math.trunc(input.ttl_s ?? 3_600)));
  const smsCap = Math.max(0, Math.trunc(input.sms_cap ?? 10));
  const writeCap = Math.max(0, Math.trunc(input.write_cap ?? 50));
  const row: AutonomyRow = {
    enabled: 1,
    sms_cap: smsCap,
    write_cap: writeCap,
    expires_at: now + ttl * 1_000,
    updated_by: input.updated_by,
    allow_rules: input.allow_rules === true ? 1 : 0,
    actor: input.actor ?? input.updated_by,
  };
  await env.DB.prepare(
    `INSERT INTO agent_autonomy (id, enabled, sms_cap, write_cap, expires_at, updated_by, updated_at, allow_rules, actor)
     VALUES (1, 1, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       enabled = 1,
       sms_cap = excluded.sms_cap,
       write_cap = excluded.write_cap,
       expires_at = excluded.expires_at,
       updated_by = excluded.updated_by,
       updated_at = excluded.updated_at,
       allow_rules = excluded.allow_rules,
       actor = excluded.actor`
  )
    .bind(smsCap, writeCap, row.expires_at, row.updated_by, now, row.allow_rules, row.actor ?? null)
    .run();
  return row;
}

/** The kill switch: stop the window and revoke every autonomy grant. */
export async function revokeAutonomy(
  env: Pick<Env, "DB">,
  by: string,
  now: number = Date.now()
): Promise<number> {
  await env.DB.prepare(
    `INSERT INTO agent_autonomy (id, enabled, sms_cap, write_cap, expires_at, updated_by, updated_at)
     VALUES (1, 0, 0, 0, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       enabled = 0,
       expires_at = excluded.expires_at,
       updated_by = excluded.updated_by,
       updated_at = excluded.updated_at`
  )
    .bind(now, by, now)
    .run();
  const result = await env.DB.prepare(
    `UPDATE authority_grants SET revoked_at = ?
       WHERE agent_token_id = ? AND revoked_at IS NULL`
  )
    .bind(now, AUTONOMY_TOKEN_ID)
    .run();
  return Number(result.meta?.changes ?? 0);
}

export interface AutonomyStatus {
  enabled: boolean;
  sms_cap: number;
  write_cap: number;
  expires_at: number | null;
  updated_by: string | null;
  usage: UsageRow & { day: string };
}

/** One sentence the prompt can carry: what the agent may do, and what is left. */
export function describeAutonomy(status: AutonomyStatus): string {
  if (!status.enabled) {
    return "Autonomy is OFF. Do not call an act tool; propose instead, and say that acting needs autonomy enabled.";
  }
  const until = status.expires_at === null ? "no stated expiry" : new Date(status.expires_at).toISOString();
  const writes = `${status.usage.writes}/${status.write_cap} writes today`;
  const sms = `${status.usage.sms}/${status.sms_cap} SMS today`;
  return `Autonomy is ON until ${until}: ${writes}, ${sms}. Live grants cover the act classes this window minted, so call the act tool and let it answer; a refusal names the reason.`;
}

export async function readAutonomyStatus(
  env: Pick<Env, "DB">,
  now: number = Date.now()
): Promise<AutonomyStatus> {
  const row = await env.DB.prepare(
    `SELECT enabled, sms_cap, write_cap, expires_at, updated_by, allow_rules, actor
       FROM agent_autonomy WHERE id = 1`
  ).first<AutonomyRow>();
  const day = utcDay(now);
  const usage = await env.DB.prepare(
    `SELECT tokens, writes, sms FROM agent_usage WHERE day = ?`
  )
    .bind(day)
    .first<UsageRow>();
  return {
    enabled: row !== null && Number(row.enabled) === 1 && Number(row.expires_at) > now,
    sms_cap: Number(row?.sms_cap ?? 0),
    write_cap: Number(row?.write_cap ?? 0),
    expires_at: row === null ? null : Number(row.expires_at),
    updated_by: row?.updated_by ?? null,
    usage: {
      day,
      tokens: Number(usage?.tokens ?? 0),
      writes: Number(usage?.writes ?? 0),
      sms: Number(usage?.sms ?? 0),
    },
  };
}

/** Revoke one autonomy grant by id (used by the status view's revoke path). */
export async function revokeAutonomyGrant(
  env: Env,
  grantId: string,
  now: number = Date.now()
): Promise<GrantRecord | null> {
  return revokeGrant(env, grantId, now);
}
