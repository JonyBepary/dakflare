/**
 * SMS Gateway v5 — Worker entry point.
 * Implements PROTOCOL_CONTRACT_V5 Rev C §1 (transport), §3.2 (validation order),
 * §6 (command state machine surface) and §8 (error envelope), and ports
 * master plan §5.2 with brief fixes #2, #19 and #20.
 *
 * Auth surfaces:
 *   - public:  POST /v1/device/pair              (single-use pairing code)
 *   - admin:   Authorization: Bearer <ADMIN_TOKEN>, constant-time compared
 *   - device:  ECDSA P-256 signature over the §2 canonical string
 */

import { DeviceGateway } from "./durable-object";
import { AuthGuard } from "./auth-guard";
import { verifyDeviceSignature } from "./auth/ecdsa";
import { handleAdminPairingCode, handleDevicePair, handleDevicesList } from "./routes/pair";
import { handleSend, handleSendBatch } from "./routes/send";
import { handleWs } from "./routes/ws";
import { handleIncomingBatch, handleMessagesList, handleMessagesPurge } from "./routes/incoming";
import { handlePoll } from "./routes/poll";
import { handleCommandStatus, handleStatusBatch } from "./routes/status";
import { handleRulesGet, handleRulesPost, handleRulesTest } from "./routes/rules";
import {
  handleDeviceFlows,
  handleWorkflowDelete,
  handleWorkflowGet,
  handleWorkflowPut,
  handleWorkflowsList,
} from "./routes/workflows";
import { handleHealth } from "./routes/health";
import {
  handleDeviceArchive,
  handleDeviceCommands,
  handleDeviceRevoke,
  handleDeviceUnarchive,
  handleRuleDelete,
  handleRulesListAdmin,
} from "./routes/admin";
import { handleAlertAck, handleAlertsList } from "./routes/alerts";
import { requireRole, type AuthUser, type Permission } from "./auth";
import {
  handleAgentTokenList,
  handleAgentTokenMint,
  handleAgentTokenRevoke,
} from "./routes/agent-tokens";
import {
  handleApprovalApprove,
  handleApprovalReject,
  handleApprovalsList,
  handleGrantRevoke,
  handleGrantsList,
} from "./routes/approvals";
import { AuthorityGuard } from "./authority-guard";
import { looksLikeAgentToken, recordTokenUse, resolveAgentToken } from "./lib/agent-tokens";
import { scopeForAction } from "./lib/agent-scopes";
import {
  handleAuthRequest,
  handleMagicLinkConsume,
  handleMagicLinkRequest,
  handlePasswordRemove,
  handlePasswordSalt,
  handlePasswordSet,
  handlePasswordSignIn,
  handleRotatePepper,
  handleTotpDisable,
  handleTotpEnable,
  handleTotpRegenerate,
  handleTotpStatus,
} from "./auth";
import { requestMeta, writeAudit, type AdminActor } from "./audit";
import { handleRedeemInvite, handleAuthMe, handleAuthMode } from "./routes/auth";
import { handleBootstrap } from "./routes/bootstrap";
import { handleResetUser } from "./routes/reset-user";
import { handleCreateInvite, handleDeleteInvite, handleListInvites } from "./routes/invites";
import { handleAuditList } from "./routes/audit";
import { err } from "./lib/errors";
import { readJsonBoundedResult } from "./lib/body";
import { MAX_BODY_BYTES, readIntEnv } from "./lib/config";

export { DeviceGateway, AuthGuard, AuthorityGuard };

/** HttpOnly session cookie carrying the dashboard's admin session. */
const SESSION_COOKIE = "dakflare_admin";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export interface Env {
  DEVICE: DurableObjectNamespace<DeviceGateway>;
  /**
   * One globally named AuthGuard object owns the failed-auth windows. Optional
   * so an older deployment without the binding still type-checks and runs; the
   * limiter then falls back to its isolate counters (see lib/auth-limits.ts).
   */
  AUTH_GUARD?: DurableObjectNamespace<AuthGuard>;
  /**
   * One globally named object owning the authority-grant expiry timers. Optional
   * for the same reason as AUTH_GUARD: D1 refuses an expired grant with or
   * without it, so a deployment that has not provisioned it loses the expiry
   * audit row and nothing else.
   */
  AUTHORITY_GUARD?: DurableObjectNamespace<AuthorityGuard>;
  DB: D1Database;
  /** Load-bearing: lib/fcm.ts caches the FCM HTTP v1 bearer token here. */
  KV: KVNamespace;
  /**
   * Admin bearer token. Comes from `.dev.vars` locally or `wrangler secret put`
   * remotely; it is deliberately NOT in `[vars]`. When unset, `withAdmin` fails
   * closed with 401 (see the comment there).
   */
  ADMIN_TOKEN?: string;
  /** FCM HTTP v1 service-account JSON. Absent is a normal local-dev state. */
  FCM_SERVICE_ACCOUNT_JSON?: string;
  /**
   * `legacy` (the default) keeps ADMIN_TOKEN; `new` moves them to
   * `requireRole()` with ADMIN_TOKEN demoted to the CLI path. Read per request
   * from `env`, so flipping it is a `[vars]` change plus a deploy.
   */
  /** Public origin of this Worker, e.g. https://…workers.dev. Used for rpId/cookies. */
  AUTH_BASE_URL?: string;
  /** Comma-separated extra origins allowed by Better Auth's CSRF check. */
  AUTH_TRUSTED_ORIGINS?: string;
  /** WebAuthn rpId. Defaults to AUTH_BASE_URL's hostname, then the pinned workers.dev value. */
  AUTH_RP_ID?: string;
  /** 32-byte base64. Signs sessions and encrypts TOTP secrets. Absent disables /api/auth. */
  BETTER_AUTH_SECRET?: string;
  /**
   * The pepper ring, `v2:<b64-32>,v1:<b64-32>` (AUTH_PLAN §2, §8). A Worker
   * Encrypted Secret, never `[vars]`. First entry signs new hashes, all verify.
   * Missing or malformed => password routes answer 503 naming the secret.
   */
  AUTH_PEPPER?: string;
  /**
   * Which side runs the password KDF: `off` (default), `client-derived` (free
   * tier) or `server-kdf` (paid). Read per request; see lib/config.ts.
   */
  AUTH_PASSWORD_MODE?: string;
  /**
   * Resend API key for magic-link delivery. A Worker secret, never `[vars]`.
   * Absent => the factor is advertised as unavailable (`magic_link:false`) and
   * the no-op sender logs `[mail] mail disabled`; requests still answer 202.
   */
  RESEND_API_KEY?: string;
  /** Redirectable Resend API base (default https://api.resend.com), for a local capture. */
  RESEND_BASE_URL?: string;
  /** From address for magic links. Defaults to Resend's sandbox sender. */
  MAGIC_LINK_FROM?: string;
  /** Magic-link lifetime in seconds. Default 900; clamped in lib/config.ts. */
  MAGIC_LINK_TTL_SECONDS?: string;
  /** Redirectable so the harness can point FCM at a local stub. */
  FCM_BASE_URL: string;
  GOOGLE_TOKEN_URL: string;
  /** Optional timing overrides, clamped in lib/config.ts. */
  /**
   * How long a device may hold a command before another transport may claim it.
   * Default 60000. Do not shorten this to the ack timeout: a send that outlasts
   * its lease is re-claimed and delivered twice.
   */
  LEASE_MS?: string;
  /** How long before an unacked socket is closed. Default 8000. */
  ACK_TIMEOUT_MS?: string;
  OFFLINE_ALERT_MS?: string;
  STALE_SOCKET_MS?: string;
  NONCE_WINDOW_MS?: string;
  /** Retention window in days for message bodies (D1 and DO). Default 90. */
  MESSAGE_RETENTION_DAYS?: string;
  /**
   * Where `/source` redirects. AGPL-3.0 §13 requires a network deployment to offer its
   * source to the people using it; this makes the offer a configuration value rather
   * than a hardcoded URL that goes stale on a fork.
   */
  SOURCE_URL?: string;
  /**
   * Rate Limiting bindings. Optional so a deployment without them still type
   * checks and runs; each call site guards on presence.
   */
  PAIR_LIMITER?: RateLimit;
  ADMIN_LIMITER?: RateLimit;
  DEVICE_LIMITER?: RateLimit;
  /**
   * Separate binding for the shared pairing key. It must be a distinct limiter,
   * not the same one keyed differently: sharing `PAIR_LIMITER` let one client
   * drain the global budget and deny pairing to every other device.
   */
  PAIR_GLOBAL_LIMITER?: RateLimit;
  /**
   * Per-IP counter for FAILED device authentication only. Never incremented on
   * success, so a busy legitimate device is unaffected. Skipped when the request
   * carries no `CF-Connecting-IP` (local dev, conformance suite).
   */
  AUTH_FAIL_LIMITER?: RateLimit;
  /** Per-device daily inbound row budget, read by the DO's `write_budget` table. */
  INCOMING_ROWS_PER_DAY?: string;
  /**
   * Optional out-of-band delivery for operator alerts. When set, the DO POSTs the
   * alert JSON to it, best-effort: a webhook outage must never fail the alarm.
   */
  ALERT_WEBHOOK_URL?: string;
}

type DeviceHandler = (
  req: Request,
  env: Env,
  deviceId: string,
  body: string
) => Promise<Response>;

/**
 * Admin authentication — brief #20.
 *
 * The token is compared in constant time: both sides are hashed to SHA-256 first
 * (which fixes the length, so no length leak) and the digests are compared with a
 * single accumulating XOR loop rather than `===`, which short-circuits on the
 * first differing byte.
 *
 * Fail closed: if `ADMIN_TOKEN` is unset, every admin route answers 401. In local
 * dev without a non-dev token that means `wrangler dev` alone is not enough —
 * create `worker/.dev.vars` (see `.dev.vars.example`) or set the token with
 * `wrangler secret put ADMIN_TOKEN`.
 *
 * Note: §8 defines the code set for the DEVICE protocol only, so an admin auth
 * failure uses its own body and keeps `err()` strictly within §8.
 */
async function withAdmin(
  req: Request,
  env: Env,
  handler: () => Promise<Response>
): Promise<Response> {
  const expected = env.ADMIN_TOKEN;
  if (!expected) return unauthorized();

  const authHeader = req.headers.get("Authorization");
  if (authHeader !== null) {
    // Bearer path — unchanged. A caller that sends `Authorization` gets no
    // fallback to the cookie, so a bad bearer header still fails.
    const providedDigest = await sha256(authHeader);
    const expectedDigest = await sha256(`Bearer ${expected}`);
    if (!timingSafeEqual(providedDigest, expectedDigest)) return unauthorized();
  } else {
    // Session-cookie path.
    //
    // CSRF guard: require a custom header. A cross-origin `fetch` cannot set
    // `X-Admin-Session` without a CORS preflight, and this Worker allows no
    // cross-origin CORS, so the preflight fails and the real request never
    // leaves the browser. `SameSite=Strict` independently keeps the cookie off
    // cross-site requests, so both layers would have to fail for a forged
    // request to authenticate.
    if (req.headers.get("X-Admin-Session") !== "1") return unauthorized();
    const exp = await verifySession(expected, readCookie(req, SESSION_COOKIE));
    if (exp === null) return unauthorized();
  }

  // Rate-limit only AFTER the token is verified. Keying the limiter by token
  // material before verification lets an attacker send random `Authorization`
  // headers and mint a fresh rate-limit key per request — a complete bypass.
  if (env.ADMIN_LIMITER) {
    const { success } = await env.ADMIN_LIMITER.limit({ key: "admin" });
    if (!success) return err("rate_limited", 429);
  }

  return handler();
}

/**
 * Admin gate. Three credentials:
 *
 *   a Better Auth session with role owner/admin, for a person;
 *   ADMIN_TOKEN with `X-Dakflare-Client: cli`, for a machine (AUTH_PLAN §8);
 *   a `dkf_agt_` agent token, for an autonomous agent (v6.1 P0).
 *
 * The agent path is a THIRD credential type rather than a role, and it is
 * narrower than either of the other two in two ways that matter:
 *
 *   - It reaches a route only if `SCOPE_FOR_ACTION` names a scope for that
 *     action. A route that is absent from that table is invisible to agents,
 *     which is the safe default for a route added later.
 *   - `revoke` and `auth reset` are not in `TOKEN_SCOPES` at all, so no token can
 *     hold them and no grant can add them. The refusal is structural, not a
 *     policy someone can edit in the wrong direction.
 *
 * What it does NOT decide here is the grant. `send` needs a target-shaped,
 * time-boxed grant that this layer cannot see, so the route enforces that itself
 * (`lib/agent-send.ts`). This gate answers "may you ask", not "may you do".
 *
 * Every admin route resolves an actor here so the audited ones can log who acted
 * without re-reading the credential anywhere else.
 */
async function withAdminAccess(
  req: Request,
  env: Env,
  permission: Permission,
  action: string,
  handler: (actor: AdminActor) => Promise<Response>
): Promise<Response> {
  const bearer = readBearer(req);
  if (looksLikeAgentToken(bearer)) {
    return withAgentAccess(req, env, bearer as string, action, handler);
  }
  if (req.headers.get("X-Dakflare-Client") === "cli") {
    return withAdmin(req, env, () => handler(machineActor()));
  }
  const guard = await requireRole(req, env, permission, { action });
  if (!guard.ok) return guard.response;
  return handler(actorFromUser(guard.user));
}

/** The `Bearer …` value, or `null`. Header names are case-insensitive. */
function readBearer(req: Request): string | null {
  const header = req.headers.get("Authorization");
  if (header === null) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match === null ? null : match[1];
}

/**
 * The agent credential path.
 *
 * Rate limiting is keyed on the TOKEN ID, not a constant: two agents have two
 * budgets, and one runaway token cannot deny the other. It runs after the token
 * verifies, for the same reason the admin limiter does — keying on unverified
 * material lets an attacker mint a fresh key per guess.
 */
async function withAgentAccess(
  req: Request,
  env: Env,
  raw: string,
  action: string,
  handler: (actor: AdminActor) => Promise<Response>
): Promise<Response> {
  const token = await resolveAgentToken(env, raw);
  if (token === null) return unauthorized();

  const scope = scopeForAction(action);
  if (scope === null) {
    return Response.json(
      {
        error: "forbidden",
        message: `an agent token cannot ${action}`,
      },
      { status: 403 }
    );
  }
  if (!token.scopes.includes(scope)) {
    return Response.json(
      {
        error: "forbidden",
        message: `this agent token lacks the ${scope} scope needed to ${action}`,
        scope,
      },
      { status: 403 }
    );
  }

  if (env.ADMIN_LIMITER) {
    const { success } = await env.ADMIN_LIMITER.limit({ key: `agent:${token.id}` });
    if (!success) return err("rate_limited", 429);
  }

  await recordTokenUse(env, token.id);

  return handler({
    userId: null,
    label: `agent:${token.name}`,
    role: "agent",
    canGrantOwner: false,
    agentTokenId: token.id,
    agentDeviceId: token.device_id,
  });
}

/**
 * `withAdminToken` — the bootstrap path: Bearer ADMIN_TOKEN only, never a
 * session cookie, because it has to work before any user exists (AUTH_PLAN §4).
 */
async function withAdminToken(
  req: Request,
  env: Env,
  handler: () => Promise<Response>
): Promise<Response> {
  const expected = env.ADMIN_TOKEN;
  if (!expected) return unauthorized();

  const authHeader = req.headers.get("Authorization");
  if (authHeader === null) return unauthorized();

  const providedDigest = await sha256(authHeader);
  const expectedDigest = await sha256(`Bearer ${expected}`);
  if (!timingSafeEqual(providedDigest, expectedDigest)) return unauthorized();

  if (env.ADMIN_LIMITER) {
    const { success } = await env.ADMIN_LIMITER.limit({ key: "admin" });
    if (!success) return err("rate_limited", 429);
  }
  return handler();
}

function machineActor(): AdminActor {
  return { userId: null, label: "admin-token", role: "machine", canGrantOwner: true };
}

function actorFromUser(user: AuthUser): AdminActor {
  return {
    userId: user.id,
    label: user.email,
    role: user.role,
    canGrantOwner: user.role === "owner",
  };
}

/**
 * Advance `devices.last_seen` after an authenticated device request, and clear
 * an archive if the device came back.
 *
 * §11.12: this is authenticated contact, not pairing time. It is deliberately
 * fire-and-forget (`ctx.waitUntil`) and conditional on being at least 60 s stale,
 * so it never delays a response and cannot turn a D1 hiccup into a device failure.
 * Every failure mode is swallowed; a stale liveness value is worse than a failed
 * request only if the request itself fails.
 *
 * The archive clear rides along in the same batch. "A phone that comes back is
 * not archived": the operator archived it because it was gone, and the first
 * authenticated request proves it is not. It is a separate statement because the
 * 60 s staleness guard would otherwise hide the transition on a device archived
 * moments after its last contact. Audited as `device.unarchived` with
 * `automatic: true`, so it is distinguishable from the admin endpoint.
 */
function recordDeviceContact(ctx: ExecutionContext, env: Env, deviceId: string): void {
  ctx.waitUntil(
    (async () => {
      try {
        const now = Date.now();
        const [unarchived] = await env.DB.batch([
          env.DB.prepare(
            `UPDATE devices SET archived_at = NULL WHERE device_id = ? AND archived_at IS NOT NULL`
          ).bind(deviceId),
          env.DB.prepare(
            `UPDATE devices SET last_seen = ? WHERE device_id = ? AND last_seen < ?`
          ).bind(now, deviceId, now - 60_000),
          // The device answering is the condition clearing. Resolving here rather
          // than in the alert task means it happens on the first contact, not at
          // the next scheduled check — and a resolved alert frees the unique
          // index slot so a later outage raises a new one.
          env.DB.prepare(
            `UPDATE alerts SET resolved_at = ?
              WHERE device_id = ? AND kind = 'device_offline' AND resolved_at IS NULL`
          ).bind(now, deviceId),
        ]);

        if (Number(unarchived.meta?.changes ?? 0) > 0) {
          await writeAudit(env, {
            action: "device.unarchived",
            actor: { userId: null, label: "device" },
            subject: deviceId,
            detail: { automatic: true },
          });
        }
      } catch {
        // Presence is diagnostic. Never surface it. A failed unarchive retries on
        // the next authenticated request.
      }
    })()
  );
}

/** `withDevice` — §3.2 runs entirely inside `verifyDeviceSignature`. */
async function withDevice(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  handler: DeviceHandler
): Promise<Response> {
  const result = await verifyDeviceSignature(req, env);
  if (!result.ok) {
    // Count FAILURES only, and only where the edge tells us who is calling. A
    // pre-auth counter keyed on an attacker-chosen header value would be a bypass;
    // `CF-Connecting-IP` is set by Cloudflare and cannot be spoofed from outside.
    // No header means local dev / the conformance suite, where limiting would be
    // pure noise, so the whole check is skipped.
    if (env.AUTH_FAIL_LIMITER) {
      const ip = req.headers.get("CF-Connecting-IP");
      if (ip !== null && ip !== "") {
        const { success } = await env.AUTH_FAIL_LIMITER.limit({ key: `authfail:${ip}` });
        if (!success) return err("rate_limited", 429);
      }
    }
    return result.response;
  }

  // Per-device throttle, applied after the signature proves which device it is.
  // A compromised device must not be able to flood the batch endpoints, each of
  // which costs Durable Object requests plus D1 rows.
  if (env.DEVICE_LIMITER) {
    const { success } = await env.DEVICE_LIMITER.limit({ key: `device:${result.deviceId}` });
    if (!success) return err("rate_limited", 429);
  }

  // Authenticated contact, after every gate that could reject the request.
  recordDeviceContact(ctx, env, result.deviceId);

  return handler(req, env, result.deviceId, result.body);
}

export default {
  /**
   * Retention cron (hardening S6). Terminal D1 rows are pruned in bounded
   * batches so one large delete cannot hit a D1 duration limit and roll back.
   * The device keeps the authoritative copy, so this only bounds the operator's
   * copy — which is also the copy that holds SMS bodies and phone numbers.
   */
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    ctx.waitUntil(runRetention(env));
  },

  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;
    const method = req.method.toUpperCase();

    /* ---- public bootstrapping ----------------------------------------- */
    // AGPL-3.0 §13 source offer. Public by design: it must be reachable by anyone the
    // deployment serves, including someone who has never paired a device.
    if (method === "GET" && pathname === "/source") {
      return env.SOURCE_URL
        ? Response.redirect(env.SOURCE_URL, 302)
        : Response.json({ error: "not_found" }, { status: 404 });
    }

    if (method === "POST" && pathname === "/v1/device/pair") {
      return handleDevicePair(req, env);
    }

    /* ---- Better Auth: /api/auth/* ------------------------------------- */
    // Delegated whole: passkey registration/sign-in, TOTP. Better Auth owns the
    // routes, cookies and error envelopes under this prefix.
    if (pathname === "/api/auth" || pathname.startsWith("/api/auth/")) {
      return handleAuthRequest(req, env);
    }

    // Our account-creation policy (AUTH_PLAN §4). Not under /api/auth: these are
    // ours, not the library's.
    if (method === "POST" && pathname === "/v1/auth/redeem") {
      return handleRedeemInvite(req, env);
    }
    if (method === "GET" && pathname === "/v1/auth/me") {
      return handleAuthMe(req, env);
    }
    // Pre-auth configuration probe. Deliberately before any session check: the
    // login page must be able to choose a factor before it has one.
    if (method === "GET" && pathname === "/v1/auth/mode") {
      return handleAuthMode(req, env);
    }

    // Magic-link factor (AUTH_PLAN §1, factor 2). The request route answers the
    // same 202 for known, unknown and malformed addresses; the consume route is
    // the only thing that spends a token.
    if (method === "POST" && pathname === "/v1/auth/magic-link") {
      return handleMagicLinkRequest(req, env, ctx);
    }
    if (method === "POST" && pathname === "/v1/auth/magic-link/consume") {
      return handleMagicLinkConsume(req, env);
    }

    // Password factor (AUTH_PLAN §2). These are ours, not Better Auth's:
    // `/api/auth/sign-in/email` stays disabled so AUTH_PASSWORD_MODE cannot be
    // bypassed by a library route that always runs the KDF on the Worker.
    if (method === "POST" && pathname === "/v1/auth/salt") {
      return handlePasswordSalt(req, env);
    }
    if (method === "POST" && pathname === "/v1/auth/sign-in/password") {
      return handlePasswordSignIn(req, env);
    }
    if (method === "POST" && pathname === "/v1/auth/password") {
      return handlePasswordSet(req, env);
    }
    if (method === "DELETE" && pathname === "/v1/auth/password") {
      return handlePasswordRemove(req, env);
    }

    // TOTP management that does not need the account password. The plugin's own
    // enable/disable/generate-backup-codes endpoints are password-gated once a
    // credential row exists (see `auth/totp-routes.ts`); these do the same work
    // behind a passkey re-assertion or a current code.
    if (method === "GET" && pathname === "/v1/auth/totp") {
      return handleTotpStatus(req, env);
    }
    if (method === "POST" && pathname === "/v1/auth/totp/enable") {
      return handleTotpEnable(req, env);
    }
    if (method === "POST" && pathname === "/v1/auth/totp/disable") {
      return handleTotpDisable(req, env);
    }
    if (method === "POST" && pathname === "/v1/auth/totp/regenerate") {
      return handleTotpRegenerate(req, env);
    }

    /* ---- admin -------------------------------------------------------- */
    // First owner, for `dakflare init`. ADMIN_TOKEN only and never a cookie.
    if (method === "POST" && pathname === "/v1/admin/bootstrap") {
      return withAdminToken(req, env, () => handleBootstrap(req, env));
    }
    if (method === "POST" && pathname === "/v1/admin/auth/reset-user") {
      return withAdminToken(req, env, () => handleResetUser(req, env));
    }

    // Pepper rotation is ADMIN_TOKEN only: it changes how every password row is
    // sealed, so a human session is not enough (AUTH_PLAN §8 demotes the token to
    // exactly this kind of machine operation).
    if (method === "POST" && pathname === "/v1/admin/auth/rotate-pepper") {
      return withAdminToken(req, env, () => handleRotatePepper(req, env));
    }

    if (method === "POST" && pathname === "/v1/admin/invites") {
      return withAdminAccess(req, env, "write", "create invites", (actor) =>
        handleCreateInvite(req, env, actor)
      );
    }
    if (method === "GET" && pathname === "/v1/admin/invites") {
      return withAdminAccess(req, env, "read", "list invites", (_actor) =>
        handleListInvites(env)
      );
    }
    const inviteDeleteMatch = pathname.match(/^\/v1\/admin\/invites\/([^/]+)$/);
    if (method === "DELETE" && inviteDeleteMatch) {
      return withAdminAccess(req, env, "write", "revoke invites", (actor) =>
        handleDeleteInvite(env, decodeURIComponent(inviteDeleteMatch[1]), actor)
      );
    }
    if (method === "GET" && pathname === "/v1/admin/audit") {
      // A read: a member may see who did what, including their own actions.
      return withAdminAccess(req, env, "read", "read the audit log", (_actor) =>
        handleAuditList(env, url)
      );
    }

    /* ---- agent control plane (v6.1 P0) --------------------------------- */
    // Human-only by construction: none of these actions appear in
    // SCOPE_FOR_ACTION, so an agent token is refused before the handler runs. A
    // credential that can mint credentials, approve its own requests or read the
    // grant table is a credential that can escalate itself.
    if (method === "POST" && pathname === "/v1/admin/agent-tokens") {
      return withAdminAccess(req, env, "write", "mint agent tokens", (actor) =>
        handleAgentTokenMint(req, env, actor)
      );
    }
    if (method === "GET" && pathname === "/v1/admin/agent-tokens") {
      return withAdminAccess(req, env, "read", "list agent tokens", (_actor) =>
        handleAgentTokenList(env, url)
      );
    }
    const agentTokenMatch = pathname.match(/^\/v1\/admin\/agent-tokens\/([^/]+)$/);
    if (method === "DELETE" && agentTokenMatch) {
      return withAdminAccess(req, env, "write", "revoke agent tokens", (actor) =>
        handleAgentTokenRevoke(req, env, decodeURIComponent(agentTokenMatch[1]), actor)
      );
    }

    if (method === "GET" && pathname === "/v1/admin/approvals") {
      return withAdminAccess(req, env, "read", "read approvals", (_actor) =>
        handleApprovalsList(env, url)
      );
    }
    const approvalDecisionMatch = pathname.match(
      /^\/v1\/admin\/approvals\/([^/]+)\/(approve|reject)$/
    );
    if (method === "POST" && approvalDecisionMatch) {
      const approvalId = decodeURIComponent(approvalDecisionMatch[1]);
      const decision = approvalDecisionMatch[2];
      const action = decision === "approve" ? "approve authority" : "reject authority";
      return withAdminAccess(req, env, "write", action, (actor) =>
        decision === "approve"
          ? handleApprovalApprove(req, env, approvalId, actor)
          : handleApprovalReject(req, env, approvalId, actor)
      );
    }

    if (method === "GET" && pathname === "/v1/admin/grants") {
      return withAdminAccess(req, env, "read", "read grants", (_actor) =>
        handleGrantsList(env, url)
      );
    }
    const grantMatch = pathname.match(/^\/v1\/admin\/grants\/([^/]+)$/);
    if (method === "DELETE" && grantMatch) {
      return withAdminAccess(req, env, "write", "revoke grants", (actor) =>
        handleGrantRevoke(req, env, decodeURIComponent(grantMatch[1]), actor)
      );
    }
    if (method === "POST" && pathname === "/v1/admin/pairing-code") {
      return withAdminAccess(req, env, "write", "pair devices", (_actor) =>
        handleAdminPairingCode(req, env)
      );
    }

    if (method === "GET" && pathname === "/v1/admin/health") {
      return withAdminAccess(req, env, "read", "read health", (_actor) => handleHealth(env));
    }

    // S10: revocation must reach the Durable Object, not just D1.
    const revokeMatch = pathname.match(/^\/v1\/admin\/devices\/([^/]+)$/);
    if (method === "DELETE" && revokeMatch) {
      const target = decodeURIComponent(revokeMatch[1]);
      return withAdminAccess(req, env, "write", "revoke devices", (actor) =>
        handleDeviceRevoke(env, target, actor)
      );
    }

    // Archive is the non-destructive alternative to revoke: the row, its key and
    // its messages stay, and only the fleet view hides it.
    const deviceArchiveMatch = pathname.match(/^\/v1\/admin\/devices\/([^/]+)\/archive$/);
    if (method === "POST" && deviceArchiveMatch) {
      const target = decodeURIComponent(deviceArchiveMatch[1]);
      return withAdminAccess(req, env, "write", "archive devices", (actor) =>
        handleDeviceArchive(env, target, actor)
      );
    }
    const deviceUnarchiveMatch = pathname.match(/^\/v1\/admin\/devices\/([^/]+)\/unarchive$/);
    if (method === "POST" && deviceUnarchiveMatch) {
      const target = decodeURIComponent(deviceUnarchiveMatch[1]);
      return withAdminAccess(req, env, "write", "unarchive devices", (actor) =>
        handleDeviceUnarchive(env, target, actor)
      );
    }

    const deviceCommandsMatch = pathname.match(/^\/v1\/admin\/devices\/([^/]+)\/commands$/);
    if (method === "GET" && deviceCommandsMatch) {
      // Decoding happens INSIDE `withAdmin`, so a malformed escape is an
      // authenticated caller's error, not an unauthenticated throw.
      return withAdminAccess(req, env, "read", "read device commands", (_actor) =>
        handleDeviceCommands(env, decodeURIComponent(deviceCommandsMatch[1]), url)
      );
    }

    if (method === "GET" && pathname === "/v1/admin/alerts") {
      return withAdminAccess(req, env, "read", "read alerts", (_actor) =>
        handleAlertsList(env, url)
      );
    }
    const alertAckMatch = pathname.match(/^\/v1\/admin\/alerts\/([^/]+)\/ack$/);
    if (method === "POST" && alertAckMatch) {
      return withAdminAccess(req, env, "write", "acknowledge alerts", (_actor) =>
        handleAlertAck(env, decodeURIComponent(alertAckMatch[1]))
      );
    }

    if (method === "GET" && pathname === "/v1/admin/rules") {
      return withAdminAccess(req, env, "read", "read rules", (_actor) =>
        handleRulesListAdmin(env)
      );
    }
    if (method === "POST" && pathname === "/v1/admin/rules/test") {
      // Ambiguous: evaluating a rule against a sample has no side effects, but
      // it is a POST that can run arbitrary stored regexes, so it stays a write.
      return withAdminAccess(req, env, "write", "test rules", (_actor) =>
        handleRulesTest(req, env)
      );
    }
    const ruleDeleteMatch = pathname.match(/^\/v1\/admin\/rules\/([^/]+)$/);
    if (method === "DELETE" && ruleDeleteMatch) {
      const ruleId = decodeURIComponent(ruleDeleteMatch[1]);
      return withAdminAccess(req, env, "write", "delete rules", (_actor) =>
        handleRuleDelete(env, ruleId)
      );
    }

    // Workflow graphs. The id segment is passed to the handler RAW and decoded
    // there, after `withAdmin`, so a malformed escape cannot throw on an
    // unauthenticated path. The list route has no segment and is matched first.
    if (method === "GET" && pathname === "/v1/admin/workflows") {
      return withAdminAccess(req, env, "read", "read workflows", (_actor) =>
        handleWorkflowsList(env)
      );
    }
    const workflowMatch = pathname.match(/^\/v1\/admin\/workflows\/([^/]+)$/);
    if (method === "GET" && workflowMatch) {
      return withAdminAccess(req, env, "read", "read workflows", (_actor) =>
        handleWorkflowGet(env, workflowMatch[1])
      );
    }
    if (method === "PUT" && workflowMatch) {
      return withAdminAccess(req, env, "write", "save workflows", (_actor) =>
        handleWorkflowPut(req, env, workflowMatch[1])
      );
    }
    if (method === "DELETE" && workflowMatch) {
      return withAdminAccess(req, env, "write", "delete workflows", (_actor) =>
        handleWorkflowDelete(env, workflowMatch[1])
      );
    }
    if (method === "GET" && pathname === "/v1/devices") {
      return withAdminAccess(req, env, "read", "list devices", (_actor) =>
        handleDevicesList(env, url)
      );
    }
    if (method === "GET" && pathname === "/v1/messages") {
      return withAdminAccess(req, env, "read", "read messages", (_actor) =>
        handleMessagesList(env, url)
      );
    }
    if (method === "DELETE" && pathname === "/v1/messages") {
      return withAdminAccess(req, env, "write", "purge messages", (_actor) =>
        handleMessagesPurge(env, url)
      );
    }
    if (method === "POST" && pathname === "/v1/rules") {
      return withAdminAccess(req, env, "write", "save rules", (actor) =>
        handleRulesPost(req, env, actor)
      );
    }
    if (method === "POST" && pathname === "/v1/sms/send") {
      return withAdminAccess(req, env, "write", "send SMS", (actor) =>
        handleSend(req, env, actor)
      );
    }
    if (method === "POST" && pathname === "/v1/sms/send/batch") {
      return withAdminAccess(req, env, "write", "send SMS", (actor) =>
        handleSendBatch(req, env, actor)
      );
    }

    const commandMatch = pathname.match(/^\/v1\/sms\/commands\/([^/]+)$/);
    if (method === "GET" && commandMatch) {
      const commandId = decodeURIComponent(commandMatch[1]);
      return withAdminAccess(req, env, "read", "read command status", (_actor) =>
        handleCommandStatus(env, url.searchParams.get("device_id") ?? "", commandId)
      );
    }

    const deviceStatusMatch = pathname.match(/^\/v1\/device\/([^/]+)\/status$/);
    if (method === "GET" && deviceStatusMatch) {
      const target = deviceStatusMatch[1];
      return withAdminAccess(req, env, "read", "read device status", async (_actor) => {
        const stub = env.DEVICE.get(env.DEVICE.idFromName(target));
        return stub.fetch("https://do/__device_status", { method: "GET" });
      });
    }

    /* ---- ECDSA-authenticated device routes ----------------------------- */
    if (method === "GET" && pathname === "/v1/device/ws") {
      return withDevice(req, env, ctx, (r, e, deviceId) => handleWs(r, e, deviceId));
    }
    if (method === "POST" && pathname === "/v1/sms/incoming/batch") {
      return withDevice(req, env, ctx, (r, e, deviceId, body) =>
        handleIncomingBatch(r, e, deviceId, body)
      );
    }
    if (method === "POST" && pathname === "/v1/sms/outgoing/poll") {
      return withDevice(req, env, ctx, (r, e, deviceId, body) => handlePoll(r, e, deviceId, body));
    }
    if (method === "POST" && pathname === "/v1/sms/status/batch") {
      return withDevice(req, env, ctx, (r, e, deviceId, body) => handleStatusBatch(r, e, deviceId, body));
    }
    if (method === "GET" && pathname === "/v1/rules") {
      return withDevice(req, env, ctx, (r, e, deviceId) => handleRulesGet(r, e, deviceId));
    }
    if (method === "GET" && pathname === "/v1/flows") {
      return withDevice(req, env, ctx, (_r, e, deviceId) => handleDeviceFlows(e, deviceId));
    }

    /* ---- admin session (cookie) ---------------------------------------- */
    // Not wrapped in `withAdmin`: these are the endpoints that establish and
    // inspect the session in the first place.
    if (method === "POST" && pathname === "/admin/session") {
      return handleSessionCreate(req, env);
    }
    if (method === "GET" && pathname === "/admin/session") {
      return handleSessionGet(req, env);
    }
    if (method === "DELETE" && pathname === "/admin/session") {
      return handleSessionDelete(req);
    }

    // Every real console route is a PRERENDERED file (`/admin/devices.html`),
    // so the assets layer serves it before this Worker runs — which is why
    // there is no `ASSETS` binding: `cf` deploys assets but exposes none to the
    // Worker. Only an unknown path under `/admin` reaches here; send the
    // operator to the console root instead of answering with the JSON 404.
    if (pathname === "/admin" || pathname.startsWith("/admin/")) {
      return Response.redirect(new URL("/admin/", req.url).toString(), 302);
    }

    return Response.json({ error: "not_found" }, { status: 404 });
  },
} satisfies ExportedHandler<Env>;

async function runRetention(env: Env): Promise<void> {
  const days = readIntEnv(env.MESSAGE_RETENTION_DAYS, 90, 7, 3_650);
  const cutoff = Date.now() - days * 86_400_000;
  let deleted = 0;

  // Bounded batches with a hard iteration cap.
  //
  // The cap matters on Workers Free: D1 rows WRITTEN is 100,000/day, and each
  // deleted row counts. 10 batches x 1,000 is 10% of that budget per day, so a
  // first-run catch-up on a large backlog can never consume the whole day and
  // starve the live writes. A runaway loop would be worse than a slow prune; the
  // next run continues where this one stopped.
  for (let i = 0; i < 10; i++) {
    const result = await env.DB.prepare(
      `DELETE FROM messages WHERE id IN (
         SELECT id FROM messages WHERE received_at < ? LIMIT 1000
       )`
    )
      .bind(cutoff)
      .run();
    const changes = Number(result.meta?.changes ?? 0);
    deleted += changes;
    if (changes === 0) break;
  }

  const codes = await env.DB.prepare(`DELETE FROM pairing_codes WHERE expires_at <= ?`)
    .bind(Date.now())
    .run();

  // Magic-link rows are single use and short lived. Removing them at expiry
  // keeps an attacker who knows a valid address from growing the table (the
  // request route is rate-limited, but the rows would otherwise never go away).
  const magicLinks = await env.DB.prepare(`DELETE FROM magic_link WHERE expires_at <= ?`)
    .bind(Date.now())
    .run();

  // `rule_hits` is what enforces each rule's cooldown and hourly cap. It grows one
  // row per automated reply, so it needs the same retention as the log — but the
  // horizon must never be shorter than a cooldown that is still configured, or a
  // prune would silently re-enable a reply the operator asked to suppress.
  const cooldownRow = await env.DB.prepare(
    `SELECT MAX(cooldown_s) AS max_cooldown_s FROM rules`
  ).first<{ max_cooldown_s: number | null }>();
  const maxCooldownS = cooldownRow?.max_cooldown_s;
  const hitCutoff =
    maxCooldownS === null || maxCooldownS === undefined
      ? // No rules configured: keep a day of history so re-creating a rule shortly
        // afterwards still respects the most recent reply.
        Date.now() - 24 * 3_600_000
      : Date.now() - Math.max(3_600_000, Math.max(0, maxCooldownS) * 1_000 + 3_600_000);
  let hitsDeleted = 0;
  for (let i = 0; i < 10; i++) {
    const result = await env.DB.prepare(
      `DELETE FROM rule_hits WHERE rowid IN (
         SELECT rowid FROM rule_hits WHERE replied_at < ? LIMIT 1000
       )`
    )
      .bind(hitCutoff)
      .run();
    const changes = Number(result.meta?.changes ?? 0);
    hitsDeleted += changes;
    if (changes === 0) break;
  }

  // Alerts are operator history, not device state. Acknowledged ones are safe to
  // age out with the message log; an OPEN alert is the current outage signal and
  // is never deleted here.
  const alerts = await env.DB.prepare(
    `DELETE FROM alerts WHERE acknowledged_at IS NOT NULL AND acknowledged_at < ?`
  )
    .bind(cutoff)
    .run();

  console.log(
    `[retention] days=${days} messages=${deleted} pairing_codes=${Number(
      codes.meta?.changes ?? 0
    )} magic_links=${Number(magicLinks.meta?.changes ?? 0)} rule_hits=${hitsDeleted} alerts=${Number(
      alerts.meta?.changes ?? 0
    )}`
  );
}

function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

/* ---- session cookie helpers ------------------------------------------ */

/**
 * Session key derivation.
 *
 * The HMAC key is `SHA-256("dakflare-session-v1\n" + ADMIN_TOKEN)`, so rotating
 * `ADMIN_TOKEN` invalidates every outstanding session without a revocation list.
 * The label keeps the derivation domain-separated from any other use of the token.
 */
async function sessionKey(adminToken: string): Promise<CryptoKey> {
  const digest = await sha256(`dakflare-session-v1\n${adminToken}`);
  return crypto.subtle.importKey("raw", digest, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
}

/**
 * Mint a session cookie value: `v1.<expiry_ms>.<hmac_hex>`, where the HMAC
 * covers exactly `v1.<expiry_ms>`. The expiry is therefore authenticated; a
 * client cannot extend its own session by editing the cookie.
 */
async function mintSession(adminToken: string): Promise<{ value: string; exp: number }> {
  const key = await sessionKey(adminToken);
  const exp = Date.now() + SESSION_TTL_MS;
  const payload = `v1.${exp}`;
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return { value: `${payload}.${toHex(new Uint8Array(signature))}`, exp };
}

/**
 * Verify a session cookie value. Returns the authenticated expiry, or `null` for
 * anything malformed, expired or forged. The MAC comparison is constant time.
 */
async function verifySession(
  adminToken: string,
  cookieValue: string | undefined
): Promise<number | null> {
  if (!cookieValue) return null;

  const parts = cookieValue.split(".");
  if (parts.length !== 3) return null;

  const [version, rawExp, macHex] = parts;
  if (version !== "v1") return null;

  const exp = Number(rawExp);
  if (!Number.isFinite(exp)) return null;
  if (exp <= Date.now()) return null;

  const mac = fromHex(macHex);
  if (mac === null || mac.length !== 32) return null;

  const key = await sessionKey(adminToken);
  const expected = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${version}.${rawExp}`))
  );
  return timingSafeEqual(mac, expected) ? exp : null;
}

/** Read one cookie value from the request's `Cookie` header. */
function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get("Cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** Build the `Set-Cookie` value with the attributes the dashboard expects. */
function sessionCookie(value: string, maxAgeSeconds: number, secure: boolean): string {
  return (
    `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}` +
    (secure ? "; Secure" : "")
  );
}

/**
 * `POST /admin/session` — exchange the admin token for an HttpOnly cookie.
 *
 * The token never persists in the browser: it is read from this one request and
 * the response only carries the signed session. Rate-limited per IP *before*
 * verification, because an unauthenticated login endpoint is exactly where
 * guessing happens (unlike admin routes, a random guess here cannot mint a
 * useful limiter key).
 */
async function handleSessionCreate(req: Request, env: Env): Promise<Response> {
  const ip = req.headers.get("CF-Connecting-IP") ?? "local";
  if (env.ADMIN_LIMITER) {
    const { success } = await env.ADMIN_LIMITER.limit({ key: `login:${ip}` });
    if (!success) return err("rate_limited", 429);
  }

  const expected = env.ADMIN_TOKEN;
  if (!expected) return unauthorized();

  const parsed = await readJsonBoundedResult(req, MAX_BODY_BYTES);
  if (!parsed.ok) return err(parsed.reason, parsed.reason === "payload_too_large" ? 413 : 400);

  const token = parsed.value.token;
  if (typeof token !== "string") return err("bad_request", 400);

  const providedDigest = await sha256(token);
  const expectedDigest = await sha256(expected);
  if (!timingSafeEqual(providedDigest, expectedDigest)) return unauthorized();

  // The only place ADMIN_TOKEN becomes a session. Rotation itself happens via
  // `wrangler secret put` (a Worker cannot set its own secret), so this is the
  // auditable event: the machine credential was used (AUTH_PLAN §5, §8).
  await writeAudit(env, {
    action: "token.used",
    actor: { userId: null, label: "admin-token" },
    detail: { route: "/admin/session" },
    ...requestMeta(req),
  });

  const { value, exp } = await mintSession(expected);
  const secure = new URL(req.url).protocol === "https:";
  return Response.json(
    { ok: true, expires_at: exp },
    { headers: { "Set-Cookie": sessionCookie(value, SESSION_TTL_MS / 1000, secure) } }
  );
}

/** `GET /admin/session` — is this cookie still valid, and until when. */
async function handleSessionGet(req: Request, env: Env): Promise<Response> {
  const exp = env.ADMIN_TOKEN
    ? await verifySession(env.ADMIN_TOKEN, readCookie(req, SESSION_COOKIE))
    : null;
  if (exp === null) return unauthorized();
  return Response.json({ ok: true, expires_at: exp });
}

/** `DELETE /admin/session` — clear the cookie. Clearing needs no authentication. */
function handleSessionDelete(req: Request): Response {
  const secure = new URL(req.url).protocol === "https:";
  return Response.json(
    { ok: true },
    { headers: { "Set-Cookie": sessionCookie("", 0, secure) } }
  );
}

/* ---- byte helpers ----------------------------------------------------- */

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** Decode lowercase/uppercase hex, or `null` on an odd length or non-hex character. */
function fromHex(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function sha256(input: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return new Uint8Array(digest);
}

/** Constant-time equality over two fixed-length digests. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
