use crate::plugin_page_runtime::DocumentBinding;
use atools_core::{Database, Plugin};
use parking_lot::Mutex;
use serde_json::Value;
use std::{
    sync::{atomic::AtomicBool, Arc},
    time::Instant,
};
use zeroize::Zeroizing;

pub(super) fn credential() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}
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
            return Err("Invalid plugin identity".into());
        }
        let instance = uuid::Uuid::parse_str(instance)
            .map_err(|_| "Invalid plugin instance")?
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
    pub fn validate(&self, db: &Database, id: &str) -> Result<(), String> {
        let plugin = db.get_plugin(id).map_err(|_| "Plugin unavailable")?;
        if Self::current(db, &plugin)? != *self {
            return Err("Plugin code changed".into());
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
    pub cancelled: Arc<AtomicBool>,
}
pub(super) struct Session {
    pub id: String,
    pub token: String,
    pub owner: Owner,
    pub document: Option<DocumentBinding>,
    pub binding: Binding,
    pub tool: String,
    pub key: Mutex<Zeroizing<[u8; 32]>>,
    pub once: Option<super::once_authorization::OnceAuthorization>,
    pub active: Mutex<bool>,
}
pub(super) struct Invocation {
    pub session: String,
    pub request: Value,
    pub run: Mutex<Option<String>>,
    pub claimed: AtomicBool,
    pub result: Mutex<Option<Result<Value, String>>>,
}
pub(super) fn same_token(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |d, (x, y)| d | (x ^ y)) == 0
}
