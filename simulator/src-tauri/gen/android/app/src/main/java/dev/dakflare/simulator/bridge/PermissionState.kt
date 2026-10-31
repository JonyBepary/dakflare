package dev.dakflare.simulator.bridge

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.PowerManager
import android.provider.Telephony
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject

/**
 * What the app needs before it can be a gateway, as one object.
 *
 * Read-only on purpose: this reports state and never requests anything. The gate
 * screen decides what to ask for and in which order, so the same values can be
 * shown, logged and asserted without the reader having a side effect.
 *
 * The gateway service is deliberately NOT gated on any of this. Answering an
 * inbound SMS is the app's job, and a missing permission makes it slower or
 * invisible, not wrong — a dozing phone must not go silent because the UI is
 * unhappy.
 */
object PermissionState {
    const val BATTERY = "battery_exempt"
    const val SMS_ROLE = "sms_role"
    const val SEND_SMS = "send_sms"
    const val NOTIFICATIONS = "notifications"

    /** `{"battery_exempt":bool,"sms_role":bool,"send_sms":bool,"notifications":bool}`. */
    @JvmStatic
    fun read(context: Context): String {
        val json = JSONObject()
        json.put(BATTERY, isBatteryExempt(context))
        json.put(SMS_ROLE, holdsSmsRole(context))
        json.put(
            SEND_SMS,
            ContextCompat.checkSelfPermission(context, Manifest.permission.SEND_SMS) ==
                PackageManager.PERMISSION_GRANTED,
        )
        json.put(NOTIFICATIONS, notificationsEnabled(context))
        return json.toString()
    }

    /**
     * Doze defers a foreground service for hours, and that is the measured cause
     * of a send taking between 3.5 seconds and several minutes.
     */
    @JvmStatic
    fun isBatteryExempt(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true
        val power = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return false
        return power.isIgnoringBatteryOptimizations(context.packageName)
    }

    /** Before Android 10 the holder is whatever the telecom stack says it is. */
    @Suppress("DEPRECATION")
    @JvmStatic
    fun holdsSmsRole(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            return context.packageName == Telephony.Sms.getDefaultSmsPackage(context)
        }
        val roles = context.getSystemService(Context.ROLE_SERVICE) as? android.app.role.RoleManager
            ?: return false
        return roles.isRoleHeld(android.app.role.RoleManager.ROLE_SMS)
    }

    /**
     * Both halves matter: the permission can be granted while the operator has
     * switched the app's notifications off, and then the `live` / `polling only`
     * line never appears.
     */
    @JvmStatic
    fun notificationsEnabled(context: Context): Boolean {
        val enabled = NotificationManagerCompat.from(context).areNotificationsEnabled()
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return enabled
        return enabled && ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.POST_NOTIFICATIONS,
        ) == PackageManager.PERMISSION_GRANTED
    }
}
