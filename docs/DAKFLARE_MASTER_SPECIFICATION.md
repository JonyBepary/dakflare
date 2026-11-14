# DakFlare: master system specification

> Scope: the repository as it exists on 2026-11-14. Version 6.1.0 in `worker/package.json`,
> `dashboard/package.json` and the CLI envelope.
>
> This document describes what is built. The forward-looking multi-platform proposal is
> `MULTI_PLATFORM_AI_HUB_SPEC.md`; point-in-time plans and contracts are in `history/`.

## 1. What DakFlare is

One Android handset, one Cloudflare Worker, one operator console. The handset is the radio: it holds
the SIM, is the default SMS app, and signs every request with a P-256 key that never leaves Android
Keystore. The Worker is the coordinator: it verifies the wire, queues commands, runs automation, and
holds accounts, channels, flows and the agent control plane. The console is where a person watches
both.

The same Worker can carry Telegram and WhatsApp Cloud conversations alongside SMS. A conversation is
one row keyed by `(channel, account_id, peer_id)`, and an inbound message from any channel enters the
same rules-then-flows pipeline.

## 2. Topology

| Component | What runs there |
|---|---|
| `worker/` | the edge: request verification, admin API, auth mount, channels, flow engine, MCP |
| `simulator/` | the Android app: Tauri v2 shell, Rust core, Kotlin telephony, Svelte UI, on-device flow engine |
| `dashboard/` | the console: SvelteKit with `adapter-static`, built into `worker/public/admin` |
| `cli/` | `dakflare`: zero-dependency Node 22+ operator CLI |
| `design/` | design tokens and the token preview |
| `skills/` | four `SKILL.md` packages for agents |
| `contracts/` | the MCP tool contract |
| `test-support/` | dev stack, vectors, gates, stubs |

### 2.1 Worker bindings

| Binding | Class or resource | Role |
|---|---|---|
| `DB` | D1 `sms_gateway` | every durable row |
| `KV` | KV namespace | FCM bearer-token cache |
| `DEVICE` | Durable Object `DeviceGateway` | command queue, replay guard, alarms, sockets |
| `AUTH_GUARD` | Durable Object `AuthGuard` | account and IP lockout counters |
| `AUTHORITY_GUARD` | Durable Object `AuthorityGuard` | live grant windows |
| `WEBHOOK_QUEUE` | Queue `dakflare-webhook-queue` | outbound webhook delivery |
| `FLOW_WORKFLOW` | Workflow `flow-execution-workflow` | delays longer than five seconds |
| `MEDIA_BUCKET` | R2 `dakflare-media` | declared; no route reads it yet |
| `AI` | Workers AI | declared; no route calls a model yet |
| `ASSETS` | `public/` | the console and the landing page |
| limiters | `PAIR`, `ADMIN`, `DEVICE`, `AUTH_FAIL`, `PAIR_GLOBAL`, `AUTH_ACCOUNT`, `AUTH_IP` | request budgets |

Three Durable Objects, one queue, one workflow. The DO classes are one-way doors: adding or renaming
one lands with a deploy and only after the `exports` list matches every live class.

## 3. Device protocol

### 3.1 Signed request

Every device request carries:

```
METHOD
PATH
TIMESTAMP
NONCE
SHA256(body)
```

signed with the handset's P-256 key. The Worker rebuilds the canonical string, checks the timestamp
window, verifies the signature, and spends the nonce through the device's Durable Object. A request
outside the window, a reused nonce, or a signature that does not cover the body is refused before any
write.

The private key is stored as `keystore:v1:<iv>:<ciphertext>`, wrapped by a non-exportable
AndroidKeyStore AES-GCM key. D1 holds the public key. A copied database cannot impersonate the phone.

### 3.2 Pairing

`POST /v1/device/pair` spends a pairing code minted by `dakflare pair` or the console. A new device
waits for approval on the handset and in `GET /v1/device/approvals`; an approved device appears in
`GET /v1/devices`. Revoking removes the public key in D1 and reaches the device's Durable Object, so
the phone must pair again.

### 3.3 Delivery

| Path | Use |
|---|---|
| `GET /v1/device/ws` | the persistent socket: `hello`, command batches, acks, pings |
| `POST /v1/sms/outgoing/poll` | the fallback when the socket is down |
| `POST /v1/sms/status/batch` | status updates for commands already dispatched |
| `POST /v1/sms/incoming/batch` | inbound SMS, idempotent by `local_id` |

A queued command is `PENDING`. The device gateway leases it (`LEASED`), dispatches it (`DISPATCHED`),
and the handset reports the radio outcome (`SENT`). A carrier report moves it to `DELIVERED`. `FAILED`
and `EXPIRED` are terminal; `EXPIRED` comes from a lease that was never acked. The production lease is
60 seconds and the ack timeout 8 seconds; CI shortens both so the timers can be told apart.

A stale ack must not move a terminal command backwards. A lease that expires returns the command to
`PENDING` without duplicating a dispatch. A command is never delivered twice on the socket.

### 3.4 Command states

```
PENDING -> LEASED -> DISPATCHED -> SENT -> DELIVERED
                    \-> FAILED
PENDING | LEASED | DISPATCHED -> EXPIRED
```

### 3.5 Device presence

| State | Condition | Reading |
|---|---|---|
| `live` | socket connected | reachable now |
| `synced` | no socket, `last_seen` within 15 minutes | reachable on the next poll |
| `stale` | `last_seen` within 24 hours | may be asleep |
| `offline` | `last_seen` older than 24 hours, or never | not answering |
| `unknown` | no `last_seen` | never synced since pairing |

Wake capability is separate: `push` when an FCM token is present, `poll-only` otherwise. Offline plus
poll-only is the state that raises an offline alert.

## 4. Authentication and sessions

### 4.1 Factors

| Factor | Route | Notes |
|---|---|---|
| Passkey | `/api/auth/passkey/*` | primary; WebAuthn registration and assertion |
| TOTP | `/api/auth/two-factor/verify-totp`, `/v1/auth/totp/*` | optional; enrolment needs a passkey assertion or a current code |
| Password | `/v1/auth/sign-in/password` | client-derived PBKDF2 (210,000 rounds) under `AUTH_PASSWORD_MODE=client-derived` |
| Magic link | `/v1/auth/magic-link`, `/consume` | sender-gated; the token is spent by the button, never by opening the page |
| Invite | `/v1/auth/redeem` | the only way an account is created |

`AUTH_MODE` selects the admin gate: `legacy` exchanges `ADMIN_TOKEN` for a console session cookie,
`new` uses Better Auth accounts and `requireRole()`. The console reads `/v1/auth/mode` before it draws
the doors.

### 4.2 Session

A signed-in browser holds `__Secure-better-auth.session_token`: HttpOnly, Secure, `SameSite=Lax`,
host-only, seven days. The value is `<token>.<HMAC-SHA256(BETTER_AUTH_SECRET, token)>`, URL-encoded;
D1 stores the token and the session row. Better Auth also caches the session in a signed
`session_data` cookie for five minutes; `requireRole({ fresh: true })` reads D1 instead. The legacy
console cookie is `dakflare_admin`, `SameSite=Strict`.

The cookie is host-only: a proxy or a second hostname gets its own jar, signs in on the Worker, and
keeps nothing. The login page reports that the session could not be started rather than asking for a
second factor.

### 4.3 Roles and sensitive actions

Roles are `owner`, `admin` and `member`. The nav hides Approvals, Audit log and Security from a member;
the routes refuse them independently. A sensitive action (change factors, rotate a pepper, reset an
account) asks for a fresh read of the session, not the five-minute cache.

The lockout authority is the `AuthGuard` Durable Object: a fixed attempt budget per account and per
IP, with the Worker's route checking it before a password or code is verified. The two-factor plugin's
own lockout is disabled so there is one window, not two.

### 4.4 Second-factor handshake

A first factor that must withhold the session answers `{ twoFactorRedirect: true,
twoFactorMethods: ["totp"] }` and sets a signed challenge cookie and a verification row.
`GET /v1/auth/challenge` answers whether a live challenge exists for this browser. The login page
shows the code step only when the Worker says so; a `?step=code` in the URL or an unreadable session is
not evidence. Disabling TOTP deletes the secret, the flag and any outstanding challenges.

## 5. Agent control plane

An agent never holds the admin token.

### 5.1 Tokens

`dakflare auth mint-agent-token --name ci --scope sms:send,devices:read` prints a `dkf_agt_` token
once; D1 stores a SHA-256 digest. The token has an hourly SMS budget (20 by default) and can be
revoked; a revoked token is `401` on its next request.

Scopes:

| Reads | Cheap writes | Always need a grant |
|---|---|---|
| `messages:read`, `devices:read`, `flows:read`, `audit:read` | `sms:send`, `messages:purge`, `alerts:write`, `flows:write`, `devices:write`, `rules:write`, `webhooks:write` | `sms:send:production`, `enable_shortcode`, `dlq_bulk_replay`, `flow_deploy_prod` |

`devices:revoke` and `auth:reset` are not scopes. No token and no grant can hold them.

### 5.2 Grants

A grant is time-boxed authority over a scope and a target. The ladder is 1m, 5m, 15m, 30m, 1h, 1d,
7d, 30d, and the ceiling per scope is lower:

| Scope | Ceiling | Target |
|---|---|---|
| `sms:send:production` | 1 hour | recipients or a device |
| `enable_shortcode` | 15 minutes | rule |
| `dlq_bulk_replay` | 15 minutes | device |
| `flow_deploy_prod` | 1 day | flow |
| `flows:write`, `rules:write`, `webhooks:write` | 1 day | flow, or free-form |
| `messages:read`, `devices:read` | 30 days | free-form |

A request that asks for 30 days on production SMS is answered with `requested_s: 2592000,
granted_s: 3600, clamped: true`. A decision is claimed atomically; the loser of the race is told who
answered first (`request was already approved by <actor>`).

### 5.3 Approvals

`approval_requests` moves `PENDING` to `APPROVED`, `REJECTED`, `EXPIRED` or `CANCELLED`. The console's
Approvals page and `dakflare auth approvals|approve|reject` answer the queue. An approval that is
answered elsewhere is removed with the reason, not silently. The same page lists the **live grants**
the queue has minted, with a countdown and a revoke (`GET /v1/admin/grants?live=1`,
`DELETE /v1/admin/grants/:id`); `dakflare auth grants` reads the same table.

### 5.4 MCP

`POST /v1/mcp` serves seven tools over the same token:

`list_devices`, `read_messages`, `command_status`, `list_flows`, `get_flow`, `trace`, `send_sms`.

`send_sms` uses multi-round-trip: with no grant it returns `input_required` naming the approval
request; the retry re-reads the grant store, so a client cannot widen its own permission. The bearer
is a static `dkf_agt_` token and this is deliberately not MCP authorization: there is no OAuth 2.1
resource server, and a conformant OAuth client cannot negotiate it. `dakflare mcp serve` bridges the
same tools over stdio.

## 6. Automation

### 6.1 Rules, then flows

For each accepted inbound message that the device did not already answer, the Worker evaluates rules
by `priority DESC`. The first matching rule inside its cooldown and hourly cap replies and stops the
pipeline. If no rule replied, the flow pipeline runs. A device that replied itself suppresses both.
`reply_source` and `reply_ref` on the message row answer "what replied?".

A rule is one matcher, one reply template, a cooldown and an hourly cap. On save it compiles to a flow
graph and runs through the same interpreter as a workflow. A rule that compiles to an invalid graph is
refused with `rule_rejected`.

### 6.2 Flow IR

A flow is a canonical document, not a canvas blob:

```
{ id, name, graph: { nodes: [{ id, type, data }], edges: [{ id, source, target, sourceHandle? }] },
  device_id?, enabled?, expected_previous_version? }
```

Nine node kinds: `trigger`, `extract`, `set_var`, `condition`, `switch`, `delay`, `webhook`,
`send_sms`, `stop`. An unknown kind round-trips as `unsupported` so an older console cannot destroy a
newer flow.

| Limit | Value |
|---|---|
| Nodes | 200 |
| Edges | 400 |
| Switch cases | 8 plus default |
| SMS body | 4,096 characters |
| Delay | 300 seconds |
| Topology | acyclic |

Validation refuses a cycle with the edge and the node it returns to, and refuses a variable that is
not bound on every path (the intersection of the variables guaranteed by every incoming edge). The
Worker ranks nodes by longest distance from the trigger, so no coordinates are needed to save a flow.

### 6.3 Execution

The handset runs the graph first, synchronously and offline, in the Rust engine
(`simulator/flow`). The same engine compiles to WebAssembly at `worker/src/wasm/flow.wasm` and
`simulator/flow-wasm`; the console runs the same binary in its simulation panel.

`delay` and `webhook` are the steps the handset cannot finish alone. A delay over five seconds becomes
a `FlowExecutionWorkflow`; a webhook goes through `WEBHOOK_QUEUE`, with an SSRF guard that refuses
private and metadata addresses. A run that the handset could not finish is marked `partial` and the
Worker continues it.

### 6.4 Drift

`extract_misses` records failed extractions. Two misses in an hour raise an `extraction_drift` alert
naming the flow and the capture group. `dakflare extract synthesize --samples <file>` derives a
replacement pattern and proves it against the samples and the negatives; `--verify-d1-limit` reports
how many recent messages it reaches. `dakflare flows heal <flow-id> --samples <file>` then re-checks
the pattern against the real history: every inbound body the old pattern matched must capture the
same value byte for byte, or nothing is written and the offenders are printed with exit `6`. The
write itself is `flows apply`, never a hand edit.

## 7. Channels and conversations

| Channel | Ingress | Notes |
|---|---|---|
| SMS | the paired handset | signed protocol, one phone per SIM |
| Telegram | `POST /v1/channels/telegram/webhook` | verifies `X-Telegram-Bot-Api-Secret-Token` |
| WhatsApp Cloud | `POST /v1/channels/whatsapp/webhook` | verifies `X-Hub-Signature-256`; 24-hour window |

A conversation is `(channel, account_id, peer_id)` with `session_state`, `window_expires_at` and
`last_inbound_at`. Inbound rows carry `channel` and `conversation_id`, so the console and the flow
engine see one message model. WhatsApp free-form text is refused outside the window with
`template_required`; `session_state` moves `NO_SESSION` to `WINDOW_OPEN` on an inbound, and to
`TEMPLATE_ONLY` when the window closes.

## 8. Data model

33 tables in production, grouped by job:

| Group | Tables |
|---|---|
| Fleet | `devices`, `device_sims`, `pairing_codes` |
| Messaging | `messages`, `conversations`, `rule_hits`, `flow_runs`, `integration_deliveries`, `financial_transactions`, `interactive_sessions`, `webhooks` |
| Automation | `rules`, `workflows`, `workflow_versions`, `audience_lists`, `audience_members`, `extract_misses` |
| Auth | `user`, `session`, `account`, `verification`, `twoFactor`, `passkey`, `invite`, `magic_link` |
| Agents | `agent_tokens`, `approval_requests`, `authority_grants` |
| Plugins | `plugin_repos`, `installed_plugins` (schema only) |
| Operations | `audit_log`, `alerts`, `d1_migrations` |

Retention: messages older than `MESSAGE_RETENTION_DAYS` (90 by default) are deleted by a cron in capped batches (10,000 rows per run), so a first-run backlog
cannot exhaust the D1 write budget. `audit_log` is append-only. `extract_misses` and `alerts` are
operator evidence, not cache.

A revoked device is a **tombstone**, not a deletion: `devices.revoked_at` is set, the public key and
FCM token are cleared, messages stay, and alerts and flow runs go. Re-pairing the same device id
revives the row. Migration `0008_revoked_devices.sql` adds the column; the schema is applied by hand
from `worker/migrations/0001..0008`, and `d1_migrations` records what ran.

## 9. Console

SvelteKit with `adapter-static`, served at `/admin`. Routes:

`/login`, `/invite`, `/enrol`, `/magic`, `/` (overview), `/devices`, `/messages`, `/rules`,
`/workflows`, `/workflows/edit`, `/approvals`, `/audit`, `/security`.

- **Overview**: deployment health, fleet, the quiet panel, the rules-vs-flows pipeline.
- **Devices**: the fleet with five presence states, a named group of revoked tombstones, and the
  device detail drawer. A revoked drawer is read-only and says how to pair again.
- **Messages**: the message log with delivery state, the reply lineage, and a trace for a command
  that failed or expired.
- **Automation**: rules and workflows; the editor has `Steps` (default), `Map` and a read-only
  `Source` sheet, with `Ctrl+K` finder, grouped undo, `Ctrl+S` and a leave guard.
- **Approvals**: the pending authority queue with the duration ladder, and the live grants already
  handed out, with a countdown and a revoke.
- **Audit log**: every privileged action.
- **Security**: factors, invites, recovery.

The layout measures its content column, not the window. The rail takes 248 px (249 with its rule), so
a 914 px window leaves 616 px. Tables switch to stacked rows on a container query over their card.
The fleet table needs a 966 px card, about a 1282 px window; below that it is a stacked card. The
device name keeps a 180 px floor and the id ellipsizes on one line, with the open arrow outside the
ellipsis. Measured at 390, 768, 914, 1024 and 1440 with no horizontal overflow.

## 10. CLI

`dakflare` is zero-dependency, speaks one compact JSON document under `--agent`, and never prompts or
colours. Twenty-three commands:

`init`, `up`, `doctor`, `pair`, `devices`, `revoke`, `send`, `status`, `audit`, `auth` (bootstrap,
invite, invites, reset, mint-agent-token, agent-tokens, revoke-agent-token, approvals, approve, reject,
grants), `flows apply|heal`, `rules apply|test`, `extract synthesize`, `trace`, `alerts`, `dlq`,
`ws inspect`, `capabilities`, `describe`, `schema`, `examples`, `mcp serve`, `key fingerprint`.

Exit codes: `0` ok, `1` failed, `2` usage, `3` not found, `4` permission, `5` conflict, `6`
precondition, `75` still in flight. A send waits 10 seconds by default and exits from the outcome;
`--no-wait` returns when the deployment queues it. `SENT` is not delivery; exit `75` means check
`status`, never send again.

## 11. Operations

- **Deploy**: `cd worker && npm run deploy`, which builds the console into `worker/public/admin` and
  runs `cf deploy`. CI runs six check jobs (`worker`, `skills`, `dashboard`, `simulator`, `rust`,
  `suite`) and does not deploy. No Cloudflare credential is in the repository.
- **Migrations**: by hand, from a machine signed in to `cf`, passing the database **id**, never the
  name. The preview lane uses `sms_gateway_preview` and `wrangler.account.toml`.
- **Secrets**: `ADMIN_TOKEN`, `BETTER_AUTH_SECRET`, `AUTH_PEPPER`
  (`v2:<base64 32 bytes>,v1:<base64 32 bytes>`), optional `RESEND_API_KEY` and
  `FCM_SERVICE_ACCOUNT_JSON`. They survive a deploy; `dakflare up` uploads them from
  `worker/.dev.vars`.
- **Backup**: D1 Time Travel for mistakes, `wrangler d1 export` for an off-account copy. A restore does
  not bring back the Durable Objects, KV, the handset's local database or the secrets; the runbook is
  `OPS_BACKUP.md`.
- **Budget**: DO requests bind first. One idle phone is roughly 96 alarms and 96 pings a day; a phone
  exchanging a few hundred SMS sits at a few percent of the free allowances. The retention cron is
  capped at 10 batches per run.

## 12. Testing and conformance

```bash
dakflare doctor
simulator/scripts/device-check.sh
cd worker && node dakflare_test_harness.mjs pair && node dakflare_test_harness.mjs suite
cd simulator/core && cargo test
```

Harness modes: `selftest`, `verify-vectors`, `pair`, `suite`, `hardening`, `multidevice`, `auth`,
`password`, `lockout-global`, `password-rotate`, `magic`, `proxy`, `ws`, `stub`, `reset`.

The harness is a separate implementation of the wire from the frozen contract; `protocol-vectors.json`
is the one published copy of the canonical and TOTP vectors, read by the harness, the Rust core and
the independent Python check. The suite covers pairing, admin, auth rejection, replay, the command
state machine, WebSocket delivery, ack timeout, rules, the password factor and a software WebAuthn
authenticator. `platform-gate.mjs` covers what a local run cannot: hibernation, keepalive, staleness
and a real deploy. `burst-probe.mjs` drives real batch sizes against a deployment.

## 13. Invariants and known gaps

Invariants:

- A device request is never accepted without a valid signature, an in-window timestamp and a fresh
  nonce.
- A command is never delivered twice on the socket; a stale ack never regresses a terminal state.
- A send is asynchronous; `SENT` is not delivery.
- An agent cannot hold `devices:revoke` or `auth:reset`, and a costly scope needs a live grant.
- The console measures its card, not the viewport.
- A revoked device cannot authenticate, be a send target, inherit workflows or be woken.
- Deploys are local; CI holds no Cloudflare credential.

Known gaps:

- **MMS** is not supported; a push produces a notification saying so.
- **Signal** and the Android notification bridge are not implemented.
- **Plugin registry and WASM sandbox** are not implemented; the tables exist.
- **R2 media and Workers AI** bindings are declared and unread by any route.
- **Magic link** needs `RESEND_API_KEY`; without it the factor is not advertised.
- **TOTP enrolment needs a passkey**; a password-only account cannot turn it on.
- **`server-kdf`** is paid-tier only, by measurement.
- **A proxy in front of the console breaks the cookie**, not the sign-in, because the session cookie
  is host-only.
