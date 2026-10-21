//! Carrier simulation.
//!
//! The only genuinely fake part of the app. Inbound SMS is injected here instead
//! of arriving from a radio; outbound SMS is captured from the command queue
//! instead of being handed to `SmsManager`. Everything between (identity,
//! signing, protocol, storage) is the real thing.

use std::time::{SystemTime, UNIX_EPOCH};

use crate::db::{Message, Store, StoreError};
use crate::protocol::{DeviceClient, InboundMessage, ProtocolError};

#[derive(Debug, thiserror::Error)]
pub enum CarrierError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Protocol(#[from] ProtocolError),
}

#[derive(Debug)]
pub struct Injected {
    pub message: Message,
    pub uploaded: bool,
    pub accepted: u64,
    pub duplicates: u64,
}

/// "Receive" one SMS.
///
/// It is always recorded locally, so the thread is complete even offline. When
/// the device is online it is also uploaded through the signed inbound endpoint,
/// which is what a real phone does after `SMS_RECEIVED`.
pub async fn inject_inbound(
    store: &Store,
    client: Option<&DeviceClient>,
    device_id: &str,
    sender: &str,
    body: &str,
    offline: bool,
) -> Result<Injected, CarrierError> {
    let local_id = format!("sim-{}", random_hex(8)?);
    let message = store
        .record_message(device_id, "in", sender, body, "received", Some(&local_id))
        .await?;

    if offline || client.is_none() {
        return Ok(Injected {
            message,
            uploaded: false,
            accepted: 0,
            duplicates: 0,
        });
    }

    let response = client
        .expect("checked above")
        .upload_inbound(
            &[InboundMessage {
                local_id,
                sender: sender.to_string(),
                body: body.to_string(),
                received_at: now_ms(),
            }],
            &[],
        )
        .await?;

    let accepted = response.get("accepted").and_then(|v| v.as_u64()).unwrap_or(0);
    let duplicates = response
        .get("duplicates")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    if accepted > 0 || duplicates > 0 {
        store.set_message_state(&message.id, "uploaded").await?;
    }

    Ok(Injected {
        message,
        uploaded: true,
        accepted,
        duplicates,
    })
}

/// `poll` → capture every queued command as an outbound message → ack them.
///
/// Acknowledgement happens in a second poll, exactly as a device would do, so the
/// command leaves `PENDING`/`DISPATCHED` and stops being redelivered.
pub async fn drain_outbox(
    store: &Store,
    client: &DeviceClient,
    device_id: &str,
) -> Result<Vec<Message>, CarrierError> {
    let commands = client.poll(&[]).await?;
    let entries = commands.as_array().cloned().unwrap_or_default();

    let mut captured = Vec::new();
    let mut ack_ids: Vec<String> = Vec::new();

    for entry in entries {
        let command_id = entry
            .get("command_id")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        // The wire shape is `to` (durable-object `toView`), not the SQL column
        // name `to_e164`. Accept both so a future rename cannot silently produce
        // an outbound message with an empty recipient.
        let to = entry
            .get("to")
            .or_else(|| entry.get("to_e164"))
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        let body = entry
            .get("body")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();

        if command_id.is_empty() {
            continue;
        }

        let message = store
            .record_message(device_id, "out", &to, &body, "queued", None)
            .await?;
        ack_ids.push(command_id);
        captured.push(message);
    }

    if !ack_ids.is_empty() {
        // A push-wakeup may add commands here; they stay queued for the next drain.
        client.poll(&ack_ids).await?;
        for message in &captured {
            store.set_message_state(&message.id, "sent").await?;
        }
    }

    Ok(captured)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn random_hex(bytes: usize) -> Result<String, StoreError> {
    let mut buffer = vec![0u8; bytes];
    getrandom::fill(&mut buffer).map_err(|_| StoreError::Clock)?;
    let mut out = String::with_capacity(bytes * 2);
    for byte in buffer {
        out.push_str(&format!("{byte:02x}"));
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::NewDevice;

    #[tokio::test]
    async fn offline_injection_is_recorded_but_not_uploaded() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("sim.db")).await.unwrap();
        let (device, _) = store
            .create_device(NewDevice {
                label: "offline",
                platform: "simulator",
                platform_id: None,
                carrier: None,
                sim_slot: 0,
            })
            .await
            .unwrap();

        let injected =
            inject_inbound(&store, None, &device.device_id, "+15550001111", "CODE 483920", true)
                .await
                .unwrap();

        assert!(!injected.uploaded);
        assert_eq!(injected.message.direction, "in");
        assert_eq!(injected.message.body, "CODE 483920");
        assert_eq!(injected.message.state, "received");

        let thread = store.list_messages(&device.device_id, 50).await.unwrap();
        assert_eq!(thread.len(), 1);
        assert_eq!(thread[0].peer, "+15550001111");

        assert_eq!(store.clear_messages(&device.device_id).await.unwrap(), 1);
        assert!(store.list_messages(&device.device_id, 50).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn offline_flag_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("sim.db")).await.unwrap();
        let (device, _) = store
            .create_device(NewDevice {
                label: "toggle",
                platform: "simulator",
                platform_id: None,
                carrier: None,
                sim_slot: 0,
            })
            .await
            .unwrap();

        assert!(!store.is_offline(&device.device_id).await.unwrap());
        store.set_offline(&device.device_id, true).await.unwrap();
        assert!(store.is_offline(&device.device_id).await.unwrap());
        store.set_offline(&device.device_id, false).await.unwrap();
        assert!(!store.is_offline(&device.device_id).await.unwrap());
    }
}
