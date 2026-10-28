package dev.dakflare.simulator.bridge

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Telephony
import android.telephony.SmsManager
import android.telephony.SubscriptionManager
import android.telephony.TelephonyManager
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

/**
 * Receives real SMS broadcasts, hands them to the Rust core and sends the flow
 * replies from the same process.
 *
 * The Rust call persists the inbound row and runs the cached flows; Kotlin only
 * decides whether a reply is safe to send and hands it to `SmsManager`. There is
 * no second flow interpreter here.
 *
 * Logging rule: counts, ids and a masked sender only. The sender is masked to at
 * most its last four characters and no body — inbound or reply — is ever logged.
 */
class SmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return

        // Opening a database and sending may take longer than a receiver's
        // main-thread budget; keep the broadcast alive while a worker does it.
        val pending = goAsync()
        Thread(
            {
                try {
                    process(context, intent)
                } catch (error: Throwable) {
                    // Class name only: an exception message could carry a body.
                    Log.e(TAG, "inbound failed: ${error.javaClass.simpleName}")
                } finally {
                    pending.finish()
                }
            },
            "dakflare-sms",
        ).start()
    }

    private fun process(context: Context, intent: Intent) {
        val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
        if (messages.isEmpty()) return

        // The framework tags SMS_RECEIVED with the subscription it arrived on.
        // `SmsMessage.getSubscriptionId()` is not in the public SDK, so the
        // intent extra is the available source; invalid means "default SIM".
        val subscriptionId = intent.getIntExtra(
            EXTRA_SUBSCRIPTION,
            SubscriptionManager.INVALID_SUBSCRIPTION_ID,
        )

        // Concatenate multipart parts in delivery order, grouped by originating
        // address. A single broadcast practically always carries one sender, but
        // grouping keeps a carrier batch from merging two conversations.
        val bySender = LinkedHashMap<String, Multipart>()
        for (message in messages) {
            val sender = message.originatingAddress ?: continue
            val group = bySender.getOrPut(sender) { Multipart() }
            group.body.append(message.messageBody ?: "")
            group.receivedAtMs = maxOf(group.receivedAtMs, message.timestampMillis)
            group.parts += 1
        }

        // Must be the same directory Tauri's `app_data_dir()` reports: on
        // Android that is `getDataDir()` (the app data root), *not* `filesDir` —
        // `filesDir` is a child of it, and using it here would silently open a
        // second database the UI never reads.
        val appDir = context.applicationInfo.dataDir
        for ((sender, group) in bySender) {
            val result = NativeBridge.processIncomingSafely(
                appDir = appDir,
                sender = sender,
                body = group.body.toString(),
                receivedAtMs = group.receivedAtMs,
            )
            val outcome = parse(result)
            Log.i(
                TAG,
                "inbound sender=${mask(sender)} parts=${group.parts} " +
                    "stored=${outcome.ok} actions=${outcome.actions.size}",
            )
            if (!outcome.ok) {
                Log.w(TAG, "inbound was not answered: ${outcome.error}")
                continue
            }
            reply(context, appDir, outcome.deviceId, sender, subscriptionId, outcome.actions)
        }
    }

    /** Send the flow actions, after the filters that keep a gateway from replying badly. */
    private fun reply(
        context: Context,
        appDir: String,
        deviceId: String,
        sender: String,
        subscriptionId: Int,
        actions: List<Reply>,
    ) {
        if (actions.isEmpty()) return

        if (context.checkSelfPermission(Manifest.permission.SEND_SMS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            Log.w(TAG, "SEND_SMS not granted; ${actions.size} reply/replies skipped")
            decline(appDir, deviceId, actions, "no_send_permission")
            return
        }

        val senderSkip = skipReason(sender)
        if (senderSkip != null) {
            Log.i(TAG, "sender=${mask(sender)} skip=$senderSkip")
            decline(appDir, deviceId, actions, senderSkip)
            return
        }

        // Guard against a loopback / self-sent SMS. When no source yields a
        // number there is nothing to compare against, so the guard is logged as
        // unknown and only a number known from another source would match.
        val ownNumbers = ownNumbers(context)
        if (ownNumbers.isEmpty()) {
            Log.i(TAG, "self-number guard unknown; proceeding")
        } else if (normalize(sender) in ownNumbers) {
            Log.i(TAG, "sender=${mask(sender)} skip=self")
            decline(appDir, deviceId, actions, "self")
            return
        }

        val manager = smsManager(subscriptionId)
        if (manager == null) {
            decline(appDir, deviceId, actions, "manager_unavailable")
            return
        }

        for (action in actions) {
            val targetSkip = skipReason(action.to)
            if (targetSkip != null) {
                Log.i(TAG, "target skip=$targetSkip")
                mark(appDir, deviceId, action.localId, "failed")
                continue
            }
            try {
                val parts = manager.divideMessage(action.body)
                if (parts.size > 1) {
                    manager.sendMultipartTextMessage(action.to, null, parts, null, null)
                } else {
                    manager.sendTextMessage(action.to, null, action.body, null, null)
                }
                Log.i(TAG, "reply handled to=${mask(action.to)} parts=${parts.size}")
            } catch (error: Throwable) {
                // The reply never left the phone. `failed` keeps it out of the
                // mirror; M5.5's retry queue owns what happens next.
                mark(appDir, deviceId, action.localId, "failed")
                Log.e(TAG, "reply failed: ${error.javaClass.simpleName}")
                continue
            }
            // Exactly once per action, after the whole (possibly multipart)
            // send call returned. A mark error leaves the row queued — never
            // claim `sent` when the store did not accept it.
            mark(appDir, deviceId, action.localId, "sent")
        }

        // Best effort: the inbound row, its run and the rows marked `sent`
        // above upload together when the Worker is reachable; a failure leaves
        // them for the next flush. Declined rows stay `failed` and are never
        // uploaded.
        val ok = NativeBridge.flushPendingSafely(appDir, deviceId)
        Log.i(TAG, "flush attempted ok=$ok")
    }

    /**
     * Mark every action of a deliberately unanswered message as `failed`.
     *
     * Nothing left the phone, so the mirror must not upload it as history. The
     * log carries only a word reason and a count: never the recipient or body.
     */
    private fun decline(
        appDir: String,
        deviceId: String,
        actions: List<Reply>,
        reason: String,
    ) {
        Log.i(TAG, "replies declined count=${actions.size} skip=$reason")
        for (action in actions) {
            mark(appDir, deviceId, action.localId, "failed")
        }
    }

    private fun mark(appDir: String, deviceId: String, localId: String, state: String) {
        if (!NativeBridge.markOutboundSafely(appDir, deviceId, localId, state)) {
            // Class/name-free: markOutboundSafely already logged a class name
            // when it threw. Staying queued is the honest outcome.
            Log.w(TAG, "reply state not recorded; row stays queued")
        }
    }

    /**
     * Alphanumeric masks (`bKash`, `NAGAD`) and digits-only shortcodes are never
     * valid reply destinations for a human conversation. Returns a word-only
     * reason so the caller can decline and mark the row `failed`.
     */
    private fun skipReason(number: String): String? = when {
        number.any { it.isLetter() } -> "mask"
        number.count { it.isDigit() } < MIN_DIGITS -> "shortcode"
        else -> null
    }

    /**
     * Every reachable number for this device: the default line, each active
     * subscription's line and, on API 33+, the platform's phone-number lookup.
     * All need a phone-number permission; without it the set is empty and the
     * caller treats the guard as unknown rather than as "not me".
     */
    private fun ownNumbers(context: Context): Set<String> {
        val numbers = LinkedHashSet<String>()

        fun add(raw: String?) {
            val digits = normalize(raw ?: return)
            if (digits.length >= MIN_DIGITS) numbers += digits
        }

        try {
            add(context.getSystemService(TelephonyManager::class.java)?.line1Number)
        } catch (_: SecurityException) {
            // Permission denied: another source may still answer.
        }

        val subscriptions = context.getSystemService(SubscriptionManager::class.java)
        if (subscriptions != null) {
            try {
                for (info in subscriptions.activeSubscriptionInfoList ?: emptyList()) {
                    try {
                        add(info.number)
                    } catch (_: SecurityException) {
                    }
                    if (Build.VERSION.SDK_INT >= 33) {
                        try {
                            add(subscriptions.getPhoneNumber(info.subscriptionId))
                        } catch (_: SecurityException) {
                        }
                    }
                }
            } catch (_: SecurityException) {
            }

            if (Build.VERSION.SDK_INT >= 33) {
                val defaultId = SubscriptionManager.getDefaultSmsSubscriptionId()
                if (defaultId != SubscriptionManager.INVALID_SUBSCRIPTION_ID) {
                    try {
                        add(subscriptions.getPhoneNumber(defaultId))
                    } catch (_: SecurityException) {
                    }
                }
            }
        }

        return numbers
    }

    /** The manager for the SMS's subscription, or the default one. */
    @Suppress("DEPRECATION")
    private fun smsManager(subscriptionId: Int): SmsManager? = try {
        when {
            subscriptionId == SubscriptionManager.INVALID_SUBSCRIPTION_ID -> SmsManager.getDefault()
            Build.VERSION.SDK_INT >= 31 ->
                SmsManager.getDefault().createForSubscriptionId(subscriptionId)
            else -> SmsManager.getSmsManagerForSubscriptionId(subscriptionId)
        }
    } catch (error: Throwable) {
        Log.e(TAG, "SmsManager unavailable: ${error.javaClass.simpleName}")
        null
    }

    private fun parse(json: String): Outcome = try {
        val objectValue = JSONObject(json)
        if (!objectValue.optBoolean("ok")) {
            Outcome(false, objectValue.optString("error", "unknown"), "", emptyList())
        } else {
            val array: JSONArray = objectValue.optJSONArray("actions") ?: JSONArray()
            val actions = ArrayList<Reply>(array.length())
            for (index in 0 until array.length()) {
                val item = array.optJSONObject(index) ?: continue
                val to = item.optString("to")
                val body = item.optString("body")
                val localId = item.optString("local_id")
                if (to.isNotEmpty() && body.isNotEmpty()) {
                    actions += Reply(to, body, localId)
                }
            }
            Outcome(
                true,
                null,
                objectValue.optString("device_id"),
                actions,
            )
        }
    } catch (_: Throwable) {
        Outcome(false, "bad_json", "", emptyList())
    }

    /** Keep at most the last four characters of a number; never log it whole. */
    private fun mask(number: String): String =
        if (number.length <= 4) "***" else "***" + number.takeLast(4)

    /** Compare numbers the way the radio writes them: digits only. */
    private fun normalize(number: String): String = number.filter { it.isDigit() }

    private class Multipart {
        val body = StringBuilder()
        var receivedAtMs = 0L
        var parts = 0
    }

    private class Reply(val to: String, val body: String, val localId: String)

    private class Outcome(
        val ok: Boolean,
        val error: String?,
        val deviceId: String,
        val actions: List<Reply>,
    )

    private companion object {
        const val TAG = "DakFlareSms"
        const val EXTRA_SUBSCRIPTION = "subscription"
        const val MIN_DIGITS = 10
    }
}
