/**
 * Agent runtime control routes — pass 3, stage A.
 *
 * Two routes only, and both are human-surface:
 *
 *   POST /v1/admin/agent/ticket   mint one 60-second, single-use upgrade ticket
 *   GET  /v1/admin/agent/runtime  what the shell is: enabled, schema, pin
 *
 * The ticket action is deliberately ABSENT from `SCOPE_FOR_ACTION`, so an agent
 * token is refused before the handler runs. A credential that can mint the
 * ticket that opens the runtime is a credential that can enter it.
 *
 * The GET goes through `runAsAgent` because that is the function a future tool
 * will call too: one place resolves the actor, checks the token scope, applies
 * the limiter and records the use. Stage A wires no tool, so this route is the
 * only caller besides the upgrade gate in the entry point.
 */

import type { Env } from "../index";
import type { AdminActor } from "../audit";
import { writeAudit } from "../audit";
import { assertHuman, runAsAgent } from "../lib/authority";
import {
  AUTONOMY_TOKEN_ID,
  enableAutonomy,
  mintAutonomyGrants,
  readAutonomyStatus,
  revokeAutonomy,
} from "../agent/grants";
import { listGrants } from "../lib/authority";
import { readJsonBoundedResult } from "../lib/body";
import { MAX_BODY_BYTES } from "../lib/config";
import { err } from "../lib/errors";
import {
  ASSISTANT_OBJECT_NAME,
  mintTicket,
  type MintedTicket,
} from "../lib/agent-runtime";
import { AGENT_SCHEMA_VERSION } from "../agent/runtime";
import {
  actorHashFor,
  attachmentKind,
  ATTACHMENT_TTL_MS,
  d1AttachmentStore,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_PER_TURN,
  checkUpload,
  objectKeyFor,
  r2BlobStore,
  safeObjectName,
  turnRefusalStatus,
  type AttachmentRow,
} from "../agent/attachments";

const TICKET_ACTION = "mint agent runtime tickets";
const RUNTIME_READ_ACTION = "read the agent runtime";
const AUTONOMY_READ_ACTION = "read agent autonomy";

export function agentRuntimeEnabled(env: Pick<Env, "AGENT_RUNTIME">): boolean {
  return env.AGENT_RUNTIME === "on";
}

/**
 * `POST /v1/admin/agent/ticket`.
 *
 * A ticket needs the Better Auth session row, not just any write-capable
 * credential: it is bound to that session id, and the upgrade gate redeems it
 * against the session on the socket request. An ADMIN_TOKEN caller has no
 * session, so it is refused here with the reason rather than minting a ticket
 * nothing can redeem.
 */
export async function handleAgentTicketMint(
  _req: Request,
  env: Env,
  actor: AdminActor
): Promise<Response> {
  if (!agentRuntimeEnabled(env)) {
    return Response.json({ error: "agent_runtime_off" }, { status: 503 });
  }
  if (actor.sessionId === undefined || actor.sessionId === "") {
    return Response.json(
      {
        error: "permission",
        message: `${TICKET_ACTION} needs a signed-in human session; ` +
          "an admin token or an agent credential has no session to bind a ticket to",
      },
      { status: 403 }
    );
  }

  const minted: MintedTicket = await mintTicket(env, actor.sessionId, ASSISTANT_OBJECT_NAME);
  return Response.json(minted, { status: 201 });
}

/**
 * `GET /v1/admin/agent/runtime` — `{enabled, schemaVersion, sessions, pinnedName}`.
 *
 * When the runtime is off the Durable Object is never touched: asking it for a
 * status would create the object on a deployment that deliberately has no
 * runtime.
 */
export async function handleAgentRuntimeRead(req: Request, env: Env): Promise<Response> {
  return runAsAgent(
    req,
    env,
    RUNTIME_READ_ACTION,
    async (_actor) => {
      const enabled = agentRuntimeEnabled(env);
      if (!enabled) {
        return Response.json({
          enabled: false,
          schemaVersion: AGENT_SCHEMA_VERSION,
          sessions: 0,
          pinnedName: ASSISTANT_OBJECT_NAME,
        });
      }

      let status: {
        schemaVersion?: number;
        connections?: number;
      } = {};
      try {
        const stub = env.ASSISTANT?.get(env.ASSISTANT.idFromName(ASSISTANT_OBJECT_NAME));
        if (stub !== undefined) {
          const response = await stub.fetch("https://assistant/__runtime/status");
          if (response.ok) status = (await response.json()) as typeof status;
        }
      } catch (error) {
        console.error(`[agent] runtime status unavailable: ${String(error)}`);
      }

      return Response.json({
        enabled,
        schemaVersion:
          typeof status.schemaVersion === "number" ? status.schemaVersion : AGENT_SCHEMA_VERSION,
        sessions: typeof status.connections === "number" ? status.connections : 0,
        pinnedName: ASSISTANT_OBJECT_NAME,
      });
    },
    "read"
  );
}

/* ───────────────────────────── autonomy window ───────────────────────────── */

/** `GET /v1/admin/agent/autonomy` — the window, the caps and today's spend. */
export async function handleAutonomyRead(req: Request, env: Env): Promise<Response> {
  return runAsAgent(
    req,
    env,
    AUTONOMY_READ_ACTION,
    async (actor) => {
      const human = assertHuman(actor);
      if (!human.ok) return human.response;
      const status = await readAutonomyStatus(env);
      const grants = await listGrants(env, { tokenId: AUTONOMY_TOKEN_ID, liveOnly: true });
      return Response.json({
        ...status,
        // Whose window this is. A session that did not open it is refused at act
        // time; the console needs the same fact to say so before anyone tries.
        mine: (status.actor ?? null) === null || status.actor === actor.label,
        grants: grants.map((grant) => ({
          id: grant.id,
          scope: grant.scope,
          target: grant.target,
          expires_at: grant.expires_at,
          use_count: grant.use_count,
        })),
      });
    },
    "read"
  );
}

interface AutonomyBody {
  ttl_s?: number;
  sms_cap?: number;
  write_cap?: number;
  /** The deployment-wide daily SMS ceiling, beside the per-window `sms_cap`. */
  daily_sms_cap?: number;
  recipients?: string[];
  flows?: Array<{ flow_id?: string; graph_hash?: string }>;
  rules?: Array<{ rule_id?: string; body_hash?: string }>;
  sms_max_uses?: number;
  write_max_uses?: number;
  /** Grant rules:write with no target — any rule, bounded by the write cap. */
  allow_rules?: boolean;
  allowRules?: boolean;
}

function readInteger(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.max(min, Math.min(max, numeric));
}

/**
 * `POST /v1/admin/agent/autonomy` — turn autonomy on for a bounded window.
 *
 * The request names the effects: `recipients` for SMS, `flows` with a graph
 * hash, `rules` with a body hash. There is no "all recipients" shorthand,
 * because the grant table would have to interpret it as a wildcard and that is
 * the one thing a grant must never be.
 */
export async function handleAutonomyEnable(
  req: Request,
  env: Env,
  actor: AdminActor
): Promise<Response> {
  const human = assertHuman(actor);
  if (!human.ok) return human.response;

  const parsed = await readJsonBoundedResult(req, MAX_BODY_BYTES);
  if (!parsed.ok) return err(parsed.reason);
  const input = parsed.value as AutonomyBody;

  const ttlS = readInteger(input.ttl_s, 3_600, 60, 3_600);
  const smsCap = readInteger(input.sms_cap, 10, 0, 1_000);
  const writeCap = readInteger(input.write_cap, 50, 0, 1_000);
  const dailySmsCap = readInteger(input.daily_sms_cap, 20, 0, 1_000);

  const recipients = Array.isArray(input.recipients)
    ? input.recipients.filter((entry): entry is string => typeof entry === "string")
    : [];
  const flows: Array<{ flow_id: string; graph_hash?: string }> = Array.isArray(input.flows)
    ? input.flows
        .filter((entry) => entry !== null && typeof entry === "object")
        .map((entry) => ({
          flow_id: typeof entry.flow_id === "string" ? entry.flow_id : "",
          ...(typeof entry.graph_hash === "string" ? { graph_hash: entry.graph_hash } : {}),
        }))
        .filter((entry) => entry.flow_id !== "")
    : [];
  const rules: Array<{ rule_id?: string; body_hash?: string }> = Array.isArray(input.rules)
    ? input.rules
        .filter((entry) => entry !== null && typeof entry === "object")
        .map((entry) => ({
          ...(typeof entry.rule_id === "string" ? { rule_id: entry.rule_id } : {}),
          ...(typeof entry.body_hash === "string" ? { body_hash: entry.body_hash } : {}),
        }))
    : [];

  const row = await enableAutonomy(env, {
    // Bound to the caller: a window is per session, not per deployment.
    actor: actor.label,
    ttl_s: ttlS,
    sms_cap: smsCap,
    write_cap: writeCap,
    daily_sms_cap: dailySmsCap,
    recipients,
    flows,
    rules,
    // The operator's explicit "any rule" consent, which is the only way a rule
    // act can be authorised: its id is minted by the act.
    allow_rules: input.allow_rules === true || input.allowRules === true,
    sms_max_uses:
      input.sms_max_uses === undefined ? undefined : readInteger(input.sms_max_uses, smsCap, 1, 1_000),
    write_max_uses:
      input.write_max_uses === undefined
        ? undefined
        : readInteger(input.write_max_uses, writeCap, 1, 1_000),
    updated_by: actor.label,
  });

  const minted = await mintAutonomyGrants(env, actor, {
    ttl_s: ttlS,
    sms_cap: smsCap,
    write_cap: writeCap,
    recipients,
    flows,
    rules,
    sms_max_uses: input.sms_max_uses,
    write_max_uses: input.write_max_uses,
    allow_rules: input.allow_rules === true || input.allowRules === true,
  });

  await writeAudit(env, {
    action: "agent.autonomy_enabled",
    actor: { userId: actor.userId, label: actor.label },
    subject: "autonomy",
    detail: {
      expires_at: row.expires_at,
        actor: typeof row.actor === "string" ? row.actor : null,
        mine: (typeof row.actor === "string" ? row.actor : null) === actor.label,
      sms_cap: smsCap,
      write_cap: writeCap,
      daily_sms_cap: dailySmsCap,
      grants: minted.grants.map((grant) => ({ id: grant.id, scope: grant.scope })),
    },
  });

  return Response.json(
    {
      enabled: true,
      expires_at: row.expires_at,
      sms_cap: smsCap,
      write_cap: writeCap,
      daily_sms_cap: dailySmsCap,
      grants: minted.grants.map((grant) => ({
        id: grant.id,
        scope: grant.scope,
        target: grant.target,
        expires_at: grant.expires_at,
      })),
      refusals: minted.refusals,
    },
    { status: 201 }
  );
}

/**
 * `DELETE /v1/admin/agent/autonomy` — the kill switch.
 *
 * Revokes the window and every autonomy grant, then tells the pinned object to
 * close its sessions. `AGENT_RUNTIME=off` is the other half: it answers 503
 * before the object is touched.
 */
export async function handleAutonomyRevoke(
  _req: Request,
  env: Env,
  actor: AdminActor
): Promise<Response> {
  const human = assertHuman(actor);
  if (!human.ok) return human.response;

  const revokedGrants = await revokeAutonomy(env, actor.label);

  let closed = 0;
  try {
    const stub = env.ASSISTANT?.get(env.ASSISTANT.idFromName(ASSISTANT_OBJECT_NAME));
    if (stub !== undefined) {
      const response = await stub.fetch("https://assistant/__runtime/kill", { method: "POST" });
      if (response.ok) {
        const body = (await response.json()) as { closed?: number };
        closed = Number(body.closed ?? 0);
      }
    }
  } catch (error) {
    console.error(`[agent] kill switch could not reach the object: ${String(error)}`);
  }

  await writeAudit(env, {
    action: "agent.autonomy_revoked",
    actor: { userId: actor.userId, label: actor.label },
    subject: "autonomy",
    detail: { revoked_grants: revokedGrants, closed },
  });

  return Response.json({ enabled: false, revoked_grants: revokedGrants, sessions_closed: closed });
}

interface SayBody {
  message?: unknown;
  idempotencyKey?: unknown;
  attachmentIds?: unknown;
}

/** 8–64 chars of `[A-Za-z0-9_-]`, or null when the caller supplied one badly. */
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,64}$/;

/** A caller-supplied or empty attachment id list, or null when malformed. */
function readAttachmentIds(value: unknown): string[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  const ids: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry === "") return null;
    ids.push(entry);
  }
  if (ids.length > MAX_ATTACHMENTS_PER_TURN) return null;
  return ids;
}

/**
 * `POST /v1/admin/agent/say` — one non-streaming turn for a machine caller.
 *
 * The console talks over the WebSocket; this exists so the CLI and a harness can
 * exercise the same loop, tools, grants and journal without a browser session.
 * It is admin-only, its action is absent from SCOPE_FOR_ACTION, and it refuses
 * when the runtime is off.
 *
 * `idempotencyKey` (optional, 8–64 chars) makes the turn replayable: the same
 * key returns the recorded answer with `replayed: true` and no second model
 * call. `attachmentIds` (max 3) are resolved by the object, which owns the
 * conversation and the R2 binding.
 */
export async function handleAgentSay(
  req: Request,
  env: Env,
  actor: AdminActor
): Promise<Response> {
  if (!agentRuntimeEnabled(env)) {
    return Response.json({ error: "agent_runtime_off" }, { status: 503 });
  }
  if (env.ASSISTANT === undefined) {
    return Response.json(
      { error: "agent_runtime_off", message: "the ASSISTANT binding is not configured" },
      { status: 503 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad_request", message: "body must be JSON" }, { status: 400 });
  }
  const input = (body !== null && typeof body === "object" ? body : {}) as SayBody;
  const message = typeof input.message === "string" ? input.message.trim() : "";
  if (message === "") {
    return Response.json(
      { error: "bad_request", message: "message must be a non-empty string" },
      { status: 400 }
    );
  }
  if (message.length > 2_000) {
    return Response.json(
      { error: "bad_request", message: "message must be at most 2000 characters" },
      { status: 400 }
    );
  }

  let idempotencyKey: string | undefined;
  if (input.idempotencyKey !== undefined) {
    if (typeof input.idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
      return Response.json(
        {
          error: "bad_request",
          message: "idempotencyKey must be 8-64 characters of A-Z, a-z, 0-9, _ or -",
        },
        { status: 400 }
      );
    }
    idempotencyKey = input.idempotencyKey;
  }

  const attachmentIds = readAttachmentIds(input.attachmentIds);
  if (attachmentIds === null) {
    return Response.json(
      {
        error: "bad_request",
        message: `attachmentIds must be an array of at most ${MAX_ATTACHMENTS_PER_TURN} strings`,
      },
      { status: 400 }
    );
  }

  const stub = env.ASSISTANT.getByName(ASSISTANT_OBJECT_NAME);
  const result = await stub.say(actor, message, {
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    attachmentIds,
  });
  if (!result.ok) {
    return Response.json(
      { error: "agent_refused", reason: result.reason, message: result.message },
      { status: turnRefusalStatus(result.reason) }
    );
  }
  return Response.json(result);
}

/* ──────────────────────────────── conversation ───────────────────────────── */

const CONVERSATION_READ_ACTION = "read the agent conversation";
const CONVERSATION_CLEAR_ACTION = "clear the agent conversation";

/** `GET /v1/admin/agent/conversation?limit=` — the durable transcript. */
export async function handleAgentConversationRead(req: Request, env: Env): Promise<Response> {
  return runAsAgent(
    req,
    env,
    CONVERSATION_READ_ACTION,
    async (actor) => {
      if (!agentRuntimeEnabled(env) || env.ASSISTANT === undefined) {
        return Response.json({ error: "agent_runtime_off" }, { status: 503 });
      }
      const raw = new URL(req.url).searchParams.get("limit");
      const parsed = raw === null ? 40 : Number(raw);
      const limit = Number.isInteger(parsed) ? Math.max(1, Math.min(100, parsed)) : 40;

      const stub = env.ASSISTANT.getByName(ASSISTANT_OBJECT_NAME);
      const result = await stub.readConversation({ label: actor.label }, limit);
      if (!result.ok) {
        return Response.json(
          { error: "agent_refused", reason: result.reason, message: result.message },
          { status: 503 }
        );
      }
      return Response.json({
        conversation: result.conversation,
        messages: result.messages,
        truncated: result.truncated,
      });
    },
    "read"
  );
}

/**
 * `DELETE /v1/admin/agent/conversation` — clear this operator's transcript.
 *
 * Sessions has `clearMessages()` for one session, so the conversation id is
 * stable across a clear: the panel's next turn appends to the same id. The
 * clear is audited because deleting the memory a later turn reasons from is a
 * change to what the agent can say.
 */
export async function handleAgentConversationClear(
  _req: Request,
  env: Env,
  actor: AdminActor
): Promise<Response> {
  if (!agentRuntimeEnabled(env) || env.ASSISTANT === undefined) {
    return Response.json({ error: "agent_runtime_off" }, { status: 503 });
  }
  const stub = env.ASSISTANT.getByName(ASSISTANT_OBJECT_NAME);
  const result = await stub.clearConversation({ label: actor.label });
  if (!result.ok) {
    return Response.json(
      { error: "agent_refused", reason: result.reason, message: result.message },
      { status: 503 }
    );
  }
  await writeAudit(env, {
    action: "agent.conversation_cleared",
    actor: { userId: actor.userId, label: actor.label },
    subject: "agent conversation",
    detail: { conversation: result.conversation },
  });
  return Response.json({
    cleared: true,
    conversation: result.conversation,
  });
}

/* ──────────────────────────────── attachments ────────────────────────────── */

const ATTACHMENT_WRITE_ACTION = "upload agent attachments";
const ATTACHMENT_DELETE_ACTION = "delete agent attachments";
const ATTACHMENT_READ_ACTION = "list agent attachments";

/** Multipart overhead above the file itself (boundary, headers, fields). */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

/**
 * Read a request body into memory without ever exceeding `limit` bytes.
 *
 * `content-length` is only a hint: a chunked upload can omit it and an
 * understated one can lie. The reader is the actual enforcement, and it cancels
 * the stream the moment the next chunk would cross the limit, so a hostile body
 * is never buffered past the cap. Returns `tooLarge` separately from a read
 * error so the caller can answer 413 rather than 400.
 */
async function readBoundedBody(
  req: Request,
  limit: number
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; tooLarge: boolean }> {
  if (req.body === null) return { ok: true, bytes: new Uint8Array(0) };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, tooLarge: true };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, tooLarge: false };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

function attachmentDto(row: AttachmentRow): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    bytes: Number(row.bytes),
    kind: row.kind,
    created_at: new Date(Number(row.created_at)).toISOString(),
    expires_at: new Date(Number(row.expires_at)).toISOString(),
  };
}

/** Is this form entry a file? `File` exists in Workers; keep the check structural. */
function asFile(value: unknown): { name: string; size: number; arrayBuffer(): Promise<ArrayBuffer> } | null {
  if (value === null || typeof value !== "object") return null;
  const candidate = value as { name?: unknown; size?: unknown; arrayBuffer?: unknown };
  if (
    typeof candidate.name !== "string" ||
    typeof candidate.size !== "number" ||
    typeof candidate.arrayBuffer !== "function"
  ) {
    return null;
  }
  return candidate as { name: string; size: number; arrayBuffer(): Promise<ArrayBuffer> };
}

/**
 * `POST /v1/admin/agent/attachments` — one file, multipart/form-data.
 *
 * Bounded at 1 MiB and 3 live attachments per operator. The refusal names the
 * limit it crossed: "too big" without the number is a message an operator has
 * to guess at.
 */
export async function handleAgentAttachmentUpload(
  req: Request,
  env: Env,
  actor: AdminActor
): Promise<Response> {
  if (env.MEDIA_BUCKET === undefined) {
    return Response.json(
      {
        error: "attachments_unavailable",
        message: "MEDIA_BUCKET is not bound, so attachments cannot be stored on this deployment",
      },
      { status: 503 }
    );
  }

  const bodyLimit = MAX_ATTACHMENT_BYTES + MULTIPART_OVERHEAD_BYTES;
  const tooLarge = (): Response =>
    Response.json(
      {
        error: "attachment_too_large",
        message: `a file may be at most ${MAX_ATTACHMENT_BYTES} bytes (1 MiB)`,
      },
      { status: 413 }
    );

  // Fast path: a declared length larger than the file cap plus multipart
  // overhead is refused without reading the stream.
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > bodyLimit) return tooLarge();

  // The real cap: read through a bounded stream, so a chunked or understated
  // upload is refused as soon as it crosses the limit instead of being buffered
  // whole by `formData()` first.
  const bounded = await readBoundedBody(req, bodyLimit);
  if (!bounded.ok) {
    if (bounded.tooLarge) return tooLarge();
    return Response.json(
      {
        error: "bad_request",
        message: "the body must be multipart/form-data with one `file` field",
      },
      { status: 400 }
    );
  }

  const contentType = req.headers.get("content-type");
  const headers = new Headers();
  if (contentType !== null) headers.set("content-type", contentType);

  let form: FormData;
  try {
    form = await new Response(bounded.bytes, { headers }).formData();
  } catch {
    return Response.json(
      {
        error: "bad_request",
        message: "the body must be multipart/form-data with one `file` field",
      },
      { status: 400 }
    );
  }
  const file = asFile(form.get("file"));
  if (file === null) {
    return Response.json(
      { error: "bad_request", message: "the multipart body must contain one `file` field" },
      { status: 400 }
    );
  }

  const now = Date.now();
  const actorHash = await actorHashFor(actor.label);
  const store = d1AttachmentStore(env);
  const refusal = checkUpload({
    name: file.name,
    size: file.size,
    liveCount: await store.count(actorHash, now),
  });
  if (refusal !== null) {
    return Response.json(
      { error: refusal.error, message: refusal.message },
      { status: refusal.status }
    );
  }

  const id = `att_${crypto.randomUUID().replace(/-/g, "")}`;
  const name = safeObjectName(file.name);
  const kind = attachmentKind(file.name);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const key = objectKeyFor(actorHash, id, name);
  const row: AttachmentRow = {
    id,
    actor_hash: actorHash,
    actor: actor.label,
    name,
    kind,
    bytes: bytes.byteLength,
    r2_key: key,
    created_at: now,
    expires_at: now + ATTACHMENT_TTL_MS,
  };

  await r2BlobStore(env.MEDIA_BUCKET).put(key, bytes);
  try {
    await store.insert(row);
  } catch (error) {
    // The row is the index; an orphaned object would bill storage forever.
    await env.MEDIA_BUCKET.delete(key).catch(() => undefined);
    throw error;
  }

  return Response.json(
    {
      id: row.id,
      name: row.name,
      bytes: row.bytes,
      kind: row.kind,
      expires_at: new Date(row.expires_at).toISOString(),
    },
    { status: 201 }
  );
}

/** `GET /v1/admin/agent/attachments` — the caller's live attachments. */
export async function handleAgentAttachmentList(
  req: Request,
  env: Env
): Promise<Response> {
  return runAsAgent(
    req,
    env,
    ATTACHMENT_READ_ACTION,
    async (actor) => {
      if (env.MEDIA_BUCKET === undefined) {
        return Response.json({ attachments: [] });
      }
      const actorHash = await actorHashFor(actor.label);
      const rows = await d1AttachmentStore(env).list(actorHash, Date.now());
      return Response.json({ attachments: rows.map(attachmentDto) });
    },
    "read"
  );
}

/** `DELETE /v1/admin/agent/attachments/:id` — remove the object and the row. */
export async function handleAgentAttachmentDelete(
  _req: Request,
  env: Env,
  actor: AdminActor,
  id: string
): Promise<Response> {
  if (env.MEDIA_BUCKET === undefined) {
    return Response.json({ error: "attachments_unavailable" }, { status: 503 });
  }
  const actorHash = await actorHashFor(actor.label);
  const store = d1AttachmentStore(env);
  const row = await store.find(actorHash, id);
  if (row === null) {
    return Response.json(
      { error: "not_found", message: `no attachment ${id} belongs to this operator` },
      { status: 404 }
    );
  }
  // Object first: a failed delete leaves the row so the caller can retry, and a
  // retried delete of a missing object is harmless.
  await env.MEDIA_BUCKET.delete(row.r2_key);
  await store.remove(actorHash, id);
  return Response.json({ deleted: true, id });
}
