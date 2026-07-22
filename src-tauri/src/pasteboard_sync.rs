//! Encrypted WebDAV replication for the native Paste clipboard store.

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use atools_core::{
    AppConfig, Database, PasteboardBlob, PasteboardItem, PasteboardPinboard, PasteboardTombstone,
};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use rand::RngCore;
use reqwest::{Client, Method, StatusCode};
use scrypt::{scrypt, Params as ScryptParams};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};

use crate::webdav::WebdavSyncConfig;

const VAULT_VERSION: u32 = 1;
const VAULT_DIRECTORY: &str = "pasteboard-v1";
const SNAPSHOT_FILE: &str = "snapshot.enc";
const VAULT_FILE: &str = "vault.json";
const MAX_SNAPSHOT_BYTES: usize = 32 * 1024 * 1024;
const MAX_BLOB_BYTES: usize = 100 * 1024 * 1024;
const SYNC_PAGE_SIZE: usize = 500;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct VaultMetadata {
    version: u32,
    kdf: VaultKdf,
    cipher: VaultCipher,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct VaultKdf {
    name: String,
    salt: String,
    #[serde(rename = "N")]
    n: u32,
    r: u32,
    p: u32,
    #[serde(rename = "keyLength")]
    key_length: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct VaultCipher {
    name: String,
    nonce_length: u32,
    tag_length: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VaultEnvelope {
    version: u32,
    object_type: String,
    object_id: String,
    revision: String,
    nonce: String,
    ciphertext: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PasteboardSyncMetadata {
    version: u32,
    generated_at: String,
    source_device_id: String,
    items: Vec<PasteboardItem>,
    pinboards: Vec<PasteboardPinboard>,
    tombstones: Vec<PasteboardTombstone>,
    blobs: Vec<PasteboardBlob>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PasteboardSyncResult {
    pub status: String,
    pub items: usize,
    pub pinboards: usize,
    pub blobs: usize,
    pub uploaded_blobs: usize,
    pub downloaded_blobs: usize,
    pub retries: usize,
    pub duration_ms: u64,
}

struct RemoteFile {
    bytes: Vec<u8>,
    etag: Option<String>,
}

pub async fn sync_pasteboard_vault(
    db: &Database,
    app_config: &AppConfig,
    config: WebdavSyncConfig,
) -> Result<PasteboardSyncResult, String> {
    crate::webdav::validate_webdav_config(&config)?;
    if config.password.is_empty() {
        return Err("WebDAV password is required for encrypted Paste sync".into());
    }
    let started = Instant::now();
    let client = webdav_client(&config)?;
    let remote_path = pasteboard_remote_path(&config.remote_path);
    ensure_remote_directories(&client, &config, &remote_path).await?;
    let metadata = ensure_vault_metadata(&client, &config, &remote_path).await?;
    let key = derive_key(&config.password, &metadata)?;
    let mut uploaded_blobs = 0;
    let mut downloaded_blobs = 0;

    for attempt in 0..3 {
        let local = local_metadata(db)?;
        let remote_file = get_remote_file(&client, &config, &remote_path, SNAPSHOT_FILE).await?;
        let remote = match remote_file.as_ref() {
            Some(file) => decrypt_metadata(&key, &file.bytes)?,
            None => empty_metadata(&local.source_device_id),
        };
        let merged = merge_metadata(local.clone(), remote)?;

        uploaded_blobs += upload_local_blobs(
            &client,
            &config,
            &remote_path,
            app_config,
            &key,
            &local.blobs,
        )
        .await?;
        downloaded_blobs += download_missing_blobs(
            &client,
            &config,
            &remote_path,
            app_config,
            db,
            &key,
            &merged.blobs,
        )
        .await?;
        apply_metadata(db, &merged)?;

        let body = encrypt_metadata(&key, &merged)?;
        let status = put_remote_file(
            &client,
            &config,
            &remote_path,
            SNAPSHOT_FILE,
            body,
            remote_file.as_ref().and_then(|file| file.etag.as_deref()),
            remote_file.is_none(),
        )
        .await?;
        if status == StatusCode::PRECONDITION_FAILED {
            if attempt == 2 {
                return Err("Paste WebDAV sync conflicted after three retries".into());
            }
            continue;
        }
        if !status.is_success() {
            return Err(format!(
                "Paste WebDAV snapshot upload failed: HTTP {}",
                status.as_u16()
            ));
        }
        return Ok(PasteboardSyncResult {
            status: "success".into(),
            items: merged.items.len(),
            pinboards: merged.pinboards.len(),
            blobs: merged.blobs.len(),
            uploaded_blobs,
            downloaded_blobs,
            retries: attempt,
            duration_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
        });
    }
    unreachable!("bounded Paste sync retry loop returns on every terminal state")
}

fn empty_metadata(device_id: &str) -> PasteboardSyncMetadata {
    PasteboardSyncMetadata {
        version: VAULT_VERSION,
        generated_at: atools_core::utils::now_iso(),
        source_device_id: device_id.to_string(),
        items: Vec::new(),
        pinboards: Vec::new(),
        tombstones: Vec::new(),
        blobs: Vec::new(),
    }
}

fn local_metadata(db: &Database) -> Result<PasteboardSyncMetadata, String> {
    let source_device_id = db
        .get_setting("pasteboard.device_id")
        .map_err(|error| error.to_string())?
        .unwrap_or_else(|| "unknown-device".into());
    let mut items = Vec::new();
    let mut offset = 0;
    loop {
        let page = db
            .search_pasteboard_items("", None, &[], SYNC_PAGE_SIZE, offset)
            .map_err(|error| error.to_string())?;
        let count = page.len();
        items.extend(page);
        if count < SYNC_PAGE_SIZE {
            break;
        }
        offset += count;
    }
    let mut blob_ids = BTreeSet::new();
    for item in &items {
        blob_ids.extend(item_blob_ids(item));
    }
    let mut blobs = Vec::new();
    for id in blob_ids {
        if let Some(blob) = db
            .get_pasteboard_blob(&id)
            .map_err(|error| error.to_string())?
        {
            blobs.push(blob);
        }
    }
    Ok(PasteboardSyncMetadata {
        version: VAULT_VERSION,
        generated_at: atools_core::utils::now_iso(),
        source_device_id,
        items,
        pinboards: db
            .list_pasteboard_pinboards()
            .map_err(|error| error.to_string())?,
        tombstones: db
            .list_pasteboard_tombstones()
            .map_err(|error| error.to_string())?,
        blobs,
    })
}

fn merge_metadata(
    local: PasteboardSyncMetadata,
    remote: PasteboardSyncMetadata,
) -> Result<PasteboardSyncMetadata, String> {
    if local.version != VAULT_VERSION || remote.version != VAULT_VERSION {
        return Err("Paste sync metadata schema is unsupported".into());
    }
    let mut items = BTreeMap::new();
    for item in local.items.into_iter().chain(remote.items) {
        merge_latest(&mut items, item.id.clone(), item, |item| &item.updated_at)?;
    }
    let mut pinboards = BTreeMap::new();
    for pinboard in local.pinboards.into_iter().chain(remote.pinboards) {
        merge_latest(&mut pinboards, pinboard.id.clone(), pinboard, |pinboard| {
            &pinboard.updated_at
        })?;
    }
    let mut tombstones = BTreeMap::new();
    for tombstone in local.tombstones.into_iter().chain(remote.tombstones) {
        let key = format!("{}\0{}", tombstone.entity_kind, tombstone.entity_id);
        merge_latest(&mut tombstones, key, tombstone, |tombstone| {
            &tombstone.deleted_at
        })?;
    }
    tombstones.retain(|_, tombstone| match tombstone.entity_kind.as_str() {
        "paste_item" => items
            .get(&tombstone.entity_id)
            .is_none_or(|item| tombstone.deleted_at >= item.updated_at),
        "pinboard" => pinboards
            .get(&tombstone.entity_id)
            .is_none_or(|pinboard| tombstone.deleted_at >= pinboard.updated_at),
        _ => true,
    });
    for tombstone in tombstones.values() {
        match tombstone.entity_kind.as_str() {
            "paste_item" => {
                items.remove(&tombstone.entity_id);
            }
            "pinboard" => {
                pinboards.remove(&tombstone.entity_id);
                for item in items.values_mut() {
                    if item.pinboard_id.as_deref() == Some(tombstone.entity_id.as_str()) {
                        item.pinboard_id = None;
                        item.pinboard_order_key = None;
                    }
                }
            }
            _ => {}
        }
    }
    let mut blobs: BTreeMap<String, PasteboardBlob> = BTreeMap::new();
    for blob in local.blobs.into_iter().chain(remote.blobs) {
        if let Some(existing) = blobs.get(&blob.id) {
            if existing.content_hash != blob.content_hash
                || existing.byte_size != blob.byte_size
                || existing.media_type != blob.media_type
            {
                return Err(format!(
                    "Paste sync blob {} has conflicting metadata",
                    blob.id
                ));
            }
        } else {
            blobs.insert(blob.id.clone(), blob);
        }
    }
    let referenced = items
        .values()
        .flat_map(item_blob_ids)
        .collect::<BTreeSet<_>>();
    blobs.retain(|id, _| referenced.contains(id));
    Ok(PasteboardSyncMetadata {
        version: VAULT_VERSION,
        generated_at: atools_core::utils::now_iso(),
        source_device_id: local.source_device_id,
        items: items.into_values().collect(),
        pinboards: pinboards.into_values().collect(),
        tombstones: tombstones.into_values().collect(),
        blobs: blobs.into_values().collect(),
    })
}

fn merge_latest<T: Serialize>(
    values: &mut BTreeMap<String, T>,
    key: String,
    candidate: T,
    updated_at: impl Fn(&T) -> &str,
) -> Result<(), String> {
    let replace = match values.get(&key) {
        None => true,
        Some(existing) => {
            let candidate_time = updated_at(&candidate);
            let existing_time = updated_at(existing);
            candidate_time > existing_time
                || (candidate_time == existing_time
                    && serde_json::to_vec(&candidate).map_err(|error| error.to_string())?
                        > serde_json::to_vec(existing).map_err(|error| error.to_string())?)
        }
    };
    if replace {
        values.insert(key, candidate);
    }
    Ok(())
}

fn apply_metadata(db: &Database, metadata: &PasteboardSyncMetadata) -> Result<(), String> {
    let merged_tombstones = metadata
        .tombstones
        .iter()
        .map(|value| format!("{}\0{}", value.entity_kind, value.entity_id))
        .collect::<BTreeSet<_>>();
    for current in db
        .list_pasteboard_tombstones()
        .map_err(|error| error.to_string())?
    {
        let key = format!("{}\0{}", current.entity_kind, current.entity_id);
        if !merged_tombstones.contains(&key) {
            db.delete_pasteboard_tombstone(&current.entity_id, &current.entity_kind)
                .map_err(|error| error.to_string())?;
        }
    }
    for tombstone in &metadata.tombstones {
        match tombstone.entity_kind.as_str() {
            "paste_item" => {
                db.delete_pasteboard_item(&tombstone.entity_id)
                    .map_err(|error| error.to_string())?;
            }
            "pinboard" => {
                db.delete_pasteboard_pinboard(&tombstone.entity_id)
                    .map_err(|error| error.to_string())?;
            }
            _ => {}
        }
        db.upsert_pasteboard_tombstone(tombstone)
            .map_err(|error| error.to_string())?;
    }
    for pinboard in &metadata.pinboards {
        db.upsert_pasteboard_pinboard(pinboard)
            .map_err(|error| error.to_string())?;
        let _ = db.delete_pasteboard_tombstone(&pinboard.id, "pinboard");
    }
    for item in &metadata.items {
        db.upsert_pasteboard_item(item)
            .map_err(|error| error.to_string())?;
        let blob_ids = item_blob_ids(item).into_iter().collect::<Vec<_>>();
        db.replace_pasteboard_item_blobs(&item.id, &blob_ids)
            .map_err(|error| error.to_string())?;
        let _ = db.delete_pasteboard_tombstone(&item.id, "paste_item");
    }
    Ok(())
}

fn item_blob_ids(item: &PasteboardItem) -> BTreeSet<String> {
    [
        "richTextBlobId",
        "imageBlobId",
        "thumbnailBlobId",
        "pdfBlobId",
    ]
    .into_iter()
    .filter_map(|key| item.payload.get(key).and_then(serde_json::Value::as_str))
    .map(str::to_string)
    .collect()
}

async fn upload_local_blobs(
    client: &Client,
    config: &WebdavSyncConfig,
    remote_path: &str,
    app_config: &AppConfig,
    key: &[u8; 32],
    blobs: &[PasteboardBlob],
) -> Result<usize, String> {
    let mut uploaded = 0;
    for blob in blobs {
        let blob_remote_path = format!("{remote_path}/blobs");
        let blob_file_name = format!("{}.enc", safe_object_id(&blob.id)?);
        if remote_file_exists(client, config, &blob_remote_path, &blob_file_name).await? {
            continue;
        }
        let path = managed_blob_path(app_config, blob)?;
        let bytes = tokio::fs::read(&path)
            .await
            .map_err(|error| format!("Failed to read Paste blob {}: {error}", blob.id))?;
        validate_blob_bytes(blob, &bytes)?;
        let envelope = encrypt_object(key, "blob", &blob.id, &blob.content_hash, &bytes)?;
        let body = serde_json::to_vec(&envelope).map_err(|error| error.to_string())?;
        let status = put_remote_file(
            client,
            config,
            &blob_remote_path,
            &blob_file_name,
            body,
            None,
            true,
        )
        .await?;
        if status.is_success() {
            uploaded += 1;
        } else if status != StatusCode::PRECONDITION_FAILED {
            return Err(format!(
                "Paste blob upload failed for {}: HTTP {}",
                blob.id,
                status.as_u16()
            ));
        }
    }
    Ok(uploaded)
}

async fn remote_file_exists(
    client: &Client,
    config: &WebdavSyncConfig,
    remote_path: &str,
    file_name: &str,
) -> Result<bool, String> {
    let url = crate::webdav::webdav_file_url(&config.url, remote_path, file_name)?;
    let status = client
        .head(url)
        .basic_auth(&config.username, Some(&config.password))
        .send()
        .await
        .map_err(|error| error.to_string())?
        .status();
    match status {
        StatusCode::OK | StatusCode::NO_CONTENT => Ok(true),
        StatusCode::NOT_FOUND | StatusCode::METHOD_NOT_ALLOWED => Ok(false),
        StatusCode::UNAUTHORIZED => Err("Paste WebDAV authentication failed".into()),
        status if status.is_success() => Ok(true),
        status => Err(format!(
            "Paste WebDAV attachment probe failed: HTTP {}",
            status.as_u16()
        )),
    }
}

async fn download_missing_blobs(
    client: &Client,
    config: &WebdavSyncConfig,
    remote_path: &str,
    app_config: &AppConfig,
    db: &Database,
    key: &[u8; 32],
    blobs: &[PasteboardBlob],
) -> Result<usize, String> {
    let mut downloaded = 0;
    for blob in blobs {
        let destination = managed_blob_path(app_config, blob)?;
        if destination.is_file() {
            db.upsert_pasteboard_blob(blob)
                .map_err(|error| error.to_string())?;
            continue;
        }
        let remote = get_remote_file(
            client,
            config,
            &format!("{remote_path}/blobs"),
            &format!("{}.enc", safe_object_id(&blob.id)?),
        )
        .await?
        .ok_or_else(|| format!("Remote Paste blob is missing: {}", blob.id))?;
        let envelope: VaultEnvelope =
            serde_json::from_slice(&remote.bytes).map_err(|error| error.to_string())?;
        let bytes = decrypt_object(key, &envelope, "blob", &blob.id, &blob.content_hash)?;
        validate_blob_bytes(blob, &bytes)?;
        if let Some(parent) = destination.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|error| error.to_string())?;
        }
        let temporary = destination.with_extension(format!("sync-{}.tmp", uuid::Uuid::new_v4()));
        tokio::fs::write(&temporary, &bytes)
            .await
            .map_err(|error| error.to_string())?;
        tokio::fs::rename(&temporary, &destination)
            .await
            .map_err(|error| error.to_string())?;
        db.upsert_pasteboard_blob(blob)
            .map_err(|error| error.to_string())?;
        downloaded += 1;
    }
    Ok(downloaded)
}

fn managed_blob_path(app_config: &AppConfig, blob: &PasteboardBlob) -> Result<PathBuf, String> {
    let relative = Path::new(&blob.relative_path);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(format!("Paste blob path is unsafe: {}", blob.relative_path));
    }
    Ok(app_config.pasteboard_blobs_dir().join(relative))
}

fn validate_blob_bytes(blob: &PasteboardBlob, bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > MAX_BLOB_BYTES {
        return Err(format!("Paste blob {} exceeds 100 MiB", blob.id));
    }
    if bytes.len() as u64 != blob.byte_size {
        return Err(format!(
            "Paste blob {} size does not match metadata",
            blob.id
        ));
    }
    let hash = format!("{:x}", Sha256::digest(bytes));
    if hash != blob.content_hash {
        return Err(format!(
            "Paste blob {} hash does not match metadata",
            blob.id
        ));
    }
    Ok(())
}

fn encrypt_metadata(key: &[u8; 32], metadata: &PasteboardSyncMetadata) -> Result<Vec<u8>, String> {
    let plaintext = serde_json::to_vec(metadata).map_err(|error| error.to_string())?;
    if plaintext.len() > MAX_SNAPSHOT_BYTES {
        return Err("Paste sync metadata exceeds 32 MiB".into());
    }
    let revision = format!("{:x}", Sha256::digest(&plaintext));
    let envelope = encrypt_object(key, "index", "main", &revision, &plaintext)?;
    serde_json::to_vec(&envelope).map_err(|error| error.to_string())
}

fn decrypt_metadata(key: &[u8; 32], bytes: &[u8]) -> Result<PasteboardSyncMetadata, String> {
    if bytes.len() > MAX_SNAPSHOT_BYTES + 4096 {
        return Err("Remote Paste sync metadata exceeds the size limit".into());
    }
    let envelope: VaultEnvelope =
        serde_json::from_slice(bytes).map_err(|_| "Remote Paste sync envelope is corrupted")?;
    let revision = envelope.revision.clone();
    let plaintext = decrypt_object(key, &envelope, "index", "main", &revision)
        .map_err(|_| "Paste sync password is incorrect or remote data is corrupted")?;
    if format!("{:x}", Sha256::digest(&plaintext)) != revision {
        return Err("Remote Paste sync metadata revision is invalid".into());
    }
    let metadata: PasteboardSyncMetadata =
        serde_json::from_slice(&plaintext).map_err(|error| error.to_string())?;
    if metadata.version != VAULT_VERSION {
        return Err("Remote Paste sync schema is newer than this application".into());
    }
    Ok(metadata)
}

fn encrypt_object(
    key: &[u8; 32],
    object_type: &str,
    object_id: &str,
    revision: &str,
    plaintext: &[u8],
) -> Result<VaultEnvelope, String> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|error| error.to_string())?;
    let mut nonce = [0u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    let aad = object_aad(object_type, object_id, revision);
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad: &aad,
            },
        )
        .map_err(|_| "Failed to encrypt Paste sync object".to_string())?;
    Ok(VaultEnvelope {
        version: VAULT_VERSION,
        object_type: object_type.to_string(),
        object_id: object_id.to_string(),
        revision: revision.to_string(),
        nonce: STANDARD.encode(nonce),
        ciphertext: STANDARD.encode(ciphertext),
    })
}

fn decrypt_object(
    key: &[u8; 32],
    envelope: &VaultEnvelope,
    object_type: &str,
    object_id: &str,
    revision: &str,
) -> Result<Vec<u8>, String> {
    if envelope.version != VAULT_VERSION
        || envelope.object_type != object_type
        || envelope.object_id != object_id
        || envelope.revision != revision
    {
        return Err("Paste sync object descriptor is invalid".into());
    }
    let nonce = STANDARD
        .decode(&envelope.nonce)
        .map_err(|_| "Paste sync nonce is invalid")?;
    if nonce.len() != 12 {
        return Err("Paste sync nonce must be 12 bytes".into());
    }
    let ciphertext = STANDARD
        .decode(&envelope.ciphertext)
        .map_err(|_| "Paste sync ciphertext is invalid")?;
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|error| error.to_string())?;
    let aad = object_aad(object_type, object_id, revision);
    cipher
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad: &aad,
            },
        )
        .map_err(|_| "Paste sync authentication failed".into())
}

fn object_aad(object_type: &str, object_id: &str, revision: &str) -> Vec<u8> {
    format!("{VAULT_VERSION}\0{object_type}\0{object_id}\0{revision}").into_bytes()
}

fn new_vault_metadata() -> VaultMetadata {
    let mut salt = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut salt);
    VaultMetadata {
        version: VAULT_VERSION,
        kdf: VaultKdf {
            name: "scrypt".into(),
            salt: STANDARD.encode(salt),
            n: 32_768,
            r: 8,
            p: 1,
            key_length: 32,
        },
        cipher: VaultCipher {
            name: "AES-256-GCM".into(),
            nonce_length: 12,
            tag_length: 16,
        },
    }
}

fn validate_vault_metadata(metadata: &VaultMetadata) -> Result<(), String> {
    if metadata.version != VAULT_VERSION
        || metadata.kdf.name != "scrypt"
        || metadata.kdf.n != 32_768
        || metadata.kdf.r != 8
        || metadata.kdf.p != 1
        || metadata.kdf.key_length != 32
        || metadata.cipher.name != "AES-256-GCM"
        || metadata.cipher.nonce_length != 12
        || metadata.cipher.tag_length != 16
    {
        return Err("Paste sync vault parameters are unsupported".into());
    }
    let salt = STANDARD
        .decode(&metadata.kdf.salt)
        .map_err(|_| "Paste sync vault salt is invalid")?;
    if salt.len() < 16 {
        return Err("Paste sync vault salt is too short".into());
    }
    Ok(())
}

fn derive_key(password: &str, metadata: &VaultMetadata) -> Result<[u8; 32], String> {
    validate_vault_metadata(metadata)?;
    let salt = STANDARD
        .decode(&metadata.kdf.salt)
        .map_err(|_| "Paste sync vault salt is invalid")?;
    let params = ScryptParams::new(15, 8, 1, 32).map_err(|error| error.to_string())?;
    let mut key = [0u8; 32];
    scrypt(password.as_bytes(), &salt, &params, &mut key).map_err(|error| error.to_string())?;
    Ok(key)
}

async fn ensure_vault_metadata(
    client: &Client,
    config: &WebdavSyncConfig,
    remote_path: &str,
) -> Result<VaultMetadata, String> {
    if let Some(file) = get_remote_file(client, config, remote_path, VAULT_FILE).await? {
        let metadata = serde_json::from_slice(&file.bytes).map_err(|error| error.to_string())?;
        validate_vault_metadata(&metadata)?;
        return Ok(metadata);
    }
    let metadata = new_vault_metadata();
    let bytes = serde_json::to_vec(&metadata).map_err(|error| error.to_string())?;
    let status =
        put_remote_file(client, config, remote_path, VAULT_FILE, bytes, None, true).await?;
    if status.is_success() {
        return Ok(metadata);
    }
    if status == StatusCode::PRECONDITION_FAILED {
        let file = get_remote_file(client, config, remote_path, VAULT_FILE)
            .await?
            .ok_or_else(|| "Paste sync vault creation raced without a remote vault".to_string())?;
        let metadata = serde_json::from_slice(&file.bytes).map_err(|error| error.to_string())?;
        validate_vault_metadata(&metadata)?;
        return Ok(metadata);
    }
    Err(format!(
        "Paste sync vault creation failed: HTTP {}",
        status.as_u16()
    ))
}

async fn ensure_remote_directories(
    client: &Client,
    config: &WebdavSyncConfig,
    remote_path: &str,
) -> Result<(), String> {
    for path in [remote_path.to_string(), format!("{remote_path}/blobs")] {
        for url in crate::webdav::webdav_directory_urls(&config.url, &path)? {
            let status = client
                .request(
                    Method::from_bytes(b"MKCOL").map_err(|error| error.to_string())?,
                    url,
                )
                .basic_auth(&config.username, Some(&config.password))
                .send()
                .await
                .map_err(|error| error.to_string())?
                .status();
            if !(status.is_success()
                || status == StatusCode::METHOD_NOT_ALLOWED
                || status == StatusCode::CONFLICT)
            {
                return Err(format!(
                    "Paste WebDAV MKCOL failed: HTTP {}",
                    status.as_u16()
                ));
            }
        }
    }
    Ok(())
}

async fn get_remote_file(
    client: &Client,
    config: &WebdavSyncConfig,
    remote_path: &str,
    file_name: &str,
) -> Result<Option<RemoteFile>, String> {
    let url = crate::webdav::webdav_file_url(&config.url, remote_path, file_name)?;
    let response = client
        .get(url)
        .basic_auth(&config.username, Some(&config.password))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if response.status() == StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if response.status() == StatusCode::UNAUTHORIZED {
        return Err("Paste WebDAV authentication failed".into());
    }
    if !response.status().is_success() {
        return Err(format!(
            "Paste WebDAV download failed: HTTP {}",
            response.status().as_u16()
        ));
    }
    let etag = response
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    let bytes = response
        .bytes()
        .await
        .map_err(|error| error.to_string())?
        .to_vec();
    Ok(Some(RemoteFile { bytes, etag }))
}

async fn put_remote_file(
    client: &Client,
    config: &WebdavSyncConfig,
    remote_path: &str,
    file_name: &str,
    body: Vec<u8>,
    etag: Option<&str>,
    create_only: bool,
) -> Result<StatusCode, String> {
    let url = crate::webdav::webdav_file_url(&config.url, remote_path, file_name)?;
    let mut request = client
        .put(url)
        .basic_auth(&config.username, Some(&config.password))
        .header(reqwest::header::CONTENT_TYPE, "application/octet-stream");
    if let Some(etag) = etag {
        request = request.header(reqwest::header::IF_MATCH, etag);
    } else if create_only {
        request = request.header(reqwest::header::IF_NONE_MATCH, "*");
    }
    Ok(request
        .body(body)
        .send()
        .await
        .map_err(|error| error.to_string())?
        .status())
}

fn webdav_client(config: &WebdavSyncConfig) -> Result<Client, String> {
    let mut builder = Client::builder().timeout(Duration::from_secs(60));
    if let Some(proxy) = config
        .proxy_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        builder = builder.proxy(reqwest::Proxy::all(proxy).map_err(|error| error.to_string())?);
    }
    builder.build().map_err(|error| error.to_string())
}

fn pasteboard_remote_path(remote_path: &str) -> String {
    let remote_path = remote_path.trim_matches('/');
    if remote_path.is_empty() {
        VAULT_DIRECTORY.into()
    } else {
        format!("{remote_path}/{VAULT_DIRECTORY}")
    }
}

fn safe_object_id(value: &str) -> Result<&str, String> {
    if value.is_empty()
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("Paste sync object ID is unsafe".into());
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use atools_core::{PasteboardItemKind, PasteboardSourceApp};

    fn item(id: &str, updated_at: &str, text: &str) -> PasteboardItem {
        PasteboardItem {
            id: id.into(),
            kind: PasteboardItemKind::Text,
            title: None,
            source_app: Some(PasteboardSourceApp {
                bundle_id: Some("dev.atools.test".into()),
                name: Some("Test".into()),
            }),
            source_device_id: "device".into(),
            copied_at: updated_at.into(),
            updated_at: updated_at.into(),
            content_fingerprint: format!("hash-{id}-{text}"),
            payload: serde_json::json!({"text": text}),
            ocr_text: None,
            pinboard_id: None,
            pinboard_order_key: None,
            pinned: false,
            field_clocks: serde_json::json!({}),
        }
    }

    fn metadata(items: Vec<PasteboardItem>) -> PasteboardSyncMetadata {
        PasteboardSyncMetadata {
            version: VAULT_VERSION,
            generated_at: "2026-07-21T00:00:00Z".into(),
            source_device_id: "device".into(),
            items,
            pinboards: Vec::new(),
            tombstones: Vec::new(),
            blobs: Vec::new(),
        }
    }

    #[test]
    fn encryption_round_trip_rejects_wrong_key_and_corruption() {
        let vault = new_vault_metadata();
        let key = derive_key("correct horse", &vault).unwrap();
        let wrong = derive_key("wrong horse", &vault).unwrap();
        let value = metadata(vec![item("item-1", "2026-07-21T00:00:00Z", "hello")]);
        let encoded = encrypt_metadata(&key, &value).unwrap();
        assert_eq!(decrypt_metadata(&key, &encoded).unwrap().items.len(), 1);
        assert!(decrypt_metadata(&wrong, &encoded).is_err());
        let mut corrupted = encoded;
        *corrupted.last_mut().unwrap() ^= 1;
        assert!(decrypt_metadata(&key, &corrupted).is_err());
    }

    #[test]
    fn newer_entity_wins_and_newer_tombstone_deletes_it() {
        let local = metadata(vec![item("item-1", "2026-07-21T00:00:00Z", "old")]);
        let mut remote = metadata(vec![item("item-1", "2026-07-21T01:00:00Z", "new")]);
        remote.tombstones.push(PasteboardTombstone {
            entity_id: "item-1".into(),
            entity_kind: "paste_item".into(),
            deleted_at: "2026-07-21T02:00:00Z".into(),
            deleted_clock: serde_json::json!({}),
            source_device_id: "remote".into(),
        });
        let merged = merge_metadata(local, remote).unwrap();
        assert!(merged.items.is_empty());
        assert_eq!(merged.tombstones.len(), 1);
    }

    #[test]
    fn newer_entity_revives_an_older_tombstone() {
        let mut local = metadata(vec![item("item-1", "2026-07-21T03:00:00Z", "revived")]);
        local.tombstones.push(PasteboardTombstone {
            entity_id: "item-1".into(),
            entity_kind: "paste_item".into(),
            deleted_at: "2026-07-21T02:00:00Z".into(),
            deleted_clock: serde_json::json!({}),
            source_device_id: "remote".into(),
        });
        let merged = merge_metadata(local, metadata(Vec::new())).unwrap();
        assert_eq!(merged.items.len(), 1);
        assert!(merged.tombstones.is_empty());
    }
}
