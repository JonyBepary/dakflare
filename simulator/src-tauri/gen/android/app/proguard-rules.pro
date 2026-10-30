# R8 rules for the DakFlare shell.
#
# The bridge classes are reached by name at runtime, from two directions that R8
# cannot see:
#   * Rust calls Kotlin through Tauri's mobile plugin registry, which resolves
#     `dev.dakflare.simulator.bridge.SmsPlugin` by class name (`run_mobile_plugin`).
#   * Kotlin calls Rust through JNI, whose symbols are the fully qualified class
#     and method names (`Java_dev_dakflare_simulator_bridge_NativeBridge_*`).
#   * Android instantiates every receiver and service from the manifest.
# Without these, a release build strips the plugin class and the app dies at
# startup with ClassNotFoundException — which is exactly what 0.2.0 did.

-keep class dev.dakflare.simulator.bridge.** { *; }
-keep class dev.dakflare.simulator.KeyVault { *; }
-keep class dev.dakflare.simulator.MainActivity { *; }

# JNI entry points are matched by their Java names, never by obfuscated ones.
-keepclasseswithmembernames class * {
    native <methods>;
}

# Keep the metadata the manifest and the runtime reflection rely on.
-keepattributes *Annotation*, InnerClasses, Signature, EnclosingMethod
