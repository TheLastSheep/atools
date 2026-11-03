use crate::{ai_runtime::AiCancelHandle, plugin_page_runtime::DocumentBinding};
use atools_core::{
    agent::PermissionDecision,
    ai_service::{AiAssistantMessage, AiRequest},
    Plugin,
};
use parking_lot::Mutex;
use serde::Serialize;
use sha2::Digest;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

pub(crate) const SOURCE: &str = "plugin_ai";
pub(super) const PREPARED_LEASE: Duration = Duration::from_secs(120);
pub(super) const RUN_LEASE: Duration = Duration::from_secs(120);
pub(super) const RESULT_LEASE: Duration = Duration::from_secs(15);
pub(super) const MAX_REQUESTS: usize = 4;
pub(super) const MAX_REQUEST_BYTES: usize = 3 * 1024 * 1024;
pub(super) const MAX_RUNNING: usize = 2;
pub(super) const MAX_PER_PLUGIN: usize = 1;
pub(super) const MAX_ENVELOPE: usize = 16 * 1024;
pub(super) const ACK_LEASE: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(super) struct Owner {
    pub window: String,
    pub plugin: String,
    pub instance: String,
}
impl Owner {
    pub fn new(window: &str, plugin: &str, instance: &str) -> Result<Self, String> {
        if plugin.is_empty()
            || plugin.len() > 256
            || plugin.trim() != plugin
            || plugin.chars().any(char::is_control)
        {
            return Err("Invalid AI plugin owner".into());
        }
        let instance = uuid::Uuid::parse_str(instance)
            .map_err(|_| "Invalid AI instance")?
            .to_string();
        Ok(Self {
            window: window.into(),
            plugin: plugin.into(),
            instance,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct FrameBinding {
    pub generation: u64,
    pub nonce: String,
    pub page_document_id: Option<String>,
}
impl FrameBinding {
    pub fn validate(
        generation: u64,
        nonce: String,
        page_document_id: Option<String>,
    ) -> Result<Self, String> {
        if generation == 0
            || generation > 9_007_199_254_740_991
            || nonce.len() != 32
            || !nonce.bytes().all(|b| b.is_ascii_hexdigit())
            || page_document_id
                .as_ref()
                .is_some_and(|v| v.is_empty() || v.len() > 256 || v.chars().any(char::is_control))
        {
            return Err("Invalid AI frame identity".into());
        }
        Ok(Self {
            generation,
            nonce: nonce.to_ascii_lowercase(),
            page_document_id,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Binding {
    pub path: String,
    pub version: String,
    pub code_revision: Option<String>,
    pub settings_revision: String,
}
impl Binding {
    pub fn current(db: &atools_core::Database, plugin: &Plugin) -> Result<Self, String> {
        if !plugin.enabled {
            return Err("Plugin is disabled".into());
        }
        let raw = db
            .get_setting("settings-general")
            .map_err(|_| "AI settings unavailable")?
            .unwrap_or_else(|| "{}".into());
        let revision = settings_revision(&raw).ok_or("AI settings unavailable")?;
        let code_revision = crate::plugin_code_revision::current(db, &plugin.id)
            .map_err(|_| "AI plugin unavailable")?;
        Ok(Self {
            path: plugin.path.clone(),
            version: plugin.version.clone(),
            code_revision,
            settings_revision: revision,
        })
    }
    pub fn validate(&self, db: &atools_core::Database, plugin: &str) -> Result<(), String> {
        let current = db.get_plugin(plugin).map_err(|_| "AI plugin unavailable")?;
        if &Self::current(db, &current)? != self {
            return Err("AI plugin or settings changed".into());
        }
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AiDeltaEnvelope {
    pub kind: String,
    pub request_id: String,
    pub seq: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delta: Option<atools_core::ai_service::AiDelta>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_bytes: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Mode {
    Stream,
    Collect,
}
impl Mode {
    pub fn parse(v: &str) -> Result<Self, String> {
        match v {
            "stream" => Ok(Self::Stream),
            "collect" => Ok(Self::Collect),
            _ => Err("Invalid AI output mode".into()),
        }
    }
}

pub(super) struct Request {
    pub id: String,
    pub client_id: String,
    pub owner: Owner,
    pub frame: FrameBinding,
    pub document: Option<DocumentBinding>,
    pub binding: Binding,
    pub tool: String,
    pub permission_at_prepare: PermissionDecision,
    pub mode: Mode,
    pub model: String,
    pub request: Mutex<Option<AiRequest>>,
    pub created: Instant,
    pub cancel: AiCancelHandle,
    pub run_id: Mutex<Option<String>>,
    pub submitted: Mutex<bool>,
    pub started: Mutex<bool>,
    pub task_terminal: Mutex<bool>,
    pub running_at: Mutex<Option<Instant>>,
    pub output: Mutex<Option<AiAssistantMessage>>,
    pub output_bytes: Mutex<usize>,
    pub delta_count: Mutex<u64>,
    pub expires_result: Mutex<Option<Instant>>,
    pub channel: Mutex<Option<tauri::ipc::Channel<AiDeltaEnvelope>>>,
    pub ack: Mutex<Option<(u64, bool, Arc<tokio::sync::Notify>)>>,
    pub active: Mutex<bool>,
}
impl Request {
    pub fn valid(&self) -> bool {
        let now = Instant::now();
        let lifetime_ok = if let Some(deadline) = *self.expires_result.lock() {
            deadline > now
        } else if let Some(at) = *self.running_at.lock() {
            at.elapsed() < RUN_LEASE
        } else {
            self.created.elapsed() < PREPARED_LEASE
        };
        *self.active.lock()
            && lifetime_ok
            && self
                .document
                .as_ref()
                .is_none_or(DocumentBinding::is_active)
    }
}

pub(super) struct Tombstone {
    pub owner: Owner,
    pub frame: FrameBinding,
    pub expires: Instant,
}

pub(crate) fn settings_revision(raw: &str) -> Option<String> {
    let settings: serde_json::Value = serde_json::from_str(raw).ok()?;
    let mut projection = serde_json::Map::new();
    for key in [
        "aiProvider",
        "aiBaseUrl",
        "aiDefaultModel",
        "aiApiKey",
        "aiTemperature",
        "proxyEnabled",
        "proxyUrl",
    ] {
        if let Some(value) = settings.get(key) {
            projection.insert(key.to_owned(), value.clone());
        }
    }
    Some(format!(
        "{:x}",
        sha2::Sha256::digest(serde_json::to_vec(&projection).ok()?)
    ))
}
