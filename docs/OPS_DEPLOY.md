# Deploying

One deploy path, two configuration files, and a pipeline that runs the checks before it
touches production.

```bash
cd worker
npm run deploy        # build the console, then `cf deploy`
```

That is what CI runs. Nothing else is required to ship.

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
| `rust` | `cargo test --locked` in `simulator/core` (89 tests) and `simulator/flow` (8) |
| `suite` | the conformance suite against a local stack: `pair` then `suite` |
| `deploy` | only on a push to `main`, or a manual run: build, `cf build`, `cf deploy --prebuilt`, smoke test, `doctor` |

A pull request never reaches `deploy`, and the job needs every check to pass first. A manual
run deploys whichever ref it was started on, and the `deploy` input can be turned off to run
the checks alone.

## First-time setup

1. **API token** at `dash.cloudflare.com/profile/api-tokens`. Start from the Workers template
   and grant: Workers Scripts:Edit, D1:Edit, Workers KV Storage:Edit, Account Settings:Read.
   A deploy uploads the Worker and resolves bindings; it does not need zone or DNS access.
2. **Repository secrets** (Settings, Secrets and variables, Actions):
   - `CLOUDFLARE_API_TOKEN`, required.
   - `CLOUDFLARE_ACCOUNT_ID`, required.
   - `ADMIN_TOKEN`, optional. Without it the post-deploy `doctor` step is skipped rather than
     failed. With it, a deploy that breaks health, schema or bindings fails the run.
3. **Environment** `production` is created by the first run. Add required reviewers there if
   a deploy should wait for a person.
4. Verify the token from a terminal before trusting the pipeline:

   ```bash
   CLOUDFLARE_API_TOKEN=... cf auth whoami
   ```

**Worker secrets are not managed here.** `ADMIN_TOKEN`, `BETTER_AUTH_SECRET`, `AUTH_PEPPER`,
`RESEND_API_KEY` and `FCM_SERVICE_ACCOUNT_JSON` are set once with
`npx wrangler secret put <NAME> --name dakflare-worker` and survive a deploy. `cf deploy
--secrets-file` exists if a deployment ever needs them uploaded by the pipeline; this one does
not, so a deploy cannot overwrite a secret by accident.

## Order of operations for a schema change

1. Back up: a Time Travel bookmark, or an export. `docs/OPS_BACKUP.md`.
2. Run **Actions, D1 migrations, Run workflow**, type `apply` in the confirmation field.
3. Merge the code that expects the new schema. The push to `main` deploys it.

Migrations are never part of the deploy pipeline: a migration is a one-way door, and a
pipeline that applies one on every push will eventually apply one nobody read.

## Rolling back

A Worker rollback does **not** roll back D1. Check which of the two you need.

```bash
cd worker
npx cf workers versions list          # what is deployed, newest first
```

To go back to an earlier commit, run the pipeline on it: tag the good commit and start a
manual run on that tag, or revert and push. A revert is preferred, because `main` stays the
thing that is running.

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
