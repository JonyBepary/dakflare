/**
 * The agent runtime's HTTP gate and its single-use upgrade tickets.
 *
 * This module is deliberately free of `agents` imports and of the auth
 * library: the checks under `__checks__/agent-runtime.mjs` exercise the Origin
 * matrix and the ticket lifecycle with nothing but `crypto` and D1-shaped
 * objects, and the Worker entry point composes the session lookup around the
 * pieces exported here.
 *
 * Three rules hold the connection together:
 *
 *   1. The object name is fixed server-side. `/agents/device/<anything>` would
 *      otherwise mint unbounded objects out of the three existing namespaces, so
 *      the entry point rewrites every `/agents/*` path to the one pinned name and
 *      this gate refuses any other Durable Object class.
 *   2. An upgrade checks the Origin exactly. `SameSite=Strict` already keeps a
 *      cross-site cookie off the request; comparing the Origin makes that
 *      explicit instead of incidental. Prefix comparison would accept
 *      `https://console.example.evil.test`, so it is string equality of origins.
 *   3. A ticket is 32 random bytes, hashed at rest, bound to the session that
 *      minted it and to the object name it may reach, and spent exactly once.
 *      A WebSocket rejection cannot carry a status a browser will show, so the
 *      ticket is spent here and the mint route is where a refusal is readable.
 */

import type { Env } from "../index";

/** The one Durable Object an agent connection may ever reach. */
export const ASSISTANT_OBJECT_NAME = "assistant";

/** The one binding name `routeAgentRequest` must have matched. */
export const ASSISTANT_BINDING = "ASSISTANT";

/** How long a minted ticket stays redeemable. */
export const TICKET_TTL_MS = 60_000;

/** How long a spent ticket stays diagnosable as "already used". */
const TICKET_TOMBSTONE_MS = 10 * 60_000;

export type TicketFailure =
  | "missing"
  | "unknown"
  | "expired"
  | "already_used"
  | "wrong_session"
  | "wrong_object";

/**
 * Is this Origin one we trust for an agent socket?
 *
 * The trusted set is the request's own origin (a same-origin console), the
 * deployment's `AUTH_BASE_URL`, and every entry of `AUTH_TRUSTED_ORIGINS`.
 * Each value is normalised through `URL` and compared as whole origins, so a
 * lookalike host or a path prefix can never match.
 */
export function isTrustedOrigin(
  request: Request,
  env: Pick<Env, "AUTH_BASE_URL" | "AUTH_TRUSTED_ORIGINS">
): { ok: true; origin: string } | { ok: false; reason: string } {
  const header = request.headers.get("Origin");
  if (header === null || header.trim() === "") {
    return { ok: false, reason: "origin_missing" };
  }

  let supplied: string;
  try {
    supplied = new URL(header).origin;
  } catch {
    return { ok: false, reason: "origin_malformed" };
  }

  const trusted = new Set<string>();
  const trustedHosts = new Set<string>();
  try {
    const own = new URL(request.url);
    trusted.add(own.origin);
    // The Worker sees its own URL with an internal scheme (production reports
    // http for a workers.dev route while every browser Origin is https), so a
    // same-host Origin is accepted on either scheme. A hostile party controlling
    // the scheme of our own host already controls the host.
    trustedHosts.add(own.host);
  } catch {
    // A local dev request always parses; if it does not, only the configured
    // origins remain trusted.
  }
  const base = env.AUTH_BASE_URL?.trim();
  if (base !== undefined && base !== "") {
    try {
      trusted.add(new URL(base).origin);
    } catch {
      // A malformed AUTH_BASE_URL is already reported by the auth routes; do not
      // turn it into a second, silent trust decision here.
    }
  }
  for (const entry of (env.AUTH_TRUSTED_ORIGINS ?? "").split(",")) {
    const value = entry.trim();
    if (value === "") continue;
    try {
      trusted.add(new URL(value).origin);
    } catch {
      // Ignore a malformed extra origin rather than trusting a prefix of it.
    }
  }

  if (trusted.has(supplied)) return { ok: true, origin: supplied };
  try {
    if (trustedHosts.has(new URL(supplied).host)) return { ok: true, origin: supplied };
  } catch {
    // unparsable origins were already refused above
  }
  return { ok: false, reason: "origin_untrusted" };
}

/** What the check order decided about an upgrade request, before any storage. */
export type UpgradeCheck =
  | { ok: true; origin: string; ticket: string }
  | { ok: false; response: Response };

/**
 * Method, Upgrade and Origin, in that order, for a WebSocket request.
 *
 * The ticket is read but not spent here: redemption needs the session id, and
 * the caller resolves the session first so a stolen ticket is refused as
 * `wrong_session` rather than burning the real owner's upgrade.
 */
export function checkUpgradeRequest(
  request: Request,
  env: Pick<Env, "AUTH_BASE_URL" | "AUTH_TRUSTED_ORIGINS">
): UpgradeCheck {
  if (request.method !== "GET") {
    return { ok: false, response: refusal("method_not_allowed", 405) };
  }
  if ((request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket") {
    return { ok: false, response: refusal("upgrade_required", 426) };
  }
  const origin = isTrustedOrigin(request, env);
  if (!origin.ok) {
    return { ok: false, response: refusal(origin.reason, 403) };
  }
  const ticket = new URL(request.url).searchParams.get("ticket");
  if (ticket === null || ticket === "") {
    return { ok: false, response: refusal("ticket_missing", 401) };
  }
  return { ok: true, origin: origin.origin, ticket };
}

/**
 * The allowlist every routed request passes before anything else.
 *
 * `routeAgentRequest` maps EVERY Durable Object binding, so without this a
 * caller reaches `DEVICE`, `AUTH_GUARD` and `AUTHORITY_GUARD` through the same
 * `/agents/*` prefix. A non-ASSISTANT class is answered as not found, which is
 * the same answer an unknown binding gets from the router.
 */
export function assertAssistantRoute(route: { className?: string }): Response | null {
  if (route.className === ASSISTANT_BINDING) return null;
  return Response.json({ error: "not_found" }, { status: 404 });
}

function refusal(error: string, status: number): Response {
  return Response.json({ error: `agent_${error}` }, { status });
}

/** A ticket token: 32 random bytes, URL-safe, never logged. */
export function mintTicketToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** SHA-256 hex. Short-lived and single use, so a plain digest is enough. */
export async function hashTicket(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export interface MintedTicket {
  ticket: string;
  expires_at: number;
}

/**
 * Mint one ticket bound to `sessionId` and `objectName`.
 *
 * Expired rows and old tombstones are pruned here rather than by a cron: a
 * self-hosted deployment has no guaranteed cron for this table, and the write
 * is bounded to rows that are already dead.
 */
export async function mintTicket(
  env: Pick<Env, "DB">,
  sessionId: string,
  objectName: string = ASSISTANT_OBJECT_NAME,
  now = Date.now()
): Promise<MintedTicket> {
  const ticket = mintTicketToken();
  const tokenHash = await hashTicket(ticket);
  const expiresAt = now + TICKET_TTL_MS;

  await env.DB.batch([
    env.DB.prepare(`DELETE FROM agent_runtime_tickets WHERE expires_at <= ?`).bind(now),
    env.DB.prepare(`DELETE FROM agent_runtime_ticket_uses WHERE used_at <= ?`).bind(
      now - TICKET_TOMBSTONE_MS
    ),
    env.DB.prepare(
      `INSERT INTO agent_runtime_tickets
         (token_hash, session_id, object_name, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(tokenHash, sessionId, objectName, now, expiresAt),
  ]);

  return { ticket, expires_at: expiresAt };
}

/**
 * Spend a ticket. The success path deletes the row so a replay cannot work;
 * a tombstone keeps the refusal diagnosable as `already_used` instead of
 * collapsing it into `unknown`.
 */
export async function redeemTicket(
  env: Pick<Env, "DB">,
  token: string,
  sessionId: string,
  objectName: string = ASSISTANT_OBJECT_NAME,
  now = Date.now()
): Promise<{ ok: true } | { ok: false; reason: TicketFailure }> {
  const tokenHash = await hashTicket(token);

  const spent = await env.DB.prepare(
    `DELETE FROM agent_runtime_tickets
      WHERE token_hash = ? AND session_id = ? AND object_name = ? AND expires_at > ?`
  )
    .bind(tokenHash, sessionId, objectName, now)
    .run();

  if (Number(spent.meta?.changes ?? 0) > 0) {
    // Best effort: losing the tombstone only costs the nicer refusal reason.
    try {
      await env.DB.prepare(
        `INSERT OR REPLACE INTO agent_runtime_ticket_uses (token_hash, used_at) VALUES (?, ?)`
      )
        .bind(tokenHash, now)
        .run();
    } catch {
      // The ticket is spent either way.
    }
    return { ok: true };
  }

  const row = await env.DB.prepare(
    `SELECT session_id, object_name, expires_at FROM agent_runtime_tickets WHERE token_hash = ?`
  )
    .bind(tokenHash)
    .first<{ session_id: string; object_name: string; expires_at: number }>();

  if (row !== null && row !== undefined) {
    if (Number(row.expires_at) <= now) {
      await env.DB.prepare(`DELETE FROM agent_runtime_tickets WHERE token_hash = ?`)
        .bind(tokenHash)
        .run();
      return { ok: false, reason: "expired" };
    }
    if (row.session_id !== sessionId) return { ok: false, reason: "wrong_session" };
    if (row.object_name !== objectName) return { ok: false, reason: "wrong_object" };
    // The row matched every condition and the DELETE still changed nothing: a
    // concurrent redemption won between the two statements.
    return { ok: false, reason: "already_used" };
  }

  const used = await env.DB.prepare(
    `SELECT 1 AS used FROM agent_runtime_ticket_uses WHERE token_hash = ?`
  )
    .bind(tokenHash)
    .first<{ used: number }>();
  if (used !== null && used !== undefined) return { ok: false, reason: "already_used" };

  return { ok: false, reason: "unknown" };
}

/** The 401/403 body for a failed redemption, with the reason in the code. */
export function ticketRefusal(reason: TicketFailure): Response {
  return Response.json(
    {
      error: `agent_ticket_${reason}`,
      message:
        reason === "missing"
          ? "no ticket was supplied"
          : reason === "unknown"
            ? "this ticket was never minted here"
            : reason === "expired"
              ? "this ticket expired; mint a new one"
              : reason === "already_used"
                ? "this ticket was already spent"
                : reason === "wrong_session"
                  ? "this ticket belongs to a different session"
                  : "this ticket is bound to a different agent object",
    },
    { status: reason === "wrong_session" ? 403 : 401 }
  );
}
