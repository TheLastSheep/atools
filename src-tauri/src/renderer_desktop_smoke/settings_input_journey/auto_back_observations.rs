use super::super::{general_policies_probe as policy_probe, state::Harness};
use serde_json::{json, Value};
use std::time::Instant;
use tauri::{AppHandle, Wry};

pub(super) async fn sample(app: &AppHandle<Wry>, harness: &Harness) -> Value {
    let main = policy_probe::main_general_policies_auto_back_inspect(app, harness)
        .await
        .ok();
    let native = crate::renderer_settings_view::snapshot(app);
    let window = crate::window::main_window(app).ok();
    let session_count = native["sessionCount"].as_u64();
    let child_present = native["childPresent"].as_bool();
    let plugin_dom = main
        .as_ref()
        .and_then(|value| value["pluginDomPresent"].as_bool());
    let search_dom = main
        .as_ref()
        .and_then(|value| value["searchDomPresent"].as_bool());
    json!({
        "queryEmpty": main.as_ref().and_then(|value| value["queryEmpty"].as_bool()),
        "inputFound": main.as_ref().and_then(|value| value["inputFound"].as_bool()),
        "pluginDomPresent": plugin_dom,
        "searchDomPresent": search_dom,
        "settingsSessionCount": session_count,
        "settingsChildPresent": child_present,
        "layoutCount": crate::window::main_child_layout_active_count(app).ok(),
        "pendingCalls": native["pendingCalls"].as_u64(),
        "pendingWrites": native["pendingWrites"].as_u64(),
        "mainWindowHidden": window.as_ref().and_then(|value| value.is_visible().ok()).map(|visible| !visible),
        "mainWindowFocused": window.as_ref().and_then(|value| value.is_focused().ok()),
        "mainDocumentHidden": main.as_ref().and_then(|value| value["documentHidden"].as_bool()),
        "mainDocumentHasFocus": main.as_ref().and_then(|value| value["documentHasFocus"].as_bool()),
        "focusEvents": harness.focus_gained_events(),
    })
}

pub(super) fn empty_observations() -> Value {
    let sample = json!({
        "queryEmpty": null, "inputFound": null,
        "pluginDomPresent": null, "searchDomPresent": null,
        "settingsSessionCount": null, "settingsChildPresent": null,
        "layoutCount": null, "pendingCalls": null, "pendingWrites": null,
        "mainWindowHidden": null, "mainWindowFocused": null,
        "mainDocumentHidden": null, "mainDocumentHasFocus": null, "focusEvents": null,
    });
    json!({
        "focusEventsBefore": null,
        "baseline": {"sessionCountBefore": null, "childPresentBefore": null,
            "freshSessionIdObserved": null, "sessionFresh": null,
            "navigationDispatched": null, "navigationRouteGeneral": null,
            "themeControlFound": null,
            "routeGeneral": null, "controlUnique": null, "uiValue": null,
            "effectiveValue": null, "sqliteValue": null, "sqliteValueMissing": null,
            "browserDbValue": null},
        "save30s": {"value": null, "selectionDispatched": null, "optionSetValid": null,
            "routeGeneral": null, "controlUnique": null, "uiValue": null,
            "browserDbValue": null, "sqliteValue": null, "unrelatedSettingsUnchanged": null,
            "elapsedMs": null, "queryableSettings": null},
        "delayed": {"beforeHide": sample, "after150ms": sample, "elapsedMs": null,
            "afterReturn": sample},
        "freshReopen": {"sessionChanged": null, "navigationDispatched": null,
            "navigationRouteGeneral": null, "themeControlFound": null,
            "routeGeneral": null, "controlUnique": null, "uiValue": null,
            "browserDbValue": null, "sqliteValue": null, "unrelatedSettingsUnchanged": null},
        "saveImmediately": {"value": null, "selectionDispatched": null, "optionSetValid": null,
            "routeGeneral": null, "controlUnique": null, "uiValue": null,
            "browserDbValue": null, "sqliteValue": null, "unrelatedSettingsUnchanged": null,
            "elapsedMs": null, "queryableSettings": null},
        "immediate": {"beforeHide": sample, "elapsedMs": null, "afterReturn": sample},
        "globalSearch": {"beforeHide": sample, "elapsedMs": null, "afterReturn": sample},
        "restored": {"uiValue": null, "browserDbValue": null, "sqliteValue": null,
            "optionSetValid": null, "sqliteValueMissing": null, "baselineValue": null,
            "baselineRestored": null, "unrelatedSettingsUnchanged": null},
        "final": {"childClosed": null, "settingsSessionCount": null, "settingsChildPresent": null,
            "queryEmpty": null, "pluginDomPresent": null, "searchDomPresent": null,
            "mainWindowHidden": null, "mainWindowFocused": null, "focusEvents": null},
    })
}

pub(super) fn session_is_active(sample: &Value) -> bool {
    sample["settingsSessionCount"].as_u64() == Some(1)
        && sample["settingsChildPresent"].as_bool() == Some(true)
}

pub(super) fn session_is_closed(sample: &Value) -> bool {
    sample["settingsSessionCount"].as_u64() == Some(0)
        && sample["settingsChildPresent"].as_bool() == Some(false)
        && sample["layoutCount"].as_u64() == Some(0)
        && sample["pendingCalls"].as_u64() == Some(0)
        && sample["pendingWrites"].as_u64() == Some(0)
}

pub(super) fn window_is_hidden_unfocused(sample: &Value, focus_events_before: u64) -> bool {
    sample["mainWindowHidden"].as_bool() == Some(true)
        && sample["mainWindowFocused"].as_bool() == Some(false)
        && sample["mainDocumentHidden"].as_bool() == Some(true)
        && sample["mainDocumentHasFocus"].as_bool() == Some(false)
        && sample["focusEvents"].as_u64() == Some(focus_events_before)
}

pub(super) fn returned_to_search(sample: &Value, focus_events_before: u64) -> bool {
    session_is_closed(sample)
        && sample["queryEmpty"].as_bool() == Some(true)
        && sample["pluginDomPresent"].as_bool() == Some(false)
        && sample["searchDomPresent"].as_bool() == Some(true)
        && window_is_hidden_unfocused(sample, focus_events_before)
}

pub(super) fn session_closed(app: &AppHandle<Wry>) -> bool {
    let snapshot = crate::renderer_settings_view::snapshot(app);
    snapshot["stateAvailable"].as_bool() == Some(true)
        && snapshot["runtimeInitialized"].as_bool() == Some(true)
        && snapshot["sessionCount"].as_u64() == Some(0)
        && snapshot["childPresent"].as_bool() == Some(false)
        && crate::window::main_child_layout_active_count(app).ok() == Some(0)
        && snapshot["pendingCalls"].as_u64() == Some(0)
        && snapshot["pendingWrites"].as_u64() == Some(0)
}

pub(super) fn elapsed_ms(started: Instant) -> u64 {
    started.elapsed().as_millis().min(u64::MAX as u128) as u64
}

pub(super) fn push_error(errors: &mut Vec<&'static str>, error: &'static str) {
    if !errors.contains(&error) {
        errors.push(error);
    }
}
