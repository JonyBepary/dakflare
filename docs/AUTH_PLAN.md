# Auth plan — tiered, free-tier honest

Status: decided 2026-10-29. Supersedes the paste-a-token login. The gateway's device
API is out of scope: it keeps its own P-256 signature scheme.

Update 2026-10-31: `AUTH_MODE=legacy` is retired. There is one admin gate and two
credentials — a Better Auth session with role owner/admin, or `ADMIN_TOKEN` carrying
`X-Dakflare-Client: cli`. A bare bearer token is now 401.

## 1. The ladder

One account may hold several factors; the console offers them in this order.

| # | Factor | Cost on a Worker | Free tier | Notes |
|---|---|---|---|---|
| 1 | Passkey (WebAuthn) | one ECDSA verify, ~1–2 ms | yes | default; discoverable credential, no username needed |
| 2 | Magic link | HMAC + one D1 read | yes | single use, 15 min, bound to a pre-auth cookie (not the IP) |
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

Both modes store the same shape, so an account created on free keeps working after an
upgrade — the *value* is identical because the pepper is applied after the KDF in both:

```
material  = PBKDF2-SHA256(password, salt, iterations)      who runs it: browser (c) or Worker (s)
peppered  = HMAC-SHA256(pepper_v, salt ‖ material)
stored    = SHA-256(peppered)

row       = v1$p=<pepper-version>$k=<iterations>$m=<c|s>$<salt-b64>$<sha256-b64>
```

Applying the pepper *before* the KDF in one mode and *after* it in the other would produce
two different values for the same password and force a re-hash on upgrade; it does not, so
it must not happen. The only thing that changes between free and paid is `m=` — who runs
the inner PBKDF2 — and `m=s` on an existing row is only reachable by one sign-in that
sends the password, because the Worker cannot derive what it never sees.

Why the outer `SHA-256` exists, stated honestly: it does **not** change the offline work
factor, which stays "210,000 iterations per guess". It removes the stored value's
usefulness as a verifier in any other scheme and costs a few microseconds. What actually
protects a leaked database is the pepper: without it, `SHA-256(HMAC(pepper, …))` cannot be
checked against a candidate at all. With the pepper, an attacker is reduced to exactly the
cost of brute-forcing a PBKDF2 hash — which is the same position a conventional
server-side hash would leave them in, not a bypass.

### The 100,000-iteration claim, tested

A review claimed workerd refuses PBKDF2 above 100,000 iterations. It does not. On
`wrangler dev --local` (compatibility date 2026-10-01) the runtime returned a derived key
at every count asked:

| Iterations | Result | Wall time |
|---|---|---|
| 100,000 | ok, 32 bytes | 10 ms |
| 210,000 | ok, 32 bytes | 21 ms |
| 500,000 | ok, 32 bytes | 50 ms |

No `NotSupportedError`, no clamp. So there is no cap to design around — the constraint is
the 10 ms CPU budget, which is why the KDF is client-side on free and server-side on paid.
If a future runtime introduces a cap, the fallback is chaining derivations; do not build
that now for a limit that does not exist.

### Pepper

`HMAC-SHA256(AUTH_PEPPER, salt ‖ PBKDF2(...))`, with the pepper in a Worker secret, a
version in the stored tag, and the ring stored as `v2:<b64>,v1:<b64>` in one secret so two
versions verify during rotation. A database leak alone cannot be checked against a
candidate at all. Rotation re-derives the outer layers on next sign-in without the
password (the inner PBKDF2 output is unchanged), and never locks anyone out — the failure
mode the current `ADMIN_TOKEN` still has.

The salt pre-flight must answer identically for an unknown address. For a missing user:

```
salt = HMAC-SHA256(AUTH_PEPPER, "salt-v1:" ‖ lowercase(email))[0..16]
```

returning a fresh random salt on a miss would turn the endpoint into a user oracle.

## 3. Stack

**Better Auth**, pinned, with exactly three plugins: `passkey`, `magicLink`,
`twoFactor` (TOTP). Password hashing replaced by ours (§2). Organization plugin only if
roles outgrow a single `role` column.

Boundary: `worker/src/auth/` exposes `requireRole()` and nothing else to the rest of the
Worker. Policy — invite-only registration, the bootstrap owner, the audit table — is ours.
Protocol mechanics are Better Auth's. If it ever needs replacing, it is a swap behind that
one door.

Details that decide whether it works in practice:

- **Magic links are consumed by `POST`, never `GET`.** Corporate scanners (Outlook
  SafeLinks, Gmail, Proton) prefetch every link. `GET /auth/magic-link?token=…` renders a
  one-button page that posts the token; the scanner burns a page load, not the credential.
- **Bind the link to the requesting browser, not its address.** A `HttpOnly` pre-auth
  nonce cookie set when the link is requested; IP equality breaks the normal case of
  requesting on a laptop and tapping on a phone.
- **`rpId` is `sohelahmedjony.workers.dev`** (workers.dev is on the Public Suffix List, so
  the subdomain is its own registrable domain). Moving to a custom domain later
  **invalidates every existing passkey** — WebAuthn binds credentials to the rpId. Magic
  link, TOTP and email OTP are the recovery path when that day comes; say so in the
  release notes rather than discovering it.
- **Sessions: short signed cookie cache over D1.** A five-minute cookie cache cuts D1 reads
  by roughly an order of magnitude for console browsing; sensitive actions call
  `requireRole({ fresh: true })` and read D1, so revocation is immediate where it matters.
- **Rate limiting lives in the existing Durable Object, in memory.** A sliding window in
  the DO costs zero D1 writes; only legitimate attempts and summarised bursts reach
  `audit_log`. Using D1 for this would let an attacker spend your 100k daily write quota.

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

## 8. Secrets

All secrets are Worker Encrypted Secrets (`wrangler secret put`), read from `env`, never in
`wrangler.toml`, D1 or a build artefact.

| Secret | Format | Purpose | Rotation |
|---|---|---|---|
| `AUTH_PEPPER` | `v2:<b64-32>,v1:<b64-32>` | pepper ring: password outer layer, fake salts, magic-link HMAC | prepend a version; verify old, re-derive on next sign-in |
| `BETTER_AUTH_SECRET` | 32-byte base64 | session cookie signing, CSRF/state | dual key or flush sessions |
| `ADMIN_TOKEN` | `dk_adm_<b64-32>` | bootstrap (`dakflare init`) and CLI/automation only | instant via `wrangler secret put` |
| `EMAIL_API_KEY` | provider key | magic links, email OTP | provider-side |

`ADMIN_TOKEN` is a machine credential: refused on cookie/session routes, accepted only with
`X-Dakflare-Client: cli`, compared with `timingSafeEqual`, and written to `audit_log` as
`actor_label = "admin-token"` on every call. `dakflare init --local` writes fresh random
values to `.dev.vars` so local runs exercise the same paths.

## 9. Decided 2026-10-30

- **Cutover by flag.** `AUTH_MODE` stays `legacy` until the owner has enrolled a passkey,
  a second account has signed in, TOTP has been proven, and the audit page shows both.
  Only then does it flip to `new`. A bad session bug can therefore never lock the console.
- **Magic link sender: Resend sandbox** until a domain exists. It delivers only to the
  account's own address, which is exactly one operator. The feature is wired behind a
  sender interface and stays disabled until a key is present; invites are CLI-printed
  links, so onboarding never depends on email.
- **Deploy-to-Cloudflare button after phase 2**, not before: the button deploys Worker +
  D1 + DO, the deploy script applies migrations first, and `dakflare init --from-deploy`
  sets secrets and creates the owner. A button over a Worker with no auth tables is a trap.

## 10. Decided 2026-10-30 (second pass)

- **TOTP is optional for every role.** Anyone may enrol it; nobody is forced. The
  account that can revoke phones can therefore stay single-factor if the operator never
  enrols — accepted deliberately, because with one person and passkeys the marginal
  protection of a forced TOTP is smaller than the lockout risk of enforcing a factor
  before its recovery path is proven.
- **Sessions: seven days, sliding**, unchanged: five-minute cookie cache, and
  `requireRole({ fresh: true })` on destructive actions.
- **Next after TOTP: password mode (phase 4)** — client-derived PBKDF2 on free, server KDF
  on paid, the pepper keyring and its rotation, and the mode switch `doctor` reports.

The cutover rule from §9 stands unchanged: `AUTH_MODE` flips only after a real passkey
sign-in reaches Overview and the audit page records it.
