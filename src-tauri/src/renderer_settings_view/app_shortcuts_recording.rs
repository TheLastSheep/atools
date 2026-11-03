//! Independent Shortcuts scope. General authorization is deliberately unchanged.
use super::{
    phase::SessionPhase,
    session::SessionView,
    validation::{exact_object, invalid_payload, BridgeError},
};
use crate::hotkey::{
    recording::{self, Target},
    recording_runtime,
};
use serde_json::Value;
use tauri::{AppHandle, Manager};

pub(super) async fn handle(
    app: &AppHandle,
    session: &SessionView,
    operation: &str,
    payload: &Value,
) -> Result<Value, BridgeError> {
    let generation = generation(payload)?;
    let mut target = target(session);
    target.visibility_epoch = recording_runtime::visibility_epoch(app);
    let start = operation == "startAppShortcutRecording";
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if !target_current(&app, &target, start) {
            return Err(crate::app_global_shortcuts::recording_gate::STALE.into());
        }
        let ack = if start {
            crate::app_global_shortcuts::recording::start(&app, target, generation)
        } else {
            crate::app_global_shortcuts::recording::stop(&app, &target.session_id, generation)
        }?;
        serde_json::to_value(ack)
            .map_err(|_| crate::app_global_shortcuts::recording_gate::UNAVAILABLE.to_string())
    })
    .await
    .map_err(|_| unavailable())?
    .map_err(|code: String| {
        let code = match code.as_str() {
            "SETTINGS_APP_SHORTCUT_RECORDING_BUSY" => "SETTINGS_APP_SHORTCUT_RECORDING_BUSY",
            "SETTINGS_APP_SHORTCUT_RECORDING_STALE" => "SETTINGS_APP_SHORTCUT_RECORDING_STALE",
            _ => "SETTINGS_APP_SHORTCUT_RECORDING_UNAVAILABLE",
        };
        BridgeError::new(
            code,
            "Shortcut recording could not begin or finish; release held keys before retrying",
        )
    })
}
pub(super) fn release_before_quota(operation: &str) -> bool {
    operation == "stopAppShortcutRecording"
}
pub(super) fn check_payload(payload: &Value) -> Result<(), BridgeError> {
    generation(payload).map(|_| ())
}
fn generation(payload: &Value) -> Result<u64, BridgeError> {
    let object = exact_object(payload, &["generation"])?;
    let generation = object
        .get("generation")
        .and_then(Value::as_u64)
        .ok_or_else(invalid_payload)?;
    recording::valid_generation(generation).map_err(|_| invalid_payload())?;
    Ok(generation)
}

fn unavailable() -> BridgeError {
    BridgeError::new(
        "SETTINGS_APP_SHORTCUT_RECORDING_UNAVAILABLE",
        "Shortcut recording could not acquire or release its owned key",
    )
}
fn target(session: &SessionView) -> Target {
    Target {
        session_id: session.id.clone(),
        label: session.label.clone(),
        origin: session.origin.clone(),
        bundle_revision: session.bundle_revision.clone(),
        visibility_epoch: 0,
    }
}

pub(crate) fn target_live(app: &AppHandle, target: &Target) -> bool {
    target_current(app, target, true)
}
fn target_current(app: &AppHandle, target: &Target, general_only: bool) -> bool {
    let Ok(runtime) = super::runtime(app) else {
        return false;
    };
    let Ok(session) = runtime.current_for_id(&target.session_id) else {
        return false;
    };
    let Some(child) = app.get_webview(&target.label) else {
        return false;
    };
    let Ok(url) = child.url() else {
        return false;
    };
    let signal = session.signal();
    target.session_id == session.id
        && target.label == session.label
        && target.origin == session.origin
        && target.bundle_revision == session.bundle_revision
        && session.bundle.revision() == target.bundle_revision
        && child.label() == target.label
        && child.window().label() == "main"
        && !session.is_revoked()
        && signal.phase == SessionPhase::Open
        && signal.ready
        && super::identity::is_expected_origin(&target.origin, &target.session_id)
        && super::identity::is_expected_settings_url(&url, &target.session_id)
        && (!general_only
            || (crate::window::main_child_is_visible(app, &target.label)
                && super::intent_protocol::is_shortcuts_route(&url, &target.session_id)
                && recording_runtime::visibility_allows(
                    target.visibility_epoch,
                    recording_runtime::visibility_epoch(app),
                    child.window().is_visible().unwrap_or(false),
                )))
}

pub(crate) fn deliver(
    app: &AppHandle,
    notice: crate::app_global_shortcuts::recording_gate::Notice,
) {
    let app_handle = app.clone();
    let _=app.run_on_main_thread(move || {
        if !crate::app_global_shortcuts::recording::gate(&app_handle).is_ok_and(|g|g.notice_current(&notice)) { return; }
        let recorded=notice.value["status"]=="recorded";
        if !target_current(&app_handle,&notice.target,recorded) { return; }
        let Some(child)=app_handle.get_webview(&notice.target.label) else {return};
        let value=notice.value;
        let script=format!("if(typeof window.__ATOOLS_SETTINGS_DELIVER_APP_SHORTCUT_RECORDING__==='function'){{window.__ATOOLS_SETTINGS_DELIVER_APP_SHORTCUT_RECORDING__({value});}}");
        if let Err(error)=child.eval(script) { tracing::warn!(%error,"App recording notice submission failed"); }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn only_fixed_release_operation_has_prequota_admission() {
        assert!(release_before_quota("stopAppShortcutRecording"));
        for operation in [
            "startAppShortcutRecording",
            "stopHotkeyRecording",
            "mutateAppGlobalShortcut",
            "stopAppShortcutRecording ",
            "",
        ] {
            assert!(!release_before_quota(operation));
        }
    }
    #[test]
    fn private_rpc_only_accepts_exact_positive_safe_generation() {
        assert_eq!(generation(&json!({"generation":1})).unwrap(), 1);
        for packet in [
            json!({}),
            json!({"generation":0}),
            json!({"generation":-1}),
            json!({"generation":1.5}),
            json!({"generation":9007199254740992u64}),
            json!({"generation":1,"scope":"general"}),
            json!({"generation":1,"label":"main"}),
            json!({"generation":{"large":"x".repeat(1048576)}}),
        ] {
            assert!(check_payload(&packet).is_err());
        }
    }
}
