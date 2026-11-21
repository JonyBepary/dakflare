# Deploying

One sovereign deploy path, five configuration files, and an air-gapped CI pipeline
that verifies every check without holding any production credentials.

```bash
dakflare up              # provision/migrate/deploy from the local operator terminal
# or directly:
cd worker && npm run deploy
```

Deployment is **decoupled from GitHub Actions**: CI runs with zero repository secrets,
guaranteeing complete supply-chain immunity for edge credentials while keeping production
deployments coordinated with the physical Android handset.

## The configs

| File | Read by | Why it exists |
|---|---|---|
| `worker/cloudflare.config.ts` | `cf` (deploy, resources, `cf d1 migrations apply`) | the canonical definition of the **main** Worker: bindings, exports, triggers |
| `worker/agent/cloudflare.config.ts` | `cf`, run from `worker/agent` | the **agent** Worker: `AssistantAgent`, no public route, no auth secrets |
| `worker/wrangler.toml` | `wrangler` (local dev, `tail`, `d1 export`) | `cf` sets secrets now (`cf workers secrets update`), but cannot stream logs, and the conformance suite needs `wrangler dev --local` with Durable Object SQLite and alarms |
| `worker/wrangler.agent.toml` | `wrangler` (agent Worker local dev and `tail`) | the same split for the agent Worker; `CORE` points at the main Worker |
| `worker/wrangler.account.toml` | `wrangler` (`ACCOUNT_BACKED=1` test lane) | the preview D1 and KV are `remote = true`; the Worker and Durable Object still run locally |

`cf build` delegates to Wrangler, which is also why `wrangler.toml`'s `[assets] directory`
still decides what is uploaded as static assets.

**They must not drift.** `npm run check:config` compares the binding, limiter and variable
names across `wrangler.toml`, `wrangler.account.toml` and `cloudflare.config.ts`, and CI runs
it. It caught a real one: the `cf` migration dropped `AUTH_PASSWORD_MODE`, `MAGIC_LINK_FROM`
and `MAGIC_LINK_TTL_SECONDS`, so a `cf` deploy had silently disabled the password factor that
`wrangler.toml` had been enabling. Adding a binding to one file and not the others is a
binding that is `undefined` in one tool and present in the other.

## Two Workers

`dakflare-worker` is the public edge: auth, the console, `/v1`, the handset socket and every
queue consumer. `dakflare-agent-worker` owns `AssistantAgent`, the MCP surface and the agent
conversation routes. The split exists because the assistant's dependencies — the agents SDK,
the MCP SDK, the model providers — were 2.2 MB of bundle and about 50 ms of startup paid by
every request, including a device heartbeat.

| | Main Worker | Agent Worker |
|---|---|---|
| public route | yes | none (`workers_dev = false`) |
| `AssistantAgent` | retired (deleted tombstone) | owns a **new** namespace |
| auth | sessions, passkeys, TOTP, `ADMIN_TOKEN` | none; `CORE` calls back for SMS, health and TOTP |
| D1 / R2 | both | the same database and bucket |
| reached by | the internet | `AGENT_SVC` from the main Worker only |

The main Worker resolves the actor and the ticket, then forwards `/agents/*`, `/v1/mcp`, `/mcp`
and `/v1/admin/agent/*` through its `AGENT_SVC` service binding. The agent Worker never sees a
session cookie or `BETTER_AUTH_SECRET`; a tool that needs to send an SMS asks the main Worker
through `CORE`, so scopes, limiters and audits still apply.

**Deploy the agent Worker first.** `AGENT_SVC` names it, and a deploy that binds a Worker which
does not exist yet fails. `dakflare up` and the pack do this in order; a manual deploy is:

```bash
cd worker/agent && npx cf deploy     # then
cd .. && npm run deploy
```

**The namespace move is one-way.** The agent Worker's `AssistantAgent` is a different Durable
Object namespace from the one the main Worker used to export, and the old one is retired with an
explicit `state: "deleted"` export. The transcript does not follow automatically: it was exported
and imported once with `/v1/admin/agent/export` and `/v1/admin/agent/import` before the move.
D1 rows and R2 objects are unaffected, because the object keys are the same.

**Secrets that must exist on both.** `ADMIN_TOKEN` has to be identical on both Workers,
because the agent Worker presents it to `CORE`. The provider keys move with the model call: the
turn runs inside the agent Worker's Durable Object, so `AI_CHAT_API_KEY` (or
`AI_PROVIDER_API_KEY`) and `TOKENLAB_API_KEY` have to be set there too. A secret set with
`cf workers secrets update` exists on one Worker only — it is not inherited through a service
binding, and it cannot be read back, so each one is set twice:

```bash
npx cf workers secrets update ADMIN_TOKEN --worker dakflare-agent-worker --type secret_text
npx cf workers secrets update AI_CHAT_API_KEY --worker dakflare-agent-worker --type secret_text
npx cf workers secrets update TOKENLAB_API_KEY --worker dakflare-agent-worker --type secret_text
```

`npm run verify:deploy` fails when the agent Worker has no chat key, because the alternative is
an assistant panel that answers `missing_key` only when someone uses it. A `dakflare up` install
does not hit this: it deploys both Workers with the same `--secrets-file`, so whatever is in
`.dev.vars` lands on both.

The release pack carries both Build Outputs (`pack.json` → `agent`), and `dakflare up` fills the
D1 id into both `worker.config.json` files before deploying.

## The pipeline

`.github/workflows/pipeline.yml`, on every pull request, every push to `main`, and by hand.

| Job | What it proves |
|---|---|
| `worker` | `tsc --noEmit`, and the three configs agree |
| `skills` | the four `SKILL.md` packages pass the skills gate |
| `dashboard` | the console type-checks and builds |
| `simulator` | the phone's Svelte UI type-checks |
| `rust` | `cargo test --locked` in `simulator/core` and `simulator/flow` |
| `suite` | the conformance suite against a local stack: `pair` then `suite` |

**The check pipeline holds no secrets.** `pipeline.yml` does not read `CLOUDFLARE_API_TOKEN` or
`ADMIN_TOKEN`, so forks and pull requests run the complete suite hermetically.

There is no Cloudflare credential in this repository at all. Migrations are applied from a
machine with a signed-in `cf`, which is a local credential that never leaves your laptop and
needs no secret store to hold it.

That also removes the only reason a workflow needed a Cloudflare API token: a GitHub runner has
no browser and no OAuth session, so a workflow that talked to the API had to carry a long-lived
account credential. Nothing here does any more.

## First-time setup

1. **Sign in locally to Cloudflare**:
   ```bash
   cf auth login
   ```
2. **Provision and deploy**:
   ```bash
   dakflare up --email you@example.com
   ```
   `dakflare up` provisions D1 and KV, generates and writes configurations, applies D1 migrations,
   uploads secrets from `worker/.dev.vars`, deploys the Worker, and prints a pairing code
   for the physical handset.

**Worker secrets are not managed in CI.** `ADMIN_TOKEN`, `BETTER_AUTH_SECRET`, `AUTH_PEPPER`,
`RESEND_API_KEY` and `FCM_SERVICE_ACCOUNT_JSON` are set once with
`npx cf workers secrets update <NAME> --worker dakflare-worker --type secret_text` (or uploaded from `worker/.dev.vars` by
`dakflare up`) and survive a deploy. `cf deploy --secrets-file` is driven locally by `dakflare up`.

## Deploying

There is no deploy job. A push to `main` runs the six check jobs and stops; production moves
only when you run it:

```bash
cd worker && npm run deploy        # builds the console, then `cf deploy`
```

`dakflare up` does the same for a fresh deployment, plus provisioning. This is deliberate: the
account credential never lives in the repository, and a deploy is a decision rather than a
consequence of merging.

Both deploy scripts first run `scripts/assert-clean-dashboard.mjs`, which refuses when
`dashboard/src` differs from HEAD. `cf deploy` uploads `worker/public/admin`, and that is a
build artifact: nothing in it says which source produced it. On 2026-11-19 a work lane built
the console to verify its own work, and `deploy:no-dashboard` — which means *do not rebuild*,
not *do not upload* — published those files to production a commit early. The guard turns
that into a refusal with the file list. `--force` (or `DAKFLARE_ALLOW_DIRTY_ASSETS=1`) ships
anyway, and says so.

## Order of operations for a schema change

1. Back up: a Time Travel bookmark, or an export. `docs/OPS_BACKUP.md`.
2. Apply it from a machine signed in to `cf`, passing the database **ID**:

   ```bash
   cd worker
   npx cf d1 migrations list  8d88069e-71cf-49a2-ba33-c150b02246b7
   npx cf d1 migrations apply 8d88069e-71cf-49a2-ba33-c150b02246b7
   ```

3. Merge the code that expects the new schema, then deploy it by hand (`cd worker && npm run
   deploy`). Merging alone no longer moves production.

Migrations are never part of the deploy pipeline: a migration is a one-way door, and a
pipeline that applies one on every push will eventually apply one nobody read.

## Traps when scripting `cf`

Five that have each cost this repository something:

- **An aborted destructive command exits `0`.** In a non-interactive session a delete without
  `--force` prints `Aborted.` to stderr and returns success. A script that trusts the exit status
  will report a deletion that did not happen; check for the resource, not the exit code.
- **D1 migrations need the database ID, never the name.** `cf d1 migrations list sms_gateway`
  answers `Expected a D1 database ID, but received <database>="sms_gateway". Database names and
  binding names are not accepted.` The ID is `8d88069e-71cf-49a2-ba33-c150b02246b7`.
- **`tail` is still Wrangler; secrets are not.** `cf workers secrets update <NAME> --type secret_text`
  sets one (it asks for the value, so the key never reaches argv). `cf` still cannot stream logs.
  Wrangler does not read `cloudflare.config.ts`, so pass the worker name:
  `npx cf workers secrets update ADMIN_TOKEN --worker dakflare-worker --type secret_text`.

- **The pack refuses an old `cf`.** A prebuilt pack is built by `cf` 1.0.0-rc.2 and
  `dakflare up` checks the installed version against `pack.json.requires.cf` before it does
  anything. A global `cf` from the 1.0.0 betas is `1.0.0-rc.0`, which sorts below the floor, so a
  machine that has been deploying for weeks can still be told to upgrade:
  `npm install -g cf@1.0.0-rc.2`.
- **`deploy:no-dashboard` still uploads the console.** The name reads as "Worker only"; it
  means "do not run the dashboard build first". Whatever is in `worker/public/admin` goes
  live, including a build another process left there. The guard described under Deploying is
  what makes this safe now; `deploy:worker` is the honest name for the same command.
- **`cf deploy` can exit `1` on a deploy that worked, because of the Workflow trigger.**
  Intermittently — three deploys in a row failed this way on 2026-11-18/19 and the next one
  with identical config succeeded — a deploy ends with:

      Trigger configuration for "dakflare-worker" was only partially updated:
        Workflows:
      - Workflow "flow-execution-workflow": A request to the Cloudflare API
        (/accounts/<id>/workflows/flow-execution-workflow) failed.
            - workflows.api.error.internal_server [code: 10001]
        Successful trigger changes were not rolled back.

  The error is the API's, not the config's: `workflows.api.error.internal_server` is a 500.
  The Worker upload, the cron schedule and both queue triggers are applied before that
  step, and the workflow itself ends up bound: `cf workflows list` shows
  `script_name: dakflare-worker` with a `modified_on` inside the deploy minute. Measured
  on version `9675e667`: exit `1`, new routes answering `401` instead of `404`, and the
  workflow listed and current. So when it happens the exit code is wrong, not the deploy.
  A release gate therefore reads the evidence, not the status: `npm run verify:deploy` in
  `worker/` checks the newest version id, six live routes (four answering `401` rather than
  `404`, which is how a route that exists differs from one that was never deployed, and
  `/agents/assistant/assistant` answering `426` rather than `404`, which is how a gate wired to
  the split Worker differs from one whose `className` never matches), the workflow still bound
  to the deployed script, and an empty unapplied migration ledger. `node
  scripts/verify-deploy.mjs --expect <id8>` pins the version the build was supposed to become. Re-running `cf workers triggers deploy` alone exits `0`
  and changes nothing, which is a safe second opinion when in doubt.

## Rolling back

A Worker rollback does **not** roll back D1. Check which of the two you need.

```bash
cd worker
npx cf workers versions list          # what is deployed, newest first
```

To go back to an earlier commit, revert it on `main` and deploy by hand. A revert is preferred
over a rollback: `main` stays the thing that is running, and the next deploy does not silently
re-introduce the bad commit.

Data is a different job: `npx wrangler d1 time-travel restore sms_gateway --remote
--timestamp=...` rolls the database back in place for up to 30 days. Both are in
`docs/OPS_BACKUP.md`.

## Smoke and health

`worker/scripts/smoke.sh <url>` is the check to run after a manual deploy. CI never runs it.
It needs no credential and asserts the three things a deploy must keep serving:

- `/` returns 200 **and more than 1000 bytes**, because a deploy that loses its assets still
  answers 200 with the Worker's own 404 body.
- `/admin/` returns 200, the console shell.
- `/source` returns 302, the AGPL-3.0 §13 offer.

The authenticated check is `dakflare doctor`: config, health, admin token, schema, migrations,
bindings, auth mode, D1 counts, phone contact, SMS role, installed build. It is the same check
a person runs; nothing in CI runs it for you.

## What is deliberately not automated

- **The Android build.** It needs the NDK, JDK 21 and the release keystore. It is local:
  `cd simulator && npx tauri android build --apk --target aarch64`. A release APK replaces
  cleanly because the certificate does not change, so pairing and the battery whitelist
  survive.
- **Pairing a handset.** `dakflare pair`, then the phone scans or types the code.
- **Durable Object classes.** Adding or renaming one is a one-way door described at the top of
  `cloudflare.config.ts`. It lands with `cf deploy`, never with a version upload, and only
  once the `exports` list matches every live class.
- **Secrets.** See above.

## Forks

`cloudflare.config.ts` carries this account's D1 and KV ids, so it deploys only into this
account. A fork copies `cloudflare.config.template.ts`, creates its own database and namespace,
and pastes the ids in. The quick start in `README.md` is the short version.
