use super::passes;
use serde_json::{json, Value};

fn presentation() -> Value {
    json!({
        "visible": true,
        "windowFocused": false,
        "windowKey": false,
        "appActive": false,
        "frontmostIsSelf": false,
    })
}

fn trace() -> Value {
    json!({
        "schemaVersion": 1,
        "baseline": {
            "visible": false,
            "occlusionVisible": false,
            "onActiveSpace": false,
            "windowFocused": false,
            "windowKey": false,
            "appActive": false,
            "appHidden": false,
            "frontmostIsSelf": false,
        },
        "afterOrderFront": {
            "visible": true,
            "occlusionVisible": null,
            "onActiveSpace": false,
            "windowFocused": false,
            "windowKey": false,
            "appActive": false,
            "appHidden": false,
            "frontmostIsSelf": false,
        },
        "lastVisibility": {
            "visible": true,
            "occlusionVisible": true,
            "onActiveSpace": true,
            "windowFocused": false,
            "windowKey": false,
            "appActive": false,
            "appHidden": false,
            "frontmostIsSelf": false,
        },
        "afterHide": {
            "visible": false,
            "occlusionVisible": false,
            "onActiveSpace": true,
            "windowFocused": false,
            "windowKey": false,
            "appActive": false,
            "appHidden": false,
            "frontmostIsSelf": false,
        },
        "visibilitySamples": 1,
    })
}

fn step(theme: &str, dark: bool) -> Value {
    json!({
        "theme": theme,
        "themeControlFound": true,
        "themeMenuOpened": true,
        "optionSetValid": true,
        "selectionDispatched": true,
        "selected": true,
        "selectedTheme": theme,
        "databaseTheme": theme,
        "childMediaDark": dark,
        "mainMediaDark": dark,
        "nativeAppearance": if dark { "dark" } else { "light" },
        "readiness": if theme == "system" { Value::Null } else {
            json!({
                "routeGeneral": true,
                "mediaMatches": true,
                "menusAbsent": true,
                "rootTextMatches": true,
                "sidebarTextMatches": true,
                "labelTextMatches": true,
                "framesObserved": true,
                "settled": true,
            })
        },
        "presentation": presentation(),
        "snapshot": if theme == "system" {
            json!({ "state": "not-required" })
        } else {
            json!({ "state": "captured" })
        },
    })
}

fn successful_report() -> Value {
    json!({
        "steps": [step("light", false), step("dark", true), step("system", true)],
        "presentation": presentation(),
        "restoration": {
            "selectedTheme": "dark",
            "databaseTheme": "dark",
            "childMediaDark": true,
            "mainMediaDark": true,
            "nativeAppearance": "dark",
            "presentation": presentation(),
        },
        "cleanup": {
            "hideConfirmed": true,
            "visible": false,
            "windowFocused": false,
            "windowKey": false,
            "appActive": false,
            "frontmostIsSelf": false,
        },
        "windowTrace": trace(),
        "errors": [],
    })
}

#[test]
fn report_pass_requires_complete_trace_and_consistent_cleanup() {
    let mut report = successful_report();
    assert!(passes(&report));

    report["windowTrace"]["afterOrderFront"]["appHidden"] = Value::Null;
    assert!(!passes(&report));

    report = successful_report();
    report["windowTrace"]["afterHide"]["appActive"] = Value::Bool(true);
    assert!(!passes(&report));

    report = successful_report();
    report["windowTrace"]["visibilitySamples"] = Value::from(0);
    assert!(!passes(&report));

    report = successful_report();
    report["windowTrace"]["afterHide"] = Value::Null;
    assert!(!passes(&report));
}
