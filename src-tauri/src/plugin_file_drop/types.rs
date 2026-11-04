use crate::plugin_page_runtime::DocumentBinding;
use atools_core::{Database, Plugin};
use parking_lot::Mutex;
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};

pub(super) const MAX_FILES: usize = 16;
pub(super) const MAX_FILE_BYTES: usize = 4 * 1024 * 1024;
pub(super) const MAX_TOTAL_BYTES: usize = 8 * 1024 * 1024;
pub(super) const MAX_HEADER_BYTES: usize = 128 * 1024;
pub(super) const MAX_INTENTS: usize = 4;
pub(super) const MAX_REQUESTS: usize = 4;
pub(super) const LEASE: Duration = Duration::from_secs(120);
pub(super) const SOURCE: &str = "plugin_file_drop";

pub(super) fn opaque_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Owner {
    pub window: String,
    pub plugin: String,
    pub instance: String,
}
impl Owner {
    pub fn new(window: &str, plugin: &str, instance: &str) -> Result<Self, String> {
        if window != "main"
            || plugin.is_empty()
            || plugin.len() > 256
            || plugin.trim() != plugin
            || plugin.chars().any(char::is_control)
        {
            return Err("Invalid file-drop owner".into());
        }
        let instance = uuid::Uuid::parse_str(instance)
            .map_err(|_| "Invalid file-drop instance")?
            .to_string();
        Ok(Self {
            window: window.into(),
            plugin: plugin.into(),
            instance,
        })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Binding {
    pub(super) path: String,
    pub(super) version: String,
    pub(super) revision: Option<String>,
}
impl Binding {
    pub fn current(db: &Database, plugin: &Plugin) -> Result<Self, String> {
        if !plugin.enabled {
            return Err("Plugin is disabled".into());
        }
        Ok(Self {
            path: plugin.path.clone(),
            version: plugin.version.clone(),
            revision: crate::plugin_code_revision::current(db, &plugin.id)?,
        })
    }
    pub fn validate(&self, db: &Database, plugin: &str) -> Result<(), String> {
        let current = db.get_plugin(plugin).map_err(|_| "Plugin unavailable")?;
        if &Self::current(db, &current)? != self {
            return Err("Plugin changed; reopen it".into());
        }
        Ok(())
    }
}

pub(super) struct Selection {
    pub id: String,
    pub window: String,
    pub paths: Vec<PathBuf>,
    pub point_x: f64,
    pub point_y: f64,
    pub scale: f64,
    pub file_count: usize,
    pub valid: bool,
    pub created: Instant,
}
pub(super) struct Request {
    pub id: String,
    pub selection_id: String,
    pub owner: Owner,
    pub binding: Binding,
    pub document: Option<DocumentBinding>,
    pub generation: u64,
    pub nonce: String,
    pub tool: String,
    pub permission_at_prepare: atools_core::agent::PermissionDecision,
    pub created: Instant,
    pub selection: Mutex<Option<Vec<PathBuf>>>,
    pub run_id: Mutex<Option<String>>,
    pub read_started: Mutex<bool>,
    pub payload: Mutex<Option<Vec<u8>>>,
}
impl Request {
    pub fn valid(&self) -> bool {
        self.created.elapsed() < LEASE
            && self
                .document
                .as_ref()
                .is_none_or(DocumentBinding::is_active)
    }
}
