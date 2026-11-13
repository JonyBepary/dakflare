# DakFlare

> **A sovereign multi-platform messaging hub and SMS gateway on Cloudflare and Android.**
>
> DakFlare pairs a dedicated Android handset with your own Cloudflare account (Workers, Durable
> Objects, D1, Queues, Workflows) and turns it into an SMS gateway, a conversation hub for Telegram
> and WhatsApp, and an agent-operable control plane. No third-party telecom SaaS, no per-message
> markup, no shared secret between the phone and the edge.

The handset is the radio. The Worker is the coordinator. The console is where an operator watches
both.

## Why "DakFlare"

**DakFlare** combines *Dāk* (ডাক, the relay-runner dispatch network that carried urgent letters across
Bengal station by station) with the **Cloudflare** edge where the coordinator lives.

## Shape

| Layer | Role |
|---|---|
| **Android app** (Tauri + Rust core) | Owns the SIM, is the default SMS app, holds a P-256 identity wrapped by Android Keystore, runs the flow engine on-device, mirrors what it did |
| **Worker** | Verifies every device request against a canonical string and a replay guard, serves the console, hosts accounts, channels, flows and the agent control plane |
| **Durable Objects** | `DeviceGateway` per handset (command queue, replay nonces, ack and offline alarms), `AuthGuard` (account lockout), `AuthorityGuard` (grant windows) |
| **D1** | Fleet, messages, conversations, rules, flows, agents, approvals, grants, audit. Seven migrations, `0001` through `0007` |
| **Queues and Workflows** | `dakflare-webhook-queue` for outbound webhooks; `FlowExecutionWorkflow` for flow delays longer than five seconds |
| **Channels** | SMS through the handset, Telegram and WhatsApp Cloud webhooks, all stored as conversations |
| **KV** | FCM bearer-token cache |

Device auth is not a shared secret: each phone signs `METHOD\nPATH\nTIMESTAMP\nNONCE\nSHA256(body)`
with a P-256 key whose at-rest form is `keystore:v1:<iv>:<ciphertext>`, wrapped by a non-exportable
AndroidKeyStore AES-GCM key. A copied database alone cannot impersonate the phone.

## Repository map

| Path | What |
|---|---|
| `worker/` | the Worker, D1 migrations, Durable Objects, channels, flow engine and MCP server |
| `dashboard/` | the SvelteKit console, built into `worker/public/admin` and served at `/admin` |
| `cli/` | `dakflare`, a zero-dependency Node 22+ operator CLI |
| `simulator/` | the Android app (Tauri + Rust core, Kotlin telephony, Svelte UI) and the on-device flow engine |
| `design/` | design tokens and the token preview |
| `docs/` | the master spec, runbooks, console and workflow notes, and `history/` for point-in-time plans |
| `skills/` | four `SKILL.md` packages for agents: provision, messaging, flows, agents |
| `contracts/` | the MCP tool contract (`mcp-tools.json`) |
| `test-support/` | local dev stack, protocol and flow vectors, platform and skills gates |

## Quick start

```bash
git clone https://github.com/JonyBepary/dakflare
cd dakflare

# 1. the edge
cd worker && npm install
cp wrangler.template.toml wrangler.toml
cp cloudflare.config.template.ts cloudflare.config.ts
npx wrangler d1 create sms_gateway              # paste database_id into wrangler.toml
npx wrangler kv namespace create KV             # paste the id into wrangler.toml
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

`cf` is the deploy path. `wrangler` stays for local dev, `tail`, `secret put` and `d1 export`, because
`cf` cannot set one secret or stream logs yet.

CI runs the same checks on every pull request; it does not deploy. Deploy from a clean tree with
`npm run deploy`, which builds the console first. Migrations are applied by hand, never by the
pipeline. `docs/OPS_DEPLOY.md` has the jobs, the secrets, the order of operations and the rollback.

Then, from anywhere:

```bash
npm install -g .            # or: node cli/bin/dakflare.js ...
dakflare init               # stores the URL + token in ~/.config/dakflare/config.json (mode 600)
dakflare up                 # provision resources, deploy, create the owner and pair a phone
```

Or step by step:

```bash
dakflare doctor                                   # config, health, schema, migrations, bindings, phone
dakflare auth bootstrap --email you@example.com   # prints the one-time owner invite
```

Open that invite in a browser, redeem it, create a passkey. That account is the owner.

## The console

SvelteKit, prerendered to static assets and served by the Worker at `/admin`, hand-written CSS over a
token system (`design/tokens.css`: primitive, semantic, component). Warm cream surfaces, pastel
containers that never carry body text, one coral action per screen, mono for anything an operator
compares with a log.

- **Overview**: deployment health, fleet, the quiet panel, the rules-vs-flows pipeline.
- **Devices / Messages**: the fleet with five states, and a message log that says who answered and
  what happened to that answer (`Delivered · Sent · Queued · Failed, reason`).
- **Automation**: rules as one sentence each, workflows on a canvas.
- **Approvals**: the queue of time-boxed authority an agent is waiting for, with the duration ladder.
- **Audit log**: every privileged action, who took it and what it touched.
- **Security**: sign-in factors (passkey, authenticator, password) and invites.

### Layout

The console measures its content column, not the window. The rail takes 249 px, so a 914 px window
leaves the page about 616 px, and a table that assumes the window will collapse there even though the
browser reports a wide viewport.

- Tables switch to stacked rows on a **container query** over their card, never on `@media`.
- The fleet table needs a 966 px card (about a 1282 px window) for its six columns. Below that the fleet
  is a stacked card, not a squeezed table.
- Wide grids give the name column a floor and let the device id ellipsize on one line. The open arrow
  rides the id line, outside the ellipsis, so it stays visible wherever the id clips.
- The login page and every console page were measured at 390, 768, 914, 1024 and 1440: no horizontal
  overflow, and the action buttons stay inside their card at every width.

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
- **Turning the authenticator off cleans up after itself.** The secret and the enabled flag go, and so
  do the sign-in challenges the account left outstanding, so a tab parked on the code step cannot keep
  asking for a code that no longer exists.

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

## Agent control plane

An agent never holds the admin token. It holds a `dkf_agt_` token minted with a scope set, and every
irreversible action also needs a live, time-boxed grant that a human approves in the console or with
`dakflare auth approve`.

- **Tokens**: `dakflare auth mint-agent-token --name ci --scope sms:send,devices:read`. The token is
  printed once; D1 stores a digest. `dakflare auth agent-tokens` lists them, and
  `dakflare auth revoke-agent-token <id>` stops one on its next request.
- **Scopes**: reads (`messages:read`, `devices:read`, `flows:read`, `audit:read`), cheap writes
  (`sms:send`, `rules:write`, `flows:write`, `alerts:write`, and others), and the costly four
  (`sms:send:production`, `flow_deploy_prod`, `dlq_bulk_replay`, `enable_shortcode`). `devices:revoke`
  and `auth:reset` are not scopes at all, so neither a token nor a grant can hold them.
- **Grants**: a ladder of 1m, 5m, 15m, 30m, 1h, 1d, 7d and 30d, capped per scope. Production SMS is
  capped at one hour and must name recipients or a device; a production flow deploy, a rules write and
  a bulk DLQ replay are capped at one day or less.
- **Approvals**: `GET /v1/admin/approvals`, the console's Approvals page, and
  `dakflare auth approvals|approve|reject`. A request that loses the race is told who answered first.
- **Grants on record**: `dakflare auth grants [--live]` and `dakflare auth grants revoke <id>`.

### MCP

`POST /v1/mcp` serves seven tools over the same token: `list_devices`, `read_messages`,
`command_status`, `list_flows`, `get_flow`, `trace` and `send_sms`. The bearer is a static `dkf_agt_`
token, and this is deliberately not MCP authorization: there is no OAuth 2.1 resource server here, so
a conformant OAuth client cannot negotiate it. `dakflare mcp serve` bridges the same tools over stdio.

## Flows

A flow is a canonical IR document, not a canvas blob. Nine node kinds (`trigger`, `extract`,
`set_var`, `condition`, `switch`, `delay`, `webhook`, `send_sms`, `stop`), a dry-run that prints a
structural diff before a write, and a layout the Worker computes from the graph, so an agent can
author a flow without knowing anything about coordinates.

- `dakflare flows apply <file> [--dry-run]` writes one document and prints the diff.
- `dakflare extract synthesize --samples <file>` derives a regex from real messages and proves it
  against the negatives.
- Drift alerts (`extraction_drift`) fire when a stored pattern stops matching traffic.
- The editor has two surfaces (`Steps` and `Map`) and a read-only `Source` sheet; `PatternSheet`
  explains a pattern with live samples.

The same engine also compiles to WebAssembly (`simulator/flow-wasm`), so the handset can evaluate a
flow locally instead of waiting for the network.

## Provenance

- `dakflare trace <id>` explains a message, command or approval request across D1, the Durable Object
  and the audit log.
- `dakflare alerts` lists open operator alerts, newest first; the console can acknowledge them.
- `dakflare dlq <device>` reads a device object's dead letters.
- `dakflare ws inspect <device>` shows a device's live sockets.

## Channels

`worker/src/channels` has three adapters. SMS goes through the paired handset; Telegram and WhatsApp
Cloud arrive as webhooks (`/v1/channels/telegram/webhook`, `/v1/channels/whatsapp/webhook`) and are
stored as conversations (`0007`), so the console and the flow engine see one message model.

## The phone

A real SMS app, not a config page: four frames behind a dock (**Threads · Device · Flows · Settings**),
a conversation view with paging, a reply-only composer that counts GSM-7/UCS-2 segments, and inline
reply from the notification.

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

## CLI

`dakflare` is zero-dependency, speaks one compact JSON document under `--agent`, never prompts and
never colours. Twenty-three commands:

- **Provision**: `init`, `up`, `doctor`, `pair`, `devices`, `revoke`.
- **Messaging**: `send`, `status`, `audit`.
- **Accounts and agents**: `auth bootstrap|invite|invites|reset|mint-agent-token|agent-tokens|revoke-agent-token|approvals|approve|reject|grants`.
- **Automation**: `flows apply`, `rules apply|test`, `extract synthesize`.
- **Provenance**: `trace`, `alerts`, `dlq`, `ws inspect`.
- **Contract**: `capabilities`, `describe`, `schema` (including `schema states`), `examples`,
  `mcp serve`, `key fingerprint`.

Exit codes are semantic: `0` ok, `1` failed, `2` usage, `3` not found, `4` permission, `5` conflict,
`6` precondition, `75` still in flight. A send is asynchronous: `send` waits 10 s and exits from the
outcome, `--no-wait` returns as soon as the deployment queues it, and exit `75` means check `status`,
never send again.

## Skills for agents

`skills/dakflare-provision`, `skills/dakflare-messaging`, `skills/dakflare-flows` and
`skills/dakflare-agents` are `SKILL.md` packages that teach an agent the CLI contract, the async send
rule (`SENT` is not delivery) and the authority model. Install them with `npx skills add` or point an
agent at the folder.

## Verifying it

```bash
dakflare doctor                                  # edge + handset, one screen
simulator/scripts/device-check.sh                # role, wrapped key, receive, provider, send,
                                                 # notification, foreground service, optional reboot
cd worker && node dakflare_test_harness.mjs pair && node dakflare_test_harness.mjs suite
cd simulator/core && cargo test
```

Harness modes: `selftest`, `verify-vectors`, `pair`, `suite`, `hardening`, `multidevice`, `auth`,
`password`, `lockout-global`, `password-rotate`, `magic`, `proxy`, `ws`, `stub` and `reset`. The suite
covers pairing, admin, reply state, auth, replay, rules, console surface, websockets, ack timeout and
the password factor, including a software WebAuthn authenticator, so passkey assertions are real
cryptography rather than a mock. `test-support/` holds the dev stack and the shared vectors.

## Known gaps

- **MMS** is not supported; a push produces a notification saying so rather than vanishing.
- **Magic link** needs a sender. `RESEND_API_KEY` turns the door on; without it `/v1/auth/mode` does
  not advertise the factor, because a door that cannot deliver a link would strand the login page.
- **TOTP enrolment needs a passkey**; a password-only account cannot turn it on.
- **`server-kdf`** is paid-tier only, by measurement.
- **`MEDIA_BUCKET` and `AI` are bound but unused**; no Worker route reads media or calls a model yet.
- **A proxy in front of the console breaks the cookie**, not the sign-in. The session cookie is
  host-only, so an http preview or a second hostname signs in on the Worker and keeps nothing; open
  the deployment's own HTTPS URL. `/admin/login` is honest about this: it reports that the session
  could not be started rather than asking for a code.
- **An older Worker without `/v1/auth/challenge`** makes the console drop the code step and show the
  doors. That is the safe direction: a challenge is never inferred.

## License

AGPL-3.0-only.
