/**
 * Agent attachments — the durable files an operator hands the runtime.
 *
 * The bytes live in R2 (`MEDIA_BUCKET`), the metadata in D1, and the prompt
 * carries only what the model can actually read. Three rules shape the module:
 *
 *   1. Text files are read into the turn's USER message, never the system
 *      prompt. A file is operator input, and operator input must not become
 *      instructions the server appears to have written.
 *   2. Images and other binaries are named in the prompt and explicitly marked
 *      unreadable. The model is told it cannot see them so it does not describe
 *      a screenshot it never received.
 *   3. Expiry is a refusal, not a silent drop. An attachment older than 24 h is
 *      named in a 400 rather than quietly disappearing from a turn the operator
 *      believes included it.
 *
 * The store and blob seams are injected so `__checks__/agent-attachments.mjs`
 * exercises this policy (caps, truncation, expiry, prompt shape) without R2 or
 * D1, and the route/object wire the real adapters below.
 */

import type { Env } from "../index";

/** Hard cap on one uploaded file. */
export const MAX_ATTACHMENT_BYTES = 1_048_576;

/** How many live attachments one operator may keep at a time. */
export const MAX_ATTACHMENTS_PER_OPERATOR = 3;

/** How many a single turn may name. */
export const MAX_ATTACHMENTS_PER_TURN = 3;

/** An attachment stops being attachable after this long. */
export const ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1_000;

/**
 * How much file text one turn may carry.
 *
 * Counted over the file bodies; the `--- file:` headers are a few bytes each
 * and capped at three, so the block is bounded at 64 KiB + 200 bytes.
 */
export const TEXT_PROMPT_BUDGET_BYTES = 64 * 1024;

/**
 * The first line of the attachment block inside a stored user message.
 *
 * The block stays in the stored turn — a later turn's prompt needs the file
 * text — but the panel read must not serve it again. `conversation.ts` keys the
 * strip on this exact header and on the message metadata written beside it.
 */
export const ATTACHMENT_BLOCK_HEADER = "Attached files from the operator:";

/** Extensions read into the prompt. Anything else is named, not sent. */
const TEXT_EXTENSIONS: ReadonlySet<string> = new Set([
  "txt",
  "md",
  "json",
  "csv",
  "log",
  "yaml",
  "yml",
  "eml",
]);

/** Extensions treated as an image the model still cannot see. */
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

export type AttachmentKind = "text" | "image" | "other";

export interface AttachmentRow {
  id: string;
  actor_hash: string;
  actor: string;
  name: string;
  kind: AttachmentKind;
  bytes: number;
  r2_key: string;
  created_at: number;
  expires_at: number;
}

/** The metadata seam. Real implementation is D1; the check uses a Map. */
export interface AttachmentStore {
  insert(row: AttachmentRow): Promise<void>;
  list(actorHash: string, now: number): Promise<AttachmentRow[]>;
  find(actorHash: string, id: string): Promise<AttachmentRow | null>;
  remove(actorHash: string, id: string): Promise<void>;
  count(actorHash: string, now: number): Promise<number>;
  /** Expired rows, oldest first, bounded by `limit`. Used only by the sweep. */
  listExpired(now: number, limit: number): Promise<Array<Pick<AttachmentRow, "id" | "r2_key">>>;
  /** Remove one row by id, across all actors. Used only by the sweep. */
  removeById(id: string): Promise<void>;
}

/** The byte seam. Real implementation is R2; the check uses a Map. */
export interface BlobStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  getText(key: string): Promise<string | null>;
  delete(key: string): Promise<void>;
}

export interface AttachmentDeps {
  store: AttachmentStore;
  blobs: BlobStore;
}

/** The file text or name one turn will hand the model. */
export interface PromptFile {
  id: string;
  name: string;
  kind: AttachmentKind;
  bytes: number;
  /** Present for text files only. */
  text?: string;
}

export type ResolveResult =
  | { ok: true; files: PromptFile[]; block: string }
  | { ok: false; reason: "unknown_attachment" | "attachment_expired" | "too_many"; message: string };

/** Lower-case extension without the dot, or "" for a name with none. */
export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

/** Classify by extension first, then by declared MIME type. */
export function attachmentKind(name: string, mimeType?: string): AttachmentKind {
  const extension = extensionOf(name);
  if (TEXT_EXTENSIONS.has(extension)) return "text";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  const mime = (mimeType ?? "").toLowerCase();
  if (mime.startsWith("text/")) return "text";
  if (mime.startsWith("image/")) return "image";
  if (mime === "application/json" || mime === "application/x-yaml" || mime === "message/rfc822") {
    return "text";
  }
  return "other";
}

/**
 * A safe R2 key segment: no slashes, no traversal, a bounded length.
 *
 * The name is display metadata too, so a name that is only separators falls back
 * to "file" rather than producing an empty key segment.
 */
export function safeObjectName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "").slice(0, 120);
  return cleaned === "" ? "file" : cleaned;
}

/** `agent/<actor-hash>/<id>/<name>` — the key the brief specifies. */
export function objectKeyFor(actorHash: string, id: string, name: string): string {
  return `agent/${actorHash}/${id}/${safeObjectName(name)}`;
}

/** Hex SHA-256, used for the per-operator bucket prefix. */
export async function actorHashFor(label: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(label));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 32);
}

/** Truncate a string to at most `maxBytes` of UTF-8 without splitting a char. */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const encoded = new TextEncoder().encode(text);
  if (encoded.byteLength <= maxBytes) return { text, truncated: false };
  // TextDecoder replaces an incomplete trailing sequence, so the result is
  // always valid text and never longer than the budget in bytes.
  const slice = encoded.slice(0, Math.max(0, maxBytes));
  return { text: new TextDecoder().decode(slice), truncated: true };
}

/**
 * The prompt block for a set of files.
 *
 * Text is quoted under a header that names the file; every non-text file is
 * named with the sentence the model must not contradict ("the model cannot see
 * this file"). The 64 KiB budget is spent in the order the attachments were
 * listed, so the first attachment is complete before the second gets a byte.
 */
export function attachmentPromptBlock(files: PromptFile[]): string {
  if (files.length === 0) return "";
  const lines: string[] = [ATTACHMENT_BLOCK_HEADER];
  let remaining = TEXT_PROMPT_BUDGET_BYTES;
  for (const file of files) {
    if (file.kind !== "text") {
      lines.push(
        `--- file: ${file.name} (${file.kind}, ${file.bytes} bytes) — ` +
          "the model cannot see this file; do not claim to have read or described it ---"
      );
      continue;
    }
    const raw = file.text ?? "";
    const budgeted = truncateUtf8(raw, remaining);
    const body = budgeted.text;
    remaining = Math.max(0, remaining - new TextEncoder().encode(body).byteLength);
    lines.push(`--- file: ${file.name} (text, ${file.bytes} bytes) ---`);
    lines.push(body);
    if (budgeted.truncated) {
      const shown = new TextEncoder().encode(body).byteLength;
      lines.push(`[truncated: showing ${shown} of ${raw.length} characters]`);
    }
  }
  return lines.join("\n");
}

/**
 * Resolve caller-supplied ids into prompt files.
 *
 * Order is the caller's; a duplicate id is not a second file. Unknown and
 * expired ids refuse the turn by name: the operator asked for a file the model
 * did not get, and pretending otherwise is the failure this exists to prevent.
 */
export async function resolveAttachments(
  ids: string[],
  actorHash: string,
  deps: AttachmentDeps,
  now: number = Date.now()
): Promise<ResolveResult> {
  const unique = [...new Set(ids.filter((id) => typeof id === "string" && id !== ""))];
  if (unique.length > MAX_ATTACHMENTS_PER_TURN) {
    return {
      ok: false,
      reason: "too_many",
      message: `at most ${MAX_ATTACHMENTS_PER_TURN} attachments may be named in one turn`,
    };
  }

  const files: PromptFile[] = [];
  for (const id of unique) {
    const row = await deps.store.find(actorHash, id);
    if (row === null) {
      return {
        ok: false,
        reason: "unknown_attachment",
        message: `no attachment ${id} belongs to this operator`,
      };
    }
    if (Number(row.expires_at) <= now) {
      return {
        ok: false,
        reason: "attachment_expired",
        message:
          `attachment ${id} (${row.name}) expired at ` +
          `${new Date(Number(row.expires_at)).toISOString()}; ` +
          `attachments are kept for ${ATTACHMENT_TTL_MS / 3_600_000} hours, so it was not attached`,
      };
    }

    if (row.kind === "text") {
      const text = await deps.blobs.getText(row.r2_key);
      if (text === null) {
        return {
          ok: false,
          reason: "unknown_attachment",
          message: `attachment ${id} (${row.name}) has no stored bytes`,
        };
      }
      files.push({ id, name: row.name, kind: row.kind, bytes: Number(row.bytes), text });
    } else {
      files.push({ id, name: row.name, kind: row.kind, bytes: Number(row.bytes) });
    }
  }

  return { ok: true, files, block: attachmentPromptBlock(files) };
}

/** The user message for a turn: the operator's words, then what was attached. */
export function messageWithAttachments(message: string, block: string): string {
  return block === "" ? message : `${message}\n\n${block}`;
}

/** A refusal the upload route can return as-is. */
export interface UploadRefusal {
  status: number;
  error: string;
  message: string;
}

/**
 * The upload limits, in one place so the route and the check cannot drift.
 *
 * `liveCount` is the operator's unexpired attachment count BEFORE this upload,
 * so the cap is "at most 3 kept", not "3 then a fourth".
 */
export function checkUpload(input: {
  name: string;
  size: number;
  liveCount: number;
}): UploadRefusal | null {
  if (input.size > MAX_ATTACHMENT_BYTES) {
    return {
      status: 413,
      error: "attachment_too_large",
      message:
        `${input.name} is ${input.size} bytes; ` +
        `a file may be at most ${MAX_ATTACHMENT_BYTES} bytes (1 MiB)`,
    };
  }
  if (input.liveCount >= MAX_ATTACHMENTS_PER_OPERATOR) {
    return {
      status: 409,
      error: "attachment_limit",
      message:
        `at most ${MAX_ATTACHMENTS_PER_OPERATOR} attachments are kept per operator; ` +
        "delete one before uploading another",
    };
  }
  return null;
}

/** The HTTP status for a refused turn. Bad input is 400; our failure is 503. */
export function turnRefusalStatus(reason: string): number {
  // A key reused for different text, or one still running, is a conflict with
  // an existing turn — not a malformed request and not our failure.
  if (reason === "idempotency_conflict" || reason === "turn_in_progress") return 409;
  return reason === "bad_request" ||
    reason === "bad_attachment" ||
    reason === "unknown_attachment" ||
    reason === "attachment_expired" ||
    reason === "too_many"
    ? 400
    : 503;
}

/* ───────────────────────────── real adapters ─────────────────────────── */

/** D1-backed metadata store. `agent_attachments` is migration 0016. */
export function d1AttachmentStore(env: Pick<Env, "DB">): AttachmentStore {
  return {
    async insert(row) {
      await env.DB.prepare(
        `INSERT INTO agent_attachments
           (id, actor_hash, actor, name, kind, bytes, r2_key, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          row.id,
          row.actor_hash,
          row.actor,
          row.name,
          row.kind,
          row.bytes,
          row.r2_key,
          row.created_at,
          row.expires_at
        )
        .run();
    },
    async list(actorHash, now) {
      const result = await env.DB.prepare(
        `SELECT id, actor_hash, actor, name, kind, bytes, r2_key, created_at, expires_at
           FROM agent_attachments
          WHERE actor_hash = ? AND expires_at > ?
          ORDER BY created_at ASC`
      )
        .bind(actorHash, now)
        .all<AttachmentRow>();
      return (result.results ?? []).map((row) => ({
        ...row,
        kind: row.kind as AttachmentKind,
        bytes: Number(row.bytes),
        created_at: Number(row.created_at),
        expires_at: Number(row.expires_at),
      }));
    },
    async find(actorHash, id) {
      const row = await env.DB.prepare(
        `SELECT id, actor_hash, actor, name, kind, bytes, r2_key, created_at, expires_at
           FROM agent_attachments
          WHERE actor_hash = ? AND id = ?`
      )
        .bind(actorHash, id)
        .first<AttachmentRow>();
      return row === null || row === undefined
        ? null
        : {
            ...row,
            kind: row.kind as AttachmentKind,
            bytes: Number(row.bytes),
            created_at: Number(row.created_at),
            expires_at: Number(row.expires_at),
          };
    },
    async remove(actorHash, id) {
      await env.DB.prepare(`DELETE FROM agent_attachments WHERE actor_hash = ? AND id = ?`)
        .bind(actorHash, id)
        .run();
    },
    async count(actorHash, now) {
      const row = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM agent_attachments WHERE actor_hash = ? AND expires_at > ?`
      )
        .bind(actorHash, now)
        .first<{ n: number }>();
      return Number(row?.n ?? 0);
    },
    async listExpired(now, limit) {
      const result = await env.DB.prepare(
        `SELECT id, r2_key FROM agent_attachments
          WHERE expires_at <= ?
          ORDER BY expires_at ASC
          LIMIT ?`
      )
        .bind(now, limit)
        .all<{ id: string; r2_key: string }>();
      return result.results ?? [];
    },
    async removeById(id) {
      await env.DB.prepare(`DELETE FROM agent_attachments WHERE id = ?`).bind(id).run();
    },
  };
}

/**
 * Reclaim expired attachments, in bounded batches.
 *
 * The 24 h TTL used to be a refusal only: the row and its R2 object stayed
 * forever. This deletes both, oldest first, and stops after `maxBatches` so one
 * scheduled run cannot spend an unbounded budget on a backlog. A failed object
 * delete leaves its row for the next run rather than orphaning the object.
 */
export async function purgeExpiredAttachments(
  deps: AttachmentDeps,
  now: number = Date.now(),
  options: { batchSize?: number; maxBatches?: number } = {}
): Promise<{ deleted: number }> {
  const batchSize = Math.max(1, Math.min(500, Math.trunc(options.batchSize ?? 100)));
  const maxBatches = Math.max(1, Math.min(100, Math.trunc(options.maxBatches ?? 10)));
  let deleted = 0;

  for (let batch = 0; batch < maxBatches; batch++) {
    const rows = await deps.store.listExpired(now, batchSize);
    if (rows.length === 0) break;
    for (const row of rows) {
      try {
        await deps.blobs.delete(row.r2_key);
      } catch {
        // Leave the row so a later run can retry the object delete.
        continue;
      }
      await deps.store.removeById(row.id);
      deleted += 1;
    }
    if (rows.length < batchSize) break;
  }

  return { deleted };
}

/** R2-backed byte store. */
export function r2BlobStore(bucket: Pick<R2Bucket, "put" | "get" | "delete">): BlobStore {
  return {
    async put(key, bytes) {
      await bucket.put(key, bytes);
    },
    async getText(key) {
      const object = await bucket.get(key);
      if (object === null) return null;
      return await object.text();
    },
    async delete(key) {
      await bucket.delete(key);
    },
  };
}
