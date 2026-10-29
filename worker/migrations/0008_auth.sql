-- DakFlare — real accounts (docs/AUTH_PLAN.md §3–§5), phase 2a.
--
-- Additive only: no existing table is touched. Six tables are Better Auth's
-- (user/session/account/verification/passkey/twoFactor, generated from the
-- pinned 1.7.14 schema: passkey() + twoFactor() plugins, emailAndPassword
-- disabled), and two are ours (invite, audit_log).
--
-- Type choices follow Better Auth's own SQLite migration generator:
--   string -> text, number -> integer, boolean -> integer (0/1), date -> date.
-- The D1 adapter stores `date` values as ISO-8601 TEXT (supportsDates=false), so
-- lexical order equals chronological order and comparisons stay correct.
--
-- Column names are camelCase because Better Auth's default `casing` is "camel";
-- SQLite folds identifier case, but keeping the exact spelling avoids surprises
-- for anyone reading the DB by hand or introspecting with the Better Auth CLI.

-- ---------------------------------------------------------------------------
-- Better Auth: user
-- `role` is our additionalField (single role column per AUTH_PLAN §3, until
-- roles outgrow it and the organization plugin becomes worth its tables).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "user" (
  id               text PRIMARY KEY NOT NULL,
  name             text NOT NULL,
  email            text NOT NULL UNIQUE,
  "emailVerified"  integer NOT NULL DEFAULT 0,
  image            text,
  "createdAt"      date NOT NULL,
  "updatedAt"      date NOT NULL,
  "twoFactorEnabled" integer NOT NULL DEFAULT 0,
  role             text
);

-- ---------------------------------------------------------------------------
-- Better Auth: session (7-day sessions; cookieCache is a signed cookie, not a
-- table, see worker/src/auth/settings.ts)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS session (
  id          text PRIMARY KEY NOT NULL,
  "expiresAt" date NOT NULL,
  token       text NOT NULL UNIQUE,
  "createdAt" date NOT NULL,
  "updatedAt" date NOT NULL,
  "ipAddress" text,
  "userAgent" text,
  "userId"    text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_session_user ON session("userId");

-- ---------------------------------------------------------------------------
-- Better Auth: account
-- No credential provider is enabled in this phase, so this table stays empty;
-- it exists because the passkey/magicLink/twoFactor surface expects it and
-- because adding it later would mean a second migration touching auth.
-- `password` is where the §2 hasher's row would live when passwords are enabled.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS account (
  id                     text PRIMARY KEY NOT NULL,
  "accountId"            text NOT NULL,
  "providerId"           text NOT NULL,
  "userId"               text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "accessToken"          text,
  "refreshToken"         text,
  "idToken"              text,
  "accessTokenExpiresAt" date,
  "refreshTokenExpiresAt" date,
  scope                  text,
  password               text,
  "createdAt"            date NOT NULL,
  "updatedAt"            date NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_account_user ON account("userId");

-- ---------------------------------------------------------------------------
-- Better Auth: verification (passkey challenge tokens, magic-link tokens later)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS verification (
  id         text PRIMARY KEY NOT NULL,
  identifier text NOT NULL,
  value      text NOT NULL,
  "expiresAt" date NOT NULL,
  "createdAt" date NOT NULL,
  "updatedAt" date NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_verification_identifier ON verification(identifier);

-- ---------------------------------------------------------------------------
-- Better Auth passkey plugin: one row per WebAuthn credential.
-- rpId is pinned to sohelahmedjony.workers.dev (AUTH_PLAN §3); moving the domain
-- invalidates these rows by design.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS passkey (
  id             text PRIMARY KEY NOT NULL,
  name           text,
  "publicKey"    text NOT NULL,
  "userId"       text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "credentialID" text NOT NULL,
  counter        integer NOT NULL DEFAULT 0,
  "deviceType"   text NOT NULL,
  "backedUp"     integer NOT NULL DEFAULT 0,
  transports     text,
  "createdAt"    date,
  aaguid         text
);
CREATE INDEX IF NOT EXISTS idx_passkey_user ON passkey("userId");
CREATE INDEX IF NOT EXISTS idx_passkey_credential ON passkey("credentialID");

-- ---------------------------------------------------------------------------
-- Better Auth twoFactor plugin: TOTP secret + encrypted backup codes.
-- `secret` and `backupCodes` are encrypted by Better Auth with BETTER_AUTH_SECRET.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "twoFactor" (
  id                       text PRIMARY KEY NOT NULL,
  secret                   text NOT NULL,
  "backupCodes"            text NOT NULL,
  "userId"                 text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  verified                 integer DEFAULT 1,
  "failedVerificationCount" integer DEFAULT 0,
  "lockedUntil"            date
);
CREATE INDEX IF NOT EXISTS idx_twofactor_user ON "twoFactor"("userId");
CREATE INDEX IF NOT EXISTS idx_twofactor_secret ON "twoFactor"(secret);

-- ---------------------------------------------------------------------------
-- Ours: invite — the ONLY way an account is created (AUTH_PLAN §4).
-- The raw token is never stored: `token_hash` is SHA-256(token), so a database
-- leak cannot be replayed against the redeem endpoint. Single use is enforced by
-- `used_at IS NULL` in the consuming UPDATE, not by application logic.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invite (
  id         text PRIMARY KEY NOT NULL,
  email      text NOT NULL,
  role       text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at integer NOT NULL,
  used_at    integer,
  created_by text,
  created_at integer NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invite_email ON invite(email, used_at);
CREATE INDEX IF NOT EXISTS idx_invite_expiry ON invite(expires_at);

-- ---------------------------------------------------------------------------
-- Ours: audit_log (AUTH_PLAN §5). Append-only; the console reads it filtered by
-- actor/action. detail_json never contains a token or a message body.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id          text PRIMARY KEY NOT NULL,
  at          integer NOT NULL,
  actor_user  text,
  actor_label text,
  action      text NOT NULL,
  subject     text,
  ip          text,
  user_agent  text,
  detail_json text
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor_user, at DESC);
