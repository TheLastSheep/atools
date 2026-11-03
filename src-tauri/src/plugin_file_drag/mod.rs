//! Native file export for opt-in ZTools APIs, audited through TaskRun.
mod authorization;
pub(crate) mod commands;
#[cfg(all(feature = "legacy-node-smoke", target_os = "macos"))]
pub(crate) mod desktop_smoke;
mod lifecycle;
pub(crate) mod native;
mod privacy;
pub(crate) mod registry;
mod request;
mod sessions;
#[cfg(test)]
mod tests;
mod transport;
mod types;

use atools_core::{
    agent::{PermissionDecision, ToolDefinition},
    Database,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, Manager};
use types::{Binding, Session};

pub(crate) const SOURCE: &str = "plugin_file_drag";
pub(crate) use privacy::{bind_run, validate_private_request};
pub(crate) use sessions::Sessions;
type ExecutionGuard = Arc<tokio::sync::OwnedRwLockReadGuard<()>>;

pub(crate) fn install_manager(app: &AppHandle) {
    app.manage(Arc::new(Sessions::default()));
}

pub(crate) fn manager(app: &AppHandle) -> Result<Arc<Sessions>, String> {
    app.try_state::<Arc<Sessions>>()
        .map(|state| state.inner().clone())
        .ok_or_else(|| "Native file-drag runtime is unavailable".into())
}

fn validate_session(db: &Database, session: &Session) -> Result<(), String> {
    if !session.valid() {
        return Err("File-drag session closed or expired".into());
    }
    session.binding.validate(db, &session.owner.plugin)?;
    let tool = db
        .get_agent_tool(&session.tool)
        .map_err(|_| "File-drag capability unavailable")?
        .ok_or("File-drag capability unavailable")?;
    if registry::validate(&tool)? != session.owner.plugin || !tool.enabled {
        return Err("File-drag capability was revoked".into());
    }
    match crate::agent_tools::permission_decision_for_tool(db, "atools-ui", &session.tool)? {
        PermissionDecision::Allow => Ok(()),
        PermissionDecision::Confirm
            if session
                .once_authorization
                .as_ref()
                .is_some_and(|proof| proof.permits(db, session)) =>
        {
            Ok(())
        }
        PermissionDecision::Confirm => Err("File-drag approval expired or was revoked".into()),
        PermissionDecision::Deny => Err("File-drag permission denied".into()),
    }
}

async fn prepare_native_for_open(
    app: &AppHandle,
    runtime: &Arc<Sessions>,
    intent_id: &str,
) -> Result<(), String> {
    let _control = runtime.control.lock().await;
    let intent = runtime.get_intent(intent_id)?;
    if intent.cancelled.load(std::sync::atomic::Ordering::Acquire)
        || intent
            .document
            .as_ref()
            .is_some_and(|document| !document.is_active())
        || intent.created.elapsed() >= types::SESSION_TTL
    {
        return Err("File-drag preparation was cancelled or expired".into());
    }
    native::prepare(app).await?;
    let current = runtime.get_intent(intent_id)?;
    if current.cancelled.load(std::sync::atomic::Ordering::Acquire)
        || current
            .document
            .as_ref()
            .is_some_and(|document| !document.is_active())
    {
        return Err("File-drag preparation was cancelled".into());
    }
    Ok(())
}

pub(crate) async fn execute(
    app: &AppHandle,
    db: &Database,
    tool: &ToolDefinition,
    args: Value,
    client: &str,
    run_id: &str,
    execution: Option<ExecutionGuard>,
) -> Result<Value, String> {
    validate_private_request(app, db, client, &tool.name, &args)?;
    let plugin_id = registry::validate(tool)?;
    let plugin = db.get_plugin(plugin_id).map_err(|_| "Plugin unavailable")?;
    let binding = Binding::current(db, &plugin)?;
    let runtime = manager(app)?;
    match args["operation"].as_str() {
        Some("open") => {
            let execution_guard =
                execution.ok_or("File-drag opening requires the plugin execution gate")?;
            let intent_id = args["intentId"]
                .as_str()
                .ok_or("Missing file-drag intent")?;
            let intent = runtime.get_intent(intent_id)?;
            if intent.owner.plugin != plugin_id || intent.binding != binding {
                return Err("File-drag opening identity changed".into());
            }
            let run = db
                .get_task_run(run_id)
                .map_err(|_| "File-drag TaskRun unavailable")?
                .ok_or("File-drag TaskRun unavailable")?;
            if run.status != atools_core::task_run::TaskRunStatus::Running
                || run.capability_id != tool.name
                || run.input != args
            {
                return Err("File-drag opening TaskRun identity mismatch".into());
            }
            let decision =
                crate::agent_tools::permission_decision_for_tool(db, "atools-ui", &tool.name)?;
            let once = match decision {
                PermissionDecision::Allow => None,
                PermissionDecision::Confirm => {
                    Some(authorization::OnceAuthorization::for_confirmed_open(
                        db, intent_id, &intent, &plugin, &tool.name, run_id,
                    )?)
                }
                PermissionDecision::Deny => return Err("File-drag permission denied".into()),
            };
            let mut opening = lifecycle::OpeningIntent {
                runtime: runtime.clone(),
                app: app.clone(),
                intent_id: intent_id.to_owned(),
                committed: false,
            };
            if app.get_webview_window(&intent.owner.window).is_none() {
                return Err("Plugin window closed".into());
            }
            prepare_native_for_open(app, &runtime, intent_id).await?;
            let current = runtime.get_intent(intent_id)?;
            current.binding.validate(db, plugin_id)?;
            validate_open_run(db, &tool.name, &args, run_id)?;
            match crate::agent_tools::permission_decision_for_tool(db, "atools-ui", &tool.name)? {
                PermissionDecision::Allow => {}
                PermissionDecision::Confirm
                    if once.as_ref().is_some_and(|proof| proof.remaining_ms() > 0) => {}
                PermissionDecision::Confirm => return Err("File-drag approval expired".into()),
                PermissionDecision::Deny => return Err("File-drag permission denied".into()),
            }
            let session = runtime.open(intent_id, &binding, &tool.name, once)?;
            opening.committed = true;
            runtime.register_session_timer(
                app,
                &session.id,
                session
                    .expires_at
                    .saturating_duration_since(std::time::Instant::now()),
            );
            if let Err(error) = transport::ensure_server(app, &runtime).await {
                lifecycle::close(
                    app,
                    db,
                    &runtime,
                    Some(&session.owner),
                    None,
                    None,
                    None,
                    false,
                )
                .await;
                return Err(error);
            }
            if !session.valid() {
                lifecycle::close(
                    app,
                    db,
                    &runtime,
                    Some(&session.owner),
                    None,
                    None,
                    None,
                    false,
                )
                .await;
                return Err("File-drag session expired while opening".into());
            }
            session.binding.validate(db, plugin_id)?;
            if crate::agent_tools::permission_decision_for_tool(db, "atools-ui", &tool.name)?
                == PermissionDecision::Deny
            {
                lifecycle::close(
                    app,
                    db,
                    &runtime,
                    Some(&session.owner),
                    None,
                    None,
                    None,
                    false,
                )
                .await;
                return Err("File-drag permission denied".into());
            }
            drop(execution_guard);
            Ok(json!({"sessionId":session.id,"pluginId":plugin_id,"runtime":"plugin-file-drag"}))
        }
        Some("request") => {
            let ticket = args["invocationId"]
                .as_str()
                .ok_or("Missing file-drag invocation")?
                .to_owned();
            execute_request(
                app, db, &runtime, tool, args, client, run_id, &ticket, execution,
            )
            .await
        }
        _ => Err("Unsupported file-drag operation".into()),
    }
}

fn validate_open_run(db: &Database, tool: &str, args: &Value, run_id: &str) -> Result<(), String> {
    let run = db
        .get_task_run(run_id)
        .map_err(|_| "File-drag TaskRun unavailable")?
        .ok_or("File-drag TaskRun unavailable")?;
    if run.status != atools_core::task_run::TaskRunStatus::Running
        || run.capability_id != tool
        || run.input != *args
    {
        return Err("File-drag opening TaskRun identity mismatch".into());
    }
    Ok(())
}

async fn execute_request(
    app: &AppHandle,
    db: &Database,
    runtime: &Arc<Sessions>,
    tool: &ToolDefinition,
    args: Value,
    client: &str,
    run_id: &str,
    ticket: &str,
    execution: Option<ExecutionGuard>,
) -> Result<Value, String> {
    let execution = execution.ok_or("File-drag request requires the plugin execution gate")?;
    let invocation = runtime.invocation(ticket)?;
    if invocation
        .claimed
        .swap(true, std::sync::atomic::Ordering::AcqRel)
    {
        return Err("File-drag invocation already consumed".into());
    }
    let session = runtime.get(&invocation.session)?;
    registry::validate_invocation_identity(&invocation, &session, tool)?;
    if invocation.run.lock().as_deref() != Some(run_id) {
        return Err("File-drag invocation belongs to another TaskRun".into());
    }
    validate_session(db, &session)?;
    let run = db
        .get_task_run(run_id)
        .map_err(|_| "File-drag TaskRun unavailable")?
        .ok_or("File-drag TaskRun unavailable")?;
    if client != "atools-ui"
        || run.status != atools_core::task_run::TaskRunStatus::Running
        || run.capability_id != tool.name
        || run.input != args
    {
        return Err("File-drag request TaskRun identity mismatch".into());
    }
    let paths = invocation
        .paths
        .lock()
        .take()
        .ok_or("File-drag paths were already consumed")?;
    let file_count = paths.len();
    if invocation
        .cancelled
        .load(std::sync::atomic::Ordering::Acquire)
        || !session.valid()
        || !invocation.begin_start()
    {
        invocation.acknowledge(Err("File-drag request cancelled before native start".into()));
        lifecycle::cancel_run(
            app,
            db,
            run_id,
            "File-drag request cancelled before native start",
        );
        invocation.mark_finished();
        runtime.remove_invocation(ticket);
        return Err("File-drag request cancelled before native start".into());
    }

    let begin = native::begin(
        app,
        &session.owner.window,
        paths,
        invocation.cancelled.clone(),
    )
    .await;
    let started = match begin {
        Ok(started) => started,
        Err(error) => {
            invocation.acknowledge(Err(error.clone()));
            if invocation
                .cancelled
                .load(std::sync::atomic::Ordering::Acquire)
            {
                lifecycle::cancel_run(
                    app,
                    db,
                    run_id,
                    "File-drag request cancelled before native start",
                );
            }
            invocation.mark_finished();
            runtime.remove_invocation(ticket);
            return Err(error);
        }
    };
    // The native backend has committed the OS drag start. Releasing this guard
    // lets disable/update proceed while the user is still holding the mouse.
    drop(execution);
    invocation.mark_started();
    let acknowledged = invocation.acknowledge(Ok(json!({"started":true})));
    if !acknowledged && invocation.phase() != types::INVOCATION_STARTED {
        lifecycle::cancel_run(app, db, run_id, "File-drag acknowledgement timed out");
    }
    match started.completion.await {
        Ok(native::DragOutcome::Dropped) => {
            invocation.mark_finished();
            runtime.remove_invocation(ticket);
            Ok(json!({"started":true,"dropped":true,"fileCount":file_count}))
        }
        Ok(native::DragOutcome::Cancelled) => {
            lifecycle::cancel_run(
                app,
                db,
                run_id,
                "Native file drag was cancelled or not accepted",
            );
            invocation.mark_finished();
            runtime.remove_invocation(ticket);
            Err("Native file drag was cancelled or not accepted".into())
        }
        Err(_) => {
            lifecycle::cancel_run(
                app,
                db,
                run_id,
                "Native file drag ended without a completion result",
            );
            invocation.mark_finished();
            runtime.remove_invocation(ticket);
            Err("Native file drag ended without a completion result".into())
        }
    }
}

pub(crate) async fn close_window(app: &AppHandle, label: &str) {
    if let (Ok(runtime), Some(state)) = (manager(app), app.try_state::<crate::state::AppState>()) {
        lifecycle::close(
            app,
            &state.db,
            &runtime,
            None,
            None,
            Some(label),
            None,
            false,
        )
        .await;
    }
    let _ = native::close_window(app, label).await;
}

pub(crate) async fn close_document(app: &AppHandle, document_id: &str) {
    if let (Ok(runtime), Some(state)) = (manager(app), app.try_state::<crate::state::AppState>()) {
        lifecycle::close(
            app,
            &state.db,
            &runtime,
            None,
            None,
            None,
            Some(document_id),
            false,
        )
        .await;
    }
}

pub(crate) async fn invalidate(app: &AppHandle, plugin: Option<&str>) {
    if let (Ok(runtime), Some(state)) = (manager(app), app.try_state::<crate::state::AppState>()) {
        lifecycle::close(app, &state.db, &runtime, None, plugin, None, None, false).await;
    }
}

pub(crate) async fn stop(app: &AppHandle) {
    if let (Ok(runtime), Some(state)) = (manager(app), app.try_state::<crate::state::AppState>()) {
        lifecycle::close(app, &state.db, &runtime, None, None, None, None, true).await;
    }
}

pub(crate) fn stop_on_main_thread(app: &AppHandle) {
    if let (Ok(runtime), Some(state)) = (manager(app), app.try_state::<crate::state::AppState>()) {
        lifecycle::close_now(app, &state.db, &runtime);
    }
    // Native shutdown runs inline when called from AppKit's main thread; no
    // queued main-thread task is awaited here.
    let _ = tauri::async_runtime::block_on(native::shutdown(app));
}
