//! Local libSQL store.
//!
//! libSQL is SQLite with a replication story: same file format, same SQL. Keeping
//! it in the Rust core means one schema and one set of migrations for desktop,
//! Android and (later) embedded replicas, instead of a Kotlin/Room implementation
//! on one side and a Rust one on the other.

use std::path::Path;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use libsql::{Builder, Database, params};
use serde::{Deserialize, Serialize};

use crate::flowrun::{FlowRunReport, RemoteFlow};
use crate::identity::{Identity, is_valid_device_id};
use crate::keyvault::{self, KeyCipher, UNLOCK_ERROR};

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("database error: {0}")]
    Database(#[from] libsql::Error),
    #[error("invalid device id: {0}")]
    InvalidDeviceId(String),
    #[error("corrupt stored data: {0}")]
    Corrupt(String),
    #[error("invalid message state: {0}")]
    InvalidState(String),
    #[error("invalid device fact: {0}")]
    InvalidFact(String),
    #[error("time went backwards")]
    Clock,
    /// A `keystore:v1:` blob with no wrapping key, a tampered blob, or a cipher
    /// that refused. Never downgraded to plaintext and never ignored: the
    /// signing path must stop instead of sending an unsigned request.
    #[error("{UNLOCK_ERROR}")]
    KeyLocked,
    /// The wrapping key exists but the platform could not encrypt (or the
    /// round-trip proof failed). The old plaintext value is left in place.
    #[error("the device key cannot be protected on this phone: {0}")]
    Vault(String),
}

/// Facts the native shell may report. Anything else is refused, so a caller
/// cannot use the fact setter to overwrite a credential or the target URL.
pub const DEVICE_FACT_KEYS: [&str; 6] = [
    "self_number",
    "sim_slot",
    "sim_carrier",
    "permissions",
    "battery_optimized",
    "default_sms_app",
];

/// One fact value is a phone number, a slot, a small JSON object or a package
/// name; 256 bytes is comfortably more than any of those needs.
pub const MAX_DEVICE_FACT_LEN: usize = 256;

pub fn is_device_fact_key(key: &str) -> bool {
    DEVICE_FACT_KEYS.contains(&key)
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
    (
        8,
        // The last successfully fetched flow set, so the Android receiver can
        // run flows with no network and no webview. `(id, version)` is the key
        // because an edited graph is a different flow; the table holds the set
        // the server last served, not an append-only history.
        "CREATE TABLE IF NOT EXISTS flows (
            id         TEXT NOT NULL,
            version    INTEGER NOT NULL,
            graph      TEXT NOT NULL,
            fetched_at INTEGER NOT NULL,
            PRIMARY KEY (id, version)
        )",
    ),
    (
        9,
        // M5.5 retry budget. A send that the radio refuses for a transient
        // reason goes back to `queued` and spends one attempt; after the third
        // it becomes `failed` and stops retrying. Rows from before this column
        // existed start at zero, which is the same budget a fresh row gets.
        "ALTER TABLE messages ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0",
    ),
    (
        10,
        // Why the last send failed. Written when the row enters `failed`
        // (the platform rejected it, or transient retries ran out) and cleared
        // when it goes back to `queued`/`sent`/`delivered`, so the mirror never
        // uploads a stale reason as if it were current. NULL means "no reason
        // recorded", never an invented default.
        "ALTER TABLE messages ADD COLUMN last_error TEXT",
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
    /// Why the row last entered `failed`; `None` when no reason was recorded,
    /// and cleared on a retry so it cannot outlive the state it describes.
    pub last_error: Option<String>,
}

/// What one failed send attempt did to the row. `attempts` is the value after
/// the update, so the native receiver can log a truthful retry budget without a
/// second read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SendFailureOutcome {
    pub state: String,
    pub attempts: i64,
}

/// One row of the cached flow set. `node_count` is parsed from the stored graph
/// and is `None` when that graph is not valid JSON; the metadata stays readable
/// either way. The `flows` table has no `enabled` column, so this does not
/// invent one.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CachedFlow {
    pub id: String,
    pub version: i64,
    pub fetched_at: i64,
    pub node_count: Option<u64>,
}

/// One recorded flow run, in the shape the Flows frame reads.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlowRunRow {
    pub local_id: String,
    pub flow_id: String,
    pub flow_version: i64,
    pub outcome: String,
    pub created_at: i64,
}

/// Handset facts the native shell reports once the permission flow settles.
/// A missing or unparseable setting is `None`, never a fabricated default.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct DeviceFacts {
    pub self_number: Option<String>,
    pub sim_slot: Option<i64>,
    pub sim_carrier: Option<String>,
    pub permissions: Option<serde_json::Value>,
    pub battery_optimized: Option<bool>,
    pub default_sms_app: Option<String>,
}

pub struct Store {
    db: Database,
    /// `Some` on Android, where a non-exportable Keystore key can wrap the
    /// identity. `None` on desktop, which keeps the plaintext column.
    cipher: Option<Arc<dyn KeyCipher>>,
}

impl Store {
    /// Open (or create) the database and bring the schema up to date.
    ///
    /// No wrapping cipher: this is the desktop path and the store keeps the
    /// PKCS#8 column exactly as it always has. Android uses
    /// [`Store::open_with_cipher`].
    pub async fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        Self::open_inner(path, None).await
    }

    /// Open the store with the platform's at-rest wrapping key.
    ///
    /// Every plaintext key already in the file is wrapped before the caller
    /// gets the store. Migration is best effort by design: a Keystore that
    /// cannot produce the key must not brick a phone that can still sign, so
    /// the failure is logged and retried by the next open (and by
    /// [`Store::private_key`]). A value that is *already* wrapped is the
    /// opposite case — it fails closed, never back to plaintext.
    pub async fn open_with_cipher(
        path: impl AsRef<Path>,
        cipher: Arc<dyn KeyCipher>,
    ) -> Result<Self, StoreError> {
        let store = Self::open_inner(path, Some(cipher)).await?;
        match store.migrate_device_keys().await {
            Ok(0) => {}
            Ok(count) => eprintln!("[vault] wrapped {count} device key(s) at rest"),
            Err(error) => eprintln!("[vault] key migration deferred: {error}"),
        }
        Ok(store)
    }

    async fn open_inner(
        path: impl AsRef<Path>,
        cipher: Option<Arc<dyn KeyCipher>>,
    ) -> Result<Self, StoreError> {
        let db = Builder::new_local(path.as_ref()).build().await?;
        let store = Self { db, cipher };
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
    ///
    /// With a cipher installed the private half is wrapped and proven before
    /// the row is written, so a fresh install never puts plaintext on disk.
    pub async fn create_device(&self, new: NewDevice<'_>) -> Result<(Device, Identity), StoreError> {
        let identity = crate::identity::generate_identity()
            .map_err(|e| StoreError::InvalidDeviceId(e.to_string()))?;
        if !is_valid_device_id(&identity.device_id) {
            return Err(StoreError::InvalidDeviceId(identity.device_id));
        }

        let stored_key = match &self.cipher {
            Some(cipher) => {
                self.wrap_and_prove(
                    cipher.as_ref(),
                    &identity.private_key_pkcs8_pem,
                    &identity.public_key_spki_b64,
                )
                .await?
            }
            None => identity.private_key_pkcs8_pem.clone(),
        };

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
                stored_key,
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

    /// Record that this device answered a signed request.
    ///
    /// `updated_at` is the only local evidence of contact: the webview cannot see
    /// the deployment's socket, so a phone that has answered a poll or a flush is
    /// as live as this app can honestly claim.
    pub async fn touch_device(&self, device_id: &str) -> Result<(), StoreError> {
        let conn = self.db.connect()?;
        conn.execute(
            "UPDATE devices SET updated_at = ? WHERE device_id = ?",
            params![now_ms()?, device_id],
        )
        .await?;
        Ok(())
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

    /// The device that was most recently paired (or updated). There is no
    /// explicit "default device" column, so recency is the tie-breaker when a
    /// local store holds more than one row — for example a handset that was
    /// paired, revoked and paired again.
    pub async fn latest_device(&self) -> Result<Option<Device>, StoreError> {
        let conn = self.db.connect()?;
        let mut rows = conn
            .query(
                "SELECT device_id, public_key_spki, platform, platform_id, label,
                        carrier, sim_slot, created_at, updated_at
                   FROM devices ORDER BY updated_at DESC, created_at DESC LIMIT 1",
                (),
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

    /// The PKCS#8 PEM used to sign, resolved from the stored value.
    ///
    /// This is the one place the plaintext exists on the Android build: it is
    /// returned for the lifetime of the `DeviceClient` that asked for it and
    /// dropped with it. There is no plaintext on disk because:
    ///
    /// * a `keystore:v1:` blob is unwrapped through the platform key, and a
    ///   missing or invalid key is [`StoreError::KeyLocked`] — never a
    ///   plaintext fallback;
    /// * a legacy plaintext value is wrapped, proven and overwritten here on
    ///   first use (also attempted for every row on open), so a phone that
    ///   already held a key migrates without a new device id or re-pairing.
    ///
    /// A failed wrap leaves the legacy value usable and is logged: the phone
    /// keeps signing while the migration is retried. Only a *wrapped* value
    /// that cannot be unwrapped is fatal.
    pub async fn private_key(&self, device_id: &str) -> Result<Option<String>, StoreError> {
        let Some((stored, spki)) = self.stored_key(device_id).await? else {
            return Ok(None);
        };

        if keyvault::is_wrapped(&stored) {
            let cipher = self.cipher.as_deref().ok_or(StoreError::KeyLocked)?;
            return keyvault::unwrap(cipher, &stored)
                .map(Some)
                .map_err(|_| StoreError::KeyLocked);
        }

        // Legacy plaintext: still the value we can sign with, but wrap it now.
        if let Some(cipher) = self.cipher.clone() {
            match self
                .wrap_plaintext_key(cipher.as_ref(), device_id, &spki, &stored)
                .await
            {
                Ok(true) => self.compact().await,
                Ok(false) => {}
                Err(error) => eprintln!("[vault] key not wrapped yet: {error}"),
            }
        }

        Ok(Some(stored))
    }

    /// Wrap every plaintext key in this store. Returns how many rows changed.
    ///
    /// Idempotent: an already-wrapped row is skipped, and a lost compare-and-
    /// swap (another writer wrapped it first) is a no-op rather than an error.
    /// A row whose round-trip proof fails is left untouched, so a crash or a
    /// bad wrap can never cost the identity.
    pub async fn migrate_device_keys(&self) -> Result<usize, StoreError> {
        let Some(cipher) = self.cipher.clone() else {
            return Ok(0);
        };

        let conn = self.db.connect()?;
        let mut rows = conn
            .query(
                "SELECT device_id, public_key_spki, private_key_pkcs8 FROM devices",
                (),
            )
            .await?;
        let mut plaintext = Vec::new();
        while let Some(row) = rows.next().await? {
            let device_id: String = row.get(0)?;
            let spki: String = row.get(1)?;
            let stored: String = row.get(2)?;
            if !keyvault::is_wrapped(&stored) {
                plaintext.push((device_id, spki, stored));
            }
        }
        drop(rows);
        drop(conn);

        let mut migrated = 0;
        for (device_id, spki, stored) in plaintext {
            if self
                .wrap_plaintext_key(cipher.as_ref(), &device_id, &spki, &stored)
                .await?
            {
                migrated += 1;
            }
        }
        if migrated > 0 {
            self.compact().await;
        }
        Ok(migrated)
    }

    /// Read the stored key column and the SPKI it must match.
    async fn stored_key(&self, device_id: &str) -> Result<Option<(String, String)>, StoreError> {
        let conn = self.db.connect()?;
        let mut rows = conn
            .query(
                "SELECT private_key_pkcs8, public_key_spki FROM devices WHERE device_id = ?",
                params![device_id],
            )
            .await?;
        match rows.next().await? {
            Some(row) => Ok(Some((row.get(0)?, row.get(1)?))),
            None => Ok(None),
        }
    }

    /// Wrap `plaintext`, prove the round-trip and only then overwrite the row.
    ///
    /// The UPDATE is the commit point: a process that dies before it leaves the
    /// old value in place, and the compare-and-swap means a concurrent writer
    /// cannot be overwritten with a second (still valid) wrap.
    async fn wrap_plaintext_key(
        &self,
        cipher: &dyn KeyCipher,
        device_id: &str,
        spki: &str,
        plaintext: &str,
    ) -> Result<bool, StoreError> {
        let wrapped = self.wrap_and_prove(cipher, plaintext, spki).await?;

        let conn = self.db.connect()?;
        let affected = conn
            .execute(
                "UPDATE devices SET private_key_pkcs8 = ?
                  WHERE device_id = ? AND private_key_pkcs8 = ?",
                params![wrapped, device_id, plaintext],
            )
            .await?;
        Ok(affected > 0)
    }

    /// Encrypt `plaintext` and unwrap it back, refusing unless the recovered
    /// key's public half is exactly the stored SPKI.
    async fn wrap_and_prove(
        &self,
        cipher: &dyn KeyCipher,
        plaintext: &str,
        spki: &str,
    ) -> Result<String, StoreError> {
        let wrapped =
            keyvault::wrap(cipher, plaintext).map_err(|e| StoreError::Vault(e.to_string()))?;
        let recovered =
            keyvault::unwrap(cipher, &wrapped).map_err(|e| StoreError::Vault(e.to_string()))?;
        let derived = crate::identity::public_key_spki_b64(&recovered)
            .map_err(|e| StoreError::Vault(e.to_string()))?;
        if derived != spki {
            return Err(StoreError::Vault(
                "round-trip does not match the stored public key".into(),
            ));
        }
        Ok(wrapped)
    }

    /// Rewrite the file after a migration so no stale page or WAL frame still
    /// holds the old PEM. Best effort: a database that cannot compact is still
    /// correct, only larger.
    ///
    /// VACUUM rebuilds every page from live rows; the checkpoint that follows
    /// leaves an empty WAL, which is what makes `strings simulator.db` (and the
    /// whole app directory) free of `BEGIN PRIVATE KEY`.
    async fn compact(&self) {
        let Ok(conn) = self.db.connect() else {
            return;
        };
        if conn.execute("VACUUM", ()).await.is_err() {
            return;
        }
        if let Ok(mut rows) = conn.query("PRAGMA wal_checkpoint(TRUNCATE)", ()).await {
            while let Ok(Some(_)) = rows.next().await {}
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

    /// Persist one whitelisted handset fact.
    ///
    /// The key is checked here, in the core, so both the Tauri command surface
    /// and the JNI setter share one rule. A rejected key is never written, which
    /// also keeps the fact path from overwriting `base_url` or `admin_token`.
    pub async fn set_device_fact(&self, key: &str, value: &str) -> Result<(), StoreError> {
        if !is_device_fact_key(key) {
            return Err(StoreError::InvalidFact(key.to_string()));
        }
        if value.len() > MAX_DEVICE_FACT_LEN {
            return Err(StoreError::InvalidFact(format!("value too long for {key}")));
        }
        self.set_setting(key, value).await
    }

    /// The last handset facts the native shell wrote. Each missing or malformed
    /// value stays `None`, so the UI shows "not reported" instead of a guess.
    pub async fn get_device_facts(&self) -> Result<DeviceFacts, StoreError> {
        let self_number = self.get_setting("self_number").await?;
        let sim_slot = self
            .get_setting("sim_slot")
            .await?
            .and_then(|value| value.parse::<i64>().ok());
        let sim_carrier = self.get_setting("sim_carrier").await?;
        let permissions = self
            .get_setting("permissions")
            .await?
            .and_then(|value| serde_json::from_str(&value).ok());
        let battery_optimized = self
            .get_setting("battery_optimized")
            .await?
            .and_then(|value| value.parse::<bool>().ok());
        let default_sms_app = self.get_setting("default_sms_app").await?;

        Ok(DeviceFacts {
            self_number,
            sim_slot,
            sim_carrier,
            permissions,
            battery_optimized,
            default_sms_app,
        })
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
            last_error: None,
        })
    }

    /// Queue one SMS composed on this phone and return the device-local id the
    /// sender must later mark.
    ///
    /// The row is written before the radio is touched, so a send that dies on
    /// the way to `SmsManager` still leaves an honest `queued` row for the
    /// status receiver to finish. The id is a fresh `compose-<hex>`; the
    /// `UNIQUE(device_id, local_id)` key is the same idempotency rule the reply
    /// path uses, and an identical send that is still `queued` is resolved to
    /// the row that already exists. A double tap therefore cannot create two
    /// rows for one send. Once the row leaves `queued` (`sent` or `failed`), a
    /// new send of the same text is a new row.
    pub async fn queue_composed_outbound(
        &self,
        device_id: &str,
        to: &str,
        body: &str,
    ) -> Result<String, StoreError> {
        let conn = self.db.connect()?;
        // One transaction so the lookup and the insert cannot interleave with
        // another queue call on a second connection.
        let tx = conn.transaction().await?;

        let mut rows = tx
            .query(
                "SELECT local_id FROM messages
                  WHERE device_id = ? AND direction = 'out' AND peer = ? AND body = ?
                    AND state = 'queued' AND local_id LIKE 'compose-%'
                  ORDER BY created_at DESC, id DESC LIMIT 1",
                params![device_id, to, body],
            )
            .await?;
        let existing: Option<String> = match rows.next().await? {
            Some(row) => Some(row.get(0)?),
            None => None,
        };
        drop(rows);

        if let Some(local_id) = existing {
            tx.commit().await?;
            return Ok(local_id);
        }

        let id = format!("msg{}", random_hex(12)?);
        let local_id = format!("compose-{}", random_hex(12)?);
        let now = now_ms()?;
        tx.execute(
            "INSERT INTO messages
                (id, device_id, direction, peer, body, state, local_id, created_at)
             VALUES (?, ?, 'out', ?, ?, 'queued', ?, ?)",
            params![id, device_id, to, body, local_id.as_str(), now],
        )
        .await?;
        tx.commit().await?;

        Ok(local_id)
    }

    /// Persist one flow run for an inbound message.
    ///
    /// `(device_id, local_id, flow_id, flow_version)` is the dedupe key shared
    /// with the Worker fallback, so a repeated insert is a no-op rather than an
    /// error: a re-delivered broadcast can report the same run again without
    /// creating a second row. `sms_json` keeps its default.
    pub async fn record_run(
        &self,
        device_id: &str,
        report: &FlowRunReport,
    ) -> Result<(), StoreError> {
        let id = format!("run{}", random_hex(12)?);
        let now = now_ms()?;
        let conn = self.db.connect()?;
        conn.execute(
            "INSERT OR IGNORE INTO flow_runs
                (id, device_id, local_id, flow_id, flow_version, outcome, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
            params![
                id,
                device_id,
                report.local_id.as_str(),
                report.flow_id.as_str(),
                report.flow_version,
                report.outcome.as_str(),
                now
            ],
        )
        .await?;
        Ok(())
    }

    /// This device's recorded runs, newest first. Clamped so a bad caller cannot
    /// ask the phone to materialise its entire history.
    pub async fn list_flow_runs(
        &self,
        device_id: &str,
        limit: i64,
    ) -> Result<Vec<FlowRunRow>, StoreError> {
        let limit = limit.clamp(1, 100);
        let conn = self.db.connect()?;
        let mut rows = conn
            .query(
                "SELECT local_id, flow_id, flow_version, outcome, created_at
                   FROM flow_runs WHERE device_id = ?
                  ORDER BY created_at DESC, id DESC LIMIT ?",
                params![device_id, limit],
            )
            .await?;

        let mut out = Vec::new();
        while let Some(row) = rows.next().await? {
            out.push(FlowRunRow {
                local_id: row.get(0)?,
                flow_id: row.get(1)?,
                flow_version: row.get(2)?,
                outcome: row.get(3)?,
                created_at: row.get(4)?,
            });
        }
        Ok(out)
    }

    /// Find a row by its deterministic device-local id. This is how a
    /// re-delivered `SMS_RECEIVED` broadcast resolves to the row the first
    /// delivery already wrote.
    pub async fn message_by_local_id(
        &self,
        device_id: &str,
        local_id: &str,
    ) -> Result<Option<Message>, StoreError> {
        let conn = self.db.connect()?;
        let mut rows = conn
            .query(
                "SELECT id, device_id, direction, peer, body, state, local_id, created_at, last_error
                   FROM messages WHERE device_id = ? AND local_id = ?",
                params![device_id, local_id],
            )
            .await?;
        match rows.next().await? {
            Some(row) => Ok(Some(Message {
                id: row.get(0)?,
                device_id: row.get(1)?,
                direction: row.get(2)?,
                peer: row.get(3)?,
                body: row.get(4)?,
                state: row.get(5)?,
                local_id: row.get(6)?,
                created_at: row.get(7)?,
                last_error: row.get(8)?,
            })),
            None => Ok(None),
        }
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
                "SELECT id, device_id, direction, peer, body, state, local_id, created_at, last_error
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
                last_error: row.get(8)?,
            });
        }
        Ok(out)
    }

    /// One keyset page strictly older than `(before_created_at, before_id)`.
    ///
    /// The tie-breaker is `id`, matching the `ORDER BY created_at DESC, id DESC`
    /// of [`Store::list_messages`]. Comparing the tuple rather than just the
    /// timestamp is what keeps rows that share a millisecond from repeating or
    /// vanishing between pages.
    pub async fn list_messages_before(
        &self,
        device_id: &str,
        before_created_at: i64,
        before_id: &str,
        limit: i64,
    ) -> Result<Vec<Message>, StoreError> {
        let conn = self.db.connect()?;
        let mut rows = conn
            .query(
                "SELECT id, device_id, direction, peer, body, state, local_id, created_at, last_error
                   FROM messages
                  WHERE device_id = ?
                    AND (created_at < ? OR (created_at = ? AND id < ?))
                  ORDER BY created_at DESC, id DESC LIMIT ?",
                params![
                    device_id,
                    before_created_at,
                    before_created_at,
                    before_id,
                    limit
                ],
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
                last_error: row.get(8)?,
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
    ///
    /// `failed` is included: a reply the radio refused is the row the operator
    /// most needs to see, and it is uploaded exactly once with its `state` and
    /// reason. If M5.5 later retries it to `sent`/`delivered`, that transition
    /// resets `mirrored`, so the same `(device_id, local_id)` is uploaded again
    /// and the Worker updates it instead of inserting a second row.
    ///
    /// `delivered` is the final state and stays eligible until it has been
    /// mirrored once. The deployment's `messages` row now carries `reply_state`,
    /// so the whole transition is visible to the console.
    pub async fn list_unmirrored_outbound(
        &self,
        device_id: &str,
        limit: i64,
    ) -> Result<Vec<Message>, StoreError> {
        let conn = self.db.connect()?;
        let mut rows = conn
            .query(
                "SELECT id, device_id, direction, peer, body, state, local_id, created_at, last_error
                   FROM messages
                  WHERE device_id = ? AND direction = 'out' AND mirrored = 0
                    AND state IN ('queued', 'sent', 'failed', 'delivered')
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
                last_error: row.get(8)?,
            });
        }
        Ok(out)
    }

    /// Inbound rows a native flush has not uploaded yet.
    ///
    /// `received` is the marker: the carrier path flips its own rows to
    /// `uploaded` as soon as it uploads, while a row written by the Android
    /// receiver stays `received` until a flush is accepted for it.
    pub async fn list_pending_inbound(
        &self,
        device_id: &str,
        limit: i64,
    ) -> Result<Vec<Message>, StoreError> {
        let conn = self.db.connect()?;
        let mut rows = conn
            .query(
                "SELECT id, device_id, direction, peer, body, state, local_id, created_at, last_error
                   FROM messages
                  WHERE device_id = ? AND direction = 'in' AND state = 'received'
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
                last_error: row.get(8)?,
            });
        }
        Ok(out)
    }

    /// Every stored run for the given inbound message ids.
    ///
    /// An empty slice is answered without touching the database; otherwise this
    /// is one `IN (…)` query whose placeholder count comes from the slice length.
    pub async fn list_runs_for_inbound(
        &self,
        device_id: &str,
        local_ids: &[String],
    ) -> Result<Vec<FlowRunReport>, StoreError> {
        if local_ids.is_empty() {
            return Ok(Vec::new());
        }

        let placeholders = vec!["?"; local_ids.len()].join(", ");
        let sql = format!(
            "SELECT local_id, flow_id, flow_version, outcome
               FROM flow_runs
              WHERE device_id = ? AND local_id IN ({placeholders})
              ORDER BY created_at ASC, id ASC"
        );

        let mut values: Vec<libsql::Value> = Vec::with_capacity(local_ids.len() + 1);
        values.push(device_id.to_string().into());
        values.extend(local_ids.iter().cloned().map(Into::into));

        let conn = self.db.connect()?;
        let mut rows = conn.query(&sql, values).await?;

        let mut out = Vec::new();
        while let Some(row) = rows.next().await? {
            out.push(FlowRunReport {
                local_id: row.get(0)?,
                flow_id: row.get(1)?,
                flow_version: row.get(2)?,
                outcome: row.get(3)?,
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

    /// Record the outcome of an outbound send by its device-local id.
    ///
    /// The receiver learns the id from the JNI reply and reports what actually
    /// happened, so the mirror never uploads a reply that was never sent. The
    /// accepted states are `queued`, `sent`, `failed` and the terminal
    /// `delivered`.
    ///
    /// `delivered` has a stricter rule than the others: it may only follow
    /// `sent` (or repeat an existing `delivered`). A delivery mark on a
    /// `queued` or `failed` row is refused with [`StoreError::InvalidState`]
    /// rather than coerced, so a caller cannot skip the radio's verdict. A
    /// late `sent` report must likewise not erase an earlier `delivered`; that
    /// case is a no-op success.
    ///
    /// `queued` is also how M5.5 flips a transiently failed row back for retry
    /// (see [`Store::record_send_failure_by_local_id`]). Returns `false` when no
    /// outbound row matched (a re-delivery with no reply, or a stale id).
    ///
    /// A transition clears `mirrored`, so the deployment sees the new state on
    /// the next flush even when this row was already mirrored as `failed` or
    /// `sent`. `failed` records a reason in `last_error`; every other state
    /// clears it, so a reason never outlives the failure it describes.
    pub async fn set_message_state_by_local_id(
        &self,
        device_id: &str,
        local_id: &str,
        state: &str,
    ) -> Result<bool, StoreError> {
        if !matches!(state, "queued" | "sent" | "failed" | "delivered") {
            return Err(StoreError::InvalidState(state.to_string()));
        }

        // The native bridge calls `markOutbound(..., "failed")` for a platform
        // result that is neither OK nor a retryable radio error. The result code
        // is not on this path, so store the one truthful fact we have rather
        // than fabricate a carrier message.
        let last_error = if state == "failed" {
            Some("send_rejected")
        } else {
            None
        };

        let conn = self.db.connect()?;
        // Read and write in one transaction: the `delivered` rule depends on
        // the current state, and two reports can race in a broadcast receiver.
        let tx = conn.transaction().await?;
        let mut rows = tx
            .query(
                "SELECT state FROM messages
                  WHERE device_id = ? AND local_id = ? AND direction = 'out'",
                params![device_id, local_id],
            )
            .await?;
        let current: Option<String> = match rows.next().await? {
            Some(row) => Some(row.get(0)?),
            None => None,
        };
        drop(rows);

        let Some(current) = current else {
            tx.commit().await?;
            return Ok(false);
        };

        match state {
            "delivered" => {
                if current != "sent" && current != "delivered" {
                    // Dropping the transaction rolls it back; nothing changed.
                    return Err(StoreError::InvalidState(format!(
                        "delivered after {current}"
                    )));
                }
                if current != "delivered" {
                    tx.execute(
                        "UPDATE messages SET state = 'delivered', last_error = NULL,
                                mirrored = 0
                          WHERE device_id = ? AND local_id = ? AND direction = 'out'",
                        params![device_id, local_id],
                    )
                    .await?;
                }
            }
            "sent" => {
                // A delivery report can beat the SENT broadcast. The final
                // state is stronger evidence than the intermediate one, so a
                // late `sent` is a no-op rather than a downgrade.
                if current != "delivered" {
                    tx.execute(
                        "UPDATE messages SET state = 'sent', last_error = NULL,
                                mirrored = 0
                          WHERE device_id = ? AND local_id = ? AND direction = 'out'",
                        params![device_id, local_id],
                    )
                    .await?;
                }
            }
            _ => {
                tx.execute(
                    "UPDATE messages SET state = ?, last_error = ?, mirrored = 0
                      WHERE device_id = ? AND local_id = ? AND direction = 'out'",
                    params![state, last_error, device_id, local_id],
                )
                .await?;
            }
        }

        tx.commit().await?;
        Ok(true)
    }

    /// Mark a row `delivered` from a carrier delivery report.
    ///
    /// A delivery report is proof that the carrier accepted the message, so it
    /// is the one caller allowed to promote a `queued` row. That promotion is
    /// done as `sent` then `delivered` inside one transaction: an observer never
    /// sees a delivered row that skipped the state rule, and a report that
    /// arrived before the SENT broadcast is not lost.
    ///
    /// A `failed` row is refused (`Ok(false)`): the radio said the message never
    /// left, and a delivery report that contradicts that is not trusted to
    /// rewrite history. A missing row is also `Ok(false)`.
    pub async fn mark_delivered_by_local_id(
        &self,
        device_id: &str,
        local_id: &str,
    ) -> Result<bool, StoreError> {
        let conn = self.db.connect()?;
        let tx = conn.transaction().await?;
        let mut rows = tx
            .query(
                "SELECT state FROM messages
                  WHERE device_id = ? AND local_id = ? AND direction = 'out'",
                params![device_id, local_id],
            )
            .await?;
        let current: Option<String> = match rows.next().await? {
            Some(row) => Some(row.get(0)?),
            None => None,
        };
        drop(rows);

        let Some(current) = current else {
            tx.commit().await?;
            return Ok(false);
        };

        match current.as_str() {
            "delivered" => {}
            "sent" => {
                tx.execute(
                    "UPDATE messages SET state = 'delivered', last_error = NULL,
                            mirrored = 0
                      WHERE device_id = ? AND local_id = ? AND direction = 'out'",
                    params![device_id, local_id],
                )
                .await?;
            }
            "queued" => {
                // One transaction, so the persisted history is `queued` then
                // `delivered` with the intermediate `sent` mark applied first.
                tx.execute(
                    "UPDATE messages SET state = 'sent', last_error = NULL,
                            mirrored = 0
                      WHERE device_id = ? AND local_id = ? AND direction = 'out'",
                    params![device_id, local_id],
                )
                .await?;
                tx.execute(
                    "UPDATE messages SET state = 'delivered', last_error = NULL,
                            mirrored = 0
                      WHERE device_id = ? AND local_id = ? AND direction = 'out'",
                    params![device_id, local_id],
                )
                .await?;
            }
            // `failed` (or a state this build does not know) is not evidence
            // that can be rewritten. Leave it alone and say so.
            _ => {
                tx.commit().await?;
                return Ok(false);
            }
        }

        tx.commit().await?;
        Ok(true)
    }

    /// Record one failed send attempt.
    ///
    /// `transient` is the radio's own verdict (`RESULT_ERROR_RADIO_OFF` or
    /// `RESULT_ERROR_NO_SERVICE`): the row goes back to `queued` and spends one
    /// attempt, except that the third such failure turns it `failed` so it stops
    /// retrying. A permanent refusal (`failed`) is unchanged and spends no
    /// budget, because retrying it would only repeat the same refusal.
    ///
    /// Returns `None` when no `queued` outbound row matched a transient report
    /// (a late duplicate or a stale id); the row is otherwise reported with its
    /// post-update state and attempt count.
    pub async fn record_send_failure_by_local_id(
        &self,
        device_id: &str,
        local_id: &str,
        transient: bool,
    ) -> Result<Option<SendFailureOutcome>, StoreError> {
        let conn = self.db.connect()?;

        if !transient {
            let affected = conn
                .execute(
                    "UPDATE messages SET state = 'failed', last_error = 'send_rejected',
                            mirrored = 0
                      WHERE device_id = ? AND local_id = ? AND direction = 'out'",
                    params![device_id, local_id],
                )
                .await?;
            if affected == 0 {
                return Ok(None);
            }
            return self
                .send_failure_outcome(&conn, device_id, local_id)
                .await;
        }

        let tx = conn.transaction().await?;
        let mut rows = tx
            .query(
                "SELECT state, attempts FROM messages
                  WHERE device_id = ? AND local_id = ? AND direction = 'out'",
                params![device_id, local_id],
            )
            .await?;
        let current: Option<(String, i64)> = match rows.next().await? {
            Some(row) => Some((row.get(0)?, row.get(1)?)),
            None => None,
        };
        drop(rows);

        let Some((state, attempts)) = current else {
            tx.commit().await?;
            return Ok(None);
        };
        // Only a row that is still waiting for the radio can spend an attempt.
        // A late report against a `sent`/`delivered`/`failed` row is a no-op.
        if state != "queued" {
            tx.commit().await?;
            return Ok(None);
        }

        let next_attempts = attempts + 1;
        let next_state = if next_attempts >= 3 { "failed" } else { "queued" };
        // Only an exhausted retry budget is a recorded failure. A row going
        // back to `queued` clears the reason, because the next attempt has not
        // failed yet.
        let last_error = if next_state == "failed" {
            Some("radio_off_or_no_service")
        } else {
            None
        };
        tx.execute(
            "UPDATE messages SET state = ?, attempts = ?, last_error = ?, mirrored = 0
              WHERE device_id = ? AND local_id = ? AND direction = 'out'",
            params![next_state, next_attempts, last_error, device_id, local_id],
        )
        .await?;
        tx.commit().await?;

        Ok(Some(SendFailureOutcome {
            state: next_state.to_string(),
            attempts: next_attempts,
        }))
    }

    async fn send_failure_outcome(
        &self,
        conn: &libsql::Connection,
        device_id: &str,
        local_id: &str,
    ) -> Result<Option<SendFailureOutcome>, StoreError> {
        let mut rows = conn
            .query(
                "SELECT state, attempts FROM messages
                  WHERE device_id = ? AND local_id = ? AND direction = 'out'",
                params![device_id, local_id],
            )
            .await?;
        match rows.next().await? {
            Some(row) => Ok(Some(SendFailureOutcome {
                state: row.get(0)?,
                attempts: row.get(1)?,
            })),
            None => Ok(None),
        }
    }

    /// Queued outbound rows M5.5 may retry.
    ///
    /// Only rows that are still `queued`, have spent fewer than three attempts
    /// and are older than the 60 s grace period are eligible. The grace period
    /// keeps a send that is merely slow to report from being handed to the radio
    /// twice; the age is measured from `created_at`, the same timestamp the
    /// mirror uploads, so the rule is visible in one place.
    pub async fn list_retryable_outbound(
        &self,
        device_id: &str,
        now: i64,
        limit: i64,
    ) -> Result<Vec<Message>, StoreError> {
        let cutoff = now.saturating_sub(60_000);
        let limit = limit.clamp(1, 100);
        let conn = self.db.connect()?;
        let mut rows = conn
            .query(
                "SELECT id, device_id, direction, peer, body, state, local_id, created_at, last_error
                   FROM messages
                  WHERE device_id = ? AND direction = 'out' AND state = 'queued'
                    AND attempts < 3 AND created_at < ?
                  ORDER BY created_at ASC LIMIT ?",
                params![device_id, cutoff, limit],
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
                last_error: row.get(8)?,
            });
        }
        Ok(out)
    }

    pub async fn delete_device(&self, device_id: &str) -> Result<bool, StoreError> {
        let conn = self.db.connect()?;
        let affected = conn
            .execute("DELETE FROM devices WHERE device_id = ?", params![device_id])
            .await?;
        Ok(affected > 0)
    }

    /// Replace the cached flow set with the last successfully fetched one.
    ///
    /// The fetched list is authoritative: rows are inserted/updated in one
    /// transaction and every row not in it is deleted. That is deliberate —
    /// a flow deleted on the server must stop running on the phone, and a graph
    /// version that is no longer served must not keep answering alongside the
    /// current one. An empty list therefore clears the cache.
    ///
    /// Callers must only call this after a successful fetch. A failed fetch
    /// leaves the previous set untouched for the next background run.
    pub async fn replace_flows(&self, flows: &[RemoteFlow]) -> Result<(), StoreError> {
        let fetched_at = now_ms()?;
        let conn = self.db.connect()?;
        // Atomic: a crash between delete and insert must not leave the receiver
        // with no flows at all.
        let tx = conn.transaction().await?;
        tx.execute("DELETE FROM flows", ()).await?;
        for flow in flows {
            let graph = serde_json::to_string(&flow.graph)
                .map_err(|e| StoreError::Corrupt(format!("flow graph: {e}")))?;
            tx.execute(
                "INSERT INTO flows (id, version, graph, fetched_at)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT(id, version) DO UPDATE SET
                     graph = excluded.graph,
                     fetched_at = excluded.fetched_at",
                params![flow.id.as_str(), flow.version, graph, fetched_at],
            )
            .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    /// The flow set the background receiver executes. Empty until the first
    /// successful fetch (see [`Store::replace_flows`]).
    pub async fn load_flows(&self) -> Result<Vec<RemoteFlow>, StoreError> {
        let conn = self.db.connect()?;
        let mut rows = conn
            .query("SELECT id, version, graph FROM flows ORDER BY id, version", ())
            .await?;

        let mut flows = Vec::new();
        while let Some(row) = rows.next().await? {
            let graph: String = row.get(2)?;
            let graph = serde_json::from_str(&graph)
                .map_err(|e| StoreError::Corrupt(format!("flow graph: {e}")))?;
            flows.push(RemoteFlow {
                id: row.get(0)?,
                version: row.get(1)?,
                graph,
            });
        }
        Ok(flows)
    }

    /// Read the cached flow set as metadata for the Flows frame.
    ///
    /// Unlike [`Store::load_flows`] this tolerates a corrupt graph: the row is
    /// still reported, with `node_count` set to `None`, because hiding a cached
    /// flow would be a lie about what this phone holds.
    pub async fn list_cached_flows(&self) -> Result<Vec<CachedFlow>, StoreError> {
        let conn = self.db.connect()?;
        let mut rows = conn
            .query(
                "SELECT id, version, graph, fetched_at FROM flows ORDER BY id, version",
                (),
            )
            .await?;

        let mut flows = Vec::new();
        while let Some(row) = rows.next().await? {
            let graph: String = row.get(2)?;
            let node_count = serde_json::from_str::<serde_json::Value>(&graph)
                .ok()
                .and_then(|value| {
                    value
                        .get("nodes")
                        .and_then(|nodes| nodes.as_array())
                        .and_then(|nodes| u64::try_from(nodes.len()).ok())
                });
            flows.push(CachedFlow {
                id: row.get(0)?,
                version: row.get(1)?,
                fetched_at: row.get(3)?,
                node_count,
            });
        }
        Ok(flows)
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

    /* ------------------------------------------------------- identity vault */

    use crate::keyvault::testing::StubCipher;
    use base64::{Engine as _, engine::general_purpose::STANDARD};

    async fn raw_key(store: &Store, device_id: &str) -> String {
        let conn = store.db.connect().unwrap();
        let mut rows = conn
            .query(
                "SELECT private_key_pkcs8 FROM devices WHERE device_id = ?",
                params![device_id],
            )
            .await
            .unwrap();
        rows.next().await.unwrap().unwrap().get(0).unwrap()
    }

    /// True when the database file (or either sidecar) still contains the PEM
    /// header. This is the `strings simulator.db | grep BEGIN PRIVATE KEY`
    /// check, run against every file SQLite may keep.
    fn pem_on_disk(path: &std::path::Path) -> bool {
        for suffix in ["", "-wal", "-shm"] {
            let candidate = std::path::PathBuf::from(format!("{}{suffix}", path.display()));
            if let Ok(bytes) = std::fs::read(&candidate) {
                if bytes.windows(17).any(|window| window == b"BEGIN PRIVATE KEY") {
                    return true;
                }
            }
        }
        false
    }

    /// Insert one device row with an explicit plaintext key. This is the shape
    /// a phone that predates the vault has on disk.
    async fn insert_plaintext(
        store: &Store,
        identity: &crate::identity::Identity,
    ) -> crate::db::Device {
        let conn = store.db.connect().unwrap();
        conn.execute(
            "INSERT INTO devices
                (device_id, public_key_spki, private_key_pkcs8, platform, platform_id,
                 label, carrier, sim_slot, created_at, updated_at)
             VALUES (?, ?, ?, 'simulator', NULL, 'legacy', NULL, 0, 1, 1)",
            params![
                identity.device_id.clone(),
                identity.public_key_spki_b64.clone(),
                identity.private_key_pkcs8_pem.clone()
            ],
        )
        .await
        .unwrap();
        store.get_device(&identity.device_id).await.unwrap().unwrap()
    }

    #[tokio::test]
    async fn opening_with_a_cipher_wraps_an_existing_key_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sim.db");
        let identity = crate::identity::generate_identity().unwrap();

        {
            let store = Store::open(&path).await.unwrap();
            insert_plaintext(&store, &identity).await;
            assert!(raw_key(&store, &identity.device_id)
                .await
                .starts_with("-----BEGIN PRIVATE KEY-----"));
            assert!(pem_on_disk(&path));
        }

        // First Android open: the legacy row is wrapped, proven, overwritten.
        let store = Store::open_with_cipher(
            &path,
            std::sync::Arc::new(StubCipher::new(0x5A)),
        )
        .await
        .unwrap();

        let stored = raw_key(&store, &identity.device_id).await;
        assert!(stored.starts_with(crate::keyvault::KEYSTORE_PREFIX));
        assert!(crate::keyvault::parse(&stored).is_ok());
        assert!(!pem_on_disk(&path), "the plaintext key is still on disk");

        // Same device id, same SPKI: no re-enrolment, only the at-rest form
        // changed.
        let device = store.get_device(&identity.device_id).await.unwrap().unwrap();
        assert_eq!(device.public_key_spki, identity.public_key_spki_b64);

        // The key still signs, and the signature verifies against the stored
        // public half.
        let pem = store.private_key(&identity.device_id).await.unwrap().unwrap();
        assert!(pem.starts_with("-----BEGIN PRIVATE KEY-----"));
        let canonical = "POST\n/v1/sms/outgoing/poll\n1776470400000\nabc\ne3b0";
        let signature = crate::identity::sign_p1363(&pem, canonical).unwrap();
        assert!(
            crate::identity::verify_p1363(&device.public_key_spki, canonical, &signature).unwrap()
        );

        // One-way: a second pass finds nothing to do and rewrites nothing.
        let before = raw_key(&store, &identity.device_id).await;
        assert_eq!(store.migrate_device_keys().await.unwrap(), 0);
        assert_eq!(raw_key(&store, &identity.device_id).await, before);
    }

    #[tokio::test]
    async fn a_device_created_with_a_cipher_is_never_written_in_plaintext() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sim.db");
        let store = Store::open_with_cipher(
            &path,
            std::sync::Arc::new(StubCipher::new(0x33)),
        )
        .await
        .unwrap();

        let (device, identity) = store
            .create_device(NewDevice {
                label: "fresh",
                platform: "android",
                platform_id: None,
                carrier: None,
                sim_slot: 0,
            })
            .await
            .unwrap();

        let stored = raw_key(&store, &device.device_id).await;
        assert!(stored.starts_with(crate::keyvault::KEYSTORE_PREFIX));
        assert!(!pem_on_disk(&path));
        assert_eq!(device.public_key_spki, identity.public_key_spki_b64);

        let pem = store.private_key(&device.device_id).await.unwrap().unwrap();
        assert_eq!(pem, identity.private_key_pkcs8_pem);
    }

    #[tokio::test]
    async fn a_wrapped_key_without_its_cipher_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sim.db");
        let identity = crate::identity::generate_identity().unwrap();

        {
            let store = Store::open(&path).await.unwrap();
            insert_plaintext(&store, &identity).await;
        }
        {
            let store = Store::open_with_cipher(
                &path,
                std::sync::Arc::new(StubCipher::new(0x5A)),
            )
            .await
            .unwrap();
            assert!(store
                .private_key(&identity.device_id)
                .await
                .unwrap()
                .unwrap()
                .starts_with("-----BEGIN PRIVATE KEY-----"));
        }

        // A desktop build has no Keystore, and a phone that lost its key looks
        // the same: a wrapped blob with no way to open it.
        let store = Store::open(&path).await.unwrap();
        let error = store.private_key(&identity.device_id).await.unwrap_err();
        assert!(matches!(error, StoreError::KeyLocked));
        assert_eq!(
            error.to_string(),
            "The device key cannot be unlocked on this phone"
        );
    }

    #[tokio::test]
    async fn a_blob_from_a_different_wrapping_key_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sim.db");
        let identity = crate::identity::generate_identity().unwrap();

        {
            let store = Store::open(&path).await.unwrap();
            insert_plaintext(&store, &identity).await;
        }
        {
            let store = Store::open_with_cipher(
                &path,
                std::sync::Arc::new(StubCipher::new(0x5A)),
            )
            .await
            .unwrap();
            store.private_key(&identity.device_id).await.unwrap();
        }

        // The Keystore entry was deleted or never restored from a backup; the
        // platform now has a different key. Never fall back to anything.
        let store = Store::open_with_cipher(
            &path,
            std::sync::Arc::new(StubCipher::new(0x01)),
        )
        .await
        .unwrap();
        assert!(matches!(
            store.private_key(&identity.device_id).await,
            Err(StoreError::KeyLocked)
        ));
    }

    #[tokio::test]
    async fn a_tampered_blob_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sim.db");
        let identity = crate::identity::generate_identity().unwrap();

        {
            let store = Store::open(&path).await.unwrap();
            insert_plaintext(&store, &identity).await;
        }
        let store = Store::open_with_cipher(
            &path,
            std::sync::Arc::new(StubCipher::new(0x5A)),
        )
        .await
        .unwrap();

        // Flip one bit of the ciphertext, leaving the framing intact.
        let stored = raw_key(&store, &identity.device_id).await;
        let fields: Vec<&str> = stored.split(':').collect();
        assert_eq!(fields.len(), 4);
        let mut ciphertext = STANDARD.decode(fields[3]).unwrap();
        ciphertext[0] ^= 0x01;
        let tampered = format!(
            "keystore:v1:{}:{}",
            fields[2],
            STANDARD.encode(&ciphertext)
        );
        {
            let conn = store.db.connect().unwrap();
            conn.execute(
                "UPDATE devices SET private_key_pkcs8 = ? WHERE device_id = ?",
                params![tampered, identity.device_id.as_str()],
            )
            .await
            .unwrap();
        }

        assert!(matches!(
            store.private_key(&identity.device_id).await,
            Err(StoreError::KeyLocked)
        ));
    }

    #[tokio::test]
    async fn a_failed_round_trip_leaves_the_old_key_usable() {
        /// Encrypts, then refuses to decrypt: the equivalent of a Keystore that
        /// accepted the wrap but cannot return the same bytes.
        struct BrokenCipher(StubCipher);

        impl KeyCipher for BrokenCipher {
            fn encrypt(&self, plaintext: &str) -> Result<(String, String), crate::keyvault::KeyVaultError> {
                self.0.encrypt(plaintext)
            }
            fn decrypt(
                &self,
                _iv_b64: &str,
                _ciphertext_b64: &str,
            ) -> Result<String, crate::keyvault::KeyVaultError> {
                Err(crate::keyvault::KeyVaultError::Invalid)
            }
        }

        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("sim.db");
        let identity = crate::identity::generate_identity().unwrap();
        {
            let store = Store::open(&path).await.unwrap();
            insert_plaintext(&store, &identity).await;
        }

        let store = Store::open_with_cipher(
            &path,
            std::sync::Arc::new(BrokenCipher(StubCipher::new(0x5A))),
        )
        .await
        .unwrap();

        // Open swallowed the failure; the migration itself reports it...
        assert!(store.migrate_device_keys().await.is_err());
        // ...and the row still holds the exact plaintext it started with.
        assert_eq!(
            raw_key(&store, &identity.device_id).await,
            identity.private_key_pkcs8_pem
        );
        // A phone in this state keeps working while the next open retries.
        assert_eq!(
            store.private_key(&identity.device_id).await.unwrap().unwrap(),
            identity.private_key_pkcs8_pem
        );
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
    async fn pending_inbound_ignores_outbound_and_uploaded_rows() {
        let (_dir, store) = open_temp().await;
        let (device, _) = store
            .create_device(NewDevice {
                label: "flush",
                platform: "android",
                platform_id: None,
                carrier: None,
                sim_slot: 0,
            })
            .await
            .unwrap();

        let pending = store
            .record_message(&device.device_id, "in", "+1555", "one", "received", Some("in-1"))
            .await
            .unwrap();
        store
            .record_message(&device.device_id, "in", "+1555", "two", "uploaded", Some("in-2"))
            .await
            .unwrap();
        store
            .record_message(&device.device_id, "out", "+1555", "reply", "sent", Some("out-1"))
            .await
            .unwrap();

        let rows = store
            .list_pending_inbound(&device.device_id, 10)
            .await
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, pending.id);
        assert_eq!(rows[0].local_id.as_deref(), Some("in-1"));
    }

    #[tokio::test]
    async fn runs_for_no_inbound_ids_are_empty() {
        let (_dir, store) = open_temp().await;
        // No device at all: an empty slice must not reach the database.
        let runs = store.list_runs_for_inbound("dev_missing", &[]).await.unwrap();
        assert!(runs.is_empty());
    }

    #[tokio::test]
    async fn composed_sends_queue_once_per_identical_send() {
        let (_dir, store) = open_temp().await;
        let (device, _) = store
            .create_device(NewDevice {
                label: "compose",
                platform: "android",
                platform_id: None,
                carrier: None,
                sim_slot: 1,
            })
            .await
            .unwrap();

        let first = store
            .queue_composed_outbound(&device.device_id, "+15550001111", "hello")
            .await
            .unwrap();
        assert!(first.starts_with("compose-"));
        assert_eq!(first.len(), "compose-".len() + 24);

        let row = store
            .message_by_local_id(&device.device_id, &first)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.direction, "out");
        assert_eq!(row.state, "queued");
        assert_eq!(row.peer, "+15550001111");
        assert_eq!(row.body, "hello");

        // A double tap while the first row is still queued is the same send.
        let second = store
            .queue_composed_outbound(&device.device_id, "+15550001111", "hello")
            .await
            .unwrap();
        assert_eq!(second, first);
        assert_eq!(
            store.list_messages(&device.device_id, 10).await.unwrap().len(),
            1
        );

        // Once the row is finished, the same text is a new send.
        assert!(
            store
                .set_message_state_by_local_id(&device.device_id, &first, "sent")
                .await
                .unwrap()
        );
        let third = store
            .queue_composed_outbound(&device.device_id, "+15550001111", "hello")
            .await
            .unwrap();
        assert_ne!(third, first);
        assert_eq!(
            store.list_messages(&device.device_id, 10).await.unwrap().len(),
            2
        );
    }

    #[tokio::test]
    async fn message_state_updates_by_local_id() {
        let (_dir, store) = open_temp().await;
        let (device, _) = store
            .create_device(NewDevice {
                label: "states",
                platform: "simulator",
                platform_id: None,
                carrier: None,
                sim_slot: 0,
            })
            .await
            .unwrap();

        store
            .record_message(
                &device.device_id,
                "out",
                "+1555",
                "hi",
                "queued",
                Some("native-1-reply-0"),
            )
            .await
            .unwrap();

        assert!(
            store
                .set_message_state_by_local_id(&device.device_id, "native-1-reply-0", "sent")
                .await
                .unwrap()
        );
        let row = store
            .message_by_local_id(&device.device_id, "native-1-reply-0")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.state, "sent");

        // Only the reply lifecycle is allowed; a typo must not reach the table.
        let error = store
            .set_message_state_by_local_id(&device.device_id, "native-1-reply-0", "nonsense")
            .await
            .unwrap_err();
        assert!(matches!(error, StoreError::InvalidState(_)));

        // A stale id is a no-op, not an error: the receiver may race a re-sync.
        assert!(
            !store
                .set_message_state_by_local_id(&device.device_id, "native-missing", "sent")
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn failed_outbound_rows_are_mirrored_like_any_other_state() {
        let (_dir, store) = open_temp().await;
        let (device, _) = store
            .create_device(NewDevice {
                label: "mirror states",
                platform: "simulator",
                platform_id: None,
                carrier: None,
                sim_slot: 0,
            })
            .await
            .unwrap();

        for (local_id, state) in [
            ("reply-0", "queued"),
            ("reply-1", "sent"),
            ("reply-2", "failed"),
            ("reply-3", "delivered"),
        ] {
            store
                .record_message(
                    &device.device_id,
                    "out",
                    "+1555",
                    "hi",
                    state,
                    Some(local_id),
                )
                .await
                .unwrap();
        }

        let pending = store
            .list_unmirrored_outbound(&device.device_id, 10)
            .await
            .unwrap();
        // Inserted in the same millisecond, so the fetch order between equal
        // `created_at` values is not guaranteed; only the set matters here.
        let mut states: Vec<&str> = pending.iter().map(|m| m.state.as_str()).collect();
        states.sort_unstable();
        assert_eq!(states, vec!["delivered", "failed", "queued", "sent"]);

        // Mirroring is what stops a repeat upload of the same state.
        let ids: Vec<String> = pending.iter().map(|m| m.id.clone()).collect();
        store.mark_mirrored(&ids).await.unwrap();
        assert!(
            store
                .list_unmirrored_outbound(&device.device_id, 10)
                .await
                .unwrap()
                .is_empty()
        );

        // A later transition re-opens exactly that row, so the deployment gets
        // an update for the same local id instead of a duplicate.
        assert!(
            store
                .set_message_state_by_local_id(&device.device_id, "reply-2", "queued")
                .await
                .unwrap()
        );
        let reopened = store
            .list_unmirrored_outbound(&device.device_id, 10)
            .await
            .unwrap();
        assert_eq!(reopened.len(), 1);
        assert_eq!(reopened[0].local_id.as_deref(), Some("reply-2"));
        assert_eq!(reopened[0].state, "queued");
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

    fn flow(id: &str, version: i64, body: &str) -> RemoteFlow {
        RemoteFlow {
            id: id.into(),
            version,
            graph: serde_json::json!({
                "nodes": [
                    { "id": "t1", "type": "trigger", "data": { "kind": "incoming" } },
                    { "id": "s1", "type": "send_sms", "data": { "to": "{{sender}}", "body": body } },
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
    async fn flows_persist_and_load_round_trip() {
        let (_dir, store) = open_temp().await;
        assert!(store.load_flows().await.unwrap().is_empty());

        store
            .replace_flows(&[flow("wf_a", 1, "first"), flow("wf_b", 3, "second")])
            .await
            .unwrap();

        let loaded = store.load_flows().await.unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].id, "wf_a");
        assert_eq!(loaded[0].version, 1);
        assert_eq!(loaded[0].graph["nodes"][1]["data"]["body"], "first");
        assert_eq!(loaded[1].id, "wf_b");
        assert_eq!(loaded[1].version, 3);

        // The graph column stores JSON, not a Rust debug string: a real run must
        // parse what was persisted.
        let run = crate::run_flows(&loaded, "native-1", "+15550001111", "anything");
        assert_eq!(run.actions.len(), 2);
    }

    #[tokio::test]
    async fn replacing_flows_removes_vanished_ids_and_stale_versions() {
        let (_dir, store) = open_temp().await;
        store
            .replace_flows(&[flow("wf_keep", 1, "v1"), flow("wf_gone", 1, "gone")])
            .await
            .unwrap();

        // A deleted flow must stop running, and the same id served at a new
        // version replaces the old graph instead of answering twice.
        store
            .replace_flows(&[flow("wf_keep", 2, "v2"), flow("wf_new", 1, "new")])
            .await
            .unwrap();

        let loaded = store.load_flows().await.unwrap();
        let ids: Vec<&str> = loaded.iter().map(|f| f.id.as_str()).collect();
        assert_eq!(ids, vec!["wf_keep", "wf_new"]);
        assert_eq!(loaded[0].version, 2);
        assert_eq!(loaded[0].graph["nodes"][1]["data"]["body"], "v2");

        // An empty fetched set clears the cache rather than reviving old rows.
        store.replace_flows(&[]).await.unwrap();
        assert!(store.load_flows().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn message_paging_uses_the_created_at_and_id_cursor() {
        let (_dir, store) = open_temp().await;
        let (device, _) = store
            .create_device(NewDevice {
                label: "paging",
                platform: "simulator",
                platform_id: None,
                carrier: None,
                sim_slot: 0,
            })
            .await
            .unwrap();

        let mut expected = Vec::new();
        for index in 0..4 {
            let message = store
                .record_message(
                    &device.device_id,
                    "in",
                    "+1555",
                    &format!("body {index}"),
                    "received",
                    Some(&format!("in-{index}")),
                )
                .await
                .unwrap();
            expected.push(message.id);
        }

        // Put all four rows in one millisecond. Only the id tie-breaker keeps
        // the pages stable, so this is the case the cursor exists for.
        {
            let conn = store.db.connect().unwrap();
            conn.execute(
                "UPDATE messages SET created_at = 1000 WHERE device_id = ?",
                params![device.device_id.as_str()],
            )
            .await
            .unwrap();
        }

        let first = store.list_messages(&device.device_id, 2).await.unwrap();
        assert_eq!(first.len(), 2);
        assert_eq!(first[0].created_at, first[1].created_at);
        assert!(first[0].id > first[1].id, "newest first within a tie");

        let cursor = &first[1];
        let second = store
            .list_messages_before(&device.device_id, cursor.created_at, &cursor.id, 2)
            .await
            .unwrap();
        assert_eq!(second.len(), 2);
        assert_eq!(second[0].created_at, second[1].created_at);
        assert!(second[0].id > second[1].id);
        assert!(second[0].id < cursor.id, "strictly older than the cursor");

        let first_ids: Vec<&str> = first.iter().map(|m| m.id.as_str()).collect();
        let second_ids: Vec<&str> = second.iter().map(|m| m.id.as_str()).collect();
        assert!(second_ids.iter().all(|id| !first_ids.contains(id)));

        let mut seen = first_ids.clone();
        seen.extend(second_ids);
        seen.sort_unstable();
        expected.sort_unstable();
        assert_eq!(seen, expected);

        // The final page is empty: the cursor has walked off the end once.
        let last = &second[1];
        assert!(
            store
                .list_messages_before(&device.device_id, last.created_at, &last.id, 2)
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn cached_flows_report_metadata_and_count_nodes() {
        let (_dir, store) = open_temp().await;
        assert!(store.list_cached_flows().await.unwrap().is_empty());

        store
            .replace_flows(&[flow("wf_a", 2, "x"), flow("wf_b", 1, "y")])
            .await
            .unwrap();

        let cached = store.list_cached_flows().await.unwrap();
        assert_eq!(cached.len(), 2);
        assert_eq!(cached[0].id, "wf_a");
        assert_eq!(cached[0].version, 2);
        assert_eq!(cached[0].node_count, Some(3));
        assert!(cached[0].fetched_at > 0);
        assert_eq!(cached[1].id, "wf_b");

        // A corrupt graph must not hide the row or panic the reader.
        {
            let conn = store.db.connect().unwrap();
            conn.execute("UPDATE flows SET graph = 'not json'", ())
                .await
                .unwrap();
        }
        let cached = store.list_cached_flows().await.unwrap();
        assert_eq!(cached.len(), 2);
        assert_eq!(cached[0].node_count, None);
        assert_eq!(cached[1].node_count, None);
    }

    #[tokio::test]
    async fn flow_runs_list_newest_first_and_are_scoped_to_the_device() {
        let (_dir, store) = open_temp().await;
        let (device, _) = store
            .create_device(NewDevice {
                label: "runs",
                platform: "simulator",
                platform_id: None,
                carrier: None,
                sim_slot: 0,
            })
            .await
            .unwrap();

        for (index, outcome) in ["delivered", "masked", "error"].iter().enumerate() {
            store
                .record_run(
                    &device.device_id,
                    &FlowRunReport {
                        local_id: format!("in-{index}"),
                        flow_id: "wf_gate".into(),
                        flow_version: 2,
                        outcome: (*outcome).into(),
                    },
                )
                .await
                .unwrap();
        }

        // record_run stamps every row with the same millisecond, so give them
        // distinct times to prove the ORDER BY rather than insertion order.
        {
            let conn = store.db.connect().unwrap();
            for index in 0..3i64 {
                conn.execute(
                    "UPDATE flow_runs SET created_at = ? WHERE local_id = ?",
                    params![1000 + index, format!("in-{index}")],
                )
                .await
                .unwrap();
            }
        }

        let runs = store.list_flow_runs(&device.device_id, 2).await.unwrap();
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[0].local_id, "in-2");
        assert_eq!(runs[0].created_at, 1002);
        assert_eq!(runs[0].flow_id, "wf_gate");
        assert_eq!(runs[0].flow_version, 2);
        assert_eq!(runs[0].outcome, "error");
        assert_eq!(runs[1].local_id, "in-1");
        assert_eq!(runs[1].outcome, "masked");

        assert!(
            store
                .list_flow_runs("dev_missing", 10)
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn device_facts_reject_unknown_keys_and_long_values() {
        let (_dir, store) = open_temp().await;

        assert_eq!(store.get_device_facts().await.unwrap().self_number, None);
        store
            .set_device_fact("self_number", "+15550001111")
            .await
            .unwrap();
        store.set_device_fact("sim_slot", "1").await.unwrap();
        store
            .set_device_fact(
                "permissions",
                r#"{"sms":true,"send":true,"phone_numbers":false}"#,
            )
            .await
            .unwrap();

        let facts = store.get_device_facts().await.unwrap();
        assert_eq!(facts.self_number.as_deref(), Some("+15550001111"));
        assert_eq!(facts.sim_slot, Some(1));
        assert_eq!(
            facts
                .permissions
                .as_ref()
                .and_then(|p| p["phone_numbers"].as_bool()),
            Some(false)
        );

        // A key outside the whitelist must not touch the settings table: this is
        // the same row the target URL lives in.
        let error = store
            .set_device_fact("base_url", "https://example.invalid")
            .await
            .unwrap_err();
        assert!(matches!(error, StoreError::InvalidFact(_)));
        assert_eq!(store.get_setting("base_url").await.unwrap(), None);

        let long = "x".repeat(MAX_DEVICE_FACT_LEN + 1);
        let error = store
            .set_device_fact("sim_carrier", &long)
            .await
            .unwrap_err();
        assert!(matches!(error, StoreError::InvalidFact(_)));
        assert_eq!(store.get_setting("sim_carrier").await.unwrap(), None);
    }

    async fn outbound(
        store: &Store,
        device_id: &str,
        local_id: &str,
        state: &str,
        created_at: i64,
        attempts: i64,
    ) {
        store
            .record_message(device_id, "out", "+1555", "hi", state, Some(local_id))
            .await
            .unwrap();
        let conn = store.db.connect().unwrap();
        conn.execute(
            "UPDATE messages SET created_at = ?, attempts = ?
              WHERE device_id = ? AND local_id = ?",
            params![created_at, attempts, device_id, local_id],
        )
        .await
        .unwrap();
    }

    async fn row_state(store: &Store, device_id: &str, local_id: &str) -> (String, i64) {
        let conn = store.db.connect().unwrap();
        let mut rows = conn
            .query(
                "SELECT state, attempts FROM messages WHERE device_id = ? AND local_id = ?",
                params![device_id, local_id],
            )
            .await
            .unwrap();
        let row = rows.next().await.unwrap().unwrap();
        (row.get(0).unwrap(), row.get(1).unwrap())
    }

    #[tokio::test]
    async fn delivered_must_follow_sent() {
        let (_dir, store) = open_temp().await;
        let (device, _) = store
            .create_device(NewDevice {
                label: "delivery",
                platform: "android",
                platform_id: None,
                carrier: None,
                sim_slot: 0,
            })
            .await
            .unwrap();

        store
            .record_message(&device.device_id, "out", "+1555", "hi", "queued", Some("r-0"))
            .await
            .unwrap();

        // A delivered mark on a queued row is refused, not coerced.
        let error = store
            .set_message_state_by_local_id(&device.device_id, "r-0", "delivered")
            .await
            .unwrap_err();
        assert!(matches!(error, StoreError::InvalidState(_)));
        assert_eq!(row_state(&store, &device.device_id, "r-0").await.0, "queued");

        assert!(
            store
                .set_message_state_by_local_id(&device.device_id, "r-0", "sent")
                .await
                .unwrap()
        );
        assert!(
            store
                .set_message_state_by_local_id(&device.device_id, "r-0", "delivered")
                .await
                .unwrap()
        );
        assert_eq!(
            row_state(&store, &device.device_id, "r-0").await.0,
            "delivered"
        );

        // A late SENT broadcast must not erase the stronger final state.
        assert!(
            store
                .set_message_state_by_local_id(&device.device_id, "r-0", "sent")
                .await
                .unwrap()
        );
        assert_eq!(
            row_state(&store, &device.device_id, "r-0").await.0,
            "delivered"
        );

        // A failed row cannot be promoted by a direct delivered mark.
        store
            .record_message(&device.device_id, "out", "+1555", "no", "failed", Some("r-1"))
            .await
            .unwrap();
        let error = store
            .set_message_state_by_local_id(&device.device_id, "r-1", "delivered")
            .await
            .unwrap_err();
        assert!(matches!(error, StoreError::InvalidState(_)));

        // The delivery-report path is the one caller allowed to promote a
        // queued row, and it writes sent then delivered in one transaction.
        store
            .record_message(&device.device_id, "out", "+1555", "yes", "queued", Some("r-2"))
            .await
            .unwrap();
        assert!(
            store
                .mark_delivered_by_local_id(&device.device_id, "r-2")
                .await
                .unwrap()
        );
        assert_eq!(
            row_state(&store, &device.device_id, "r-2").await.0,
            "delivered"
        );

        // It still refuses a row the radio marked failed.
        assert!(
            !store
                .mark_delivered_by_local_id(&device.device_id, "r-1")
                .await
                .unwrap()
        );
        assert_eq!(row_state(&store, &device.device_id, "r-1").await.0, "failed");
    }

    #[tokio::test]
    async fn retryable_outbound_respects_attempts_and_age() {
        let (_dir, store) = open_temp().await;
        let (device, _) = store
            .create_device(NewDevice {
                label: "retry",
                platform: "android",
                platform_id: None,
                carrier: None,
                sim_slot: 0,
            })
            .await
            .unwrap();

        let now = now_ms().unwrap();
        let old = now - 120_000;
        outbound(&store, &device.device_id, "young", "queued", now, 0).await;
        outbound(&store, &device.device_id, "fresh", "queued", old, 0).await;
        outbound(&store, &device.device_id, "second", "queued", old + 1_000, 2).await;
        outbound(&store, &device.device_id, "spent", "queued", old, 3).await;
        outbound(&store, &device.device_id, "sent", "sent", old, 0).await;
        outbound(&store, &device.device_id, "failed", "failed", old, 0).await;

        let retryable = store
            .list_retryable_outbound(&device.device_id, now, 10)
            .await
            .unwrap();
        let local_ids: Vec<&str> = retryable
            .iter()
            .filter_map(|message| message.local_id.as_deref())
            .collect();
        assert_eq!(local_ids, vec!["fresh", "second"]);
        assert!(retryable.iter().all(|message| message.state == "queued"));

        // Another device's rows are never eligible for this one.
        assert!(
            store
                .list_retryable_outbound("dev_missing", now, 10)
                .await
                .unwrap()
                .is_empty()
        );
    }

    #[tokio::test]
    async fn transient_failure_requeues_and_permanent_one_fails() {
        let (_dir, store) = open_temp().await;
        let (device, _) = store
            .create_device(NewDevice {
                label: "attempts",
                platform: "android",
                platform_id: None,
                carrier: None,
                sim_slot: 0,
            })
            .await
            .unwrap();

        for local_id in ["t-0", "p-0"] {
            store
                .record_message(
                    &device.device_id,
                    "out",
                    "+1555",
                    "hi",
                    "queued",
                    Some(local_id),
                )
                .await
                .unwrap();
        }

        // Two transient failures leave the row retryable.
        for expected in 1..=2 {
            let outcome = store
                .record_send_failure_by_local_id(&device.device_id, "t-0", true)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(outcome.state, "queued");
            assert_eq!(outcome.attempts, expected);
        }
        assert_eq!(
            row_state(&store, &device.device_id, "t-0").await,
            ("queued".to_string(), 2)
        );

        // The third spends the last attempt and gives up.
        let outcome = store
            .record_send_failure_by_local_id(&device.device_id, "t-0", true)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(outcome.state, "failed");
        assert_eq!(outcome.attempts, 3);
        assert_eq!(
            row_state(&store, &device.device_id, "t-0").await,
            ("failed".to_string(), 3)
        );
        // A fourth report has nothing left to spend.
        assert!(
            store
                .record_send_failure_by_local_id(&device.device_id, "t-0", true)
                .await
                .unwrap()
                .is_none()
        );

        // A permanent refusal fails immediately and spends no budget.
        let outcome = store
            .record_send_failure_by_local_id(&device.device_id, "p-0", false)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(outcome.state, "failed");
        assert_eq!(outcome.attempts, 0);
        assert_eq!(
            row_state(&store, &device.device_id, "p-0").await,
            ("failed".to_string(), 0)
        );

        assert!(
            store
                .record_send_failure_by_local_id(&device.device_id, "missing", true)
                .await
                .unwrap()
                .is_none()
        );
    }
}
