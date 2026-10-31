//! Device identity.
//!
//! A simulated device authenticates exactly like a real one: a P-256 keypair,
//! whose public half is registered at pairing time and whose private half signs
//! the canonical request string (PROTOCOL_CONTRACT_V5 §2/§3).
//!
//! Two identifiers are generated here, and they are deliberately different:
//!
//! * `device_id` — client-chosen, grammar `^[A-Za-z0-9_-]{8,64}$`. This is the
//!   authentication identity: the Worker routes on it and the Durable Object
//!   stores the public key against it.
//! * `platform_id` — the OS-provided hint (`ANDROID_ID`, `IDFV`). It is NOT a
//!   credential: it is readable by anyone with the app's signing key, survives
//!   reinstall but not a factory reset, and can be spoofed on a rooted device.
//!   It exists for support and duplicate detection only.
//!
//! The private half is PKCS#8 PEM in memory and only ever signs from there. At
//! rest the Android build stores it wrapped under a non-exportable
//! AndroidKeyStore key (`keystore:v1:` — see [`crate::keyvault`]); a desktop
//! build keeps the plaintext column, because a developer machine has no
//! Keystore and the simulator's purpose is holding test identities there.

use base64::{Engine as _, engine::general_purpose::STANDARD};
use p256::ecdsa::{SigningKey, VerifyingKey, signature::Signer};
use p256::pkcs8::{DecodePrivateKey, DecodePublicKey, EncodePrivateKey, EncodePublicKey, LineEnding};
use serde::{Deserialize, Serialize};

/// `^[A-Za-z0-9_-]{8,64}$` — the contract's device-id grammar.
pub fn is_valid_device_id(value: &str) -> bool {
    (8..=64).contains(&value.len())
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Identity {
    pub device_id: String,
    /// PKCS#8 PEM. Simulator-only; see the module note.
    pub private_key_pkcs8_pem: String,
    /// DER SubjectPublicKeyInfo, base64 — exactly what the pair endpoint takes.
    pub public_key_spki_b64: String,
}

#[derive(Debug, thiserror::Error)]
pub enum IdentityError {
    #[error("operating system randomness unavailable: {0}")]
    Random(String),
    #[error("key encoding failed: {0}")]
    Encoding(String),
    #[error("signing failed: {0}")]
    Signing(String),
}

/// Generate a fresh device identity.
///
/// `device_id` is `dev` + 16 hex characters (19 total), matching the harness and
/// the contract grammar. The scalar is drawn until it is a valid P-256 key; the
/// failure probability is negligible, but retrying keeps the function total.
pub fn generate_identity() -> Result<Identity, IdentityError> {
    let (private_key_pkcs8_pem, public_key_spki_b64) = generate_keypair()?;
    Ok(Identity {
        device_id: generate_device_id()?,
        private_key_pkcs8_pem,
        public_key_spki_b64,
    })
}

fn generate_keypair() -> Result<(String, String), IdentityError> {
    loop {
        let mut scalar = [0u8; 32];
        getrandom::fill(&mut scalar).map_err(|e| IdentityError::Random(e.to_string()))?;
        let Ok(signing_key) = SigningKey::from_slice(&scalar) else {
            continue;
        };

        let pem = signing_key
            .to_pkcs8_pem(LineEnding::LF)
            .map_err(|e| IdentityError::Encoding(e.to_string()))?;
        let spki = signing_key
            .verifying_key()
            .to_public_key_der()
            .map_err(|e| IdentityError::Encoding(e.to_string()))?;

        return Ok((pem.to_string(), STANDARD.encode(spki.as_bytes())));
    }
}

fn generate_device_id() -> Result<String, IdentityError> {
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes).map_err(|e| IdentityError::Random(e.to_string()))?;
    let mut id = String::from("dev");
    for byte in bytes {
        id.push_str(&format!("{byte:02x}"));
    }
    Ok(id)
}

/// The base64 DER SubjectPublicKeyInfo for a PKCS#8 private key.
///
/// This is the proof the vault's migration publishes before it overwrites a
/// plaintext key: unwrapping the blob must yield a key whose public half is
/// byte-for-byte the SPKI already registered with the Worker.
pub fn public_key_spki_b64(private_key_pkcs8_pem: &str) -> Result<String, IdentityError> {
    let signing_key = SigningKey::from_pkcs8_pem(private_key_pkcs8_pem)
        .map_err(|e| IdentityError::Encoding(e.to_string()))?;
    let spki = signing_key
        .verifying_key()
        .to_public_key_der()
        .map_err(|e| IdentityError::Encoding(e.to_string()))?;
    Ok(STANDARD.encode(spki.as_bytes()))
}

/// Sign a canonical request string, returning the base64 IEEE-P1363 signature.
///
/// P1363 (`r || s`, 64 bytes) is what WebCrypto and the Worker expect; this is
/// NOT the ASN.1 DER form that `openssl dgst` prints.
pub fn sign_p1363(private_key_pkcs8_pem: &str, canonical: &str) -> Result<String, IdentityError> {
    let signing_key = SigningKey::from_pkcs8_pem(private_key_pkcs8_pem)
        .map_err(|e| IdentityError::Encoding(e.to_string()))?;
    let signature: p256::ecdsa::Signature = signing_key.sign(canonical.as_bytes());
    Ok(STANDARD.encode(signature.to_bytes()))
}

/// Verify a P1363 signature against a base64 SPKI — used by the core's own tests
/// so a generated identity is proven usable, not just well-formed.
pub fn verify_p1363(
    public_key_spki_b64: &str,
    canonical: &str,
    signature_b64: &str,
) -> Result<bool, IdentityError> {
    use p256::ecdsa::signature::Verifier;

    let der = STANDARD
        .decode(public_key_spki_b64)
        .map_err(|e| IdentityError::Encoding(e.to_string()))?;
    let verifying_key = VerifyingKey::from_public_key_der(&der)
        .map_err(|e| IdentityError::Encoding(e.to_string()))?;
    let raw = STANDARD
        .decode(signature_b64)
        .map_err(|e| IdentityError::Encoding(e.to_string()))?;
    let signature = p256::ecdsa::Signature::from_slice(&raw)
        .map_err(|e| IdentityError::Signing(e.to_string()))?;
    Ok(verifying_key.verify(canonical.as_bytes(), &signature).is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_id_matches_the_contract_grammar() {
        let id = generate_identity().unwrap();
        assert!(is_valid_device_id(&id.device_id), "{}", id.device_id);
        assert!(id.device_id.starts_with("dev"));
        assert_eq!(id.device_id.len(), 19);
    }

    #[test]
    fn public_key_is_a_usable_p256_spki() {
        let id = generate_identity().unwrap();
        let der = STANDARD.decode(&id.public_key_spki_b64).unwrap();
        let key = VerifyingKey::from_public_key_der(&der).unwrap();
        assert_eq!(key.to_sec1_point(true).as_bytes().len(), 33);
    }

    #[test]
    fn signatures_are_p1363_and_verify() {
        let id = generate_identity().unwrap();
        let canonical = "POST\n/v1/sms/outgoing/poll\n1776470400000\na3f1c0d29b7e4f8a1c6d5e2b9f0a7c34\nabcdef";
        let signature = sign_p1363(&id.private_key_pkcs8_pem, canonical).unwrap();

        let raw = STANDARD.decode(&signature).unwrap();
        assert_eq!(raw.len(), 64, "must be raw r||s, not DER");

        assert!(verify_p1363(&id.public_key_spki_b64, canonical, &signature).unwrap());
        assert!(!verify_p1363(&id.public_key_spki_b64, "tampered", &signature).unwrap());
    }

    #[test]
    fn public_key_spki_can_be_derived_from_the_private_half() {
        let id = generate_identity().unwrap();
        // The vault's migration publishes this before it overwrites a key.
        assert_eq!(
            public_key_spki_b64(&id.private_key_pkcs8_pem).unwrap(),
            id.public_key_spki_b64
        );
    }

    #[test]
    fn two_identities_never_collide() {
        let a = generate_identity().unwrap();
        let b = generate_identity().unwrap();
        assert_ne!(a.device_id, b.device_id);
        assert_ne!(a.public_key_spki_b64, b.public_key_spki_b64);
    }

    #[test]
    fn grammar_rejects_bad_ids() {
        assert!(is_valid_device_id("dev12345678"));
        assert!(is_valid_device_id("A_b-9xxxx"));
        assert!(!is_valid_device_id("short"));
        assert!(!is_valid_device_id("has space"));
        assert!(!is_valid_device_id("bad/slash"));
    }
}
