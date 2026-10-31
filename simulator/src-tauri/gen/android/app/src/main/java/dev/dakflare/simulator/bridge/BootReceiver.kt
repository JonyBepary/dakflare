package dev.dakflare.simulator.bridge

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Brings the gateway back after a reboot, but only for a phone that is paired.
 *
 * `BOOT_COMPLETED` is delivered after the user unlocked the device, so the
 * credential-encrypted libSQL store is readable here. Android 15 restricts
 * several foreground-service types at boot; `remoteMessaging` is one of the
 * types still allowed, which is why [GatewayService] declares it.
 *
 * A phone with no identity does nothing at all: no service, no notification.
 * The receiver is exported=false because only the system sends this protected
 * broadcast.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return

        val appDir = context.applicationInfo.dataDir
        if (NativeBridge.identitySafely(appDir) == null) {
            Log.i(TAG, "boot: no identity; gateway stays off")
            return
        }

        GatewayService.start(context)
        Log.i(TAG, "boot: gateway start requested")
    }

    private companion object {
        const val TAG = "DakFlareSms"
    }
}
