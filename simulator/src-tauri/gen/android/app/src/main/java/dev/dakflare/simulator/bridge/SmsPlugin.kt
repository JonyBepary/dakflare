package dev.dakflare.simulator.bridge

import android.app.Activity
import android.app.role.RoleManager
import android.content.Intent
import android.os.Build
import android.provider.Telephony
import android.util.Log
import app.tauri.annotation.Command
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

/**
 * The Kotlin end of the SMS Tauri commands: `send_sms`, the default-role
 * request, and the pending sms:/smsto: route.
 *
 * Registered from Rust with `PluginApi::register_android_plugin` and driven by
 * `run_mobile_plugin_async`. [send] validates arguments and hands the work to
 * [SmsSender] on a worker thread, because the store write and the radio call
 * must not block the Android main thread.
 *
 * Tauri constructs this plugin with the current Activity
 * (`(Landroid/app/Activity;)V`), so `host` is already the right Activity for
 * `startActivityForResult`; a static weak reference in `MainActivity` would be
 * a second source of truth that can go stale across recreation.
 */
class SmsPlugin(private val host: Activity) : Plugin(host) {
    @Command
    fun send(invoke: Invoke) {
        val args = try {
            invoke.parseArgs(SendArgs::class.java)
        } catch (error: Throwable) {
            Log.e(TAG, "send args rejected: ${error.javaClass.simpleName}")
            invoke.reject("The message could not be read")
            return
        }

        val appDir = host.applicationInfo.dataDir
        val context = host.applicationContext

        Thread(
            {
                try {
                    val localId = SmsSender.send(
                        context = context,
                        appDir = appDir,
                        deviceId = args.deviceId,
                        to = args.to,
                        body = args.body,
                        simSlot = args.simSlot,
                    )
                    invoke.resolveObject(mapOf("local_id" to localId))
                } catch (refused: SmsSender.Refused) {
                    invoke.reject(refused.message)
                } catch (error: Throwable) {
                    // Class name only: an exception message could carry a body.
                    Log.e(TAG, "send failed: ${error.javaClass.simpleName}")
                    invoke.reject("The phone could not send the message")
                }
            },
            "dakflare-send",
        ).start()
    }

    /**
     * Open Android's default-SMS role dialog. This only *asks*: the reply means
     * the dialog was launched, never that the role was granted. The fact is
     * written by `MainActivity.onResume` and read back by `get_device_facts`.
     *
     * API 29+ uses `RoleManager`; below that the platform's
     * `ACTION_CHANGE_DEFAULT` dialog takes the package extra. minSdk is 24, so
     * both paths must exist.
     */
    @Command
    fun requestDefaultSmsRole(invoke: Invoke) {
        try {
            val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val roles = host.getSystemService(RoleManager::class.java)
                when {
                    roles == null -> {
                        invoke.reject("This phone cannot manage the SMS role")
                        return
                    }
                    !roles.isRoleAvailable(RoleManager.ROLE_SMS) -> {
                        invoke.reject("This phone does not offer the SMS role")
                        return
                    }
                    roles.isRoleHeld(RoleManager.ROLE_SMS) -> {
                        // Already ours: nothing to ask, and no false claim.
                        invoke.resolve()
                        return
                    }
                    else -> roles.createRequestRoleIntent(RoleManager.ROLE_SMS)
                }
            } else {
                Intent(Telephony.Sms.Intents.ACTION_CHANGE_DEFAULT).putExtra(
                    Telephony.Sms.Intents.EXTRA_PACKAGE_NAME,
                    host.packageName,
                )
            }

            // The result is intentionally not read: the role is confirmed by
            // the shell's report on resume, which is the only source of truth
            // the UI trusts.
            @Suppress("DEPRECATION")
            host.startActivityForResult(intent, REQUEST_DEFAULT_SMS)
            invoke.resolve()
        } catch (error: Throwable) {
            Log.e(TAG, "role request failed: ${error.javaClass.simpleName}")
            invoke.reject("The system role dialog could not be opened")
        }
    }

    /** Hand the one pending sms:/smsto: route to the webview, then forget it. */
    @Command
    fun takeSmsRoute(invoke: Invoke) {
        invoke.resolveObject(mapOf("route" to SmsRoute.take()))
    }

    /** The shape `send_sms` sends: camelCase over the Tauri IPC. */
    private class SendArgs {
        var deviceId: String = ""
        var to: String = ""
        var body: String = ""
        var simSlot: Int = 0
    }

    private companion object {
        const val TAG = "DakFlareSms"
        const val REQUEST_DEFAULT_SMS = 0x5D5
    }
}
