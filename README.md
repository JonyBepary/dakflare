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
npx wrangler secret put AUTH_PEPPER --name dakflare-worker      # v1:<base64 32 bytes>

# 3. deploy (builds the console into worker/public/admin first)
npm run deploy                                  # cf build + cf deploy; see docs/OPS_DEPLOY.md
```

`cf` is the deploy path. `wrangler` stays for local dev, `tail`, `secret put` and `d1 export`,
because `cf` cannot set one secret or stream logs yet.

CI runs the same checks on every pull request and deploys `main` when they pass. Migrations
are applied by hand, never by the pipeline. `docs/OPS_DEPLOY.md` has the jobs, the secrets,
the order of operations and the rollback.

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
| 3 | **Password** | optional; the KDF runs in the browser under `AUTH_PASSWORD_MODE=client-derived`, because a server-side PBKDF2 costs ~27 ms against the free tier's 10 ms CPU budget |

`AUTH_MODE` decides who guards `/v1/admin/*`: `legacy` (the `ADMIN_TOKEN`, exchanged for a session
cookie) or `new` (Better Auth accounts, `requireRole()`). Registration is invite-only — there is no
public sign-up. `dakflare auth invite` or the Security panel mints a single-use link; only its hash is
stored.

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
- **Magic link** is planned and unimplemented — it needs a sender, and this deployment has no domain.
- **TOTP enrolment needs a passkey**; a password-only account cannot turn it on.
- **`server-kdf`** is paid-tier only, by measurement.
- The console's pre-auth state cannot read `auth_mode` (health is behind the admin gate), so the login
  offers the token form first and the passkey door behind a live `/api/auth` probe.

## License

AGPL-3.0-only.
