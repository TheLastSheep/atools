use super::support::{
    default_ignored_bundle_ids, DEFAULT_ATTACHMENT_BUDGET_BYTES,
    DEFAULT_LEGACY_HISTORY_RETENTION_DAYS, DEFAULT_RETENTION_DAYS,
};
use async_trait::async_trait;
use atools_core::{PasteboardBlob, PasteboardItem, PasteboardSourceApp};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::path::Path;

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
    Paused {
        change_count: i64,
    },
    Ignored {
        change_count: i64,
        reason: String,
    },
    Captured {
        item_id: String,
        change_count: i64,
        #[serde(skip)]
        legacy_text_projected: bool,
        #[serde(skip)]
        plugin_history_projected: bool,
    },
    Updated {
        item_id: String,
        change_count: i64,
        #[serde(skip)]
        legacy_text_projected: bool,
        #[serde(skip)]
        plugin_history_projected: bool,
    },
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

    pub fn legacy_text_projected(&self) -> bool {
        matches!(
            self,
            Self::Captured {
                legacy_text_projected: true,
                ..
            } | Self::Updated {
                legacy_text_projected: true,
                ..
            }
        )
    }

    pub fn plugin_history_projected(&self) -> bool {
        matches!(
            self,
            Self::Captured {
                plugin_history_projected: true,
                ..
            } | Self::Updated {
                plugin_history_projected: true,
                ..
            }
        )
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

    /// Read a bounded, current-context snapshot without requiring a change count supplied by the caller.
    /// Backends that only implement change-count reads may use the reserved sentinel default;
    /// production Native backends should override this to select only the required representations.
    async fn current_context_snapshot(&self) -> Result<Option<NativePasteboardSnapshot>, String> {
        self.snapshot_if_changed(i64::MIN).await
    }

    /// Read only the current OS change count so stale content can be waited out without re-copying it.
    async fn current_change_count(&self) -> Result<Option<i64>, String> {
        Ok(self
            .current_context_snapshot()
            .await?
            .map(|snapshot| snapshot.change_count))
    }

    async fn write_item(
        &self,
        item: &PasteboardItem,
        blob_root: &Path,
        plain_text: bool,
    ) -> Result<(), String>;

    async fn paste_frontmost(&self) -> Result<(), String>;
}

#[derive(Debug, Clone)]
pub(super) struct CaptureState {
    pub(super) change_count: i64,
    pub(super) last_outcome: Option<CaptureOutcome>,
    pub(super) suppressed_fingerprint: Option<String>,
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
pub(super) struct PasteboardRuntimeSettings {
    pub(super) paused: bool,
    pub(super) retention_days: u64,
    pub(super) legacy_history_retention_days: u64,
    pub(super) attachment_budget_bytes: u64,
    pub(super) ignored_bundle_ids: BTreeSet<String>,
    pub(super) sensitive_content_filter: bool,
}

impl Default for PasteboardRuntimeSettings {
    fn default() -> Self {
        Self {
            paused: false,
            retention_days: DEFAULT_RETENTION_DAYS,
            legacy_history_retention_days: DEFAULT_LEGACY_HISTORY_RETENTION_DAYS,
            attachment_budget_bytes: DEFAULT_ATTACHMENT_BUDGET_BYTES,
            ignored_bundle_ids: default_ignored_bundle_ids(),
            sensitive_content_filter: true,
        }
    }
}
pub(super) struct NormalizedSnapshot {
    pub(super) item: PasteboardItem,
    pub(super) blobs: Vec<PasteboardBlob>,
}
