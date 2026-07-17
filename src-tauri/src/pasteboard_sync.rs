use aes_gcm::{
    aead::{Aead, Payload},
    Aes256Gcm, KeyInit, Nonce,
};
use async_trait::async_trait;
use atools_core::{
    Database, HybridLogicalClock, PasteboardBlob, PasteboardEntityType, PasteboardItem,
    PasteboardTombstone, Pinboard,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use hmac::{Hmac, Mac};
use rand::{rngs::OsRng, RngCore};
use scrypt::{scrypt, Params as ScryptParams};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::time::Duration;

pub const VAULT_VERSION: u8 = 1;
pub const SCRYPT_N: u32 = 32_768;
pub const SCRYPT_R: u32 = 8;
pub const SCRYPT_P: u32 = 1;
pub const KEY_BYTES: usize = 32;
pub const NONCE_BYTES: usize = 12;
pub const TAG_BYTES: usize = 16;
pub const MAX_BLOB_PLAINTEXT_BYTES: usize = 100 * 1024 * 1024;
pub const MAX_BLOB_ENVELOPE_BYTES: usize = 140 * 1024 * 1024;
pub const MAX_WEBDAV_RESPONSE_BYTES: usize = MAX_BLOB_ENVELOPE_BYTES + 1024 * 1024;
pub const MAX_INDEX_CONFLICT_RETRIES: usize = 3;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct VaultObjectDescriptor {
    pub version: u8,
    pub object_type: String,
    pub object_id: String,
    pub revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct VaultObjectEnvelope {
    pub version: u8,
    pub object_type: String,
    pub object_id: String,
    pub revision: String,
    pub nonce: String,
    pub ciphertext: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct VaultKdfMetadata {
    pub name: String,
    pub salt: String,
    #[serde(rename = "N")]
    pub n: u32,
    pub r: u32,
    pub p: u32,
    pub key_length: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
#[serde(rename_all = "camelCase")]
pub struct VaultCipherMetadata {
    pub name: String,
    pub nonce_length: usize,
    pub tag_length: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct VaultMetadata {
    pub version: u8,
    pub kdf: VaultKdfMetadata,
    pub cipher: VaultCipherMetadata,
}

impl VaultMetadata {
    pub fn new(salt: &[u8]) -> Result<Self, String> {
        if salt.len() < 16 {
            return Err("Vault salt must contain at least 16 bytes".to_string());
        }
        Ok(Self {
            version: VAULT_VERSION,
            kdf: VaultKdfMetadata {
                name: "scrypt".to_string(),
                salt: BASE64.encode(salt),
                n: SCRYPT_N,
                r: SCRYPT_R,
                p: SCRYPT_P,
                key_length: KEY_BYTES,
            },
            cipher: VaultCipherMetadata {
                name: "AES-256-GCM".to_string(),
                nonce_length: NONCE_BYTES,
                tag_length: TAG_BYTES,
            },
        })
    }

    pub fn validate(&self) -> Result<Vec<u8>, String> {
        if self.version != VAULT_VERSION {
            return Err(format!(
                "Unsupported vault metadata version: {}",
                self.version
            ));
        }
        if self.kdf.name != "scrypt"
            || self.kdf.n != SCRYPT_N
            || self.kdf.r != SCRYPT_R
            || self.kdf.p != SCRYPT_P
            || self.kdf.key_length != KEY_BYTES
        {
            return Err("Unsupported vault KDF parameters".to_string());
        }
        if self.cipher.name != "AES-256-GCM"
            || self.cipher.nonce_length != NONCE_BYTES
            || self.cipher.tag_length != TAG_BYTES
        {
            return Err("Unsupported vault cipher parameters".to_string());
        }
        let salt = BASE64
            .decode(&self.kdf.salt)
            .map_err(|_| "Vault salt is not valid base64".to_string())?;
        if salt.len() < 16 {
            return Err("Vault salt must contain at least 16 bytes".to_string());
        }
        Ok(salt)
    }
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
    encrypt_bytes_with_nonce(
        key,
        descriptor,
        canonical_json(value)?.as_bytes(),
        nonce_bytes,
    )
}

fn encrypt_bytes_with_nonce(
    key: &[u8; KEY_BYTES],
    descriptor: &VaultObjectDescriptor,
    plaintext: &[u8],
    nonce_bytes: [u8; NONCE_BYTES],
) -> Result<VaultObjectEnvelope, String> {
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|error| format!("Failed to initialize AES-256-GCM: {error}"))?;
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload {
                msg: plaintext,
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

pub fn encrypt_bytes(
    key: &[u8; KEY_BYTES],
    descriptor: &VaultObjectDescriptor,
    plaintext: &[u8],
) -> Result<VaultObjectEnvelope, String> {
    let mut nonce = [0_u8; NONCE_BYTES];
    OsRng.fill_bytes(&mut nonce);
    encrypt_bytes_with_nonce(key, descriptor, plaintext, nonce)
}

pub fn decrypt_envelope(
    key: &[u8; KEY_BYTES],
    envelope: &VaultObjectEnvelope,
) -> Result<Value, String> {
    let plaintext = decrypt_envelope_bytes(key, envelope)?;
    serde_json::from_slice(&plaintext)
        .map_err(|error| format!("Vault plaintext is not valid JSON: {error}"))
}

pub fn decrypt_envelope_bytes(
    key: &[u8; KEY_BYTES],
    envelope: &VaultObjectEnvelope,
) -> Result<Vec<u8>, String> {
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
    cipher
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad: &object_aad(&descriptor)?,
            },
        )
        .map_err(|_| "Vault object authentication failed".to_string())
}

pub fn vault_revision(key: &[u8; KEY_BYTES], value: &Value) -> Result<String, String> {
    vault_bytes_revision(key, canonical_json(value)?.as_bytes())
}

pub fn vault_bytes_revision(key: &[u8; KEY_BYTES], value: &[u8]) -> Result<String, String> {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key)
        .map_err(|error| format!("Failed to initialize vault HMAC: {error}"))?;
    mac.update(value);
    Ok(format!("r-{}", hex::encode(mac.finalize().into_bytes())))
}

#[derive(Clone)]
pub struct PasteboardWebDavConfig {
    pub vault_url: String,
    pub username: String,
    pub password: String,
    pub proxy_url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PasteboardWebDavRequest {
    pub method: String,
    pub path: String,
    pub headers: BTreeMap<String, String>,
    pub body: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PasteboardWebDavResponse {
    pub status: u16,
    pub etag: Option<String>,
    pub body: Vec<u8>,
}

#[async_trait]
pub trait PasteboardWebDavTransport: Send + Sync {
    async fn request(
        &self,
        request: PasteboardWebDavRequest,
    ) -> Result<PasteboardWebDavResponse, String>;
}

pub struct ReqwestPasteboardWebDavTransport {
    client: reqwest::Client,
    base_url: reqwest::Url,
    username: String,
    password: String,
}

impl ReqwestPasteboardWebDavTransport {
    pub fn new(config: PasteboardWebDavConfig) -> Result<Self, String> {
        let mut base_url = reqwest::Url::parse(config.vault_url.trim())
            .map_err(|error| format!("Invalid PasteboardPro WebDAV URL: {error}"))?;
        if base_url.scheme() != "https" {
            return Err("PasteboardPro WebDAV URL must use HTTPS".to_string());
        }
        if !base_url.username().is_empty() || base_url.password().is_some() {
            return Err("PasteboardPro WebDAV URL cannot embed credentials".to_string());
        }
        if base_url.query().is_some() || base_url.fragment().is_some() {
            return Err("PasteboardPro WebDAV URL cannot contain query or fragment".to_string());
        }
        if config.username.trim().is_empty() || config.username.contains(':') {
            return Err("PasteboardPro WebDAV username is invalid".to_string());
        }
        if config.password.is_empty() {
            return Err("PasteboardPro WebDAV password is required".to_string());
        }
        if !base_url.path().ends_with('/') {
            let path = format!("{}/", base_url.path());
            base_url.set_path(&path);
        }
        let mut builder = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none());
        if let Some(proxy_url) = config
            .proxy_url
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            builder = builder.proxy(
                reqwest::Proxy::all(proxy_url)
                    .map_err(|error| format!("Invalid PasteboardPro proxy URL: {error}"))?,
            );
        }
        let client = builder
            .build()
            .map_err(|error| format!("Failed to create PasteboardPro WebDAV client: {error}"))?;
        Ok(Self {
            client,
            base_url,
            username: config.username,
            password: config.password,
        })
    }

    fn request_url(&self, path: &str) -> Result<reqwest::Url, String> {
        if path.is_empty()
            || path.starts_with('/')
            || path.contains('\\')
            || path.contains('?')
            || path.contains('#')
            || path.split('/').any(|segment| matches!(segment, "." | ".."))
        {
            return Err("PasteboardPro WebDAV path escaped the vault".to_string());
        }
        let url = self
            .base_url
            .join(path)
            .map_err(|error| format!("Invalid PasteboardPro WebDAV path: {error}"))?;
        if url.origin() != self.base_url.origin() || !url.path().starts_with(self.base_url.path()) {
            return Err("PasteboardPro WebDAV request escaped the configured vault".to_string());
        }
        Ok(url)
    }
}

#[async_trait]
impl PasteboardWebDavTransport for ReqwestPasteboardWebDavTransport {
    async fn request(
        &self,
        request: PasteboardWebDavRequest,
    ) -> Result<PasteboardWebDavResponse, String> {
        let method = reqwest::Method::from_bytes(request.method.as_bytes())
            .map_err(|_| "Unsupported PasteboardPro WebDAV method".to_string())?;
        let url = self.request_url(&request.path)?;
        let mut builder = self
            .client
            .request(method, url)
            .basic_auth(&self.username, Some(&self.password));
        for (name, value) in request.headers {
            builder = builder.header(name, value);
        }
        if !request.body.is_empty() {
            builder = builder.body(request.body);
        }
        let response = builder
            .send()
            .await
            .map_err(|error| format!("PasteboardPro WebDAV request failed: {error}"))?;
        if response
            .content_length()
            .is_some_and(|bytes| bytes > MAX_WEBDAV_RESPONSE_BYTES as u64)
        {
            return Err("PasteboardPro WebDAV response exceeds 101 MiB".to_string());
        }
        let status = response.status().as_u16();
        let etag = response
            .headers()
            .get(reqwest::header::ETAG)
            .and_then(|value| value.to_str().ok())
            .map(ToString::to_string);
        let body = response
            .bytes()
            .await
            .map_err(|error| format!("Failed to read PasteboardPro WebDAV response: {error}"))?
            .to_vec();
        if body.len() > MAX_WEBDAV_RESPONSE_BYTES {
            return Err("PasteboardPro WebDAV response exceeds 101 MiB".to_string());
        }
        Ok(PasteboardWebDavResponse { status, etag, body })
    }
}

fn webdav_request(
    method: &str,
    path: &str,
    headers: impl IntoIterator<Item = (String, String)>,
    body: Vec<u8>,
) -> PasteboardWebDavRequest {
    PasteboardWebDavRequest {
        method: method.to_string(),
        path: path.to_string(),
        headers: headers.into_iter().collect(),
        body,
    }
}

pub async fn read_vault_file<T: PasteboardWebDavTransport>(
    transport: &T,
    path: &str,
) -> Result<Option<PasteboardWebDavResponse>, String> {
    let response = transport
        .request(webdav_request("GET", path, [], Vec::new()))
        .await?;
    match response.status {
        200 => Ok(Some(response)),
        404 => Ok(None),
        401 | 403 => Err("PasteboardPro WebDAV authentication failed".to_string()),
        status => Err(format!(
            "PasteboardPro WebDAV read failed for {path}: HTTP {status}"
        )),
    }
}

pub async fn put_vault_file_if_absent<T: PasteboardWebDavTransport>(
    transport: &T,
    path: &str,
    body: Vec<u8>,
    content_type: &str,
) -> Result<bool, String> {
    let response = transport
        .request(webdav_request(
            "PUT",
            path,
            [
                ("content-type".to_string(), content_type.to_string()),
                ("if-none-match".to_string(), "*".to_string()),
            ],
            body,
        ))
        .await?;
    match response.status {
        200 | 201 | 204 => Ok(true),
        412 => Ok(false),
        401 | 403 => Err("PasteboardPro WebDAV authentication failed".to_string()),
        status => Err(format!(
            "PasteboardPro WebDAV immutable upload failed for {path}: HTTP {status}"
        )),
    }
}

fn parse_vault_metadata(bytes: &[u8]) -> Result<VaultMetadata, String> {
    if bytes.len() > 64 * 1024 {
        return Err("vault.json exceeds 64 KiB".to_string());
    }
    let metadata: VaultMetadata =
        serde_json::from_slice(bytes).map_err(|error| format!("vault.json is invalid: {error}"))?;
    metadata.validate()?;
    Ok(metadata)
}

pub async fn read_vault_metadata<T: PasteboardWebDavTransport>(
    transport: &T,
) -> Result<Option<VaultMetadata>, String> {
    read_vault_file(transport, "vault.json")
        .await?
        .map(|response| parse_vault_metadata(&response.body))
        .transpose()
}

pub async fn ensure_vault_metadata<T: PasteboardWebDavTransport>(
    transport: &T,
) -> Result<VaultMetadata, String> {
    if let Some(metadata) = read_vault_metadata(transport).await? {
        return Ok(metadata);
    }
    let mut salt = [0_u8; 16];
    OsRng.fill_bytes(&mut salt);
    let candidate = VaultMetadata::new(&salt)?;
    let candidate_value = serde_json::to_value(&candidate)
        .map_err(|error| format!("Failed to serialize vault metadata: {error}"))?;
    let created = put_vault_file_if_absent(
        transport,
        "vault.json",
        canonical_json(&candidate_value)?.into_bytes(),
        "application/json",
    )
    .await?;
    if created {
        return Ok(candidate);
    }
    read_vault_metadata(transport)
        .await?
        .ok_or_else(|| "vault.json create race completed without a remote file".to_string())
}

pub async fn verify_remote_vault_key<T: PasteboardWebDavTransport>(
    transport: &T,
    key: &[u8; KEY_BYTES],
) -> Result<(), String> {
    let Some(response) = read_vault_file(transport, "index.enc").await? else {
        return Ok(());
    };
    if response.body.len() > 16 * 1024 * 1024 {
        return Err("Remote PasteboardPro index exceeds 16 MiB".to_string());
    }
    let envelope: VaultObjectEnvelope = serde_json::from_slice(&response.body)
        .map_err(|_| "Remote PasteboardPro index envelope is invalid".to_string())?;
    if envelope.object_type != "index" || envelope.object_id != "main" {
        return Err("Remote PasteboardPro index descriptor is invalid".to_string());
    }
    let index = decrypt_envelope(key, &envelope)
        .map_err(|_| "PasteboardPro sync password is incorrect".to_string())?;
    if index.get("version").and_then(Value::as_u64) != Some(u64::from(VAULT_VERSION))
        || !index.get("objects").is_some_and(Value::is_array)
    {
        return Err("Remote PasteboardPro index schema is unsupported".to_string());
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PasteboardIndexUpdateResult {
    pub status: String,
    pub retries: usize,
    pub etag: Option<String>,
}

pub async fn update_encrypted_index<T, F>(
    transport: &T,
    mut build_index: F,
) -> Result<PasteboardIndexUpdateResult, String>
where
    T: PasteboardWebDavTransport,
    F: FnMut(Option<&[u8]>) -> Result<Vec<u8>, String>,
{
    for attempt in 0..=MAX_INDEX_CONFLICT_RETRIES {
        let current = read_vault_file(transport, "index.enc").await?;
        let (remote_body, etag) = match current.as_ref() {
            Some(response) => {
                let etag = response
                    .etag
                    .clone()
                    .ok_or_else(|| "PasteboardPro index response is missing ETag".to_string())?;
                (Some(response.body.as_slice()), Some(etag))
            }
            None => (None, None),
        };

        // The caller must decrypt, authenticate, merge, and construct the next
        // encrypted index before this function is allowed to issue any PUT.
        let next_index = build_index(remote_body)?;
        let conditional_header = match etag.as_ref() {
            Some(value) => ("if-match".to_string(), value.clone()),
            None => ("if-none-match".to_string(), "*".to_string()),
        };
        let response = transport
            .request(webdav_request(
                "PUT",
                "index.enc",
                [
                    (
                        "content-type".to_string(),
                        "application/octet-stream".to_string(),
                    ),
                    conditional_header,
                ],
                next_index,
            ))
            .await?;
        match response.status {
            200 | 201 | 204 => {
                return Ok(PasteboardIndexUpdateResult {
                    status: "success".to_string(),
                    retries: attempt,
                    etag: response.etag,
                });
            }
            412 if attempt < MAX_INDEX_CONFLICT_RETRIES => continue,
            412 => {
                return Ok(PasteboardIndexUpdateResult {
                    status: "conflict".to_string(),
                    retries: MAX_INDEX_CONFLICT_RETRIES,
                    etag: None,
                });
            }
            401 | 403 => return Err("PasteboardPro WebDAV authentication failed".to_string()),
            status => {
                return Err(format!(
                    "PasteboardPro conditional index update failed: HTTP {status}"
                ));
            }
        }
    }
    Err("PasteboardPro index retry state is unreachable".to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct VaultIndexEntry {
    pub object_type: String,
    pub object_id: String,
    pub revision: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct VaultIndex {
    pub version: u8,
    pub objects: Vec<VaultIndexEntry>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PasteboardSyncResult {
    pub status: String,
    pub pulled_objects: usize,
    pub pushed_objects: usize,
    pub failed_object_ids: Vec<String>,
    pub retries: usize,
    pub synced_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
enum SyncEntity {
    Item(PasteboardItem),
    Pinboard(Pinboard),
    Tombstone(PasteboardTombstone),
}

impl SyncEntity {
    fn entity_type(&self) -> PasteboardEntityType {
        match self {
            Self::Item(_) => PasteboardEntityType::PasteItem,
            Self::Pinboard(_) => PasteboardEntityType::Pinboard,
            Self::Tombstone(value) => value.entity_type,
        }
    }

    fn id(&self) -> &str {
        match self {
            Self::Item(value) => &value.id,
            Self::Pinboard(value) => &value.id,
            Self::Tombstone(value) => &value.id,
        }
    }

    fn identity(&self) -> String {
        format!("{}\0{}", self.entity_type().as_str(), self.id())
    }

    fn object_type(&self) -> &'static str {
        match self {
            Self::Item(_) => "item",
            Self::Pinboard(_) => "pinboard",
            Self::Tombstone(_) => "tombstone",
        }
    }

    fn object_id(&self) -> String {
        match self {
            Self::Tombstone(value) => {
                format!("{}:{}", value.entity_type.as_str(), value.id)
            }
            _ => self.id().to_string(),
        }
    }

    fn value(&self) -> Result<Value, String> {
        match self {
            Self::Item(value) => serde_json::to_value(value),
            Self::Pinboard(value) => serde_json::to_value(value),
            Self::Tombstone(value) => serde_json::to_value(value),
        }
        .map_err(|error| format!("Failed to serialize PasteboardPro entity: {error}"))
    }

    fn descriptor(&self, key: &[u8; KEY_BYTES]) -> Result<VaultObjectDescriptor, String> {
        let value = self.value()?;
        Ok(VaultObjectDescriptor {
            version: VAULT_VERSION,
            object_type: self.object_type().to_string(),
            object_id: self.object_id(),
            revision: vault_revision(key, &value)?,
        })
    }
}

fn compare_clock(left: &HybridLogicalClock, right: &HybridLogicalClock) -> Ordering {
    left.wall_ms
        .cmp(&right.wall_ms)
        .then_with(|| left.counter.cmp(&right.counter))
        .then_with(|| left.device_id.cmp(&right.device_id))
}

fn select_field<T: Clone + PartialEq>(
    key: &str,
    left_value: &T,
    left_clocks: &BTreeMap<String, HybridLogicalClock>,
    right_value: &T,
    right_clocks: &BTreeMap<String, HybridLogicalClock>,
) -> Result<T, String> {
    let order = match (left_clocks.get(key), right_clocks.get(key)) {
        (Some(left), Some(right)) => compare_clock(left, right),
        (Some(_), None) => Ordering::Greater,
        (None, Some(_)) => Ordering::Less,
        (None, None) => Ordering::Equal,
    };
    match order {
        Ordering::Greater => Ok(left_value.clone()),
        Ordering::Less => Ok(right_value.clone()),
        Ordering::Equal if left_value == right_value => Ok(left_value.clone()),
        Ordering::Equal => Err(format!(
            "PasteboardPro field {key} has conflicting values at an equal clock"
        )),
    }
}

fn merge_field_clocks(
    left: &BTreeMap<String, HybridLogicalClock>,
    right: &BTreeMap<String, HybridLogicalClock>,
) -> BTreeMap<String, HybridLogicalClock> {
    let mut merged = left.clone();
    for (key, right_clock) in right {
        if merged.get(key).map_or(true, |left_clock| {
            compare_clock(left_clock, right_clock) == Ordering::Less
        }) {
            merged.insert(key.clone(), right_clock.clone());
        }
    }
    merged
}

fn newest_updated_at(left: &str, right: &str) -> String {
    if left < right {
        right.to_string()
    } else {
        left.to_string()
    }
}

fn merge_items(left: &PasteboardItem, right: &PasteboardItem) -> Result<PasteboardItem, String> {
    if left.id != right.id {
        return Err("Cannot merge PasteboardPro items with different ids".to_string());
    }
    if left.kind != right.kind
        || left.source_app != right.source_app
        || left.source_device_id != right.source_device_id
        || left.copied_at != right.copied_at
        || left.content_fingerprint != right.content_fingerprint
    {
        return Err("PasteboardPro item immutable capture fields conflict".to_string());
    }
    if left.payload.revision == right.payload.revision && left.payload != right.payload {
        return Err("PasteboardPro payload revision contains conflicting content".to_string());
    }
    Ok(PasteboardItem {
        id: left.id.clone(),
        kind: left.kind,
        title: select_field(
            "title",
            &left.title,
            &left.field_clocks,
            &right.title,
            &right.field_clocks,
        )?,
        source_app: left.source_app.clone(),
        source_device_id: left.source_device_id.clone(),
        copied_at: left.copied_at.clone(),
        updated_at: newest_updated_at(&left.updated_at, &right.updated_at),
        content_fingerprint: left.content_fingerprint.clone(),
        payload: select_field(
            "payload",
            &left.payload,
            &left.field_clocks,
            &right.payload,
            &right.field_clocks,
        )?,
        ocr_text: select_field(
            "ocrText",
            &left.ocr_text,
            &left.field_clocks,
            &right.ocr_text,
            &right.field_clocks,
        )?,
        pinboard_id: select_field(
            "pinboardId",
            &left.pinboard_id,
            &left.field_clocks,
            &right.pinboard_id,
            &right.field_clocks,
        )?,
        pinboard_order_key: select_field(
            "pinboardOrderKey",
            &left.pinboard_order_key,
            &left.field_clocks,
            &right.pinboard_order_key,
            &right.field_clocks,
        )?,
        pinned: select_field(
            "pinned",
            &left.pinned,
            &left.field_clocks,
            &right.pinned,
            &right.field_clocks,
        )?,
        field_clocks: merge_field_clocks(&left.field_clocks, &right.field_clocks),
    })
}

fn merge_pinboards(left: &Pinboard, right: &Pinboard) -> Result<Pinboard, String> {
    if left.id != right.id || left.created_at != right.created_at {
        return Err("PasteboardPro Pinboard immutable fields conflict".to_string());
    }
    Ok(Pinboard {
        id: left.id.clone(),
        name: select_field(
            "name",
            &left.name,
            &left.field_clocks,
            &right.name,
            &right.field_clocks,
        )?,
        color: select_field(
            "color",
            &left.color,
            &left.field_clocks,
            &right.color,
            &right.field_clocks,
        )?,
        order_key: select_field(
            "orderKey",
            &left.order_key,
            &left.field_clocks,
            &right.order_key,
            &right.field_clocks,
        )?,
        created_at: left.created_at.clone(),
        updated_at: newest_updated_at(&left.updated_at, &right.updated_at),
        field_clocks: merge_field_clocks(&left.field_clocks, &right.field_clocks),
    })
}

fn maximum_live_clock(entity: &SyncEntity) -> Option<&HybridLogicalClock> {
    let clocks = match entity {
        SyncEntity::Item(value) => &value.field_clocks,
        SyncEntity::Pinboard(value) => &value.field_clocks,
        SyncEntity::Tombstone(_) => return None,
    };
    clocks
        .values()
        .max_by(|left, right| compare_clock(left, right))
}

fn merge_entities(left: &SyncEntity, right: &SyncEntity) -> Result<SyncEntity, String> {
    if left.identity() != right.identity() {
        return Err("Cannot merge different PasteboardPro entity identities".to_string());
    }
    match (left, right) {
        (SyncEntity::Item(left), SyncEntity::Item(right)) => {
            merge_items(left, right).map(SyncEntity::Item)
        }
        (SyncEntity::Pinboard(left), SyncEntity::Pinboard(right)) => {
            merge_pinboards(left, right).map(SyncEntity::Pinboard)
        }
        (SyncEntity::Tombstone(left), SyncEntity::Tombstone(right)) => {
            match compare_clock(&left.clock, &right.clock) {
                Ordering::Greater => Ok(SyncEntity::Tombstone(left.clone())),
                Ordering::Less => Ok(SyncEntity::Tombstone(right.clone())),
                Ordering::Equal if left == right => Ok(SyncEntity::Tombstone(left.clone())),
                Ordering::Equal => {
                    Err("PasteboardPro tombstones conflict at an equal clock".to_string())
                }
            }
        }
        (SyncEntity::Tombstone(deleted), live) | (live, SyncEntity::Tombstone(deleted)) => {
            let live_clock = maximum_live_clock(live);
            if live_clock.map_or(true, |clock| {
                compare_clock(&deleted.clock, clock) != Ordering::Less
            }) {
                Ok(SyncEntity::Tombstone(deleted.clone()))
            } else {
                Ok(live.clone())
            }
        }
        _ => Err("PasteboardPro live entity types conflict".to_string()),
    }
}

fn local_sync_entities(db: &Database) -> Result<Vec<SyncEntity>, String> {
    let mut entities = db
        .list_pasteboard_items_for_sync()
        .map_err(|error| error.to_string())?
        .into_iter()
        .map(SyncEntity::Item)
        .collect::<Vec<_>>();
    entities.extend(
        db.list_pinboards()
            .map_err(|error| error.to_string())?
            .into_iter()
            .map(SyncEntity::Pinboard),
    );
    entities.extend(
        db.list_pasteboard_tombstones()
            .map_err(|error| error.to_string())?
            .into_iter()
            .map(SyncEntity::Tombstone),
    );
    Ok(entities)
}

fn merge_entity_sets(
    local: Vec<SyncEntity>,
    remote: Vec<SyncEntity>,
) -> Result<Vec<SyncEntity>, String> {
    let mut merged = BTreeMap::<String, SyncEntity>::new();
    for entity in local.into_iter().chain(remote) {
        let identity = entity.identity();
        let next = match merged.get(&identity) {
            Some(current) => merge_entities(current, &entity)?,
            None => entity,
        };
        merged.insert(identity, next);
    }
    Ok(merged.into_values().collect())
}

fn apply_sync_entities(db: &Database, entities: &[SyncEntity]) -> Result<(), String> {
    for entity in entities {
        match entity {
            SyncEntity::Item(value) => db
                .upsert_pasteboard_item(value)
                .map_err(|error| error.to_string())?,
            SyncEntity::Pinboard(value) => db
                .upsert_pinboard(value)
                .map_err(|error| error.to_string())?,
            SyncEntity::Tombstone(value) => db
                .upsert_pasteboard_tombstone(value)
                .map_err(|error| error.to_string())?,
        }
    }
    Ok(())
}

fn validate_index(mut index: VaultIndex) -> Result<VaultIndex, String> {
    if index.version != VAULT_VERSION {
        return Err(format!(
            "Unsupported PasteboardPro index version: {}",
            index.version
        ));
    }
    let mut identities = BTreeSet::new();
    for entry in &index.objects {
        if entry.object_type == "index" {
            return Err("PasteboardPro index cannot reference an index object".to_string());
        }
        let descriptor = VaultObjectDescriptor {
            version: VAULT_VERSION,
            object_type: entry.object_type.clone(),
            object_id: entry.object_id.clone(),
            revision: entry.revision.clone(),
        };
        let expected_path = object_path(&descriptor)?;
        if entry.path != expected_path {
            return Err("PasteboardPro index entry path does not match its descriptor".to_string());
        }
        if !identities.insert(format!("{}\0{}", entry.object_type, entry.object_id)) {
            return Err("PasteboardPro index contains duplicate object identities".to_string());
        }
    }
    index.objects.sort_by(|left, right| {
        left.object_type
            .cmp(&right.object_type)
            .then_with(|| left.object_id.cmp(&right.object_id))
            .then_with(|| left.revision.cmp(&right.revision))
    });
    Ok(index)
}

fn parse_index(key: &[u8; KEY_BYTES], bytes: &[u8]) -> Result<VaultIndex, String> {
    if bytes.len() > 16 * 1024 * 1024 {
        return Err("Remote PasteboardPro index exceeds 16 MiB".to_string());
    }
    let envelope: VaultObjectEnvelope = serde_json::from_slice(bytes)
        .map_err(|_| "Remote PasteboardPro index envelope is invalid".to_string())?;
    if envelope.object_type != "index" || envelope.object_id != "main" {
        return Err("Remote PasteboardPro index descriptor is invalid".to_string());
    }
    let value = decrypt_envelope(key, &envelope)
        .map_err(|_| "PasteboardPro sync password is incorrect".to_string())?;
    let index: VaultIndex = serde_json::from_value(value)
        .map_err(|_| "Remote PasteboardPro index schema is unsupported".to_string())?;
    validate_index(index)
}

fn parse_remote_entity(
    key: &[u8; KEY_BYTES],
    entry: &VaultIndexEntry,
    bytes: &[u8],
) -> Result<SyncEntity, String> {
    if bytes.len() > 100 * 1024 * 1024 + 64 * 1024 {
        return Err(format!(
            "Remote PasteboardPro object is too large: {}",
            entry.path
        ));
    }
    let envelope: VaultObjectEnvelope = serde_json::from_slice(bytes)
        .map_err(|_| format!("Remote PasteboardPro envelope is invalid: {}", entry.path))?;
    if envelope.object_type != entry.object_type
        || envelope.object_id != entry.object_id
        || envelope.revision != entry.revision
    {
        return Err(format!(
            "Remote PasteboardPro object descriptor mismatch: {}",
            entry.path
        ));
    }
    let value = decrypt_envelope(key, &envelope).map_err(|_| {
        format!(
            "Remote PasteboardPro object authentication failed: {}",
            entry.path
        )
    })?;
    match entry.object_type.as_str() {
        "item" => serde_json::from_value(value)
            .map(SyncEntity::Item)
            .map_err(|_| format!("Remote PasteboardPro item is invalid: {}", entry.path)),
        "pinboard" => serde_json::from_value(value)
            .map(SyncEntity::Pinboard)
            .map_err(|_| format!("Remote PasteboardPro Pinboard is invalid: {}", entry.path)),
        "tombstone" => serde_json::from_value(value)
            .map(SyncEntity::Tombstone)
            .map_err(|_| format!("Remote PasteboardPro tombstone is invalid: {}", entry.path)),
        _ => Err(format!(
            "Remote PasteboardPro index contains unsupported entity type: {}",
            entry.object_type
        )),
    }
}

async fn read_remote_entity_set<T: PasteboardWebDavTransport>(
    transport: &T,
    key: &[u8; KEY_BYTES],
    entries: &[VaultIndexEntry],
) -> Result<(Vec<SyncEntity>, Vec<VaultIndexEntry>), String> {
    let mut entities = Vec::new();
    let mut blobs = Vec::new();
    for entry in entries {
        if entry.object_type == "blob" {
            blobs.push(entry.clone());
            continue;
        }
        let remote = read_vault_file(transport, &entry.path)
            .await?
            .ok_or_else(|| format!("Remote PasteboardPro object is missing: {}", entry.path))?;
        entities.push(parse_remote_entity(key, entry, &remote.body)?);
    }
    Ok((entities, blobs))
}

fn encrypted_entity(
    key: &[u8; KEY_BYTES],
    entity: &SyncEntity,
) -> Result<(VaultIndexEntry, Vec<u8>), String> {
    let descriptor = entity.descriptor(key)?;
    let path = object_path(&descriptor)?;
    let envelope = encrypt_object(key, &descriptor, &entity.value()?)?;
    let body = canonical_json(
        &serde_json::to_value(envelope)
            .map_err(|error| format!("Failed to serialize PasteboardPro envelope: {error}"))?,
    )?
    .into_bytes();
    Ok((
        VaultIndexEntry {
            object_type: descriptor.object_type,
            object_id: descriptor.object_id,
            revision: descriptor.revision,
            path,
        },
        body,
    ))
}

fn blob_descriptor(
    key: &[u8; KEY_BYTES],
    blob_id: &str,
    bytes: &[u8],
) -> Result<VaultObjectDescriptor, String> {
    if bytes.len() > MAX_BLOB_PLAINTEXT_BYTES {
        return Err(format!(
            "PasteboardPro blob is larger than 100 MiB: {blob_id}"
        ));
    }
    Ok(VaultObjectDescriptor {
        version: VAULT_VERSION,
        object_type: "blob".to_string(),
        object_id: blob_id.to_string(),
        revision: vault_bytes_revision(key, bytes)?,
    })
}

fn encrypted_blob(
    blob_root: &Path,
    key: &[u8; KEY_BYTES],
    blob: &PasteboardBlob,
) -> Result<(VaultIndexEntry, Vec<u8>), String> {
    let path = blob_root.join(&blob.relative_path);
    let bytes = std::fs::read(&path)
        .map_err(|error| format!("Failed to read PasteboardPro blob {}: {error}", blob.id))?;
    if bytes.len() as u64 != blob.byte_length {
        return Err(format!(
            "PasteboardPro blob length does not match metadata: {}",
            blob.id
        ));
    }
    let digest = hex::encode(Sha256::digest(&bytes));
    if blob.keyed_fingerprint != format!("sha256:{digest}") {
        return Err(format!(
            "PasteboardPro blob fingerprint does not match local bytes: {}",
            blob.id
        ));
    }
    let descriptor = blob_descriptor(key, &blob.id, &bytes)?;
    let path = object_path(&descriptor)?;
    let envelope = encrypt_bytes(key, &descriptor, &bytes)?;
    let body = canonical_json(
        &serde_json::to_value(envelope)
            .map_err(|error| format!("Failed to serialize PasteboardPro blob: {error}"))?,
    )?
    .into_bytes();
    if body.len() > MAX_BLOB_ENVELOPE_BYTES {
        return Err(format!(
            "Encrypted PasteboardPro blob exceeds the 140 MiB transport limit: {}",
            blob.id
        ));
    }
    Ok((
        VaultIndexEntry {
            object_type: descriptor.object_type,
            object_id: descriptor.object_id,
            revision: descriptor.revision,
            path,
        },
        body,
    ))
}

fn parse_remote_blob(
    key: &[u8; KEY_BYTES],
    entry: &VaultIndexEntry,
    bytes: &[u8],
) -> Result<Vec<u8>, String> {
    if bytes.len() > MAX_BLOB_ENVELOPE_BYTES {
        return Err(format!(
            "Remote PasteboardPro blob envelope is too large: {}",
            entry.path
        ));
    }
    let envelope: VaultObjectEnvelope = serde_json::from_slice(bytes).map_err(|_| {
        format!(
            "Remote PasteboardPro blob envelope is invalid: {}",
            entry.path
        )
    })?;
    if envelope.object_type != "blob"
        || envelope.object_id != entry.object_id
        || envelope.revision != entry.revision
    {
        return Err(format!(
            "Remote PasteboardPro blob descriptor mismatch: {}",
            entry.path
        ));
    }
    let plaintext = decrypt_envelope_bytes(key, &envelope).map_err(|_| {
        format!(
            "Remote PasteboardPro blob authentication failed: {}",
            entry.path
        )
    })?;
    if plaintext.len() > MAX_BLOB_PLAINTEXT_BYTES {
        return Err(format!(
            "Remote PasteboardPro blob is larger than 100 MiB: {}",
            entry.path
        ));
    }
    if vault_bytes_revision(key, &plaintext)? != entry.revision {
        return Err(format!(
            "Remote PasteboardPro blob revision mismatch: {}",
            entry.path
        ));
    }
    Ok(plaintext)
}

fn blob_extension(media_type: &str) -> &'static str {
    match media_type {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/tiff" => "tiff",
        "application/pdf" => "pdf",
        "text/rtf" => "rtf",
        "text/rtfd" => "rtfd",
        _ => "bin",
    }
}

fn store_remote_blob(
    db: &Database,
    blob_root: &Path,
    entry: &VaultIndexEntry,
    media_type: &str,
    bytes: &[u8],
) -> Result<PasteboardBlob, String> {
    let digest = hex::encode(Sha256::digest(bytes));
    let relative_path = format!(
        "blobs/{}/{}.{}",
        &digest[..2],
        digest,
        blob_extension(media_type)
    );
    let destination = blob_root.join(&relative_path);
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("Failed to create PasteboardPro blob directory: {error}"))?;
    }
    if !destination.is_file() {
        let temporary = destination.with_extension(format!(
            "{}.tmp-{}",
            blob_extension(media_type),
            atools_core::utils::generate_rev()
        ));
        std::fs::write(&temporary, bytes)
            .map_err(|error| format!("Failed to write remote PasteboardPro blob: {error}"))?;
        if let Err(error) = std::fs::rename(&temporary, &destination) {
            let _ = std::fs::remove_file(&temporary);
            if !destination.is_file() {
                return Err(format!(
                    "Failed to finalize remote PasteboardPro blob: {error}"
                ));
            }
        }
    }
    let timestamp = atools_core::utils::now_iso();
    let blob = PasteboardBlob {
        id: entry.object_id.clone(),
        keyed_fingerprint: format!("sha256:{digest}"),
        relative_path,
        media_type: media_type.to_string(),
        byte_length: bytes.len() as u64,
        created_at: timestamp.clone(),
        last_accessed_at: timestamp,
        remote_available: true,
        sync_state: "synced".to_string(),
        metadata: Value::Null,
    };
    db.upsert_pasteboard_blob(&blob)
        .map_err(|error| error.to_string())?;
    Ok(blob)
}

fn referenced_blob_media_types(entities: &[SyncEntity]) -> BTreeMap<String, String> {
    entities
        .iter()
        .filter_map(|entity| match entity {
            SyncEntity::Item(item) => item.payload.blob_id.as_ref().map(|blob_id| {
                (
                    blob_id.clone(),
                    item.payload
                        .media_type
                        .clone()
                        .unwrap_or_else(|| "application/octet-stream".to_string()),
                )
            }),
            _ => None,
        })
        .collect()
}

fn encrypted_index(
    key: &[u8; KEY_BYTES],
    entries: Vec<VaultIndexEntry>,
) -> Result<Vec<u8>, String> {
    let index = validate_index(VaultIndex {
        version: VAULT_VERSION,
        objects: entries,
    })?;
    let value = serde_json::to_value(index)
        .map_err(|error| format!("Failed to serialize PasteboardPro index: {error}"))?;
    let descriptor = VaultObjectDescriptor {
        version: VAULT_VERSION,
        object_type: "index".to_string(),
        object_id: "main".to_string(),
        revision: vault_revision(key, &value)?,
    };
    let envelope = encrypt_object(key, &descriptor, &value)?;
    Ok(canonical_json(
        &serde_json::to_value(envelope).map_err(|error| {
            format!("Failed to serialize PasteboardPro index envelope: {error}")
        })?,
    )?
    .into_bytes())
}

pub async fn sync_pasteboard_vault<T: PasteboardWebDavTransport>(
    db: &Database,
    blob_root: &Path,
    transport: &T,
    key: &[u8; KEY_BYTES],
) -> Result<PasteboardSyncResult, String> {
    for attempt in 0..=MAX_INDEX_CONFLICT_RETRIES {
        let current = read_vault_file(transport, "index.enc").await?;
        let (remote_entries, etag) = match current.as_ref() {
            Some(response) => {
                let etag = response
                    .etag
                    .clone()
                    .ok_or_else(|| "PasteboardPro index response is missing ETag".to_string())?;
                (parse_index(key, &response.body)?.objects, Some(etag))
            }
            None => (Vec::new(), None),
        };
        let remote_paths = remote_entries
            .iter()
            .map(|entry| entry.path.clone())
            .collect::<BTreeSet<_>>();
        let (remote_entities, remote_blobs) =
            read_remote_entity_set(transport, key, &remote_entries).await?;
        let mut pulled_objects = remote_entities.len();
        let merged = merge_entity_sets(local_sync_entities(db)?, remote_entities)?;
        apply_sync_entities(db, &merged)?;
        let referenced_blobs = referenced_blob_media_types(&merged);
        let remote_blob_entries = remote_blobs
            .iter()
            .map(|entry| (entry.object_id.clone(), entry.clone()))
            .collect::<BTreeMap<_, _>>();

        let mut pushed_objects = 0;
        let mut failed_object_ids = Vec::new();
        let mut next_entries = remote_blobs
            .into_iter()
            .map(|entry| (format!("blob\0{}", entry.object_id), entry))
            .collect::<BTreeMap<_, _>>();

        for (blob_id, media_type) in &referenced_blobs {
            let local_available = db
                .get_pasteboard_blob(blob_id)
                .map_err(|error| error.to_string())?
                .is_some_and(|blob| blob_root.join(blob.relative_path).is_file());
            if local_available {
                continue;
            }
            let Some(entry) = remote_blob_entries.get(blob_id) else {
                failed_object_ids.push(format!("blob:{blob_id}"));
                continue;
            };
            let remote = read_vault_file(transport, &entry.path)
                .await?
                .ok_or_else(|| format!("Remote PasteboardPro blob is missing: {}", entry.path))?;
            let bytes = parse_remote_blob(key, entry, &remote.body)?;
            store_remote_blob(db, blob_root, entry, media_type, &bytes)?;
            pulled_objects += 1;
        }

        for entity in &merged {
            let (entry, body) = encrypted_entity(key, entity)?;
            match put_vault_file_if_absent(transport, &entry.path, body, "application/octet-stream")
                .await
            {
                Ok(created) => {
                    pushed_objects += usize::from(created);
                    next_entries.insert(entity.identity(), entry);
                }
                Err(_) if remote_paths.contains(&entry.path) => {
                    next_entries.insert(entity.identity(), entry);
                }
                Err(_) => failed_object_ids.push(entity.id().to_string()),
            }
        }

        for blob_id in referenced_blobs.keys() {
            let Some(blob) = db
                .get_pasteboard_blob(blob_id)
                .map_err(|error| error.to_string())?
            else {
                failed_object_ids.push(format!("blob:{blob_id}"));
                continue;
            };
            let (entry, body) = match encrypted_blob(blob_root, key, &blob) {
                Ok(value) => value,
                Err(_) => {
                    failed_object_ids.push(format!("blob:{blob_id}"));
                    continue;
                }
            };
            if remote_blob_entries
                .get(blob_id)
                .is_some_and(|remote| remote.revision != entry.revision)
            {
                return Err(format!(
                    "PasteboardPro blob id has conflicting immutable revisions: {blob_id}"
                ));
            }
            match put_vault_file_if_absent(transport, &entry.path, body, "application/octet-stream")
                .await
            {
                Ok(created) => {
                    pushed_objects += usize::from(created);
                    next_entries.insert(format!("blob\0{blob_id}"), entry);
                }
                Err(_) if remote_paths.contains(&entry.path) => {
                    next_entries.insert(format!("blob\0{blob_id}"), entry);
                }
                Err(_) => failed_object_ids.push(format!("blob:{blob_id}")),
            }
        }
        failed_object_ids.sort();
        failed_object_ids.dedup();
        if !failed_object_ids.is_empty() {
            // Successfully uploaded immutable objects remain reusable on the next
            // attempt, but the authoritative index is left untouched until every
            // merged entity has a reachable object revision.
            return Ok(PasteboardSyncResult {
                status: "partial".to_string(),
                pulled_objects,
                pushed_objects,
                failed_object_ids,
                retries: attempt,
                synced_at: None,
            });
        }
        let next_index = encrypted_index(key, next_entries.into_values().collect())?;
        let conditional_header = match etag.as_ref() {
            Some(value) => ("if-match".to_string(), value.clone()),
            None => ("if-none-match".to_string(), "*".to_string()),
        };
        let response = transport
            .request(webdav_request(
                "PUT",
                "index.enc",
                [
                    (
                        "content-type".to_string(),
                        "application/octet-stream".to_string(),
                    ),
                    conditional_header,
                ],
                next_index,
            ))
            .await?;
        match response.status {
            200 | 201 | 204 => {
                for blob_id in referenced_blobs.keys() {
                    if let Some(mut blob) = db
                        .get_pasteboard_blob(blob_id)
                        .map_err(|error| error.to_string())?
                    {
                        blob.remote_available = true;
                        blob.sync_state = "synced".to_string();
                        blob.last_accessed_at = atools_core::utils::now_iso();
                        db.upsert_pasteboard_blob(&blob)
                            .map_err(|error| error.to_string())?;
                    }
                }
                return Ok(PasteboardSyncResult {
                    status: "success".to_string(),
                    pulled_objects,
                    pushed_objects,
                    failed_object_ids,
                    retries: attempt,
                    synced_at: Some(atools_core::utils::now_iso()),
                });
            }
            412 if attempt < MAX_INDEX_CONFLICT_RETRIES => continue,
            412 => {
                return Ok(PasteboardSyncResult {
                    status: "conflict".to_string(),
                    pulled_objects,
                    pushed_objects,
                    failed_object_ids,
                    retries: MAX_INDEX_CONFLICT_RETRIES,
                    synced_at: None,
                });
            }
            401 | 403 => return Err("PasteboardPro WebDAV authentication failed".to_string()),
            status => {
                return Err(format!(
                    "PasteboardPro conditional index update failed: HTTP {status}"
                ));
            }
        }
    }
    Err("PasteboardPro sync retry state is unreachable".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::Mutex;

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

    struct MockTransport {
        responses: Mutex<VecDeque<PasteboardWebDavResponse>>,
        requests: Mutex<Vec<PasteboardWebDavRequest>>,
    }

    #[async_trait]
    impl PasteboardWebDavTransport for MockTransport {
        async fn request(
            &self,
            request: PasteboardWebDavRequest,
        ) -> Result<PasteboardWebDavResponse, String> {
            self.requests.lock().unwrap().push(request);
            self.responses
                .lock()
                .unwrap()
                .pop_front()
                .ok_or_else(|| "missing mock response".to_string())
        }
    }

    fn response(status: u16, etag: Option<&str>, body: &[u8]) -> PasteboardWebDavResponse {
        PasteboardWebDavResponse {
            status,
            etag: etag.map(ToString::to_string),
            body: body.to_vec(),
        }
    }

    fn sync_item(id: &str, title: &str, wall_ms: i64) -> PasteboardItem {
        PasteboardItem {
            id: id.to_string(),
            kind: atools_core::PasteboardItemKind::Text,
            title: Some(title.to_string()),
            source_app: None,
            source_device_id: "atools-test".to_string(),
            copied_at: "2026-07-16T00:00:00Z".to_string(),
            updated_at: "2026-07-16T00:00:00Z".to_string(),
            content_fingerprint: format!("fingerprint-{id}"),
            payload: atools_core::PasteboardPayload {
                revision: format!("payload-{id}"),
                text: Some("hello".to_string()),
                ..Default::default()
            },
            ocr_text: None,
            pinboard_id: None,
            pinboard_order_key: None,
            pinned: false,
            field_clocks: BTreeMap::from([(
                "title".to_string(),
                HybridLogicalClock {
                    wall_ms,
                    counter: 0,
                    device_id: "atools-test".to_string(),
                },
            )]),
        }
    }

    fn sync_blob_item(id: &str, blob_id: &str, media_type: &str) -> PasteboardItem {
        let mut item = sync_item(id, "image", 10);
        item.kind = atools_core::PasteboardItemKind::Image;
        item.payload.text = None;
        item.payload.blob_id = Some(blob_id.to_string());
        item.payload.media_type = Some(media_type.to_string());
        item.field_clocks.insert(
            "payload".to_string(),
            HybridLogicalClock {
                wall_ms: 10,
                counter: 0,
                device_id: "atools-test".to_string(),
            },
        );
        item
    }

    fn encrypted_empty_index(key: &[u8; KEY_BYTES]) -> Vec<u8> {
        encrypted_index(key, Vec::new()).unwrap()
    }

    #[test]
    fn encrypts_blob_bytes_without_json_coercion() {
        let key = [7_u8; KEY_BYTES];
        let bytes = [0_u8, 255, 1, 2, 3, 0];
        let descriptor = blob_descriptor(&key, "blob-test", &bytes).unwrap();
        let envelope = encrypt_bytes(&key, &descriptor, &bytes).unwrap();
        assert_eq!(decrypt_envelope_bytes(&key, &envelope).unwrap(), bytes);
        assert!(decrypt_envelope(&key, &envelope).is_err());
    }

    #[tokio::test]
    async fn uploads_referenced_blob_before_publishing_the_index() {
        let key = [8_u8; KEY_BYTES];
        let blob_dir = tempfile::tempdir().unwrap();
        let relative_path = "blobs/aa/blob.png";
        std::fs::create_dir_all(blob_dir.path().join("blobs/aa")).unwrap();
        let bytes = vec![1_u8, 2, 3, 4];
        std::fs::write(blob_dir.path().join(relative_path), &bytes).unwrap();
        let digest = hex::encode(Sha256::digest(&bytes));
        let db = Database::in_memory().unwrap();
        db.upsert_pasteboard_blob(&PasteboardBlob {
            id: "blob-test".to_string(),
            keyed_fingerprint: format!("sha256:{digest}"),
            relative_path: relative_path.to_string(),
            media_type: "image/png".to_string(),
            byte_length: bytes.len() as u64,
            created_at: "2026-07-16T00:00:00Z".to_string(),
            last_accessed_at: "2026-07-16T00:00:00Z".to_string(),
            remote_available: false,
            sync_state: "local".to_string(),
            metadata: Value::Null,
        })
        .unwrap();
        db.upsert_pasteboard_item(&sync_blob_item("item-image", "blob-test", "image/png"))
            .unwrap();
        let transport = MockTransport {
            responses: Mutex::new(VecDeque::from([
                response(404, None, b""),
                response(201, None, b""),
                response(201, None, b""),
                response(201, Some("\"index\""), b""),
            ])),
            requests: Mutex::new(Vec::new()),
        };
        let result = sync_pasteboard_vault(&db, blob_dir.path(), &transport, &key)
            .await
            .unwrap();
        assert_eq!(result.status, "success");
        let requests = transport.requests.lock().unwrap();
        let blob_put = requests
            .iter()
            .position(|request| request.method == "PUT" && request.path.contains("/blob/"))
            .unwrap();
        let index_put = requests
            .iter()
            .position(|request| request.method == "PUT" && request.path == "index.enc")
            .unwrap();
        assert!(blob_put < index_put);
        assert!(
            db.get_pasteboard_blob("blob-test")
                .unwrap()
                .unwrap()
                .remote_available
        );
    }

    #[tokio::test]
    async fn retries_three_etag_conflicts_and_rebuilds_each_time() {
        let transport = MockTransport {
            responses: Mutex::new(VecDeque::from([
                response(200, Some("\"e0\""), b"remote-0"),
                response(412, None, b""),
                response(200, Some("\"e1\""), b"remote-1"),
                response(412, None, b""),
                response(200, Some("\"e2\""), b"remote-2"),
                response(412, None, b""),
                response(200, Some("\"e3\""), b"remote-3"),
                response(204, Some("\"final\""), b""),
            ])),
            requests: Mutex::new(Vec::new()),
        };
        let mut builds = 0;
        let result = update_encrypted_index(&transport, |remote| {
            builds += 1;
            let mut body = remote.unwrap_or_default().to_vec();
            body.extend_from_slice(b"+local");
            Ok(body)
        })
        .await
        .unwrap();
        assert_eq!(result.retries, 3);
        assert_eq!(builds, 4);
        let requests = transport.requests.lock().unwrap();
        let puts = requests
            .iter()
            .filter(|request| request.method == "PUT")
            .collect::<Vec<_>>();
        assert_eq!(puts.len(), 4);
        assert_eq!(puts[0].headers.get("if-match").unwrap(), "\"e0\"");
        assert_eq!(puts[3].headers.get("if-match").unwrap(), "\"e3\"");
    }

    #[tokio::test]
    async fn failed_index_authentication_performs_no_put() {
        let transport = MockTransport {
            responses: Mutex::new(VecDeque::from([response(
                200,
                Some("\"existing\""),
                b"encrypted-index",
            )])),
            requests: Mutex::new(Vec::new()),
        };
        assert!(
            update_encrypted_index(&transport, |_| { Err("wrong password".to_string()) })
                .await
                .is_err()
        );
        assert!(transport
            .requests
            .lock()
            .unwrap()
            .iter()
            .all(|request| request.method != "PUT"));
    }

    #[test]
    fn field_clocks_merge_concurrent_item_edits() {
        let left = sync_item("item-1", "left", 10);
        let mut right = sync_item("item-1", "right", 20);
        right.pinboard_id = Some("board-1".to_string());
        right.pinboard_order_key = Some("a0".to_string());
        right.field_clocks.insert(
            "pinboardId".to_string(),
            HybridLogicalClock {
                wall_ms: 15,
                counter: 0,
                device_id: "remote".to_string(),
            },
        );
        right.field_clocks.insert(
            "pinboardOrderKey".to_string(),
            HybridLogicalClock {
                wall_ms: 15,
                counter: 1,
                device_id: "remote".to_string(),
            },
        );
        let merged = merge_items(&left, &right).unwrap();
        assert_eq!(merged.title.as_deref(), Some("right"));
        assert_eq!(merged.pinboard_id.as_deref(), Some("board-1"));
    }

    #[tokio::test]
    async fn wrong_vault_key_never_writes_remote_objects_or_index() {
        let fixture = fixture();
        let correct_key =
            derive_vault_key(&fixture.password, &hex::decode(&fixture.salt_hex).unwrap()).unwrap();
        let transport = MockTransport {
            responses: Mutex::new(VecDeque::from([response(
                200,
                Some("\"existing\""),
                &encrypted_empty_index(&correct_key),
            )])),
            requests: Mutex::new(Vec::new()),
        };
        let db = Database::in_memory().unwrap();
        let blob_dir = tempfile::tempdir().unwrap();
        assert!(
            sync_pasteboard_vault(&db, blob_dir.path(), &transport, &[9_u8; KEY_BYTES])
                .await
                .is_err()
        );
        assert!(transport
            .requests
            .lock()
            .unwrap()
            .iter()
            .all(|request| request.method != "PUT"));
    }

    #[tokio::test]
    async fn partial_object_upload_leaves_authoritative_index_untouched() {
        let fixture = fixture();
        let key =
            derive_vault_key(&fixture.password, &hex::decode(&fixture.salt_hex).unwrap()).unwrap();
        let transport = MockTransport {
            responses: Mutex::new(VecDeque::from([
                response(404, None, b""),
                response(503, None, b""),
            ])),
            requests: Mutex::new(Vec::new()),
        };
        let db = Database::in_memory().unwrap();
        db.upsert_pasteboard_item(&sync_item("item-1", "hello", 10))
            .unwrap();
        let blob_dir = tempfile::tempdir().unwrap();
        let result = sync_pasteboard_vault(&db, blob_dir.path(), &transport, &key)
            .await
            .unwrap();
        assert_eq!(result.status, "partial");
        assert_eq!(result.failed_object_ids, vec!["item-1"]);
        assert!(transport
            .requests
            .lock()
            .unwrap()
            .iter()
            .all(|request| !(request.method == "PUT" && request.path == "index.enc")));
    }
}
