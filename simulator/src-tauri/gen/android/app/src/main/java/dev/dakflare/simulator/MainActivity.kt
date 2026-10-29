package dev.dakflare.simulator

import android.Manifest
import android.app.role.RoleManager
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
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
import dev.dakflare.simulator.bridge.AppVisibility
import dev.dakflare.simulator.bridge.NativeBridge
import dev.dakflare.simulator.bridge.SmsNotifier
import dev.dakflare.simulator.bridge.SmsRoute
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

    // A SENDTO/VIEW intent launched this Activity (cold start). Hand the route
    // to the webview; the layout takes it once after boot. A normal launcher
    // intent offers nothing, so the app opens on Threads as before.
    offerSmsRoute(intent)

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
    //
    // A default SMS app also needs POST_NOTIFICATIONS on Android 13+: inbound
    // messages are announced, and the MMS receiver says when it cannot open a
    // push. The result is recorded in the `permissions` fact.
    SmsNotifier.ensureChannel(this)
    requestRuntimePermissions()
  }

  /** SMS pair first, then the one-time notification request; both end in facts. */
  private fun requestRuntimePermissions() {
    val smsPermissions = arrayOf(
      Manifest.permission.RECEIVE_SMS,
      Manifest.permission.SEND_SMS,
    )
    val missing = smsPermissions.filter { !isGranted(it) }
    if (missing.isNotEmpty()) {
      requestPermissions(missing.toTypedArray()) { allGranted ->
        if (allGranted != true) {
          Log.w("DakFlareSms", "SMS permissions not granted; gateway stays disabled")
        }
        // The callback is the point where the permission flow has settled, so
        // the phone reports its facts exactly once.
        writeDeviceFacts()
        requestNotificationsOnce()
      }
    } else {
      writeDeviceFacts()
      requestNotificationsOnce()
    }
  }

  /**
   * Ask for POST_NOTIFICATIONS once on API 33+, and never again after the user
   * answered. `adb install -g` grants it up front, in which case there is
   * nothing to ask and the fact already reflects it.
   */
  private fun requestNotificationsOnce() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return

    val prefs = getSharedPreferences(PERMISSION_PREFS, MODE_PRIVATE)
    if (prefs.getBoolean(KEY_ASKED_NOTIFICATIONS, false)) return
    if (isGranted(Manifest.permission.POST_NOTIFICATIONS)) {
      prefs.edit().putBoolean(KEY_ASKED_NOTIFICATIONS, true).apply()
      return
    }

    requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS)) {
      prefs.edit().putBoolean(KEY_ASKED_NOTIFICATIONS, true).apply()
      // Record the answer where the Device frame reads permissions.
      writeDeviceFacts()
    }
  }

  /**
   * `singleTask` sends a new sms:/smsto: link to this instance instead of
   * creating a second Activity. Tauri still sees the intent; the webview takes
   * the route on the next focus/resume.
   */
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    offerSmsRoute(intent)
  }

  /**
   * Android's role dialog runs in another Activity, so returning from it is the
   * first moment the new holder can be read. Write that fact here, before the
   * webview reloads it: the UI never claims the role from the button tap, only
   * from this report.
   */
  override fun onResume() {
    super.onResume()
    AppVisibility.foreground = true
    writeDefaultSmsFact()
  }

  /**
   * A message for the thread in front of the user must not be announced again.
   * `AppVisibility.thread` is set from the SMS route below; leaving the Activity
   * makes every thread "not showing".
   */
  override fun onPause() {
    AppVisibility.foreground = false
    super.onPause()
  }

  /**
   * Turn a SENDTO/VIEW intent into a webview route.
   *
   * Only the four SMS/MMS schemes qualify. A `sms:`/`smsto:` number opens that
   * thread; an empty number, or an mms: link (MMS has no thread here), opens
   * Threads. Anything else offers nothing, so a normal launch is unchanged.
   */
  private fun offerSmsRoute(intent: Intent?) {
    val action = intent?.action
    if (action != Intent.ACTION_SENDTO && action != Intent.ACTION_VIEW) return
    val data = intent.data ?: return
    val scheme = data.scheme?.lowercase() ?: return
    if (scheme !in SMS_SCHEMES) return

    // `sms:+8801…?body=…` puts the number in schemeSpecificPart; `sms://+8801…`
    // adds two slashes. The query is the optional draft body, which this build
    // does not use.
    val peer = data.schemeSpecificPart
      ?.substringBefore('?')
      ?.trimStart('/')
      ?.let(Uri::decode)
      ?.trim()
      .orEmpty()

    // Only a real sms:/smsto: number names a thread this build can show. An
    // mms: link (MMS is out of scope) or an empty number opens Threads.
    val isSms = scheme == "sms" || scheme == "smsto"
    val route = if (isSms && peer.isNotEmpty()) "/messages/${Uri.encode(peer)}" else "/messages"
    SmsRoute.offer(route)
    // The notifier reads this to stay quiet for the thread the user is on.
    AppVisibility.thread = if (route.startsWith("/messages/")) peer else null
  }

  /**
   * Record the current default-SMS package. `none` is a real answer and is
   * written as such, matching what [writeDeviceFacts] does on first launch.
   */
  private fun writeDefaultSmsFact() {
    try {
      val value = defaultSmsPackage() ?: "none"
      NativeBridge.setDeviceFactSafely(applicationInfo.dataDir, "default_sms_app", value)
    } catch (_: SecurityException) {
      // The fact stays as the last confirmed value rather than guessing.
    }
  }

  /**
   * The package Android currently treats as the default SMS app.
   *
   * From API 29 the SMS role is authoritative, and this is not just tidiness:
   * on the Android 16 gate handset `cmd role add-role-holder` makes this app the
   * holder while `Settings.Secure.sms_default_application` — and therefore
   * `Telephony.Sms.getDefaultSmsPackage` — still returns null. Reading the role
   * first is what keeps the UI from claiming "none" while the app is default.
   * The legacy getter remains the fallback below API 29 and for ROMs that keep
   * the setting in step.
   */
  private fun defaultSmsPackage(): String? {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      try {
        val roles = getSystemService(RoleManager::class.java)
        if (roles != null &&
          roles.isRoleAvailable(RoleManager.ROLE_SMS) &&
          roles.isRoleHeld(RoleManager.ROLE_SMS)
        ) {
          // `isRoleHeld` is the only public RoleManager query a normal app has;
          // the holder list is a system API. This answers the one question the
          // UI must never guess: does *this* package hold the role?
          return packageName
        }
      } catch (_: SecurityException) {
        // Fall through to the legacy source.
      } catch (_: Throwable) {
        // A broken role service must not take the facts screen down.
      }
    }

    // Below API 29, and on ROMs that keep the secure setting in step, this names
    // another holder too. On this Android 16 build it can stay null even while
    // another app holds the role, so a false "none" is possible only for that
    // other-app case; the role request itself still works.
    return try {
      Telephony.Sms.getDefaultSmsPackage(this)
    } catch (_: SecurityException) {
      null
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
      .put("notifications", notificationsGranted())
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

    // `null` is a real answer here — no app holds the default-SMS role — so it
    // is recorded rather than skipped, and the UI can say "none" instead of
    // "not reported". [defaultSmsPackage] asks RoleManager before the legacy
    // secure setting, which this Android build leaves null.
    write("default_sms_app", defaultSmsPackage() ?: "none")

    Log.i("DakFlareSms", "device facts written=$written")
  }

  private fun isGranted(permission: String): Boolean =
    checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

  /** Below API 33 notifications are on by default and there is no runtime grant. */
  private fun notificationsGranted(): Boolean =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
      isGranted(Manifest.permission.POST_NOTIFICATIONS)

  private companion object {
    val SMS_SCHEMES = setOf("sms", "smsto", "mms", "mmsto")
    const val PERMISSION_PREFS = "dakflare_permissions"
    const val KEY_ASKED_NOTIFICATIONS = "asked_notifications"
  }
}
