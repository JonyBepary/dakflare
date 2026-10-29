/**
 * Better Auth configuration — AUTH_PLAN §3.
 *
 * Boundary: this file is the ONLY place Better Auth is configured. The rest of
 * the Worker sees `requireRole()` and the `/api/auth/*` mount (see `auth/index.ts`),
 * never a Better Auth type. Replacing the library later is a swap behind that door.
 *
 * Pinned: better-auth 1.7.14, @better-auth/passkey 1.7.14 (exact, see package.json).
 * The D1 binding is passed directly: 1.7.x ships a D1 Kysely dialect internally
 * (`D1SqliteDialect`, transaction: false), so no separate adapter package is
 * installed. That was checked against the package, not assumed from docs.
 */

import { betterAuth } from "better-auth";
import { passkey } from "@better-auth/passkey";
import { twoFactor } from "better-auth/plugins";
import type { Env } from "../index";
import { hasLiveInvite, normalizeEmail } from "../lib/invites";

/** Five minutes, per AUTH_PLAN §3: a short signed cookie cache over D1. */
const COOKIE_CACHE_SECONDS = 5 * 60;

/** Seven days. Sensitive actions use `requireRole({ fresh: true })` and hit D1. */
const SESSION_SECONDS = 7 * 24 * 60 * 60;

/** The rpId AUTH_PLAN §3 pins. Moving to a custom domain invalidates passkeys. */
const DEFAULT_RP_ID = "sohelahmedjony.workers.dev";

type Auth = ReturnType<typeof buildAuth>;

function trustedOrigins(env: Env): string[] {
  const raw = env.AUTH_TRUSTED_ORIGINS ?? "";
  const origins = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
  const base = env.AUTH_BASE_URL?.trim();
  if (base !== undefined && base !== "" && !origins.includes(base)) origins.push(base);
  return origins;
}

function rpId(env: Env): string {
  if (env.AUTH_RP_ID !== undefined && env.AUTH_RP_ID !== "") return env.AUTH_RP_ID;
  const base = env.AUTH_BASE_URL?.trim();
  if (base !== undefined && base !== "") {
    try {
      return new URL(base).hostname;
    } catch {
      // fall through to the pinned default
    }
  }
  return DEFAULT_RP_ID;
}

function buildAuth(env: Env) {
  const baseURL = env.AUTH_BASE_URL?.trim() || undefined;
  // Secure cookies unless we are explicitly on plain http (local `wrangler dev`).
  // The prefix is load-bearing: Better Auth adds `__Secure-` when this is true,
  // and a browser will not store that over http.
  const useSecureCookies = baseURL === undefined ? true : baseURL.startsWith("https://");

  return betterAuth({
    appName: "DakFlare",
    ...(baseURL === undefined ? {} : { baseURL }),
    // Env is a D1Database; Better Auth 1.7.14 detects it and uses its own
    // D1SqliteDialect (transaction: false). No adapter package needed.
    database: env.DB,
    secret: env.BETTER_AUTH_SECRET ?? "",
    trustedOrigins: trustedOrigins(env),

    // No public registration and no password login in this phase. Accounts come
    // only from an invite (AUTH_PLAN §4) or `POST /v1/admin/bootstrap`.
    emailAndPassword: {
      enabled: false,
      // ----------------------------------------------------------------
      // PASSWORD HASHER — deliberately NOT implemented in phase 2a.
      //
      // This is where AUTH_PLAN §2's construction goes when passwords are
      // enabled. It is one function pair, kept in one place, because the
      // stored value must be identical whether the browser or the Worker ran
      // the inner PBKDF2:
      //
      //   material = PBKDF2-SHA256(password, salt, iterations)   // client (free) or Worker (paid)
      //   peppered = HMAC-SHA256(pepper_v, salt ‖ material)       // ALWAYS after the KDF
      //   stored   = SHA-256(peppered)
      //   row      = v1$p=<pepper-version>$k=<iterations>$m=<c|s>$<salt-b64>$<sha256-b64>
      //
      // password: { hash: async (password) => { /* §2 */ }, verify: async ({ hash, password }) => { /* §2 */ } },
      // ----------------------------------------------------------------
    },

    session: {
      expiresIn: SESSION_SECONDS,
      // Signed cache in a cookie; `requireRole({ fresh: true })` bypasses it.
      cookieCache: { enabled: true, maxAge: COOKIE_CACHE_SECONDS },
    },

    advanced: {
      useSecureCookies,
    },

    user: {
      additionalFields: {
        // A single role column, as AUTH_PLAN §3 allows. `input: false` keeps it
        // out of any sign-up payload: only our invite/bootstrap code sets it.
        role: {
          type: "string",
          required: false,
          defaultValue: "member",
          input: false,
        },
      },
    },

    // Every Better Auth-created user must match a live invite. This is the
    // defence-in-depth gate for factors added later (magic link, passkey-first);
    // `POST /v1/auth/redeem` is the path that actually consumes the invite.
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const email = normalizeEmail(user.email);
            if (email === null) return false;
            return await hasLiveInvite(env, email);
          },
        },
      },
    },

    plugins: [
      passkey({
        rpID: rpId(env),
        rpName: "DakFlare",
      }),
      twoFactor({
        issuer: "DakFlare",
        // This phase has no password factor at all: `emailAndPassword.enabled`
        // is false above, so `shouldRequirePassword()` would be true for every
        // account and `enable`, `disable`, `generate-backup-codes` and
        // `get-totp-uri` would each answer INVALID_PASSWORD forever. The flag
        // makes the password optional and, with no credential row, satisfied —
        // TOTP is then the second factor after the passkey, exactly as
        // AUTH_PLAN §1 factor 3 describes. The moment a password factor is
        // enabled this must be revisited: the plugin deliberately asks for the
        // password when one exists.
        allowPasswordless: true,
      }),
    ],

    // Better Auth's own limiter is per-isolate memory and would compete with the
    // Durable Object limiter AUTH_PLAN §3 names. Ours owns the budget.
    rateLimit: { enabled: false },
    // No outbound telemetry from a self-hosted Worker.
    telemetry: { enabled: false },
  });
}

/**
 * Cached per isolate. `betterAuth()` builds an adapter and schema checks; doing
 * that on every request would be a measurable tax on the free tier's CPU budget.
 * The key includes everything configuration depends on, so a secret rotation or
 * a different D1 binding cannot reuse a stale instance.
 */
let cached: { key: string; auth: Auth } | null = null;

export function getAuth(env: Env): Auth | null {
  if (env.BETTER_AUTH_SECRET === undefined || env.BETTER_AUTH_SECRET === "") return null;
  const key = [
    env.BETTER_AUTH_SECRET,
    env.AUTH_BASE_URL ?? "",
    env.AUTH_TRUSTED_ORIGINS ?? "",
    env.AUTH_RP_ID ?? "",
  ].join("\u0000");
  if (cached !== null && cached.key === key) return cached.auth;
  const auth = buildAuth(env);
  cached = { key, auth };
  return auth;
}
