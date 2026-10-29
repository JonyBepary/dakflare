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
 * then touch the radio. The row therefore exists before `SmsManager` is called,
 * and [SendStatusReceiver] finishes it from the `SENT` broadcast rather than
 * this call claiming delivery.
 *
 * Logging rule, same as the inbound receiver: counts, ids and a masked
 * recipient only. No body is ever logged, and no number is logged whole.
 */
object SmsSender {
    private const val TAG = "DakFlareSms"

    /** One typed message, not a carrier payload; the Rust entry enforces the same cap. */
    private const val MAX_BODY_CHARS = 1600

    /** Masks and shortcodes are never valid destinations for a conversation. */
    private const val MIN_DIGITS = 10

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
        if (recipient.isEmpty() || skipReason(recipient) != null) {
            throw Refused("That number is not a reply target")
        }
        if (body.isBlank()) throw Refused("That message is empty")
        if (body.length > MAX_BODY_CHARS) throw Refused("That message is too long")

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
            val parts = manager.divideMessage(body)
            val sent = SendReceipt.pendingIntent(context, deviceId, localId)
            if (parts.size > 1) {
                // One PendingIntent for every part: each part reports the same
                // row, and marking it twice is a no-op in the store.
                val sentIntents = ArrayList<PendingIntent>(parts.size)
                repeat(parts.size) { sentIntents.add(sent) }
                manager.sendMultipartTextMessage(recipient, null, parts, sentIntents, null)
            } else {
                manager.sendTextMessage(recipient, null, body, sent, null)
            }
            Log.i(TAG, "compose handed to radio to=${mask(recipient)} parts=${parts.size}")
        } catch (error: Throwable) {
            markFailed(appDir, deviceId, localId)
            // Class name only: an exception message could carry the body.
            Log.e(TAG, "compose failed: ${error.javaClass.simpleName}")
            throw Refused("The phone could not send the message")
        }

        return localId
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

    private fun markFailed(appDir: String, deviceId: String, localId: String) {
        if (!NativeBridge.markOutboundSafely(appDir, deviceId, localId, "failed")) {
            Log.w(TAG, "compose state not recorded; row stays queued")
        }
    }

    /**
     * Same rule as `SmsReceiver.skipReason`: letters mean an alphanumeric mask,
     * fewer than ten digits means a shortcode. Returns a word-only reason.
     */
    private fun skipReason(number: String): String? = when {
        number.any { it.isLetter() } -> "mask"
        number.count { it.isDigit() } < MIN_DIGITS -> "shortcode"
        else -> null
    }

    /** Keep at most the last four characters of a number; never log it whole. */
    private fun mask(number: String): String =
        if (number.length <= 4) "***" else "***" + number.takeLast(4)
}
