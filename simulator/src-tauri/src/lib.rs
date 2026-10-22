//! Tauri shell for the DakFlare device simulator.
//!
//! Everything interesting lives in `dakflare-core`: identity, the libSQL store and
//! the protocol client. This file owns the app lifecycle and the command surface
//! the webview calls.

use std::sync::Arc;

use dakflare_core::{
    Device, DeviceClient, Message, NewDevice, ProtocolError, Store, Target, drain_outbox,
    inject_inbound, parse_pair_link,
};
use serde::Serialize;
use tauri::{Manager, State};

struct AppState {
    store: Arc<Store>,
}

#[derive(Serialize)]
struct TargetView {
    base_url: Option<String>,
    has_admin_token: bool,
}

async fn load_target(state: &AppState) -> Result<Target, String> {
    let base_url = state
        .store
        .get_setting("base_url")
        .await
        .map_err(|e| e.to_string())?
        .filter(|v| !v.trim().is_empty())
        .ok_or("No target URL configured. Set one in Target first.")?;

    let token = state
        .store
        .get_setting("admin_token")
        .await
        .map_err(|e| e.to_string())?
        .filter(|v| !v.trim().is_empty());

    Target::new(base_url, token).map_err(|e| e.to_string())
}

async fn client_for(state: &AppState, device_id: &str) -> Result<(DeviceClient, Device), String> {
    let target = load_target(state).await?;
    let device = state
        .store
        .get_device(device_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("Unknown device")?;
    let private_key = state
        .store
        .private_key(device_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("Device has no private key")?;

    Ok((
        DeviceClient::new(target, device.device_id.clone(), private_key),
        device,
    ))
}

/* ---------------------------------------------------------------- target */

#[tauri::command]
async fn get_target(state: State<'_, AppState>) -> Result<TargetView, String> {
    let base_url = state
        .store
        .get_setting("base_url")
        .await
        .map_err(|e| e.to_string())?;
    let token = state
        .store
        .get_setting("admin_token")
        .await
        .map_err(|e| e.to_string())?;

    Ok(TargetView {
        base_url,
        has_admin_token: token.map(|t| !t.is_empty()).unwrap_or(false),
    })
}

#[tauri::command]
async fn save_target(
    state: State<'_, AppState>,
    base_url: String,
    admin_token: Option<String>,
) -> Result<(), String> {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("Target URL is required".into());
    }
    // Validate shape before storing, so a typo fails here rather than at pairing.
    Target::new(trimmed, None).map_err(|e| e.to_string())?;

    state
        .store
        .set_setting("base_url", trimmed)
        .await
        .map_err(|e| e.to_string())?;

    if let Some(token) = admin_token.filter(|t| !t.trim().is_empty()) {
        state
            .store
            .set_setting("admin_token", token.trim())
            .await
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

/* ---------------------------------------------------------------- devices */

#[tauri::command]
async fn list_devices(state: State<'_, AppState>) -> Result<Vec<Device>, String> {
    state.store.list_devices().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn create_device(
    state: State<'_, AppState>,
    label: String,
    platform_id: Option<String>,
    carrier: Option<String>,
    sim_slot: Option<i64>,
) -> Result<Device, String> {
    let label = label.trim();
    if label.is_empty() {
        return Err("label is required".into());
    }

    let platform_id = platform_id.filter(|v| !v.trim().is_empty());
    let carrier = carrier.filter(|v| !v.trim().is_empty());

    let (device, _identity) = state
        .store
        .create_device(NewDevice {
            label,
            platform: "simulator",
            platform_id: platform_id.as_deref(),
            carrier: carrier.as_deref(),
            sim_slot: sim_slot.unwrap_or(0),
        })
        .await
        .map_err(|e| e.to_string())?;

    Ok(device)
}

#[tauri::command]
async fn delete_device(state: State<'_, AppState>, device_id: String) -> Result<bool, String> {
    state
        .store
        .delete_device(&device_id)
        .await
        .map_err(|e| e.to_string())
}

/* --------------------------------------------------------------- protocol */

/// Mint an enrolment code with the admin token and pair this device with it.
///
/// Lab-only self-pairing: it exists so a simulator device can be enrolled
/// without a dashboard. Real onboarding redeems an operator's code with
/// [`pair_with_code`].
#[tauri::command]
async fn pair_device(
    state: State<'_, AppState>,
    device_id: String,
    ttl_ms: Option<u64>,
) -> Result<String, String> {
    let (client, device) = client_for(&state, &device_id).await?;
    let code = client
        .mint_pairing_code(ttl_ms.unwrap_or(120_000))
        .await
        .map_err(|e| e.to_string())?;
    client
        .pair(&code, &device.public_key_spki)
        .await
        .map_err(|e| e.to_string())?;
    Ok(format!("Paired as {}", device.device_id))
}

/// Redeem an operator-minted pairing code. No admin token is read or required.
///
/// `code` is either the bare 12-character code or a
/// `dakflare://pair?u=<worker-url>&c=<code>` link. When the link carries `u`,
/// that URL is validated and saved as the target *before* pairing, so pasting
/// the link is enough to onboard a fresh install.
///
/// The code is single-use server-side. A failure here leaves the local device
/// row untouched, so the user can retry with a freshly minted code.
#[tauri::command]
async fn pair_with_code(
    state: State<'_, AppState>,
    device_id: String,
    code: String,
) -> Result<String, String> {
    let link = parse_pair_link(&code).map_err(|e| e.to_string())?;

    if let Some(base_url) = link.base_url.as_deref() {
        let trimmed = base_url.trim().trim_end_matches('/');
        Target::new(trimmed, None)
            .map_err(|e| format!("The link's worker URL is not usable: {e}"))?;
        state
            .store
            .set_setting("base_url", trimmed)
            .await
            .map_err(|e| e.to_string())?;
    }

    // Both the target and the device key are enough: `pair` is authenticated by
    // the pairing code alone, so a token-less target must work here.
    let (client, device) = client_for(&state, &device_id).await?;
    client
        .pair(&link.code, &device.public_key_spki)
        .await
        .map_err(pair_failure)?;
    Ok(format!("Paired as {}", device.device_id))
}

/// Translate the protocol error into something a person can act on.
///
/// Deliberately never includes the code (it is single-use) or the admin token.
fn pair_failure(error: ProtocolError) -> String {
    match error {
        ProtocolError::Status {
            status: 401, body, ..
        } => format!(
            "That code was not accepted. It may have expired, already been used, or belong to \
             another device. Mint a new code in the dashboard and try again. ({body})"
        ),
        ProtocolError::Status { status: 409, .. } => {
            "This device is already registered. Ask the operator for a rotation code, or revoke \
             the device first."
                .into()
        }
        ProtocolError::Status { status: 429, .. } => {
            "Too many pairing attempts. Wait a minute, then try again.".into()
        }
        ProtocolError::Http(error) => format!(
            "Could not reach the worker: {error}. Check the target URL and the connection, then \
             retry."
        ),
        other => other.to_string(),
    }
}

/// One signed poll; returns the queued commands.
#[tauri::command]
async fn poll_device(
    state: State<'_, AppState>,
    device_id: String,
) -> Result<serde_json::Value, String> {
    let (client, _device) = client_for(&state, &device_id).await?;
    client.poll(&[]).await.map_err(|e| e.to_string())
}

/// Test-cleanup: erase this device's message log on the deployment.
#[tauri::command]
async fn purge_messages(state: State<'_, AppState>, device_id: String) -> Result<u64, String> {
    let (client, _device) = client_for(&state, &device_id).await?;
    client.purge_messages().await.map_err(|e| e.to_string())
}

/// Revoke the device server-side (D1 + its Durable Object).
#[tauri::command]
async fn revoke_device(state: State<'_, AppState>, device_id: String) -> Result<(), String> {
    let (client, _device) = client_for(&state, &device_id).await?;
    client.revoke().await.map_err(|e| e.to_string())
}

/* ---------------------------------------------------------------- carrier */

/// "Receive" one SMS: record it locally, then upload when online.
#[tauri::command]
async fn carrier_inject(
    state: State<'_, AppState>,
    device_id: String,
    sender: String,
    body: String,
) -> Result<serde_json::Value, String> {
    let offline = state
        .store
        .is_offline(&device_id)
        .await
        .map_err(|e| e.to_string())?;

    let client = if offline {
        None
    } else {
        Some(client_for(&state, &device_id).await?.0)
    };

    // Device-first: pull this device's flows and run them here, before upload.
    // An empty list (or a sync failure) simply leaves the Worker as the engine.
    let flows = match client.as_ref() {
        Some(client) => match client.fetch_flows().await {
            Ok(flows) => Some(flows),
            Err(error) => {
                eprintln!("[carrier] flow sync failed: {error}");
                None
            }
        },
        None => None,
    };

    let result = inject_inbound(
        state.store.as_ref(),
        client.as_ref(),
        &device_id,
        &sender,
        &body,
        offline,
        flows.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())?;

    Ok(serde_json::json!({
        "uploaded": result.uploaded,
        "accepted": result.accepted,
        "duplicates": result.duplicates,
        "message_id": result.message.id,
        "state": result.message.state,
        "device_sent": result.device_sent,
        "fallback": result.fallback,
    }))
}

/// Poll the Worker and capture every queued command as an outbound message.
#[tauri::command]
async fn carrier_drain(
    state: State<'_, AppState>,
    device_id: String,
) -> Result<Vec<Message>, String> {
    if state
        .store
        .is_offline(&device_id)
        .await
        .map_err(|e| e.to_string())?
    {
        return Err("Device is offline. Turn the carrier back on to poll.".into());
    }

    let (client, _device) = client_for(&state, &device_id).await?;
    drain_outbox(state.store.as_ref(), &client, &device_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_messages(
    state: State<'_, AppState>,
    device_id: String,
    limit: Option<i64>,
) -> Result<Vec<Message>, String> {
    state
        .store
        .list_messages(&device_id, limit.unwrap_or(100).clamp(1, 500))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn clear_messages(state: State<'_, AppState>, device_id: String) -> Result<u64, String> {
    state
        .store
        .clear_messages(&device_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_offline(
    state: State<'_, AppState>,
    device_id: String,
    offline: bool,
) -> Result<(), String> {
    state
        .store
        .set_offline(&device_id, offline)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_offline(state: State<'_, AppState>, device_id: String) -> Result<bool, String> {
    state
        .store
        .is_offline(&device_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn schema_version(state: State<'_, AppState>) -> Result<i64, String> {
    state
        .store
        .schema_version()
        .await
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let dir = app
                .path()
                .app_data_dir()
                .map_err(|e| std::io::Error::other(format!("no app data dir: {e}")))?;
            std::fs::create_dir_all(&dir)?;

            // Opening the store is async; setup runs before the event loop, so a
            // blocking open here is simpler than racing the UI against a lazy DB.
            let store = tauri::async_runtime::block_on(Store::open(dir.join("simulator.db")))
                .map_err(|e| {
                    std::io::Error::other(format!("could not open local database: {e}"))
                })?;

            app.manage(AppState {
                store: Arc::new(store),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_target,
            save_target,
            list_devices,
            create_device,
            delete_device,
            pair_device,
            pair_with_code,
            poll_device,
            purge_messages,
            revoke_device,
            carrier_inject,
            carrier_drain,
            list_messages,
            clear_messages,
            set_offline,
            get_offline,
            schema_version
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
