# DakFlare Device 6.3.1

Icon-only release. The mark is centred on the artwork instead of the poster's
frame, and the paper no longer shows a square edge in the launcher mask.

**Package** `dev.dakflare.device` · **version** 6.3.1 (631) · **ABI** arm64-v8a ·
**signed** with the DakFlare release key
(`77:B2:81:84:75:8F:82:9E:93:53:C2:6C:44:0F:06:BB:28:5D:9C:83:D1:1F:99:F1:89:67:39:25:1F:DC:81:F6`).

## Install

Same package as 6.3.0, so this updates in place — no re-pairing, no data loss.

```sh
gh release download device-v6.3.1 --pattern '*universal.apk' --pattern 'SHA256SUMS'
sha256sum -c SHA256SUMS
adb install -r DakFlare-Device-6.3.1-universal.apk
```

Obtainium picks it up from the same source (tag filter `device-v`, APK filter
`universal`).

## Verify

```sh
apksigner verify --print-certs DakFlare-Device-6.3.1-universal.apk
```

The digest must be `77b28184…f6`. A build with any other signer is not ours.

## Changed

- Launcher icon centred on the duckling's own ink bounds; the sun is treated as
  an accent rather than part of the subject.
- The icon's paper field is sampled from the sheet instead of its corner, and the
  edge is feathered, so no square appears inside the adaptive mask.

No application code changed.
