package dev.dakflare.simulator.bridge

import android.app.Activity
import android.util.Log
import app.tauri.annotation.Command
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

/**
 * The Kotlin end of the `send_sms` Tauri command.
 *
 * Registered from Rust with `PluginApi::register_android_plugin` and driven by
 * `run_mobile_plugin_async`; this is the project's first Rust→Kotlin call in the
 * other direction. It only validates arguments and hands the work to
 * [SmsSender] on a worker thread, because the store write and the radio call
 * must not block the Android main thread. The reply is the queued row's id or a
 * worded refusal from [SmsSender.Refused] — never a recipient or a body.
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

    /** The shape `send_sms` sends: camelCase over the Tauri IPC. */
    private class SendArgs {
        var deviceId: String = ""
        var to: String = ""
        var body: String = ""
        var simSlot: Int = 0
    }

    private companion object {
        const val TAG = "DakFlareSms"
    }
}
