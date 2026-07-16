use aes_gcm::{
    aead::{Aead, Payload},
    Aes256Gcm, KeyInit, Nonce,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use hmac::{Hmac, Mac};
use rand::{rngs::OsRng, RngCore};
use scrypt::{scrypt, Params as ScryptParams};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::Sha256;

pub const VAULT_VERSION: u8 = 1;
pub const SCRYPT_N: u32 = 32_768;
pub const SCRYPT_R: u32 = 8;
pub const SCRYPT_P: u32 = 1;
pub const KEY_BYTES: usize = 32;
pub const NONCE_BYTES: usize = 12;
pub const TAG_BYTES: usize = 16;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VaultObjectDescriptor {
    pub version: u8,
    pub object_type: String,
    pub object_id: String,
    pub revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VaultObjectEnvelope {
    pub version: u8,
    pub object_type: String,
    pub object_id: String,
    pub revision: String,
    pub nonce: String,
    pub ciphertext: String,
}

pub fn validate_descriptor(descriptor: &VaultObjectDescriptor) -> Result<(), String> {
    if descriptor.version != VAULT_VERSION {
        return Err(format!("Unsupported vault version: {}", descriptor.version));
    }
    if !matches!(
        descriptor.object_type.as_str(),
        "item" | "pinboard" | "tombstone" | "index" | "blob"
    ) {
        return Err("Unsupported vault object type".to_string());
    }
    for (label, value) in [
        ("objectId", descriptor.object_id.as_str()),
        ("revision", descriptor.revision.as_str()),
    ] {
        if value.is_empty() || value.contains('\0') {
            return Err(format!("{label} must be a non-empty string without NUL"));
        }
    }
    Ok(())
}

pub fn object_aad(descriptor: &VaultObjectDescriptor) -> Result<Vec<u8>, String> {
    validate_descriptor(descriptor)?;
    Ok(format!(
        "{}\0{}\0{}\0{}",
        descriptor.version, descriptor.object_type, descriptor.object_id, descriptor.revision
    )
    .into_bytes())
}

pub fn object_path(descriptor: &VaultObjectDescriptor) -> Result<String, String> {
    validate_descriptor(descriptor)?;
    for value in [&descriptor.object_id, &descriptor.revision] {
        if matches!(value.as_str(), "." | "..") || value.contains('/') || value.contains('\\') {
            return Err("Vault object path segment is unsafe".to_string());
        }
    }
    Ok(format!(
        "objects/{}/{}/{}.enc",
        descriptor.object_type,
        encode_uri_component(&descriptor.object_id),
        encode_uri_component(&descriptor.revision)
    ))
}

fn encode_uri_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric()
            || matches!(
                *byte,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            )
        {
            encoded.push(char::from(*byte));
        } else {
            encoded.push('%');
            encoded.push_str(&format!("{byte:02X}"));
        }
    }
    encoded
}

fn canonical_value(value: &Value) -> Result<Value, String> {
    match value {
        Value::Null | Value::Bool(_) | Value::String(_) => Ok(value.clone()),
        Value::Number(number) => {
            if number.as_f64().is_some_and(f64::is_finite) {
                Ok(value.clone())
            } else {
                Err("Canonical JSON numbers must be finite".to_string())
            }
        }
        Value::Array(values) => values
            .iter()
            .map(canonical_value)
            .collect::<Result<Vec<_>, _>>()
            .map(Value::Array),
        Value::Object(values) => {
            let mut keys = values.keys().collect::<Vec<_>>();
            keys.sort();
            let mut output = Map::new();
            for key in keys {
                output.insert(key.clone(), canonical_value(&values[key])?);
            }
            Ok(Value::Object(output))
        }
    }
}

pub fn canonical_json(value: &Value) -> Result<String, String> {
    serde_json::to_string(&canonical_value(value)?)
        .map_err(|error| format!("Failed to serialize canonical JSON: {error}"))
}

pub fn derive_vault_key(password: &str, salt: &[u8]) -> Result<[u8; KEY_BYTES], String> {
    if password.is_empty() {
        return Err("Sync password cannot be empty".to_string());
    }
    if salt.len() < 16 {
        return Err("Vault salt must contain at least 16 bytes".to_string());
    }
    let params = ScryptParams::new(15, SCRYPT_R, SCRYPT_P, KEY_BYTES)
        .map_err(|error| format!("Invalid scrypt parameters: {error}"))?;
    let mut key = [0_u8; KEY_BYTES];
    scrypt(password.as_bytes(), salt, &params, &mut key)
        .map_err(|error| format!("Failed to derive vault key: {error}"))?;
    Ok(key)
}

fn encrypt_with_nonce(
    key: &[u8; KEY_BYTES],
    descriptor: &VaultObjectDescriptor,
    value: &Value,
    nonce_bytes: [u8; NONCE_BYTES],
) -> Result<VaultObjectEnvelope, String> {
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|error| format!("Failed to initialize AES-256-GCM: {error}"))?;
    let plaintext = canonical_json(value)?;
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload {
                msg: plaintext.as_bytes(),
                aad: &object_aad(descriptor)?,
            },
        )
        .map_err(|_| "Failed to encrypt vault object".to_string())?;
    Ok(VaultObjectEnvelope {
        version: descriptor.version,
        object_type: descriptor.object_type.clone(),
        object_id: descriptor.object_id.clone(),
        revision: descriptor.revision.clone(),
        nonce: BASE64.encode(nonce_bytes),
        ciphertext: BASE64.encode(ciphertext),
    })
}

pub fn encrypt_object(
    key: &[u8; KEY_BYTES],
    descriptor: &VaultObjectDescriptor,
    value: &Value,
) -> Result<VaultObjectEnvelope, String> {
    let mut nonce = [0_u8; NONCE_BYTES];
    OsRng.fill_bytes(&mut nonce);
    encrypt_with_nonce(key, descriptor, value, nonce)
}

pub fn decrypt_envelope(
    key: &[u8; KEY_BYTES],
    envelope: &VaultObjectEnvelope,
) -> Result<Value, String> {
    let descriptor = VaultObjectDescriptor {
        version: envelope.version,
        object_type: envelope.object_type.clone(),
        object_id: envelope.object_id.clone(),
        revision: envelope.revision.clone(),
    };
    let nonce = BASE64
        .decode(&envelope.nonce)
        .map_err(|_| "Vault nonce is not valid base64".to_string())?;
    if nonce.len() != NONCE_BYTES {
        return Err("Vault nonce must contain 12 bytes".to_string());
    }
    let ciphertext = BASE64
        .decode(&envelope.ciphertext)
        .map_err(|_| "Vault ciphertext is not valid base64".to_string())?;
    if ciphertext.len() < TAG_BYTES {
        return Err("Vault ciphertext is missing its authentication tag".to_string());
    }
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|error| format!("Failed to initialize AES-256-GCM: {error}"))?;
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad: &object_aad(&descriptor)?,
            },
        )
        .map_err(|_| "Vault object authentication failed".to_string())?;
    serde_json::from_slice(&plaintext)
        .map_err(|error| format!("Vault plaintext is not valid JSON: {error}"))
}

pub fn vault_revision(key: &[u8; KEY_BYTES], value: &Value) -> Result<String, String> {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key)
        .map_err(|error| format!("Failed to initialize vault HMAC: {error}"))?;
    mac.update(canonical_json(value)?.as_bytes());
    Ok(format!("r-{}", hex::encode(mac.finalize().into_bytes())))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct CryptoFixture {
        password: String,
        salt_hex: String,
        nonce_hex: String,
        derived_key_hex: String,
        ciphertext_and_tag_hex: String,
        descriptor: VaultObjectDescriptor,
        object: Value,
    }

    fn fixture() -> CryptoFixture {
        serde_json::from_str(include_str!("../tests/fixtures/pasteboard-crypto-v1.json")).unwrap()
    }

    #[test]
    fn matches_the_cross_host_crypto_fixture() {
        let fixture = fixture();
        let salt = hex::decode(&fixture.salt_hex).unwrap();
        let key = derive_vault_key(&fixture.password, &salt).unwrap();
        assert_eq!(hex::encode(key), fixture.derived_key_hex);
        let nonce: [u8; NONCE_BYTES] = hex::decode(&fixture.nonce_hex).unwrap().try_into().unwrap();
        let envelope =
            encrypt_with_nonce(&key, &fixture.descriptor, &fixture.object, nonce).unwrap();
        assert_eq!(
            hex::encode(BASE64.decode(&envelope.ciphertext).unwrap()),
            fixture.ciphertext_and_tag_hex
        );
        assert_eq!(decrypt_envelope(&key, &envelope).unwrap(), fixture.object);
    }

    #[test]
    fn rejects_wrong_keys_and_unsafe_paths() {
        let fixture = fixture();
        let key =
            derive_vault_key(&fixture.password, &hex::decode(&fixture.salt_hex).unwrap()).unwrap();
        let envelope = encrypt_object(&key, &fixture.descriptor, &fixture.object).unwrap();
        assert!(decrypt_envelope(&[9_u8; KEY_BYTES], &envelope).is_err());
        let mut unsafe_descriptor = fixture.descriptor;
        unsafe_descriptor.object_id = "../item".to_string();
        assert!(object_path(&unsafe_descriptor).is_err());
    }
}
