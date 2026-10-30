package dev.dakflare.simulator.bridge

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.telephony.SmsManager
import android.telephony.SubscriptionManager
import android.util.Log

/**
 * Finishes a send from the two receipts [SendReceipt] attaches to every part: a
 * composed message and a flow reply alike.
 *
 * `SENT` (the radio's verdict):
 *  - `RESULT_OK` marks the row `sent` and writes the system provider's Sent row;
 *  - `RESULT_ERROR_RADIO_OFF` / `RESULT_ERROR_NO_SERVICE` records a transient
 *    failure — the row goes back to `queued`, spends one of its three attempts
 *    and is retried by [GatewayService];
 *  - any other code marks it `failed`, which keeps it out of the mirror instead
 *    of uploading a message that never left the phone.
 *
 * `DELIVERED` (the carrier's report) marks the row `delivered`. A report that
 * arrives before the `SENT` broadcast is not lost: the core promotes the still
 * `queued` row with `sent` then `delivered` in one transaction. A non-OK
 * delivery report is logged and ignored — it does not downgrade a message that
 * the radio already accepted.
 *
 * The intents carry the row id and the result code, never the body; the
 * recipient and body needed for the provider row are read back from the local
 * store by that id. The row state is written before the provider is touched, so
 * a provider failure can never change it. Only ids, codes and exception classes
 * are logged.
 */
class SendStatusReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            SendReceipt.ACTION_SENT -> handleSent(context, intent)
            SendReceipt.ACTION_DELIVERED -> handleDelivered(context, intent)
            else -> return
        }
    }

    private fun handleSent(context: Context, intent: Intent) {
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
                    when {
                        result == Activity.RESULT_OK -> {
                            val stored = NativeBridge.markOutboundSafely(
                                appDir,
                                deviceId,
                                localId,
                                "sent",
                            )
                            Log.i(TAG, "send status id=$localId result=$result state=sent stored=$stored")
                            // Tell the deployment, not just the local store: a
                            // command collected from the outbound poll only
                            // leaves ACKED_BY_DEVICE when its terminal state is
                            // reported here.
                            report(appDir, deviceId, localId, "sent")

                            // Same worker that marked the row, after the mark: the
                            // provider copy is a record of a real send, not a reason
                            // to change the row.
                            writeSentRow(context, appDir, deviceId, localId)
                        }

                        result == SmsManager.RESULT_ERROR_RADIO_OFF ||
                            result == SmsManager.RESULT_ERROR_NO_SERVICE -> {
                            // The radio is off or has no service: the message never
                            // left, but the send is still worth retrying. Spend one
                            // attempt; the core turns the third one into `failed`.
                            val outcome = NativeBridge.recordTransientFailureSafely(
                                appDir,
                                deviceId,
                                localId,
                            )
                            Log.i(
                                TAG,
                                "send status id=$localId result=$result " +
                                    "state=${outcome?.state ?: "unknown"} " +
                                    "attempts=${outcome?.attempts ?: -1}",
                            )
                            // No provider row: nothing left the phone.
                        }

                        else -> {
                            val stored = NativeBridge.markOutboundSafely(
                                appDir,
                                deviceId,
                                localId,
                                "failed",
                            )
                            Log.i(TAG, "send status id=$localId result=$result state=failed stored=$stored")
                            Log.i(TAG, "provider write skipped state=failed")
                            report(appDir, deviceId, localId, "failed")
                        }
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
     * A carrier delivery report is terminal evidence: it may promote a row that
     * is still `queued` (the report arrived first), but it never rewrites a row
     * the radio reported as failed.
     */
    private fun handleDelivered(context: Context, intent: Intent) {
        val localId = intent.getStringExtra(SendReceipt.EXTRA_LOCAL_ID) ?: return
        val deviceId = intent.getStringExtra(SendReceipt.EXTRA_DEVICE_ID) ?: return
        val result = resultCode

        val pending = goAsync()
        Thread(
            {
                try {
                    val appDir = context.applicationInfo.dataDir
                    if (result != Activity.RESULT_OK) {
                        // A delivery failure report does not prove the message
                        // was never sent; leave the honest `sent` row alone.
                        Log.i(TAG, "delivery status id=$localId result=$result ignored")
                    } else {
                        val marked = NativeBridge.markDeliveredSafely(appDir, deviceId, localId)
                        Log.i(TAG, "delivery status id=$localId result=$result delivered=$marked")
                        report(appDir, deviceId, localId, "delivered")
                    }

                    // The transition is local-only (the Worker's log has no state
                    // column), but the flush still uploads an unmirrored body.
                    NativeBridge.flushPendingSafely(appDir, deviceId)
                } catch (error: Throwable) {
                    Log.e(TAG, "delivery status failed: ${error.javaClass.simpleName}")
                } finally {
                    pending.finish()
                }
            },
            "dakflare-sms-delivery",
        ).start()
    }

    /**
     * Report one terminal state to the deployment.
     *
     * Silent by design: the local row already holds the truth, and a refused
     * report leaves the command where it was for the next receipt or tick. The
     * id is logged only on success, and it is a command id, never a body.
     */
    private fun report(appDir: String, deviceId: String, localId: String, state: String) {
        if (NativeBridge.reportStatusSafely(appDir, deviceId, localId, state)) {
            Log.i(TAG, "command status id=$localId state=$state reported")
        }
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
            localId = localId,
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
