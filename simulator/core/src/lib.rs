//! Core for the DakFlare device simulator.
//!
//! Deliberately free of Tauri: identity, the local store and (next) the protocol
//! client must compile and test without a desktop shell, and they must be usable
//! from the Android build later.

pub mod db;
pub mod identity;

pub use db::{Device, NewDevice, Store, StoreError};
pub use identity::{
    Identity, IdentityError, generate_identity, is_valid_device_id, sign_p1363, verify_p1363,
};
