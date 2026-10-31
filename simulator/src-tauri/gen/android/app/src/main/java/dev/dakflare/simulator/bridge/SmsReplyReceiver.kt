package dev.dakflare.simulator.bridge

import android.Manifest
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.core.app.RemoteInput

/**
 * The "Reply" action on a message notification, end to end.
 *
 * [SmsReply] is the intent contract between [SmsNotifier] (which builds the
 * action) and [SmsReplyReceiver] (which performs it). The system fills the
 * caller's text into the [RemoteInput] result key; the peer and the
 * notification id travel as extras on the same explicit broadcast, because a
 * notification action has nowhere else to carry them. The action's
 * PendingIntent is MUTABLE — the platform refuses to attach RemoteInput results
 * to an immutable one — while the notification's tap intent stays untouched and
 * immutable.
 *
 * [SmsReplyReceiver] is manifest-declared and unexported. It needs no Activity:
 * a broadcast can cold-start the process, so a reply works with the app killed.
 * The send goes through [SmsSender.send], the same path as the composer, so it
 * inherits queue-before-radio ordering, the `SENT`/`DELIVERED` receipts, the
 * provider write and the refusal rules (identity, SEND_SMS, mask/shortcode)
 * instead of duplicating them.
 *
 * Feedback is never silent: a handed-off reply clears the message notification
 * it came from, and a refused one posts a notification that names the reason
 * and keeps the typed text visible. Nothing is cancelled on a refusal, so the
 * original message and its reply action survive.
 */
object SmsReply {
    /** The explicit broadcast [SmsReplyReceiver] performs. */
    const val ACTION_REPLY = "dev.dakflare.simulator.SMS_REPLY"

    /** The [RemoteInput] result key the system fills with the typed reply. */
    const val RESULT_KEY = "dakflare.reply.text"

    /**
     * A plain text extra read after the [RemoteInput] results.
     *
     * The notification shade only ever fills [RESULT_KEY]; this exists for a
     * same-uid diagnostic broadcast (`adb shell run-as … am broadcast`), which
     * cannot synthesise RemoteInput ClipData. It is not a second user path.
     */
    const val EXTRA_TEXT = "text"

    /** The thread this notification belongs to; the reply's only recipient. */
    const val EXTRA_PEER = "peer"

    /** The per-message notification the reply came from, so it can be cleared. */
    const val EXTRA_NOTIFICATION_ID = "notification_id"

    /** The explicit action intent; one per peer so two threads never share one. */
    internal fun intent(context: Context, peer: String, notificationId: Int): Intent =
        Intent(context, SmsReplyReceiver::class.java).apply {
            action = ACTION_REPLY
            // Part of the PendingIntent's identity (which ignores extras), so a
            // reply for one peer can never be updated into another's intent.
            data = Uri.parse("dakflare-reply://${Uri.encode(peer)}")
            putExtra(EXTRA_PEER, peer)
            putExtra(EXTRA_NOTIFICATION_ID, notificationId)
        }

    /**
     * The mutable broadcast behind the action. [PendingIntent.FLAG_MUTABLE] is
     * what allows the system to write the RemoteInput results into the intent;
     * below API 31 the flag does not exist and the platform always allows it.
     */
    internal fun pendingIntent(
        context: Context,
        peer: String,
        notificationId: Int,
    ): PendingIntent {
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                PendingIntent.FLAG_MUTABLE
            } else {
                0
            }
        return PendingIntent.getBroadcast(
            context,
            notificationId,
            intent(context, peer, notificationId),
            flags,
        )
    }

    /** The typed text: the shade's RemoteInput result first, the diagnostic extra second. */
    fun textFrom(intent: Intent): String? {
        val typed = RemoteInput.getResultsFromIntent(intent)
            ?.getCharSequence(RESULT_KEY)
            ?.toString()
        return if (!typed.isNullOrBlank()) typed else intent.getStringExtra(EXTRA_TEXT)
    }
}

/**
 * Performs one notification reply without an Activity.
 *
 * Runs on its own thread behind `goAsync`, because the store write and the
 * radio call can outlive a receiver's main-thread budget (as [SmsReceiver]
 * does). Logging follows the same rule as the rest of the SMS path: a masked
 * peer, ids, lengths and exception classes — never the body and never the
 * number whole.
 */
class SmsReplyReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != SmsReply.ACTION_REPLY) return

        val pending = goAsync()
        Thread(
            {
                try {
                    deliver(context, intent)
                } catch (error: Throwable) {
                    // Class name only: an exception message could carry the body.
                    Log.e(TAG, "reply failed: ${error.javaClass.simpleName}")
                } finally {
                    pending.finish()
                }
            },
            "dakflare-sms-reply",
        ).start()
    }

    private fun deliver(context: Context, intent: Intent) {
        val peer = intent.getStringExtra(SmsReply.EXTRA_PEER)?.trim().orEmpty()
        val notificationId = intent.getIntExtra(SmsReply.EXTRA_NOTIFICATION_ID, NO_ID)
        val text = SmsReply.textFrom(intent)

        // Without a peer there is no honest destination and no thread to name in
        // a failure notification; the log is all that is left.
        if (peer.isEmpty()) {
            Log.w(TAG, "reply ignored: no peer")
            return
        }
        if (text.isNullOrBlank()) {
            Log.w(TAG, "reply refused: empty text")
            SmsNotifier.notifyReplyRefused(context, peer, "", "The reply was empty")
            return
        }

        val appDir = context.applicationInfo.dataDir

        // Guard 1, identity: SmsSender refuses a blank id too, but checking here
        // is what lets the failure notification say "not paired" by name.
        val deviceId = NativeBridge.identitySafely(appDir)
        if (deviceId == null) {
            refuse(context, peer, text, "Not paired")
            return
        }

        // Guard 2, permission: same reason the composer shows.
        if (context.checkSelfPermission(Manifest.permission.SEND_SMS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            refuse(context, peer, text, "SMS permission is not granted")
            return
        }

        // Guard 3, destination and body: the same policy the core enforces, so a
        // refusal here says exactly what the composer would have said.
        NativeBridge.checkSendSafely(peer, text)?.let { problem ->
            refuse(context, peer, text, problem)
            return
        }

        // The SIM the composer would use, read from the same handset fact.
        val simSlot = NativeBridge.getDeviceFactSafely(appDir, "sim_slot")
            ?.toIntOrNull()
            ?: 0

        try {
            val localId = SmsSender.send(
                context = context,
                appDir = appDir,
                deviceId = deviceId,
                to = peer,
                body = text,
                simSlot = simSlot,
            )
            Log.i(
                TAG,
                "reply handed to radio id=$localId to=${mask(peer)} chars=${text.length}",
            )

            // The text is now the radio's; the inbox notification has served its
            // purpose. Only this message's notification is cleared, and the
            // summary is recomputed for whatever other threads still have one.
            if (notificationId != NO_ID) {
                SmsNotifier.replied(context, notificationId)
            } else {
                Log.w(TAG, "reply sent without a notification id; inbox notification left")
            }

            // The queue row and the flush are the sender's contract; the receipt
            // will mark it and mirror it exactly as for a composed message.
            GatewayService.start(context)
        } catch (refused: SmsSender.Refused) {
            refuse(context, peer, text, refused.message ?: "The reply was refused")
        } catch (error: Throwable) {
            Log.e(TAG, "reply send failed: ${error.javaClass.simpleName}")
            refuse(context, peer, text, "The phone could not send the reply")
        }
    }

    /**
     * Say why nothing was sent, and keep the typed text in front of the user.
     * The message notification is deliberately not cancelled: the user still has
     * the message and its Reply action.
     */
    private fun refuse(context: Context, peer: String, text: String, reason: String) {
        Log.i(TAG, "reply refused to=${mask(peer)} reason=${reason.take(48)}")
        SmsNotifier.notifyReplyRefused(context, peer, text, reason)
    }

    /** Keep at most the last four characters of a number; never log it whole. */
    private fun mask(number: String): String =
        if (number.length <= 4) "***" else "***" + number.takeLast(4)

    private companion object {
        const val TAG = "DakFlareSms"
        const val NO_ID = Int.MIN_VALUE
    }
}
