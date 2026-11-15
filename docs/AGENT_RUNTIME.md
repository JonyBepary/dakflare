# The agent runtime

Status: pass 3, stage A. This document is the contract for the acting agent. Read
`AGENT_SURFACE.md` first for the authority rule it has to survive.

## What this changes, in one paragraph

The console assistant answers prose and returns proposals. This adds a durable agent
runtime beside it: a fourth Durable Object that holds a conversation, streams tokens over a
WebSocket, and can call tools. Read and propose tools are the existing surface. Act tools
write through the same handlers the console uses, and are the only reason this pass carries
risk. The stateless `/v1/admin/assistant/chat` stays; a deployment that never turns the
runtime on behaves exactly as it does today.

## Non-negotiables, taken from the design review

1. **A WebSocket authenticates at upgrade and is authorised per act.** A session lives 7
   days and a grant an hour, so a socket that outlives its grant must not keep acting. Every
   act calls one `authorizeAgentAction` (fresh session, live grant, budgets) before the
   effect, and the object closes the socket at the earlier of session and grant expiry. The
   object's name is pinned server-side (`assistant`); a name from the path would mint
   unbounded objects.
2. **A grant must name the effect, not the object class.** `targetMatches` compares only
   the constraints a grant names, and an empty target matches everything, so "SMS for a
   day" would mean "any recipient". Autonomy therefore mints effect-shaped grants —
   explicit `recipients` and `max_uses` for SMS, `rule_id`/`body_hash` for rules, `flow_id`
   plus graph hash for a deploy — each with its own token id so supersede cannot collide
   with a hand-approved grant.
3. **The model never supplies an idempotency key.** Every act writes a `tool_calls` row
   (`call_id`, turn, tool, args hash, state) in the same transaction that marks the turn
   executing, then derives the effect's key from `call_id`. A replay returns the recorded
   result: `replayed: true`, same `command_id`; for a rule the deterministic id; for a flow
   the same graph hash. Grant uses and quota spent by a replayed call are refunded, or a
   retry loop can burn a `max_uses` grant on its own replays.
4. **Money has three separate caps.** Tokens for the loop (its own counter, not the chat
   budget), writes per day, and SMS per day. A kill switch revokes the grant and stops the
   harness; a turn cap stops a loop that would otherwise exhaust any of them.
5. **Runtime state is versioned, and a bad upgrade degrades.** The object owns a
   `schema_version` table with forward-only migrations inside `blockConcurrencyWhile`,
   refuses to serve with `503` when the stored version is newer than the code, and
   `AGENT_RUNTIME=off` routes `/agents/*` to `503` while the stateless assistant keeps
   working.

## Memory and streaming are the SDK's, not ours

A doc study of the Agents SDK found we had adopted its shell (Lifecycle, State, WebSockets)
and hand-rolled the two pieces under it that matter most, so both are now the documented
capabilities. Nothing was added to `package.json`: `agents@0.33.0` already exports them.

- **`agents/sessions`** holds the conversation. It is keyed by the operator
  (`conversation:<actor>`), not by the socket, so a reconnect is the same conversation and the
  panel and the CLI share one memory. Appends are idempotent on a turn-derived message id, so a
  retried turn does not duplicate, and history is hydrated to a 32 KiB budget by bytes rather
  than rows. Branching, compaction and full-text search come with it and are unused so far.
- **`agents/streams`** holds each turn. Every frame is appended to a durable chunk log keyed by
  the turn's idempotency key, so a client can resume: send `{type:"resume", streamId, from}` on
  the socket, or `GET /agents/assistant/assistant/streams/<id>?from=<seq>` for an SSE replay
  after a reload. The old "stream" sliced a finished answer into 48-character pieces, which
  looked live, resumed from nothing, and was removed.

Deliberately not adopted: `@cloudflare/think` bundles sessions, streams, approvals and a
per-turn authorization model, but it is experimental and pulls `ai@7`, the `@ai-sdk/*`
packages and React. Its authorization also defaults to allow-all per turn, which is the
opposite of what this gateway needs.

The object now extends the SDK's `Agent` base class. That adds `keepAlive`, `runFiber`,
`queue` and `@callable` without changing the bespoke contract: the pinned name, the grant
model, the fail-closed journal, the versioned schema and the turn frames stay ours. Two
rules keep the migration honest:

- **Two schema owners, disjoint tables.** `Agent._ensureSchema()` owns every
  `cf_agents_*` table and its KV gate; our `MIGRATIONS` + `AGENT_SCHEMA_VERSION` row own
  `agent_turns`, `tool_calls`, `agent_messages` and `schema_version`. Our refusal wins for
  our tables when a stored version is newer than the code (a rollback), independently of
  the SDK's gate.
- **No SDK protocol frames on our wire.** `shouldSendProtocolMessages()` returns false, so
  identity, state sync and MCP frames are never sent; the client continues to speak its
  bespoke JSON protocol starting with `ready`.

A turn runs under `keepAliveWhile` (the SDK's ref-counted 30 s alarm cap, which replaced
the hand-rolled `Scheduler` heartbeat) and as a `runFiber`. The fiber row records an
interrupted turn for `onFiberRecovered`, but it never resumes or replays one: replay
safety is the journal's `tool_calls` row, which refuses a second effect for the same turn.

## Authority

The rule stays meaningful only if the human decision names the effect. Turning autonomy on
mints grants for a bounded window; each act spends one; when they expire the agent is back
to proposing. `createGrant` and `decideApproval` gain an `assertHuman(actor)` guard, so a
Durable Object that imports them cannot approve itself, and the same `runAsAgent` helper
wraps the HTTP gate and the tool path so a tool cannot skip the scope check, the per-token
limiter or `recordTokenUse` that the HTTP route applies.

With no grant, an act does not become a proposal silently: it opens an approval request
through the existing queue, which is the same gate a human write goes through.

## Routing and connection

- `/agents/*` is matched **before** the existing router. `routeAgentRequest` maps every
  Durable Object binding, so a `className` allowlist (`ASSISTANT` only) runs first.
- Upgrade checks, in order: `GET`, `Upgrade: websocket`, `Origin` in
  `AUTH_TRUSTED_ORIGINS` (same-origin counts), a single-use ticket bound to the session id
  and the object name, then the admin session itself.
- `POST /v1/admin/agent/ticket` mints that ticket (60 s, single use). A WebSocket rejection
  cannot carry a status a browser will show, so the ticket endpoint is where a refusal is
  diagnosable.
- Cookies are `SameSite=Strict` and `Path=/`, which already closes the cross-site case; the
  `Origin` check makes it explicit rather than incidental.

## Stages

- **A (this one).** Pinned dependencies, the object with Lifecycle + State + WebSockets and
  a versioned schema, routing with the allowlist, Origin and ticket checks, `assertHuman`
  and `runAsAgent`, the config gate, `AGENT_RUNTIME` off by default. No tools, no autonomy.
- **B.** Read and propose tools, an injectable model adapter so the loop is testable, and a
  `node --test` harness for the policy plus a dev-stack harness for the socket.
- **C.** Act tools, effect-shaped grants, the `tool_calls` journal, counters, caps, kill
  switch, and autonomy enabled for this deployment.

## Evidence, and what only a pool could prove

Plain `node --test` covers the pure policy: `targetMatches` for a device-only grant against
a recipient list, empty grant against empty request, `max_uses`, and the key derivation. A
dev-stack harness covers the socket: refused without a ticket, refused on a wrong `Origin`,
`101` with one, a proposal with no grant, one command and one `message.sent` row after an
approval, a revoked or expired grant refused, and a repeated key returning `replayed: true`
with a single command.

Only a real Workers pool can prove eviction, hibernation wake, the browser `Origin`/cookie
matrix, live-model tool calling and reconnect across a deploy. Those are named as
smoke-tested, not asserted.
