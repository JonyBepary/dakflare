package dev.dakflare.simulator.bridge

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import android.util.Log

/**
 * Receives real SMS broadcasts and hands them to the Rust core.
 *
 * No reply is sent in this milestone. The receiver only persists the inbound
 * message, even when the Activity and the Tauri runtime are not running.
 *
 * Logging rule: counts and ids only. The sender is masked to at most its last
 * four characters and the body is never logged.
 */
class SmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return

        // Opening a database may take longer than a receiver's main-thread
        // budget; keep the broadcast alive while a worker does the JNI call.
        val pending = goAsync()
        Thread(
            {
                try {
                    persist(context, intent)
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

    private fun persist(context: Context, intent: Intent) {
        val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
        if (messages.isEmpty()) return

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
        // Android that is `getDataDir()` (the app data root), *not*
        // `filesDir` — `filesDir` is a child of it, and using it here would
        // silently open a second database the UI never reads.
        val appDir = context.applicationInfo.dataDir
        for ((sender, group) in bySender) {
            val result = NativeBridge.storeIncomingSafely(
                appDir = appDir,
                sender = sender,
                body = group.body.toString(),
                receivedAtMs = group.receivedAtMs,
            )
            Log.i(TAG, "inbound sender=${mask(sender)} parts=${group.parts} result=$result")
        }
    }

    /** Keep at most the last four characters of a sender; never log it whole. */
    private fun mask(sender: String): String =
        if (sender.length <= 4) "***" else "***" + sender.takeLast(4)

    private class Multipart {
        val body = StringBuilder()
        var receivedAtMs = 0L
        var parts = 0
    }

    private companion object {
        const val TAG = "DakFlareSms"
    }
}
