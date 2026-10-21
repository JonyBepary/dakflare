//! Live protocol probe.
//!
//! Creates a temporary local device, pairs it with a real deployment, performs a
//! signed poll and an inbound upload, then purges the message log and revokes the
//! device. Nothing is left behind if every step succeeds.
//!
//! ```bash
//! DAKFLARE_URL=https://<worker>.workers.dev \
//! DAKFLARE_ADMIN_TOKEN=... \
//! cargo run --example probe
//! ```

use dakflare_core::{
    DeviceClient, InboundMessage, NewDevice, Store, Target,
};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let base_url = std::env::var("DAKFLARE_URL")
        .map_err(|_| "set DAKFLARE_URL to the deployment base URL")?;
    let admin_token = std::env::var("DAKFLARE_ADMIN_TOKEN")
        .map_err(|_| "set DAKFLARE_ADMIN_TOKEN")?;

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

    let code = client.mint_pairing_code(120_000).await?;
    println!("code:     {}…", &code[..code.len().min(8)]);

    client.pair(&code, &device.public_key_spki).await?;
    println!("pair:     ok");

    let commands = client.poll(&[]).await?;
    println!(
        "poll:     ok ({} queued command(s))",
        commands.as_array().map(|a| a.len()).unwrap_or(0)
    );

    let local_id = format!("probe-{}", std::process::id());
    let inbound = client
        .upload_inbound(
            &[InboundMessage {
                local_id: local_id.clone(),
                sender: "+15550000001".into(),
                body: "probe message".into(),
                received_at: now_ms(),
            }],
            &[],
        )
        .await?;
    println!(
        "inbound:  accepted={} duplicates={}",
        inbound.get("accepted").and_then(|v| v.as_u64()).unwrap_or(0),
        inbound.get("duplicates").and_then(|v| v.as_u64()).unwrap_or(0),
    );

    let deleted = client.purge_messages().await?;
    println!("purge:    {deleted} message(s) removed");

    client.revoke().await?;
    println!("revoke:   ok");

    let _ = store.delete_device(&device.device_id).await?;
    let _ = std::fs::remove_file(&db_path);

    println!("\nPROBE OK");
    Ok(())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
