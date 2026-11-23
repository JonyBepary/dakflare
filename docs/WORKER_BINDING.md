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
the CLI uses — so scopes, limiters and audit rows still apply.

### Three transports, one job each

| Binding | Entrypoint | Auth | Use |
|---|---|---|---|
| `DAKFLARE_ADMIN` | `DakFlareAdminApi` | trusted, same account, no token | provision: mint a service token, create a webhook, rotate its secret, put a flow, list deliveries, replay |
| `DAKFLARE_RUNTIME` | `DakFlareRuntimeApi` | a service token passed per call | send, read devices/messages, manifest, health, usage |
| inbound | HTTPS webhook | v1 envelope, `X-Dakflare-Delivery` as nonce | carrier messages into the consumer |

The runtime entrypoint has **no** `request` method and no admin route: it cannot
mint a token or create a webhook even if a caller names one. The admin entrypoint
refuses to run under `BINDING_AUTH=agent_token`, because an admin path with no
admin credential is a misconfiguration rather than a fallback. Both dispatch
through the same router, so an error code and a limiter are the HTTP ones, and
`GET /v1/integration/manifest` publishes this table as `rpc`.

### Rotating a signing secret

`rotateWebhookSecret(webhookId)` (or `POST /v1/admin/webhooks/:id/rotate-secret`)
mints a new secret, stores it sealed, and returns it once with
`previous_valid_until`. The old secret stops being used immediately — deliveries
are signed at consumption — so the timestamp is a **transport bound** (an
already-sent request can still be in flight), not a policy window. A consumer that
wants to accept the old secret for a day is making its own rule; this field only
promises what the deployment can keep. The route is human-only and audited as
`webhook.secret_rotated`.

### What a service token cannot do

A service token is bounded on four axes, set at mint and enforced by the send gate:
`allowed_device_ids`, `allowed_channels`, `allowed_recipients` (E.164 prefixes —
`+8801` covers every BD mobile, a full number covers one) and `max_per_hour`. A
leaked token can therefore spend its hour, on its handsets, to its numbers. It
cannot reach an admin route, mint another token, or rotate a signing secret.

Per-recipient and per-device **rate** limits are deliberately not here yet: they
need a counter table and an atomic window, and a half-built quota would be a
promise the deployment cannot keep.

Inbound delivery stays a signed webhook on purpose. An RPC would be a second
delivery model beside `integration_deliveries`, and two ledgers is how a
duplicate settlement happens.

### A trusted binding can present a weaker credential

Under `BINDING_AUTH=trusted` a call with no token runs as the deployment. That is right for
provisioning and administration, and wrong for a runtime send: a send as `ADMIN_TOKEN` has no
`allowed_device_ids`, no `allowed_channels` and no hourly budget, because those live on the token.

So every method takes `{ token }` even in trusted mode, and a token that is passed **is forwarded**
instead of the deployment credential. It cannot escalate — the caller already had the deployment —
and it keeps the service-token semantics the send gate enforces:

```ts
// Runtime: the business's own service token, bounded by its allowlist and budget.
await env.DAKFLARE.sendSms({ to, body, deviceId, idempotencyKey }, { token: serviceToken });

// Provisioning: no token, the binding's own credential.
await env.DAKFLARE.request({ path: "/v1/admin/agent-tokens", method: "POST", body: mint });
```

A service token cannot reach an admin route this way: the scope table refuses it before the
handler runs (`mint agent tokens: null`, and so on). The rule is one line in `#call`; the
separation is the scope table's, not the transport's. The binding can name an entrypoint
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
