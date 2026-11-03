use serde_json::Value;
use tauri::{AppHandle, Emitter, EventTarget, Manager, Wry};

use super::{
    protocol::{child_delivery, main_event},
    state::Transition,
};
use crate::renderer_settings_view::{
    lifecycle,
    presentation::{self, FocusPhase},
    session::SessionView,
    validation::{inactive_session, BridgeError},
};

pub(crate) fn emit_main_state(
    app: &AppHandle<Wry>,
    session: &SessionView,
    transition: &Transition,
) -> Result<(), BridgeError> {
    require_active(session)?;
    let main = crate::window::main_webview(app).map_err(|_| inactive_session())?;

    if transition.focus
        && transition.snapshot.visible
        && presentation::allow_focus(app, FocusPhase::ValueEcho)
    {
        main.set_focus().map_err(|_| {
            BridgeError::new(
                "SETTINGS_SUBINPUT_FOCUS_FAILED",
                "Main SubInput could not receive focus",
            )
        })?;
    }

    require_active(session)?;
    app.emit_to(
        EventTarget::webview("main"),
        super::super::SETTINGS_EVENT,
        main_event(session, transition),
    )
    .map_err(|_| {
        BridgeError::new(
            "SETTINGS_SUBINPUT_DELIVERY_FAILED",
            "Main renderer did not accept the settings input update",
        )
    })
}

pub(crate) fn deliver_child_input(
    app: &AppHandle<Wry>,
    session: &SessionView,
    snapshot: &super::state::SubInputSnapshot,
) -> Result<(), BridgeError> {
    require_active(session)?;
    let child = app
        .get_webview(&session.label)
        .filter(|child| child.window().label() == "main")
        .ok_or_else(inactive_session)?;
    let payload = child_delivery(session, snapshot);
    let script = child_delivery_script(&payload)?;
    // Tauri success means this script was queued. The child hook performs delivery later.
    child.eval(&script).map_err(|_| {
        BridgeError::new(
            "SETTINGS_SUBINPUT_DELIVERY_FAILED",
            "Settings input could not be queued for the active settings view",
        )
    })
}

pub(crate) fn focus_child(app: &AppHandle<Wry>, session: &SessionView) -> Result<(), BridgeError> {
    require_active(session)?;
    if !presentation::allow_focus(app, FocusPhase::ChildDelivery) {
        return Ok(());
    }
    app.get_webview(&session.label)
        .filter(|child| child.window().label() == "main")
        .ok_or_else(inactive_session)?
        .set_focus()
        .map_err(|_| {
            BridgeError::new(
                "SETTINGS_SUBINPUT_FOCUS_FAILED",
                "Settings view could not receive focus",
            )
        })
}

pub(crate) fn child_delivery_script(payload: &Value) -> Result<String, BridgeError> {
    let serialized = serde_json::to_string(payload)
        .map_err(|_| BridgeError::new("SETTINGS_INVALID_ARGUMENT", "Settings input is invalid"))?;
    let serialized = serialized
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
        .replace('&', "\\u0026")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029");
    Ok(format!(
        "(function(){{var deliver=window.__ATOOLS_SETTINGS_DELIVER_INPUT__;if(typeof deliver==='function')deliver({serialized});}})();"
    ))
}

fn require_active(session: &SessionView) -> Result<(), BridgeError> {
    if lifecycle::session_can_serve(session) {
        Ok(())
    } else {
        Err(inactive_session())
    }
}

#[cfg(test)]
#[path = "delivery_tests.rs"]
mod tests;
