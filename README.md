# DakFlare

> **Sovereign Device-to-Edge SMS Relay on Cloudflare Workers & Android.**
>
> DakFlare pairs a dedicated Android handset with your own Cloudflare account (Workers, Durable
> Objects, D1, KV) to send, receive and answer SMS over a signed wire protocol. No third-party
> telecom SaaS, no per-message markup, no shared secret between the phone and the edge.

The handset is the radio. The Worker is the coordinator. The console is where an operator watches
both.

## Why "DakFlare"

**DakFlare** combines *Dāk* (ডাক — the relay-runner dispatch network that carried urgent letters
across Bengal station by station) with the **Cloudflare** edge where the coordinator lives.

## Shape

| Layer | Role |
|---|---|
| **Android app** (Tauri + Rust core) | Owns the SIM, is the default SMS app, holds a P-256 identity wrapped by Android Keystore, runs flows on-device, mirrors what it did |
| **Worker** | Verifies every device request against a canonical string and a replay guard, serves the console, hosts accounts |
| **Durable Object** (one per device) | SQLite-backed command queue, replay-guard nonces, alarms for `ack_timeout` / `offline_alert` / expiry |
| **D1** | Fleet registry, message log, rules, workflows, accounts, invites, audit |
| **KV** | FCM bearer-token cache |

Device auth is not a shared secret: each phone signs `METHOD\nPATH\nTIMESTAMP\nNONCE\nSHA256(body)`
with a P-256 key whose at-rest form is `keystore:v1:<iv>:<ciphertext>` — wrapped by a non-exportable
AndroidKeyStore AES-GCM key. A copied database alone cannot impersonate the phone.

## Quick start

```bash
git clone https://github.com/JonyBepary/dakflare
cd dakflare

# 1. the edge
cd worker && npm install
cp wrangler.template.toml wrangler.toml
cp cloudflare.config.template.ts cloudflare.config.ts
npx wrangler d1 create sms_gateway
npx wrangler kv namespace create KV            # paste the id into cloudflare.config.ts
npx wrangler d1 migrations apply sms_gateway --remote

# 2. secrets (never in the repo)
npx wrangler secret put ADMIN_TOKEN --name dakflare-worker      # machine credential
npx wrangler secret put BETTER_AUTH_SECRET --name dakflare-worker
npx wrangler secret put AUTH_PEPPER --name dakflare-worker      # v2:<base64 32 bytes>,v1:<base64 32 bytes>
# optional: turns on the magic-link door
npx wrangler secret put RESEND_API_KEY --name dakflare-worker

# 3. deploy (builds the console into worker/public/admin first)
npm run deploy                                  # cf build + cf deploy; see docs/OPS_DEPLOY.md
```

`cf` is the deploy path. `wrangler` stays for local dev, `tail`, `secret put` and `d1 export`,
because `cf` cannot set one secret or stream logs yet.

CI runs the same checks on every pull request; it does not deploy. Deploy from a clean tree with
`npm run deploy`, which builds the console first. Migrations are applied by hand, never by the
pipeline. `docs/OPS_DEPLOY.md` has the jobs, the secrets, the order of operations and the rollback.

Then, from anywhere:

```bash
npm install -g .            # or: node cli/bin/dakflare.js …
dakflare init               # stores the URL + token in ~/.config/dakflare/config.json (mode 600)
dakflare doctor             # 11 checks: config, health, token, schema, migrations, bindings,
                            # auth mode, D1, phone contact, SMS role, installed build
dakflare auth bootstrap --email you@example.com   # prints the one-time owner invite
```

Open that invite in a browser, redeem it, create a passkey. That account is the owner.

## The console

Prerendered SvelteKit, served by the Worker at `/admin`, hand-written CSS over a token system
(`design/tokens.css`: primitive → semantic → component). Warm cream surfaces, pastel containers that
never carry body text, one coral action per screen, mono for anything an operator compares with a log.

- **Overview** — deployment health, fleet, the quiet panel, the rules-vs-flows pipeline.
- **Devices / Messages** — the fleet with five states, and a message log that says who answered and
  what happened to that answer (`Delivered · Sent · Queued · Failed — reason`).
- **Automation** — rules as one sentence each, workflows on a canvas.
- **Security** — sign-in factors (passkey, authenticator, password), invites, and the audit log.

### Sign-in

| # | Factor | Notes |
|---|---|---|
| 1 | **Passkey** | primary; nothing phishable, no shared secret |
| 2 | **TOTP** | optional for every role; backup codes shown once |
| 3 | **Password** | optional; the KDF runs in the browser under `AUTH_PASSWORD_MODE=client-derived`, because a server-side PBKDF2 costs about 27 ms against the free tier's 10 ms CPU budget |
| 4 | **Magic link** | optional; the door appears only when `RESEND_API_KEY` is set. The token is spent by the button, never by opening the page |

`AUTH_MODE` decides who guards `/v1/admin/*`: `legacy` (the `ADMIN_TOKEN`, exchanged for a session
cookie) or `new` (Better Auth accounts, `requireRole()`). Registration is invite-only; there is no
public sign-up. The CLI or the Security panel mints a single-use invite, and only its hash is stored.

#### Sessions

A signed-in browser holds one `__Secure-better-auth.session_token` cookie: HttpOnly, Secure,
`SameSite=Lax`, host-only, seven days. Its value is `<token>.<HMAC-SHA256(BETTER_AUTH_SECRET, token)>`,
URL-encoded; D1 stores the token and the session row. Better Auth also caches the session in a signed
`session_data` cookie for five minutes, and `requireRole({ fresh: true })` reads D1 instead. The legacy
admin-token console keeps its own `dakflare_admin` cookie, `SameSite=Strict`.

Three consequences worth knowing:

- **The cookie is host-only.** Open the console on the hostname that signed you in. A preview proxy on
  `localhost`, an IDE iframe, or another hostname has its own cookie jar, so the Worker signs the
  request in and the browser never sends the cookie back. The console then says the session could not
  be started, which is true, and is not a second factor.
- **A second factor is the Worker's decision.** A first factor returns `{ twoFactorRedirect: true }`
  when it withheld the session, and `GET /v1/auth/challenge` answers whether a code challenge is live
  for this browser. The login page renders the code step only on those answers. A `?step=code` in the
  URL, or a session it could not read, is not evidence that an account owes a code.
- **Turning the authenticator off cleans up after itself.** The secret and the enabled flag go, and
  so do the sign-in challenges the account left outstanding, so a tab parked on the code step cannot
  keep asking for a code that no longer exists.

| Endpoint | Purpose |
|---|---|
| `GET /v1/auth/mode` | pre-auth configuration: which doors this deployment can finish |
| `GET /v1/auth/challenge` | is a sign-in challenge live for this browser (`{ pending }`) |
| `POST /v1/auth/redeem` | spend an invite and mint the first session |
| `POST /v1/auth/salt` | per-address salt and iteration count for client-side derivation |
| `POST /v1/auth/sign-in/password` | password first factor; `{ material }` in client-derived mode |
| `POST /v1/auth/magic-link` | request a link (the same 202 for known and unknown addresses) |
| `POST /v1/auth/magic-link/consume` | spend the link; answers `twoFactorRedirect`, or sets the session |
| `GET /v1/auth/me` | the account behind the session, or 401 |
| `/api/auth/*` | Better Auth itself: passkey and TOTP verification, sign-out |

## The phone

A real SMS app, not a config page: four frames behind a dock (**Threads · Device · Flows ·
Settings**), a conversation view with paging, a reply-only composer that counts GSM-7/UCS-2 segments,
and inline reply from the notification.

It is the **default SMS app** (role held), so it receives `SMS_DELIVER`, writes what it stores into
`content://sms`, and posts one silent notification per thread. A `remoteMessaging` foreground service
flushes pending rows every 15 minutes and returns after a reboot.

```bash
cd simulator
source ~/.config/dakflare/android-env.sh        # SDK 37, NDK 27, JDK 21, Rust targets
npx tauri android build --debug --apk --target aarch64
adb install -r -g app/build/outputs/apk/universal/debug/app-universal-debug.apk

../simulator/scripts/device-check.sh            # 8 checks against the handset
```

Release signing lives outside the repo: `~/.config/dakflare/dakflare-release.jks` with its password in
`release-keystore.txt` (both mode 600), driven by `simulator/scripts/release-apk.sh`. **Losing that key
means no future update can carry the same app id.** The certificate fingerprint is recorded in
`docs/PHONE_RELEASE.md`.

## Verifying it

```bash
dakflare doctor                                  # edge + handset, one screen
simulator/scripts/device-check.sh                # role, wrapped key, receive, provider, send,
                                                 # notification, foreground service, optional reboot
cd worker && node dakflare_test_harness.mjs pair && node dakflare_test_harness.mjs suite
cd simulator/core && cargo test
```

The harness covers pairing, admin, reply state, auth, replay, rules, console surface, the state
machine, websockets, ack timeout and the password factor — including a software WebAuthn authenticator,
so passkey assertions are real cryptography rather than a mock.

## Known gaps

- **MMS** is not supported; a push produces a notification saying so rather than vanishing.
- **Magic link** needs a sender. `RESEND_API_KEY` turns the door on; without it `/v1/auth/mode` does
  not advertise the factor, because a door that cannot deliver a link would strand the login page.
- **TOTP enrolment needs a passkey**; a password-only account cannot turn it on.
- **`server-kdf`** is paid-tier only, by measurement.
- **A proxy in front of the console breaks the cookie**, not the sign-in. The session cookie is
  host-only, so an http preview or a second hostname signs in on the Worker and keeps nothing; open
  the deployment's own HTTPS URL. `/admin/login` is honest about this: it reports that the session
  could not be started rather than asking for a code.
- **An older Worker without `/v1/auth/challenge`** makes the console drop the code step and show the
  doors. That is the safe direction: a challenge is never inferred.

## License

AGPL-3.0-only.
