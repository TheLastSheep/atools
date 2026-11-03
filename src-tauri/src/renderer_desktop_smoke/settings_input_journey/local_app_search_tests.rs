use super::{
    app_target_count_valid, child_inspect_valid, child_toggle_valid, main_search_valid,
    timestamp_control_valid,
};
use serde_json::json;

fn hidden_child(enabled: bool) -> serde_json::Value {
    json!({
        "routeGeneral": true,
        "controlUnique": true,
        "checked": enabled,
        "settingsObject": true,
        "settingsHasBoolean": true,
        "settingsEnabled": enabled,
        "documentHidden": true,
        "documentHasFocus": false,
    })
}

fn main_search(app_count: u64) -> serde_json::Value {
    json!({
        "storeUnique": true,
        "storeReady": true,
        "searchCallable": true,
        "appTargetCount": app_count,
        "timestampMatchCount": 1,
        "timestampIdentityValid": true,
        "timestampPath": "/private/tmp/plugins/timestamp",
        "inputFound": true,
        "inputEmpty": true,
        "documentHidden": true,
        "documentHasFocus": false,
    })
}

#[test]
fn original_general_checkbox_requires_route_and_sqlite_readback() {
    assert!(child_inspect_valid(&hidden_child(true), true));
    assert!(child_inspect_valid(&hidden_child(false), false));

    for field in [
        "routeGeneral",
        "controlUnique",
        "settingsObject",
        "settingsHasBoolean",
    ] {
        let mut invalid = hidden_child(true);
        invalid[field] = json!(false);
        assert!(!child_inspect_valid(&invalid, true), "{field}");
    }
    let mut invalid = hidden_child(true);
    invalid["documentHasFocus"] = json!(true);
    assert!(!child_inspect_valid(&invalid, true));
}

#[test]
fn checkbox_toggle_requires_a_real_directional_click_and_readback() {
    let disabled = json!({
        "routeGeneral": true,
        "controlUnique": true,
        "beforeChecked": true,
        "clickDispatched": true,
        "afterChecked": false,
        "settingsObject": true,
        "settingsHasBoolean": true,
        "settingsEnabled": false,
        "documentHidden": true,
        "documentHasFocus": false,
    });
    assert!(child_toggle_valid(&disabled, true, false));
    assert!(!child_toggle_valid(&disabled, false, true));
    for field in ["clickDispatched", "settingsHasBoolean", "documentHidden"] {
        let mut invalid = disabled.clone();
        invalid[field] = json!(false);
        assert!(!child_toggle_valid(&invalid, true, false), "{field}");
    }
}

#[test]
fn main_filter_requires_exact_target_count_and_stable_real_plugin_control() {
    let excluded = main_search(0);
    let restored = main_search(1);
    assert!(main_search_valid(&excluded));
    assert!(app_target_count_valid(&excluded, 0));
    assert!(app_target_count_valid(&restored, 1));
    assert!(!app_target_count_valid(&restored, 0));

    assert!(timestamp_control_valid(&excluded, None));
    assert!(timestamp_control_valid(
        &excluded,
        Some("/private/tmp/plugins/timestamp"),
    ));
    assert!(!timestamp_control_valid(
        &excluded,
        Some("/other/timestamp")
    ));

    let mut general_without_input = restored.clone();
    general_without_input["inputFound"] = json!(false);
    general_without_input["inputEmpty"] = json!(false);
    assert!(main_search_valid(&general_without_input));
    assert!(app_target_count_valid(&general_without_input, 1));
    assert!(timestamp_control_valid(&general_without_input, None));

    let mut unknown_store = restored.clone();
    unknown_store["storeReady"] = json!(false);
    assert!(!main_search_valid(&unknown_store));
    let mut wrong_store = restored.clone();
    wrong_store["storeUnique"] = json!(false);
    assert!(!main_search_valid(&wrong_store));
    let mut unavailable_search = restored.clone();
    unavailable_search["searchCallable"] = json!(false);
    assert!(!main_search_valid(&unavailable_search));
    let mut missing = excluded.clone();
    missing["timestampMatchCount"] = json!(0);
    assert!(!timestamp_control_valid(&missing, None));
    let mut unknown_app_count = restored.clone();
    unknown_app_count["appTargetCount"] = json!(null);
    assert!(!app_target_count_valid(&unknown_app_count, 1));
    let mut unknown_timestamp_count = restored.clone();
    unknown_timestamp_count["timestampMatchCount"] = json!(null);
    assert!(!timestamp_control_valid(&unknown_timestamp_count, None));
    let mut focused = excluded;
    focused["documentHasFocus"] = json!(true);
    assert!(!main_search_valid(&focused));
}
