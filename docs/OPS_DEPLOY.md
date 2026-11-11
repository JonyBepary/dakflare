# Deploying

One sovereign deploy path, two configuration files, and an air-gapped CI pipeline
that verifies every check without holding any production credentials.

```bash
dakflare up              # provision/migrate/deploy from the local operator terminal
# or directly:
cd worker && npm run deploy
```

Deployment is **decoupled from GitHub Actions**: CI runs with zero repository secrets,
guaranteeing complete supply-chain immunity for edge credentials while keeping production
deployments coordinated with the physical Android handset.

## The two configs

| File | Read by | Why it exists |
|---|---|---|
| `worker/cloudflare.config.ts` | `cf` (deploy, resources, `cf d1 migrations apply`) | the canonical Worker definition: bindings, exports, triggers |
| `worker/wrangler.toml` | `wrangler` (local dev, `tail`, `secret put`, `d1 export`) | `cf` cannot set one secret or stream logs yet, and the conformance suite needs `wrangler dev --local` with Durable Object SQLite and alarms |

`cf build` delegates to Wrangler, which is also why `wrangler.toml`'s `[assets] directory`
still decides what is uploaded as static assets.

**They must not drift.** `npm run check:config` compares the binding, limiter and variable
names across `wrangler.toml`, `wrangler.account.toml` and `cloudflare.config.ts`, and CI runs
it. It caught a real one: the `cf` migration dropped `AUTH_PASSWORD_MODE`, `MAGIC_LINK_FROM`
and `MAGIC_LINK_TTL_SECONDS`, so a `cf` deploy had silently disabled the password factor that
`wrangler.toml` had been enabling. Adding a binding to one file and not the others is a
binding that is `undefined` in one tool and present in the other.

## The pipeline

`.github/workflows/pipeline.yml`, on every pull request, every push to `main`, and by hand.

| Job | What it proves |
|---|---|
| `worker` | `tsc --noEmit`, and the three configs agree |
| `dashboard` | the console type-checks and builds |
| `simulator` | the phone's Svelte UI type-checks |
| `rust` | `cargo test --locked` in `simulator/core` (92 tests) and `simulator/flow` (22) |
| `suite` | the conformance suite against a local stack: `pair` then `suite` |

**The check pipeline holds no secrets.** `pipeline.yml` does not read `CLOUDFLARE_API_TOKEN` or
`ADMIN_TOKEN`, so forks and pull requests run the complete suite hermetically.

One workflow is the exception: `migrations.yml` holds `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` because it calls `cf d1 migrations` against the real database. It is
manual, runs in the `production` environment, and refuses without the confirmation word.

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
   uploads secrets from `worker/.dev.vars`, deploys the Worker, and prints the QR pairing code
   for the physical handset.

**Worker secrets are not managed in CI.** `ADMIN_TOKEN`, `BETTER_AUTH_SECRET`, `AUTH_PEPPER`,
`RESEND_API_KEY` and `FCM_SERVICE_ACCOUNT_JSON` are set once with
`npx wrangler secret put <NAME> --name dakflare-worker` (or uploaded from `worker/.dev.vars` by
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

## Order of operations for a schema change

1. Back up: a Time Travel bookmark, or an export. `docs/OPS_BACKUP.md`.
2. Run **Actions, D1 migrations, Run workflow**, type `apply` in the confirmation field.
3. Merge the code that expects the new schema, then deploy it by hand (`cd worker && npm run
   deploy`). Merging alone no longer moves production.

Migrations are never part of the deploy pipeline: a migration is a one-way door, and a
pipeline that applies one on every push will eventually apply one nobody read.

## Traps when scripting `cf`

Three that have each cost this repository something:

- **An aborted destructive command exits `0`.** In a non-interactive session a delete without
  `--force` prints `Aborted.` to stderr and returns success. A script that trusts the exit status
  will report a deletion that did not happen; check for the resource, not the exit code.
- **D1 migrations need the database ID, never the name.** `cf d1 migrations list sms_gateway`
  answers `Expected a D1 database ID, but received <database>="sms_gateway". Database names and
  binding names are not accepted.` The ID is `8d88069e-71cf-49a2-ba33-c150b02246b7`.
- **`tail` and `secret put` are still Wrangler.** `cf` cannot stream logs or set one secret yet.
  Wrangler does not read `cloudflare.config.ts`, so pass the worker name:
  `npx wrangler secret put ADMIN_TOKEN --name dakflare-worker`.

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

`worker/scripts/smoke.sh <url>` is what the pipeline runs after a deploy. It needs no
credential and asserts the three things a deploy must keep serving:

- `/` returns 200 **and more than 1000 bytes**, because a deploy that loses its assets still
  answers 200 with the Worker's own 404 body.
- `/admin/` returns 200, the console shell.
- `/source` returns 302, the AGPL-3.0 §13 offer.

The authenticated check is `dakflare doctor`: config, health, admin token, schema, migrations,
bindings, auth mode, D1 counts, phone contact, SMS role, installed build. It is the same check
a person runs, so the pipeline cannot claim a health the CLI would not.

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
