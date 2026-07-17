use atools_core::{
    AppConfig, Database, HybridLogicalClock, PasteboardBlob, PasteboardEntityType, PasteboardItem,
    PasteboardItemKind, PasteboardPayload, PasteboardSourceApp, PasteboardTombstone,
};
use image::{ImageFormat, ImageReader, Limits};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::io::Cursor;
use std::path::Path;
use std::sync::Arc;

const DEVICE_ID_SETTING_KEY: &str = "pasteboard-device-id";
const CAPTURE_PAUSED_SETTING_KEY: &str = "pasteboard-capture-paused";
const RETENTION_DAYS_SETTING_KEY: &str = "pasteboard-retention-days";
const BLOB_BUDGET_SETTING_KEY: &str = "pasteboard-blob-budget-bytes";
const PRIVACY_LITERALS_SETTING_KEY: &str = "pasteboard-privacy-literals";
const SCREEN_SHARE_PROTECTION_SETTING_KEY: &str = "pasteboard-screen-share-protection";
const DEFAULT_RETENTION_DAYS: u64 = 90;
const TOMBSTONE_RETENTION_DAYS: u64 = 180;
const DEFAULT_BLOB_BUDGET_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_CAPTURE_TEXT_BYTES: usize = 10 * 1024 * 1024;
const MAX_CAPTURE_BLOB_BYTES: usize = 100 * 1024 * 1024;
const MAX_CAPTURE_FILES: usize = 512;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PasteboardSnapshot {
    pub kind: PasteboardItemKind,
    pub text: Option<String>,
    pub html: Option<String>,
    pub bytes: Option<Vec<u8>>,
    pub media_type: Option<String>,
    pub file_paths: Option<Vec<String>>,
    pub source_bundle_id: Option<String>,
    pub transient: bool,
    pub concealed: bool,
}

impl PasteboardSnapshot {
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            kind: PasteboardItemKind::Text,
            text: Some(text.into()),
            html: None,
            bytes: None,
            media_type: None,
            file_paths: None,
            source_bundle_id: None,
            transient: false,
            concealed: false,
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CaptureOutcome {
    Captured(String),
    Duplicate,
    Empty,
    Paused,
    Sensitive,
    TooLarge,
}

#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PasteboardCaptureStatus {
    pub paused: bool,
    pub retention_days: u64,
    pub item_count: usize,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PasteboardPreferences {
    pub retention_days: u64,
    pub blob_budget_bytes: u64,
    pub privacy_literals: Vec<String>,
    pub screen_share_protection: bool,
}

#[derive(Clone)]
pub struct PasteboardRuntime {
    db: Arc<Database>,
    config: AppConfig,
}

impl PasteboardRuntime {
    pub fn new(db: Arc<Database>, config: AppConfig) -> Self {
        Self { db, config }
    }

    fn bool_setting(&self, key: &str, fallback: bool) -> Result<bool, String> {
        Ok(self
            .db
            .get_setting(key)
            .map_err(|error| error.to_string())?
            .map(|value| value == "true")
            .unwrap_or(fallback))
    }

    fn u64_setting(&self, key: &str, fallback: u64) -> Result<u64, String> {
        self.db
            .get_setting(key)
            .map_err(|error| error.to_string())?
            .map(|value| {
                value
                    .parse::<u64>()
                    .map_err(|_| format!("PasteboardPro setting {key} is invalid"))
            })
            .transpose()
            .map(|value| value.unwrap_or(fallback))
    }

    fn device_id(&self) -> Result<String, String> {
        if let Some(value) = self
            .db
            .get_setting(DEVICE_ID_SETTING_KEY)
            .map_err(|error| error.to_string())?
            .filter(|value| !value.trim().is_empty())
        {
            return Ok(value);
        }
        let value = format!("atools-{}", atools_core::utils::generate_rev());
        self.db
            .set_setting(DEVICE_ID_SETTING_KEY, &value)
            .map_err(|error| error.to_string())?;
        Ok(value)
    }

    pub fn status(&self) -> Result<PasteboardCaptureStatus, String> {
        Ok(PasteboardCaptureStatus {
            paused: self.bool_setting(CAPTURE_PAUSED_SETTING_KEY, false)?,
            retention_days: self.u64_setting(RETENTION_DAYS_SETTING_KEY, DEFAULT_RETENTION_DAYS)?,
            item_count: self
                .db
                .count_pasteboard_items()
                .map_err(|error| error.to_string())?,
        })
    }

    pub fn preferences(&self) -> Result<PasteboardPreferences, String> {
        Ok(PasteboardPreferences {
            retention_days: self.u64_setting(RETENTION_DAYS_SETTING_KEY, DEFAULT_RETENTION_DAYS)?,
            blob_budget_bytes: self
                .u64_setting(BLOB_BUDGET_SETTING_KEY, DEFAULT_BLOB_BUDGET_BYTES)?,
            privacy_literals: self.privacy_literals()?,
            screen_share_protection: self
                .bool_setting(SCREEN_SHARE_PROTECTION_SETTING_KEY, true)?,
        })
    }

    pub fn update_preferences(
        &self,
        mut preferences: PasteboardPreferences,
    ) -> Result<PasteboardPreferences, String> {
        if !(1..=3_650).contains(&preferences.retention_days) {
            return Err("PasteboardPro retention days must be between 1 and 3650".to_string());
        }
        if !(64 * 1024 * 1024..=100 * 1024 * 1024 * 1024).contains(&preferences.blob_budget_bytes) {
            return Err("PasteboardPro blob budget must be between 64 MiB and 100 GiB".to_string());
        }
        preferences.privacy_literals = preferences
            .privacy_literals
            .into_iter()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect();
        if preferences.privacy_literals.len() > 200
            || preferences
                .privacy_literals
                .iter()
                .any(|value| value.chars().count() > 256)
        {
            return Err(
                "PasteboardPro privacy literals allow at most 200 values of 256 characters"
                    .to_string(),
            );
        }
        self.db
            .set_setting(
                RETENTION_DAYS_SETTING_KEY,
                &preferences.retention_days.to_string(),
            )
            .map_err(|error| error.to_string())?;
        self.db
            .set_setting(
                BLOB_BUDGET_SETTING_KEY,
                &preferences.blob_budget_bytes.to_string(),
            )
            .map_err(|error| error.to_string())?;
        self.db
            .set_setting(
                PRIVACY_LITERALS_SETTING_KEY,
                &serde_json::to_string(&preferences.privacy_literals)
                    .map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())?;
        self.db
            .set_setting(
                SCREEN_SHARE_PROTECTION_SETTING_KEY,
                if preferences.screen_share_protection {
                    "true"
                } else {
                    "false"
                },
            )
            .map_err(|error| error.to_string())?;
        self.apply_retention()?;
        self.preferences()
    }

    pub fn set_paused(&self, paused: bool) -> Result<PasteboardCaptureStatus, String> {
        self.db
            .set_setting(
                CAPTURE_PAUSED_SETTING_KEY,
                if paused { "true" } else { "false" },
            )
            .map_err(|error| error.to_string())?;
        self.status()
    }

    pub fn capture_text(&self, text: &str) -> Result<CaptureOutcome, String> {
        let mut snapshot = PasteboardSnapshot::text(text);
        snapshot.kind = detect_kind(text);
        self.capture_snapshot(snapshot)
    }

    pub fn create_text_item(
        &self,
        text: &str,
        title: Option<&str>,
    ) -> Result<PasteboardItem, String> {
        validate_editable_text(text)?;
        if self.is_sensitive(text)? {
            return Err("PasteboardPro refused to save text matched by privacy rules".to_string());
        }
        let wall_ms = wall_ms()?;
        let device_id = self.device_id()?;
        let timestamp = atools_core::utils::now_iso();
        let id = format!("atools-created:{}", atools_core::utils::generate_rev());
        let normalized_title = normalized_item_title(title, text)?;
        let payload_revision = text_payload_revision(text);
        let mut fingerprint = Sha256::new();
        fingerprint.update(b"pasteboard-created-text\0");
        fingerprint.update(id.as_bytes());
        let content_fingerprint = format!("sha256:{}", hex::encode(fingerprint.finalize()));
        let clock = |counter| HybridLogicalClock {
            wall_ms,
            counter,
            device_id: device_id.clone(),
        };
        let item = PasteboardItem {
            id,
            kind: PasteboardItemKind::Text,
            title: normalized_title.clone(),
            source_app: Some(PasteboardSourceApp {
                bundle_id: None,
                name: Some("PasteboardPro".to_string()),
            }),
            source_device_id: device_id.clone(),
            copied_at: timestamp.clone(),
            updated_at: timestamp,
            content_fingerprint,
            payload: PasteboardPayload {
                revision: payload_revision,
                text: Some(text.to_string()),
                html: None,
                blob_id: None,
                media_type: None,
                file_paths: None,
            },
            ocr_text: None,
            pinboard_id: None,
            pinboard_order_key: None,
            pinned: false,
            field_clocks: BTreeMap::from([
                ("payload".to_string(), clock(0)),
                ("title".to_string(), clock(1)),
                ("pinned".to_string(), clock(2)),
            ]),
        };
        self.db
            .upsert_pasteboard_item(&item)
            .map_err(|error| error.to_string())?;
        self.apply_retention()?;
        Ok(item)
    }

    pub fn update_text_item(
        &self,
        item_id: &str,
        text: &str,
        title: Option<&str>,
    ) -> Result<PasteboardItem, String> {
        validate_editable_text(text)?;
        if self.is_sensitive(text)? {
            return Err("PasteboardPro refused to save text matched by privacy rules".to_string());
        }
        let mut item = self
            .db
            .get_pasteboard_item(item_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("PasteboardPro item does not exist: {item_id}"))?;
        if !matches!(
            item.kind,
            PasteboardItemKind::Text
                | PasteboardItemKind::RichText
                | PasteboardItemKind::Html
                | PasteboardItemKind::Url
                | PasteboardItemKind::Color
        ) {
            return Err("PasteboardPro item does not support text editing".to_string());
        }
        let wall_ms = wall_ms()?;
        let device_id = self.device_id()?;
        item.kind = PasteboardItemKind::Text;
        item.title = normalized_item_title(title, text)?;
        item.payload = PasteboardPayload {
            revision: text_payload_revision(text),
            text: Some(text.to_string()),
            html: None,
            blob_id: None,
            media_type: None,
            file_paths: None,
        };
        item.ocr_text = None;
        item.updated_at = atools_core::utils::now_iso();
        for (counter, field) in ["payload", "title", "ocrText"].into_iter().enumerate() {
            item.field_clocks.insert(
                field.to_string(),
                HybridLogicalClock {
                    wall_ms,
                    counter: counter as u64,
                    device_id: device_id.clone(),
                },
            );
        }
        self.db
            .upsert_pasteboard_item(&item)
            .map_err(|error| error.to_string())?;
        Ok(item)
    }

    pub fn update_item_title(&self, item_id: &str, title: &str) -> Result<PasteboardItem, String> {
        let normalized = title.trim();
        if normalized.is_empty() || normalized.chars().count() > 160 {
            return Err("PasteboardPro title must contain 1 to 160 characters".to_string());
        }
        let mut item = self
            .db
            .get_pasteboard_item(item_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("PasteboardPro item does not exist: {item_id}"))?;
        item.title = Some(normalized.to_string());
        item.updated_at = atools_core::utils::now_iso();
        item.field_clocks.insert(
            "title".to_string(),
            HybridLogicalClock {
                wall_ms: wall_ms()?,
                counter: 0,
                device_id: self.device_id()?,
            },
        );
        self.db
            .upsert_pasteboard_item(&item)
            .map_err(|error| error.to_string())?;
        Ok(item)
    }

    pub fn capture_snapshot(
        &self,
        mut snapshot: PasteboardSnapshot,
    ) -> Result<CaptureOutcome, String> {
        if self.bool_setting(CAPTURE_PAUSED_SETTING_KEY, false)? {
            return Ok(CaptureOutcome::Paused);
        }
        if snapshot.transient || snapshot.concealed {
            return Ok(CaptureOutcome::Sensitive);
        }
        if snapshot
            .text
            .as_ref()
            .is_some_and(|text| text.len() > MAX_CAPTURE_TEXT_BYTES)
            || snapshot
                .html
                .as_ref()
                .is_some_and(|html| html.len() > MAX_CAPTURE_TEXT_BYTES)
            || snapshot
                .bytes
                .as_ref()
                .is_some_and(|bytes| bytes.len() > MAX_CAPTURE_BLOB_BYTES)
        {
            return Ok(CaptureOutcome::TooLarge);
        }
        if snapshot
            .file_paths
            .as_ref()
            .is_some_and(|paths| paths.len() > MAX_CAPTURE_FILES)
        {
            return Ok(CaptureOutcome::TooLarge);
        }
        if snapshot_is_empty(&snapshot) {
            return Ok(CaptureOutcome::Empty);
        }
        if snapshot.kind == PasteboardItemKind::Text {
            if let Some(text) = snapshot.text.as_deref() {
                snapshot.kind = detect_kind(text);
            }
        }
        if let Some(text) = snapshot.text.as_deref() {
            if self.is_sensitive(text)? {
                return Ok(CaptureOutcome::Sensitive);
            }
        }
        let fingerprint = snapshot_fingerprint(&snapshot);
        if self
            .db
            .find_pasteboard_item_by_fingerprint(&fingerprint)
            .map_err(|error| error.to_string())?
            .is_some()
        {
            return Ok(CaptureOutcome::Duplicate);
        }
        let blob = snapshot
            .bytes
            .as_deref()
            .map(|bytes| {
                self.store_blob(
                    bytes,
                    snapshot
                        .media_type
                        .as_deref()
                        .unwrap_or("application/octet-stream"),
                )
            })
            .transpose()?;
        let wall_ms = wall_ms()?;
        let device_id = self.device_id()?;
        let timestamp = atools_core::utils::now_iso();
        let clock = HybridLogicalClock {
            wall_ms,
            counter: 0,
            device_id: device_id.clone(),
        };
        let title = snapshot_title(&snapshot);
        let mut field_clocks = BTreeMap::from([
            ("payload".to_string(), clock.clone()),
            ("pinned".to_string(), clock.clone()),
        ]);
        if title.is_some() {
            field_clocks.insert("title".to_string(), clock);
        }
        let item = PasteboardItem {
            id: format!("atools:{}", atools_core::utils::generate_rev()),
            kind: snapshot.kind,
            title: title.clone(),
            source_app: snapshot
                .source_bundle_id
                .map(|bundle_id| PasteboardSourceApp {
                    bundle_id: Some(bundle_id),
                    name: None,
                }),
            source_device_id: device_id,
            copied_at: timestamp.clone(),
            updated_at: timestamp,
            content_fingerprint: fingerprint.clone(),
            payload: PasteboardPayload {
                revision: fingerprint,
                text: snapshot.text,
                html: snapshot.html,
                blob_id: blob.as_ref().map(|blob| blob.id.clone()),
                media_type: snapshot.media_type,
                file_paths: snapshot.file_paths,
            },
            ocr_text: None,
            pinboard_id: None,
            pinboard_order_key: None,
            pinned: false,
            field_clocks,
        };
        self.db
            .upsert_pasteboard_item(&item)
            .map_err(|error| error.to_string())?;
        self.apply_retention()?;
        Ok(CaptureOutcome::Captured(item.id))
    }

    pub fn rotate_image_item(
        &self,
        item_id: &str,
        quarter_turns: i8,
    ) -> Result<PasteboardItem, String> {
        let normalized_turns = i32::from(quarter_turns).rem_euclid(4);
        if normalized_turns == 0 {
            return Err(
                "PasteboardPro image rotation requires a non-zero quarter turn".to_string(),
            );
        }
        let mut item = self
            .db
            .get_pasteboard_item(item_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("PasteboardPro item does not exist: {item_id}"))?;
        if item.kind != PasteboardItemKind::Image {
            return Err("PasteboardPro rotation requires an image item".to_string());
        }
        let blob_id = item
            .payload
            .blob_id
            .as_deref()
            .ok_or_else(|| "PasteboardPro image is not available on this device".to_string())?;
        let blob = self
            .db
            .get_pasteboard_blob(blob_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("PasteboardPro blob is unavailable: {blob_id}"))?;
        if !blob.media_type.starts_with("image/") {
            return Err("PasteboardPro rotation blob is not an image".to_string());
        }
        let source_path = self.config.pasteboard_dir().join(&blob.relative_path);
        let bytes = std::fs::read(&source_path)
            .map_err(|error| format!("Failed to read PasteboardPro image: {error}"))?;
        if bytes.len() as u64 != blob.byte_length {
            return Err("PasteboardPro rotation image length does not match metadata".to_string());
        }
        let mut reader = ImageReader::new(Cursor::new(bytes))
            .with_guessed_format()
            .map_err(|error| format!("Failed to detect PasteboardPro image format: {error}"))?;
        let mut limits = Limits::default();
        limits.max_image_width = Some(20_000);
        limits.max_image_height = Some(20_000);
        limits.max_alloc = Some(512 * 1024 * 1024);
        reader.limits(limits);
        let decoded = reader
            .decode()
            .map_err(|error| format!("Failed to decode PasteboardPro image: {error}"))?;
        let rotated = match normalized_turns {
            1 => decoded.rotate90(),
            2 => decoded.rotate180(),
            3 => decoded.rotate270(),
            _ => unreachable!("quarter turns are normalized modulo four"),
        };
        let mut output = Cursor::new(Vec::new());
        rotated
            .write_to(&mut output, ImageFormat::Png)
            .map_err(|error| format!("Failed to encode rotated PasteboardPro image: {error}"))?;
        let output = output.into_inner();
        if output.len() > MAX_CAPTURE_BLOB_BYTES {
            return Err("Rotated PasteboardPro image exceeds 100 MiB".to_string());
        }
        let rotated_blob = self.store_blob(&output, "image/png")?;
        let wall_ms = wall_ms()?;
        let device_id = self.device_id()?;
        item.payload.revision = rotated_blob.keyed_fingerprint.clone();
        item.payload.blob_id = Some(rotated_blob.id);
        item.payload.media_type = Some("image/png".to_string());
        item.ocr_text = None;
        item.updated_at = atools_core::utils::now_iso();
        item.field_clocks.insert(
            "payload".to_string(),
            HybridLogicalClock {
                wall_ms,
                counter: 0,
                device_id: device_id.clone(),
            },
        );
        item.field_clocks.insert(
            "ocrText".to_string(),
            HybridLogicalClock {
                wall_ms,
                counter: 1,
                device_id,
            },
        );
        self.db
            .upsert_pasteboard_item(&item)
            .map_err(|error| error.to_string())?;
        Ok(item)
    }

    fn store_blob(&self, bytes: &[u8], media_type: &str) -> Result<PasteboardBlob, String> {
        let digest = Sha256::digest(bytes);
        let hex_digest = hex::encode(digest);
        let id = format!("blob-{hex_digest}");
        if let Some(existing) = self
            .db
            .get_pasteboard_blob(&id)
            .map_err(|error| error.to_string())?
        {
            let path = self.config.pasteboard_dir().join(&existing.relative_path);
            if path.is_file() {
                return Ok(existing);
            }
        }
        let extension = media_type_extension(media_type);
        let relative_path = format!("blobs/{}/{}.{}", &hex_digest[..2], hex_digest, extension);
        let destination = self.config.pasteboard_dir().join(&relative_path);
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent).map_err(|error| {
                format!("Failed to create PasteboardPro blob directory: {error}")
            })?;
        }
        if !destination.is_file() {
            let temporary = destination.with_extension(format!(
                "{}.tmp-{}",
                extension,
                atools_core::utils::generate_rev()
            ));
            std::fs::write(&temporary, bytes)
                .map_err(|error| format!("Failed to write PasteboardPro blob: {error}"))?;
            if let Err(error) = std::fs::rename(&temporary, &destination) {
                let _ = std::fs::remove_file(&temporary);
                if !destination.is_file() {
                    return Err(format!("Failed to finalize PasteboardPro blob: {error}"));
                }
            }
        }
        let timestamp = atools_core::utils::now_iso();
        let blob = PasteboardBlob {
            id,
            keyed_fingerprint: format!("sha256:{hex_digest}"),
            relative_path,
            media_type: media_type.to_string(),
            byte_length: bytes.len() as u64,
            created_at: timestamp.clone(),
            last_accessed_at: timestamp,
            remote_available: false,
            sync_state: "local".to_string(),
            metadata: serde_json::Value::Null,
        };
        self.db
            .upsert_pasteboard_blob(&blob)
            .map_err(|error| error.to_string())?;
        Ok(blob)
    }

    fn privacy_literals(&self) -> Result<Vec<String>, String> {
        let Some(value) = self
            .db
            .get_setting(PRIVACY_LITERALS_SETTING_KEY)
            .map_err(|error| error.to_string())?
        else {
            return Ok(Vec::new());
        };
        serde_json::from_str::<Vec<String>>(&value)
            .map(|values| {
                values
                    .into_iter()
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty())
                    .collect()
            })
            .map_err(|error| format!("PasteboardPro privacy literals are invalid: {error}"))
    }

    fn is_sensitive(&self, text: &str) -> Result<bool, String> {
        let trimmed = text.trim();
        let lowered = trimmed.to_ascii_lowercase();
        if [
            "-----begin private key-----",
            "-----begin rsa private key-----",
            "-----begin openssh private key-----",
            "password:",
        ]
        .iter()
        .any(|marker| lowered.contains(marker))
            || ["sk-", "ghp_", "github_pat_", "xoxb-", "xoxp-"]
                .iter()
                .any(|prefix| lowered.starts_with(prefix) && trimmed.len() >= 20)
            || looks_like_otp(trimmed)
            || looks_like_payment_card(trimmed)
        {
            return Ok(true);
        }
        Ok(self
            .privacy_literals()?
            .iter()
            .any(|literal| text.contains(literal)))
    }

    fn apply_retention(&self) -> Result<(), String> {
        let retention_days =
            self.u64_setting(RETENTION_DAYS_SETTING_KEY, DEFAULT_RETENTION_DAYS)?;
        let blob_budget = self.u64_setting(BLOB_BUDGET_SETTING_KEY, DEFAULT_BLOB_BUDGET_BYTES)?;
        let blob_paths = self
            .db
            .list_pasteboard_blobs()
            .map_err(|error| error.to_string())?
            .into_iter()
            .map(|blob| (blob.id, blob.relative_path))
            .collect::<BTreeMap<_, _>>();
        let pruned = self
            .db
            .prune_pasteboard_history(
                &atools_core::utils::iso_days_ago(retention_days),
                blob_budget,
            )
            .map_err(|error| error.to_string())?;
        let wall_ms = wall_ms()?;
        let device_id = self.device_id()?;
        for (counter, item_id) in pruned.deleted_item_ids.iter().enumerate() {
            self.db
                .upsert_pasteboard_tombstone(&PasteboardTombstone {
                    id: item_id.clone(),
                    entity_type: PasteboardEntityType::PasteItem,
                    deleted: true,
                    deleted_at: atools_core::utils::now_iso(),
                    source_device_id: device_id.clone(),
                    clock: HybridLogicalClock {
                        wall_ms,
                        counter: counter as u64,
                        device_id: device_id.clone(),
                    },
                })
                .map_err(|error| error.to_string())?;
        }
        for blob_id in pruned.deleted_blob_ids {
            if let Some(relative_path) = blob_paths.get(&blob_id) {
                let path = self.config.pasteboard_dir().join(relative_path);
                let _ = std::fs::remove_file(path);
            }
        }
        self.db
            .prune_pasteboard_tombstones(&atools_core::utils::iso_days_ago(
                TOMBSTONE_RETENTION_DAYS,
            ))
            .map_err(|error| error.to_string())?;
        Ok(())
    }
}

fn wall_ms() -> Result<i64, String> {
    let duration = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| format!("System clock is invalid: {error}"))?;
    i64::try_from(duration.as_millis())
        .map_err(|_| "System clock exceeds PasteboardPro HLC range".to_string())
}

fn detect_kind(text: &str) -> PasteboardItemKind {
    let trimmed = text.trim();
    if is_hex_color(trimmed) {
        PasteboardItemKind::Color
    } else if reqwest::Url::parse(trimmed).is_ok_and(|url| matches!(url.scheme(), "http" | "https"))
    {
        PasteboardItemKind::Url
    } else {
        PasteboardItemKind::Text
    }
}

fn is_hex_color(value: &str) -> bool {
    matches!(value.len(), 4 | 7 | 9)
        && value.starts_with('#')
        && value[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn snapshot_fingerprint(snapshot: &PasteboardSnapshot) -> String {
    let mut digest = Sha256::new();
    digest.update(snapshot.kind.as_str().as_bytes());
    digest.update([0]);
    for value in [snapshot.text.as_deref(), snapshot.html.as_deref()]
        .into_iter()
        .flatten()
    {
        digest.update(value.len().to_be_bytes());
        digest.update(value.as_bytes());
    }
    if let Some(bytes) = snapshot.bytes.as_deref() {
        digest.update(bytes.len().to_be_bytes());
        digest.update(bytes);
    }
    if let Some(paths) = snapshot.file_paths.as_deref() {
        for path in paths {
            digest.update(path.len().to_be_bytes());
            digest.update(path.as_bytes());
        }
    }
    format!("sha256:{}", hex::encode(digest.finalize()))
}

fn snapshot_is_empty(snapshot: &PasteboardSnapshot) -> bool {
    snapshot.text.as_ref().map_or(true, String::is_empty)
        && snapshot.html.as_ref().map_or(true, String::is_empty)
        && snapshot.bytes.as_ref().map_or(true, Vec::is_empty)
        && snapshot.file_paths.as_ref().map_or(true, Vec::is_empty)
}

fn snapshot_title(snapshot: &PasteboardSnapshot) -> Option<String> {
    if let Some(text) = snapshot.text.as_deref().filter(|text| !text.is_empty()) {
        return text_title(text);
    }
    if let Some(paths) = snapshot
        .file_paths
        .as_deref()
        .filter(|paths| !paths.is_empty())
    {
        if paths.len() == 1 {
            return Path::new(&paths[0])
                .file_name()
                .and_then(|name| name.to_str())
                .map(ToOwned::to_owned)
                .or_else(|| Some(paths[0].clone()));
        }
        return Some(format!("{} items", paths.len()));
    }
    Some(
        match snapshot.kind {
            PasteboardItemKind::Image => "Image",
            PasteboardItemKind::Pdf => "PDF",
            PasteboardItemKind::RichText => "Rich Text",
            PasteboardItemKind::Html => "HTML",
            _ => return None,
        }
        .to_string(),
    )
}

fn media_type_extension(media_type: &str) -> &'static str {
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

fn text_title(text: &str) -> Option<String> {
    let title = text.lines().next().unwrap_or_default().trim();
    if title.is_empty() {
        return None;
    }
    Some(title.chars().take(80).collect())
}

fn validate_editable_text(text: &str) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err("PasteboardPro text content cannot be empty".to_string());
    }
    if text.len() > MAX_CAPTURE_TEXT_BYTES {
        return Err("PasteboardPro text content cannot exceed 10 MiB".to_string());
    }
    Ok(())
}

fn normalized_item_title(title: Option<&str>, text: &str) -> Result<Option<String>, String> {
    let title = title.map(str::trim).filter(|value| !value.is_empty());
    if title.is_some_and(|value| value.chars().count() > 160) {
        return Err("PasteboardPro title cannot exceed 160 characters".to_string());
    }
    Ok(title.map(ToString::to_string).or_else(|| text_title(text)))
}

fn text_payload_revision(text: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(b"pasteboard-text-payload\0");
    digest.update(text.as_bytes());
    format!("sha256:{}", hex::encode(digest.finalize()))
}

fn looks_like_payment_card(value: &str) -> bool {
    let digits = value
        .bytes()
        .filter(|byte| byte.is_ascii_digit())
        .collect::<Vec<_>>();
    if digits.len() < 13 || digits.len() > 19 {
        return false;
    }
    let mut sum = 0_u32;
    let parity = digits.len() % 2;
    for (index, digit) in digits.iter().enumerate() {
        let mut value = u32::from(*digit - b'0');
        if index % 2 == parity {
            value *= 2;
            if value > 9 {
                value -= 9;
            }
        }
        sum += value;
    }
    sum % 10 == 0
}

fn looks_like_otp(value: &str) -> bool {
    let lowered = value.to_ascii_lowercase();
    if !["verification", "verify", "otp", "code", "验证码"]
        .iter()
        .any(|marker| lowered.contains(marker))
    {
        return false;
    }
    value
        .split(|character: char| !character.is_ascii_digit())
        .any(|token| (4..=8).contains(&token.len()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn runtime() -> (tempfile::TempDir, PasteboardRuntime) {
        let dir = tempdir().unwrap();
        let config = AppConfig::with_base_dir(dir.path().join("atools"));
        config.ensure_dirs().unwrap();
        let db = Arc::new(Database::open(&config.db_path()).unwrap());
        (dir, PasteboardRuntime::new(db, config))
    }

    #[test]
    fn captures_text_and_deduplicates_by_content() {
        let (_dir, runtime) = runtime();
        assert!(matches!(
            runtime.capture_text("hello"),
            Ok(CaptureOutcome::Captured(_))
        ));
        assert_eq!(
            runtime.capture_text("hello").unwrap(),
            CaptureOutcome::Duplicate
        );
        assert_eq!(runtime.status().unwrap().item_count, 1);
    }

    #[test]
    fn rejects_high_confidence_secrets_before_storage() {
        let (_dir, runtime) = runtime();
        for value in [
            "Your verification code is 123456",
            "sk-12345678901234567890",
            "-----BEGIN PRIVATE KEY-----\nsecret",
        ] {
            assert_eq!(
                runtime.capture_text(value).unwrap(),
                CaptureOutcome::Sensitive
            );
        }
        assert_eq!(runtime.status().unwrap().item_count, 0);
    }

    #[test]
    fn paused_capture_never_writes_history() {
        let (_dir, runtime) = runtime();
        runtime.set_paused(true).unwrap();
        assert_eq!(
            runtime.capture_text("hello").unwrap(),
            CaptureOutcome::Paused
        );
        assert_eq!(runtime.status().unwrap().item_count, 0);
    }

    #[test]
    fn preferences_validate_persist_and_deduplicate_privacy_literals() {
        let (_dir, runtime) = runtime();
        let saved = runtime
            .update_preferences(PasteboardPreferences {
                retention_days: 30,
                blob_budget_bytes: 512 * 1024 * 1024,
                privacy_literals: vec![
                    "PRIVATE NOTE".to_string(),
                    " PRIVATE NOTE ".to_string(),
                    "internal-only".to_string(),
                ],
                screen_share_protection: false,
            })
            .unwrap();
        assert_eq!(saved.retention_days, 30);
        assert_eq!(saved.blob_budget_bytes, 512 * 1024 * 1024);
        assert_eq!(
            saved.privacy_literals,
            vec!["PRIVATE NOTE".to_string(), "internal-only".to_string()]
        );
        assert!(!saved.screen_share_protection);
        assert_eq!(runtime.preferences().unwrap(), saved);
        assert!(runtime
            .update_preferences(PasteboardPreferences {
                retention_days: 0,
                ..saved
            })
            .is_err());
    }

    #[test]
    fn creates_edits_and_renames_text_with_new_field_clocks() {
        let (_dir, runtime) = runtime();
        let created = runtime
            .create_text_item("Draft body", Some("Draft title"))
            .unwrap();
        assert_eq!(created.title.as_deref(), Some("Draft title"));
        assert_eq!(created.payload.text.as_deref(), Some("Draft body"));
        let capture_fingerprint = created.content_fingerprint.clone();
        let payload_revision = created.payload.revision.clone();

        let edited = runtime
            .update_text_item(&created.id, "Edited body", Some("Edited title"))
            .unwrap();
        assert_eq!(edited.kind, PasteboardItemKind::Text);
        assert_eq!(edited.title.as_deref(), Some("Edited title"));
        assert_eq!(edited.payload.text.as_deref(), Some("Edited body"));
        assert_eq!(edited.content_fingerprint, capture_fingerprint);
        assert_ne!(edited.payload.revision, payload_revision);

        let renamed = runtime
            .update_item_title(&created.id, "Final title")
            .unwrap();
        assert_eq!(renamed.title.as_deref(), Some("Final title"));
        assert_eq!(renamed.payload.revision, edited.payload.revision);
        assert!(renamed.field_clocks.contains_key("title"));
    }

    #[test]
    fn stores_image_bytes_in_the_content_addressed_blob_directory() {
        let (_dir, runtime) = runtime();
        let outcome = runtime
            .capture_snapshot(PasteboardSnapshot {
                kind: PasteboardItemKind::Image,
                text: None,
                html: None,
                bytes: Some(vec![1, 2, 3, 4]),
                media_type: Some("image/png".to_string()),
                file_paths: None,
                source_bundle_id: Some("com.example.source".to_string()),
                transient: false,
                concealed: false,
            })
            .unwrap();
        assert!(matches!(outcome, CaptureOutcome::Captured(_)));
        let item = runtime
            .db
            .list_pasteboard_items_for_sync()
            .unwrap()
            .remove(0);
        let blob = runtime
            .db
            .get_pasteboard_blob(item.payload.blob_id.as_deref().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(blob.byte_length, 4);
        assert!(runtime
            .config
            .pasteboard_dir()
            .join(blob.relative_path)
            .is_file());
        assert_eq!(
            item.source_app.and_then(|app| app.bundle_id).as_deref(),
            Some("com.example.source")
        );
    }

    #[test]
    fn rotating_an_image_replaces_payload_blob_and_invalidates_ocr() {
        use image::{DynamicImage, GenericImageView, ImageBuffer, Rgba};

        let (_dir, runtime) = runtime();
        let source =
            DynamicImage::ImageRgba8(ImageBuffer::from_pixel(2, 1, Rgba([255, 0, 0, 255])));
        let mut encoded = Cursor::new(Vec::new());
        source.write_to(&mut encoded, ImageFormat::Png).unwrap();
        let item_id = match runtime
            .capture_snapshot(PasteboardSnapshot {
                kind: PasteboardItemKind::Image,
                text: None,
                html: None,
                bytes: Some(encoded.into_inner()),
                media_type: Some("image/png".to_string()),
                file_paths: None,
                source_bundle_id: None,
                transient: false,
                concealed: false,
            })
            .unwrap()
        {
            CaptureOutcome::Captured(item_id) => item_id,
            outcome => panic!("expected captured image, got {outcome:?}"),
        };
        runtime
            .db
            .update_pasteboard_item_ocr_from_device(&item_id, Some("stale"), "test-device")
            .unwrap();
        let before = runtime.db.get_pasteboard_item(&item_id).unwrap().unwrap();
        let rotated = runtime.rotate_image_item(&item_id, 1).unwrap();
        assert_ne!(rotated.payload.blob_id, before.payload.blob_id);
        assert_eq!(rotated.payload.media_type.as_deref(), Some("image/png"));
        assert!(rotated.ocr_text.is_none());
        let blob = runtime
            .db
            .get_pasteboard_blob(rotated.payload.blob_id.as_deref().unwrap())
            .unwrap()
            .unwrap();
        let bytes =
            std::fs::read(runtime.config.pasteboard_dir().join(blob.relative_path)).unwrap();
        assert_eq!(
            image::load_from_memory(&bytes).unwrap().dimensions(),
            (1, 2)
        );
    }

    #[test]
    fn concealed_and_transient_snapshots_are_never_persisted() {
        let (_dir, runtime) = runtime();
        for (transient, concealed) in [(true, false), (false, true)] {
            let mut snapshot = PasteboardSnapshot::text("not stored");
            snapshot.transient = transient;
            snapshot.concealed = concealed;
            assert_eq!(
                runtime.capture_snapshot(snapshot).unwrap(),
                CaptureOutcome::Sensitive
            );
        }
        assert_eq!(runtime.status().unwrap().item_count, 0);
    }
}
