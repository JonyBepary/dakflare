package dev.dakflare.simulator

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Telephony
import android.telephony.SubscriptionManager
import android.telephony.TelephonyManager
import android.util.Log
import android.view.View
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import dev.dakflare.simulator.bridge.NativeBridge
import org.json.JSONObject

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

    // M5.2: the gateway needs both halves of the SMS role. Requesting them
    // together avoids a second dialog: RECEIVE_SMS lets the manifest receiver
    // run with the app closed, SEND_SMS lets it answer a flow. The explanatory
    // screen belongs to M5.4. This request is asynchronous and never blocks the
    // webview.
    val smsPermissions = arrayOf(
      Manifest.permission.RECEIVE_SMS,
      Manifest.permission.SEND_SMS,
    )
    val missing = smsPermissions.filter {
      checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED
    }
    if (missing.isNotEmpty()) {
      requestPermissions(missing.toTypedArray()) { allGranted ->
        if (allGranted != true) {
          Log.w("DakFlareSms", "SMS permissions not granted; gateway stays disabled")
        }
        // The callback is the point where the permission flow has settled, so
        // the phone reports its facts exactly once.
        writeDeviceFacts()
      }
    } else {
      writeDeviceFacts()
    }
  }

  /**
   * Report the handset facts the Device frame cannot get from the webview.
   *
   * Writes go straight to the same local store through [NativeBridge]; the
   * Tauri command `get_device_facts` reads them back. Every permission-gated
   * read is wrapped: a `SecurityException` leaves the fact unwritten, which the
   * UI renders as "not reported" rather than a guessed value. No number, key or
   * value is logged, only how many writes the store accepted.
   */
  private fun writeDeviceFacts() {
    val appDir = applicationInfo.dataDir
    val subscriptions = getSystemService(SubscriptionManager::class.java)
    val telephony = getSystemService(TelephonyManager::class.java)
    val defaultSubId = SubscriptionManager.getDefaultSubscriptionId()
    var written = 0

    fun write(key: String, value: String?) {
      if (value.isNullOrEmpty()) return
      if (NativeBridge.setDeviceFactSafely(appDir, key, value)) written += 1
    }

    // SubscriptionManager on API 33+, then the framework line as the fallback.
    var selfNumber: String? = null
    if (Build.VERSION.SDK_INT >= 33 &&
      subscriptions != null &&
      defaultSubId != SubscriptionManager.INVALID_SUBSCRIPTION_ID
    ) {
      try {
        selfNumber = subscriptions.getPhoneNumber(defaultSubId)
      } catch (_: SecurityException) {
        // No phone-number permission: fall through to line1Number.
      }
    }
    if (selfNumber.isNullOrEmpty()) {
      try {
        selfNumber = telephony?.line1Number
      } catch (_: SecurityException) {
      }
    }
    write("self_number", selfNumber)

    if (subscriptions != null) {
      try {
        val infos = subscriptions.activeSubscriptionInfoList ?: emptyList()
        val info = infos.firstOrNull { it.subscriptionId == defaultSubId }
          ?: infos.firstOrNull()
        if (info != null) {
          // SubscriptionInfo reports a 0-based slot index; every other surface
          // in this product calls the second tray "SIM 2", so write it 1-based.
          write("sim_slot", (info.simSlotIndex + 1).toString())
          write("sim_carrier", info.carrierName?.toString())
        }
      } catch (_: SecurityException) {
        // Reading the list needs a phone permission; write nothing instead of
        // reporting a slot the phone did not confirm.
      }
    }

    val permissions = JSONObject()
      .put("sms", isGranted(Manifest.permission.RECEIVE_SMS))
      .put("send", isGranted(Manifest.permission.SEND_SMS))
      .put("phone_numbers", isGranted(Manifest.permission.READ_PHONE_NUMBERS))
    write("permissions", permissions.toString())

    try {
      val power = getSystemService(PowerManager::class.java)
      if (power != null) {
        write(
          "battery_optimized",
          power.isIgnoringBatteryOptimizations(packageName).toString(),
        )
      }
    } catch (_: SecurityException) {
    }

    try {
      // `null` is a real answer here — no app holds the default-SMS role on this
      // handset — so it is recorded rather than skipped, and the Device frame can
      // say "none" instead of "not reported".
      write("default_sms_app", Telephony.Sms.getDefaultSmsPackage(this) ?: "none")
    } catch (_: SecurityException) {
    }

    Log.i("DakFlareSms", "device facts written=$written")
  }

  private fun isGranted(permission: String): Boolean =
    checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED
}
