-- DakFlare — magic-link sign-in (docs/AUTH_PLAN.md §1, factor 2).
--
-- Additive only. The raw token is never stored: `token_hash` is SHA-256(token),
-- so a database leak cannot be replayed against the consume endpoint. Single use
-- is enforced by `used_at IS NULL` in the consuming UPDATE, not by application
-- logic, so two concurrent requests cannot both win.
--
-- `email` is the normalized address the link was minted for. The account is
-- looked up again at consume time; a link whose account disappeared simply does
-- not issue a session. `ip` is the requesting address (nullable locally) and is
-- used for audit/abuse review only, never as the binding: AUTH_PLAN §3 binds a
-- link to the browser that requested it, not to the network it was requested
-- from (laptop request, phone click is the normal case).
CREATE TABLE IF NOT EXISTS magic_link (
  id         text PRIMARY KEY NOT NULL,
  email      text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at integer NOT NULL,
  used_at    integer,
  created_at integer NOT NULL,
  ip         text
);
CREATE INDEX IF NOT EXISTS idx_magic_link_email ON magic_link(email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_magic_link_expiry ON magic_link(expires_at);
