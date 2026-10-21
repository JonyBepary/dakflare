//! Live protocol + carrier probe.
//!
//! Creates a temporary local device, pairs it with a real deployment, then:
//!   1. injects an inbound SMS (uploaded over the signed endpoint),
//!   2. queues a real command as admin and captures it through a signed poll,
//!   3. purges the message log and revokes the device.
//!
//! Nothing is left behind if every step succeeds.
//!
//! ```bash
//! DAKFLARE_URL=https://<worker>.workers.dev \
//! DAKFLARE_ADMIN_TOKEN=... \
//! cargo run --example probe
//! ```

use dakflare_core::{DeviceClient, NewDevice, Store, Target, drain_outbox, inject_inbound};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let base_url = std::env::var("DAKFLARE_URL")
        .map_err(|_| "set DAKFLARE_URL to the deployment base URL")?;
    let admin_token =
        std::env::var("DAKFLARE_ADMIN_TOKEN").map_err(|_| "set DAKFLARE_ADMIN_TOKEN")?;

    let db_path = std::env::temp_dir().join(format!(
        "dakflare-probe-{}-{}.db",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_millis()
    ));

    let store = Store::open(&db_path).await?;
    println!("local db: {}", db_path.display());

    let (device, identity) = store
        .create_device(NewDevice {
            label: "probe",
            platform: "simulator",
            platform_id: Some("probe-android-id"),
            carrier: Some("probe-carrier"),
            sim_slot: 0,
        })
        .await?;
    println!("device:   {}", device.device_id);
    println!("spki:     {}…", &device.public_key_spki[..16]);

    let target = Target::new(base_url, Some(admin_token))?;
    let client = DeviceClient::new(
        target,
        device.device_id.clone(),
        identity.private_key_pkcs8_pem.clone(),
    );

    /* ---- pair ---------------------------------------------------------- */
    let code = client.mint_pairing_code(120_000).await?;
    println!("code:     {}…", &code[..code.len().min(8)]);
    client.pair(&code, &device.public_key_spki).await?;
    println!("pair:     ok");

    let commands = client.poll(&[]).await?;
    println!(
        "poll:     ok ({} queued command(s))",
        commands.as_array().map(|a| a.len()).unwrap_or(0)
    );

    /* ---- carrier: inbound ---------------------------------------------- */
    let injected = inject_inbound(
        &store,
        Some(&client),
        &device.device_id,
        "+15550000001",
        "CODE 483920",
        false,
    )
    .await?;
    println!(
        "inject:   uploaded={} accepted={} duplicates={}",
        injected.uploaded, injected.accepted, injected.duplicates
    );

    /* ---- carrier: outbound --------------------------------------------- */
    let command_id = client.admin_send("+15550000002", "probe outbound").await?;
    println!("send:     {}…", &command_id[..command_id.len().min(8)]);

    let captured = drain_outbox(&store, &client, &device.device_id).await?;
    println!("drain:    captured {} outbound message(s)", captured.len());
    for message in &captured {
        println!("          → {} · {}", message.peer, message.body);
    }

    let thread = store.list_messages(&device.device_id, 50).await?;
    println!("thread:   {} local message(s)", thread.len());

    /* ---- clean up ------------------------------------------------------- */
    let deleted = client.purge_messages().await?;
    println!("purge:    {deleted} message(s) removed");

    client.revoke().await?;
    println!("revoke:   ok");

    let _ = store.clear_messages(&device.device_id).await?;
    let _ = store.delete_device(&device.device_id).await?;
    let _ = std::fs::remove_file(&db_path);

    println!("\nPROBE OK");
    Ok(())
}
