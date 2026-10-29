package dev.dakflare.simulator.bridge

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony
import android.util.Log

/**
 * Exists only because Android will not offer the default-SMS role to an app
 * without a `WAP_PUSH_DELIVER` receiver. MMS is explicitly out of scope for this
 * milestone (docs/WAVE2_NATIVE_SMS.md §5), so the push is consumed and dropped:
 * no database, no network, no reply, and no path that can throw.
 */
class MmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.WAP_PUSH_DELIVER_ACTION) return
        // Deliberately no payload handling. A log line is all this receiver does.
        Log.i(TAG, "MMS push ignored (out of scope)")
    }

    private companion object {
        const val TAG = "DakFlareSms"
    }
}
