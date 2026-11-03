use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use rand::{rngs::OsRng, RngCore};
use zeroize::Zeroizing;

const MAGIC: &[u8; 5] = b"ATSS\x01";
const NONCE_BYTES: usize = 12;
const TAG_BYTES: usize = 16;

pub(super) fn new_key() -> Zeroizing<[u8; 32]> {
    let mut key = Zeroizing::new([0u8; 32]);
    OsRng.fill_bytes(key.as_mut());
    key
}

pub(super) fn encrypt(key: &[u8; 32], plugin: &str, text: &str) -> Result<String, String> {
    if text.len() > super::registry::MAX_TEXT_BYTES {
        return Err("INPUT_TOO_LARGE".into());
    }
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| "CRYPTO_UNAVAILABLE")?;
    let mut nonce = [0u8; NONCE_BYTES];
    OsRng.fill_bytes(&mut nonce);
    let associated_data = aad(plugin);
    let sealed = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: text.as_bytes(),
                aad: &associated_data,
            },
        )
        .map_err(|_| "ENCRYPT_FAILED")?;
    let mut bytes = Vec::with_capacity(MAGIC.len() + NONCE_BYTES + sealed.len());
    bytes.extend_from_slice(MAGIC);
    bytes.extend_from_slice(&nonce);
    bytes.extend_from_slice(&sealed);
    if bytes.len() > super::registry::MAX_CIPHER_BYTES {
        return Err("CIPHERTEXT_TOO_LARGE".into());
    }
    Ok(STANDARD.encode(bytes))
}

pub(super) fn decrypt(key: &[u8; 32], plugin: &str, encoded: &str) -> Result<String, String> {
    if encoded.len() > super::registry::MAX_WIRE_BYTES {
        return Err("CIPHERTEXT_TOO_LARGE".into());
    }
    let bytes = STANDARD.decode(encoded).map_err(|_| "INVALID_CIPHERTEXT")?;
    if bytes.len() > super::registry::MAX_CIPHER_BYTES
        || bytes.len() < MAGIC.len() + NONCE_BYTES + TAG_BYTES
        || &bytes[..MAGIC.len()] != MAGIC
    {
        return Err("UNSUPPORTED_CIPHERTEXT".into());
    }
    let nonce = &bytes[MAGIC.len()..MAGIC.len() + NONCE_BYTES];
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| "CRYPTO_UNAVAILABLE")?;
    let associated_data = aad(plugin);
    let clear = Zeroizing::new(
        cipher
            .decrypt(
                Nonce::from_slice(nonce),
                Payload {
                    msg: &bytes[MAGIC.len() + NONCE_BYTES..],
                    aad: &associated_data,
                },
            )
            .map_err(|_| "DECRYPT_FAILED")?,
    );
    if clear.len() > super::registry::MAX_TEXT_BYTES {
        return Err("PLAINTEXT_TOO_LARGE".into());
    }
    String::from_utf8(clear.to_vec()).map_err(|_| "INVALID_PLAINTEXT".into())
}

fn aad(plugin: &str) -> Vec<u8> {
    format!("ATools.safeStorage.v1\0{plugin}").into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugin_secret_storage_runtime::registry::MAX_TEXT_BYTES;

    #[test]
    fn empty_unicode_and_exact_byte_limit_round_trip() {
        let key = new_key();
        let boundary = "x".repeat(MAX_TEXT_BYTES);
        for value in ["", "密钥配置\n🙂", boundary.as_str()] {
            let encoded = encrypt(&key, "fixture-a", value).unwrap();
            assert_eq!(decrypt(&key, "fixture-a", &encoded).unwrap(), value);
        }
        assert_eq!(
            encrypt(&key, "fixture-a", &"x".repeat(MAX_TEXT_BYTES + 1)).unwrap_err(),
            "INPUT_TOO_LARGE"
        );
        assert_eq!(
            decrypt(
                &key,
                "fixture-a",
                &STANDARD.encode(b"legacy electron base64")
            )
            .unwrap_err(),
            "UNSUPPORTED_CIPHERTEXT"
        );
    }

    #[test]
    fn encrypt_uses_fresh_nonce_and_authenticates_plugin_identity() {
        let key = new_key();
        let first = encrypt(&key, "fixture-a", "secret").unwrap();
        let second = encrypt(&key, "fixture-a", "secret").unwrap();
        assert_ne!(first, second);
        assert_eq!(decrypt(&key, "fixture-a", &first).unwrap(), "secret");
        assert_eq!(decrypt(&key, "fixture-a", &second).unwrap(), "secret");
        assert_eq!(
            decrypt(&key, "fixture-b", &first).unwrap_err(),
            "DECRYPT_FAILED"
        );
    }

    #[test]
    fn tampered_truncated_and_oversized_ciphertext_is_rejected() {
        let key = new_key();
        let encoded = encrypt(&key, "fixture-a", "secret").unwrap();
        let mut bytes = STANDARD.decode(encoded).unwrap();
        *bytes.last_mut().unwrap() ^= 1;
        assert_eq!(
            decrypt(&key, "fixture-a", &STANDARD.encode(bytes)).unwrap_err(),
            "DECRYPT_FAILED"
        );
        assert_eq!(
            decrypt(&key, "fixture-a", &STANDARD.encode(b"ATSS\x01short")).unwrap_err(),
            "UNSUPPORTED_CIPHERTEXT"
        );
        assert_eq!(
            decrypt(
                &key,
                "fixture-a",
                &"a".repeat(super::super::registry::MAX_WIRE_BYTES + 1)
            )
            .unwrap_err(),
            "CIPHERTEXT_TOO_LARGE"
        );
    }
}
