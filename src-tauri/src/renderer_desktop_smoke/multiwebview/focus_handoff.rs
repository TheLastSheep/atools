use super::{focus_observation::FocusObservation, main_probe, state::Harness};
use serde::Serialize;
use serde_json::json;
use std::time::Duration;
use tauri::{AppHandle, Manager, Wry};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeFocusState {
    visible: Option<bool>,
    focused: Option<bool>,
}

pub(super) async fn verify(
    app: &AppHandle<Wry>,
    harness: &Harness,
    child: &tauri::Webview<Wry>,
    nonce: &str,
    resource_path: &str,
) -> Result<(), &'static str> {
    let child_window_before = native_focus_state(app);
    let child_focus_issued = child.set_focus().is_ok();
    let child_receiver = harness.begin_child(nonce.to_string(), 1, "focus")?;
    tokio::time::sleep(Duration::from_millis(80)).await;
    let child_document = if child
        .eval("window.__ATOOLS_MULTIWEBVIEW_REPORT_FOCUS__ && window.__ATOOLS_MULTIWEBVIEW_REPORT_FOCUS__()")
        .is_ok()
    {
        super::await_child_report(harness, child_receiver, 1)
            .await
            .ok()
            .and_then(|report| report.get("document").cloned())
            .and_then(|value| FocusObservation::from_normalized_report(&value))
    } else {
        harness.cancel_child(1);
        None
    };
    let child_window_after = native_focus_state(app);

    let main_window_before = native_focus_state(app);
    let main_webview = crate::window::main_webview(app).ok();
    let main_focus_issued = main_webview.is_some_and(|webview| webview.set_focus().is_ok());
    tokio::time::sleep(Duration::from_millis(80)).await;
    let main_document = main_probe::observe_main_dom_focus(app, harness, resource_path)
        .await
        .ok();
    let main_window_after = native_focus_state(app);

    let child_dom_focused = child_document.as_ref().is_some_and(|value| value.has_focus);
    let main_dom_focused = main_document.as_ref().is_some_and(|value| value.has_focus);
    let child_webview_focused = child_focus_issued && child_dom_focused;
    let main_webview_focused = main_focus_issued && main_dom_focused;
    let window_visible = main_window_after.visible == Some(true);
    let window_focused = main_window_after.focused == Some(true);

    harness.record(
        &["child", "focusJourney"],
        json!({
            "childWebviewFocused": child_webview_focused,
            "mainWebviewFocused": main_webview_focused,
            "windowVisible": window_visible,
            "windowFocused": window_focused,
            "diagnostics": {
                "childFocusApiIssued": child_focus_issued,
                "childWindowBeforeFocus": child_window_before,
                "childWindowAfterFocus": child_window_after,
                "childDocument": child_document,
                "mainFocusApiIssued": main_focus_issued,
                "mainWindowBeforeFocus": main_window_before,
                "mainWindowAfterFocus": main_window_after,
                "mainDocument": main_document,
                "focusEvents": "not-observed"
            }
        }),
    );

    if child_webview_focused && main_webview_focused && window_visible && window_focused {
        Ok(())
    } else {
        Err("multiwebview-child-to-main-focus-handoff-failed")
    }
}

fn native_focus_state(app: &AppHandle<Wry>) -> NativeFocusState {
    let Ok(window) = crate::window::main_window(app) else {
        return NativeFocusState {
            visible: None,
            focused: None,
        };
    };
    NativeFocusState {
        visible: window.is_visible().ok(),
        focused: window.is_focused().ok(),
    }
}
