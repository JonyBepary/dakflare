//! M4 probe — proves which engine replied.
//!
//! Case A: the device fetches the flow, runs it locally, and reports the run. The
//!         Worker fallback must stay silent.
//! Case B: the device uploads without running anything. The Worker fallback must
//!         produce the reply.
//!
//! ```bash
//! DAKFLARE_URL=... DAKFLARE_ADMIN_TOKEN=... cargo run --example flow_probe
//! ```

use dakflare_core::{DeviceClient, NewDevice, Store, Target, inject_inbound};
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

    client
        .admin_put_workflow(WORKFLOW_ID, "M4 engine probe", graph())
        .await?;
    println!("workflow: installed {WORKFLOW_ID}");

    let code = client.mint_pairing_code(120_000).await?;
    client.pair(&code, &device.public_key_spki).await?;
    println!("pair:     ok");

    /* ---- device engine ------------------------------------------------ */
    let flows = client.fetch_flows().await?;
    println!("flows:    fetched {} for this device", flows.len());

    let case_a = inject_inbound(
        &store,
        Some(&client),
        &device.device_id,
        "+15551230000",
        "CODE 483920",
        false,
        Some(&flows),
    )
    .await?;
    println!(
        "case A:   device_sent={} fallback={}",
        case_a.device_sent, case_a.fallback
    );
    for message in &case_a.captured {
        println!("          → {} · {}", message.peer, message.body);
    }

    /* ---- Worker fallback ---------------------------------------------- */
    // No flows passed: the device uploads the message without running anything.
    let case_b = inject_inbound(
        &store,
        Some(&client),
        &device.device_id,
        "+15551230000",
        "CODE 777111",
        false,
        None,
    )
    .await?;
    println!(
        "case B:   device_sent={} fallback={}",
        case_b.device_sent, case_b.fallback
    );
    for message in &case_b.captured {
        println!("          → {} · {}", message.peer, message.body);
    }

    let a_ok = case_a.device_sent == 1
        && case_a.fallback == 0
        && case_a
            .captured
            .iter()
            .any(|m| m.body == "Your code is 483920");

    let b_ok = case_b.device_sent == 0
        && case_b.fallback == 1
        && case_b
            .captured
            .iter()
            .any(|m| m.body == "Your code is 777111");

    client.admin_delete_workflow(WORKFLOW_ID).await.ok();
    let purged = client.purge_messages().await.unwrap_or(0);
    client.revoke().await.ok();
    let _ = store.clear_messages(&device.device_id).await;
    let _ = store.delete_device(&device.device_id).await;
    let _ = std::fs::remove_file(&db_path);
    println!("cleanup:  workflow removed, {purged} message(s) purged, device revoked");

    if !a_ok {
        return Err("device engine did not produce exactly one reply (or fallback fired)".into());
    }
    if !b_ok {
        return Err("Worker fallback did not produce exactly one reply".into());
    }

    println!("\nFLOW PROBE OK — device primary, Worker fallback");
    Ok(())
}
