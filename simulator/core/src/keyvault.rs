//! At-rest protection for the device identity key.
//!
//! A paired device's P-256 private key used to sit in `devices.private_key_pkcs8`
//! as plaintext PKCS#8 PEM. Anyone who could read the database file — a root
//! shell, a backup, a stolen handset — held the key that signs every request.
//!
//! This module defines the replacement: the column holds only
//!
//! ```text
//! keystore:v1:<base64 iv>:<base64 ciphertext>
//! ```
//!
//! where the ciphertext is AES-256-GCM over the original PEM (16-byte tag
//! appended by GCM) and the wrapping key is a non-exportable AndroidKeyStore
//! key. The crypto itself is the platform's: [`KeyCipher`] is implemented in
//! the Android shell (`KeyVault.kt`), because the key must never leave the
//! Keystore. The core owns the framing and the migration rules, so the format,
//! the round-trip check and the fail-closed behaviour are testable here.
//!
//! Desktop builds keep the plaintext column: the simulator's purpose is holding
//! test identities on a developer machine. Only the phone has a Keystore to
//! wrap into, and only the phone is in scope for invariant 1.

use base64::{Engine as _, engine::general_purpose::STANDARD};

/// The only format this build writes. A value that starts with this prefix is
/// never parsed as a PEM and never signed with without an unwrap.
pub const KEYSTORE_PREFIX: &str = "keystore:v1:";

/// The one sentence every locked-key path reports. Invariant 4: fail closed,
/// plainly, and never send an unsigned request.
pub const UNLOCK_ERROR: &str = "The device key cannot be unlocked on this phone";

/// GCM's standard IV length. `KeyVault` asks AndroidKeyStore for a random IV on
/// every wrap, so a re-wrap of the same PEM never reuses one.
pub const IV_BYTES: usize = 12;

/// AES-GCM's authentication tag. A ciphertext shorter than this cannot be a
/// valid v1 blob.
pub const TAG_BYTES: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum KeyVaultError {
    /// No wrapping key: the Keystore entry is gone, the platform refused, or the
    /// bridge was never installed.
    #[error("{UNLOCK_ERROR}")]
    Unavailable,
    /// The blob did not authenticate: it was tampered with, truncated, or it was
    /// wrapped by a different (now missing) key.
    #[error("{UNLOCK_ERROR}")]
    Invalid,
}

/// AES-256-GCM with a key the caller cannot export.
///
/// Implemented by the Android shell over `AndroidKeyStore`. Tests use a stub;
/// the real authentication tag is produced and verified by the platform's
/// `Cipher`, never by Rust.
pub trait KeyCipher: Send + Sync {
    /// Encrypt `plaintext`, returning `(iv, ciphertext || tag)` — both standard
    /// base64 with padding, exactly what the JNI bridge receives from Kotlin.
    fn encrypt(&self, plaintext: &str) -> Result<(String, String), KeyVaultError>;

    /// Decrypt and authenticate one blob's halves. Implementations must reject
    /// a ciphertext whose tag does not verify.
    fn decrypt(&self, iv_b64: &str, ciphertext_b64: &str) -> Result<String, KeyVaultError>;
}

/// One parsed `keystore:v1:` blob. The halves stay base64 because they go
/// straight back to the platform cipher.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WrappedKey<'a> {
    pub iv_b64: &'a str,
    pub ciphertext_b64: &'a str,
}

/// Whether a stored column value is a wrapped blob rather than legacy PEM.
pub fn is_wrapped(stored: &str) -> bool {
    stored.starts_with(KEYSTORE_PREFIX)
}

/// Parse and validate a v1 blob.
///
/// Strict on purpose: a wrong version, a missing field, an extra field, invalid
/// base64, a non-12-byte IV or a ciphertext too short to carry a tag is
/// [`KeyVaultError::Invalid`]. Nothing here ever falls back to treating the
/// value as PEM.
pub fn parse(stored: &str) -> Result<WrappedKey<'_>, KeyVaultError> {
    let rest = stored
        .strip_prefix(KEYSTORE_PREFIX)
        .ok_or(KeyVaultError::Invalid)?;

    let (iv_b64, ciphertext_b64) = rest.split_once(':').ok_or(KeyVaultError::Invalid)?;
    // Exactly two fields: a colon inside either half means a different format.
    if ciphertext_b64.contains(':') || iv_b64.is_empty() || ciphertext_b64.is_empty() {
        return Err(KeyVaultError::Invalid);
    }

    let iv = STANDARD.decode(iv_b64).map_err(|_| KeyVaultError::Invalid)?;
    let ciphertext = STANDARD
        .decode(ciphertext_b64)
        .map_err(|_| KeyVaultError::Invalid)?;
    if iv.len() != IV_BYTES || ciphertext.len() <= TAG_BYTES {
        return Err(KeyVaultError::Invalid);
    }

    Ok(WrappedKey {
        iv_b64,
        ciphertext_b64,
    })
}

/// Wrap one PKCS#8 PEM into the stored format.
pub fn wrap(cipher: &dyn KeyCipher, plaintext: &str) -> Result<String, KeyVaultError> {
    let (iv_b64, ciphertext_b64) = cipher.encrypt(plaintext)?;
    let blob = format!("{KEYSTORE_PREFIX}{iv_b64}:{ciphertext_b64}");
    // Reject a cipher implementation that produced something this build would
    // not be able to read back.
    parse(&blob)?;
    Ok(blob)
}

/// Unwrap one stored blob, authenticating it through the platform cipher.
pub fn unwrap(cipher: &dyn KeyCipher, stored: &str) -> Result<String, KeyVaultError> {
    let blob = parse(stored)?;
    cipher.decrypt(blob.iv_b64, blob.ciphertext_b64)
}

#[cfg(test)]
pub(crate) mod testing {
    use super::*;

    /// Test double for the Keystore cipher. It is deliberately *not* AES: it
    /// proves the framing and the migration/fail-closed sequencing, while the
    /// real authentication tag is the platform `Cipher`'s. It does carry a tag
    /// of its own so a tampered blob is refused, which is the behaviour every
    /// caller depends on.
    pub struct StubCipher {
        key: u8,
    }

    impl StubCipher {
        pub fn new(key: u8) -> Self {
            Self { key }
        }

        fn tag(&self, iv: &[u8], body: &[u8]) -> [u8; TAG_BYTES] {
            let mut sum = self.key;
            for byte in iv.iter().chain(body.iter()) {
                sum = sum.wrapping_mul(31).wrapping_add(*byte);
            }
            [sum; TAG_BYTES]
        }
    }

    impl KeyCipher for StubCipher {
        fn encrypt(&self, plaintext: &str) -> Result<(String, String), KeyVaultError> {
            let iv = vec![0x2Au8; IV_BYTES];
            let mut body: Vec<u8> = plaintext.bytes().map(|b| b ^ self.key).collect();
            let tag = self.tag(&iv, &body);
            body.extend_from_slice(&tag);
            Ok((STANDARD.encode(&iv), STANDARD.encode(&body)))
        }

        fn decrypt(&self, iv_b64: &str, ciphertext_b64: &str) -> Result<String, KeyVaultError> {
            let iv = STANDARD.decode(iv_b64).map_err(|_| KeyVaultError::Invalid)?;
            let raw = STANDARD
                .decode(ciphertext_b64)
                .map_err(|_| KeyVaultError::Invalid)?;
            let split = raw
                .len()
                .checked_sub(TAG_BYTES)
                .ok_or(KeyVaultError::Invalid)?;
            let (body, tag) = raw.split_at(split);
            if tag != self.tag(&iv, body) {
                return Err(KeyVaultError::Invalid);
            }
            let bytes: Vec<u8> = body.iter().map(|b| b ^ self.key).collect();
            String::from_utf8(bytes).map_err(|_| KeyVaultError::Invalid)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testing::StubCipher;
    use super::*;

    #[test]
    fn blob_is_versioned_base64_and_round_trips() {
        let cipher = StubCipher::new(0x5A);
        let blob = wrap(&cipher, "-----BEGIN PRIVATE KEY-----\nsecret\n").unwrap();

        assert!(blob.starts_with("keystore:v1:"));
        assert!(is_wrapped(&blob));
        assert!(!blob.contains("BEGIN PRIVATE KEY"), "no PEM in the blob");

        let parsed = parse(&blob).unwrap();
        let iv = STANDARD.decode(parsed.iv_b64).unwrap();
        assert_eq!(iv.len(), IV_BYTES);
        let ciphertext = STANDARD.decode(parsed.ciphertext_b64).unwrap();
        assert!(ciphertext.len() > TAG_BYTES);

        assert_eq!(
            unwrap(&cipher, &blob).unwrap(),
            "-----BEGIN PRIVATE KEY-----\nsecret\n"
        );
    }

    #[test]
    fn a_blob_is_exactly_four_colon_separated_fields() {
        let cipher = StubCipher::new(0x11);
        let blob = wrap(&cipher, "same key").unwrap();
        let fields: Vec<&str> = blob.split(':').collect();
        assert_eq!(fields, vec!["keystore", "v1", fields[2], fields[3]]);
        assert_eq!(fields.len(), 4);
        assert!(parse(&blob).is_ok());
    }

    #[test]
    fn parse_refuses_anything_that_is_not_a_v1_blob() {
        for bad in [
            "",
            "-----BEGIN PRIVATE KEY-----\nMIGT...\n-----END PRIVATE KEY-----\n",
            "keystore:v2:AAAAAAAAAAAAAAAA:AAAA",
            "keystore:v1:only-one-field",
            "keystore:v1:AAAAAAAAAAAAAAAA:AAAA:BBBB",
            "keystore:v1::AAAA",
            "keystore:v1:not base64:AAAA",
            // Valid base64, wrong IV length.
            "keystore:v1:AAAA:AAAAAAAAAAAAAAAAAAAAAA==",
            // Valid 12-byte IV, ciphertext with no room for a tag.
            "keystore:v1:AAAAAAAAAAAAAAAA:AAAAAA==",
        ] {
            assert!(parse(bad).is_err(), "accepted {bad:?}");
        }
    }

    #[test]
    fn a_tampered_ciphertext_is_refused() {
        let cipher = StubCipher::new(0x42);
        let blob = wrap(&cipher, "device key").unwrap();
        let parsed = parse(&blob).unwrap();

        let mut ciphertext = STANDARD.decode(parsed.ciphertext_b64).unwrap();
        ciphertext[0] ^= 0x01;
        let tampered = format!(
            "keystore:v1:{}:{}",
            parsed.iv_b64,
            STANDARD.encode(&ciphertext)
        );

        assert_eq!(unwrap(&cipher, &tampered), Err(KeyVaultError::Invalid));
    }

    #[test]
    fn a_blob_from_another_wrapping_key_is_refused() {
        let blob = wrap(&StubCipher::new(0x01), "device key").unwrap();
        assert_eq!(
            unwrap(&StubCipher::new(0x02), &blob),
            Err(KeyVaultError::Invalid)
        );
    }

    #[test]
    fn the_error_text_is_the_sentence_the_phone_shows() {
        assert_eq!(
            KeyVaultError::Unavailable.to_string(),
            "The device key cannot be unlocked on this phone"
        );
        assert_eq!(
            KeyVaultError::Invalid.to_string(),
            "The device key cannot be unlocked on this phone"
        );
    }
}
