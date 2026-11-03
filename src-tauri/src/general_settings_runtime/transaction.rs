use std::{collections::BTreeMap, sync::Arc};

use atools_core::Database;
use serde_json::Value;
use tauri::AppHandle;

use super::{
    effects::{apply_all, rollback_all, NativeSettingChange},
    settings::native_effect_changes,
    system_effects::TauriNativeSettings,
};

pub(super) struct TransactionReceipt {
    pub(super) raw: String,
    pub(super) notification_delivered: bool,
    pub(super) effects_applied: bool,
    pub(super) ai_invalidated: bool,
}

struct AppliedEffects {
    changes: Vec<NativeSettingChange>,
    port: TauriNativeSettings,
}

pub(super) async fn save_patch(
    app: AppHandle,
    db: Arc<Database>,
    expected: Option<String>,
    changes: BTreeMap<String, Value>,
    apply_native: bool,
) -> Result<TransactionReceipt, String> {
    let prepare_db = Arc::clone(&db);
    let prepare_expected = expected.clone();
    let prepare_changes = changes.clone();
    let plan = spawn_blocking_result(move || {
        prepare_db
            .prepare_general_settings_write(prepare_expected.as_deref(), &prepare_changes)
            .map_err(|error| error.to_string())
    })
    .await?;

    let before_raw = plan.before().map(ToOwned::to_owned);
    let after_raw = plan.after().to_owned();
    let before_revision = before_raw
        .as_deref()
        .and_then(crate::plugin_ai_runtime::types::settings_revision);
    let after_revision = crate::plugin_ai_runtime::types::settings_revision(&after_raw);
    let ai_changed = before_revision != after_revision;

    let applied = if apply_native {
        let effects_app = app.clone();
        let effects_before = before_raw.clone();
        let effects_after = after_raw.clone();
        Some(
            spawn_blocking_result(move || {
                let mut port = TauriNativeSettings::new(effects_app);
                let effect_changes = native_effect_changes(
                    effects_before.as_deref(),
                    &effects_after,
                    port.active_hotkey(),
                )?;
                apply_all(&mut port, &effect_changes)?;
                Ok(AppliedEffects {
                    changes: effect_changes,
                    port,
                })
            })
            .await?,
        )
    } else {
        None
    };

    let commit_db = Arc::clone(&db);
    let commit_result = spawn_blocking_result(move || {
        commit_db
            .commit_general_settings_write(plan)
            .map_err(|error| error.to_string())
    })
    .await;

    let raw = match commit_result {
        Ok(raw) => raw,
        Err(commit_error) => {
            let Some(applied) = applied else {
                return Err(format!("General settings commit failed: {commit_error}"));
            };
            if applied.changes.is_empty() {
                return Err(format!("General settings commit failed: {commit_error}"));
            }

            let AppliedEffects { changes, mut port } = applied;
            let rollback_result =
                spawn_blocking_result(move || rollback_all(&mut port, &changes)).await;
            return Err(match rollback_result {
                Ok(()) => format!(
                    "General settings commit failed: {commit_error}; native effects were compensated"
                ),
                Err(rollback_error) => format!(
                    "General settings commit failed: {commit_error}; native compensation was incomplete or failed: {rollback_error}"
                ),
            });
        }
    };

    if ai_changed {
        crate::plugin_ai_runtime::invalidate(&app, None).await;
    }

    let notification_delivered = super::emit_projected_general_settings(&app, &raw);

    Ok(TransactionReceipt {
        raw,
        notification_delivered,
        effects_applied: applied.is_some_and(|effects| !effects.changes.is_empty()),
        ai_invalidated: ai_changed,
    })
}

async fn spawn_blocking_result<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|_| "General settings worker failed".to_owned())?
}

pub(super) async fn set_capture_paused_patch(
    app: AppHandle,
    db: Arc<Database>,
    changes: BTreeMap<String, Value>,
) -> Result<(), String> {
    let patch_db = Arc::clone(&db);
    let raw = spawn_blocking_result(move || {
        patch_db
            .patch_general_settings_current(&changes)
            .map_err(|error| error.to_string())
    })
    .await?;

    let _notification_delivered = super::emit_projected_general_settings(&app, &raw);
    Ok(())
}
