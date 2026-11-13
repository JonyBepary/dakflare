# DakFlare device app

One Android handset as the SMS radio for a DakFlare deployment: device identity,
SMS receive and send, local flows, and reports to the Worker. Package
`dev.dakflare.simulator`.

## Shape

| Path | What it is |
|---|---|
| `src-tauri/` | Tauri v2 shell: lifecycle, commands and the webview host |
| `core/` | Rust core: P-256 identity, signed protocol client, local libSQL store, flow runs |
| `src/` | Svelte 5 UI, served as an SPA in the webview |
| `flow/` | pure Rust flow interpreter: graph and message in, actions out |
| `flow-wasm/` | the same interpreter compiled for the Worker's fallback |
| `src-tauri/gen/android/.../bridge/` | Kotlin telephony, provider and gateway service |
| `scripts/` | toolchain setup, device checks and release build |

The Kotlin bridge is the platform surface: `SmsReceiver` takes `SMS_DELIVER`,
`SmsSender` and `SendStatusReceiver` handle the radio, `SmsProvider` publishes to
`content://sms`, and `GatewayService` stays in the foreground with a Reply action
on the notification. `BootReceiver` restores the service after a reboot. The Rust
core stays free of Tauri, so it builds and tests outside the desktop shell.

## Default SMS app

The manifest declares the default-SMS-app entry points, including `SMS_DELIVER`
and the compose intents. The role is held at runtime by `android.app.role.SMS`;
the device check reports the holder and never changes it. The app handles SMS
only. MMS is not supported.

## Local store and flow engine

Identity and messages live in a local libSQL database managed by `core/`. The
signing key is wrapped by Android Keystore in `KeyVault` and stored as a
`keystore:v1:` blob, not plaintext PKCS#8. The store also caches flows, queues
outbound messages and records `flow_runs`.

The on-device engine parses each cached flow and runs it for an incoming message
without a network round trip. Replies are queued locally and sent through the
radio; the run is reported per message and flow version. The Worker keeps a WASM
fallback for messages the device did not run.

## Build

```bash
simulator/scripts/android-setup.sh          # JDK, SDK, NDK and Rust targets
source ~/.config/dakflare/android-env.sh
cd simulator
npm install
npm run check
npm run build
npx tauri android build --apk --target aarch64
```

`android-setup.sh` installs under `$HOME`, needs about 8 GB free, and the release
target is `aarch64`. Tests run without the Android toolchain:

```bash
cd simulator/core && cargo test
cd simulator/flow && cargo test
simulator/flow-wasm/build.sh   # rebuild worker/src/wasm/flow.wasm
```

## Device check

```bash
simulator/scripts/device-check.sh
simulator/scripts/device-check.sh --reboot
```

The script checks the attached handset, the SMS role, the Keystore-backed key,
one injected inbound PDU, the provider row, an outgoing send, the notification
action and the foreground service. `--reboot` also proves the boot path. It needs
a rooted debug handset, `adb`, `node`, `python3` and `sqlite3`; a SKIP is not a
pass, and a failed check exits non-zero.

## Release signing

```bash
simulator/scripts/release-apk.sh
```

The script sources `~/.config/dakflare/android-env.sh`, requires the release
keystore, runs the Tauri Android build and prints the APK path, size,
`apksigner` certificate and version. Signing material stays outside the
repository: `~/.config/dakflare/dakflare-release.jks` and the mode 600
`release-keystore.txt`. Gradle refuses a release build without the key, so it
cannot fall back to the debug signer. The APK lands in
`src-tauri/gen/android/app/build/outputs/apk/universal/release/`.
