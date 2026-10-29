//! Core for the DakFlare device simulator.
//!
//! Deliberately free of Tauri: identity, the local store and (next) the protocol
//! client must compile and test without a desktop shell, and they must be usable
//! from the Android build later.

pub mod carrier;
pub mod db;
pub mod flowrun;
pub mod identity;
pub mod protocol;

pub use carrier::{
    CarrierError, Flushed, Injected, drain_outbox, flush_pending, inject_inbound,
    receive_and_reply, receive_offline, reply_local_id,
};
pub use dakflare_flow::Action;
pub use db::{
    CachedFlow, DEVICE_FACT_KEYS, Device, DeviceFacts, FlowRunRow, MAX_DEVICE_FACT_LEN, Message,
    NewDevice, Store, StoreError, is_device_fact_key,
};
pub use flowrun::{FlowRunReport, LocalRun, RemoteFlow, run_flows};
pub use identity::{
    Identity, IdentityError, generate_identity, is_valid_device_id, sign_p1363, verify_p1363,
};
pub use protocol::{
    DeviceClient, InboundMessage, PairLink, PairLinkError, PairRequest, ProtocolError,
    SignedHeaders, Target, canonical_string, parse_pair_link, sign_request,
};
