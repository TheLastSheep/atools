//! Private runtime state; entry anchors and credentials are never serialized.
use super::native_image::NativeImageEngine;
use super::native_image_session::ImageSessionStore;
use crate::plugin_page_runtime::DocumentBinding;
use atools_plugin::LegacyNodeSession;
use parking_lot::Mutex;
use serde_json::Value;
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Instant,
};

#[derive(Clone)]
pub struct Intent {
    pub owner: String,
    pub document: Option<DocumentBinding>,
    pub client: String,
    pub plugin_id: String,
    pub cancelled: Arc<AtomicBool>,
    pub claimed: Arc<AtomicBool>,
    pub created: Instant,
    pub run_id: Arc<Mutex<Option<String>>>,
    pub(super) selected: Option<super::node_selected_entry::SelectedPreload>,
    #[cfg(feature = "legacy-node-smoke")]
    pub(super) startup_diagnostic:
        Option<super::native_node_startup_fixture::StartupDiagnosticPermit>,
}
pub struct Session {
    pub id: String,
    pub owner: String,
    pub document: Option<DocumentBinding>,
    pub client: String,
    pub plugin_id: String,
    pub plugin_path: String,
    pub version: String,
    pub token: String,
    pub tool: String,
    pub runtime: LegacyNodeSession,
    pub(super) closing: AtomicBool,
    pub(super) native_image_engine: Arc<NativeImageEngine>,
    pub(super) native_image_store: ImageSessionStore,
}
impl Session {
    pub(super) fn mark_closing(&self) {
        self.closing.store(true, Ordering::Release);
    }

    pub(super) fn is_closing(&self) -> bool {
        self.closing.load(Ordering::Acquire)
    }
}
pub struct Invocation {
    pub session_id: String,
    pub request: Value,
    pub claimed: AtomicBool,
    pub run_id: Mutex<Option<String>>,
    pub result: Mutex<Option<Result<Value, String>>>,
}

#[cfg(feature = "legacy-node-smoke")]
impl Session {
    pub(crate) fn smoke_native_image_engine(&self) -> Arc<NativeImageEngine> {
        Arc::clone(&self.native_image_engine)
    }
}
