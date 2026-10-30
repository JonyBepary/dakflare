//! Core for the DakFlare device simulator.
//!
//! Deliberately free of Tauri: identity, the local store and (next) the protocol
//! client must compile and test without a desktop shell, and they must be usable
//! from the Android build later.

pub mod carrier;
pub mod compose;
pub mod db;
pub mod flowrun;
pub mod identity;
pub mod keyvault;
pub mod protocol;

pub use carrier::{
    CarrierError, Flushed, Injected, drain_outbox, flush_pending, inject_inbound,
    report_command_state,
    receive_and_reply, receive_offline, reply_local_id, sync_flows,
};
pub use compose::{
    ComposeProblem, MAX_COMPOSE_BODY_CHARS, MAX_RECIPIENT_DIGITS, MIN_RECIPIENT_DIGITS, body_chars,
    check_body, check_recipient, check_send,
};
pub use dakflare_flow::Action;
pub use db::{
    CachedFlow, DEVICE_FACT_KEYS, Device, DeviceFacts, FlowRunRow, MAX_DEVICE_FACT_LEN,
    MAX_SEARCH_HITS, MIN_SEARCH_CHARS, Message, NewDevice, RETENTION_CHECK_INTERVAL_MS,
    RETENTION_LAST_DELETED, RETENTION_LAST_PURGE, RETENTION_SETTING, Retention, RetentionStatus,
    SearchHits, SendFailureOutcome, Store, StoreError, is_device_fact_key,
};
pub use flowrun::{FlowRunReport, LocalRun, RemoteFlow, run_flows};
pub use identity::{
    Identity, IdentityError, generate_identity, is_valid_device_id, public_key_spki_b64,
    sign_p1363, verify_p1363,
};
pub use keyvault::{KEYSTORE_PREFIX, KeyCipher, KeyVaultError, UNLOCK_ERROR};
pub use protocol::{
    DeviceClient, InboundMessage, PairLink, PairLinkError, PairRequest, ProtocolError,
    SignedHeaders, Target, canonical_string, parse_pair_link, sign_request,
};
