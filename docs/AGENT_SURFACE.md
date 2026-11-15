# DakFlare agent surface

Status: v7.1. Applies to `worker/src/routes/agent.ts`, `worker/src/lib/system1.ts`,
`worker/src/mcp/`, and the `ask` / `fix` / `flow test` / `flow apply` CLI commands.
Read `DAKFLARE_MASTER_SPECIFICATION.md` §5 for the authority model this builds on.

## Why it exists

An operator can read a bKash receipt and a flow in one glance. An agent cannot. The agent
surface turns that reading into typed decisions, bounded reads and a staged patch, and it
never lets a model act on its own authority.

Three rules hold everywhere below:

1. A model answers with probabilities over a closed set. It never writes prose that the
   console renders as fact.
2. A read is a read. A write needs a token, and a consequential write needs a live grant.
3. When a model is unreachable, the endpoint says so and returns less. It does not guess.

## System 1: typed decisions, one provider at a time

`worker/src/lib/system1.ts` is a client for Cloudflare's [Clef](https://developers.cloudflare.com/workers-ai/models/clef/)
decision models, verified live on 2026-11-15 against `@cf/cloudflare/clef-flash` and
`@cf/cloudflare/clef`.

The request is a state plus a map of typed questions, and one pass answers all of them:

```json
{
  "model": "clef-flash",
  "state": { "message": "You have received Tk 800.00 ...", "sender": "0199999999" },
  "questions": {
    "intent": { "type": "choice", "instructions": "...", "criteria": { "payment_credit": "...", "other": "..." } },
    "injection": { "type": "noul", "instructions": "..." },
    "specificity": { "type": "score", "instructions": "...", "criteria": ["...", "..."] }
  }
}
```

Answers come back under the same ids: `{ type: "choice", choice, probabilities, confidence }`,
`{ type: "noul", noul }`, or `{ type: "score", score, legend, probabilities }`.

Invariants the client enforces, because each one is a silent wrong answer when skipped:

- the model selector is in the body (`clef-flash` / `clef`), not only in the binding call;
- every question has non-empty instructions;
- choice criteria are rewritten to snake_case and always gain an `other` option;
- duplicate criteria, single-option choices and score questions without two levels throw
  before the network call;
- one threshold set for every caller: auto-route 0.90, injection block 0.70. There is no tie-break
  threshold any more, because nothing implements a tie-break: the number was aspirational.

Thresholds (`SYSTEM1_THRESHOLDS`) used to be per alias, which stopped being honest once a
single wire model answered all three: Token Lab serves `Clef` for `clef`, `clef-flash` and
`clef-omni`. One set — the strictest of the old values — is applied to all of them, and the
local alias is kept apart from the wire name so a stored `Clef` cannot index a table that has
no such key.

There are two backends, chosen in settings, not by an env var:

- **Workers AI** (`clef`, `clef-flash`, `clef-omni`), verified live on 2026-11-15, no key;
- **an OpenAI-compatible gateway** that serves `POST {base}/systemone` with model `Clef`,
  verified live against Token Lab the same day.

`SYSTEM1_PROVIDER`, `SYSTEM1_DEFAULT_MODEL` and the TypeSafe `jev` adapter are gone. `ask`
takes a resolved config — provider, wire model, base URL, key — so nothing inside it reads the
environment, and `AskResult.provider` names the backend that actually answered.

## Endpoints

All four live under `/v1/agent/*` and go through the same gate as the rest of the console
(`withAdminAccess`): `ADMIN_TOKEN` with `X-Dakflare-Client: cli`, a Better Auth session, or a
`dkf_agt_` token whose scope allows the action. Bodies are capped at 8 KiB.

| Endpoint | Scope | Answers |
|---|---|---|
| `POST /v1/agent/triage` | `messages:read` | intent, injection risk, template specificity, up to five span roles, `balance >= principal` |
| `POST /v1/agent/telemetry` | `devices:read` | one of six fixed plans, executed as a single bounded D1 batch |
| `POST /v1/agent/diagnose` | `messages:read` | a root-cause card with an exact offset |
| `POST /v1/agent/synthesize` | `flows:write` | a faithfulness score, an approval verdict and an `apply_token` |

### triage

```json
{ "message": "You have received Tk 800.00 ...", "sender": "0199999999",
  "spans": [{ "index": 0, "text": "800.00" }, { "index": 1, "text": "0.00" }] }
```

```json
{ "intent": { "choice": "payment_credit", "probability": 0.9768, "confidence": 0.9316 },
  "injection": { "probability": 0.0397 },
  "specificity": { "score": 1.4 },
  "roles": [{ "index": 0, "role": "principal_amount", "probability": 0.94 }],
  "invariant": { "balanceAtLeastPrincipal": false },
  "source": "workers-ai" }
```

With no AI binding or an unreachable provider: `source: "unavailable"`, every model field
`null`, and the deterministic invariant still computed. A 200 with less is the contract.

### telemetry

`{ "question": "which SIM has the worst signal" }` maps to one plan:
`fleet_health`, `stuck_outbox`, `sim_signal_ranking`, `workflow_failures`,
`authority_audit`, `unmatched_drift`. Anything else is `400` with the plan list. Each plan is
one `env.DB.batch` of constant SQL with bound parameters: 25 rows per query, 50 total,
`took_ms` returned. There is no raw SQL and no fan-out over devices; `stuck_outbox` reads
`messages` rows whose `reply_state` never reached a terminal value.

### diagnose

Accepts `message_id`, `flow_run_id`, `message` or `pattern`, and returns a card for one of six
codes:

| Code | Meaning |
|---|---|
| `ERR_UNICODE_ZERO_WIDTH_UCS2` | invisible character breaks the match or forces UCS-2 |
| `ERR_MULTIWORD_REF_MISMATCH` | the pattern stops inside a multi-word reference |
| `ERR_AUTHORITY_GUARD_EXPIRED_OR_HASH_MISMATCH` | no live grant, or the body hash moved |
| `ERR_APPROVAL_GATE_409_NOT_PENDING` | another operator answered first |
| `ERR_FAKE_SMS_SPOOF_QUARANTINE` | balance below principal, or a reused transaction id |
| `ERR_DOWNSTREAM_WEBHOOK_502` | webhook retries exhausted |

A message body is never echoed: the highlight is a 16/8/16 character window with control
characters escaped (`<U+200B>`), so the offender is visible without the message.

### synthesize

Judges a candidate patch and mints an `apply_token` through `canonicalTargetJson` with
`body_hash` set to the SHA-256 of the canonical patch summary and `max_uses: 1`. It applies
nothing. If the judge does not answer, the route returns `503 ai_unavailable` rather than
minting authority without a verdict. Spending the handle stays with the existing approvals
route, which is what `dakflare flow apply` calls.

## MCP

The server speaks streamable HTTP at `/mcp` (`/v1/mcp` remains for tokens already deployed
against it):

- `POST` for JSON-RPC requests and batches, `GET` for the SSE stream of a stateful session,
  `DELETE` to end it;
- `Accept` must include `application/json` or `text/event-stream`, otherwise `406`;
- stateful sessions use `Mcp-Session-Id`; stateless clients use `params._meta`;
- `GET /.well-known/oauth-protected-resource` (RFC 9728) and
  `/.well-known/oauth-authorization-server` (RFC 8414) are public; a `401` names the metadata
  document in `WWW-Authenticate`;
- audience binding (RFC 8707) rejects a token minted for a different resource.

Mutating tools (`send_sms`, and any future patch tool) require MCP elicitation first:
`elicitation/create` asks for `confirm_deployment`, a six-digit `totp_code` and `max_uses`.
Declining or timing out aborts the call with a JSON-RPC error and nothing is executed. The
minted grant is clamped by scope and lasts at most 15 minutes.

JSON-RPC errors: `-32700` parse, `-32600` envelope or session, `-32601` unknown tool,
`-32602` invalid params or payload changed after confirmation, `-32603` internal,
`-32000` not acceptable, `-32001` session not found, `-32002` elicitation declined,
`-32003` elicitation timed out, `-32004` TOTP rejected.

## CLI

| Command | What it does |
|---|---|
| `dakflare schema --flow-v2 [--json]` | the canonical flow IR schema (`cli/schema/flow-v2.json`) |
| `dakflare ask "<intent>" --flow <id> [--ndjson|--dry-run]` | synthesize a patch; streams understand, propose, verify, result |
| `dakflare fix --flow <id> [--message-id] [--message] [--pattern]` | diagnose a failure and print the card |
| `dakflare flow test --flow <id> --corpus <jsonl>` | run the corpus against the built `flow.wasm` locally |
| `dakflare flow apply --token <handle> [--totp]` | spend a synthesis handle through approvals |

`--ndjson` emits one JSON object per line on stdout and prose on stderr. `--dry-run` prints
the request without sending it. Exit codes keep their meaning: `75` for a temporary network
or model failure, `6` when there is nothing to spend or no built engine, `5` for a decided
request, `4` for permission.

## The console assistant and the agent runtime

A model that writes prose needs a human on the other end of it, so `/v1/admin/assistant/chat`,
`/v1/admin/ai/*` and the agent runtime under `/agents/*` sit outside everything above:

- none of their action names exist in `SCOPE_FOR_ACTION`, so an agent token gets `403`
  before the handler runs and no agent can spend the operator's model budget;
- the model's only output is a proposal with a server-minted id, and accepting one calls
  the same handlers the console does, after re-validating the payload;
- the prose exception is therefore narrow and stated: it is admin-only, it is labelled as
  prose in the UI, and it never becomes a number, a state or a row.

The runtime adds acts, and it keeps the rule by moving the human decision rather than the
model's judgement: enabling autonomy mints effect-shaped grants for a bounded window (explicit
recipients and uses for SMS, a flow plus graph hash for a deploy, or the operator's explicit
"any rule" consent, which is the only grant a rule can match because the rule's id is minted by
the act). Every act re-checks the live grant, the window and the daily caps at call time — the
socket's identity is not authorisation — writes the same audit row the console writes, and is
journalled before its effect so a retry returns the recorded result instead of repeating it.
`assertHuman` guards `createGrant` and `decideApproval`, so the runtime cannot mint its own
authority. With no live grant the act is refused by name, not silently downgraded to a proposal.

Read `ASSISTANT.md` for the routes, the budget and the proposal lifecycle, and
`AGENT_RUNTIME.md` for the runtime's invariants, stages and evidence.

## What this does not do

- It does not compose arbitrary edits from inside the Worker. The palette reads `add`,
  `move`, `rename` and `remove` deterministically and stages the result (`agent-patch.ts`);
  an agent stages a graph directly with `stage_flow_patch`.
- It does not apply anything from `synthesize`. A human approves, then an apply spends.
- It does not act on a stale read: a diagnosis is a snapshot, and a grant is the only thing
  that authorises a change.
- It does not guess a provider: the settings row decides, and a missing key or a refused base
  URL is an error with a reason rather than a fallback to a different vendor.
