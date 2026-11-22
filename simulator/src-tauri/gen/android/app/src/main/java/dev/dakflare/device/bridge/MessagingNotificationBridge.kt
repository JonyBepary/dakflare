package dev.dakflare.device.bridge

import android.app.Notification
import android.app.RemoteInput
import android.content.Intent
import android.os.Bundle
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log

/**
 * Zero-dependency Android edge bridge for personal messaging sessions
 * (WhatsApp, Telegram, Facebook Messenger, Instagram).
 *
 * Uses Android's official `NotificationListenerService` + `RemoteInput` reply
 * actions:
 * - no third-party protocol library and no reverse-engineered session
 * - no Meta/Telegram account-ban risk
 * - inbound rows go through the same Rust store and the same sync path as SMS
 *
 * Notification access is a user grant made in system Settings ("Notification
 * access"). The service asks for nothing else and does not enable itself: until
 * the user grants access the system never binds it.
 *
 * Logging rule, same as [SmsReceiver]: channel, counts, a masked peer and no
 * body, ever.
 */
class MessagingNotificationBridge : NotificationListenerService() {

    data class ReplyHandle(
        val packageName: String,
        val channel: String,
        val peerKey: String,
        val action: Notification.Action,
        val remoteInput: RemoteInput,
        val postedAtMs: Long,
    )

    companion object {
        private const val TAG = "DakFlareEdge"

        @Volatile
        private var appContext: android.content.Context? = null

        /**
         * The apps this bridge understands. Anything else is ignored untouched.
         */
        private val SUPPORTED_PACKAGES = mapOf(
            "com.whatsapp" to "whatsapp_personal",
            "com.whatsapp.w4b" to "whatsapp_personal",
            "org.telegram.messenger" to "telegram_personal",
            "org.thunderdog.challegram" to "telegram_personal",
            "com.facebook.orca" to "messenger_personal",
            "com.instagram.android" to "instagram_personal",
        )

        /**
         * The toggle each package belongs to. WhatsApp and WhatsApp Business are
         * separate installs and separate switches; Telegram's two clients share
         * one.
         */
        private val WATCHED_APP_KEYS = mapOf(
            "com.whatsapp" to "whatsapp",
            "com.whatsapp.w4b" to "whatsapp_business",
            "org.telegram.messenger" to "telegram",
            "org.thunderdog.challegram" to "telegram",
            "com.facebook.orca" to "messenger",
            "com.instagram.android" to "instagram",
        )

        /**
         * The one handset fact that holds the per-app toggles. It is a small
         * JSON object (`{"whatsapp":true,...}`) written by the Rust
         * `set_watched_app` command through `Store::set_device_fact`, so it lives
         * in the same SQLite `settings` table as every other handset fact and
         * the JNI fact whitelist still applies.
         */
        private const val WATCHED_APPS_FACT = "watched_apps"


        /**
         * At most 512 live reply handles. The oldest is evicted, not the whole
         * map: a chatty group should not cost the reply route to the chat the
         * user is actually in. Guarded by [replyHandles]' own lock.
         */
        private const val MAX_REPLY_HANDLES = 512

        /**
         * Keyed by `StatusBarNotification.key`, so a cancelled notification can
         * drop exactly its own handle even when several chats share a sender
         * label. Insertion order is the eviction order.
         */
        private val replyHandles = object : LinkedHashMap<String, ReplyHandle>() {
            override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, ReplyHandle>): Boolean =
                size > MAX_REPLY_HANDLES
        }

        /**
         * Dispatch a reply through the official app's notification reply action.
         *
         * Returns true only when a live handle existed and the PendingIntent
         * fired. The most recent handle for the channel/peer wins, which is the
         * conversation the user just saw.
         */
        fun sendReply(channel: String, peerKey: String, text: String): Boolean {
            if (text.isEmpty()) return false
            val context = appContext ?: return false
            val handle = synchronized(replyHandles) {
                replyHandles.values.lastOrNull { it.channel == channel && it.peerKey == peerKey }
            } ?: return false
            if (!watchesApp(context.applicationInfo.dataDir, handle.packageName)) return false

            val intent = Intent()
            val bundle = Bundle().apply {
                putCharSequence(handle.remoteInput.resultKey, text)
            }
            RemoteInput.addResultsToIntent(arrayOf(handle.remoteInput), intent, bundle)
            return try {
                handle.action.actionIntent.send(context, 0, intent)
                true
            } catch (error: Throwable) {
                // Only the class: the exception message may carry the text.
                Log.w(TAG, "reply action failed: ${error.javaClass.simpleName}")
                false
            }
        }

        /**
         * Whether the operator still wants this package's messages captured.
         *
         * The toggles are stored as one JSON fact, and the default is on for
         * every listed package: a missing fact, a missing key, a value that is
         * not a boolean, or a store that is not readable yet all read as on. An
         * install that upgrades therefore never goes silent, and only an
         * explicit `false` switches an app off. Reading is fail-open on purpose:
         * losing a message is worse than storing one the operator had muted, and
         * the fact is consulted per notification so a toggle takes effect
         * without a restart.
         */
        fun watchesApp(appDir: String, packageName: String): Boolean {
            val key = WATCHED_APP_KEYS[packageName] ?: return false
            val raw = NativeBridge.getDeviceFactSafely(appDir, WATCHED_APPS_FACT) ?: return true
            return try {
                val json = org.json.JSONObject(raw)
                if (!json.has(key)) true else json.optBoolean(key, true)
            } catch (_: Throwable) {
                // A malformed fact must not mute the channel.
                true
            }
        }


        /** True when [packageName] is one of the supported apps. */
        fun handles(packageName: String): Boolean = SUPPORTED_PACKAGES.containsKey(packageName)
    }

    override fun onListenerConnected() {
        appContext = applicationContext
    }

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        if (appContext == null) appContext = applicationContext
        // A null happens on a race during listener reconnect; nothing to read.
        if (sbn == null) return
        val channel = SUPPORTED_PACKAGES[sbn.packageName] ?: return
        // A package the operator switched off is ignored before its body is
        // touched, so a muted app costs no store write and no reply handle.
        if (!watchesApp(applicationInfo.dataDir, sbn.packageName)) return
        val notification = sbn.notification ?: return

        // Group summaries aggregate other notifications and ongoing rows are
        // progress/controls, not received messages. Reading either would store a
        // row no human sent.
        if (sbn.isOngoing) return
        if ((notification.flags and Notification.FLAG_GROUP_SUMMARY) != 0) return

        val extras = notification.extras ?: return
        val sender = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()?.trim().orEmpty()
        val body = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()?.trim().orEmpty()
        if (sender.isEmpty() || body.isEmpty()) return

        rememberReplyHandle(sbn, channel, sender, notification)

        // Deterministic id: package + notification id + post time. A re-post of
        // the same notification resolves to one row in the store.
        val localId = "notif:${sbn.packageName}:${sbn.id}:${sbn.postTime}"
        enqueueEdgeNotificationForSync(
            channel = channel,
            localId = localId,
            sender = sender,
            body = body,
            timestampMs = sbn.postTime,
        )
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification?) {
        if (sbn == null) return
        // The chat was dismissed, or the app withdrew the notification. Keeping
        // its RemoteInput would make the next reply fire into a dead
        // PendingIntent, so drop it by the identity it was stored under.
        synchronized(replyHandles) { replyHandles.remove(sbn.key) }
    }

    override fun onListenerDisconnected() {
        // The grant was revoked or the system unbound us. In-memory handles are
        // no longer reachable through a live listener; say so in one line.
        synchronized(replyHandles) { replyHandles.clear() }
        Log.i(TAG, "notification listener disconnected")
    }

    /**
     * Capture the first RemoteInput reply action the app exposes for this
     * notification. Apps that show no reply affordance have no handle, which is
     * normal; the message is still stored.
     */
    private fun rememberReplyHandle(
        sbn: StatusBarNotification,
        channel: String,
        sender: String,
        notification: Notification,
    ) {
        val actions = notification.actions ?: return
        for (action in actions) {
            val remoteInput = action.remoteInputs?.firstOrNull { it.allowFreeFormInput } ?: continue
            synchronized(replyHandles) {
                replyHandles[sbn.key] = ReplyHandle(
                    packageName = sbn.packageName,
                    channel = channel,
                    peerKey = sender,
                    action = action,
                    remoteInput = remoteInput,
                    postedAtMs = sbn.postTime,
                )
            }
            return
        }
    }

    /**
     * Persist the message where the rest of the app stores inbound traffic.
     *
     * The route is the same JNI call the SMS receiver uses
     * (`NativeBridge` -> `simulator/core` -> `Store::record_sourced_message`),
     * but the row is tagged with its channel and the SMS flush deliberately
     * never selects it. `GatewayService` drains it through
     * `NativeBridge.flushEdgePendingSafely` to the edge endpoint, which has the
     * larger budget, so the body is stored whole.
     *
     * It is deliberately the persistence-only entry, not `processIncoming`: the
     * flow engine can only answer with `SendSms`, and replying to a WhatsApp
     * message by SMS would be wrong.
     */
    private fun enqueueEdgeNotificationForSync(
        channel: String,
        localId: String,
        sender: String,
        body: String,
        timestampMs: Long,
    ) {
        // Same directory the Rust core opens: on Android `app_data_dir()` is
        // `getDataDir()`, which `applicationInfo.dataDir` reports.
        val appDir = applicationInfo.dataDir
        val stored = NativeBridge.storeEdgeInboundSafely(
            appDir = appDir,
            channel = channel,
            localId = localId,
            sender = sender,
            body = body,
            receivedAtMs = timestampMs,
        )
        if (stored) {
            Log.i(TAG, "inbound channel=$channel local_id=$localId len=${body.length}")
        } else {
            // The id names the notification, never the content. A failure means
            // the row will be lost unless the app posts it again.
            Log.w(TAG, "inbound not stored channel=$channel local_id=$localId")
        }
    }
}
