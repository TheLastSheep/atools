//! Trusted-parent initialization. Real paths never pass through the TaskRun result.
use super::{
    registry::{self, Access},
    source_hint::Hints,
    store::{Binding, Owner},
};
use atools_core::agent::PermissionDecision;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, WebviewWindow};

#[tauri::command]
pub(crate) async fn prepare_plugin_paths(
    app: AppHandle,
    window: WebviewWindow,
    plugin_id: String,
    instance_id: String,
    access: Access,
    request_permission: bool,
) -> Result<Value, String> {
    let owner = Owner::new(window.label(), &plugin_id, &instance_id)?;
    let runtime = super::manager(&app)?;
    let preparation = runtime.begin(owner.clone())?;
    let state = app.state::<crate::state::AppState>();
    for run in runtime.expire() {
        super::cancel(&app, &state.db, &run);
    }
    if app.get_webview_window(window.label()).is_none() {
        return Err("Plugin window closed".into());
    }
    let execution = crate::plugin_lifecycle::execution(&app, &plugin_id).await;
    let plugin = state
        .db
        .get_plugin(&plugin_id)
        .map_err(|_| "Plugin unavailable")?;
    let binding = Binding::current(&state.db, &plugin)?;
    if let Some(snapshot_id) = runtime.existing(&owner, access) {
        let store = runtime.0.lock();
        super::validate_snapshot(
            &state.db,
            store
                .snapshots
                .get(&snapshot_id)
                .ok_or("Path snapshot closed")?,
        )?;
        return Ok(json!({"snapshotId":snapshot_id,"usage":"detected"}));
    }
    let scan_app = app.clone();
    let scan_plugin = plugin.clone();
    let revision = crate::plugin_code_revision::current(&state.db, &plugin_id)?;
    let hints = tauri::async_runtime::spawn_blocking(move || {
        scan_app
            .state::<Hints>()
            .scan(&scan_plugin, revision.as_deref())
    })
    .await
    .map_err(|_| "Path source hint interrupted")?;
    let detected = if access == Access::Standard {
        hints.standard
    } else {
        hints.plugin_data
    };
    if !request_permission && !detected {
        return Ok(
            json!({"unavailable":true,"usage":if hints.unknown {"unknown"} else {"not_detected"}}),
        );
    }
    let name = registry::tool_name(&plugin_id, access);
    if !request_permission
        && !state
            .db
            .is_agent_tool_granted("atools-ui", &name)
            .map_err(|_| "Unable to check path grant")?
    {
        return Ok(json!({"unavailable":true,"usage":"detected"}));
    }
    registry::ensure_tool(&state.db, &plugin, access)?;
    if !request_permission
        && crate::agent_tools::permission_decision_for_tool(&state.db, "atools-ui", &name)?
            != PermissionDecision::Allow
    {
        return Ok(json!({"unavailable":true,"usage":"detected"}));
    }
    let intent = runtime.intent(preparation, binding, access)?;
    drop(execution);
    let result = crate::agent_tools::call_tool_with_audit(
        &app,
        &state.db,
        "atools-ui",
        &name,
        json!({"operation":"prepare","intentId":intent}),
        false,
    )
    .await;
    let mut output = result.structured_content;
    if output["permission_required"] == true {
        if let Some(run) = output["runId"].as_str() {
            let store = runtime.0.lock();
            if let Some(i) = store.intents.get(&intent) {
                *i.run.lock() = Some(run.into());
            } else {
                drop(store);
                super::cancel(&app, &state.db, run);
            }
        }
    } else {
        runtime.0.lock().intents.remove(&intent);
    }
    output["usage"] = json!("detected");
    Ok(output)
}

#[tauri::command]
pub(crate) async fn get_plugin_path_snapshot(
    app: AppHandle,
    window: WebviewWindow,
    plugin_id: String,
    instance_id: String,
    snapshot_id: String,
) -> Result<Value, String> {
    let owner = Owner::new(window.label(), &plugin_id, &instance_id)?;
    let _execution = crate::plugin_lifecycle::execution(&app, &plugin_id).await;
    let state = app.state::<crate::state::AppState>();
    let runtime = super::manager(&app)?;
    let store = runtime.0.lock();
    let snapshot = store
        .snapshots
        .get(&snapshot_id)
        .ok_or("Path snapshot closed")?;
    if snapshot.owner != owner {
        return Err("Path snapshot belongs to another instance".into());
    }
    super::validate_snapshot(&state.db, snapshot)?;
    Ok(json!({"paths":snapshot.paths,"access":snapshot.access}))
}

#[tauri::command]
pub(crate) fn close_plugin_paths(
    app: AppHandle,
    window: WebviewWindow,
    plugin_id: String,
    instance_id: String,
) -> Result<(), String> {
    let owner = Owner::new(window.label(), &plugin_id, &instance_id)?;
    let state = app.state::<crate::state::AppState>();
    for run in super::manager(&app)?.close(Some(&owner), None, None, false) {
        super::cancel(&app, &state.db, &run);
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn rotate_plugin_paths(
    app: AppHandle,
    window: WebviewWindow,
    plugin_id: String,
    instance_id: String,
    next_instance_id: String,
) -> Result<(), String> {
    let old = Owner::new(window.label(), &plugin_id, &instance_id)?;
    let next = Owner::new(window.label(), &plugin_id, &next_instance_id)?;
    let _execution = crate::plugin_lifecycle::execution(&app, &plugin_id).await;
    let state = app.state::<crate::state::AppState>();
    let runtime = super::manager(&app)?;
    {
        let store = runtime.0.lock();
        for snapshot in store.snapshots.values().filter(|s| s.owner == old) {
            super::validate_snapshot(&state.db, snapshot)?;
        }
    }
    runtime.rotate(&old, next)
}
