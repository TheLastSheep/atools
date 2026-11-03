//! Narrow native bridge for the original renderer's General settings page.

use std::{collections::BTreeMap, sync::Arc};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Webview, Window};

use crate::state::AppState;

const MAIN_LABEL: &str = "main";

#[derive(Debug, Serialize)]
pub(crate) struct RendererGeneralSettingsSnapshot {
    version: u8,
    raw: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RendererGeneralSettingsMutationReceipt {
    version: u8,
    raw: String,
    notification_delivered: bool,
}

#[tauri::command]
pub(crate) async fn get_renderer_general_settings(
    app: AppHandle,
    webview: Webview,
    window: Window,
    state: tauri::State<'_, AppState>,
) -> Result<RendererGeneralSettingsSnapshot, String> {
    ensure_main_context(&webview, &window)?;
    let raw = crate::general_settings_runtime::read_general_settings(app, Arc::clone(&state.db))
        .await
        .map_err(|error| {
            if error == "General settings read worker failed" {
                "Renderer General settings read worker failed".to_owned()
            } else {
                format!("Renderer General settings could not be read: {error}")
            }
        })?;

    Ok(RendererGeneralSettingsSnapshot { version: 1, raw })
}

#[tauri::command]
pub(crate) async fn mutate_renderer_general_settings(
    app: AppHandle,
    webview: Webview,
    window: Window,
    state: tauri::State<'_, AppState>,
    expected: Option<String>,
    changes: BTreeMap<String, Value>,
) -> Result<RendererGeneralSettingsMutationReceipt, String> {
    ensure_main_context(&webview, &window)?;
    validate_main_renderer_general_settings_patch(&changes)?;
    let db = Arc::clone(&state.db);
    let receipt = crate::general_settings_runtime::run_renderer_patch(app, db, expected, changes)
        .await
        .map_err(|error| format!("Renderer General settings were not committed: {error}"))?;
    Ok(RendererGeneralSettingsMutationReceipt {
        version: receipt.version,
        raw: receipt.raw,
        notification_delivered: receipt.notification_delivered,
    })
}

fn ensure_main_context(webview: &Webview, window: &Window) -> Result<(), String> {
    if is_main_context(webview.label(), webview.window().label(), window.label()) {
        Ok(())
    } else {
        Err("Renderer General settings are available only to the main window".into())
    }
}

fn validate_main_renderer_general_settings_patch(
    changes: &BTreeMap<String, Value>,
) -> Result<(), String> {
    let main_fields = &atools_core::db::RENDERER_GENERAL_SETTINGS_FIELDS[..5];
    if changes.is_empty()
        || changes
            .keys()
            .any(|field| !main_fields.contains(&field.as_str()))
    {
        return Err("Renderer General settings patch contains unsupported fields".into());
    }
    atools_core::db::validate_renderer_general_settings_patch(changes)
        .map_err(|error| error.to_string())
}

fn is_main_context(webview_label: &str, parent_label: &str, window_label: &str) -> bool {
    webview_label == MAIN_LABEL && parent_label == MAIN_LABEL && window_label == MAIN_LABEL
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use serde_json::json;

    use super::{is_main_context, validate_main_renderer_general_settings_patch};

    #[test]
    fn general_settings_are_scoped_to_the_main_webview_and_window() {
        assert!(is_main_context("main", "main", "main"));
        assert!(!is_main_context("secondary", "main", "main"));
        assert!(!is_main_context("main", "secondary", "main"));
        assert!(!is_main_context("main", "main", "secondary"));
    }

    #[test]
    fn main_mutation_accepts_the_original_five_typed_fields_only() {
        let main_patch = BTreeMap::from([
            ("placeholder".into(), json!("Search")),
            ("theme".into(), json!("dark")),
            ("primaryColor".into(), json!("green")),
            ("customColor".into(), json!("#a1B2c3")),
            ("autoClear".into(), json!("10m")),
        ]);
        assert!(validate_main_renderer_general_settings_patch(&main_patch).is_ok());

        for rejected in [
            BTreeMap::new(),
            BTreeMap::from([("showRecentInSearch".into(), json!(true))]),
            BTreeMap::from([("recentRows".into(), json!(2))]),
            BTreeMap::from([("opacity".into(), json!(1.0))]),
            BTreeMap::from([("autoPaste".into(), json!("3s"))]),
            BTreeMap::from([("theme".into(), json!("blue"))]),
        ] {
            assert!(validate_main_renderer_general_settings_patch(&rejected).is_err());
        }
    }
}
