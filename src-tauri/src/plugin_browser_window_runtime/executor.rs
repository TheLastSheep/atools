//! TaskRun dispatcher for the source-bound native BrowserWindow capability.
use super::{
    intents::{Intent, IntentState, LoadState, NativeWindow, Operation, Payload, WindowLife},
    manager::Runtime,
};
use atools_core::{
    agent::ToolDefinition,
    task_run::{TaskRun, TaskRunStatus},
};
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
use tauri::{AppHandle, Manager};
use tokio::sync::watch;

const CLIENT: &str = "atools-ui";
const DURABLE_ERROR: &str = "Native BrowserWindow operation failed";

pub(super) async fn execute(
    app: &AppHandle,
    db: &atools_core::Database,
    tool: &ToolDefinition,
    arguments: Value,
    client: &str,
    run_id: &str,
    _execution: Option<Arc<tokio::sync::OwnedRwLockReadGuard<()>>>,
) -> Result<Value, String> {
    let (operation, intent_id) = parse_private_arguments(&arguments)?;
    if client != CLIENT || tool.source != super::SOURCE {
        return Err(DURABLE_ERROR.into());
    }
    super::registry::validate(tool).map_err(|_| DURABLE_ERROR)?;
    let runtime = super::manager(app).map_err(|_| DURABLE_ERROR)?;
    let intent = runtime.intent(intent_id).map_err(|_| DURABLE_ERROR)?;
    validate_running_run(db, tool, &intent, operation, &arguments, run_id, client)
        .map_err(|error| fail_private(&runtime, &intent, error))?;
    let source =
        crate::plugin_window_sources::resolve(app, &intent.owner.window, &intent.source_binding_id)
            .and_then(|source| {
                source.validate(app, db)?;
                if source.owner() != &intent.owner || !source.is_active() {
                    return Err("BrowserWindow source identity is no longer active".into());
                }
                Ok(source)
            })
            .map_err(|error| fail_private(&runtime, &intent, error))?;
    let name = super::registry::tool_name(&intent.owner.plugin);
    if tool.name != name
        || tool.plugin_id.as_deref() != Some(intent.owner.plugin.as_str())
        || crate::agent_tools::permission_decision_for_tool(db, CLIENT, &name)
            .map_err(|error| fail_private(&runtime, &intent, error))?
            == atools_core::agent::PermissionDecision::Deny
    {
        return Err(fail_private(
            &runtime,
            &intent,
            "BrowserWindow authorization was revoked".into(),
        ));
    }
    if !intent.set_state(IntentState::Running) {
        return Err(DURABLE_ERROR.into());
    }

    match operation {
        Operation::Open => execute_open(app, db, &runtime, &intent, &source).await,
        Operation::Action => execute_action(app, db, &runtime, &intent, &source).await,
    }
}

async fn execute_open(
    app: &AppHandle,
    db: &atools_core::Database,
    runtime: &Runtime,
    intent: &Arc<Intent>,
    source: &crate::plugin_window_sources::SourceBinding,
) -> Result<Value, String> {
    if validate_open_intent_run(db, intent).is_err() || source.validate(app, db).is_err() {
        return Err(fail_private(
            runtime,
            intent,
            "BrowserWindow open authorization is no longer current".into(),
        ));
    }
    let spec = match intent.payload.lock().as_mut() {
        Some(Payload::Open { spec }) => spec.take(),
        _ => None,
    }
    .ok_or_else(|| {
        fail_private(
            runtime,
            intent,
            "BrowserWindow open specification was consumed".into(),
        )
    })?;
    let ticket = super::identity::private_id();
    let parent = app
        .get_webview_window(&intent.owner.window)
        .ok_or_else(|| {
            fail_private(
                runtime,
                intent,
                "BrowserWindow parent is unavailable".into(),
            )
        })?;
    let shell_url = parent
        .url()
        .map_err(|error| {
            fail_private(
                runtime,
                intent,
                format!("Unable to read trusted parent URL: {error}"),
            )
        })?
        .join(&format!("/atools-native-window.html#{ticket}"))
        .map_err(|error| {
            fail_private(
                runtime,
                intent,
                format!("Unable to construct native shell URL: {error}"),
            )
        })?;
    let shell_url = shell_url.to_string();
    let (window, mut load_rx) = runtime
        .reserve(
            intent,
            parent.label().to_string(),
            shell_url.clone(),
            ticket,
            spec,
        )
        .map_err(|error| fail_private(runtime, intent, error))?;

    // Only the trusted host bridge knows how to turn a reservation into an
    // opaque plugin iframe. No plugin URL or HTML crosses this native boundary.
    let binding_js = js_string(&intent.source_binding_id).map_err(|error| {
        fail_open_before_popup(app, runtime, intent, &window, &shell_url, error)
    })?;
    let window_js = js_string(&intent.window_id).map_err(|error| {
        fail_open_before_popup(app, runtime, intent, &window, &shell_url, error)
    })?;
    let url_js = js_string(&shell_url).map_err(|error| {
        fail_open_before_popup(app, runtime, intent, &window, &shell_url, error)
    })?;
    let script = format!(
        "if (window.__ATOOLS_NATIVE_WINDOWS__ && typeof window.__ATOOLS_NATIVE_WINDOWS__.openAuthorized === 'function') {{ window.__ATOOLS_NATIVE_WINDOWS__.openAuthorized({binding_js},{window_js},{url_js}); }}"
    );
    if let Err(error) = parent.eval(&script) {
        return Err(fail_open_before_popup(
            app,
            runtime,
            intent,
            &window,
            &shell_url,
            error.to_string(),
        ));
    }

    let mut cancel_rx = intent.cancel_tx.subscribe();
    match wait_for_load(&mut load_rx, &mut cancel_rx, super::lifecycle::OPEN_TIMEOUT).await {
        Ok(()) => {}
        Err(detail) => {
            if runtime.expire_reservation(&shell_url).is_some() {
                crate::plugin_window_sources::revoke_renderer(app, &window.native_label);
                window.load_tx.send_replace(LoadState::Failed(
                    "Native BrowserWindow load timed out".into(),
                ));
            }
            if let Some(created) = runtime.window_for_intent(&intent.id) {
                let _ = runtime.mark_destroying(&created.native_label);
                super::lifecycle::request_destroy(app, &created);
            }
            if intent.state() == IntentState::Cancelled {
                return Err(DURABLE_ERROR.into());
            }
            return Err(fail_private(runtime, intent, detail));
        }
    }
    if validate_open_intent_run(db, intent).is_err()
        || source.validate(app, db).is_err()
        || *window.life.lock() != WindowLife::Alive
    {
        let _ = runtime.mark_destroying(&window.native_label);
        super::lifecycle::request_destroy(app, &window);
        return Err(fail_private(
            runtime,
            intent,
            "BrowserWindow source changed during creation".into(),
        ));
    }
    let snapshot =
        match crate::plugin_browser_window_native::snapshot(app, &window.native_label).await {
            Ok(snapshot) => snapshot.to_value(),
            Err(error) => Err(error),
        }
        .map_err(|error| {
            let _ = runtime.mark_destroying(&window.native_label);
            super::lifecycle::request_destroy(app, &window);
            fail_private(runtime, intent, error)
        })?;
    let result = json!({
        "windowId": window.frontend_window_id,
        "nativeLabel": window.native_label,
        "snapshot": snapshot,
    });
    if !runtime.finish_intent(intent, Ok(result)) {
        let _ = runtime.mark_destroying(&window.native_label);
        super::lifecycle::request_destroy(app, &window);
        return Err(DURABLE_ERROR.into());
    }
    Ok(json!({"operation":"open","windowId":window.frontend_window_id,"status":"created"}))
}

async fn execute_action(
    app: &AppHandle,
    db: &atools_core::Database,
    runtime: &Runtime,
    intent: &Arc<Intent>,
    source: &crate::plugin_window_sources::SourceBinding,
) -> Result<Value, String> {
    let (action, args) = match intent.payload.lock().as_ref() {
        Some(Payload::Action { action, args }) => (action.clone(), args.clone()),
        _ => {
            return Err(fail_private(
                runtime,
                intent,
                "BrowserWindow action is unavailable".into(),
            ))
        }
    };
    if action == "__renderReady" && !args.is_empty() {
        return Err(fail_private(
            runtime,
            intent,
            "Renderer readiness does not accept action arguments".into(),
        ));
    }
    let target = runtime
        .window_for_source(source, &intent.window_id)
        .map_err(|error| fail_private(runtime, intent, error))?;
    if source.validate(app, db).is_err()
        || !target
            .renderer_authorized
            .load(std::sync::atomic::Ordering::Acquire)
    {
        return Err(fail_private(
            runtime,
            intent,
            "BrowserWindow source was revoked".into(),
        ));
    }

    let close_action = matches!(action.as_str(), "close" | "destroy");
    let close_run_id = if close_action {
        let run_id = intent.run_id.lock().clone().ok_or_else(|| {
            fail_private(
                runtime,
                intent,
                "BrowserWindow TaskRun is unavailable".into(),
            )
        })?;
        runtime
            .begin_expected_close(&target.native_label, &run_id)
            .map_err(|error| fail_private(runtime, intent, error))?;
        Some(run_id)
    } else {
        None
    };
    let mut destroyed_rx = target.load_tx.subscribe();
    let action_result = if action == "__renderReady" {
        runtime
            .claim_renderer_ready(&target.native_label, source.id())
            .map_err(|error| fail_private(runtime, intent, error))?;
        if target.requested_show {
            crate::plugin_browser_window_native::apply_action(
                app,
                &target.native_label,
                "show",
                &[],
            )
            .await
        } else {
            match crate::plugin_browser_window_native::snapshot(app, &target.native_label).await {
                Ok(snapshot) => snapshot
                    .to_value()
                    .map(|snapshot| json!({"value":null,"snapshot":snapshot})),
                Err(error) => Err(error),
            }
        }
    } else {
        if action == "startDragging" {
            super::dragging::apply(app, db, intent, source, &target, &args).await
        } else {
            crate::plugin_browser_window_native::apply_action(
                app,
                &target.native_label,
                &action,
                &args,
            )
            .await
        }
    };
    let action_result = match action_result {
        Ok(result) => result,
        Err(error) => {
            if let Some(run_id) = close_run_id.as_deref() {
                runtime.clear_expected_close(&target.native_label, run_id);
            }
            return Err(fail_private(runtime, intent, error));
        }
    };

    if close_action {
        if wait_for_destroyed(&mut destroyed_rx, super::lifecycle::OPEN_TIMEOUT)
            .await
            .is_err()
        {
            if let Some(run_id) = close_run_id.as_deref() {
                // Keep the native record and its budget until the actual
                // Destroyed callback. The timed-out action has failed, so its
                // expected-close exemption must no longer mask later cleanup.
                let _ = runtime.abandon_expected_close(&target.native_label, run_id);
            }
            super::lifecycle::request_destroy(app, &target);
            return Err(fail_private(
                runtime,
                intent,
                "Native BrowserWindow destruction timed out".into(),
            ));
        }
    }
    if action == "__renderReady" && target.permission_prompt_shown && !target.parent_was_visible {
        if let Some(parent) = app.get_webview_window(&target.parent_label) {
            parent.hide().map_err(|error| {
                fail_private(
                    runtime,
                    intent,
                    format!("Unable to restore hidden parent: {error}"),
                )
            })?;
        }
    }
    let value = json!({
        "windowId": target.frontend_window_id,
        "nativeLabel": target.native_label,
        "value": action_result.get("value").cloned().unwrap_or(Value::Null),
        "snapshot": action_result.get("snapshot").cloned().unwrap_or(Value::Null),
    });
    if !runtime.finish_intent(intent, Ok(value)) {
        return Err(DURABLE_ERROR.into());
    }
    Ok(json!({"operation":"action","windowId":target.frontend_window_id,"status":"completed"}))
}

fn parse_private_arguments(args: &Value) -> Result<(Operation, &str), String> {
    let fields = args.as_object().ok_or_else(|| DURABLE_ERROR.to_string())?;
    if fields.len() != 2
        || fields
            .keys()
            .any(|key| !["operation", "intentId"].contains(&key.as_str()))
    {
        return Err(DURABLE_ERROR.into());
    }
    let operation = match args.get("operation").and_then(Value::as_str) {
        Some("open") => Operation::Open,
        Some("action") => Operation::Action,
        _ => return Err(DURABLE_ERROR.into()),
    };
    let id = args
        .get("intentId")
        .and_then(Value::as_str)
        .ok_or_else(|| DURABLE_ERROR.to_string())?;
    if !super::identity::is_private_id(id) {
        return Err(DURABLE_ERROR.into());
    }
    Ok((operation, id))
}

fn validate_running_run(
    db: &atools_core::Database,
    tool: &ToolDefinition,
    intent: &Intent,
    operation: Operation,
    arguments: &Value,
    run_id: &str,
    client: &str,
) -> Result<TaskRun, String> {
    if intent.operation != operation || intent.run_id.lock().as_deref() != Some(run_id) {
        return Err("BrowserWindow intent is bound to another run".into());
    }
    let run = db
        .get_task_run(run_id)
        .map_err(|_| "BrowserWindow TaskRun is unavailable")?
        .ok_or("BrowserWindow TaskRun is unavailable")?;
    if run.status != TaskRunStatus::Running
        || run.capability_id != tool.name
        || run.input != *arguments
        || run.initiator.client_id.as_deref() != Some(client)
    {
        return Err("BrowserWindow TaskRun authorization is no longer current".into());
    }
    Ok(run)
}

fn validate_open_intent_run(db: &atools_core::Database, intent: &Intent) -> Result<(), String> {
    let run_id = intent
        .run_id
        .lock()
        .clone()
        .ok_or("BrowserWindow open TaskRun is unavailable")?;
    let run = db
        .get_task_run(&run_id)
        .map_err(|_| "BrowserWindow open TaskRun is unavailable")?
        .ok_or("BrowserWindow open TaskRun is unavailable")?;
    if run.status != TaskRunStatus::Running
        || run.capability_id != super::registry::tool_name(&intent.owner.plugin)
        || run.input != json!({"operation":"open","intentId":intent.id})
        || run.initiator.client_id.as_deref() != Some(CLIENT)
    {
        return Err("BrowserWindow open TaskRun was cancelled or changed".into());
    }
    Ok(())
}

async fn wait_for_load(
    load: &mut watch::Receiver<LoadState>,
    cancel: &mut watch::Receiver<bool>,
    timeout: Duration,
) -> Result<(), String> {
    tokio::time::timeout(timeout, async {
        loop {
            match load.borrow().clone() {
                LoadState::Loaded => return Ok(()),
                LoadState::Failed(message) => return Err(message),
                LoadState::Destroyed => return Err("Native BrowserWindow was destroyed during creation".into()),
                LoadState::Pending => {}
            }
            if *cancel.borrow() { return Err("BrowserWindow request was cancelled".into()); }
            tokio::select! {
                changed = load.changed() => if changed.is_err() { return Err("Native BrowserWindow load signal ended".into()); },
                changed = cancel.changed() => if changed.is_err() || *cancel.borrow() { return Err("BrowserWindow request was cancelled".into()); },
            }
        }
    }).await.map_err(|_| "Native BrowserWindow load timed out".to_string())?
}

async fn wait_for_destroyed(
    load: &mut watch::Receiver<LoadState>,
    timeout: Duration,
) -> Result<(), String> {
    tokio::time::timeout(timeout, async {
        loop {
            match load.borrow().clone() {
                LoadState::Destroyed => return Ok(()),
                LoadState::Failed(message) => return Err(message),
                _ => {}
            }
            load.changed()
                .await
                .map_err(|_| "Native BrowserWindow destruction signal ended")?;
        }
    })
    .await
    .map_err(|_| "Native BrowserWindow destruction timed out".to_string())?
}

fn fail_open_before_popup(
    app: &AppHandle,
    runtime: &Runtime,
    intent: &Arc<Intent>,
    _window: &NativeWindow,
    shell_url: &str,
    detail: String,
) -> String {
    if let Some(reservation) = runtime.expire_reservation(shell_url) {
        crate::plugin_window_sources::revoke_renderer(app, &reservation.window.native_label);
        reservation.window.load_tx.send_replace(LoadState::Failed(
            "Native BrowserWindow was not opened".into(),
        ));
    }
    fail_private(runtime, intent, detail)
}

fn fail_private(runtime: &Runtime, intent: &Arc<Intent>, detail: String) -> String {
    runtime.finish_intent(intent, Err(detail));
    DURABLE_ERROR.into()
}

fn js_string(value: &str) -> Result<String, String> {
    serde_json::to_string(value)
        .map_err(|error| format!("Unable to encode trusted BrowserWindow argument: {error}"))
}
