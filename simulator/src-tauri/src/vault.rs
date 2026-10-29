//! The Android Keystore half of the identity vault.
//!
//! `dakflare-core` owns the `keystore:v1:<iv>:<ciphertext>` format and the
//! migration rules, but it must never hold the wrapping key: that key is
//! non-exportable and lives in AndroidKeyStore. So the AES-256-GCM work is done
//! by [`KeyVault.kt`] and this module is the Rust side of that call — a static
//! method on the same class, invoked over JNI.
//!
//! Kotlin installs the class reference once, at process start, through
//! `KeyVault.nativeInstall`: `NativeBridge`'s static initializer calls it, and
//! `MainActivity.onCreate` calls it before `super.onCreate()` so the Tauri
//! setup path (which opens the store and migrates the key) already has it. The
//! `JClass` argument comes from the JVM, so no `FindClass` on a native thread
//! (and no app-class-loader guessing) is involved.
//!
//! If the install never happened, the Keystore entry is gone, or the blob does
//! not authenticate, every method here returns
//! [`KeyVaultError::Unavailable`]/[`Invalid`] and the core turns that into
//! `StoreError::KeyLocked`. Nothing is logged about the key material, and no
//! path returns plaintext as a fallback.

use std::sync::OnceLock;

use dakflare_core::keyvault::{KeyCipher, KeyVaultError};
use jni::objects::{GlobalRef, JClass, JString, JValue};
use jni::{JNIEnv, JavaVM};

/// The JVM and the `KeyVault` class, installed once per process. `JavaVM` is
/// cheap to clone and `GlobalRef` keeps the class alive for the process.
static VM: OnceLock<JavaVM> = OnceLock::new();
static CLASS: OnceLock<GlobalRef> = OnceLock::new();

const CLASS_NAME: &str = "dev.dakflare.simulator.KeyVault";

/// The cipher handed to `Store::open_with_cipher` on Android.
#[derive(Debug, Clone, Copy)]
pub struct JniKeyCipher;

impl KeyCipher for JniKeyCipher {
    fn encrypt(&self, plaintext: &str) -> Result<(String, String), KeyVaultError> {
        with_env(|env| {
            let input = env
                .new_string(plaintext)
                .map_err(|_| KeyVaultError::Unavailable)?;
            let reply = call(
                env,
                "wrap",
                "(Ljava/lang/String;)Ljava/lang/String;",
                &[JValue::Object(&input)],
            )?;
            let iv = reply
                .get("iv")
                .and_then(|value| value.as_str())
                .ok_or(KeyVaultError::Unavailable)?;
            let ciphertext = reply
                .get("ciphertext")
                .and_then(|value| value.as_str())
                .ok_or(KeyVaultError::Unavailable)?;
            Ok((iv.to_string(), ciphertext.to_string()))
        })
    }

    fn decrypt(&self, iv_b64: &str, ciphertext_b64: &str) -> Result<String, KeyVaultError> {
        with_env(|env| {
            let iv = env
                .new_string(iv_b64)
                .map_err(|_| KeyVaultError::Unavailable)?;
            let ciphertext = env
                .new_string(ciphertext_b64)
                .map_err(|_| KeyVaultError::Unavailable)?;
            let reply = call(
                env,
                "unwrap",
                "(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;",
                &[JValue::Object(&iv), JValue::Object(&ciphertext)],
            )?;
            Ok(reply
                .get("plaintext")
                .and_then(|value| value.as_str())
                .ok_or(KeyVaultError::Unavailable)?
                .to_string())
        })
    }
}

/// Attach the calling thread to the JVM for the duration of one call.
///
/// A thread that is already attached (the receiver's worker, the service loop,
/// the main thread) keeps its env and is not detached by the guard.
fn with_env<T>(
    run: impl FnOnce(&mut JNIEnv) -> Result<T, KeyVaultError>,
) -> Result<T, KeyVaultError> {
    let vm = VM.get().ok_or(KeyVaultError::Unavailable)?;
    let mut guard = vm
        .attach_current_thread()
        .map_err(|_| KeyVaultError::Unavailable)?;
    run(&mut guard)
}

/// Call one static method and decode its JSON reply.
///
/// Kotlin answers `{"ok":true,…}` or `{"ok":false,"error":"…"}`; anything else
/// (a pending Java exception, a null return, malformed JSON) is
/// [`KeyVaultError::Unavailable`]. The exception is cleared so a failed call
/// cannot leak into the next JNI entry.
fn call(
    env: &mut JNIEnv,
    method: &str,
    signature: &str,
    args: &[JValue],
) -> Result<serde_json::Value, KeyVaultError> {
    let class = CLASS.get().ok_or(KeyVaultError::Unavailable)?;
    let value = match env.call_static_method(class, method, signature, args) {
        Ok(value) => value,
        Err(_) => {
            let _ = env.exception_clear();
            eprintln!("[vault] KeyVault.{method} raised");
            return Err(KeyVaultError::Unavailable);
        }
    };

    let object = value.l().map_err(|_| KeyVaultError::Unavailable)?;
    if object.is_null() {
        return Err(KeyVaultError::Unavailable);
    }
    let text: String = env
        .get_string(&JString::from(object))
        .map_err(|_| KeyVaultError::Unavailable)?
        .into();
    let reply: serde_json::Value =
        serde_json::from_str(&text).map_err(|_| KeyVaultError::Unavailable)?;

    if reply.get("ok").and_then(|ok| ok.as_bool()) != Some(true) {
        return Err(match reply.get("error").and_then(|error| error.as_str()) {
            Some("invalid") => KeyVaultError::Invalid,
            _ => KeyVaultError::Unavailable,
        });
    }
    Ok(reply)
}

/// `dev.dakflare.simulator.KeyVault.nativeInstall()`
///
/// Cache the VM and the class reference. Idempotent and silent: failing to
/// install is not fatal here, it makes every later unwrap fail closed with the
/// one clear sentence.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_dakflare_simulator_KeyVault_nativeInstall(
    env: JNIEnv,
    class: JClass,
) {
    let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        if VM.get().is_none() {
            match env.get_java_vm() {
                Ok(vm) => {
                    let _ = VM.set(vm);
                }
                Err(_) => eprintln!("[vault] no JavaVM for {CLASS_NAME}"),
            }
        }
        if CLASS.get().is_none() {
            match env.new_global_ref(&class) {
                Ok(reference) => {
                    let _ = CLASS.set(reference);
                }
                Err(_) => eprintln!("[vault] could not retain {CLASS_NAME}"),
            }
        }
    }));
}
