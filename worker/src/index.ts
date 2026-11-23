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
import { handleRulePut, handleRulesGet, handleRulesPost, handleRulesTest } from "./routes/rules";
import {
  handleAiModels,

  handleAiSettingsGet,
  handleAiSettingsPut,
  handleAiTest,
  handleAssistantChat,
  handleAssistantProposalAccept,
  handleSystem1Test,
} from "./routes/assistant";
import {
  handleDeviceFlows,
  handleWorkflowDelete,
  handleWorkflowGet,
  handleWorkflowPut,
  handleWorkflowsList,
} from "./routes/workflows";
import { handleHealth } from "./routes/health";
import {
  handleIntegrationHealth,
  handleIntegrationManifest,
  handleMessageStatus,
  handleWebhookDeliveryReplay,
} from "./routes/integration";
import { HEADER_TRACE_ID } from "./lib/integration-envelope";
import {
  handleWebhookCreate,
  handleWebhookSecretRotate,
  handleWebhookDelete,
  handleWebhookDeliveries,
  handleWebhookIngress,
  handleWebhookList,
  handleWebhookTest,
} from "./routes/webhooks";
import {
  handleDeviceArchive,
  handleDeviceCommands,
  handleDeviceRevoke,
  handleDeviceUnarchive,
  handleRuleDelete,
  handleRulesListAdmin,
} from "./routes/admin";
import { handleAlertAck, handleAlertsAckAll, handleAlertsList } from "./routes/alerts";
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
import { handleDlq, handleTrace, handleWsInspect } from "./routes/trace";
import { enqueueOutboundCommand } from "./lib/commands";
import {
  handleDeviceApprovalApprove,
  handleDeviceApprovalReject,
  handleDeviceApprovals,
} from "./routes/device-approvals";
import { handleWellKnown, mcpUnauthorized as mcpChallenge } from "./mcp/oauth";
import type { AssistantAgent } from "./agent/runtime";
import {
  ASSISTANT_BINDING,
  ASSISTANT_OBJECT_NAME,
  assertAssistantRoute,
  checkUpgradeRequest,
  isTrustedOrigin,
  redeemTicket,
  ticketRefusal,
} from "./lib/agent-runtime";
import { machineActorFromRequest, machineClientId } from "./lib/authority";
import {
  d1AttachmentStore,
  purgeExpiredAttachments,
  r2BlobStore,
} from "./agent/attachments";
import {
  handleAgentTicketMint,
  handleAutonomyEnable,
  handleAutonomyRead,
  handleAutonomyRevoke,
  handleAgentAttachmentUpload,
  handleAgentAttachmentList,
  handleAgentAttachmentDelete,
} from "./routes/agent-runtime";
import {
  handleAgentDiagnose,
  handleAgentSynthesize,
  handleAgentTelemetry,
  handleAgentTriage,
} from "./routes/agent";
import { AuthorityGuard } from "./authority-guard";
import { FlowExecutionWorkflow, type FlowWorkflowParams } from "./workflows/flow-execution";
import { getChannelPlugin } from "./channels";
import { dispatchFlows } from "./flow/dispatch";
import { isBlockedWebhookHost } from "./lib/flow-ir";
import { signOutboundRequest } from "./lib/outbound-webhook";
import { recordDeliveryResult } from "./lib/integration-delivery";
export { FlowExecutionWorkflow };
import { looksLikeAgentToken, recordTokenUse, resolveAgentToken } from "./lib/agent-tokens";
import { scopeForAction, tokenCoversScope } from "./lib/agent-scopes";
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
import { handleRedeemInvite, handleAuthMe, handleAuthMode, handleAuthChallenge } from "./routes/auth";
import { handleBootstrap } from "./routes/bootstrap";
import { handleResetUser } from "./routes/reset-user";
import { handleCreateInvite, handleDeleteInvite, handleListInvites } from "./routes/invites";
import { handleAuditList } from "./routes/audit";
import { err } from "./lib/errors";
import { readBodyBounded, readJsonBoundedResult } from "./lib/body";
import {
  auditLockout,
  checkAuthLockout,
  clearAuthFailures,
  clientIp,
  lockoutResponse,
  recordAuthFailure,
} from "./lib/auth-limits";
import { MAX_BODY_BYTES, readIntEnv } from "./lib/config";
import { ChannelConnection } from "./channels/connection-do";
import { Scheduler } from "./scheduler";
import {
  handlePacingList,
  handlePacingUpdate,
  handleScheduledCancel,
  handleScheduledCreate,
  handleScheduledList,
} from "./routes/scheduled";
import { consumeIngestBatch, consumeIngestDeadLetter } from "./channels/ingest";
import { handleEdgeIncomingBatch } from "./routes/edge-incoming";
import {
  handleChannelWebhook,
  handleConnectorCreate,
  handleConnectorDelete,
  handleConnectorList,
  handleConnectorUpdate,
  sendConnectorOutbound,
} from "./routes/channel-connectors";
import {
  handleContactsImport,
  handleContactsList,
  handleTemplateCreate,
  handleTemplateDelete,
  handleTemplateList,
  handleTemplatePreview,
} from "./routes/templates";
import { handleTelegramRegister } from "./routes/telegram-register";
import type { NormalizedChannelEvent } from "./channels/connection-do";

export { DeviceGateway, AuthGuard, AuthorityGuard, Scheduler };

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
   * The fourth Durable Object: one pinned instance (`assistant`) holding the
   * agent runtime. Optional so a deployment whose config predates pass 3 still
   * type-checks; `/agents/*` answers 503 until `AGENT_RUNTIME` is `on`.
   */
  ASSISTANT?: DurableObjectNamespace<AssistantAgent>;
  /** Service binding to the split agent Worker (main Worker only). */
  AGENT_SVC?: Fetcher;
  /** Same-account EdgePay receiver for webhook delivery (isolated deployment). */
  EDGEPAY?: Fetcher;
  /** Service binding to the main Worker (agent Worker only). */
  CORE?: Fetcher;
  /**
   * `on` enables the agent runtime's WebSocket surface; anything else (including
   * absent) makes `/agents/*` answer `503 {error:"agent_runtime_off"}` while the
   * stateless console assistant keeps working. Read per request.
   */
  AGENT_RUNTIME?: string;
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
  /** Cloudflare Workers AI binding for intent classification and text extraction. */
  AI?: Ai;
  /**
   * System One defaults, used ONLY while `ai_settings` has no row. The row's
   * `system1_model` / `system1_base_url` win, and `provider` in that row decides
   * the backend (workers-ai or openai-compatible). This origin must end in the
   * version segment, because the adapter appends `/systemone`.
   */
  TOKENLAB_BASE_URL?: string;
  /** The wire model System One is asked for when the row names none. Default `Clef`. */
  TOKENLAB_SYSTEM1_MODEL?: string;
  /**
   * Canonical provider key for chat, `/models` and System One. A Worker secret,
   * never `[vars]`. `AI_CHAT_API_KEY` and `TOKENLAB_API_KEY` are still read as
   * fallbacks, in that order, so an existing install needs no secret rename.
   */
  AI_PROVIDER_API_KEY?: string;
  /**
   * Console assistant (AI chat) defaults. The provider/model/base URL can also be
   * overridden per deployment in D1 (`ai_settings`); these env values are what a
   * deployment with no row reads. `AI_CHAT_PROVIDER` is one of `workers-ai` |
   * `openai-compatible`.
   */
  AI_CHAT_PROVIDER?: string;
  AI_CHAT_MODEL?: string;
  /** Origin for an OpenAI-compatible provider. Unused by workers-ai. */
  AI_CHAT_BASE_URL?: string;
  /**
   * Legacy provider key name for an OpenAI-compatible provider. A Worker secret,
   * never `[vars]` and never written to D1. Read second in the key chain; the
   * canonical name is `AI_PROVIDER_API_KEY`.
   */
  AI_CHAT_API_KEY?: string;
  /** Legacy Token Lab key. Read third in the key chain; never a `[vars]` value. */
  TOKENLAB_API_KEY?: string;
  /** Daily prompt+completion token ceiling for chat and the connectivity probe. */
  AI_DAILY_TOKEN_BUDGET?: string;
  /** Optional comma-separated origin allowlist for custom AI base URLs. */
  ALLOWED_AI_ORIGINS?: string;
  /** R2 bucket for multi-channel media storage and presigned download links. */
  MEDIA_BUCKET?: R2Bucket;
  /** Cloudflare Queue for reliable asynchronous outbound webhook delivery. */
  WEBHOOK_QUEUE?: Queue;
  /** Cloudflare Workflow for multi-step execution with sleeping, retries and approvals. */
  FLOW_WORKFLOW?: Workflow<FlowWorkflowParams>;
  /**
   * Admin bearer token. Comes from `.dev.vars` locally or `cf workers secrets update`
   * remotely; it is deliberately NOT in `[vars]`. When unset, `withAdmin` fails
   * closed with 401 (see the comment there).
   */
  ADMIN_TOKEN?: string;
  /**
   * Who may call the worker-to-worker interface (`DakFlareApi`). `trusted` (default) treats the
   * service binding as the credential; `agent_token` requires a `dkf_agt_` token per call and
   * therefore enforces that token's scopes and grants. See `src/binding.ts`.
   */
  BINDING_AUTH?: string;
  /** One Durable Object per external channel account, named `${channel}:${account_id}`. */
  CHANNEL_CONN: DurableObjectNamespace<ChannelConnection>;
  /**
   * One globally named object owning scheduled-send pacing (`scheduler`). D1 is
   * the queue; this only holds the clock and the token buckets.
   */
  SCHEDULER: DurableObjectNamespace<Scheduler>;
  /** Inbound channel events, deduped in the DO and coalesced into one D1 batch per delivery. */
  INGEST_QUEUE: Queue<NormalizedChannelEvent>;
  /**
   * Optional dedicated key for sealing a webhook signing secret at rest
   * (routes/webhooks.ts). Absent falls back to ADMIN_TOKEN then
   * BETTER_AUTH_SECRET. Rotating it makes existing hooks unverifiable; they
   * must be recreated, which is the same operation as rotating the hook itself.
   */
  WEBHOOK_SECRET_KEY?: string;
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
  /**
   * "on" only when D1 read replication is enabled for this database. Off means
   * the request path skips `withSession` and its per-request allocations.
   */
  D1_READ_REPLICATION?: string;
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
 * `cf workers secrets update ADMIN_TOKEN --worker dakflare-worker --type secret_text`.
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
 * `POST /v1/mcp` — the MCP endpoint.
 *
 * A static `dkf_agt_` bearer, checked before anything else. This is NOT MCP
 * authorization and the docs say so: MCP authorization, when implemented, is an
 * OAuth 2.1 resource server with RFC 9728 metadata and a `WWW-Authenticate`
 * challenge that points at it. There is no authorization server here to point at,
 * so the challenge is a bare `Bearer` and a conformant OAuth client cannot
 * negotiate this endpoint. It is the same credential the CLI holds, and the
 * `agent_tokens` table is what an OAuth front door would read anyway.
 */
function actorHeaders(req: Request, actor: AdminActor): Headers {
  const headers = new Headers(req.headers);
  headers.delete("x-dakflare-actor");
  headers.delete("x-dakflare-user-id");
  headers.delete("x-dakflare-actor-role");
  headers.delete("x-dakflare-agent-token-id");
  headers.delete("x-dakflare-agent-device-id");
  headers.delete("x-dakflare-agent-scopes");
  headers.delete("x-dakflare-session-id");
  headers.set("x-dakflare-actor", actor.label);
  headers.set("x-dakflare-actor-role", actor.role);
  if (actor.userId !== null) headers.set("x-dakflare-user-id", actor.userId);
  if (actor.agentTokenId !== undefined) headers.set("x-dakflare-agent-token-id", actor.agentTokenId);
  if (actor.agentDeviceId !== undefined && actor.agentDeviceId !== null) {
    headers.set("x-dakflare-agent-device-id", actor.agentDeviceId);
  }
  if (actor.agentScopes !== undefined) headers.set("x-dakflare-agent-scopes", actor.agentScopes.join(","));
  if (actor.sessionId !== undefined) headers.set("x-dakflare-session-id", actor.sessionId);
  headers.set("x-dakflare-public-host", new URL(req.url).host);
  return headers;
}

async function forwardToAgent(
  req: Request,
  env: Env,
  path: string,
  actor: AdminActor
): Promise<Response> {
  if (env.AGENT_SVC === undefined) {
    return Response.json({ error: "agent_runtime_off" }, { status: 503 });
  }
  const method = req.method.toUpperCase();
  const body = method === "GET" || method === "HEAD" ? undefined : req.body;
  return env.AGENT_SVC.fetch(
    new Request(`https://agent${path}`, {
      method: req.method,
      headers: actorHeaders(req, actor),
      body,
    })
  );
}

async function handleMcpRoute(req: Request, env: Env, pathname: string): Promise<Response> {
  const bearer = readBearer(req);
  if (bearer === null) return mcpChallenge(req, "missing bearer token");

  const token = await resolveAgentToken(env, bearer);
  if (token === null) return mcpChallenge(req, "unknown or revoked token");

  if (env.ADMIN_LIMITER) {
    const { success } = await env.ADMIN_LIMITER.limit({ key: `mcp:${token.id}` });
    if (!success) {
      return Response.json(
        { error: "rate_limited", message: "too many MCP requests for this token" },
        { status: 429 }
      );
    }
  }

  await recordTokenUse(env, token.id);

  const actor = {
    userId: null,
    label: `agent:${token.name}`,
    role: "agent" as const,
    canGrantOwner: false,
    agentTokenId: token.id,
    agentDeviceId: token.device_id,
    agentScopes: token.scopes,
  };

  if (env.AGENT_SVC === undefined) {
    return Response.json({ error: "agent_runtime_off" }, { status: 503 });
  }
  const headers = actorHeaders(req, actor);
  headers.set("x-dakflare-mcp-path", pathname);
  const body = req.method.toUpperCase() === "POST" ? req.body : undefined;
  return env.AGENT_SVC.fetch(
    new Request("https://agent/internal/mcp", { method: req.method, headers, body })
  );
}

/**
 * A 401 a client can act on.
 *
 * No `resource_metadata` parameter: there is no protected-resource document to
 * point at, and inventing a URL for one would be worse than the bare challenge.
 */
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
  const client = machineClientId(req);
  if (client !== null) {
    if (client === "cli") {
      return withAdmin(req, env, () => handler(machineActorFromRequest(req)));
    }
    // A named machine client still needs the ADMIN_TOKEN bearer. `withAdmin`
    // also accepts a session cookie, which must not become a machine identity.
    return withAdminToken(req, env, () => handler(machineActorFromRequest(req)));
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
  if (!tokenCoversScope(token.scopes, scope, token.kind)) {
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
    agentScopes: token.scopes,
    agentTokenKind: token.kind,
    agentAllowedDeviceIds: token.allowed_device_ids,
    agentAllowedChannels: token.allowed_channels,
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

function actorFromUser(user: AuthUser): AdminActor {
  return {
    userId: user.id,
    label: user.email,
    role: user.role,
    canGrantOwner: user.role === "owner",
    sessionId: user.sessionId,
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
            `UPDATE devices SET archived_at = NULL WHERE device_id = ? AND archived_at IS NOT NULL AND revoked_at IS NULL`
          ).bind(deviceId),
          env.DB.prepare(
            `UPDATE devices SET last_seen = ? WHERE device_id = ? AND last_seen < ? AND revoked_at IS NULL`
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

interface D1SessionHelper {
  env: Env;
  attachBookmark: (res: Response) => Response;
}

/**
 * Sequential consistency session helper for Cloudflare D1 Read Replication.
 * Tracks bookmarks across requests to prevent read-after-write anomalies across replicas.
 */
function createD1SessionHelper(env: Env, req: Request): D1SessionHelper {
  // `withSession` only buys read-after-write consistency when D1 read
  // replication is enabled. It is therefore ON by default: a deployment that
  // enables replication but forgets this var must not silently lose
  // consistency. Set D1_READ_REPLICATION="off" only when the database's
  // read_replication.mode is disabled; verify:deploy asserts the pair.
  if (env.D1_READ_REPLICATION === "off") {
    return { env, attachBookmark: (res) => res };
  }
  if (typeof env.DB?.withSession !== "function") {
    return {
      env,
      attachBookmark: (res) => res,
    };
  }

  const rawBookmark =
    req.headers.get("x-d1-bookmark") ||
    req.headers.get("x-session-bookmark") ||
    undefined;
  const bookmark = rawBookmark && rawBookmark.trim() !== "" ? rawBookmark.trim() : undefined;

  let session: D1DatabaseSession;
  try {
    session = env.DB.withSession(bookmark);
  } catch {
    return {
      env,
      attachBookmark: (res) => res,
    };
  }

  const sessionDb: D1Database = {
    prepare: (query: string) => session.prepare(query),
    batch: <T = unknown>(statements: D1PreparedStatement[]) => session.batch<T>(statements),
    exec: (query: string) => env.DB.exec(query),
    dump: () => env.DB.dump(),
    withSession: (constraintOrBookmark?: D1SessionBookmark | D1SessionConstraint) =>
      env.DB.withSession(constraintOrBookmark),
  };

  return {
    env: { ...env, DB: sessionDb },
    attachBookmark: (res: Response) => {
      if (!res || res.status === 101) return res;
      try {
        const latestBookmark = session.getBookmark();
        if (latestBookmark && !res.headers.has("x-d1-bookmark")) {
          const headers = new Headers(res.headers);
          headers.set("x-d1-bookmark", latestBookmark);
          return new Response(res.body, {
            status: res.status,
            statusText: res.statusText,
            headers,
          });
        }
      } catch {
        // Fallback
      }
      return res;
    },
  };
}

export default {
  /**
   * Retention cron (hardening S6). Terminal D1 rows are pruned in bounded
   * batches so one large delete cannot hit a D1 duration limit and roll back.
   * The device keeps the authoritative copy, so this only bounds the operator's
   * copy — which is also the copy that holds SMS bodies and phone numbers.
   */
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    // The five-minute tick exists only to wake the Send Scheduler: a row inserted
    // while the object was asleep, or an alarm lost with an eviction, must not
    // wait for the daily retention pass. It runs no retention work.
    if (controller.cron === "*/5 * * * *") {
      ctx.waitUntil(
        env.SCHEDULER.getByName("scheduler")
          .wake()
          .catch((error) => {
            console.error(`[scheduler] cron wake failed: ${String(error)}`);
          })
      );
      return;
    }
    ctx.waitUntil(runRetention(env));
  },

  // The EdgePay isolated deployment uses this queue; see scripts/sync-edgepay-worker.sh.
  async queue(batch: MessageBatch<unknown>, env: Env, _ctx: ExecutionContext): Promise<void> {
    // One consumer, three queues. Inbound channel events are deduped in the DO before they get
    // here, so this half only has to write them atomically and refuse to drop a failed batch.
    // The same code serves more than one deployment. The EdgePay-owned isolated
    // Worker binds `edgepay-dakflare-*` queues; the original deployment binds
    // `dakflare-*`. `MessageBatch.queue` carries the real name, so both are
    // accepted here instead of rejecting the isolated queues as unknown.
    const queueName = batch.queue;
    const isIngestQueue =
      queueName === "dakflare-ingest-queue" ||
      queueName === "edgepay-dakflare-ingest-queue";
    const isIngestDlq =
      queueName === "dakflare-ingest-dlq" ||
      queueName === "edgepay-dakflare-ingest-dlq";
    const isWebhookQueue =
      queueName === "dakflare-webhook-queue" ||
      queueName === "edgepay-dakflare-webhook-queue";

    if (isIngestQueue) {
      const written = await consumeIngestBatch(
        batch as MessageBatch<NormalizedChannelEvent>,
        env,
        _ctx
      );
      if (written > 0) console.log(`[ingest] wrote ${written} rows from ${batch.messages.length} events`);
      return;
    }
    if (isIngestDlq) {
      await consumeIngestDeadLetter(batch, env);
      return;
    }

    if (!isWebhookQueue) {
      // An unknown queue is a misconfiguration, not a message: retrying it forever hides it.
      console.error(`[queue] no consumer for "${queueName}"; acknowledging so it is not retried`);
      batch.ackAll();
      return;
    }

    for (const msg of batch.messages) {
      try {
        const payload = msg.body as {
          url?: string;
          headers?: Record<string, string>;
          body?: unknown;
          deliveryId?: string;
          eventType?: string;
          traceId?: string;
        } | null;
        if (payload?.url) {
          if (isBlockedWebhookHost(payload.url)) {
            if (typeof payload.deliveryId === "string") {
              // Not retryable: the URL is refused, so a retry would be refused too.
              await recordDeliveryResult(env, {
                deliveryId: payload.deliveryId,
                httpStatus: 0,
                ok: false,
                error: "blocked_target_url",
              });
            }
            msg.ack();
            continue;
          }
          const bodyString =
            typeof payload.body === "string" ? payload.body : JSON.stringify(payload.body ?? {});
          // The delivery id is inside the signed string, so it must be the row's
          // id and must not change on a retry. A legacy job without one is still
          // signed, with an id minted here, because an unsigned request is worse.
          const deliveryId =
            typeof payload.deliveryId === "string" && payload.deliveryId !== ""
              ? payload.deliveryId
              : crypto.randomUUID();
          const traceId =
            typeof payload.traceId === "string" && payload.traceId !== ""
              ? payload.traceId
              : crypto.randomUUID();
          // Sign at consumption: a job may have waited, so a timestamp minted at
          // enqueue would be stale. `signOutboundRequest` also drops any signature
          // headers an older producer put on the payload, so one edge signs once.
          const headers = await signOutboundRequest(
            env,
            payload.url,
            { "Content-Type": "application/json", ...(payload.headers ?? {}) },
            bodyString,
            { deliveryId, traceId }
          );
          // Same-account delivery uses the service binding, not a public
          // fetch: two Workers on the same `workers.dev` zone cannot fetch each
          // other (error 1042). The request is unchanged — same method, signed
          // headers and body — so the receiver verifies the v1 envelope as usual.
          const deliveryInit: RequestInit = {
            method: "POST",
            headers,
            body: bodyString,
            redirect: "manual",
            signal: AbortSignal.timeout(10_000),
          };
          const useEdgePayBinding =
            env.EDGEPAY !== undefined &&
            new URL(payload.url).pathname.startsWith(
              "/api/v1/integrations/dakflare/"
            );
          const res = useEdgePayBinding
            ? await env.EDGEPAY!.fetch(new Request(payload.url, deliveryInit))
            : await fetch(payload.url, deliveryInit);

          // A 2xx with an empty body is a valid answer (202 Accepted is the
          // common one). Reading it is best-effort: a receipt that cannot be
          // parsed is still a delivery. A failure body is capped and kept so
          // the operator can see which receiver answered 404 and why.
          let ack: unknown = null;
          let failureBody: string | undefined;
          const text = await res.text().catch(() => "");
          if (res.ok) {
            if (text.trim() !== "") {
              try {
                ack = JSON.parse(text);
              } catch {
                ack = { text: text.slice(0, 512) };
              }
            }
          } else {
            failureBody = text.slice(0, 300);
            console.error(
              `[webhook] ${payload.deliveryId ?? "(no id)"} -> ${res.status} ${payload.url} ${failureBody}`
            );
          }

          if (typeof payload.deliveryId === "string") {
            const outcome = await recordDeliveryResult(env, {
              deliveryId: payload.deliveryId,
              httpStatus: res.status,
              ok: res.ok,
              ack,
              error: res.ok
                ? undefined
                : `HTTP ${res.status}${failureBody ? `: ${failureBody}` : ""}`,
            });
            if (!res.ok && outcome.retry) {
              msg.retry();
              continue;
            }
            if (!res.ok && outcome.deadLettered) {
              console.error(
                `[webhook] delivery ${payload.deliveryId} dead-lettered after ${outcome.attempts} attempts`
              );
            }
          } else if (!res.ok) {
            msg.retry();
            continue;
          }
        }
        msg.ack();
      } catch {
        msg.retry();
      }
    }
  },

  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const traceId = req.headers.get(HEADER_TRACE_ID)?.trim() || crypto.randomUUID();
    const sessionHelper = createD1SessionHelper(env, req);
    const res = await handleFetch(req, sessionHelper.env, ctx);
    const withBookmark = sessionHelper.attachBookmark(res);
    // One trace per request, echoed whether the caller supplied it or not, so a
    // consumer can correlate its own log line with an outbound delivery this
    // request caused. A 101 is returned untouched: a WebSocket response cannot
    // be re-wrapped without losing the socket.
    if (withBookmark.status === 101 || withBookmark.headers.has(HEADER_TRACE_ID)) {
      return withBookmark;
    }
    const headers = new Headers(withBookmark.headers);
    headers.set(HEADER_TRACE_ID, traceId);
    return new Response(withBookmark.body, {
      status: withBookmark.status,
      statusText: withBookmark.statusText,
      headers,
    });
  },
} satisfies ExportedHandler<Env>;

import { verifyDeploymentTotp } from "./lib/totp";

export async function handleFetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
    const { pathname } = url;
    const method = req.method.toUpperCase();

    /* ---- agent runtime (pass 3, stage A) ------------------------------ */
    // Matched BEFORE everything else. `routeAgentRequest` maps every Durable
    // Object binding, so three things happen here in order:
    //
    //   1. the kill switch answers 503 without touching the object;
    //   2. the path is REWRITTEN to the one pinned name. The router resolves the
    //      object id from the path before any hook runs, so trusting a caller's
    //      name would mint unbounded objects;
    //   3. the gate refuses a non-ASSISTANT class, checks Upgrade/Origin, spends
    //      a ticket bound to the session, and forwards the actor header.
    if (pathname === "/agents" || pathname.startsWith("/agents/")) {
      if (env.AGENT_RUNTIME !== "on") {
        return Response.json({ error: "agent_runtime_off" }, { status: 503 });
      }

      const pinned = new URL(req.url);
      // A durable stream is read over HTTP (SSE), so its `/streams/<id>`
      // suffix has to survive the rewrite to the pinned object. The first two
      // segments are still replaced with the pinned name, so a caller cannot
      // mint a second object.
      const streamSuffix = /^\/agents\/[^/]+\/[^/]+(\/streams\/[^/]+)$/.exec(pathname);
      pinned.pathname =
        streamSuffix !== null
          ? `/agents/${ASSISTANT_OBJECT_NAME}/${ASSISTANT_OBJECT_NAME}${streamSuffix[1]}`
          : `/agents/${ASSISTANT_OBJECT_NAME}/${ASSISTANT_OBJECT_NAME}`;
      const routedRequest = new Request(pinned.toString(), req);

      const gate = async (
        request: Request,
        route: { className: string }
      ): Promise<Response | Request | void> => {
        const denied = assertAssistantRoute(route);
        if (denied !== null) return denied;

        // The SSE endpoint is a read: no ticket (there is no upgrade to fail
        // visibly) but the same Origin rule and the same admin session. The
        // WebSocket gate below is untouched.
        const requestPath = new URL(request.url).pathname;
        const streamRead =
          request.method === "GET" &&
          (request.headers.get("Upgrade") ?? "").toLowerCase() !== "websocket" &&
          /\/streams\/[^/]+$/.test(requestPath);
        if (streamRead) {
          const originHeader = request.headers.get("Origin");
          if (originHeader !== null) {
            const origin = isTrustedOrigin(request, env);
            if (!origin.ok) return Response.json({ error: `agent_${origin.reason}` }, { status: 403 });
          } else {
            const fetchSite = request.headers.get("Sec-Fetch-Site")?.toLowerCase();
            if (
              fetchSite !== undefined &&
              fetchSite !== "" &&
              fetchSite !== "same-origin" &&
              fetchSite !== "none"
            ) {
              return Response.json({ error: "agent_origin_untrusted" }, { status: 403 });
            }
          }
          const headers = new Headers(request.headers);
          if (machineClientId(request) !== null) {
            const authorized = await withAdmin(
              request,
              env,
              async () => new Response(null, { status: 204 })
            );
            if (!authorized.ok) return authorized;
            const machine = machineActorFromRequest(request);
            headers.delete("x-dakflare-actor");
            headers.delete("x-dakflare-user-id");
            headers.set("x-dakflare-actor", machine.label);
            headers.set("x-dakflare-actor-role", machine.role);
            return new Request(request, { headers });
          }
          const guard = await requireRole(request, env, "write", {
            action: "resume an agent stream",
          });
          if (!guard.ok) return guard.response;
          headers.delete("x-dakflare-actor");
          headers.delete("x-dakflare-user-id");
          headers.set("x-dakflare-actor", guard.user.email);
          headers.set("x-dakflare-user-id", guard.user.id);
          headers.set("x-dakflare-actor-role", guard.user.role);
          return new Request(request, { headers });
        }

        const checked = checkUpgradeRequest(request, env);
        if (!checked.ok) return checked.response;

        // The session is resolved BEFORE the ticket is spent because the ticket
        // is bound to the session id. A stolen ticket is then refused as
        // `wrong_session` instead of burning the owner's upgrade.
        const guard = await requireRole(request, env, "write", {
          action: "connect to the agent runtime",
        });
        if (!guard.ok) return guard.response;

        const redeemed = await redeemTicket(
          env,
          checked.ticket,
          guard.user.sessionId,
          ASSISTANT_OBJECT_NAME
        );
        if (!redeemed.ok) return ticketRefusal(redeemed.reason);

        // Never trust a client-supplied identity header: delete it, then set the
        // value this Worker just proved.
        const headers = new Headers(request.headers);
        headers.delete("x-dakflare-actor");
        headers.delete("x-dakflare-user-id");
        headers.set("x-dakflare-actor", guard.user.email);
        headers.set("x-dakflare-user-id", guard.user.id);
        headers.set("x-dakflare-actor-role", guard.user.role);
        return new Request(request, { headers });
      };

      const gated = await gate(routedRequest, { className: ASSISTANT_BINDING });
      if (gated instanceof Response) return gated;
      if (env.AGENT_SVC === undefined) {
        return Response.json({ error: "agent_runtime_off" }, { status: 503 });
      }
      return env.AGENT_SVC.fetch(gated ?? routedRequest);
    }

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

    /* ---- inbound agent webhooks (v7.2) -------------------------------- */
    // Public ingress: the HMAC signature over the raw body IS the credential.
    // Deliberately outside the admin gate, and outside SCOPE_FOR_ACTION: no
    // agent token can reach it, and the turn it starts has no human session.
    const webhookIngressMatch = pathname.match(/^\/v1\/webhooks\/([^/]+)$/);
    if (method === "POST" && webhookIngressMatch) {
      return handleWebhookIngress(req, env, decodeURIComponent(webhookIngressMatch[1]));
    }

    /* ---- Multi-Channel Webhooks (v7.0) -------------------------------- */
    // `/v1/channels/<channel>/<connector-id>/webhook`: public by design, authenticates the caller
    // with the connector's own secret, and is matched after the legacy exact paths above/below.
    const connectorWebhook = pathname.match(/^\/v1\/channels\/([a-z]+)\/([^/]+)\/webhook$/);
    if (connectorWebhook) {
      return handleChannelWebhook(req, env, connectorWebhook[1], connectorWebhook[2], ctx);
    }
    if (pathname === "/v1/channels/telegram/webhook") {
      if (method !== "POST") return new Response("Method not allowed", { status: 405 });
      const bounded = await readBodyBounded(req, MAX_BODY_BYTES);
      if (!bounded.ok) return err("payload_too_large", 413);
      const rawBody = bounded.text;
      const plugin = getChannelPlugin("telegram");
      if (!plugin) return Response.json({ error: "not_found" }, { status: 404 });
      const verified = await plugin.verifyWebhook(req, rawBody, env);
      if (!verified) return new Response("Unauthorized", { status: 401 });
      const messages = await plugin.parseInbound(req, rawBody, env);
      for (const msg of messages) {
        const convId = `conv_tg_${msg.sender}`;
        const now = Date.now();
        ctx.waitUntil(
          (async () => {
            try {
              const batchRes = await env.DB.batch([
                env.DB.prepare(
                  `INSERT INTO messages (id, device_id, local_id, direction, peer, body, received_at, channel, conversation_id)
                   VALUES (?1, 'channel:telegram', ?2, 'in', ?3, ?4, ?5, 'telegram', ?6)
                   ON CONFLICT(device_id, local_id) DO NOTHING`
                ).bind(
                  crypto.randomUUID(),
                  `tg_${msg.channelMessageId}`,
                  msg.sender,
                  msg.body,
                  msg.timestamp,
                  convId
                ),
                env.DB.prepare(
                  `INSERT INTO conversations (id, channel, account_id, peer_id, session_state, last_inbound_at, created_at, updated_at)
                   VALUES (?1, 'telegram', 'default', ?2, 'WINDOW_OPEN', ?3, ?4, ?4)
                   ON CONFLICT(channel, account_id, peer_id) DO UPDATE SET
                     session_state = 'WINDOW_OPEN',
                     last_inbound_at = excluded.last_inbound_at,
                     updated_at = excluded.updated_at`
                ).bind(convId, msg.sender, msg.timestamp, now),
              ]);

              if (batchRes && Number(batchRes[0]?.meta?.changes ?? 0) > 0) {
                await dispatchFlows(
                  env,
                  "channel:telegram",
                  [
                    {
                      localId: `tg_${msg.channelMessageId}`,
                      sender: msg.sender,
                      body: msg.body,
                      receivedAt: msg.timestamp,
                    },
                  ],
                  "telegram"
                );
              }
            } catch (err) {
              console.warn(`[telegram] failed to store message/conversation: ${String(err)}`);
            }
          })()
        );
      }
      return Response.json({ ok: true, count: messages.length });
    }

    if (pathname === "/v1/channels/whatsapp/webhook") {
      if (method === "GET") {
        const mode = url.searchParams.get("hub.mode");
        const token = url.searchParams.get("hub.verify_token");
        const challenge = url.searchParams.get("hub.challenge");
        const expectedToken = (env as unknown as Record<string, string | undefined>).WHATSAPP_VERIFY_TOKEN;
        const enc = new TextEncoder();
        if (
          mode === "subscribe" &&
          expectedToken &&
          token !== null &&
          timingSafeEqual(enc.encode(token), enc.encode(expectedToken))
        ) {
          return new Response(challenge ?? "", { status: 200 });
        }
        return new Response("Forbidden", { status: 403 });
      }

      if (method === "POST") {
        const bounded = await readBodyBounded(req, MAX_BODY_BYTES);
        if (!bounded.ok) return err("payload_too_large", 413);
        const rawBody = bounded.text;
        const plugin = getChannelPlugin("whatsapp");
        if (!plugin) return Response.json({ error: "not_found" }, { status: 404 });
        const verified = await plugin.verifyWebhook(req, rawBody, env);
        if (!verified) return new Response("Unauthorized", { status: 401 });
        const messages = await plugin.parseInbound(req, rawBody, env);
        for (const msg of messages) {
          const convId = `conv_wa_${msg.sender}`;
          const now = Date.now();
          const expiresAt = msg.timestamp + 24 * 3600 * 1000;
          ctx.waitUntil(
            (async () => {
              try {
                const batchRes = await env.DB.batch([
                  env.DB.prepare(
                    `INSERT INTO messages (id, device_id, local_id, direction, peer, body, received_at, channel, conversation_id)
                     VALUES (?1, 'channel:whatsapp', ?2, 'in', ?3, ?4, ?5, 'whatsapp', ?6)
                     ON CONFLICT(device_id, local_id) DO NOTHING`
                  ).bind(
                    crypto.randomUUID(),
                    `wa_${msg.channelMessageId}`,
                    msg.sender,
                    msg.body,
                    msg.timestamp,
                    convId
                  ),
                  env.DB.prepare(
                    `INSERT INTO conversations (id, channel, account_id, peer_id, session_state, window_expires_at, last_inbound_at, created_at, updated_at)
                     VALUES (?1, 'whatsapp', 'default', ?2, 'WINDOW_OPEN', ?3, ?4, ?5, ?5)
                     ON CONFLICT(channel, account_id, peer_id) DO UPDATE SET
                       session_state = 'WINDOW_OPEN',
                       window_expires_at = excluded.window_expires_at,
                       last_inbound_at = excluded.last_inbound_at,
                       updated_at = excluded.updated_at`
                  ).bind(convId, msg.sender, expiresAt, msg.timestamp, now),
                ]);

                if (batchRes && Number(batchRes[0]?.meta?.changes ?? 0) > 0) {
                  await dispatchFlows(
                    env,
                    "channel:whatsapp",
                    [
                      {
                        localId: `wa_${msg.channelMessageId}`,
                        sender: msg.sender,
                        body: msg.body,
                        receivedAt: msg.timestamp,
                      },
                    ],
                    "whatsapp"
                  );
                }
              } catch (err) {
                console.warn(`[whatsapp] failed to store message/conversation: ${String(err)}`);
              }
            })()
          );
        }
        return Response.json({ ok: true, count: messages.length });
      }
    }

    /* ---- MCP (v6.1 P4) -------------------------------------------------- */
    // Its own auth, its own error envelope (JSON-RPC), and its own protocol
    // versioning: everything an MCP client expects, none of which the admin gate
    // speaks. Resolve the credential first; the tool registry is then filtered to
    // the scopes it holds, so `tools/list` is the permission surface.
    /* ---- MCP OAuth discovery (RFC 9728 / RFC 8414) --------------------- */
    // Metadata is public by definition: a client reads it to learn how to
    // authenticate. Only the two documents exist; anything else under
    // /.well-known/ 404s from the handler.
    if (method === "GET" && pathname.startsWith("/.well-known/oauth-")) {
      return handleWellKnown(req, env);
    }

    /* ---- MCP (v6.1 P4, streamable HTTP since v7.1) --------------------- */
    // POST is the request/response leg, GET holds the SSE stream for a stateful
    // session, DELETE ends it. `/mcp` is the spec path; `/v1/mcp` stays for the
    // tokens already deployed against it.
    if (
      (method === "POST" && pathname === "/v1/mcp") ||
      ((method === "POST" || method === "GET" || method === "DELETE") && pathname === "/mcp")
    ) {
      return handleMcpRoute(req, env, pathname);
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
    // Is a second-factor challenge live for this browser? The login page asks
    // before it renders a code form, so a stale `?step=code` or a session it
    // could not read cannot strand anyone on a step nothing can satisfy.
    if (method === "GET" && pathname === "/v1/auth/challenge") {
      return handleAuthChallenge(req, env);
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
    /* ---- channel connectors ------------------------------------------- */
    // Credentials: every handler refuses a member session and an agent token, so a dkf_agt_
    // credential can never read or rotate a connector's secret.
    if (method === "POST" && pathname === "/v1/admin/connectors") {
      return withAdminAccess(req, env, "write", "create channel connectors", (actor) =>
        handleConnectorCreate(req, env, actor)
      );
    }
    if (method === "GET" && pathname === "/v1/admin/connectors") {
      return withAdminAccess(req, env, "read", "read channel connectors", (actor) =>
        handleConnectorList(env, actor)
      );
    }
    const connectorRegisterMatch = pathname.match(
      /^\/v1\/admin\/connectors\/([^/]+)\/register-webhook$/
    );
    if (method === "POST" && connectorRegisterMatch) {
      return withAdminAccess(req, env, "write", "register channel webhook", (actor) =>
        handleTelegramRegister(req, env, actor, decodeURIComponent(connectorRegisterMatch[1]))
      );
    }
    const connectorMatch = pathname.match(/^\/v1\/admin\/connectors\/([^/]+)$/);
    if (method === "PATCH" && connectorMatch) {
      return withAdminAccess(req, env, "write", "update channel connectors", (actor) =>
        handleConnectorUpdate(req, env, actor, connectorMatch[1])
      );
    }
    if (method === "DELETE" && connectorMatch) {
      return withAdminAccess(req, env, "write", "delete channel connectors", (actor) =>
        handleConnectorDelete(env, actor, connectorMatch[1])
      );
    }

    /* ---- message templates and audience -------------------------------- */
    // Templates and audience rows are operator records, not credentials. Reads
    // allow a member; writes require a human owner or admin. Route order puts
    // `/preview` before the bare id form, and `/contacts/import` before the list.
    if (method === "GET" && pathname === "/v1/admin/templates") {
      return withAdminAccess(req, env, "read", "read message templates", (actor) =>
        handleTemplateList(env, actor)
      );
    }
    if (method === "POST" && pathname === "/v1/admin/templates") {
      return withAdminAccess(req, env, "write", "create message template", (actor) =>
        handleTemplateCreate(req, env, actor)
      );
    }
    const templatePreviewMatch = pathname.match(/^\/v1\/admin\/templates\/([^/]+)\/preview$/);
    if (method === "POST" && templatePreviewMatch) {
      return withAdminAccess(req, env, "read", "preview message template", (actor) =>
        handleTemplatePreview(req, env, actor, decodeURIComponent(templatePreviewMatch[1]))
      );
    }
    const templateMatch = pathname.match(/^\/v1\/admin\/templates\/([^/]+)$/);
    if (method === "DELETE" && templateMatch) {
      return withAdminAccess(req, env, "write", "delete message template", (actor) =>
        handleTemplateDelete(env, actor, decodeURIComponent(templateMatch[1]))
      );
    }
    if (method === "GET" && pathname === "/v1/admin/contacts") {
      return withAdminAccess(req, env, "read", "read contacts", (actor) =>
        handleContactsList(env, url, actor)
      );
    }
    if (method === "POST" && pathname === "/v1/admin/contacts/import") {
      return withAdminAccess(req, env, "write", "import contacts", (actor) =>
        handleContactsImport(req, env, actor)
      );
    }

    /* ---- pacing policies ---------------------------------------------- */
    // The console edits the per-target rate, quiet hours and timezone here. The
    // scheduled create route snapshots the row into `policy_json`, so a later
    // policy edit does not silently rewrite messages already queued.
    if (method === "GET" && pathname === "/v1/admin/pacing") {
      return withAdminAccess(req, env, "read", "manage pacing", (_actor) =>
        handlePacingList(env)
      );
    }
    const pacingMatch = pathname.match(/^\/v1\/admin\/pacing\/([^/]+)\/([^/]+)$/);
    if (method === "PUT" && pacingMatch) {
      return withAdminAccess(req, env, "write", "manage pacing", (actor) =>
        handlePacingUpdate(req, env, actor, pacingMatch[1], pacingMatch[2])
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

    /* ---- inbound agent webhooks (v7.2) -------------------------------- */
    // Human-only: all four actions are absent from SCOPE_FOR_ACTION and each
    // handler calls assertHuman, so an agent token or a webhook actor can
    // never mint, inspect or revoke an ingress credential.
    if (method === "POST" && pathname === "/v1/admin/webhooks") {
      return withAdminAccess(req, env, "write", "create webhooks", (actor) =>
        handleWebhookCreate(req, env, actor)
      );
    }
    if (method === "GET" && pathname === "/v1/admin/webhooks") {
      const requestedKind = url.searchParams.get("kind") ?? "inbound";
      if (requestedKind !== "inbound" && requestedKind !== "outbound") {
        return Response.json(
          { error: "bad_request", message: "kind must be 'inbound' or 'outbound'" },
          { status: 400 }
        );
      }
      return withAdminAccess(req, env, "read", "list webhooks", (actor) =>
        handleWebhookList(env, actor, requestedKind)
      );
    }
    const webhookTestMatch = pathname.match(/^\/v1\/admin\/webhooks\/([^/]+)\/test$/);
    if (method === "POST" && webhookTestMatch) {
      return withAdminAccess(req, env, "write", "test webhooks", (actor) =>
        handleWebhookTest(env, decodeURIComponent(webhookTestMatch[1]), actor)
      );
    }
    const webhookDeliveriesMatch = pathname.match(
      /^\/v1\/admin\/webhooks\/([^/]+)\/deliveries$/
    );
    if (method === "GET" && webhookDeliveriesMatch) {
      return withAdminAccess(req, env, "read", "read webhook deliveries", (actor) =>
        handleWebhookDeliveries(env, decodeURIComponent(webhookDeliveriesMatch[1]), actor)
      );
    }
    /* ---- generic integration surface (v6.3) --------------------------- */
    // The manifest and health are reads a service token needs before it can call
    // anything, so they are reachable with `devices:read`. Replay is a bounded
    // write with its own scope; it names the webhook AND the delivery, so a
    // credential cannot replay someone else's row.
    if (method === "GET" && pathname === "/v1/integration/manifest") {
      return withAdminAccess(req, env, "read", "read the integration manifest", async () =>
        handleIntegrationManifest(req)
      );
    }
    if (method === "GET" && pathname === "/v1/integration/health") {
      return withAdminAccess(req, env, "read", "read integration health", (actor) =>
        handleIntegrationHealth(req, env, actor)
      );
    }
    const messageStatusMatch = pathname.match(/^\/v1\/integration\/messages\/([^/]+)$/);
    if (method === "GET" && messageStatusMatch) {
      return withAdminAccess(req, env, "read", "read a message status", () =>
        handleMessageStatus(req, env, decodeURIComponent(messageStatusMatch[1]))
      );
    }
    const deliveryReplayMatch = pathname.match(
      /^\/v1\/webhooks\/([^/]+)\/deliveries\/([^/]+)\/replay$/
    );
    if (method === "POST" && deliveryReplayMatch) {
      return withAdminAccess(req, env, "write", "replay a webhook delivery", (actor) =>
        handleWebhookDeliveryReplay(
          req,
          env,
          actor,
          decodeURIComponent(deliveryReplayMatch[1]),
          decodeURIComponent(deliveryReplayMatch[2])
        )
      );
    }

    const webhookRotateMatch = pathname.match(
      /^\/v1\/admin\/webhooks\/([^/]+)\/rotate-secret$/
    );
    if (method === "POST" && webhookRotateMatch) {
      // Human-only: absent from SCOPE_FOR_ACTION, so an agent or service token is
      // refused before the handler runs. A credential that can rotate a signing
      // secret can also forge deliveries to the receiver.
      return withAdminAccess(req, env, "write", "rotate webhook secret", (actor) =>
        handleWebhookSecretRotate(req, env, decodeURIComponent(webhookRotateMatch[1]), actor)
      );
    }

    const webhookDeleteMatch = pathname.match(/^\/v1\/admin\/webhooks\/([^/]+)$/);
    if (method === "DELETE" && webhookDeleteMatch) {
      return withAdminAccess(req, env, "write", "delete webhooks", (actor) =>
        handleWebhookDelete(env, decodeURIComponent(webhookDeleteMatch[1]), actor)
      );
    }

    /* ---- Agent analysis (v7.1 WS4/WS6) --------------------------------- */
    // Three reads and one capability mint. The read-only paths use the `read`
    // permission (a member may ask); synthesize is a `write` because it mints
    // the authority handle an apply spends. `withAdminAccess` is the same gate
    // the rest of the console uses, so ADMIN_TOKEN, a session and a `dkf_agt_`
    // token all reach it and the per-token/admin rate limiter still applies.
    if (method === "POST" && pathname === "/v1/agent/triage") {
      return withAdminAccess(req, env, "read", "triage inbound messages", (_actor) =>
        handleAgentTriage(req, env)
      );
    }
    if (method === "POST" && pathname === "/v1/agent/telemetry") {
      return withAdminAccess(req, env, "read", "read agent telemetry", (actor) =>
        handleAgentTelemetry(req, env, actor)
      );
    }
    if (method === "POST" && pathname === "/v1/agent/diagnose") {
      return withAdminAccess(req, env, "read", "diagnose agent failures", (_actor) =>
        handleAgentDiagnose(req, env)
      );
    }
    if (method === "POST" && pathname === "/v1/agent/synthesize") {
      return withAdminAccess(req, env, "write", "synthesize agent patches", (actor) =>
        handleAgentSynthesize(req, env, actor)
      );
    }

    /* ---- agent runtime control (pass 3, stage A) ----------------------- */
    // The ticket action is deliberately absent from SCOPE_FOR_ACTION, so an
    // agent token is refused before the handler runs. The GET resolves through
    // `runAsAgent`, the same function a future tool path must call.
    // One non-streaming turn for a machine caller; the console uses the socket.
    if (method === "POST" && pathname === "/v1/admin/agent/say") {
      return withAdminAccess(req, env, "write", "run one agent turn", (actor) =>
        forwardToAgent(req, env, "/internal/agent/say", actor)
      );
    }
    // The durable transcript and the attachments it may carry. Every action is
    // absent from SCOPE_FOR_ACTION, so an agent credential is refused before the
    // handler runs: a transcript is operator data and a file upload is a write.
    if (method === "GET" && pathname === "/v1/admin/agent/conversation") {
      return withAdminAccess(req, env, "read", "read the agent conversation", (actor) =>
        forwardToAgent(req, env, "/internal/agent/conversation", actor)
      );
    }
    if (method === "DELETE" && pathname === "/v1/admin/agent/conversation") {
      return withAdminAccess(req, env, "write", "clear the agent conversation", (actor) =>
        forwardToAgent(req, env, "/internal/agent/conversation", actor)
      );
    }
    if (method === "POST" && pathname === "/v1/admin/agent/attachments") {
      return withAdminAccess(req, env, "write", "upload agent attachments", (actor) =>
        handleAgentAttachmentUpload(req, env, actor)
      );
    }
    if (method === "GET" && pathname === "/v1/admin/agent/attachments") {
      return handleAgentAttachmentList(req, env);
    }
    const attachmentDeleteMatch = pathname.match(/^\/v1\/admin\/agent\/attachments\/([^/]+)$/);
    if (method === "DELETE" && attachmentDeleteMatch) {
      return withAdminAccess(req, env, "write", "delete agent attachments", (actor) =>
        handleAgentAttachmentDelete(req, env, actor, decodeURIComponent(attachmentDeleteMatch[1]))
      );
    }
    if (method === "POST" && pathname === "/v1/admin/agent/ticket") {
      return withAdminAccess(req, env, "write", "mint agent runtime tickets", (actor) =>
        handleAgentTicketMint(req, env, actor)
      );
    }
    // One-shot migration hooks for moving AssistantAgent to its own Worker.
    // Both are admin-gated and removed after the cutover.
    if (method === "POST" && pathname === "/v1/admin/agent/totp") {
      return withAdminAccess(req, env, "read", "verify an agent TOTP", async () => {
        const body = (await req.json().catch(() => null)) as
          | { actor?: AdminActor; code?: unknown }
          | null;
        if (body === null || body.actor === undefined || typeof body.code !== "string") {
          return Response.json({ error: "bad_request" }, { status: 400 });
        }
        const ok = await verifyDeploymentTotp(env, body.actor, body.code);
        return Response.json({ ok });
      });
    }
    if (method === "POST" && pathname === "/v1/admin/agent/import") {
      return withAdminAccess(req, env, "write", "import agent conversations", (actor) =>
        forwardToAgent(req, env, "/internal/agent/import", actor)
      );
    }
    // The split agent Worker checks authority itself, then asks this Worker to
    // put the command in the Durable Object that owns the handset socket. Only
    // the enqueue crosses the binding: the grant check and the audit row stay
    // with the Worker that served the request. `CORE` presents the admin
    // credential, and the action is absent from SCOPE_FOR_ACTION, so an agent
    // token cannot reach it.
    if (method === "POST" && pathname === "/v1/admin/agent/enqueue") {
      return withAdminAccess(req, env, "write", "enqueue a device command", async () => {
        const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
        if (body === null) return Response.json({ error: "bad_request" }, { status: 400 });
        const deviceId = typeof body.device_id === "string" ? body.device_id : "";
        const commandId = typeof body.command_id === "string" ? body.command_id : "";
        const to = typeof body.to === "string" ? body.to : "";
        const text = typeof body.body === "string" ? body.body : "";
        const priority = typeof body.priority === "string" ? body.priority : "normal";
        const expiresAt = typeof body.expires_at === "number" ? body.expires_at : 0;
        const idempotencyKey =
          typeof body.idempotency_key === "string" ? body.idempotency_key : undefined;
        const simSlot = typeof body.sim_slot === "number" ? body.sim_slot : undefined;
        if (deviceId === "" || commandId === "" || to === "" || text === "" || expiresAt <= 0) {
          return Response.json({ error: "bad_request" }, { status: 400 });
        }
        const outcome = await enqueueOutboundCommand(env, {
          deviceId,
          commandId,
          to,
          body: text,
          priority,
          expiresAt,
          ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
          ...(simSlot !== undefined ? { simSlot } : {}),
        });
        if (!outcome.ok) {
          return Response.json({ error: "enqueue_failed" }, { status: 502 });
        }
        return Response.json({ command_id: outcome.commandId, replayed: outcome.replayed });
      });
    }
    if (method === "GET" && pathname === "/v1/admin/agent/runtime") {
      return withAdminAccess(req, env, "read", "read the agent runtime", (actor) =>
        forwardToAgent(req, env, "/internal/agent/runtime", actor)
      );
    }
    // Autonomy control plane (pass 3, stage C). Human-only: the three actions
    // are absent from SCOPE_FOR_ACTION, and each handler calls assertHuman, so
    // an agent credential is refused before it can widen its own window.
    if (method === "GET" && pathname === "/v1/admin/agent/autonomy") {
      return withAdminAccess(req, env, "read", "read agent autonomy", (_actor) =>
        handleAutonomyRead(req, env)
      );
    }
    if (method === "POST" && pathname === "/v1/admin/agent/autonomy") {
      return withAdminAccess(req, env, "write", "enable agent autonomy", (actor) =>
        handleAutonomyEnable(req, env, actor)
      );
    }
    if (method === "DELETE" && pathname === "/v1/admin/agent/autonomy") {
      return withAdminAccess(req, env, "write", "revoke agent autonomy", (actor) =>
        handleAutonomyRevoke(req, env, actor)
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

    // v6.1 P3 provenance. Reads, so a member may use them; the ids they return
    // are the operator's own, and the trace never includes a message body that the
    // caller could not already read from /v1/messages.
    const traceMatch = pathname.match(/^\/v1\/admin\/trace\/([^/]+)$/);
    if (method === "GET" && traceMatch) {
      return withAdminAccess(req, env, "read", "read trace", (actor) =>
        handleTrace(env, traceMatch[1], url, actor)
      );
    }
    if (method === "GET" && pathname === "/v1/admin/dlq") {
      return withAdminAccess(req, env, "read", "read the dead letter queue", (_actor) =>
        handleDlq(env, url)
      );
    }
    if (method === "GET" && pathname === "/v1/admin/ws") {
      return withAdminAccess(req, env, "read", "inspect sockets", (_actor) =>
        handleWsInspect(env, url)
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
    if (method === "POST" && pathname === "/v1/admin/alerts/ack-all") {
      return withAdminAccess(req, env, "write", "acknowledge alerts", (actor) =>
        handleAlertsAckAll(env, actor)
      );
    }
    const alertAckMatch = pathname.match(/^\/v1\/admin\/alerts\/([^/]+)\/ack$/);
    if (method === "POST" && alertAckMatch) {
      return withAdminAccess(req, env, "write", "acknowledge alerts", (actor) =>
        handleAlertAck(env, decodeURIComponent(alertAckMatch[1]), actor)
      );
    }

    /* ---- AI console assistant (pass 1) --------------------------------- */
    // Human-only by construction: none of these actions appear in
    // SCOPE_FOR_ACTION, so an agent token is refused with 403 before the handler
    // runs. An assistant that spends the operator's token budget must not be
    // drivable by a credential another agent can mint.
    if (method === "GET" && pathname === "/v1/admin/ai/settings") {
      return withAdminAccess(req, env, "read", "read AI settings", (_actor) =>
        handleAiSettingsGet(env)
      );
    }
    if (method === "PUT" && pathname === "/v1/admin/ai/settings") {
      return withAdminAccess(req, env, "write", "update AI settings", (actor) =>
        handleAiSettingsPut(req, env, actor)
      );
    }
    if (method === "GET" && pathname === "/v1/admin/ai/models") {
      return withAdminAccess(req, env, "write", "list AI models", (_actor) =>
        handleAiModels(env)
      );
    }
    if (method === "POST" && pathname === "/v1/admin/ai/test") {
      return withAdminAccess(req, env, "write", "test AI provider", (_actor) =>
        handleAiTest(env)
      );
    }
    // System 1 provider probe. The action string is deliberately absent from
    // SCOPE_FOR_ACTION, so an agent token is refused with 403 before the
    // handler runs: this route spends a provider call and is for a human
    // debugging a deployment's model wiring.
    if (method === "POST" && pathname === "/v1/admin/ai/system1/test") {
      return withAdminAccess(req, env, "write", "test System 1 provider", (_actor) =>
        handleSystem1Test(req, env)
      );
    }
    if (method === "POST" && pathname === "/v1/admin/assistant/chat") {
      return withAdminAccess(req, env, "write", "use the AI assistant", (actor) =>
        handleAssistantChat(req, env, actor)
      );
    }
    // The id segment is passed RAW and matched there: a malformed escape is a
    // 404 rather than a throw on an authenticated path.
    const proposalAcceptMatch = pathname.match(
      /^\/v1\/admin\/assistant\/proposals\/([^/]+)\/accept$/
    );
    if (method === "POST" && proposalAcceptMatch) {
      return withAdminAccess(req, env, "write", "accept AI proposals", (actor) =>
        handleAssistantProposalAccept(env, proposalAcceptMatch[1], actor)
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
    const ruleMatch = pathname.match(/^\/v1\/admin\/rules\/([^/]+)$/);
    if (method === "PUT" && ruleMatch) {
      return withAdminAccess(req, env, "write", "save rules", (actor) =>
        handleRulePut(req, env, ruleMatch[1], actor)
      );
    }
    if (method === "DELETE" && ruleMatch) {
      let ruleId: string;
      try {
        ruleId = decodeURIComponent(ruleMatch[1]);
      } catch {
        return err("bad_request", 400);
      }
      return withAdminAccess(req, env, "write", "delete rules", (actor) =>
        handleRuleDelete(env, ruleId, actor)
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
      return withAdminAccess(req, env, "write", "save workflows", (actor) =>
        handleWorkflowPut(req, env, workflowMatch[1], actor)
      );
    }
    if (method === "DELETE" && workflowMatch) {
      return withAdminAccess(req, env, "write", "delete workflows", (actor) =>
        handleWorkflowDelete(env, workflowMatch[1], actor)
      );
    }
    if (method === "GET" && pathname === "/v1/devices") {
      return withAdminAccess(req, env, "read", "list devices", (_actor) =>
        handleDevicesList(env, url)
      );
    }

    /* ---- scheduled sends ---------------------------------------------- */
    // D1 is the queue and the cancellation authority; the Scheduler Durable
    // Object only owns the clock. Create and cancel are writes; the list is a
    // read the console and a member may use.
    if (method === "POST" && pathname === "/v1/scheduled") {
      return withAdminAccess(req, env, "write", "schedule messages", (actor) =>
        handleScheduledCreate(req, env, actor)
      );
    }
    if (method === "GET" && pathname === "/v1/scheduled") {
      return withAdminAccess(req, env, "read", "read scheduled messages", (_actor) =>
        handleScheduledList(env, url)
      );
    }
    const scheduledCancelMatch = pathname.match(/^\/v1\/scheduled\/([^/]+)$/);
    if (method === "DELETE" && scheduledCancelMatch) {
      return withAdminAccess(req, env, "write", "cancel scheduled messages", (actor) =>
        handleScheduledCancel(req, env, actor, scheduledCancelMatch[1])
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
    const v1RuleMatch = pathname.match(/^\/v1\/rules\/([^/]+)$/);
    if (method === "PUT" && v1RuleMatch) {
      return withAdminAccess(req, env, "write", "save rules", (actor) =>
        handleRulePut(req, env, v1RuleMatch[1], actor)
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

    // Per-connector send: same effect as the legacy route below, but with the credential that
    // belongs to that account instead of the deployment's environment. Inbound without this is a
    // mailbox nobody can answer from.
    const connectorSendMatch = pathname.match(/^\/v1\/channels\/([^/]+)\/([^/]+)\/send$/);
    if (method === "POST" && connectorSendMatch !== null) {
      const channel = connectorSendMatch[1];
      const connectorId = connectorSendMatch[2];
      return withAdminAccess(req, env, "write", `send ${channel} message`, async (_actor) => {
        const parsed = await readJsonBoundedResult(req, MAX_BODY_BYTES);
        if (!parsed.ok) return err(parsed.reason);
        const body = parsed.value;
        const to = String(body.to || "");
        const messageBody = String(body.body || "");
        if (!to || !messageBody) {
          return Response.json(
            { error: "bad_request", message: "to and body required" },
            { status: 400 }
          );
        }
        const result = await sendConnectorOutbound(env, channel, connectorId, {
          to,
          body: messageBody,
          ...(typeof body.media_url === "string" ? { mediaUrl: body.media_url } : {}),
          ...(typeof body.template_id === "string" ? { templateId: body.template_id } : {}),
          // Outside the 24-hour window, Messenger allows a 7-day HUMAN_AGENT message and
          // Instagram allows a private reply to a comment. Passing them through is what makes
          // those two policies reachable from the route rather than only from the SDK.
          ...(body.use_human_agent_tag === true ? { useHumanAgentTag: true } : {}),
          ...(typeof body.comment_id === "string" ? { commentId: body.comment_id } : {}),
        });
        const status = result.success
          ? 200
          : result.errorCode === "connector_not_found"
            ? 404
            : result.errorCode === "window_expired"
              ? 409
              : 400;
        return Response.json(result, { status });
      });
    }

    const channelSendMatch = pathname.match(/^\/v1\/channels\/([^/]+)\/send$/);
    if (method === "POST" && channelSendMatch) {
      const channel = channelSendMatch[1];
      return withAdminAccess(req, env, "write", `send ${channel} message`, async (_actor) => {
        const plugin = getChannelPlugin(channel);
        if (!plugin) {
          return Response.json(
            { error: "not_found", message: `Channel ${channel} not found` },
            { status: 404 }
          );
        }
        const parsed = await readJsonBoundedResult(req, MAX_BODY_BYTES);
        if (!parsed.ok) return err(parsed.reason);
        const body = parsed.value;
        const to = String(body.to || "");
        const messageBody = String(body.body || "");
        if (!to || !messageBody) {
          return Response.json(
            { error: "bad_request", message: "to and body required" },
            { status: 400 }
          );
        }
        const result = await plugin.sendOutbound(
          {
            to,
            body: messageBody,
            templateId: typeof body.template_id === "string" ? body.template_id : undefined,
          },
          env
        );
        return Response.json(result, { status: result.success ? 200 : 400 });
      });
    }

    const commandMatch = pathname.match(/^\/v1\/(?:sms\/)?commands\/([^/]+)$/);
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
      return withDevice(req, env, ctx, (r, e, deviceId) => handleWs(r, e, ctx, deviceId));
    }
    if (method === "POST" && pathname === "/v1/edge/incoming/batch") {
      return handleEdgeIncomingBatch(req, env, ctx);
    }
    if (method === "POST" && pathname === "/v1/sms/incoming/batch") {
      return withDevice(req, env, ctx, (r, e, deviceId, body) =>
        handleIncomingBatch(r, e, deviceId, body, ctx)
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
    // Approvals, answered from the handset. Device-authenticated because the phone
    // is the party who can see whether sending is safe, and it may only answer a
    // request whose target names it.
    if (method === "GET" && pathname === "/v1/device/approvals") {
      return withDevice(req, env, ctx, (_r, e, deviceId) => handleDeviceApprovals(e, deviceId));
    }
    const deviceApprovalMatch = pathname.match(
      /^\/v1\/device\/approvals\/([^/]+)\/(approve|reject)$/
    );
    if (method === "POST" && deviceApprovalMatch) {
      const approvalId = decodeURIComponent(deviceApprovalMatch[1]);
      const decision = deviceApprovalMatch[2];
      const meta = requestMeta(req);
      return withDevice(req, env, ctx, (_r, e, deviceId, body) =>
        decision === "approve"
          ? handleDeviceApprovalApprove(body, e, deviceId, approvalId, meta)
          : handleDeviceApprovalReject(e, deviceId, approvalId, meta)
      );
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
}

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

  // Alerts are operator history, not device state. Acknowledged or resolved
  // ones are safe to age out with the message log; an OPEN alert is the current
  // outage signal and is never deleted here.
  const alerts = await env.DB.prepare(
    `DELETE FROM alerts
      WHERE (acknowledged_at IS NOT NULL AND acknowledged_at < ?1)
         OR (resolved_at IS NOT NULL AND resolved_at < ?1)`
  )
    .bind(cutoff)
    .run();

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const proposalCutoff = nowMs - 86_400_000;
  try {
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM extract_misses WHERE at < ?`).bind(cutoff),
      env.DB.prepare(`DELETE FROM webhook_deliveries WHERE received_at < ?`).bind(cutoff),
      env.DB.prepare(
        `DELETE FROM session
          WHERE (typeof("expiresAt") IN ('integer', 'real') AND "expiresAt" < ?1)
             OR (typeof("expiresAt") = 'text' AND "expiresAt" < ?2)`
      ).bind(nowMs, nowIso),
      env.DB.prepare(
        `DELETE FROM verification
          WHERE (typeof("expiresAt") IN ('integer', 'real') AND "expiresAt" < ?1)
             OR (typeof("expiresAt") = 'text' AND "expiresAt" < ?2)`
      ).bind(nowMs, nowIso),
      env.DB.prepare(`DELETE FROM invite WHERE expires_at < ?`).bind(cutoff),
      env.DB.prepare(
        `DELETE FROM approval_requests WHERE expires_at < ? AND state != 'PENDING'`
      ).bind(cutoff),
      env.DB.prepare(`DELETE FROM assistant_proposals WHERE expires_at < ?`).bind(proposalCutoff),
    ]);
  } catch {
    // Non-fatal if an older database schema lacks one of the auxiliary tables.
  }

  // Attachments expire after 24 h. Until this sweep existed the row and its R2
  // object outlived the TTL forever. The purge is bounded per run; a backlog
  // continues on the next schedule rather than holding the handler open.
  let attachmentsDeleted = 0;
  if (env.MEDIA_BUCKET !== undefined) {
    try {
      const purged = await purgeExpiredAttachments({
        store: d1AttachmentStore(env),
        blobs: r2BlobStore(env.MEDIA_BUCKET),
      });
      attachmentsDeleted = purged.deleted;
    } catch (error) {
      console.warn(`[retention] attachment sweep failed: ${String(error)}`);
    }
  }

  console.log(
    `[retention] days=${days} messages=${deleted} pairing_codes=${Number(
      codes.meta?.changes ?? 0
    )} magic_links=${Number(magicLinks.meta?.changes ?? 0)} rule_hits=${hitsDeleted} alerts=${Number(
      alerts.meta?.changes ?? 0
    )} attachments=${attachmentsDeleted}`
  );
}

function unauthorized(): Response {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

/* ---- session cookie helpers ------------------------------------------ */

const ADMIN_SESSION_KEYS = new Map<string, Promise<CryptoKey>>();

/**
 * Session key derivation.
 *
 * The HMAC key is `SHA-256("dakflare-session-v1\n" + ADMIN_TOKEN)`, so rotating
 * `ADMIN_TOKEN` invalidates every outstanding session without a revocation list.
 * The label keeps the derivation domain-separated from any other use of the token.
 */
function sessionKey(adminToken: string): Promise<CryptoKey> {
  let cached = ADMIN_SESSION_KEYS.get(adminToken);
  if (cached === undefined) {
    if (ADMIN_SESSION_KEYS.size >= 8) ADMIN_SESSION_KEYS.clear();
    cached = (async () => {
      const digest = await sha256(`dakflare-session-v1\n${adminToken}`);
      return crypto.subtle.importKey("raw", digest, { name: "HMAC", hash: "SHA-256" }, false, [
        "sign",
      ]);
    })();
    ADMIN_SESSION_KEYS.set(adminToken, cached);
  }
  return cached;
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
  const ip = clientIp(req);
  const lockoutBefore = await checkAuthLockout(env, { email: "admin-session", ip });
  if (lockoutBefore.locked) return lockoutResponse(lockoutBefore);

  if (env.ADMIN_LIMITER) {
    const { success } = await env.ADMIN_LIMITER.limit({ key: `login:${ip ?? "local"}` });
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
  if (!timingSafeEqual(providedDigest, expectedDigest)) {
    const after = await recordAuthFailure(env, { email: "admin-session", ip });
    if (after.locked) {
      await auditLockout(env, req, { email: "admin-session", factor: "admin_token", lockout: after });
      return lockoutResponse(after);
    }
    return unauthorized();
  }

  await clearAuthFailures(env, "admin-session");

  // The only place ADMIN_TOKEN becomes a session. Rotation itself happens via
  // `cf workers secrets update` (a Worker cannot set its own secret), so this is the
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

/**
 * The worker-to-worker interface. A consumer binds this script with
 * `entrypoint: "DakFlareApi"` and calls typed methods; every one of them goes through
 * `handleFetch`, so the scopes, limiters, audits and idempotency are the same ones the HTTP API
 * applies. See `src/binding.ts` for the trust modes.
 */
export { DakFlareAdminApi, DakFlareApi, DakFlareRuntimeApi } from "./binding-api";

/** Exported class: a Durable Object only exists if the entry module exports it. */
export { ChannelConnection };

/**
 * Legacy assistant object. The split deployment serves it from
 * `dakflare-agent-worker` via `AGENT_SVC`; the isolated EdgePay instance keeps
 * the pre-split `ASSISTANT` namespace, so the class stays exported here.
 */
export { AssistantAgent } from "./agent/runtime";
