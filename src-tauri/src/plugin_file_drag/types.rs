//! Private in-memory identities for authenticated native file drag.
use crate::plugin_page_runtime::DocumentBinding;
use atools_core::{Database, Plugin};
use parking_lot::Mutex;
use serde_json::Value;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tokio::sync::oneshot;

pub(super) const SESSION_TTL: Duration = Duration::from_secs(600);
pub(super) const MAX_SESSIONS: usize = 4;
pub(super) const MAX_PENDING_INTENTS: usize = 32;
pub(super) const MAX_INVOCATIONS: usize = 4;
pub(super) const START_ACK_TIMEOUT: Duration = Duration::from_secs(2);
pub(super) const INVOCATION_PENDING: u8 = 0;
pub(super) const INVOCATION_STARTING: u8 = 1;
pub(super) const INVOCATION_STARTED: u8 = 2;
pub(super) const INVOCATION_FINISHED: u8 = 3;
pub(super) const INVOCATION_CANCELLED_BEFORE_START: u8 = 4;

pub(super) fn credential() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
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
            return Err("Invalid native file-drag owner".into());
        }
        let instance = uuid::Uuid::parse_str(instance)
            .map_err(|_| "Invalid native file-drag instance")?
            .to_string();
        Ok(Self {
            window: window.into(),
            plugin: plugin.into(),
            instance,
        })
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn key(&self) -> String {
        format!("window:{}:{}", self.window, self.instance)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Binding {
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
            return Err("Plugin changed; reopen it before dragging files".into());
        }
        Ok(())
    }
}

#[derive(Clone)]
pub(crate) struct Intent {
    pub owner: Owner,
    pub document: Option<DocumentBinding>,
    pub binding: Binding,
    #[allow(dead_code)]
    pub created: Instant,
    pub cancelled: Arc<AtomicBool>,
    pub run: Arc<Mutex<Option<String>>>,
}

pub(crate) struct Session {
    pub id: String,
    pub token: String,
    pub owner: Owner,
    pub document: Option<DocumentBinding>,
    pub binding: Binding,
    pub tool: String,
    pub once_authorization: Option<super::authorization::OnceAuthorization>,
    #[allow(dead_code)]
    pub created: Instant,
    pub expires_at: Instant,
    pub active: AtomicBool,
}

impl Session {
    pub fn valid(&self) -> bool {
        self.active.load(Ordering::Acquire)
            && Instant::now() < self.expires_at
            && self
                .document
                .as_ref()
                .is_none_or(DocumentBinding::is_active)
    }

    pub fn expired(&self) -> bool {
        Instant::now() >= self.expires_at
    }
}

pub(crate) struct Invocation {
    pub id: String,
    pub session: String,
    pub owner: Owner,
    pub plugin: String,
    pub document: Option<DocumentBinding>,
    pub paths: Mutex<Option<Vec<PathBuf>>>,
    pub claimed: AtomicBool,
    pub phase: AtomicU8,
    pub cancelled: Arc<AtomicBool>,
    pub run: Mutex<Option<String>>,
    pub acknowledgement: Mutex<Option<oneshot::Sender<Result<Value, String>>>>,
}

impl Invocation {
    pub fn begin_start(&self) -> bool {
        if self.cancelled.load(Ordering::Acquire) {
            return false;
        }
        self.phase
            .compare_exchange(
                INVOCATION_PENDING,
                INVOCATION_STARTING,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
    }

    pub fn mark_started(&self) {
        self.phase.store(INVOCATION_STARTED, Ordering::Release);
    }

    pub fn mark_finished(&self) {
        self.phase.store(INVOCATION_FINISHED, Ordering::Release);
    }

    pub fn is_started(&self) -> bool {
        self.phase.load(Ordering::Acquire) == INVOCATION_STARTED
    }

    /// Returns true only when cancellation won before native start began.
    pub fn cancel_before_start(&self) -> bool {
        self.cancelled.store(true, Ordering::Release);
        self.phase
            .compare_exchange(
                INVOCATION_PENDING,
                INVOCATION_CANCELLED_BEFORE_START,
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
    }

    pub fn phase(&self) -> u8 {
        self.phase.load(Ordering::Acquire)
    }

    pub fn acknowledge(&self, result: Result<Value, String>) -> bool {
        self.acknowledgement
            .lock()
            .take()
            .is_some_and(|sender| sender.send(result).is_ok())
    }
}

pub(super) fn same_token(expected: &str, supplied: &str) -> bool {
    expected.len() == supplied.len()
        && expected
            .bytes()
            .zip(supplied.bytes())
            .fold(0u8, |difference, (a, b)| difference | (a ^ b))
            == 0
}
