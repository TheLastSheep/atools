use std::sync::Arc;

use serde_json::{json, Value};
use tauri::{ipc::Invoke, AppHandle, State, Webview, Window, Wry};

use super::{
    cleanup,
    identity::is_valid_session_id,
    lifecycle,
    main_authority::capture_main,
    native_appearance,
    open_claims::ClaimKind,
    open_service::{open_prepared, RequestObserver},
    session::SessionView,
    validation::{
        authorize_child_session, check_payload_budget, close_reason, ensure_still_active,
        exact_object, inactive_session, invalid_payload, require_empty_payload, revision_conflict,
        string_field, validate_main_context, BridgeError,
    },
};

pub(crate) fn handles(command: &str) -> bool {
    matches!(
        command,
        "open_renderer_settings"
            | "open_renderer_app_shortcuts"
            | "close_renderer_settings"
            | "call_renderer_settings"
            | "notify_renderer_settings_input"
    )
}

pub(crate) fn dispatch(invoke: Invoke<Wry>) -> bool {
    let registered: fn(Invoke<Wry>) -> bool = tauri::generate_handler![
        open_renderer_settings,
        super::app_shortcuts_intent::open_renderer_app_shortcuts,
        close_renderer_settings,
        call_renderer_settings,
        notify_renderer_settings_input,
    ];
    registered(invoke)
}

#[tauri::command]
pub(crate) async fn open_renderer_settings(
    app: AppHandle<Wry>,
    webview: Webview<Wry>,
    window: Window<Wry>,
    state: State<'_, crate::state::AppState>,
) -> Result<Value, BridgeError> {
    let main = capture_main(&app, &webview, &window)?;
    let runtime = super::runtime(&app).map_err(|_| inactive_session())?;
    let (claim, _, tickets) = runtime
        .admit_request(main.key, ClaimKind::General)
        .map_err(|_| inactive_session())?;
    super::open_service::cleanup_tickets(&app, tickets);
    let observer = RequestObserver::new(app.clone(), claim).map_err(|_| inactive_session())?;
    let envelope = open_prepared(app, Arc::clone(&state.db), main, observer)
        .await
        .map_err(|_| {
            BridgeError::new("SETTINGS_OPEN_FAILED", "Settings view could not be opened")
        })?;
    // No await between envelope consumption and native receipt adoption.
    envelope.adopt_general().map_err(|_| inactive_session())
}

#[tauri::command]
pub(crate) async fn close_renderer_settings(
    app: AppHandle<Wry>,
    webview: Webview<Wry>,
    window: Window<Wry>,
    session_id: String,
    reason: String,
) -> Result<Value, BridgeError> {
    validate_main_context(&app, &webview, &window)?;
    if !is_valid_session_id(&session_id) || !cleanup::valid_reason(&reason) {
        return Err(BridgeError::new(
            "SETTINGS_CLOSE_REJECTED",
            "Settings view close request is invalid",
        ));
    }
    let runtime = super::runtime(&app).map_err(|_| inactive_session())?;
    if runtime.current_for_id(&session_id).is_err() {
        return Err(inactive_session());
    }
    cleanup::close_session(&app, &session_id, &reason)
        .await
        .map_err(|_| {
            BridgeError::new(
                "SETTINGS_CLOSE_INCOMPLETE",
                "Settings view cleanup completed with a lifecycle failure",
            )
        })?;
    Ok(json!({"version":1,"sessionId":session_id,"closed":true}))
}

#[tauri::command]
pub(crate) async fn notify_renderer_settings_input(
    app: AppHandle<Wry>,
    webview: Webview<Wry>,
    window: Window<Wry>,
    request: Value,
) -> Result<Value, BridgeError> {
    validate_main_context(&app, &webview, &window)?;
    super::sub_input::require_main_role_labels(
        webview.label(),
        webview.window().label(),
        window.label(),
    )?;
    super::sub_input::notify_main_input(&app, &request).await
}

#[tauri::command]
pub(crate) async fn call_renderer_settings(
    app: AppHandle<Wry>,
    webview: Webview<Wry>,
    window: Window<Wry>,
    session_id: String,
    operation: String,
    payload: Value,
) -> Result<Value, BridgeError> {
    check_operation_payload_budget(&operation, &payload)?;
    let session = authorize_child_session(
        &app,
        &webview,
        &window,
        &session_id,
        operation == "outAcknowledged",
    )?;

    // Only this fixed, prevalidated release packet bypasses ordinary operation slots.
    // Native handle() independently verifies the actual current compiled Child.
    if super::app_shortcuts_recording::release_before_quota(&operation) {
        let accounting = super::runtime(&app)
            .map_err(|_| inactive_session())?
            .accounting();
        let _call = accounting.track_call();
        return super::app_shortcuts_recording::handle(&app, &session, &operation, &payload).await;
    }

    if operation == "ackAppShortcutIntent" {
        return super::app_shortcuts_intent::acknowledge(&app, &webview, &session, &payload);
    }

    if operation == "outAcknowledged" {
        require_empty_payload(&payload)?;
        super::runtime(&app)
            .map_err(|_| inactive_session())?
            .acknowledge_out(&session.id)
            .map_err(|_| {
                BridgeError::new(
                    "SETTINGS_ACK_REJECTED",
                    "Settings view acknowledgement was rejected",
                )
            })?;
        return Ok(json!({"acknowledged":true}));
    }

    if operation == "close" {
        let reason = close_reason(&payload)?;
        cleanup::close_session(&app, &session.id, reason)
            .await
            .map_err(|_| {
                BridgeError::new(
                    "SETTINGS_CLOSE_INCOMPLETE",
                    "Settings view cleanup completed with a lifecycle failure",
                )
            })?;
        return Ok(json!({"version":1,"sessionId":session.id,"closed":true}));
    }

    let operation_permit = session
        .operations
        .clone()
        .try_acquire_owned()
        .map_err(|_| {
            BridgeError::new(
                "SETTINGS_CALL_BUSY",
                "Settings view is handling too many requests",
            )
        })?;
    let accounting = super::runtime(&app)
        .map_err(|_| inactive_session())?
        .accounting();
    let call_guard = accounting.track_call();

    if matches!(
        operation.as_str(),
        "startAppShortcutRecording" | "stopAppShortcutRecording"
    ) {
        return super::app_shortcuts_recording::handle(&app, &session, &operation, &payload).await;
    }

    if matches!(
        operation.as_str(),
        "startHotkeyRecording" | "stopHotkeyRecording"
    ) {
        return super::hotkey_recording::handle(&app, &session, &operation, &payload).await;
    }

    if super::about::handles(&operation) {
        return super::about::handle(
            app,
            session,
            operation,
            payload,
            operation_permit,
            call_guard,
            accounting,
        )
        .await;
    }

    if operation == "updateSubInput" {
        return super::sub_input::update_from_child(&app, &session, &payload).await;
    }

    if super::disabled_commands::handles(&operation) {
        return super::disabled_commands::handle(
            app,
            session,
            payload,
            operation_permit,
            call_guard,
            accounting,
        )
        .await;
    }

    if super::search_pins::handles(&operation) {
        return super::search_pins::handle(
            app,
            session,
            payload,
            operation_permit,
            call_guard,
            accounting,
        )
        .await;
    }

    if super::app_global_shortcuts::handles(&operation) {
        return super::app_global_shortcuts::handle(
            app,
            session,
            &operation,
            payload,
            operation_permit,
            call_guard,
            accounting,
        )
        .await;
    }

    if super::local_shortcuts::handles(&operation) {
        return super::local_shortcuts::handle(
            app,
            session,
            &operation,
            payload,
            operation_permit,
            call_guard,
            accounting,
        )
        .await;
    }

    if operation == "patchGeneral" {
        return super::general_write::patch(
            &app,
            &session,
            &payload,
            operation_permit,
            call_guard,
            accounting,
        )
        .await;
    }

    if super::command_data::handles(&operation) {
        return super::command_data::handle(
            app,
            session,
            operation,
            payload,
            operation_permit,
            call_guard,
            accounting,
        )
        .await;
    }

    if super::legacy_launch_at_login::handles(&operation) {
        return super::legacy_launch_at_login::handle(
            app,
            session,
            &operation,
            payload,
            operation_permit,
            call_guard,
            accounting,
        )
        .await;
    }

    if super::launch_at_login::handles(&operation) {
        return super::launch_at_login::handle(
            app,
            session,
            payload,
            operation_permit,
            call_guard,
            accounting,
        )
        .await;
    }

    match operation.as_str() {
        "ready" => ready(&app, &session, &payload).await,
        "readGeneral" => read_general(&app, &session, &payload).await,
        "setTheme" => set_theme(&app, &session, &payload).await,
        "setWindowOpacity" => set_window_opacity(&app, &session, &payload).await,
        _ => Err(BridgeError::new(
            "SETTINGS_OPERATION_REJECTED",
            "Settings view operation is not allowed",
        )),
    }
}

fn check_operation_payload_budget(operation: &str, payload: &Value) -> Result<(), BridgeError> {
    if matches!(
        operation,
        "startAppShortcutRecording" | "stopAppShortcutRecording"
    ) {
        super::app_shortcuts_recording::check_payload(payload)
    } else if operation == "ackAppShortcutIntent" {
        super::intent_protocol::parse_ack(payload).map(|_| ())
    } else if super::local_shortcuts::handles(operation) {
        super::local_shortcut_protocol::check_payload_budget(payload)
    } else if super::disabled_commands::handles(operation) {
        super::disabled_commands::check_payload_budget(payload)
    } else {
        check_payload_budget(payload)
    }
}

async fn ready(
    app: &AppHandle<Wry>,
    session: &SessionView,
    payload: &Value,
) -> Result<Value, BridgeError> {
    require_empty_payload(payload)?;
    if !lifecycle::session_can_serve(session) {
        return Err(inactive_session());
    }
    let general = session.preferences.snapshot().await;
    ensure_still_active(app, session)?;
    let result = lifecycle::ready_snapshot(session, general).map_err(|_| {
        BridgeError::new(
            "SETTINGS_READY_INVALID",
            "Settings view could not prepare its initial snapshot",
        )
    })?;
    super::runtime(app)
        .map_err(|_| inactive_session())?
        .record_ready(&session.id, &session.bundle_revision)
        .map_err(|_| inactive_session())?;
    Ok(result)
}

async fn read_general(
    app: &AppHandle<Wry>,
    session: &SessionView,
    payload: &Value,
) -> Result<Value, BridgeError> {
    require_empty_payload(payload)?;
    let result = session.preferences.snapshot().await;
    ensure_still_active(app, session)?;
    Ok(result)
}

async fn set_theme(
    app: &AppHandle<Wry>,
    session: &SessionView,
    payload: &Value,
) -> Result<Value, BridgeError> {
    let object = exact_object(payload, &["theme"])?;
    let theme = string_field(object, "theme")?;
    if !matches!(theme, "system" | "light" | "dark") {
        return Err(invalid_payload());
    }
    ensure_still_active(app, session)?;
    let snapshot = session.preferences.snapshot().await;
    ensure_still_active(app, session)?;
    if snapshot
        .get("value")
        .and_then(|value| value.get("theme"))
        .and_then(Value::as_str)
        != Some(theme)
    {
        return Err(revision_conflict());
    }
    native_appearance::set_theme(app, &session.preferences, theme)
        .await
        .map_err(|_| {
            BridgeError::new(
                "SETTINGS_THEME_APPLY_FAILED",
                "The committed theme could not be applied to the main window",
            )
        })?;
    ensure_still_active(app, session)?;
    Ok(json!({"theme":theme,"themeApplied":true}))
}

async fn set_window_opacity(
    app: &AppHandle<Wry>,
    session: &SessionView,
    payload: &Value,
) -> Result<Value, BridgeError> {
    let object = exact_object(payload, &["opacity"])?;
    let opacity = object
        .get("opacity")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && (0.3..=1.0).contains(value))
        .ok_or_else(|| invalid_payload())?;
    ensure_still_active(app, session)?;
    let snapshot = session.preferences.snapshot().await;
    ensure_still_active(app, session)?;
    if snapshot
        .get("value")
        .and_then(|value| value.get("opacity"))
        .and_then(Value::as_f64)
        != Some(opacity)
    {
        return Err(BridgeError::new(
            "SETTINGS_OPACITY_UNSUPPORTED",
            "Window opacity changes are not supported by this settings adapter",
        ));
    }
    if session
        .native_runtime
        .get("opacityApplied")
        .and_then(Value::as_bool)
        != Some(true)
    {
        return Err(BridgeError::new(
            "SETTINGS_OPACITY_UNAVAILABLE",
            "Window opacity is not available on this platform",
        ));
    }
    native_appearance::set_opacity(app, &session.preferences, opacity)
        .await
        .map_err(|_| {
            BridgeError::new(
                "SETTINGS_OPACITY_APPLY_FAILED",
                "The configured window opacity could not be applied",
            )
        })?;
    ensure_still_active(app, session)?;
    Ok(json!({"opacity":opacity,"opacityApplied":true}))
}

#[cfg(test)]
mod payload_budget_tests {
    use super::*;

    #[test]
    fn only_disabled_command_writes_receive_the_larger_payload_budget() {
        let medium = json!({"value":"x".repeat(70 * 1024)});
        assert!(check_operation_payload_budget("writeDisabledCommands", &medium).is_ok());
        assert!(check_operation_payload_budget("readCommandSettings", &medium).is_err());
        assert!(check_operation_payload_budget("unknownOperation", &medium).is_err());

        let too_large = json!({"value":"x".repeat(129 * 1024)});
        assert!(check_operation_payload_budget("writeDisabledCommands", &too_large).is_err());
    }
}
