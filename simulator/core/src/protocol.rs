//! Device protocol client (PROTOCOL_CONTRACT_V5 §2/§3, §11).
//!
//! Everything here is derived from the contract, not from `worker/src`: that
//! independence is what lets the simulator disagree with the server.
//!
//! Signed request = four headers over a canonical string:
//!
//! ```text
//! METHOD \n path \n timestamp \n nonce \n sha256(body) as lowercase hex
//! ```
//!
//! with an IEEE-P1363 signature (r||s, 64 bytes) — the form WebCrypto and the
//! Worker verify, not ASN.1 DER.

use std::time::{SystemTime, UNIX_EPOCH};

use reqwest::header::{CONTENT_TYPE, HeaderMap, HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::identity::sign_p1363;

#[derive(Debug, thiserror::Error)]
pub enum ProtocolError {
    #[error("http error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("invalid target url: {0}")]
    Url(String),
    #[error("signing failed: {0}")]
    Signing(String),
    #[error("server returned {status}: {body}")]
    Status { status: u16, body: String },
    #[error("unexpected response: {0}")]
    Shape(String),
}

#[derive(Debug, Clone)]
pub struct Target {
    pub base_url: String,
    pub admin_token: Option<String>,
}

impl Target {
    pub fn new(base_url: impl Into<String>, admin_token: Option<String>) -> Result<Self, ProtocolError> {
        let base_url = base_url.into().trim_end_matches('/').to_string();
        if !(base_url.starts_with("https://") || base_url.starts_with("http://")) {
            return Err(ProtocolError::Url(base_url));
        }
        Ok(Self { base_url, admin_token })
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base_url)
    }
}

/* ---- onboarding links --------------------------------------------------- */

/// Where a pairing code came from: a bare code, or an operator's deep link.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PairLink {
    /// Worker base URL carried by the link (`u`); `None` for a bare code.
    pub base_url: Option<String>,
    /// The 12-character pairing code, normalized to uppercase.
    pub code: String,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PairLinkError {
    #[error("paste a pairing code or a dakflare://pair link")]
    Empty,
    #[error("not a DakFlare pairing link: expected dakflare://pair?u=…&c=…")]
    NotALink,
    #[error("wrong link scheme: expected dakflare://pair")]
    Scheme,
    #[error("wrong link target: expected dakflare://pair")]
    Host,
    #[error("the link is missing its worker URL (u)")]
    MissingUrl,
    #[error("the link is missing its pairing code (c)")]
    MissingCode,
    #[error("the pairing code must be 12 hexadecimal characters")]
    BadCode,
    #[error("the link contains invalid percent-encoding")]
    BadEncoding,
}

/// Parse what the user pasted: either a full `dakflare://pair?u=…&c=…` deep
/// link, or a bare 12-character code.
///
/// Strict on purpose. The scheme must be `dakflare`, the host `pair`, and both
/// `u` and `c` must be present and non-empty. Anything else is rejected rather
/// than guessed at, so a mistyped link fails here with a readable message
/// instead of as an opaque 401 from the Worker.
pub fn parse_pair_link(input: &str) -> Result<PairLink, PairLinkError> {
    let input = input.trim();
    if input.is_empty() {
        return Err(PairLinkError::Empty);
    }

    let Some((scheme, rest)) = input.split_once(':') else {
        return Ok(PairLink {
            base_url: None,
            code: normalize_code(input)?,
        });
    };

    if !scheme.eq_ignore_ascii_case("dakflare") {
        return Err(PairLinkError::Scheme);
    }
    let Some(rest) = rest.strip_prefix("//") else {
        return Err(PairLinkError::NotALink);
    };

    let (authority, tail) = match rest.find(['/', '?']) {
        Some(index) => (&rest[..index], &rest[index..]),
        None => (rest, ""),
    };
    if !authority.eq_ignore_ascii_case("pair") {
        return Err(PairLinkError::Host);
    }

    // Only a bare `?query` (optionally behind one `/`) is a pairing link; a path
    // segment means this is some other URL that merely looks similar.
    let query = tail.strip_prefix('/').unwrap_or(tail);
    let query = query.strip_prefix('?').ok_or(PairLinkError::NotALink)?;

    let mut base_url = None;
    let mut code = None;
    for pair in query.split('&') {
        if pair.is_empty() {
            continue;
        }
        let Some((key, value)) = pair.split_once('=') else {
            return Err(PairLinkError::NotALink);
        };
        let value = percent_decode(value)?;
        match key {
            "u" if base_url.is_none() => base_url = Some(value.trim().to_string()),
            "c" if code.is_none() => code = Some(value),
            _ => {}
        }
    }

    let base_url = base_url
        .filter(|value| !value.is_empty())
        .ok_or(PairLinkError::MissingUrl)?;
    let code = code.ok_or(PairLinkError::MissingCode)?;

    Ok(PairLink {
        base_url: Some(base_url),
        code: normalize_code(&code)?,
    })
}

fn normalize_code(input: &str) -> Result<String, PairLinkError> {
    let code = input.trim();
    if code.len() != 12 || !code.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(PairLinkError::BadCode);
    }
    Ok(code.to_ascii_uppercase())
}

fn percent_decode(input: &str) -> Result<String, PairLinkError> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let high = bytes
                .get(index + 1)
                .and_then(|b| (*b as char).to_digit(16))
                .ok_or(PairLinkError::BadEncoding)?;
            let low = bytes
                .get(index + 2)
                .and_then(|b| (*b as char).to_digit(16))
                .ok_or(PairLinkError::BadEncoding)?;
            out.push((high * 16 + low) as u8);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).map_err(|_| PairLinkError::BadEncoding)
}

/// SHA-256 of the raw body bytes, lowercase hex.
pub fn body_digest(body: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(body);
    to_hex(&hasher.finalize())
}

/// The five-line canonical string. The method is uppercased; the digest is over
/// raw bytes, never over a re-serialized JSON value.
pub fn canonical_string(method: &str, path: &str, timestamp: &str, nonce: &str, body: &[u8]) -> String {
    format!(
        "{}\n{}\n{}\n{}\n{}",
        method.to_uppercase(),
        path,
        timestamp,
        nonce,
        body_digest(body)
    )
}

pub struct SignedHeaders {
    pub timestamp: String,
    pub nonce: String,
    pub signature_b64: String,
    pub canonical: String,
}

/// Build the four signed headers for one request.
pub fn sign_request(
    device_id: &str,
    private_key_pkcs8_pem: &str,
    method: &str,
    path: &str,
    body: &[u8],
) -> Result<SignedHeaders, ProtocolError> {
    let timestamp = now_ms().to_string();
    let nonce = random_nonce()?;
    let canonical = canonical_string(method, path, &timestamp, &nonce, body);
    let signature_b64 = sign_p1363(private_key_pkcs8_pem, &canonical)
        .map_err(|e| ProtocolError::Signing(e.to_string()))?;

    let _ = device_id; // the id travels in a header, not in the signature
    Ok(SignedHeaders {
        timestamp,
        nonce,
        signature_b64,
        canonical,
    })
}

pub struct DeviceClient {
    http: reqwest::Client,
    target: Target,
    device_id: String,
    private_key_pkcs8_pem: String,
}

/// Body of `POST /v1/device/pair`.
///
/// The three original fields are unchanged. `label` and `sim_slot` are the
/// identity hints added in contract §11.12: both are optional, so a server that
/// predates them ignores the extra keys, and an older payload without them still
/// deserializes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PairRequest {
    pub pairing_code: String,
    pub device_id: String,
    pub public_key_spki: String,
    /// Omitted when unknown, never invented.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// Explicit `null` when unknown, so the field is always on the wire.
    #[serde(default)]
    pub sim_slot: Option<i64>,
}

impl PairRequest {
    pub fn new(
        pairing_code: impl Into<String>,
        device_id: impl Into<String>,
        public_key_spki: impl Into<String>,
    ) -> Self {
        Self {
            pairing_code: pairing_code.into(),
            device_id: device_id.into(),
            public_key_spki: public_key_spki.into(),
            label: None,
            sim_slot: None,
        }
    }

    /// Attach the device row's label and SIM slot.
    ///
    /// The label is trimmed and capped at 64 characters (contract §11.12); an
    /// empty label becomes `None`. A slot outside 0–2 becomes `None`, so the
    /// wire only ever carries a value the contract permits.
    pub fn with_identity(mut self, label: Option<&str>, sim_slot: Option<i64>) -> Self {
        self.label = label.and_then(normalize_label);
        self.sim_slot = sim_slot.filter(|slot| (0..=2).contains(slot));
        self
    }
}

fn normalize_label(label: &str) -> Option<String> {
    // Trim first, then cap: otherwise leading whitespace would eat into the
    // 64-character budget. Control characters are dropped, not escaped. The cap
    // counts UTF-16 code units so it matches the Worker's JavaScript
    // `label.length > 64` check for astral characters.
    let mut cleaned = String::new();
    let mut units = 0usize;
    for c in label.trim().chars() {
        if c.is_control() {
            continue;
        }
        let width = c.len_utf16();
        if units + width > 64 {
            break;
        }
        cleaned.push(c);
        units += width;
    }
    let trimmed = cleaned.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

impl DeviceClient {
    pub fn new(
        target: Target,
        device_id: impl Into<String>,
        private_key_pkcs8_pem: impl Into<String>,
    ) -> Self {
        Self {
            http: reqwest::Client::new(),
            target,
            device_id: device_id.into(),
            private_key_pkcs8_pem: private_key_pkcs8_pem.into(),
        }
    }

    /* ---- admin: pairing code ------------------------------------------- */

    /// Mint an enrolment code. Uses the deployment's admin token.
    pub async fn mint_pairing_code(&self, ttl_ms: u64) -> Result<String, ProtocolError> {
        let token = self
            .target
            .admin_token
            .as_deref()
            .ok_or_else(|| ProtocolError::Shape("no admin token configured".into()))?;

        let res = self
            .http
            .post(self.target.url("/v1/admin/pairing-code"))
            .bearer_auth(token)
            .json(&json!({ "ttl_ms": ttl_ms }))
            .send()
            .await?;

        let status = res.status();
        let text = res.text().await?;
        if !status.is_success() {
            return Err(ProtocolError::Status {
                status: status.as_u16(),
                body: text,
            });
        }
        let value: Value = serde_json::from_str(&text)
            .map_err(|e| ProtocolError::Shape(format!("{e}: {text}")))?;
        value
            .get("pairing_code")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| ProtocolError::Shape("no pairing_code in response".into()))
    }

    /* ---- device: pair (unsigned) ---------------------------------------- */

    pub async fn pair(
        &self,
        pairing_code: &str,
        public_key_spki_b64: &str,
    ) -> Result<(), ProtocolError> {
        self.pair_with_identity(pairing_code, public_key_spki_b64, None, None)
            .await
    }

    /// Pair with the identity hints the device row already holds.
    ///
    /// Used by both onboarding paths (operator code and lab self-pair). The
    /// code alone authenticates the request; no admin token is involved.
    pub async fn pair_with_identity(
        &self,
        pairing_code: &str,
        public_key_spki_b64: &str,
        label: Option<&str>,
        sim_slot: Option<i64>,
    ) -> Result<(), ProtocolError> {
        let body = PairRequest::new(pairing_code, self.device_id.as_str(), public_key_spki_b64)
            .with_identity(label, sim_slot);
        let res = self
            .http
            .post(self.target.url("/v1/device/pair"))
            .json(&body)
            .send()
            .await?;

        let status = res.status();
        let text = res.text().await?;
        if !status.is_success() {
            return Err(ProtocolError::Status {
                status: status.as_u16(),
                body: text,
            });
        }
        Ok(())
    }

    /* ---- device: signed requests ---------------------------------------- */

    fn signed_headers(&self, method: &str, path: &str, body: &[u8]) -> Result<HeaderMap, ProtocolError> {
        let signed = sign_request(
            &self.device_id,
            &self.private_key_pkcs8_pem,
            method,
            path,
            body,
        )?;

        let mut headers = HeaderMap::new();
        headers.insert(
            HeaderName::from_static("x-device-id"),
            header_value(&self.device_id)?,
        );
        headers.insert(
            HeaderName::from_static("x-timestamp"),
            header_value(&signed.timestamp)?,
        );
        headers.insert(
            HeaderName::from_static("x-nonce"),
            header_value(&signed.nonce)?,
        );
        headers.insert(
            HeaderName::from_static("x-signature"),
            header_value(&signed.signature_b64)?,
        );
        Ok(headers)
    }

    async fn decode(response: reqwest::Response) -> Result<Value, ProtocolError> {
        let status = response.status();
        let text = response.text().await?;
        if !status.is_success() {
            return Err(ProtocolError::Status {
                status: status.as_u16(),
                body: text,
            });
        }
        serde_json::from_str(&text).map_err(|e| ProtocolError::Shape(format!("{e}: {text}")))
    }

    async fn signed_post(&self, path: &str, body: Value) -> Result<Value, ProtocolError> {
        let body_bytes = serde_json::to_vec(&body)
            .map_err(|e| ProtocolError::Shape(format!("serialize: {e}")))?;
        let mut headers = self.signed_headers("POST", path, &body_bytes)?;
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));

        let res = self
            .http
            .post(self.target.url(path))
            .headers(headers)
            .body(body_bytes)
            .send()
            .await?;
        Self::decode(res).await
    }

    /// Signed GETs sign an empty body (§1.2).
    async fn signed_get(&self, path: &str) -> Result<Value, ProtocolError> {
        let headers = self.signed_headers("GET", path, b"")?;
        let res = self.http.get(self.target.url(path)).headers(headers).send().await?;
        Self::decode(res).await
    }

    /// `GET /v1/flows` — the flows this device runs locally.
    pub async fn fetch_flows(&self) -> Result<Vec<crate::flowrun::RemoteFlow>, ProtocolError> {
        let value = self.signed_get("/v1/flows").await?;
        let list = value
            .get("flows")
            .and_then(Value::as_array)
            .ok_or_else(|| ProtocolError::Shape("no flows array in response".into()))?;

        let mut flows = Vec::with_capacity(list.len());
        for entry in list {
            let parsed: crate::flowrun::RemoteFlow = serde_json::from_value(entry.clone())
                .map_err(|e| ProtocolError::Shape(format!("flow shape: {e}")))?;
            flows.push(parsed);
        }
        Ok(flows)
    }

    /// `POST /v1/sms/outgoing/poll` — returns the `commands` array.
    pub async fn poll(&self, ack_command_ids: &[String]) -> Result<Value, ProtocolError> {
        let value = self
            .signed_post(
                "/v1/sms/outgoing/poll",
                json!({ "ack_command_ids": ack_command_ids }),
            )
            .await?;
        Ok(value.get("commands").cloned().unwrap_or(Value::Array(vec![])))
    }

    /// `POST /v1/sms/status/batch` — report a terminal state for commands this
    /// device collected.
    ///
    /// §6.1: a rejected transition is a successful no-op, so an unknown or
    /// already-terminal command id is not an error here.
    pub async fn report_status(
        &self,
        updates: &[(String, String)],
    ) -> Result<Value, ProtocolError> {
        let payload: Vec<Value> = updates
            .iter()
            .map(|(command_id, status)| json!({ "command_id": command_id, "status": status }))
            .collect();
        self.signed_post("/v1/sms/status/batch", json!({ "updates": payload }))
            .await
    }

    /// `POST /v1/sms/incoming/batch` — upload messages and acknowledge commands.
    pub async fn upload_inbound(
        &self,
        messages: &[InboundMessage],
        ack_command_ids: &[String],
    ) -> Result<Value, ProtocolError> {
        self.upload_inbound_with_runs(messages, ack_command_ids, &[]).await
    }

    /// Upload with the device's own flow runs attached, so the Worker fallback
    /// can skip them.
    pub async fn upload_inbound_with_runs(
        &self,
        messages: &[InboundMessage],
        ack_command_ids: &[String],
        runs: &[crate::flowrun::FlowRunReport],
    ) -> Result<Value, ProtocolError> {
        self.upload_batch(messages, ack_command_ids, runs, &[]).await
    }

    /// One request carrying inbound messages, device flow runs and outbound rows
    /// to mirror. Keeping them together makes the upload atomic.
    pub async fn upload_batch(
        &self,
        messages: &[InboundMessage],
        ack_command_ids: &[String],
        runs: &[crate::flowrun::FlowRunReport],
        outbound: &[OutboundReport],
    ) -> Result<Value, ProtocolError> {
        let payload: Vec<Value> = messages
            .iter()
            .map(|m| {
                json!({
                    "local_id": m.local_id,
                    "sender_e164": m.sender,
                    "body": m.body,
                    "received_at": m.received_at,
                })
            })
            .collect();

        let outbound_payload: Vec<Value> =
            outbound.iter().map(OutboundReport::to_json).collect();

        let runs_payload: Vec<Value> = runs
            .iter()
            .map(|run| {
                json!({
                    "local_id": run.local_id,
                    "flow_id": run.flow_id,
                    "flow_version": run.flow_version,
                    "outcome": run.outcome,
                })
            })
            .collect();

        let mut body = json!({
            "messages": payload,
            "ack_command_ids": ack_command_ids,
            "outbound": outbound_payload,
        });
        if let Some(map) = body.as_object_mut() {
            map.insert("flow_runs".into(), Value::Array(runs_payload));
        }

        self.signed_post("/v1/sms/incoming/batch", body).await
    }

    /* ---- admin: cleanup -------------------------------------------------- */

    /// `POST /v1/sms/send` — queue an outbound SMS for this device (admin).
    pub async fn admin_send(&self, to: &str, body: &str) -> Result<String, ProtocolError> {
        let token = self
            .target
            .admin_token
            .as_deref()
            .ok_or_else(|| ProtocolError::Shape("no admin token configured".into()))?;

        let res = self
            .http
            .post(self.target.url("/v1/sms/send"))
            .bearer_auth(token)
            .json(&json!({
                "device_id": self.device_id,
                "to": to,
                "body": body,
            }))
            .send()
            .await?;

        let status = res.status();
        let text = res.text().await?;
        if !status.is_success() {
            return Err(ProtocolError::Status {
                status: status.as_u16(),
                body: text,
            });
        }
        let value: Value = serde_json::from_str(&text)
            .map_err(|e| ProtocolError::Shape(format!("{e}: {text}")))?;
        value
            .get("command_id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| ProtocolError::Shape("no command_id in response".into()))
    }

    /// `PUT /v1/admin/workflows/:id` — install or replace a flow.
    pub async fn admin_put_workflow(
        &self,
        id: &str,
        name: &str,
        graph: Value,
    ) -> Result<(), ProtocolError> {
        let token = self
            .target
            .admin_token
            .as_deref()
            .ok_or_else(|| ProtocolError::Shape("no admin token configured".into()))?;

        let res = self
            .http
            .put(self.target.url(&format!("/v1/admin/workflows/{id}")))
            .bearer_auth(token)
            .json(&json!({ "name": name, "enabled": true, "graph": graph }))
            .send()
            .await?;

        let status = res.status();
        let text = res.text().await?;
        if !status.is_success() {
            return Err(ProtocolError::Status {
                status: status.as_u16(),
                body: text,
            });
        }
        Ok(())
    }

    /// `DELETE /v1/admin/workflows/:id`.
    pub async fn admin_delete_workflow(&self, id: &str) -> Result<(), ProtocolError> {
        let token = self
            .target
            .admin_token
            .as_deref()
            .ok_or_else(|| ProtocolError::Shape("no admin token configured".into()))?;

        let res = self
            .http
            .delete(self.target.url(&format!("/v1/admin/workflows/{id}")))
            .bearer_auth(token)
            .send()
            .await?;

        let status = res.status();
        if !status.is_success() && status.as_u16() != 404 {
            let text = res.text().await.unwrap_or_default();
            return Err(ProtocolError::Status {
                status: status.as_u16(),
                body: text,
            });
        }
        Ok(())
    }

    /// `DELETE /v1/messages?device_id=` — erase this device's message log.
    pub async fn purge_messages(&self) -> Result<u64, ProtocolError> {
        let token = self
            .target
            .admin_token
            .as_deref()
            .ok_or_else(|| ProtocolError::Shape("no admin token configured".into()))?;

        let url = format!(
            "{}/v1/messages?device_id={}",
            self.target.base_url, self.device_id
        );
        let res = self.http.delete(url).bearer_auth(token).send().await?;
        let status = res.status();
        let text = res.text().await?;
        if !status.is_success() {
            return Err(ProtocolError::Status {
                status: status.as_u16(),
                body: text,
            });
        }
        let value: Value = serde_json::from_str(&text)
            .map_err(|e| ProtocolError::Shape(format!("{e}: {text}")))?;
        Ok(value.get("deleted").and_then(Value::as_u64).unwrap_or(0))
    }

    /// `DELETE /v1/admin/devices/:id` — revoke the device server-side.
    pub async fn revoke(&self) -> Result<(), ProtocolError> {
        let token = self
            .target
            .admin_token
            .as_deref()
            .ok_or_else(|| ProtocolError::Shape("no admin token configured".into()))?;

        let url = format!(
            "{}/v1/admin/devices/{}",
            self.target.base_url, self.device_id
        );
        let res = self.http.delete(url).bearer_auth(token).send().await?;
        let status = res.status();
        let text = res.text().await?;
        if !status.is_success() {
            return Err(ProtocolError::Status {
                status: status.as_u16(),
                body: text,
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct InboundMessage {
    pub local_id: String,
    pub sender: String,
    pub body: String,
    pub received_at: i64,
}

fn header_value(value: &str) -> Result<HeaderValue, ProtocolError> {
    HeaderValue::from_str(value).map_err(|e| ProtocolError::Shape(format!("header: {e}")))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn random_nonce() -> Result<String, ProtocolError> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|e| ProtocolError::Shape(format!("random: {e}")))?;
    Ok(to_hex(&bytes))
}

fn to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::{generate_identity, verify_p1363};

    #[test]
    fn canonical_string_has_five_lines() {
        let body = b"{\"ack_command_ids\":[]}";
        let canonical = canonical_string(
            "post",
            "/v1/sms/outgoing/poll",
            "1776470400000",
            "a3f1c0d29b7e4f8a1c6d5e2b9f0a7c34",
            body,
        );
        let lines: Vec<&str> = canonical.split('\n').collect();
        assert_eq!(lines.len(), 5);
        assert_eq!(lines[0], "POST");
        assert_eq!(lines[1], "/v1/sms/outgoing/poll");
        assert_eq!(lines[4], body_digest(body));
        assert!(!canonical.ends_with('\n'));
        // Digest is over raw bytes and lowercase hex.
        assert_eq!(lines[4].len(), 64);
        assert!(lines[4].chars().all(|c| c.is_ascii_hexdigit() && !c.is_uppercase()));
    }

    #[test]
    fn empty_body_digest_matches_the_contract_vector() {
        // SHA-256("") — the §2.3 empty-body digest.
        assert_eq!(
            body_digest(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn signed_headers_verify_with_the_public_key() {
        let identity = generate_identity().unwrap();
        let body = br#"{"ack_command_ids":[]}"#;
        let signed = sign_request(
            &identity.device_id,
            &identity.private_key_pkcs8_pem,
            "POST",
            "/v1/sms/outgoing/poll",
            body,
        )
        .unwrap();

        let expected = canonical_string(
            "POST",
            "/v1/sms/outgoing/poll",
            &signed.timestamp,
            &signed.nonce,
            body,
        );
        assert_eq!(signed.canonical, expected);
        assert!(verify_p1363(&identity.public_key_spki_b64, &expected, &signed.signature_b64).unwrap());
    }

    #[test]
    fn nonces_differ_between_requests() {
        let identity = generate_identity().unwrap();
        let a = sign_request(&identity.device_id, &identity.private_key_pkcs8_pem, "POST", "/x", b"").unwrap();
        let b = sign_request(&identity.device_id, &identity.private_key_pkcs8_pem, "POST", "/x", b"").unwrap();
        assert_ne!(a.nonce, b.nonce);
    }

    #[test]
    fn target_requires_a_url_scheme() {
        assert!(Target::new("https://example.workers.dev/", None).is_ok());
        assert!(Target::new("example.workers.dev", None).is_err());
    }

    #[test]
    fn pair_request_keeps_the_wire_fields_and_carries_the_label() {
        let request = PairRequest::new("AB12CD34EF56", "device_01", "spki-b64")
            .with_identity(Some("  Pixel 8 · reception  "), Some(1));
        let value = serde_json::to_value(&request).unwrap();

        // The original contract fields are untouched.
        assert_eq!(value["pairing_code"], "AB12CD34EF56");
        assert_eq!(value["device_id"], "device_01");
        assert_eq!(value["public_key_spki"], "spki-b64");
        // Label trimmed; SIM slot passed through when in range.
        assert_eq!(value["label"], "Pixel 8 · reception");
        assert_eq!(value["sim_slot"], 1);
    }

    #[test]
    fn pair_request_nulls_an_unknown_sim_slot() {
        let value =
            serde_json::to_value(PairRequest::new("AB12CD34EF56", "device_01", "spki-b64")).unwrap();

        // The field is on the wire, explicitly null, rather than omitted.
        assert!(value.get("sim_slot").is_some());
        assert!(value["sim_slot"].is_null());
        // An unknown label is omitted, not sent as an empty string.
        assert!(value.get("label").is_none());
    }

    #[test]
    fn pair_request_trims_caps_and_nulls_out_of_range_values() {
        let long_label = format!("  {}  ", "L".repeat(80));
        let request = PairRequest::new("AB12CD34EF56", "device_01", "spki-b64")
            .with_identity(Some(&long_label), Some(3));
        let value = serde_json::to_value(&request).unwrap();

        assert_eq!(value["label"].as_str().unwrap().chars().count(), 64);
        assert!(value["sim_slot"].is_null());

        let blank = PairRequest::new("AB12CD34EF56", "device_01", "spki-b64")
            .with_identity(Some("   "), None);
        assert_eq!(blank.label, None);

        // Astral characters count as two UTF-16 units, matching the Worker's
        // `label.length > 64` check, so a valid request is never rejected as long.
        let emoji = "😀".repeat(40);
        let request = PairRequest::new("AB12CD34EF56", "device_01", "spki-b64")
            .with_identity(Some(&emoji), None);
        let units = request
            .label
            .as_deref()
            .unwrap()
            .encode_utf16()
            .count();
        assert!(units <= 64, "label was {units} UTF-16 units");
    }

    #[test]
    fn pair_request_deserializes_payloads_from_before_the_identity_hints() {
        // A body produced by an older client: no `label`, no `sim_slot`.
        let request: PairRequest = serde_json::from_str(
            r#"{"pairing_code":"AB12CD34EF56","device_id":"device_01","public_key_spki":"spki-b64"}"#,
        )
        .unwrap();

        assert_eq!(request.pairing_code, "AB12CD34EF56");
        assert_eq!(request.device_id, "device_01");
        assert_eq!(request.public_key_spki, "spki-b64");
        assert_eq!(request.label, None);
        assert_eq!(request.sim_slot, None);
    }

    #[test]
    fn pairing_link_carries_the_worker_url_and_normalizes_the_code() {
        let link = parse_pair_link(
            "dakflare://pair?u=https%3A%2F%2Fdakflare.example.workers.dev&c=ab12cd34ef56",
        )
        .unwrap();
        assert_eq!(
            link.base_url.as_deref(),
            Some("https://dakflare.example.workers.dev")
        );
        assert_eq!(link.code, "AB12CD34EF56");
    }

    #[test]
    fn pairing_link_accepts_a_trailing_slash_and_unencoded_url() {
        let link = parse_pair_link("dakflare://pair/?u=https://example.test/&c=001122334455").unwrap();
        assert_eq!(link.base_url.as_deref(), Some("https://example.test/"));
        assert_eq!(link.code, "001122334455");
    }

    #[test]
    fn bare_codes_do_not_imply_a_target() {
        let link = parse_pair_link("  ab12cd34ef56  ").unwrap();
        assert_eq!(link.base_url, None);
        assert_eq!(link.code, "AB12CD34EF56");
    }

    #[test]
    fn pairing_links_are_strict() {
        // Wrong scheme / host / path.
        assert_eq!(
            parse_pair_link("https://pair?u=https%3A%2F%2Fx&c=001122334455"),
            Err(PairLinkError::Scheme)
        );
        assert_eq!(
            parse_pair_link("dakflare://device?u=https%3A%2F%2Fx&c=001122334455"),
            Err(PairLinkError::Host)
        );
        assert_eq!(
            parse_pair_link("dakflare://pair/other?u=https%3A%2F%2Fx&c=001122334455"),
            Err(PairLinkError::NotALink)
        );
        // Required parameters.
        assert_eq!(
            parse_pair_link("dakflare://pair?c=001122334455"),
            Err(PairLinkError::MissingUrl)
        );
        assert_eq!(
            parse_pair_link("dakflare://pair?u=https%3A%2F%2Fx"),
            Err(PairLinkError::MissingCode)
        );
        assert_eq!(
            parse_pair_link("dakflare://pair?u=&c=001122334455"),
            Err(PairLinkError::MissingUrl)
        );
        // Code must be the 12-hex shape the Worker mints.
        assert_eq!(
            parse_pair_link("dakflare://pair?u=https%3A%2F%2Fx&c=1234"),
            Err(PairLinkError::BadCode)
        );
        assert_eq!(parse_pair_link("nope"), Err(PairLinkError::BadCode));
        assert_eq!(parse_pair_link("   "), Err(PairLinkError::Empty));
        assert_eq!(
            parse_pair_link("dakflare://pair?u=https%3A%2F%2Fx&c=%GG1122334455"),
            Err(PairLinkError::BadEncoding)
        );
    }
}

/// One SMS the device sent locally, to be mirrored into the deployment log.
#[derive(Debug, Clone)]
pub struct OutboundReport {
    pub local_id: String,
    pub to: String,
    pub body: String,
    pub sent_at: i64,
    /// `queued` | `sent` | `failed` | `delivered`. `None` lets a caller that
    /// does not know the state omit the key rather than invent one.
    pub state: Option<String>,
    /// Why a send failed, from the row's `last_error`. Omitted when absent.
    pub error: Option<String>,
}

impl OutboundReport {
    /// The frozen `outbound[]` entry. `state`/`error` are serialized only when
    /// present, so a client that knows nothing about them keeps sending the
    /// original four-field shape.
    fn to_json(&self) -> Value {
        let mut entry = json!({
            "local_id": self.local_id,
            "to": self.to,
            "body": self.body,
            "sent_at": self.sent_at,
        });
        if let Some(state) = &self.state {
            entry["state"] = json!(state);
        }
        if let Some(error) = &self.error {
            entry["error"] = json!(error);
        }
        entry
    }
}

impl DeviceClient {
    /// Mirror locally-sent SMS into the deployment's message log.
    ///
    /// Sent through the inbound endpoint's `outbound[]` array, so the
    /// `(device_id, local_id)` idempotency key makes retries free and a later
    /// `sent`/`delivered` report updates the row instead of duplicating it.
    pub async fn upload_outbound(
        &self,
        reports: &[OutboundReport],
    ) -> Result<Value, ProtocolError> {
        if reports.is_empty() {
            return Ok(Value::Null);
        }
        let payload: Vec<Value> = reports.iter().map(OutboundReport::to_json).collect();

        self.signed_post(
            "/v1/sms/incoming/batch",
            json!({ "messages": [], "ack_command_ids": [], "outbound": payload }),
        )
        .await
    }

    /// Admin read of the message log, used by probes and the dashboard.
    pub async fn admin_list_messages(&self, limit: u32) -> Result<Value, ProtocolError> {
        let token = self
            .target
            .admin_token
            .as_deref()
            .ok_or_else(|| ProtocolError::Shape("no admin token configured".into()))?;

        let url = format!(
            "{}/v1/messages?device_id={}&limit={}",
            self.target.base_url, self.device_id, limit
        );
        let res = self.http.get(url).bearer_auth(token).send().await?;
        Self::decode(res).await
    }
}
