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

## Check-only timer, explicit update

This repository's deployment posture is sovereign: the operator's authenticated
`wrangler` session deploys, and no edge credential is stored in CI. The update
lane follows that rule:

- a systemd user timer **checks** daily (default 09:00) and never deploys;
- `edgepay dakflare worker update` is the only deploy path;
- the candidate must be on `origin/main`, have a successful **Conformance
  Pipeline** run for its exact SHA, be at least 24 hours past that run
  (`--min-age-hours`), and change Worker source/migrations/config;
- pending D1 migrations require `--apply-migrations`; there is no implicit
  schema change and no CI/soak override.

The same-account webhook transport is a service binding (`EDGEPAY` →
`edgepay-cf`), so the queue consumer delivers the signed v1 request without a
public `fetch()` and without the same-zone error 1042. Cross-account receivers
still use public HTTPS.

## Install

```bash
./scripts/install-edgepay-check.sh
loginctl enable-linger "$USER"   # optional: run while logged out
```

The timer checks daily at 09:00. It logs a candidate and, if `notify-send`
exists, sends a desktop notification. It has no deploy path. Use the EdgePay
CLI to change cadence:

```bash
edgepay dakflare worker schedule daily|weekly|monthly|off
```

## Manual

From EdgePay:

```bash
edgepay dakflare worker check
edgepay dakflare worker update          # prompts; --yes in scripts
edgepay dakflare worker status
```

From this repository (same engine, lower level):

```bash
./scripts/sync-edgepay-worker.sh --check
./scripts/sync-edgepay-worker.sh --deploy --min-age-hours 24
./scripts/sync-edgepay-worker.sh --deploy --apply-migrations
```

A deploy uses a detached worktree under
`~/.local/state/dakflare/edgepay-worker-worktree`, the existing Wrangler
session, and records the commit only after `/v1/integration/manifest` answers
200/401. A failed deploy leaves the previous version serving.

State and logs:

```text
~/.local/state/dakflare/edgepay-worker.commit     # last verified deploy
~/.local/state/dakflare/edgepay-worker.log
~/.local/state/dakflare/edgepay-worker-worktree/
```

## D1 migrations

The script deploys code, not schema. `update` refuses while migrations are
pending unless `--apply-migrations` is passed; the operator confirms that in
the CLI. To apply them separately:

```bash
cd ~/.local/state/dakflare/edgepay-worker-worktree/worker
npx wrangler d1 migrations apply DB --remote --config wrangler.edgepay.toml
```

A schema change is reviewed by a human; a code-only security fix is the case the
check/update lane is meant to make quick.

## First-deploy checklist for a new EdgePay instance

1. Pair the handset against `edgepay-dakflare-worker`.
2. From EdgePay, call `POST /api/admin/v1/dakflare/provision` with the paired
   device ids and the carrier sender allowlist.
3. Install the returned token:
   `cf workers secrets update DAKFLARE_RUNTIME_TOKEN --type secret_text`.
4. Confirm `GET /api/admin/v1/dakflare/integration` returns the manifest.
5. Rotate the webhook secret with `POST /api/admin/v1/dakflare/rotate-secret`
   and verify a delivery lands with the new secret.
