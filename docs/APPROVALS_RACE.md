# Approval race — live proof of the single-winner decide path

`test-support/approval-race.mjs` exercises the approval decide path through the
real routes, with two decisions in flight at once. It exists because the 409
branch in the CLI was previously only read, never reached live.

It touches no repository state on disk and mints nothing durable: every grant it
creates is revoked and the throwaway agent token is deleted before it exits.

## What it proves

The Worker claims a pending approval with **one conditional UPDATE**:

```sql
UPDATE approval_requests
   SET state = ?, decided_by = ?, decided_at = ?
 WHERE id = ? AND state = 'PENDING' AND expires_at > ?
```

`meta.changes === 0` is the loser's answer. `lib/authority.ts` explains why the
claim moved ahead of the grant insert: minting first let two approvers both read
`PENDING`, both mint a grant, and both report success; the second grant's
supersede then silently revoked the first, so one operator was told they had
granted authority that no longer existed.

The script asserts:

1. **Approve vs approve** — exactly one `200`, exactly one `409`, with body
   `error: "not_pending"`. The winner minted one grant; the approval names
   exactly that grant; the loser learns who decided, when, and which way.
2. **Approve vs reject** — exactly one `200`, exactly one `409`. If approval
   won, exactly one grant exists for the approval. If rejection won, **zero**
   grants exist for it and the response carries no grant. The loser is told the
   winning direction and the decider.
3. **Cleanup** — every grant minted by the run is revoked, the agent token is
   deleted, and a final `GET /v1/admin/grants?token=…&live=1` must be empty.

## How it requests an approval

It uses the product routes, not a test-only back door:

| Step | Route | Credential | Expected |
|---|---|---|---|
| Mint throwaway agent with `flow_deploy_prod` | `POST /v1/admin/agent-tokens` | admin | `200` |
| Ask to deploy a flow (no live grant) | `DELETE /v1/admin/workflows/:id` | agent | `202` `approval_required` |
| Decide the request twice, concurrently | `POST /v1/admin/approvals/:id/approve` or `/reject` | admin | one `200`, one `409` |
| Inspect grants | `GET /v1/admin/grants?token=…[&live=1]` | admin | `200` |
| Revoke minted grants | `DELETE /v1/admin/grants/:id` | admin | `200` |
| Delete throwaway agent | `DELETE /v1/admin/agent-tokens/:id` | admin | `200` |

The approval scope is `flow_deploy_prod`, target `{ "flow_id": "race_*" }`. Each
case uses a fresh flow id so `requestApproval` cannot return an earlier pending
row, and so one case's grant cannot satisfy the next case's ask.

## Running it

Start the stack in one terminal:

```bash
./test-support/dev.sh
```

`pair` is **not** required for this test: it uses an admin credential and the
flow-deploy route, so it never signs a device request. (The harness's `pair` mode
is only needed for device-facing tests.)

Then, in another terminal:

```bash
node test-support/approval-race.mjs \
  --url http://127.0.0.1:8787 \
  --token dev-admin-token
```

Or with environment variables / the CLI config:

```bash
DAKFLARE_URL=http://127.0.0.1:8787 \
DAKFLARE_TOKEN=dev-admin-token \
  node test-support/approval-race.mjs
```

Connection resolution, in order:

| Setting | Sources, first match wins |
|---|---|
| URL | `--url`, `DAKFLARE_URL`, `WORKER_URL`, `~/.config/dakflare/config.json` `"url"` |
| Token | `--token` / `--token-file`, `DAKFLARE_TOKEN`, `ADMIN_TOKEN`, CLI config `"token"` |

There is **no built-in default**, so a missing connection is an error rather
than a silent attempt against localhost or production. Both `url` and `token`
must resolve.

Exit codes:

| Code | Meaning |
|---|---|
| `0` | Both races passed and cleanup left no live grant |
| `1` | An assertion failed, an unexpected status arrived, or cleanup failed |
| `2` | Usage / no connection / invalid URL |
| `6` | The dev stack is not running (told to run `./test-support/dev.sh`) |

`--help` prints the same contract without touching the network. Offline runs
never print a stack trace.

## Exact statuses it expects

| Observation | Expected |
|---|---|
| Agent flow-deploy without a grant | `202`, `error: "approval_required"` |
| Two concurrent approves | one `200`, one `409` |
| Losing decide | `409`, `error: "not_pending"` |
| Winning decide | `200`, `ok: true`, `approval.state` `APPROVED` or `REJECTED` |
| Grants per approval | `1` if approved, `0` if rejected |
| Final live grants for the throwaway token | `0` |

## The two failure modes a race can hide

**Lost update.** Both approvers read `PENDING`, both write, and the second write
overwrites the first. The response can still look fine: two `200`s, or one `200`
plus one `409` for the wrong reason. The tell is in the grant table, not the
response body. The test therefore checks `grant.approval_request_id`: an
approval may name at most one grant, and a rejected approval may name none. A
lost update shows up as two grants, or as a `200` whose grant is already revoked.

**Both answers winning.** Before the claim was a conditional UPDATE, both
decide calls could return `ok: true`; `createGrant`'s supersede then revoked the
first grant, so one person was told they had granted something that no longer
existed. This is why the test requires exactly one `200` and one `409`, not
merely "at least one 409". It also checks that the winning `200`'s grant is the
row still present for that approval.

A third, quieter failure is covered by the cleanup pass: a race that leaves a
live grant behind after the test. That is a real grant, not test residue, and the
script fails if `live=1` is non-empty.

## What the local run showed

Command:

```bash
DAKFLARE_URL=http://127.0.0.1:8787 DAKFLARE_TOKEN=dev-admin-token \
  node test-support/approval-race.mjs
```

Representative output (exit `0`):

```
case 1 approve vs approve: PASS — one 200 (grant d8918257…), one 409 not_pending; loser told admin-token approved (via approval lookup; body omitted them)
case 2 approve vs reject: PASS — rejected won; 409 not_pending loser told admin-token rejected (decided_by/decided_at in body); grants for the approval: 0
cleanup: PASS — minted grants revoked, agent token deleted, no live grants left
```

Five further consecutive runs also exited `0`, with case 1 and case 2 each
observing one `200` and one `409`, and cleanup empty every time. In one run the
approve-vs-reject case hit the true claim-loser branch and its `409` body carried
`decided_by` and `decided_at`.

### The early 409 now carries `decided_by`

`decideApproval` has two `409` exits, and they used to disagree:

* the **early** check, when the row already reads non-`PENDING`, returned
  `{ error: "not_pending", message: "request is already APPROVED" }` with no decider;
* **`lostRace`** returned `decided_by` and `decided_at`.

A single-isolate `wrangler dev` serialises the two requests, so the early branch is
the common result. That made the wire contract depend on timing. It is fixed:
`src/lib/authority.ts` now returns `decided_by`/`decided_at` from both exits, and the
reject route in `src/routes/approvals.ts` spreads them like the approve route does.

Verified after the fix: the script's two cases both report "(decided_by/decided_at in
body)" for the losing caller on the early branch, with no approval lookup needed. The
script keeps its lookup fallback anyway, because an older deployment still has the gap
and the CLI already compensates for it (`cli/bin/dakflare.js`, the
`result.status === 409` block).

### Unexercised

* **True multi-isolate simultaneity.** A local Worker runs in one isolate and
  usually serialises the two decide requests; the claim-loser branch was reached
  only intermittently (once in six runs). Production can interleave across
  isolates, but this test cannot force that from a single local process.
* **The reject route's `409` never carries structured `decided_by`/`decided_at`**
  even on `lostRace`: `handleApprovalReject` returns only
  `{ error, message }`. The loser is still told by the message ("already
  approved by …"), and the test accepts that via the message/lookup fallback,
  but a structured-field assertion for the reject loser would fail.
* **Expiry racing a decision** (`error: "expired"`) is not exercised; the
  approval TTL is 15 minutes and the test does not wait for it.
