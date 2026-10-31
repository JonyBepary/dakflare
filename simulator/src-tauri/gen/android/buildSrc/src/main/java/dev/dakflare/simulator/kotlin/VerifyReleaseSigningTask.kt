package dev.dakflare.simulator.kotlin

import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.tasks.Internal
import org.gradle.api.tasks.TaskAction
import java.io.File
import java.security.KeyStore
import java.security.MessageDigest
import java.security.cert.X509Certificate
import java.util.Properties

/**
 * Refuses a release build without a real signing key and prints the certificate
 * fingerprint that goes into docs/PHONE_RELEASE.md.
 *
 * The key material is resolved from the environment/config file at execution
 * time on purpose: the password stays out of the Gradle configuration cache and
 * a rotated key cannot be shadowed by a stale cache entry.
 */
abstract class VerifyReleaseSigningTask : DefaultTask() {
    @get:Internal
    var versionName: String = ""

    @get:Internal
    var versionCode: Int = 0

    @TaskAction
    fun verify() {
        val configDir = File(System.getProperty("user.home"), ".config/dakflare")
        val signingFile = File(configDir, "release-keystore.txt")
        val properties = Properties().apply {
            if (signingFile.isFile) {
                signingFile.inputStream().use { load(it) }
            }
        }

        val keystore = File(
            System.getenv("DAKFLARE_KEYSTORE")
                ?: properties.getProperty("keystore")
                ?: File(configDir, "dakflare-release.jks").path
        )
        val alias = System.getenv("DAKFLARE_KEY_ALIAS")
            ?: properties.getProperty("alias")
            ?: "dakflare"
        val password = System.getenv("DAKFLARE_KEYSTORE_PASSWORD")
            ?: properties.getProperty("storePassword")

        val problem = when {
            !keystore.isFile -> "keystore not found at ${keystore.path}"
            password.isNullOrBlank() ->
                "no store password (set DAKFLARE_KEYSTORE_PASSWORD or write $signingFile)"
            else -> null
        }
        if (problem != null) {
            throw GradleException(
                """
                |Release signing is not configured: $problem
                |
                |Set DAKFLARE_KEYSTORE, DAKFLARE_KEYSTORE_PASSWORD and DAKFLARE_KEY_ALIAS,
                |or create ~/.config/dakflare/dakflare-release.jks plus
                |~/.config/dakflare/release-keystore.txt (alias=, storePassword=, keyPassword=).
                |See docs/PHONE_RELEASE.md. The release build never falls back to the debug key.
                """.trimMargin()
            )
        }

        val store = KeyStore.getInstance(keystore, password!!.toCharArray())
        val certificate = store.getCertificate(alias) as? X509Certificate
            ?: throw GradleException("alias '$alias' has no X.509 certificate in ${keystore.path}")
        val digest = MessageDigest.getInstance("SHA-256").digest(certificate.encoded)
        val fingerprint = digest.joinToString(":") { "%02X".format(it) }

        logger.lifecycle("DAKFLARE release keystore: ${keystore.path} (alias $alias)")
        logger.lifecycle("DAKFLARE release certificate SHA-256: $fingerprint")
        logger.lifecycle("DAKFLARE release version: $versionName ($versionCode)")
    }
}
