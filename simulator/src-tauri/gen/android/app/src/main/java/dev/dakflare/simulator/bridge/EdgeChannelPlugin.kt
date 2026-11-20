package dev.dakflare.simulator.bridge

import android.app.Activity
import android.util.Log
import app.tauri.annotation.Command
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin
import org.json.JSONObject

/**
 * The Kotlin end of the personal-channel reply command.
 *
 * [MessagingNotificationBridge] keeps the live `RemoteInput` handles in a
 * process-wide map; this plugin is only the Tauri door to
 * [MessagingNotificationBridge.sendReply]. It is a separate plugin from
 * `SmsPlugin` because a personal reply never touches the radio, and separate
 * from `PermissionPlugin` because replying is an effect, not a grant.
 *
 * Arguments and bodies are never logged. A refusal names the class only, so a
 * log line can never carry the message text or the peer.
 */
class EdgeChannelPlugin(private val host: Activity) : Plugin(host) {
    @Command
    fun sendPersonalReply(invoke: Invoke) {
        val args = try {
            invoke.parseArgs(PersonalReplyArgs::class.java)
        } catch (error: Throwable) {
            Log.e(TAG, "sendPersonalReply args rejected: ${error.javaClass.simpleName}")
            invoke.reject("The reply could not be read")
            return
        }

        try {
            val sent = MessagingNotificationBridge.sendReply(
                args.channel,
                args.peerKey,
                args.text,
            )
            invoke.resolveObject(JSONObject().put("sent", sent))
        } catch (error: Throwable) {
            // Class name only: an exception message may carry the text.
            Log.e(TAG, "sendPersonalReply failed: ${error.javaClass.simpleName}")
            invoke.reject("The reply could not be sent")
        }
    }

    /** The shape `send_personal_reply` sends: camelCase over the Tauri IPC. */
    private class PersonalReplyArgs {
        var channel: String = ""
        var peerKey: String = ""
        var text: String = ""
    }

    private companion object {
        const val TAG = "DakFlareEdge"
    }
}
