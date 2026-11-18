# The state machines this app already has

Every subsystem here is a state machine. Most of them are not written down, which is
why an operator, a developer and an agent each learn them separately and disagree.
This file is the list: what the states are, what moves between them, and where the
rule lives.

Read the last column first. **Guarded** means one function or one SQL predicate owns
the transition, so a new route cannot invent a path. **Declared** means the schema
lists the states but nothing stops a writer from setting any of them. **Derived**
means there is no state column at all: the state is computed from timestamps and
counters at read time, and two readers must agree on the computation or they disagree
about the truth.

## Outbound delivery

| | |
|---|---|
| Machine | A command leaving the phone |
| States | `PENDING` → `LEASED` → `DISPATCHED` → `SENT` → `DELIVERED` / `FAILED`; `EXPIRED` from any unsettled state |
| Terminal | `DELIVERED`, `FAILED`, `EXPIRED` — no transition leaves them |
| Enforced in | `worker/src/durable-object.ts:124` (`ALLOWED_PREDECESSORS`), `:139` (terminal set) |
| Kind | **Guarded**, in SQL, per the note at `:112`: the guard is in the statement so it is atomic and cannot be bypassed from a new route |

This is the one machine in the codebase that is finished. `SENT` is not delivery and
the whole console agrees: a `DELIVERED` needs a status report, and five minutes of
silence after `SENT` settles the SMS row rather than claiming it (`SMS_SETTLED_GRACE_MS`).

The same rows are also read through a second, derived machine:

| | |
|---|---|
| Machine | Canonical lifecycle tuple `(state, substate, is_terminal, settled, remediation)` |
| States | `QUEUED`, `LEASED_OR_DISPATCHING`, `ACCEPTED_BY_CHANNEL`, `DELIVERED`, `READ`, `SETTLED_SENT`, `FAILED_PERMANENT`, `EXPIRED`, `RETRY_BACKOFF`, `FALLBACK_TRIGGERED` |
| Enforced in | `worker/src/lib/canonical-lifecycle.ts:11`, `computeCommandLifecycle` |
| Kind | **Derived** — a pure mapping from the raw state, so it cannot drift from storage, but every surface that reads it must use the same function |

## Inbound reply fate

| | |
|---|---|
| Machine | What happened to the auto-reply to one inbound message |
| States | `queued`, `sent`, `failed`, `delivered`, plus `null` for "the phone reported nothing" |
| Enforced in | `worker/src/routes/incoming.ts:64` (`REPLY_STATES`), `readReplyState` at `:79` |
| Kind | **Guarded at the edge**: an unknown state or a non-string error fails the batch instead of being dropped. A dropped state is exactly the unanswered-looking row the endpoint exists to prevent |

`reply_verdict` is a second axis on the same row (`suppressed_cooldown`,
`suppressed_hourly_cap`, `0004_provenance.sql:28`): the reply was not sent, and the
column says why. Empty means it was not suppressed.

## Device radio

| | |
|---|---|
| Machine | One SIM's radio |
| States | `READY`, `DEGRADED`, `NO_SERVICE`, `LOCKED` |
| Enforced in | `0002_v6_enterprise_and_hardening.sql:144` (`device_sims.radio_state`) |
| Kind | **Declared** — a `CHECK` stops a typo, nothing stops a writer moving `LOCKED` to `READY` without the lock being released |

The accompanying facts are timestamps, not states: `devices.paired_at`,
`devices.last_seen`, `devices.archived_at`. "Offline" is derived from `last_seen`
against a threshold, which is why the console, the CLI and the motif page must use one
threshold function or they disagree about the same phone.

## Conversation window (multi-platform)

| | |
|---|---|
| Machine | Whether a channel may be answered freely |
| States | `NO_SESSION`, `WINDOW_OPEN`, `TEMPLATE_ONLY`, `OPTED_OUT` |
| Enforced in | `0007_multi_platform_and_conversations.sql:23` (`conversations.session_state`) |
| Kind | **Declared** — the most consequential of the declared ones, because `OPTED_OUT` and `TEMPLATE_ONLY` are policy, not telemetry |

## Pairing

| | |
|---|---|
| Machine | One handset joining the deployment |
| States | code `issued` → `claimed` (single use) → `expired`; device `unpaired` → `paired` → `archived` |
| Storage | `pairing_codes` (`0001_baseline.sql:103`): `expires_at` plus `claimed_at`, so single use is a timestamp rather than a state |
| Kind | **Derived** from `expires_at` plus the row's consumption. The claim path is the only writer, so in practice the machine is guarded by having one entry point |

## Approval request

| | |
|---|---|
| Machine | A human answering an agent's ask |
| States | `PENDING` → `APPROVED` / `REJECTED`; `EXPIRED`, `CANCELLED` |
| Enforced in | `0003_agent_control_plane.sql:82` (`CHECK`) |
| Kind | **Declared**. The transition code lives in the route, so the invariant "only `PENDING` may be approved" is a predicate a new caller has to remember |

## Authority grant

| | |
|---|---|
| Machine | Permission for one effect class on one target, for one token |
| States | live → `revoked` (`revoked_at`) → `expired` (clock) → `exhausted` (`use_count` ≥ max) |
| Enforced in | `0003_agent_control_plane.sql:121`; one-live-grant-per-scope unique index at `:144`; decided in `worker/src/agent/grants.ts:250` |
| Kind | **Derived, and lossy.** There is no state column, so three different endings collapse into one refusal string, `grant_expired`. An operator asking "why was it refused" is told expiry when the answer may be revocation or exhaustion |

## Autonomy window

| | |
|---|---|
| Machine | Whether the runtime may act without a click |
| States | `off`, `open`, `expired` (clock), `other-session` (opened by a different operator) |
| Enforced in | `0003`/`0012` schema; decided in `worker/src/agent/grants.ts:166` onward |
| Kind | **Derived.** Stored as `enabled` + `expires_at` + `actor` + caps; the state is recomputed on every act. Refusals are ordered cheapest-first and named (`autonomy_off`, `autonomy_expired`, `autonomy_other_session`, `no_grant`, `grant_expired`, `sms_cap`, `write_cap`, `webhook_cannot_act`) — this is the best-named machine in the app and the model for the others |

The window is deliberately *not* the grant: a window mints grants for the act classes it
covers, so revoking one grant does not close the window and closing the window does not
require walking the grants.

## Agent runtime ticket

| | |
|---|---|
| Machine | One browser socket's one-use credential |
| States | `issued` → `used` → `expired` |
| Storage | `agent_runtime_tickets` and `agent_runtime_ticket_uses` (`0011_agent_runtime.sql:13`, `:24`) |
| Kind | **Derived from two tables.** `valid = now < expires_at AND token_hash NOT IN uses`. Squatting a ticket needs a writer to insert into both correctly; nothing in the schema makes that atomic |

This is the machine with the widest blast radius per mistake: a reusable ticket is a
socket for anyone who reads one log line.

## Agent turn

| | |
|---|---|
| Machine | One question's life |
| States | `opening` → `streaming` (tokens, tool calls) → `answered` / `refused` / `lost` |
| Enforced in | `worker/src/agent/*` (frames), `dashboard/src/lib/agent-socket.ts` (client mirror) |
| Kind | **Implicit on both sides.** The server emits frames; the client decides when a turn is terminal and whether a dropped link is resumable. `lost` exists only in the console, which is why its announcement was the one branch a screen reader never heard |

A turn also carries a durable stream id, so "resume" is a real state rather than a
retry — and `Try again` must reuse the turn key or it buys a second model call.

## Assistant proposal

| | |
|---|---|
| Machine | A change the assistant prepared and did not apply |
| States | `pending` → `consumed` (`consumed_at`) / `expired` (`expires_at`) |
| Enforced in | `0009_ai_assistant.sql:52`; claim at `worker/src/routes/assistant.ts:2037` (`WHERE id = ? AND consumed_at IS NULL`) |
| Kind | **Guarded at the claim.** The predicate is the whole idempotency story: two Accept clicks race and exactly one wins |

Proposals made *because an act was refused for authority* are a different fact from
proposals made because a model chose to propose, and until `origin` existed on the
payload the card could not say which. Same states, two causes.

## Webhook delivery

| | |
|---|---|
| Machine | One signed inbound call |
| States | `running` → `succeeded` / `failed`; a replay of the same delivery returns the recorded answer |
| Enforced in | `0015_webhooks.sql:40`; `worker/src/routes/webhooks.ts:366` (replay) |
| Kind | **Guarded for replay, declared for status.** `webhook_cannot_act` keeps a webhook actor from mutating authority, so this machine can answer but not act |

## Budgets and counters

| | |
|---|---|
| Machine | Daily AI spend and daily SMS/write caps |
| States | none — a day key and counters |
| Enforced in | `0009_ai_assistant.sql:74` (`ai_usage`, UTC `YYYY-MM-DD`), `0012_agent_autonomy.sql:30` (`agent_usage`) |
| Kind | **Derived** by rollover. The UTC key is deliberate: a local-midnight reset moves twice a year. Caps are per window, so two windows in one day double the ceiling unless a deployment-wide cap exists |

## Scheduled work

| | |
|---|---|
| Machine | One alarm-queue row |
| States | `pending` → `running` → `consumed` / `rescheduled` (with backoff) → `dead_letters` at 5 attempts |
| Enforced in | `worker/src/durable-object.ts:100` (`ScheduledTaskRow`), `:141` (`MAX_TASK_ATTEMPTS`) |
| Kind | **Guarded** — a dead letter is a terminal absence, and the attempt ceiling is what stops a poisoned task from spinning forever |

## Auth

| | |
|---|---|
| Machine | Failed sign-ins and lockout |
| States | `ok` → `counting` → `locked` (`AUTH_LOCKOUT_WINDOW_SECONDS`) |
| Enforced in | `worker/src/lib/auth-limits.ts`, `AuthGuard` |
| Kind | **Guarded**, in a single globally named object — the counter is global, not per IP, which is a decision worth knowing when debugging a "random" lockout |

## What is worth fixing, ranked

1. **`grant_expired` hides three endings.** `expired`, `revoked` and `exhausted` are
   different actions for the operator (renew, re-ask, raise the cap). One string teaches
   them the machine is arbitrary. Split the reason; the console already renders reasons.
2. **`radio_state`, `session_state` and `installed_plugins.status` are declared, not
   guarded.** They are the three where a wrong value changes what the product does
   (send, reply, run). A transition table per column, checked in one place, is cheaper
   than the bug where `OPTED_OUT` becomes `WINDOW_OPEN`.
3. **The validity of a ticket is a two-table join.** If it is worth a ticket at all it is
   worth one row: `used_at` on the ticket, updated with the same predicate that checks it.
4. **The turn's terminal state lives only in the client.** The server emits frames and
   never records that a turn ended, so "was this answered" cannot be asked server-side.
   The conversation read being added now fixes the visible half of this; it does not fix
   the audit half.
5. **"Offline" has two sources of truth.** The alert threshold is one config value
   (`offlineAlertMs`, fifteen minutes, `worker/src/lib/config.ts:31`), while presence in
   the device UI is its own set of shapes (`DeviceDetail.svelte`). They can disagree
   about the same phone in the same minute. One function, imported by both.
