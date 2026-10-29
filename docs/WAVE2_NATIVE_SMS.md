# Wave 2 — making the phone a gateway

Status: M5.1 and M5.2 gated on hardware 2026-10-29 (§8); M5.3 next. Scope: the
part that did not exist before — receiving and sending real SMS while the app is
closed. Everything before this is protocol, console and a simulated carrier.

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
       ├─ NativeBridge.processIncoming(<getDataDir()>, sender, body, receivedAtMs)
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

Two mechanisms, both used for the 2026-10-29 gate:

1. **Root PDU injection** (`simulator/scripts/inject-sms.sh` and
   `simulator/scripts/sms-pdu.py`). A 3GPP SMS-DELIVER encoder plus an
   `app_process` injector (`ActivityThread.systemMain()` by reflection) that
   sends the system's `SMS_RECEIVED` broadcast to the app's manifest receiver
   carrying real `pdus`.
   It exercises the production receive path — PDU parse, multipart concat, the
   `subscription` extra — with no carrier round trip. Only the inbound leg is
   synthetic: a reply still goes to `SmsManager`, so a reply to a real number is
   a real SMS. Inject from the device's own number to test the self-guard, and
   from a mask (`bKash`) or a shortcode (`16222`) to test the filters. Never
   inject from a number you do not own, or the phone will text a stranger.
2. **A second phone** for the truth case: one real SMS to the gateway while the
   app is closed, which is the only way to prove carrier delivery, the radio's
   own PDU, and a real reply.

`adb emu sms send` does not exist for physical devices. The fleet's Mi A3 has a
single SIM, so the two-SIM loopback this section used to recommend is not
available: the self-number guard is covered by `getLine1Number`,
`SubscriptionInfo.getNumber()` and `getPhoneNumber(subId)` on the loaded
subscription instead.

## 7. What this does not fix

- Keystore migration (the key is still PKCS#8 in libSQL) — do it in M5.3 while the
  service work touches identity boot.
- FCM wake and the WebSocket client — M5.3/M5.6; polling still works without them.
- Rules are gateway-side by decision (§11.11); the device runs flows only. A phone
  with no synced flows has nothing to execute, and the Worker fallback answers on
  the next sync.
- **Flows are only fetched from the carrier panel.** `carrier_inject` is the sole
  caller of `fetch_flows` + `replace_flows`, so a freshly paired phone has an
  empty `flows` table — and therefore answers nothing — until an operator opens
  the device page and injects once. Sync belongs on its own trigger (paired,
  app opened, service start), not on a test button.

## 8. Gate log — 2026-10-29

Device: Xiaomi Mi A3 (`laurel_sprout`), LineageOS 23 / Android 16, rooted,
single SIM (subId 1, `sim_slot` 2), number `+8801…82829`. Build: debug APK,
`dev.dakflare.simulator` installed with `adb install -r -g` so all three
permissions are granted without a dialog. Deployment: production Worker, flow
`wf_gate` v2 (trigger: body keyword `DAKFLARE-GATE-1` → `send_sms` to
`{{sender}}` → `stop`), cached on the device before the run.

### M5.1 + M5.4 filters — app closed

`am kill` left no process (`pidof` empty), logcat cleared, then one PDU per case
through the root injector. Sender masked in the log, as it is in production.

| Case | Sender | Outcome |
|---|---|---|
| self-guard | `+8801…82829` | `stored=true actions=1`, reply declined `skip=self` |
| carrier mask | `bKash` | `stored=true`, declined `skip=mask` |
| shortcode | `16222` | `stored=true`, declined `skip=shortcode` |
| Bangla UCS-2 | `+8801…82829` | `stored=true`, body byte-identical in the DB, declined `skip=self` |
| no port in app | — | `pidof` empty before the broadcast; the receiver cold-started the process |

A declined reply keeps its row at `failed`, so nothing is uploaded as history.
`adb logcat | grep -c` for a known body and for a known reply text: 0.

### M5.2 — real SMS, real reply, mirrored

App closed (`pidof` empty), logcat cleared, then one SMS from a second handset
at `+8801…96080`:

```
DakFlareSms: inbound sender=***6080 parts=1 stored=true actions=1
DakFlareSms: reply handled to=***6080 parts=1
DakFlareSms: mirror attempted ok=true
```

(`mirror attempted` is the earlier build's log line, when only outbound rows
were drained; the flush below replaced it.)

Device database (`/data/data/dev.dakflare.simulator/simulator.db`):

```
direction  state     peer             body
in         received  +8801…96080  DAKFLARE-GATE-1 HELLO
out        sent      +8801…96080  DakFlare gate ok. You said: DAKFLARE-GATE-1 HELLO
```

Both `local_id`s derive from the PDU timestamp and sender, and the reply from
the inbound id, so a re-delivered broadcast cannot double-insert.

Console (`GET /v1/messages?device_id=dev29b9c2248cb266c8`):

```
out +8801…96080 | DakFlare gate ok. You said: DAKFLARE-GATE-1 HELLO
```

The reply reached the deployment through `NativeBridge.mirrorOutbound`, which
the receiver calls after its send loop and which `poll_device` repeats as a
recovery sweep.

### M5.2 — native flush, one request

The receiver stopped at the reply in the first run above, so the console held a
reply with no message behind it. `NativeBridge.flushPending` now uploads pending
inbound rows, their stored flow runs and unmirrored outbound rows in one
`upload_batch`; `poll_device` repeats it as a recovery sweep.

Recovery first: opening the app and pressing Poll uploaded the three rows the
earlier build had left at `received`, including the carrier's own multipart
promotion (`GP Info`, 2 parts):

```
in GP Info        | দুঃখিত, নম্বরটি ইমার্জেন্সি মিনিট লোনের জন্য উপযুক…
in +8801…96080 | Hello
in +8801…96080 | DAKFLARE-GATE-1 HELLO
out +8801…96080 | DakFlare gate ok. You said: DAKFLARE-GATE-1 HELLO
```

Then the receive path itself, app closed again (`pidof` empty), one injected
delivery from `+8801…96080`:

```
DakFlareSms: inbound sender=***6080 parts=1 stored=true actions=1
DakFlareSms: reply handled to=***6080 parts=1
DakFlareSms: flush attempted ok=true
```

```
device: in  uploaded  +8801…96080  DAKFLARE-GATE-1 second run
        out sent      +8801…96080  DakFlare gate ok. You said: DAKFLARE-GATE-1 second run
        flow_runs: wf_gate v2 delivered native-5c83d2a9…
console: in  +8801…96080  DAKFLARE-GATE-1 second run
         out +8801…96080  DakFlare gate ok. You said: DAKFLARE-GATE-1 second run
```

`flushPending` is best effort and idempotent: the last failing step leaves the
rows pending, and every key — inbound `(device_id, local_id)`, run
`(device_id, local_id, flow_id, flow_version)`, outbound the same as inbound —
makes the retry a no-op on the Worker.

### Not yet true at this gate

- Delivery receipts and the retry queue are M5.5; `sent` means "handed to the
  radio", not "delivered".
- The flush runs inside the receiver's `goAsync` window, so a very slow network
  can outlive the broadcast budget. M5.3's foreground service is where the
  drain belongs; until then `poll_device` is the safety net.
- Flows still arrive only from the carrier panel (see §7), and the release build
  has no signing config. Everything above is a debug APK installed with `adb`;
  reboot survival, `am kill` versus a user force-stop, and battery-optimisation
  soak are M5.3.

### Correction, 2026-10-29 (later the same day)

The M5.2 section above claims a real reply. It does not hold on this handset.

`SmsReceiver` called `SmsManager.sendTextMessage` with no `SENT` intent and marked the
row `sent` when the call returned. On this Mi A3 the radio rejects every mobile-originated
SMS: `result=16 (RESULT_MODEM_ERROR)`, `111 (RESULT_RIL_MODEM_ERR)` over the CS path, and
the stock `com.android.messaging` app shows "Not sent" for the same number, including for
the replies this gateway believed it had sent. Mobile-terminated SMS works — inbound rows
and the carrier's own multipart promotion arrive normally.

So at that gate: receiving, the flow run, the queue and the console mirror were real; the
`out … sent` row was not evidence that anything left the phone.

What changed as a result: the reply path now passes a `SENT` `PendingIntent` and only marks
`sent` on `RESULT_OK`, so a rejected reply lands as `failed` and is not mirrored. The
composer uses the same receipt.

Still open, and not a software question: whether this SIM may send at all (carrier barring,
plan, or the LineageOS 23 modem/IMS stack on `laurel_sprout`). Test order: the same SIM in
another handset, then another SIM in this handset.
