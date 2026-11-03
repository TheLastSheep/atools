use super::{
    cleanup_safe, empty_observations, observations_passed, valid_operation, validate_probe_evidence,
};
use serde_json::{json, Value};

fn successful_observations() -> Value {
    let mut value = empty_observations();
    for key in ["ownerVerified", "attempted", "proofInstalled"] {
        value["install"][key] = json!(true);
    }
    for key in ["routeGeneral", "controlUnique"] {
        value["baseline"][key] = json!(true);
    }
    value["baseline"]["uiEnabled"] = json!(false);
    value["baseline"]["getterEnabled"] = json!(false);
    value["baseline"]["nativeEnabled"] = json!(false);
    for key in [
        "routeGeneral",
        "controlUnique",
        "clickDispatched",
        "uiEnabled",
        "getterEnabled",
        "nativeEnabled",
    ] {
        value["enable"][key] = json!(true);
    }
    for key in [
        "newSession",
        "routeGeneral",
        "controlUnique",
        "uiEnabled",
        "getterEnabled",
        "nativeEnabled",
    ] {
        value["freshEnabled"][key] = json!(true);
    }
    value["externalDisable"] = json!({"attempted":true,"confirmed":true,"nativeEnabled":false});
    value["conflict"] = json!({"routeGeneral":true,"controlUnique":true,"clickDispatched":true,
        "uiEnabled":true,"getterEnabled":null,"rollbackObserved":true,"errorCode":"conflict","nativeEnabled":false});
    value["freshDisabled"] = json!({"newSession":true,"routeGeneral":true,"controlUnique":true,
        "uiEnabled":false,"getterEnabled":false,"nativeEnabled":false});
    value["childClosed"] = json!(true);
    value["pluginUiOpened"] = json!(false);
    value["preloadStarted"] = json!(false);
    value["cleanup"] = json!({"attempted":true,"unregistered":true,"osEnabled":false,
        "nativeCallsTerminal":true});
    value
}

#[test]
fn only_current_child_operations_are_whitelisted() {
    assert!(valid_operation(
        "childLaunchAtLoginInspect",
        "ztools-settings-42"
    ));
    assert!(valid_operation(
        "childLaunchAtLoginClick",
        "ztools-settings-42"
    ));
    assert!(!valid_operation("childLaunchAtLoginClick", "main"));
    assert!(!valid_operation("childLaunchAtLoginInspect", "other-child"));
    assert!(!valid_operation(
        "launchAtLoginInspect",
        "ztools-settings-42"
    ));
}

#[test]
fn probe_evidence_has_exact_booleans_and_fixed_error_enums() {
    assert_eq!(
        validate_probe_evidence(
            "childLaunchAtLoginInspect",
            &json!({
                "routeGeneral":true,"controlUnique":true,"uiEnabled":false,"getterEnabled":false,
            })
        ),
        Some(Ok(()))
    );
    assert_eq!(
        validate_probe_evidence(
            "childLaunchAtLoginClick",
            &json!({
                "routeGeneral":true,"controlUnique":true,"clickDispatched":true,"uiEnabled":true,
                "getterEnabled":null,"errorCode":"conflict",
            })
        ),
        Some(Ok(()))
    );
    assert!(validate_probe_evidence(
        "childLaunchAtLoginClick",
        &json!({
            "routeGeneral":true,"controlUnique":true,"clickDispatched":true,"uiEnabled":true,
            "getterEnabled":null,"errorCode":"raw error",
        })
    )
    .is_some_and(|result| result.is_err()));
    assert!(validate_probe_evidence("childLaunchAtLoginInspect", &json!({
        "routeGeneral":true,"controlUnique":true,"uiEnabled":false,"getterEnabled":false,"extra":0,
    })).is_some_and(|result| result.is_err()));
}

#[test]
fn pass_requires_ui_native_fresh_session_and_conflict_facts() {
    let mut observations = successful_observations();
    assert!(observations_passed(&observations));
    for getter in [Value::Bool(true), Value::Bool(false)] {
        observations["conflict"]["getterEnabled"] = getter;
        assert!(!observations_passed(&observations));
    }
    observations["conflict"]["getterEnabled"] = Value::Null;
    observations["conflict"]["errorCode"] = json!(null);
    assert!(!observations_passed(&observations));
}

#[test]
fn safe_cleanup_requires_owned_proof_and_confirmed_not_registered_status() {
    let mut observations = successful_observations();
    assert!(cleanup_safe(&observations));
    observations["cleanup"]["unregistered"] = Value::Null;
    assert!(!cleanup_safe(&observations));
    observations["cleanup"]["unregistered"] = Value::Bool(true);
    observations["cleanup"]["nativeCallsTerminal"] = Value::Bool(false);
    assert!(!cleanup_safe(&observations));
}
