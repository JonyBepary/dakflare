/**
 * Signed `ag1_` apply handles.
 *
 * A handle is not a credential: it names a target the approval route spends. It
 * still must not be forgeable, because a caller that can edit the JSON can turn
 * "this one flow, this one hash" into a different target — and `max_uses` would
 * mean whatever an attacker typed.
 *
 * The signature is HMAC-SHA256 over `canonicalTargetJson`, with a key derived
 * from a Worker-held secret using the same domain-separation shape as the
 * webhook seal (`routes/webhooks.ts`): the material is hashed with a
 * version-prefixed label before use, so the same secret can key more than one
 * purpose without the purposes being interchangeable. The key is
 * `WEBHOOK_SECRET_KEY`; absence fails closed, exactly as sealing does.
 *
 * The payload keeps the documented `ag1_<base64url(json)>` shape, with `sig`
 * and `handle_id` as extra members of that JSON. That is load-bearing for
 * compatibility: `dakflare flow apply` decodes the handle with plain base64url
 * and ignores members it does not know, so a signed handle remains readable by
 * a CLI that predates this file.
 */

import type { Env } from "../index";
import { canonicalTargetJson, type GrantTarget } from "./authority";

export const APPLY_HANDLE_PREFIX = "ag1_";

/** The target a handle must carry; `sig` is the signature, never part of it. */
export interface ApplyHandleTarget extends GrantTarget {
  handle_id: string;
  max_uses: number;
}

export type ApplyHandleProblem = {
  ok: false;
  /** Stable code a caller can branch on, never prose matching. */
  code: "invalid_apply_token" | "apply_handle_unavailable";
  message: string;
};

export type ApplyHandleResult =
  | { ok: true; token: string; target: ApplyHandleTarget; signature: string }
  | ApplyHandleProblem;

const encoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

function fromHex(value: string): Uint8Array | null {
  if (value.length % 2 !== 0 || !/^[0-9a-f]*$/.test(value)) return null;
  const out = new Uint8Array(value.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    const out = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
    return out;
  } catch {
    return null;
  }
}

/**
 * Constant-time comparison over two hex strings.
 *
 * Length is folded into the accumulator and the loop runs over the longer of
 * the two, so a truncated signature costs the same as a wrong full-length one.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let index = 0; index < length; index += 1) {
    diff |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return diff === 0;
}

const HANDLE_KEYS = new Map<string, Promise<CryptoKey>>();

function handleKey(env: Env): Promise<CryptoKey> | null {
  const material = env.WEBHOOK_SECRET_KEY?.trim() || "";
  if (material === "") return null;
  const cached = HANDLE_KEYS.get(material);
  if (cached !== undefined) return cached;
  if (HANDLE_KEYS.size >= 32) HANDLE_KEYS.clear();
  const derived = crypto.subtle
    .digest("SHA-256", encoder.encode(`dakflare-apply-handle-v1\0${material}`))
    .then((digest) =>
      crypto.subtle.importKey("raw", digest, { name: "HMAC", hash: "SHA-256" }, false, [
        "sign",
        "verify",
      ])
    );
  HANDLE_KEYS.set(material, derived);
  return derived;
}

/** The bytes a handle signs: the canonical target, with `handle_id` included. */
function signedBytes(target: ApplyHandleTarget): Uint8Array {
  return encoder.encode(canonicalTargetJson(target));
}

async function sign(env: Env, target: ApplyHandleTarget): Promise<string | null> {
  const key = handleKey(env);
  if (key === null) return null;
  const signature = await crypto.subtle.sign("HMAC", await key, signedBytes(target));
  return toHex(new Uint8Array(signature));
}

function randomHandleId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

/**
 * Mint a signed handle for a target.
 *
 * `handle_id` is minted here rather than accepted from the caller: it is what
 * the approval request and the later use count are keyed by, so a caller that
 * chose it could collide with somebody else's spend.
 */
export async function mintApplyHandle(
  env: Env,
  target: GrantTarget,
  options: { handleId?: string } = {}
): Promise<ApplyHandleResult> {
  const handleId = options.handleId ?? randomHandleId();
  const maximal: ApplyHandleTarget = {
    ...target,
    handle_id: handleId,
    max_uses:
      typeof target.max_uses === "number" && Number.isInteger(target.max_uses) && target.max_uses > 0
        ? target.max_uses
        : 1,
  };
  const signature = await sign(env, maximal);
  if (signature === null) {
    return {
      ok: false,
      code: "apply_handle_unavailable",
      message:
        "WEBHOOK_SECRET_KEY is not set, so the Worker cannot sign an apply handle; nothing was minted",
    };
  }
  const payload = JSON.stringify({ ...JSON.parse(canonicalTargetJson(maximal)), sig: signature });
  return {
    ok: true,
    token: `${APPLY_HANDLE_PREFIX}${base64Url(encoder.encode(payload))}`,
    target: maximal,
    signature,
  };
}

/**
 * Verify a presented handle.
 *
 * Every failure is the same named refusal, so a caller learns that the handle
 * was not accepted without learning which byte was wrong. A tampered
 * `max_uses`, `body_hash`, `flow_id` or `handle_id` all land here.
 */
export async function verifyApplyHandle(
  env: Env,
  raw: string
): Promise<{ ok: true; target: ApplyHandleTarget } | ApplyHandleProblem> {
  const token = String(raw ?? "").trim();
  const refusal = (message: string): ApplyHandleProblem => ({
    ok: false,
    code: "invalid_apply_token",
    message,
  });

  if (!token.startsWith(APPLY_HANDLE_PREFIX)) {
    return refusal("not an apply handle: expected ag1_<base64url>");
  }
  const bytes = fromBase64Url(token.slice(APPLY_HANDLE_PREFIX.length));
  if (bytes === null) return refusal("the apply handle is not base64url");

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return refusal("the apply handle does not decode to a target document");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return refusal("the apply handle does not name a target");
  }
  const row = parsed as Record<string, unknown>;
  const signature = row.sig;
  if (typeof signature !== "string" || signature === "") {
    return refusal("the apply handle carries no signature");
  }

  const target: ApplyHandleTarget = {
    flow_id: typeof row.flow_id === "string" && row.flow_id !== "" ? row.flow_id : undefined,
    handle_id: typeof row.handle_id === "string" && row.handle_id !== "" ? row.handle_id : "",
    max_uses:
      typeof row.max_uses === "number" && Number.isInteger(row.max_uses) && row.max_uses > 0
        ? row.max_uses
        : 0,
    ...(typeof row.body_hash === "string" && row.body_hash !== ""
      ? { body_hash: row.body_hash }
      : {}),
    ...(typeof row.device_id === "string" && row.device_id !== ""
      ? { device_id: row.device_id }
      : {}),
    ...(typeof row.rule_id === "string" && row.rule_id !== "" ? { rule_id: row.rule_id } : {}),
    ...(Array.isArray(row.recipients)
      ? {
          recipients: row.recipients.filter(
            (entry): entry is string => typeof entry === "string" && entry !== ""
          ),
        }
      : {}),
  };
  if (target.flow_id === undefined) return refusal("the apply handle does not name a flow");
  if (target.handle_id === "") return refusal("the apply handle carries no handle id");
  if (target.max_uses === 0) return refusal("the apply handle carries no max_uses");

  const key = handleKey(env);
  if (key === null) {
    return {
      ok: false,
      code: "apply_handle_unavailable",
      message:
        "WEBHOOK_SECRET_KEY is not set, so the Worker cannot verify an apply handle; nothing was spent",
    };
  }

  const expected = fromHex(signature);
  if (expected === null) return refusal("the apply handle signature is malformed");

  const valid = await crypto.subtle.verify("HMAC", await key, expected, signedBytes(target));
  if (!valid) {
    return refusal("the apply handle signature does not verify; the handle was not accepted");
  }
  return { ok: true, target };
}
