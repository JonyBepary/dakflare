# Calling DakFlare from another Worker

A second Worker in the same Cloudflare account — or a Cloudflare Workflow, which runs inside a
Worker and can hold the same bindings — can call this deployment as a typed service instead of
building a `Request` and remembering which header carries the credential.

This is new: until now the only interfaces were the HTTP API (untyped `Request`/`Response`) and
the raw Durable Object stubs, which bypass every gate this Worker has.

The split agent Worker is the one caller inside this repository, and it uses the plain Fetcher
form (`CORE: bindings.worker({ worker: "dakflare-worker" })`) rather than `DakFlareApi`, because
`DakFlareApi` is typed for the public `/v1` contract and `CORE` also reaches internal routes such
as `/v1/admin/agent/enqueue`. It sends `Authorization: Bearer $ADMIN_TOKEN` — the same credential
the CLI uses — so scopes, limiters and audit rows still apply. The binding can name an entrypoint
when a caller wants only the typed surface: `bindings.worker({ worker: "dakflare-worker",
exportName: "DakFlareApi" })`. `docs/OPS_DEPLOY.md` has the deploy order and the secrets both
Workers need.

## The consumer

```toml
# the consumer Worker's wrangler.toml
[[services]]
binding = "DAKFLARE"
service = "dakflare-worker"
entrypoint = "DakFlareApi"
```

```ts
// the consumer Worker
const sent = await env.DAKFLARE.sendSms({ to: "+8801711000111", body: "Paid." });
const fleet = await env.DAKFLARE.devices();
const turn = await env.DAKFLARE.ask("How many rules are enabled?");
```

The importable type is exported from the Worker's own module (`src/binding-api.ts`), so a
consumer that type-checks against this repository gets completion rather than `any`:

```ts
import type { DakFlareApi } from "dakflare-worker/binding-api";
```

## The methods

Every one delegates to `handleFetch`, the same router the public API uses. Scopes, rate
limiters, audit rows, idempotency and the D1 session bookmark behave exactly as they do for an
HTTP caller — this is a calling convention, not a second code path.

| Method | Route | Needs a credential |
|---|---|---|
| `health()` | `GET /v1/auth/mode` | no — that route is public by design |
| `deployment()` | `GET /v1/admin/health` | yes |
| `devices()` | `GET /v1/devices` | yes |
| `messages({ limit, deviceId, direction })` | `GET /v1/messages` | yes |
| `sendSms({ to, body, deviceId?, idempotencyKey? })` | `POST /v1/sms/send` | yes |
| `ask(message, { idempotencyKey?, token? })` | `POST /v1/admin/agent/say` | yes |
| `request({ path, method, body, headers, token })` | anything under `/v1` | yes (unless `false` is passed) |

`request()` is the escape hatch, and it is deliberate: a route added to the HTTP API is callable
from a binding the day it ships, so the two surfaces cannot drift.

A failure is a thrown `BindingError` with `code`, `status` and the route's own sentence — a
client branches on `code`, never on the message.

## Who may act

`BINDING_AUTH` decides, read per call so a deploy changes it without a warm isolate holding the
old answer. It lives in `cloudflare.config.ts` beside the other deployment settings.

| Mode | Credential | What a bound Worker can do |
|---|---|---|
| `trusted` (default) | none — the binding *is* the credential | everything the deployment can, including sending SMS and spending money |
| `agent_token` | a `dkf_agt_` token passed per call | whatever that token's scopes allow; an act additionally needs a live authority grant, because that is the path a token takes |

`trusted` is the default because a single-owner deployment's account is already the trust
boundary, and a token on every call would be ceremony that teaches nobody anything. It is still
a real decision: **any Worker in the account that binds this service can send an SMS.** If that
is more than you want, set `BINDING_AUTH: bindings.text("agent_token")` and mint a token with
`dakflare auth mint-agent-token --name <consumer> --scope sms:send,devices:read`.

There is deliberately no third mode in which a grant replaces the token. A grant is bound to a
token, so "grant without a credential" has no identity to check it against; `agent_token` is that
mode — the token names the actor, the grant decides what the actor may do.

If `BINDING_AUTH=trusted` and the deployment has no `ADMIN_TOKEN`, every credentialed call
refuses with `binding_untrusted` rather than running unauthenticated. That is the one case a
deployment can get wrong, so it fails loudly and names both ways out.

## What a binding does not do

- **It does not cross accounts.** Service bindings, queues, workflows and rate-limit namespaces
  are account-scoped. A different account calls the HTTP API with a token.
- **It does not bypass the router.** The methods above are conveniences over `handleFetch`; a
  binding cannot reach a Durable Object method directly unless you bind that class yourself, and
  doing so skips the scope checks, limiters and audit rows this file describes.
- **A machine caller has its own transcript.** The entrypoint sends
  `X-Dakflare-Client: binding`, so its conversation and attachment namespace is its own rather
  than the CLI's. `ADMIN_TOKEN` remains one shared credential: this separates cooperating
  clients by declared identity, not cryptographically.
- **Resolution is Cloudflare's, not ours.** That a consumer's `entrypoint: "DakFlareApi"`
  resolves to this class is proven by the deploy bundle exporting it beside the Durable Object
  classes and the default handler — `npx wrangler deploy --dry-run --outdir …` and read the
  `export { … }` list. There is no unit test for it, and pretending otherwise would be worse
  than saying so.
