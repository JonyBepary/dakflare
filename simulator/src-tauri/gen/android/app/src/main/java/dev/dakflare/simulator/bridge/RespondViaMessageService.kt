package dev.dakflare.simulator.bridge

import android.app.Service
import android.content.Intent
import android.os.IBinder
import android.util.Log

/**
 * Exists only for default-SMS eligibility: Android's SMS role also requires a
 * service handling `RESPOND_VIA_MESSAGE` for `smsto:`, protected by
 * `SEND_RESPOND_VIA_MESSAGE` (the quick-reply action the dialer offers during a
 * call). This gateway has no compose surface, so the service stops itself
 * without reading or sending anything and cannot crash.
 */
class RespondViaMessageService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Log.i(TAG, "respond-via-message ignored (no compose surface)")
        stopSelf(startId)
        return START_NOT_STICKY
    }

    private companion object {
        const val TAG = "DakFlareSms"
    }
}
