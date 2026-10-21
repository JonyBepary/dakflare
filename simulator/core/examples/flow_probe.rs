//! End-to-end flow probe.
//!
//! Installs a real workflow on the deployment, pairs a temporary device, injects
//! `CODE 483920`, and asserts that the Worker's WASM interpreter enqueued the
//! expected reply. Then removes the workflow, purges the log and revokes the
//! device.
//!
//! ```bash
//! DAKFLARE_URL=https://<worker>.workers.dev DAKFLARE_ADMIN_TOKEN=... \
//!   cargo run --example flow_probe
//! ```

use dakflare_core::{
    DeviceClient, InboundMessage, NewDevice, Store, Target, drain_outbox, inject_inbound,
};
use serde_json::json;

const WORKFLOW_ID: &str = "wf_flowprobe";

fn graph() -> serde_json::Value {
    json!({
        "nodes": [
            { "id": "t1", "type": "trigger", "position": { "x": 0, "y": 0 },
              "data": { "kind": "incoming" } },
            { "id": "x1", "type": "extract", "position": { "x": 220, "y": 0 },
              "data": { "source": "body", "pattern": "CODE\\s+(?<code>\\d{6})" } },
            { "id": "c1", "type": "condition", "position": { "x": 440, "y": 0 },
              "data": { "left": "{{code}}", "op": "exists" } },
            { "id": "s1", "type": "send_sms", "position": { "x": 660, "y": -80 },
              "data": { "to": "{{sender}}", "body": "Your code is {{code}}" } },
            { "id": "e1", "type": "stop", "position": { "x": 880, "y": -80 },
              "data": { "reason": "sent" } },
            { "id": "e2", "type": "stop", "position": { "x": 660, "y": 120 },
              "data": { "reason": "no code" } }
        ],
        "edges": [
            { "id": "a", "source": "t1", "target": "x1" },
            { "id": "b", "source": "x1", "target": "c1" },
            { "id": "c", "source": "c1", "target": "s1", "sourceHandle": "true" },
            { "id": "d", "source": "c1", "target": "e2", "sourceHandle": "false" },
            { "id": "e", "source": "s1", "target": "e1" }
        ]
    })
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let base_url =
        std::env::var("DAKFLARE_URL").map_err(|_| "set DAKFLARE_URL to the deployment URL")?;
    let admin_token =
        std::env::var("DAKFLARE_ADMIN_TOKEN").map_err(|_| "set DAKFLARE_ADMIN_TOKEN")?;

    let db_path = std::env::temp_dir().join(format!(
        "dakflare-flow-probe-{}-{}.db",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_millis()
    ));

    let store = Store::open(&db_path).await?;
    let (device, identity) = store
        .create_device(NewDevice {
            label: "flow-probe",
            platform: "simulator",
            platform_id: None,
            carrier: Some("probe"),
            sim_slot: 0,
        })
        .await?;
    println!("device:   {}", device.device_id);

    let target = Target::new(base_url, Some(admin_token))?;
    let client = DeviceClient::new(
        target,
        device.device_id.clone(),
        identity.private_key_pkcs8_pem.clone(),
    );

    // The workflow must exist before the message is uploaded: dispatch reads it
    // during the inbound request.
    client
        .admin_put_workflow(WORKFLOW_ID, "M3 device-code probe", graph())
        .await?;
    println!("workflow: installed {WORKFLOW_ID}");

    let code = client.mint_pairing_code(120_000).await?;
    client.pair(&code, &device.public_key_spki).await?;
    println!("pair:     ok");

    let injected = inject_inbound(
        &store,
        Some(&client),
        &device.device_id,
        "+15551230000",
        "CODE 483920",
        false,
    )
    .await?;
    println!(
        "inject:   uploaded={} accepted={}",
        injected.uploaded, injected.accepted
    );

    // The reply may arrive in the upload response (same round trip) or from a
    // later poll; both are legitimate delivery paths.
    let mut captured = injected.captured.clone();
    captured.extend(drain_outbox(&store, &client, &device.device_id).await?);
    println!("captured: {} outbound message(s)", captured.len());
    for message in &captured {
        println!("          → {} · {}", message.peer, message.body);
    }

    // Idempotency: replaying the same message must not send a second reply. The
    // Worker only dispatches flows for rows that were actually inserted.
    let local_id = injected.message.local_id.clone().expect("local id");
    let retry = client
        .upload_inbound(
            &[InboundMessage {
                local_id,
                sender: "+15551230000".into(),
                body: "CODE 483920".into(),
                received_at: now_ms(),
            }],
            &[],
        )
        .await?;
    let retry_duplicates = retry.get("duplicates").and_then(|v| v.as_u64()).unwrap_or(0);
    let retry_commands = retry
        .get("commands")
        .and_then(|v| v.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    let extra = drain_outbox(&store, &client, &device.device_id).await?;
    println!(
        "retry:    duplicates={retry_duplicates} commands={retry_commands} extra_drain={}",
        extra.len()
    );

    let ok = captured
        .iter()
        .any(|m| m.peer == "+15551230000" && m.body == "Your code is 483920")
        && retry_duplicates == 1
        && retry_commands == 0
        && extra.is_empty();

    // Clean up regardless of the assertion.
    client.admin_delete_workflow(WORKFLOW_ID).await.ok();
    let purged = client.purge_messages().await.unwrap_or(0);
    client.revoke().await.ok();
    let _ = store.clear_messages(&device.device_id).await;
    let _ = store.delete_device(&device.device_id).await;
    let _ = std::fs::remove_file(&db_path);
    println!("cleanup:  workflow removed, {purged} message(s) purged, device revoked");

    if !ok {
        return Err("flow did not produce the expected reply".into());
    }

    println!("\nFLOW PROBE OK");
    Ok(())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
