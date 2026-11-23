# DakFlare Device 6.3.0

The Android handset app for a self-hosted [DakFlare](https://github.com/JonyBepary/dakflare#readme) gateway. The
phone is the radio: it sends and receives SMS, runs your flows offline, and signs
every request to your own Worker with a hardware-backed key. There is no account,
no relay, and no third-party service in the message path.

**Package** `dev.dakflare.device` · **version** 6.3.0 (630) · **minSdk** 24
(Android 7.0) · **ABI** arm64-v8a · **signed** with the DakFlare release key
(`77:B2:81:84:75:8F:82:9E:93:53:C2:6C:44:0F:06:BB:28:5D:9C:83:D1:1F:99:F1:89:67:39:25:1F:DC:81:F6`).

## Requirements

- A DakFlare Worker you control — `dakflare up` in this repository, or the
  precompiled pack. The app is useless without one, by design.
- A pairing code from that deployment (`dakflare pair`).
- An arm64 Android phone with a SIM. SMS role and notification access are
  granted on first run.

## Install

**Obtainium** (recommended: updates follow this repository):

1. Add `https://github.com/JonyBepary/dakflare`.
2. Filter tags by `device-v`, APKs by `universal`.
3. Install, open, paste the Worker URL and the pairing code.

**Direct download:** attach this release's APK, or:

```sh
adb install -r DakFlare-Device-6.3.0-universal.apk
```

**Upgrading from 6.1.0 or earlier:** that build used the package id
`dev.dakflare.simulator`. The id changed, so the new app installs **beside** the
old one instead of over it. Pair the handset again in the new app, confirm it
works, then uninstall the old package. Its data is not migrated.

## Verify before installing

```sh
sha256sum -c SHA256SUMS
apksigner verify --print-certs DakFlare-Device-6.3.0-universal.apk
```

The certificate digest must be `77b28184…f6`, the same key as every earlier
release and the one recorded in [`docs/PHONE_RELEASE.md`](https://github.com/JonyBepary/dakflare/blob/main/docs/PHONE_RELEASE.md).
A build with any other signer is not ours. The public certificate ships beside the
APK (`DakFlare-Device-release-cert.pem`); pin it if you automate updates.

## Permissions and what each is for

| Permission | Why |
|---|---|
| SMS (read, send, receive) | The product: the phone is the radio. Without these it cannot be a default SMS client. |
| Phone numbers / state | SIM slot and carrier reporting for multi-SIM handsets. |
| Notifications | Delivery of the app's own foreground status; also the notification listener for personal channels (WhatsApp, Telegram, Messenger, Instagram) when you enable them. |
| Foreground service (remote messaging) | Keeps the send queue alive while the screen is off. |
| Battery optimisation exemption | Requested, not assumed; Android otherwise defers the socket and delivery stalls. |
| Boot completed | Re-arms the queue after a reboot. |

No analytics, no crash reporter, no Firebase, no Google Play Services, no network
endpoint other than the Worker URL you enter.

## What is in 6.3.0

- **Default SMS client**: threads, compose, delivery state, SIM choice, and
  inline notification replies.
- **Offline flows**: the same Rust engine the Worker compiles to Wasm
  (`simulator/flow`), so rules run on the phone with no round trip.
- **Lettered channels**: notification capture for personal WhatsApp, Telegram,
  Messenger and Instagram sessions, on `edge_device` connectors.
- **Pairing by key**: a P-256 key in `AndroidKeyStore` signs every request; the
  private key never leaves the phone.
- **Poll-only presence**: a persistent WebSocket when online, polling when not.
  No push dependency, which is what lets it run on GMS-free Android.
- **OTP/PIN handling**: codes are recognised locally and never forwarded to a
  webhook body.

## Known limits

- **arm64 only.** 32-bit and x86 devices are not built in this release.
- **One gateway per install.** The app talks to the Worker you point it at.
- **No background SMS without the role.** Android grants SMS to the default
  client; the app asks for the role on first run.
- **The old package id keeps working** until you uninstall it; it will not
  receive updates from this release.
