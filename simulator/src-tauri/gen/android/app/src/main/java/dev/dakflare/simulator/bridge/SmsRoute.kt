package dev.dakflare.simulator.bridge

/**
 * One pending sms:/smsto: route, written by `MainActivity` when a SENDTO/VIEW
 * intent arrives and read once by the webview through the `take_sms_route`
 * command.
 *
 * A process-wide mailbox rather than a reference to the Activity: the Activity
 * can be recreated by the system while the Tauri plugin is constructed with
 * whichever instance is current, and a static Activity reference would leak it.
 * This object holds only a short path string.
 */
object SmsRoute {
    @Volatile
    private var route: String? = null

    @Volatile
    private var pending = false

    /** Offer one route; `null` means the intent was not an SMS link. */
    fun offer(value: String?) {
        if (value == null) return
        route = value
        pending = true
    }

    /** The route once, or `null` when no intent is waiting. */
    fun take(): String? {
        if (!pending) return null
        pending = false
        return route.also { route = null }
    }
}
