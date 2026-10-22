package dev.dakflare.simulator

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.util.Log
import android.view.View
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/**
 * Edge-to-edge is compulsory from Android 15 for apps targeting SDK 35+, and
 * `Theme.simulator` keeps the default transparent status bar that [enableEdgeToEdge]
 * sets up. The WebView alone does not know about system bar insets, so without
 * this the page's wordmark draws underneath the status bar clock and carrier
 * text (the collision in the captured screenshot).
 *
 * The fix belongs here rather than in the page CSS: `env(safe-area-inset-top)`
 * is not reliably exposed inside Android WebView, and a hard-coded margin would
 * be wrong on cutouts, landscape and tablets. Insetting the activity's content
 * view by the real system-bar/cutout insets keeps the WebView below the status
 * bar while leaving the bars themselves transparent.
 */
class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      insets
    }
    // The content view may already be attached, so ask for an explicit dispatch.
    ViewCompat.requestApplyInsets(content)

    // M5.1: a bare runtime prompt so the receiver can persist real SMS. The
    // explanatory screen (and the SEND_SMS pair) belongs to M5.4; this request
    // is asynchronous and never blocks the webview.
    if (checkSelfPermission(Manifest.permission.RECEIVE_SMS) != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(arrayOf(Manifest.permission.RECEIVE_SMS)) { granted ->
        if (granted != true) {
          Log.w("DakFlareSms", "RECEIVE_SMS not granted; inbound SMS stays disabled")
        }
      }
    }
  }
}
