# SMS Gateway v5 — Master Plan (Rev C)

> **Status:** Rev C — verified, corrected, re-scoped.
> **Supersedes:** `sms_gateway_v5_master_plan_and_timeline.md` (Rev B).
> **Date:** October 18, 2026
> **Authority map:** wire format → `PROTOCOL_CONTRACT_V5.md` (frozen). This file → schedule, gates,
> test strategy. Rev B → historical record only; do not implement from it.

---

## 1. What Rev C changes

Rev B was reviewed line-by-line against current Cloudflare documentation, the Android platform
reference, and a logic/protocol audit. 4 blockers, 7 high, and 6 medium defects were found; 24 claims
were verified correct. The architecture survived intact. The contract, the test strategy, and the
schedule did not.

### 1.1 The central correction

Rev B's risk model (§1) identified three risks: ECDSA encoding drift, Durable Object hibernation edge
cases, and two-phase ACK ordering. **The first is a non-risk and the real risks were elsewhere.**

| Rev B's stated risk | Verified verdict |
|---|---|
| ECDSA P1363 vs DER encoding drift | **Sound, not a risk.** Workers `crypto.subtle.verify()` for ECDSA genuinely consumes raw 64-byte IEEE P1363 — the exact format Rev B produces. No change needed. |
| DO hibernation edge cases | **Partly sound.** The APIs are all current and correct (`acceptWebSocket`, `setWebSocketAutoResponse`, `serializeAttachment`, `getWebSocketAutoResponseTimestamp`). The defects were in *our use* of them, not the APIs. |
| Two-phase ACK ordering | **Sound and important** — but the state machine it depends on was never enforced (§1.3 below). |

The risks Rev B missed, ranked by what they cost:

1. **The frozen contract was not implementable.** Rev B's §4 canonical string left five decisions
   unstated, each producing a silent `401`. The most important thing in the whole plan — the thing
   §1 correctly says is undebuggable from a phone — was under-specified.
2. **The gate could not fail.** The harness and the client would have shared an author, so a protocol
   mismatch could never be detected by the harness that defines the protocol.
3. **The gate's own artifacts did not exist.** §6 referenced `sms_gateway_test_harness.mjs` and
   `hoppscotch_sms_gateway_collection.json` as present in the workspace. Neither existed.
4. **The gate was not sound even if it had run.** "Pass twice in a row against `--local`" can pass on
   leftover state, and local runs enforce none of the production limits.

### 1.2 Contract changes

`PROTOCOL_CONTRACT_V5.md` is now the sole authority. It resolves Rev B's five ambiguities by
**deletion rather than documentation**:

- Signed requests carry **no query string at all** — the `search` segment is removed from the
  canonical string, deleting the percent-encoding and parameter-ordering divergence class entirely.
- `X-Timestamp` is fixed to exactly 13 decimal digits; `X-Nonce` to 32 lowercase hex characters.
- `GET`/`HEAD` use `SHA-256("")`, spelled out explicitly with its value.
- The contract ships a real P-256 test key and three byte-exact vectors, including a non-ASCII body
  whose UTF-8 byte length (159) is the only thing that catches a string-vs-bytes digest bug.

### 1.3 Fixes applied to the backend

Full register in §6. The structural changes:

- **Replay guard rewritten.** Rev B's `device_meta` JSON ring buffer with `evicted_max_ts` is
  withdrawn. It self-DoSes: 33+ signed requests inside 300 s evicts a live nonce and raises the floor,
  after which a legitimate request whose `ts` *equals* that floor is rejected at millisecond
  resolution. Replaced with a `nonces(nonce PRIMARY KEY, ts, exp)` table, `exp = MAX(now, ts) + W`.
  The `MAX(now, ts)` is load-bearing: `now + W` alone reopens a replay hole for future-dated
  timestamps, because the ±300 s window is symmetric.
- **State transitions enforced in SQL.** Rev B declared the state machine in §4 and never enforced it;
  a stale ack retry could regress `DELIVERED` → `ACKED_BY_DEVICE`. Now `UPDATE … WHERE state IN
  (<allowed predecessors>)`, with `rowsWritten == 0` meaning "rejected no-op", returning `200`.
- **Single-command push.** Rev B's `tryPushOverWebSocket` selected `state IN
  ('PENDING','DISPATCHED')` on every enqueue, so a batch of N sends re-delivered command #1 N times
  and reset its ack timer each time. The enqueue path now pushes only the new command.
- **`alarm()` no longer deletes before awaiting**, so an alarm retry is not a silent no-op.
- **The rule linter is now a real RE2 compatibility checker**, not three string regexes that `((a+))+`
  and `(?=…)` walk straight through. Rev B let lookahead through, which then fails to compile in
  RE2/J on the device — two grammars with nothing reconciling them.
- **Pairing is ordered correctly** and checks the Durable Object's response; Rev B burned the
  single-use code first and returned `{ok:true}` even on a DO failure.
- **`getWebSocketAutoResponseTimestamp` is advisory only.** It is not verified to return a genuine
  value under `wrangler dev --local`. Rev B made it load-bearing in two places; that is withdrawn.

### 1.4 Gaps that were closed by adding scope

Rev B had no admin path to read incoming messages, never persisted outbound rows despite
`messages.direction CHECK (direction IN ('in','out'))`, left `sendFcmHighPriorityWake()` an empty stub
while listing FCM OAuth2 as a B4 deliverable, and bound a KV namespace that no code referenced. All
four are now implemented, with the KV binding made load-bearing as the OAuth token cache.

---

## 2. Test strategy — three tiers, honestly labelled

Rev B had one gate and described it as proving more than it can. Rev C separates what each tier
actually establishes. Verified mechanism references are in §7.

### Tier 1 — Offline conformance suite (`wrangler dev --local`, real `workerd`)

**Proves: application logic and the frozen HTTP contract.**
**Does not prove: platform behaviour.**

`wrangler dev --local` runs the same `workerd` runtime as production, so Worker JS/V8 semantics, D1,
DO SQLite, DO alarms, hibernating WebSockets, KV, and Web Crypto are real, not mocks. That is a strong
tier. It is not unlimited.

Local runs enforce **none** of the production limits — CPU time, subrequest count, memory. A green
local suite can still fail in production with a 1102.

### Tier 2 — Staged deploy gate (replaces "one `--remote` smoke check")

**Proves the platform behaviour the local tier structurally cannot.**

Rev B's single `--remote` smoke check was the wrong shape: `--remote` needs real provisioned resources,
and one check cannot cover the gap list. Rev C replaces it with a staged deploy running the *same*
black-box HTTP suite, plus explicit platform assertions (§4.3).

### Tier 3 — Physical device matrix (Android, B6)

**Proves what no document can settle.** Enumerated in §5.

### 2.1 Account-backed testing is available

An earlier draft treated "runs with no Cloudflare account" as a requirement. **It is not.** We are
authenticated against a real account, so the constraint is dropped. Three consequences:

1. **The `--remote` blocker is gone — and resources are now provisioned.** Rev B shipped all-zero
   placeholder resource IDs. `--local` treats them as inert local keys so it passes, but `--remote`
   validates them against the account and fails. Real resources now exist and their IDs are in
   `worker/wrangler.toml`: D1 `sms_gateway` = `8d88069e-71cf-49a2-ba33-c150b02246b7` (region APAC) and
   KV `cabb16caf192453fa17b54b6e0f9d85f`. The migration is applied remotely — `devices`, `messages`,
   `pairing_codes`, `rules` all verified present. The Tier 2 gate is reachable.
2. **Remote bindings close two gaps cheaply.** Marking individual bindings `remote = true` points local
   development at the *real* D1 and KV while the Worker still runs locally. That exercises real KV
   eventual consistency and real D1 behaviour — the two gaps §7 lists as "not simulated locally" — with
   no deploy at all. The DO binding must stay local, because a remote DO changes the very semantics
   under test.
3. **The harness is unaffected.** It speaks HTTP to `localhost:8787`, so it neither knows nor cares
   whether the bindings behind the Worker are local or remote.

What this does **not** change: CPU, subrequest and memory limits are still not enforced locally, alarm
retry is still not reproduced, and the edge WebSocket idle timeout still does not exist. Those remain
Tier 2 or Tier 3 items regardless of account access.

### 2.2 The run-twice requirement, corrected

Rev B: *"Re-running `suite` a second time immediately passes with zero state corruption."* Unsound —
local state persists across `wrangler dev` runs by default, so a second run can pass because it
inherits the first run's rows, hiding a broken migration or a non-idempotent path.

Rev C requires **both**, and distinguishes them:

1. **Same-state run:** `suite` twice against the same `.wrangler/state`. Catches non-idempotency and
   accumulated-state bugs.
2. **Fresh-state run:** `rm -rf worker/.wrangler/state` first. Catches migration and bootstrap bugs.

Both must pass. The harness mints a **fresh random `device_id` on every run**, so the same-state run
is a genuine determinism test rather than a test of leftover rows.

---

## 3. Milestone roadmap (Rev C)

Rev B's 7-day sprint put B1–B4 in four days. That assumed zero code and zero test infrastructure, which
was false: the harness, the Hoppscotch collection, the FCM client, and the entire Android app were all
unwritten. The realistic track is **15 days** at 4–6 h/day, from a workspace that now contains the
frozen contract.

| Milestone | Days | Deliverables | Gate |
|---|---|---|---|
| **B0: Contract & artifacts** | **Day 0** ✅ | `PROTOCOL_CONTRACT_V5.md` (frozen, with key + 3 vectors); harness skeleton; `worker/` scaffold. | Vector assertions pass in both the harness and the Worker. |
| **B1: Storage & pairing** | 1–2 | D1 schema, DO SQLite DDL in `blockConcurrencyWhile`, `nonces` table, `/v1/admin/pairing-code`, corrected `/v1/device/pair`. | `selftest` + `pair`; expiry `401`, reuse `401`, and a post-pair signed request succeeds (proves D1 and DO agree). |
| **B2: ECDSA auth & replay guard** | 2–3 | `buildCanonicalString()`, `withDevice()`, header grammars, ordered validation, `transactionSync` nonce table. | Vectors A/B/C byte-exact; tamper `401`; grammar rejects; replay `401`; fresh nonce same-ms `200`; **40+ in-window requests all `200`**. |
| **B3: HTTP endpoints & rules** | 3–5 | batch/poll/status/send/rules, RE2 linter, batch-facing hardening, outbound persistence, admin read endpoints. | Full `suite` green; **state-machine tests** (delivered-then-stale-ack stays delivered); linter rejects lookahead and `((a+))+`. |
| **B4a: WS, alarms, FCM (offline)** | 5–7 | hibernating WS, single-command push, multiplexed alarms, FCM OAuth2 + KV cache, local FCM stub. | `suite` twice — same-state **and** fresh-state; WS `hello`/ping-pong/ack; batch send delivers unique command ids; ack timeout reverts `PENDING` and the FCM stub records a send. |
| **B4b: Staged deploy gate** | 7–8 | provision real D1/KV, deploy, run the black-box suite remotely. | The §4.3 platform assertions. **Freeze the backend API here.** |
| **B5: Android crypto & transport** | 8–11 | Keystore keygen, `derToP1363()` (or `SHA256withECDSAinP1363Format`), pairing UI, `SignedHttpClient`, `remoteMessaging` FGS + WS client. | Device pairs; the client reproduces vectors A/B/C in a unit test; survives process kill and reboot with battery optimisation on. |
| **B6: SMS pipeline & auto-reply** | 12–15 | `SmsReceiver` (`goAsync` + PDU concat), `AutoReplyEngine`, Room queues, `SmsSender` multipart receipts, FCM downgrade guard, provisioning. | §5 device matrix. |

**Highest schedule risk:** B4b (platform behaviour that cannot be rehearsed locally) and B6 (a
carrier-dependent test surface where each iteration needs a real SIM).

---

## 4. Gates, restated to be falsifiable

### 4.1 The B4 gate must be able to fail

Every assertion below is currently *absence-of-failure* in Rev B. Each is now a positive test.

| Must assert | Catches |
|---|---|
| 40+ signed requests inside the window all return `200` | the withdrawn `evicted_max_ts` self-DoS |
| A fresh nonce at the *same millisecond* as a rejected one returns `200` | the `ts <= floor` boundary bug |
| A batch of N sends yields N **unique** command ids on the socket | the O(N²) re-push bug |
| `DELIVERED` then a stale ack leaves it `DELIVERED`; `EXPIRED` then a late `SENT` leaves it `EXPIRED` | unguarded transitions |
| Canonical strings equal §4.2 byte-for-byte, including the 159-byte UTF-8 body | string-vs-bytes digest bug |
| A query string on a signed request returns `400 unexpected_query` | the deleted ambiguity class |
| Pairing then a signed request succeeds | D1/DO divergence on partial pairing failure |
| Ack timeout reverts to `PENDING` **and** the FCM stub records a send | the empty-stub FCM path |

### 4.2 Backend API freeze

The freeze is the pair of contracts: `PROTOCOL_CONTRACT_V5.md` §2–§8 (wire) and §11 (surface). After
B4b, any change requires a version bump and regenerated vectors.

### 4.3 Staged deploy gate — results

**Deployed and run** at `https://sms-gateway-worker.sohelahmedjony.workers.dev` against real D1, KV and
Durable Objects, with production timings (`ACK_TIMEOUT_MS=8000`, `OFFLINE_ALERT_MS=900000`,
`STALE_SOCKET_MS=120000`) and a 32-byte random `ADMIN_TOKEN` set as a secret.

The full suite passes against the deployment: 82 assertions, 1 skipped (FCM — needs a real project).
`test-support/platform-gate.mjs` adds the assertions local cannot make: **11/11 green**.

| Assertion | Result |
|---|---|
| Socket survives 38 s idle; a push wakes the hibernated DO and is delivered | ✅ |
| Woken DO advances the command to `ACKED_BY_DEVICE` | ✅ |
| A socket pinged every 45 s is still routable after 150 s | ✅ |
| A socket quiet past `STALE_SOCKET_MS` is closed as stale (`1001`) | ✅ |
| The command is never lost on a failed push — stays `PENDING` for the next poll | ✅ |

**Two findings correct the plan:**

1. **No observable edge WebSocket idle timeout for hibernatable Durable Object sockets.** A fully silent
   socket was still routable after 150 s of no traffic. Rev B's premise — that the 45 s ping exists to
   stay under a ~100 s idle timeout — is **wrong**.
2. **The 45 s ping is still necessary, for a different reason.** It keeps
   `getWebSocketAutoResponseTimestamp` fresh, and that timestamp is the liveness evidence
   `socketLastSeen` relies on. Verified: with `STALE_SOCKET_MS=120000`, a socket quiet for 135 s is
   closed `1001 stale_connection` on the next push. Without the ping, a healthy but quiet device would
   be disconnected every `STALE_SOCKET_MS`.

**Limits probe — done.** `test-support/burst-probe.mjs`, 7/7. A 200-row incoming batch (200 statements
in a single `env.DB.batch()`) and a 100-command outbound batch both return 2xx well inside budget —
932 ms and 415 ms respectively. A 200-row replay is correctly counted as 200 duplicates, and the probe
acks its own commands so it leaves nothing `PENDING`.

**Workers Logs — configured, unverified from here.** `[observability] enabled = true` is now in
`wrangler.toml`, because without it the deployment is a black box. But the observability API returns no
events for `sms-gateway-worker` (it does return them for two unrelated workers), `wrangler tail` cannot
connect from this environment (`ETIMEDOUT`), and the API MCP's credentials get a 403 on the script
settings endpoint. So "zero errors in the production logs" is **not** verified — do not claim it. What
*is* verified is weaker but real: all 82 remote assertions assert status codes, so any error surfacing
as a 5xx would have failed the suite.

**Still open (Tier 2 residual):** forced alarm retry/backoff (needs instrumentation to make `alarm()`
throw), observed KV propagation (needs time-separated reads from different colos), and a real FCM send
(needs a real service account). None of the three touches the wire format.

---

## 5. B6 gate, restated

Rev B's B6 acceptance criteria included two items that cannot fail as written.

### 5.1 The SMS-burst gate named the wrong mechanism

Rev B: *">30 SMS/30m burst without system modal"*, provisioned by *"`sms_outgoing_check_max_count =
99999`"*. Verified against AOSP `SmsUsageMonitor`:

- The knob is `Settings.Global.SMS_OUTGOING_CHECK_MAX_COUNT` — **`Settings.Global`, not
  `device_config`**. The `device_config` namespace Rev B resembles governs ActivityManager FGS
  timeouts, a different subsystem.
- The platform default is **30 per 60 000 ms — one minute, not 30 minutes**. No primary source
  supports the 30-minute framing.
- It is writable only by a holder of `WRITE_SECURE_SETTINGS` (ADB or a privileged app). **A
  Play-installed app can never set it.** It is dev provisioning, not a shippable behaviour.
- `SmsUsageMonitor.check()` returns `true` unconditionally for the holder of `ROLE_SMS`. If the app
  holds the SMS role there is no cap and no modal — so the gate passes for reasons unrelated to the
  app.

**Rev C replaces it with:** determine the actual regime first
(`adb shell cmd role get-role-holders android.app.role.SMS`), then assert the behaviour appropriate to
it. If the app is *not* the default SMS app, record that non-default sending raises a system
confirmation dialog and that the rate-limit knob is dev-only. Drop the 30-minute claim.

### 5.2 The FGS gate passes by construction

Rev B: *"survives 6+ hours without FGS timeout"*. Verified: Android 15's 6-hour cap applies only to
`dataSync` and `mediaProcessing`. `remoteMessaging` is outside it, and may be started from
`BOOT_COMPLETED`. So the gate cannot fail.

**Rev C replaces it with recovery tests**, which is what actually kills this kind of service:

- 6-hour soak on a stock device with **battery optimisation on** — OEM battery managers are the real
  threat, not the platform timeout.
- Force-stop, then confirm the FGS restarts.
- Reboot, and confirm the `BOOT_COMPLETED` path starts the FGS without
  `ForegroundServiceStartNotAllowedException`.
- Confirm the FCM path starts the FGS *inside* the FCM handler (the allowlist exemption is granted to
  the high-priority delivery being processed, not to a later code path reading a stored flag).

### 5.3 Device test matrix

| # | Unknown | Test |
|---|---|---|
| 1 | `getPhoneNumber(subId)` may return `""` on modern SIMs, silently disabling the self-number loop guard | Compare `getPhoneNumber` / `getLine1Number` / the SIM MSISDN |
| 2 | Multipart SMS may arrive as one broadcast or per-part, OEM-dependent | Send a 2–3 part UCS-2 Bangla message; log `getMessagesFromIntent().length` |
| 3 | Whether `SHA256withECDSAinP1363Format` exists on the target device | If it does, `derToP1363()` is unnecessary — test **before** writing the DER parser |
| 4 | Whether EC keys generated without `.setDigests(DIGEST_SHA256)` can sign with `SHA256withECDSA` | Instrumented test; Android's own EC sample always sets it |
| 5 | Whether the configured rule set actually compiles under RE2/J | Compile every golden rule on device |
| 6 | Whether a 30 s wake lock suffices for a slow multipart send | Log send start and receipt over a throttled path |

---

## 6. Defect register (summary)

Full detail was produced during review. Blockers are fixed in the Frozen Contract and the backend
implementation; the remainder are tracked to their milestones.

**Blockers — all resolved in Rev C:** missing harness/Hoppscotch artifacts; the empty FCM stub with a
dead KV binding; the unimplementable canonical string; the mis-specified SMS-burst gate.

**High:** O(N²) duplicate push; unguarded state transitions; `evicted_max_ts` self-DoS; non-atomic
pairing; `alarm()` delete-before-await; linter bypass plus RE2/J incompatibility; no admin read path
and no persisted outbound rows.

**Medium:** non-canonical `X-Timestamp`/`X-Nonce` acceptance; `syncNextAlarm` falsy-`0`; `rules.id`
NULL primary key; `--remote` blocked by placeholder resource IDs; `/v1/rules` returned globally across
devices; the self-number guard can silently no-op; non-constant-time admin token comparison.

**Withdrawn rather than fixed:** Rev B's `device_meta` ring buffer, its `evicted_max_ts` floor, and its
reliance on `getWebSocketAutoResponseTimestamp` for liveness decisions.

---

## 7. Verified facts worth keeping

**Confirmed correct against primary sources** (no change needed): Workers ECDSA `verify()` consumes
raw 64-byte P1363; DER→P1363 conversion is genuinely required; `transactionSync` is synchronous and
rolls back on throw; `cursor.rowsWritten` is the correct property name; `getWebSocketAutoResponseTimestamp`
returns `Date | null`; `setWebSocketAutoResponse` takes two strings; `acceptWebSocket` plus a 16 KB
attachment limit; `new Response(null, {status:101, webSocket})`; D1 `DELETE … RETURNING` and `.first()`;
D1 `meta.changes` is `0` on a conflict-skipped insert; `remoteMessaging` is a real FGS type with no
runtime prerequisites; the Android 15 6-hour cap covers only `dataSync`/`mediaProcessing`;
`BOOT_COMPLETED` may start `remoteMessaging`; `goAsync()` gives ~10 s (30 s background);
`SMS_RECEIVED` is exempt from the implicit-broadcast clamp-down; `wakeLock.acquire(ms)` auto-releases;
re2j 1.8 and libphonenumber 9.0.41 are current; `compatibility_date = "2026-04-07"` is valid and is the
date `web_socket_auto_reply_to_close` became default.

**Not testable offline (staged deploy required):** alarm retry and backoff; CPU/subrequest/memory
limits; KV eventual consistency; D1 read replication; real hibernation under load; the edge WebSocket
idle timeout; DO placement and single-instance guarantees; TLS/CDN behaviour in front of the Worker;
real FCM delivery.

**Corrected by the staged deploy:** "the edge WebSocket idle timeout" turned out not to exist for
hibernatable DO sockets — a silent socket was still routable after 150 s. The 45 s ping's real purpose
is keeping `getWebSocketAutoResponseTimestamp` fresh so `socketLastSeen` does not age a healthy socket
out at `STALE_SOCKET_MS` (verified: a 135 s-quiet socket is closed `1001`). See §4.3.

**Local-only mechanism notes:** `--test-scheduled` drives the Worker's **cron** `scheduled()` handler,
**not** Durable Object `alarm()`. Alarms may fail after a hot reload — restart `wrangler dev`.
`--local` needs no real resource IDs, but `--remote` does.

---

## 8. Day-by-day checklist (Rev C)

**Day 0 — done**
- [x] Contract frozen; P-256 test key and 3 byte-exact vectors generated and verified.
- [x] Backend scaffold implemented with all defect fixes.
- [x] Harness complete: `sms_gateway_test_harness.mjs` (83 assertions, raw RFC 6455 client, signing
      proxy), `hoppscotch_sms_gateway_collection.json`, `test-support/` (FCM stub, `dev.sh`, README).

**Days 1–2 — B1** ✅
- [x] `selftest` green (grammar + DER→P1363 known-answer tests + all §4 vectors).
- [x] `verify-vectors` green — 21/21 byte-exact.
- [x] `pair` green, including the post-pair signed-request check that proves D1 and the DO agree.
- [x] D1 migration clean locally **and** remotely; `devices`, `messages`, `pairing_codes`, `rules` verified present.

**Days 2–3 — B2** ✅
- [x] Vectors A/B/C byte-exact in the harness **and** in the Worker's own builder; the Worker's
      hand-rolled SHA-256 matches `node:crypto` on all three, including the 159-byte UTF-8 body.
- [x] A **third** implementation (`test-support/independent-canonical-check.py`, Python) agrees
      byte-for-byte, so a shared misreading of the contract can no longer hide: 26/26.
- [x] Grammar rejections, tamper → `invalid_signature`, replay → `nonce_replay`, same-millisecond
      fresh nonce → `200`, query-before-crypto ordering.
- [x] **40+ in-window requests all `200`** — the assertion the withdrawn `evicted_max_ts` design fails.

**Days 3–5 — B3** ✅
- [x] Full `suite` green.
- [x] State-machine regression tests green (stale ack, `DELIVERED`→`SENT`, `EXPIRED`→`SENT`).
- [x] RE2 linter rejects lookahead, `((a+))+`, `((a+)(b+))+`, `(a|a)+$`, `(a|aa)+$`, possessive
      quantifiers, backreferences and a 600-byte pattern — 15/15, while still accepting valid patterns.

**Days 5–7 — B4a** ✅
- [x] `suite` twice, same-state, green — 83/83 both runs, with a distinct `device_id` per run.
- [x] WS `hello` / edge `pong` / ack; batch send delivers N **unique** command ids (the O(N²) guard).
- [x] Ack timeout reverts to `PENDING`, closes with `1011`, and the FCM stub records a send.

**Days 7–8 — B4b** ✅ (gate run)
- [x] Deployed; the full suite green against the deployment (82 pass, 1 skipped).
- [x] `platform-gate.mjs` 11/11 — hibernation, edge idle behaviour, staleness ageing.
- [x] Two plan corrections recorded from the deployment (§4.3): there is no observable edge idle
      timeout, and the 45 s ping's real justification is liveness evidence, not connection survival.
- [x] Limits probe (`burst-probe.mjs`, 7/7): 200-row batch in 932 ms, 100-command batch in 415 ms.
- [ ] Forced alarm retry/backoff, observed KV propagation, real FCM send — none touch the wire format.
- [ ] **Backend API frozen** — ready to freeze: the wire format and surface have held locally, in
      account-backed mode, and against the deployment without a single contract change.

**Days 8–11 — B5**
- [ ] Android reproduces vectors A/B/C in a unit test.
- [ ] Device pairs, connects over WSS, survives process kill and reboot with battery optimisation on.

**Days 12–15 — B6**
- [ ] §5.3 device matrix complete.
- [ ] FGS recovery tests (§5.2), not the timeout test.
- [ ] Carrier matrix recorded: multipart Bangla, mask/shortcode ignore, self-number guard.
