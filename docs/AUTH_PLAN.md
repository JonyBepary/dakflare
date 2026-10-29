# Auth plan — tiered, free-tier honest

Status: decided 2026-10-29. Supersedes the paste-a-token login. The gateway's device
API is out of scope: it keeps its own P-256 signature scheme.

## 1. The ladder

One account may hold several factors; the console offers them in this order.

| # | Factor | Cost on a Worker | Free tier | Notes |
|---|---|---|---|---|
| 1 | Passkey (WebAuthn) | one ECDSA verify, ~1–2 ms | yes | default; discoverable credential, no username needed |
| 2 | Magic link | HMAC + one D1 read | yes | single use, 15 min, bound to the account and the request IP |
| 3 | TOTP (second factor) | one HMAC-SHA1, microseconds | yes | optional, required by policy for `owner` if ever more than one |
| 4 | Email OTP | HMAC + one D1 row | yes | recovery only, never a primary on its own |
| 5 | Password | **KDF** | see §2 | off unless the operator chooses it |

## 2. Passwords, by plan

The only CPU-bound step in the whole design is the password KDF. PBKDF2-SHA256 at
210,000 iterations is roughly 60–150 ms, against a **10 ms** free-tier CPU budget per
request. So the KDF runs where there is budget:

| Plan | Mode | Who runs PBKDF2 | Worker cost |
|---|---|---|---|
| Free | `client-derived` | the browser, at login and registration | HMAC(pepper, derived) + compare, ~1 ms |
| Paid | `server-kdf` | the Worker | 60–150 ms (30 s limit available) |
| Free, passwords unwanted | `off` | nobody | none |

Both modes store the same shape, distinguished by a version tag, so an account created
on free keeps working after an upgrade:

```
v1$<salt-b64>$<iterations>$<hmac-b64>     client-derived (free)
v2$<salt-b64>$<iterations>$<pbkdf2-b64>   server-kdf (paid)
```

The switch is `AUTH_PASSWORD_MODE`, set by `dakflare doctor` from the detected plan and
overridable by hand. The login page renders from it: a password field only exists when a
password path can actually complete.

### Why the iteration count is not randomised

A random 200k–250k per user does not harden anything. In `client-derived` mode the
browser sends a derived key, so an attacker holding the stored value never runs PBKDF2 at
all — the **pepper** is what stops them, not the iteration count. In `server-kdf` mode the
count is a fixed cost you choose once. Randomising it adds a column, a branch, and the
illusion of strength. Fixed: **210,000** (OWASP's PBKDF2-SHA256 floor), recorded in the
stored value so it can be raised later per account on next sign-in.

What actually earns its place instead: pepper versioning, a uniform salt response (no user
enumeration), rate limiting per IP and per account, and an audit row for every attempt.

### Pepper

`HMAC-SHA256(AUTH_PEPPER, salt ‖ password-material)` before the KDF, with the pepper in a
Worker secret and its version in the stored tag. A database leak alone is then useless.
Rotation accepts two versions, re-derives on next successful sign-in, and never locks
anyone out — the failure mode the current `ADMIN_TOKEN` still has.

## 3. Stack

**Better Auth**, pinned, with exactly three plugins: `passkey`, `magicLink`,
`twoFactor` (TOTP). Password hashing replaced by ours (§2). Organization plugin only if
roles outgrow a single `role` column.

Boundary: `worker/src/auth/` exposes `requireRole()` and nothing else to the rest of the
Worker. Policy — invite-only registration, the bootstrap owner, the audit table — is ours.
Protocol mechanics are Better Auth's. If it ever needs replacing, it is a swap behind that
one door.

## 4. Registration

There is no public sign-up. The first owner is created by `dakflare init` using
`ADMIN_TOKEN`; every later account exists only because an owner invited that email. An
invite is a row with a role, an expiry, and a single use. `ADMIN_TOKEN` then demotes to a
machine credential for the CLI and automation, never a human login.

## 5. Audit

`audit_log(id, at, actor_user, actor_label, action, subject, ip, user_agent, detail_json)`.
Written for: sign-in attempts (all factors), invite created/redeemed, device paired or
revoked, rule and flow saved, message sent, retention changed, token rotated. Console gets
an Audit page filtered by actor and action; the CLI gets `dakflare audit --tail`.

## 6. Free-tier budget check

Requests per day for one phone: ~300 (poll + flush + sync at 15 min). Console: hundreds.
Auth: a handful. All far inside 100,000/day. CPU per request stays in single-digit
milliseconds on every path except the paid password mode. The Durable Object stays
SQLite-backed, which is the only kind the free plan allows.

## 7. Not doing

- ML-DSA in the browser — no WebCrypto support; PQ is already covered at TLS, and the
  device signature is the only place a PQ upgrade would matter (a later, hybrid change).
- Cloudflare Access — no custom domain, and nothing else here needs one.
- Public registration, password reset without a factor, session sharing across users.
