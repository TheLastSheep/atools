//! Host-owned per-plugin window preferences, isolated by stable plugin identity.

use atools_core::db::Database;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::State;

use crate::state::AppState;

const KEY_PREFIX: &str = "plugin_window_preferences.";

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginWindowPreferences {
    pub auto_detach: bool,
}

fn validate_plugin_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 512 || id != id.trim() || id.chars().any(char::is_control) {
        return Err("Invalid plugin identity".into());
    }
    Ok(())
}

fn setting_key(id: &str) -> String {
    format!("{KEY_PREFIX}{:x}", Sha256::digest(id.as_bytes()))
}

fn validate_installed_plugin(db: &Database, id: &str) -> Result<(), String> {
    validate_plugin_id(id)?;
    db.get_plugin(id)
        .map(|_| ())
        .map_err(|_| format!("Plugin is not installed: {id}"))
}

fn read_auto_detach(db: &Database, id: &str) -> Result<bool, String> {
    match db
        .get_setting(&setting_key(id))
        .map_err(|error| error.to_string())?
        .as_deref()
    {
        None | Some("false") => Ok(false),
        Some("true") => Ok(true),
        Some(_) => Err("Plugin window preference is invalid; reset it and try again".into()),
    }
}

pub(crate) fn get_preferences(
    db: &Database,
    plugin_id: &str,
) -> Result<PluginWindowPreferences, String> {
    validate_installed_plugin(db, plugin_id)?;
    Ok(PluginWindowPreferences {
        auto_detach: read_auto_detach(db, plugin_id)?,
    })
}

pub(crate) fn set_auto_detach(
    db: &Database,
    plugin_id: &str,
    enabled: bool,
) -> Result<PluginWindowPreferences, String> {
    validate_installed_plugin(db, plugin_id)?;
    db.set_setting(
        &setting_key(plugin_id),
        if enabled { "true" } else { "false" },
    )
    .map_err(|error| error.to_string())?;
    Ok(PluginWindowPreferences {
        auto_detach: enabled,
    })
}

pub(crate) fn activation_auto_detach(db: &Database, id: &str) -> bool {
    read_auto_detach(db, id).unwrap_or(false)
}

#[tauri::command]
pub(crate) fn get_plugin_window_preferences(
    state: State<'_, AppState>,
    plugin_id: String,
) -> Result<PluginWindowPreferences, String> {
    get_preferences(&state.db, &plugin_id)
}

#[tauri::command]
pub(crate) fn set_plugin_auto_detach(
    state: State<'_, AppState>,
    plugin_id: String,
    enabled: bool,
) -> Result<PluginWindowPreferences, String> {
    set_auto_detach(&state.db, &plugin_id, enabled)
}

#[cfg(test)]
#[path = "plugin_window_preferences_tests.rs"]
mod tests;
