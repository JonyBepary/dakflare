# Call DakFlare from a Worker or a Cloudflare Workflow

> Bind the DakFlareApi RPC entrypoint from another Worker or a Workflow step, with the trust modes, the idempotency rule a retrying step needs, and the same-account limit.

Another Worker in the same Cloudflare account — or a Cloudflare Workflow, which runs inside one —
can call this deployment as a typed service instead of building a `Request` and remembering which
header carries the credential. That interface is `DakFlareApi`, a `WorkerEntrypoint` exported by
`dakflare-worker` (`worker/src/binding-api.ts`).

## The consumer's config

```toml
# the consumer Worker's wrangler.toml
[[services]]
binding = "DAKFLARE"
service = "dakflare-worker"
entrypoint = "DakFlareApi"
```

The consumer needs a compatibility date that supports RPC entrypoints; this repository's own
Worker runs `compatibility_date = "2026-04-07"` with `nodejs_compat`, which is what the entrypoint
is built and tested against.

## The type

`dakflare-worker` is not published to npm, so there is nothing to `import` from. Declare the part
you call, and keep `worker/src/binding-api.ts` as the reference when a method changes:

```ts
// the consumer's types.ts
export interface DakFlareBinding {
  health(): Promise<unknown>;
  deployment(): Promise<unknown>;
  devices(): Promise<unknown>;
  messages(query?: { limit?: number; deviceId?: string; direction?: string }): Promise<unknown>;
  sendSms(input: {
    to: string;
    body: string;
    deviceId?: string;
    idempotencyKey?: string;
  }): Promise<unknown>;
  ask(message: string, options?: { idempotencyKey?: string }): Promise<unknown>;
  request(input: {
    path: string;
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  }): Promise<{ status: number; body: unknown; bookmark: string | null }>;
}

interface Env {
  DAKFLARE: Service<DakFlareBinding>;
}
```

## From a Worker

```ts
export default {
  async fetch(_request: Request, env: Env): Promise<Response> {
    // Idempotent by key: the same key returns the same command instead of a second SMS.
    const sent = await env.DAKFLARE.sendSms({
      to: "+8801711000111",
      body: "Payment settled.",
      idempotencyKey: "invoice-9021-notice-1",
    });
    return Response.json(sent);
  },
};
```

| Method | Route it reaches | Credential |
| --- | --- | --- |
| `health()` | `GET /v1/auth/mode` | none — that route is public by design |
| `deployment()` | `GET /v1/admin/health` | yes |
| `devices()` | `GET /v1/devices` | yes |
| `messages({ limit, deviceId, direction })` | `GET /v1/messages` | yes |
| `sendSms({ to, body, deviceId?, idempotencyKey? })` | `POST /v1/sms/send` | yes |
| `ask(message, { idempotencyKey? })` | `POST /v1/admin/agent/say` | yes |
| `request({ path, method, body })` | anything under `/v1` | yes |

Every one of them delegates to the same router the public API uses, with
`X-Dakflare-Client: binding`, so scopes, rate limiters, audit rows, idempotency and the D1 bookmark
behave exactly as they do for an HTTP caller. `request()` is the escape hatch: a route added to the
HTTP API is callable the day it ships, which is what keeps the two surfaces from drifting.

## From a Cloudflare Workflow

A Workflow class lives in a Worker and receives the same `env`, so the binding is used exactly as
above — inside a step:

```ts
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

interface Payload {
  to: string;
  invoice: string;
}

export class InvoiceFollowUp extends WorkflowEntrypoint<Env, Payload> {
  async run(event: WorkflowEvent<Payload>, step: WorkflowStep) {
    const { to, invoice } = event.payload;

    const first = await step.do("first notice", async () =>
      this.env.DAKFLARE.sendSms({
        to,
        body: `Invoice ${invoice} is due.`,
        // A step retries. The key is what makes the retry a replay instead of a second SMS.
        idempotencyKey: `invoice-${invoice}-notice-1`,
      }),
    );

    await step.sleep("wait three days", "3 days");

    await step.do("second notice", async () =>
      this.env.DAKFLARE.sendSms({
        to,
        body: `Invoice ${invoice} is still due.`,
        idempotencyKey: `invoice-${invoice}-notice-2`,
      }),
    );

    return first;
  }
}
```

Two rules make that safe, and they are the whole reason to read this page:

1. **Every `step.do` can run more than once.** Derive the `idempotencyKey` from the event and the
   step's purpose, never from `Date.now()`. A key that changes on retry buys a second SMS.
2. **A step's result is durable, the side effect is not.** If a step sends and then fails before
   returning, the retry re-enters the closure; the key is what makes that a no-op rather than a
   duplicate.

`step.sleep` is the Workflow's own clock, not the flow interpreter's `delay` node. A `delay` inside
a `dakflare.flow/v2` graph runs on the handset, and a graph the handset could only partly perform
reports `partial` so the Worker runs the rest — see the state-machine reference for that boundary.

## Who may act

`BINDING_AUTH` on the **producer** decides, read per call:

| Mode | Credential | What a bound Worker can do |
| --- | --- | --- |
| `trusted` (default) | none — the binding is the credential | everything the deployment can, including sending SMS and spending money |
| `agent_token` | a `dkf_agt_` token passed per call | whatever that token's scopes allow; an act additionally needs a live authority grant |

`trusted` is the default because a single-owner account is already the trust boundary, and it is
also why the limit below matters. If `BINDING_AUTH=trusted` and the deployment has no
`ADMIN_TOKEN`, every credentialed call refuses with `binding_untrusted` naming both ways out,
rather than running unauthenticated.

A refusal is a thrown error carrying a code, so the consumer branches on the code and never on the
sentence:

```ts
try {
  await env.DAKFLARE.sendSms({ to, body });
} catch (error) {
  if (error instanceof Error && "code" in error) {
    // binding_untrusted · binding_token_required · idempotency_conflict
    // turn_in_progress · unknown_attachment · sms_cap …
  }
  throw error;
}
```

## What a binding cannot do

- **It cannot cross accounts.** Service bindings, queues, workflows and rate-limit namespaces are
  account-scoped. From another account, call the HTTP API with a `dkf_agt_` token.
- **A raw Durable Object binding bypasses all of it.** Binding `AssistantAgent` or `DeviceGateway`
  directly gives you their RPC methods with no session, no scope, no rate limit and no audit row —
  the binding is the authorisation. Use `DakFlareApi` unless you are deliberately operating the
  object.
- **It cannot see a machine's transcript by accident.** The entrypoint sends
  `X-Dakflare-Client: binding`, so its conversation and attachments are its own. `ADMIN_TOKEN`
  remains one shared credential: this separates cooperating clients by declared identity, not
  cryptographically.
- **The event payload of this repository's own Workflow is internal.** `flow-execution-workflow`
  (bound here as `FLOW_WORKFLOW`, class `FlowExecutionWorkflow`) is invoked by the Worker's flow
  fallback; a consumer can bind it, but its payload shape is not a contract.
