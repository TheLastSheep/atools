use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::{Map, Value};
use tauri::{AppHandle, Webview, Window, Wry};

use super::{
    identity::{is_expected_settings_url, is_valid_session_id},
    lifecycle,
    phase::SessionPhase,
    session::SessionView,
};

const MAX_CALL_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BridgeError {
    code: &'static str,
    message: &'static str,
}

impl BridgeError {
    pub(crate) const fn new(code: &'static str, message: &'static str) -> Self {
        Self { code, message }
    }
}

pub(crate) fn authorize_child_session(
    app: &AppHandle<Wry>,
    webview: &Webview<Wry>,
    window: &Window<Wry>,
    session_id: &str,
    allow_closing: bool,
) -> Result<SessionView, BridgeError> {
    if !is_valid_session_id(session_id)
        || webview.window().label() != "main"
        || window.label() != "main"
        || webview.label() != format!("ztools-settings-{session_id}")
    {
        return Err(BridgeError::new(
            "SETTINGS_CALLER_REJECTED",
            "Settings view caller is not the active child",
        ));
    }
    let actual = webview.url().map_err(|_| inactive_session())?;
    if !is_expected_settings_url(&actual, session_id) {
        return Err(inactive_session());
    }
    let runtime = super::runtime(app).map_err(|_| inactive_session())?;
    let session = runtime
        .current_for_id(session_id)
        .map_err(|_| inactive_session())?;
    if session.label != webview.label()
        || session.bundle.revision() != session.bundle_revision
        || (!allow_closing && !lifecycle::session_can_serve(&session))
    {
        return Err(inactive_session());
    }
    if allow_closing {
        if session.signal().phase != SessionPhase::Closing {
            return Err(BridgeError::new(
                "SETTINGS_ACK_REJECTED",
                "Settings view acknowledgement was rejected",
            ));
        }
    } else if session.signal().phase == SessionPhase::Closing {
        return Err(inactive_session());
    }
    Ok(session)
}

pub(crate) fn ensure_still_active(
    app: &AppHandle<Wry>,
    session: &SessionView,
) -> Result<(), BridgeError> {
    if session.is_revoked() {
        return Err(inactive_session());
    }
    let runtime = super::runtime(app).map_err(|_| inactive_session())?;
    let current = runtime
        .current_for_id(&session.id)
        .map_err(|_| inactive_session())?;
    if current.label != session.label
        || current.bundle_revision != session.bundle_revision
        || current.signal().phase == SessionPhase::Closing
        || current.is_revoked()
    {
        return Err(inactive_session());
    }
    Ok(())
}

pub(crate) fn validate_main_context(
    app: &AppHandle<Wry>,
    webview: &Webview<Wry>,
    window: &Window<Wry>,
) -> Result<(), BridgeError> {
    if webview.label() != "main" || webview.window().label() != "main" || window.label() != "main" {
        return Err(BridgeError::new(
            "SETTINGS_CALLER_REJECTED",
            "Settings command is available only to the main renderer",
        ));
    }
    let main = crate::window::main_webview(app).map_err(|_| inactive_session())?;
    if main.label() != webview.label()
        || !is_local_root_url(
            &webview.url().map_err(|_| inactive_session())?,
            app.config().build.dev_url.as_ref(),
        )
    {
        return Err(BridgeError::new(
            "SETTINGS_CALLER_REJECTED",
            "Settings command is available only to the main renderer root page",
        ));
    }
    Ok(())
}

fn is_local_root_url(url: &tauri::Url, configured_dev_url: Option<&tauri::Url>) -> bool {
    let local_dev_host = |host| matches!(host, Some("localhost" | "127.0.0.1" | "[::1]"));
    let configured_dev_origin = configured_dev_url.is_some_and(|dev_url| {
        local_dev_host(dev_url.host_str())
            && local_dev_host(url.host_str())
            && dev_url.scheme() == url.scheme()
            && dev_url.port_or_known_default() == url.port_or_known_default()
    });
    let local_origin = match url.scheme() {
        "tauri" => url.host_str() == Some("localhost") && url.port().is_none(),
        "http" | "https" => {
            (url.host_str() == Some("tauri.localhost") && url.port().is_none())
                || configured_dev_origin
        }
        _ => false,
    };
    local_origin
        && url.username().is_empty()
        && url.password().is_none()
        && url.path() == "/"
        && url.query().is_none()
        && url.fragment().is_none()
}

pub(crate) fn check_payload_budget(payload: &Value) -> Result<(), BridgeError> {
    let bytes = serde_json::to_vec(payload).map_err(|_| invalid_payload())?;
    if bytes.len() > MAX_CALL_BYTES {
        return Err(BridgeError::new(
            "SETTINGS_CALL_TOO_LARGE",
            "Settings request exceeds the 64 KiB limit",
        ));
    }
    Ok(())
}

pub(crate) fn exact_object<'a>(
    payload: &'a Value,
    allowed: &[&str],
) -> Result<&'a Map<String, Value>, BridgeError> {
    let object = payload.as_object().ok_or_else(invalid_payload)?;
    if object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(invalid_payload());
    }
    Ok(object)
}

pub(crate) fn string_field<'a>(
    object: &'a Map<String, Value>,
    field: &str,
) -> Result<&'a str, BridgeError> {
    object
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty() && value.len() <= 512)
        .ok_or_else(invalid_payload)
}

pub(crate) fn changes_field(value: Option<&Value>) -> Result<BTreeMap<String, Value>, BridgeError> {
    let object = value
        .and_then(Value::as_object)
        .ok_or_else(invalid_payload)?;
    let changes: BTreeMap<String, Value> = object
        .iter()
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    atools_core::db::validate_renderer_general_settings_patch(&changes)
        .map_err(|_| invalid_payload())?;
    Ok(changes)
}

pub(crate) fn require_empty_payload(payload: &Value) -> Result<(), BridgeError> {
    let object = exact_object(payload, &[])?;
    if object.is_empty() {
        Ok(())
    } else {
        Err(invalid_payload())
    }
}

pub(crate) fn close_reason(payload: &Value) -> Result<&'static str, BridgeError> {
    let object = exact_object(payload, &["reason"])?;
    match string_field(object, "reason")? {
        "child-out" => Ok("child-out"),
        "escape" => Ok("escape"),
        _ => Err(BridgeError::new(
            "SETTINGS_CLOSE_REJECTED",
            "Settings view close request is invalid",
        )),
    }
}

pub(crate) fn map_preferences_error(error: String) -> BridgeError {
    if error == "SETTINGS_REVISION_CONFLICT" {
        revision_conflict()
    } else if error == "SETTINGS_OPACITY_RECOVERY_FAILED" {
        BridgeError::new(
            "SETTINGS_OPACITY_RECOVERY_FAILED",
            "Window opacity recovery failed; check the window state before continuing",
        )
    } else if error == "SETTINGS_NATIVE_RECOVERY_FAILED" {
        BridgeError::new(
            "SETTINGS_NATIVE_RECOVERY_FAILED",
            "Native settings recovery failed; reopen settings before continuing",
        )
    } else if error == "SETTINGS_HOTKEY_LISTEN_PERMISSION_REQUIRED" {
        BridgeError::new(
            "SETTINGS_HOTKEY_LISTEN_PERMISSION_REQUIRED",
            "Input monitoring permission is required for double-modifier shortcuts",
        )
    } else if error == "SETTINGS_HOTKEY_DOUBLE_TAP_UNSUPPORTED" {
        BridgeError::new(
            "SETTINGS_HOTKEY_DOUBLE_TAP_UNSUPPORTED",
            "Double-modifier shortcuts are not supported on this platform",
        )
    } else if error == "SETTINGS_CLOSE_SHORTCUT_UNSUPPORTED" {
        BridgeError::new(
            "SETTINGS_CLOSE_SHORTCUT_UNSUPPORTED",
            "Close shortcut settings are unsupported on this platform",
        )
    } else if error == "SETTINGS_CLOSE_SHORTCUT_REJECTED" {
        BridgeError::new(
            "SETTINGS_CLOSE_SHORTCUT_REJECTED",
            "Close shortcut settings could not be applied",
        )
    } else if error == "SETTINGS_HOTKEY_REJECTED" {
        BridgeError::new(
            "SETTINGS_HOTKEY_REJECTED",
            "Primary shortcut could not be registered; check for conflicts and try again",
        )
    } else {
        BridgeError::new(
            "SETTINGS_PATCH_FAILED",
            "General settings could not be saved",
        )
    }
}

pub(crate) fn revision_conflict() -> BridgeError {
    BridgeError::new(
        "SETTINGS_REVISION_CONFLICT",
        "General settings changed; reload before applying the patch",
    )
}

pub(crate) fn invalid_payload() -> BridgeError {
    BridgeError::new(
        "SETTINGS_INVALID_ARGUMENT",
        "Settings view request has an invalid shape",
    )
}

#[cfg(test)]
#[path = "validation_tests.rs"]
mod tests;

pub(crate) fn inactive_session() -> BridgeError {
    BridgeError::new(
        "SETTINGS_SESSION_INACTIVE",
        "Settings view session is no longer active",
    )
}
