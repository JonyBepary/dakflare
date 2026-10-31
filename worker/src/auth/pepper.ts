/**
 * The pepper ring — AUTH_PLAN §2 and §8.
 *
 * `AUTH_PEPPER` is one Worker Encrypted Secret holding every pepper that must
 * still verify: `v2:<base64 32 bytes>,v1:<base64 32 bytes>`. The FIRST entry is
 * active and signs new hashes; every entry verifies. Rotation is "prepend a
 * version": deploy the new ring, let old rows verify against their own `p=`
 * until they are re-wrapped at sign-in, then drop the oldest entry.
 *
 * Deliberate failure mode: a missing or malformed secret is a 503 that NAMES the
 * secret, never a silent fallback to an unpeppered hash. Falling back would
 * write rows that no correct deployment can verify, which is worse than an
 * outage you can see.
 */

import type { Env } from "../index";
import { b64decode, b64encode, concatBytes } from "./base64";

export interface PepperEntry {
  version: number;
  key: Uint8Array;
}

export interface PepperRing {
  /** The secret exactly as configured, normalized (used by the rotate endpoint). */
  raw: string;
  /** The first entry: signs new hashes, seals new fake salts. */
  active: PepperEntry;
  byVersion: Map<number, PepperEntry>;
  /** Imported HMAC keys, one per version. Cached per ring, never per request. */
  hmacKeys: Map<number, Promise<CryptoKey>>;
}

export type PepperLoad =
  | { ok: true; ring: PepperRing }
  | { ok: false; response: Response };

/** Eight is already generous for a rotation window; more is a typo or an attack. */
const MAX_VERSIONS = 8;

/** A sentence an operator can act on, without echoing the secret value. */
function pepperUnavailable(reason: string): Response {
  return Response.json(
    {
      error: "auth_unavailable",
      message: `AUTH_PEPPER is ${reason}; expected "v2:<base64 of 32 bytes>,v1:<base64 of 32 bytes>" as a Worker secret.`,
    },
    { status: 503, headers: { "Cache-Control": "no-store" } }
  );
}

function parseRing(raw: unknown): PepperRing | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const parts = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  if (parts.length === 0 || parts.length > MAX_VERSIONS) return null;

  const byVersion = new Map<number, PepperEntry>();
  const normalized: string[] = [];
  for (const part of parts) {
    const match = /^v([1-9][0-9]{0,8}):([A-Za-z0-9+/=]{40,64})$/.exec(part);
    if (match === null) return null;
    const version = Number(match[1]);
    if (!Number.isSafeInteger(version) || byVersion.has(version)) return null;
    const key = b64decode(match[2], 64);
    if (key === null || key.length !== 32) return null;
    byVersion.set(version, { version, key });
    normalized.push(`v${version}:${b64encode(key)}`);
  }

  const active = byVersion.get(Number(/^v([1-9][0-9]{0,8}):/.exec(parts[0])?.[1] ?? 0));
  if (active === undefined) return null;

  return {
    raw: normalized.join(","),
    active,
    byVersion,
    hmacKeys: new Map(),
  };
}

/**
 * Per-isolate cache. The key is the secret string itself, so rotating the
 * secret can never reuse a stale parse, and a request parses at most once.
 */
let cached: { raw: string; ring: PepperRing } | null = null;

/** Parse `AUTH_PEPPER` once. Missing/malformed is a ready-made 503. */
export function loadPepperRing(env: Pick<Env, "AUTH_PEPPER">): PepperLoad {
  const raw = env.AUTH_PEPPER;
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: false, response: pepperUnavailable("missing") };
  }
  if (cached !== null && cached.raw === raw) return { ok: true, ring: cached.ring };
  const ring = parseRing(raw);
  if (ring === null) {
    return { ok: false, response: pepperUnavailable("malformed") };
  }
  cached = { raw, ring };
  return { ok: true, ring };
}

/** The entry for a stored `p=`, or `null` while that version is no longer in the ring. */
export function pepperFor(ring: PepperRing, version: number): PepperEntry | null {
  return ring.byVersion.get(version) ?? null;
}

/** Import (once per ring/version) the HMAC key for a pepper entry. */
export function pepperHmacKey(ring: PepperRing, entry: PepperEntry): Promise<CryptoKey> {
  const existing = ring.hmacKeys.get(entry.version);
  if (existing !== undefined) return existing;
  const imported = crypto.subtle.importKey(
    "raw",
    entry.key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  ring.hmacKeys.set(entry.version, imported);
  return imported;
}

/**
 * The ring that results from prepending `pepper`.
 *
 * `nextVersion` is max+1 rather than count+1, so a ring that skipped a number
 * (v5,v3) does not accidentally reuse one. The value is returned as the exact
 * string an operator puts in `wrangler secret put AUTH_PEPPER`; the Worker
 * itself can never write its own secret, which is why rotation is a two-step
 * operation (see `auth/password-routes.ts`).
 */
export function ringAfterPrepend(
  ring: PepperRing,
  pepper: Uint8Array
): { version: number; raw: string } {
  let max = 0;
  for (const version of ring.byVersion.keys()) if (version > max) max = version;
  const version = max + 1;
  return { version, raw: `v${version}:${b64encode(pepper)},${ring.raw}` };
}

/** The version whose key equals `pepper`, or `null`. Byte comparison, not string. */
export function findPepperVersion(ring: PepperRing, pepper: Uint8Array): number | null {
  for (const entry of ring.byVersion.values()) {
    if (entry.key.length !== pepper.length) continue;
    let diff = 0;
    for (let i = 0; i < entry.key.length; i++) diff |= entry.key[i] ^ pepper[i];
    if (diff === 0) return entry.version;
  }
  return null;
}

/** HMAC-SHA256(pepper_v, data). The single place the pepper touches bytes. */
export async function pepperHmac(
  ring: PepperRing,
  entry: PepperEntry,
  data: Uint8Array
): Promise<Uint8Array> {
  const key = await pepperHmacKey(ring, entry);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
}

/** `salt ‖ material`, the exact HMAC input AUTH_PLAN §2 specifies. */
export function outerInput(salt: Uint8Array, material: Uint8Array): Uint8Array {
  return concatBytes(salt, material);
}
