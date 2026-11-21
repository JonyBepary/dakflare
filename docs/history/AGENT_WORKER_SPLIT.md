# The agent Worker split — why `AssistantAgent` left the main Worker

Status: decided and deployed 2026-11-21, released as `6.3.0-alpha.5`.

## The problem

Every request paid for the assistant. The main Worker's bundle was 7.57 MB (1.64 MB gzip) and
started in ~131 ms of active CPU because it imported the agents SDK, the MCP SDK and the model
provider clients at module scope. A device heartbeat paid the same price as an agent turn.

Measured before, on 401 responses:

| | Before | After |
|---|---:|---:|
| bundle | 7,565,003 B | 5,314,252 B |
| gzip | 1,635,810 B | 1,178,631 B |
| local startup, active CPU | 131.5 ms | 80.6 ms |
| tail CPU at p99 | — | 0 |

## The shape

`dakflare-agent-worker` owns `AssistantAgent`, the MCP surface and the agent conversation routes.
`dakflare-worker` stays the only public entrypoint, proves the actor and the ticket, and forwards
`/agents/*`, `/v1/mcp`, `/mcp` and `/v1/admin/agent/*` through `AGENT_SVC`.

The agent Worker has no public route, no `BETTER_AUTH_SECRET`, no `AUTH_GUARD` and no `DEVICE`
namespace. Two bindings point back:

- `CORE` (a plain Fetcher, `bindings.worker({ worker: "dakflare-worker" })`) for SMS, health,
  TOTP and the command enqueue.
- Nothing else. A raw Durable Object binding would bypass the gates, so it was not used.

The authority check stays with the Worker that serves the request. The MCP `send_sms` tool runs the
grant check in the agent Worker and only the enqueue crosses to the main Worker
(`POST /v1/admin/agent/enqueue`), so the approval a human grants is still checked against the agent
token that asked, and the audit row is written where the decision was made.

## The namespace move

`AssistantAgent` in the agent Worker is a **different** Durable Object namespace. The old one is
retired with an explicit `state: "deleted"` export, not silently dropped. The transcript does not
follow: it was exported with `/v1/admin/agent/export` and imported with `/v1/admin/agent/import`
before the move — 6 conversations, 90 messages. D1 rows and R2 objects were unaffected because the
object keys are the same.

## What this cost, and the defects it exposed

- **The store gate compared the wrong string.** The proxy passed `className: "AssistantAgent"`
  while the gate checks the binding name `ASSISTANT`, so every `/agents/*` request answered `404`.
  Static gates passed; a two-Worker test harness found it on the first run. `verify:deploy` now
  fails on that shape (`426`, not `404`).
- **The MCP send tool still ran in the old world.** It called `handleSend` in a Worker with no
  `DEVICE`, so it answered `500` after the gate had correctly asked for approval. Fixed by the
  internal enqueue route above.
- **The conformance stack started one Worker.** `/v1/mcp` answered `501` and the suite died before
  the MCP section. `dev.sh` now runs both configs in one `wrangler dev` session, which is also the
  only way two local Workers can share a D1.
- **Workers AI is remote-only.** In a multi-Worker dev session the auxiliary config either opens a
  remote proxy (needs `CLOUDFLARE_API_TOKEN`, and CI holds no credentials) or refuses to start with
  `remote = false`. The dev config drops the binding; the harness points chat at its model stub.

## Rejected

- **Caching the Better Auth router.** It is request-scoped; the passkey routes were made to dispatch
  through `auth.api.*` directly instead.
- **`better-auth/minimal`.** It needs Kysely to talk to D1 directly.
- **One Worker with lazy imports only.** Lazy imports cut startup but not the bundle or the cold
  path, and they made the module graph harder to reason about than a second deployment.
- **A raw Durable Object binding into the main Worker.** Faster, and it bypasses `BINDING_AUTH`,
  scopes, limiters and audit — the things `docs/WORKER_BINDING.md` exists to keep.
- **Sampling logs at 0.1.** Measured ~0.5 requests/s after the CPU fix, roughly 43k events a day:
  inside the free allowance. 0.1 saves nothing and hides nine requests in ten.
