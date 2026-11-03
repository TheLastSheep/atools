//! The auto-only route commits once, then captures its runtime effect inside the General gate.
use super::commands::GeneralSettingsPatchReceipt;
use atools_core::Database;
use serde_json::Value;
use std::{collections::BTreeMap, sync::Arc};
use tauri::AppHandle;
pub(super) async fn run(
    app: AppHandle,
    db: Arc<Database>,
    expected: Option<String>,
    changes: BTreeMap<String, Value>,
) -> Result<GeneralSettingsPatchReceipt, String> {
    atools_core::db::validate_renderer_general_settings_patch(&changes)
        .map_err(|e| e.to_string())?;
    if changes.len() != 1 {
        return Err("Automatic update preference must be written alone".into());
    }
    let enabled = changes
        .get("autoCheckUpdate")
        .and_then(Value::as_bool)
        .ok_or("Automatic update preference must be boolean")?;
    super::commands::get_coordinator(&app)?
        .run(move || async move {
            let effect_app = app.clone();
            execute(
                db,
                expected,
                changes,
                enabled,
                move |enabled| crate::updater::auto_check::apply(&effect_app, enabled),
                move |raw| super::emit_general_projection(&app, raw),
            )
            .await
        })
        .await
}

// General's other existing write paths use the same scheduler, never a second timer.
pub(super) fn committed(app: &AppHandle, raw: &str) {
    if let Ok(value) = serde_json::from_str::<Value>(raw) {
        if let Some(fields) = value.as_object() {
            let enabled = fields
                .get("autoCheckUpdate")
                .map_or(true, |v| v.as_bool() == Some(true));
            let _ = crate::updater::auto_check::apply(app, enabled);
        }
    }
}

async fn execute(
    db: Arc<Database>,
    expected: Option<String>,
    changes: BTreeMap<String, Value>,
    enabled: bool,
    apply: impl FnOnce(bool) -> crate::updater::auto_check::Receipt,
    notify: impl FnOnce(&str) -> bool,
) -> Result<GeneralSettingsPatchReceipt, String> {
    let raw = tauri::async_runtime::spawn_blocking(move || {
        db.mutate_renderer_general_settings(expected.as_deref(), &changes)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|_| "Renderer General settings worker failed".to_owned())??;
    let effect = apply(enabled);
    let notification_delivered = notify(&raw);
    Ok(GeneralSettingsPatchReceipt {
        version: 1,
        raw,
        notification_delivered,
        auto_check: Some(effect),
    })
}
#[cfg(test)]
#[path = "auto_check_effect_tests.rs"]
mod tests;
