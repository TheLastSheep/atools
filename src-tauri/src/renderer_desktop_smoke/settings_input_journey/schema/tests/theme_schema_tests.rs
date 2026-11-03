use super::super::{valid_operation, validate_evidence};
use serde_json::json;

#[test]
fn theme_probes_are_scoped_to_exact_main_and_child_operations() {
    let child = "ztools-settings-0123456789abcdef0123456789abcdef";
    let main = json!({
        "mediaDark": true,
        "documentHidden": true,
        "documentHasFocus": false,
    });
    assert!(valid_operation("mainThemeInspect", "main"));
    assert!(!valid_operation("mainThemeInspect", child));
    assert_eq!(validate_evidence("mainThemeInspect", &main), Ok(()));

    let inspect = json!({
        "routeAllCommands": true,
        "routeGeneral": false,
        "sidebarFound": true,
        "themeControlFound": false,
        "selectedTheme": null,
        "committedTheme": "dark",
        "mediaDark": true,
        "documentHidden": true,
        "documentHasFocus": false,
    });
    assert!(valid_operation("childThemeInspect", child));
    assert!(!valid_operation("childThemeInspect", "main"));
    assert_eq!(validate_evidence("childThemeInspect", &inspect), Ok(()));
    for route_all_commands in [false, true] {
        let mut invalid_route = inspect.clone();
        invalid_route["routeAllCommands"] = json!(route_all_commands);
        invalid_route["routeGeneral"] = json!(route_all_commands);
        assert!(validate_evidence("childThemeInspect", &invalid_route).is_err());
    }

    let navigation = json!({
        "routeAllCommands": false,
        "routeGeneral": true,
        "sidebarFound": true,
        "navigationDispatched": true,
        "themeControlFound": true,
        "selectedTheme": "dark",
        "committedTheme": "dark",
        "mediaDark": true,
        "documentHidden": true,
        "documentHasFocus": false,
    });
    assert!(valid_operation("childThemeNavigate", child));
    assert!(!valid_operation("childThemeNavigate", "main"));
    assert_eq!(validate_evidence("childThemeNavigate", &navigation), Ok(()));
    let mut invalid_navigation = navigation.clone();
    invalid_navigation["routeAllCommands"] = json!(true);
    assert!(validate_evidence("childThemeNavigate", &invalid_navigation).is_err());

    let selection = json!({
        "routeAllCommands": false,
        "routeGeneral": true,
        "themeControlFound": true,
        "themeMenuOpened": true,
        "optionSetValid": true,
        "selectionDispatched": true,
        "selected": true,
        "selectedTheme": "light",
        "committedTheme": "light",
        "mediaDark": false,
        "documentHidden": true,
        "documentHasFocus": false,
    });
    assert_eq!(validate_evidence("childThemeSelect", &selection), Ok(()));
    let mut invalid_selection = selection.clone();
    invalid_selection["routeGeneral"] = json!(false);
    assert!(validate_evidence("childThemeSelect", &invalid_selection).is_err());
    for operation in [
        "childThemeInspect",
        "childThemeNavigate",
        "childThemeSelect",
    ] {
        let mut extra = match operation {
            "childThemeInspect" => inspect.clone(),
            "childThemeNavigate" => navigation.clone(),
            _ => selection.clone(),
        };
        extra["path"] = json!("/settings");
        assert!(validate_evidence(operation, &extra).is_err());
    }
    let mut invalid = selection;
    invalid["committedTheme"] = json!("unknown");
    assert!(validate_evidence("childThemeSelect", &invalid).is_err());
}

#[test]
fn snapshot_readiness_requires_exact_booleans_and_derived_settled_value() {
    let child = "ztools-settings-0123456789abcdef0123456789abcdef";
    let mut evidence = json!({
        "routeGeneral": true,
        "mediaMatches": true,
        "menusAbsent": true,
        "rootTextMatches": true,
        "sidebarTextMatches": true,
        "labelTextMatches": true,
        "framesObserved": true,
        "settled": true,
    });
    assert!(valid_operation("childSnapshotReady", child));
    assert!(!valid_operation("childSnapshotReady", "main"));
    assert_eq!(validate_evidence("childSnapshotReady", &evidence), Ok(()));

    evidence["menusAbsent"] = json!(false);
    evidence["settled"] = json!(false);
    assert_eq!(validate_evidence("childSnapshotReady", &evidence), Ok(()));
    evidence["settled"] = json!(true);
    assert!(validate_evidence("childSnapshotReady", &evidence).is_err());

    evidence["settled"] = json!(false);
    evidence["rawColor"] = json!("rgb(1, 2, 3)");
    assert!(validate_evidence("childSnapshotReady", &evidence).is_err());
}
