//! Shared execution/mutation coordination. No idle polling or plugin-wide reloads.
use crate::plugin_execution_gates::PluginExecutionGates;
use crate::plugin_mutation_runs::{MutationRun, Outcome};
use atools_core::db::Database;
use serde::Serialize;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::OwnedRwLockReadGuard;

struct MutationWorkers(Arc<tokio::sync::Semaphore>);
fn workers(app: &AppHandle) -> Arc<tokio::sync::Semaphore> {
    if app.try_state::<MutationWorkers>().is_none() {
        app.manage(MutationWorkers(Arc::new(tokio::sync::Semaphore::new(4))));
    }
    app.state::<MutationWorkers>().0.clone()
}

fn gates(app: &AppHandle) -> Arc<PluginExecutionGates> {
    if app.try_state::<Arc<PluginExecutionGates>>().is_none() {
        // manage is atomic: another caller may win, in which case its registry is reused.
        app.manage(Arc::new(PluginExecutionGates::default()));
    }
    app.state::<Arc<PluginExecutionGates>>().inner().clone()
}

pub(crate) async fn execution(app: &AppHandle, id: &str) -> OwnedRwLockReadGuard<()> {
    gates(app).read(id).await
}

pub(crate) struct DetachedWindowReuseLease {
    _gate: tokio::sync::OwnedMutexGuard<()>,
    pub generation: u64,
}

/// Waits for any Destroyed cleanup to finish, then closes the previous detached
/// plugin runtime before the caller stages the next single-slot handoff.
pub(crate) async fn prepare_detached_window_reuse(
    app: &AppHandle,
) -> Result<DetachedWindowReuseLease, String> {
    let runtime = app.state::<crate::plugin_detach_runtime::PluginDetachRuntime>();
    loop {
        runtime.wait_for_destroyed_cleanup().await;
        let gate = runtime.cleanup_gate().lock_owned().await;
        if runtime.destroyed_cleanup_pending() {
            drop(gate);
            continue;
        }
        if runtime.is_occupied()
            && app
                .get_webview_window(crate::window::PLUGIN_DETACH_LABEL)
                .is_some()
        {
            return Err(
                "PLUGIN_DETACH_WINDOW_OCCUPIED: detached plugin window is already in use".into(),
            );
        }
        let generation = runtime.begin_reuse();
        close_detached_window_resources_under_gate(app).await;
        if runtime.destroyed_cleanup_pending() {
            drop(gate);
            continue;
        }
        return Ok(DetachedWindowReuseLease {
            _gate: gate,
            generation,
        });
    }
}

/// Close the resources owned by the detached webview while its cleanup gate is held.
pub(crate) async fn close_detached_window_resources_under_gate(app: &AppHandle) {
    close_window_resources_unlocked(app, crate::window::PLUGIN_DETACH_LABEL).await;
}

/// Native lifecycle cleanup shared by window destruction and detached-window
/// reuse. The detached slot cannot be restaged until a Destroyed cleanup ends.
pub(crate) async fn close_window_resources(app: &AppHandle, label: &str) {
    let detached = if label == crate::window::PLUGIN_DETACH_LABEL {
        app.try_state::<crate::plugin_detach_runtime::PluginDetachRuntime>()
    } else {
        None
    };
    let _gate = if let Some(runtime) = detached.as_ref() {
        Some(runtime.cleanup_gate().lock_owned().await)
    } else {
        None
    };
    if let Some(runtime) = detached.as_ref() {
        runtime.clear_for_reuse();
    }
    close_window_resources_unlocked(app, label).await;
    if let Some(runtime) = detached {
        runtime.complete_destroyed_cleanup();
    }
}

async fn close_window_resources_unlocked(app: &AppHandle, label: &str) {
    crate::plugin_main_push::close_window(app, label);
    crate::plugin_page_runtime::close_window(app, label);
    crate::plugin_asset_protocol::close_window(app, label);
    crate::plugin_system_paths::close_window(app, label);
    crate::plugin_file_drop::close_window(app, label).await;
    crate::plugin_file_drag::close_window(app, label).await;
    crate::plugin_ai_runtime::close_window(app, label).await;
    crate::plugin_display_runtime::close_window(app, label).await;
    crate::plugin_dialog_runtime::close_window(app, label).await;
    crate::plugin_data_runtime::close_window(app, label).await;
    crate::plugin_secret_storage_runtime::close_window(app, label).await;
    crate::plugin_background_runtime::close_window(app, label).await;
    crate::legacy_runtime::close_window(app, label).await;
    crate::host_runtime::close_window(app, label).await;
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ChangeReason {
    Reset,
    Installed,
    Updated,
    Removed,
    Disabled,
    Enabled,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CodeChange<'a> {
    plugin_id: &'a str,
    reason: ChangeReason,
}

pub(crate) fn notify(app: &AppHandle, id: &str, reason: ChangeReason) {
    if let Err(error) = app.emit(
        "plugin-code-changed",
        CodeChange {
            plugin_id: id,
            reason,
        },
    ) {
        tracing::warn!("Plugin lifecycle notification failed for {id}: {error}");
    }
    if !matches!(reason, ChangeReason::Reset) {
        crate::plugin_inventory::events::notify(app);
    }
}

/// Caller holds the exclusive plugin gate. Attempt every cleanup even if one fails.
async fn reset(app: &AppHandle, db: &Database, id: &str, code_change: bool) -> Result<(), String> {
    crate::plugin_page_runtime::invalidate_plugin(app, id);
    crate::plugin_dialog_runtime::invalidate(app, db, Some(id)).await;
    crate::plugin_asset_protocol::invalidate_plugin(app, id);
    crate::plugin_system_paths::invalidate(app, db, Some(id));
    crate::plugin_display_runtime::invalidate(app, db, Some(id)).await;
    crate::plugin_data_runtime::invalidate(app, db, Some(id)).await;
    crate::plugin_secret_storage_runtime::invalidate(app, db, Some(id)).await;
    crate::plugin_file_drop::invalidate(app, Some(id)).await;
    crate::plugin_file_drag::invalidate(app, Some(id)).await;
    crate::plugin_ai_runtime::invalidate(app, Some(id)).await;
    let background_cleanup = crate::plugin_background_runtime::invalidate(app, db, Some(id)).await;
    notify(app, id, ChangeReason::Reset);
    let mut errors = Vec::new();
    if let Err(error) = background_cleanup {
        errors.push(error);
    }
    if let Err(error) = crate::plugin_lifecycle_permissions::cancel_pending(app, db, id) {
        errors.push(error);
    }
    if code_change {
        if let Err(error) = crate::plugin_lifecycle_permissions::revoke_code_grants(db, id) {
            errors.push(error);
        }
    }
    if app
        .try_state::<Arc<crate::legacy_runtime::Sessions>>()
        .is_some()
    {
        // Includes host clipboard, intents, openings and pending private TaskRuns.
        crate::legacy_runtime::invalidate(app, db, Some(id)).await;
    } else {
        crate::host_runtime::invalidate(app, db, Some(id)).await;
    }
    if let Some(supervisor) = app.try_state::<Arc<atools_plugin::SidecarSupervisor>>() {
        if let Err(error) = supervisor.stop(id).await {
            errors.push(error.to_string());
        }
    }
    if let Some(runtime) = app.try_state::<Arc<atools_plugin::runtime::JsRuntime>>() {
        if let Err(error) = runtime.invalidate_plugin(id).await {
            errors.push(error.to_string());
        }
    }
    if let Some(state) = app.try_state::<crate::state::AppState>() {
        let mut active = state.active_plugin.lock();
        if active.as_deref() == Some(id) {
            *active = None;
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "无法完整关闭插件旧实例，请关闭插件后重试：{}",
            errors.join("；")
        ))
    }
}

/// Wait for in-flight calls before replacing bytes. New calls to this plugin wait;
/// other plugins, search, and catalog reads keep using their own paths.
pub(crate) async fn mutate<T: Send + 'static>(
    app: &AppHandle,
    db: Arc<Database>,
    id: &str,
    reason: ChangeReason,
    operation: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    mutate_when(app, db, id, Some(reason), |_| true, operation).await
}

pub(crate) async fn mutate_when<T: Send + 'static>(
    app: &AppHandle,
    db: Arc<Database>,
    id: &str,
    reason: Option<ChangeReason>,
    changed: impl FnOnce(&T) -> bool + Send + 'static,
    operation: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let inventory_readiness = app
        .try_state::<crate::state::AppState>()
        .map(|state| state.inner().plugin_inventory_readiness.clone());
    if let Some(readiness) = inventory_readiness {
        readiness.wait_ready().await?;
    }

    let operation_label = match reason {
        None => "import",
        Some(ChangeReason::Installed) => "install",
        Some(ChangeReason::Updated) => "update",
        Some(ChangeReason::Removed) => "uninstall",
        Some(ChangeReason::Disabled) => "disable",
        Some(ChangeReason::Enabled) => "enable",
        Some(ChangeReason::Reset) => return Err("Invalid mutation operation".into()),
    };
    let audit = MutationRun::start(db.clone(), id, operation_label)?;
    let run_id = audit.id().to_owned();
    let _ = app.emit("task-run-updated", &run_id);
    let worker = workers(app)
        .acquire_owned()
        .await
        .map_err(|error| error.to_string())?;
    // An active picker holds a read permit; close its real native panel before
    // waiting for the writer, otherwise a user-owned modal could stall mutation.
    crate::plugin_dialog_runtime::invalidate(app, &db, Some(id)).await;
    crate::plugin_main_push::invalidate(app, &db, Some(id));
    let exclusive = gates(app).write(id).await;
    let code_change = !matches!(reason, Some(ChangeReason::Disabled | ChangeReason::Enabled));
    let revision = if code_change {
        match crate::plugin_code_revision::CodeRevision::begin(&db, id) {
            Ok(revision) => Some(revision),
            Err(error) => {
                let _ = audit.finish(Outcome::Failure);
                let _ = app.emit("task-run-updated", &run_id);
                return Err(error);
            }
        }
    } else {
        None
    };
    if let Err(error) = reset(app, &db, id, code_change).await {
        if let Some(revision) = revision {
            let _ = revision.finish(&db);
        }
        let _ = audit.finish(Outcome::Failure);
        let _ = app.emit("task-run-updated", &run_id);
        return Err(error);
    }
    let app = app.clone();
    let id = id.to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        // The worker owns the guard: dropping an IPC future must not release it
        // while filesystem/SQLite work is still running on the blocking thread.
        let _exclusive = exclusive;
        let _worker = worker;
        let result = operation();
        // Market copy failures can have persisted enabled=false. Synchronize and
        // notify that real state even when the install result is an error.
        let sync = crate::agent_tools::sync_plugin_tools(&db)
            .and_then(|()| crate::plugin_background_runtime::registry::sync(&db))
            .and_then(|()| {
                // New manifest tool names may have historical grants without a
                // current tool row. Revoke those while still holding the write gate.
                if code_change {
                    crate::plugin_lifecycle_permissions::revoke_code_grants(&db, &id)
                } else {
                    Ok(())
                }
            })
            .and_then(|()| match revision {
                Some(revision) => revision.finish(&db),
                None => Ok(()),
            });
        let did_change = result.as_ref().is_ok_and(changed);
        if did_change {
            if let Some(reason) = reason {
                notify(&app, &id, reason);
            }
        } else if result.is_err() && db.get_plugin(&id).is_ok_and(|plugin| !plugin.enabled) {
            notify(&app, &id, ChangeReason::Disabled);
        }
        let outcome = if result.is_ok() && sync.is_ok() {
            Outcome::Success {
                changed: did_change,
            }
        } else {
            Outcome::Failure
        };
        let audited = audit.finish(outcome);
        let _ = app.emit("task-run-updated", &run_id);
        match (result, sync) {
            (Ok(value), Ok(())) => audited.map(|_| value),
            (Err(error), _) => Err(error),
            (Ok(_), Err(error)) => Err(format!("插件已保存，但能力与授权同步失败：{error}")),
        }
    })
    .await
    .map_err(|error| format!("插件变更执行中断：{error}"))?
}
