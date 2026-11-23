# Documentation

Everything that explains this repository is here. The exceptions are the four files that have to
live where they are: `README.md` at the root because that is what someone opening the repository
sees first, `AGENTS.md` because agents look for it there, `SECURITY.md` because GitHub looks for
it there, and `skills/*/SKILL.md` because that directory shape is what `npx skills add` reads.

Start at the root `README.md` for what the product is. This page is the map of everything else.

**The same material is also a site.** `apps/docs` is a Fumadocs application that renders the
guides, the reference and the architecture notes for a reader who does not want to browse a
repository — including `/docs/{slug}.md` (every page as clean markdown), `/llms.txt`, and an MCP
endpoint, so an agent can read it as easily as a person. This directory remains the source of
truth; the site is a presentation of it, and should be corrected here first.

## The product

| | |
|---|---|
| `DAKFLARE_MASTER_SPECIFICATION.md` | the system reference: surfaces, storage, protocols, invariants |
| `MULTI_PLATFORM_AI_HUB_SPEC.md` | the multi-channel hub: WhatsApp, Telegram, session windows, templates |
| `MULTICHANNEL.md` | what shipped for the connector tiers, the invariants, and the two known gaps |
| `SCHEDULING.md` | scheduled sends, the Scheduler object, claims, pacing and quiet hours |

## Agents

| | |
|---|---|
| `AGENT_SURFACE.md` | the agent-facing HTTP surface: triage, telemetry, diagnose, synthesize, MCP |
| `AGENT_RUNTIME.md` | the acting agent: authority, grants, sockets, webhooks, turn claims. The contract |
| `ADR_001_AGENT_RUNTIME.md` | why the runtime is built this way, and what was rejected |
| `ASSISTANT.md` | the assistant panel and the model behind it |
| `APPROVALS_RACE.md` | the single-winner approval path, and the live proof of it |
| `WORKER_BINDING.md` | calling this Worker from another Worker or a Cloudflare Workflow |

## Console and design

| | |
|---|---|
| `CONSOLE.md` | the console as a component: layout, navigation, states |
| `CONSOLE_UX.md` | what each screen promises an operator |
| `DESIGN_2026.md` | the visual contract: tokens, motion, type, the rules a surface must keep |
| `WORKFLOW_EDITOR.md` | the canvas: phases, ghost patches, staging |
| `WEBMCP.md` | what the editor declares to an agent instead of letting it guess from the DOM |

## Running it

| | |
|---|---|
| `OPS_DEPLOY.md` | deploy, schema order, the `cf` traps, rollback |
| `OPS_BACKUP.md` | Time Travel bookmarks and exports |
| `RELEASE.md` | cutting a release: one version, one tag, what the archive contains |
| `STORE_RELEASE.md` | publishing the handset app: artifact contract, IzzyOnDroid, F-Droid, Obtainium, self-hosted repo |
| `PHONE_APP.md` | the handset app: shape, SMS role, flow engine, wake capability |
| `PHONE_RELEASE.md` | building and signing the APK |
| `HARNESS.md` | the conformance harness and the dev stack |
| `CLI.md` | the zero-dependency CLI |
| `FLOW_SCHEMA.md` | the `dakflare.flow/v2` document, derived from the validator |

## Reference that outlives a release

| | |
|---|---|
| `STATE_MACHINES.md` | every state machine, and whether it is guarded, declared or derived |

## The record

`history/` is point-in-time material — plans, frozen contracts and review notes. It is not
current documentation, and its own `README.md` says so. Read it for how a decision was reached,
never for what the code does now.
