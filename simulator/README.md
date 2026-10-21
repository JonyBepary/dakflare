# DakFlare device simulator

A real device-shaped app, not a test harness: it holds a P-256 identity, a local
libSQL database, and (next) speaks the full signed protocol. The carrier is the
only simulated part; everything above it is intended to survive the move to a
real Android build.

## Layout

```
core/        Rust library — identity, local libSQL store. No Tauri, no UI.
src-tauri/   Tauri v2 shell — app lifecycle + commands over `core`.
src/         SvelteKit 2 + Svelte 5 + Bits UI, served as an SPA in the webview.
```

`core` is deliberately Tauri-free so it compiles and tests on any machine, and so
the Android build can use it without dragging in the desktop shell.

## Run

```bash
# Core: schema, identity, signing (no system dependencies)
cd core && cargo test

# Frontend type check + build
npm install
npm run check
npm run build

# Desktop app (needs the system libraries below)
npm run tauri dev
```

### Desktop prerequisites (Debian/Ubuntu)

```bash
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev \
                 librsvg2-dev patchelf build-essential
```

Without these, `cargo` cannot link the Tauri shell — this is the state on the CI
box used for M0.

### Android prerequisites

```bash
# once per machine
rustup target add aarch64-linux-android armv7-linux-androideabi \
                  i686-linux-android x86_64-linux-android
# ANDROID_HOME / NDK_HOME must point at a real SDK + NDK
npm run tauri android init
npm run tauri android dev
```

M0 could not run this: the machine has no Android SDK/NDK. The Rust core and the
webview bundle are the two pieces that were verified instead.

## M4 status

| Check | Result |
|---|---|
| Device fetches its flows (`GET /v1/flows`, signed, device-scoped) | **pass** — live |
| Device runs the graph locally and reports `flow_runs` | **pass** — live |
| Worker fallback skips flows the device ran | **pass** — `device_sent=1 fallback=0` |
| Fallback still replies when the device reports no run | **pass** — `device_sent=0 fallback=1` |
| Purge removes `flow_runs` with the message log | **pass** |

The probe now asserts the split explicitly:

```
case A:   device_sent=1 fallback=0
          → +15551230000 · Your code is 483920
case B:   device_sent=0 fallback=1
          → +15551230000 · Your code is 777111
FLOW PROBE OK — device primary, Worker fallback
```

## M3 status

| Check | Result |
|---|---|
| Flow interpreter (pure Rust): extract, condition, template, stop, budgets | **pass** — 8 tests |
| Worker fallback via WASM (same crate, `wasm32-unknown-unknown`) | **pass** — live |
| Injected `CODE 483920` produces `Your code is 483920` | **pass** — production probe |
| Retried batch does not send twice | **pass** — `duplicates=1`, no extra command |
| WeakRef/alloc boundary | hand-rolled `alloc`/`dealloc`/`run_json`, no wasm-bindgen |

The reply rides back in the **same upload response**: `handleIncomingBatch`
finishes by reading the pending queue, which marks the just-enqueued command
`DISPATCHED`. The carrier captures commands from that response as well as from a
later poll, because skipping the first path silently dropped replies.

`workflow` execution is Worker-only today. Device-side execution (M4) is the other
half of "device primary, Worker fallback"; the `flow_runs` dedupe key is already
in the schema for it.

Rebuild the bundled module after changing `simulator/flow`:

```bash
simulator/flow-wasm/build.sh   # writes worker/src/wasm/flow.wasm
```

## M2 status

| Check | Result |
|---|---|
| Inject inbound: local thread + signed upload | **pass** — live probe |
| Capture outbound: poll → record → ack | **pass** — live probe |
| Offline switch: stores locally, skips upload/poll | **pass** — unit test + UI |
| Message thread + clear | **pass** — unit test |

The probe now covers the carrier path as well: pair, inject `CODE 483920`
(uploaded, accepted=1), queue a real command as admin, drain it through a signed
poll (captured with the right recipient), then purge and revoke. It also caught a
real bug: the command wire field is `to`, not the SQL column `to_e164`, so the
first capture produced an outbound row with an empty peer.

## M1 status

| Check | Result |
|---|---|
| Protocol client: mint code, pair, signed poll, inbound upload | **pass** — live probe against production |
| Cleanup: purge message log, revoke device | **pass** — probe removed its own rows |
| Canonical string + P1363 headers (contract §2/§3) | **pass** — unit tests |
| WebSocket transport | not yet |

The probe is `core/examples/probe.rs`:

```bash
cd core
DAKFLARE_URL=https://<worker>.workers.dev DAKFLARE_ADMIN_TOKEN=... \
  cargo run --example probe
```

It creates a temporary identity, pairs, polls, uploads one inbound message,
purges that device's log, revokes the device and deletes the temp database —
so it is safe to run against the live deployment.

## M0 status

| Check | Result |
|---|---|
| libSQL opens a real file, migrations idempotent | **pass** — `cargo test`, 8 tests |
| Device identity: grammar, SPKI, P1363 sign/verify | **pass** |
| Frontend compiles (Svelte 5 + Bits UI) | **pass** — `npm run check`, 0 errors |
| Desktop shell builds | **blocked** — WebKitGTK/GTK/libsoup/rsvg not installed |
| Android target builds | **blocked** — no SDK/NDK on the machine |

## Decisions worth remembering

- **`device_id` authenticates; `platform_id` does not.** `device_id` is generated
  locally and bound to the keypair. `ANDROID_ID` (or iOS `IDFV`) is stored as a
  support hint only — it is stable per signing key, survives reinstall, resets on
  factory reset, and is spoofable on a rooted device. Using it as a credential
  would let a rooted phone impersonate another.
- **libSQL, not the platform SQLite.** Same file format as SQLite, but it lives in
  the Rust core, so desktop and Android share one schema and one migration path,
  and embedded replicas remain possible later. Room/Kotlin would split the data
  layer in two.
- **Private keys in the local DB are simulator-only.** PKCS#8 PEM on disk is fine
  for test identities on a developer machine; the Android build must use the
  Keystore.
- **RCS is out of scope.** There is no public API for third-party apps to send or
  receive RCS. SMS/MMS via `SmsManager` is the programmatic surface.

## Next

1. Protocol client in `core` (pair, signed poll, inbound batch, WebSocket).
2. Target switcher (deployed Worker) + cleanup rails (`sim*` prefixes,
   message purge endpoint).
3. Device-side flow execution + `flow_runs` reporting (M4).
4. WebSocket transport (poll covers delivery today).
