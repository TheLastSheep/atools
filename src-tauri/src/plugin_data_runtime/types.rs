//! Private in-memory identities. None of these payloads implement Serialize.
use crate::plugin_page_runtime::DocumentBinding;
use atools_core::{Database, Plugin};
use parking_lot::Mutex;
use serde_json::Value;
use std::{
    sync::{atomic::AtomicBool, Arc},
    time::Instant,
};

pub(super) fn credential() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

#[derive(Clone, Debug, PartialEq, Eq)]
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
            return Err("Invalid plugin identity".into());
        }
        let instance = uuid::Uuid::parse_str(instance)
            .map_err(|_| "Invalid plugin data instance")?
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
    pub path: String,
    pub version: String,
    pub revision: Option<String>,
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
        let current = db.get_plugin(plugin).map_err(|_| "Plugin is unavailable")?;
        if &Self::current(db, &current)? != self {
            return Err("Plugin changed; reopen it before accessing data".into());
        }
        Ok(())
    }
}

#[derive(Clone)]
pub(super) struct Intent {
    pub owner: Owner,
    pub document: Option<DocumentBinding>,
    pub binding: Binding,
    pub created: Instant,
    pub run: Arc<Mutex<Option<String>>>,
}
pub(super) struct Session {
    pub id: String,
    pub token: String,
    pub owner: Owner,
    pub document: Option<DocumentBinding>,
    pub binding: Binding,
    pub tool: String,
    pub active: Mutex<bool>,
    pub opening_run: Arc<Mutex<Option<String>>>,
}
pub(super) struct Invocation {
    pub session: String,
    pub request: Value,
    pub claimed: AtomicBool,
    pub dynamic_features_changed: AtomicBool,
    pub run: Mutex<Option<String>>,
    pub result: Mutex<Option<Result<Value, String>>>,
}

pub(super) fn same_token(expected: &str, supplied: &str) -> bool {
    expected.len() == supplied.len()
        && expected
            .bytes()
            .zip(supplied.bytes())
            .fold(0u8, |difference, (a, b)| difference | (a ^ b))
            == 0
}
