package dev.dakflare.simulator

import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import org.json.JSONObject
import java.security.KeyStore
import java.security.ProviderException
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The wrapping key behind `keystore:v1:` identity storage.
 *
 * The AES-256-GCM key is generated inside AndroidKeyStore and is non-exportable:
 * this class can ask the platform to encrypt and decrypt, and nothing else — not
 * even this process — can read the key bytes. On devices that offer StrongBox
 * (API 28+, a discrete security chip) the key is created there; when the chip
 * refuses, generation falls back to the TEE-backed Keystore without changing
 * the alias.
 *
 * The key deliberately does **not** require user authentication. The identity is
 * used by [dev.dakflare.simulator.bridge.SmsReceiver] and
 * [dev.dakflare.simulator.bridge.GatewayService] in a process with no Activity
 * and no unlocked screen; a key that demanded authentication would leave the
 * gateway unable to sign after a reboot.
 *
 * Rust calls [wrap] and [unwrap] over JNI through `src-tauri/src/vault.rs`.
 * [install] caches the class reference once, at process start, so those calls
 * work from the Tauri worker threads as well as from a broadcast receiver.
 *
 * Logging rule: never the plaintext, the ciphertext, the IV or the key. Only an
 * exception class name.
 */
object KeyVault {
    private const val TAG = "DakFlareVault"
    private const val LIBRARY = "simulator_lib"
    private const val PROVIDER = "AndroidKeyStore"
    private const val ALIAS = "dakflare.device-key.v1"
    private const val TRANSFORMATION = "AES/GCM/NoPadding"
    private const val GCM_TAG_BITS = 128

    /** One instance per process; the native side only needs the reference. */
    @Volatile
    private var installed = false

    /**
     * Cache the JVM and this class for the Rust cipher.
     *
     * Called from `MainActivity.onCreate` before `super.onCreate()` (so Tauri's
     * setup, which opens the store and migrates the key, already has it) and from
     * [dev.dakflare.simulator.bridge.NativeBridge]'s initializer (so a cold-start
     * receiver or the boot-started service has it with no Activity). Idempotent;
     * a failure is logged and leaves every unwrap failing closed.
     */
    fun install() {
        if (installed) return
        synchronized(this) {
            if (installed) return
            try {
                System.loadLibrary(LIBRARY)
                nativeInstall()
                installed = true
            } catch (error: Throwable) {
                // The bridge is optional at this point: the core reports
                // "The device key cannot be unlocked on this phone" instead.
                Log.e(TAG, "vault install failed: ${error.javaClass.simpleName}")
            }
        }
    }

    /**
     * Encrypt a PKCS#8 PEM under the Keystore wrapping key.
     *
     * Returns `{"ok":true,"iv":"<base64>","ciphertext":"<base64>"}` or
     * `{"ok":false,"error":"unavailable"}`. The ciphertext carries GCM's tag.
     * Android generates a fresh random IV for every call because the key was
     * created with `setRandomizedEncryptionRequired(true)`.
     */
    @JvmStatic
    fun wrap(plaintext: String): String = try {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, wrappingKey())
        val ciphertext = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
        JSONObject()
            .put("ok", true)
            .put("iv", encode(cipher.iv))
            .put("ciphertext", encode(ciphertext))
            .toString()
    } catch (error: Throwable) {
        Log.e(TAG, "wrap failed: ${error.javaClass.simpleName}")
        failure("unavailable")
    }

    /**
     * Decrypt and authenticate one blob.
     *
     * Returns `{"ok":true,"plaintext":"<pem>"}` or
     * `{"ok":false,"error":"invalid"|"unavailable"}`. A wrong tag — a tampered
     * blob, or one wrapped by a key this phone no longer has — is `invalid`;
     * the caller must then fail closed, never fall back to anything.
     */
    @JvmStatic
    fun unwrap(iv: String, ciphertext: String): String = try {
        val nonce = decode(iv)
        val body = decode(ciphertext)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(
            Cipher.DECRYPT_MODE,
            wrappingKey(),
            GCMParameterSpec(GCM_TAG_BITS, nonce),
        )
        val plaintext = cipher.doFinal(body)
        JSONObject()
            .put("ok", true)
            .put("plaintext", String(plaintext, Charsets.UTF_8))
            .toString()
    } catch (error: AEADBadTagException) {
        // Tampered, truncated, or wrapped by a different key: the tag is the
        // only answer the phone gets, and it is "no".
        Log.w(TAG, "unwrap refused: the blob did not authenticate")
        failure("invalid")
    } catch (error: Throwable) {
        Log.e(TAG, "unwrap failed: ${error.javaClass.simpleName}")
        failure("unavailable")
    }

    /**
     * The Keystore entry, created on first use.
     *
     * Never deleted or regenerated: losing this key would make every stored
     * identity blob unreadable, which is exactly the fail-closed case the
     * user-facing sentence exists for. If the alias is already present it is
     * used as-is, whatever parameters it was created with.
     */
    private fun wrappingKey(): SecretKey {
        val keyStore = KeyStore.getInstance(PROVIDER).apply { load(null) }
        (keyStore.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let {
            return it.secretKey
        }

        synchronized(this) {
            (keyStore.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let {
                return it.secretKey
            }
            // StrongBox is a separate chip. Not every device has one, and a
            // device that has one may still refuse this app (slot exhaustion,
            // a locked secure element). Fall back to the ordinary Keystore
            // under the same alias; `StrongBoxUnavailableException` is a
            // ProviderException, so one catch covers it on every API level.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                try {
                    return generate(strongBox = true)
                } catch (error: ProviderException) {
                    Log.w(TAG, "StrongBox unavailable: ${error.javaClass.simpleName}")
                }
            }
            return generate(strongBox = false)
        }
    }

    private fun generate(strongBox: Boolean): SecretKey {
        val builder = KeyGenParameterSpec.Builder(
            ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            // A random IV per encryption is what keeps two wraps of the same
            // key distinct; the platform owns the IV in this mode.
            .setRandomizedEncryptionRequired(true)
            // The receiver and the foreground service must sign with no
            // Activity and a locked screen.
            .setUserAuthenticationRequired(false)

        if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            builder.setIsStrongBoxBacked(true)
        }

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER)
        generator.init(builder.build())
        return generator.generateKey()
    }

    private fun encode(bytes: ByteArray): String =
        Base64.encodeToString(bytes, Base64.NO_WRAP)

    private fun decode(value: String): ByteArray =
        Base64.decode(value, Base64.NO_WRAP)

    private fun failure(reason: String): String =
        JSONObject().put("ok", false).put("error", reason).toString()

    /** Cache the VM and this class on the Rust side. */
    @JvmStatic
    external fun nativeInstall()
}
