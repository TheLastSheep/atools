//! Owned prepare / OS apply / guarded CAS / publication / compensation.
use super::*;
use crate::general_settings_runtime::GeneralSettingsCoordinator;
use atools_core::db::{AppGlobalShortcutBinding, AppGlobalShortcutSnapshot};
use serde_json::{json, Value};

pub(super) async fn mutate(
    app: &AppHandle,
    revision: String,
    mutation: MutationRequest,
    revoked: Arc<AtomicBool>,
) -> Result<Value, String> {
    let rt = runtime(app)?;
    if rt.stopping.load(Ordering::Acquire) {
        return Err("App binding runtime stopping".into());
    }
    let owned = app
        .state::<GeneralSettingsCoordinator>()
        .hotkey_operation_lease()
        .map_err(|_| "SETTINGS_APP_SHORTCUT_BUSY".to_owned())?;
    if recording::gate(app)?.busy() {
        return Err(recording_gate::BUSY.into());
    }
    let app = app.clone();
    let (tx, rx) = tokio::sync::oneshot::channel();
    tauri::async_runtime::spawn_blocking(move || {
        let _lease = owned;
        let result = work(&app, &rt, revision, mutation, &revoked);
        let _ = tx.send(result);
    });
    rx.await
        .map_err(|_| "SETTINGS_APP_SHORTCUT_COMMIT_UNKNOWN".to_owned())?
}
fn live_rows(
    app: &AppHandle,
    snapshot: &AppGlobalShortcutSnapshot,
) -> Result<Vec<AppGlobalShortcutBinding>, String> {
    let catalog = app
        .state::<crate::state::AppState>()
        .launcher_app_catalog
        .snapshot()?;
    Ok(snapshot
        .bindings
        .iter()
        .filter(|r| r.public_matches && catalog.iter().any(|a| a.path() == r.path))
        .cloned()
        .collect())
}
fn publish(rt: &Runtime, rows: &[AppGlobalShortcutBinding], epoch: u64) -> Result<(), String> {
    let previous = std::mem::take(&mut *rt.published.lock());
    for id in previous.keys() {
        rt.fence.revoke(id)?;
    }
    rt.queue.lock().epochs.clear();
    rt.queue.lock().events.clear();
    rt.queue.lock().pressed.clear();
    rt.queue.lock().pending.clear();
    let desired = registry::desired(rows, epoch)?;
    for entry in desired.values() {
        rt.fence.publish(
            entry.target_code.row_id.clone(),
            epoch,
            entry.target_code.path.clone(),
        )?;
    }
    *rt.published.lock() = desired
        .into_values()
        .map(|d| (d.target_code.row_id.clone(), d.target_code))
        .collect();
    Ok(())
}
fn quarantine(rt: &Runtime) {
    let previous = std::mem::take(&mut *rt.published.lock());
    for id in previous.keys() {
        let _ = rt.fence.revoke(id);
    }
}
fn statuses(
    rt: &Runtime,
    snapshot: &AppGlobalShortcutSnapshot,
    live: &[AppGlobalShortcutBinding],
    applied: Option<bool>,
) {
    let mut status = rt.status.lock();
    status.clear();
    for row in &snapshot.bindings {
        let state = if !row.enabled {
            "disabled"
        } else if !row.public_matches || applied != Some(true) {
            "unavailable"
        } else if live.iter().any(|r| r.row_id == row.row_id) {
            "registered"
        } else {
            "missing"
        };
        status.insert(row.row_id.clone(), (state.into(), None));
    }
}
fn receipt(
    rt: &Runtime,
    snapshot: Option<&AppGlobalShortcutSnapshot>,
    persisted: Option<bool>,
    changed: Option<bool>,
    applied: Option<bool>,
    error: Option<String>,
) -> Result<Value, String> {
    Ok(
        json!({"version":1,"persisted":persisted,"changed":changed,"runtimeApplied":applied,"notificationDelivered":false,"error":error.map(|message|json!({"code":if message.contains(atools_core::db::APP_GLOBAL_SHORTCUT_CONFLICT){"SETTINGS_REVISION_CONFLICT"}else{"SETTINGS_APP_SHORTCUT_WRITE_FAILED"},"message":message})),"snapshot":snapshot.map(|s|wire::projection(rt,s)).transpose()?}),
    )
}
fn work(
    app: &AppHandle,
    rt: &Arc<Runtime>,
    revision: String,
    mutation: MutationRequest,
    revoked: &AtomicBool,
) -> Result<Value, String> {
    if rt.stopping.load(Ordering::Acquire) {
        return Err("App binding runtime stopping".into());
    }
    let state = app.state::<crate::state::AppState>();
    let db = &state.db;
    let mutation = mutation.resolve(&state.launcher_app_catalog)?;
    let mut port = registry::Port { app, runtime: rt };
    execute(
        rt,
        db,
        revision,
        mutation,
        &mut port,
        &|snapshot| live_rows(app, snapshot),
        &|| !revoked.load(Ordering::Acquire),
        &|| {
            use tauri::{Emitter, EventTarget};
            app.emit_to(
                EventTarget::webview("main"),
                "atools://renderer-app-global-shortcuts",
                json!({"version":1}),
            )
            .is_ok()
        },
    )
}

pub(super) fn execute<
    P: crate::general_settings_runtime::app_shortcut_registry::ShortcutPort<BindingTarget>,
>(
    rt: &Arc<Runtime>,
    db: &atools_core::db::Database,
    revision: String,
    mutation: atools_core::db::AppGlobalShortcutMutation,
    port: &mut P,
    live: &dyn Fn(&AppGlobalShortcutSnapshot) -> Result<Vec<AppGlobalShortcutBinding>, String>,
    caller_live: &dyn Fn() -> bool,
    notify: &dyn Fn() -> bool,
) -> Result<Value, String> {
    if rt.stopping.load(Ordering::Acquire) || !caller_live() {
        return Err("App binding admission revoked".into());
    }
    let before = db
        .read_renderer_app_global_shortcuts()
        .map_err(|e| e.to_string())?;
    if rt
        .token
        .lock()
        .as_ref()
        .is_none_or(|(token, s)| token != &revision || s != &before)
    {
        return Err("SETTINGS_REVISION_CONFLICT".into());
    }
    let plan = db
        .prepare_renderer_app_global_shortcut_write(&before, mutation)
        .map_err(|e| e.to_string())?;
    let after = plan.after().clone();
    let changed = plan.changed();
    let rows = live(&after)?;
    let epoch = rt.epoch.fetch_add(1, Ordering::AcqRel) + 1;
    let desired = registry::desired(&rows, epoch)?;
    // The shared lease provides exclusivity. Never hold a registry mutex while SDK
    // calls dispatch to the main thread, or SQLite is locked.
    let mut registry = std::mem::take(&mut *rt.registry.lock());
    let apply = registry.replace_all(port, desired);
    let mut error = None;
    let mut persisted = Some(false);
    let mut result_snapshot = Some(before.clone());
    if let Err(e) = apply {
        error = Some(e)
    } else {
        match db.commit_renderer_app_global_shortcut_write_guarded(plan, || {
            !rt.stopping.load(Ordering::Acquire) && caller_live()
        }) {
            Ok(write) => {
                persisted = Some(true);
                result_snapshot = Some(write.snapshot)
            }
            Err(e) => {
                error = Some(e.to_string());
                let definitely_uncommitted = matches!(&e,atools_core::AToolsError::Config(message) if message==atools_core::db::APP_GLOBAL_SHORTCUT_CONFLICT || message==atools_core::db::APP_GLOBAL_SHORTCUT_GUARD_REJECTED);
                match db.read_renderer_app_global_shortcuts() {
                    Ok(current) => {
                        persisted = if current == after {
                            Some(true)
                        } else if current == before || definitely_uncommitted {
                            Some(false)
                        } else {
                            None
                        };
                        result_snapshot = Some(current)
                    }
                    Err(_) => {
                        persisted = None;
                        result_snapshot = None
                    }
                }
            }
        }
    }
    let runtime_applied;
    if persisted == Some(true) {
        runtime_applied = if publish(rt, &rows, epoch).is_ok() {
            Some(true)
        } else {
            quarantine(rt);
            None
        };
    } else {
        quarantine(rt);
        let recovery_epoch = rt.epoch.fetch_add(1, Ordering::AcqRel) + 1;
        let restored = live(&before).and_then(|old| {
            let desired = registry::desired(&old, recovery_epoch)?;
            registry.replace_all(port, desired)?;
            publish(rt, &old, recovery_epoch)?;
            Ok(old)
        });
        runtime_applied = match restored {
            Ok(_) if persisted == Some(false) && result_snapshot.as_ref() == Some(&before) => {
                Some(true)
            }
            Ok(_) => {
                quarantine(rt);
                None
            }
            Err(e) => {
                quarantine(rt);
                error = Some(format!(
                    "{}; compensation incomplete: {e}",
                    error.unwrap_or_default()
                ));
                None
            }
        };
    }
    *rt.registry.lock() = registry;
    if let Some(snapshot) = result_snapshot.as_ref() {
        let rows = live(snapshot).unwrap_or_default();
        statuses(rt, snapshot, &rows, runtime_applied);
    }
    let mut reply = receipt(
        rt,
        result_snapshot.as_ref(),
        persisted,
        persisted.map(|saved| saved && changed),
        runtime_applied,
        error,
    )?;
    // The reply contains the authoritative projection. A failed optional event
    // does not undo a durable commit or turn it into a retryable create.
    if persisted == Some(true) {
        let delivered = notify();
        reply["notificationDelivered"] = json!(delivered);
    }
    Ok(reply)
}
