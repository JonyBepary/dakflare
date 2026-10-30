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
    StoreError, Target,
    carrier::{drain_outbox, flush_pending},
    is_device_fact_key, receive_and_reply, reply_local_id, sync_flows,
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
/// `queued`, `sent`, `failed` and `delivered` are accepted; `delivered` may only
/// follow `sent` (a direct delivery mark on a queued row is refused, use
/// `markDelivered` for a real carrier report). A `failed` row is not mirrored
/// until M5.5's retry flips it back to `queued`.
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

/// `dev.dakflare.simulator.bridge.NativeBridge.markDelivered`
///
/// Marks a reply row `delivered` from a carrier delivery report:
/// `{"ok":true}` or `{"ok":false,"error":"bad_input"|"not_found"|"storage"}`.
///
/// A delivery report is the one caller allowed to promote a row that is still
/// `queued` (the report arrived before the `SENT` broadcast); the core writes
/// `sent` then `delivered` in one transaction. A `failed` row is refused.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_dakflare_simulator_bridge_NativeBridge_markDelivered(
    mut env: JNIEnv,
    _class: JClass,
    app_dir: JString,
    device_id: JString,
    local_id: JString,
) -> jstring {
    let json = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        match read_local_id_inputs(&mut env, &app_dir, &device_id, &local_id) {
            Ok((app_dir, device_id, local_id)) => {
                match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    mark_delivered_blocking(&app_dir, &device_id, &local_id)
                })) {
                    Ok(Ok(true)) => serde_json::json!({ "ok": true }).to_string(),
                    // Missing row or a row the radio already failed: an honest
                    // no-op, not a storage fault.
                    Ok(Ok(false)) => error_json("not_found"),
                    Ok(Err(code)) => error_json(code),
                    Err(_) => {
                        eprintln!("[jni] markDelivered panicked in the core");
                        error_json("storage")
                    }
                }
            }
            Err(code) => error_json(code),
        }
    })) {
        Ok(json) => json,
        Err(_) => {
            eprintln!("[jni] markDelivered panicked before storage");
            error_json("storage")
        }
    };
    to_jstring(&mut env, json)
}

/// `dev.dakflare.simulator.bridge.NativeBridge.recordTransientFailure`
///
/// Records one radio failure that is worth retrying (`RADIO_OFF` or
/// `NO_SERVICE`). The core puts the row back to `queued` and spends one attempt,
/// or turns it `failed` once the third attempt is spent. Returns
/// `{"ok":true,"state":"queued"|"failed","attempts":<n>}` or
/// `{"ok":false,"error":"bad_input"|"not_found"|"storage"}`.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_dakflare_simulator_bridge_NativeBridge_recordTransientFailure(
    mut env: JNIEnv,
    _class: JClass,
    app_dir: JString,
    device_id: JString,
    local_id: JString,
) -> jstring {
    let json = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        match read_local_id_inputs(&mut env, &app_dir, &device_id, &local_id) {
            Ok((app_dir, device_id, local_id)) => {
                match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    record_transient_failure_blocking(&app_dir, &device_id, &local_id)
                })) {
                    Ok(Ok(Some(outcome))) => serde_json::json!({
                        "ok": true,
                        "state": outcome.state,
                        "attempts": outcome.attempts,
                    })
                    .to_string(),
                    // A late report against a row that already left `queued`
                    // is a no-op, not a new failure.
                    Ok(Ok(None)) => error_json("not_found"),
                    Ok(Err(code)) => error_json(code),
                    Err(_) => {
                        eprintln!("[jni] recordTransientFailure panicked in the core");
                        error_json("storage")
                    }
                }
            }
            Err(code) => error_json(code),
        }
    })) {
        Ok(json) => json,
        Err(_) => {
            eprintln!("[jni] recordTransientFailure panicked before storage");
            error_json("storage")
        }
    };
    to_jstring(&mut env, json)
}

/// `dev.dakflare.simulator.bridge.NativeBridge.retryableOutbound`
///
/// Lists the local ids the gateway tick may retry (queued, fewer than three
/// attempts, older than 60 s): `{"ok":true,"local_ids":["…"]}` or
/// `{"ok":false,"error":"bad_input"|"storage"}`. Only ids cross this boundary;
/// the body and recipient are read back from the stored row before a re-send.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_dakflare_simulator_bridge_NativeBridge_retryableOutbound(
    mut env: JNIEnv,
    _class: JClass,
    app_dir: JString,
    device_id: JString,
) -> jstring {
    let json = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        match read_flush_inputs(&mut env, &app_dir, &device_id) {
            Ok((app_dir, device_id)) => {
                match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    retryable_blocking(&app_dir, &device_id)
                })) {
                    Ok(Ok(local_ids)) => serde_json::json!({
                        "ok": true,
                        "local_ids": local_ids,
                    })
                    .to_string(),
                    Ok(Err(code)) => error_json(code),
                    Err(_) => {
                        eprintln!("[jni] retryableOutbound panicked in the core");
                        error_json("storage")
                    }
                }
            }
            Err(code) => error_json(code),
        }
    })) {
        Ok(json) => json,
        Err(_) => {
            eprintln!("[jni] retryableOutbound panicked before storage");
            error_json("storage")
        }
    };
    to_jstring(&mut env, json)
}

/// `dev.dakflare.simulator.bridge.NativeBridge.resendOutbound`
///
/// Reads the stored row a retry may send. It takes only the row's `local_id`:
/// the recipient, body and SIM slot come back from the store, so they never
/// cross the JNI boundary as arguments. Kotlin owns the `SmsManager` call; this
/// entry is the one place the retry reads its payload from.
///
/// Returns `{"ok":true,"peer":"…","body":"…","sim_slot":<n>}` or
/// `{"ok":false,"error":"bad_input"|"not_found"|"storage"}`. A row that is no
/// longer `queued` is `not_found`, so a stale id cannot re-send a finished row.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_dakflare_simulator_bridge_NativeBridge_resendOutbound(
    mut env: JNIEnv,
    _class: JClass,
    app_dir: JString,
    device_id: JString,
    local_id: JString,
) -> jstring {
    let json = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        match read_local_id_inputs(&mut env, &app_dir, &device_id, &local_id) {
            Ok((app_dir, device_id, local_id)) => {
                match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    retry_row_blocking(&app_dir, &device_id, &local_id)
                })) {
                    Ok(Ok(Some(row))) => serde_json::json!({
                        "ok": true,
                        "peer": row.peer,
                        "body": row.body,
                        "sim_slot": row.sim_slot,
                    })
                    .to_string(),
                    Ok(Ok(None)) => error_json("not_found"),
                    Ok(Err(code)) => error_json(code),
                    Err(_) => {
                        eprintln!("[jni] resendOutbound panicked in the core");
                        error_json("storage")
                    }
                }
            }
            Err(code) => error_json(code),
        }
    })) {
        Ok(json) => json,
        Err(_) => {
            eprintln!("[jni] resendOutbound panicked before storage");
            error_json("storage")
        }
    };
    to_jstring(&mut env, json)
}

/// `dev.dakflare.simulator.bridge.NativeBridge.checkSend`
///
/// The one recipient/body policy, so Kotlin cannot drift from Rust or from the
/// webview. Returns `{"ok":true}` or `{"ok":false,"error":"<sentence>"}` where
/// the sentence is the one the UI already shows. No number or body is logged.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_dakflare_simulator_bridge_NativeBridge_checkSend(
    mut env: JNIEnv,
    _class: JClass,
    to: JString,
    body: JString,
) -> jstring {
    let json = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        match (java_string(&mut env, &to), java_string(&mut env, &body)) {
            (Ok(to), Ok(body)) => match dakflare_core::check_send(&to, &body) {
                Ok(_) => serde_json::json!({ "ok": true }).to_string(),
                Err(problem) => serde_json::json!({
                    "ok": false,
                    "error": problem.sentence(),
                })
                .to_string(),
            },
            _ => error_json("bad_input"),
        }
    })) {
        Ok(json) => json,
        Err(_) => error_json("storage"),
    };
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

/// `dev.dakflare.simulator.bridge.NativeBridge.messageByLocalId`
///
/// Reads one stored message by its deterministic local id. The `SENT` receipt
/// carries only ids, so the status receiver uses this to recover the address,
/// body and timestamp for the system provider's Sent row:
/// `{"ok":true,"peer":"…","body":"…","created_at":<ms>}` or
/// `{"ok":false,"error":"bad_input"|"not_found"|"storage"}`.
///
/// The body crosses JNI because the caller must write it; it is never logged.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_dakflare_simulator_bridge_NativeBridge_messageByLocalId(
    mut env: JNIEnv,
    _class: JClass,
    app_dir: JString,
    device_id: JString,
    local_id: JString,
) -> jstring {
    let json = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        match (
            java_string(&mut env, &app_dir),
            java_string(&mut env, &device_id),
            java_string(&mut env, &local_id),
        ) {
            (Ok(app_dir), Ok(device_id), Ok(local_id)) => {
                if app_dir.is_empty() || !Path::new(&app_dir).is_absolute() {
                    return error_json("bad_input");
                }
                if device_id.is_empty() || device_id.len() > MAX_DEVICE_ID_LEN {
                    return error_json("bad_input");
                }
                if local_id.is_empty() || local_id.len() > MAX_LOCAL_ID_LEN {
                    return error_json("bad_input");
                }

                let found = open_store_blocking(&app_dir).and_then(|store| {
                    tauri::async_runtime::block_on(store.message_by_local_id(&device_id, &local_id))
                        .map_err(map_store_error)
                });
                match found {
                    Ok(Some(message)) => serde_json::json!({
                        "ok": true,
                        "peer": message.peer,
                        "body": message.body,
                        "created_at": message.created_at,
                    })
                    .to_string(),
                    Ok(None) => error_json("not_found"),
                    Err(code) => error_json(code),
                }
            }
            _ => error_json("bad_input"),
        }
    })) {
        Ok(json) => json,
        Err(_) => {
            eprintln!("[jni] messageByLocalId panicked");
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

/// `dev.dakflare.simulator.bridge.NativeBridge.drainOutbox`
///
/// Fetches the deployment's queued commands and records them locally as
/// `queued` outbound rows. Returns `{"ok":true,"captured":["out-…"]}` or
/// `{"ok":false,"error":"bad_input"|"unpaired"|"storage"|"network"|"protocol"}`.
///
/// The ids are what the gateway tick hands to the radio. This call never sends:
/// an id here means "the phone holds it", not "the phone sent it".
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_dakflare_simulator_bridge_NativeBridge_drainOutbox(
    mut env: JNIEnv,
    _class: JClass,
    app_dir: JString,
    device_id: JString,
) -> jstring {
    let json = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        match read_flush_inputs(&mut env, &app_dir, &device_id) {
            Ok((app_dir, device_id)) => {
                match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    drain_blocking(&app_dir, &device_id)
                })) {
                    Ok(Ok(captured)) => serde_json::json!({
                        "ok": true,
                        "captured": captured,
                    })
                    .to_string(),
                    Ok(Err(code)) => error_json(code),
                    Err(_) => {
                        eprintln!("[jni] drainOutbox panicked in the core");
                        error_json("storage")
                    }
                }
            }
            Err(code) => error_json(code),
        }
    })) {
        Ok(json) => json,
        Err(_) => {
            eprintln!("[jni] drainOutbox panicked before storage");
            error_json("storage")
        }
    };
    to_jstring(&mut env, json)
}

/// `dev.dakflare.simulator.bridge.NativeBridge.syncFlows`
///
/// Replaces the cached flow set with this deployment's current set. The gateway
/// service calls it in the same tick as its flush, so a Worker-side edit reaches
/// a phone the operator never touches. Returns
/// `{"ok":true,"flows":<count>}` or
/// `{"ok":false,"error":"bad_input"|"unpaired"|"storage"|"network"|"protocol"}`.
///
/// Best effort: on failure the previous cache stays in place and the next tick
/// retries. An empty list is success and clears the cache.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_dakflare_simulator_bridge_NativeBridge_syncFlows(
    mut env: JNIEnv,
    _class: JClass,
    app_dir: JString,
    device_id: JString,
) -> jstring {
    let json = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        match read_flush_inputs(&mut env, &app_dir, &device_id) {
            Ok((app_dir, device_id)) => {
                match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    sync_flows_blocking(&app_dir, &device_id)
                })) {
                    Ok(Ok(count)) => serde_json::json!({
                        "ok": true,
                        "flows": count,
                    })
                    .to_string(),
                    Ok(Err(code)) => error_json(code),
                    Err(_) => {
                        eprintln!("[jni] syncFlows panicked in the core");
                        error_json("storage")
                    }
                }
            }
            Err(code) => error_json(code),
        }
    })) {
        Ok(json) => json,
        Err(_) => {
            eprintln!("[jni] syncFlows panicked before storage");
            error_json("storage")
        }
    };
    to_jstring(&mut env, json)
}

/// `dev.dakflare.simulator.bridge.NativeBridge.hasIdentity`
///
/// Reports the paired identity in this store:
/// `{"ok":true,"device_id":"…"}` or
/// `{"ok":false,"error":"bad_input"|"unpaired"|"storage"}`.
///
/// The gateway service needs the id to flush, while the boot receiver and the
/// UI only need yes/no; one call answers both. A device row without a private
/// key is not a usable identity and is reported as `unpaired`.
#[unsafe(no_mangle)]
pub extern "system" fn Java_dev_dakflare_simulator_bridge_NativeBridge_hasIdentity(
    mut env: JNIEnv,
    _class: JClass,
    app_dir: JString,
) -> jstring {
    let json = match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        match java_string(&mut env, &app_dir) {
            Ok(app_dir) => {
                if app_dir.is_empty() || !Path::new(&app_dir).is_absolute() {
                    return error_json("bad_input");
                }

                let identity = open_store_blocking(&app_dir).and_then(|store| {
                    tauri::async_runtime::block_on(async {
                        let Some(device) =
                            store.latest_device().await.map_err(|_| "storage")?
                        else {
                            return Err("unpaired");
                        };
                        let key = store
                            .private_key(&device.device_id)
                            .await
                            .map_err(map_store_error)?;
                        if key.is_none() {
                            return Err("unpaired");
                        }
                        Ok::<String, &'static str>(device.device_id)
                    })
                });

                match identity {
                    Ok(device_id) => serde_json::json!({
                        "ok": true,
                        "device_id": device_id,
                    })
                    .to_string(),
                    Err(code) => error_json(code),
                }
            }
            Err(code) => error_json(code),
        }
    })) {
        Ok(json) => json,
        Err(_) => {
            eprintln!("[jni] hasIdentity panicked");
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

/// Decode and validate a local id that identifies a stored outbound row. Same
/// bounds as the state-mark path, minus the state string. No value is logged.
fn read_local_id_inputs(
    env: &mut JNIEnv,
    app_dir: &JString,
    device_id: &JString,
    local_id: &JString,
) -> Result<(String, String, String), &'static str> {
    let app_dir = java_string(env, app_dir)?;
    let device_id = java_string(env, device_id)?;
    let local_id = java_string(env, local_id)?;

    if app_dir.is_empty() || !Path::new(&app_dir).is_absolute() {
        return Err("bad_input");
    }
    if device_id.is_empty() || device_id.len() > MAX_DEVICE_ID_LEN {
        return Err("bad_input");
    }
    if local_id.is_empty() || local_id.len() > MAX_LOCAL_ID_LEN {
        return Err("bad_input");
    }

    Ok((app_dir, device_id, local_id))
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
///
/// The Keystore cipher is installed here too: this is the coldest entry point in
/// the app (a broadcast with no Activity), and an identity stored by an older
/// build is wrapped before the caller can sign with it.
fn open_store_blocking(app_dir: &str) -> Result<Store, &'static str> {
    let dir = Path::new(app_dir);
    std::fs::create_dir_all(dir).map_err(|_| "storage")?;
    tauri::async_runtime::block_on(Store::open_with_cipher(
        dir.join(DB_FILE),
        std::sync::Arc::new(crate::vault::JniKeyCipher),
    ))
    .map_err(|_| "storage")
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

fn mark_delivered_blocking(
    app_dir: &str,
    device_id: &str,
    local_id: &str,
) -> Result<bool, &'static str> {
    let store = open_store_blocking(app_dir)?;
    tauri::async_runtime::block_on(store.mark_delivered_by_local_id(device_id, local_id))
        .map_err(map_store_error)
}

fn record_transient_failure_blocking(
    app_dir: &str,
    device_id: &str,
    local_id: &str,
) -> Result<Option<dakflare_core::SendFailureOutcome>, &'static str> {
    let store = open_store_blocking(app_dir)?;
    tauri::async_runtime::block_on(store.record_send_failure_by_local_id(
        device_id, local_id, true,
    ))
    .map_err(map_store_error)
}

fn retryable_blocking(app_dir: &str, device_id: &str) -> Result<Vec<String>, &'static str> {
    let store = open_store_blocking(app_dir)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .map_err(|_| "storage")?;
    tauri::async_runtime::block_on(store.list_retryable_outbound(device_id, now, 10))
        .map(|messages| messages.into_iter().filter_map(|message| message.local_id).collect())
        .map_err(map_store_error)
}

struct RetryRow {
    peer: String,
    body: String,
    sim_slot: i64,
}

/// Load one retry row from the store. Only a still-`queued` outbound row is
/// eligible: a sent, delivered or failed row must not be re-sent by a stale id.
fn retry_row_blocking(
    app_dir: &str,
    device_id: &str,
    local_id: &str,
) -> Result<Option<RetryRow>, &'static str> {
    let store = open_store_blocking(app_dir)?;
    tauri::async_runtime::block_on(async {
        let Some(message) = store
            .message_by_local_id(device_id, local_id)
            .await
            .map_err(|_| "storage")?
        else {
            return Ok(None);
        };
        if message.direction != "out" || message.state != "queued" {
            return Ok(None);
        }
        let sim_slot = store
            .get_setting("sim_slot")
            .await
            .map_err(|_| "storage")?
            .and_then(|value| value.trim().parse::<i64>().ok())
            .unwrap_or(0);

        Ok(Some(RetryRow {
            peer: message.peer,
            body: message.body,
            sim_slot,
        }))
    })
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
/// identity. A missing pairing or key is `unpaired`; a missing or invalid
/// target is `storage`. Shared by the flush and flow-sync entries so both
/// always talk to the same deployment as the same identity.
fn signed_client_blocking(store: &Store, device_id: &str) -> Result<DeviceClient, &'static str> {
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
            .map_err(map_store_error)?
            .ok_or("unpaired")?;

        let target = Target::new(base_url, admin_token).map_err(|_| "storage")?;
        Ok(DeviceClient::new(target, device_id, private_key))
    })
}

/// Flush everything the deployment has not accepted yet.
fn flush_blocking(app_dir: &str, device_id: &str) -> Result<Flushed, &'static str> {
    let store = open_store_blocking(app_dir)?;
    let client = signed_client_blocking(&store, device_id)?;

    let flushed = tauri::async_runtime::block_on(flush_pending(&store, &client, device_id))
        .map_err(map_network_error)?;
    // An empty queue returns without touching the network, so only a real upload
    // is contact. This is the background path that keeps `last_contact` fresh
    // while the webview is closed.
    if flushed.inbound > 0 || flushed.outbound > 0 {
        record_contact_blocking(&store, device_id);
    }
    Ok(flushed)
}

/// Collect every command the deployment has queued for this device.
///
/// `drain_outbox` records each one as a local `queued` row and acknowledges it,
/// so the Worker stops redelivering it; it does not touch the radio. The caller
/// hands the returned local ids to `SmsSender`, which is the only path allowed
/// to mark a row `sent`.
fn drain_blocking(app_dir: &str, device_id: &str) -> Result<Vec<String>, &'static str> {
    let store = open_store_blocking(app_dir)?;
    let client = signed_client_blocking(&store, device_id)?;

    let captured = tauri::async_runtime::block_on(drain_outbox(&store, &client, device_id))
        .map_err(map_network_error)?;
    // A poll is answered even when it carries no commands, so the answer itself
    // is contact. This is what keeps `last_seen` fresh while the webview is shut.
    record_contact_blocking(&store, device_id);

    Ok(captured.into_iter().filter_map(|message| message.local_id).collect())
}

/// Record that a signed request was answered. Mirrors `lib.rs::record_contact`;
/// this path runs without a Tauri `State`, so it takes the store directly.
fn record_contact_blocking(store: &Store, device_id: &str) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let _ = tauri::async_runtime::block_on(
        store.set_setting(&format!("last_contact:{device_id}"), &now.to_string()),
    );
}

/// Replace the cached flow set with this deployment's current set.
fn sync_flows_blocking(app_dir: &str, device_id: &str) -> Result<usize, &'static str> {
    let store = open_store_blocking(app_dir)?;
    let client = signed_client_blocking(&store, device_id)?;

    tauri::async_runtime::block_on(sync_flows(&store, &client)).map_err(map_network_error)
}

fn map_carrier_error(error: CarrierError) -> &'static str {
    match error {
        CarrierError::Unpaired => "unpaired",
        CarrierError::InvalidInput(_) => "bad_input",
        CarrierError::Store(StoreError::KeyLocked) => "locked",
        CarrierError::Store(_) | CarrierError::Protocol(_) => "storage",
    }
}

/// The network paths (flush and flow sync) can fail on the wire, which is not a
/// store problem. Only a transport or URL failure is `network`; a signing or
/// response-shape failure is `protocol`.
fn map_network_error(error: CarrierError) -> &'static str {
    match error {
        CarrierError::Unpaired => "unpaired",
        CarrierError::InvalidInput(_) => "bad_input",
        CarrierError::Store(StoreError::KeyLocked) => "locked",
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
        // A wrapped key without its wrapping key (or a blob that does not
        // authenticate). Distinct from `unpaired` so the log names the real
        // reason, and never retried as a network fault.
        StoreError::KeyLocked => "locked",
        StoreError::Vault(_) => "storage",
        StoreError::Database(_) | StoreError::Corrupt(_) | StoreError::Clock => "storage",
    }
}

fn error_json(code: &'static str) -> String {
    // `locked` carries the sentence the phone must show, so Kotlin can log the
    // real reason without inventing one. Everything else stays a bare code.
    if code == "locked" {
        return serde_json::json!({
            "ok": false,
            "error": code,
            "message": dakflare_core::UNLOCK_ERROR,
        })
        .to_string();
    }
    serde_json::json!({ "ok": false, "error": code }).to_string()
}
