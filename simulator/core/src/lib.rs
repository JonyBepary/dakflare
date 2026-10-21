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

pub use carrier::{CarrierError, Injected, drain_outbox, inject_inbound};
pub use db::{Device, Message, NewDevice, Store, StoreError};
pub use flowrun::{FlowRunReport, LocalRun, RemoteFlow, run_flows};
pub use identity::{
    Identity, IdentityError, generate_identity, is_valid_device_id, sign_p1363, verify_p1363,
};
pub use protocol::{
    DeviceClient, InboundMessage, ProtocolError, SignedHeaders, Target, canonical_string,
    sign_request,
};
