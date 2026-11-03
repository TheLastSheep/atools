//! Narrow recording operations and delivery to the current General-settings Child.
use super::{
    phase::SessionPhase,
    session::SessionView,
    validation::{exact_object, invalid_payload, BridgeError},
};
use crate::hotkey::{
    recording::{self, Notice, Outcome, Target},
    recording_runtime,
};
use serde_json::{json, Value};
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
    let app = app.clone();
    let start = operation == "startHotkeyRecording";
    tauri::async_runtime::spawn_blocking(move || {
        if !target_current(&app, &target, start) {
            return Err(recording::STALE.to_owned());
        }
        let ack = if start {
            recording_runtime::start(&app, target, generation)
        } else {
            recording_runtime::stop(&app, &target.session_id, generation)
        }?;
        #[cfg(feature = "legacy-node-smoke")]
        crate::renderer_desktop_smoke::manual_ui::hotkey_witness::ack(&app, &ack);
        serde_json::to_value(ack).map_err(|_| recording::UNAVAILABLE.to_owned())
    })
    .await
    .map_err(|_| unavailable())?
    .map_err(|error| {
        if error == recording::STALE {
            BridgeError::new(
                "SETTINGS_HOTKEY_RECORDING_STALE",
                "Recording generation is no longer active",
            )
        } else {
            unavailable()
        }
    })
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
        "SETTINGS_HOTKEY_RECORDING_UNAVAILABLE",
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
            || (url.fragment() == Some("/generalSetting")
                && recording_runtime::visibility_allows(
                    target.visibility_epoch,
                    recording_runtime::visibility_epoch(app),
                    child.window().is_visible().unwrap_or(false),
                )))
}

pub(crate) fn deliver(app: &AppHandle, notice: Notice) {
    let handle = app.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        if !target_live(&handle, &notice.target) { return; }
        let Some(child) = handle.get_webview(&notice.target.label) else { return; };
        let mut value = json!({"version":1,"sessionId":notice.target.session_id,"generation":notice.generation});
        match notice.outcome {
            Outcome::Recorded => { value["status"] = json!("recorded"); value["shortcut"] = json!(if cfg!(target_os="macos") {"Option+Space"} else {"Alt+Space"}); }
            Outcome::Stopped(reason) => { value["status"] = json!("stopped"); value["reason"] = json!(reason); }
        }
        let script = format!("if(typeof window.__ATOOLS_SETTINGS_DELIVER_HOTKEY__==='function'){{window.__ATOOLS_SETTINGS_DELIVER_HOTKEY__({value});}}");
        let result = child.eval(script);
        #[cfg(feature = "legacy-node-smoke")]
        crate::renderer_desktop_smoke::manual_ui::hotkey_witness::notice_submitted(&handle, &notice, result.is_ok());
        if let Err(error) = result { tracing::warn!(%error, "Recording event could not be submitted to the Child"); }
    }) { tracing::warn!(%error, "Recording event delivery could not be scheduled"); }
}

#[cfg(test)]
#[path = "hotkey_recording_tests.rs"]
mod tests;
