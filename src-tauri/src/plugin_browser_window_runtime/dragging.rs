//! Source- and TaskRun-bound preflight for the private native drag action.

use super::{
    intents::{Intent, IntentState, NativeWindow, Payload, WindowLife},
    manager::Runtime,
};
use crate::plugin_window_sources::SourceBinding;
use atools_core::{task_run::TaskRunStatus, Database};
use serde_json::{json, Value};
use std::{
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, WebviewWindow};

const CLIENT: &str = "atools-ui";
const GESTURE_TTL: Duration = Duration::from_millis(250);

pub(super) fn source_is_exact_child(source_frame_id: &str, window_id: &str) -> bool {
    !window_id.is_empty()
        && source_frame_id
            .strip_prefix("child:")
            .is_some_and(|child_id| child_id == window_id)
}

pub(super) fn validate_started_at_for_prepare(args: &[Value]) -> Result<(), String> {
    let started_at_ms = parse_started_at(args)?;
    let now_ms = unix_epoch_ms()?;
    if started_at_ms > now_ms {
        return Err(invalid_gesture("startedAtMs is in the future"));
    }
    if now_ms - started_at_ms > GESTURE_TTL.as_millis() as u64 {
        return Err(invalid_gesture(
            "startedAtMs is older than the active gesture window",
        ));
    }
    Ok(())
}

pub(super) async fn apply(
    app: &AppHandle,
    db: &Database,
    intent: &Arc<Intent>,
    source: &SourceBinding,
    target: &Arc<NativeWindow>,
    args: &[Value],
) -> Result<Value, String> {
    let started_at_ms = parse_started_at(args)?;
    if started_at_ms > intent.prepared_at_epoch_ms
        || intent.prepared_at_epoch_ms - started_at_ms > GESTURE_TTL.as_millis() as u64
        || intent.prepared_at.elapsed() > GESTURE_TTL
    {
        return Err(invalid_gesture(
            "gesture does not match the current BrowserWindow intent",
        ));
    }
    let runtime = super::manager(app)?;
    let run_id = intent
        .run_id
        .lock()
        .clone()
        .ok_or_else(|| "BrowserWindow drag TaskRun is unavailable".to_string())?;
    let tool_name = super::registry::tool_name(&intent.owner.plugin);
    let app_for_check = app.clone();
    let db_for_check = db.clone();
    let runtime_for_check = runtime.clone();
    let intent_for_check = intent.clone();
    let source_for_check = source.clone();
    let target_for_check = target.clone();
    let source_binding_id = source.id().to_string();
    let preflight = move |window: &WebviewWindow| {
        authorize_start(
            &app_for_check,
            &db_for_check,
            &runtime_for_check,
            &intent_for_check,
            &source_for_check,
            &target_for_check,
            &source_binding_id,
            &run_id,
            &tool_name,
            window,
        )
    };
    crate::plugin_browser_window_native::start_dragging(
        app,
        &target.native_label,
        started_at_ms,
        intent.prepared_at,
        intent.prepared_at_epoch_ms,
        preflight,
    )
    .await
}

fn authorize_start(
    app: &AppHandle,
    db: &Database,
    runtime: &Runtime,
    intent: &Intent,
    source: &SourceBinding,
    target: &Arc<NativeWindow>,
    source_binding_id: &str,
    run_id: &str,
    tool_name: &str,
    native_window: &WebviewWindow,
) -> Result<crate::plugin_browser_window_native::StartAuthorization, String> {
    let intent_running = intent.operation == super::intents::Operation::Action
        && intent.state() == IntentState::Running
        && matches!(
            intent.payload.lock().as_ref(),
            Some(Payload::Action { action, args })
                if action == "startDragging" && parse_started_at(args).is_ok()
        );
    let task_run_running = db
        .get_task_run(run_id)
        .map_err(|_| "BrowserWindow drag TaskRun is unavailable")?
        .is_some_and(|run| {
            run.status == TaskRunStatus::Running
                && run.capability_id == tool_name
                && run.input == json!({"operation":"action","intentId":intent.id})
                && run.initiator.client_id.as_deref() == Some(CLIENT)
        });
    let current_source =
        crate::plugin_window_sources::resolve(app, &intent.owner.window, source_binding_id)?;
    let source_active = source.is_active()
        && current_source.is_active()
        && source.owner() == &intent.owner
        && current_source.owner() == source.owner()
        && current_source.frame_id() == source.frame_id()
        && source_is_exact_child(current_source.frame_id(), &intent.window_id)
        && current_source.generation() == source.generation()
        && current_source.document_nonce() == source.document_nonce();
    let current_target = runtime.window_for_source(&current_source, &intent.window_id);
    let exact_self = current_target.as_ref().is_ok_and(|current| {
        Arc::ptr_eq(current, target)
            && current.owner == intent.owner
            && current.creator_binding_id == target.creator_binding_id
            && current.frontend_window_id == intent.window_id
            && current.native_label == native_window.label()
            && intent.source_binding_id == source_binding_id
    });
    let renderer_authorized = target
        .renderer_authorized
        .load(std::sync::atomic::Ordering::Acquire);
    let window_alive = exact_self
        && *target.life.lock() == WindowLife::Alive
        && app.get_webview_window(native_window.label()).is_some();
    let decision = crate::agent_tools::permission_decision_for_tool(db, CLIENT, tool_name)
        .map_err(|_| "BrowserWindow drag permission could not be verified")?;
    let permission_prompt_shown = intent
        .permission_prompt_shown
        .load(std::sync::atomic::Ordering::Acquire);

    Ok(crate::plugin_browser_window_native::StartAuthorization {
        intent_running,
        task_run_running,
        source_active,
        exact_self,
        renderer_authorized,
        window_alive,
        permission_decision: decision,
        permission_prompt_shown,
    })
}

fn parse_started_at(args: &[Value]) -> Result<u64, String> {
    if args.len() != 1 {
        return Err(invalid_gesture(
            "startDragging expects one startedAtMs object",
        ));
    }
    let object = args[0]
        .as_object()
        .ok_or_else(|| invalid_gesture("startDragging argument must be an object"))?;
    if object.len() != 1 || !object.contains_key("startedAtMs") {
        return Err(invalid_gesture(
            "startedAtMs must be the only argument field",
        ));
    }
    let value = object
        .get("startedAtMs")
        .and_then(Value::as_number)
        .filter(|number| number.is_u64())
        .and_then(serde_json::Number::as_u64)
        .ok_or_else(|| invalid_gesture("startedAtMs must be a non-negative integer"))?;
    Ok(value)
}

fn unix_epoch_ms() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|elapsed| u64::try_from(elapsed.as_millis()).ok())
        .ok_or_else(|| invalid_gesture("system clock is outside the supported range"))
}

fn invalid_gesture(message: impl AsRef<str>) -> String {
    format!("ERR_ATOOLS_NATIVE_WINDOW_GESTURE: {}", message.as_ref())
}

#[cfg(test)]
mod tests {
    use super::{parse_started_at, source_is_exact_child, validate_started_at_for_prepare};
    use serde_json::json;

    #[test]
    fn started_at_requires_one_strict_unsigned_integer_field() {
        assert_eq!(parse_started_at(&[json!({"startedAtMs": 123})]), Ok(123));
        assert!(parse_started_at(&[]).is_err());
        assert!(parse_started_at(&[json!({"startedAtMs": 123, "extra": true})]).is_err());
        assert!(parse_started_at(&[json!({"startedAtMs": 123.0})]).is_err());
        assert!(parse_started_at(&[json!({"startedAtMs": -1})]).is_err());
        assert!(parse_started_at(&[json!({"startedAtMs": "123"})]).is_err());
    }

    #[test]
    fn prepare_rejects_future_and_stale_dom_timestamps() {
        assert!(validate_started_at_for_prepare(&[json!({"startedAtMs": u64::MAX})]).is_err());
        assert!(validate_started_at_for_prepare(&[json!({"startedAtMs": 1})]).is_err());
    }

    #[test]
    fn drag_source_must_be_the_exact_target_child_document() {
        assert!(source_is_exact_child("child:window-42", "window-42"));
        assert!(!source_is_exact_child("main", "window-42"));
        assert!(!source_is_exact_child("child:sibling", "window-42"));
        assert!(!source_is_exact_child("child:window-420", "window-42"));
        assert!(!source_is_exact_child("child:", ""));
    }
}
