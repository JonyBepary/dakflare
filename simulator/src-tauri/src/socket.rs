//! The device socket: one blocking WebSocket in a thread of its own.
//!
//! The gateway parks a JNI call in [`await_commands`], so the socket is blocking
//! on purpose: a thread that reads, and a channel the parked call waits on. A
//! second async runtime would only be another scheduler to reason about, and the
//! signing code is the same one every other request uses.
//!
//! Three rules from the design, and where each lives:
//!
//! - **Ack on receipt.** A command is recorded as a `queued` row and acknowledged
//!   over the socket. That says the phone holds it, never that the radio sent it;
//!   the send path marks the row from its own receipt. Same rule as the HTTP
//!   poll, which is why both call `record_commands`.
//! - **A missed pong is a dead socket.** The edge answers `{"op":"ping"}` without
//!   waking the Durable Object, so a pong is real liveness evidence. One read
//!   timeout period with no traffic sends a ping; the next one with no pong ends
//!   the session.
//! - **Retry forever, back off to a minute.** The 5-minute HTTP poll in the
//!   gateway is the backstop, so a socket that cannot be established is a
//!   latency problem, not an outage.

use std::io::ErrorKind;
use std::net::TcpStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, mpsc};
use std::time::{Duration, Instant};

use dakflare_core::carrier::record_commands;
use tungstenite::client::IntoClientRequest;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket, connect};

/// How long the socket waits for traffic before it pings.
const IDLE_TIMEOUT: Duration = Duration::from_secs(60);
/// The reconnect backoff ceiling. The HTTP poll covers anything longer.
const BACKOFF_MAX: Duration = Duration::from_secs(60);
/// A session that lasted this long resets the backoff; a shorter one doubles it.
const STABLE_SESSION: Duration = Duration::from_secs(30);

const WS_PATH: &str = "/v1/device/ws";

/// Set by the socket thread while a session is connected. Read by the gateway so
/// the notification can say "live" only when it is true.
static LIVE: AtomicBool = AtomicBool::new(false);

/// The running socket, if one has been started. One device per process: the
/// gateway stops when the identity goes, and re-pairing restarts the service.
static SHARED: Mutex<Option<Shared>> = Mutex::new(None);

struct Shared {
    device_id: String,
    rx: mpsc::Receiver<Vec<String>>,
}

/// One wait's worth of result.
pub struct AwaitResult {
    /// Local ids of the commands this wait collected, oldest first.
    pub captured: Vec<String>,
    /// Whether the socket was connected when the wait finished.
    pub live: bool,
}

/// True when the socket is connected right now.
pub fn is_live() -> bool {
    LIVE.load(Ordering::Relaxed)
}

/// Wait up to `timeout` for the socket to deliver commands.
///
/// Returns an empty list on timeout: no commands is the normal case, not an
/// error, and the caller's next call resumes the wait.
pub fn await_commands(
    app_dir: &str,
    device_id: &str,
    timeout: Duration,
) -> Result<AwaitResult, &'static str> {
    ensure_started(app_dir, device_id)?;

    let guard = SHARED.lock().map_err(|_| "storage")?;
    let shared = guard.as_ref().ok_or("storage")?;
    if shared.device_id != device_id {
        return Err("unpaired");
    }
    // The lock is held across the wait. Only the gateway thread calls this, and
    // the socket thread never takes it, so nothing else can be blocked by it.
    let captured = shared.rx.recv_timeout(timeout).unwrap_or_default();
    Ok(AwaitResult {
        captured,
        live: is_live(),
    })
}

/// Start the socket thread for this device, or leave a running one alone.
fn ensure_started(app_dir: &str, device_id: &str) -> Result<(), &'static str> {
    let mut guard = SHARED.lock().map_err(|_| "storage")?;
    if let Some(shared) = guard.as_ref() {
        if shared.device_id == device_id {
            return Ok(());
        }
    }

    // A different device means a different key, so the old session is no longer
    // useful. Its thread exits on its next read error; a new one starts here.
    LIVE.store(false, Ordering::Relaxed);

    let (tx, rx) = mpsc::channel();
    let owned_dir = app_dir.to_string();
    let owned_device = device_id.to_string();
    std::thread::Builder::new()
        .name("dakflare-socket".to_string())
        .spawn(move || run(owned_dir, owned_device, tx))
        .map_err(|_| "storage")?;

    *guard = Some(Shared {
        device_id: device_id.to_string(),
        rx,
    });
    Ok(())
}

fn run(app_dir: String, device_id: String, tx: mpsc::Sender<Vec<String>>) {
    let mut backoff = Duration::from_secs(1);
    loop {
        let started = Instant::now();
        let outcome = session(&app_dir, &device_id, &tx);
        LIVE.store(false, Ordering::Relaxed);

        if outcome.is_err() && started.elapsed() < STABLE_SESSION {
            backoff = (backoff * 2).min(BACKOFF_MAX);
        } else {
            backoff = Duration::from_secs(1);
        }
        std::thread::sleep(backoff);
    }
}

/// One connection, from the upgrade to the first error that ends it.
fn session(
    app_dir: &str,
    device_id: &str,
    tx: &mpsc::Sender<Vec<String>>,
) -> Result<(), &'static str> {
    let store = crate::android::open_store_blocking(app_dir)?;
    let client = crate::android::signed_client_blocking(&store, device_id)?;

    let mut request = ws_url(client.base_url())?
        .into_client_request()
        .map_err(|_| "protocol")?;
    // §1.2: the upgrade is a signed GET with no query string, so the canonical
    // string covers the empty body — vector B in the shared protocol vectors.
    let headers = client.upgrade_headers().map_err(|_| "protocol")?;
    for (name, value) in headers.iter() {
        request.headers_mut().insert(name.clone(), value.clone());
    }

    let (mut socket, _response) = connect(request).map_err(|_| "network")?;
    LIVE.store(true, Ordering::Relaxed);

    // `hello` is the reconnect recovery: the Durable Object answers it with the
    // PENDING commands a dropped socket never delivered.
    let _ = socket.send(Message::text(r#"{"op":"hello"}"#));
    set_read_timeout(&socket, IDLE_TIMEOUT);

    let mut awaiting_pong = false;
    loop {
        match socket.read() {
            Ok(Message::Text(text)) => {
                awaiting_pong = false;
                if let Some(ids) = handle_text(&store, device_id, &text, &mut socket) {
                    let _ = tx.send(ids);
                }
            }
            Ok(Message::Ping(_)) | Ok(Message::Pong(_)) => {
                awaiting_pong = false;
            }
            Ok(Message::Close(_)) => return Ok(()),
            Ok(_) => {}
            Err(error) if is_timeout(&error) => {
                if awaiting_pong {
                    // The edge answers a ping without waking the object, so a
                    // period with no pong means the socket is gone even though
                    // the OS still believes it is open.
                    return Ok(());
                }
                if socket.send(Message::text(r#"{"op":"ping"}"#)).is_err() {
                    return Ok(());
                }
                awaiting_pong = true;
            }
            Err(_) => return Ok(()),
        }
    }
}

/// Handle one server frame. Returns the local ids to hand to the caller, if any.
fn handle_text(
    store: &dakflare_core::Store,
    device_id: &str,
    text: &str,
    socket: &mut WebSocket<MaybeTlsStream<TcpStream>>,
) -> Option<Vec<String>> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    if value.get("op").and_then(|v| v.as_str()) != Some("commands") {
        return None;
    }
    let commands = value
        .get("commands")
        .cloned()
        .unwrap_or(serde_json::Value::Null);

    let (captured, ack_ids) =
        tauri::async_runtime::block_on(record_commands(store, device_id, &commands)).ok()?;

    if !ack_ids.is_empty() {
        // Acknowledge over the socket rather than a second HTTP poll: the
        // command is held, and the send path owns everything after that.
        let ack = serde_json::json!({ "op": "ack", "command_ids": ack_ids });
        let _ = socket.send(Message::text(ack.to_string()));
    }

    let ids: Vec<String> = captured
        .into_iter()
        .filter_map(|message| message.local_id)
        .collect();
    if ids.is_empty() {
        None
    } else {
        Some(ids)
    }
}

/// `https://host` becomes `wss://host/v1/device/ws`, and `http://` becomes `ws://`
/// so a local Worker can be exercised over the same path.
fn ws_url(base_url: &str) -> Result<String, &'static str> {
    if let Some(rest) = base_url.strip_prefix("https://") {
        return Ok(format!("wss://{rest}{WS_PATH}"));
    }
    if let Some(rest) = base_url.strip_prefix("http://") {
        return Ok(format!("ws://{rest}{WS_PATH}"));
    }
    Err("storage")
}

/// Give the underlying TCP stream a read timeout.
///
/// One thread both reads and pings, so the read has to return periodically. Both
/// rustls and tungstenite keep partial state across a `WouldBlock`, so a timeout
/// between frames is recoverable; anything else ends the session.
fn set_read_timeout(socket: &WebSocket<MaybeTlsStream<TcpStream>>, timeout: Duration) {
    let tcp = match socket.get_ref() {
        MaybeTlsStream::Plain(stream) => Some(stream),
        MaybeTlsStream::Rustls(stream) => Some(stream.get_ref()),
        _ => None,
    };
    if let Some(stream) = tcp {
        let _ = stream.set_read_timeout(Some(timeout));
    }
}

fn is_timeout(error: &tungstenite::Error) -> bool {
    match error {
        tungstenite::Error::Io(io) => {
            matches!(io.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut)
        }
        _ => false,
    }
}
