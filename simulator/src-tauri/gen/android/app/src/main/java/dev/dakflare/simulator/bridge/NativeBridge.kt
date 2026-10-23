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
}
