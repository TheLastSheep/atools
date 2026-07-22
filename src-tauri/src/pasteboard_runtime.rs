//! Native, local-first clipboard capture coordinator.

use async_trait::async_trait;
use atools_core::{
    AppConfig, Database, PasteboardBlob, PasteboardItem, PasteboardItemKind, PasteboardPruneResult,
    PasteboardSourceApp,
};
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeSet, VecDeque};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

const DEFAULT_RETENTION_DAYS: u64 = 90;
const DEFAULT_ATTACHMENT_BUDGET_BYTES: u64 = 1_073_741_824;
const MAX_INLINE_TEXT_BYTES: usize = 10 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES: usize = 100 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub enum NativePasteboardRepresentation {
    Text(String),
    RichText { bytes: Vec<u8>, media_type: String },
    Html(String),
    Url(String),
    Image { bytes: Vec<u8>, media_type: String },
    Pdf(Vec<u8>),
    Color(String),
    Files(Vec<String>),
}

#[derive(Debug, Clone, PartialEq)]
pub struct NativePasteboardSnapshot {
    pub change_count: i64,
    pub copied_at: String,
    pub source_app: Option<PasteboardSourceApp>,
    pub is_confidential: bool,
    pub is_transient: bool,
    pub representations: Vec<NativePasteboardRepresentation>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PasteOutcome {
    pub item_id: String,
    pub copied: bool,
    pub pasted: bool,
    pub warning_code: Option<String>,
    pub warning: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum CaptureOutcome {
    Unchanged,
    Paused { change_count: i64 },
    Ignored { change_count: i64, reason: String },
    Captured { item_id: String, change_count: i64 },
    Updated { item_id: String, change_count: i64 },
}

impl CaptureOutcome {
    pub fn change_count(&self) -> Option<i64> {
        match self {
            Self::Unchanged => None,
            Self::Paused { change_count }
            | Self::Ignored { change_count, .. }
            | Self::Captured { change_count, .. }
            | Self::Updated { change_count, .. } => Some(*change_count),
        }
    }

    pub fn changed_item_id(&self) -> Option<&str> {
        match self {
            Self::Captured { item_id, .. } | Self::Updated { item_id, .. } => Some(item_id),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PasteboardCaptureStatus {
    pub paused: bool,
    pub last_change_count: i64,
    pub last_outcome: Option<CaptureOutcome>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PasteStackStatus {
    pub active: bool,
    pub count: usize,
    pub item_ids: Vec<String>,
}

#[async_trait]
pub trait PasteboardBackend: Send + Sync {
    async fn snapshot_if_changed(
        &self,
        previous_change_count: i64,
    ) -> Result<Option<NativePasteboardSnapshot>, String>;

    async fn write_item(
        &self,
        item: &PasteboardItem,
        blob_root: &Path,
        plain_text: bool,
    ) -> Result<(), String>;

    async fn paste_frontmost(&self) -> Result<(), String>;
}

#[derive(Debug, Clone)]
struct CaptureState {
    change_count: i64,
    last_outcome: Option<CaptureOutcome>,
    suppressed_fingerprint: Option<String>,
}

impl Default for CaptureState {
    fn default() -> Self {
        Self {
            change_count: -1,
            last_outcome: None,
            suppressed_fingerprint: None,
        }
    }
}

#[derive(Debug, Clone)]
struct PasteboardRuntimeSettings {
    paused: bool,
    retention_days: u64,
    attachment_budget_bytes: u64,
    ignored_bundle_ids: BTreeSet<String>,
    sensitive_content_filter: bool,
}

impl Default for PasteboardRuntimeSettings {
    fn default() -> Self {
        Self {
            paused: false,
            retention_days: DEFAULT_RETENTION_DAYS,
            attachment_budget_bytes: DEFAULT_ATTACHMENT_BUDGET_BYTES,
            ignored_bundle_ids: default_ignored_bundle_ids(),
            sensitive_content_filter: true,
        }
    }
}

pub struct PasteboardRuntime {
    backend: Arc<dyn PasteboardBackend>,
    db: Arc<Database>,
    blob_root: PathBuf,
    device_id: String,
    state: RwLock<CaptureState>,
    paste_stack: Mutex<VecDeque<String>>,
}

impl PasteboardRuntime {
    pub fn new(
        backend: Arc<dyn PasteboardBackend>,
        db: Arc<Database>,
        config: &AppConfig,
    ) -> Result<Self, String> {
        let device_id = match db.get_setting("pasteboard.device_id") {
            Ok(Some(value)) if !value.trim().is_empty() => value,
            Ok(_) => {
                let value = uuid::Uuid::new_v4().to_string();
                db.set_setting("pasteboard.device_id", &value)
                    .map_err(|error| error.to_string())?;
                value
            }
            Err(error) => return Err(error.to_string()),
        };
        Ok(Self {
            backend,
            db,
            blob_root: config.pasteboard_blobs_dir(),
            device_id,
            state: RwLock::new(CaptureState::default()),
            paste_stack: Mutex::new(VecDeque::new()),
        })
    }

    pub fn status(&self) -> PasteboardCaptureStatus {
        let settings = self.settings();
        let state = self.state.read();
        PasteboardCaptureStatus {
            paused: settings.paused,
            last_change_count: state.change_count,
            last_outcome: state.last_outcome.clone(),
        }
    }

    pub fn device_id(&self) -> &str {
        &self.device_id
    }

    pub fn set_paste_stack(&self, item_ids: Vec<String>) -> Result<PasteStackStatus, String> {
        let mut unique = BTreeSet::new();
        let mut queue = VecDeque::new();
        for item_id in item_ids {
            let item_id = item_id.trim();
            if item_id.is_empty() || !unique.insert(item_id.to_string()) {
                continue;
            }
            if self
                .db
                .get_pasteboard_item(item_id)
                .map_err(|error| error.to_string())?
                .is_some()
            {
                queue.push_back(item_id.to_string());
            }
        }
        *self.paste_stack.lock() = queue;
        Ok(self.paste_stack_status())
    }

    pub fn paste_stack_status(&self) -> PasteStackStatus {
        let queue = self.paste_stack.lock();
        PasteStackStatus {
            active: !queue.is_empty(),
            count: queue.len(),
            item_ids: queue.iter().cloned().collect(),
        }
    }

    pub fn pop_paste_stack_item(&self) -> Option<String> {
        self.paste_stack.lock().pop_front()
    }

    pub fn clear_paste_stack(&self) -> PasteStackStatus {
        self.paste_stack.lock().clear();
        self.paste_stack_status()
    }

    pub async fn capture_once(&self) -> Result<CaptureOutcome, String> {
        let previous_change_count = self.state.read().change_count;
        let Some(snapshot) = self
            .backend
            .snapshot_if_changed(previous_change_count)
            .await?
        else {
            return Ok(CaptureOutcome::Unchanged);
        };

        let settings = self.settings();
        if settings.paused {
            return Ok(self.finish_capture(CaptureOutcome::Paused {
                change_count: snapshot.change_count,
            }));
        }
        if let Some(reason) = ignored_snapshot_reason(&snapshot, &settings) {
            return Ok(self.finish_capture(CaptureOutcome::Ignored {
                change_count: snapshot.change_count,
                reason,
            }));
        }

        let snapshot_fingerprint = snapshot_fingerprint(&snapshot.representations);
        if self
            .state
            .write()
            .suppressed_fingerprint
            .take()
            .is_some_and(|fingerprint| fingerprint == snapshot_fingerprint)
        {
            return Ok(self.finish_capture(CaptureOutcome::Ignored {
                change_count: snapshot.change_count,
                reason: "self_write".into(),
            }));
        }

        let normalized = self.normalize_snapshot(snapshot.clone()).await?;
        let existing = self
            .db
            .find_pasteboard_item_by_fingerprint(&normalized.item.content_fingerprint)
            .map_err(|error| error.to_string())?;
        let updated = existing.is_some();
        let mut item = if let Some(mut existing) = existing {
            existing.kind = normalized.item.kind;
            existing.title = normalized.item.title;
            existing.source_app = normalized.item.source_app;
            existing.copied_at = normalized.item.copied_at;
            existing.updated_at = normalized.item.updated_at;
            existing.payload = normalized.item.payload;
            existing.ocr_text = normalized.item.ocr_text;
            existing
        } else {
            normalized.item
        };
        item.source_device_id = self.device_id.clone();

        self.db
            .upsert_pasteboard_item(&item)
            .map_err(|error| error.to_string())?;
        for blob in normalized.blobs {
            self.db
                .upsert_pasteboard_blob(&blob)
                .map_err(|error| error.to_string())?;
            self.db
                .link_pasteboard_blob(&item.id, &blob.id)
                .map_err(|error| error.to_string())?;
        }
        self.apply_retention(&settings).await?;

        let outcome = if updated {
            CaptureOutcome::Updated {
                item_id: item.id,
                change_count: snapshot.change_count,
            }
        } else {
            CaptureOutcome::Captured {
                item_id: item.id,
                change_count: snapshot.change_count,
            }
        };
        Ok(self.finish_capture(outcome))
    }

    pub async fn paste_item(&self, id: &str, plain_text: bool) -> Result<PasteOutcome, String> {
        let item = self
            .db
            .get_pasteboard_item(id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("Paste item not found: {id}"))?;
        self.write_item(&item, plain_text).await?;
        match self.backend.paste_frontmost().await {
            Ok(()) => Ok(PasteOutcome {
                item_id: item.id,
                copied: true,
                pasted: true,
                warning_code: None,
                warning: None,
            }),
            Err(message) => Ok(PasteOutcome {
                item_id: item.id,
                copied: true,
                pasted: false,
                warning_code: Some("accessibility_required".into()),
                warning: Some(message),
            }),
        }
    }

    pub async fn copy_item(&self, id: &str, plain_text: bool) -> Result<PasteOutcome, String> {
        let item = self
            .db
            .get_pasteboard_item(id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("Paste item not found: {id}"))?;
        self.write_item(&item, plain_text).await?;
        Ok(PasteOutcome {
            item_id: item.id,
            copied: true,
            pasted: false,
            warning_code: None,
            warning: None,
        })
    }

    pub fn create_text_item(
        &self,
        text: &str,
        title: Option<String>,
    ) -> Result<PasteboardItem, String> {
        let text = text.trim();
        if text.is_empty() {
            return Err("文本内容不能为空".into());
        }
        validate_inline_text(text)?;
        let now = atools_core::utils::now_iso();
        let item = PasteboardItem {
            id: format!("paste-{}", uuid::Uuid::new_v4()),
            kind: PasteboardItemKind::Text,
            title: normalized_title(title),
            source_app: Some(PasteboardSourceApp {
                bundle_id: Some("com.atools.desktop".into()),
                name: Some("ATools".into()),
            }),
            source_device_id: self.device_id.clone(),
            copied_at: now.clone(),
            updated_at: now,
            content_fingerprint: snapshot_fingerprint(&[NativePasteboardRepresentation::Text(
                text.to_string(),
            )]),
            payload: json!({ "text": text, "previewText": text }),
            ocr_text: None,
            pinboard_id: None,
            pinboard_order_key: None,
            pinned: false,
            field_clocks: json!({}),
        };
        self.db
            .upsert_pasteboard_item(&item)
            .map_err(|error| error.to_string())?;
        Ok(item)
    }

    pub fn update_text_item(
        &self,
        id: &str,
        text: &str,
        title: Option<String>,
    ) -> Result<PasteboardItem, String> {
        let text = text.trim();
        if text.is_empty() {
            return Err("文本内容不能为空".into());
        }
        validate_inline_text(text)?;
        let mut item = self
            .db
            .get_pasteboard_item(id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("Paste item not found: {id}"))?;
        if !matches!(
            item.kind,
            PasteboardItemKind::Text
                | PasteboardItemKind::RichText
                | PasteboardItemKind::Html
                | PasteboardItemKind::Url
        ) {
            return Err("当前内容类型不能作为文本编辑".into());
        }
        item.kind = PasteboardItemKind::Text;
        item.title = normalized_title(title);
        item.payload = json!({ "text": text, "previewText": text });
        item.content_fingerprint =
            snapshot_fingerprint(&[NativePasteboardRepresentation::Text(text.to_string())]);
        item.updated_at = atools_core::utils::now_iso();
        self.db
            .upsert_pasteboard_item(&item)
            .map_err(|error| error.to_string())?;
        Ok(item)
    }

    pub async fn rotate_image(
        &self,
        id: &str,
        quarter_turns: i32,
    ) -> Result<PasteboardItem, String> {
        let mut item = self
            .db
            .get_pasteboard_item(id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("Paste item not found: {id}"))?;
        if item.kind != PasteboardItemKind::Image {
            return Err("只有图片内容支持旋转".into());
        }
        let relative_path = item
            .payload
            .get("imageBlobPath")
            .and_then(Value::as_str)
            .ok_or_else(|| "图片没有可用的本机附件".to_string())?;
        let path = safe_blob_path(&self.blob_root, relative_path)?;
        let turns = quarter_turns.rem_euclid(4);
        if turns == 0 {
            return Ok(item);
        }
        let png = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
            let image = image::open(path).map_err(|error| error.to_string())?;
            let rotated = match turns {
                1 => image.rotate90(),
                2 => image.rotate180(),
                _ => image.rotate270(),
            };
            let mut output = std::io::Cursor::new(Vec::new());
            rotated
                .write_to(&mut output, image::ImageFormat::Png)
                .map_err(|error| error.to_string())?;
            Ok(output.into_inner())
        })
        .await
        .map_err(|error| error.to_string())??;
        let original = self.persist_blob(&png, "image/png", "png").await?;
        let thumbnail_bytes = create_image_thumbnail(&png)
            .await
            .ok_or_else(|| "旋转后的图片缩略图生成失败".to_string())?;
        let thumbnail = self
            .persist_blob(&thumbnail_bytes, "image/png", "png")
            .await?;
        let payload = item
            .payload
            .as_object_mut()
            .ok_or_else(|| "图片负载格式无效".to_string())?;
        payload.insert("imageBlobId".into(), Value::String(original.id.clone()));
        payload.insert(
            "imageBlobPath".into(),
            Value::String(original.relative_path.clone()),
        );
        payload.insert("imageMediaType".into(), Value::String("image/png".into()));
        payload.insert(
            "thumbnailBlobId".into(),
            Value::String(thumbnail.id.clone()),
        );
        payload.insert(
            "thumbnailBlobPath".into(),
            Value::String(thumbnail.relative_path.clone()),
        );
        payload.insert(
            "thumbnailMediaType".into(),
            Value::String("image/png".into()),
        );
        item.content_fingerprint = snapshot_fingerprint(&[NativePasteboardRepresentation::Image {
            bytes: png,
            media_type: "image/png".into(),
        }]);
        item.updated_at = atools_core::utils::now_iso();
        self.db
            .upsert_pasteboard_blob(&original)
            .and_then(|_| self.db.upsert_pasteboard_blob(&thumbnail))
            .and_then(|_| self.db.upsert_pasteboard_item(&item))
            .and_then(|_| {
                self.db.replace_pasteboard_item_blobs(
                    &item.id,
                    &[original.id.clone(), thumbnail.id.clone()],
                )
            })
            .map_err(|error| error.to_string())?;
        Ok(item)
    }

    async fn write_item(&self, item: &PasteboardItem, plain_text: bool) -> Result<(), String> {
        self.state.write().suppressed_fingerprint = Some(item.content_fingerprint.clone());
        if let Err(error) = self
            .backend
            .write_item(item, &self.blob_root, plain_text)
            .await
        {
            self.state.write().suppressed_fingerprint = None;
            return Err(error);
        }
        Ok(())
    }

    fn finish_capture(&self, outcome: CaptureOutcome) -> CaptureOutcome {
        let mut state = self.state.write();
        if let Some(change_count) = outcome.change_count() {
            state.change_count = change_count;
        }
        state.last_outcome = Some(outcome.clone());
        outcome
    }

    fn settings(&self) -> PasteboardRuntimeSettings {
        let Some(raw) = self.db.get_setting("settings-general").ok().flatten() else {
            return PasteboardRuntimeSettings::default();
        };
        let Ok(value) = serde_json::from_str::<Value>(&raw) else {
            return PasteboardRuntimeSettings::default();
        };
        PasteboardRuntimeSettings::from_value(&value)
    }

    async fn normalize_snapshot(
        &self,
        snapshot: NativePasteboardSnapshot,
    ) -> Result<NormalizedSnapshot, String> {
        if snapshot.representations.is_empty() {
            return Err("Clipboard snapshot has no supported representations".into());
        }
        let fingerprint = snapshot_fingerprint(&snapshot.representations);
        let mut payload = Map::new();
        let mut blobs = Vec::new();
        let mut kind = PasteboardItemKind::Text;
        let mut preview_text = None;

        for representation in &snapshot.representations {
            match representation {
                NativePasteboardRepresentation::Text(text) => {
                    validate_inline_text(text)?;
                    payload.insert("text".into(), Value::String(text.clone()));
                    preview_text.get_or_insert_with(|| text.clone());
                }
                NativePasteboardRepresentation::RichText { bytes, media_type } => {
                    kind = prefer_kind(kind, PasteboardItemKind::RichText);
                    let blob = self
                        .persist_blob(bytes, media_type, extension_for_media_type(media_type))
                        .await?;
                    payload.insert("richTextBlobId".into(), Value::String(blob.id.clone()));
                    payload.insert(
                        "richTextBlobPath".into(),
                        Value::String(blob.relative_path.clone()),
                    );
                    blobs.push(blob);
                }
                NativePasteboardRepresentation::Html(html) => {
                    validate_inline_text(html)?;
                    kind = prefer_kind(kind, PasteboardItemKind::Html);
                    payload.insert("html".into(), Value::String(html.clone()));
                }
                NativePasteboardRepresentation::Url(url) => {
                    validate_inline_text(url)?;
                    kind = prefer_kind(kind, PasteboardItemKind::Url);
                    payload.insert("url".into(), Value::String(url.clone()));
                    preview_text.get_or_insert_with(|| url.clone());
                }
                NativePasteboardRepresentation::Image { bytes, media_type } => {
                    kind = prefer_kind(kind, PasteboardItemKind::Image);
                    let blob = self
                        .persist_blob(bytes, media_type, extension_for_media_type(media_type))
                        .await?;
                    payload.insert("imageBlobId".into(), Value::String(blob.id.clone()));
                    payload.insert(
                        "imageBlobPath".into(),
                        Value::String(blob.relative_path.clone()),
                    );
                    payload.insert("imageMediaType".into(), Value::String(media_type.clone()));
                    blobs.push(blob);
                    if let Some(thumbnail_bytes) = create_image_thumbnail(bytes).await {
                        let thumbnail = self
                            .persist_blob(&thumbnail_bytes, "image/png", "png")
                            .await?;
                        payload.insert(
                            "thumbnailBlobId".into(),
                            Value::String(thumbnail.id.clone()),
                        );
                        payload.insert(
                            "thumbnailBlobPath".into(),
                            Value::String(thumbnail.relative_path.clone()),
                        );
                        payload.insert(
                            "thumbnailMediaType".into(),
                            Value::String("image/png".into()),
                        );
                        blobs.push(thumbnail);
                    }
                }
                NativePasteboardRepresentation::Pdf(bytes) => {
                    kind = prefer_kind(kind, PasteboardItemKind::Pdf);
                    let blob = self.persist_blob(bytes, "application/pdf", "pdf").await?;
                    payload.insert("pdfBlobId".into(), Value::String(blob.id.clone()));
                    payload.insert(
                        "pdfBlobPath".into(),
                        Value::String(blob.relative_path.clone()),
                    );
                    blobs.push(blob);
                }
                NativePasteboardRepresentation::Color(color) => {
                    validate_inline_text(color)?;
                    kind = prefer_kind(kind, PasteboardItemKind::Color);
                    payload.insert("color".into(), Value::String(color.clone()));
                    preview_text.get_or_insert_with(|| color.clone());
                }
                NativePasteboardRepresentation::Files(files) => {
                    kind = prefer_kind(kind, PasteboardItemKind::Files);
                    payload.insert(
                        "files".into(),
                        Value::Array(files.iter().cloned().map(Value::String).collect()),
                    );
                    preview_text.get_or_insert_with(|| files.join("\n"));
                }
            }
        }
        if let Some(preview_text) = preview_text {
            payload.insert("previewText".into(), Value::String(preview_text));
        }
        let now = if snapshot.copied_at.trim().is_empty() {
            atools_core::utils::now_iso()
        } else {
            snapshot.copied_at
        };
        let item = PasteboardItem {
            id: format!("paste-{}", uuid::Uuid::new_v4()),
            kind,
            title: None,
            source_app: snapshot.source_app,
            source_device_id: self.device_id.clone(),
            copied_at: now.clone(),
            updated_at: now,
            content_fingerprint: fingerprint,
            payload: Value::Object(payload),
            ocr_text: None,
            pinboard_id: None,
            pinboard_order_key: None,
            pinned: false,
            field_clocks: json!({}),
        };
        Ok(NormalizedSnapshot { item, blobs })
    }

    async fn persist_blob(
        &self,
        bytes: &[u8],
        media_type: &str,
        extension: &str,
    ) -> Result<PasteboardBlob, String> {
        if bytes.is_empty() {
            return Err("Clipboard attachment is empty".into());
        }
        if bytes.len() > MAX_ATTACHMENT_BYTES {
            return Err(format!(
                "Clipboard attachment exceeds {} MiB",
                MAX_ATTACHMENT_BYTES / 1024 / 1024
            ));
        }
        let hash = hex_sha256(bytes);
        let relative_path = format!("{}/{}.{}", &hash[..2], hash, extension);
        let path = safe_blob_path(&self.blob_root, &relative_path)?;
        if !path.exists() {
            let parent = path
                .parent()
                .ok_or_else(|| "Clipboard blob path has no parent".to_string())?;
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|error| error.to_string())?;
            let temporary = path.with_extension(format!("{}.tmp", extension));
            tokio::fs::write(&temporary, bytes)
                .await
                .map_err(|error| error.to_string())?;
            if let Err(error) = tokio::fs::rename(&temporary, &path).await {
                if !path.exists() {
                    let _ = tokio::fs::remove_file(&temporary).await;
                    return Err(error.to_string());
                }
                let _ = tokio::fs::remove_file(&temporary).await;
            }
        }
        let now = atools_core::utils::now_iso();
        Ok(PasteboardBlob {
            id: format!("blob-{hash}"),
            content_hash: hash,
            relative_path,
            media_type: media_type.to_string(),
            byte_size: bytes.len() as u64,
            created_at: now.clone(),
            last_accessed_at: now,
        })
    }

    async fn apply_retention(&self, settings: &PasteboardRuntimeSettings) -> Result<(), String> {
        let cutoff = atools_core::utils::iso_days_ago(settings.retention_days);
        let result = self
            .db
            .prune_pasteboard_history(&cutoff, settings.attachment_budget_bytes)
            .map_err(|error| error.to_string())?;
        remove_pruned_blobs(&self.blob_root, &result).await;
        Ok(())
    }
}

impl PasteboardRuntimeSettings {
    fn from_value(value: &Value) -> Self {
        let mut settings = Self::default();
        settings.paused = value
            .get("pasteboardCapturePaused")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        settings.retention_days = value
            .get("clipboardRetentionDays")
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_RETENTION_DAYS)
            .clamp(1, 3650);
        settings.attachment_budget_bytes = value
            .get("pasteboardAttachmentBudgetBytes")
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_ATTACHMENT_BUDGET_BYTES)
            .clamp(16 * 1024 * 1024, 1024 * 1024 * 1024 * 1024);
        settings.sensitive_content_filter = value
            .get("pasteboardExcludeSensitiveContent")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        if let Some(values) = value
            .get("pasteboardIgnoredBundleIds")
            .and_then(Value::as_array)
        {
            settings.ignored_bundle_ids.extend(
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(normalize_bundle_id)
                    .filter(|value| !value.is_empty()),
            );
        }
        settings
    }
}

struct NormalizedSnapshot {
    item: PasteboardItem,
    blobs: Vec<PasteboardBlob>,
}

fn ignored_snapshot_reason(
    snapshot: &NativePasteboardSnapshot,
    settings: &PasteboardRuntimeSettings,
) -> Option<String> {
    if snapshot.is_confidential {
        return Some("confidential".into());
    }
    if snapshot.is_transient {
        return Some("transient".into());
    }
    let bundle_id = snapshot
        .source_app
        .as_ref()
        .and_then(|source| source.bundle_id.as_deref())
        .map(normalize_bundle_id)
        .unwrap_or_default();
    if !bundle_id.is_empty() && settings.ignored_bundle_ids.contains(&bundle_id) {
        return Some("ignored_application".into());
    }
    if settings.sensitive_content_filter {
        let text = snapshot_text(snapshot);
        if looks_sensitive(&text) {
            return Some("sensitive_content".into());
        }
    }
    None
}

fn default_ignored_bundle_ids() -> BTreeSet<String> {
    [
        "com.1password.1password",
        "com.agilebits.onepassword7",
        "com.bitwarden.desktop",
        "com.lastpass.lastpassmacdesktop",
        "com.dashlane.dashlanephonefinal",
        "com.apple.keychainaccess",
    ]
    .into_iter()
    .map(str::to_string)
    .collect()
}

fn normalize_bundle_id(value: &str) -> String {
    value.trim().to_lowercase()
}

fn normalized_title(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn snapshot_text(snapshot: &NativePasteboardSnapshot) -> String {
    snapshot
        .representations
        .iter()
        .filter_map(|representation| match representation {
            NativePasteboardRepresentation::Text(value)
            | NativePasteboardRepresentation::Html(value)
            | NativePasteboardRepresentation::Url(value)
            | NativePasteboardRepresentation::Color(value) => Some(value.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn looks_sensitive(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return false;
    }
    let upper = trimmed.to_ascii_uppercase();
    if upper.contains("-----BEGIN PRIVATE KEY-----")
        || upper.contains("-----BEGIN RSA PRIVATE KEY-----")
        || upper.contains("-----BEGIN OPENSSH PRIVATE KEY-----")
        || upper.starts_with("AKIA") && upper.len() >= 20
        || upper.starts_with("GHU_")
        || upper.starts_with("GHP_")
        || upper.starts_with("SK-LIVE-")
    {
        return true;
    }
    let digits = trimmed
        .chars()
        .filter(char::is_ascii_digit)
        .collect::<String>();
    (13..=19).contains(&digits.len()) && luhn_valid(&digits)
}

fn luhn_valid(digits: &str) -> bool {
    let mut sum = 0u32;
    let parity = digits.len() % 2;
    for (index, byte) in digits.bytes().enumerate() {
        let mut digit = u32::from(byte - b'0');
        if index % 2 == parity {
            digit *= 2;
            if digit > 9 {
                digit -= 9;
            }
        }
        sum += digit;
    }
    sum % 10 == 0
}

fn snapshot_fingerprint(representations: &[NativePasteboardRepresentation]) -> String {
    let mut hasher = Sha256::new();
    for representation in representations {
        match representation {
            NativePasteboardRepresentation::Text(value) => {
                hash_tagged(&mut hasher, b"text", value.as_bytes())
            }
            NativePasteboardRepresentation::RichText { bytes, media_type } => {
                hash_tagged(&mut hasher, media_type.as_bytes(), bytes)
            }
            NativePasteboardRepresentation::Html(value) => {
                hash_tagged(&mut hasher, b"html", value.as_bytes())
            }
            NativePasteboardRepresentation::Url(value) => {
                hash_tagged(&mut hasher, b"url", value.as_bytes())
            }
            NativePasteboardRepresentation::Image { bytes, media_type } => {
                hash_tagged(&mut hasher, media_type.as_bytes(), bytes)
            }
            NativePasteboardRepresentation::Pdf(bytes) => hash_tagged(&mut hasher, b"pdf", bytes),
            NativePasteboardRepresentation::Color(value) => {
                hash_tagged(&mut hasher, b"color", value.as_bytes())
            }
            NativePasteboardRepresentation::Files(files) => {
                for file in files {
                    hash_tagged(&mut hasher, b"file", file.as_bytes());
                }
            }
        }
    }
    format!("{:x}", hasher.finalize())
}

fn hash_tagged(hasher: &mut Sha256, tag: &[u8], bytes: &[u8]) {
    hasher.update((tag.len() as u64).to_le_bytes());
    hasher.update(tag);
    hasher.update((bytes.len() as u64).to_le_bytes());
    hasher.update(bytes);
}

fn prefer_kind(current: PasteboardItemKind, candidate: PasteboardItemKind) -> PasteboardItemKind {
    if kind_priority(candidate) > kind_priority(current) {
        candidate
    } else {
        current
    }
}

fn kind_priority(kind: PasteboardItemKind) -> u8 {
    match kind {
        PasteboardItemKind::Text => 0,
        PasteboardItemKind::Url => 1,
        PasteboardItemKind::Color => 2,
        PasteboardItemKind::RichText => 3,
        PasteboardItemKind::Html => 4,
        PasteboardItemKind::Pdf => 5,
        PasteboardItemKind::Image => 6,
        PasteboardItemKind::Files => 7,
    }
}

fn validate_inline_text(value: &str) -> Result<(), String> {
    if value.len() > MAX_INLINE_TEXT_BYTES {
        return Err(format!(
            "Clipboard text exceeds {} MiB",
            MAX_INLINE_TEXT_BYTES / 1024 / 1024
        ));
    }
    Ok(())
}

fn extension_for_media_type(media_type: &str) -> &str {
    match media_type.to_ascii_lowercase().as_str() {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "text/rtf" | "application/rtf" => "rtf",
        _ => "bin",
    }
}

fn hex_sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn safe_blob_path(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let relative = Path::new(relative_path);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("Unsafe clipboard blob path".into());
    }
    Ok(root.join(relative))
}

async fn remove_pruned_blobs(root: &Path, result: &PasteboardPruneResult) {
    for relative_path in &result.deleted_blobs {
        match safe_blob_path(root, relative_path) {
            Ok(path) => {
                if let Err(error) = tokio::fs::remove_file(&path).await {
                    if error.kind() != std::io::ErrorKind::NotFound {
                        tracing::warn!(path = %path.display(), %error, "Failed to remove pruned Paste blob");
                    }
                }
            }
            Err(error) => {
                tracing::warn!(relative_path, %error, "Ignored unsafe pruned Paste blob path")
            }
        }
    }
}

async fn create_image_thumbnail(bytes: &[u8]) -> Option<Vec<u8>> {
    let bytes = bytes.to_vec();
    tauri::async_runtime::spawn_blocking(move || {
        let image = image::load_from_memory(&bytes).ok()?;
        let thumbnail = image.thumbnail(384, 256);
        let mut output = std::io::Cursor::new(Vec::new());
        thumbnail
            .write_to(&mut output, image::ImageFormat::Png)
            .ok()?;
        Some(output.into_inner())
    })
    .await
    .ok()
    .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn luhn_filter_rejects_cards_but_not_regular_numbers() {
        assert!(looks_sensitive("4242 4242 4242 4242"));
        assert!(!looks_sensitive("build 202607210001"));
    }

    #[test]
    fn snapshot_kind_prefers_files_and_images_over_text() {
        assert_eq!(
            prefer_kind(PasteboardItemKind::Text, PasteboardItemKind::Image),
            PasteboardItemKind::Image
        );
        assert_eq!(
            prefer_kind(PasteboardItemKind::Image, PasteboardItemKind::Files),
            PasteboardItemKind::Files
        );
    }

    #[test]
    fn blob_paths_reject_parent_components() {
        assert!(safe_blob_path(Path::new("/tmp/blobs"), "../secret").is_err());
        assert!(safe_blob_path(Path::new("/tmp/blobs"), "ab/hash.png").is_ok());
    }
}
