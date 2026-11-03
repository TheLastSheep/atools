use std::{collections::BTreeMap, sync::Arc};

use atools_core::Database;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, Webview, Window};

use super::{
    coordinator::GeneralSettingsCoordinator,
    transaction::{save_patch, set_capture_paused_patch},
};

const MAX_REQUEST_BYTES: usize = 64 * 1024;
const PASTEBOARD_DIALOG_FIELDS: [&str; 5] = [
    "pasteboardDockEdge",
    "pasteboardCompact",
    "clipboardRetentionDays",
    "pasteboardAttachmentBudgetBytes",
    "pasteboardExcludeSensitiveContent",
];

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct GeneralSettingsExpected {
    #[serde(deserialize_with = "required_option_string")]
    pub(crate) raw: Option<String>,
}

fn required_option_string<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    Option::<String>::deserialize(deserializer)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GeneralSettingsSaveReceipt {
    version: u8,
    raw: String,
    notification_delivered: bool,
    effects_applied: bool,
    ai_invalidated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GeneralSettingsPatchReceipt {
    pub(crate) version: u8,
    pub(crate) raw: String,
    pub(crate) notification_delivered: bool,
    #[serde(skip)]
    pub(crate) auto_check: Option<crate::updater::auto_check::Receipt>,
}

#[derive(Serialize)]
struct SaveRequestBudget<'a> {
    expected: &'a GeneralSettingsExpected,
    changes: &'a BTreeMap<String, Value>,
    apply_native: bool,
}

#[derive(Serialize)]
struct RendererRequestBudget<'a> {
    expected: &'a Option<String>,
    changes: &'a BTreeMap<String, Value>,
}

#[tauri::command]
pub(crate) async fn save_general_settings(
    app: AppHandle,
    webview: Webview,
    window: Window,
    state: tauri::State<'_, crate::state::AppState>,
    expected: GeneralSettingsExpected,
    changes: BTreeMap<String, Value>,
    apply_native: Option<bool>,
) -> Result<GeneralSettingsSaveReceipt, String> {
    let apply_native = apply_native.unwrap_or(false);
    if !native_launch_at_login_form_patch_allowed(&changes, apply_native) {
        return Err("launchAtLogin must use the dedicated system setting command".into());
    }
    authorize_save_caller(&webview, &window, &changes, apply_native)?;
    validate_save_budget(&expected, &changes, apply_native)?;
    let coordinator = get_coordinator(&app)?;
    let db = Arc::clone(&state.db);

    let receipt = coordinator
        .run(move || async move {
            let menu_app = app.clone();
            let menu_db = Arc::clone(&db);
            let menu_changes = changes.clone();
            super::close_shortcut_effect::wrap(
                &menu_app,
                &menu_db,
                &menu_changes,
                save_patch(app, db, expected.raw, changes, apply_native),
            )
            .await
            .map(|receipt| GeneralSettingsSaveReceipt {
                version: 1,
                raw: receipt.raw,
                notification_delivered: receipt.notification_delivered,
                effects_applied: receipt.effects_applied,
                ai_invalidated: receipt.ai_invalidated,
            })
        })
        .await?;
    Ok(receipt)
}

/// Reads the latest General snapshot after all earlier admitted writes have completed.
pub(crate) async fn read_general_settings(
    app: AppHandle,
    db: Arc<Database>,
) -> Result<Option<String>, String> {
    let coordinator = get_coordinator(&app)?;
    coordinator
        .run(move || async move {
            tauri::async_runtime::spawn_blocking(move || {
                db.read_renderer_general_settings()
                    .map_err(|error| error.to_string())
            })
            .await
            .map_err(|_| "General settings read worker failed".to_owned())?
        })
        .await
}

/// Runs a validated renderer preference patch under the same cancellation-safe gate.
pub(crate) async fn run_renderer_patch(
    app: AppHandle,
    db: Arc<Database>,
    expected: Option<String>,
    changes: BTreeMap<String, Value>,
) -> Result<GeneralSettingsPatchReceipt, String> {
    validate_renderer_budget(&expected, &changes)?;
    if changes.contains_key("autoCheckUpdate") {
        return super::auto_check_effect::run(app, db, expected, changes).await;
    }
    super::renderer_native_effect_transaction::run_renderer_patch(app, db, expected, changes).await
}

/// Patches the latest capture setting snapshot while holding the shared write gate.
#[tauri::command]
pub(crate) async fn pasteboard_set_capture_paused(
    app: AppHandle,
    webview: Webview,
    window: Window,
    state: tauri::State<'_, crate::state::AppState>,
    paused: bool,
) -> Result<crate::pasteboard_runtime::PasteboardCaptureStatus, String> {
    if !capture_caller_allowed(webview.label(), webview.window().label(), window.label()) {
        return Err("Clipboard capture preferences are unavailable to this WebView".into());
    }
    set_capture_paused(app, Arc::clone(&state.db), paused).await?;
    Ok(state.pasteboard_runtime.status())
}

fn capture_caller_allowed(webview: &str, parent: &str, window: &str) -> bool {
    labels_match(webview, parent, window, "main")
        || labels_match(
            webview,
            parent,
            window,
            crate::pasteboard_window::PASTEBOARD_SHELF_LABEL,
        )
}

pub(crate) fn authorize_general_settings_read(
    webview: &Webview,
    window: &Window,
) -> Result<(), String> {
    let webview_label = webview.label();
    let parent_label = webview.window().label().to_owned();
    let window_label = window.label();
    let allowed = [
        "main",
        "settings",
        "pasteboard-dialog",
        crate::pasteboard_window::PASTEBOARD_SHELF_LABEL,
    ];
    if allowed
        .iter()
        .any(|expected| labels_match(webview_label, &parent_label, window_label, expected))
    {
        Ok(())
    } else {
        Err("General settings are not available to this WebView".into())
    }
}

/// Patches only the capture flag; callers must validate their entry-point identity.
pub(crate) async fn set_capture_paused(
    app: AppHandle,
    db: Arc<Database>,
    paused: bool,
) -> Result<(), String> {
    let coordinator = get_coordinator(&app)?;
    let changes = BTreeMap::from([("pasteboardCapturePaused".to_owned(), Value::Bool(paused))]);
    coordinator
        .run(move || async move { set_capture_paused_patch(app, db, changes).await })
        .await
}

pub(super) fn get_coordinator(app: &AppHandle) -> Result<GeneralSettingsCoordinator, String> {
    app.try_state::<GeneralSettingsCoordinator>()
        .map(|state| state.inner().clone())
        .ok_or_else(|| {
            "General settings coordinator is unavailable in this app instance".to_owned()
        })
}

fn authorize_save_caller(
    webview: &Webview,
    window: &Window,
    changes: &BTreeMap<String, Value>,
    apply_native: bool,
) -> Result<(), String> {
    let webview_label = webview.label();
    let parent_label = webview.window().label().to_owned();
    let window_label = window.label();
    if labels_match(webview_label, &parent_label, window_label, "main")
        || labels_match(webview_label, &parent_label, window_label, "settings")
    {
        return Ok(());
    }

    if labels_match(
        webview_label,
        &parent_label,
        window_label,
        "pasteboard-dialog",
    ) {
        if apply_native {
            return Err("pasteboard-dialog may not apply native General settings".into());
        }
        if changes
            .keys()
            .any(|key| !pasteboard_dialog_field_allowed(key))
        {
            return Err("pasteboard-dialog may update only clipboard preference fields".into());
        }
        return Ok(());
    }

    Err("General settings writes are not available to this WebView".into())
}

fn labels_match(webview: &str, parent: &str, window: &str, expected: &str) -> bool {
    webview == expected && parent == expected && window == expected
}

fn pasteboard_dialog_field_allowed(key: &str) -> bool {
    PASTEBOARD_DIALOG_FIELDS.contains(&key)
}

fn native_launch_at_login_form_patch_allowed(
    changes: &BTreeMap<String, Value>,
    apply_native: bool,
) -> bool {
    !apply_native || !changes.contains_key("launchAtLogin")
}

fn validate_save_budget(
    expected: &GeneralSettingsExpected,
    changes: &BTreeMap<String, Value>,
    apply_native: bool,
) -> Result<(), String> {
    let request = SaveRequestBudget {
        expected,
        changes,
        apply_native,
    };
    let bytes = serde_json::to_vec(&request)
        .map_err(|_| "General settings request could not be serialized".to_owned())?;
    if bytes.len() > MAX_REQUEST_BYTES {
        return Err("General settings request exceeds the 64 KiB serialized limit".into());
    }
    Ok(())
}

fn validate_renderer_budget(
    expected: &Option<String>,
    changes: &BTreeMap<String, Value>,
) -> Result<(), String> {
    let request = RendererRequestBudget { expected, changes };
    let bytes = serde_json::to_vec(&request)
        .map_err(|_| "Renderer General settings request could not be serialized".to_owned())?;
    if bytes.len() > MAX_REQUEST_BYTES {
        return Err("Renderer General settings request exceeds the 64 KiB serialized limit".into());
    }
    Ok(())
}

#[cfg(test)]
#[path = "commands_tests.rs"]
mod tests;
