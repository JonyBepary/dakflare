# The state machines this app already has

Every subsystem here is a state machine. Most of them were not written down, which is why an
operator, a developer and an agent each learned them separately and disagreed. This file is
the list: what the states are, what moves between them, and where the rule lives.

Read the last column first. **Guarded** means one function or one SQL predicate owns the
transition, so a new route cannot invent a path. **Declared** means the schema lists the
states but nothing stops a writer from setting any of them. **Derived** means there is no
state column: the state is computed from timestamps and counters at read time, and two
readers must agree on the computation or they disagree about the truth.

Corrected 2026-11-19 against the code, not against the previous version of this file. Three
entries here had been wrong since they were written — the proposal claim, the reply fate and
the agent turn — and the ticket and auth entries described implementations that do not exist.
An independent pass checked every claim; the ones it found false are fixed rather than
softened, and where the code has no writer for a declared state, this file now says so.

## Outbound delivery

| | |
|---|---|
| Machine | A command leaving the phone |
| States | `PENDING` → `LEASED` → `DISPATCHED` → `SENT` → `DELIVERED`; `FAILED` from `DISPATCHED` or `SENT`; `EXPIRED` from `PENDING`, `LEASED` or `DISPATCHED` |
| Terminal | `DELIVERED`, `FAILED`, `EXPIRED` — no transition leaves them |
| Enforced in | `worker/src/durable-object.ts:136` (`ALLOWED_PREDECESSORS`), `:147` (terminal set) |
| Kind | **Guarded**, in SQL, so the guard is atomic and cannot be bypassed from a new route |

This is the most finished machine in the codebase. `SENT` is not delivery and the console
agrees: a `DELIVERED` needs a status report, and five minutes of silence after `SENT` settles
the SMS row rather than claiming it (`SMS_SETTLED_GRACE_MS`).

`DELIVERED` accepts `DISPATCHED` as well as `SENT`, because a status report is evidence and
can arrive out of order; the handset does not re-send an ack, so requiring `SENT` stranded a
command forever. A late `SENT` after `DELIVERED` is a no-op, and `LEASED` is deliberately not
a delivery predecessor.

The same rows are also read through a second, derived machine:

| | |
|---|---|
| Machine | Canonical lifecycle tuple `(state, substate, is_terminal, settled, remediation)` |
| States | `QUEUED`, `LEASED_OR_DISPATCHING`, `ACCEPTED_BY_CHANNEL`, `DELIVERED`, `READ`, `SETTLED_SENT`, `FAILED_PERMANENT`, `EXPIRED`, `RETRY_BACKOFF`, `FALLBACK_TRIGGERED` |
| Enforced in | `worker/src/lib/canonical-lifecycle.ts:11` |
| Kind | **Derived** — a pure mapping from the raw state, so it cannot drift from storage, but every surface must use the same function |

## Inbound reply fate

| | |
|---|---|
| Machine | What happened to the auto-reply to one inbound message |
| States | `queued`, `sent`, `failed`, `delivered`, plus `null` for "the phone reported nothing" |
| Transitions | `null` → any; `queued` → `sent`/`delivered`/`failed`; `sent` → `delivered`/`failed`; `delivered` and `failed` are terminal |
| Enforced in | `worker/src/routes/incoming.ts:379` (predecessor guard in the upsert), `:64` (`REPLY_STATES`) |
| Kind | **Guarded** — an unknown state or a non-string error fails the batch instead of being dropped, and a late report cannot walk `delivered` backwards |

`reply_verdict` is the second axis on the same row: `suppressed_cooldown` or
`suppressed_hourly_cap` (`0004_provenance.sql:28`). The reply was not sent, and the column says
why. Empty means it was not suppressed. A dropped state is exactly the unanswered-looking row
the endpoint exists to prevent.

## Device radio

| | |
|---|---|
| Machine | One SIM's radio |
| States | `READY`, `DEGRADED`, `NO_SERVICE`, `LOCKED` |
| Enforced in | `0002_v6_enterprise_and_hardening.sql:144` (`device_sims.radio_state`) |
| Kind | **Declared, with no writer.** Nothing in the tree inserts or updates `device_sims`; the column is read (`routes/agent.ts:285`) and never written |

An empty state column that a reader honours is worse than no column: a surface can show
`READY` for a radio nobody has asked. Either the handset starts reporting it or the column
goes. "Offline" is separate and derived from `devices.last_seen` against `offlineAlertMs`
(`lib/config.ts:31`).

## Conversation window (multi-platform)

| | |
|---|---|
| Machine | Whether a channel may be answered freely |
| States | `NO_SESSION`, `WINDOW_OPEN`, `TEMPLATE_ONLY`, `OPTED_OUT` |
| Enforced in | `0007_multi_platform_and_conversations.sql:23` (`conversations.session_state`) |
| Kind | **Declared, one writer.** Both the Telegram and the WhatsApp insert hard-code `WINDOW_OPEN`; the other three states have no writer at all |

The most consequential gap of the declared ones: `OPTED_OUT` and `TEMPLATE_ONLY` are policy,
not telemetry, and nothing sets them. A 24-hour WhatsApp window that has expired still reads
`WINDOW_OPEN`.

## Pairing

| | |
|---|---|
| Machine | One handset joining the deployment |
| States | code `issued` → `claimed` (single use) → `expired`; device `unpaired` → `paired` → `archived` |
| Storage | `pairing_codes` (`0001_baseline.sql:103`): `expires_at` plus `claimed_at` |
| Kind | **Derived** from `expires_at` and the claim timestamp; one entry point writes it |

## Invite

| | |
|---|---|
| Machine | A second operator joining a deployment |
| States | issued → accepted → expired (TTL); revoked by deletion |
| Storage | `invite` (`0001_baseline.sql:70`) |
| Kind | **Derived** from `expires_at`; acceptance is a single use of the token |

## Approval request

| | |
|---|---|
| Machine | A human answering an agent's ask |
| States | `PENDING` → `APPROVED` / `REJECTED`; `EXPIRED`, `CANCELLED` |
| Enforced in | `0003_agent_control_plane.sql:82` (`CHECK`) |
| Kind | **Declared.** The transition lives in the route, so "only `PENDING` may be approved" is a predicate a new caller must remember |

The console shows decided requests and revoked or expired grants under "Recent decisions",
newest first, so a decision does not remove its own evidence — the page used to ask only for
`PENDING` and live grants, and a queue row vanished the moment someone answered it.

## Authority grant

| | |
|---|---|
| Machine | Permission for one effect class on one target, for one token |
| States | live → `revoked` (`revoked_at`) → `expired` (clock) → `exhausted` (`use_count` ≥ max) |
| Enforced in | `0003_agent_control_plane.sql:121`; one-live-grant-per-scope index at `:144`; decided in `agent/grants.ts:250` |
| Kind | **Derived, and lossy.** Three endings collapse into one refusal, `grant_expired` |

An operator asking "why was it refused" is told expiry when the answer may be revocation or
exhaustion. This is the clearest case in the file where a state machine is correct and its
vocabulary is not.

## Agent token

| | |
|---|---|
| Machine | A machine credential |
| States | live → revoked (deleted or flagged), with an optional expiry and a per-token usage meter |
| Enforced in | `0003_agent_control_plane.sql:40`; scopes in `lib/agent-scopes.ts` |
| Kind | **Declared.** `isGrantRequiredScope` exists (`agent-scopes.ts:68`) and has no caller, so `flows:write` is advertised as grant-required and enforced by nobody |

## Autonomy window

| | |
|---|---|
| Machine | Whether the runtime may act without a click |
| States | `off`, `open`, `expired` (clock), `other-session` (opened by a different operator) |
| Enforced in | `0003`/`0012` schema; decided in `agent/grants.ts:166` |
| Kind | **Derived.** Stored as `enabled` + `expires_at` + `actor` + caps; recomputed on every act. Refusals are ordered cheapest-first and named (`webhook_cannot_act`, `autonomy_off`, `autonomy_other_session`, `autonomy_expired`, `sms_cap`/`write_cap`, `daily_sms_cap`, `no_grant`, `grant_expired`) |

The window is deliberately not the grant: a window mints grants for the act classes it covers.
`agent_autonomy.daily_sms_cap` bounds the deployment's day beside the per-window cap, and it is
read before any grant.

## Agent runtime ticket

| | |
|---|---|
| Machine | One browser socket's one-use credential |
| States | `issued` → `spent` / `expired` |
| Enforced in | `worker/src/lib/agent-runtime.ts:415` |
| Kind | **Guarded.** The spend is a single conditional `DELETE FROM agent_runtime_tickets … WHERE expires_at > ?`, so atomically exactly one caller gets the row |

`agent_runtime_ticket_uses` is not part of the machine: it is a tombstone written after a failed
redemption so the refusal can say "already used" rather than "unknown". An earlier version of
this file described the ticket as a two-table join — that was wrong.

## Agent turn

| | |
|---|---|
| Machine | One question's life |
| Server states | `running` → `done` / `failed`, in `agent_turns` (`agent/journal.ts:145,210`); the finished answer is recorded under `<key>:answer` (`agent/conversation.ts:180`) |
| Client states | `opening` → `streaming` → answered / refused / lost |
| Enforced in | `agent/runtime.ts:657` (replay read before anything runs), `agent/conversation.ts` |
| Kind | **Guarded on the server for the result; the transport labels are the client's** |

A replayed key reads the recorded answer and returns it with `replayed: true`, without a second
model call. What is *not* guarded is two in-flight turns with the same key: both pass the
replay read while it is still null and both call the model. The key also is not bound to the
message, so reusing it with different text returns the old answer.

## Assistant proposal

| | |
|---|---|
| Machine | A change the assistant prepared and did not apply |
| States | `pending` → `consumed` (`consumed_at`) / `expired` (`expires_at`) |
| Enforced in | `0009_ai_assistant.sql:52`; claim at `worker/src/routes/assistant.ts:2034` |
| Kind | **Guarded at the claim.** The effect now runs *after* the conditional claim, exactly one request can win it, the loser gets `409 already_applied`, and a refused or thrown effect releases the claim so a retry can still apply it |

Before that change the effect ran first and the mark's row count was never read, so two clicks
made two rules and one mark no-opped. `origin: "act_refused"` distinguishes a proposal made
because an act was refused for authority from one the model chose.

## Webhook delivery

| | |
|---|---|
| Machine | One signed inbound call |
| States | `running` → `succeeded` / `failed`; a replay of the same delivery returns the recorded answer |
| Enforced in | `0015_webhooks.sql:40`; `routes/webhooks.ts:366` |
| Kind | **Guarded for replay, declared for status.** A failed delivery has no retry path and no dead-letter queue, and the console and CLI have no surface for any of it |

## Agent attachment

| | |
|---|---|
| Machine | A file handed to one turn |
| States | `stored` → `expired` (24 h) / `deleted` |
| Enforced in | `0016_agent_attachments.sql`; `agent/attachments.ts` |
| Kind | **Derived from `expires_at`, with no reaper.** An expired row and its R2 object are refused but never reclaimed, and the attachment text is folded into the stored user message, so the conversation read returns it |

## MCP session

| | |
|---|---|
| Machine | One streamable-HTTP MCP connection and its pending elicitation |
| States | `open` → `closed`; an elicitation is `pending` → `answered` / `abandoned` |
| Enforced in | `worker/src/mcp/http.ts:52` |
| Kind | **In memory, not a machine the deployment owns.** Both registries are module-level maps, so eviction loses every session and every pending elicitation |

## Alert

| | |
|---|---|
| Machine | One condition worth telling an operator about |
| States | `open` → `acknowledged` → `resolved` (or `expired`) |
| Enforced in | `0001_baseline.sql:31`; resolution at `worker/src/index.ts:618`, `flow/dispatch.ts:155` |
| Kind | **Declared, partially driven.** Only `device_offline` is resolved on contact; a drift alert is never auto-resolved, and its next miss inserts a *fresh* open alert because the dedupe query excludes acknowledged rows |

The console now renders each kind's own words and severity (`dashboard/src/lib/alerts.ts`):
silence stays red, drift is amber and says a flow cannot read what it expects, and an unknown
kind is neutral rather than being announced as silence.

## Flow run

| | |
|---|---|
| Machine | One flow execution as the phone reports it |
| States | `completed` / `delivered`, `partial`, `halted`, `filtered`, `no_trigger`, `error` |
| Enforced in | `0001_baseline.sql:60`; `simulator/core/src/carrier.rs:237` (`partial`); `worker/src/flow/dispatch.ts:68` and `:325` (the fallback) |
| Kind | **Guarded on both sides.** The handset marks a run `partial` when it produced a `Delay` or `Webhook` it cannot perform; the Worker then skips only the SMS steps already sent before that boundary and runs the rest, including the webhook. A pure-SMS run stays `delivered` |

## Connector

| | |
|---|---|
| Machine | A multi-platform channel (WhatsApp, Telegram) and its credentials |
| States | configured → connected → paused |
| Enforced in | `0018_channel_connectors.sql` (`channel_connectors`, `enabled`), `0019` adds `last_webhook_at` and `last_error` |
| Kind | **Declared.** The connector row is the account; `enabled` is stored, while "connected" is inferred from `last_event_at` or `last_webhook_at` traffic rather than a separate state column |

## Budgets and counters

| | |
|---|---|
| Machine | Daily AI spend, and daily SMS/write caps |
| States | none — a day key and counters |
| Enforced in | `0009_ai_assistant.sql:74` (`ai_usage`, UTC `YYYY-MM-DD`), `0012_agent_autonomy.sql:30` (`agent_usage`) |
| Kind | **Derived** by rollover. Console chat is capped by `AI_DAILY_TOKEN_BUDGET`; the agent token's meter (`agent_usage.tokens`) is recorded and not capped |

## Scheduled work

| | |
|---|---|
| Machine | One alarm-queue row |
| States | no state column — `run_at` plus `attempts`; an alarm returns `consumed` / `rescheduled` (`TaskOutcome`), and after 5 attempts the row is moved to the separate `dead_letters` table |
| Enforced in | `worker/src/durable-object.ts:100` (`ScheduledTaskRow`), `:141` (`MAX_TASK_ATTEMPTS`) |
| Kind | **Guarded** — a dead letter is a terminal absence, and the attempt ceiling stops a poisoned task from spinning |

## Scheduled message

| | |
|---|---|
| Machine | One row in D1 `scheduled_messages`, dispatched by the `Scheduler` object |
| States | `scheduled → dispatching → sent`; terminal `cancelled`, `skipped_opt_out`, `skipped_window`, `failed`, `unknown`; `delivered` is reserved for a platform receipt and is not written by the Scheduler yet |
| Enforced in | `0019_templates_and_scheduling.sql`, `worker/src/lib/scheduled.ts` (`claimScheduled`, `cancelScheduled`, `finalizeScheduled`), `worker/src/scheduler.ts` |
| Kind | **Guarded** by the conditional claim `WHERE status = 'scheduled'`. Cancel wins until the claim, then answers `409 not_cancellable`. `dispatching` is written before the side effect, so a crash cannot double-send: a connector becomes `unknown`, while SMS is requeued because `sched:<id>` makes the enqueue idempotent |

## Auth

| | |
|---|---|
| Machine | Failed sign-ins and lockout |
| States | `ok` → `counting` → `locked` |
| Scopes | **two** — per account (5) and per IP (20), each mirrored into the single `AuthGuard` object by key |
| Enforced in | `worker/src/lib/auth-limits.ts:68,124` |
| Kind | **Guarded.** An earlier version of this file described one global counter; it is two scopes, which is what makes a shared-IP office and a single attacker behave differently |

## What is still worth fixing

1. **`grant_expired` hides three endings.** Expired, revoked and exhausted are different
   actions for the operator. Split the reason.
2. **`radio_state` and `session_state` are declared with no writer.** One is a column nobody
   fills; the other is policy nobody sets, so an expired WhatsApp window still reads open.
3. **Two in-flight turns with one key both call the model**, and a key is not bound to its
   message. Claim the key before running, and compare the text on replay.
4. **Attachment text is stored in the transcript and re-served**, and expired attachments are
   never reclaimed. Keep a reference, not the text; add the sweep.
5. **A run recorded `delivered` by an older handset still hides a skipped webhook.** The
   handset tells the truth now; runs already stored keep the old outcome, and nothing
   re-classifies them.
6. **Drift alerts never resolve**, and acknowledgement spawns a fresh open row.
