use super::current_context_runtime::CurrentContextObservation;
use super::model::{
    CaptureOutcome, CaptureState, NativePasteboardRepresentation, PasteOutcome, PasteStackStatus,
    PasteboardBackend, PasteboardCaptureStatus,
};
use super::support::{
    create_image_thumbnail, extension_for_media_type, hex_sha256, normalized_title, safe_blob_path,
    snapshot_fingerprint, validate_inline_text, MAX_ATTACHMENT_BYTES,
};
use atools_core::{
    AppConfig, Database, PasteboardBlob, PasteboardItem, PasteboardItemKind, PasteboardSourceApp,
};
use parking_lot::{Mutex, RwLock};
use serde_json::{json, Value};
use std::collections::{BTreeSet, VecDeque};
use std::path::PathBuf;
use std::sync::Arc;

pub struct PasteboardRuntime {
    pub(super) backend: Arc<dyn PasteboardBackend>,
    pub(super) db: Arc<Database>,
    pub(super) blob_root: PathBuf,
    pub(super) device_id: String,
    pub(super) capture_epoch_id: String,
    pub(super) state: RwLock<CaptureState>,
    pub(super) current_context_observation: Arc<Mutex<CurrentContextObservation>>,
    pub(super) snapshot_gate: Arc<tokio::sync::Mutex<()>>,
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
            // A fresh epoch lets OS change-count reuse after restart create a new projection.
            capture_epoch_id: uuid::Uuid::new_v4().to_string(),
            state: RwLock::new(CaptureState::default()),
            current_context_observation: Arc::new(Mutex::new(CurrentContextObservation::default())),
            snapshot_gate: Arc::new(tokio::sync::Mutex::new(())),
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
    pub(super) fn finish_capture(&self, outcome: CaptureOutcome) -> CaptureOutcome {
        let mut state = self.state.write();
        if let Some(change_count) = outcome.change_count() {
            state.change_count = change_count;
        }
        state.last_outcome = Some(outcome.clone());
        outcome
    }
    pub(super) async fn persist_blob(
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
}
