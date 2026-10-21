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
        let body = json!({
            "pairing_code": pairing_code,
            "device_id": self.device_id,
            "public_key_spki": public_key_spki_b64,
        });
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

        let mut payload = payload;
        payload.extend(outbound.iter().map(|report| {
            json!({
                "local_id": report.local_id,
                "sender_e164": report.to,
                "body": report.body,
                "received_at": report.sent_at,
                "direction": "out",
            })
        }));

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

        let mut body = json!({ "messages": payload, "ack_command_ids": ack_command_ids });
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
}

/// One SMS the device sent locally, to be mirrored into the deployment log.
#[derive(Debug, Clone)]
pub struct OutboundReport {
    pub local_id: String,
    pub to: String,
    pub body: String,
    pub sent_at: i64,
}

impl DeviceClient {
    /// Mirror locally-sent SMS into the deployment's message log.
    ///
    /// Sent through the same inbound endpoint with `direction: "out"`, so the
    /// `(device_id, local_id)` idempotency key makes retries free.
    pub async fn upload_outbound(
        &self,
        reports: &[OutboundReport],
    ) -> Result<Value, ProtocolError> {
        if reports.is_empty() {
            return Ok(Value::Null);
        }
        let payload: Vec<Value> = reports
            .iter()
            .map(|report| {
                json!({
                    "local_id": report.local_id,
                    "sender_e164": report.to,
                    "body": report.body,
                    "received_at": report.sent_at,
                    "direction": "out",
                })
            })
            .collect();

        self.signed_post(
            "/v1/sms/incoming/batch",
            json!({ "messages": payload, "ack_command_ids": [] }),
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
