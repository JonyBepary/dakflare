/**
 * The password construction — AUTH_PLAN §2, one implementation for both modes.
 *
 *   material = PBKDF2-SHA256(password, salt, iterations)     browser (m=c) or Worker (m=s)
 *   stored   = SHA-256(HMAC-SHA256(pepper_v, salt ‖ material))
 *   row      = v1$p=<v>$k=<iterations>$m=<c|s>$<salt-b64>$<sha256-b64>
 *
 * The pepper is ALWAYS applied after the inner KDF. That is what makes the
 * value identical whoever ran PBKDF2, so an account created in `client-derived`
 * mode keeps working after an upgrade to `server-kdf` with no re-hash. Applying
 * the pepper before the KDF in one mode would break that; it must not happen.
 *
 * `m=` records who ran the inner KDF. It is provenance, not a second hash: both
 * modes verify through `verifyMaterial`, which compares the same digest.
 */

import { b64decode, b64encode, timingSafeEqual } from "./base64";
import {
  outerInput,
  pepperFor,
  pepperHmac,
  type PepperRing,
} from "./pepper";

/** AUTH_PLAN §2's count. Verified against workerd with no iteration cap. */
export const PASSWORD_ITERATIONS = 210_000;

/**
 * Bounds for a client-supplied `k`. A client may not ask the Worker (or a later
 * client) to run a weaker KDF than the contract's floor. The ceiling keeps a
 * hostile client from making future server-mode sign-ins cost seconds.
 */
export const CLIENT_MIN_ITERATIONS = 100_000;
export const CLIENT_MAX_ITERATIONS = 1_000_000;

export const SALT_BYTES = 16;
export const MATERIAL_BYTES = 32;

/** Same bounds Better Auth defaults to; used only when the Worker sees plaintext. */
export const PASSWORD_MIN_CHARS = 8;
export const PASSWORD_MAX_CHARS = 128;

const ROW_MAGIC = "v1";
const ROW_KEYS = ["p", "k", "m"] as const;

export type PasswordModeTag = "c" | "s";

export interface PasswordRow {
  version: number;
  iterations: number;
  mode: PasswordModeTag;
  salt: Uint8Array;
  digest: Uint8Array;
  /** The exact stored string, for a compare-and-swap write-back. */
  raw: string;
}

/** Render the one row shape both modes write. */
export function formatPasswordRow(args: {
  version: number;
  iterations: number;
  mode: PasswordModeTag;
  salt: Uint8Array;
  digest: Uint8Array;
}): string {
  return [
    ROW_MAGIC,
    `p=${args.version}`,
    `k=${args.iterations}`,
    `m=${args.mode}`,
    b64encode(args.salt),
    b64encode(args.digest),
  ].join("$");
}

/**
 * Parse a stored row strictly.
 *
 * Anything unexpected returns `null`; a malformed row is a failed verification,
 * never a reason to run a KDF or to fall back to a different scheme.
 */
export function parsePasswordRow(raw: unknown): PasswordRow | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 512) return null;
  const parts = raw.split("$");
  if (parts.length !== 6) return null;
  if (parts[0] !== ROW_MAGIC) return null;

  const fields = new Map<string, string>();
  for (let i = 0; i < ROW_KEYS.length; i++) {
    const prefix = `${ROW_KEYS[i]}=`;
    const part = parts[i + 1];
    if (!part.startsWith(prefix)) return null;
    fields.set(ROW_KEYS[i], part.slice(prefix.length));
  }

  const version = Number(fields.get("p"));
  if (!Number.isSafeInteger(version) || version < 1) return null;

  const iterations = Number(fields.get("k"));
  if (
    !Number.isSafeInteger(iterations) ||
    iterations < CLIENT_MIN_ITERATIONS ||
    iterations > CLIENT_MAX_ITERATIONS
  ) {
    return null;
  }

  const mode = fields.get("m");
  if (mode !== "c" && mode !== "s") return null;

  const salt = b64decode(parts[4], 64);
  if (salt === null || salt.length !== SALT_BYTES) return null;
  const digest = b64decode(parts[5], 64);
  if (digest === null || digest.length !== MATERIAL_BYTES) return null;

  return { version, iterations, mode, salt, digest, raw };
}

/** PBKDF2-SHA256(password, salt, iterations) → 32 bytes. The only KDF. */
export async function deriveMaterial(
  password: string,
  salt: Uint8Array,
  iterations: number
): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    base,
    MATERIAL_BYTES * 8
  );
  return new Uint8Array(bits);
}

/** SHA-256(HMAC-SHA256(pepper_v, salt ‖ material)). The outer layer. */
export async function outerDigest(
  ring: PepperRing,
  version: number,
  salt: Uint8Array,
  material: Uint8Array
): Promise<Uint8Array | null> {
  const entry = pepperFor(ring, version);
  if (entry === null) return null;
  const peppered = await pepperHmac(ring, entry, outerInput(salt, material));
  return new Uint8Array(await crypto.subtle.digest("SHA-256", peppered));
}

/**
 * Build a row from material. Both the client and the Worker end up here; the
 * only difference is the `m` tag the caller passes.
 */
export async function buildPasswordRow(args: {
  ring: PepperRing;
  salt: Uint8Array;
  material: Uint8Array;
  iterations: number;
  mode: PasswordModeTag;
}): Promise<string | null> {
  const digest = await outerDigest(args.ring, args.ring.active.version, args.salt, args.material);
  if (digest === null) return null;
  return formatPasswordRow({
    version: args.ring.active.version,
    iterations: args.iterations,
    mode: args.mode,
    salt: args.salt,
    digest,
  });
}

export interface VerifyResult {
  ok: boolean;
  /** 32 zero bytes when the row would not verify; HMAC+SHA always ran. */
  reason: "ok" | "mismatch" | "malformed" | "pepper_missing";
  /** The digest computed with the row's own pepper version, if it existed. */
  digest?: Uint8Array;
}

/** Constant-ish: HMAC + SHA over the same lengths whether the digest matches or not. */
export async function verifyMaterial(
  row: PasswordRow,
  material: Uint8Array,
  ring: PepperRing
): Promise<VerifyResult> {
  if (material.length !== MATERIAL_BYTES) return { ok: false, reason: "malformed" };
  const digest = await outerDigest(ring, row.version, row.salt, material);
  if (digest === null) return { ok: false, reason: "pepper_missing" };
  const ok = timingSafeEqual(digest, row.digest);
  return { ok, reason: ok ? "ok" : "mismatch", digest };
}

/**
 * Verify a plaintext password against a row. This ALWAYS runs PBKDF2 — it is
 * reachable only where Better Auth itself hands us plaintext (its TOTP
 * management endpoints). Our own sign-in never calls it in `client-derived`
 * mode, which is what keeps that mode inside the free CPU budget.
 */
export async function verifyPlaintext(
  row: PasswordRow,
  password: string,
  ring: PepperRing
): Promise<boolean> {
  const material = await deriveMaterial(password, row.salt, row.iterations);
  const result = await verifyMaterial(row, material, ring);
  return result.ok;
}

/** A fresh 16-byte salt for a server-mode set. */
export function randomSalt(): Uint8Array {
  const salt = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(salt);
  return salt;
}

/**
 * HMAC-SHA256(active_pepper, "salt-v1:" ‖ lowercase(email))[0..16].
 *
 * Deterministic on purpose: a fresh random salt on a miss would make
 * `POST /v1/auth/salt` a user oracle. An unknown address and a known address
 * return the same shape, and the value is stable across retries.
 */
export async function fakeSalt(ring: PepperRing, email: string): Promise<Uint8Array> {
  const peppered = await pepperHmac(
    ring,
    ring.active,
    new TextEncoder().encode(`salt-v1:${email.toLowerCase()}`)
  );
  return peppered.slice(0, SALT_BYTES);
}

/**
 * The sign-in/deletion shape: just the 32-byte material. Salt and iteration
 * count come from the stored row, so a client cannot substitute them here.
 */
export function parseMaterial(value: Record<string, unknown>): Uint8Array | null {
  const material = b64decode(value.material, 64);
  if (material === null || material.length !== MATERIAL_BYTES) return null;
  return material;
}

/** Validate a client-supplied `{material, salt, iterations}` triple. */
export function parseClientMaterial(value: Record<string, unknown>): {
  material: Uint8Array;
  salt: Uint8Array;
  iterations: number;
} | null {
  const material = parseMaterial(value);
  if (material === null) return null;
  const salt = b64decode(value.salt, 64);
  if (salt === null || salt.length !== SALT_BYTES) return null;
  const iterations = Number(value.iterations);
  if (
    !Number.isSafeInteger(iterations) ||
    iterations < CLIENT_MIN_ITERATIONS ||
    iterations > CLIENT_MAX_ITERATIONS
  ) {
    return null;
  }
  return { material, salt, iterations };
}

/** Plaintext bounds, applied only where the Worker actually sees a password. */
export function plausiblePassword(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length < PASSWORD_MIN_CHARS || value.length > PASSWORD_MAX_CHARS) return null;
  if (new TextEncoder().encode(value).length > 1024) return null;
  return value;
}
