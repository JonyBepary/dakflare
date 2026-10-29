package dev.dakflare.simulator.bridge

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.telephony.SubscriptionManager
import android.util.Log

/**
 * Finishes a send: the `SENT` broadcast that [SendReceipt] attaches to every
 * part reports what the radio actually did, for a composed message and for a
 * flow reply alike.
 *
 * `RESULT_OK` marks the row `sent` and writes the system provider's Sent row;
 * any error code marks it `failed`, which keeps it out of the mirror instead of
 * uploading a message that never left the phone. A rejected send writes no
 * provider row at all.
 *
 * The intent carries the row id and the result code, never the body; the
 * recipient and body needed for the provider row are read back from the local
 * store by that id. The row state is written before the provider is touched, so
 * a provider failure can never change it. Only ids, codes and exception classes
 * are logged.
 */
class SendStatusReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != SendReceipt.ACTION_SENT) return

        val localId = intent.getStringExtra(SendReceipt.EXTRA_LOCAL_ID) ?: return
        val deviceId = intent.getStringExtra(SendReceipt.EXTRA_DEVICE_ID) ?: return
        // The platform sets the broadcast result code from SmsManager's report.
        val result = resultCode

        // A store write, a provider write and a flush can outlive the receiver's
        // main-thread budget; keep the broadcast alive while a worker does it.
        val pending = goAsync()
        Thread(
            {
                try {
                    val appDir = context.applicationInfo.dataDir
                    val state = if (result == Activity.RESULT_OK) "sent" else "failed"
                    val stored = NativeBridge.markOutboundSafely(
                        appDir,
                        deviceId,
                        localId,
                        state,
                    )
                    Log.i(TAG, "send status id=$localId result=$result state=$state stored=$stored")

                    if (result == Activity.RESULT_OK) {
                        // Same worker that marked the row, after the mark: the
                        // provider copy is a record of a real send, not a reason
                        // to change the row.
                        writeSentRow(context, appDir, deviceId, localId)
                    } else {
                        // Nothing left the phone, so there is no Sent row to add.
                        Log.i(TAG, "provider write skipped state=failed")
                    }

                    // Best effort: a failed flush leaves the row pending for the
                    // next call, so nothing is lost to being offline.
                    NativeBridge.flushPendingSafely(appDir, deviceId)
                } catch (error: Throwable) {
                    // Class name only: an exception message could carry a body.
                    Log.e(TAG, "send status failed: ${error.javaClass.simpleName}")
                } finally {
                    pending.finish()
                }
            },
            "dakflare-sms-status",
        ).start()
    }

    /**
     * Read the row's address/body back from the local store and mirror it into
     * `content://sms/sent`. A missing row or a provider failure is logged and
     * otherwise ignored: the local row already holds the truth.
     */
    private fun writeSentRow(
        context: Context,
        appDir: String,
        deviceId: String,
        localId: String,
    ) {
        val row = NativeBridge.messageByLocalIdSafely(appDir, deviceId, localId)
        if (row == null) {
            Log.w(TAG, "sent provider write skipped: row missing")
            return
        }
        val wrote = SmsProvider.writeSent(
            context = context,
            address = row.peer,
            body = row.body,
            dateMs = row.createdAt,
            subscriptionId = defaultSubscriptionId(),
        )
        Log.i(TAG, "sent provider write id=$localId ok=$wrote")
    }

    /** The SIM the SMS role would send from; unknown means "omit sub_id". */
    private fun defaultSubscriptionId(): Int = try {
        SubscriptionManager.getDefaultSmsSubscriptionId()
    } catch (_: Throwable) {
        SubscriptionManager.INVALID_SUBSCRIPTION_ID
    }

    private companion object {
        const val TAG = "DakFlareSms"
    }
}
