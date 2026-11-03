//! Source and native-window lifecycle. Cross-module work always happens after
//! the manager has released its state lock.
use super::{
    intents::{Intent, LoadState, NativeWindow, Reservation, WindowLife},
    manager::Runtime,
    EVENT,
};
use atools_core::{
    agent::PermissionDecision,
    task_run::{TaskRun, TaskRunStatus},
    Database,
};
use serde_json::json;
use std::{sync::Arc, time::Duration};
use tauri::Url;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

pub(super) const OPEN_TIMEOUT: Duration = Duration::from_secs(5);

pub(super) fn consume_popup(
    app: &AppHandle,
    parent: &WebviewWindow,
    url: &Url,
) -> Result<Option<crate::plugin_browser_window_native::WindowSpec>, String> {
    let Some(ticket) = url
        .fragment()
        .filter(|ticket| super::identity::is_private_id(ticket))
    else {
        return Ok(None);
    };
    if url.path() != "/atools-native-window.html"
        || url.query().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Ok(None);
    }
    let runtime = super::manager(app)?;
    let Some(reservation) = runtime.reservation(parent.label(), url.as_str()) else {
        return Ok(None);
    };
    if reservation.shell_ticket != ticket
        || reservation.window.owner.window != parent.label()
        || reservation.window.creator_binding_id != reservation.binding_id
        || reservation.window.native_label != reservation.spec.label()
    {
        return Ok(None);
    }
    let state = app
        .try_state::<crate::state::AppState>()
        .ok_or("Plugin application state is unavailable")?;
    validate_open_run(&state.db, &reservation)?;
    let source = crate::plugin_window_sources::resolve(
        app,
        &reservation.window.owner.window,
        &reservation.binding_id,
    )?;
    if source.owner() != &reservation.window.owner || !source.is_active() {
        return Ok(None);
    }
    let name = super::registry::tool_name(&source.owner().plugin);
    let tool = state
        .db
        .get_agent_tool(&name)
        .map_err(|_| "BrowserWindow capability is unavailable")?
        .ok_or("BrowserWindow capability is unavailable")?;
    super::registry::validate(&tool)?;
    if crate::agent_tools::permission_decision_for_tool(&state.db, "atools-ui", &name)?
        == PermissionDecision::Deny
    {
        return Err("BrowserWindow permission was revoked before native creation".into());
    }

    crate::plugin_window_sources::authorize_renderer(
        app,
        &source,
        &reservation.window.native_label,
    )?;
    if source.validate(app, &state.db).is_err() {
        crate::plugin_window_sources::revoke_renderer(app, &reservation.window.native_label);
        return Ok(None);
    }
    let Some(consumed) = runtime.consume_reservation(
        parent.label(),
        url.as_str(),
        &reservation.binding_id,
        &reservation.run_id,
    ) else {
        crate::plugin_window_sources::revoke_renderer(app, &reservation.window.native_label);
        return Ok(None);
    };
    consumed
        .window
        .renderer_authorized
        .store(true, std::sync::atomic::Ordering::Release);
    Ok(Some(consumed.spec))
}

/// Called by the native adapter immediately after builder success. It closes a
/// window whose source or TaskRun was revoked while the builder was in flight.
pub(crate) fn native_created(app: &AppHandle, label: &str) {
    let Ok(runtime) = super::manager(app) else {
        return;
    };
    let Some(window) = runtime.mark_created(label) else {
        return;
    };
    if *window.life.lock() == WindowLife::Destroying
        || validate_creating_window(app, &window).is_err()
    {
        window
            .load_tx
            .send_replace(LoadState::Failed("BrowserWindow source was revoked".into()));
        cancel_open_intent(app, &runtime, &window, "BrowserWindow source was revoked");
        request_destroy(app, &window);
    }
}

/// A builder failure proves that no native record will ever arrive, so this is
/// the only pre-Destroyed path allowed to release its reserved budget.
pub(crate) fn native_build_failed(app: &AppHandle, label: &str) {
    let Ok(runtime) = super::manager(app) else {
        return;
    };
    let Some(window) = runtime.build_failed(label) else {
        return;
    };
    crate::plugin_browser_window_native::forget_window(app, label);
    crate::plugin_window_sources::revoke_renderer(app, label);
    cancel_open_intent(
        app,
        &runtime,
        &window,
        "Native BrowserWindow could not be created",
    );
}

pub(crate) fn native_loaded(app: &AppHandle, label: &str) {
    let Ok(runtime) = super::manager(app) else {
        return;
    };
    let Some(window) = runtime.window(label) else {
        return;
    };
    if validate_creating_window(app, &window).is_err()
        || *window.life.lock() != WindowLife::Creating
    {
        window.load_tx.send_replace(LoadState::Failed(
            "BrowserWindow source is no longer active".into(),
        ));
        cancel_open_intent(
            app,
            &runtime,
            &window,
            "BrowserWindow source is no longer active",
        );
        request_destroy(app, &window);
        return;
    }
    if runtime.mark_loaded(label).is_none() {
        return;
    }
}

/// Window events carry no source identifiers, tokens, or shell URLs.
pub(crate) fn native_event(app: &AppHandle, label: &str, kind: &str) {
    if kind == "Destroyed" {
        return;
    }
    super::event_queue::queue_native_event(app, label, kind);
}

/// Only the adapter's real `WindowEvent::Destroyed` callback calls this hook.
pub(crate) fn native_destroyed(app: &AppHandle, label: &str) {
    let Ok(runtime) = super::manager(app) else {
        return;
    };
    let Some((window, expected_close_run, cancelled)) = runtime.remove_destroyed(label) else {
        return;
    };
    crate::plugin_window_sources::revoke_renderer(app, label);
    crate::plugin_browser_window_native::forget_window(app, label);
    if let Some(state) = app.try_state::<crate::state::AppState>() {
        cancel_intents(
            app,
            &state.db,
            cancelled,
            "Native BrowserWindow was destroyed",
        );
    }

    // Revoking the exact child frame cancels descendants. Protect this close
    // action's own TaskRun until the cascade has finished.
    crate::plugin_window_sources::revoke_frame(
        app,
        &window.owner,
        &format!("child:{}", window.frontend_window_id),
    );
    if let Some(run_id) = &expected_close_run {
        runtime.clear_protected_close(run_id);
    }
    let payload = json!({"windowId":window.frontend_window_id,"nativeLabel":window.native_label,"kind":"Destroyed"});
    let _ = app.emit_to(&window.parent_label, EVENT, payload);
}

pub(crate) fn close_sources(app: &AppHandle, ids: &[String]) {
    let Ok(runtime) = super::manager(app) else {
        return;
    };
    let (intents, windows, reservations) = runtime.close_sources(ids);
    cleanup_reservations(app, reservations);
    if let Some(state) = app.try_state::<crate::state::AppState>() {
        cancel_intents(app, &state.db, intents, "Plugin source was revoked");
    }
    for window in windows {
        crate::plugin_window_sources::revoke_renderer(app, &window.native_label);
        request_destroy(app, &window);
    }
}

pub(super) fn close_parent(app: &AppHandle, label: &str) {
    let Ok(runtime) = super::manager(app) else {
        return;
    };
    let (intents, windows, reservations) = runtime.close_parent(label);
    cleanup_reservations(app, reservations);
    if let Some(state) = app.try_state::<crate::state::AppState>() {
        cancel_intents(
            app,
            &state.db,
            intents,
            "Native BrowserWindow parent was destroyed",
        );
    }
    for window in windows {
        request_destroy(app, &window);
    }
}

pub(super) fn stop(app: &AppHandle) {
    let Ok(runtime) = super::manager(app) else {
        return;
    };
    let (intents, windows, reservations) = runtime.stop();
    cleanup_reservations(app, reservations);
    if let Some(state) = app.try_state::<crate::state::AppState>() {
        cancel_intents(
            app,
            &state.db,
            intents,
            "Native BrowserWindow runtime stopped",
        );
    }
    for window in windows {
        request_destroy(app, &window);
    }
    crate::plugin_window_sources::clear(app);
}

pub(super) fn cancel_intent(
    app: &AppHandle,
    db: &Database,
    runtime: &Runtime,
    id: &str,
    reason: &str,
) {
    let Some(intent) = runtime.cancel_intent(id, reason) else {
        return;
    };
    cancel_task_run(app, db, &intent, reason);
    if let Some(window) = runtime.window_for_intent(id) {
        if intent.operation == super::intents::Operation::Open {
            let _ = runtime.mark_destroying(&window.native_label);
            request_destroy(app, &window);
        }
    }
}

/// Hook called by the shared TaskRun cancellation path after its durable
/// transition. It never re-enters that path and is a no-op for unrelated runs.
pub(crate) fn cancel_run(app: &AppHandle, run_id: &str) {
    let Ok(runtime) = super::manager(app) else {
        return;
    };
    let Some(intent) = runtime.intent_by_run(run_id) else {
        return;
    };
    let _ = runtime.cancel_intent(&intent.id, "BrowserWindow TaskRun was cancelled");
    if let Some(window) = runtime.window_for_intent(&intent.id) {
        if intent.operation == super::intents::Operation::Open {
            let _ = runtime.mark_destroying(&window.native_label);
            request_destroy(app, &window);
        }
    }
}

fn validate_open_run(db: &Database, reservation: &Reservation) -> Result<TaskRun, String> {
    let run = db
        .get_task_run(&reservation.run_id)
        .map_err(|_| "BrowserWindow TaskRun is unavailable")?
        .ok_or("BrowserWindow TaskRun is unavailable")?;
    let expected = json!({"operation":"open","intentId":reservation.window.intent_id});
    if run.status != TaskRunStatus::Running
        || run.capability_id != super::registry::tool_name(&reservation.window.owner.plugin)
        || run.input != expected
        || run.initiator.client_id.as_deref() != Some("atools-ui")
    {
        return Err("BrowserWindow TaskRun is no longer authorized".into());
    }
    Ok(run)
}

fn validate_creating_window(app: &AppHandle, window: &NativeWindow) -> Result<(), String> {
    validate_alive_window(app, window)?;
    let state = app
        .try_state::<crate::state::AppState>()
        .ok_or("Plugin application state is unavailable")?;
    let run = state
        .db
        .get_task_run(&window.open_run_id)
        .map_err(|_| "BrowserWindow TaskRun is unavailable")?
        .ok_or("BrowserWindow TaskRun is unavailable")?;
    if run.status != TaskRunStatus::Running {
        return Err("BrowserWindow creation TaskRun is no longer running".into());
    }
    Ok(())
}

/// Alive windows remain usable after the open run succeeds and its private
/// result has been taken. The immutable run id avoids depending on that
/// one-shot intent record for subsequent native events.
pub(super) fn validate_alive_window(app: &AppHandle, window: &NativeWindow) -> Result<(), String> {
    let state = app
        .try_state::<crate::state::AppState>()
        .ok_or("Plugin application state is unavailable")?;
    let source = crate::plugin_window_sources::resolve(
        app,
        &window.owner.window,
        &window.creator_binding_id,
    )?;
    source.validate(app, &state.db)?;
    if source.owner() != &window.owner
        || !window
            .renderer_authorized
            .load(std::sync::atomic::Ordering::Acquire)
    {
        return Err("BrowserWindow source is no longer authorized".into());
    }
    let capability_name = super::registry::tool_name(&window.owner.plugin);
    let tool = state
        .db
        .get_agent_tool(&capability_name)
        .map_err(|_| "BrowserWindow capability is unavailable")?
        .ok_or("BrowserWindow capability is unavailable")?;
    super::registry::validate(&tool)?;
    if tool.plugin_id.as_deref() != Some(window.owner.plugin.as_str())
        || crate::agent_tools::permission_decision_for_tool(
            &state.db,
            "atools-ui",
            &capability_name,
        )? == PermissionDecision::Deny
    {
        return Err("BrowserWindow capability is no longer authorized".into());
    }
    let run = state
        .db
        .get_task_run(&window.open_run_id)
        .map_err(|_| "BrowserWindow TaskRun is unavailable")?
        .ok_or("BrowserWindow TaskRun is unavailable")?;
    let expected = json!({"operation":"open","intentId":window.intent_id});
    if run.capability_id != capability_name
        || run.input != expected
        || run.initiator.client_id.as_deref() != Some("atools-ui")
        || !open_run_is_alive(run.status)
    {
        return Err("BrowserWindow open authorization is no longer active".into());
    }
    Ok(())
}

fn open_run_is_alive(status: TaskRunStatus) -> bool {
    matches!(status, TaskRunStatus::Running | TaskRunStatus::Succeeded)
}

fn cancel_open_intent(app: &AppHandle, runtime: &Runtime, window: &NativeWindow, reason: &str) {
    if let Some(intent) = runtime.cancel_intent(&window.intent_id, reason) {
        if let Some(state) = app.try_state::<crate::state::AppState>() {
            cancel_task_run(app, &state.db, &intent, reason);
        }
    }
}

fn cancel_intents(app: &AppHandle, db: &Database, intents: Vec<Arc<Intent>>, reason: &str) {
    for intent in intents {
        cancel_task_run(app, db, &intent, reason);
    }
}

fn cancel_task_run(app: &AppHandle, db: &Database, intent: &Intent, reason: &str) {
    let Some(run_id) = intent.run_id.lock().clone() else {
        return;
    };
    let Ok(Some(mut run)) = db.get_task_run(&run_id) else {
        return;
    };
    if run.status.is_terminal() {
        return;
    }
    let was_running = run.status == TaskRunStatus::Running;
    run.summary = Some(match reason {
        "Plugin source was revoked" => "Plugin BrowserWindow source was revoked".into(),
        "Native BrowserWindow parent was destroyed" => {
            "Plugin BrowserWindow parent was destroyed".into()
        }
        "Native BrowserWindow runtime stopped" => "Plugin BrowserWindow runtime stopped".into(),
        _ => "Plugin BrowserWindow operation was cancelled".into(),
    });
    if run.transition(TaskRunStatus::Cancelled).is_err() {
        return;
    }
    let changed = if was_running {
        db.finish_running_task_run(&run)
    } else {
        db.update_pending_task_run(&run)
    };
    if changed.unwrap_or(false) {
        crate::permission_requests::remove_for_run(app, &run_id);
        let _ = app.emit("task-run-updated", run_id);
    }
}

fn cleanup_reservations(app: &AppHandle, reservations: Vec<Reservation>) {
    for reservation in reservations {
        crate::plugin_window_sources::revoke_renderer(app, &reservation.window.native_label);
        reservation.window.load_tx.send_replace(LoadState::Failed(
            "BrowserWindow reservation was revoked".into(),
        ));
    }
}

pub(super) fn request_destroy(app: &AppHandle, window: &NativeWindow) {
    let Some(native) = app.get_webview_window(&window.native_label) else {
        // A Creating record remains budgeted until native_created/build_failed
        // disambiguates the in-flight builder. Never synthesize Destroyed.
        return;
    };
    if window
        .destroy_requested
        .compare_exchange(
            false,
            true,
            std::sync::atomic::Ordering::AcqRel,
            std::sync::atomic::Ordering::Acquire,
        )
        .is_ok()
        && native.destroy().is_err()
    {
        window
            .destroy_requested
            .store(false, std::sync::atomic::Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::open_run_is_alive;
    use atools_core::task_run::TaskRunStatus;

    #[test]
    fn successful_open_remains_authoritative_after_intent_handoff() {
        assert!(open_run_is_alive(TaskRunStatus::Running));
        assert!(open_run_is_alive(TaskRunStatus::Succeeded));
        assert!(!open_run_is_alive(TaskRunStatus::Failed));
        assert!(!open_run_is_alive(TaskRunStatus::Cancelled));
        assert!(!open_run_is_alive(TaskRunStatus::Partial));
    }
}
