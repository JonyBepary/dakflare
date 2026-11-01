/**
 * The agent scope vocabulary, and the one table that maps an admin route to the
 * scope an agent token needs to reach it.
 *
 * Two ideas are separated on purpose:
 *
 *   SCOPE   what a token may ATTEMPT. It is a property of the credential and is
 *           minted with it.
 *   GRANT   what a token may actually DO, for how long, over which target. It is
 *           a property of a human's decision and it expires.
 *
 * `sms:send` is the clearest case. A token holding it may ask to send; every
 * production send still needs a live `sms:send:production` grant, because an
 * agent that can spend money unattended is the failure this whole subsystem
 * exists to prevent. The grant carries the recipients, so approving "send to
 * these two numbers for fifteen minutes" cannot become "send to anyone".
 *
 * Everything an agent is denied, it is denied by CONSTRUCTION rather than by a
 * scope it might be granted: `devices:revoke` and `auth:reset` are not in
 * `TOKEN_SCOPES`, so `mint` refuses them and no grant can add them. A scope an
 * operator cannot mint is a scope an injected agent cannot obtain.
 */

/**
 * What a token may be minted with. Anything outside this list is refused at
 * mint time with a 400 naming the unknown scope, rather than silently dropped:
 * a token that quietly lacks the scope it printed is worse than one that failed
 * to mint.
 */
export const TOKEN_SCOPES = [
  // Reads.
  "messages:read",
  "devices:read",
  "flows:read",
  "audit:read",
  // Writes that are reversible or cheap.
  "sms:send",
  "messages:purge",
  "alerts:write",
  "flows:write",
  "devices:write",
  "rules:write",
  "webhooks:write",
  // Writes that cost money, interrupt traffic, or redeploy production. Each one
  // also requires a live grant, even though the token may hold the scope.
  "sms:send:production",
  "enable_shortcode",
  "dlq_bulk_replay",
  "flow_deploy_prod",
] as const;

export type TokenScope = (typeof TOKEN_SCOPES)[number];

const TOKEN_SCOPE_SET: ReadonlySet<string> = new Set(TOKEN_SCOPES);

export function isTokenScope(value: unknown): value is TokenScope {
  return typeof value === "string" && TOKEN_SCOPE_SET.has(value);
}

/**
 * Scopes that a grant must additionally cover, per action.
 *
 * `sms:send:production` is the grant scope for sending: there is no separate
 * "sandbox" in a self-hosted gateway, every SMS leaves a real radio and costs
 * real money, so the distinction is between "the agent may ask" and "a human
 * said yes to these recipients until this time".
 */
export const GRANT_REQUIRED_SCOPES: ReadonlySet<string> = new Set([
  "sms:send:production",
  "enable_shortcode",
  "dlq_bulk_replay",
  "flow_deploy_prod",
  "rules:write",
  "webhooks:write",
]);

/** The eight rungs an operator may pick from. Anything else is clamped to one. */
export const GRANT_LADDER_S: readonly number[] = [
  60, // 1 minute
  300, // 5 minutes
  900, // 15 minutes
  1_800, // 30 minutes
  3_600, // 1 hour
  86_400, // 1 day
  604_800, // 7 days
  2_592_000, // 30 days
];

/**
 * The ceiling per scope. The ladder is what a human may CHOOSE; this is what the
 * system will actually allow, because a menu entry is not a promise.
 *
 * `sms:send:production` is capped at one hour on purpose. "Production SMS for 30
 * days unattended" is the runaway loop this pillar exists to stop, and unlocking
 * it should take a deliberate edit to this table rather than a slip of the mouse
 * in a dropdown.
 */
export interface ScopeCap {
  /** Longest grant, in seconds. */
  max_ttl_s: number;
  /**
   * What `target_json` must name for this scope. `null` means a free-form
   * target, which is only true for read scopes.
   */
  requires: "recipients-or-device" | "device" | "flow" | "rule" | null;
}

export const SCOPE_CAPS: Readonly<Record<string, ScopeCap>> = {
  "sms:send:production": { max_ttl_s: 3_600, requires: "recipients-or-device" },
  enable_shortcode: { max_ttl_s: 900, requires: "rule" },
  dlq_bulk_replay: { max_ttl_s: 900, requires: "device" },
  flow_deploy_prod: { max_ttl_s: 86_400, requires: "flow" },
  "rules:write": { max_ttl_s: 86_400, requires: null },
  "webhooks:write": { max_ttl_s: 86_400, requires: null },
  "messages:read": { max_ttl_s: 2_592_000, requires: null },
  "devices:read": { max_ttl_s: 2_592_000, requires: null },
  "flows:read": { max_ttl_s: 2_592_000, requires: null },
  "audit:read": { max_ttl_s: 2_592_000, requires: null },
};

/**
 * Scopes that exist only to be refused to agents. They are named here so a
 * reader can see the decision, and so `grantAuthority` can say WHY it refused
 * instead of answering "unknown scope".
 */
export const NEVER_GRANTABLE: Readonly<Record<string, string>> = {
  "devices:revoke": "revoking a handset needs a human credential, never a grant",
  "auth:reset": "resetting an account needs a human credential, never a grant",
};

/**
 * Route action -> scope. The `action` strings are the ones `withAdminAccess`
 * already passes for the audit log, so the policy reads as a table instead of
 * being scattered across fifty call sites.
 *
 * A missing entry means NO agent token may reach that route, which is the safe
 * default: a new route is invisible to agents until someone decides otherwise
 * here. `null` is written explicitly where the decision is "never" so it reads
 * as a decision rather than an omission.
 */
export const SCOPE_FOR_ACTION: Readonly<Record<string, string | null>> = {
  // Reads.
  "read messages": "messages:read",
  "read command status": "messages:read",
  "read device commands": "messages:read",
  "read alerts": "messages:read",
  "read workflows": "flows:read",
  "read rules": "flows:read",
  "test rules": "flows:read",
  "list devices": "devices:read",
  "read device status": "devices:read",
  "read health": "devices:read",
  "read the audit log": "audit:read",
  "read trace": "messages:read",
  "read the dead letter queue": "devices:read",
  "inspect sockets": "devices:read",

  // Writes.
  "send SMS": "sms:send",
  "purge messages": "messages:purge",
  "acknowledge alerts": "alerts:write",
  "save workflows": "flows:write",
  "delete workflows": "flows:write",
  "save rules": "rules:write",
  "delete rules": "rules:write",
  "pair devices": "devices:write",
  "archive devices": "devices:write",
  "unarchive devices": "devices:write",

  // Never for an agent token. Listed so the refusal is a decision.
  "revoke devices": null,
  "create invites": null,
  "list invites": null,
  "revoke invites": null,
  // The control plane itself. An agent that could mint tokens, approve its own
  // requests or read the grant table would not need a grant at all.
  "mint agent tokens": null,
  "list agent tokens": null,
  "revoke agent tokens": null,
  "read approvals": null,
  "approve authority": null,
  "reject authority": null,
  "read grants": null,
  "revoke grants": null,
};

/**
 * Resolve the scope for a route action. `undefined` (unknown action) and `null`
 * (explicitly never) both mean "an agent token cannot reach this", and the
 * caller distinguishes them only for the sentence it prints.
 */
export function scopeForAction(action: string): string | null {
  const entry = SCOPE_FOR_ACTION[action];
  return entry === undefined ? null : entry;
}

/** Scopes whose use must be covered by a live grant in addition to the token. */
export function scopeNeedsGrant(scope: string): boolean {
  return GRANT_REQUIRED_SCOPES.has(scope);
}
