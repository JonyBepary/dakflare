# DakFlare

> **Sovereign Device-to-Edge SMS Relay on Cloudflare Workers & Android.**
>
> DakFlare pairs a dedicated Android handset with your own Cloudflare account (Workers, Durable Objects with hibernating WebSockets, D1, and KV) to send, receive, and auto-reply to SMS over a strictly verified ECDSA P-256 wire protocol. No third-party telecom SaaS, no per-message markups, and no shared credentials.

Turn any Android device and Cloudflare Worker into a zero-trust, self-hosted SMS gateway with hardware ECDSA P-256 signing and hibernating sockets.

## Why "DakFlare"

**DakFlare** combines *Dāk* (ডাক — the historic relay-runner dispatch network across Bengal and the subcontinent that carried urgent dispatches from station to station day and night) with the **Cloudflare** edge where the coordinator lives.

## What it actually is

The Android handset is the radio. The Worker is the coordinator. Neither trusts the other by default.

| Layer | Role |
|---|---|
| **Android device** | Owns the SIM. Receives and sends SMS, holds an ECDSA P-256 key in the hardware Keystore, and evaluates inbound rules locally. |
| **Cloudflare Worker** | Verifies every request against a canonical string and a replay guard, terminates the device WebSocket, and exposes the admin API. |
| **Durable Object** (one per device) | SQLite-backed command queue, replay-guard nonces, alarms for `ack_timeout` / `offline_alert` / expiry, and the hibernating socket itself. |
| **D1** | Fleet registry, message log, rules, pairing codes. |
| **KV** | FCM bearer-token cache. |

Auth is not a shared secret. Each device signs `METHOD\nPATH\nTIMESTAMP\nNONCE\nSHA256(body)` with a P-256 key that never leaves its Keystore; the Worker verifies the 64-byte signature, rejects replayed nonces, and returns distinct error codes so a failure is debuggable from the phone.

## Quick start (bring your own Cloudflare account)

```bash
git clone https://github.com/JonyBepary/dakflare
cd dakflare/worker
npm install

cp wrangler.template.toml wrangler.toml     # ships WITHOUT resource ids
npx wrangler d1 create sms_gateway          # or let `wrangler deploy` provision it
npx wrangler kv namespace create KV
npx wrangler d1 migrations apply sms_gateway --remote

npx wrangler secret put ADMIN_TOKEN         # required — admin routes fail closed without it
npx wrangler secret put FCM_SERVICE_ACCOUNT_JSON   # optional: wake pushes
npx wrangler deploy
```

Then check what you actually deployed:

```bash
curl -H "Authorization: Bearer $ADMIN_TOKEN" \
  https://<your-worker>.workers.dev/v1/admin/health
```

`health` reports the version, applied migrations, which bindings are present, and row counts — never a
message body, phone number, or key.

## Repository layout

```
worker/                     Worker + Durable Object + D1 migrations
  wrangler.toml             operator config (keeps real resource ids)
  wrangler.template.toml    BYOCF starting point (no ids → automatic provisioning)
  wrangler.account.toml     local Worker + real PREVIEW D1/KV
  public/                   landing page, served as a static asset
  src/                      routes, auth, DO, lib
cli/                        dakflare desktop CLI (init, doctor, pair, devices, send)
PROTOCOL_CONTRACT_V5.md     FROZEN wire format — the sole authority
dakflare_v5_master_plan_rev_c.md   architecture, gates, schedule
dakflare_test_harness.mjs   zero-dependency virtual device + conformance suite
hoppscotch_dakflare_collection.json
test-support/               FCM stub, dev.sh, platform gate, burst probe, docs
SECURITY.md                 disclosure policy and scope
LICENSE                     AGPL-3.0-only
```

## Android app identifiers (B5/B6 scaffold)

| Property | Value |
|---|---|
| Display name | `DakFlare` |
| Application ID | `dev.dakflare.agent` |
| Keystore key alias | `dakflare_device_p256` |
| Foreground service | `remoteMessaging` |
| FGS notification title | `DakFlare Relay Active` |
| FGS notification body | `Connected to Cloudflare edge (remoteMessaging)` |

Two builds are planned from one codebase: a Play/GitHub-Releases build with FCM, and an F-Droid build
without proprietary push (WebSocket reconnect only). See the master plan for the trade-off.

## Verify it yourself

```bash
node dakflare_test_harness.mjs selftest          # grammar, DER→P1363, frozen vectors — no server
python3 test-support/independent-canonical-check.py   # third implementation of the canonical string
```

The harness is an independent implementation of the protocol, not a wrapper around the Worker. The
canonical string is re-derived a third time in Python so a shared misreading of the contract cannot hide.

## Status

Rev C backend, frozen wire contract. Verified locally, account-backed, and against a deployed Worker.
Advanced fleet features (per-line availability, capacity, failover) are planned in the master plan and
not yet implemented.

## Licence

**AGPL-3.0-only.** If you run a modified version as a network service, section 13 requires you to offer
its source to your users. The unmodified deployment satisfies this via `/source`.

Security reports: see [`SECURITY.md`](SECURITY.md). Please do not open a public issue.
