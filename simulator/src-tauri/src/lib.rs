//! Tauri shell for the DakFlare device simulator.
//!
//! Everything interesting lives in `dakflare-core`: identity, the libSQL store and
//! (next) the protocol client. This file only owns the app lifecycle and exposes
//! those operations to the webview.

use std::sync::Arc;

use dakflare_core::{Device, NewDevice, Store};
use tauri::{Manager, State};

struct AppState {
    store: Arc<Store>,
}

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
            let store = tauri::async_runtime::block_on(Store::open(dir.join("simulator.db"))).map_err(
                |e| std::io::Error::other(format!("could not open local database: {e}")),
            )?;

            app.manage(AppState {
                store: Arc::new(store),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_devices,
            create_device,
            delete_device,
            schema_version
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
