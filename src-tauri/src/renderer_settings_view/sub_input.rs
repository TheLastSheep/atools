#[path = "sub_input/delivery.rs"]
mod delivery;
#[path = "sub_input/protocol.rs"]
mod protocol;
#[path = "sub_input/state.rs"]
mod state;

#[cfg(test)]
#[path = "sub_input/tests.rs"]
mod tests;

pub(crate) use state::{SubInputBuffer, SubInputDiagnostics};

use serde_json::Value;
use tauri::{AppHandle, Wry};

use super::{
    lifecycle,
    session::SessionView,
    validation::{ensure_still_active, inactive_session, BridgeError},
};

pub(crate) async fn notify_main_input(
    app: &AppHandle<Wry>,
    request: &Value,
) -> Result<Value, BridgeError> {
    let request = protocol::parse_main_input(request)?;
    let runtime = super::runtime(app).map_err(|_| inactive_session())?;
    let session = runtime
        .current_for_id(&request.session_id)
        .map_err(|_| inactive_session())?;
    if session.bundle_revision != request.bundle_revision || !lifecycle::session_can_serve(&session)
    {
        return Err(inactive_session());
    }

    let _permit = session
        .operations
        .clone()
        .try_acquire_owned()
        .map_err(|_| {
            BridgeError::new(
                "SETTINGS_CALL_BUSY",
                "Settings view is handling too many requests",
            )
        })?;
    let _call_guard = runtime.accounting().track_call();

    let _serial = session.sub_input.serialize_operations().await;
    ensure_still_active(app, &session)?;
    let transition = session.sub_input.apply_main_input(&request);
    if transition.closed {
        return Err(inactive_session());
    }
    if !transition.applied {
        return Ok(protocol::reply(&transition.snapshot, false));
    }

    ensure_still_active(app, &session)?;
    delivery::deliver_child_input(app, &session, &transition.snapshot)?;
    Ok(protocol::reply(&transition.snapshot, true))
}

pub(crate) async fn update_from_child(
    app: &AppHandle<Wry>,
    session: &SessionView,
    payload: &Value,
) -> Result<Value, BridgeError> {
    let _serial = session.sub_input.serialize_operations().await;
    ensure_still_active(app, session)?;
    if !lifecycle::session_can_serve(session) {
        return Err(inactive_session());
    }

    let request = protocol::parse_control(payload)?;
    let transition = session.sub_input.apply_control(&request);
    if transition.closed {
        return Err(inactive_session());
    }
    if !transition.applied {
        return Ok(protocol::reply(&transition.snapshot, false));
    }

    ensure_still_active(app, session)?;
    delivery::emit_main_state(app, session, &transition)?;

    match transition.action {
        protocol::InputAction::Set | protocol::InputAction::Value => {
            delivery::deliver_child_input(app, session, &transition.snapshot)?;
        }
        protocol::InputAction::Blur => delivery::focus_child(app, session)?,
        protocol::InputAction::Remove
        | protocol::InputAction::Focus
        | protocol::InputAction::Select => {}
    }

    Ok(protocol::reply(&transition.snapshot, true))
}

pub(crate) fn require_main_role_labels(
    webview_label: &str,
    parent_window_label: &str,
    command_window_label: &str,
) -> Result<(), BridgeError> {
    protocol::require_main_role_labels(webview_label, parent_window_label, command_window_label)
}
