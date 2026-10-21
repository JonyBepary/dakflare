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
3. Carrier panel: inject inbound, capture outbound.
4. Flow interpreter in Rust, compiled to WASM for the Worker fallback.
