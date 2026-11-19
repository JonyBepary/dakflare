//! Edge-device personal-channel batches (Android -> DakFlare Worker).
//!
//! `MessagingNotificationBridge.kt` reads Android's own notification stream
//! (WhatsApp, Telegram, Messenger, Instagram) and records each message through
//! the same local store the SMS receiver uses. This module owns the wire half:
//! the normalized message shape, the two Worker limits (500 rows and 262,144
//! bytes per request) and the signed upload to `POST /v1/edge/incoming/batch`.
//!
//! Zero extra dependencies by default: the upload reuses the canonical P-256
//! request signer in [`crate::protocol`] instead of carrying its own transport.
//! Optional protocol clients are strictly gated behind Cargo features so the
//! default build pulls no new crate.
//!
//! Logging rule, same as the rest of the core: counts, ids and timestamps only;
//! never a sender or a body.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::carrier::resolve_device;
use crate::db::{Message, Store};
use crate::protocol::{DeviceClient, ProtocolError};

/// The Worker's `MAX_INCOMING_MESSAGES` (`worker/src/lib/config.ts`).
pub const MAX_EDGE_MESSAGES_PER_BATCH: usize = 500;
/// The Worker's `MAX_BODY_BYTES`, measured over the whole JSON request body.
pub const MAX_EDGE_BATCH_BYTES: usize = 262_144;

/// Where an edge batch is uploaded.
pub const EDGE_INCOMING_PATH: &str = "/v1/edge/incoming/batch";

/// The personal channels the Android bridge can observe. Kept in sync with the
/// `SUPPORTED_PACKAGES` map in `MessagingNotificationBridge.kt`; an unknown
/// channel is a bug on the phone, not something the store should accept.
pub const EDGE_CHANNELS: [&str; 4] = [
    "whatsapp_personal",
    "telegram_personal",
    "messenger_personal",
    "instagram_personal",
];

/// True when any opt-in protocol adapter is compiled in. The default build is
/// `false`, which is what the module test asserts.
pub const EDGE_ADAPTERS_COMPILED: bool = cfg!(any(feature = "mtproto", feature = "wa-linked"));

// The local-store caps. They mirror the JNI entry's own checks so another caller
// cannot smuggle an unbounded row past the phone boundary.
const MAX_CHANNEL_LEN: usize = 64;
/// The Worker's `MAX_ID_CHARS` for the existing inbound flush. Longer than any
/// `notif:<package>:<id>:<postTime>` string but enforced anyway.
const MAX_LOCAL_ID_LEN: usize = 128;
const MAX_SENDER_LEN: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EdgeInboundMessage {
    /// `whatsapp_personal` | `telegram_personal` | `messenger_personal` |
    /// `instagram_personal`.
    pub channel: String,
    /// Deterministic idempotency key: the notification's package, id and post
    /// time. A re-posted notification resolves to one message.
    pub local_id: String,
    /// Display name, phone number or peer id, as the app's notification shows it.
    pub sender: String,
    pub body: String,
    /// UTC epoch milliseconds.
    pub received_at: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EdgeIncomingBatch {
    pub device_id: String,
    pub messages: Vec<EdgeInboundMessage>,
}

/// Why a message list could not be cut into batches the Worker will accept.
#[derive(Debug, thiserror::Error)]
pub enum EdgeBatchError {
    /// A single message is larger than the whole byte budget, so no chunking
    /// can make it fit. The message is named so the caller can drop it and keep
    /// the rest of the queue moving.
    #[error(
        "edge message {local_id} is {bytes} bytes on its own, over the {limit}-byte batch budget"
    )]
    OversizedMessage {
        local_id: String,
        bytes: usize,
        limit: usize,
    },
    #[error("could not serialize edge batch: {0}")]
    Serialize(String),
}

/// The deterministic id for one Android notification.
///
/// `package` is the posting app, `notification_id` is `StatusBarNotification.id`
/// and `post_time_ms` is `StatusBarNotification.postTime`. They identify the
/// notification instance, so a re-post lands on the row the first delivery
/// created. The same string is built by `MessagingNotificationBridge.kt`.
pub fn edge_local_id(package: &str, notification_id: i32, post_time_ms: i64) -> String {
    format!("notif:{package}:{notification_id}:{post_time_ms}")
}

/// Cut messages into batches that respect both Worker limits.
///
/// `max_per_batch` is clamped to `1..=500`. The byte budget is measured over the
/// compact JSON body serde produces for [`EdgeIncomingBatch`], which includes
/// the device id and every key, exactly like the request that will be sent.
///
/// A message that cannot fit on its own is [`EdgeBatchError::OversizedMessage`];
/// it is never truncated, because truncating a personal message would upload a
/// lie.
pub fn chunk_edge_batch(
    device_id: &str,
    messages: &[EdgeInboundMessage],
    max_per_batch: usize,
) -> Result<Vec<EdgeIncomingBatch>, EdgeBatchError> {
    let cap = max_per_batch.clamp(1, MAX_EDGE_MESSAGES_PER_BATCH);

    // Exact compact-JSON length of the envelope around the message array. The
    // field order is the struct declaration order serde uses.
    let device_json = serde_json::to_string(device_id).map_err(batch_serialize_error)?;
    let header_len = format!("{{\"device_id\":{device_json},\"messages\":[").len();
    let footer_len = "]}".len();

    let mut batches = Vec::new();
    let mut current: Vec<EdgeInboundMessage> = Vec::new();
    let mut current_payload = 0usize;

    for message in messages {
        let message_len = serde_json::to_vec(message)
            .map_err(batch_serialize_error)?
            .len();
        let next_count = current.len() + 1;
        // header + each message + one comma between messages + footer.
        let next_len =
            header_len + current_payload + message_len + next_count.saturating_sub(1) + footer_len;

        if next_count <= cap && next_len <= MAX_EDGE_BATCH_BYTES {
            current.push(message.clone());
            current_payload += message_len;
            if current.len() == cap {
                batches.push(take_batch(device_id, &mut current));
                current_payload = 0;
            }
            continue;
        }

        // The new message does not fit beside the current set.
        if current.is_empty() {
            return Err(EdgeBatchError::OversizedMessage {
                local_id: message.local_id.clone(),
                bytes: header_len + message_len + footer_len,
                limit: MAX_EDGE_BATCH_BYTES,
            });
        }

        batches.push(take_batch(device_id, &mut current));

        // It must still fit alone, or no chunking can help.
        let alone = header_len + message_len + footer_len;
        if alone > MAX_EDGE_BATCH_BYTES {
            return Err(EdgeBatchError::OversizedMessage {
                local_id: message.local_id.clone(),
                bytes: alone,
                limit: MAX_EDGE_BATCH_BYTES,
            });
        }
        current.push(message.clone());
        current_payload = message_len;
    }

    if !current.is_empty() {
        batches.push(take_batch(device_id, &mut current));
    }

    Ok(batches)
}

fn take_batch(device_id: &str, messages: &mut Vec<EdgeInboundMessage>) -> EdgeIncomingBatch {
    EdgeIncomingBatch {
        device_id: device_id.to_string(),
        messages: std::mem::take(messages),
    }
}

fn batch_serialize_error(error: serde_json::Error) -> EdgeBatchError {
    EdgeBatchError::Serialize(error.to_string())
}

/// Refuse a channel the Android bridge cannot produce.
pub fn is_edge_channel(channel: &str) -> bool {
    EDGE_CHANNELS.contains(&channel)
}

/// Record one edge message in the local store, on the same inbound path the SMS
/// receiver writes, tagged with its channel as the row's source.
///
/// The row is `direction = 'in'`, `state = 'received'`, with `local_id` as the
/// idempotency key. That is exactly what [`crate::carrier::receive_offline`]
/// writes, minus the SMS body hash: the notification id is the stable key, so a
/// re-posted notification returns the row the first post created instead of a
/// duplicate. No flows run here: a WhatsApp message must not trigger an SMS
/// auto-reply that the flow engine can only express as `SendSms`.
///
/// The row is stored **whole**. `source = channel` keeps it out of
/// [`Store::list_pending_inbound`], so the SMS uploader never sees it and its
/// length can never be the reason the SMS flush fails. The edge uploader
/// ([`flush_edge_pending`]) is the only consumer.
pub async fn record_edge_inbound(
    store: &Store,
    device_id: Option<&str>,
    message: &EdgeInboundMessage,
) -> Result<Message, crate::carrier::CarrierError> {
    use crate::carrier::CarrierError;

    if !is_edge_channel(&message.channel) || message.channel.len() > MAX_CHANNEL_LEN {
        return Err(CarrierError::InvalidInput("edge channel"));
    }
    let local_id = message.local_id.trim();
    if local_id.is_empty() || local_id.chars().count() > MAX_LOCAL_ID_LEN {
        return Err(CarrierError::InvalidInput("edge local id"));
    }
    let sender = message.sender.trim();
    if sender.is_empty() || sender.chars().count() > MAX_SENDER_LEN {
        return Err(CarrierError::InvalidInput("sender"));
    }
    if message.body.trim().is_empty() {
        return Err(CarrierError::InvalidInput("body"));
    }
    if message.received_at <= 0 {
        return Err(CarrierError::InvalidInput("received_at"));
    }

    let device_id = resolve_device(store, device_id).await?;

    // A re-post finds the first delivery's row.
    if let Some(existing) = store.message_by_local_id(&device_id, local_id).await? {
        return Ok(existing);
    }

    match store
        .record_sourced_message(
            &device_id,
            "in",
            sender,
            &message.body,
            "received",
            Some(local_id),
            &message.channel,
        )
        .await
    {
        Ok(message) => Ok(message),
        // A concurrent re-post hit `UNIQUE(device_id, local_id)`: the winner is
        // the row to return.
        Err(error) => match store.message_by_local_id(&device_id, local_id).await? {
            Some(existing) => Ok(existing),
            None => Err(CarrierError::Store(error)),
        },
    }
}

/// Upload one already-chunked batch.
///
/// Uses [`DeviceClient::signed_post`], the same sign-and-POST path every other
/// device request takes: the canonical string, the four headers and the body
/// digest come from `protocol.rs`. Nothing about the edge endpoint is special on
/// the wire except the path.
pub async fn upload_edge_batch(
    client: &DeviceClient,
    batch: &EdgeIncomingBatch,
) -> Result<Value, ProtocolError> {
    let body = serde_json::to_value(batch)
        .map_err(|error| ProtocolError::Shape(format!("edge batch serialize: {error}")))?;
    client.signed_post(EDGE_INCOMING_PATH, body).await
}

/// Why an edge upload stopped.
#[derive(Debug, thiserror::Error)]
pub enum EdgeUploadError {
    #[error(transparent)]
    Batch(#[from] EdgeBatchError),
    #[error(transparent)]
    Protocol(#[from] ProtocolError),
}

/// Chunk and upload messages, returning how many rows the deployment accepted.
///
/// Each batch is one signed request; a failed request stops the run and leaves
/// the rest unuploaded. The caller retries from the top, which is safe because
/// every row's `local_id` is an idempotency key on the Worker.
pub async fn upload_edge_messages(
    client: &DeviceClient,
    device_id: &str,
    messages: &[EdgeInboundMessage],
    max_per_batch: usize,
) -> Result<usize, EdgeUploadError> {
    let batches = chunk_edge_batch(device_id, messages, max_per_batch)?;
    let mut uploaded = 0usize;
    for batch in &batches {
        upload_edge_batch(client, batch).await?;
        uploaded += batch.messages.len();
    }
    Ok(uploaded)
}

/// One stored edge message that no batch can carry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EdgeRefusal {
    pub local_id: String,
    /// The compact-JSON size of the batch containing only this message.
    pub bytes: usize,
}

/// What one edge flush did: rows the deployment accepted, and rows it cannot
/// ever accept because one message alone is over the batch budget.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EdgeFlushed {
    pub uploaded: usize,
    pub batches: usize,
    pub refused: Vec<EdgeRefusal>,
}

/// Why an edge flush stopped before uploading everything.
#[derive(Debug, thiserror::Error)]
pub enum EdgeFlushError {
    #[error(transparent)]
    Store(#[from] crate::db::StoreError),
    #[error(transparent)]
    Batch(#[from] EdgeBatchError),
    #[error(transparent)]
    Protocol(#[from] ProtocolError),
}

/// Upload the personal-channel rows that the SMS flush never selects.
///
/// Every row comes from [`Store::list_pending_edge_inbound`], so an SMS row can
/// never be sent to the edge endpoint and an edge row can never be sent to the
/// SMS one. A row whose single-message batch is already over 262,144 bytes is
/// put in [`EdgeFlushed::refused`] and **left pending**: it is visible to the
/// caller instead of being dropped or truncated, while the rows that do fit are
/// uploaded in the same pass.
///
/// The `received_at` sent to the Worker is the row's `created_at`, which the
/// store writes when the notification is observed. That is within milliseconds
/// of the notification's own post time (the JNI call happens on that path).
pub async fn flush_edge_pending(
    store: &Store,
    client: &DeviceClient,
    device_id: &str,
    max_per_batch: usize,
) -> Result<EdgeFlushed, EdgeFlushError> {
    // One page of pending rows; the next tick takes the next page. A row that
    // is refused stays at the head, so it must not consume the whole page: the
    // split below keeps going.
    let pending = store
        .list_pending_edge_inbound(device_id, MAX_EDGE_MESSAGES_PER_BATCH as i64)
        .await?;

    let mut row_ids: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut fitting: Vec<EdgeInboundMessage> = Vec::new();
    let mut refused: Vec<EdgeRefusal> = Vec::new();

    for (channel, row) in pending {
        let Some(local_id) = row.local_id.clone() else {
            continue;
        };
        let message = EdgeInboundMessage {
            channel,
            local_id,
            sender: row.peer,
            body: row.body,
            received_at: row.created_at,
        };

        // The same chunker decides what one message costs: if a batch holding
        // only it cannot be built, no chunking can help.
        match chunk_edge_batch(device_id, std::slice::from_ref(&message), 1) {
            Ok(_) => {
                row_ids.insert(message.local_id.clone(), row.id);
                fitting.push(message);
            }
            Err(EdgeBatchError::OversizedMessage {
                local_id, bytes, ..
            }) => {
                refused.push(EdgeRefusal { local_id, bytes });
            }
            Err(error) => return Err(EdgeFlushError::Batch(error)),
        }
    }

    let batches = chunk_edge_batch(device_id, &fitting, max_per_batch)?;
    let mut uploaded = 0usize;
    let mut uploaded_ids: Vec<String> = Vec::new();
    for batch in &batches {
        upload_edge_batch(client, batch).await?;
        for message in &batch.messages {
            if let Some(id) = row_ids.get(&message.local_id) {
                uploaded_ids.push(id.clone());
            }
        }
        uploaded += batch.messages.len();
    }
    // `uploaded` is the state the SMS flush also uses to retire an inbound row;
    // `mirrored` alone would leave the edge query selecting it again.
    for id in &uploaded_ids {
        store.set_message_state(id, "uploaded").await?;
    }

    Ok(EdgeFlushed {
        uploaded,
        batches: batches.len(),
        refused,
    })
}

/// Optional Telegram MTProto client hook (`Lonami/grammers`).
///
/// Empty until the feature is enabled; the default build declares the feature
/// but pulls no crate. When implemented this module would own a
/// `grammers_client::Client` for the cases the notification stream cannot
/// serve: cold sends by phone number, full history sync and replies from a
/// session that has no notification. The signed upload stays exactly the code
/// above; only the way messages are discovered changes.
#[cfg(feature = "mtproto")]
pub mod mtproto {
    /// The feature is compiled, but the adapter is deliberately a stub.
    pub const ENABLED: bool = true;
}

/// Optional WhatsApp linked-device client hook (`whatsapp-rust`).
///
/// Empty until the feature is enabled; the default build declares the feature
/// but pulls no crate. When implemented this module would own the linked-device
/// session for delivery receipts and history that a notification cannot show.
/// It would never replace the notification path for replies: the official app's
/// `RemoteInput` action is the only reply route that carries no account-ban
/// risk, and it stays the default.
#[cfg(feature = "wa-linked")]
pub mod wa_linked {
    /// The feature is compiled, but the adapter is deliberately a stub.
    pub const ENABLED: bool = true;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::NewDevice;
    use crate::protocol::Target;

    fn message(index: usize, body_size: usize) -> EdgeInboundMessage {
        EdgeInboundMessage {
            channel: "whatsapp_personal".into(),
            local_id: format!("notif:com.whatsapp:{index}:1763600000000"),
            sender: "Alice".into(),
            body: "x".repeat(body_size),
            received_at: 1_763_600_000_000 + index as i64,
        }
    }

    fn batch_len(batch: &EdgeIncomingBatch) -> usize {
        serde_json::to_vec(batch).expect("serialize").len()
    }

    #[test]
    fn chunks_respect_worker_500_row_ceiling() {
        let messages: Vec<EdgeInboundMessage> = (0..1050).map(|i| message(i, 4)).collect();

        // A caller asking for 1000 rows still gets 500: the Worker limit wins.
        let chunks = chunk_edge_batch("dev_test_001", &messages, 1000).expect("chunks");
        assert_eq!(chunks.len(), 3);
        assert_eq!(chunks[0].messages.len(), 500);
        assert_eq!(chunks[1].messages.len(), 500);
        assert_eq!(chunks[2].messages.len(), 50);
        assert!(
            chunks
                .iter()
                .all(|batch| batch.messages.len() <= MAX_EDGE_MESSAGES_PER_BATCH)
        );
    }

    #[test]
    fn byte_budget_splits_a_batch() {
        // Two bodies plus the envelope exceed 262,144; one does not.
        let messages = vec![message(0, 200_000), message(1, 200_000)];

        let chunks = chunk_edge_batch("dev_test_001", &messages, 500).expect("chunks");
        assert_eq!(chunks.len(), 2);
        for batch in &chunks {
            assert_eq!(batch.messages.len(), 1);
            assert!(
                batch_len(batch) <= MAX_EDGE_BATCH_BYTES,
                "batch of {} bytes exceeds the budget",
                batch_len(batch)
            );
        }
    }

    #[test]
    fn rows_and_bytes_together_are_both_enforced() {
        // Three 100 KB messages: two fit by bytes (about 200 KB), the third does
        // not, so the byte budget splits even though 3 < 500.
        let messages = vec![
            message(0, 100_000),
            message(1, 100_000),
            message(2, 100_000),
        ];

        let chunks = chunk_edge_batch("dev_test_001", &messages, 500).expect("chunks");
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].messages.len(), 2);
        assert_eq!(chunks[1].messages.len(), 1);
        assert!(
            chunks
                .iter()
                .all(|batch| batch_len(batch) <= MAX_EDGE_BATCH_BYTES)
        );
    }

    #[test]
    fn oversized_message_is_refused_by_name() {
        let messages = vec![message(7, MAX_EDGE_BATCH_BYTES + 1_000)];
        let error = chunk_edge_batch("dev_test_001", &messages, 500).expect_err("must refuse");

        match &error {
            EdgeBatchError::OversizedMessage {
                local_id, limit, ..
            } => {
                assert_eq!(local_id, &messages[0].local_id);
                assert_eq!(*limit, MAX_EDGE_BATCH_BYTES);
            }
            other => panic!("unexpected error: {other}"),
        }
        // The message is named in the sentence, so a log line identifies it.
        assert!(error.to_string().contains(&messages[0].local_id));
    }

    #[test]
    fn local_id_is_deterministic() {
        let first = edge_local_id("com.whatsapp", 42, 1_763_600_000_000);
        let second = edge_local_id("com.whatsapp", 42, 1_763_600_000_000);
        assert_eq!(first, second);
        assert_eq!(first, "notif:com.whatsapp:42:1763600000000");

        // A different notification instance is a different message.
        assert_ne!(first, edge_local_id("com.whatsapp", 43, 1_763_600_000_000));
        assert_ne!(first, edge_local_id("com.whatsapp", 42, 1_763_600_000_001));
    }

    #[test]
    fn max_per_batch_is_clamped_and_empty_input_is_no_batch() {
        let messages: Vec<EdgeInboundMessage> = (0..3).map(|i| message(i, 4)).collect();
        assert!(
            chunk_edge_batch("dev", &[], 500)
                .expect("chunks")
                .is_empty()
        );
        assert_eq!(
            chunk_edge_batch("dev", &messages, 0).expect("chunks").len(),
            3
        );
        assert_eq!(
            chunk_edge_batch("dev", &messages, 1).expect("chunks").len(),
            3
        );
    }

    #[test]
    fn wire_shape_matches_the_edge_route() {
        let batch = EdgeIncomingBatch {
            device_id: "dev_test_001".into(),
            messages: vec![message(0, 4)],
        };
        let value = serde_json::to_value(&batch).expect("json");
        assert_eq!(value["device_id"], "dev_test_001");
        let row = &value["messages"][0];
        // The Worker reads exactly these snake_case keys.
        for key in ["channel", "local_id", "sender", "body", "received_at"] {
            assert!(row.get(key).is_some(), "missing key {key}");
        }
    }

    #[test]
    fn default_feature_set_compiles_the_module() {
        // The default build has the batch/upload code and no protocol adapter.
        let messages = vec![message(0, 4)];
        let chunks = chunk_edge_batch("dev", &messages, 500).expect("chunks");
        assert_eq!(chunks.len(), 1);

        #[cfg(all(not(feature = "mtproto"), not(feature = "wa-linked")))]
        assert!(!EDGE_ADAPTERS_COMPILED);
        #[cfg(feature = "mtproto")]
        assert!(EDGE_ADAPTERS_COMPILED);
        #[cfg(feature = "wa-linked")]
        assert!(EDGE_ADAPTERS_COMPILED);
    }

    /* ---- store and flush behaviour -------------------------------------- */

    async fn paired_store() -> (tempfile::TempDir, Store, String) {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = Store::open(dir.path().join("sim.db")).await.expect("store");
        let (device, _) = store
            .create_device(NewDevice {
                label: "edge-test",
                platform: "simulator",
                platform_id: None,
                carrier: None,
                sim_slot: 0,
            })
            .await
            .expect("device");
        (dir, store, device.device_id)
    }

    fn client_for(device_id: &str, base_url: String) -> DeviceClient {
        let identity = crate::generate_identity().expect("identity");
        DeviceClient::new(
            Target::new(base_url, None).expect("target"),
            device_id.to_string(),
            identity.private_key_pkcs8_pem,
        )
    }

    /// One local endpoint that records each request body and answers 200.
    fn serve_batch_requests(
        expected: usize,
    ) -> (String, std::thread::JoinHandle<Vec<serde_json::Value>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        let address = listener.local_addr().expect("addr");
        let handle = std::thread::spawn(move || {
            use std::io::{Read, Write};

            let mut bodies = Vec::new();
            for _ in 0..expected {
                let Ok((mut stream, _)) = listener.accept() else {
                    break;
                };
                let mut raw = Vec::new();
                let mut chunk = [0_u8; 4096];
                loop {
                    let read = stream.read(&mut chunk).unwrap_or(0);
                    if read == 0 {
                        break;
                    }
                    raw.extend_from_slice(&chunk[..read]);

                    let Some(header_end) = raw.windows(4).position(|w| w == b"\r\n\r\n") else {
                        continue;
                    };
                    let head = String::from_utf8_lossy(&raw[..header_end]);
                    let length = head
                        .lines()
                        .find_map(|line| {
                            let lower = line.to_ascii_lowercase();
                            lower
                                .strip_prefix("content-length:")
                                .and_then(|value| value.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    let total = header_end + 4 + length;
                    while raw.len() < total {
                        let read = stream.read(&mut chunk).unwrap_or(0);
                        if read == 0 {
                            break;
                        }
                        raw.extend_from_slice(&chunk[..read]);
                    }

                    bodies.push(serde_json::from_slice(&raw[header_end + 4..]).expect("json body"));
                    let body = "{\"accepted\":1,\"duplicates\":0,\"commands\":[]}";
                    let response = format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = stream.write_all(response.as_bytes());
                    break;
                }
            }
            bodies
        });
        (format!("http://{address}"), handle)
    }

    #[tokio::test]
    async fn edge_body_survives_round_trip_at_20000_characters() {
        let (_dir, store, device_id) = paired_store().await;
        let body = "x".repeat(20_000);
        let mut inbound = message(1, 0);
        inbound.body = body.clone();

        record_edge_inbound(&store, Some(&device_id), &inbound)
            .await
            .expect("record");

        let pending = store
            .list_pending_edge_inbound(&device_id, 10)
            .await
            .expect("pending");
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].0, "whatsapp_personal");
        assert_eq!(pending[0].1.body.len(), 20_000);
        assert_eq!(pending[0].1.body, body);
    }

    #[tokio::test]
    async fn oversized_edge_row_is_not_in_the_sms_pending_set() {
        let (_dir, store, device_id) = paired_store().await;

        store
            .record_message(
                &device_id,
                "in",
                "+15550001111",
                "hello",
                "received",
                Some("native-1"),
            )
            .await
            .expect("sms row");
        let mut huge = message(2, 0);
        huge.local_id = "notif:com.whatsapp:2:1763600000002".into();
        huge.body = "y".repeat(MAX_EDGE_BATCH_BYTES + 10_000);
        record_edge_inbound(&store, Some(&device_id), &huge)
            .await
            .expect("edge row");

        let sms = store
            .list_pending_inbound(&device_id, 10)
            .await
            .expect("sms");
        assert_eq!(sms.len(), 1);
        assert_eq!(sms[0].peer, "+15550001111");
        assert!(
            sms.iter()
                .all(|row| row.local_id.as_deref() != Some(huge.local_id.as_str())),
            "an edge row must never appear in the SMS pending set"
        );

        let edge = store
            .list_pending_edge_inbound(&device_id, 10)
            .await
            .expect("edge");
        assert_eq!(edge.len(), 1);
        assert_eq!(edge[0].1.local_id.as_deref(), Some(huge.local_id.as_str()));
    }

    #[tokio::test]
    async fn sms_flush_completes_while_an_oversized_edge_row_is_pending() {
        let (_dir, store, device_id) = paired_store().await;

        store
            .record_message(
                &device_id,
                "in",
                "+15550001111",
                "hello",
                "received",
                Some("native-1"),
            )
            .await
            .expect("sms row");
        let mut huge = message(3, 0);
        huge.local_id = "notif:com.whatsapp:3:1763600000003".into();
        huge.body = "z".repeat(MAX_EDGE_BATCH_BYTES + 10_000);
        record_edge_inbound(&store, Some(&device_id), &huge)
            .await
            .expect("edge row");

        let (base_url, server) = serve_batch_requests(1);
        let client = client_for(&device_id, base_url);

        // The SMS flush sees only the SMS row and succeeds; the oversized edge
        // row is still pending and did not travel with it.
        let flushed = crate::carrier::flush_pending(&store, &client, &device_id)
            .await
            .expect("sms flush");
        assert_eq!(flushed.inbound, 1);

        let requests = server.join().expect("server");
        assert_eq!(requests.len(), 1);
        let uploaded = requests[0]["messages"].as_array().expect("messages");
        assert_eq!(uploaded.len(), 1);
        assert_eq!(uploaded[0]["sender_e164"], "+15550001111");

        let pending = store
            .list_pending_edge_inbound(&device_id, 10)
            .await
            .expect("pending");
        assert_eq!(pending.len(), 1, "the edge row is left for the edge flush");
    }

    #[tokio::test]
    async fn edge_flush_sends_the_whole_body_and_reports_the_oversized_row() {
        let (_dir, store, device_id) = paired_store().await;

        let whole_body = "ম".repeat(20_000);
        let mut fits = message(4, 0);
        fits.local_id = "notif:com.whatsapp:4:1763600000004".into();
        fits.body = whole_body.clone();
        record_edge_inbound(&store, Some(&device_id), &fits)
            .await
            .expect("fitting row");

        let mut huge = message(5, 0);
        huge.local_id = "notif:com.whatsapp:5:1763600000005".into();
        huge.body = "w".repeat(MAX_EDGE_BATCH_BYTES + 10_000);
        record_edge_inbound(&store, Some(&device_id), &huge)
            .await
            .expect("oversized row");

        // One request: the fitting row only.
        let (base_url, server) = serve_batch_requests(1);
        let client = client_for(&device_id, base_url);

        let flushed = flush_edge_pending(&store, &client, &device_id, 500)
            .await
            .expect("edge flush");
        assert_eq!(flushed.uploaded, 1);
        assert_eq!(flushed.batches, 1);
        assert_eq!(flushed.refused.len(), 1);
        assert_eq!(flushed.refused[0].local_id, huge.local_id);
        assert!(flushed.refused[0].bytes > MAX_EDGE_BATCH_BYTES);

        let requests = server.join().expect("server");
        assert_eq!(requests.len(), 1);
        let sent = &requests[0]["messages"][0];
        assert_eq!(sent["local_id"], fits.local_id);
        assert_eq!(
            sent["body"].as_str().expect("body").chars().count(),
            20_000,
            "the whole personal message is uploaded, not a clamp"
        );
        assert_eq!(sent["body"].as_str().expect("body"), whole_body);

        // The oversized row stays pending so the call is repeated and visible.
        let pending = store
            .list_pending_edge_inbound(&device_id, 10)
            .await
            .expect("pending");
        assert_eq!(pending.len(), 1);
        assert_eq!(
            pending[0].1.local_id.as_deref(),
            Some(huge.local_id.as_str())
        );
    }
}
