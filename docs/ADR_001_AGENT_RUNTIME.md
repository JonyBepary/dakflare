# ADR 001 — the agent runtime

Status: accepted, 2026-11-16. Contract: `docs/AGENT_RUNTIME.md`. Surface rules:
`docs/AGENT_SURFACE.md`. This record exists for the decisions and the paths not taken.

## Context

DakFlare is a self-hosted SMS gateway: one Android handset is the radio, one Worker coordinates,
one console observes. The console assistant began as a stateless chat route that could only propose
changes. The owner asked for an agentic system: durable, tool-using, able to act inside an authority
model this product already has, and fast enough to feel like work rather than a request.

The authority rule predates this ADR and is not negotiable: a model never authorises a change; a
grant does. Everything below is shaped by that sentence.

## Decisions

1. **A Durable Object runs the agent, not a request handler.** `AssistantAgent` holds the
   conversation, the tools and the journal. A request cannot, because a turn outlives it and must
   survive an eviction.
2. **The `Agent` base class, not a bare `DurableObject`.** The Pi example shows the bare shape
   works, and it is the shape this object had. The base class adds `keepAliveWhile` and `runFiber`,
   which the 25-second turn needed, and `queue`, which a post-approval follow-up will need. It costs
   a hook rewrite and no bundle size worth measuring (79 bytes, measured).
3. **Native tool calling, not a JSON envelope.** The envelope asked a model to reproduce a structure
   in prose. It cost three defects: twenty seconds of silence, a turn lost to one bad brace, and a
   panel that printed JSON at an operator. Tools are function calls now and prose streams.
4. **Sessions and Streams, not our own tables.** Conversation memory is keyed by operator, survives
   a reconnect and is budgeted by bytes. Every turn is a durable chunk log replayable from a
   sequence, which is why a dropped socket no longer loses an answer.
5. **Grants name the effect, and are re-read at the act.** `authorizeAct` reads the live grant, the
   window and the day's caps at call time. A window belongs to the operator who opened it. The
   SDK's own model — permissions per turn, allowed by default — is the opposite default.
6. **A journal row before every effect.** `tool_calls` is written before the effect and settled
   after, keyed by a server-minted call id. A replay returns the recorded result and spends nothing;
   an interrupted act is refused rather than guessed at. The SDK's own ledger reclaims a stale row
   after five minutes when a key exists; for money and messages, fail-closed is correct.
7. **A ticket, an exact Origin, and a pinned name.** Browsers cannot set a header on a WebSocket
   upgrade, so a single-use ticket bound to the session and the object is redeemed in the gate;
   `Origin` must match the gateway's own host across schemes; the object name is rewritten
   server-side so a path cannot mint unbounded objects.
8. **A versioned runtime schema that refuses to run backwards.** The object keeps its own migration
   ledger and answers `503 agent_schema_ahead` when storage is newer than the code. Workers roll
   back atomically; Durable Object storage does not.
9. **The model is a per-deployment choice.** This deployment runs Gemma-4-31B-IT: the reasoning
   models answered "at capacity" often enough to fail turns, and their reasoning budget competed
   with the answer that follows it.

## Rejected

- **`@cloudflare/think`.** Everything we built, already assembled — and experimental, pulling `ai@7`,
  `@ai-sdk/*` and React. Its `action()` approvals are the closest documented equivalent to our acts,
  but its authorization is opt-in and defaults to allow-all per turn, which for a gateway that sends
  SMS is the wrong default to inherit.
- **The Pi harness.** The more capable harness, and the one that owns recovery properly. Rejected for
  this pass because it replaces the loop wholesale and its substrate is pinned to one minor version
  per `agents` release; the invariants we care about live in our tools, not in the loop.
- **A prompt-forced JSON envelope, kept as a fallback.** Two contracts for one turn means two sets of
  defects. One path, with a documented non-streaming fallback at the adapter only.
- **Second-by-second token animation from a finished answer.** It looked live, resumed from nothing
  and lied about progress. Removed rather than tuned.
- **Storing provider secrets in D1 to "simplify" configuration.** A database backup that can charge
  the operator's model account is not a simplification.

## Consequences

- Two sources of truth for schema — the SDK's `cf_agents_*` tables and ours — are stated in the
  object's header and in `AGENT_RUNTIME.md`, because a reader must know which refusal is authoritative.
- The agent can only act while a window is open, so an operator who wants unattended behaviour trades
  convenience for an explicit grant. That is the intended trade.
- Latency is the provider's: a full tool turn is 15–25 seconds of model time. Streaming makes it
  legible, not faster.
- Eviction, hibernation wake and reconnect across a deploy are still smoke-tested rather than
  asserted; a Workers pool is the only honest way to prove them.

## Open

Webhooks as a second channel (in progress), a plan-before-act step in the panel, and the evidence
pool. None of them change the decisions above.
