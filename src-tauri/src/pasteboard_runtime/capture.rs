use super::history_projection::record_plugin_media_projection;
use super::model::{
    CaptureOutcome, NativePasteboardRepresentation, NativePasteboardSnapshot, NormalizedSnapshot,
    PasteboardRuntimeSettings,
};
use super::runtime_ops::PasteboardRuntime;
use super::support::{
    create_image_thumbnail, default_ignored_bundle_ids, extension_for_media_type,
    ignored_snapshot_reason, normalize_bundle_id, prefer_kind, remove_pruned_blobs,
    snapshot_fingerprint, validate_inline_text, DEFAULT_ATTACHMENT_BUDGET_BYTES,
    DEFAULT_LEGACY_HISTORY_RETENTION_DAYS, DEFAULT_RETENTION_DAYS,
};
use atools_core::{PasteboardBlob, PasteboardItem, PasteboardItemKind};
use serde_json::{json, Map, Value};

impl PasteboardRuntime {
    pub async fn capture_once(&self) -> Result<CaptureOutcome, String> {
        let previous_change_count = self.state.read().change_count;
        let Some(observed) = self
            .snapshot_if_changed_observed(previous_change_count)
            .await?
        else {
            return Ok(CaptureOutcome::Unchanged);
        };
        let snapshot = observed.snapshot;

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

        let retention_cutoff =
            atools_core::utils::iso_days_ago(settings.legacy_history_retention_days);
        let mut plugin_history_projected =
            record_plugin_media_projection(&self.db, &item, &self.blob_root, &retention_cutoff);
        self.apply_retention(&settings).await?;
        if plugin_history_projected {
            let projection_kind = match item.kind {
                PasteboardItemKind::Image => "image",
                PasteboardItemKind::Files => "file",
                _ => unreachable!("only image and file captures use media projections"),
            };
            plugin_history_projected = match self
                .db
                .plugin_clipboard_history_projection_exists(&item.id, projection_kind)
            {
                Ok(exists) => exists,
                Err(error) => {
                    tracing::warn!(item_id = %item.id, %error, "Unable to confirm retained clipboard media projection");
                    false
                }
            };
        }

        let mut legacy_text_projected = false;
        if let Some(text) = legacy_history_text(item.kind, &item.payload) {
            // Blank and oversized text is intentionally omitted from the bounded legacy API.

            if !text.trim().is_empty()
                && text.len() <= atools_core::db::CLIPBOARD_HISTORY_TEXT_BYTES_MAX
            {
                let recorded = self
                    .db
                    .record_clipboard_capture_projection(
                        text,
                        &item.copied_at,
                        &self.device_id,
                        &self.capture_epoch_id,
                        snapshot.change_count,
                        &snapshot_fingerprint,
                        &retention_cutoff,
                    )
                    .map_err(|error| error.to_string())?;
                plugin_history_projected |=
                    recorded && item.copied_at.as_str() >= retention_cutoff.as_str();
                legacy_text_projected = true;
            }
        }

        let outcome = if updated {
            CaptureOutcome::Updated {
                item_id: item.id,
                change_count: snapshot.change_count,
                legacy_text_projected,
                plugin_history_projected,
            }
        } else {
            CaptureOutcome::Captured {
                item_id: item.id,
                change_count: snapshot.change_count,
                legacy_text_projected,
                plugin_history_projected,
            }
        };
        Ok(self.finish_capture(outcome))
    }
    pub(super) fn settings(&self) -> PasteboardRuntimeSettings {
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
    pub(super) fn from_value(value: &Value) -> Self {
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
        settings.legacy_history_retention_days = value
            .get("clipboardRetentionDays")
            .and_then(Value::as_u64)
            .unwrap_or(DEFAULT_LEGACY_HISTORY_RETENTION_DAYS)
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

pub(super) fn legacy_history_text(kind: PasteboardItemKind, payload: &Value) -> Option<&str> {
    if kind != PasteboardItemKind::Text {
        return None;
    }
    payload.get("text").and_then(Value::as_str)
}
