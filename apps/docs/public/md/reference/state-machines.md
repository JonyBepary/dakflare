# State Machines

> Authoritative inventory of DakFlare's guarded, declared, and derived state machines across outbound commands, replies, approvals, grants, agent turns, and auth.

Every state machine in DakFlare is classified by how its transitions are enforced:
- **Guarded**: One atomic SQL predicate or function owns the transition; no route can bypass it.
- **Declared**: Schema enumerates valid states, but enforcement lives in route predicates or lacks a writer.
- **Derived**: Computed dynamically from timestamps and counters at read time.

## Outbound Command Delivery (**Guarded**)

Owned by `worker/src/durable-object.ts` (`ALLOWED_PREDECESSORS`):

```text
PENDING -> LEASED -> DISPATCHED -> SENT -> DELIVERED
                  \-> FAILED (with optional error_code & error_message)
PENDING | LEASED | DISPATCHED -> EXPIRED (error_code: "expired")
```

- **Terminal states**: `DELIVERED`, `FAILED`, `EXPIRED` (no transition ever leaves them).
- **Out-of-order safety**: `DELIVERED` accepts `DISPATCHED` as well as `SENT` because carrier delivery reports can arrive before radio ack; late `SENT` after `DELIVERED` is a no-op; `LEASED` cannot jump directly to `DELIVERED`.
- **Canonical lifecycle projection** (`worker/src/lib/canonical-lifecycle.ts`, **Derived**): maps raw state into `(state, substate, is_terminal, settled, remediation)` including `SETTLED_SENT` after 5 minutes of silence (`SMS_SETTLED_GRACE_MS`).

## Inbound Reply Fate (**Guarded**)

Owned by `worker/src/routes/incoming.ts`:
- **States**: `null` → `queued` → `sent` → `delivered` / `failed`. `delivered` and `failed` are terminal.
- **Suppression axis (`reply_verdict`)**: `suppressed_cooldown` or `suppressed_hourly_cap` (`0004_provenance.sql`).

## Flow Run (**Guarded on Handset & Worker**)

- **States**: `delivered`, `partial`, `halted`, `filtered`, `no_trigger`, `error`.
- When the handset encounters a `delay` or `webhook` node it cannot execute locally, it marks the run `partial` (`simulator/core/src/carrier.rs`). The Worker skips SMS steps already executed before the boundary and resumes the remaining actions (`worker/src/flow/dispatch.ts`).

## Authority, Autonomy & Agent Runtime

| Machine | States | Enforcement |
| --- | --- | --- |
| **Approval Request** | `PENDING` → `APPROVED` / `REJECTED` / `EXPIRED` / `CANCELLED` | **Declared** (`0003` CHECK + atomic single-winner claim; loser gets `409`) |
| **Authority Grant** | `live` → `revoked` / `expired` / `exhausted` | **Derived** (`agent/grants.ts`; note: all three non-live endings currently surface as `grant_expired`) |
| **Autonomy Window** | `off`, `open`, `expired`, `other-session` | **Derived** on every act; ordered refusals: `autonomy_off`, `autonomy_expired`, `autonomy_other_session`, `no_grant`, `grant_expired`, `sms_cap`, `write_cap`, `webhook_cannot_act` |
| **Runtime WS Ticket** | `issued` → `spent` / `expired` | **Guarded** (atomic conditional `DELETE ... WHERE expires_at > ?` in `lib/agent-runtime.ts`) |
| **Assistant Proposal** | `pending` → `consumed` / `expired` | **Guarded** (conditional claim before effect; duplicate click gets `409 already_applied`; failed effect releases claim) |
| **Agent Turn** | `running` → `done` / `failed` | **Guarded** for completed replay (`<key>:answer` returns `replayed: true`) |
| **Scheduled DO Work** | `pending` → `running` → `consumed` / `rescheduled` → `dead_letters` (5 attempts) | **Guarded** (`durable-object.ts`) |
| **Auth Lockout** | `ok` → `counting` → `locked` | **Guarded** across two scopes in `AuthGuard`: per-account (5) and per-IP (20) |

## Known Unwritten / Declared-Only Columns

- `device_sims.radio_state` (`READY`, `DEGRADED`, `NO_SERVICE`, `LOCKED`): declared in `0002`, read by telemetry, no handset writer yet.
- `conversations.session_state` (`NO_SESSION`, `WINDOW_OPEN`, `TEMPLATE_ONLY`, `OPTED_OUT`): Telegram and WhatsApp inserts currently hard-code `WINDOW_OPEN`.
- `alerts` (`extraction_drift`): `device_offline` auto-resolves on handset contact; drift alerts do not auto-resolve yet.
