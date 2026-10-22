//! JNI entry points used by the Android shell.
//!
//! A manifest `BroadcastReceiver` runs with no Tauri runtime and no webview, so
//! it cannot use the command surface. It calls these functions directly on the
//! packaged `libsimulator_lib.so`; the Rust core still owns the database.
//!
//! Rules for this module:
//! - Never log a sender or a body.
//! - Never let a panic cross the FFI boundary; every path returns a JSON string.
//! - Take the app data directory from Kotlin. Never guess it.

use std::path::Path;

use dakflare_core::{CarrierError, Store, receive_offline};
use jni::JNIEnv;
use jni::objects::{JClass, JString};
use jni::sys::{jlong, jstring};

const MAX_SENDER_LEN: usize = 64;
const MAX_BODY_LEN: usize = 4096;
const DB_FILE: &str = "simulator.db";

/// `dev.dakflare.simulator.bridge.NativeBridge.storeIncoming`
///
/// Persists one inbound SMS in `<appDir>/simulator.db` and returns
/// `{"ok":true,"device_id":"…","local_id":"…"}` or
/// `{"ok":false,"error":"unpaired"|"bad_input"|"storage"}`.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_dakflare_simulator_bridge_NativeBridge_storeIncoming(
    mut env: JNIEnv,
    _class: JClass,
    app_dir: JString,
    sender: JString,
    body: JString,
    received_at_ms: jlong,
) -> jstring {
    // Top-level guard: no Rust panic may unwind across the JNI boundary. The
    // inner guard exists so a failure inside the blocking store call keeps its
    // own message; both end as the same `storage` JSON.
    let json = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        match read_inputs(&mut env, &app_dir, &sender, &body, received_at_ms) {
            Ok((app_dir, sender, body)) => {
                match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    store_blocking(&app_dir, &sender, &body, received_at_ms)
                })) {
                    Ok(Ok((device_id, local_id))) => serde_json::json!({
                        "ok": true,
                        "device_id": device_id,
                        "local_id": local_id,
                    })
                    .to_string(),
                    Ok(Err(code)) => error_json(code),
                    Err(_) => {
                        eprintln!("[jni] storeIncoming panicked");
                        error_json("storage")
                    }
                }
            }
            Err(code) => error_json(code),
        }
    })) {
        Ok(json) => json,
        Err(_) => {
            eprintln!("[jni] storeIncoming panicked before storage");
            error_json("storage")
        }
    };

    match env.new_string(json) {
        Ok(value) => value.into_raw(),
        // Only reachable if the JVM cannot allocate; there is no way to report
        // that without a string, so null is the only safe result.
        Err(_) => std::ptr::null_mut(),
    }
}

/// Decode and validate the JNI arguments. Strings are copied before the
/// `JNIEnv` is released, and lengths are checked here so oversized input never
/// reaches the database layer.
fn read_inputs(
    env: &mut JNIEnv,
    app_dir: &JString,
    sender: &JString,
    body: &JString,
    received_at_ms: i64,
) -> Result<(String, String, String), &'static str> {
    let app_dir = java_string(env, app_dir)?;
    let sender = java_string(env, sender)?;
    let body = java_string(env, body)?;

    if app_dir.is_empty() || !Path::new(&app_dir).is_absolute() {
        return Err("bad_input");
    }
    if sender.trim().is_empty() || sender.len() > MAX_SENDER_LEN {
        return Err("bad_input");
    }
    if body.len() > MAX_BODY_LEN {
        return Err("bad_input");
    }
    if received_at_ms <= 0 {
        return Err("bad_input");
    }

    Ok((app_dir, sender, body))
}

fn java_string(env: &mut JNIEnv, value: &JString) -> Result<String, &'static str> {
    env.get_string(value)
        .map(Into::into)
        .map_err(|_| "bad_input")
}

fn store_blocking(
    app_dir: &str,
    sender: &str,
    body: &str,
    received_at_ms: i64,
) -> Result<(String, String), &'static str> {
    let dir = Path::new(app_dir);
    std::fs::create_dir_all(dir).map_err(|_| "storage")?;

    // Tauri's global async runtime is initialized lazily, so this works in a
    // receiver process even though no Tauri application was built there.
    tauri::async_runtime::block_on(async {
        let store = Store::open(dir.join(DB_FILE))
            .await
            .map_err(|_| "storage")?;
        let message = receive_offline(&store, None, sender, body, received_at_ms)
            .await
            .map_err(map_carrier_error)?;
        Ok((message.device_id, message.local_id.unwrap_or_default()))
    })
}

fn map_carrier_error(error: CarrierError) -> &'static str {
    match error {
        CarrierError::Unpaired => "unpaired",
        CarrierError::InvalidInput(_) => "bad_input",
        CarrierError::Store(_) | CarrierError::Protocol(_) => "storage",
    }
}

fn error_json(code: &'static str) -> String {
    serde_json::json!({ "ok": false, "error": code }).to_string()
}
