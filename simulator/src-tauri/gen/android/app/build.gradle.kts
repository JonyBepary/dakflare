import dev.dakflare.simulator.kotlin.VerifyReleaseSigningTask
import groovy.json.JsonSlurper
import java.util.Properties
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

// ---------------------------------------------------------------------------
// Version: one source, src-tauri/tauri.conf.json.
//
//   "version"                     -> versionName (0.2.0)
//   "bundle"."android"."versionCode" -> versionCode (200)
//
// The Tauri CLI also mirrors these into app/tauri.properties, but that file is
// generated and is deliberately NOT read here: editing it would silently make
// the APK disagree with the config. Bump both fields in tauri.conf.json.
// ---------------------------------------------------------------------------
val tauriConfig = JsonSlurper().parse(rootProject.file("../../tauri.conf.json")) as Map<*, *>
val appVersionName = tauriConfig["version"] as? String
    ?: throw GradleException("tauri.conf.json has no \"version\"")
val appVersionCode = (((tauriConfig["bundle"] as? Map<*, *>)?.get("android") as? Map<*, *>)
    ?.get("versionCode") as? Number)?.toInt()
    ?: throw GradleException(
        "tauri.conf.json has no bundle.android.versionCode; the APK version code " +
            "must be explicit so it never silently derives from the version name"
    )

// ---------------------------------------------------------------------------
// Release signing. The key is not in the repository and never will be.
//
//   DAKFLARE_KEYSTORE           path to the .jks (default: ~/.config/dakflare/dakflare-release.jks)
//   DAKFLARE_KEYSTORE_PASSWORD  store password (default: ~/.config/dakflare/release-keystore.txt)
//   DAKFLARE_KEY_ALIAS          key alias (default: "dakflare")
//   DAKFLARE_KEY_PASSWORD       optional; PKCS#12 keys share the store password
//
// There is no debug-key fallback: a release build without this fails in
// verifyReleaseSigning before anything is packaged. See docs/PHONE_RELEASE.md.
// ---------------------------------------------------------------------------
val signingConfigDir = File(System.getProperty("user.home"), ".config/dakflare")
val signingFile = File(signingConfigDir, "release-keystore.txt")
val signingProperties = Properties().apply {
    if (signingFile.isFile) {
        // fileContents() is a configuration-cache input: regenerating the file
        // invalidates the cached configuration instead of reusing old secrets.
        providers.fileContents(layout.file(providers.provider { signingFile }))
            .asText.orNull
            ?.let { load(it.reader()) }
    }
}

val releaseKeystore = File(
    providers.environmentVariable("DAKFLARE_KEYSTORE").orNull
        ?: signingProperties.getProperty("keystore")
        ?: File(signingConfigDir, "dakflare-release.jks").path
)
val releaseStorePassword = providers.environmentVariable("DAKFLARE_KEYSTORE_PASSWORD").orNull
    ?: signingProperties.getProperty("storePassword")
val releaseKeyAlias = providers.environmentVariable("DAKFLARE_KEY_ALIAS").orNull
    ?: signingProperties.getProperty("alias")
    ?: "dakflare"
val releaseKeyPassword = providers.environmentVariable("DAKFLARE_KEY_PASSWORD").orNull
    ?: signingProperties.getProperty("keyPassword")
    ?: releaseStorePassword

val releaseSigningProblem: String? = when {
    !releaseKeystore.isFile ->
        "keystore not found at ${releaseKeystore.path}"
    releaseStorePassword.isNullOrBlank() ->
        "no store password (set DAKFLARE_KEYSTORE_PASSWORD or write $signingFile)"
    releaseKeyAlias.isBlank() ->
        "no key alias (set DAKFLARE_KEY_ALIAS or write $signingFile)"
    releaseKeyPassword.isNullOrBlank() ->
        "no key password (set DAKFLARE_KEY_PASSWORD; PKCS#12 usually shares the store password)"
    else -> null
}
val releaseSigningReady = releaseSigningProblem == null

// Fail before configuring a release build, and never store a configuration
// cache entry for a keyless one: otherwise a later run could replay a cached
// configuration that has no signingConfig and package an unsigned APK.
if (gradle.startParameter.taskNames.any { it.contains("Release") } && !releaseSigningReady) {
    throw GradleException(
        "Release signing is not configured: $releaseSigningProblem\n" +
            "See docs/PHONE_RELEASE.md. The release build never falls back to the debug key."
    )
}

android {
    compileSdk = 37
    namespace = "dev.dakflare.simulator"
    defaultConfig {
        // The release app is HTTPS-only. Debug overrides this to true for the
        // Vite dev server on http://localhost:1420.
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "dev.dakflare.simulator"
        minSdk = 24
        targetSdk = 37
        versionCode = appVersionCode
        versionName = appVersionName
    }
    signingConfigs {
        if (releaseSigningReady) {
            create("release") {
                storeFile = releaseKeystore
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
                enableV1Signing = true
                enableV2Signing = true
                enableV3Signing = true
            }
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {
                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            isDebuggable = false
            isJniDebuggable = false
            manifestPlaceholders["usesCleartextTraffic"] = "false"
            if (releaseSigningReady) {
                signingConfig = signingConfigs.getByName("release")
            }
            optimization {
               enable = true
            }
            proguardFiles(
                *fileTree(".") {
                  include("**/*.pro")
                  exclude("build/**")
                }.files.toTypedArray()
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    buildFeatures {
        buildConfig = true
    }
}

// Fails a release build before packaging when the key is missing, and prints the
// certificate fingerprint that must be recorded in docs/PHONE_RELEASE.md.
// The task class lives in buildSrc so the action does not capture the build
// script (which would break Gradle's configuration cache).
val verifyReleaseSigning = tasks.register<VerifyReleaseSigningTask>("verifyReleaseSigning") {
    group = "verification"
    description = "Require a release signing key and print its SHA-256 certificate fingerprint."
    versionName = appVersionName
    versionCode = appVersionCode
}

// assembleAarch64Release, packageUniversalRelease, bundleRelease, ... all get it.
tasks.matching {
    it.name.endsWith("Release") &&
        (it.name.startsWith("assemble") || it.name.startsWith("package") || it.name.startsWith("bundle"))
}.configureEach {
    dependsOn(verifyReleaseSigning)
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_1_8
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = file("tauri.build.gradle.kts"))
