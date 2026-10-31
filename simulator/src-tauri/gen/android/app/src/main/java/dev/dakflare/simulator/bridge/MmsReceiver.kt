package dev.dakflare.simulator.bridge

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import android.util.Log

/**
 * Exists because Android will not offer the default-SMS role to an app without
 * a `WAP_PUSH_DELIVER` receiver. MMS is explicitly out of scope for this
 * milestone (docs/WAVE2_NATIVE_SMS.md §5), so the push is not downloaded and no
 * database, network or reply path runs here.
 *
 * It is not dropped silently, though: a default SMS app that swallowed an MMS
 * would leave a lost picture invisible, so one low-priority notification says
 * that this build cannot open it. That is the whole MMS decision for now.
 */
class MmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.WAP_PUSH_DELIVER_ACTION) return
        // Deliberately no payload handling. The notification is the only effect.
        SmsNotifier.notifyUnsupportedMms(context)
        Log.i(TAG, "MMS push ignored (out of scope); user notified")
    }

    private companion object {
        const val TAG = "DakFlareSms"
    }
}
