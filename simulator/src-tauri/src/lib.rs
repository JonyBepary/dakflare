//! Tauri shell for the DakFlare device app.
//!
//! Everything interesting lives in `dakflare-core`: identity, the libSQL store and
//! the protocol client. This file owns the app lifecycle and the command surface
//! the webview calls.

use std::sync::Arc;

use dakflare_core::{
    CachedFlow, Device, DeviceClient, DeviceFacts, FlowRunRow, Message, NewDevice, ProtocolError,
    Store, Target, carrier::flush_pending, drain_outbox, inject_inbound, parse_pair_link,
    sync_flows as sync_flows_core,
};
use serde::Serialize;
#[cfg(target_os = "android")]
use serde::Deserialize;
use tauri::{Manager, State};

/// Direct JNI surface for the Android `SmsReceiver`. Not compiled on desktop.
#[cfg(target_os = "android")]
mod android;

struct AppState {
    store: Arc<Store>,
}

#[derive(Serialize)]
struct TargetView {
    base_url: Option<String>,
    has_admin_token: bool,
}

#[derive(Serialize)]
struct MessagePage {
    messages: Vec<Message>,
    has_more: bool,
}

async fn load_target(state: &AppState) -> Result<Target, String> {
    let base_url = state
        .store
        .get_setting("base_url")
        .await
        .map_err(|e| e.to_string())?
        .filter(|v| !v.trim().is_empty())
        .ok_or("No target URL configured. Set the Worker URL in Target deployment first.")?;

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

/// The identity hints the device row already holds, in the shape the pair body
/// wants: the label when it is meaningful, and the SIM slot only when it is one
/// the contract permits (0–2). Unknown values become `None` / `null`, never a
/// fabricated default.
fn identity_hints(device: &Device) -> (Option<&str>, Option<i64>) {
    let label = (!device.label.trim().is_empty()).then_some(device.label.as_str());
    let sim_slot = (0..=2).contains(&device.sim_slot).then_some(device.sim_slot);
    (label, sim_slot)
}

/// Mint an enrolment code with the admin token and pair this device with it.
///
/// Lab-only self-pairing: it exists so a device identity can be enrolled
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
    let (label, sim_slot) = identity_hints(&device);
    client
        .pair_with_identity(&code, &device.public_key_spki, label, sim_slot)
        .await
        .map_err(|e| e.to_string())?;
    record_pairing(&state, &device.device_id).await;
    Ok(pairing_message(&state, &client, &device.device_id).await)
}

/// Pairing has already succeeded by the time this runs: the returned sentence
/// carries the flow-sync outcome, but a failure there never fails the pairing.
/// The first real contact (`poll_device`, the gateway tick) retries the sync.
async fn pairing_message(
    state: &State<'_, AppState>,
    client: &DeviceClient,
    device_id: &str,
) -> String {
    match sync_flows_core(&state.store, client).await {
        Ok(count) => format!("Paired as {device_id}. Cached {count} flow(s)."),
        Err(error) => {
            eprintln!("[pair] flow sync failed: {error}");
            format!("Paired as {device_id}. Flows will sync on the next contact.")
        }
    }
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
    let (label, sim_slot) = identity_hints(&device);
    client
        .pair_with_identity(&link.code, &device.public_key_spki, label, sim_slot)
        .await
        .map_err(pair_failure)?;
    record_pairing(&state, &device.device_id).await;
    Ok(pairing_message(&state, &client, &device.device_id).await)
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
    // A receiver can leave rows pending while offline; flush them before polling
    // so opening the app clears the backlog. Best effort.
    let _ = flush_pending(&state.store, &client, &device_id).await;
    // Opening the app is also a flow-sync trigger: a Worker-side edit must reach
    // the phone without an operator opening the carrier panel. Best effort, and
    // reported in the reply so the Flows frame can say a refresh failed.
    let flows = match sync_flows_core(&state.store, &client).await {
        Ok(count) => serde_json::json!({ "ok": true, "count": count }),
        Err(error) => {
            eprintln!("[poll] flow sync failed: {error}");
            serde_json::json!({ "ok": false, "error": error.to_string() })
        }
    };
    let commands = client.poll(&[]).await.map_err(|e| e.to_string())?;
    // Both calls above are signed and were answered, so this is a real contact.
    let _ = state.store.touch_device(&device_id).await;
    // A deployment that answers this identity has accepted it. That backfills the
    // pairing time for identities created before it was recorded, without
    // overwriting the original date on later polls.
    let key = format!("paired:{device_id}");
    if matches!(state.store.get_setting(&key).await, Ok(None)) {
        record_pairing(&state, &device_id).await;
    }
    Ok(serde_json::json!({ "commands": commands, "flows": flows }))
}

/// Pull the deployment's flow set for this device into the local cache.
///
/// The explicit "Sync now" trigger in the Flows frame. Returns the number of
/// cached flows; an error leaves the previous cache in place so the frame keeps
/// listing graphs this phone can still run.
#[tauri::command]
async fn sync_flows(state: State<'_, AppState>, device_id: String) -> Result<usize, String> {
    let (client, _device) = client_for(&state, &device_id).await?;
    sync_flows_core(&state.store, &client)
        .await
        .map_err(|e| e.to_string())
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

/// Remember when this identity was paired.
///
/// Nothing in the local schema records it: `devices` holds the identity, not the
/// handshake. The Device frame would otherwise have to say "not recorded" about
/// a phone that plainly is, so the one fact that matters is kept beside it.
async fn record_pairing(state: &State<'_, AppState>, device_id: &str) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let _ = state
        .store
        .set_setting(&format!("paired:{device_id}"), &now.to_string())
        .await;
}

/// When this identity last completed a pairing handshake, if it ever did.
#[tauri::command]
async fn get_device_pairing(
    state: State<'_, AppState>,
    device_id: String,
) -> Result<Option<i64>, String> {
    let value = state
        .store
        .get_setting(&format!("paired:{device_id}"))
        .await
        .map_err(|e| e.to_string())?;
    Ok(value.and_then(|raw| raw.trim().parse::<i64>().ok()))
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
            Ok(flows) => {
                // The Android receiver runs with no network and no webview, so
                // the last good set must live in the local store. Persisting
                // only on success is what makes a failed fetch harmless: the
                // previous rows stay in place for the background path.
                if let Err(error) = state.store.replace_flows(&flows).await {
                    eprintln!("[carrier] flow persist failed: {error}");
                }
                Some(flows)
            }
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

/* ---------------------------------------------------------------- compose */

/// The composer's one hard limit, matching `SmsSender` on the Android side.
const MAX_COMPOSE_BODY_CHARS: usize = 1600;

/// `send_sms` reply. The UI pairs this id with the row it later reads back.
#[derive(Serialize)]
struct SendSmsReply {
    local_id: String,
}

/// Rust → Kotlin bridge for the composer.
///
/// A registered Tauri mobile plugin rather than a direct JNI call: it is the
/// sanctioned mechanism (`PluginApi::register_android_plugin` +
/// `run_mobile_plugin_async`), it dispatches to the Android context without this
/// crate needing a `JavaVM` of its own (`ndk_context` is not a dependency), and
/// it uses the same class-loading and main-thread plumbing as the bundled path
/// plugin. A direct JNI call would have to cache a VM during some Kotlin→Rust
/// call that may not have happened yet.
#[cfg(target_os = "android")]
struct SmsBridge(tauri::plugin::PluginHandle<tauri::Wry>);

#[cfg(target_os = "android")]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SmsPluginRequest<'a> {
    device_id: &'a str,
    to: &'a str,
    body: &'a str,
    /// 1-based tray index, exactly as the device row holds it.
    sim_slot: i64,
}

#[cfg(target_os = "android")]
#[derive(Deserialize)]
struct SmsPluginReply {
    local_id: String,
}

/// The webview's one pending sms:/smsto: route, if an intent offered one.
#[cfg(target_os = "android")]
#[derive(Deserialize)]
struct SmsRouteReply {
    route: Option<String>,
}

#[cfg(target_os = "android")]
fn sms_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("dakflare-sms")
        .setup(|app, api| {
            let handle =
                api.register_android_plugin("dev.dakflare.simulator.bridge", "SmsPlugin")?;
            app.manage(SmsBridge(handle));
            Ok(())
        })
        .build()
}

/// Turn a plugin failure into the composer's plain-string contract. Kotlin only
/// rejects with its own worded refusals, so nothing here can carry a number or a
/// body.
#[cfg(target_os = "android")]
fn sms_plugin_error(error: tauri::plugin::mobile::PluginInvokeError) -> String {
    use tauri::plugin::mobile::PluginInvokeError;

    match error {
        PluginInvokeError::InvokeRejected(response) => response
            .message
            .filter(|message| !message.trim().is_empty())
            .unwrap_or_else(|| "The phone could not send the message".to_string()),
        other => {
            // Carries no number and no body; only the JNI/deserialisation reason.
            eprintln!("[sms] mobile plugin failed: {other}");
            "The phone could not send the message".to_string()
        }
    }
}

/// Send one SMS composed in the webview.
///
/// Kotlin writes the `queued` row (`queueOutbound`) before the radio is touched
/// and reports the real outcome with a `SENT` broadcast, so this command never
/// claims delivery: it returns the row's id, and the row moves to `sent` or
/// `failed` on its own. A device with no row is `Not paired`, which is what the
/// composer shows as its empty state.
#[tauri::command]
async fn send_sms(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    device_id: String,
    to: String,
    body: String,
) -> Result<SendSmsReply, String> {
    let device = state
        .store
        .get_device(&device_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Not paired".to_string())?;

    let to = to.trim();
    if to.is_empty() {
        return Err("A recipient is required".into());
    }
    if body.trim().is_empty() {
        return Err("A message is required".into());
    }
    if body.chars().count() > MAX_COMPOSE_BODY_CHARS {
        return Err("That message is too long".into());
    }

    #[cfg(target_os = "android")]
    {
        let bridge = app
            .try_state::<SmsBridge>()
            .ok_or_else(|| "Sending SMS is not available in this build".to_string())?;
        let reply = bridge
            .0
            .run_mobile_plugin_async::<SmsPluginReply>(
                "send",
                SmsPluginRequest {
                    device_id: &device.device_id,
                    to,
                    body: body.as_str(),
                    sim_slot: device.sim_slot,
                },
            )
            .await
            .map_err(sms_plugin_error)?;
        Ok(SendSmsReply {
            local_id: reply.local_id,
        })
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, device);
        Err("Sending SMS is only available on the phone".into())
    }
}

/// Ask Android to show its default-SMS role dialog.
///
/// Kotlin owns the platform branch (`RoleManager` on API 29+,
/// `ACTION_CHANGE_DEFAULT` below it). This command only opens the dialog; it
/// never reports the role as held. `get_device_facts` stays the source of truth
/// because `MainActivity.onResume` re-reads the role holder after the dialog
/// closes.
#[tauri::command]
async fn request_default_sms_role(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        let bridge = app.try_state::<SmsBridge>().ok_or_else(|| {
            "Changing the SMS role is not available in this build".to_string()
        })?;
        bridge
            .0
            .run_mobile_plugin_async::<serde_json::Value>("requestDefaultSmsRole", ())
            .await
            .map_err(sms_plugin_error)?;
        Ok(())
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Err("Changing the SMS role is only available on the phone".into())
    }
}

/// Take the pending sms:/smsto: route from the Android shell, once.
///
/// `MainActivity` records it when a SENDTO/VIEW intent arrives; the webview
/// opens the matching thread. Only a `/messages` path is accepted, so a
/// malformed intent cannot steer the router elsewhere. A desktop build has no
/// intents and returns `None`.
#[tauri::command]
async fn take_sms_route(app: tauri::AppHandle) -> Result<Option<String>, String> {
    #[cfg(target_os = "android")]
    {
        let Some(bridge) = app.try_state::<SmsBridge>() else {
            return Ok(None);
        };
        let reply = bridge
            .0
            .run_mobile_plugin_async::<SmsRouteReply>("takeSmsRoute", ())
            .await
            .map_err(sms_plugin_error)?;
        Ok(reply
            .route
            .filter(|route| route == "/messages" || route.starts_with("/messages/")))
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(None)
    }
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

/// One keyset page for the Threads frame.
///
/// No cursor means the first page and delegates to [`list_messages`], so the
/// two commands cannot disagree about what "newest" is. A cursor is the
/// `(created_at, id)` pair of the last row the client already has; `has_more`
/// comes from fetching one extra row rather than a second `COUNT`.
#[tauri::command]
async fn list_messages_page(
    state: State<'_, AppState>,
    device_id: String,
    before_created_at: Option<i64>,
    before_id: Option<String>,
    limit: Option<i64>,
) -> Result<MessagePage, String> {
    let limit = limit.unwrap_or(50).clamp(1, 100);
    let mut messages = match (before_created_at, before_id) {
        (None, None) => state.store.list_messages(&device_id, limit + 1).await,
        (Some(created_at), Some(id)) => {
            state
                .store
                .list_messages_before(&device_id, created_at, &id, limit + 1)
                .await
        }
        _ => {
            return Err("before_created_at and before_id must be provided together".into());
        }
    }
    .map_err(|e| e.to_string())?;

    let has_more = messages.len() as i64 > limit;
    messages.truncate(limit as usize);
    Ok(MessagePage { messages, has_more })
}

/// The cached flow set, readable by the Flows frame. A corrupt graph keeps its
/// row and reports `node_count: null`; it does not hide the cache.
#[tauri::command]
async fn list_cached_flows(state: State<'_, AppState>) -> Result<Vec<CachedFlow>, String> {
    state
        .store
        .list_cached_flows()
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_flow_runs(
    state: State<'_, AppState>,
    device_id: String,
    limit: Option<i64>,
) -> Result<Vec<FlowRunRow>, String> {
    state
        .store
        .list_flow_runs(&device_id, limit.unwrap_or(50).clamp(1, 100))
        .await
        .map_err(|e| e.to_string())
}

/// Handset facts written by the Android shell. A desktop build has none, so
/// every field is `null` rather than a fabricated value.
#[tauri::command]
async fn get_device_facts(state: State<'_, AppState>) -> Result<DeviceFacts, String> {
    state
        .store
        .get_device_facts()
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
    let builder = tauri::Builder::default();

    // Mobile plugins need an Android class to drive. Desktop keeps the command
    // but reports that sending is phone-only.
    #[cfg(target_os = "android")]
    let builder = builder.plugin(sms_plugin());

    builder
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
            sync_flows,
            purge_messages,
            revoke_device,
            carrier_inject,
            carrier_drain,
            send_sms,
            request_default_sms_role,
            take_sms_route,
            list_messages,
            list_messages_page,
            list_cached_flows,
            list_flow_runs,
            get_device_facts,
            get_device_pairing,
            clear_messages,
            set_offline,
            get_offline,
            schema_version
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
