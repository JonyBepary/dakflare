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
import { loadPepperRing } from "./pepper";
import {
  PASSWORD_ITERATIONS,
  buildPasswordRow,
  deriveMaterial,
  parsePasswordRow,
  randomSalt,
  verifyPlaintext,
} from "./password";

/** Five minutes, per AUTH_PLAN §3: a short signed cookie cache over D1. */
const COOKIE_CACHE_SECONDS = 5 * 60;

/**
 * The TOTP parameters, in one place.
 *
 * `@better-auth/two-factor` 1.7.14 generates the `otpauth://` URI from these
 * (`totp/index.mjs`, `createOTP(secret, { digits, period }).url(issuer, email)`)
 * and verifies codes against them. `totp-routes.ts` performs the enrolment half
 * of the same work behind a passkey re-assertion, so it must read the SAME
 * numbers rather than carry its own copy — otherwise the console would show a
 * URI whose codes the plugin then rejects.
 */
export const TOTP_ISSUER = "DakFlare";
export const TOTP_DIGITS = 6;
export const TOTP_PERIOD = 30;

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

    // No public registration and no password login route in this phase: accounts
    // come only from an invite (AUTH_PLAN §4) or `POST /v1/admin/bootstrap`.
    //
    // `enabled: false` is deliberate. Better Auth's `/sign-in/email` and
    // `/sign-up/email` would bypass AUTH_PASSWORD_MODE entirely: they always run
    // the KDF on the Worker, and they accept a password from any client. Our
    // `/v1/auth/sign-in/password` is the only password sign-in, so the free tier
    // can never be made to run PBKDF2 by hitting a library route.
    //
    // The hasher pair below is still installed because Better Auth's TOTP
    // management endpoints call `ctx.password.verify` whenever a credential
    // account exists (two-factor's `allowPasswordless` asks for a password if one
    // is present). It is the SAME construction as the endpoints use — one
    // function pair, one place:
    //
    //   material = PBKDF2-SHA256(password, salt, iterations)   // client (free) or Worker (paid)
    //   peppered = HMAC-SHA256(pepper_v, salt ‖ material)       // ALWAYS after the KDF
    //   stored   = SHA-256(peppered)
    //   row      = v1$p=<pepper-version>$k=<iterations>$m=<c|s>$<salt-b64>$<sha256-b64>
    emailAndPassword: {
      enabled: false,
      password: {
        // Reachable only if Better Auth itself hashes a password (a path this
        // deployment does not expose). Derive on the Worker and tag it `s` so the
        // row is honest about who ran the KDF.
        hash: async (password: string): Promise<string> => {
          const loaded = loadPepperRing(env);
          if (!loaded.ok) {
            throw new Error("AUTH_PEPPER is missing or malformed; cannot hash a password");
          }
          const salt = randomSalt();
          const material = await deriveMaterial(password, salt, PASSWORD_ITERATIONS);
          const row = await buildPasswordRow({
            ring: loaded.ring,
            salt,
            material,
            iterations: PASSWORD_ITERATIONS,
            mode: "s",
          });
          if (row === null) throw new Error("could not build a password row");
          return row;
        },
        // Better Auth hands us plaintext, so this necessarily derives on the
        // Worker. Our own sign-in path never reaches here in client-derived mode.
        verify: async ({ hash, password }: { hash: string; password: string }): Promise<boolean> => {
          const row = parsePasswordRow(hash);
          if (row === null) return false;
          const loaded = loadPepperRing(env);
          if (!loaded.ok) return false;
          return await verifyPlaintext(row, password, loaded.ring);
        },
      },
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
        issuer: TOTP_ISSUER,
        // `allowPasswordless` only relaxes the *schema* (password becomes
        // optional). It does NOT bypass the check: `shouldRequirePassword`
        // (`better-auth/dist/utils/password.mjs`) still returns true whenever a
        // credential row exists, and enable/disable/generate-backup-codes then
        // answer INVALID_PASSWORD without one. That is why the console never
        // calls those three endpoints for an account with a password: it uses
        // `totp-routes.ts`, which re-authenticates with a passkey assertion or a
        // current TOTP code and performs the same writes with the plugin's own
        // primitives. The plugin stays authoritative for the secret format, the
        // URI, the verification window, and the `verify-totp` endpoint.
        allowPasswordless: true,
        totpOptions: { digits: TOTP_DIGITS, period: TOTP_PERIOD },
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
    // The hasher pair closes over `env`; a pepper rotation must not leave a
    // cached instance holding the old ring.
    env.AUTH_PEPPER ?? "",
  ].join("\u0000");
  if (cached !== null && cached.key === key) return cached.auth;
  const auth = buildAuth(env);
  cached = { key, auth };
  return auth;
}
