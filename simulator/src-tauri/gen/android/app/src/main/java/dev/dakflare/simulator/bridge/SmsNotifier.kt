package dev.dakflare.simulator.bridge

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import dev.dakflare.simulator.MainActivity

/**
 * One notification channel and one notification per inbound message.
 *
 * A default SMS app is expected to tell the user about a message it stored. The
 * channel is low importance and silent by default: this is a gateway, and an
 * inbound SMS is information, not an alarm.
 *
 * Tapping a notification reuses [SmsRoute]: it launches [MainActivity] with a
 * `sms:<peer>` VIEW intent, which the Activity turns into `/messages/<peer>`.
 *
 * Two suppressions are deliberate: a message the app itself sent never reaches
 * this object, and an inbound message for the thread currently in front of the
 * user is not announced again.
 */
object SmsNotifier {
    const val CHANNEL_ID = "dakflare_messages"

    private const val TAG = "DakFlareSms"
    private const val GROUP = "dakflare.messages"
    private const val NOTIFICATION_TAG = "dakflare-message"
    private const val SUMMARY_ID = 0x0DAF1
    private const val MMS_ID = 0x0DAF2

    private const val PREFS = "dakflare_notifications"
    private const val KEY_SEEN = "seen"
    private const val MAX_SEEN = 100

    private const val MAX_TEXT = 160

    /** Create the channel once; `dakflare_messages` is the only one this app owns. */
    fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return

        val channel = NotificationChannel(
            CHANNEL_ID,
            "Messages",
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "Incoming SMS handled by DakFlare"
            // Low importance already stays silent; clear the sound explicitly so
            // a future importance change cannot turn the gateway into an alarm.
            setSound(null, null)
            enableVibration(false)
            setShowBadge(true)
        }
        manager.createNotificationChannel(channel)
    }

    /**
     * Post one message notification, or return `false` when it was suppressed or
     * this delivery was already announced.
     *
     * `deliveryKey` is the same PDU timestamp + sender the local id is built
     * from, so a re-delivered broadcast is announced once.
     */
    fun notifyInbound(
        context: Context,
        peer: String,
        body: String,
        deliveryKey: String,
    ): Boolean {
        if (AppVisibility.isShowing(peer)) {
            Log.i(TAG, "notification suppressed: thread visible")
            return false
        }
        if (!canNotify(context)) {
            Log.i(TAG, "notification skipped: not granted")
            return false
        }
        if (!markSeen(context, deliveryKey)) return false

        ensureChannel(context)
        val manager = NotificationManagerCompat.from(context)
        val id = deliveryKey.hashCode()
        val text = truncate(body)

        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle(peer)
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setGroup(GROUP)
            .setAutoCancel(true)
            .setContentIntent(threadIntent(context, peer))
            .build()

        try {
            manager.notify(NOTIFICATION_TAG, id, notification)
        } catch (error: SecurityException) {
            Log.e(TAG, "notification refused: SecurityException")
            return false
        } catch (error: Throwable) {
            Log.e(TAG, "notification failed: ${error.javaClass.simpleName}")
            return false
        }

        postSummaryIfNeeded(context, manager)
        return true
    }

    /**
     * The default-SMS role requires a `WAP_PUSH_DELIVER` receiver, but this
     * build does not download MMS (docs/WAVE2_NATIVE_SMS.md §5). A picture
     * arriving as an MMS would otherwise disappear silently, so the receiver
     * says so once, at low priority, instead of pretending nothing happened.
     */
    fun notifyUnsupportedMms(context: Context) {
        if (!canNotify(context)) {
            Log.i(TAG, "MMS notification skipped: not granted")
            return
        }
        ensureChannel(context)

        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle("MMS")
            .setContentText("MMS is not supported by this build")
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .setContentIntent(threadsIntent(context))
            .build()

        try {
            NotificationManagerCompat.from(context)
                .notify("dakflare-mms", MMS_ID, notification)
        } catch (error: SecurityException) {
            Log.e(TAG, "MMS notification refused: SecurityException")
        } catch (error: Throwable) {
            Log.e(TAG, "MMS notification failed: ${error.javaClass.simpleName}")
        }
    }

    /** Group summary, posted once more than one message notification is alive. */
    private fun postSummaryIfNeeded(context: Context, manager: NotificationManagerCompat) {
        val count = try {
            manager.activeNotifications.count {
                it.tag == NOTIFICATION_TAG && it.id != SUMMARY_ID
            }
        } catch (_: Throwable) {
            return
        }
        if (count <= 1) return

        val summary = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle("DakFlare")
            .setContentText("$count new messages")
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setGroup(GROUP)
            .setGroupSummary(true)
            .setAutoCancel(true)
            .setContentIntent(threadsIntent(context))
            .build()

        try {
            manager.notify(NOTIFICATION_TAG, SUMMARY_ID, summary)
        } catch (error: Throwable) {
            Log.e(TAG, "notification summary failed: ${error.javaClass.simpleName}")
        }
    }

    /** The same `sms:<peer>` link `MainActivity.offerSmsRoute` already understands. */
    private fun threadIntent(context: Context, peer: String): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            data = Uri.fromParts("sms", peer, null)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        return PendingIntent.getActivity(
            context,
            peer.hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    /** A summary has no single thread, so it opens Threads (a plain launch). */
    private fun threadsIntent(context: Context): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        return PendingIntent.getActivity(
            context,
            SUMMARY_ID,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun canNotify(context: Context): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            return false
        }
        return try {
            NotificationManagerCompat.from(context).areNotificationsEnabled()
        } catch (_: Throwable) {
            false
        }
    }

    /**
     * Announce a delivery once. The set is bounded: dropping old keys can at
     * worst repeat an old notification, never lose a new message.
     */
    private fun markSeen(context: Context, key: String): Boolean {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val seen = prefs.getStringSet(KEY_SEEN, emptySet())?.toMutableSet()
            ?: mutableSetOf()
        if (!seen.add(key)) return false
        if (seen.size > MAX_SEEN) {
            seen.clear()
            seen.add(key)
        }
        prefs.edit().putStringSet(KEY_SEEN, seen).apply()
        return true
    }

    /** Notification text is one truncated line; the body is never logged. */
    private fun truncate(body: String): String {
        val line = body.replace('\n', ' ').trim()
        return if (line.length <= MAX_TEXT) line else line.take(MAX_TEXT - 1) + "…"
    }
}

/**
 * Whether the Activity is in front and showing a particular thread.
 *
 * `MainActivity` sets `foreground` from its lifecycle and `thread` from the
 * `sms:`/`smsto:` route it was opened with. An in-app navigation back to
 * Threads is not reported to the shell, so the suppression is deliberately
 * narrow: it only covers the thread the Activity was last routed to.
 */
object AppVisibility {
    @Volatile
    var foreground: Boolean = false

    @Volatile
    var thread: String? = null

    fun isShowing(peer: String): Boolean {
        if (!foreground) return false
        val current = thread ?: return false
        return normalize(current) == normalize(peer)
    }

    private fun normalize(value: String): String {
        val digits = value.filter { it.isDigit() }
        return if (digits.isNotEmpty()) digits else value.trim().lowercase()
    }
}
