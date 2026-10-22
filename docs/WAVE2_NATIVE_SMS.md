# Wave 2 — making the phone a gateway

Status: planned 2026-10-23. Scope: the part that does not exist yet — receiving and
sending real SMS while the app is closed. Everything before this is protocol,
console and a simulated carrier.

## 1. The constraint that decides the architecture

The plan specified a native Kotlin app (Room, `SmsReceiver`, `AutoReplyEngine`,
`SmsSender`, FGS). We built Tauri + Rust instead: identity, crypto, libSQL and the
flow interpreter live in `simulator/core`, and the UI is a webview.

Android delivers `SMS_RECEIVED` to a manifest receiver even when no Activity is
running. At that moment there is no Tauri runtime and no webview, so the receiver
must execute without them. Two ways to get a reply:

1. **Reimplement rules/flows in Kotlin** — a second interpreter, the exact defect
   the Worker was fixed to avoid. Rejected.
2. **Call the existing Rust core through JNI** — the core crate is already built
   as a `cdylib` (`libsimulator_lib.so`) and packaged in the APK. A JNI entry
   point can open the same libSQL database and run the same flow interpreter
   with no Tauri involvement. **Adopted.**

The webview stays the configuration surface; Kotlin owns the Android lifecycle;
Rust remains the only implementation of identity, storage and flows.

## 2. Shape

```
SMS_RECEIVED
  └─ SmsReceiver (Kotlin, goAsync)
       ├─ Telephony.Sms.Intents.getMessagesFromIntent → PDU concat
       ├─ loadLibrary("simulator_lib")
       ├─ NativeBridge.processIncoming(filesDir, sender, body, receivedAtMs)
       │     └─ Rust: open libSQL → run flows → persist in/out → return reply
       └─ SmsManager.createForSubscriptionId(slot).sendTextMessage(...)
```

- `NativeBridge` is a Kotlin object with `external fun` declarations; symbols are
  `Java_dev_dakflare_simulator_bridge_NativeBridge_processIncoming`.
- The Rust entry takes the app's data directory from Kotlin (never guesses a
  path), caps sender/body lengths, and returns a small JSON object
  (`{reply, localId, flowId}` or `{"reply":null}`). Parsing stays in Kotlin.
- The receiver calls `goAsync()` and finishes the `PendingResult` in `finally`.
  The Rust call is synchronous and bounded; SMS sending may take seconds, which
  `goAsync`'s ~10 s window covers for a single message.
- A **foreground service** (`remoteMessaging`) owns the long-lived work: socket
  or poll loop, outbound queue, wake locks. It is started from `BOOT_COMPLETED`
  and from the receiver, and holds a low-importance notification. It is not on
  the receive path for a single SMS (the receiver is enough), which keeps the
  notification from being required just to receive.

## 3. Manifest and permissions

```xml
<uses-permission android:name="android.permission.RECEIVE_SMS" />
<uses-permission android:name="android.permission.SEND_SMS" />
<uses-permission android:name="android.permission.READ_PHONE_NUMBERS" />
<uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />
<uses-permission android:name="android.permission.FOREGROUND_SERVICE_REMOTE_MESSAGING" />
<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
<uses-permission android:name="android.permission.WAKE_LOCK" />
```

Runtime requests: `RECEIVE_SMS` + `SEND_SMS` (pair), `POST_NOTIFICATIONS`
(Android 13+). The permissions screen must explain that the app is an SMS
gateway, not a messenger, before the system dialog.

Distribution: SMS permissions put this outside Play's default policy unless it
holds the default-SMS role or qualifies for an exception. Sideload and F-Droid
builds are the supported path; do not plan a Play listing without resolving that.

## 4. Correctness rules the native path must keep

- **One reply per message.** The Worker's §11.11 rule pipeline is gateway-side and
  is skipped for rows the device already answered (`auto_reply_sent`), so the
  native reply must be reported in the batch exactly as flows are today.
- **Masks and shortcodes.** Never auto-reply to an alphanumeric sender; a
  digits-only sender shorter than 10 digits needs `allow_shortcode`.
- **Self-number guard.** `READ_PHONE_NUMBERS` may return `""`; compare every
  plausible source (`getPhoneNumber(subId)`, `getLine1Number`, SIM MSISDN) and
  fall back to "unknown" rather than an empty string that silently disables the
  guard.
- **Dedupe.** `(device_id, local_id)` on the Worker; local `local_id` is derived
  from the PDU timestamp + sender hash so a re-delivered broadcast cannot double
  insert.
- **No bodies in logs.** Not in Kotlin, not in JNI, not in crash handlers.

## 5. Milestones and gates

| # | Deliverable | Gate |
|---|---|---|
| M5.1 | Manifest permissions + `SmsReceiver` + `NativeBridge` inbound only | A real SMS from another phone is stored locally with the app **closed**; `adb logcat` shows no body |
| M5.2 | Flow execution in the JNI call + `SmsManager` reply | Inbound matching a synced flow produces a real reply; the Worker log shows the mirrored outbound row |
| M5.3 | `remoteMessaging` FGS + `BOOT_COMPLETED` + notification | Force-stop → next SMS still processed; reboot → service returns; 6 h soak with battery optimisation on |
| M5.4 | Multipart concat, mask/shortcode filter, self-number guard | §5.3 matrix items 1, 2, 5 of the master plan; Bangla UCS-2 3-part message arrives once |
| M5.5 | Receipts + retry queue | A send that fails while offline is retried once connectivity returns, and `DELIVERED` reaches the Worker |

## 6. Testability without a second phone

The Pixel has two SIMs. A loopback send from SIM 2 to SIM 1 exercises
receive→reply without another handset, provided the self-number guard is checked
against both numbers. `adb emu sms send` does not work on physical devices, so
the two-SIM path is the harness. A second phone remains the only way to test a
carrier mask.

## 7. What this does not fix

- Keystore migration (the key is still PKCS#8 in libSQL) — do it in M5.3 while the
  service work touches identity boot.
- FCM wake and the WebSocket client — M5.3/M5.6; polling still works without them.
- Rules are gateway-side by decision (§11.11); the device runs flows only. A phone
  with no synced flows has nothing to execute, and the Worker fallback answers on
  the next sync.
