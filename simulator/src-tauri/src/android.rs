//! JNI entry points used by the Android shell.
//!
//! A manifest `BroadcastReceiver` runs with no Tauri runtime and no webview, so
//! it cannot use the command surface. It calls these functions directly on the
//! packaged `libsimulator_lib.so`; the Rust core still owns the database and the
//! flow interpreter.
//!
//! Rules for this module:
//! - Never log a sender or a body (nor an action body).
//! - Never let a panic cross the FFI boundary; every path returns a JSON string.
//! - Take the app data directory from Kotlin. Never guess it.

use std::path::Path;

use dakflare_core::{
    Action, CarrierError, DeviceClient, Flushed, MAX_DEVICE_FACT_LEN, ProtocolError, Store,
    StoreError, Target, carrier::flush_pending, is_device_fact_key, receive_and_reply,
    reply_local_id,
};
use jni::JNIEnv;
use jni::objects::{JClass, JString};
use jni::sys::{jlong, jstring};

const MAX_SENDER_LEN: usize = 64;
const MAX_BODY_LEN: usize = 4096;
/// Compose is a person typing into one SMS, not a stored carrier payload: the
/// sender refuses anything longer and this entry enforces the same ceiling.
const MAX_COMPOSE_BODY_LEN: usize = 1600;
const MAX_RECIPIENT_LEN: usize = 64;
const MAX_DEVICE_ID_LEN: usize = 64;
const MAX_LOCAL_ID_LEN: usize = 200;
const MAX_STATE_LEN: usize = 16;
const DB_FILE: &str = "simulator.db";

/// `dev.dakflare.simulator.bridge.NativeBridge.storeIncoming`
///
/// Persistence-only entry kept for callers built before M5.2. It runs the same
/// path (the inbound row is written before any flow runs) but returns no
/// actions: `{"ok":true,"device_id":"…","local_id":"…"}` or
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
    let json = guarded(
        &mut env,
        &app_dir,
        &sender,
        &body,
        received_at_ms,
        "storeIncoming",
        false,
    );
    to_jstring(&mut env, json)
}

/// `dev.dakflare.simulator.bridge.NativeBridge.processIncoming`
///
/// Persists one inbound SMS, runs the locally cached flows and returns the
/// replies the receiver must send:
/// `{"ok":true,"device_id":"…","local_id":"…","actions":[{"to":"…","body":"…","local_id":"…"}]}`
/// or `{"ok":false,"error":"unpaired"|"bad_input"|"storage"}`. Each action's
/// `local_id` names the outbound row the receiver must later mark.
///
/// The inbound row is written before flows run, so a reply failure never loses
/// the message.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_dakflare_simulator_bridge_NativeBridge_processIncoming(
    mut env: JNIEnv,
    _class: JClass,
    app_dir: JString,
    sender: JString,
    body: JString,
    received_at_ms: jlong,
) -> jstring {
    let json = guarded(
        &mut env,
        &app_dir,
        &sender,
        &body,
        received_at_ms,
        "processIncoming",
        true,
    );
    to_jstring(&mut env, json)
}

/// `dev.dakflare.simulator.bridge.NativeBridge.queueOutbound`
///
/// Queues one SMS typed on this phone before the radio is touched:
/// `{"ok":true,"local_id":"compose-…"}` or
/// `{"ok":false,"error":"bad_input"|"storage"}`. The returned id is what the
/// sender hands to the `SENT` broadcast so the row can reach `sent` or `failed`.
///
/// An identical send that is still `queued` resolves to the row that already
/// exists, so a double tap cannot create two rows for one send. The number and
/// the body are never logged.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_dakflare_simulator_bridge_NativeBridge_queueOutbound(
    mut env: JNIEnv,
    _class: JClass,
    app_dir: JString,
    device_id: JString,
    to: JString,
    body: JString,
) -> jstring {
    let json = queue_guarded(&mut env, &app_dir, &device_id, &to, &body);
    to_jstring(&mut env, json)
}

/// `dev.dakflare.simulator.bridge.NativeBridge.markOutbound`
///
/// Records what happened to a queued reply row:
/// `{"ok":true}` or `{"ok":false,"error":"bad_input"|"not_found"|"storage"}`.
/// Only `queued`, `sent` and `failed` are accepted; a `failed` row is not
/// mirrored until M5.5's retry flips it back to `queued`.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_dakflare_simulator_bridge_NativeBridge_markOutbound(
    mut env: JNIEnv,
    _class: JClass,
    app_dir: JString,
    device_id: JString,
    local_id: JString,
    state: JString,
) -> jstring {
    let json = mark_guarded(&mut env, &app_dir, &device_id, &local_id, &state);
    to_jstring(&mut env, json)
}

/// `dev.dakflare.simulator.bridge.NativeBridge.getDeviceFact`
///
/// Reads one whitelisted handset fact back. The receiver uses it for
/// `self_number`: a cold start cannot always read the phone number from the
/// radio yet, and the self-number guard must not silently switch itself off.
/// Returns `{"ok":true,"value":"…"|null}` or `{"ok":false,"error":"bad_input"|"storage"}`.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_dakflare_simulator_bridge_NativeBridge_getDeviceFact(
    mut env: JNIEnv,
    _class: JClass,
    app_dir: JString,
    key: JString,
) -> jstring {
    let json = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        match (java_string(&mut env, &app_dir), java_string(&mut env, &key)) {
            (Ok(app_dir), Ok(key)) => {
                if app_dir.is_empty() || !Path::new(&app_dir).is_absolute() {
                    return error_json("bad_input");
                }
                if !dakflare_core::is_device_fact_key(&key) {
                    return error_json("bad_input");
                }
                let value = open_store_blocking(&app_dir).and_then(|store| {
                    tauri::async_runtime::block_on(store.get_setting(&key))
                        .map_err(|_| "storage")
                });
                match value {
                    Ok(found) => serde_json::json!({ "ok": true, "value": found }).to_string(),
                    Err(code) => error_json(code),
                }
            }
            _ => error_json("bad_input"),
        }
    })) {
        Ok(json) => json,
        Err(_) => {
            eprintln!("[jni] getDeviceFact panicked");
            error_json("storage")
        }
    };
    to_jstring(&mut env, json)
}

/// `dev.dakflare.simulator.bridge.NativeBridge.setDeviceFact`
///
/// Persists one whitelisted handset fact (`self_number`, `sim_slot`,
/// `sim_carrier`, `permissions`, `battery_optimized`, `default_sms_app`):
/// `{"ok":true}` or `{"ok":false,"error":"bad_input"|"storage"}`. Neither the
/// key nor the value is ever logged.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_dakflare_simulator_bridge_NativeBridge_setDeviceFact(
    mut env: JNIEnv,
    _class: JClass,
    app_dir: JString,
    key: JString,
    value: JString,
) -> jstring {
    let json = fact_guarded(&mut env, &app_dir, &key, &value);
    to_jstring(&mut env, json)
}

/// `dev.dakflare.simulator.bridge.NativeBridge.flushPending`
///
/// Drains everything this deployment has not accepted yet — pending inbound
/// rows, their stored flow runs and unmirrored outbound rows — in one atomic
/// `upload_batch`. The receiver calls it once after its send loop. Returns
/// `{"ok":true,"inbound":<count>,"outbound":<count>}` or
/// `{"ok":false,"error":"bad_input"|"unpaired"|"storage"|"network"|"protocol"}`.
///
/// Best effort: a failed call leaves the rows pending, and the next call (or
/// the next `poll_device`) retries them.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_dakflare_simulator_bridge_NativeBridge_flushPending(
    mut env: JNIEnv,
    _class: JClass,
    app_dir: JString,
    device_id: JString,
) -> jstring {
    let json = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        match read_flush_inputs(&mut env, &app_dir, &device_id) {
            Ok((app_dir, device_id)) => {
                match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    flush_blocking(&app_dir, &device_id)
                })) {
                    Ok(Ok(flushed)) => serde_json::json!({
                        "ok": true,
                        "inbound": flushed.inbound,
                        "outbound": flushed.outbound,
                    })
                    .to_string(),
                    Ok(Err(code)) => error_json(code),
                    Err(_) => {
                        eprintln!("[jni] flushPending panicked in the core");
                        error_json("storage")
                    }
                }
            }
            Err(code) => error_json(code),
        }
    })) {
        Ok(json) => json,
        Err(_) => {
            eprintln!("[jni] flushPending panicked before storage");
            error_json("storage")
        }
    };
    to_jstring(&mut env, json)
}

/// Decode arguments, run the blocking call and render JSON. Both guards end as
/// the same `storage` error, so a panic can never unwind across JNI.
fn guarded(
    env: &mut JNIEnv,
    app_dir: &JString,
    sender: &JString,
    body: &JString,
    received_at_ms: i64,
    entry: &'static str,
    include_actions: bool,
) -> String {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        match read_inputs(env, app_dir, sender, body, received_at_ms) {
            Ok((app_dir, sender, body)) => {
                match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    incoming_blocking(&app_dir, &sender, &body, received_at_ms)
                })) {
                    Ok(Ok(outcome)) => {
                        // The core returns only the actions it just recorded, in
                        // flow order (a re-delivery records none and returns an
                        // empty list), so the position is the action index used
                        // to derive the deterministic outbound row id.
                        let actions: Option<Vec<serde_json::Value>> = include_actions.then(|| {
                            outcome
                                .actions
                                .iter()
                                .enumerate()
                                .map(|(index, action)| match action {
                                    Action::SendSms { to, body } => serde_json::json!({
                                        "to": to,
                                        "body": body,
                                        "local_id": reply_local_id(&outcome.local_id, index),
                                    }),
                                })
                                .collect()
                        });

                        let mut value = serde_json::json!({
                            "ok": true,
                            "device_id": outcome.device_id,
                            "local_id": outcome.local_id,
                        });
                        if let Some(actions) = actions {
                            value["actions"] = serde_json::Value::Array(actions);
                        }
                        value.to_string()
                    }
                    Ok(Err(code)) => error_json(code),
                    Err(_) => {
                        eprintln!("[jni] {entry} panicked in the core");
                        error_json("storage")
                    }
                }
            }
            Err(code) => error_json(code),
        }
    })) {
        Ok(json) => json,
        Err(_) => {
            eprintln!("[jni] {entry} panicked before storage");
            error_json("storage")
        }
    }
}

/// The state-mark path has the same two panic guards as the inbound path: a
/// panic must never cross JNI, and every result is JSON.
fn mark_guarded(
    env: &mut JNIEnv,
    app_dir: &JString,
    device_id: &JString,
    local_id: &JString,
    state: &JString,
) -> String {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        match read_mark_inputs(env, app_dir, device_id, local_id, state) {
            Ok((app_dir, device_id, local_id, state)) => {
                match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    mark_blocking(&app_dir, &device_id, &local_id, &state)
                })) {
                    Ok(Ok(true)) => serde_json::json!({ "ok": true }).to_string(),
                    // The id does not name an outbound row: a re-delivery with
                    // no reply, or a stale action. Honest no-op, not storage.
                    Ok(Ok(false)) => error_json("not_found"),
                    Ok(Err(code)) => error_json(code),
                    Err(_) => {
                        eprintln!("[jni] markOutbound panicked in the core");
                        error_json("storage")
                    }
                }
            }
            Err(code) => error_json(code),
        }
    })) {
        Ok(json) => json,
        Err(_) => {
            eprintln!("[jni] markOutbound panicked before storage");
            error_json("storage")
        }
    }
}

/// The fact setter follows the same two-guard shape as the message paths: no
/// panic crosses JNI and every result is JSON. A rejected key/value is
/// `bad_input` and never reaches the settings table.
fn fact_guarded(env: &mut JNIEnv, app_dir: &JString, key: &JString, value: &JString) -> String {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        match read_fact_inputs(env, app_dir, key, value) {
            Ok((app_dir, key, value)) => {
                match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    fact_blocking(&app_dir, &key, &value)
                })) {
                    Ok(Ok(())) => serde_json::json!({ "ok": true }).to_string(),
                    Ok(Err(code)) => error_json(code),
                    Err(_) => {
                        eprintln!("[jni] setDeviceFact panicked in the core");
                        error_json("storage")
                    }
                }
            }
            Err(code) => error_json(code),
        }
    })) {
        Ok(json) => json,
        Err(_) => {
            eprintln!("[jni] setDeviceFact panicked before storage");
            error_json("storage")
        }
    }
}

/// The compose queue path has the same two panic guards as every other entry:
/// no panic crosses JNI and every result is JSON. The recipient and body are
/// bounded here, so an oversized send never reaches the database.
fn queue_guarded(
    env: &mut JNIEnv,
    app_dir: &JString,
    device_id: &JString,
    to: &JString,
    body: &JString,
) -> String {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        match read_queue_inputs(env, app_dir, device_id, to, body) {
            Ok((app_dir, device_id, to, body)) => {
                match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    queue_blocking(&app_dir, &device_id, &to, &body)
                })) {
                    Ok(Ok(local_id)) => serde_json::json!({
                        "ok": true,
                        "local_id": local_id,
                    })
                    .to_string(),
                    Ok(Err(code)) => error_json(code),
                    Err(_) => {
                        eprintln!("[jni] queueOutbound panicked in the core");
                        error_json("storage")
                    }
                }
            }
            Err(code) => error_json(code),
        }
    })) {
        Ok(json) => json,
        Err(_) => {
            eprintln!("[jni] queueOutbound panicked before storage");
            error_json("storage")
        }
    }
}

fn to_jstring(env: &mut JNIEnv, json: String) -> jstring {
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

/// Decode and validate the state-mark arguments. Same rules as the inbound path:
/// copy the strings, bound their lengths, and never touch the database on bad
/// input. No value here is ever logged.
fn read_mark_inputs(
    env: &mut JNIEnv,
    app_dir: &JString,
    device_id: &JString,
    local_id: &JString,
    state: &JString,
) -> Result<(String, String, String, String), &'static str> {
    let app_dir = java_string(env, app_dir)?;
    let device_id = java_string(env, device_id)?;
    let local_id = java_string(env, local_id)?;
    let state = java_string(env, state)?;

    if app_dir.is_empty() || !Path::new(&app_dir).is_absolute() {
        return Err("bad_input");
    }
    if device_id.is_empty() || device_id.len() > MAX_DEVICE_ID_LEN {
        return Err("bad_input");
    }
    if local_id.is_empty() || local_id.len() > MAX_LOCAL_ID_LEN {
        return Err("bad_input");
    }
    if state.len() > MAX_STATE_LEN {
        return Err("bad_input");
    }

    Ok((app_dir, device_id, local_id, state))
}

/// Decode and validate the flush arguments. Same rules as the state-mark path:
/// copy the strings, bound their lengths, and never touch the database on bad
/// input.
fn read_flush_inputs(
    env: &mut JNIEnv,
    app_dir: &JString,
    device_id: &JString,
) -> Result<(String, String), &'static str> {
    let app_dir = java_string(env, app_dir)?;
    let device_id = java_string(env, device_id)?;

    if app_dir.is_empty() || !Path::new(&app_dir).is_absolute() {
        return Err("bad_input");
    }
    if device_id.is_empty() || device_id.len() > MAX_DEVICE_ID_LEN {
        return Err("bad_input");
    }

    Ok((app_dir, device_id))
}

/// Decode and validate one device fact. The key whitelist and the length cap
/// live in the core, so this path and any future caller share one rule.
fn read_fact_inputs(
    env: &mut JNIEnv,
    app_dir: &JString,
    key: &JString,
    value: &JString,
) -> Result<(String, String, String), &'static str> {
    let app_dir = java_string(env, app_dir)?;
    let key = java_string(env, key)?;
    let value = java_string(env, value)?;

    if app_dir.is_empty() || !Path::new(&app_dir).is_absolute() {
        return Err("bad_input");
    }
    if !is_device_fact_key(&key) || value.len() > MAX_DEVICE_FACT_LEN {
        return Err("bad_input");
    }

    Ok((app_dir, key, value))
}

/// Decode and validate one composed SMS. Same rules as every other entry: copy
/// the strings, bound their lengths, and never touch the database on bad input.
/// The body limit is counted in characters, matching what the sender checks, so
/// a Bangla message is not refused for being multi-byte in UTF-8.
fn read_queue_inputs(
    env: &mut JNIEnv,
    app_dir: &JString,
    device_id: &JString,
    to: &JString,
    body: &JString,
) -> Result<(String, String, String, String), &'static str> {
    let app_dir = java_string(env, app_dir)?;
    let device_id = java_string(env, device_id)?;
    let to = java_string(env, to)?;
    let body = java_string(env, body)?;

    if app_dir.is_empty() || !Path::new(&app_dir).is_absolute() {
        return Err("bad_input");
    }
    if device_id.is_empty() || device_id.len() > MAX_DEVICE_ID_LEN {
        return Err("bad_input");
    }
    if to.trim().is_empty() || to.len() > MAX_RECIPIENT_LEN {
        return Err("bad_input");
    }
    if body.trim().is_empty() || body.chars().count() > MAX_COMPOSE_BODY_LEN {
        return Err("bad_input");
    }

    Ok((app_dir, device_id, to, body))
}

fn java_string(env: &mut JNIEnv, value: &JString) -> Result<String, &'static str> {
    env.get_string(value)
        .map(Into::into)
        .map_err(|_| "bad_input")
}

struct IncomingOutcome {
    device_id: String,
    local_id: String,
    actions: Vec<Action>,
}

fn incoming_blocking(
    app_dir: &str,
    sender: &str,
    body: &str,
    received_at_ms: i64,
) -> Result<IncomingOutcome, &'static str> {
    let store = open_store_blocking(app_dir)?;

    // Tauri's global async runtime is initialized lazily, so this works in a
    // receiver process even though no Tauri application was built there.
    tauri::async_runtime::block_on(async {
        let (message, actions) = receive_and_reply(&store, None, sender, body, received_at_ms)
            .await
            .map_err(map_carrier_error)?;
        Ok(IncomingOutcome {
            device_id: message.device_id,
            local_id: message.local_id.unwrap_or_default(),
            actions,
        })
    })
}

/// The one place a receiver opens the store. Both the inbound and the state
/// mark path use it, so they always resolve the same database file.
fn open_store_blocking(app_dir: &str) -> Result<Store, &'static str> {
    let dir = Path::new(app_dir);
    std::fs::create_dir_all(dir).map_err(|_| "storage")?;
    tauri::async_runtime::block_on(Store::open(dir.join(DB_FILE))).map_err(|_| "storage")
}

fn mark_blocking(
    app_dir: &str,
    device_id: &str,
    local_id: &str,
    state: &str,
) -> Result<bool, &'static str> {
    let store = open_store_blocking(app_dir)?;
    tauri::async_runtime::block_on(store.set_message_state_by_local_id(device_id, local_id, state))
        .map_err(map_store_error)
}

fn fact_blocking(app_dir: &str, key: &str, value: &str) -> Result<(), &'static str> {
    let store = open_store_blocking(app_dir)?;
    tauri::async_runtime::block_on(store.set_device_fact(key, value)).map_err(map_store_error)
}

/// Queue one composed SMS. An unknown device is `bad_input`: the command checks
/// the pairing first, so a row created against a deleted device is never right.
fn queue_blocking(
    app_dir: &str,
    device_id: &str,
    to: &str,
    body: &str,
) -> Result<String, &'static str> {
    let store = open_store_blocking(app_dir)?;
    tauri::async_runtime::block_on(async {
        store
            .get_device(device_id)
            .await
            .map_err(|_| "storage")?
            .ok_or("bad_input")?;
        store
            .queue_composed_outbound(device_id, to, body)
            .await
            .map_err(map_store_error)
    })
}

/// Build the same signed client the app uses from the stored target and
/// identity, then flush the pending inbound and outbound rows. A missing
/// pairing or key is `unpaired`; a missing or invalid target is `storage`.
fn flush_blocking(app_dir: &str, device_id: &str) -> Result<Flushed, &'static str> {
    let store = open_store_blocking(app_dir)?;

    tauri::async_runtime::block_on(async {
        let base_url = store
            .get_setting("base_url")
            .await
            .map_err(|_| "storage")?
            .filter(|value| !value.trim().is_empty())
            .ok_or("storage")?;
        let admin_token = store
            .get_setting("admin_token")
            .await
            .map_err(|_| "storage")?
            .filter(|value| !value.trim().is_empty());

        store
            .get_device(device_id)
            .await
            .map_err(|_| "storage")?
            .ok_or("unpaired")?;
        let private_key = store
            .private_key(device_id)
            .await
            .map_err(|_| "storage")?
            .ok_or("unpaired")?;

        let target = Target::new(base_url, admin_token).map_err(|_| "storage")?;
        let client = DeviceClient::new(target, device_id, private_key);

        flush_pending(&store, &client, device_id)
            .await
            .map_err(map_flush_error)
    })
}

fn map_carrier_error(error: CarrierError) -> &'static str {
    match error {
        CarrierError::Unpaired => "unpaired",
        CarrierError::InvalidInput(_) => "bad_input",
        CarrierError::Store(_) | CarrierError::Protocol(_) => "storage",
    }
}

/// The flush path can fail on the wire, which is not a store problem. Only a
/// transport or URL failure is `network`; a signing or response-shape failure
/// is `protocol`.
fn map_flush_error(error: CarrierError) -> &'static str {
    match error {
        CarrierError::Unpaired => "unpaired",
        CarrierError::InvalidInput(_) => "bad_input",
        CarrierError::Store(_) => "storage",
        CarrierError::Protocol(ProtocolError::Http(_) | ProtocolError::Url(_)) => "network",
        CarrierError::Protocol(_) => "protocol",
    }
}

fn map_store_error(error: StoreError) -> &'static str {
    match error {
        StoreError::InvalidState(_) => "bad_input",
        StoreError::InvalidDeviceId(_) => "bad_input",
        StoreError::InvalidFact(_) => "bad_input",
        StoreError::Database(_) | StoreError::Corrupt(_) | StoreError::Clock => "storage",
    }
}

fn error_json(code: &'static str) -> String {
    serde_json::json!({ "ok": false, "error": code }).to_string()
}
