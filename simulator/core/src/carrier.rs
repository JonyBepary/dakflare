//! Carrier simulation.
//!
//! The only genuinely fake part of the app. Inbound SMS is injected here instead
//! of arriving from a radio; outbound SMS is captured from the command queue
//! instead of being handed to `SmsManager`. Everything between (identity,
//! signing, protocol, storage) is the real thing.

use std::time::{SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};

use dakflare_flow::Action;

use crate::db::{Message, Store, StoreError};
use crate::flowrun::{RemoteFlow, run_flows};
use crate::protocol::{DeviceClient, InboundMessage, OutboundReport, ProtocolError};

/// The JNI surface caps these before calling in; the core repeats the check so a
/// future caller cannot bypass them.
const MAX_SENDER_LEN: usize = 64;
const MAX_BODY_LEN: usize = 4096;

#[derive(Debug, thiserror::Error)]
pub enum CarrierError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error(transparent)]
    Protocol(#[from] ProtocolError),
    /// No device exists locally, so an inbound SMS has nothing to belong to.
    /// The app must be paired before the receiver can persist messages.
    #[error("device is not paired")]
    Unpaired,
    #[error("invalid inbound message: {0}")]
    InvalidInput(&'static str),
}

#[derive(Debug)]
pub struct Injected {
    pub message: Message,
    pub uploaded: bool,
    pub accepted: u64,
    pub duplicates: u64,
    /// Commands the upload response already delivered. The incoming handler ends
    /// by reading the pending queue, so a freshly enqueued auto-reply comes back
    /// in the same response and is marked DISPATCHED by the DO. A later poll
    /// would not see it — this is the intended low-latency path.
    pub captured: Vec<Message>,
    /// Messages the DEVICE produced by running its own flows.
    pub device_sent: usize,
    /// Messages the WORKER fallback produced (flows the device did not run).
    pub fallback: usize,
}

/// Record an SMS that arrived on the real radio while no Tauri runtime was
/// running (the Android `SmsReceiver` path).
///
/// Unlike [`inject_inbound`] this never uploads: there is no target, no signed
/// client and no flow runner in that process yet (M5.1 is persistence only).
/// The row is written through [`Store::record_message`], the same insert path the
/// simulator uses.
///
/// `device_id` may be `Some` when a caller already knows which paired device owns
/// the message. Otherwise the store decides: the only device, or the most
/// recently paired one when several exist. An empty store is [`CarrierError::Unpaired`].
///
/// `received_at_ms` is the PDU timestamp. It is part of the deterministic
/// `local_id`, so a broadcast Android delivers twice resolves to the row written
/// by the first delivery instead of inserting a second copy.
pub async fn receive_offline(
    store: &Store,
    device_id: Option<&str>,
    sender: &str,
    body: &str,
    received_at_ms: i64,
) -> Result<Message, CarrierError> {
    let sender = sender.trim();
    if sender.is_empty() || sender.len() > MAX_SENDER_LEN {
        return Err(CarrierError::InvalidInput("sender"));
    }
    if body.len() > MAX_BODY_LEN {
        return Err(CarrierError::InvalidInput("body"));
    }

    let device_id = resolve_device(store, device_id).await?;
    let local_id = offline_local_id(sender, received_at_ms);

    // The common re-delivery path: the row is already there.
    if let Some(existing) = store.message_by_local_id(&device_id, &local_id).await? {
        return Ok(existing);
    }

    match store
        .record_message(&device_id, "in", sender, body, "received", Some(&local_id))
        .await
    {
        Ok(message) => Ok(message),
        // A duplicate broadcast racing this one hits `UNIQUE(device_id,
        // local_id)`. Treat that as success and return the winner's row.
        Err(error) => match store.message_by_local_id(&device_id, &local_id).await? {
            Some(existing) => Ok(existing),
            None => Err(CarrierError::Store(error)),
        },
    }
}

/// Receive one SMS and run the locally persisted flows against it.
///
/// The inbound row is written first, through [`receive_offline`], so a failure
/// while running flows never loses the message. Every `Action::SendSms` is then
/// recorded as an outbound `queued` row with a local id derived from the inbound
/// row and the action's position: the existing mirror path uploads it later, and
/// a re-delivered broadcast finds those rows already there.
///
/// Only actions recorded by this call are returned. A re-delivered broadcast
/// therefore returns no actions, which stops the Android receiver from sending a
/// second SMS for the same message (the retry queue is M5.5's job).
pub async fn receive_and_reply(
    store: &Store,
    device_id: Option<&str>,
    sender: &str,
    body: &str,
    received_at_ms: i64,
) -> Result<(Message, Vec<Action>), CarrierError> {
    let message = receive_offline(store, device_id, sender, body, received_at_ms).await?;

    // Always set by `receive_offline`; a row without one has no stable dedupe
    // key, so it is stored but not answered.
    let Some(inbound_local_id) = message.local_id.clone() else {
        return Ok((message, Vec::new()));
    };

    let flows = match store.load_flows().await {
        Ok(flows) => flows,
        Err(error) => {
            // The inbound row is already written; an unreadable flow cache is a
            // reason not to answer, never a reason to lose the message.
            eprintln!("[carrier] stored flows unavailable: {error}");
            return Ok((message, Vec::new()));
        }
    };
    if flows.is_empty() {
        return Ok((message, Vec::new()));
    }

    let run = run_flows(&flows, &inbound_local_id, &message.peer, &message.body);

    // Persist the run before anything else so a later flush can report it. The
    // inbound row is already written, so a failed insert must not lose the
    // message: the reply still goes out and the Worker simply does not learn
    // about this run. Nothing here logs a body or a number.
    for report in &run.reports {
        if let Err(error) = store.record_run(&message.device_id, report).await {
            eprintln!("[carrier] flow run not recorded: {error}");
        }
    }

    let mut actions = Vec::new();
    for (index, action) in run.actions.iter().enumerate() {
        let Action::SendSms { to, body } = action;
        let outbound_local_id = reply_local_id(&inbound_local_id, index);

        if store
            .message_by_local_id(&message.device_id, &outbound_local_id)
            .await?
            .is_some()
        {
            continue;
        }

        match store
            .record_message(
                &message.device_id,
                "out",
                to,
                body,
                "queued",
                Some(&outbound_local_id),
            )
            .await
        {
            Ok(_) => actions.push(action.clone()),
            // A duplicate broadcast racing this one hit UNIQUE(device_id,
            // local_id). The winner already represents the reply.
            Err(error) => {
                if store
                    .message_by_local_id(&message.device_id, &outbound_local_id)
                    .await?
                    .is_none()
                {
                    return Err(CarrierError::Store(error));
                }
            }
        }
    }

    Ok((message, actions))
}

/// The deterministic outbound id for one reply. Same inbound delivery and same
/// action index always resolve to the same row. Public so the JNI layer can name
/// the row it just returned an action for without re-implementing the rule.
pub fn reply_local_id(inbound_local_id: &str, action_index: usize) -> String {
    format!("{inbound_local_id}-reply-{action_index}")
}

/// Pick the device an inbound message belongs to. No "default device" flag
/// exists in the schema, so a store with more than one row uses the most
/// recently paired/updated device.
async fn resolve_device(store: &Store, requested: Option<&str>) -> Result<String, CarrierError> {
    if let Some(device_id) = requested {
        return match store.get_device(device_id).await? {
            Some(device) => Ok(device.device_id),
            None => Err(CarrierError::Unpaired),
        };
    }

    let devices = store.list_devices().await?;
    match devices.len() {
        0 => Err(CarrierError::Unpaired),
        1 => Ok(devices[0].device_id.clone()),
        _ => store
            .latest_device()
            .await?
            .map(|device| device.device_id)
            .ok_or(CarrierError::Unpaired),
    }
}

/// Deterministic id from the PDU timestamp + sender. Same delivery (even a
/// re-delivery) hashes to the same value; a different sender at the same
/// millisecond does not.
fn offline_local_id(sender: &str, received_at_ms: i64) -> String {
    let mut hasher = Sha256::new();
    hasher.update(received_at_ms.to_le_bytes());
    hasher.update(b"\0");
    hasher.update(sender.as_bytes());
    let digest = hasher.finalize();

    let mut out = String::with_capacity(7 + 32);
    out.push_str("native-");
    for byte in &digest[..16] {
        use std::fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    out
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
    flows: Option<&[RemoteFlow]>,
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
            captured: Vec::new(),
            device_sent: 0,
            fallback: 0,
        });
    }

    let client = client.expect("checked above");

    // Device-first: run the flows here, before the upload, so the run can be
    // reported in the same request and the Worker fallback stays out of the way.
    let mut captured: Vec<Message> = Vec::new();
    let mut runs = Vec::new();
    if let Some(flows) = flows {
        if !flows.is_empty() {
            let local = run_flows(flows, &local_id, sender, body);
            for action in &local.actions {
                // `Action` has one variant today; an explicit match keeps new
                // action types from being silently ignored when they land.
                match action {
                    dakflare_flow::Action::SendSms { to, body } => {
                        let outbound_id = format!("out-{}", random_hex(8)?);
                        captured.push(
                            store
                                .record_message(
                                    device_id,
                                    "out",
                                    to,
                                    body,
                                    "sent",
                                    Some(&outbound_id),
                                )
                                .await?,
                        );
                    }
                }
            }
            runs = local.reports;
        }
    }

    // Everything unsent-to-the-log, including a backlog from a previous failed
    // mirror, rides along in this same request.
    let pending = store.list_unmirrored_outbound(device_id, 100).await?;
    let reports: Vec<OutboundReport> = pending
        .iter()
        .filter_map(|message| {
            Some(OutboundReport {
                local_id: message.local_id.clone()?,
                to: message.peer.clone(),
                body: message.body.clone(),
                sent_at: message.created_at,
                state: Some(message.state.clone()),
                error: message.last_error.clone(),
            })
        })
        .collect();

    let response = client
        .upload_batch(
            &[InboundMessage {
                local_id,
                sender: sender.to_string(),
                body: body.to_string(),
                received_at: now_ms(),
            }],
            &[],
            &runs,
            &reports,
        )
        .await?;

    if !reports.is_empty() {
        let ids: Vec<String> = pending.iter().map(|m| m.id.clone()).collect();
        store.mark_mirrored(&ids).await?;
    }

    let accepted = response.get("accepted").and_then(|v| v.as_u64()).unwrap_or(0);
    let duplicates = response
        .get("duplicates")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    if accepted > 0 || duplicates > 0 {
        store.set_message_state(&message.id, "uploaded").await?;
    }

    // Fallback replies (flows the device did not run) arrive in this response.
    let device_sent = captured.len();
    let commands = response.get("commands").cloned().unwrap_or(serde_json::Value::Null);
    let fallback_messages = capture_commands(store, client, device_id, &commands).await?;
    let fallback = fallback_messages.len();
    captured.extend(fallback_messages);

    Ok(Injected {
        message,
        uploaded: true,
        accepted,
        duplicates,
        captured,
        device_sent,
        fallback,
    })
}

/// Record each command as an outbound message, then acknowledge it so the
/// Worker stops redelivering it.
async fn capture_commands(
    store: &Store,
    client: &DeviceClient,
    device_id: &str,
    commands: &serde_json::Value,
) -> Result<Vec<Message>, CarrierError> {
    let entries = commands.as_array().cloned().unwrap_or_default();
    let mut captured = Vec::new();
    let mut ack_ids: Vec<String> = Vec::new();

    for entry in entries {
        let command_id = entry
            .get("command_id")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
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

        // The row's local id is the command id. That keeps one identity for the
        // command from the moment it is collected until its receipt is
        // reported, which is what lets `report_command_state` address the
        // Worker's state machine without a second column.
        let message = store
            .record_message(device_id, "out", &to, &body, "queued", Some(&command_id))
            .await?;
        ack_ids.push(command_id);
        captured.push(message);
    }

    if !ack_ids.is_empty() {
        client.poll(&ack_ids).await?;
        // Deliberately NOT `set_message_state(..., "sent")`. Acknowledging a
        // command says the phone holds it, not that the radio transmitted it;
        // the row stays `queued` until the send path marks it from its own
        // SENT/DELIVERED receipt. Claiming `sent` here made every Worker-queued
        // message look delivered while nothing had touched the radio.
        //
        // Mirror what the device now holds. Best effort: an unsent row keeps
        // `mirrored = 0` and is retried on the next sync, and the state change
        // when the radio reports re-opens it for mirroring.
        if let Err(error) = mirror_pending(store, client, device_id).await {
            eprintln!("[carrier] outbound mirror failed: {error}");
        }
    }

    Ok(captured)
}

/// `poll` → capture every queued command as an outbound message → ack them.
///
/// Acknowledgement happens in a second poll, exactly as a device would do, so the
/// command leaves `PENDING`/`DISPATCHED` and stops being redelivered.
/// Report a command's terminal state to the deployment.
///
/// The Worker's command state machine is keyed by `command_id`, and a row this
/// device captured carries that id as its `local_id`. Composer sends and flow
/// replies mint their own ids, so the shape check keeps their states out of a
/// request the Worker would only reject.
///
/// Returns whether a report was sent. A rejected transition is a successful
/// no-op (§6.1), so an already-terminal command is not an error.
pub async fn report_command_state(
    client: &DeviceClient,
    local_id: &str,
    state: &str,
) -> Result<bool, CarrierError> {
    let Some(status) = protocol_status(state) else {
        return Ok(false);
    };
    if !looks_like_command_id(local_id) {
        return Ok(false);
    }
    client
        .report_status(&[(local_id.to_string(), status.to_string())])
        .await?;
    Ok(true)
}

fn protocol_status(state: &str) -> Option<&'static str> {
    match state {
        "sent" => Some("SENT"),
        "failed" => Some("FAILED"),
        "delivered" => Some("DELIVERED"),
        _ => None,
    }
}

/// `crypto.randomUUID()` on the Worker: 8-4-4-4-12 hex. Ids minted on the phone
/// are `out-…` or `native-…`, so this cannot match one of those.
fn looks_like_command_id(value: &str) -> bool {
    value.len() == 36
        && value.char_indices().all(|(index, ch)| match index {
            8 | 13 | 18 | 23 => ch == '-',
            _ => ch.is_ascii_hexdigit(),
        })
}

pub async fn drain_outbox(
    store: &Store,
    client: &DeviceClient,
    device_id: &str,
) -> Result<Vec<Message>, CarrierError> {
    let commands = client.poll(&[]).await?;
    capture_commands(store, client, device_id, &commands).await
}


/// Pull this deployment's flow set for this device into the local cache.
///
/// The fetched list is authoritative: [`Store::replace_flows`] replaces every
/// cached row, so a flow deleted on the Worker stops running here and an empty
/// answer clears the cache. Returns how many flows are now cached.
///
/// A failed fetch returns the protocol error and leaves the previous cache
/// untouched, which is what lets the background receiver keep answering with
/// the last good set.
pub async fn sync_flows(store: &Store, client: &DeviceClient) -> Result<usize, CarrierError> {
    let flows = client.fetch_flows().await?;
    store.replace_flows(&flows).await?;
    Ok(flows.len())
}

/// The window the deployment accepts, mirroring `incoming.ts`.
const WINDOW_PAST_MS: i64 = 180 * 24 * 60 * 60 * 1000;
const WINDOW_FUTURE_MS: i64 = 24 * 60 * 60 * 1000;

/// Split rows into the ones the deployment will accept and the ones it never
/// will, so a single stale row cannot block every later upload.
fn split_window(
    rows: Vec<crate::db::Message>,
    now: i64,
) -> (Vec<crate::db::Message>, Vec<crate::db::Message>) {
    rows.into_iter().partition(|message| {
        message.created_at >= now - WINDOW_PAST_MS && message.created_at <= now + WINDOW_FUTURE_MS
    })
}

/// Counts from one native flush.
#[derive(Debug)]
pub struct Flushed {
    pub inbound: usize,
    pub outbound: usize,
}

/// Upload everything the deployment has not accepted yet in one request:
/// pending inbound rows, their stored flow runs and unmirrored outbound rows.
///
/// One request keeps the console consistent, so an inbound row cannot appear
/// without its run and reply (or the other way round). A retry is free because
/// every key is idempotent: inbound rows dedupe on `(device_id, local_id)`,
/// runs on `(device_id, local_id, flow_id, flow_version)` and outbound rows on
/// `(device_id, local_id)`.
///
/// Rows are marked as accepted only after the request succeeds. A row without a
/// `local_id` cannot be keyed, so it is skipped in the payload and left pending.
///
/// M5.5's states travel with the row: `queued`, `sent`, `failed` and the
/// terminal `delivered` are all reported with their `last_error`, so the
/// console can tell a refused reply from one that is merely waiting. A later
/// transition resets `mirrored`, which is what turns the second upload into an
/// update of the same `(device_id, local_id)` row rather than a duplicate.
pub async fn flush_pending(
    store: &Store,
    client: &DeviceClient,
    device_id: &str,
) -> Result<Flushed, CarrierError> {
    let now = now_ms();
    // The deployment refuses a timestamp it cannot believe. One such row used to
    // poison the whole batch: nothing uploaded, ever, and the queue grew behind
    // it. Rows outside the window are retired locally instead — an inbound row
    // becomes `failed` with the reason, an outbound row stops being offered.
    let (inbound, stale_inbound) = split_window(store.list_pending_inbound(device_id, 100).await?, now);
    let (outbound, stale_outbound) =
        split_window(store.list_unmirrored_outbound(device_id, 100).await?, now);

    for message in &stale_inbound {
        // `failed` keeps it out of the queue and out of the mirror, and it stays
        // visible on the phone as what it is: a message this deployment refused.
        let _ = store
            .set_message_state(&message.id, "failed")
            .await;
    }
    if !stale_outbound.is_empty() {
        let ids: Vec<String> = stale_outbound.iter().map(|m| m.id.clone()).collect();
        let _ = store.mark_mirrored(&ids).await;
    }

    if inbound.is_empty() && outbound.is_empty() {
        return Ok(Flushed {
            inbound: 0,
            outbound: 0,
        });
    }

    let local_ids: Vec<String> = inbound
        .iter()
        .filter_map(|message| message.local_id.clone())
        .collect();
    let runs = store.list_runs_for_inbound(device_id, &local_ids).await?;

    let messages: Vec<InboundMessage> = inbound
        .iter()
        .filter_map(|message| {
            Some(InboundMessage {
                local_id: message.local_id.clone()?,
                sender: message.peer.clone(),
                body: message.body.clone(),
                received_at: message.created_at,
            })
        })
        .collect();

    let reports: Vec<OutboundReport> = outbound
        .iter()
        .filter_map(|message| {
            Some(OutboundReport {
                local_id: message.local_id.clone()?,
                to: message.peer.clone(),
                body: message.body.clone(),
                sent_at: message.created_at,
                state: Some(message.state.clone()),
                error: message.last_error.clone(),
            })
        })
        .collect();

    client.upload_batch(&messages, &[], &runs, &reports).await?;

    let outbound_ids: Vec<String> = outbound.iter().map(|m| m.id.clone()).collect();
    store.mark_mirrored(&outbound_ids).await?;
    for message in &inbound {
        if message.local_id.is_some() {
            store.set_message_state(&message.id, "uploaded").await?;
        }
    }

    Ok(Flushed {
        inbound: messages.len(),
        outbound: reports.len(),
    })
}

/// Upload any outbound rows the deployment has not accepted yet.
pub async fn mirror_pending(
    store: &Store,
    client: &DeviceClient,
    device_id: &str,
) -> Result<usize, CarrierError> {
    let pending = store.list_unmirrored_outbound(device_id, 100).await?;
    if pending.is_empty() {
        return Ok(0);
    }

    let reports: Vec<OutboundReport> = pending
        .iter()
        .filter_map(|message| {
            Some(OutboundReport {
                local_id: message.local_id.clone()?,
                to: message.peer.clone(),
                body: message.body.clone(),
                sent_at: message.created_at,
                state: Some(message.state.clone()),
                error: message.last_error.clone(),
            })
        })
        .collect();

    if reports.is_empty() {
        return Ok(0);
    }

    client.upload_outbound(&reports).await?;
    let ids: Vec<String> = pending.iter().map(|m| m.id.clone()).collect();
    store.mark_mirrored(&ids).await?;
    Ok(pending.len())
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
    use crate::Target;
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
            inject_inbound(&store, None, &device.device_id, "+15550001111", "CODE 483920", true, None)
                .await
                .unwrap();

        assert!(!injected.uploaded);
        assert!(injected.captured.is_empty());
        assert_eq!(injected.message.direction, "in");
        assert_eq!(injected.message.body, "CODE 483920");
        assert_eq!(injected.message.state, "received");

        let thread = store.list_messages(&device.device_id, 50).await.unwrap();
        assert_eq!(thread.len(), 1);
        assert_eq!(thread[0].peer, "+15550001111");

        assert_eq!(store.clear_messages(&device.device_id).await.unwrap(), 1);
        assert!(store.list_messages(&device.device_id, 50).await.unwrap().is_empty());
    }

    async fn paired_store() -> (tempfile::TempDir, Store, crate::db::Device) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("sim.db")).await.unwrap();
        let (device, _) = store
            .create_device(NewDevice {
                label: "radio",
                platform: "android",
                platform_id: None,
                carrier: None,
                sim_slot: 0,
            })
            .await
            .unwrap();
        (dir, store, device)
    }

    #[tokio::test]
    async fn offline_receive_is_idempotent_for_one_pdu() {
        let (_dir, store, device) = paired_store().await;
        let received_at = 1_776_470_400_000;

        let first = receive_offline(&store, None, "+15550001111", "CODE 483920", received_at)
            .await
            .unwrap();
        let second = receive_offline(&store, None, "+15550001111", "CODE 483920", received_at)
            .await
            .unwrap();

        assert_eq!(first.id, second.id, "a re-delivered broadcast reuses the row");
        assert_eq!(first.local_id, second.local_id);
        assert!(first.local_id.as_deref().unwrap().starts_with("native-"));
        assert_eq!(first.direction, "in");
        assert_eq!(first.state, "received");
        assert_eq!(first.device_id, device.device_id);

        let rows = store.list_messages(&device.device_id, 50).await.unwrap();
        assert_eq!(rows.len(), 1);
    }

    #[tokio::test]
    async fn offline_receive_keeps_different_senders_apart() {
        let (_dir, store, device) = paired_store().await;

        receive_offline(&store, None, "+15550001111", "one", 1_776_470_400_000)
            .await
            .unwrap();
        receive_offline(&store, None, "+15550002222", "two", 1_776_470_400_000)
            .await
            .unwrap();

        let rows = store.list_messages(&device.device_id, 50).await.unwrap();
        assert_eq!(rows.len(), 2);
    }

    #[tokio::test]
    async fn offline_receive_requires_a_paired_device() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("sim.db")).await.unwrap();

        let error = receive_offline(&store, None, "+15550001111", "hi", 1).await.unwrap_err();
        assert!(matches!(error, CarrierError::Unpaired));
    }

    #[tokio::test]
    async fn offline_receive_prefers_the_most_recent_device() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("sim.db")).await.unwrap();
        let (older, _) = store
            .create_device(NewDevice {
                label: "older",
                platform: "android",
                platform_id: None,
                carrier: None,
                sim_slot: 0,
            })
            .await
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        let (newer, _) = store
            .create_device(NewDevice {
                label: "newer",
                platform: "android",
                platform_id: None,
                carrier: None,
                sim_slot: 0,
            })
            .await
            .unwrap();

        let message = receive_offline(&store, None, "+15550001111", "hi", 1_776_470_400_000)
            .await
            .unwrap();

        assert_eq!(message.device_id, newer.device_id);
        assert_ne!(message.device_id, older.device_id);
    }

    #[test]
    fn a_row_older_than_the_deployment_window_is_split_out() {
        let now = 1_793_000_000_000i64;
        let build = |created_at: i64| crate::db::Message {
            id: format!("msg{created_at}"),
            device_id: "dev_test".into(),
            direction: "in".into(),
            peer: "+15550001111".into(),
            body: "hi".into(),
            state: "received".into(),
            local_id: Some(format!("native-{created_at}")),
            created_at,
            last_error: None,
        };

        let fresh = build(now - 1_000);
        let old = build(now - WINDOW_PAST_MS - 1);
        let future = build(now + WINDOW_FUTURE_MS + 1);
        let (keep, drop) = split_window(vec![fresh.clone(), old, future], now);

        assert_eq!(keep.len(), 1);
        assert_eq!(keep[0].id, fresh.id);
        assert_eq!(drop.len(), 2, "a row the deployment would refuse must not ride along");
    }

    #[tokio::test]
    async fn offline_receive_rejects_oversized_input() {
        let (_dir, store, _device) = paired_store().await;

        let long_body = "x".repeat(MAX_BODY_LEN + 1);
        let error = receive_offline(&store, None, "+15550001111", &long_body, 1)
            .await
            .unwrap_err();
        assert!(matches!(error, CarrierError::InvalidInput("body")));

        let long_sender = "1".repeat(MAX_SENDER_LEN + 1);
        let error = receive_offline(&store, None, &long_sender, "hi", 1)
            .await
            .unwrap_err();
        assert!(matches!(error, CarrierError::InvalidInput("sender")));
    }

    fn reply_flow(id: &str, version: i64, body: &str) -> crate::flowrun::RemoteFlow {
        crate::flowrun::RemoteFlow {
            id: id.into(),
            version,
            graph: serde_json::json!({
                "nodes": [
                    { "id": "t1", "type": "trigger", "data": { "kind": "incoming" } },
                    { "id": "s1", "type": "send_sms", "data": {
                        "to": "{{sender}}", "body": body } },
                    { "id": "e1", "type": "stop", "data": {} }
                ],
                "edges": [
                    { "id": "a", "source": "t1", "target": "s1" },
                    { "id": "b", "source": "s1", "target": "e1" }
                ]
            }),
        }
    }

    #[tokio::test]
    async fn receive_and_reply_records_one_queued_outbound_row() {
        let (_dir, store, device) = paired_store().await;
        store
            .replace_flows(&[reply_flow("wf_reply", 1, "got it")])
            .await
            .unwrap();
        let received_at = 1_776_470_400_000;

        let (message, actions) =
            receive_and_reply(&store, None, "+15550001111", "ping", received_at)
                .await
                .unwrap();

        assert_eq!(message.direction, "in");
        assert_eq!(actions.len(), 1);
        assert_eq!(
            actions[0],
            Action::SendSms {
                to: "+15550001111".into(),
                body: "got it".into(),
            }
        );

        let outbound = store
            .list_unmirrored_outbound(&device.device_id, 10)
            .await
            .unwrap();
        assert_eq!(outbound.len(), 1);
        assert_eq!(outbound[0].peer, "+15550001111");
        assert_eq!(outbound[0].body, "got it");
        assert_eq!(outbound[0].state, "queued");
        let expected = format!(
            "{}-reply-0",
            message.local_id.as_deref().expect("inbound local id")
        );
        assert_eq!(outbound[0].local_id.as_deref(), Some(expected.as_str()));
    }

    #[tokio::test]
    async fn receive_and_reply_persists_its_run_for_the_flush() {
        let (_dir, store, device) = paired_store().await;
        store
            .replace_flows(&[reply_flow("wf_reply", 1, "got it")])
            .await
            .unwrap();
        let received_at = 1_776_470_400_000;

        let (message, _) = receive_and_reply(&store, None, "+15550001111", "ping", received_at)
            .await
            .unwrap();
        let inbound_id = message.local_id.clone().expect("inbound local id");

        // The row is still `received`, so a flush will pick it up.
        let pending = store
            .list_pending_inbound(&device.device_id, 10)
            .await
            .unwrap();
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].id, message.id);
        assert_eq!(pending[0].state, "received");

        let runs = store
            .list_runs_for_inbound(&device.device_id, std::slice::from_ref(&inbound_id))
            .await
            .unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].local_id, inbound_id);
        assert_eq!(runs[0].flow_id, "wf_reply");
        assert_eq!(runs[0].flow_version, 1);

        // A re-delivered broadcast reports the same run again; the UNIQUE key
        // makes that insert a no-op.
        receive_and_reply(&store, None, "+15550001111", "ping", received_at)
            .await
            .unwrap();
        let again = store
            .list_runs_for_inbound(&device.device_id, std::slice::from_ref(&inbound_id))
            .await
            .unwrap();
        assert_eq!(again.len(), 1);
    }

    #[tokio::test]
    async fn redelivered_broadcast_does_not_reply_twice() {
        let (_dir, store, device) = paired_store().await;
        store
            .replace_flows(&[reply_flow("wf_reply", 1, "got it")])
            .await
            .unwrap();
        let received_at = 1_776_470_400_000;

        let (_, first) = receive_and_reply(&store, None, "+15550001111", "ping", received_at)
            .await
            .unwrap();
        let (again, second) = receive_and_reply(&store, None, "+15550001111", "ping", received_at)
            .await
            .unwrap();

        assert_eq!(first.len(), 1);
        assert!(
            second.is_empty(),
            "a re-delivery must not send a second reply"
        );
        assert_eq!(again.state, "received");

        let rows = store.list_messages(&device.device_id, 50).await.unwrap();
        assert_eq!(
            rows.len(),
            2,
            "one inbound and one outbound row, never two of each"
        );
        let outbound = store
            .list_unmirrored_outbound(&device.device_id, 10)
            .await
            .unwrap();
        assert_eq!(outbound.len(), 1);
    }

    #[tokio::test]
    async fn no_stored_flows_means_no_reply_but_the_message_is_kept() {
        let (_dir, store, device) = paired_store().await;

        let (message, actions) =
            receive_and_reply(&store, None, "+15550001111", "ping", 1_776_470_400_000)
                .await
                .unwrap();

        assert!(actions.is_empty());
        assert_eq!(message.direction, "in");
        assert_eq!(
            store
                .list_messages(&device.device_id, 50)
                .await
                .unwrap()
                .len(),
            1
        );
        assert!(
            store
                .list_unmirrored_outbound(&device.device_id, 10)
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn a_flow_deleted_from_the_fetched_set_stops_replying() {
        let (_dir, store, _device) = paired_store().await;
        store
            .replace_flows(&[reply_flow("wf_reply", 1, "got it")])
            .await
            .unwrap();
        // Simulates the next successful sync after the flow was deleted.
        store.replace_flows(&[]).await.unwrap();

        let (_, actions) = receive_and_reply(&store, None, "+15550001111", "ping", 42)
            .await
            .unwrap();
        assert!(actions.is_empty());
    }

    /// A one-shot HTTP endpoint that answers `GET /v1/flows` with `flows` as
    /// the `flows` array. The signed headers are ignored: this test exercises
    /// the cache replacement, not the protocol.
    fn serve_flows(flows: String) -> (String, std::thread::JoinHandle<()>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let body = format!("{{\"flows\":{flows}}}");
        let handle = std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                use std::io::{Read, Write};
                let mut request = [0_u8; 2048];
                let _ = stream.read(&mut request);
                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes());
            }
        });
        (format!("http://{address}"), handle)
    }

    #[tokio::test]
    async fn sync_flows_replaces_the_cache_and_clears_it_when_empty() {
        let (_dir, store, device) = paired_store().await;
        store
            .replace_flows(&[reply_flow("wf_old", 1, "old")])
            .await
            .unwrap();
        let identity = crate::generate_identity().unwrap();

        // One served flow replaces whatever was cached.
        let fetched = serde_json::json!([{
            "id": "wf_new",
            "version": 2,
            "graph": reply_flow("wf_new", 2, "new").graph,
        }]);
        let (base_url, server) = serve_flows(fetched.to_string());
        let client = DeviceClient::new(
            Target::new(base_url, None).unwrap(),
            device.device_id.clone(),
            identity.private_key_pkcs8_pem.clone(),
        );
        assert_eq!(sync_flows(&store, &client).await.unwrap(), 1);
        server.join().unwrap();

        let cached = store.list_cached_flows().await.unwrap();
        assert_eq!(cached.len(), 1);
        assert_eq!(cached[0].id, "wf_new");
        assert_eq!(cached[0].version, 2);

        // An empty answer is a valid answer: the deleted flow must stop running.
        let (base_url, server) = serve_flows("[]".to_string());
        let client = DeviceClient::new(
            Target::new(base_url, None).unwrap(),
            device.device_id.clone(),
            identity.private_key_pkcs8_pem.clone(),
        );
        assert_eq!(sync_flows(&store, &client).await.unwrap(), 0);
        server.join().unwrap();

        assert!(store.list_cached_flows().await.unwrap().is_empty());
        assert!(store.load_flows().await.unwrap().is_empty());
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

    /// A local endpoint that accepts `expected` POSTs, records their JSON
    /// bodies and answers with a batch-shaped 200. It observes the wire, so the
    /// test can prove what a flush actually reports (and what it omits).
    fn serve_batch_requests(
        expected: usize,
    ) -> (String, std::thread::JoinHandle<Vec<serde_json::Value>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
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

                    bodies.push(serde_json::from_slice(&raw[header_end + 4..]).unwrap());
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

    /// A refused reply must reach the console, once, with its reason. A later
    /// `sent` transition is the SAME report (same local id), not a second row.
    #[tokio::test]
    async fn failed_outbound_is_mirrored_once_with_its_error_and_a_retry_updates_it() {
        let (_dir, store, device) = paired_store().await;
        let identity = crate::generate_identity().unwrap();

        store
            .record_message(
                &device.device_id,
                "out",
                "+15550001111",
                "refused reply",
                "queued",
                Some("native-1-reply-0"),
            )
            .await
            .unwrap();
        assert!(
            store
                .set_message_state_by_local_id(&device.device_id, "native-1-reply-0", "failed")
                .await
                .unwrap()
        );

        let (base_url, server) = serve_batch_requests(2);
        let client = DeviceClient::new(
            Target::new(base_url, None).unwrap(),
            device.device_id.clone(),
            identity.private_key_pkcs8_pem.clone(),
        );

        // First flush: the failed row is uploaded once and marked accepted.
        let flushed = flush_pending(&store, &client, &device.device_id)
            .await
            .unwrap();
        assert_eq!(flushed.outbound, 1);
        assert!(
            store
                .list_unmirrored_outbound(&device.device_id, 10)
                .await
                .unwrap()
                .is_empty(),
            "a mirrored failed row is not uploaded again unchanged"
        );

        // M5.5 retries it and the radio accepts: the state transition re-opens
        // the row for mirroring so the deployment's copy can be updated.
        assert!(
            store
                .set_message_state_by_local_id(&device.device_id, "native-1-reply-0", "sent")
                .await
                .unwrap()
        );
        let flushed = flush_pending(&store, &client, &device.device_id)
            .await
            .unwrap();
        assert_eq!(flushed.outbound, 1);

        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 2);

        let first = requests[0]["outbound"].as_array().expect("outbound array");
        assert_eq!(first.len(), 1);
        assert_eq!(first[0]["local_id"], "native-1-reply-0");
        assert_eq!(first[0]["to"], "+15550001111");
        assert_eq!(first[0]["state"], "failed");
        assert_eq!(first[0]["error"], "send_rejected");

        let second = requests[1]["outbound"].as_array().expect("outbound array");
        assert_eq!(
            second.len(),
            1,
            "a retry updates one report, it never creates a second"
        );
        assert_eq!(second[0]["local_id"], "native-1-reply-0");
        assert_eq!(second[0]["state"], "sent");
        assert!(
            second[0].get("error").is_none(),
            "a sent row must not carry the previous failure reason"
        );

        // One local row throughout; nothing left pending after the second flush.
        assert_eq!(
            store
                .list_messages(&device.device_id, 10)
                .await
                .unwrap()
                .len(),
            1
        );
        assert!(
            store
                .list_unmirrored_outbound(&device.device_id, 10)
                .await
                .unwrap()
                .is_empty()
        );
    }
}
