package dev.dakflare.simulator.bridge

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri

/**
 * The `SENT` and `DELIVERED` receipts shared by both send paths: a composed
 * message ([SmsSender]) and a flow reply ([SmsReceiver]).
 *
 * `SmsManager` reports the radio's verdict through the `sentIntent`, never
 * through the send call's return value — the call returning only means the
 * request was accepted for dispatch. Attaching this receipt is therefore the
 * only way a row may become `sent`.
 *
 * A `deliveryIntent` is the carrier's report that the message actually reached
 * the handset. It only proves what the network did; [SendStatusReceiver] maps it
 * to the terminal `delivered` state and never invents one when no report arrives.
 *
 * Both intents are explicit and target the same-app, unexported
 * [SendStatusReceiver]; an explicit broadcast reaches it without exporting it.
 * They carry only the row's `local_id` and `device_id`, never the body or the
 * recipient. The data URI makes each send its own PendingIntent without
 * relying on a request-code collision.
 */
internal object SendReceipt {
    /** The explicit broadcast [SendStatusReceiver] listens for. */
    const val ACTION_SENT = "dev.dakflare.simulator.SMS_SENT"
    const val ACTION_DELIVERED = "dev.dakflare.simulator.SMS_DELIVERED"
    const val EXTRA_LOCAL_ID = "local_id"
    const val EXTRA_DEVICE_ID = "device_id"

    /** One receipt for [localId]; safe to reuse for every part of a multipart send. */
    fun pendingIntent(context: Context, deviceId: String, localId: String): PendingIntent =
        receipt(context, ACTION_SENT, "sent", deviceId, localId)

    /**
     * The carrier's delivery report for [localId]. Same shape as the `SENT`
     * receipt, separate action and data URI so the platform never confuses the
     * two reports for one send.
     */
    fun deliveryIntent(context: Context, deviceId: String, localId: String): PendingIntent =
        receipt(context, ACTION_DELIVERED, "delivered", deviceId, localId)

    private fun receipt(
        context: Context,
        action: String,
        kind: String,
        deviceId: String,
        localId: String,
    ): PendingIntent {
        val intent = Intent(context, SendStatusReceiver::class.java).apply {
            this.action = action
            data = Uri.parse("dakflare-sms://$kind/$localId")
            putExtra(EXTRA_LOCAL_ID, localId)
            putExtra(EXTRA_DEVICE_ID, deviceId)
        }
        return PendingIntent.getBroadcast(
            context,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }
}
