package dev.dakflare.simulator.bridge

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Finishes a send: the `SENT` broadcast that [SendReceipt] attaches to every
 * part reports what the radio actually did, for a composed message and for a
 * flow reply alike.
 *
 * `RESULT_OK` marks the row `sent`; any error code marks it `failed`, which
 * keeps it out of the mirror instead of uploading a message that never left the
 * phone. The intent carries the row id and the result code, never the body, and
 * only ids and codes are logged. Once the row is final the same flush path as an
 * inbound reply uploads it when the Worker is reachable.
 */
class SendStatusReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != SendReceipt.ACTION_SENT) return

        val localId = intent.getStringExtra(SendReceipt.EXTRA_LOCAL_ID) ?: return
        val deviceId = intent.getStringExtra(SendReceipt.EXTRA_DEVICE_ID) ?: return
        // The platform sets the broadcast result code from SmsManager's report.
        val result = resultCode

        // A store write and a flush can outlive the receiver's main-thread
        // budget; keep the broadcast alive while a worker does it.
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

    private companion object {
        const val TAG = "DakFlareSms"
    }
}
