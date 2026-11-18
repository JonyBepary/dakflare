# The console assistant

Status: pass 1. Applies to `worker/src/routes/assistant.ts`, `worker/src/lib/ai/`,
`dashboard/src/lib/assistant.ts`, the AI settings page and the floating panel, and the
`dakflare ai` command group. Read `AGENT_SURFACE.md` first for what the agent surface
is allowed to do; this document is about the one part of the product where a model
writes prose.

## Why it is separate from the agent surface

`AGENT_SURFACE.md` states that a model never writes prose the console renders as fact.
That rule exists so an operator cannot be handed a sentence and mistake it for a
reading. The assistant breaks the rule in one place, deliberately, and earns it back
three ways:

- It is reachable only by a human session. Every route is at `/v1/admin/assistant/*`
  or `/v1/admin/ai/*`, and none of the action names appear in
  `worker/src/lib/agent-scopes.ts`. An agent token is refused with `403` before the
  handler runs, so no agent can spend the operator's model budget or read the settings.
- Its prose is labelled as prose. The panel shows the answer verbatim and never turns
  it into a row, a count, or a state.
- By default it cannot act: it proposes, and a proposal executes only when a person
  presses Accept on a card, which calls a route that re-validates the payload. The agent
  runtime changes that for one deployment at a time and always behind a grant — see
  `AGENT_RUNTIME.md`; with autonomy off (the shipped default) this sentence is exact.

## What the operator configures

One selection, one secret.

| Where | What |
|---|---|
| `ai_settings` (D1, singleton row) | `provider`, `model`, `base_url` |
| Worker secret `AI_CHAT_API_KEY` | the provider's key, never stored in D1, never returned |
| `AI_CHAT_PROVIDER`, `AI_CHAT_MODEL`, `AI_CHAT_BASE_URL` | defaults for a deployment with no row |
| `AI_DAILY_TOKEN_BUDGET` | daily ceiling, default `20000` |
| `ai_usage` (D1) | the counter, one row per UTC day |

Two providers are implemented, and they cover most of the market:

- `workers-ai` uses the Worker's own `AI` binding. No key, no egress, an account that
  already deploys this gateway can use it immediately.
- `openai-compatible` is one adapter for every gateway that speaks `POST
  {baseUrl}/chat/completions` with a Bearer key: OpenAI, OpenRouter, Groq, Together,
  DeepSeek, Mistral, vLLM, Ollama, LM Studio, and most corporate proxies. A key is
  required; the base URL must be `https`, or `http` on localhost.

`baseUrl` is rejected for `workers-ai` rather than stored and ignored, so a settings
page can never look configured while pointing nowhere.

## The five routes

All are admin-gated: `read` for the settings GET (a member may look), `write` for
everything else, and an agent token is refused on every one. Writes that change a setting
are audited.

| Route | Answers |
|---|---|
| `GET /v1/admin/ai/settings` | `{provider, model, baseUrl, apiKeyConfigured, hint, budget:{day,used,limit}}` |
| `PUT /v1/admin/ai/settings` | the read shape after validating and saving |
| `POST /v1/admin/ai/test` | `{ok, provider, model, took_ms, sample}`, capped at 64 output tokens |
| `POST /v1/admin/assistant/chat` | `{answer, proposals:[{id, kind, title, summary, payload}]}` |
| `POST /v1/admin/assistant/proposals/:id/accept` | `{kind, result, patch?}` |

The chat body is `{message, context?: {route?, flowId?}}`, capped at 8 KiB. Any other
context key is a `400`: message bodies, message lists and contact data never enter the
context, so an attacker's own SMS cannot steer a proposal.

A missing key is `503 {error:"ai_unavailable", reason:"missing_key"}` and no outbound
call is made. Budget exhaustion is `429 {error:"budget_exhausted", used, limit}`.

## Proposals: what a model may suggest, and what happens on accept

The model must answer with one JSON object holding `answer` and at most three
proposals of a closed set. Parsing is defensive in this order: clean JSON, then a
fenced block, then the first-to-last brace span. Anything else returns the raw text as
the answer with zero proposals, which is honest and useless in the right way.

Each proposal is stored with a **server-minted** id (`ap_…`), a 15-minute expiry and
the actor who asked. Accept re-reads the row, requires it unconsumed and unexpired, and
re-validates the payload:

- `create_rule` drops any model-supplied `id`, refuses a `regex` matcher, forces
  `allow_shortcode:false` and `device_id:null`, then calls the same handler the console
  uses (`handleRulesPost`). A model can create a rule; it cannot overwrite one, and it
  cannot make one reply to a shortcode.
- `create_template` writes nothing. It returns a validated `{name, body}` draft that the
  card shows as text, because a template is only real once something references it. The
  operator copies it from there; the draft itself is never stored.
- `stage_workflow_patch` writes nothing. The model proposes **operations** (`add`,
  `move`, `rename`, `remove`), naming the node ids it was shown; the Worker applies them
  deterministically to the flow it already read and returns the composed `{patch}`. The
  console hands that to the editor's own sink, which draws it as a ghost that still needs a
  human Accept.

  This is a correction, not a preference. Asking a 70B model to reproduce a whole graph as
  one JSON object produced invalid JSON against a live flow (a `]` where a `}` belonged,
  measured twice), which the parser rightly refused. Operations are small, checkable, and a
  refusal names the step: `removing "Condition" is refused because it has two outgoing
  connections`. Anything the Worker refuses appears in the response's `withheld` list and
  is shown to the operator, so a missing card is never a mystery.

Consumption is a timestamp written **after** success, so a failed accept leaves the
proposal usable and a successful one cannot be replayed.

## What a model's answer is trusted to be

Nothing. The reply is parsed defensively in this order: clean JSON, a fenced block, the
first-to-last brace span, and finally the same span with its open brackets closed, because
one missing closer is common and repairable. When all of that fails, the `answer` string
is salvaged with a string-aware scan so the operator still reads the prose; only when that
also fails does the raw text become the answer with no proposals.

The adapter is equally suspicious of the provider. The same `env.AI.run(...)` call really
does answer three ways: a bare string, `{response}`, and a chat-completions object with
`choices[]`. All three are read, and an error object delivered with a 200 becomes
`unparseable` with the shape named (`object with keys …`) rather than a silent empty
answer. `src/lib/__checks__/workers-ai-adapter.mjs` asserts each shape and each refusal.

Output is capped at 1024 tokens for chat: a complete graph did not fit in 400.

## Cost, and what stops a loop

The daily budget is checked before dispatch and charged after, from the provider's
reported usage or, when it reports none, from a deliberately pessimistic estimate of
three characters per token. The same counter covers `/ai/test`. There is no per-user
split and no streaming; a deployment that wants a tighter leash lowers
`AI_DAILY_TOKEN_BUDGET` or configures it in D1 (`ai_usage`).

Adapters cap output at 400 tokens by default and 1024 hard. The registry refuses an
unknown provider kind, a missing `AI` binding, a missing key, and a missing base URL,
each with a machine-readable reason that becomes the `503` body.

## The provider this deployment uses

One settings row governs both roles. Token Lab (`https://api.tokenlab.amd.com/v1`) answers
them today:

- **chat** through the ordinary `openai-compatible` adapter, model
  `DeepSeek-V4.1-Flash`, with `GET /v1/admin/ai/models` and `dakflare ai models`
  listing the ten ids the gateway publishes;
- **System One** through `POST /v1/systemone` with model `Clef`, which answers the same
  typed questions the Workers AI binding does.

`GET /v1/admin/ai/settings` returns the effective values for both roles. An empty
`system1_model` resolves to the provider's **decision** model, not to the chat model — a
gateway decides with a different name than it chats with (Token Lab decides with `Clef` and
chats as `DeepSeek-V4.1-Flash`), and inheriting the chat name asked the decision endpoint for
a model it does not serve. An empty `system1_base_url` does inherit the chat base, because the
origin is usually the same host:

```json
{ "provider": "openai-compatible", "model": "DeepSeek-V4.1-Flash",
  "baseUrl": "https://api.tokenlab.amd.com/v1",
  "system1": { "model": "Clef", "provider": "openai-compatible",
               "baseUrl": "https://api.tokenlab.amd.com/v1" },
  "apiKeyConfigured": true,
  "keySource": { "chat": "AI_CHAT_API_KEY", "system1": "TOKENLAB_API_KEY" },
  "hint": "Key configured. Requests go to https://api.tokenlab.amd.com/v1.",
  "budget": { "day": "2026-11-15", "used": 12, "limit": 20000 } }
```

Keys resolve **per role**, because a key issued by one gateway must never travel to another:
chat uses `AI_PROVIDER_API_KEY` then `AI_CHAT_API_KEY`; System One uses
`AI_PROVIDER_API_KEY` then `TOKENLAB_API_KEY`. A single `AI_PROVIDER_API_KEY` serves both,
which is what a deployment with one vendor wants; `keySource` says which secret actually
answered, so the console never claims "configured" on the strength of a variable the role does
not read. Set either with `cf workers secrets update <NAME> --type secret_text`.

The provider is stored, not configured by env. `SYSTEM1_PROVIDER`, `SYSTEM1_DEFAULT_MODEL`
and the TypeSafe `jev` adapter are gone: env is only the fallback when no row exists, and a
D1 fault on a serving path degrades to that fallback instead of failing the request.

## Deploy order

Apply `0010_unified_ai_provider.sql` **before** the Worker that reads `system1_model` and
`system1_base_url`: the code selects both columns, so a code-first deploy makes the settings
read fail (every AI call then falls back to the env defaults, and GET reports the fallback as
though it were configured).

## In the console

`/admin/security/ai` (rail: Security → AI assistant) holds the provider form, the key
state and the allowance. The panel is honest about the two things it cannot do: a
missing key is shown as the command that installs one
(`cf workers secrets update AI_CHAT_API_KEY --type secret_text`), and there is no field
anywhere to type a key, because a key typed into a browser ends up in a history, a log
or a screenshot.

The floating button bottom-right opens the agent panel. It sends the current `route`
and `flowId` as context, renders proposals as cards, and shows the operator's saved
transcript above the turn in progress. On a deployment with the agent runtime, the
transcript is durable: `GET /v1/admin/agent/conversation` is read on open, "Clear"
deletes it inline, and each question carries an idempotency key so a retry is answered
rather than re-run (`replayed: true`). Files are attached to a question through
`POST /v1/admin/agent/attachments` (one file, at most 1 MiB, three kept per operator,
24 h); text is read into the turn's user message, an image is named to the model and
the panel says it cannot be seen, and removing a chip deletes the stored file. A
deployment with the runtime off keeps the older stateless route: it still answers, and
the panel says the turn is not added to a transcript.

`stage_workflow_patch` is the one proposal with a second step. The card offers "Stage
the patch" only while a workflow editor is mounted, because the handover is a function
the editor registers on mount (`registerWorkflowPatchSink`). With no editor open the
card says so and links to the editor rather than pretending a POST would do something.

## In the CLI

```bash
dakflare ai providers                 # what the gateway is set to, key present or not, budget
dakflare ai configure --provider openai-compatible --model gpt-4o-mini --base-url https://api.example.com/v1
dakflare ai test                      # one small call, prints the sample
```

`--agent` prints one compact JSON document. Exit codes are semantic: `2` bad input
(including `--api-key`, which the CLI refuses because the key belongs in a Worker
secret), `4` permission, `5` a budget or state conflict, `6` a precondition (no key),
`75` the provider or network was unreachable.

## What this pass does not do

- **No PKCE or OAuth.** One vendor's flow does not justify a second credential
  lifecycle and a code-redeeming endpoint, and this repo has no CSP to protect a
  verifier. Use the provider's static key as a Worker secret.
- **No streaming, no history, no multi-turn.** One question, one answer.
- **No per-user or per-token budgets**, and no cost table: tokens, not currency.
- **No `anthropic` or `gemini` adapter.** Both are a `chat(messages)` shape and fit the
  interface; neither is written until something needs it.
- **No recommender.** The assistant can propose a rule, a template or a staged patch.
  It does not analyse the fleet for you; that is `/v1/agent/telemetry`, which is typed.
