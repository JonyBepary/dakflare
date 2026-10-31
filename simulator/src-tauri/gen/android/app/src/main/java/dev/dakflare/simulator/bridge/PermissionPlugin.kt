package dev.dakflare.simulator.bridge

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Log
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import org.json.JSONObject

/**
 * The Kotlin end of the permission gate: read the four checks, and open the one
 * system surface that can fix each of them.
 *
 * [PermissionState] stays the reader, so the same values can be shown, logged and
 * asserted without a side effect. This class only adds the asking.
 *
 * Nothing here stops the gateway service. A missing permission makes a reply
 * slower or a status line invisible; it never makes answering an inbound SMS
 * wrong, so the service is deliberately not gated on any of it.
 *
 * Every command resolves as soon as the system surface has been *launched*,
 * never when it has been granted: the answer is read back from
 * [PermissionState] on the next resume, which is the only source of truth the
 * UI trusts.
 */
class PermissionPlugin(private val host: Activity) : Plugin(host) {
    /** `{"battery_exempt":bool,"sms_role":bool,"send_sms":bool,"receive_sms":bool,"notifications":bool}`. */
    @Command
    fun state(invoke: Invoke) {
        try {
            invoke.resolveObject(JSONObject(PermissionState.read(host)))
        } catch (error: Throwable) {
            Log.e(TAG, "state failed: ${error.javaClass.simpleName}")
            invoke.reject("The phone could not report its permissions")
        }
    }

    /**
     * Open the battery-exemption dialog for this package.
     *
     * `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` is a direct dialog on phones
     * that offer it. Where it does not exist, the battery-optimisation list is
     * the honest fallback: it is where the operator would have to go anyway.
     */
    @Command
    fun requestBattery(invoke: Invoke) {
        try {
            if (PermissionState.isBatteryExempt(host)) {
                invoke.resolve()
                return
            }
            val direct = Intent(
                Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                Uri.parse("package:${host.packageName}"),
            )
            val opened = try {
                host.startActivity(direct)
                true
            } catch (_: Throwable) {
                false
            }
            if (!opened) {
                host.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
            }
            invoke.resolve()
        } catch (error: Throwable) {
            Log.e(TAG, "battery request failed: ${error.javaClass.simpleName}")
            invoke.reject("The battery setting could not be opened")
        }
    }

    /**
     * Ask for the two SMS runtime permissions together, so one dialog covers
     * both halves. A request for a permission that is already granted is a no-op
     * on Android, but the list is filtered anyway to keep the dialog honest.
     */
    @Command
    fun requestSmsPermissions(invoke: Invoke) {
        try {
            val missing = arrayOf(
                Manifest.permission.RECEIVE_SMS,
                Manifest.permission.SEND_SMS,
            ).filter { !isGranted(it) }
            if (missing.isEmpty()) {
                invoke.resolve()
                return
            }
            host.requestPermissions(missing.toTypedArray(), REQUEST_SMS)
            invoke.resolve()
        } catch (error: Throwable) {
            Log.e(TAG, "sms permission request failed: ${error.javaClass.simpleName}")
            invoke.reject("The permission dialog could not be opened")
        }
    }

    /**
     * Ask for `POST_NOTIFICATIONS` on API 33+, or open the app's notification
     * settings when the permission is granted but the operator switched the
     * app's notifications off. Both halves decide whether the `live` /
     * `polling only` line can ever appear.
     */
    @Command
    fun requestNotifications(invoke: Invoke) {
        try {
            if (PermissionState.notificationsEnabled(host)) {
                invoke.resolve()
                return
            }
            val needsPermission = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                !isGranted(Manifest.permission.POST_NOTIFICATIONS)
            if (needsPermission) {
                host.requestPermissions(
                    arrayOf(Manifest.permission.POST_NOTIFICATIONS),
                    REQUEST_NOTIFICATIONS,
                )
            } else {
                host.startActivity(
                    Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                        .putExtra(Settings.EXTRA_APP_PACKAGE, host.packageName),
                )
            }
            invoke.resolve()
        } catch (error: Throwable) {
            Log.e(TAG, "notification request failed: ${error.javaClass.simpleName}")
            invoke.reject("The notification setting could not be opened")
        }
    }

    private fun isGranted(permission: String): Boolean =
        ContextCompat.checkSelfPermission(host, permission) == PackageManager.PERMISSION_GRANTED

    private companion object {
        const val TAG = "DakFlarePermissions"
        const val REQUEST_SMS = 0x5D6
        const val REQUEST_NOTIFICATIONS = 0x5D7
    }
}
