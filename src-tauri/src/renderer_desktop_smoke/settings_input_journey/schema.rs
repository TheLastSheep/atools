pub(super) use super::probe_operation_schema::valid_operation;
use serde_json::Value;
use std::time::Duration;

pub(super) const MAIN_READY_TIMEOUT: Duration = Duration::from_secs(12);
pub(super) const PROBE_TIMEOUT: Duration = Duration::from_secs(12);
pub(super) const CHILD_TIMEOUT: Duration = Duration::from_secs(18);
pub(super) const CLOSE_TIMEOUT: Duration = Duration::from_secs(8);
pub(super) const POLL_INTERVAL: Duration = Duration::from_millis(35);

pub(super) fn validate_evidence(operation: &str, value: &Value) -> Result<(), &'static str> {
    if let Some(result) = super::login_cross_entry_schema::validate_probe_evidence(operation, value)
    {
        return result;
    }
    if let Some(result) = super::command_aliases_schema::validate_probe_evidence(operation, value) {
        return result;
    }
    if operation == "mainPluginInventory" {
        return super::plugin_inventory_schema::validate_evidence(value);
    }
    if let Some(result) = super::local_app_search_schema::validate_probe_evidence(operation, value)
    {
        return result;
    }
    if let Some(result) = super::window_opacity_schema::validate_probe_evidence(operation, value) {
        return result;
    }
    if let Some(result) = super::tray_visibility_schema::validate_probe_evidence(operation, value) {
        return result;
    }
    if let Some(result) = super::main_hotkey_schema::validate_probe_evidence(operation, value) {
        return result;
    }
    if let Some(result) =
        super::main_hotkey_startup_schema::validate_probe_evidence(operation, value)
    {
        return result;
    }
    if let Some(result) = super::general_policies_schema::validate_probe_evidence(operation, value)
    {
        return result;
    }
    if let Some(result) = super::launch_at_login_schema::validate_probe_evidence(operation, value) {
        return result;
    }
    if let Some(result) =
        super::command_availability_schema::validate_probe_evidence(operation, value)
    {
        return result;
    }
    if operation == "childPaintDiagnostic" {
        return super::paint_diagnostics::validate_probe_evidence(value);
    }
    let fields: &[&str] = match operation {
        "mainReady" => &["inputFound", "documentHidden", "documentHasFocus"],
        "mainUpdater" => &[
            "startupCalls",
            "verifiedCalls",
            "idle",
            "unchecked",
            "hasUpdate",
            "hasDownloadedAbsent",
        ],
        "mainOpenSettings" => &["openCallAvailable", "openCallDispatched"],
        "mainOpenState" => &[
            "openCalls",
            "pendingOpen",
            "openFailures",
            "listenerState",
            "registrationErrors",
            "invalidPayloads",
        ],
        "mainInspect" => &[
            "inputFound",
            "inputEmpty",
            "documentHidden",
            "documentHasFocus",
        ],
        "mainInput" => &[
            "inputFound",
            "eventDispatched",
            "valueMatches",
            "inputEmpty",
            "documentHidden",
            "documentHasFocus",
        ],
        "mainValue" => &[
            "inputFound",
            "valueMatches",
            "inputEmpty",
            "documentHidden",
            "documentHasFocus",
        ],
        "mainPinnedSearch" => &[
            "inputFound",
            "inputEmpty",
            "searchViewReady",
            "revisionMatches",
            "pinnedGroupFound",
            "targetPresent",
            "targetAbsent",
            "documentHidden",
            "documentHasFocus",
        ],
        "mainThemeInspect" => &["mediaDark", "documentHidden", "documentHasFocus"],
        "childBaseline" | "childTarget" | "childNoMatch" | "childClear" | "childReopenBaseline" => {
            &[
                "routeValid",
                "baselineCount",
                "filteredCount",
                "matchedCount",
                "restoredCount",
                "queryMatches",
                "targetUnique",
                "documentHidden",
                "documentHasFocus",
            ]
        }
        "childOwnerRoute" => &[
            "routeValid",
            "targetUnique",
            "documentHidden",
            "documentHasFocus",
        ],
        "childValue" => &["apiAvailable", "acknowledged"],
        "childStale" => &["replyValid", "applied", "replyMatchesCurrent"],
        "childRetiredSession" => &["rejected", "expectedCode"],
        "childOut" => &["available"],
        "childPinSearch" | "childUnpinSearch" => &[
            "menuOpened",
            "menuItemFound",
            "clickDispatched",
            "menuStateReflected",
            "readBack",
            "routeValid",
            "baselineCount",
            "filteredCount",
            "matchedCount",
            "restoredCount",
            "queryMatches",
            "targetUnique",
            "documentHidden",
            "documentHasFocus",
        ],
        "childThemeInspect" => &[
            "routeAllCommands",
            "routeGeneral",
            "sidebarFound",
            "themeControlFound",
            "selectedTheme",
            "committedTheme",
            "mediaDark",
            "documentHidden",
            "documentHasFocus",
        ],
        "childThemeNavigate" => &[
            "routeAllCommands",
            "routeGeneral",
            "sidebarFound",
            "navigationDispatched",
            "themeControlFound",
            "selectedTheme",
            "committedTheme",
            "mediaDark",
            "documentHidden",
            "documentHasFocus",
        ],
        "childThemeSelect" => &[
            "routeAllCommands",
            "routeGeneral",
            "themeControlFound",
            "themeMenuOpened",
            "optionSetValid",
            "selectionDispatched",
            "selected",
            "selectedTheme",
            "committedTheme",
            "mediaDark",
            "documentHidden",
            "documentHasFocus",
        ],
        "childSnapshotReady" => &[
            "routeGeneral",
            "mediaMatches",
            "menusAbsent",
            "rootTextMatches",
            "sidebarTextMatches",
            "labelTextMatches",
            "framesObserved",
            "settled",
        ],
        _ => return Err("settings-input-probe-operation-invalid"),
    };

    let object = value
        .as_object()
        .ok_or("settings-input-probe-protocol-rejected")?;
    if object.len() != fields.len() || fields.iter().any(|field| !object.contains_key(*field)) {
        return Err("settings-input-probe-protocol-rejected");
    }
    for field in fields {
        let item = &value[*field];
        match *field {
            "startupCalls" | "verifiedCalls" => {
                if item.as_u64().is_none_or(|count| count > 3) {
                    return Err("settings-input-probe-protocol-rejected");
                }
            }
            "baselineCount" | "filteredCount" | "matchedCount" => {
                if item.as_u64().is_none_or(|count| count > 4096) {
                    return Err("settings-input-probe-protocol-rejected");
                }
            }
            "restoredCount" => {
                if !item.is_null() && item.as_u64().is_none_or(|count| count > 4096) {
                    return Err("settings-input-probe-protocol-rejected");
                }
            }
            "openCalls" | "openFailures" | "registrationErrors" | "invalidPayloads" => {
                if !item.is_null() && item.as_u64().is_none_or(|count| count > 1_000_000) {
                    return Err("settings-input-probe-protocol-rejected");
                }
            }
            "pendingOpen" => {
                if !item.is_null() && !item.is_boolean() {
                    return Err("settings-input-probe-protocol-rejected");
                }
            }
            "listenerState" => {
                if !item.is_null()
                    && !matches!(
                        item.as_str(),
                        Some("idle" | "registering" | "listening" | "failed" | "disposed")
                    )
                {
                    return Err("settings-input-probe-protocol-rejected");
                }
            }
            "selectedTheme" | "committedTheme" => {
                if !item.is_null() && !matches!(item.as_str(), Some("system" | "light" | "dark")) {
                    return Err("settings-input-probe-protocol-rejected");
                }
            }
            _ if !item.is_boolean() => {
                return Err("settings-input-probe-protocol-rejected");
            }
            _ => {}
        }
    }
    match operation {
        "childThemeInspect" => {
            if value["routeAllCommands"].as_bool() == value["routeGeneral"].as_bool() {
                return Err("settings-input-probe-protocol-rejected");
            }
        }
        "childThemeNavigate" | "childThemeSelect" => {
            if value["routeAllCommands"].as_bool() != Some(false)
                || value["routeGeneral"].as_bool() != Some(true)
            {
                return Err("settings-input-probe-protocol-rejected");
            }
        }
        "childSnapshotReady" => {
            let settled_facts = [
                "routeGeneral",
                "mediaMatches",
                "menusAbsent",
                "rootTextMatches",
                "sidebarTextMatches",
                "labelTextMatches",
                "framesObserved",
            ]
            .iter()
            .all(|field| value[field].as_bool() == Some(true));
            if value["settled"].as_bool() != Some(settled_facts) {
                return Err("settings-input-probe-protocol-rejected");
            }
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{valid_operation, validate_evidence};
    use serde_json::{json, Value};

    fn open_state(
        open_calls: Value,
        pending_open: Value,
        open_failures: Value,
        listener_state: Value,
        registration_errors: Value,
        invalid_payloads: Value,
    ) -> Value {
        json!({
            "openCalls": open_calls,
            "pendingOpen": pending_open,
            "openFailures": open_failures,
            "listenerState": listener_state,
            "registrationErrors": registration_errors,
            "invalidPayloads": invalid_payloads,
        })
    }

    #[test]
    fn open_diagnostics_preserve_unknown_fields_as_null() {
        let evidence = open_state(
            Value::Null,
            Value::Null,
            Value::Null,
            Value::Null,
            Value::Null,
            Value::Null,
        );
        assert_eq!(validate_evidence("mainOpenState", &evidence), Ok(()));
    }

    #[test]
    fn open_diagnostics_accept_bounded_counts_and_known_listener_states() {
        for listener in ["idle", "registering", "listening", "failed", "disposed"] {
            let evidence = open_state(
                json!(0),
                json!(true),
                json!(1_000_000),
                json!(listener),
                json!(0),
                json!(1),
            );
            assert_eq!(validate_evidence("mainOpenState", &evidence), Ok(()));
        }
    }

    #[test]
    fn open_diagnostics_reject_invalid_counters_enums_and_boolean_shapes() {
        let cases = [
            open_state(
                json!(-1),
                json!(false),
                json!(0),
                json!("listening"),
                json!(0),
                json!(0),
            ),
            open_state(
                json!(1.5),
                json!(false),
                json!(0),
                json!("listening"),
                json!(0),
                json!(0),
            ),
            open_state(
                json!(1_000_001),
                json!(false),
                json!(0),
                json!("listening"),
                json!(0),
                json!(0),
            ),
            open_state(
                json!(0),
                json!(false),
                json!(0),
                json!("broken"),
                json!(0),
                json!(0),
            ),
            open_state(
                json!(0),
                json!(1),
                json!(0),
                json!("listening"),
                json!(0),
                json!(0),
            ),
        ];
        for evidence in cases {
            assert!(validate_evidence("mainOpenState", &evidence).is_err());
        }
    }

    #[test]
    fn open_diagnostics_require_exact_keys() {
        let mut evidence = open_state(
            json!(0),
            json!(false),
            json!(0),
            json!("idle"),
            json!(0),
            json!(0),
        );
        evidence["extra"] = json!(true);
        assert!(validate_evidence("mainOpenState", &evidence).is_err());
        evidence.as_object_mut().unwrap().remove("extra");
        evidence.as_object_mut().unwrap().remove("openCalls");
        assert!(validate_evidence("mainOpenState", &evidence).is_err());
    }

    #[test]
    fn retired_session_probe_is_child_scoped_with_exact_boolean_evidence() {
        assert!(valid_operation(
            "childRetiredSession",
            "ztools-settings-0123456789abcdef0123456789abcdef"
        ));
        assert!(!valid_operation("childRetiredSession", "main"));
        assert_eq!(
            validate_evidence(
                "childRetiredSession",
                &json!({"rejected": true, "expectedCode": true})
            ),
            Ok(())
        );
        assert!(validate_evidence(
            "childRetiredSession",
            &json!({"rejected": true, "expectedCode": true, "error": "raw"})
        )
        .is_err());
        assert!(validate_evidence(
            "childRetiredSession",
            &json!({"rejected": true, "expectedCode": "SETTINGS_CALLER_REJECTED"})
        )
        .is_err());
    }

    #[test]
    fn search_pin_probes_are_exactly_scoped_to_the_original_views() {
        let child = "ztools-settings-0123456789abcdef0123456789abcdef";
        let evidence = json!({
            "menuOpened": true,
            "menuItemFound": true,
            "clickDispatched": true,
            "menuStateReflected": true,
            "readBack": true,
            "routeValid": true,
            "baselineCount": 7,
            "filteredCount": 7,
            "matchedCount": 7,
            "restoredCount": null,
            "queryMatches": true,
            "targetUnique": true,
            "documentHidden": true,
            "documentHasFocus": false,
        });
        for operation in ["childPinSearch", "childUnpinSearch"] {
            assert!(valid_operation(operation, child));
            assert!(!valid_operation(operation, "main"));
            assert_eq!(validate_evidence(operation, &evidence), Ok(()));

            let mut extra = evidence.clone();
            extra["path"] = json!("/private");
            assert!(validate_evidence(operation, &extra).is_err());
            let mut malformed = evidence.clone();
            malformed["readBack"] = json!("yes");
            assert!(validate_evidence(operation, &malformed).is_err());
        }

        let main_evidence = json!({
            "inputFound": true,
            "inputEmpty": true,
            "searchViewReady": true,
            "revisionMatches": true,
            "pinnedGroupFound": true,
            "targetPresent": true,
            "targetAbsent": false,
            "documentHidden": true,
            "documentHasFocus": false,
        });
        assert!(valid_operation("mainPinnedSearch", "main"));
        assert!(!valid_operation("mainPinnedSearch", child));
        assert_eq!(
            validate_evidence("mainPinnedSearch", &main_evidence),
            Ok(())
        );
        for key in ["searchViewReady", "revisionMatches"] {
            let mut missing = main_evidence.clone();
            missing.as_object_mut().unwrap().remove(key);
            assert!(validate_evidence("mainPinnedSearch", &missing).is_err());

            let mut false_evidence = main_evidence.clone();
            false_evidence[key] = json!(false);
            assert_eq!(
                validate_evidence("mainPinnedSearch", &false_evidence),
                Ok(())
            );
        }
        let mut extra_main = main_evidence;
        extra_main["targetName"] = json!("private");
        assert!(validate_evidence("mainPinnedSearch", &extra_main).is_err());
    }

    #[path = "theme_schema_tests.rs"]
    mod theme_schema_tests;
}
