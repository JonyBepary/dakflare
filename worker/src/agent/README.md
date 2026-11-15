# The agent runtime

`runtime.ts` is the fourth Durable Object: one pinned instance (`assistant`)
that will hold a conversation and, in later stages, call tools over a WebSocket.
Read `docs/AGENT_RUNTIME.md` before changing it; this note only explains why the
dependencies are pinned exactly.

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
