package dev.dakflare.simulator.bridge

import android.Manifest
import android.app.PendingIntent
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.telephony.SmsManager
import android.telephony.SubscriptionManager
import android.util.Log

/**
 * Sends one SMS typed in the composer.
 *
 * The order is the contract: refuse what must never be sent (permission, mask,
 * shortcode, oversize body), then write the `queued` row through the Rust core,
 * then touch the radio, then acknowledge the command. The row therefore exists
 * before `SmsManager` is called, and [SendStatusReceiver] finishes it from the
 * `SENT` broadcast rather than this call claiming delivery. A command is never
 * acknowledged before `SmsManager` returns without throwing: that is the
 * radio's acceptance, not local durability.
 *
 * Logging rule, same as the inbound receiver: counts, ids and a masked
 * recipient only. No body is ever logged, and no number is logged whole.
 */
object SmsSender {
    private const val TAG = "DakFlareSms"

    /**
     * A refusal the composer can show verbatim. It never carries the recipient
     * or the body; `message` is the whole user-facing text.
     */
    class Refused(message: String) : Exception(message)

    /**
     * Queue and send one message, returning the id of the row that was written.
     *
     * Throws [Refused] for every path that did not hand the message to the
     * radio. Once the row exists, any failure marks it `failed` first, so it is
     * never left `queued` by an exception in this process.
     */
    @JvmStatic
    fun send(
        context: Context,
        appDir: String,
        deviceId: String,
        to: String,
        body: String,
        simSlot: Int,
    ): String {
        if (deviceId.isBlank()) throw Refused("Not paired")

        if (context.checkSelfPermission(Manifest.permission.SEND_SMS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            throw Refused("SMS permission is not granted")
        }

        val recipient = to.trim()
        // One policy with Rust and the webview: same rules, same sentence.
        NativeBridge.checkSendSafely(recipient, body)?.let { throw Refused(it) }

        // The row exists before the radio is touched. A double tap reaches this
        // point twice but resolves to the same row, because an identical send
        // still `queued` is the same send to the store.
        val localId = NativeBridge.queueOutboundSafely(appDir, deviceId, recipient, body)
            ?: throw Refused("The message could not be queued")

        val manager = try {
            smsManager(context, subscriptionId(context, simSlot))
        } catch (error: Throwable) {
            markFailed(appDir, deviceId, localId)
            Log.e(TAG, "SmsManager unavailable: ${error.javaClass.simpleName}")
            throw Refused("This phone cannot send SMS right now")
        }

        try {
            val parts = handToRadio(context, deviceId, localId, recipient, body, manager)
            Log.i(TAG, "compose handed to radio to=${mask(recipient)} parts=$parts")
        } catch (error: Throwable) {
            markFailed(appDir, deviceId, localId)
            // Class name only: an exception message could carry the body.
            Log.e(TAG, "compose failed: ${error.javaClass.simpleName}")
            throw Refused("The phone could not send the message")
        }

        return localId
    }

    /**
     * Re-send the queued rows the gateway tick is allowed to retry.
     *
     * Only local ids cross the Rust boundary. Each row's recipient, body and SM
     * slot are read back from the store here, never passed in, so a retry can
     * only send what was actually queued. Returns how many were handed to the
     * radio; the `SENT`/`DELIVERED` receipts finish each row exactly as they do
     * for a first send.
     */
    @JvmStatic
    fun retryQueued(context: Context, appDir: String, deviceId: String): Int {
        if (deviceId.isBlank()) return 0
        if (context.checkSelfPermission(Manifest.permission.SEND_SMS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            return 0
        }

        val localIds = NativeBridge.retryableOutboundSafely(appDir, deviceId)
        var handed = 0
        for (localId in localIds) {
            if (resend(context, appDir, deviceId, localId)) handed += 1
        }
        return handed
    }

    /**
     * One retry from the stored row. This is the send entry the gateway calls
     * per local id; the recipient, body and SIM slot are read back from the
     * store by [NativeBridge.resendOutboundSafely], never passed in.
     */
    @JvmStatic
    fun resend(
        context: Context,
        appDir: String,
        deviceId: String,
        localId: String,
    ): Boolean {
        val row = NativeBridge.resendOutboundSafely(appDir, deviceId, localId) ?: return false

        val manager = try {
            smsManager(context, subscriptionId(context, row.simSlot))
        } catch (error: Throwable) {
            markFailed(appDir, deviceId, localId)
            Log.e(TAG, "retry manager unavailable: ${error.javaClass.simpleName}")
            return false
        }

        return try {
            val parts = handToRadio(context, deviceId, localId, row.peer, row.body, manager)
            // The radio accepted the message, so the command may be acknowledged
            // now. A composer row has no lease token and this is a harmless
            // false, but only a command that reached the radio is acked.
            val acked = NativeBridge.ackCommandSafely(appDir, deviceId, localId)
            Log.i(TAG, "retry handed to radio to=${mask(row.peer)} parts=$parts acked=$acked")
            true
        } catch (error: Throwable) {
            // A thrown send has no result code, so it is not known to be
            // transient. The honest outcome is `failed`, as for a first send.
            markFailed(appDir, deviceId, localId)
            Log.e(TAG, "retry failed: ${error.javaClass.simpleName}")
            false
        }
    }

    /**
     * Divide, attach both receipts and hand one message to the radio. Shared by
     * a first send and a retry so the two paths cannot diverge on receipts.
     */
    private fun handToRadio(
        context: Context,
        deviceId: String,
        localId: String,
        recipient: String,
        body: String,
        manager: SmsManager,
    ): Int {
        val parts = manager.divideMessage(body)
        // The radio is handed exactly these parts. Log their sizes, never their
        // text: a 2-part GSM body shows 153,47 and a Bangla body 67,33, which is
        // the only proof available when the receiving handset cannot be read.
        Log.i(TAG, "radio parts=${parts.size} lengths=${partLengths(parts)}")
        val sent = SendReceipt.pendingIntent(context, deviceId, localId)
        val delivered = SendReceipt.deliveryIntent(context, deviceId, localId)
        if (parts.size > 1) {
            // One receipt per part: each part reports the same row, and marking
            // it twice is a no-op in the store.
            val sentIntents = ArrayList<PendingIntent>(parts.size)
            val deliveryIntents = ArrayList<PendingIntent>(parts.size)
            repeat(parts.size) {
                sentIntents.add(sent)
                deliveryIntents.add(delivered)
            }
            manager.sendMultipartTextMessage(recipient, null, parts, sentIntents, deliveryIntents)
        } else {
            manager.sendTextMessage(recipient, null, body, sent, delivered)
        }
        return parts.size
    }

    /**
     * Resolve the SMS subscription from the device row's 1-based `sim_slot`,
     * falling back to the platform default when the slot is unset, missing or
     * unreadable. A gateway must send from the SIM the operator chose, but a
     * send that cannot prove which tray is worse than the default.
     */
    private fun subscriptionId(context: Context, simSlot: Int): Int {
        if (simSlot >= 1) {
            try {
                val subscriptions = context.getSystemService(SubscriptionManager::class.java)
                val match = subscriptions?.activeSubscriptionInfoList
                    ?.firstOrNull { it.simSlotIndex + 1 == simSlot }
                if (match != null) return match.subscriptionId
            } catch (_: SecurityException) {
                // Fall through to the default.
            }
        }
        return SubscriptionManager.getDefaultSmsSubscriptionId()
    }

    @Suppress("DEPRECATION")
    private fun smsManager(context: Context, subscriptionId: Int): SmsManager =
        when {
            subscriptionId == SubscriptionManager.INVALID_SUBSCRIPTION_ID ->
                SmsManager.getDefault()
            Build.VERSION.SDK_INT >= 31 ->
                SmsManager.getDefault().createForSubscriptionId(subscriptionId)
            else -> SmsManager.getSmsManagerForSubscriptionId(subscriptionId)
        }

    /**
     * The length in UTF-16 code units of every part the radio was given. For
     * GSM-7 this is the septet count the carrier sees; for UCS-2 it is the
     * number of two-byte characters. Never the text itself.
     */
    private fun partLengths(parts: List<String>): String =
        parts.joinToString(",") { it.length.toString() }

    private fun markFailed(appDir: String, deviceId: String, localId: String) {
        if (!NativeBridge.markOutboundSafely(appDir, deviceId, localId, "failed")) {
            Log.w(TAG, "compose state not recorded; row stays queued")
        }
    }

    /** Keep at most the last four characters of a number; never log it whole. */
    private fun mask(number: String): String =
        if (number.length <= 4) "***" else "***" + number.takeLast(4)
}
