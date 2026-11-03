use super::protocol::Harness;
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, Manager, Wry};
use tokio::sync::oneshot;

pub(super) async fn observe(
    app: &AppHandle<Wry>,
    harness: &Harness,
    stage: &str,
) -> Result<Value, &'static str> {
    harness
        .profile()
        .validate_settings_child_fixture()
        .map_err(|_| "settings-registration-focus-owner-invalid")?;
    if app.config().identifier != harness.profile().expected_identifier() {
        return Err("settings-registration-focus-owner-invalid");
    }
    let app = app.clone();
    let app_for_thread = app.clone();
    let stage = stage.to_owned();
    let witness = std::sync::Arc::clone(&harness.witness);
    let (sender, receiver) = oneshot::channel();
    app.run_on_main_thread(move || {
        let value = inspect(&app_for_thread, &stage, witness.focus_gained());
        let _ = sender.send(value);
    })
    .map_err(|_| "settings-registration-focus-observation-unavailable")?;
    tokio::time::timeout(Duration::from_secs(2), receiver)
        .await
        .map_err(|_| "settings-registration-focus-observation-unavailable")?
        .map_err(|_| "settings-registration-focus-observation-unavailable")
}

#[cfg(target_os = "macos")]
fn inspect(app: &AppHandle<Wry>, stage: &str, focus_events: usize) -> Value {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSWindow};
    let marker = MainThreadMarker::new();
    let window = crate::window::main_window(app)
        .ok()
        .filter(|window| window.label() == "main");
    let key = window
        .as_ref()
        .and_then(|window| window.ns_window().ok())
        .and_then(|ptr| {
            (!ptr.is_null()).then(|| unsafe { (&*ptr.cast::<NSWindow>()).isKeyWindow() })
        });
    json!({"stage":stage, "visible":window.as_ref().and_then(|window| window.is_visible().ok()),
        "focused":window.as_ref().and_then(|window| window.is_focused().ok()),
        "applicationActive":marker.map(|marker| NSApplication::sharedApplication(marker).isActive()),
        "mainKey":key, "focusGainedEvents":focus_events})
}

#[cfg(not(target_os = "macos"))]
fn inspect(_app: &AppHandle<Wry>, stage: &str, focus_events: usize) -> Value {
    json!({"stage":stage,"visible":null,"focused":null,"applicationActive":null,"mainKey":null,"focusGainedEvents":focus_events})
}

pub(super) fn hidden(value: &Value) -> bool {
    ["visible", "focused", "applicationActive", "mainKey"]
        .iter()
        .all(|key| value[*key] == false)
        && value["focusGainedEvents"] == 0
}
