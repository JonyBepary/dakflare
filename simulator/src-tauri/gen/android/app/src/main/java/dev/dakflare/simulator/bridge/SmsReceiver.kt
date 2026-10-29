package dev.dakflare.simulator.bridge

import android.Manifest
import android.app.PendingIntent
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
        // SMS_DELIVER is the copy Android sends to the default SMS app;
        // SMS_RECEIVED is the ordinary broadcast every RECEIVE_SMS holder gets
        // when no default app is set. Both carry the same PDUs and share one
        // path. If the platform ever sends both for one message, the core's
        // deterministic local_id (PDU timestamp + sender) reuses the first row
        // and returns no actions, so neither storage nor a reply happens twice.
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION &&
            intent.action != Telephony.Sms.Intents.SMS_DELIVER_ACTION
        ) {
            return
        }

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
            val body = group.body.toString()
            val result = NativeBridge.processIncomingSafely(
                appDir = appDir,
                sender = sender,
                body = body,
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

            // The store succeeded, so the message is safe before the provider is
            // touched. The write is best effort and time-bounded: a wedged
            // provider must not keep an ordered SMS_DELIVER alive past budget.
            val write = SmsProvider.writeInboxBounded(
                context = context,
                address = sender,
                body = body,
                dateMs = group.receivedAtMs,
                subscriptionId = subscriptionId,
            )
            Log.i(TAG, "inbox provider=${write.name.lowercase()}")

            // Announce a genuinely new delivery once. A duplicate provider row
            // means the first delivery already announced it; without the role
            // the notifier's own delivery-key set is the same decision.
            if (write != SmsProvider.InboxWrite.DUPLICATE) {
                SmsNotifier.notifyInbound(
                    context = context,
                    peer = sender,
                    body = body,
                    deliveryKey = "${group.receivedAtMs}:$sender",
                )
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
        val ownNumbers = ownNumbers(context, appDir)
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
                // The receipt is the only proof the radio accepted the message:
                // the send call returning proves only that the request was
                // accepted for dispatch. [SendStatusReceiver] marks the row
                // `sent` on RESULT_OK and `failed` otherwise, then flushes.
                val sent = SendReceipt.pendingIntent(context, deviceId, action.localId)
                if (parts.size > 1) {
                    // `sendMultipartTextMessage` takes one sentIntent per part.
                    // The same intent is repeated, as [SmsSender] does: every
                    // part reports the same row and the store keeps the last
                    // report. The platform sends one report per part, so a
                    // radio rejection reports a failure instead of a false
                    // `sent`.
                    val sentIntents = ArrayList<PendingIntent>(parts.size)
                    repeat(parts.size) { sentIntents.add(sent) }
                    manager.sendMultipartTextMessage(action.to, null, parts, sentIntents, null)
                } else {
                    manager.sendTextMessage(action.to, null, action.body, sent, null)
                }
                Log.i(TAG, "reply handed to radio to=${mask(action.to)} parts=${parts.size}")
            } catch (error: Throwable) {
                // Either the receipt could not be built or the send call threw:
                // there is no way to learn the radio's verdict, so record the
                // honest failure now. `failed` keeps it out of the mirror;
                // M5.5's retry queue owns what happens next.
                mark(appDir, deviceId, action.localId, "failed")
                Log.e(TAG, "reply failed: ${error.javaClass.simpleName}")
                continue
            }
            // No mark here. The row stays `queued` until the `SENT` broadcast
            // arrives. If the platform drops that broadcast the row stays
            // `queued` — that is the honest state, and `flush_pending` will not
            // upload it; there is deliberately no timer that guesses a verdict.
        }

        // Best effort: the inbound row and its run upload together when the
        // Worker is reachable. Outbound rows upload only once the receipt has
        // made them `sent`; a failure leaves everything for the next flush.
        // Declined rows stay `failed` and are never uploaded.
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
    private fun ownNumbers(context: Context, appDir: String): Set<String> {
        val numbers = LinkedHashSet<String>()

        fun add(raw: String?) {
            val digits = normalize(raw ?: return)
            if (digits.length >= MIN_DIGITS) numbers += digits
        }

        // The number this app last read from the radio. A receiver that cold-starts
        // for a broadcast often gets an empty line1Number before the modem is up,
        // and an empty set turns the guard off instead of on — the one failure
        // mode that could make the gateway answer itself.
        add(NativeBridge.getDeviceFactSafely(appDir, "self_number"))

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
