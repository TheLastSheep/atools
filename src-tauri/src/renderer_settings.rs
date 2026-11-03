//! Fixed, bounded startup settings snapshot for the main renderer.

use crate::state::AppState;
use atools_core::db::Database;
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::sync::Arc;

const MAX_VALUE_BYTES: usize = 128 * 1024;
const MAX_GENERAL_BYTES: usize = 64 * 1024;
const MAX_ALIAS_PROJECTION_BYTES: usize = 512 * 1024;
const MAX_RESPONSE_BYTES: usize = 1024 * 1024;
const COMMAND_ALIASES_KEY: &str = "ztools-renderer:command-aliases";

#[path = "renderer_settings_builtin_shortcuts.rs"]
mod builtin_shortcuts;
pub(crate) use builtin_shortcuts::project_builtin_shortcuts;

const SAFE_SETTINGS_KEYS: [&str; 33] = [
    "autoCheckUpdate",
    "hotkey",
    "appShortcuts",
    "launchAtLogin",
    "showTrayIcon",
    "wakeupBlacklist",
    "theme",
    "primaryColor",
    "customColor",
    "opacity",
    "windowMaterial",
    "placeholder",
    "searchMode",
    "showRecentInSearch",
    "showMatchRecommendation",
    "localAppSearch",
    "localLaunchSearch",
    "spaceOpenCommand",
    "recentRows",
    "pinnedRows",
    "tabKeyFunction",
    "tabTarget",
    "tabTargetCommand",
    "autoPaste",
    "autoClear",
    "autoBackToSearch",
    "pluginEscapeToSearch",
    "windowDefaultHeight",
    "windowPositionStrategy",
    "clipboardRetentionDays",
    "superPanelEnabled",
    "floatingBallEnabled",
    "devToolsMode",
];

const NATIVE_SETTING_KEYS: [&str; 14] = [
    "settings-general",
    "ztools-renderer:command-aliases",
    "ztools-renderer:disable-commands",
    "ztools-renderer:enabled-main-push-plugin",
    "ztools-renderer:search-preference",
    "ztools-renderer:recommendation-pinned",
    "ztools-renderer:command-history",
    "ztools-renderer:pinned-commands",
    "ztools-renderer:out-kill-plugin",
    "ztools-renderer:auto-detach-plugin",
    "ztools-renderer:auto-start-plugin",
    "ztools-renderer:super-panel-pinned",
    "ztools-renderer:local-shortcuts",
    "ztools-renderer:command-usage-stats",
];

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub(crate) struct RendererSettingsSnapshot {
    version: u8,
    settings: BTreeMap<String, Option<String>>,
}

#[tauri::command]
pub(crate) async fn get_ztools_renderer_settings(
    webview: tauri::Webview,
    state: tauri::State<'_, AppState>,
) -> Result<RendererSettingsSnapshot, String> {
    ensure_main_webview(webview.label())?;
    let db = Arc::clone(&state.db);

    tauri::async_runtime::spawn_blocking(move || {
        let values = read_settings_snapshot(&db)?;
        build_snapshot(values).map_err(str::to_owned)
    })
    .await
    .map_err(|_| "Renderer settings worker failed".to_owned())?
}

fn ensure_main_webview(label: &str) -> Result<(), String> {
    if label == "main" {
        Ok(())
    } else {
        Err("Renderer settings are available only to the main window".into())
    }
}

fn read_settings_snapshot(db: &Database) -> Result<BTreeMap<String, Option<String>>, String> {
    db.read_settings_bounded(&NATIVE_SETTING_KEYS, MAX_VALUE_BYTES, MAX_RESPONSE_BYTES)
        .map_err(|_| "Renderer settings snapshot could not be read".to_owned())
}

fn build_snapshot(
    mut settings: BTreeMap<String, Option<String>>,
) -> Result<RendererSettingsSnapshot, &'static str> {
    if settings.len() != NATIVE_SETTING_KEYS.len()
        || settings
            .keys()
            .any(|key| !NATIVE_SETTING_KEYS.contains(&key.as_str()))
    {
        return Err("Renderer settings snapshot has an invalid key set");
    }

    for key in NATIVE_SETTING_KEYS {
        if !settings.contains_key(key) {
            return Err("Renderer settings snapshot has an invalid key set");
        }
    }

    for (key, value) in &settings {
        let value_limit = if key == "settings-general" {
            MAX_GENERAL_BYTES
        } else {
            MAX_VALUE_BYTES
        };
        if value
            .as_ref()
            .is_some_and(|value| value.len() > value_limit)
        {
            return Err("Renderer setting exceeds the configured byte limit");
        }
    }

    if let Some(Some(raw_aliases)) = settings.get(COMMAND_ALIASES_KEY) {
        let aliases = atools_core::db::normalize_renderer_command_aliases(Some(raw_aliases))
            .map_err(|_| "Renderer command aliases are invalid")?;
        let encoded = serde_json::to_string(&aliases)
            .map_err(|_| "Renderer command alias projection could not be encoded")?;
        if encoded.len() > MAX_ALIAS_PROJECTION_BYTES {
            return Err("Renderer command alias projection exceeds the 512 KiB limit");
        }
        settings.insert(COMMAND_ALIASES_KEY.to_owned(), Some(encoded));
    }

    if let Some(Some(raw_general)) = settings.get("settings-general") {
        let projected = project_general_settings(raw_general)?;
        settings.insert("settings-general".to_owned(), Some(projected));
    }

    let response_bytes = settings.iter().try_fold(0usize, |total, (key, value)| {
        let total = total.checked_add(key.len()).ok_or(())?;
        value
            .as_ref()
            .map_or(Ok(total), |value| total.checked_add(value.len()).ok_or(()))
    });
    if response_bytes.map_err(|_| "Renderer settings response exceeds its byte budget")?
        > MAX_RESPONSE_BYTES
    {
        return Err("Renderer settings response exceeds its byte budget");
    }

    let snapshot = RendererSettingsSnapshot {
        version: 1,
        settings,
    };
    let serialized = serde_json::to_vec(&snapshot)
        .map_err(|_| "Renderer settings response could not be encoded")?;
    if serialized.len() > MAX_RESPONSE_BYTES {
        return Err("Renderer settings response exceeds its byte budget");
    }
    Ok(snapshot)
}

/// Shared Main-only startup/event projection; never forward unknown settings fields.
pub(crate) fn project_general_settings(raw: &str) -> Result<String, &'static str> {
    if raw.len() > MAX_GENERAL_BYTES {
        return Err("Renderer setting exceeds the configured byte limit");
    }
    let parsed: Value =
        serde_json::from_str(raw).map_err(|_| "General renderer settings are invalid")?;
    let source = parsed
        .as_object()
        .ok_or("General renderer settings must be a JSON object")?;
    let mut safe = source
        .iter()
        .filter(|(key, _)| SAFE_SETTINGS_KEYS.contains(&key.as_str()))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect::<Map<String, Value>>();
    safe.insert(
        "builtinAppShortcutsEnabled".into(),
        project_builtin_shortcuts(source.get("builtinAppShortcutsEnabled")),
    );
    let result = Value::Object(safe).to_string();
    if result.len() > MAX_GENERAL_BYTES {
        return Err("Renderer General settings projection exceeds the configured byte limit");
    }
    Ok(result)
}

#[cfg(test)]
#[path = "renderer_settings_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "renderer_settings_builtin_shortcuts_tests.rs"]
mod builtin_shortcuts_tests;
