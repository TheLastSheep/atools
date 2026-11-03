//! Private, cancellable native pickers. Ordinary history contains metadata only.
pub(crate) mod commands;
#[cfg(test)]
mod document_tests;
mod lifecycle;
mod native;
mod observations;
mod options;
mod privacy;
pub(crate) mod registry;
mod sessions;
pub(crate) mod settings_picker;
mod source_hint;
#[cfg(test)]
mod tests;
mod transport;
#[cfg(test)]
mod transport_tests;
mod types;
use atools_core::{
    agent::{PermissionDecision, ToolDefinition},
    Database,
};
pub(crate) use privacy::{bind_run, validate_private_request};
use serde_json::{json, Value};
use sessions::Sessions;
use std::sync::{atomic::Ordering, Arc};
use tauri::{AppHandle, Manager};
use types::{Binding, Session};
type ExecutionGuard = Arc<tokio::sync::OwnedRwLockReadGuard<()>>;

pub(crate) fn install_manager(app: &AppHandle) {
    app.manage(Arc::new(Sessions::default()));
    app.manage(source_hint::Hints::default());
    app.manage(Arc::new(native::State::default()));
}
fn manager(app: &AppHandle) -> Result<Arc<Sessions>, String> {
    app.try_state::<Arc<Sessions>>()
        .map(|s| s.inner().clone())
        .ok_or_else(|| "Plugin dialog runtime is unavailable".into())
}
fn validate_session(db: &Database, session: &Session) -> Result<(), String> {
    if session.document.as_ref().is_some_and(|d| !d.is_active()) {
        return Err("Plugin document closed".into());
    }
    session.binding.validate(db, &session.owner.plugin)?;
    let tool = db
        .get_agent_tool(&session.tool)
        .map_err(|_| "Dialog capability unavailable")?
        .ok_or("Dialog capability unavailable")?;
    if registry::access_for(&tool)? != session.access
        || !tool.enabled
        || !*session.active.lock()
        || crate::agent_tools::permission_decision_for_tool(db, "atools-ui", &session.tool)?
            == PermissionDecision::Deny
    {
        return Err("Plugin dialog permission was revoked".into());
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
    let access = registry::access_for(tool)?;
    let plugin_id = tool.plugin_id.as_deref().ok_or("Missing dialog identity")?;
    let plugin = db.get_plugin(plugin_id).map_err(|_| "Plugin unavailable")?;
    let binding = Binding::current(db, &plugin)?;
    let runtime = manager(app)?;
    match args["operation"].as_str() {
        Some("open") => {
            let session = runtime.open(
                args["intentId"].as_str().ok_or("Missing dialog intent")?,
                &binding,
            )?;
            let mut opening = lifecycle::OpeningLease {
                runtime: runtime.clone(),
                owner: session.owner.clone(),
                app: app.clone(),
                db: app.state::<crate::state::AppState>().db.clone(),
                committed: false,
            };
            if app.get_webview_window(&session.owner.window).is_none() {
                return Err("Plugin window closed".into());
            }
            transport::ensure_server(app, &runtime).await?;
            runtime.get(&session.id)?;
            opening.committed = true;
            Ok(json!({"sessionId":session.id,"access":access,"runtime":"plugin-dialog"}))
        }
        Some("request") => {
            let ticket = args["invocationId"]
                .as_str()
                .ok_or("Missing dialog ticket")?;
            let invocation = runtime
                .store
                .lock()
                .invocations
                .get(ticket)
                .cloned()
                .ok_or("Dialog invocation expired")?;
            if invocation.claimed.swap(true, Ordering::AcqRel) {
                return Err("Dialog invocation already consumed".into());
            }
            *invocation.run.lock() = Some(run_id.into());
            let session = runtime.get(&invocation.session)?;
            validate_session(db, &session)?;
            let _execution = execution.ok_or("Dialog operation requires plugin execution gate")?;
            let _permit = runtime
                .operations
                .clone()
                .try_acquire_owned()
                .map_err(|_| "Native dialog runtime is busy")?;
            let mut options = options::Options::parse(&invocation.request["options"], access)?;
            // Filesystem metadata runs off the main thread. No private default path
            // is ever serialized into the TaskRun or a generic error message.
            options = tauri::async_runtime::spawn_blocking(move || {
                if let Some(value) = &mut options.default_path {
                    if std::path::Path::new(value).is_dir() && !value.ends_with('/') {
                        value.push('/');
                    }
                }
                options
            })
            .await
            .map_err(|_| "Dialog options preparation interrupted")?;
            validate_session(db, &session)?;
            let result = native::show(
                app,
                &session.owner.window,
                ticket,
                access,
                options,
                invocation.cancel.clone(),
                session.document.clone(),
                app.state::<Arc<native::State>>().inner().clone(),
            )
            .await;
            #[cfg(feature = "legacy-node-smoke")]
            let result = result.and_then(|paths| {
                crate::legacy_node_desktop_smoke::panel_dialog::validate_selection(
                    app,
                    plugin_id,
                    access.method(),
                    &paths,
                )?;
                Ok(paths)
            });
            let failed = result.is_err();
            let canceled = result.as_ref().is_ok_and(Vec::is_empty);
            let count = result.as_ref().map_or(0, Vec::len);
            *invocation.result.lock() =
                Some(result.map(|paths| json!({"canceled":paths.is_empty(),"paths":paths})));
            if failed {
                return Err("Native dialog was closed or failed; private selection details are not recorded".into());
            }
            Ok(
                json!({"invocationId":ticket,"method":access.method(),"canceled":canceled,"count":count,"transportOnly":true}),
            )
        }
        _ => Err("Unsupported dialog operation".into()),
    }
}
pub(crate) async fn invalidate(app: &AppHandle, db: &Database, plugin: Option<&str>) {
    observations::note(observations::Event::Invalidate);
    if let Some(hints) = app.try_state::<source_hint::Hints>() {
        if let Some(plugin) = plugin {
            hints.invalidate(plugin);
        }
    }
    if let Ok(runtime) = manager(app) {
        lifecycle::close(app, db, &runtime, None, plugin, None, false).await;
    }
}
pub(crate) async fn close_document(app: &AppHandle, page_id: &str) {
    if let (Ok(runtime), Some(state)) = (manager(app), app.try_state::<crate::state::AppState>()) {
        for owner in runtime.document_owners(page_id) {
            lifecycle::close(app, &state.db, &runtime, Some(&owner), None, None, false).await;
        }
    }
}
pub(crate) async fn close_window(app: &AppHandle, window: &str) {
    observations::note(observations::Event::CloseWindow);
    if let (Ok(runtime), Some(state)) = (manager(app), app.try_state::<crate::state::AppState>()) {
        lifecycle::close(app, &state.db, &runtime, None, None, Some(window), false).await;
    }
}
pub(crate) fn modal_active(app: &AppHandle, window: &str) -> bool {
    app.try_state::<Arc<native::State>>()
        .is_some_and(|s| s.active(window))
}
pub(crate) async fn stop(app: &AppHandle) {
    observations::note(observations::Event::Stop);
    native::cancel_on_shutdown(app);
    if let (Ok(runtime), Some(state)) = (manager(app), app.try_state::<crate::state::AppState>()) {
        lifecycle::close(app, &state.db, &runtime, None, None, None, true).await;
    }
}
pub(crate) fn stop_on_main_thread(app: &AppHandle) {
    observations::note(observations::Event::StopMain);
    native::cancel_on_shutdown(app);
}
#[cfg(any(test, feature = "legacy-node-smoke"))]
pub(crate) async fn runtime_state(app: &AppHandle) -> Value {
    let (sessions, intents, invocations, preparations, transport) =
        if let Ok(runtime) = manager(app) {
            let (s, i, v, p) = runtime.counts();
            (s, i, v, p, runtime.server.lock().await.is_some())
        } else {
            (0, 0, 0, 0, false)
        };
    let panels = app
        .try_state::<Arc<native::State>>()
        .map_or(0, |s| s.count());
    json!({"dialogSessions":sessions,"dialogIntents":intents,"dialogInvocations":invocations,
        "dialogPreparations":preparations,"dialogTransport":transport,"nativeDialogs":panels,
        "dialogObservations":observations::snapshot()})
}
