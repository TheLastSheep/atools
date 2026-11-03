//! SQLite-backed database layer for ATools.
//!
//! The public database handle and domain-specific persistence modules are kept
//! separate so each persistence responsibility can be reviewed in isolation.
use std::path::Path;
use std::sync::Arc;

use parking_lot::Mutex;
use rusqlite::Connection;

use crate::error::Result;

mod agent_tools;
mod attachments;
mod audit;
mod bounded_json;
pub use bounded_json::serialized_size as bounded_json_serialized_size;
mod clipboard_history;
mod feature_catalog;
mod feature_label_schema;
mod features;
mod general_settings_write;
mod memory;
mod pasteboard_items;
mod pasteboard_support;
mod plugin_clipboard_history;
mod plugin_clipboard_history_validation;
mod plugin_data;
mod plugin_data_attachments;
mod plugin_data_contract;
mod plugin_data_read;
mod plugin_data_storage;
mod plugin_data_write;
mod plugin_dynamic_features;
mod plugin_dynamic_features_contract;
mod plugin_dynamic_features_index;
mod plugin_web_storage;
mod plugins;
mod renderer_app_state;
mod renderer_app_global_shortcuts;
mod renderer_command_aliases;
mod renderer_command_catalog;
mod renderer_disabled_commands;
mod renderer_general_settings;
mod renderer_local_shortcuts;
mod renderer_recommendation_pins;
mod schema;
mod settings;
mod skills;
mod task_run_claim;
mod task_runs;

#[cfg(test)]
mod tests;

pub use clipboard_history::{
    ClipboardHistoryPage, ClipboardHistoryPageItem, CLIPBOARD_HISTORY_TEXT_BYTES_MAX,
};
pub use general_settings_write::{GeneralSettingsWritePlan, DEFAULT_SHOW_TRAY_ICON};
pub use plugin_clipboard_history::{PluginClipboardHistoryPage, PluginClipboardHistoryPageItem};
pub use plugin_data_attachments::PluginDataAttachmentMetadata;
pub use plugin_data_contract::{
    PluginDataQuery, PluginDataRemove, PluginDataWriteResult, PLUGIN_DATA_MAX_DOCUMENTS,
    PLUGIN_DATA_MAX_DOCUMENT_BYTES, PLUGIN_DATA_MAX_KEYS, PLUGIN_DATA_MAX_RESPONSE_BYTES,
};
pub use plugin_web_storage::{
    PluginWebStorageChange, PluginWebStorageEntriesPage, PluginWebStorageEntry,
    PluginWebStorageError, PLUGIN_WEB_STORAGE_ENTRIES_PAGE_BUDGET_BYTES,
    PLUGIN_WEB_STORAGE_KEYS_OUTPUT_BUDGET_BYTES, PLUGIN_WEB_STORAGE_MAX_ENTRIES,
    PLUGIN_WEB_STORAGE_MAX_KEYS_BYTES, PLUGIN_WEB_STORAGE_MAX_KEY_BYTES,
    PLUGIN_WEB_STORAGE_MAX_TOTAL_BYTES, PLUGIN_WEB_STORAGE_MAX_VALUE_BYTES,
};
pub use renderer_app_global_shortcuts::{
    AppGlobalShortcutBinding, AppGlobalShortcutMutation, AppGlobalShortcutSnapshot,
    AppGlobalShortcutWrite, AppGlobalShortcutWritePlan, APP_GLOBAL_SHORTCUTS_KEY,
    APP_GLOBAL_SHORTCUT_TARGETS_KEY, APP_GLOBAL_SHORTCUT_REVISION_KEY,
    APP_GLOBAL_SHORTCUT_CONFLICT, APP_GLOBAL_SHORTCUT_GUARD_REJECTED,
};
pub use renderer_app_state::{
    RendererAppIdentity, RendererAppStateMutation, RendererAppStateSnapshot, RendererDirectSubtype,
    RENDERER_APP_STATE_GUARD_REJECTED,
};
pub use renderer_command_aliases::{
    normalize_renderer_command_aliases, RendererCommandAliasesSnapshot, RendererCommandAliasesWrite,
};
pub use renderer_command_catalog::{
    RendererCommandCatalogSnapshot, RENDERER_COMMAND_CATALOG_MAX_PLUGINS,
};
pub use renderer_disabled_commands::{
    RendererDisabledCommandsWrite, RENDERER_DISABLED_COMMANDS_CONFLICT,
    RENDERER_DISABLED_COMMANDS_GUARD_REJECTED, RENDERER_DISABLED_COMMANDS_KEY,
};
pub use renderer_general_settings::{
    renderer_general_settings_clipboard_retention_days, renderer_general_settings_row_count,
    renderer_general_settings_window_default_height, validate_renderer_general_settings_patch,
    RENDERER_GENERAL_SETTINGS_FIELDS,
};
pub use renderer_local_shortcuts::{
    RendererLocalShortcut, RendererLocalShortcutIdentity, RendererLocalShortcutMutation,
    RendererLocalShortcutType, RendererLocalShortcutWrite, RENDERER_LOCAL_SHORTCUTS_GUARD_REJECTED,
    RENDERER_LOCAL_SHORTCUTS_KEY,
};
pub use renderer_recommendation_pins::{
    validate_renderer_recommendation_pin, RendererRecommendationPinsMutation,
    RendererRecommendationPinsWrite, RENDERER_RECOMMENDATION_PINS_CONFLICT,
    RENDERER_RECOMMENDATION_PINS_GUARD_REJECTED, RENDERER_RECOMMENDATION_PINS_KEY,
};

/// Central database handle wrapping a SQLite connection.
///
/// Thread-safe via `Arc<Mutex<Connection>>` using `parking_lot::Mutex` for
/// better performance than `std::sync::Mutex` in low-contention scenarios.
#[derive(Clone)]
pub struct Database {
    conn: Arc<Mutex<Connection>>,
    feature_catalog: Arc<Mutex<feature_catalog::FeatureCatalogCache>>,
}

impl Database {
    /// Opens or creates a SQLite database at the given path and runs migrations.
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let _ = conn.pragma_update(None, "journal_mode", "WAL");
        let _ = conn.pragma_update(None, "synchronous", "NORMAL");
        let _ = conn.pragma_update(None, "temp_store", "MEMORY");
        let _ = conn.pragma_update(None, "cache_size", -16000i32);
        let _ = conn.pragma_update(None, "mmap_size", 268_435_456i64);
        let _ = conn.busy_timeout(std::time::Duration::from_millis(5000));
        let db = Self {
            conn: Arc::new(Mutex::new(conn)),
            feature_catalog: Arc::default(),
        };
        db.run_migrations()?;
        Ok(db)
    }

    /// Opens the default database at `~/.atools/data.db`.
    pub fn new() -> Result<Self> {
        let config = crate::config::AppConfig::new()?;
        config.ensure_dirs()?;
        Self::open(&config.db_path())
    }

    /// Creates an in-memory database (useful for testing).
    pub fn in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let _ = conn.pragma_update(None, "synchronous", "OFF");
        let _ = conn.pragma_update(None, "temp_store", "MEMORY");
        let _ = conn.pragma_update(None, "cache_size", -8000i32);
        let db = Self {
            conn: Arc::new(Mutex::new(conn)),
            feature_catalog: Arc::default(),
        };
        db.run_migrations()?;
        Ok(db)
    }
}
