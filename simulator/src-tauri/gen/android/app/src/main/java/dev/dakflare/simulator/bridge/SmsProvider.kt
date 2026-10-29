package dev.dakflare.simulator.bridge

import android.app.role.RoleManager
import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.provider.Telephony
import android.telephony.SubscriptionManager
import android.util.Log

/**
 * Writes what a default SMS app owes the platform: the system SMS provider.
 *
 * Holding `android.app.role.SMS` opens the provider's write path, which is what
 * lets a default app record inbound and sent messages without `WRITE_SMS`. The
 * provider's read path is still guarded by `READ_SMS` (which this app does not
 * request), so this object never queries it; dedupe is kept beside the app.
 * When another app holds the role, nothing here touches the provider at all,
 * even though the JNI store keeps working.
 *
 * Ordering is part of the contract: [SmsReceiver] calls these methods only after
 * `NativeBridge.processIncomingSafely` reported success, so a provider failure
 * can never lose the message that the local database already holds.
 *
 * Logging rule, as everywhere on this path: masked address, counts and exception
 * classes only. No body is ever logged.
 */
object SmsProvider {
    private const val TAG = "DakFlareSms"

    /**
     * The inbound write runs on its own worker so a wedged provider cannot keep
     * an ordered `SMS_DELIVER` broadcast alive past the receiver budget. The
     * store has already happened; the provider write is best effort.
     */
    private const val WRITE_BUDGET_MS = 2_000L

    private const val PROVIDER_PREFS = "dakflare_provider"
    private const val KEY_WRITTEN_INBOX = "written_inbox"
    private const val MAX_WRITTEN = 100

    /** What the inbox write did, so the receiver can decide about a notification. */
    enum class InboxWrite {
        /** Inserted a new provider row. */
        WROTE,

        /** This delivery was already written; nothing was inserted. */
        DUPLICATE,

        /** Another app holds the SMS role; the provider was not touched. */
        NO_ROLE,

        /** The provider rejected the insert (for example `SecurityException`). */
        REFUSED,

        /** The insert threw or exceeded [WRITE_BUDGET_MS]. */
        FAILED,
    }

    /**
     * Does this package currently hold the default-SMS role?
     *
     * From API 29 `RoleManager` is authoritative. Below it the legacy secure
     * setting names the holder; `Telephony.Sms.getDefaultSmsPackage` is the only
     * public read there.
     */
    fun holdsSmsRole(context: Context): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            return try {
                val roles = context.getSystemService(RoleManager::class.java) ?: return false
                roles.isRoleAvailable(RoleManager.ROLE_SMS) &&
                    roles.isRoleHeld(RoleManager.ROLE_SMS)
            } catch (_: Throwable) {
                false
            }
        }
        return try {
            Telephony.Sms.getDefaultSmsPackage(context) == context.packageName
        } catch (_: Throwable) {
            false
        }
    }

    /**
     * Insert one inbound message into `content://sms/inbox`, bounded in time.
     *
     * Dedupe is the same delivery key the local `local_id` uses: PDU timestamp +
     * sender (plus the body, so a re-used timestamp cannot hide a genuinely
     * different message). It is kept beside the app, not read back from the
     * provider: the provider's `readPermission` is `READ_SMS`, which the default
     * role does not confer, while its write path is what the role opens. A
     * duplicate broadcast therefore finds the key the first delivery wrote and
     * inserts nothing.
     */
    fun writeInboxBounded(
        context: Context,
        address: String,
        body: String,
        dateMs: Long,
        subscriptionId: Int,
    ): InboxWrite {
        if (!holdsSmsRole(context)) return InboxWrite.NO_ROLE

        var outcome = InboxWrite.FAILED
        val worker = Thread(
            { outcome = writeInbox(context, address, body, dateMs, subscriptionId) },
            "dakflare-sms-provider",
        )
        worker.isDaemon = true
        worker.start()
        try {
            worker.join(WRITE_BUDGET_MS)
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
        }
        if (worker.isAlive) {
            // The store already has the message; the provider copy is best effort.
            Log.w(TAG, "inbox provider write exceeded ${WRITE_BUDGET_MS}ms")
            return InboxWrite.FAILED
        }
        return outcome
    }

    private fun writeInbox(
        context: Context,
        address: String,
        body: String,
        dateMs: Long,
        subscriptionId: Int,
    ): InboxWrite {
        val key = deliveryKey(address, body, dateMs)
        if (alreadyWritten(context, key)) return InboxWrite.DUPLICATE

        return try {
            val uri = Telephony.Sms.Inbox.CONTENT_URI
            val values = baseValues(address, body, dateMs, subscriptionId).apply {
                put(Telephony.Sms.READ, 0)
                put(Telephony.Sms.SEEN, 0)
                put(Telephony.Sms.TYPE, Telephony.Sms.MESSAGE_TYPE_INBOX)
            }
            if (context.contentResolver.insert(uri, values) == null) {
                Log.w(TAG, "inbox provider write returned no row")
                InboxWrite.FAILED
            } else {
                markWritten(context, key)
                Log.i(TAG, "inbox provider wrote address=${mask(address)}")
                InboxWrite.WROTE
            }
        } catch (error: SecurityException) {
            // A finding, not something a permission should paper over: the role
            // is supposed to open the provider's write path. Class only.
            Log.e(TAG, "inbox provider refused: SecurityException")
            InboxWrite.REFUSED
        } catch (error: Throwable) {
            Log.e(TAG, "inbox provider write failed: ${error.javaClass.simpleName}")
            InboxWrite.FAILED
        }
    }

    /**
     * Insert one message the radio accepted into `content://sms/sent`.
     *
     * Called from [SendStatusReceiver] only on `RESULT_OK`: a rejected send
     * never left the phone and must not appear in the system Sent list. The row
     * state was already written before this runs, so a provider failure cannot
     * change it.
     */
    fun writeSent(
        context: Context,
        address: String,
        body: String,
        dateMs: Long,
        subscriptionId: Int,
    ): Boolean {
        if (!holdsSmsRole(context)) {
            Log.i(TAG, "sent provider write skipped: no role")
            return false
        }
        return try {
            val values = baseValues(address, body, dateMs, subscriptionId).apply {
                put(Telephony.Sms.TYPE, Telephony.Sms.MESSAGE_TYPE_SENT)
            }
            context.contentResolver.insert(Telephony.Sms.Sent.CONTENT_URI, values)
            Log.i(TAG, "sent provider wrote address=${mask(address)}")
            true
        } catch (error: SecurityException) {
            Log.e(TAG, "sent provider refused: SecurityException")
            false
        } catch (error: Throwable) {
            Log.e(TAG, "sent provider write failed: ${error.javaClass.simpleName}")
            false
        }
    }

    /** The fields every provider row needs, minus the direction-specific ones. */
    private fun baseValues(
        address: String,
        body: String,
        dateMs: Long,
        subscriptionId: Int,
    ): ContentValues = ContentValues().apply {
        put(Telephony.Sms.ADDRESS, address)
        put(Telephony.Sms.BODY, body)
        // The PDU timestamp for inbound; the queued-row timestamp for sent.
        put(Telephony.Sms.DATE, dateMs)
        put(Telephony.Sms.DATE_SENT, dateMs)
        if (subscriptionId != SubscriptionManager.INVALID_SUBSCRIPTION_ID &&
            subscriptionId != 0
        ) {
            put(Telephony.Sms.SUBSCRIPTION_ID, subscriptionId.toLong())
        }
    }

    /** The provider-side half of the local-id dedupe, kept beside the app. */
    private fun deliveryKey(address: String, body: String, dateMs: Long): String =
        "$dateMs:$address:${body.hashCode()}"

    private fun alreadyWritten(context: Context, key: String): Boolean {
        val prefs = context.getSharedPreferences(PROVIDER_PREFS, Context.MODE_PRIVATE)
        return prefs.getStringSet(KEY_WRITTEN_INBOX, emptySet())?.contains(key) == true
    }

    /**
     * Remember a provider row this app wrote. The set is bounded; forgetting an
     * old key can at worst repeat a row after a redelivery of an old message.
     */
    private fun markWritten(context: Context, key: String) {
        val prefs = context.getSharedPreferences(PROVIDER_PREFS, Context.MODE_PRIVATE)
        val written = prefs.getStringSet(KEY_WRITTEN_INBOX, emptySet())?.toMutableSet()
            ?: mutableSetOf()
        written.add(key)
        if (written.size > MAX_WRITTEN) {
            written.clear()
            written.add(key)
        }
        prefs.edit().putStringSet(KEY_WRITTEN_INBOX, written).apply()
    }

    /** Keep at most the last four characters of a number; never log it whole. */
    private fun mask(number: String): String =
        if (number.length <= 4) "***" else "***" + number.takeLast(4)
}
