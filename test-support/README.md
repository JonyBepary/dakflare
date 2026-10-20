# test-support — running the conformance suite

The harness is `sms_gateway_test_harness.mjs` at the repository root: a zero-dependency Node
"Virtual Android Device" that implements the wire protocol of `PROTOCOL_CONTRACT_V5.md` from the
contract text alone. It was deliberately **not** derived from `worker/src` — its only value is that it
can disagree with the server.

## Prerequisites

- Node 24+
- `npm install` already run in `worker/`
- Cloudflare credentials (`wrangler whoami`) **only** for account-backed mode
- Nothing else. The harness has no dependencies of its own.

## Two modes, one config

`worker/wrangler.toml` marks D1 and KV `remote = true`. `wrangler dev --local` disables remote
bindings, so the same file serves both lanes:

| Mode | Command | D1 / KV | Worker + Durable Object |
|---|---|---|---|
| Local | `ACCOUNT_BACKED=0 ./test-support/dev.sh` | local SQLite | local |
| Account-backed | `ACCOUNT_BACKED=1 ./test-support/dev.sh` | **real** D1 + KV | local |

Account-backed mode is the interesting one: the Worker and the DO still run locally under `workerd`,
but D1 and KV are the real resources. That exercises real D1 behaviour and real KV semantics without
deploying anything.

`dev.sh` starts the FCM/OAuth2 stub, applies the migration to the right target, and starts the Worker
with the timing vars woven down so alarms fire in seconds instead of minutes:

```
ACK_TIMEOUT_MS=1500   OFFLINE_ALERT_MS=5000   STALE_SOCKET_MS=2000
FCM_BASE_URL=http://127.0.0.1:8790
GOOGLE_TOKEN_URL=http://127.0.0.1:8790/token
```

## Running

```bash
# terminal 1
ACCOUNT_BACKED=1 ./test-support/dev.sh

# terminal 2
node sms_gateway_test_harness.mjs selftest    # no server needed
node sms_gateway_test_harness.mjs pair
node sms_gateway_test_harness.mjs suite
```

Other commands: `verify-vectors`, `proxy`, `ws`, `stub`, `reset`.

## The two runs the plan requires

`suite` is not idempotent-by-accident: it mints a **fresh random `device_id`** every time `pair` runs,
so a second consecutive run is a genuine determinism test rather than a test of leftover rows. Both of
these must pass:

```bash
# 1. same-state: catches non-idempotency and accumulated-state bugs
node sms_gateway_test_harness.mjs pair && node sms_gateway_test_harness.mjs suite
node sms_gateway_test_harness.mjs pair && node sms_gateway_test_harness.mjs suite

# 2. fresh-state: catches migration and bootstrap bugs
rm -rf worker/.wrangler/state        # local mode only; account-backed uses real D1
```

Local state persists across `wrangler dev` runs by default, which is exactly why "run it twice" alone
is not a sound determinism check.

## Independent third implementation

The harness (JavaScript) and the Worker (TypeScript) are separate implementations, but both were
derived from the same contract by the same author-of-record. If the *contract* were misread, both
would misread it identically and the suite would stay green while the wire format was wrong.

`independent-canonical-check.py` is the missing third opinion: a different language, a different
SHA-256, a different string-building idiom, and a separate reading of the same frozen text.

```bash
python3 test-support/independent-canonical-check.py   # 26 checks, no server, no dependencies
```

It asserts only what is deterministic — the body digest and the canonical string. ECDSA signatures are
randomised (contract §4.3), so they are not compared; the JS harness proves signature validity and the
DER→P1363 conversion separately. Run it whenever the contract changes.

## What the suite covers

83 assertions across nine sections: admin surface, auth rejection (grammar, tamper, signature length,
query-before-crypto ordering), the replay guard (including **40 consecutive in-window requests** and
two fresh nonces in the same millisecond), the RE2 linter (15 patterns, rejects and accepts), incoming
batch hardening, the full command state machine (including stale-ack and expired-resurrection
regressions), WebSocket (`hello`, edge auto-response `pong`, batch-send uniqueness), the ack-timeout
alarm with a real FCM wake, and negative controls.

Three assertions are load-bearing because they target specific defects that the original design would
have shipped:

- **40 in-window requests** — the withdrawn `evicted_max_ts` ring buffer fails at 33.
- **No command delivered twice** — the original `tryPushOverWebSocket` re-pushed every in-flight
  command on each enqueue, so a batch of N re-delivered command #1 N times.
- **Stale ack does not regress `DELIVERED`** — transitions were previously unguarded.

## Tier 2 — the platform gate

`platform-gate.mjs` covers the assertions no local run can make. It needs a deployed Worker, an
identity from `pair`, and `WORKER_URL` + `ADMIN_TOKEN`:

```bash
node sms_gateway_test_harness.mjs pair          # with WORKER_URL/ADMIN_TOKEN exported
node test-support/platform-gate.mjs             # ~5.5 min
```

It asserts:

- **Hibernation.** A socket survives 38 s idle (past the DO's ~10 s eviction), a push wakes the DO, and
  the command is delivered and acked. This is the real proof that attachment serialisation and SQLite
  recovery work.
- **Keepalive.** A socket pinged every 45 s is still *routable* after 150 s — probed with a ping, not
  merely checked for a close frame.
- **Staleness.** A socket quiet past `STALE_SOCKET_MS` is closed `1001` by the push path, and the
  command is not lost (it stays `PENDING` for the next poll).

### What the deployment corrected

Rev B assumed a ~100 s edge WebSocket idle timeout, which the 45 s ping existed to stay under. **There
is no observable idle timeout for hibernatable Durable Object sockets** — a silent socket was still
routable after 150 s.

The ping is still necessary, for a different reason: it keeps `getWebSocketAutoResponseTimestamp` fresh,
and `socketLastSeen` uses that timestamp as liveness evidence. With `STALE_SOCKET_MS=120000`, a socket
quiet for 135 s is closed `1001 stale_connection` on the next push. Without the ping, a healthy but
quiet device would be disconnected every `STALE_SOCKET_MS`.

**Caution when writing gates like this:** an earlier version idled *without acking*. `hello` pushes
leftover `PENDING` commands, the un-acked ones tripped the 8 s `ack_timeout`, and the alarm closed every
socket with `1011` **before** the idle window ended — so the gate was measuring a socket that was
already dead. Drain and ack during idle, the way a real device does.

Deploying needs an admin secret, because the Worker fails closed without one:

```bash
cd worker
printf '%s' "$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')" | npx wrangler secret put ADMIN_TOKEN
npx wrangler deploy --var ACK_TIMEOUT_MS:8000 --var OFFLINE_ALERT_MS:900000 --var STALE_SOCKET_MS:120000
```

### Limits probe

Local runs enforce none of Cloudflare's CPU, subrequest or memory limits, so a green local suite says
nothing about them. `burst-probe.mjs` drives real batch sizes against a deployment:

```bash
WORKER_URL=https://... ADMIN_TOKEN=... node test-support/burst-probe.mjs
```

It sends a 200-row incoming batch (200 statements in one `env.DB.batch()` — where D1 and CPU limits
first bite), replays it to prove idempotency at scale, enqueues 100 commands in one DO call, then polls
and acks everything so it leaves nothing `PENDING`. Measured against the current deployment: 200 rows
in 932 ms, 100 commands in 415 ms, 7/7 assertions.

## Free-plan budget — what actually drains it

Measured against the operations this system performs, on the **Workers Free** allowances (100,000
Workers requests/day, 100,000 Durable Object requests/day, 5M D1 rows read/day, 100,000 D1 rows
written/day, 1,000 KV writes/day, 10 ms CPU per invocation, 50 subrequests per invocation).

| Operation | Cost per unit | Free daily budget ÷ cost |
|---|---|---|
| Inbound SMS round trip (incoming batch → poll → status batch) | 3 Worker requests, **7 DO requests**, ~3 D1 rows written | **~14,300 messages/day** (DO requests bind first) |
| Outbound SMS (`POST /v1/sms/send`) | 1 Worker, 1 DO, 1 D1 read, 1 D1 write | same order |
| Idle connected device | 96 `offline_alert` alarms + ~96 ping requests/day | **~500 idle devices/day** |
| Retention cron | ≤ 10,000 rows written/day (hard-capped) | 10 % of the write budget |
| FCM token cache | ~24 KV writes/day | 2.4 % of 1,000 |

**DO requests are the binding constraint**, not Worker requests or D1 storage. One phone exchanging a few
hundred SMS/day sits at roughly 2–5 % of the daily allowance.

**The one operation that could have drained a whole budget** was the retention cron: deleting N rows
counts as N D1 rows *written*, and the original loop allowed 100 × 1,000 = 100,000 rows — the entire
daily write allowance in a single run, on a first-run backlog. It is now hard-capped at 10 batches
(10,000 rows/day), so a catch-up takes several days and can never starve live writes.

**Watch on Free: CPU is 10 ms per invocation.** A 500-row incoming batch (JSON parse + validation +
one `DB.batch()` of 500 statements) is the most CPU-hungry request in the system. It has not been
measured on Free; if `1102` errors appear under load, lower `MAX_INCOMING_MESSAGES` to 200 — the size the
burst probe measured comfortable at 932 ms wall time, most of which is I/O rather than CPU.

Not a drain, despite looking like one: the 45 s WebSocket ping is an application-level auto-response, and
Cloudflare documents that `setWebSocketAutoResponse()` replies "will not be charged"; hibernation also
means an idle socket accrues no duration.

## Free-plan check

```bash
# Workers + DO requests, D1 rows, CPU percentiles
#   Dashboard → Workers & Pages → sms-gateway-worker → Metrics / Observability
# D1 rows read+written per day
#   Dashboard → Storage & Databases → D1 → sms_gateway → Metrics
# KV operations
#   Dashboard → Storage & Databases → KV → KV → Metrics
```

If any single day approaches 100,000 DO requests, the cause is almost certainly device count × ~192/day,
not message volume.

## What local passing does NOT prove

The local suite proves **application logic and the frozen HTTP contract**. It does not prove platform
behaviour. Verified gaps:

- **Production limits are not enforced locally.** CPU time, subrequest count and memory are enforced
  only on Cloudflare's network. A green local suite can still fail in production with a 1102.
- **Alarm retry with exponential backoff is not reproduced.** Locally an alarm fires once.
- **KV eventual consistency is not simulated locally.** Local reads-after-write always succeed. In
  account-backed mode KV is real, but a single-shot test still cannot observe a 60 s propagation delay.
- **D1 read replication / replica lag is not simulated.**
- **The edge WebSocket idle timeout** turns out not to exist for hibernatable DO sockets — verified
  against the deployment, see the Tier 2 section. The 45 s ping's real job is liveness evidence, and
  `platform-gate.mjs` proves it.
- **`getWebSocketAutoResponseTimestamp` fidelity is unverified locally.** The suite does not assert on
  it, and the contract marks it advisory only (§11.3) for exactly this reason.
- **Real FCM delivery is untestable here.** The stub validates the RS256 assertion structurally, but a
  structurally valid JWT that Google rejects is only caught against the real endpoint.
- **DO placement and TLS/CDN behaviour** in front of the Worker are untestable offline.

These are Tier 2 (staged deploy) items. See §4.3 of `sms_gateway_v5_master_plan_rev_c.md`.

## Hoppscotch

```bash
node sms_gateway_test_harness.mjs pair     # once, to create the signing identity
node sms_gateway_test_harness.mjs proxy    # :8788
```

Import `hoppscotch_sms_gateway_collection.json` and point it at `http://localhost:8788`. The proxy
injects the four signed headers for device routes and forwards your `Authorization` header for admin
routes, so no request needs manual signing. Requests `2.x` and `3.x` depend on `1.1`/`1.2` having been
run first to mint and pair a device.

Note `2.5` deliberately carries a query string: a signed request must be refused with
`400 unexpected_query` **before** any crypto work.

## The FCM / OAuth2 stub

`fcm-stub.mjs` serves `POST /token`, `POST /v1/projects/:project/messages:send`, `GET /__log` and
`POST /__log/reset`. It decodes and structurally validates the incoming RS256 JWT assertion, so a
malformed assertion is recorded as a validation error rather than silently accepted.
`stub-service-account.json` is a **test fixture only** — never a real key.

## A note on `stub-service-account.json` and KV

The bearer token is cached in KV under `fcm_bearer_token`. In account-backed mode that cache is real
and persists between runs, so `tokenCalls` in `/__log` will often read `0` after the first exchange —
that is the cache working, not the exchange being skipped. Call `POST /__log/reset` between runs if you
want to count exchanges from zero.
