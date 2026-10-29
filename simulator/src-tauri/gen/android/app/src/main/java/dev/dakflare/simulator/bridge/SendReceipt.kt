package dev.dakflare.simulator.bridge

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri

/**
 * The `SENT` receipt shared by both send paths: a composed message
 * ([SmsSender]) and a flow reply ([SmsReceiver]).
 *
 * `SmsManager` reports the radio's verdict through the `sentIntent`, never
 * through the send call's return value — the call returning only means the
 * request was accepted for dispatch. Attaching this receipt is therefore the
 * only way a row may become `sent`.
 *
 * The intent is explicit and targets the same-app, unexported
 * [SendStatusReceiver]; an explicit broadcast reaches it without exporting it.
 * It carries only the row's `local_id` and `device_id`, never the body or the
 * recipient. The data URI makes each send its own PendingIntent without
 * relying on a request-code collision.
 */
internal object SendReceipt {
    /** The explicit broadcast [SendStatusReceiver] listens for. */
    const val ACTION_SENT = "dev.dakflare.simulator.SMS_SENT"
    const val EXTRA_LOCAL_ID = "local_id"
    const val EXTRA_DEVICE_ID = "device_id"

    /** One receipt for [localId]; safe to reuse for every part of a multipart send. */
    fun pendingIntent(context: Context, deviceId: String, localId: String): PendingIntent {
        val intent = Intent(context, SendStatusReceiver::class.java).apply {
            action = ACTION_SENT
            data = Uri.parse("dakflare-sms://sent/$localId")
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
