package dev.dakflare.simulator.bridge

import android.util.Log
import org.json.JSONObject

/**
 * The only Kotlin-side entry into the Rust core.
 *
 * A manifest receiver runs without a Tauri runtime, so it cannot use `invoke`.
 * The packaged `libsimulator_lib.so` is loaded directly and called through JNI;
 * Rust remains the only implementation of storage and flows.
 *
 * Every function here returns a JSON string. A missing library or symbol is an
 * error object, never an exception that could take down the app process.
 */
object NativeBridge {
    private const val TAG = "DakFlareSms"
    private const val LIBRARY = "simulator_lib"
    private const val STORAGE_ERROR = "{\"ok\":false,\"error\":\"storage\"}"

    private val loadFailure: Throwable? = try {
        System.loadLibrary(LIBRARY)
        null
    } catch (error: UnsatisfiedLinkError) {
        // Loading is deferred until the first call; report it there so a build
        // without the native library still starts the app.
        Log.e(TAG, "simulator_lib unavailable: ${error.javaClass.simpleName}")
        error
    }

    /**
     * Persist one inbound SMS in `<appDir>/simulator.db` without returning flow
     * actions.
     *
     * Kept so a build whose `.so` predates M5.2 still stores messages. New
     * callers use [processIncoming].
     */
    @JvmStatic
    external fun storeIncoming(
        appDir: String,
        sender: String,
        body: String,
        receivedAtMs: Long,
    ): String

    /**
     * Persist one inbound SMS, run the locally cached flows and return what to
     * send.
     *
     * Returns `{"ok":true,"device_id":"…","local_id":"…","actions":[{"to","body"}]}`
     * or `{"ok":false,"error":"unpaired"|"bad_input"|"storage"}`.
     */
    @JvmStatic
    external fun processIncoming(
        appDir: String,
        sender: String,
        body: String,
        receivedAtMs: Long,
    ): String

    /**
     * Record what happened to a queued reply row (`queued`, `sent`, `failed`).
     *
     * Returns `{"ok":true}` or `{"ok":false,"error":"bad_input"|"not_found"|"storage"}`.
     */
    @JvmStatic
    external fun markOutbound(
        appDir: String,
        deviceId: String,
        localId: String,
        state: String,
    ): String

    /**
     * Upload everything the deployment has not accepted yet — pending inbound
     * SMS, their flow runs and replies already marked `sent` — in one request.
     *
     * Returns `{"ok":true,"inbound":<count>,"outbound":<count>}` or
     * `{"ok":false,"error":"bad_input"|"unpaired"|"storage"|"network"|"protocol"}`.
     */
    @JvmStatic
    external fun flushPending(appDir: String, deviceId: String): String

    /**
     * Replace the cached flow set with this deployment's current set.
     *
     * Returns `{"ok":true,"flows":<count>}` or
     * `{"ok":false,"error":"bad_input"|"unpaired"|"storage"|"network"|"protocol"}`.
     * An empty list is success and clears the cache; on failure the previous
     * cache stays in place.
     */
    @JvmStatic
    external fun syncFlows(appDir: String, deviceId: String): String

    /**
     * The paired identity in this store, if there is one.
     *
     * Returns `{"ok":true,"device_id":"…"}` or
     * `{"ok":false,"error":"bad_input"|"unpaired"|"storage"}`. The gateway
     * service needs the id to flush, and both the boot receiver and the UI need
     * the yes/no answer; one small call gives both without a second symbol.
     */
    @JvmStatic
    external fun hasIdentity(appDir: String): String

    /**
     * Persist one whitelisted handset fact (`self_number`, `sim_slot`,
     * `sim_carrier`, `permissions`, `battery_optimized`, `default_sms_app`).
     *
     * Returns `{"ok":true}` or `{"ok":false,"error":"bad_input"|"storage"}`.
     * The key and value are never logged.
     */
    @JvmStatic
    external fun setDeviceFact(appDir: String, key: String, value: String): String

    /**
     * Queue one SMS typed on this phone, before the radio is touched.
     *
     * Returns `{"ok":true,"local_id":"compose-…"}` or
     * `{"ok":false,"error":"bad_input"|"storage"}`. The id is the row the
     * `SENT` broadcast later marks; an identical send still `queued` returns the
     * same id, so a double tap cannot create two rows.
     */
    @JvmStatic
    external fun queueOutbound(
        appDir: String,
        deviceId: String,
        to: String,
        body: String,
    ): String

    /**
     * Safe wrapper for the sender: returns the local id, or `null` when the
     * store refused or the native symbol is missing. Never throws, and never
     * logs the recipient or the body.
     */
    fun queueOutboundSafely(
        appDir: String,
        deviceId: String,
        to: String,
        body: String,
    ): String? {
        if (loadFailure != null) return null
        if (appDir.isEmpty() || deviceId.isEmpty()) return null

        return try {
            val result = JSONObject(queueOutbound(appDir, deviceId, to, body))
            if (result.optBoolean("ok")) {
                result.optString("local_id").ifEmpty { null }
            } else {
                null
            }
        } catch (error: UnsatisfiedLinkError) {
            Log.e(TAG, "queueOutbound symbol missing: ${error.javaClass.simpleName}")
            null
        } catch (error: Throwable) {
            Log.e(TAG, "queueOutbound failed: ${error.javaClass.simpleName}")
            null
        }
    }

    /**
     * Read one stored message by its deterministic local id.
     *
     * The `SENT` receipt carries only ids; [SendStatusReceiver] uses this to
     * recover the address, body and timestamp it needs for the system Sent row.
     * Returns `{"ok":true,"peer":"…","body":"…","created_at":<ms>}` or
     * `{"ok":false,"error":"bad_input"|"not_found"|"storage"}`.
     */
    @JvmStatic
    external fun messageByLocalId(
        appDir: String,
        deviceId: String,
        localId: String,
    ): String

    /** One stored row, as the sent-provider write needs it. */
    class StoredMessage(
        val peer: String,
        val body: String,
        val createdAt: Long,
    )

    /**
     * Safe wrapper around [messageByLocalId]: never throws, and returns `null`
     * for a missing symbol, a missing row or a store error. Only the exception
     * class is logged.
     */
    fun messageByLocalIdSafely(
        appDir: String,
        deviceId: String,
        localId: String,
    ): StoredMessage? {
        if (loadFailure != null) return null
        if (appDir.isEmpty() || deviceId.isEmpty() || localId.isEmpty()) return null

        return try {
            val parsed = JSONObject(messageByLocalId(appDir, deviceId, localId))
            if (!parsed.optBoolean("ok")) {
                null
            } else {
                StoredMessage(
                    peer = parsed.optString("peer"),
                    body = parsed.optString("body"),
                    createdAt = parsed.optLong("created_at"),
                )
            }
        } catch (error: UnsatisfiedLinkError) {
            Log.e(TAG, "messageByLocalId symbol missing: ${error.javaClass.simpleName}")
            null
        } catch (error: Throwable) {
            Log.e(TAG, "messageByLocalId failed: ${error.javaClass.simpleName}")
            null
        }
    }

    /**
     * Read one stored handset fact (`self_number`, `sim_slot`, …).
     *
     * Returns `null` when the fact was never written or the store cannot be read.
     */
    @JvmStatic
    external fun getDeviceFact(appDir: String, key: String): String

    /**
     * The stored value of one handset fact, or `null`. Never throws and logs only
     * an exception class: a missing value must degrade to "unknown" rather than
     * take down a broadcast receiver.
     */
    fun getDeviceFactSafely(appDir: String, key: String): String? {
        if (loadFailure != null) return null
        if (appDir.isEmpty() || key.isEmpty()) return null

        return try {
            val parsed = JSONObject(getDeviceFact(appDir, key))
            if (!parsed.optBoolean("ok") || parsed.isNull("value")) return null
            parsed.optString("value").ifEmpty { null }
        } catch (error: UnsatisfiedLinkError) {
            Log.e(TAG, "getDeviceFact symbol missing: ${error.javaClass.simpleName}")
            null
        } catch (error: Throwable) {
            Log.e(TAG, "getDeviceFact failed: ${error.javaClass.simpleName}")
            null
        }
    }

    /**
     * Safe wrapper for the receiver: never throws, including when the JNI symbol
     * is missing (which only fails on invocation, not on `loadLibrary`).
     */
    fun storeIncomingSafely(
        appDir: String,
        sender: String,
        body: String,
        receivedAtMs: Long,
    ): String {
        if (loadFailure != null) return STORAGE_ERROR

        return try {
            storeIncoming(appDir, sender, body, receivedAtMs)
        } catch (error: UnsatisfiedLinkError) {
            Log.e(TAG, "storeIncoming symbol missing: ${error.javaClass.simpleName}")
            STORAGE_ERROR
        } catch (error: Throwable) {
            Log.e(TAG, "storeIncoming failed: ${error.javaClass.simpleName}")
            STORAGE_ERROR
        }
    }

    /**
     * Same contract as [storeIncomingSafely], plus flow actions.
     *
     * If the reply path fails — including a `.so` without the new symbol — fall
     * back to persistence so the inbound message is never lost to a reply
     * problem. The fallback result carries no actions, so nothing is sent twice.
     */
    fun processIncomingSafely(
        appDir: String,
        sender: String,
        body: String,
        receivedAtMs: Long,
    ): String {
        if (loadFailure != null) return STORAGE_ERROR

        return try {
            val result = processIncoming(appDir, sender, body, receivedAtMs)
            if (isOk(result)) {
                result
            } else {
                Log.w(TAG, "processIncoming did not complete; retrying persistence only")
                storeIncomingSafely(appDir, sender, body, receivedAtMs)
            }
        } catch (error: UnsatisfiedLinkError) {
            Log.e(TAG, "processIncoming symbol missing: ${error.javaClass.simpleName}")
            storeIncomingSafely(appDir, sender, body, receivedAtMs)
        } catch (error: Throwable) {
            Log.e(TAG, "processIncoming failed: ${error.javaClass.simpleName}")
            storeIncomingSafely(appDir, sender, body, receivedAtMs)
        }
    }

    private fun isOk(json: String): Boolean = try {
        JSONObject(json).optBoolean("ok")
    } catch (_: Throwable) {
        false
    }

    /**
     * Best-effort state mark for a reply row. Never throws: a missing symbol or
     * a store error returns `false` and leaves the row `queued`, which is the
     * honest "unknown" state. Only the exception class is logged.
     */
    fun markOutboundSafely(
        appDir: String,
        deviceId: String,
        localId: String,
        state: String,
    ): Boolean {
        if (loadFailure != null) return false
        if (deviceId.isEmpty() || localId.isEmpty()) return false

        return try {
            isOk(markOutbound(appDir, deviceId, localId, state))
        } catch (error: UnsatisfiedLinkError) {
            Log.e(TAG, "markOutbound symbol missing: ${error.javaClass.simpleName}")
            false
        } catch (error: Throwable) {
            Log.e(TAG, "markOutbound failed: ${error.javaClass.simpleName}")
            false
        }
    }

    /**
     * Best-effort flush of everything not yet accepted. Never throws: an empty
     * argument, a missing symbol or a store/network error returns `false` and
     * leaves the rows pending, so the next call retries them. Only the
     * exception class is logged.
     */
    fun flushPendingSafely(appDir: String, deviceId: String): Boolean {
        if (loadFailure != null) return false
        if (appDir.isEmpty() || deviceId.isEmpty()) return false

        return try {
            isOk(flushPending(appDir, deviceId))
        } catch (error: UnsatisfiedLinkError) {
            Log.e(TAG, "flushPending symbol missing: ${error.javaClass.simpleName}")
            false
        } catch (error: Throwable) {
            Log.e(TAG, "flushPending failed: ${error.javaClass.simpleName}")
            false
        }
    }

    /**
     * Best-effort flow sync for the gateway tick. Never throws: an empty
     * argument, a missing symbol or a store/network error returns `false` and
     * leaves the previous cache, so the receiver keeps answering with the last
     * good set. Only the exception class is logged.
     */
    fun syncFlowsSafely(appDir: String, deviceId: String): Boolean {
        if (loadFailure != null) return false
        if (appDir.isEmpty() || deviceId.isEmpty()) return false

        return try {
            isOk(syncFlows(appDir, deviceId))
        } catch (error: UnsatisfiedLinkError) {
            Log.e(TAG, "syncFlows symbol missing: ${error.javaClass.simpleName}")
            false
        } catch (error: Throwable) {
            Log.e(TAG, "syncFlows failed: ${error.javaClass.simpleName}")
            false
        }
    }

    /**
     * The paired device id, or `null` when this store has no identity.
     *
     * Never throws: a missing symbol or a store error degrades to "not paired",
     * which keeps the gateway off rather than starting a service that cannot
     * flush. Only the exception class is logged.
     */
    fun identitySafely(appDir: String): String? {
        if (loadFailure != null) return null
        if (appDir.isEmpty()) return null

        return try {
            val parsed = JSONObject(hasIdentity(appDir))
            if (!parsed.optBoolean("ok")) null
            else parsed.optString("device_id").ifEmpty { null }
        } catch (error: UnsatisfiedLinkError) {
            Log.e(TAG, "hasIdentity symbol missing: ${error.javaClass.simpleName}")
            null
        } catch (error: Throwable) {
            Log.e(TAG, "hasIdentity failed: ${error.javaClass.simpleName}")
            null
        }
    }

    /**
     * Best-effort write of one handset fact. Never throws: a missing symbol, a
     * rejected key or a store error returns `false`. Neither the key nor the
     * value is logged; only the exception class.
     */
    fun setDeviceFactSafely(appDir: String, key: String, value: String): Boolean {
        if (loadFailure != null) return false
        if (appDir.isEmpty() || key.isEmpty()) return false

        return try {
            isOk(setDeviceFact(appDir, key, value))
        } catch (error: UnsatisfiedLinkError) {
            Log.e(TAG, "setDeviceFact symbol missing: ${error.javaClass.simpleName}")
            false
        } catch (error: Throwable) {
            Log.e(TAG, "setDeviceFact failed: ${error.javaClass.simpleName}")
            false
        }
    }
}
