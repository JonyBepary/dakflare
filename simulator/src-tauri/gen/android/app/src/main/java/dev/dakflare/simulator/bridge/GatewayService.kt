package dev.dakflare.simulator.bridge

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.text.format.DateFormat
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import dev.dakflare.simulator.MainActivity
import java.util.Date

/**
 * The long-lived half of the gateway: one `remoteMessaging` foreground service
 * that drains what the deployment has not accepted yet.
 *
 * It owns three jobs. The loop blocks in [NativeBridge.awaitCommandSafely], which
 * parks the thread on the device socket until a command arrives; each command is
 * handed to the radio through [SmsSender.resend]. The HTTP drain runs behind it
 * every [DRAIN_EVERY_MS] as a backstop, because a socket can die without telling
 * anyone and the poll is the only other delivery path. It then asks
 * [SmsSender.retryQueued] to re-send queued rows whose earlier attempt failed for
 * a transient radio reason, calls [NativeBridge.flushPendingSafely] so inbound
 * rows stored while offline, their flow runs and replies already marked `sent`
 * reach the deployment, and every [FLOWS_EVERY_MS] calls
 * [NativeBridge.syncFlowsSafely] so a Worker-side flow edit reaches a phone the
 * operator never opens. The receive path stays in [SmsReceiver] and needs no
 * service.
 *
 * Started from [MainActivity] when the app opens with a paired identity, from
 * [SmsReceiver] after a successful inbound store, and from [BootReceiver] after
 * a reboot. Every start is best effort: a platform restriction (Android 12+
 * background start limit, OEM autostart, battery saver) must leave the receive
 * path working, so callers never see an exception from [start].
 *
 * Stop conditions: `stopService` from the UI ([sync] when the app is open
 * without an identity), [onDestroy] from the system, or the loop itself when
 * the identity is gone. The Tauri `delete_device` / `revoke_device` commands
 * live in Rust and have no Kotlin call site, so the immediate stop is
 * [MainActivity.onResume]; the loop's identity recheck is the backstop within
 * one interval.
 */
class GatewayService : Service() {
    @Volatile
    private var running = false

    /** Whether the device socket is connected. Drives the notification only. */
    @Volatile
    private var socketLive = false

    private var worker: Thread? = null
    private val sleeper = Object()

    override fun onCreate() {
        super.onCreate()

        val appDir = applicationInfo.dataDir
        val deviceId = NativeBridge.identitySafely(appDir)
        if (deviceId == null) {
            // Started by a stale caller. Say the truth once and go away: a
            // foreground service that claims to receive without an identity
            // would be a lie.
            startForegroundCompat(notification(deviceId = null, lastContactMs = 0L))
            Log.i(TAG, "gateway stopped: not paired")
            stopSelf()
            return
        }

        startForegroundCompat(notification(deviceId, lastContact()))
        startLoop(appDir, deviceId)
        Log.i(TAG, "gateway started await_ms=$AWAIT_MS drain_every_ms=$DRAIN_EVERY_MS")
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // Reopening the app calls `start` while the loop may be parked on the
        // socket. Wake it so the flush and flow sync run now rather than after
        // the wait ends. A wait already in progress cannot be interrupted, so
        // this shortens the gap rather than closing it.
        synchronized(sleeper) { sleeper.notifyAll() }
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        synchronized(sleeper) { sleeper.notifyAll() }
        worker?.interrupt()
        worker = null
        Log.i(TAG, "gateway stopped")
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    /**
     * One thread, one loop. The first pass runs immediately: the socket connects,
     * the backstop drain fires, and the flush runs, so a service that has just
     * been started is useful without waiting.
     */
    private fun startLoop(appDir: String, initialDeviceId: String) {
        if (running) return
        running = true

        val thread = Thread(
            {
                var deviceId = initialDeviceId
                var lastDrainMs = 0L
                var lastFlowsMs = 0L
                while (running) {
                    // Re-read the identity every tick. `delete_device` and
                    // `revoke_device` run in Rust, so this is the backstop that
                    // stops the service without a Kotlin call site.
                    val current = NativeBridge.identitySafely(appDir)
                    if (current == null) {
                        Log.i(TAG, "gateway identity gone; stopping")
                        updateNotification(deviceId = null, lastContactMs = 0L)
                        running = false
                        stopSelf()
                        return@Thread
                    }
                    deviceId = current

                    // The socket is the delivery path: this parks the thread
                    // until a command arrives or the wait ends. A command is
                    // recorded by the time it returns; the radio, and then the
                    // acknowledgement, are what is left.
                    val awaited = NativeBridge.awaitCommandSafely(appDir, deviceId, AWAIT_MS)
                    socketLive = awaited.live
                    var handed = 0
                    for (localId in awaited.captured) {
                        if (SmsSender.resend(this, appDir, deviceId, localId)) handed += 1
                    }
                    if (awaited.captured.isNotEmpty()) saveLastContact(System.currentTimeMillis())

                    // The backstop. A socket can be silently dead, and this is
                    // the only other way a command reaches the phone, so it runs
                    // behind the socket rather than instead of it.
                    val now = System.currentTimeMillis()
                    var drained = 0
                    if (now - lastDrainMs >= DRAIN_EVERY_MS) {
                        val captured = NativeBridge.drainOutboxSafely(appDir, deviceId)
                        for (localId in captured) {
                            if (SmsSender.resend(this, appDir, deviceId, localId)) handed += 1
                        }
                        if (captured.isNotEmpty()) saveLastContact(now)
                        drained = captured.size
                        lastDrainMs = now
                    }

                    // M5.5: give queued rows whose radio failure was transient
                    // another chance. The store only offers rows older than
                    // 60 s with attempts left, so a row this pass just captured
                    // cannot be retried in the same pass. Each retry is
                    // finished by its own SENT/DELIVERED receipt.
                    val retried = SmsSender.retryQueued(this, appDir, deviceId)

                    // Every pass, because a send result is only visible to the
                    // deployment once it is uploaded. An idle flush returns
                    // before touching the network, so this costs a local query.
                    val ok = NativeBridge.flushPendingSafely(appDir, deviceId)
                    if (ok) saveLastContact(System.currentTimeMillis())

                    // The flow set is the expensive fetch and changes rarely.
                    // Three outcomes, not two: a boolean defaulting to false made
                    // every pass that skipped the fetch read as a failure, and
                    // "flows ok=false" was reported as a regression because of it.
                    var flows = "skipped"
                    if (now - lastFlowsMs >= FLOWS_EVERY_MS) {
                        flows = if (NativeBridge.syncFlowsSafely(appDir, deviceId)) "ok" else "refused"
                        lastFlowsMs = now
                    }

                    updateNotification(deviceId, lastContact())
                    Log.i(
                        TAG,
                        "gateway socket=${if (awaited.live) "live" else "down"} " +
                            "captured=${awaited.captured.size} drained=$drained handed=$handed " +
                            "retried=$retried flush ok=$ok flows=$flows",
                    )

                    synchronized(sleeper) {
                        if (!running) return@Thread
                        try {
                            sleeper.wait(POST_TICK_MS)
                        } catch (_: InterruptedException) {
                            return@Thread
                        }
                    }
                }
            },
            "dakflare-gateway",
        )
        worker = thread
        thread.start()
    }

    private fun updateNotification(deviceId: String?, lastContactMs: Long) {
        try {
            NotificationManagerCompat.from(this)
                .notify(NOTIFICATION_ID, notification(deviceId, lastContactMs))
        } catch (error: SecurityException) {
            // Notifications were turned off after the service started. The
            // foreground entry still exists in the task manager; the flush is
            // unaffected.
            Log.w(TAG, "gateway notification refused: SecurityException")
        } catch (error: Throwable) {
            Log.w(TAG, "gateway notification failed: ${error.javaClass.simpleName}")
        }
    }

    /**
     * The honest text. No "gateway running" claim without an identity, and the
     * only changing value is the time of the last successful flush.
     */
    private fun notification(deviceId: String?, lastContactMs: Long): Notification {
        // "live" is only said when a socket is connected right now. The rest of
        // the time the phone is on the five-minute poll, and saying so is the
        // honest version of a gateway sitting in a drawer.
        val text = when {
            deviceId == null -> "Not paired"
            socketLive && lastContactMs <= 0L -> "$ONGOING · live"
            socketLive -> "$ONGOING · live · last contact ${time(lastContactMs)}"
            lastContactMs <= 0L -> "$ONGOING · polling only · no contact yet"
            else -> "$ONGOING · polling only · last contact ${time(lastContactMs)}"
        }

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("DakFlare gateway")
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setShowWhen(lastContactMs > 0L)
            .setWhen(lastContactMs)
            .setContentIntent(openIntent())
            .build()
    }

    private fun startForegroundCompat(notification: Notification) {
        // `remoteMessaging` exists from Android 14. Below that the type is
        // neither declared by the platform nor required, so pass none rather
        // than an unknown bit.
        val type = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING
        } else {
            0
        }
        ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, type)
    }

    private fun openIntent(): PendingIntent {
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        return PendingIntent.getActivity(
            this,
            NOTIFICATION_ID,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private fun time(ms: Long): String =
        DateFormat.getTimeFormat(this).format(Date(ms))

    private fun lastContact(): Long =
        getSharedPreferences(PREFS, MODE_PRIVATE).getLong(KEY_LAST_CONTACT, 0L)

    private fun saveLastContact(ms: Long) {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit()
            .putLong(KEY_LAST_CONTACT, ms)
            .apply()
    }

    companion object {
        const val CHANNEL_ID = "dakflare_gateway"

        private const val TAG = "DakFlareSms"
        private const val NOTIFICATION_ID = 0x0DAF3
        private const val PREFS = "dakflare_gateway"
        private const val KEY_LAST_CONTACT = "last_contact_ms"
        private const val ONGOING = "Receiving SMS for the gateway"
        /**
         * How long one wait parks the gateway thread on the device socket. A
         * command wakes it immediately; this is only the idle ceiling, and it
         * bounds how long a stop request can take to be noticed.
         */
        private const val AWAIT_MS = 30_000L
        /** Floor between passes, so a burst of commands cannot spin the loop. */
        private const val POST_TICK_MS = 2_000L
        /**
         * The HTTP drain, behind the socket. Five minutes because the socket is
         * the fast path: this exists for a socket that died without telling
         * anyone, not for ordinary delivery.
         */
        private const val DRAIN_EVERY_MS = 5L * 60L * 1000L
        /** The flow fetch is the expensive one and changes rarely. */
        private const val FLOWS_EVERY_MS = 15L * 60L * 1000L

        /** Create the channel once, low importance and silent like `dakflare_messages`. */
        fun ensureChannel(context: Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            val manager = context.getSystemService(NotificationManager::class.java) ?: return
            if (manager.getNotificationChannel(CHANNEL_ID) != null) return

            val channel = NotificationChannel(
                CHANNEL_ID,
                "Gateway",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "Keeps pending messages flowing to the deployment"
                setSound(null, null)
                enableVibration(false)
                setShowBadge(false)
            }
            manager.createNotificationChannel(channel)
        }

        /**
         * Start the service, or ask an already running instance to continue.
         *
         * Never throws: Android 12+ refuses a background start from a broadcast
         * receiver, and an OEM may refuse it outright. Only the exception class
         * is logged; the receive path must survive both.
         */
        fun start(context: Context) {
            ensureChannel(context)
            val intent = Intent(context, GatewayService::class.java)
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    context.startForegroundService(intent)
                } else {
                    context.startService(intent)
                }
            } catch (error: Throwable) {
                Log.w(TAG, "gateway not started: ${error.javaClass.simpleName}")
            }
        }

        /** Start only when a paired identity exists; used from a cold boot. */
        fun startIfPaired(context: Context) {
            if (NativeBridge.identitySafely(context.applicationInfo.dataDir) == null) return
            start(context)
        }

        /**
         * The UI's view of the service: start it while an identity exists, stop
         * it once the identity was deleted or revoked. Called from
         * [MainActivity.onCreate] and [MainActivity.onResume].
         */
        fun sync(context: Context) {
            if (NativeBridge.identitySafely(context.applicationInfo.dataDir) == null) {
                stop(context)
            } else {
                start(context)
            }
        }

        /** Ask a running instance to stop; [onDestroy] cancels the loop thread. */
        fun stop(context: Context) {
            try {
                context.stopService(Intent(context, GatewayService::class.java))
            } catch (error: Throwable) {
                Log.w(TAG, "gateway stop failed: ${error.javaClass.simpleName}")
            }
        }
    }
}
