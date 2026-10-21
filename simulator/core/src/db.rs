//! Local libSQL store.
//!
//! libSQL is SQLite with a replication story: same file format, same SQL. Keeping
//! it in the Rust core means one schema and one set of migrations for desktop,
//! Android and (later) embedded replicas, instead of a Kotlin/Room implementation
//! on one side and a Rust one on the other.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use libsql::{Builder, Database, params};
use serde::{Deserialize, Serialize};

use crate::identity::{Identity, is_valid_device_id};

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("database error: {0}")]
    Database(#[from] libsql::Error),
    #[error("invalid device id: {0}")]
    InvalidDeviceId(String),
    #[error("time went backwards")]
    Clock,
}

/// One statement per entry, applied in order and recorded in `schema_migrations`.
/// Single statements (not batches) keep migration failures attributable.
const MIGRATIONS: &[(i64, &str)] = &[
    (
        1,
        "CREATE TABLE IF NOT EXISTS devices (
            device_id         TEXT PRIMARY KEY,
            public_key_spki   TEXT NOT NULL,
            private_key_pkcs8 TEXT NOT NULL,
            platform          TEXT NOT NULL,
            platform_id       TEXT,
            label             TEXT NOT NULL,
            carrier           TEXT,
            sim_slot          INTEGER NOT NULL DEFAULT 0,
            created_at        INTEGER NOT NULL,
            updated_at        INTEGER NOT NULL
        )",
    ),
    (
        2,
        "CREATE TABLE IF NOT EXISTS messages (
            id         TEXT PRIMARY KEY,
            device_id  TEXT NOT NULL,
            direction  TEXT NOT NULL CHECK (direction IN ('in','out')),
            peer       TEXT NOT NULL,
            body       TEXT NOT NULL,
            state      TEXT NOT NULL,
            local_id   TEXT,
            created_at INTEGER NOT NULL,
            UNIQUE(device_id, local_id)
        )",
    ),
    (
        3,
        "CREATE INDEX IF NOT EXISTS idx_messages_device ON messages(device_id, created_at DESC)",
    ),
    (
        4,
        // The dedupe key between a device-side run and the Worker fallback:
        // (device_id, local_id, flow_id, flow_version).
        "CREATE TABLE IF NOT EXISTS flow_runs (
            id           TEXT PRIMARY KEY,
            device_id    TEXT NOT NULL,
            local_id     TEXT NOT NULL,
            flow_id      TEXT NOT NULL,
            flow_version INTEGER NOT NULL,
            outcome      TEXT NOT NULL,
            sms_json     TEXT NOT NULL DEFAULT '[]',
            created_at   INTEGER NOT NULL,
            UNIQUE(device_id, local_id, flow_id, flow_version)
        )",
    ),
    (
        5,
        "CREATE TABLE IF NOT EXISTS commands (
            command_id TEXT PRIMARY KEY,
            device_id  TEXT NOT NULL,
            to_e164    TEXT NOT NULL,
            body       TEXT NOT NULL,
            state      TEXT NOT NULL,
            created_at INTEGER NOT NULL
        )",
    ),
    (
        6,
        "CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )",
    ),
    (
        7,
        // Whether this row exists in the deployment's message log. Outbound rows
        // are mirrored after they are actually sent; a failed upload leaves the
        // flag at 0 so the next sync retries instead of losing history.
        "ALTER TABLE messages ADD COLUMN mirrored INTEGER NOT NULL DEFAULT 0",
    ),
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Device {
    pub device_id: String,
    pub public_key_spki: String,
    pub platform: String,
    pub platform_id: Option<String>,
    pub label: String,
    pub carrier: Option<String>,
    pub sim_slot: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone)]
pub struct NewDevice<'a> {
    pub label: &'a str,
    pub platform: &'a str,
    /// ANDROID_ID / IDFV. A hint, never a credential.
    pub platform_id: Option<&'a str>,
    pub carrier: Option<&'a str>,
    pub sim_slot: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub id: String,
    pub device_id: String,
    pub direction: String,
    pub peer: String,
    pub body: String,
    pub state: String,
    pub local_id: Option<String>,
    pub created_at: i64,
}

pub struct Store {
    db: Database,
}

impl Store {
    /// Open (or create) the database and bring the schema up to date.
    pub async fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let db = Builder::new_local(path.as_ref()).build().await?;
        let store = Self { db };
        store.migrate().await?;
        Ok(store)
    }

    async fn migrate(&self) -> Result<(), StoreError> {
        let conn = self.db.connect()?;
        conn.execute(
            "CREATE TABLE IF NOT EXISTS schema_migrations (
                version    INTEGER PRIMARY KEY,
                applied_at INTEGER NOT NULL
            )",
            (),
        )
        .await?;

        let mut rows = conn
            .query("SELECT COALESCE(MAX(version), 0) FROM schema_migrations", ())
            .await?;
        let current: i64 = match rows.next().await? {
            Some(row) => row.get::<i64>(0)?,
            None => 0,
        };
        drop(rows);

        for (version, sql) in MIGRATIONS {
            if *version <= current {
                continue;
            }
            conn.execute(sql, ()).await?;
            conn.execute(
                "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
                params![*version, now_ms()?],
            )
            .await?;
        }

        Ok(())
    }

    pub async fn schema_version(&self) -> Result<i64, StoreError> {
        let conn = self.db.connect()?;
        let mut rows = conn
            .query("SELECT COALESCE(MAX(version), 0) FROM schema_migrations", ())
            .await?;
        let version = match rows.next().await? {
            Some(row) => row.get::<i64>(0)?,
            None => 0,
        };
        Ok(version)
    }

    /// Create a device with a freshly generated P-256 identity.
    pub async fn create_device(&self, new: NewDevice<'_>) -> Result<(Device, Identity), StoreError> {
        let identity = crate::identity::generate_identity()
            .map_err(|e| StoreError::InvalidDeviceId(e.to_string()))?;
        if !is_valid_device_id(&identity.device_id) {
            return Err(StoreError::InvalidDeviceId(identity.device_id));
        }

        let now = now_ms()?;
        let conn = self.db.connect()?;
        conn.execute(
            "INSERT INTO devices
                (device_id, public_key_spki, private_key_pkcs8, platform, platform_id,
                 label, carrier, sim_slot, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                identity.device_id.clone(),
                identity.public_key_spki_b64.clone(),
                identity.private_key_pkcs8_pem.clone(),
                new.platform,
                new.platform_id,
                new.label,
                new.carrier,
                new.sim_slot,
                now,
                now
            ],
        )
        .await?;

        let device = Device {
            device_id: identity.device_id.clone(),
            public_key_spki: identity.public_key_spki_b64.clone(),
            platform: new.platform.to_string(),
            platform_id: new.platform_id.map(str::to_string),
            label: new.label.to_string(),
            carrier: new.carrier.map(str::to_string),
            sim_slot: new.sim_slot,
            created_at: now,
            updated_at: now,
        };
        Ok((device, identity))
    }

    pub async fn list_devices(&self) -> Result<Vec<Device>, StoreError> {
        let conn = self.db.connect()?;
        let mut rows = conn
            .query(
                "SELECT device_id, public_key_spki, platform, platform_id, label,
                        carrier, sim_slot, created_at, updated_at
                   FROM devices ORDER BY created_at DESC",
                (),
            )
            .await?;

        let mut devices = Vec::new();
        while let Some(row) = rows.next().await? {
            devices.push(Device {
                device_id: row.get(0)?,
                public_key_spki: row.get(1)?,
                platform: row.get(2)?,
                platform_id: row.get(3)?,
                label: row.get(4)?,
                carrier: row.get(5)?,
                sim_slot: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            });
        }
        Ok(devices)
    }

    pub async fn get_device(&self, device_id: &str) -> Result<Option<Device>, StoreError> {
        let conn = self.db.connect()?;
        let mut rows = conn
            .query(
                "SELECT device_id, public_key_spki, platform, platform_id, label,
                        carrier, sim_slot, created_at, updated_at
                   FROM devices WHERE device_id = ?",
                params![device_id],
            )
            .await?;
        match rows.next().await? {
            Some(row) => Ok(Some(Device {
                device_id: row.get(0)?,
                public_key_spki: row.get(1)?,
                platform: row.get(2)?,
                platform_id: row.get(3)?,
                label: row.get(4)?,
                carrier: row.get(5)?,
                sim_slot: row.get(6)?,
                created_at: row.get(7)?,
                updated_at: row.get(8)?,
            })),
            None => Ok(None),
        }
    }

    /// Private key for signing. Simulator-only API surface.
    pub async fn private_key(&self, device_id: &str) -> Result<Option<String>, StoreError> {
        let conn = self.db.connect()?;
        let mut rows = conn
            .query(
                "SELECT private_key_pkcs8 FROM devices WHERE device_id = ?",
                params![device_id],
            )
            .await?;
        match rows.next().await? {
            Some(row) => Ok(Some(row.get(0)?)),
            None => Ok(None),
        }
    }


    /// Persist a small key/value setting (target URL, admin token, …).
    pub async fn set_setting(&self, key: &str, value: &str) -> Result<(), StoreError> {
        let conn = self.db.connect()?;
        conn.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )
        .await?;
        Ok(())
    }

    pub async fn get_setting(&self, key: &str) -> Result<Option<String>, StoreError> {
        let conn = self.db.connect()?;
        let mut rows = conn
            .query("SELECT value FROM settings WHERE key = ?", params![key])
            .await?;
        match rows.next().await? {
            Some(row) => Ok(Some(row.get(0)?)),
            None => Ok(None),
        }
    }

    /// Append a message to this device's local thread.
    pub async fn record_message(
        &self,
        device_id: &str,
        direction: &str,
        peer: &str,
        body: &str,
        state: &str,
        local_id: Option<&str>,
    ) -> Result<Message, StoreError> {
        let id = format!("msg{}", random_hex(12)?);
        let now = now_ms()?;
        let conn = self.db.connect()?;
        conn.execute(
            "INSERT INTO messages
                (id, device_id, direction, peer, body, state, local_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            params![
                id.clone(),
                device_id,
                direction,
                peer,
                body,
                state,
                local_id,
                now
            ],
        )
        .await?;

        Ok(Message {
            id,
            device_id: device_id.to_string(),
            direction: direction.to_string(),
            peer: peer.to_string(),
            body: body.to_string(),
            state: state.to_string(),
            local_id: local_id.map(str::to_string),
            created_at: now,
        })
    }

    pub async fn set_message_state(&self, id: &str, state: &str) -> Result<(), StoreError> {
        let conn = self.db.connect()?;
        conn.execute(
            "UPDATE messages SET state = ? WHERE id = ?",
            params![state, id],
        )
        .await?;
        Ok(())
    }

    pub async fn list_messages(
        &self,
        device_id: &str,
        limit: i64,
    ) -> Result<Vec<Message>, StoreError> {
        let conn = self.db.connect()?;
        let mut rows = conn
            .query(
                "SELECT id, device_id, direction, peer, body, state, local_id, created_at
                   FROM messages WHERE device_id = ?
                  ORDER BY created_at DESC, id DESC LIMIT ?",
                params![device_id, limit],
            )
            .await?;

        let mut out = Vec::new();
        while let Some(row) = rows.next().await? {
            out.push(Message {
                id: row.get(0)?,
                device_id: row.get(1)?,
                direction: row.get(2)?,
                peer: row.get(3)?,
                body: row.get(4)?,
                state: row.get(5)?,
                local_id: row.get(6)?,
                created_at: row.get(7)?,
            });
        }
        Ok(out)
    }

    pub async fn clear_messages(&self, device_id: &str) -> Result<u64, StoreError> {
        let conn = self.db.connect()?;
        let deleted = conn
            .execute("DELETE FROM messages WHERE device_id = ?", params![device_id])
            .await?;
        Ok(deleted as u64)
    }

    /// Airplane-mode switch. Persisted per device so it survives a restart.
    pub async fn set_offline(&self, device_id: &str, offline: bool) -> Result<(), StoreError> {
        self.set_setting(&format!("offline:{device_id}"), if offline { "1" } else { "0" })
            .await
    }

    pub async fn is_offline(&self, device_id: &str) -> Result<bool, StoreError> {
        Ok(self
            .get_setting(&format!("offline:{device_id}"))
            .await?
            .as_deref()
            == Some("1"))
    }


    /// Outbound rows the deployment has not accepted yet.
    pub async fn list_unmirrored_outbound(
        &self,
        device_id: &str,
        limit: i64,
    ) -> Result<Vec<Message>, StoreError> {
        let conn = self.db.connect()?;
        let mut rows = conn
            .query(
                "SELECT id, device_id, direction, peer, body, state, local_id, created_at
                   FROM messages
                  WHERE device_id = ? AND direction = 'out' AND mirrored = 0
                  ORDER BY created_at ASC LIMIT ?",
                params![device_id, limit],
            )
            .await?;

        let mut out = Vec::new();
        while let Some(row) = rows.next().await? {
            out.push(Message {
                id: row.get(0)?,
                device_id: row.get(1)?,
                direction: row.get(2)?,
                peer: row.get(3)?,
                body: row.get(4)?,
                state: row.get(5)?,
                local_id: row.get(6)?,
                created_at: row.get(7)?,
            });
        }
        Ok(out)
    }

    pub async fn mark_mirrored(&self, ids: &[String]) -> Result<(), StoreError> {
        let conn = self.db.connect()?;
        for id in ids {
            conn.execute("UPDATE messages SET mirrored = 1 WHERE id = ?", params![id.as_str()])
                .await?;
        }
        Ok(())
    }

    pub async fn delete_device(&self, device_id: &str) -> Result<bool, StoreError> {
        let conn = self.db.connect()?;
        let affected = conn
            .execute("DELETE FROM devices WHERE device_id = ?", params![device_id])
            .await?;
        Ok(affected > 0)
    }
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

fn now_ms() -> Result<i64, StoreError> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| StoreError::Clock)?
        .as_millis();
    i64::try_from(millis).map_err(|_| StoreError::Clock)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn open_temp() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().join("sim.db")).await.unwrap();
        (dir, store)
    }

    #[tokio::test]
    async fn migrations_are_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sim.db");

        let first = Store::open(&path).await.unwrap();
        let version = first.schema_version().await.unwrap();
        let count = first.list_devices().await.unwrap().len();
        drop(first);

        // Re-opening must not replay migrations or lose data.
        let second = Store::open(&path).await.unwrap();
        assert_eq!(second.schema_version().await.unwrap(), version);
        assert_eq!(version, MIGRATIONS.last().unwrap().0);
        assert_eq!(second.list_devices().await.unwrap().len(), count);
    }

    #[tokio::test]
    async fn device_round_trips_with_a_working_key() {
        let (_dir, store) = open_temp().await;

        let (device, identity) = store
            .create_device(NewDevice {
                label: "Pixel 8 · lab",
                platform: "simulator",
                platform_id: Some("android-id-abc123"),
                carrier: Some("Grameenphone"),
                sim_slot: 1,
            })
            .await
            .unwrap();

        assert!(is_valid_device_id(&device.device_id));
        assert_eq!(device.label, "Pixel 8 · lab");
        assert_eq!(device.platform_id.as_deref(), Some("android-id-abc123"));
        assert_eq!(device.sim_slot, 1);

        let devices = store.list_devices().await.unwrap();
        assert_eq!(devices.len(), 1);
        assert_eq!(devices[0].device_id, device.device_id);

        // The stored key must actually sign, and the stored SPKI must verify.
        let pem = store.private_key(&device.device_id).await.unwrap().unwrap();
        let canonical = "POST\n/v1/sms/outgoing/poll\n1776470400000\na3f1c0d29b7e4f8a1c6d5e2b9f0a7c34\n00";
        let signature = crate::identity::sign_p1363(&pem, canonical).unwrap();
        assert!(
            crate::identity::verify_p1363(&device.public_key_spki, canonical, &signature).unwrap()
        );
        assert_eq!(identity.device_id, device.device_id);
    }

    #[tokio::test]
    async fn settings_round_trip_and_overwrite() {
        let (_dir, store) = open_temp().await;
        assert_eq!(store.get_setting("target").await.unwrap(), None);
        store.set_setting("target", "https://example.workers.dev").await.unwrap();
        assert_eq!(
            store.get_setting("target").await.unwrap().as_deref(),
            Some("https://example.workers.dev")
        );
        store.set_setting("target", "https://other.workers.dev").await.unwrap();
        assert_eq!(
            store.get_setting("target").await.unwrap().as_deref(),
            Some("https://other.workers.dev")
        );
    }


    #[tokio::test]
    async fn outbound_rows_start_unmirrored_and_can_be_marked() {
        let (_dir, store) = open_temp().await;
        let (device, _) = store
            .create_device(NewDevice {
                label: "mirror",
                platform: "simulator",
                platform_id: None,
                carrier: None,
                sim_slot: 0,
            })
            .await
            .unwrap();

        let sent = store
            .record_message(&device.device_id, "out", "+1555", "hello", "sent", Some("out-1"))
            .await
            .unwrap();
        let received = store
            .record_message(&device.device_id, "in", "+1555", "hi", "uploaded", Some("in-1"))
            .await
            .unwrap();

        let pending = store.list_unmirrored_outbound(&device.device_id, 10).await.unwrap();
        assert_eq!(pending.len(), 1, "only outbound rows are mirrored");
        assert_eq!(pending[0].id, sent.id);

        store.mark_mirrored(&[sent.id.clone()]).await.unwrap();
        assert!(store
            .list_unmirrored_outbound(&device.device_id, 10)
            .await
            .unwrap()
            .is_empty());
        assert_eq!(received.direction, "in");
    }

    #[tokio::test]
    async fn deleting_a_device_removes_it() {
        let (_dir, store) = open_temp().await;
        let (device, _) = store
            .create_device(NewDevice {
                label: "temp",
                platform: "simulator",
                platform_id: None,
                carrier: None,
                sim_slot: 0,
            })
            .await
            .unwrap();

        assert!(store.delete_device(&device.device_id).await.unwrap());
        assert!(store.list_devices().await.unwrap().is_empty());
        assert!(store.private_key(&device.device_id).await.unwrap().is_none());
    }
}
