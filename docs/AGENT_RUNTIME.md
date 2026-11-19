# The agent runtime

Decisions and the alternatives that were rejected are recorded in
[`ADR_001_AGENT_RUNTIME.md`](./ADR_001_AGENT_RUNTIME.md); this file is the contract the code
has to keep.

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

## The model contract is native tool calling

A turn used to be one JSON envelope: `{"answer": …, "calls": […]}`. That contract was the
cause of three of this pass's defects — a twenty-second silence before any output, a turn lost
to one malformed brace, and a panel that printed raw JSON when the envelope did not parse. Tools
are now native function calls and prose streams as it is written.

- The adapter sends `tools` + `tool_choice: "auto"`; with streaming on it parses SSE into
  `token` events and indexed `tool_calls` fragments. A provider that ignores `stream`, or
  streams something unusable, is answered with one non-streaming request rather than a failed
  turn.
- The loop executes calls through the unchanged journal and `authorizeAct` path, appends the
  assistant message (with its tool calls) and one `tool` message per call, then continues. Caps
  are unchanged: four calls a turn, six turns a conversation.
- Tool arguments arrive as a JSON string from the provider. Unparseable arguments become a
  `bad_arguments` tool result the model can see, never a thrown turn.

Three facts about the deployed gateway, each of which cost a debugging round and is now handled:

1. **SSE events are separated by newlines, not blank lines.** Splitting on `\n\n` parsed zero
   events from a stream that was entirely valid.
2. **`usage: null` arrives on every chunk.** A guard that only checked `undefined` made each
   event throw, which surfaced to the operator as "the provider streamed no content".
3. **Reasoning models stream `reasoning`/`reasoning_content` before any answer.** The text is
   counted, not shown, and an empty reply is diagnosed as "the budget went to thinking" instead
   of a mystery.

A transcript is training data. The envelope-era replies were being replayed from Sessions and
taught the model to answer in JSON again after the loop moved on, so the conversation id is
versioned (`conversation:v2:<actor>`) and the old rows are retired rather than sanitised. Bump
that version whenever the message contract changes shape.

The chat model is a per-deployment choice (`dakflare ai configure --model …`). This deployment
uses `Gemma-4-31B-IT`: the DeepSeek reasoning models answered "at capacity" often enough that a
turn failed more than it succeeded, and their reasoning budget competed with the answer.

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

## A conversation, a file, and a turn that runs once

The panel used to be stateless by design, and that is what made it feel unlike an agent:
every question began from nothing. Three additions, all admin-scoped, none of them able to
act without the authority rules above.

**The conversation is the operator's, and readable.** `GET /v1/admin/agent/conversation`
returns the transcript the Sessions API already holds for that operator — `{conversation,
messages:[{id, role, text, at}], truncated}` with `?limit=1-100` (default 40, newest last).
`DELETE` clears it. Both go through the Durable Object rather than D1 because that is where
the transcript lives; the route's action is absent from `SCOPE_FOR_ACTION`, so an agent
token cannot read a human's history.

**Attachments are metadata in D1 and bytes in R2.** `POST /v1/admin/agent/attachments`
takes one multipart `file`:

| Limit | Value | Why |
|---|---|---|
| One file | ≤ 1 MiB | A single R2 object per upload; a bigger body is refused with the limit in the message |
| Kept per operator | 3 | The panel has room for three chips; more is a decision nobody made |
| Lifetime | 24 h | An attachment is a prompt ingredient, not a document store |
| Text budget per turn | 64 KiB, all attachments | Bounded so three files cannot crowd out the transcript |
| Text types | `.txt .md .json .csv .log .yaml .yml .eml`, or `text/*` | Read into the user message, never the system prompt |
| Images and others | named only | The prompt says the model cannot see them. An agent that pretends to read a screenshot is worse than one that says it cannot |

An attachment past its 24 h is refused by name rather than silently dropped: an operator who
sees their file listed and not used learns nothing, and a model that was handed an empty
version of it answers confidently about nothing.

**A turn carries a key, and a replay is a read.** `say` and the socket's `ask` accept
`idempotencyKey` — 8–64 characters of `A-Z a-z 0-9 _ -`. The same key returns the recorded
answer with `replayed: true`, without a second model call and without a second transcript row;
the stream id is derived from the key, so a reconnect and a retry land on the same turn. The
socket forced this from the start; the HTTP path now matches it, which is what makes `Try
again` safe to press.

**Two ceilings, not one.** `agent_autonomy.daily_sms_cap` (default 20) bounds the
deployment's day; the per-window `sms_cap` bounds one operator's hour. `authorizeAct` reads
the daily ceiling before it looks at a grant, so two short windows on the same day cannot
double the total.

**A proposal says why it exists.** A proposal created because an act was refused for
authority carries `origin: "act_refused"` in its payload, so the card can say it was
prepared rather than chosen — the same states, two different causes.

## Inbound webhooks

A service can wake the agent without a browser session. An operator creates a hook with
`POST /v1/admin/webhooks`; the response carries the signing secret once and stores only
`SHA-256(secret)` plus a sealed copy (HMAC verification needs the key, which a one-way hash
cannot supply). The four admin actions are absent from `SCOPE_FOR_ACTION` and each handler
calls `assertHuman`, so no agent token reaches them.

Ingress is `POST /v1/webhooks/:id` with `x-dakflare-signature: sha256=<hex>` over the raw
body and a required `x-dakflare-delivery`. The delivery id is the primary key: the insert is
the claim, so a repeated id returns the stored answer with `replayed: true` and runs no
second turn. A disabled hook is `403`, a bad signature `401`, a missing delivery id `400`,
an oversized body `413`, and the per-hook limiter shares `ADMIN_LIMITER` under the
`webhook:<id>` key.

The turn runs `say()` with the synthetic actor `webhook:<id>` (`role: "webhook"`). That
actor has no human session, so `authorizeAct` refuses every act with `webhook_cannot_act`
even when the autonomy row is ownerless; the answer is stored on the delivery row and
returned, and a failed turn stores its reason and answers `502`.

### Rotating a webhook secret

There is no rotate endpoint: a secret cannot be re-read once shown, and the API deliberately
has no path that returns one. Rotation is create, cut over, delete:

1. `POST /v1/admin/webhooks` with the same URL and description. The response carries a new `id`
   and a new `secret`; the old hook keeps working, so there is no window in which the service
   has nothing valid to sign with.
2. Put the new `id` and the new secret in the caller, then send one signed request and confirm
   `2xx` with `replayed: false` and an answer. A signature made with the old secret against the
   new id is a `401` — that is the check that the cut-over actually happened.
3. `DELETE /v1/admin/webhooks/:id` for the old hook, and confirm its deliveries stop.

**Rotating `WEBHOOK_SECRET_KEY` is not a per-hook operation.** Each hook's secret is sealed
under that Worker key (AES-256-GCM), so a new key cannot open the old seals: every existing
hook starts answering `500` on ingress until it is deleted and recreated. Rotate it in a
window where you intend to re-create every hook, and keep the old key available in the
secret store until each one has been cut over — deleting it first turns a rotation into an
outage. This is the one case where the sealed copy is a liability rather than a convenience,
and it is the reason the key is documented here rather than only in the migration.

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

Only a real Workers pool can prove more than a pure function can. `node
dakflare_test_harness.mjs agent-pool` now asserts, on observable state rather than source
text: that a minted ticket opens exactly one socket (`101`), that the same ticket is refused
on a second upgrade with no session admitted, and that the real 60-second TTL ends it (the
harness waits, it does not edit D1); that an autonomy window opened by operator A refuses
operator B's act with `autonomy_other_session` — not `no_grant`, and not silently — while
A's identical act is decided on its merits; and that a signed webhook delivery answers once,
that an identical repeat returns the same answer with `replayed: true`, exactly one
`webhook_deliveries` row and no second model turn, and that a wrong signature is refused on
both a replay and a fresh delivery. Eviction, hibernation wake, the browser `Origin`/cookie
matrix, live-model tool calling and reconnect across a deploy remain smoke-tested, not
asserted.

## Why the agent dependencies are pinned exactly
`runtime.ts` is the fourth Durable Object: one pinned instance (`assistant`)
that will hold a conversation and, in later stages, call tools over a WebSocket.

## Why `agents` and the Pi packages are exact versions

`package.json` pins, with no `^` or `~`:

| Package | Version |
|---|---|
| `agents` | `0.33.0` |
| `@earendil-works/pi-durable` | `1.5.2` |
| `@earendil-works/pi-ai` | `1.5.2` |
| `@earendil-works/pi-schema` | `1.5.2` |
| `@earendil-works/chord` | `1.5.2` |

`agents` is the runtime (`Lifecycle`, `State`, `WebSockets`, routing). A minor
release of the SDK can change the Durable Object storage layout — the schema
`State` and the hibernating-WebSocket attachment use — and this deployment's
object owns a schema ledger of its own for exactly that reason. Pinning means a
deploy is reproducible; it also means a self-hoster who rolls the Worker back
must not run new storage with old code. The object refuses when the stored
schema is newer than the code (`503 agent_schema_ahead`), so a rollback degrades
instead of corrupting.

The four Pi packages are peers of `agents`: optional, experimental, and released
with one Pi minor per `agents` release. `1.5.2` is the Pi minor that `0.33.0`
declares (`~1.5.0`). Stage A does not import them; they are pinned now so that
stage B's model adapter cannot silently resolve a different Pi minor than the
runtime was tested against.
