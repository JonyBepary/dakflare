# EdgePay-owned Worker sync

EdgePay binds two named entrypoints on a **second deployment of this Worker**:

| EdgePay binding | Entrypoint | Purpose |
|---|---|---|
| `DAKFLARE_ADMIN` | `DakFlareAdminApi` | Trusted same-account provisioning, health, token mint, webhook create/rotate, replay |
| `DAKFLARE_RUNTIME` | `DakFlareRuntimeApi` | Service-token sends/reads, usage, message status |

The instance is `edgepay-dakflare-worker` with its own resources:

- D1 `edgepay-dakflare-db` (`bdae464b-7d48-4647-8807-bb067f99064a`)
- KV `edgepay-dakflare-kv` (`a9153f9b3812461db42413046f4262e8`)
- R2 `edgepay-dakflare-media`
- Queues `edgepay-dakflare-webhook-queue`, `edgepay-dakflare-ingest-queue`, `edgepay-dakflare-ingest-dlq`
- Workflow `edgepay-flow-execution-workflow`

`worker/wrangler.edgepay.toml` is the isolated deployment config. It deliberately
omits crons (Free-plan trigger slots), `AGENT_SVC` (that split Worker does not
exist in this account) and static assets. Secrets (`ADMIN_TOKEN`,
`AUTH_PEPPER`, `BETTER_AUTH_SECRET`, `WEBHOOK_SECRET_KEY`) are not in the file;
Wrangler preserves them across deploys.

## Why a timer, not GitHub Actions

This repository's deployment posture is sovereign: the operator's authenticated
`cf`/`wrangler` session deploys, and no edge credential is stored in CI. The
sync lane follows that rule. A systemd user timer runs on the operator machine,
pulls `origin/main`, and deploys from a detached worktree. Nothing in GitHub
can deploy production and no token is copied into `~/.config` beyond the
Wrangler OAuth session that already exists.

## Install

```bash
./scripts/install-edgepay-sync.sh
loginctl enable-linger "$USER"   # optional: run while logged out
```

The timer fires five minutes after boot and every 15 minutes. It deploys only
when `worker/src`, `worker/migrations`, `worker/package*.json` or
`worker/wrangler.edgepay.toml` changed. A commit is recorded only after the
deployed `/v1/integration/manifest` answers (200 or 401; 404 means the old
build). A failed deploy leaves the previous version serving.

## Manual

```bash
./scripts/sync-edgepay-worker.sh                 # deploy if main advanced
DAKFLARE_SYNC_DRY_RUN=1 ./scripts/sync-edgepay-worker.sh
DAKFLARE_SYNC_FORCE=1 ./scripts/sync-edgepay-worker.sh
```

State and logs:

```text
~/.local/state/dakflare/edgepay-worker.commit     # last verified deploy
~/.local/state/dakflare/edgepay-worker.log
~/.local/state/dakflare/edgepay-worker-worktree/  # detached origin/main
```

## D1 migrations

The script deploys code, not schema. Apply the isolated database's migrations
from the worktree after a migration lands on `main`:

```bash
cd ~/.local/state/dakflare/edgepay-worker-worktree/worker
npx wrangler d1 migrations apply DB --remote --config wrangler.edgepay.toml
```

Adding migrations to the timer is intentionally not automatic: a D1 schema
change is reviewed by a human, while code-only security fixes are exactly the
thing that should not wait.

## First-deploy checklist for a new EdgePay instance

1. Pair the handset against `edgepay-dakflare-worker`.
2. From EdgePay, call `POST /api/admin/v1/dakflare/provision` with the paired
   device ids and the carrier sender allowlist.
3. Install the returned token:
   `cf workers secrets update DAKFLARE_RUNTIME_TOKEN --type secret_text`.
4. Confirm `GET /api/admin/v1/dakflare/integration` returns the manifest.
5. Rotate the webhook secret with `POST /api/admin/v1/dakflare/rotate-secret`
   and verify a delivery lands with the new secret.
