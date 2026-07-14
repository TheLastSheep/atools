use crate::desktop_smoke::PluginPanelRenderSmokeSummary;
use crate::mcp_server::McpServerStatus;
use atools_core::agent::PendingAgentToolRequest;
use atools_core::config::AppConfig;
use atools_core::db::Database;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::Arc;

#[derive(Debug, Clone, serde::Serialize)]
pub struct RuntimeEvent {
    pub timestamp: String,
    pub level: String,
    pub message: String,
}

impl RuntimeEvent {
    pub fn new(level: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            timestamp: atools_core::utils::now_iso(),
            level: level.into(),
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ReleaseSmokeProgress {
    pub token: String,
    pub report_path: Option<String>,
    pub option_z_toggled: Option<bool>,
    pub settings_page_opened: Option<bool>,
    pub plugin_page_opened: Option<bool>,
    pub agent_page_opened: Option<bool>,
    pub errors: Vec<String>,
    pub completed: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ReleaseSmokeConfig {
    pub token: String,
    pub report_path: Option<String>,
}

pub struct AppState {
    pub config: AppConfig,
    pub db: Arc<Database>,
    pub active_plugin: Mutex<Option<String>>,
    pub mcp_status: Mutex<Option<McpServerStatus>>,
    pub pending_agent_requests: Mutex<BTreeMap<String, PendingAgentToolRequest>>,
    pub runtime_events: Mutex<Vec<RuntimeEvent>>,
    pub plugin_panel_render_smoke: Mutex<Option<PluginPanelRenderSmokeSummary>>,
    pub release_smoke: Mutex<Option<ReleaseSmokeConfig>>,
    pub release_smoke_progress: Mutex<ReleaseSmokeProgress>,
}

impl AppState {
    pub fn new(
        config: AppConfig,
        db: Arc<Database>,
        release_smoke: Option<ReleaseSmokeConfig>,
    ) -> Self {
        Self {
            config,
            db,
            active_plugin: Mutex::new(None),
            mcp_status: Mutex::new(None),
            pending_agent_requests: Mutex::new(BTreeMap::new()),
            runtime_events: Mutex::new(Vec::new()),
            plugin_panel_render_smoke: Mutex::new(None),
            release_smoke: Mutex::new(release_smoke),
            release_smoke_progress: Mutex::new(ReleaseSmokeProgress::default()),
        }
    }

    pub fn record_runtime_event(&self, level: impl Into<String>, message: impl Into<String>) {
        let mut events = self.runtime_events.lock();
        events.push(RuntimeEvent::new(level, message));
        const MAX_RUNTIME_EVENTS: usize = 100;
        let overflow = events.len().saturating_sub(MAX_RUNTIME_EVENTS);
        if overflow > 0 {
            events.drain(0..overflow);
        }
    }
}
