# DakFlare — Device↔Edge Protocol Contract (v5, Rev D)

> **Status:** FROZEN. This document is the sole authority for the wire format between the Android
> device and the Cloudflare Worker. Where it disagrees with any other document, **this file wins.**
> **Frozen at:** Rev D · **Plan:** `dakflare_v5_master_plan_rev_c.md`
> **Supersedes:** §4 of `sms_gateway_v5_master_plan_and_timeline.md` (Rev B)
> **Change policy:** any edit requires bumping the version and regenerating the test vectors.
>
> **Rev D** adds the routes shipped in P0/S10 (`GET /v1/admin/health`, `GET /source`,
> `DELETE /v1/admin/devices/:id`, `GET|DELETE /v1/admin/rules`), the `413 payload_too_large` code, and
> §11.7 input caps. **The signed wire format is unchanged** — §2 canonical string, §1.1 header grammars,
> §3 signature encoding, and §4 vectors A/B/C are byte-identical, so the freeze still holds for any
> already-written client.

---

## 0. Why this document exists

Rev B described the canonical string in one line:

```
${method}\n${pathname}${search}\n${timestampMs}\n${nonceHex}\n${sha256Hex(body)}
```

That line is not implementable. It leaves five decisions unstated, and each one produces a silent
`401` with no diagnostic — the exact failure mode Rev B's §1 was built to avoid. This document
removes the ambiguity by removing the choices.

| # | Rev B left open | Rev C decision |
|---|---|---|
| 1 | `${method}` casing | **Always UPPERCASE ASCII.** |
| 2 | `${search}` — leading `?`, encoding, ordering | **Signed requests carry no query string at all.** The segment is deleted from the canonical string; the server rejects any signed request with a non-empty query. |
| 3 | `${timestampMs}` — the number, or the bytes sent? | **The literal bytes sent in `X-Timestamp`.** Grammar is fixed to exactly 13 decimal digits. |
| 4 | `${nonceHex}` — validated or not? | **Lowercase hex, exactly 32 characters** (128 bits). Enforced. |
| 5 | `${sha256Hex(body)}` — casing, and GET semantics | **Lowercase hex of SHA-256 over the raw body bytes.** For `GET`/`HEAD` the body is empty, so the digest is the SHA-256 of the empty string. |

---

## 1. Transport requirements

### 1.1 Signed requests

Every request to a device-authenticated route MUST carry these headers:

| Header | Grammar | Notes |
|---|---|---|
| `X-Device-Id` | `/^[A-Za-z0-9_-]{8,64}$/` | Assigned at pairing. |
| `X-Timestamp` | `/^\d{13}$/` | Milliseconds since Unix epoch, UTC. No sign, no whitespace, no exponent, no fractional part. |
| `X-Nonce` | `/^[0-9a-f]{32}$/` | 16 random bytes, lowercase hex. |
| `X-Signature` | base64 (standard alphabet, padded) | Exactly 64 bytes when decoded. See §3. |

### 1.2 Prohibitions

- **No query string.** `new URL(req.url).search` MUST be `""` on every signed request, including the
  WebSocket upgrade. If non-empty, the server responds `400 unexpected_query` before doing any crypto
  work. This deletes a whole class of percent-encoding and parameter-ordering divergence.
- **No duplicate headers.** The server reads the first occurrence.
- **No body on `GET`/`HEAD`.** The digest is over zero bytes.

### 1.2.1 Whitespace in header values is stripped before your handler sees it

Verified against a live server: an HTTP header value's leading and trailing whitespace (OWS) is
removed by the HTTP parser before the request reaches the Worker. `X-Timestamp:  1776470400000` is
therefore observed as `1776470400000` and **passes** the 13-digit grammar.

Consequences, both of which matter for testing:

- The grammar check can never be exercised with a whitespace-padded value end-to-end. Assert that case
  as a **unit test** of the validator only.
- End-to-end grammar tests must use forms that survive parsing: a `+` prefix, a trailing `.0`, exponent
  notation, or a wrong digit count. All four are confirmed to return `401 malformed_header`.

### 1.3 Nonce freshness on retry

A nonce is single-use, **including across retries**. A client MUST generate a fresh nonce for every
attempt. Consequence to be understood clearly: if a request times out at the transport layer but was
in fact processed, the retry will carry a new nonce and will therefore **succeed**, not be deduplicated
by the auth layer. Idempotency is the responsibility of the *endpoint*:

| Endpoint | Idempotency key |
|---|---|
| `POST /v1/sms/incoming/batch` | `(device_id, local_id)` |
| `POST /v1/sms/status/batch` | forward-only state transitions (§6) |
| `POST /v1/sms/outgoing/poll` | none needed (read + ack) |

This is stated because "replay protection" in Rev B's §1 reads as if it also provides retry
idempotency. It does not, and it must not be relied on to.

---

## 2. Canonical string

### 2.1 Definition

Let:

- `METHOD` = the HTTP method, uppercased (`GET`, `POST`, …)
- `PATH` = `url.pathname` exactly as received — **no** trailing-slash normalization, **no** decoding
- `TS` = the exact byte sequence in the `X-Timestamp` header
- `NONCE` = the exact byte sequence in the `X-Nonce` header
- `BODY_SHA256` = lowercase hex of `SHA-256(rawBodyBytes)`

Then:

```
canonical = METHOD + "\n" + PATH + "\n" + TS + "\n" + NONCE + "\n" + BODY_SHA256
```

Five lines, four `\n` (0x0A) separators, **no trailing newline**. Encoded UTF-8; every field is ASCII
by construction, so the encoding is unambiguous.

**Reference building order:** read the raw body bytes once; digest them; build the string; sign.
The body must not be parsed, re-serialized, or trimmed before digesting.

### 2.2 Worked example

```
POST
/v1/sms/outgoing/poll
1776470400000
a3f1c0d29b7e4f8a1c6d5e2b9f0a7c34
f8c6ca3e8d50126cc59e541a6644ef1db7c3eec01b155a8310dea13143b9f0a9
```

### 2.3 Worked example, `GET` with no body

```
GET
/v1/device/ws
1776470400000
0f1e2d3c4b5a69788796a5b4c3d2e1f0
e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
```

The last line is `SHA-256("")` — the empty-body digest — **not** the digest of a JSON body, and not
an empty string. Signing an empty string here is the single most common way to get this wrong.

---

## 3. Signature encoding

| Property | Value |
|---|---|
| Algorithm | ECDSA, curve **P-256** (`secp256r1` / `prime256v1`) |
| Hash | SHA-256 |
| Curve point encoding | **Raw IEEE P1363**, `r ‖ s` concatenated |
| `r`, `s` width | 32 bytes each, **fixed** — zero-padded on the left |
| Total signature | **exactly 64 bytes** |
| Wire format | base64 (standard alphabet, `=` padded) |

### 3.1 The encoding trap

Android's `Signature.getInstance("SHA256withECDSA")` returns **ASN.1 DER**, whose length varies with
the value of `r` and `s` (`70`, `71`, or `72` bytes for P-256). Workers' `crypto.subtle.verify()`
for ECDSA consumes **raw P1363** and interprets a DER blob as a 64-byte signature, which fails.

Therefore the client MUST convert. Convert by parsing the DER `SEQUENCE` of two `INTEGER`s and
left-padding each to exactly 32 bytes — do not slice, and do not assume DER is 64 bytes.

> **Investigate before implementing.** `Signature.getInstance("SHA256withECDSAinP1363Format")` may be
> available via Conscrypt on the target Android version, in which case the DER parser is unnecessary
> and a whole class of bugs disappears. Verify with a one-line instrumented test on the actual device
> before writing `derToP1363()`. If it is unavailable, write the converter.

### 3.2 Server-side validation order

Cheapest checks first, so malformed traffic never reaches the curve operation:

1. All four headers present → else `401 missing_auth_headers`
2. Header grammars (§1.1) → else `401 malformed_header`
3. `search === ""` → else `400 unexpected_query`
4. `|Date.now() - Number(TS)| <= 300_000` → else `401 timestamp_out_of_window`
5. Body digest + canonical string
6. `sigBytes.length === 64` → else `401 bad_signature_length`
7. `importKey("spki", …, P-256)` + `crypto.subtle.verify` → else `401 invalid_signature`
8. Replay guard (§5) — **last**, because it is the only step that writes

Order matters: step 8 costs a write, so an invalid signature must never pay for it.

---

## 4. Test vector

Both the harness and the Android client MUST reproduce this vector in a unit test of their canonical-string
builder. This is the artifact that makes the contract falsifiable — without it, the harness and the client
share an author and agree by construction.

### 4.1 Fixed P-256 test key

> **Test-only key. Never use in production.** Provided so both sides can be provably identical.

```
private_key_d_hex : a8dc75d5bb401ada821cfaa0c9342c23c0bd0e9719c0e4a833120504f6a2a85e

public_x_hex      : b9f69d43196a1825f7ec10ea942ea49a27220048cb2957ca4fdcec2854408211
public_y_hex      : 7b55f5a64e4d8d7ce7903dd7904e0ce500808168f115d3f9fc65f643d591dfe1

public_key_spki_b64 :
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEufadQxlqGCX37BDqlC6kmiciAEjLKVfKT9zsKFRAghF7VfWmTk2NfOeQPdeQTgzlAICBaPEV0/n8ZfZD1ZHf4Q==
```

`public_key_spki_b64` is exactly what is POSTed to `/v1/device/pair` as `public_key_spki`, and exactly
what `crypto.subtle.importKey("spki", …)` consumes.

### 4.2 Assertable values

These are deterministic and MUST be asserted byte-for-byte.

**Vector A** — `POST /v1/sms/outgoing/poll`

```
body_bytes_len = 56
body (exact)   = {"ack_command_ids":[],"fcm_token":"fcm-test-token-0001"}
timestamp      = 1776470400000
nonce          = a3f1c0d29b7e4f8a1c6d5e2b9f0a7c34
body_sha256    = f8c6ca3e8d50126cc59e541a6644ef1db7c3eec01b155a8310dea13143b9f0a9
canonical      = "POST\n/v1/sms/outgoing/poll\n1776470400000\na3f1c0d29b7e4f8a1c6d5e2b9f0a7c34\nf8c6ca3e8d50126cc59e541a6644ef1db7c3eec01b155a8310dea13143b9f0a9"
```

**Vector B** — `GET /v1/device/ws` (empty body)

```
body_bytes_len = 0
timestamp      = 1776470400000
nonce          = 0f1e2d3c4b5a69788796a5b4c3d2e1f0
body_sha256    = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
canonical      = "GET\n/v1/device/ws\n1776470400000\n0f1e2d3c4b5a69788796a5b4c3d2e1f0\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
```

**Vector C** — non-ASCII body, to catch encoding bugs

```
body_bytes_len = 159
body (exact)   = {"messages":[{"local_id":"m_0001","sender":"+8801712345678","body":"আসসালামু আলাইকুম","received_at":"2026-04-18T09:15:00.000Z"}]}
timestamp      = 1776470400000
nonce          = deadbeefcafebabe0123456789abcdef
body_sha256    = 1459860ca2b1d0a6e64d93d02246fb1f6c04d574b75bcdd485881d5830486fc6
canonical      = "POST\n/v1/sms/incoming/batch\n1776470400000\ndeadbeefcafebabe0123456789abcdef\n1459860ca2b1d0a6e64d93d02246fb1f6c04d574b75bcdd485881d5830486fc6"
```

`body_bytes_len` is the **UTF-8 byte length**, not the character count. Digesting the string in a
non-UTF-8 encoding is caught by Vector C and by nothing else.

### 4.3 Not assertable

Signed signatures are **not** reproducible: ECDSA uses a random `k`, so two signatures over identical
bytes differ. Do not assert signature equality. Assert instead that a signature verifies, and that
`derToP1363()` output is exactly 64 bytes for the DER forms above (which are 72, 71, and 70 bytes
respectively — that asymmetry is the whole point of the conversion).

---

## 5. Replay guard

Rev B's design (`device_meta.recent_nonces` as a JSON array capped at 32, plus an `evicted_max_ts`
floor) is **withdrawn**. It self-DoSes: any 33+ signed requests inside the 300 s window evicts a live
nonce and raises `evicted_max_ts`, after which a legitimate request whose `ts` *equals* that floor is
rejected by the `ts <= evicted_max_ts` test. At millisecond resolution this is trivially reachable, and
out-of-order arrival makes it routine. The B6 profile (">30 SMS/30m", where one SMS produces a batch
sync, a poll, and two status updates) trips it under normal load.

### 5.1 Replacement

One row per nonce, in the device's own Durable Object SQLite:

```sql
CREATE TABLE IF NOT EXISTS nonces (
  nonce TEXT PRIMARY KEY,
  ts    INTEGER NOT NULL,
  exp   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nonces_exp ON nonces(exp);
```

Per request, inside a single `ctx.storage.transactionSync()`:

```
W = 300_000
now = Date.now()

DELETE FROM nonces WHERE exp < now             -- prune

SELECT 1 FROM nonces WHERE nonce = ?           -- detect
  → if a row exists: reject 401 nonce_replay

INSERT INTO nonces (nonce, ts, exp)
  VALUES (?, ?, MAX(?, ?) + W)                 -- exp = MAX(now, ts) + W
```

### 5.2 Why `MAX(now, ts) + W`

A request received at `R` claiming timestamp `ts` is acceptable iff `|R − ts| ≤ W`. If `ts` is in the
future (allowed — the window is symmetric), a row that expires at `R + W` is pruned *before* the
request's own validity window closes at `ts + W`, reopening a replay hole. Using
`exp = MAX(R, ts) + W` makes retention cover the entire validity window, so the nonce table alone is
sufficient and no policy floor is needed.

This is the reason `evicted_max_ts` can be deleted outright rather than tuned.

### 5.3 Bounds

`DELETE … WHERE exp < now` bounds the table to whatever fits in a 300 s window — at a sustained
10 req/s that is ~3000 rows, which is unremarkable for DO SQLite. There is no cap, therefore no
eviction, therefore no eviction bug.

The comparison is strict on purpose. A row's `exp` is the instant its own validity window closes, and
a request at exactly `now = exp` is still inside the window (`|now − ts| ≤ W`, inclusive), so pruning
at `exp <= now` would drop the guard one millisecond before it stops being needed. Pruning and
admission must not share an inclusive boundary.

---

## 6. Command state machine

Rev B's §4 declares this machine but §5 never enforces it: `/__http_ack`, the WS `ack` handler, and
`/__status` all issue unguarded `UPDATE commands SET state=?`. A stale ack retry therefore regresses
`DELIVERED` back to `ACKED_BY_DEVICE`, and an out-of-order `SENT` broadcast regresses `DELIVERED` to
`SENT`.

### 6.1 Allowed transitions

| From | To | Trigger |
|---|---|---|
| `PENDING` | `DISPATCHED` | pushed over WS, or returned by poll |
| `DISPATCHED` | `ACKED_BY_DEVICE` | device ack (WS or HTTP) |
| `DISPATCHED` | `PENDING` | `ack_timeout` (8 s) |
| `PENDING`, `DISPATCHED` | `EXPIRED` | `expire` alarm |
| `ACKED_BY_DEVICE` | `SENT` | per-part `SENT` receipt |
| `ACKED_BY_DEVICE` | `FAILED` | send failure |
| `SENT` | `DELIVERED` | delivery receipt |
| `SENT` | `FAILED` | delivery failure |

**Terminal (no outgoing transitions):** `DELIVERED`, `FAILED`, `EXPIRED`.

**Explicitly rejected:** anything out of a terminal state; `SENT → ACKED_BY_DEVICE`;
`DELIVERED → SENT`; `EXPIRED → *`. A rejected transition is a **no-op that returns success** — it is
not an error, because a late or duplicated receipt from Android is normal and must not be surfaced as
a failure.

### 6.2 Enforcement

Guard in SQL, not in application logic, so it is atomic:

```sql
-- ack
UPDATE commands SET state = 'ACKED_BY_DEVICE'
 WHERE command_id = ? AND state IN ('PENDING','DISPATCHED');

-- status
UPDATE commands SET state = ?
 WHERE command_id = ? AND state IN (<allowed predecessors of ? for this target>);
```

The caller compares `cursor.rowsWritten`: `1` = applied, `0` = rejected-as-no-op. Both are `200`.
This makes the machine enforced by the storage layer and impossible to bypass from a new route.

---

## 7. Rule language

Rev B labels the server-side validator a "pure-JS AST ReDoS linter". It is three string regular
expressions, and it is not an AST linter. More importantly, server validation and device execution
use **two different regex engines** with nothing reconciling them: a rule accepted by the JS linter
can fail to compile in RE2/J on the phone.

### 7.1 Frozen rule

- The rule language is **RE2 semantics**, on both sides. This is the only grammar a rule may use.
- Stored patterns are compiled on the device by `com.google.re2j.Pattern`. RE2/J is linear-time and
  immune to backtracking ReDoS by construction, which is why it was chosen — so the server linter's
  job is **compatibility**, not ReDoS defence.
- Length caps: pattern ≤ 512 bytes, `reply_template` ≤ 1000 bytes. **These are enforced at the route
  layer, not inside the pattern linter** — `lintRe2()` is a pure syntax check and does not inspect
  length. A harness must therefore assert the length cap against the HTTP route, not the function.
- The server MUST reject, with `400`, any pattern containing:
  - backreferences — `\1`–`\9`, `\k<name>`
  - lookahead or lookbehind — `(?=`, `(?!`, `(?<=`, `(?<!`
  - atomic groups or conditionals — `(?>`, `(?(`
  - possessive quantifiers — `*+`, `++`, `?+`, `{n,m}+`
  - nested quantifiers — any quantifier applied to a group that itself contains a quantifier,
    at any nesting depth (`(a+)+`, `((a+))+`, `(a{1,50}){1,50}`)
  - overlapping alternation under a quantifier — `(a|a)+`, `(a|aa)+`
- Any construct RE2/J cannot compile MUST be rejected at write time. The device must never be the
  first place a rule is validated.

### 7.2 Cross-check requirement

A set of golden rules MUST be compiled by **both** `RE2/J` on the device and the server linter in CI.
If the linter accepts a pattern RE2/J rejects, that is a contract violation, not a linter bug.

### 7.3 Also required

`rules.id` MUST be validated as a non-empty string or generated server-side, and the D1 schema MUST
declare `id TEXT PRIMARY KEY NOT NULL`. SQLite permits `NULL` in a non-`INTEGER` `PRIMARY KEY` and
treats each `NULL` as distinct, so an id-less POST currently creates untargetable duplicate rules that
are then served to devices.

---

## 8. Error responses

Uniform envelope, so the client never has to guess:

```json
{ "error": "nonce_replay" }
```

| Status | `error` | Meaning |
|---|---|---|
| `400` | `unexpected_query` | signed request carried a query string |
| `400` | `bad_request` | malformed JSON or missing required field |
| `400` | `rule_rejected` | pattern violates §7 |
| `401` | `missing_auth_headers` | one of the four headers absent |
| `401` | `malformed_header` | header fails its grammar |
| `401` | `timestamp_out_of_window` | `|now − ts| > 300_000` |
| `401` | `bad_signature_length` | decoded signature ≠ 64 bytes |
| `401` | `invalid_signature` | curve verification failed |
| `401` | `device_unknown` | device not registered in this DO |
| `401` | `nonce_replay` | nonce already consumed |
| `401` | `unauthorized` | admin route without a valid bearer token |
| `404` | `device_unknown` | admin send/batch targeted a `device_id` absent from the D1 registry |
| `404` | `not_found` | no route matched |
| `413` | `payload_too_large` | request body exceeded 256 KiB, or an oversized field |
| `409` | `device_exists` | pairing refused to change the key of an already-registered `device_id`; a rebind requires a `rotate` code |
| `429` | `rate_limited` | pairing, admin, or per-device limiter exceeded |
| `429` | `daily_quota_exceeded` | this device spent its daily inbound row budget; retry after 00:00 UTC |
| `503` | `storage_unavailable` | a backing store failed; **nothing was written**, retry (the `(device_id, local_id)` key makes it safe) |

`nonce_replay` and `timestamp_out_of_window` MUST be distinct from `invalid_signature`. Collapsing them
into one opaque `401` is what makes this protocol undebuggable from a phone, and the distinct codes are
observable by an attacker only after they have already forged a valid signature.

---

## 9. Client obligations (Android)

1. Generate a fresh 128-bit nonce per attempt. Never reuse, including on retry.
2. Send `X-Timestamp` as exactly 13 decimal digits of UTC epoch milliseconds.
3. Digest the raw request body bytes as transmitted — no re-serialization between digest and send.
4. Sign the five-line canonical string with ECDSA P-256 / SHA-256, convert DER → 64-byte P1363, base64.
5. Never append a query string to a signed request.
6. On `401 malformed_header` or `401 unexpected_query`, treat as a client bug — do not retry blindly.
7. On `401 nonce_replay`, regenerate the nonce and retry once. A repeat indicates the device is
   re-sending rather than re-signing.

---

## 10. Conformance

The harness MUST fail loudly on each of these, and each is currently *not* covered by Rev B's suite:

- canonical string equals the §4 vector byte-for-byte, for A, B, and C
- `SHA-256("")` used for `GET`, not an empty string
- signing a body, then altering a single byte, yields `401`
- query string on a signed request yields `400 unexpected_query`
- `X-Nonce` that is 31 chars, 33 chars, uppercase, or non-hex yields `401 malformed_header`
- `X-Timestamp` of `"+1776470400000"`, `"1776470400000.0"`, `"1.7e12"`, or a wrong digit count yields
  `401 malformed_header`. The whitespace-padded form is unit-testable only — see §1.2.1.
- the same nonce twice yields `401 nonce_replay`; a *fresh* nonce at the same millisecond succeeds
- 40+ requests inside the 300 s window all succeed (the withdrawn design fails this at 33)
- `DELIVERED` then a stale `ack` leaves the command `DELIVERED`
- `EXPIRED` then a late `SENT` leaves the command `EXPIRED`
- `DELIVERED` then `SENT` leaves the command `DELIVERED`
- a lookahead pattern is rejected `400`, and the same pattern is proven uncompilable by RE2/J
- an array above its cap yields `400`: `messages` > 500, `commands` > 200, `updates` > 500,
  `ack_command_ids` > 200 — over HTTP **and** over the WebSocket `ack`
- a field above its ceiling yields `400`: body 4096, peer 32, id 128, `fcm_token` 512 characters
- a request body above 256 KiB yields `413 payload_too_large`, **including a chunked body that sends no
  `Content-Length`** — the cap is enforced by reading the stream, never by trusting the header

---

## 11. API surface

Authentication class per route. Anything not listed does not exist.

| Method | Path | Auth | Notes |
|---|---|---|---|
| `POST` | `/v1/device/pair` | **none** | Bootstrap. Authenticated by the single-use pairing code in the body, which is atomically claimed before any Durable Object work (§11.8). Rate-limited per IP and globally, on separate buckets. |
| `GET` | `/source` | **none** | AGPL-3.0 §13 source offer. `302` to `SOURCE_URL`. Not part of the device protocol. |
| `POST` | `/v1/admin/pairing-code` | admin | Body `{ttl_ms?, device_id?, purpose?}`. Returns `{pairing_code, expires_at, device_id, purpose}`. `ttl_ms` clamped to `[1000, 86400000]`; `purpose` is `enroll` (default) or `rotate`, and `rotate` requires `device_id` (§11.8). |
| `GET` | `/v1/admin/health` | admin | Version, applied migrations, binding presence, row counts. **Never** message content. `503` when the schema or a critical binding is missing. |
| `GET` | `/v1/devices` | admin | Fleet list. |
| `DELETE` | `/v1/admin/devices/:device_id` | admin | Revoke: wipes the device from **the DO** (which is what verifies signatures) and from D1, closes its sockets. |
| `GET` | `/v1/messages` | admin | `?device_id=&limit=&before=`. `limit` default 50, max 200. Newest first. |
| `DELETE` | `/v1/messages` | admin | `?device_id=`. Erases that device's message log (simulator cleanup / erasure request). Returns `{ok, deleted}`. |
| `GET` | `/v1/sms/commands/:command_id` | admin | `?device_id=`. Single command's current state. |
| `GET` | `/v1/device/:device_id/status` | admin | `{ws_connected, queue_depth}`. |
| `GET` | `/v1/admin/rules` | admin | Every rule, including disabled and other devices'. |
| `DELETE` | `/v1/admin/rules/:rule_id` | admin | Delete by id. `404` when absent. |
| `POST` | `/v1/rules` | admin | Upsert a rule. `device_id` optional → global rule. |
| `POST` | `/v1/sms/send` | admin | Body `{device_id, to, body, priority?, expires_in_s?}`. Returns `{command_id}`. |
| `POST` | `/v1/sms/send/batch` | admin | Body `{device_id, commands[]}`. Returns `{command_ids}`. |
| `GET` | `/v1/device/ws` | device | WebSocket upgrade. Signed as a `GET` with an empty body (§2.3). |
| `POST` | `/v1/sms/incoming/batch` | device | Body `{messages[], ack_command_ids[], fcm_token?}`. |
| `POST` | `/v1/sms/outgoing/poll` | device | Body `{ack_command_ids[], fcm_token?}`. |
| `POST` | `/v1/sms/status/batch` | device | Body `{updates[]}`. |
| `GET` | `/v1/rules` | device | Returns global rules plus this device's own. |

### 11.1 Route matching order

`/v1/device/ws` MUST be matched before the `/v1/device/:device_id/status` pattern, and the pairing
route before all device routes. `/v1/sms/send/batch` MUST be matched before anything that would treat
`batch` as an id.

### 11.2 Configurable timing

Deploy-time vars, with production defaults. The conformance suite shrinks them so that timeout
behaviour is tested by firing a real alarm rather than by sleeping.

| Var | Default | Meaning |
|---|---|---|
| `ACK_TIMEOUT_MS` | `8000` | `DISPATCHED → PENDING` revert deadline |
| `OFFLINE_ALERT_MS` | `900000` | no-traffic alert threshold |
| `STALE_SOCKET_MS` | `120000` | socket considered stale for push purposes |
| `NONCE_WINDOW_MS` | `300000` | accepted `|now − ts|` window (§5.1) |
| `FCM_BASE_URL` | `https://fcm.googleapis.com` | redirectable for offline testing |
| `GOOGLE_TOKEN_URL` | `https://oauth2.googleapis.com/token` | redirectable for offline testing |

### 11.3 `getWebSocketAutoResponseTimestamp` is advisory only
`ctx.getWebSocketAutoResponseTimestamp(ws)` is **not** verified to return a real `Date` under
`wrangler dev --local`, where it may return `null` or a stub. No correctness decision may depend on
it: a `null` must never cause a socket to be closed as stale, nor suppress or fabricate an offline
alert. It may only *extend* liveness when it returns a genuine value. Rev B made this value
load-bearing in both `tryPushOverWebSocket` and `offline_alert`; that is withdrawn.

### 11.4 Pairing-code expiry cannot be provoked with a negative TTL

`ttl_ms` is clamped to `[1000, 86400000]`, so **a pre-expired pairing code cannot be minted**. Rev B's
test technique (`ttl_ms: -1000`) is therefore void: the value is clamped up to `1000` and the code is
genuinely valid, so pairing succeeds.

To test the expiry path, mint with `ttl_ms: 1000` and wait ~1.2 s before attempting to pair. Do not
add a "negative TTL means already expired" special case — the clamp is deliberate, and a test that
depends on nonsense input is a test of the nonsense, not of expiry.

### 11.5 `GET /v1/sms/commands/:command_id` response shape

Returns `{"command": {…}}`, or `{"command": null}` when the id is unknown. The state is at
`command.state`, not at the top level. A `404` is returned only when `device_id` is missing.

### 11.6 Verified end-to-end

Against a live `wrangler dev --local`: pairing (mint, pair, reuse-rejected), signed happy path, body
tamper → `invalid_signature`, all four grammar rejections, nonce replay → `nonce_replay`,
**40 consecutive in-window signed requests all `200`**, query-before-crypto ordering, the admin read
surface, outbound persistence with `direction:'out'`, poll → ack → `DELIVERED`, and incoming dedup with
the `received_at` bound. The canonical-string builder reproduces §4.2 vectors A/B/C byte-for-byte, and
its hand-rolled SHA-256 matches `node:crypto` on all three.

### 11.7 Input caps

Enforced before any work is done, so an oversized request pays for nothing — no crypto, no D1 write, no
Durable Object request.

| Cap | Value |
|---|---|
| request body | 256 KiB, enforced by **reading the stream** (never by trusting `Content-Length`) |
| `messages[]` | 500 |
| `commands[]` | 200 |
| `updates[]` | 500 |
| `ack_command_ids[]` | 200 — over HTTP **and** over the WebSocket `ack` |
| message `body` | 4096 chars |
| `peer` / `to` | 32 chars |
| `local_id` / `command_id` | 128 chars |
| `fcm_token` | 512 chars |

A body over the cap returns `413 payload_too_large`; an array or field over its cap returns
`400 bad_request`.

### 11.8 Pairing scope, rotation and the atomic claim

A pairing code is **not** a generic bearer token for any `device_id`. It carries two attributes fixed at
mint time:

| Field | Meaning |
|---|---|
| `device_id` | When set, the code may only be redeemed for that exact id. `NULL` means any **new** device. |
| `purpose` | `enroll` (default) may only register an id that does not exist yet. `rotate` — which requires `device_id` — is the only purpose allowed to replace an existing key. |

Redemption is **claim → Durable Object → finalize**:

1. A single conditional `UPDATE … RETURNING` claims the code (`claimed_at`), requiring: unexpired, not
   currently claimed by another request (a claim older than 30 s is abandoned and may be reclaimed),
   matching `device_id` scope, and — for `enroll` — no existing device. Exactly one concurrent redeemer
   can win; a loser updates zero rows and MUST NOT reach the Durable Object.
2. Only the winner calls the DO, passing `rotate` derived from the code's `purpose`. A DO failure
   **releases** the claim, so a failed redemption never burns the code (Rev B defect #13).
3. The claim is consumed (`DELETE … WHERE claimed_at = our token`) and only then is the D1 registry
   mirrored. The consume is checked by row count, never batched with the upsert: a zero-row `DELETE` is
   a successful D1 statement, so batching would let the upsert commit without holding the claim.

An `enroll` code redeemed against an already-registered `device_id` returns `409 device_exists`. An
operator rotating a key must mint with `{ "purpose": "rotate", "device_id": "<id>" }`; the DO then
evicts the previous key holder (closes sockets, drops its queued commands, nonces and per-command
timers), which is authorized behaviour only under an explicit rotation.
